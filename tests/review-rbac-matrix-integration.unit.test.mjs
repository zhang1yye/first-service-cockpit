import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const backendDir = path.join(root, 'review-system/active/backend')
const adminPassword = 'Rbac-Admin!2026-Strong-Password'
const reviewerPassword = 'Rbac-Reviewer!2026-Strong-Password'
const submitterPassword = 'Rbac-Submitter!2026-Strong-Password'

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

async function startApi(workspace, extraEnv = {}) {
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
      REVIEW_SSO_SECRET: 'rbac-integration-review-sso-secret-at-least-32-bytes',
      BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      AI_REVIEW_PROVIDER: 'hermes',
      AI_REVIEW_MODEL: 'hermes-eight-profile-v1',
      AI_REVIEW_BASE_URL: 'http://127.0.0.1:3100/v1',
      AI_REVIEW_API_KEY: 'rbac-integration-hermes-gateway-key-at-least-32-bytes',
      AI_REVIEW_AGENT_CONFIGURED: 'false',
      BACKUP_RESTORE_MIN_FREE_BYTES: String(8 * 1024 * 1024),
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const baseUrl = `http://127.0.0.1:${port}`
  await waitForHealth(baseUrl, child, () => stderr)
  return { child, baseUrl, dataDir, stdout: () => stdout, stderr: () => stderr }
}

async function requestJson(baseUrl, url, { method = 'GET', token = '', body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {}
  return { response, text, payload }
}

async function login(baseUrl, username, password) {
  const result = await requestJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { username, password }
  })
  assert.equal(result.response.status, 200, result.text)
  return result.payload.token
}

async function assertRejectedWithoutStoreMutation(context, token, rolePermissions) {
  const storePath = path.join(context.dataDir, 'store.json')
  const before = await readFile(storePath)
  const result = await requestJson(context.baseUrl, '/api/role-permissions', {
    method: 'PATCH',
    token,
    body: { rolePermissions, confirmText: '保存权限矩阵' }
  })
  assert.equal(result.response.status, 400, result.text)
  assert.deepEqual(await readFile(storePath), before, '拒绝的权限矩阵不得改写 store')
}

async function storeFingerprint(storePath) {
  const [bytes, info] = await Promise.all([
    readFile(storePath),
    stat(storePath, { bigint: true })
  ])
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    inode: info.ino,
    mtimeNs: info.mtimeNs,
    size: info.size
  }
}

function assertSameStoreFingerprint(actual, expected, message) {
  assert.deepEqual(actual.bytes, expected.bytes, `${message}：bytes 变化`)
  assert.equal(actual.sha256, expected.sha256, `${message}：SHA-256 变化`)
  assert.equal(actual.inode, expected.inode, `${message}：inode 变化`)
  assert.equal(actual.mtimeNs, expected.mtimeNs, `${message}：mtime 变化`)
  assert.equal(actual.size, expected.size, `${message}：size 变化`)
}

test('RBAC 减权即时撤销会话并跨重启持久，越权矩阵失败关闭', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'review-rbac-matrix-'))
  let context = await startApi(workspace)
  try {
    const adminToken = await login(context.baseUrl, 'admin', adminPassword)
    const created = await requestJson(context.baseUrl, '/api/users', {
      method: 'POST',
      token: adminToken,
      body: {
        username: 'rbac-reviewer',
        name: 'RBAC 审核员',
        role: '审核员',
        department: '研发小组',
        status: '启用',
        confirmText: '新增账号'
      }
    })
    assert.equal(created.response.status, 201, created.text)
    assert.equal(typeof created.payload.temporaryPassword, 'string')

    const temporaryToken = await login(context.baseUrl, 'rbac-reviewer', created.payload.temporaryPassword)
    const changedPassword = await requestJson(context.baseUrl, '/api/auth/change-password', {
      method: 'POST',
      token: temporaryToken,
      body: { oldPassword: created.payload.temporaryPassword, newPassword: reviewerPassword }
    })
    assert.equal(changedPassword.response.status, 200, changedPassword.text)
    const reviewerToken = changedPassword.payload.token
    assert.equal((await requestJson(context.baseUrl, '/api/logs', { token: reviewerToken })).response.status, 200)

    const matrix = await requestJson(context.baseUrl, '/api/role-permissions', { token: adminToken })
    assert.equal(matrix.response.status, 200, matrix.text)
    assert.deepEqual(matrix.payload.roles, ['管理员', '审核员', '提交人', '观察员'])
    assert.deepEqual(Object.keys(matrix.payload.rolePermissions), ['管理员', '使用者', '审核员', '提交人', '观察员'])

    const reduced = structuredClone(matrix.payload.rolePermissions)
    reduced['审核员'] = ['reviewProposal']
    const saved = await requestJson(context.baseUrl, '/api/role-permissions', {
      method: 'PATCH',
      token: adminToken,
      body: { rolePermissions: reduced, confirmText: '保存权限矩阵' }
    })
    assert.equal(saved.response.status, 200, saved.text)
    assert.equal(saved.payload.noChange, undefined)
    assert.deepEqual(saved.payload.rolePermissions['审核员'], ['reviewProposal'])
    assert.ok(saved.payload.revokedSessionCount >= 1)

    assert.equal((await requestJson(context.baseUrl, '/api/logs', { token: reviewerToken })).response.status, 401)
    const reviewerAfterReduction = await login(context.baseUrl, 'rbac-reviewer', reviewerPassword)
    assert.equal((await requestJson(context.baseUrl, '/api/logs', { token: reviewerAfterReduction })).response.status, 403)
    assert.equal((await requestJson(context.baseUrl, '/api/proposals', { token: reviewerAfterReduction })).response.status, 200)

    const baseline = structuredClone(saved.payload.rolePermissions)
    const overGrant = structuredClone(baseline)
    overGrant['审核员'] = ['submitProposal', 'reviewProposal']
    await assertRejectedWithoutStoreMutation(context, adminToken, overGrant)

    const reducedAdmin = structuredClone(baseline)
    reducedAdmin['管理员'] = ['manageSystem']
    await assertRejectedWithoutStoreMutation(context, adminToken, reducedAdmin)

    const unknownRole = { ...structuredClone(baseline), '超级管理员': ['manageSystem'] }
    await assertRejectedWithoutStoreMutation(context, adminToken, unknownRole)

    const unknownPermission = structuredClone(baseline)
    unknownPermission['观察员'] = ['viewLogs', 'exportEverything']
    await assertRejectedWithoutStoreMutation(context, adminToken, unknownPermission)

    await stopChild(context.child)
    context = await startApi(workspace)
    const restartedAdmin = await login(context.baseUrl, 'admin', adminPassword)
    const restartedMatrix = await requestJson(context.baseUrl, '/api/role-permissions', { token: restartedAdmin })
    assert.equal(restartedMatrix.response.status, 200, restartedMatrix.text)
    assert.deepEqual(restartedMatrix.payload.rolePermissions['审核员'], ['reviewProposal'])

    const restartedReviewer = await login(context.baseUrl, 'rbac-reviewer', reviewerPassword)
    assert.equal((await requestJson(context.baseUrl, '/api/logs', { token: restartedReviewer })).response.status, 403)
    assert.equal((await requestJson(context.baseUrl, '/api/proposals', { token: restartedReviewer })).response.status, 200)
  } finally {
    await stopChild(context.child)
    await rm(workspace, { recursive: true, force: true })
  }
})

test('GET/HEAD 任意拒绝路径保持业务 store 字节与元数据不变，写方法拒绝仍持久审计', async () => {
  const source = await readFile(path.join(backendDir, 'server.js'), 'utf8')
  const starts = [...source.matchAll(/^app\.(get|head|post|patch|put|delete)\(/gm)]
  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index]
    if (!['get', 'head'].includes(match[1])) continue
    const end = starts[index + 1]?.index ?? source.length
    const route = source.slice(match.index, end)
    assert.doesNotMatch(route, /\b(?:appendLog|saveStore)\s*\(/, `${route.split('\n')[0]} 不得直接持久化业务 store`)
  }
  const denialHelper = source.slice(
    source.indexOf('const securityAuditEventMaxBytes'),
    source.indexOf('function requirePermission')
  )
  assert.match(denialHelper, /securityAuditEventMaxBytes = 4 \* 1024[\s\S]*?securityAuditMetadataKeys[\s\S]*?Buffer\.byteLength[\s\S]*?nonPersistingReadMethods\.has[\s\S]*?writeBoundedSecurityAudit[\s\S]*?return[\s\S]*?appendLog/)
  assert.doesNotMatch(denialHelper, /originalUrl/)
  assert.doesNotMatch(denialHelper, /proposalTitle/)
  assert.doesNotMatch(source, /req\.(?:originalUrl|url)/, '业务与安全审计不得记录可携带 query/token 的原始 URL')

  const workspace = await mkdtemp(path.join(os.tmpdir(), 'review-readonly-denial-'))
  const auditTestEnv = { AUDIT_LOG_COLLECTION_TEST_MAX_BYTES: String(64 * 1024) }
  let context = await startApi(workspace, auditTestEnv)
  const storePath = path.join(context.dataDir, 'store.json')
  try {
    const adminToken = await login(context.baseUrl, 'admin', adminPassword)
    const createdUser = await requestJson(context.baseUrl, '/api/users', {
      method: 'POST',
      token: adminToken,
      body: {
        username: 'readonly-submitter',
        name: '纯读拒绝测试提交人',
        role: '提交人',
        department: '研发小组',
        status: '启用',
        confirmText: '新增账号'
      }
    })
    assert.equal(createdUser.response.status, 201, createdUser.text)
    const temporaryToken = await login(context.baseUrl, 'readonly-submitter', createdUser.payload.temporaryPassword)
    const changedPassword = await requestJson(context.baseUrl, '/api/auth/change-password', {
      method: 'POST',
      token: temporaryToken,
      body: { oldPassword: createdUser.payload.temporaryPassword, newPassword: submitterPassword }
    })
    assert.equal(changedPassword.response.status, 200, changedPassword.text)
    const submitterToken = changedPassword.payload.token

    const mustChangeUser = await requestJson(context.baseUrl, '/api/users', {
      method: 'POST',
      token: adminToken,
      body: {
        username: 'must-change-reader',
        name: '强制改密纯读账号',
        role: '提交人',
        department: '研发小组',
        status: '启用',
        confirmText: '新增账号'
      }
    })
    assert.equal(mustChangeUser.response.status, 201, mustChangeUser.text)
    const mustChangeToken = await login(context.baseUrl, 'must-change-reader', mustChangeUser.payload.temporaryPassword)

    const proposal = await requestJson(context.baseUrl, '/api/proposals', {
      method: 'POST',
      token: adminToken,
      body: {
        title: '仅用于验证越权 GET 不写 store 的方案',
        type: '内部运营方案',
        description: '由管理员提交，提交人账号无权查看。'
      }
    })
    assert.equal(proposal.response.status, 201, proposal.text)

    const beforeReads = await storeFingerprint(storePath)
    const queryCanary = 'GET-QUERY-CANARY-MUST-NOT-ENTER-AUDIT'
    const oversizedDeniedPath = `/api/proposals/${'A'.repeat(3000)}%0A%E2%80%A8control`
    const readCases = [
      ['/api/logs?' + queryCanary, 'GET', 403],
      ['/api/logs?' + queryCanary, 'HEAD', 403],
      ['/api/notifications/summary', 'GET', 403],
      ['/api/proposals', 'GET', 403],
      [oversizedDeniedPath, 'GET', 403],
      [`/api/my-proposals/${encodeURIComponent(proposal.payload.id)}`, 'GET', 403],
      [`/api/my-proposals/${encodeURIComponent(proposal.payload.id)}/files/nonexistent`, 'GET', 403],
      ['/api/my-proposals/not-found', 'GET', 404]
    ]
    for (const [url, method, expectedStatus] of readCases) {
      const result = await requestJson(context.baseUrl, url, { method, token: submitterToken })
      assert.equal(result.response.status, expectedStatus, `${method} ${url}: ${result.text}`)
      assertSameStoreFingerprint(
        await storeFingerprint(storePath),
        beforeReads,
        `${method} ${url}`
      )
    }
    for (const method of ['GET', 'HEAD']) {
      const denied = await requestJson(context.baseUrl, `/api/logs?${queryCanary}-MUST-CHANGE`, {
        method,
        token: mustChangeToken
      })
      assert.equal(denied.response.status, 403, `${method} 强制改密拦截：${denied.text}`)
      assertSameStoreFingerprint(await storeFingerprint(storePath), beforeReads, `${method} 强制改密拦截`)
    }
    assert.match(context.stderr(), /"event":"review-permission-denied"/)
    assert.doesNotMatch(context.stderr(), new RegExp(queryCanary))
    const auditLines = context.stderr().split('\n').filter(line => line.includes('"event":"review-permission-denied"'))
    assert.ok(auditLines.length >= 1)
    for (const line of auditLines) {
      assert.ok(Buffer.byteLength(line, 'utf8') <= 4096, '安全拒绝 stderr 事件必须不超过 4KiB')
      assert.doesNotMatch(line, /[\r\n]/)
      assert.doesNotThrow(() => JSON.parse(line))
    }

    await stopChild(context.child)
    context = await startApi(workspace, auditTestEnv)
    assertSameStoreFingerprint(await storeFingerprint(storePath), beforeReads, 'API 重启后')

    const restartedSubmitter = await login(context.baseUrl, 'readonly-submitter', submitterPassword)
    const beforeUnsafe = await storeFingerprint(storePath)
    const beforeUnsafeStore = JSON.parse(beforeUnsafe.bytes.toString('utf8'))
    const unsafeDenial = await requestJson(context.baseUrl, '/api/profiles/hermes-status', {
      method: 'POST',
      token: restartedSubmitter,
      body: {}
    })
    assert.equal(unsafeDenial.response.status, 403, unsafeDenial.text)
    const afterUnsafe = await storeFingerprint(storePath)
    assert.notEqual(afterUnsafe.sha256, beforeUnsafe.sha256, 'POST 权限拒绝必须持久化安全审计')
    const afterUnsafeStore = JSON.parse(afterUnsafe.bytes.toString('utf8'))
    assert.equal(afterUnsafeStore.logs.length, beforeUnsafeStore.logs.length + 1)
    assert.equal(afterUnsafeStore.logs[0].category, '账号安全')
    assert.equal(afterUnsafeStore.logs[0].result, '拒绝')
    assert.match(afterUnsafeStore.logs[0].action, /POST \/api\/profiles\/hermes-status/)

    await stopChild(context.child)
    context = await startApi(workspace, auditTestEnv)
    const persisted = JSON.parse((await readFile(storePath)).toString('utf8'))
    assert.equal(persisted.logs[0].id, afterUnsafeStore.logs[0].id, '写方法拒绝审计必须跨重启保留')
    const titleSubmitter = await login(context.baseUrl, 'readonly-submitter', submitterPassword)

    const longUserAgentCanary = `LONG-UA-CANARY-${'U'.repeat(12 * 1024)}`
    let completedLongUaDenials = 0
    for (let index = 0; index < 400; index += 1) {
      const denial = await requestJson(context.baseUrl, `/api/profiles/hermes-status?secret=QUERY-CANARY-${index}`, {
        method: 'POST',
        token: titleSubmitter,
        headers: { 'User-Agent': longUserAgentCanary },
        body: {}
      })
      assert.equal(denial.response.status, 403, denial.text)
      completedLongUaDenials += 1
    }
    assert.equal(completedLongUaDenials, 400, '长 UA 审计压力路径必须真实完成 400 次持久化拒绝')
    const boundedStore = await storeFingerprint(storePath)
    assert.ok(Number(boundedStore.size) < 12 * 1024 * 1024 - 128 * 1024, '重复长 UA 拒绝后 store 必须保留下一次业务写入余量')
    const boundedValue = JSON.parse(boundedStore.bytes.toString('utf8'))
    assert.ok(boundedValue.logs.length <= 10_000)
    assert.ok(boundedValue.logs.length < 400, '测试小容量边界必须真实触发旧日志淘汰')
    assert.ok(boundedValue.logs.every(log => Buffer.byteLength(JSON.stringify(log), 'utf8') <= 8 * 1024))
    assert.ok(boundedValue.logs.every(log => Buffer.byteLength(String(log.userAgent || ''), 'utf8') <= 512))
    assert.ok(boundedValue.logs.every(log => log.userAgent !== longUserAgentCanary))
    assert.ok(boundedValue.logs.some(log => log.id === 'L-R51-FACTORY-QUARANTINE') === persisted.logs.some(log => log.id === 'L-R51-FACTORY-QUARANTINE'))
    assert.doesNotMatch(boundedStore.bytes.toString('utf8'), /QUERY-CANARY-/)

    await stopChild(context.child)
    context = await startApi(workspace, auditTestEnv)
    const afterAuditRestart = await storeFingerprint(storePath)
    assert.equal(afterAuditRestart.sha256, boundedStore.sha256, '有界审计 store 重启不得被隐式改写')
    const postAuditAdmin = await login(context.baseUrl, 'admin', adminPassword)
    const currentSystemConfig = await requestJson(context.baseUrl, '/api/system-config', { token: postAuditAdmin })
    assert.equal(currentSystemConfig.response.status, 200, currentSystemConfig.text)
    const normalBusinessWrite = await requestJson(context.baseUrl, '/api/system-config', {
      method: 'PATCH',
      token: postAuditAdmin,
      body: {
        config: { ...currentSystemConfig.payload.config, sessionTtlMinutes: 479 },
        confirmText: '保存系统配置'
      }
    })
    assert.equal(normalBusinessWrite.response.status, 200, normalBusinessWrite.text)
    assert.ok(Number((await storeFingerprint(storePath)).size) < 12 * 1024 * 1024, '长 UA 审计压力后正常业务写必须继续成功')
    const titleToken = await login(context.baseUrl, 'readonly-submitter', submitterPassword)

    const beforeInvalidTitles = await storeFingerprint(storePath)
    const longTitle = `超长标题${'界'.repeat(4096)}`
    const rejectedLongTitle = await requestJson(context.baseUrl, '/api/proposals', {
      method: 'POST',
      token: titleToken,
      body: { title: longTitle, type: '内部运营方案', description: '标题上限测试' }
    })
    assert.equal(rejectedLongTitle.response.status, 400, rejectedLongTitle.text)
    assert.match(rejectedLongTitle.payload.message, /不能超过120个字符/)
    assertSameStoreFingerprint(await storeFingerprint(storePath), beforeInvalidTitles, '超长方案标题被拒绝后')

    const rejectedControlTitle = await requestJson(context.baseUrl, '/api/proposals', {
      method: 'POST',
      token: titleToken,
      body: { title: '控制\n字符标题', type: '内部运营方案', description: '标题控制字符测试' }
    })
    assert.equal(rejectedControlTitle.response.status, 400, rejectedControlTitle.text)
    assert.match(rejectedControlTitle.payload.message, /不能包含换行或控制字符/)
    assertSameStoreFingerprint(await storeFingerprint(storePath), beforeInvalidTitles, '控制字符方案标题被拒绝后')
  } finally {
    await stopChild(context.child)
    await rm(workspace, { recursive: true, force: true })
  }
})

test('生产 deployment-managed 配置不可由 PATCH 伪改且不阻断安全项保存', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'review-managed-config-'))
  let context = await startApi(workspace)
  try {
    const adminToken = await login(context.baseUrl, 'admin', adminPassword)
    const before = await requestJson(context.baseUrl, '/api/system-config', { token: adminToken })
    assert.equal(before.response.status, 200, before.text)
    const managedFields = [
      'frontendUrl', 'backendPort', 'apiPrefix',
      'aiProvider', 'aiModel', 'aiBaseUrl', 'aiApiKeyEnv'
    ]
    assert.deepEqual(before.payload.managedFields, managedFields)
    assert.deepEqual(
      Object.fromEntries(managedFields.map(field => [field, before.payload.config[field]])),
      before.payload.managedConfig
    )
    assert.equal(before.payload.managedConfig.frontendUrl, 'https://firstcare.cloud/review-system/')
    assert.equal(before.payload.managedConfig.backendPort, String(new URL(context.baseUrl).port))
    assert.equal(before.payload.managedConfig.apiPrefix, '/api')
    assert.equal(before.payload.managedConfig.aiProvider, 'hermes')
    assert.equal(before.payload.managedConfig.aiBaseUrl, 'http://127.0.0.1:3100/v1')
    assert.equal(before.payload.managedConfig.aiApiKeyEnv, 'AI_REVIEW_API_KEY')

    const saved = await requestJson(context.baseUrl, '/api/system-config', {
      method: 'PATCH',
      token: adminToken,
      body: {
        confirmText: '保存系统配置',
        config: {
          ...before.payload.config,
          sessionTtlMinutes: 123,
          maxLoginFailures: 7,
          frontendUrl: 'http://127.0.0.1:5174',
          backendPort: '9999',
          apiPrefix: '/evil',
          aiProvider: 'custom',
          aiModel: 'fake-model',
          aiBaseUrl: 'http://169.254.169.254/latest',
          aiApiKeyEnv: 'REVIEW_SSO_SECRET'
        }
      }
    })
    assert.equal(saved.response.status, 200, saved.text)
    assert.equal(saved.payload.config.sessionTtlMinutes, 123)
    assert.equal(saved.payload.config.maxLoginFailures, 7)
    assert.deepEqual(saved.payload.managedFields, managedFields)
    assert.deepEqual(new Set(saved.payload.ignoredManagedFields), new Set(managedFields))
    for (const field of managedFields) {
      assert.equal(saved.payload.config[field], saved.payload.managedConfig[field], `${field} 未保持部署运行态值`)
    }

    await stopChild(context.child)
    context = await startApi(workspace)
    const restartedAdmin = await login(context.baseUrl, 'admin', adminPassword)
    const afterRestart = await requestJson(context.baseUrl, '/api/system-config', { token: restartedAdmin })
    assert.equal(afterRestart.response.status, 200, afterRestart.text)
    assert.equal(afterRestart.payload.config.sessionTtlMinutes, 123)
    for (const field of managedFields) {
      assert.equal(afterRestart.payload.config[field], afterRestart.payload.managedConfig[field])
    }
  } finally {
    await stopChild(context.child)
    await rm(workspace, { recursive: true, force: true })
  }
})

test('供应商密钥停用时即使 8 个 Profile 已核验仍只保存草稿且不生成伪 AI 结论', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'review-ai-disabled-'))
  const context = await startApi(workspace)
  try {
    const health = await requestJson(context.baseUrl, '/api/health')
    assert.equal(health.response.status, 200, health.text)
    assert.equal(health.payload.gatewayConfigured, true)
    assert.equal(health.payload.agentConfigured, false)
    assert.equal(health.payload.inferenceEnabled, false)
    assert.equal(health.payload.reviewReady, false)
    assert.equal(health.payload.submissionMode, 'draft-only')
    assert.match(health.payload.reviewReadinessMessage, /推理凭据已安全停用|供应商密钥/)

    const adminToken = await login(context.baseUrl, 'admin', adminPassword)
    const profileResponse = await requestJson(context.baseUrl, '/api/profiles', { token: adminToken })
    assert.equal(profileResponse.response.status, 200, profileResponse.text)
    assert.equal(profileResponse.payload.profiles.length, 8)
    for (const profile of profileResponse.payload.profiles) {
      const enabled = await requestJson(context.baseUrl, `/api/profiles/${encodeURIComponent(profile.id)}`, {
        method: 'PATCH',
        token: adminToken,
        body: {
          status: '启用',
          standardsVerified: true,
          confirmText: '保存Profile配置'
        }
      })
      assert.equal(enabled.response.status, 200, enabled.text)
    }

    const limits = await requestJson(context.baseUrl, '/api/upload-limits', { token: adminToken })
    assert.equal(limits.response.status, 200, limits.text)
    assert.equal(limits.payload.activeProfileCount, 8)
    assert.equal(limits.payload.profileWorkflowReady, true)
    assert.equal(limits.payload.gatewayConfigured, true)
    assert.equal(limits.payload.agentConfigured, false)
    assert.equal(limits.payload.reviewReady, false)
    assert.equal(limits.payload.submissionMode, 'draft-only')
    assert.match(limits.payload.reviewReadinessMessage, /推理凭据已安全停用|供应商密钥/)

    const created = await requestJson(context.baseUrl, '/api/proposals', {
      method: 'POST',
      token: adminToken,
      body: {
        title: '供应商密钥停用期间的真实待配置草稿',
        type: '内部运营方案',
        description: '该方案只验证草稿保存，不应触发 AI。'
      }
    })
    assert.equal(created.response.status, 201, created.text)
    assert.equal(created.payload.status, '待专业配置')
    assert.equal(created.payload.summary, null)
    assert.deepEqual(created.payload.opinions, [])
    assert.deepEqual(created.payload.aiReviewTrace, [])
    assert.match(created.payload.timeline?.[0]?.action || '', /未执行 AI/)

    const rerun = await requestJson(context.baseUrl, `/api/proposals/${created.payload.id}/review`, {
      method: 'POST',
      token: adminToken,
      body: { confirmText: '重新发起AI审核' }
    })
    assert.equal(rerun.response.status, 409, rerun.text)
    assert.match(rerun.payload.message, /推理凭据已安全停用|供应商密钥/)

    const probe = await requestJson(context.baseUrl, '/api/system-config/ai-test', {
      method: 'POST',
      token: adminToken,
      body: {}
    })
    assert.equal(probe.response.status, 503, probe.text)
    assert.equal(probe.payload.mode, 'not-configured')
    assert.equal(probe.payload.fallback, false)
    assert.equal(probe.payload.runtime.agentConfigured, false)
  } finally {
    await stopChild(context.child)
    await rm(workspace, { recursive: true, force: true })
  }
})
