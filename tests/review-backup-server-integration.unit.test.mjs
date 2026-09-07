import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createBackupArchive } from '../review-system/active/backend/backup-archive.js'

const root = path.resolve(import.meta.dirname, '..')
const backendDir = path.join(root, 'review-system/active/backend')
const adminPassword = 'Backup-Test!2026-Strong-Password'

async function freePort() {
  const listener = net.createServer()
  await new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}

async function waitForHealth(baseUrl, child, stderr) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`审核 API 提前退出：${child.exitCode}\n${stderr()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`等待审核 API 启动超时\n${stderr()}`)
}

async function stopChild(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000))
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function startApi(extraEnv = {}, existingWorkspace = '') {
  const workspace = existingWorkspace || await mkdtemp(path.join(os.tmpdir(), 'review-backup-server-'))
  const dataDir = path.join(workspace, 'data')
  const stateDir = path.join(workspace, 'state')
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const port = await freePort()
  let stderr = ''
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      NODE_ENV: 'test',
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      STORE_FILE: path.join(dataDir, 'store.json'),
      FILES_DIR: path.join(dataDir, 'files'),
      BACKUPS_DIR: path.join(dataDir, 'backups'),
      SSO_NONCE_STATE_FILE: path.join(stateDir, 'cockpit-sso-consumed.json'),
      AUTH_RATE_STATE_FILE: path.join(stateDir, 'auth-rate-limits.json'),
      REVIEW_SSO_SECRET: 'backup-integration-review-sso-secret-at-least-32-bytes',
      BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      BACKUP_RESTORE_MIN_FREE_BYTES: String(8 * 1024 * 1024),
      BACKUP_DOWNLOAD_TICKET_TTL_MS: '150',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const baseUrl = `http://127.0.0.1:${port}`
  await waitForHealth(baseUrl, child, () => stderr)
  return { workspace, dataDir, stateDir, child, baseUrl, stderr: () => stderr }
}

function openPausedMultipartRequest(url, token, { fieldName, filename, contentType, content }) {
  const boundary = `----review-backup-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  )
  const payload = Buffer.isBuffer(content) ? content : Buffer.from(content)
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
  const target = new URL(url)
  let resolveResponse
  let rejectResponse
  const response = new Promise((resolve, reject) => {
    resolveResponse = resolve
    rejectResponse = reject
  })
  const request = http.request({
    hostname: target.hostname,
    port: target.port,
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': prefix.length + payload.length + suffix.length
    }
  }, incoming => {
    const chunks = []
    incoming.on('data', chunk => chunks.push(chunk))
    incoming.on('end', () => resolveResponse({
      status: incoming.statusCode,
      body: Buffer.concat(chunks).toString('utf8')
    }))
  })
  request.on('error', rejectResponse)
  request.write(prefix)
  request.write(payload)
  return {
    async finish() {
      request.end(suffix)
      return response
    },
    destroy() {
      request.destroy()
    }
  }
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword })
  })
  const body = await response.text()
  assert.equal(response.status, 200, body)
  return JSON.parse(body).token
}

function authHeaders(token, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { 'Content-Type': 'application/json' } : {})
  }
}

function assertNoAuditControlCharacters(value) {
  if (typeof value === 'string') {
    assert.doesNotMatch(value, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/)
    return
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoAuditControlCharacters)
    return
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(assertNoAuditControlCharacters)
  }
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('等待异步清理超时')
}

test('server 以一次性票据流式导出、预览并事务恢复 tgz，旧 JSON 下载永久 410', async () => {
  const context = await startApi()
  try {
    const token = await login(context.baseUrl)
    const proposalForm = new FormData()
    proposalForm.set('title', '流式备份集成测试方案')
    proposalForm.set('type', '内部运营方案')
    proposalForm.set('description', '仅用于隔离临时目录行为回归')
    proposalForm.append('files', new Blob([Buffer.from('真实附件内容\n', 'utf8')], { type: 'text/plain' }), '集成测试附件.txt')
    const proposalResponse = await fetch(`${context.baseUrl}/api/proposals`, {
      method: 'POST',
      headers: authHeaders(token),
      body: proposalForm
    })
    const proposalBody = await proposalResponse.text()
    assert.equal(proposalResponse.status, 201, proposalBody)
    const proposal = JSON.parse(proposalBody)
    assert.equal(proposal.status, '待专业配置')
    assert.equal(proposal.files.length, 1)

    const oldExport = await fetch(`${context.baseUrl}/api/system-backup/export`, { headers: authHeaders(token) })
    assert.equal(oldExport.status, 410)

    const ticketResponse = await fetch(`${context.baseUrl}/api/system-backup/export-ticket`, {
      method: 'POST',
      headers: authHeaders(token, true),
      body: '{}'
    })
    const ticketBody = await ticketResponse.text()
    assert.equal(ticketResponse.status, 200, ticketBody)
    const ticket = JSON.parse(ticketBody)
    assert.match(ticket.downloadUrl, /^\/review-api\/system-backup\/download\/[A-Za-z0-9_-]{43}$/)
    assert.equal(ticket.oneTime, true)
    assert.match(ticket.filename, /\.firstcare-review-backup\.tgz$/)

    const localDownloadPath = ticket.downloadUrl.replace('/review-api/', '/api/')
    const download = await fetch(`${context.baseUrl}${localDownloadPath}`)
    assert.equal(download.status, 200)
    assert.equal(download.headers.get('content-type'), 'application/gzip')
    assert.match(download.headers.get('cache-control') || '', /no-store/)
    assert.equal(download.headers.get('referrer-policy'), 'no-referrer')
    const archive = Buffer.from(await download.arrayBuffer())
    assert.deepEqual([...archive.subarray(0, 2)], [0x1f, 0x8b])
    assert.equal((await fetch(`${context.baseUrl}${localDownloadPath}`)).status, 404)

    const previewForm = new FormData()
    previewForm.append('backup', new Blob([archive], { type: 'application/gzip' }), ticket.filename)
    const previewResponse = await fetch(`${context.baseUrl}/api/system-backup/preview`, {
      method: 'POST',
      headers: authHeaders(token),
      body: previewForm
    })
    const previewBody = await previewResponse.text()
    assert.equal(previewResponse.status, 200, previewBody)
    const preview = JSON.parse(previewBody).preview
    assert.equal(preview.proposals, 1)
    assert.equal(preview.files, 1)
    assert.equal(preview.verifiedFiles, 1)

    const restoreForm = new FormData()
    restoreForm.set('confirmText', '确认恢复')
    restoreForm.append('backup', new Blob([archive], { type: 'application/gzip' }), ticket.filename)
    const restoreResponse = await fetch(`${context.baseUrl}/api/system-backup/restore`, {
      method: 'POST',
      headers: authHeaders(token),
      body: restoreForm
    })
    const restoreBody = await restoreResponse.text()
    assert.equal(restoreResponse.status, 200, restoreBody)
    const restored = JSON.parse(restoreBody)
    assert.equal(restored.preview.proposals, 1)
    assert.equal(restored.preview.files, 1)
    assert.match(restored.preRestoreBackup, /^pre-restore-.*\.firstcare-review-backup\.tgz$/)

    const diskStore = JSON.parse(await readFile(path.join(context.dataDir, 'store.json'), 'utf8'))
    assert.equal(diskStore.proposals.length, 1)
    assert.equal(diskStore.proposals[0].id, proposal.id)
    const files = await readdir(path.join(context.dataDir, 'files'))
    assert.equal(files.length, 1)
    assert.equal((await stat(path.join(context.dataDir, 'files', files[0]))).mode & 0o777, 0o600)
    const dataNames = await readdir(context.dataDir)
    assert.equal(dataNames.some(name => name.startsWith('.restore-')), false)
    const backupNames = await readdir(path.join(context.dataDir, 'backups'))
    assert.equal(backupNames.some(name => name.startsWith('.upload-') || name.startsWith('.export-')), false)
    assert.equal(backupNames.some(name => name.startsWith('pre-restore-')), true)
  } finally {
    await stopChild(context.child)
    await rm(context.workspace, { recursive: true, force: true })
  }
})

test('恢复旧归档会规范化超长日志、淘汰到字节上限并保留下一次业务写入余量', async () => {
  const auditTestEnv = { AUDIT_LOG_COLLECTION_TEST_MAX_BYTES: String(64 * 1024) }
  let context = await startApi(auditTestEnv)
  try {
    const token = await login(context.baseUrl)
    const currentStore = JSON.parse(await readFile(path.join(context.dataDir, 'store.json'), 'utf8'))
    const permanent = {
      id: 'L-R51-FACTORY-QUARANTINE',
      actor: '系统',
      action: '工厂数据隔离永久锺点',
      category: '系统配置',
      result: '成功',
      metadata: { schema: 'test-anchor-v1' },
      at: '2026-01-01 00:00'
    }
    const maliciousLogs = [permanent]
    for (let index = 0; index < 420; index += 1) {
      maliciousLogs.push({
        id: `OLD-${index}`,
        actor: `恢复\n操作人-${index}`,
        action: `历史恢复记录 /api/logs?token=ARCHIVE-QUERY-CANARY-${index} ${'A'.repeat(12 * 1024)}`,
        category: '账号安全',
        result: '拒绝',
        userAgent: `ARCHIVE-UA-CANARY-${'U'.repeat(12 * 1024)}`,
        metadata: {
          authorization: `Bearer ARCHIVE-BEARER-CANARY-${index}`,
          apiKey: `ARCHIVE-API-KEY-CANARY-${index}`,
          nested: { note: `控制\r\n文本\u2028${'N'.repeat(4096)}` }
        },
        at: '2025-01-01 00:00'
      })
    }
    const archivedStore = { ...currentStore, logs: maliciousLogs }
    const sourceDir = path.join(context.workspace, 'archive-source-files')
    await mkdir(sourceDir, { mode: 0o700 })
    const archivePath = path.join(context.workspace, 'oversized-audit.firstcare-review-backup.tgz')
    await createBackupArchive({
      archivePath,
      storeBuffer: Buffer.from(JSON.stringify(archivedStore, null, 2)),
      filesDir: sourceDir,
      limits: {
        maxAttachmentBytes: 1024,
        maxFileCount: 4,
        maxStoreBytes: 12 * 1024 * 1024,
        maxArchiveBytes: 16 * 1024 * 1024,
        maxTarBytes: 16 * 1024 * 1024
      }
    })
    const archive = await readFile(archivePath)

    const previewForm = new FormData()
    previewForm.append('backup', new Blob([archive], { type: 'application/gzip' }), 'legacy-audit.tgz')
    const previewResponse = await fetch(`${context.baseUrl}/api/system-backup/preview`, {
      method: 'POST',
      headers: authHeaders(token),
      body: previewForm
    })
    assert.equal(previewResponse.status, 200, await previewResponse.text())

    const restoreForm = new FormData()
    restoreForm.set('confirmText', '确认恢复')
    restoreForm.append('backup', new Blob([archive], { type: 'application/gzip' }), 'legacy-audit.tgz')
    const restoreResponse = await fetch(`${context.baseUrl}/api/system-backup/restore`, {
      method: 'POST',
      headers: authHeaders(token),
      body: restoreForm
    })
    const restoreBody = await restoreResponse.text()
    assert.equal(restoreResponse.status, 200, restoreBody)

    const storePath = path.join(context.dataDir, 'store.json')
    const restoredBytes = await readFile(storePath)
    const restoredStore = JSON.parse(restoredBytes.toString('utf8'))
    assert.ok(restoredBytes.length <= 12 * 1024 * 1024 - 128 * 1024)
    assert.ok(restoredStore.logs.length < maliciousLogs.length, '恢复必须真实触发按字节淘汰')
    assert.ok(restoredStore.logs.some(log => log.id === permanent.id), '永久工厂迁移锺点必须保留')
    assert.ok(restoredStore.logs.some(log => /\u6062\u590d/.test(log.action) && log.category === '系统配置'), '恢复审计必须保留')
    assert.ok(restoredStore.logs.every(log => Buffer.byteLength(JSON.stringify(log), 'utf8') <= 8 * 1024))
    assert.ok(restoredStore.logs.every(log => Buffer.byteLength(String(log.userAgent || ''), 'utf8') <= 512))
    restoredStore.logs.forEach(assertNoAuditControlCharacters)
    assert.doesNotMatch(restoredBytes.toString('utf8'), /ARCHIVE-(?:QUERY|BEARER|API-KEY)-CANARY/)

    await stopChild(context.child)
    context = await startApi(auditTestEnv, context.workspace)
    const restartedToken = await login(context.baseUrl)
    const pruneResponse = await fetch(`${context.baseUrl}/api/logs/prune`, {
      method: 'POST',
      headers: authHeaders(restartedToken, true),
      body: JSON.stringify({ retentionDays: 30, confirmText: '清理旧日志' })
    })
    assert.equal(pruneResponse.status, 200, await pruneResponse.text())
    const prunedStore = JSON.parse(await readFile(storePath, 'utf8'))
    assert.ok(prunedStore.logs.some(log => log.id === permanent.id), '按日期清理不得删除永久工厂迁移锺点')

    const configResponse = await fetch(`${context.baseUrl}/api/system-config`, { headers: authHeaders(restartedToken) })
    const configBody = await configResponse.text()
    assert.equal(configResponse.status, 200, configBody)
    const config = JSON.parse(configBody).config
    const writeResponse = await fetch(`${context.baseUrl}/api/system-config`, {
      method: 'PATCH',
      headers: authHeaders(restartedToken, true),
      body: JSON.stringify({
        config: { ...config, sessionTtlMinutes: 479 },
        confirmText: '保存系统配置'
      })
    })
    assert.equal(writeResponse.status, 200, await writeResponse.text())
    assert.ok((await stat(storePath)).size <= 12 * 1024 * 1024 - 128 * 1024)
  } finally {
    await stopChild(context.child)
    await rm(context.workspace, { recursive: true, force: true })
  }
})

test('归档的非日志业务数据无法保留下一次写入余量时，恢复在快照与 store 变更前失败关闭', async () => {
  const context = await startApi()
  try {
    const token = await login(context.baseUrl)
    const storePath = path.join(context.dataDir, 'store.json')
    const currentStore = JSON.parse(await readFile(storePath, 'utf8'))
    const hugeEntry = {
      id: 'K-OVERFULL-RESTORE',
      profileId: 'finance',
      clauseCode: 'OVERFULL-RESTORE',
      title: '超限恢复业务数据',
      source: '隔离测试',
      content: '',
      keywords: [],
      priority: '中',
      status: '停用',
      updatedAt: '2026-08-13 00:00',
      sourceVerifiedBy: '',
      sourceVerifiedAt: ''
    }
    const archivedStore = { ...currentStore, logs: [], knowledgeEntries: [hugeEntry] }
    const targetBytes = 12 * 1024 * 1024 - 32 * 1024
    const emptyBytes = Buffer.byteLength(JSON.stringify(archivedStore, null, 2), 'utf8')
    hugeEntry.content = 'X'.repeat(targetBytes - emptyBytes)
    const archivedStoreBuffer = Buffer.from(JSON.stringify(archivedStore, null, 2))
    assert.ok(archivedStoreBuffer.length > 12 * 1024 * 1024 - 128 * 1024)
    assert.ok(archivedStoreBuffer.length < 12 * 1024 * 1024)

    const sourceDir = path.join(context.workspace, 'overfull-source-files')
    await mkdir(sourceDir, { mode: 0o700 })
    const archivePath = path.join(context.workspace, 'overfull-store.firstcare-review-backup.tgz')
    await createBackupArchive({
      archivePath,
      storeBuffer: archivedStoreBuffer,
      filesDir: sourceDir,
      limits: {
        maxAttachmentBytes: 1024,
        maxFileCount: 4,
        maxStoreBytes: 12 * 1024 * 1024,
        maxArchiveBytes: 16 * 1024 * 1024,
        maxTarBytes: 16 * 1024 * 1024
      }
    })
    const archive = await readFile(archivePath)
    const beforeBytes = await readFile(storePath)
    const beforeStat = await stat(storePath, { bigint: true })

    const restoreForm = new FormData()
    restoreForm.set('confirmText', '确认恢复')
    restoreForm.append('backup', new Blob([archive], { type: 'application/gzip' }), 'overfull-store.tgz')
    const response = await fetch(`${context.baseUrl}/api/system-backup/restore`, {
      method: 'POST',
      headers: authHeaders(token),
      body: restoreForm
    })
    const body = await response.text()
    assert.equal(response.status, 413, body)
    assert.match(body, /非日志业务数据已占满可备份上限/)

    const afterStat = await stat(storePath, { bigint: true })
    assert.deepEqual(await readFile(storePath), beforeBytes)
    assert.equal(afterStat.ino, beforeStat.ino)
    assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs)
    const backupNames = await readdir(path.join(context.dataDir, 'backups'))
    assert.equal(backupNames.some(name => name.startsWith('pre-restore-')), false)
    assert.equal(backupNames.some(name => name.startsWith('.upload-')), false)
  } finally {
    await stopChild(context.child)
    await rm(context.workspace, { recursive: true, force: true })
  }
})

test('过期的导出票据关闭固定 FD 并删除服务端临时归档', async () => {
  const context = await startApi()
  try {
    const token = await login(context.baseUrl)
    const ticketResponse = await fetch(`${context.baseUrl}/api/system-backup/export-ticket`, {
      method: 'POST',
      headers: authHeaders(token, true),
      body: '{}'
    })
    const ticketBody = await ticketResponse.text()
    assert.equal(ticketResponse.status, 200, ticketBody)
    const ticket = JSON.parse(ticketBody)
    await new Promise(resolve => setTimeout(resolve, 250))
    const localDownloadPath = ticket.downloadUrl.replace('/review-api/', '/api/')
    assert.equal((await fetch(`${context.baseUrl}${localDownloadPath}`)).status, 404)
    await waitUntil(async () => {
      const names = await readdir(path.join(context.dataDir, 'backups'))
      return names.every(name => !name.startsWith('.export-'))
    })
  } finally {
    await stopChild(context.child)
    await rm(context.workspace, { recursive: true, force: true })
  }
})

test('慢 profile 上传从 multer 前占位，且备份独占期拒绝所有普通 API', async () => {
  const context = await startApi()
  let slowProfile
  let slowKnowledge
  let slowBackup
  try {
    const token = await login(context.baseUrl)
    const storePath = path.join(context.dataDir, 'store.json')
    const beforePureExport = await readFile(storePath)
    const pureExport = await fetch(`${context.baseUrl}/api/profiles/export`, { headers: authHeaders(token) })
    assert.equal(pureExport.status, 200, await pureExport.text())
    assert.deepEqual(await readFile(storePath), beforePureExport)

    slowProfile = openPausedMultipartRequest(`${context.baseUrl}/api/profiles/import-preview`, token, {
      fieldName: 'profiles',
      filename: 'profiles.json',
      contentType: 'application/json',
      content: '{}'
    })
    await new Promise(resolve => setTimeout(resolve, 120))
    const blockedBackup = await fetch(`${context.baseUrl}/api/system-backup/export-ticket`, {
      method: 'POST',
      headers: authHeaders(token, true),
      body: '{}'
    })
    assert.equal(blockedBackup.status, 409, await blockedBackup.text())
    assert.equal((await slowProfile.finish()).status, 400)
    slowProfile = null

    slowKnowledge = openPausedMultipartRequest(`${context.baseUrl}/api/knowledge/import`, token, {
      fieldName: 'file',
      filename: 'knowledge.csv',
      contentType: 'text/csv',
      content: 'invalid-header\ninvalid-value'
    })
    await new Promise(resolve => setTimeout(resolve, 120))
    const blockedDuringKnowledge = await fetch(`${context.baseUrl}/api/system-backup/export-ticket`, {
      method: 'POST',
      headers: authHeaders(token, true),
      body: '{}'
    })
    assert.equal(blockedDuringKnowledge.status, 409, await blockedDuringKnowledge.text())
    assert.equal((await slowKnowledge.finish()).status, 400)
    slowKnowledge = null

    const ticketResponse = await fetch(`${context.baseUrl}/api/system-backup/export-ticket`, {
      method: 'POST',
      headers: authHeaders(token, true),
      body: '{}'
    })
    const ticketBody = await ticketResponse.text()
    assert.equal(ticketResponse.status, 200, ticketBody)
    const ticket = JSON.parse(ticketBody)
    const archiveResponse = await fetch(`${context.baseUrl}${ticket.downloadUrl.replace('/review-api/', '/api/')}`)
    assert.equal(archiveResponse.status, 200)
    const archive = Buffer.from(await archiveResponse.arrayBuffer())

    slowBackup = openPausedMultipartRequest(`${context.baseUrl}/api/system-backup/preview`, token, {
      fieldName: 'backup',
      filename: ticket.filename,
      contentType: 'application/gzip',
      content: archive
    })
    await new Promise(resolve => setTimeout(resolve, 120))
    const blockedNormalGet = await fetch(`${context.baseUrl}/api/profiles/export`, { headers: authHeaders(token) })
    assert.equal(blockedNormalGet.status, 409, await blockedNormalGet.text())
    const preview = await slowBackup.finish()
    assert.equal(preview.status, 200, preview.body)
    slowBackup = null
  } finally {
    slowProfile?.destroy()
    slowKnowledge?.destroy()
    slowBackup?.destroy()
    await stopChild(context.child)
    await rm(context.workspace, { recursive: true, force: true })
  }
})

test('备份生成在创建临时归档前校验当前库存上界加2GiB余量，低空间返507且无残留', async () => {
  const context = await startApi({ BACKUP_TEST_FILESYSTEM_FREE_BYTES: String(4 * 1024 * 1024) })
  try {
    const token = await login(context.baseUrl)
    const storePath = path.join(context.dataDir, 'store.json')
    const beforeStore = await readFile(storePath)
    const response = await fetch(`${context.baseUrl}/api/system-backup/export-ticket`, {
      method: 'POST',
      headers: authHeaders(token, true),
      body: '{}'
    })
    const body = await response.text()
    assert.equal(response.status, 507, body)
    assert.match(body, /生成备份归档前/)
    assert.deepEqual(await readFile(storePath), beforeStore)
    const names = await readdir(path.join(context.dataDir, 'backups'))
    assert.deepEqual(names, [])
  } finally {
    await stopChild(context.child)
    await rm(context.workspace, { recursive: true, force: true })
  }
})

test('部署与 Nginx 合同包含归档模块、18GiB 门禁和无日志流式入口', async () => {
  const deploy = await readFile(path.join(root, 'deploy/r51-review-recovery/deploy-production.py'), 'utf8')
  const nginx = await readFile(path.join(root, 'deploy/r51-review-recovery/review-system.conf'), 'utf8')
  assert.match(deploy, /payload\/backend\/backup-archive\.js/)
  assert.match(deploy, /MIN_REVIEW_DATA_FREE_BYTES = 18 \* 1024 \* 1024 \* 1024/)
  assert.match(nginx, /client_max_body_size 5200m/)
  assert.match(nginx, /proxy_request_buffering off/)
  assert.match(nginx, /system-backup\/download\/\(\[A-Za-z0-9_-\]\{43\}\)/)
  assert.match(nginx, /access_log off/)
})
