import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-auto-jobs-'))
process.env.COCKPIT_HOME = root
process.env.COCKPIT_ROOT = path.join(root, 'cockpit')
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'auto-jobs-contract-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'
fs.mkdirSync(process.env.COCKPIT_ROOT, { recursive: true })

const [{ default: db }, { default: router }, { requireAuth, signToken }] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/data-sources.js'),
  import('../src/auth.js'),
])

const app = express()
app.use(express.json())
app.use(requireAuth)
app.use(router)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  if (server.listening) return resolve()
  server.once('listening', resolve)
  server.once('error', reject)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('测试端口未绑定')
const base = `http://127.0.0.1:${address.port}`
const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any
const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

async function monthlyJob() {
  const response = await fetch(`${base}/api/data-sources/auto-jobs`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(response.status, 200, await response.clone().text())
  const payload = await response.json() as any
  return payload.rows.find((row: any) => row.key === 'monthly-snapshot')
}

test('历史运行记录声称有快照但当前表为空时标记失败', async () => {
  db.prepare("INSERT INTO snapshot_runs(month,source,status,inserted,skipped,message) VALUES('2026-08','auto','warning',10,0,'旧记录')").run()
  const job = await monthlyJob()
  assert.equal(job.status, 'failed')
  assert.equal(job.health, 'danger')
  assert.match(job.evidence, /当前快照 0/)
  assert.match(job.message, /运行记录与生产数据不一致/)
})

test('运行记录与当前快照数量存在时保留原状态', async () => {
  db.prepare("DELETE FROM snapshot_runs").run()
  db.prepare("INSERT INTO snapshot_runs(month,source,status,inserted,skipped,message) VALUES('2026-09','auto','success',1,0,'已生成')").run()
  db.prepare(`INSERT INTO project_monthly_snapshots(month,project_name,area,source,quality_status)
    VALUES('2026-09','测试项目','测试片区','formal-fixture','verified')`).run()
  const job = await monthlyJob()
  assert.equal(job.status, 'success')
  assert.equal(job.health, 'ok')
  assert.match(job.evidence, /当前快照 1/)
  assert.equal(job.message, '已生成')
})
