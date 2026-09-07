import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import jwt from 'jsonwebtoken'

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to allocate test port')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

async function waitForReady(url: string, logs: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`full entry did not become ready\n${logs()}`)
}

test('full production entry preserves purpose-bound reconciliation automation access', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-daily-full-entry-'))
  const encryptionKey = path.join(root, 'arrears-key')
  fs.writeFileSync(encryptionKey, 'test-encryption-key-material-at-least-32-characters', { mode: 0o600 })
  const port = await freePort()
  const dailySecret = 'full-entry-daily-automation-secret-at-least-32-characters'
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      COCKPIT_DB_PATH: path.join(root, 'cockpit.db'),
      COCKPIT_ROOT: root,
      COCKPIT_ADMIN_PASSWORD: 'temporary-test-password-not-production',
      JWT_SECRET: 'full-entry-human-secret-at-least-32-characters',
      DAILY_RECONCILIATION_JWT_SECRET: dailySecret,
      ARREARS_RAW_ROOT: path.join(root, 'raw'),
      ARREARS_ENCRYPTION_KEY_FILE: encryptionKey,
      ARREARS_ENCRYPTION_KEY_VERSION: 'test-v1',
      ARREARS_RESOURCE_HASH_KEY: 'full-entry-resource-hash-key-at-least-32-characters',
      HERMES_COCKPIT_BASE_URL: 'http://127.0.0.1:9',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', chunk => { logs += chunk })
  child.stderr.on('data', chunk => { logs += chunk })
  try {
    const base = `http://127.0.0.1:${port}`
    await waitForReady(`${base}/api/health/ready`, () => logs)
    const token = jwt.sign({
      actor: 'daily-reconciliation-automation',
      purpose: 'daily-reconciliation',
      tokenKind: 'automation',
    }, dailySecret, {
      algorithm: 'HS256',
      subject: 'daily-reconciliation-automation',
      audience: 'daily-reconciliation-api',
      issuer: 'first-service-cockpit',
      expiresIn: '5m',
    })
    const headers = { Authorization: ['Bea', 'rer ', token].join(''), 'Content-Type': 'application/json' }
    const publish = await fetch(`${base}/api/data-pipeline/daily-reconciliations/0/publish`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ confirmNote: '完整入口鉴权验证' }),
    })
    const publishBody = await publish.json() as any
    assert.equal(publish.status, 404, `${JSON.stringify(publishBody)}\n${logs}`)
    assert.match(String(publishBody.error), /复核批次不存在/)

    const forbidden = await fetch(`${base}/api/data-pipeline/batches`, { headers })
    assert.equal(forbidden.status, 401)
  } finally {
    child.kill('SIGTERM')
    await new Promise<void>(resolve => child.once('exit', () => resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
