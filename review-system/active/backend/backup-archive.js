import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { Header, Pack, Parser, ReadEntry } from 'tar'

export const BACKUP_ARCHIVE_SCHEMA = 'firstcare-review-backup-archive'
export const BACKUP_ARCHIVE_VERSION = 1
export const BACKUP_ARCHIVE_SUFFIX = '.firstcare-review-backup.tgz'

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const noFollowFlag = fs.constants.O_NOFOLLOW || 0

export const BACKUP_ARCHIVE_LIMITS = Object.freeze({
  // 模块硬上界覆盖 server 允许的 5–20GiB 配置；server 每次传入当前实际值。
  maxAttachmentBytes: 20 * GiB,
  maxFileCount: 2000,
  maxStoreBytes: 12 * MiB,
  maxManifestBytes: 2 * MiB,
  // gzip 存储块、tar header/padding 和 manifest/store 保留有界余量。
  maxArchiveBytes: 20 * GiB + 128 * MiB,
  maxTarBytes: 20 * GiB + 64 * MiB,
  maxNameBytes: 255,
  // 规范生成器使用 gzip level 0，因此 4:1 已有充足兼容余量。
  maxDecompressionRatio: 4,
  readChunkBytes: MiB
})

function archiveError(message, code = 'BACKUP_ARCHIVE_INVALID') {
  return Object.assign(new Error(message), { code })
}

function exactInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw archiveError(`${name} 超出允许范围`)
  }
  return value
}

function normalizeLimits(overrides = {}) {
  const result = {}
  for (const [name, hardMaximum] of Object.entries(BACKUP_ARCHIVE_LIMITS)) {
    const supplied = overrides?.[name]
    if (supplied === undefined) {
      result[name] = hardMaximum
      continue
    }
    result[name] = exactInteger(Number(supplied), `limits.${name}`, 1, hardMaximum)
  }
  if (result.maxArchiveBytes < 1024 || result.maxTarBytes < 1024) {
    throw archiveError('归档流上限不能小于 1KiB')
  }
  return result
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino)
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
}

function assertRegularSingleLink(info, label) {
  if (!info?.isFile() || info.isSymbolicLink?.() || info.nlink !== 1) {
    throw archiveError(`${label}必须是单链接普通文件`)
  }
}

function assertDirectorySnapshot(directory, expected, label) {
  const current = fs.lstatSync(directory)
  if (!current.isDirectory() || current.isSymbolicLink() || !sameFileIdentity(current, expected)) {
    throw archiveError(`${label}在处理期间发生替换`)
  }
  return current
}

function ensureNotAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : archiveError('备份归档操作已中断', 'ABORT_ERR')
  }
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function compareUtf8Names(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''))
}

export function isSafeBackupBasename(value, limits = BACKUP_ARCHIVE_LIMITS) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..') return false
  if (value !== path.basename(value) || value.includes('/') || value.includes('\\') || value.includes('\0')) return false
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false
  return Buffer.byteLength(value, 'utf8') <= limits.maxNameBytes
}

function archiveEntryPathForName(name) {
  // tar ustar 的 pathname 字段对长 UTF-8 名称会自动生成 PAX。
  // 固定为原名 UTF-8 指纹可使生成与读取共用“无 PAX”的单一规范格式。
  return `files/${sha256Hex(Buffer.from(name, 'utf8'))}`
}

function exactArchivePath(value) {
  const archivePath = path.resolve(String(value || ''))
  if (!archivePath.endsWith(BACKUP_ARCHIVE_SUFFIX)) {
    throw archiveError(`备份归档名必须以 ${BACKUP_ARCHIVE_SUFFIX} 结尾`)
  }
  return archivePath
}

function exactInputArchivePath(value) {
  const raw = String(value || '')
  if (!raw) throw archiveError('未提供备份归档路径')
  return path.resolve(raw)
}

function normalizeStoreBuffer(value, limits) {
  const buffer = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : value instanceof Uint8Array || typeof value === 'string'
      ? Buffer.from(value)
      : null
  if (!buffer) throw archiveError('storeBuffer 必须是 JSON Buffer 或字符串')
  if (buffer.length > limits.maxStoreBytes) {
    throw archiveError(`store.json 超出 ${limits.maxStoreBytes} 字节上限`)
  }
  let parsed
  try {
    parsed = JSON.parse(buffer.toString('utf8'))
  } catch (error) {
    throw archiveError(`store.json 不是有效 JSON：${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw archiveError('store.json 顶层必须是 JSON 对象')
  }
  return { buffer, parsed }
}

function safeLstat(filePath, missingAllowed = false) {
  try {
    return fs.lstatSync(filePath)
  } catch (error) {
    if (missingAllowed && error?.code === 'ENOENT') return null
    throw error
  }
}

async function openVerifiedRegularFile(filePath, label) {
  const pathInfo = fs.lstatSync(filePath)
  assertRegularSingleLink(pathInfo, label)
  let handle
  try {
    handle = await fsp.open(filePath, fs.constants.O_RDONLY | noFollowFlag)
    const info = await handle.stat()
    assertRegularSingleLink(info, label)
    if (!sameFileIdentity(pathInfo, info)) {
      throw archiveError(`${label}在打开期间发生替换`)
    }
    return { handle, info }
  } catch (error) {
    await handle?.close().catch(() => {})
    throw error
  }
}

async function readHandleChunks(handle, expected, limits, signal, onChunk) {
  let position = 0
  const chunk = Buffer.allocUnsafe(Math.min(limits.readChunkBytes, Math.max(1, expected.size)))
  while (position < expected.size) {
    ensureNotAborted(signal)
    const length = Math.min(chunk.length, expected.size - position)
    const { bytesRead } = await handle.read(chunk, 0, length, position)
    if (bytesRead <= 0) throw archiveError('读取附件时遇到意外 EOF')
    await onChunk(chunk.subarray(0, bytesRead))
    position += bytesRead
  }
  const after = await handle.stat()
  if (!sameFileSnapshot(expected, after)) {
    throw archiveError('附件在读取期间发生变化')
  }
  return after
}

async function hashVerifiedFile(filePath, label, limits, signal) {
  const { handle, info } = await openVerifiedRegularFile(filePath, label)
  const hash = crypto.createHash('sha256')
  try {
    await readHandleChunks(handle, info, limits, signal, async chunk => hash.update(chunk))
    const currentPathInfo = fs.lstatSync(filePath)
    if (!sameFileSnapshot(info, currentPathInfo)) {
      throw archiveError(`${label}在校验后发生替换`)
    }
    return { info, sha256: hash.digest('hex') }
  } finally {
    await handle.close().catch(() => {})
  }
}

async function scanAttachmentTree(filesDir, limits, signal) {
  const directory = path.resolve(String(filesDir || ''))
  const rootInfo = fs.lstatSync(directory)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw archiveError('附件根目录必须是普通目录')
  }
  const names = fs.readdirSync(directory).sort(compareUtf8Names)
  if (names.length > limits.maxFileCount) {
    throw archiveError(`附件数量超出 ${limits.maxFileCount} 个上限`)
  }

  let totalBytes = 0
  const records = []
  for (const name of names) {
    ensureNotAborted(signal)
    if (!isSafeBackupBasename(name, limits)) throw archiveError(`附件名不安全：${name}`)
    const filePath = path.join(directory, name)
    const { info, sha256 } = await hashVerifiedFile(filePath, `附件《${name}》`, limits, signal)
    totalBytes += info.size
    if (totalBytes > limits.maxAttachmentBytes) {
      throw archiveError(`附件总量超出 ${limits.maxAttachmentBytes} 字节上限`)
    }
    records.push({
      name,
      path: archiveEntryPathForName(name),
      size: info.size,
      sha256,
      mtimeMs: info.mtimeMs,
      source: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs }
    })
  }

  assertDirectorySnapshot(directory, rootInfo, '附件根目录')
  const namesAfter = fs.readdirSync(directory).sort(compareUtf8Names)
  if (JSON.stringify(namesAfter) !== JSON.stringify(names)) {
    throw archiveError('附件集合在扫描期间发生变化')
  }
  return { directory, rootInfo, records, totalBytes }
}

function manifestFrom(storeBuffer, records, createdAt) {
  return {
    schema: BACKUP_ARCHIVE_SCHEMA,
    version: BACKUP_ARCHIVE_VERSION,
    createdAt,
    store: {
      path: 'store.json',
      size: storeBuffer.length,
      sha256: sha256Hex(storeBuffer)
    },
    files: records.map(({ name, path: entryPath, size, sha256, mtimeMs }) => ({
      name,
      path: entryPath,
      size,
      sha256,
      mtimeMs
    })),
    totals: {
      fileCount: records.length,
      fileBytes: records.reduce((sum, item) => sum + item.size, 0),
      storeBytes: storeBuffer.length
    }
  }
}

function createTarEntry(entryPath, size, mode = 0o600) {
  return new ReadEntry(new Header({
    path: entryPath,
    type: 'File',
    size,
    mode,
    uid: 0,
    gid: 0,
    mtime: new Date(0)
  }))
}

function entryEndOutcome(entry) {
  // 错误作为值返回，使 pipeline 先于生产者失败时不会出现短暂未处理拒绝。
  return new Promise(resolve => {
    entry.once('end', () => resolve(null))
    entry.once('error', resolve)
  })
}

async function waitForEntryEnd(outcome, streamFailure) {
  const entryError = await Promise.race([outcome, streamFailure])
  if (entryError) throw entryError
}

async function writeEntryChunk(entry, chunk, streamFailure) {
  if (entry.write(chunk)) return
  await Promise.race([
    new Promise((resolve, reject) => {
      const onDrain = () => {
        entry.off('error', onError)
        resolve()
      }
      const onError = error => {
        entry.off('drain', onDrain)
        reject(error)
      }
      entry.once('drain', onDrain)
      entry.once('error', onError)
    }),
    streamFailure
  ])
}

async function addBufferEntry(pack, entryPath, buffer, streamFailure) {
  const entry = createTarEntry(entryPath, buffer.length)
  const outcome = entryEndOutcome(entry)
  pack.add(entry)
  try {
    if (buffer.length > 0) await writeEntryChunk(entry, buffer, streamFailure)
    entry.end()
    await waitForEntryEnd(outcome, streamFailure)
  } catch (error) {
    entry.destroy(error)
    await outcome
    throw error
  }
}

async function addFileEntry(pack, scan, record, limits, signal, streamFailure) {
  const filePath = path.join(scan.directory, record.name)
  const { handle, info } = await openVerifiedRegularFile(filePath, `附件《${record.name}》`)
  if (!sameFileSnapshot(record.source, info)) {
    await handle.close().catch(() => {})
    throw archiveError(`附件《${record.name}》在建立 manifest 后发生变化`)
  }

  const entry = createTarEntry(record.path, info.size)
  const outcome = entryEndOutcome(entry)
  const hash = crypto.createHash('sha256')
  pack.add(entry)
  try {
    await readHandleChunks(handle, info, limits, signal, async chunk => {
      hash.update(chunk)
      await writeEntryChunk(entry, chunk, streamFailure)
    })
    const currentPathInfo = fs.lstatSync(filePath)
    if (!sameFileSnapshot(info, currentPathInfo) || hash.digest('hex') !== record.sha256) {
      throw archiveError(`附件《${record.name}》在归档读取期间发生变化`)
    }
    entry.end()
    await waitForEntryEnd(outcome, streamFailure)
  } catch (error) {
    entry.destroy(error)
    await outcome
    throw error
  } finally {
    await handle.close().catch(() => {})
  }
}

function byteLimitTransform(maximum, label) {
  let bytes = 0
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > maximum) return callback(archiveError(`${label}超出 ${maximum} 字节上限`))
      callback(null, chunk)
    }
  })
  Object.defineProperty(stream, 'bytesSeen', { get: () => bytes })
  return stream
}

function tarStructureGuard() {
  let buffered = Buffer.alloc(0)
  let bodyBytesRemaining = 0
  let zeroBlocks = 0
  let sawEndOfArchive = false

  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        let source = buffered.length > 0 ? Buffer.concat([buffered, chunk]) : chunk
        buffered = Buffer.alloc(0)
        let offset = 0
        while (offset < source.length) {
          if (bodyBytesRemaining > 0) {
            const consumed = Math.min(bodyBytesRemaining, source.length - offset)
            bodyBytesRemaining -= consumed
            offset += consumed
            continue
          }
          if (source.length - offset < 512) {
            buffered = Buffer.from(source.subarray(offset))
            break
          }
          const block = source.subarray(offset, offset + 512)
          offset += 512
          const isZeroBlock = block.every(byte => byte === 0)
          if (isZeroBlock) {
            if (sawEndOfArchive) throw archiveError('tar 完整结束标记后包含额外数据')
            zeroBlocks += 1
            if (zeroBlocks >= 2) sawEndOfArchive = true
            continue
          }
          if (sawEndOfArchive) throw archiveError('tar 完整结束标记后包含额外数据')
          zeroBlocks = 0
          const header = new Header(block)
          if (!header.cksumValid) throw archiveError('tar header 校验和不正确')
          if (!Number.isSafeInteger(header.size) || header.size < 0) throw archiveError('tar header size 不正确')
          bodyBytesRemaining = Math.ceil(header.size / 512) * 512
        }
        callback(null, chunk)
      } catch (error) {
        callback(error)
      }
    },
    flush(callback) {
      if (bodyBytesRemaining !== 0) return callback(archiveError('tar 条目正文被截断'))
      if (buffered.length !== 0) return callback(archiveError('tar 末尾未按 512 字节对齐'))
      if (!sawEndOfArchive) return callback(archiveError('tar 缺少完整结束标记'))
      callback()
    }
  })
}

function assertSafeOutputTarget(archivePath) {
  const parent = path.dirname(archivePath)
  const parentInfo = fs.lstatSync(parent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw archiveError('归档输出父目录必须是普通目录')
  }
  const targetInfo = safeLstat(archivePath, true)
  if (targetInfo) assertRegularSingleLink(targetInfo, '现有归档文件')
  return { parent, parentInfo, targetInfo }
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | noFollowFlag)
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function publishArchive(temporary, archivePath, output, replaceExisting, temporaryInfo) {
  assertDirectorySnapshot(output.parent, output.parentInfo, '归档输出父目录')
  const currentTemporary = fs.lstatSync(temporary)
  assertRegularSingleLink(currentTemporary, '待发布归档')
  if (!sameFileSnapshot(temporaryInfo, currentTemporary)) {
    throw archiveError('待发布归档在 fsync 后发生替换或改写')
  }
  const current = safeLstat(archivePath, true)
  if (output.targetInfo) {
    if (current) assertRegularSingleLink(current, '现有归档文件')
    if (!current || !sameFileSnapshot(output.targetInfo, current)) {
      throw archiveError('现有归档文件在发布前发生替换')
    }
  } else if (current) {
    throw archiveError('归档目标在发布前被并发创建')
  }

  if (output.targetInfo && !replaceExisting) {
    throw archiveError('归档目标已存在，默认拒绝覆盖')
  }
  if (output.targetInfo) {
    fs.renameSync(temporary, archivePath)
  } else {
    // 初始目标不存在时始终使用 no-replace link，即使调用者允许覆盖，
    // 也不得覆盖扫描后才并发出现的新文件。
    fs.linkSync(temporary, archivePath)
    fs.unlinkSync(temporary)
  }
  syncDirectory(output.parent)
  const installed = fs.lstatSync(archivePath)
  assertRegularSingleLink(installed, '已发布归档')
  if (!sameFileSnapshot(temporaryInfo, installed)) {
    throw archiveError('已发布归档与 fsync 候选不一致')
  }
  return installed
}

/**
 * 生成安全流式备份归档。默认不覆盖已有目标；覆盖时也只在完整 fsync 后原子 rename。
 */
export async function createBackupArchive(options = {}) {
  const limits = normalizeLimits(options.limits)
  const archivePath = exactArchivePath(options.archivePath)
  const filesDir = path.resolve(String(options.filesDir || ''))
  const { buffer: storeBuffer } = normalizeStoreBuffer(options.storeBuffer, limits)
  const output = assertSafeOutputTarget(archivePath)
  if (output.targetInfo && options.replaceExisting !== true) {
    throw archiveError('归档目标已存在，默认拒绝覆盖')
  }
  const mode = exactInteger(Number(options.mode ?? 0o600), 'mode', 0, 0o777)
  ensureNotAborted(options.signal)

  const scan = await scanAttachmentTree(filesDir, limits, options.signal)
  const createdAt = options.createdAt === undefined ? new Date().toISOString() : String(options.createdAt)
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) throw archiveError('createdAt 不是有效时间')
  const manifest = manifestFrom(storeBuffer, scan.records, createdAt)
  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2))
  if (manifestBuffer.length > limits.maxManifestBytes) {
    throw archiveError(`manifest.json 超出 ${limits.maxManifestBytes} 字节上限`)
  }

  const temporary = path.join(output.parent, `.${path.basename(archivePath)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`)
  let handle
  let published = false
  let streamFailureReject
  const streamFailure = new Promise((_, reject) => { streamFailureReject = reject })
  // 避免只有生产者失败时，长期挂起的拒绝 Promise 被视为 unhandled。
  streamFailure.catch(() => {})

  try {
    handle = await fsp.open(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag,
      mode
    )
    await handle.chmod(mode)
    const outputStream = fs.createWriteStream(temporary, { fd: handle.fd, autoClose: false })
    const archiveLimit = byteLimitTransform(limits.maxArchiveBytes, '压缩归档')
    const pack = new Pack({
      // 使用 gzip 存储模式：保持标准 .tgz，同时保证全零/高重复的合法库存
      // 也不会被读取端的压缩炸弹比率门禁拦截。
      gzip: { level: 0 },
      portable: true,
      noMtime: true,
      noPax: true,
      strict: true,
      // tar@7 把已排队 ReadEntry 计入 jobs，jobs=1 会使第一项无法开始。
      // 我们仍通过逐项 await 保证只有一个文件在读。
      jobs: 2,
      maxReadSize: limits.readChunkBytes
    })
    // 将 pipeline 失败转为值，避免生产者仍在 await 背压时出现短暂 unhandled rejection。
    const pipelineRun = options.signal
      ? pipeline(pack, archiveLimit, outputStream, { signal: options.signal })
      : pipeline(pack, archiveLimit, outputStream)
    const pipePromise = pipelineRun.then(() => null, error => {
      streamFailureReject(error)
      return error
    })

    try {
      await addBufferEntry(pack, 'manifest.json', manifestBuffer, streamFailure)
      await addBufferEntry(pack, 'store.json', storeBuffer, streamFailure)
      for (const record of scan.records) {
        ensureNotAborted(options.signal)
        await addFileEntry(pack, scan, record, limits, options.signal, streamFailure)
      }
      assertDirectorySnapshot(scan.directory, scan.rootInfo, '附件根目录')
      const currentNames = fs.readdirSync(scan.directory).sort(compareUtf8Names)
      if (JSON.stringify(currentNames) !== JSON.stringify(scan.records.map(item => item.name))) {
        throw archiveError('附件集合在归档期间发生变化')
      }
      pack.end()
      const pipeError = await pipePromise
      if (pipeError) throw pipeError
    } catch (error) {
      pack.destroy(error)
      outputStream.destroy(error)
      await pipePromise
      throw error
    }

    ensureNotAborted(options.signal)
    await handle.sync()
    const temporaryInfo = await handle.stat()
    ensureNotAborted(options.signal)
    const installed = publishArchive(
      temporary,
      archivePath,
      output,
      options.replaceExisting === true,
      temporaryInfo
    )
    published = true
    await handle.close()
    handle = null
    return {
      archivePath,
      archiveBytes: installed.size,
      manifest,
      files: manifest.files,
      totals: manifest.totals
    }
  } finally {
    await handle?.close().catch(() => {})
    if (!published) {
      try {
        fs.unlinkSync(temporary)
        syncDirectory(output.parent)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw archiveError(`${label}必须是对象`)
  const actual = Object.keys(value).sort()
  const expected = [...allowed].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw archiveError(`${label}字段集合不正确`)
  }
}

function validateManifest(value, limits) {
  assertExactKeys(value, ['schema', 'version', 'createdAt', 'store', 'files', 'totals'], 'manifest')
  if (value.schema !== BACKUP_ARCHIVE_SCHEMA || value.version !== BACKUP_ARCHIVE_VERSION) {
    throw archiveError('manifest schema/version 不受支持')
  }
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    throw archiveError('manifest.createdAt 不正确')
  }
  assertExactKeys(value.store, ['path', 'size', 'sha256'], 'manifest.store')
  if (value.store.path !== 'store.json') throw archiveError('manifest.store.path 不正确')
  exactInteger(value.store.size, 'manifest.store.size', 0, limits.maxStoreBytes)
  if (!isSha256(value.store.sha256)) throw archiveError('manifest.store.sha256 不正确')
  if (!Array.isArray(value.files) || value.files.length > limits.maxFileCount) {
    throw archiveError(`manifest.files 超出 ${limits.maxFileCount} 个上限`)
  }

  const names = new Set()
  let fileBytes = 0
  let previousName = null
  const files = value.files.map((file, index) => {
    assertExactKeys(file, ['name', 'path', 'size', 'sha256', 'mtimeMs'], `manifest.files[${index}]`)
    if (!isSafeBackupBasename(file.name, limits) || file.path !== archiveEntryPathForName(file.name)) {
      throw archiveError(`manifest.files[${index}] 路径不安全`)
    }
    if (names.has(file.name)) throw archiveError(`manifest 附件重复：${file.name}`)
    if (previousName !== null && compareUtf8Names(previousName, file.name) >= 0) {
      throw archiveError('manifest.files 必须按附件名严格排序')
    }
    names.add(file.name)
    previousName = file.name
    exactInteger(file.size, `manifest.files[${index}].size`, 0, limits.maxAttachmentBytes)
    if (!isSha256(file.sha256)) throw archiveError(`manifest.files[${index}].sha256 不正确`)
    if (typeof file.mtimeMs !== 'number' || !Number.isFinite(file.mtimeMs) || file.mtimeMs < 0) {
      throw archiveError(`manifest.files[${index}].mtimeMs 不正确`)
    }
    fileBytes += file.size
    if (fileBytes > limits.maxAttachmentBytes) throw archiveError('附件总量超出上限')
    return file
  })

  assertExactKeys(value.totals, ['fileCount', 'fileBytes', 'storeBytes'], 'manifest.totals')
  if (value.totals.fileCount !== files.length ||
      value.totals.fileBytes !== fileBytes ||
      value.totals.storeBytes !== value.store.size) {
    throw archiveError('manifest.totals 与条目不一致')
  }
  return { ...value, files }
}

function tarEntryFootprint(size) {
  return 512 + Math.ceil(size / 512) * 512
}

function assertManifestArchiveEnvelope(manifest, manifestBytes, archiveBytes, limits) {
  const expectedTarBytes = 1024 +
    tarEntryFootprint(manifestBytes) +
    tarEntryFootprint(manifest.store.size) +
    manifest.files.reduce((sum, file) => sum + tarEntryFootprint(file.size), 0)
  if (!Number.isSafeInteger(expectedTarBytes) || expectedTarBytes > limits.maxTarBytes) {
    throw archiveError(`manifest 声明的解压 tar 大小超出 ${limits.maxTarBytes} 字节上限`)
  }
  // 允许 4MiB 小归档开销；大归档按完整 manifest 声明在正文解压前拦截压缩炸弹。
  const ratioAllowance = 4 * MiB
  if (expectedTarBytes > archiveBytes * limits.maxDecompressionRatio + ratioAllowance) {
    throw archiveError(`备份归档解压比超出 ${limits.maxDecompressionRatio}:1 上限`)
  }
  return expectedTarBytes
}

function ensureEmptyStagingRoot(stagingDir, expectedUid) {
  const directory = path.resolve(String(stagingDir || ''))
  const info = fs.lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw archiveError('stagingDir 必须是普通目录')
  if ((info.mode & 0o777) !== 0o700) throw archiveError('stagingDir 权限必须为 0700')
  if (Number.isInteger(expectedUid) && info.uid !== expectedUid) {
    throw archiveError(`stagingDir 所有者必须为 uid ${expectedUid}`)
  }
  if (fs.readdirSync(directory).length !== 0) throw archiveError('stagingDir 必须为空目录')
  return { directory, info, created: [], filesDirectoryCreated: false }
}

function ensureStagingFilesDirectory(staging) {
  if (staging.filesDirectoryCreated) return
  assertDirectorySnapshot(staging.directory, staging.info, 'stagingDir')
  const filesDirectory = path.join(staging.directory, 'files')
  fs.mkdirSync(filesDirectory, { mode: 0o700 })
  const info = fs.lstatSync(filesDirectory)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) {
    throw archiveError('staging files 目录创建失败')
  }
  staging.filesDirectoryCreated = true
}

function cleanupStaging(staging) {
  if (!staging) return
  let current
  try {
    current = fs.lstatSync(staging.directory)
  } catch {
    return
  }
  if (!sameFileIdentity(current, staging.info) || !current.isDirectory() || current.isSymbolicLink()) return
  for (const filePath of [...staging.created].reverse()) {
    try {
      const info = fs.lstatSync(filePath)
      if (info.isFile() && !info.isSymbolicLink()) fs.unlinkSync(filePath)
    } catch {}
  }
  if (staging.filesDirectoryCreated) {
    try {
      fs.rmdirSync(path.join(staging.directory, 'files'))
    } catch {}
  }
  try {
    syncDirectory(staging.directory)
  } catch {}
}

function openStagingOutput(staging, entryPath) {
  assertDirectorySnapshot(staging.directory, staging.info, 'stagingDir')
  if (entryPath.startsWith('files/')) ensureStagingFilesDirectory(staging)
  const target = path.join(staging.directory, ...entryPath.split('/'))
  const descriptor = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag,
    0o600
  )
  fs.fchmodSync(descriptor, 0o600)
  staging.created.push(target)
  return { target, descriptor }
}

function writeAllSync(descriptor, chunk) {
  let offset = 0
  while (offset < chunk.length) {
    const written = fs.writeSync(descriptor, chunk, offset, chunk.length - offset)
    if (written <= 0) throw archiveError('staging 文件写入遇到意外 EOF')
    offset += written
  }
}

async function verifyStagingTree(staging, records, limits, signal) {
  assertDirectorySnapshot(staging.directory, staging.info, 'stagingDir')
  const topLevel = fs.readdirSync(staging.directory).sort(compareUtf8Names)
  if (JSON.stringify(topLevel) !== JSON.stringify(['files', 'manifest.json', 'store.json'])) {
    throw archiveError('stagingDir 顶层集合不与固定布局对应')
  }
  const filesDirectory = path.join(staging.directory, 'files')
  const filesDirectoryInfo = fs.lstatSync(filesDirectory)
  if (!filesDirectoryInfo.isDirectory() || filesDirectoryInfo.isSymbolicLink() || (filesDirectoryInfo.mode & 0o777) !== 0o700) {
    throw archiveError('staging files 目录类型或权限不正确')
  }
  const expectedFileNames = records
    .filter(record => record.relativePath.startsWith('files/'))
    .map(record => record.relativePath.slice(6))
    .sort(compareUtf8Names)
  const actualFileNames = fs.readdirSync(filesDirectory).sort(compareUtf8Names)
  if (JSON.stringify(actualFileNames) !== JSON.stringify(expectedFileNames)) {
    throw archiveError('staging 附件集合与 manifest 不一致')
  }

  for (const record of records) {
    const target = path.join(staging.directory, ...record.relativePath.split('/'))
    const verified = await hashVerifiedFile(target, `staging 条目《${record.relativePath}》`, limits, signal)
    if (verified.info.size !== record.size || verified.sha256 !== record.sha256 || (verified.info.mode & 0o777) !== 0o600) {
      throw archiveError(`staging 条目完整性或权限校验失败：${record.relativePath}`)
    }
  }
  assertDirectorySnapshot(filesDirectory, filesDirectoryInfo, 'staging files 目录')
  assertDirectorySnapshot(staging.directory, staging.info, 'stagingDir')
}

async function inspectArchive(options, extract) {
  const limits = normalizeLimits(options.limits)
  // 上传临时文件可能没有业务扩展名，读取端只信内容校验。
  const archivePath = exactInputArchivePath(options.archivePath)
  const expectedStagingUid = options.expectedStagingUid === undefined
    ? (typeof process.geteuid === 'function' ? process.geteuid() : undefined)
    : exactInteger(Number(options.expectedStagingUid), 'expectedStagingUid', 0, Number.MAX_SAFE_INTEGER)
  const staging = extract ? ensureEmptyStagingRoot(options.stagingDir, expectedStagingUid) : null
  ensureNotAborted(options.signal)

  const opened = await openVerifiedRegularFile(archivePath, '备份归档')
  if (opened.info.size > limits.maxArchiveBytes) {
    await opened.handle.close().catch(() => {})
    throw archiveError(`压缩归档超出 ${limits.maxArchiveBytes} 字节上限`)
  }

  const seenPaths = new Set()
  const actualFiles = []
  const stagedRecords = []
  const openDescriptors = new Set()
  let manifest = null
  let store = null
  let entryIndex = 0
  let parserFailure = null
  const parser = new Parser({
    strict: true,
    maxMetaEntrySize: limits.maxManifestBytes,
    // 已在 gunzip 后限制绝对字节数，比单纯压缩比更直接。
    maxDecompressionRatio: limits.maxDecompressionRatio
  })

  const rejectParser = error => {
    if (parserFailure) return
    parserFailure = error instanceof Error ? error : archiveError(String(error))
    parser.abort(parserFailure)
  }

  // 固定布局不需要 PAX/GNU 扩展元数据；拒绝它们可避免隐藏路径覆写。
  parser.on('meta', () => rejectParser(archiveError('归档包含不允许的扩展元数据条目')))
  parser.on('ignoredEntry', entry => {
    rejectParser(archiveError(`归档包含不支持或被忽略的条目：${entry?.path || '未知'}`))
  })

  parser.on('entry', entry => {
    try {
      ensureNotAborted(options.signal)
      const entryPath = String(entry.path || '')
      if (entry.type !== 'File') throw archiveError(`归档拒绝 ${entry.type} 条目：${entryPath}`)
      if (seenPaths.has(entryPath)) throw archiveError(`归档条目重复：${entryPath}`)
      seenPaths.add(entryPath)
      exactInteger(entry.size, `条目 ${entryPath} size`, 0, limits.maxAttachmentBytes)

      if (entryIndex === 0 && entryPath !== 'manifest.json') throw archiveError('归档第一项必须是 manifest.json')
      if (entryIndex === 1 && entryPath !== 'store.json') throw archiveError('归档第二项必须是 store.json')
      if (entryIndex > 1 && !/^files\/[a-f0-9]{64}$/u.test(entryPath)) {
        throw archiveError(`归档包含额外或嵌套条目：${entryPath}`)
      }
      if (entryIndex === 0 && entry.size > limits.maxManifestBytes) throw archiveError('manifest.json 超出上限')
      if (entryIndex === 1 && entry.size > limits.maxStoreBytes) throw archiveError('store.json 超出上限')
      if (entryIndex > 1 && !manifest) throw archiveError('读取附件前 manifest 未完成')

      const expected = entryIndex > 1
        ? manifest.files[entryIndex - 2]
        : entryIndex === 1
          ? manifest?.store
          : null
      if (entryIndex > 1 && (!expected || expected.path !== entryPath || expected.size !== entry.size)) {
        throw archiveError(`附件条目与 manifest 固定顺序不一致：${entryPath}`)
      }
      if (entryIndex === 1 && (!expected || expected.size !== entry.size)) {
        throw archiveError('store.json 大小与 manifest 不一致')
      }

      const chunks = entryIndex <= 1 ? [] : null
      const hash = crypto.createHash('sha256')
      let bytes = 0
      let output = null
      let stagingPath = null
      if (staging) {
        stagingPath = entryIndex > 1 ? `files/${expected.name}` : entryPath
        output = openStagingOutput(staging, stagingPath)
        openDescriptors.add(output.descriptor)
      }

      entry.on('data', chunk => {
        try {
          ensureNotAborted(options.signal)
          bytes += chunk.length
          if (bytes > entry.size) throw archiveError(`条目读取超出 header size：${entryPath}`)
          hash.update(chunk)
          if (chunks) chunks.push(Buffer.from(chunk))
          if (output) writeAllSync(output.descriptor, chunk)
        } catch (error) {
          rejectParser(error)
        }
      })

      entry.on('end', () => {
        try {
          if (parserFailure) return
          if (bytes !== entry.size) throw archiveError(`条目大小不一致：${entryPath}`)
          const digest = hash.digest('hex')
          if (output) {
            fs.fsyncSync(output.descriptor)
            const written = fs.fstatSync(output.descriptor)
            if (!written.isFile() || written.nlink !== 1 || written.size !== bytes || (written.mode & 0o777) !== 0o600) {
              throw archiveError(`staging 条目校验失败：${entryPath}`)
            }
            fs.closeSync(output.descriptor)
            openDescriptors.delete(output.descriptor)
            stagedRecords.push({ relativePath: stagingPath, size: bytes, sha256: digest })
          }

          if (entryIndex === 1) {
            if (digest !== manifest.store.sha256) throw archiveError('store.json 校验和不一致')
            const buffer = Buffer.concat(chunks)
            try {
              store = JSON.parse(buffer.toString('utf8'))
            } catch (error) {
              throw archiveError(`store.json 不是有效 JSON：${error.message}`)
            }
            if (!store || typeof store !== 'object' || Array.isArray(store)) {
              throw archiveError('store.json 顶层必须是 JSON 对象')
            }
          } else if (entryIndex === 0) {
            const buffer = Buffer.concat(chunks)
            let parsed
            try {
              parsed = JSON.parse(buffer.toString('utf8'))
            } catch (error) {
              throw archiveError(`manifest.json 不是有效 JSON：${error.message}`)
            }
            manifest = validateManifest(parsed, limits)
            assertManifestArchiveEnvelope(manifest, bytes, opened.info.size, limits)
          } else {
            if (digest !== expected.sha256) throw archiveError(`附件校验和不一致：${entryPath}`)
            actualFiles.push({ name: expected.name, path: entryPath, size: bytes, sha256: digest })
          }
          entryIndex += 1
        } catch (error) {
          rejectParser(error)
        }
      })
      entry.resume()
    } catch (error) {
      entry.resume()
      rejectParser(error)
    }
  })

  const archiveLimit = byteLimitTransform(limits.maxArchiveBytes, '压缩归档')
  const tarLimit = byteLimitTransform(limits.maxTarBytes, '解压 tar 流')
  const structureGuard = tarStructureGuard()
  const input = fs.createReadStream(archivePath, { fd: opened.handle.fd, autoClose: false })
  try {
    if (options.signal) {
      await pipeline(input, archiveLimit, createGunzip(), tarLimit, structureGuard, parser, { signal: options.signal })
    } else {
      await pipeline(input, archiveLimit, createGunzip(), tarLimit, structureGuard, parser)
    }
    if (parserFailure) throw parserFailure
    if (!manifest || !store) throw archiveError('归档缺少 manifest.json 或 store.json')
    if (entryIndex !== manifest.files.length + 2 || actualFiles.length !== manifest.files.length) {
      throw archiveError('归档附件集合与 manifest 不完整对应')
    }
    const after = await opened.handle.stat()
    if (!sameFileSnapshot(opened.info, after)) throw archiveError('备份归档在读取期间发生变化')
    const pathAfter = fs.lstatSync(archivePath)
    if (!sameFileSnapshot(opened.info, pathAfter)) throw archiveError('备份归档路径在读取期间发生替换')
    ensureNotAborted(options.signal)
    if (staging) {
      assertDirectorySnapshot(staging.directory, staging.info, 'stagingDir')
      ensureStagingFilesDirectory(staging)
      await verifyStagingTree(staging, stagedRecords, limits, options.signal)
      syncDirectory(path.join(staging.directory, 'files'))
      syncDirectory(staging.directory)
    }
    return {
      archivePath,
      archiveBytes: opened.info.size,
      manifest,
      store,
      files: actualFiles,
      stagingDir: staging?.directory || null
    }
  } catch (error) {
    for (const descriptor of openDescriptors) {
      try { fs.closeSync(descriptor) } catch {}
    }
    openDescriptors.clear()
    cleanupStaging(staging)
    throw parserFailure || error
  } finally {
    for (const descriptor of openDescriptors) {
      try { fs.closeSync(descriptor) } catch {}
    }
    await opened.handle.close().catch(() => {})
  }
}

export async function previewBackupArchive(options = {}) {
  return inspectArchive(options, false)
}

export async function restoreBackupArchive(options = {}) {
  if (!options.stagingDir) throw archiveError('restoreBackupArchive 必须提供 stagingDir')
  return inspectArchive(options, true)
}

/**
 * 固定已生成归档的 inode/FD，供一次性下载票据绑定后流式交付。
 * createReadStream 只能调用一次，流 close 时自动关闭 FD。
 */
export function openBackupArchiveForRead(options = {}) {
  const limits = normalizeLimits(options.limits)
  const archivePath = exactInputArchivePath(options.archivePath)
  const before = fs.lstatSync(archivePath)
  assertRegularSingleLink(before, '备份归档')
  if (before.size > limits.maxArchiveBytes) {
    throw archiveError(`压缩归档超出 ${limits.maxArchiveBytes} 字节上限`)
  }

  let descriptor
  try {
    descriptor = fs.openSync(archivePath, fs.constants.O_RDONLY | noFollowFlag)
    const info = fs.fstatSync(descriptor)
    assertRegularSingleLink(info, '备份归档')
    if (!sameFileSnapshot(before, info)) throw archiveError('备份归档在打开期间发生替换')
    const after = fs.lstatSync(archivePath)
    if (!sameFileSnapshot(info, after)) throw archiveError('备份归档路径在固定 FD 前发生替换')

    let claimed = false
    let closed = false
    let activeStream = null
    return {
      archivePath,
      descriptor,
      size: info.size,
      info,
      createReadStream() {
        if (claimed || closed) throw archiveError('备份归档读取 lease 已被消费')
        claimed = true
        const stream = fs.createReadStream(archivePath, { fd: descriptor, autoClose: true })
        activeStream = stream
        stream.once('close', () => {
          activeStream = null
          closed = true
        })
        return stream
      },
      close() {
        if (closed) return
        if (activeStream) {
          activeStream.destroy()
          return
        }
        closed = true
        fs.closeSync(descriptor)
      }
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
    throw error
  }
}
