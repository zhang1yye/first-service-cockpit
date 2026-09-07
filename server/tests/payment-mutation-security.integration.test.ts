import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-payment-security-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'payment-security-contract-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'
process.env.COCKPIT_ALLOW_MANUAL_BUSINESS_WRITES = 'true'

const [{ default: db }, { default: paymentsRouter }, { requireAuth, signToken }] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/payments.js'),
  import('../src/auth.js'),
])
const paymentId = Number(db.prepare(`INSERT INTO payment_centers
  (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
  VALUES('测试片区','回款安全测试中心',100,80,70,60,3.46)`).run().lastInsertRowid)

const app = express()
app.use(express.json())
app.use(requireAuth)
app.use(paymentsRouter)
app.use((_error: any, _req: any, res: any, _next: any) => res.status(500).json({ error: '测试捕获的严格审计失败' }))
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  if (server.listening) return resolve()
  server.once('listening', resolve)
  server.once('error', reject)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('回款安全测试端口未绑定')
const baseUrl = `http://127.0.0.1:${address.port}`
const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any
const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })

async function put(body: any) {
  const response = await fetch(`${baseUrl}/api/payments/${paymentId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { response, payload: await response.json() as any }
}

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('回款修改校验真实数值口径并使用乐观锁', async () => {
  assert.equal((await put({ version: 1, annualBudget: -1 })).response.status, 400)
  assert.equal((await put({ version: 1, collectionRate: 101 })).response.status, 400)
  assert.equal((await put({ version: 1, cumulativeBudget: Number.NaN })).response.status, 400)

  const changed = await put({ version: 1, cumulativeExecuted: -10, samePeriod: -5, collectionRate: 3.46 })
  assert.equal(changed.response.status, 200)
  assert.equal(changed.payload.version, 2)
  const row = db.prepare('SELECT * FROM payment_centers WHERE id=?').get(paymentId) as any
  assert.equal(row.cumulative_executed, -10)
  assert.equal(row.same_period, -5)
  assert.equal(row.collection_rate, 3.46)

  const stale = await put({ version: 1, cumulativeExecuted: 999 })
  assert.equal(stale.response.status, 409)
  assert.equal((db.prepare('SELECT cumulative_executed FROM payment_centers WHERE id=?').get(paymentId) as any).cumulative_executed, -10)
  const log = db.prepare("SELECT detail FROM operation_logs WHERE action='修改回款数据' ORDER BY id DESC LIMIT 1").get() as any
  assert.ok(log)
  assert.match(log.detail, /"before"/)
  assert.match(log.detail, /"after"/)
})

test('生产回款事实只读，不能脱离P46正式发布形成双口径', async () => {
  const before = db.prepare('SELECT * FROM payment_centers WHERE id=?').get(paymentId) as any
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const blocked = await put({ version: before.version, cumulativeExecuted: 999999 })
    assert.equal(blocked.response.status, 403)
    assert.equal(blocked.payload.code, 'FORMAL_PAYMENT_READ_ONLY')
    assert.equal(blocked.payload.replacement, '/api/data-pipeline/preview')
    const after = db.prepare('SELECT * FROM payment_centers WHERE id=?').get(paymentId) as any
    assert.equal(after.cumulative_executed, before.cumulative_executed)
    assert.equal(after.version, before.version)
  } finally {
    process.env.NODE_ENV = previous
  }
})

test('回款审计失败时更新与版本号同时回滚', async () => {
  db.exec('DROP TABLE operation_logs')
  const failed = await put({ version: 2, annualBudget: 200 })
  assert.equal(failed.response.status, 500)
  const row = db.prepare('SELECT annual_budget,version FROM payment_centers WHERE id=?').get(paymentId) as any
  assert.equal(row.annual_budget, 100)
  assert.equal(row.version, 2)
})
