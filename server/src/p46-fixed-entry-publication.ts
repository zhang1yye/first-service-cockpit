import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const PENDING_DIRECTORY = '.p46-publication-pending'
const MANIFEST_NAME = 'manifest.json'
type P46Database = { prepare(sql: string): { get(parameter: number): unknown } }

export type P46FixedEntry = {
  targetName: string
  content: Buffer
}

type ManifestEntry = {
  targetName: string
  stagedName: string
  backupName: string
  newSha256: string
  oldSha256: string | null
  hadOriginal: boolean
}

type Manifest = {
  schemaVersion: 1
  state: 'prepared' | 'installing'
  batchId: number
  ownerPid: number
  entries: ManifestEntry[]
}

const sha256 = (content: Buffer) => crypto.createHash('sha256').update(content).digest('hex')
const pendingDirectory = (root: string) => path.join(root, PENDING_DIRECTORY)
const manifestPath = (root: string) => path.join(pendingDirectory(root), MANIFEST_NAME)

function fsyncFile(filePath: string) {
  const fd = fs.openSync(filePath, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function fsyncDirectory(directory: string) {
  const fd = fs.openSync(directory, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function writeManifest(root: string, manifest: Manifest) {
  const directory = pendingDirectory(root)
  const temporary = path.join(directory, '.manifest.new')
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 })
  fsyncFile(temporary)
  fs.renameSync(temporary, manifestPath(root))
  fsyncDirectory(directory)
}

function readManifest(root: string): Manifest | null {
  const filePath = manifestPath(root)
  if (!fs.existsSync(filePath)) return null
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Manifest
  if (parsed?.schemaVersion !== 1 || !Number.isSafeInteger(parsed.batchId) || !Array.isArray(parsed.entries)) {
    throw new Error('P46固定入口恢复日志格式无效')
  }
  for (const entry of parsed.entries) {
    if (!entry || path.basename(entry.targetName) !== entry.targetName || path.basename(entry.stagedName) !== entry.stagedName || path.basename(entry.backupName) !== entry.backupName) {
      throw new Error('P46固定入口恢复日志路径无效')
    }
    if (!/^[a-f0-9]{64}$/.test(entry.newSha256) || (entry.oldSha256 !== null && !/^[a-f0-9]{64}$/.test(entry.oldSha256))) {
      throw new Error('P46固定入口恢复日志哈希无效')
    }
  }
  return parsed
}

function fileSha(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`P46固定入口不是受控普通文件：${path.basename(filePath)}`)
  return sha256(fs.readFileSync(filePath))
}

export function p46FixedEntriesMatch(root: string, definitions: P46FixedEntry[]): boolean {
  const seen = new Set<string>()
  for (const definition of definitions) {
    const targetName = path.basename(definition.targetName)
    if (targetName !== definition.targetName || seen.has(targetName)) throw new Error('P46固定入口定义重复或路径越界')
    seen.add(targetName)
    if (fileSha(path.join(root, targetName)) !== sha256(definition.content)) return false
  }
  return true
}

function replaceFrom(source: string, target: string, directory: string, index: number) {
  const temporary = path.join(directory, `.p46-recovery-install-${index}`)
  fs.copyFileSync(source, temporary)
  fs.chmodSync(temporary, 0o640)
  fsyncFile(temporary)
  fs.renameSync(temporary, target)
  fsyncDirectory(directory)
}

function publicationState(database: P46Database, batchId: number): 'previewed' | 'published' {
  const row = database.prepare(`SELECT b.status,
    (SELECT COUNT(*) FROM data_ingestion_publications p WHERE p.batch_id=b.id) AS publication_count
    FROM data_ingestion_batches b WHERE b.id=?`).get(batchId) as { status?: string; publication_count?: number } | undefined
  if (!row) throw new Error(`P46固定入口恢复批次#${batchId}不存在`)
  const publicationCount = Number(row.publication_count || 0)
  if (row.status === 'published') {
    if (publicationCount !== 1) throw new Error(`P46固定入口恢复批次#${batchId}发布状态与SQLite回执不一致`)
    return 'published'
  }
  if (publicationCount !== 0) throw new Error(`P46固定入口恢复批次#${batchId}预览状态存在异常SQLite回执`)
  return 'previewed'
}

export function recoverP46FixedEntryPublication(database: P46Database, root: string): boolean {
  const directory = pendingDirectory(root)
  if (!fs.existsSync(directory)) return false
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('P46固定入口恢复路径不是受控目录')
  const manifest = readManifest(root)
  if (!manifest) {
    fs.rmSync(directory, { recursive: true, force: true })
    return true
  }
  const state = publicationState(database, manifest.batchId)
  const recoveryErrors: Error[] = []
  for (const [index, entry] of manifest.entries.entries()) {
    try {
      const target = path.join(root, entry.targetName)
      const staged = path.join(directory, entry.stagedName)
      const backup = path.join(directory, entry.backupName)
      if (fileSha(staged) !== entry.newSha256) throw new Error(`P46固定入口${entry.targetName}暂存证据损坏`)
      if (state === 'published') {
        if (fileSha(target) !== entry.newSha256) replaceFrom(staged, target, root, index)
        continue
      }
      const currentSha = fileSha(target)
      const accepted = currentSha === entry.newSha256 || currentSha === entry.oldSha256 || (!entry.hadOriginal && currentSha === null)
      if (!accepted) throw new Error(`P46固定入口${entry.targetName}在崩溃窗口后出现未知改动，已失败关闭`)
      if (entry.hadOriginal) {
        if (fileSha(backup) !== entry.oldSha256) throw new Error(`P46固定入口${entry.targetName}回滚备份损坏`)
        if (currentSha !== entry.oldSha256) replaceFrom(backup, target, root, index)
      } else if (currentSha !== null) {
        fs.rmSync(target, { force: true })
        fsyncDirectory(root)
      }
    } catch (error: unknown) {
      recoveryErrors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }
  if (recoveryErrors.length) throw new AggregateError(recoveryErrors, recoveryErrors.map(error => error.message).join('；'))
  fs.rmSync(directory, { recursive: true, force: true })
  fsyncDirectory(root)
  return true
}

export function prepareP46FixedEntryPublication(
  database: P46Database,
  root: string,
  batchId: number,
  definitions: P46FixedEntry[],
) {
  if (!fs.existsSync(root)) {
    throw new Error('P46固定入口根目录不存在，视为临时挂载故障并禁止递归创建')
  }
  const rootStat = fs.lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('P46固定入口根目录不是受控实体目录，禁止发布')
  }
  recoverP46FixedEntryPublication(database, root)
  const directory = pendingDirectory(root)
  fs.mkdirSync(directory, { mode: 0o700 })
  try {
    const seen = new Set<string>()
    const entries = definitions.map((definition, index): ManifestEntry => {
      const targetName = path.basename(definition.targetName)
      if (targetName !== definition.targetName || seen.has(targetName)) throw new Error('P46固定入口定义重复或路径越界')
      seen.add(targetName)
      const stagedName = `staged-${index}.bin`
      const backupName = `backup-${index}.bin`
      const staged = path.join(directory, stagedName)
      fs.writeFileSync(staged, definition.content, { mode: 0o600 })
      fsyncFile(staged)
      const target = path.join(root, targetName)
      const oldSha256 = fileSha(target)
      const hadOriginal = oldSha256 !== null
      if (hadOriginal) {
        const backup = path.join(directory, backupName)
        fs.copyFileSync(target, backup)
        fs.chmodSync(backup, 0o600)
        fsyncFile(backup)
      }
      return { targetName, stagedName, backupName, newSha256: sha256(definition.content), oldSha256, hadOriginal }
    })
    const manifest: Manifest = { schemaVersion: 1, state: 'prepared', batchId, ownerPid: process.pid, entries }
    writeManifest(root, manifest)
    fsyncDirectory(root)
    return {
      install() {
        manifest.state = 'installing'
        writeManifest(root, manifest)
        const crashAfter = process.env.NODE_ENV === 'test' ? Number(process.env.COCKPIT_TEST_CRASH_AFTER_FIXED_ENTRY_COUNT || 0) : 0
        for (const [index, entry] of entries.entries()) {
          replaceFrom(path.join(directory, entry.stagedName), path.join(root, entry.targetName), root, index)
          if (Number.isSafeInteger(crashAfter) && crashAfter > 0 && index + 1 === crashAfter) process.kill(process.pid, 'SIGKILL')
        }
      },
      settle() {
        recoverP46FixedEntryPublication(database, root)
      },
    }
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
