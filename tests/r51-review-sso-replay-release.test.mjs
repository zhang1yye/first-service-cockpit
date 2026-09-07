import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const backendDir = path.join(root, 'review-system/active/backend')
const serverPath = path.join(backendDir, 'server.js')
const source = fs.readFileSync(serverPath, 'utf8')
const testSecret = 'r51-review-sso-replay-test-secret-20260812'

function signTicket(payload) {
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = crypto.createHmac('sha256', testSecret).update(payloadPart).digest('base64url')
  return `${payloadPart}.${signature}`
}

function ticket(nonce, exp = Date.now() + 60_000, overrides = {}) {
  return signTicket({
    username: 'cockpit-admin',
    name: '驾驶舱管理员',
    role: '管理员',
    exp,
    ...(nonce === undefined ? {} : { nonce }),
    ...overrides
  })
}

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

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`审核 API 提前退出：${child.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('等待审核 API 启动超时')
}

function isolatedEnv(context, port) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    NODE_ENV: 'test',
    PORT: String(port),
    BIND_HOST: '127.0.0.1',
    DATA_DIR: context.dataDir,
    STORE_FILE: path.join(context.dataDir, 'store.json'),
    FILES_DIR: path.join(context.dataDir, 'files'),
    BACKUPS_DIR: path.join(context.dataDir, 'backups'),
    SSO_NONCE_STATE_FILE: context.nonceFile,
    AUTH_RATE_STATE_FILE: context.authFile,
    REVIEW_SSO_SECRET: testSecret,
    BOOTSTRAP_ADMIN_PASSWORD: 'UnitTest-Review!2026-Secure',
    CORS_ORIGIN: 'https://firstcare.cloud'
  }
}

async function createContext() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'review-sso-process-'))
  const dataDir = path.join(rootDir, 'data')
  const stateDir = path.join(rootDir, 'state')
  await mkdir(dataDir, { mode: 0o700 })
  await mkdir(stateDir, { mode: 0o700 })
  return {
    rootDir,
    dataDir,
    stateDir,
    nonceFile: path.join(stateDir, 'cockpit-sso-consumed.json'),
    authFile: path.join(stateDir, 'auth-rate-limits.json')
  }
}

async function startApi(context) {
  const port = await freePort()
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: isolatedEnv(context, port),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const baseUrl = `http://127.0.0.1:${port}`
  await waitForHealth(baseUrl, child)
  return { child, baseUrl, stderr: () => stderr }
}

async function stopApi(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3_000))
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function consume(baseUrl, value, queryOnly = false) {
  const suffix = queryOnly ? `?token=${encodeURIComponent(value)}` : ''
  return fetch(`${baseUrl}/api/auth/cockpit-sso${suffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(queryOnly ? {} : { token: value })
  })
}

test('cockpit SSO 校验保持同步原子消费路径', () => {
  const verifyStart = source.indexOf('function verifyCockpitSsoToken')
  const verifyEnd = source.indexOf('function findCockpitSsoUser')
  const verifierSource = source.slice(verifyStart, verifyEnd)
  assert.ok(verifyStart >= 0 && verifyEnd > verifyStart)
  assert.doesNotMatch(verifierSource, /\basync\b|\bawait\b/)
  assert.match(verifierSource, /consumedCockpitSsoNonces\.has\(/)
  assert.match(verifierSource, /persistConsumedCockpitSsoNonces\(\)/)
})

test('同一 SSO 票据并发只成功一次，重启后仍拒绝重放', async () => {
  const context = await createContext()
  let runtime
  try {
    runtime = await startApi(context)
    const sharedTicket = ticket('atomic-replay-nonce-0001')
    const responses = await Promise.all([consume(runtime.baseUrl, sharedTicket), consume(runtime.baseUrl, sharedTicket)])
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 401])
    await stopApi(runtime.child)

    runtime = await startApi(context)
    assert.equal((await consume(runtime.baseUrl, sharedTicket)).status, 401)
    const info = await stat(context.nonceFile)
    assert.equal(info.mode & 0o777, 0o600)
    assert.equal(info.isFile(), true)
  } finally {
    if (runtime) await stopApi(runtime.child)
    await rm(context.rootDir, { recursive: true, force: true })
  }
})

test('query token 不被消费，缺失、非法 nonce/exp 和多余分段均拒绝', async () => {
  const context = await createContext()
  let runtime
  try {
    runtime = await startApi(context)
    const bodyTicket = ticket('query-is-not-consumed-01')
    assert.equal((await consume(runtime.baseUrl, bodyTicket, true)).status, 401)
    assert.equal((await consume(runtime.baseUrl, bodyTicket)).status, 200)

    const invalid = [
      ticket(undefined),
      ticket('short'),
      ticket('contains spaces nonce'),
      ticket('valid-nonce-exp-string', Date.now() + 60_000, { exp: String(Date.now() + 60_000) }),
      ticket('expired-ticket-nonce-01', Date.now() - 1),
      `${ticket('extra-segment-nonce-001')}.ignored`
    ]
    for (const value of invalid) assert.equal((await consume(runtime.baseUrl, value)).status, 401)
  } finally {
    if (runtime) await stopApi(runtime.child)
    await rm(context.rootDir, { recursive: true, force: true })
  }
})

test('过期消费记录会原子清理且同 nonce 可在新票据中复用', async () => {
  const context = await createContext()
  let runtime
  try {
    runtime = await startApi(context)
    const nonce = 'expired-cleanup-nonce-01'
    assert.equal((await consume(runtime.baseUrl, ticket(nonce, Date.now() + 200))).status, 200)
    await new Promise(resolve => setTimeout(resolve, 260))
    assert.equal((await consume(runtime.baseUrl, ticket(nonce))).status, 200)
    const state = JSON.parse(await readFile(context.nonceFile, 'utf8'))
    assert.equal(state.entries.length, 1)
    assert.equal(state.entries[0][0], nonce)
  } finally {
    if (runtime) await stopApi(runtime.child)
    await rm(context.rootDir, { recursive: true, force: true })
  }
})

test('损坏、宽权限或链接 nonce 状态均在启动时 fail-closed', async () => {
  for (const fixture of ['corrupt', 'wide-mode', 'symlink']) {
    const context = await createContext()
    let child
    try {
      if (fixture === 'corrupt') await writeFile(context.nonceFile, '{bad json', { mode: 0o600 })
      if (fixture === 'wide-mode') {
        await writeFile(context.nonceFile, JSON.stringify({ schema: 'first-service-cockpit-sso-nonce-v1', entries: [] }), { mode: 0o600 })
        await chmod(context.nonceFile, 0o644)
      }
      if (fixture === 'symlink') {
        const target = path.join(context.stateDir, 'target.json')
        await writeFile(target, JSON.stringify({ schema: 'first-service-cockpit-sso-nonce-v1', entries: [] }), { mode: 0o600 })
        await import('node:fs/promises').then(mod => mod.symlink(target, context.nonceFile))
      }
      const port = await freePort()
      child = spawn(process.execPath, ['server.js'], {
        cwd: backendDir,
        env: isolatedEnv(context, port),
        stdio: 'ignore'
      })
      const result = await Promise.race([
        new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`损坏 fixture 未及时失败：${fixture}`)), 10_000))
      ])
      assert.notEqual(result.code, 0)
    } finally {
      if (child) await stopApi(child)
      await rm(context.rootDir, { recursive: true, force: true })
    }
  }
})
