import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-rule-security-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'rule-security-contract-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'

const [{ default: db }, { default: governanceRouter }, { requireAuth, signToken }] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/governance.js'),
  import('../src/auth.js'),
])
const app = express()
app.use(express.json())
app.use(requireAuth)
app.use(governanceRouter)
app.use((_error: any, _req: any, res: any, _next: any) => res.status(500).json({ error: '测试捕获的严格审计失败' }))
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  if (server.listening) return resolve()
  server.once('listening', resolve)
  server.once('error', reject)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('规则安全测试端口未绑定')
const baseUrl = `http://127.0.0.1:${address.port}`
const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any
const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })

async function request(pathname: string, method = 'GET', body?: any) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { response, payload: await response.json().catch(() => ({})) as any }
}

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('规则保存拒绝空值、非有限数、错误布尔和不存在记录', async () => {
  const listed = await request('/api/governance/rules')
  assert.equal(listed.response.status, 200)
  const id = listed.payload.rows[0].id
  assert.equal((await request(`/api/governance/rules/${id}`, 'PUT', { threshold_value: null })).response.status, 400)
  assert.equal((await request(`/api/governance/rules/${id}`, 'PUT', { threshold_value: '88' })).response.status, 400)
  assert.equal((await request(`/api/governance/rules/${id}`, 'PUT', { threshold_value: -1 })).response.status, 400)
  assert.equal((await request(`/api/governance/rules/${id}`, 'PUT', { enabled: 1 })).response.status, 400)
  assert.equal((await request('/api/governance/rules/999999', 'PUT', { threshold_value: 88 })).response.status, 404)

  const updated = await request(`/api/governance/rules/${id}`, 'PUT', { threshold_value: 88, enabled: false })
  assert.equal(updated.response.status, 200)
  assert.equal(updated.payload.row.threshold_value, 88)
  assert.equal(updated.payload.row.enabled, 0)
})

test('规则审计失败时阈值修改回滚', async () => {
  const row = db.prepare('SELECT id,threshold_value FROM alert_rules ORDER BY id LIMIT 1').get() as any
  db.exec('DROP TABLE operation_logs')
  const failed = await request(`/api/governance/rules/${row.id}`, 'PUT', { threshold_value: 99 })
  assert.equal(failed.response.status, 500)
  assert.equal((db.prepare('SELECT threshold_value FROM alert_rules WHERE id=?').get(row.id) as any).threshold_value, row.threshold_value)
})
