import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-repair-atomic-'))
const cockpit = path.join(root, 'cockpit')
fs.mkdirSync(cockpit, { recursive: true })
process.env.COCKPIT_HOME = root
process.env.COCKPIT_ROOT = cockpit
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'repair-atomic-contract-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'

const [{ default: db }, { default: dataSourcesRouter }, { requireAuth, signToken }] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/data-sources.js'),
  import('../src/auth.js'),
])

const app = express()
app.use(express.json())
app.use(requireAuth)
app.use(dataSourcesRouter)
app.use((_error: any, _req: any, res: any, _next: any) => res.status(500).json({ error: '测试捕获的文件替换失败' }))
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  if (server.listening) return resolve()
  server.once('listening', resolve)
  server.once('error', reject)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('数据源修复测试端口未绑定')
const baseUrl = `http://127.0.0.1:${address.port}`
const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any
const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })

const target = path.join(cockpit, 'APH决策_每日提取.json')
const candidateName = 'APH决策_每日提取_2026-08-13.json'
const candidate = path.join(cockpit, candidateName)
const oldPayload = JSON.stringify({ marker: 'old-formal-entry', 华北地区: { 回款额: { 累计执行_万: 1, 累计预算_万: 2 } }, extractedAt: '2026-08-12T00:00:00.000Z' })
const candidatePayload = JSON.stringify({ marker: 'new-candidate', 华北地区: { 回款额: { 累计执行_万: 3, 累计预算_万: 4 } }, extractedAt: '2026-08-13T00:00:00.000Z' })

function resetFiles() {
  fs.writeFileSync(target, oldPayload)
  fs.writeFileSync(candidate, candidatePayload)
  const now = Date.now() / 1000
  fs.utimesSync(target, now - 20, now - 20)
  fs.utimesSync(candidate, now, now)
}

function candidateContract() {
  const stat = fs.statSync(candidate)
  return { candidateName, candidateMtime: stat.mtime.toISOString(), candidateSize: stat.size }
}

async function repair(body: any) {
  return fetch(`${baseUrl}/api/data-sources/repair/aph`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function snapshot(body: any) {
  return fetch(`${baseUrl}/api/data-sources/snapshot/current`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

after(() => {
  try { fs.chmodSync(cockpit, 0o755) } catch {}
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('月快照变更、运行记录和严格审计同事务，force必须显式确认', async () => {
  const insert = db.prepare(`INSERT INTO projects
    (area,name,annual_income,annual_cost,ytd_income,ytd_cost,receivable,received,quality_score,
     safety_incidents,customer_satisfaction,complaint_count,project_code,active_status,
     validation_status,source_batch)
    VALUES('测试片区',?,100,80,70,50,100,80,90,0,90,1,?,'active','verified','snapshot-fixture')`)
  for (let index = 1; index <= 5; index += 1) insert.run(`快照事务项目${index}`, `SNAPSHOT-${index}`)
  const month = new Date().toISOString().slice(0, 7)
  const first = await snapshot({ month, source: 'snapshot-transaction-fixture' })
  assert.equal(first.status, 200, await first.clone().text())
  assert.equal((db.prepare('SELECT COUNT(*) count FROM project_monthly_snapshots WHERE month=?').get(month) as any).count, 5)
  const runsBefore = (db.prepare('SELECT COUNT(*) count FROM snapshot_runs').get() as any).count
  const originalIncome = (db.prepare('SELECT ytd_income FROM project_monthly_snapshots WHERE month=? AND project_name=?').get(month, '快照事务项目1') as any).ytd_income

  db.prepare('UPDATE projects SET ytd_income=999 WHERE name=?').run('快照事务项目1')
  const missingConfirmation = await snapshot({ month, source: 'snapshot-transaction-fixture', force: true })
  assert.equal(missingConfirmation.status, 400)
  assert.equal((db.prepare('SELECT ytd_income FROM project_monthly_snapshots WHERE month=? AND project_name=?').get(month, '快照事务项目1') as any).ytd_income, originalIncome)

  db.exec(`CREATE TRIGGER reject_snapshot_operation_audit BEFORE INSERT ON operation_logs
    BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`)
  try {
    const failed = await snapshot({ month, source: 'snapshot-transaction-fixture', force: true, confirmation: '确认覆盖当前月快照' })
    assert.equal(failed.status, 503)
    assert.equal((db.prepare('SELECT ytd_income FROM project_monthly_snapshots WHERE month=? AND project_name=?').get(month, '快照事务项目1') as any).ytd_income, originalIncome)
    assert.equal((db.prepare('SELECT COUNT(*) count FROM snapshot_runs').get() as any).count, runsBefore)
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_snapshot_operation_audit')
  }
})

test('候选元数据变化返回409且不覆盖正式入口', async () => {
  resetFiles()
  const response = await repair({ confirmation: '确认修复', ...candidateContract(), candidateSize: 1 })
  assert.equal(response.status, 409)
  assert.equal(fs.readFileSync(target, 'utf8'), oldPayload)
})

test('替换阶段失败不覆盖正式入口且不遗留临时半文件', async () => {
  resetFiles()
  fs.chmodSync(cockpit, 0o555)
  const response = await repair({ confirmation: '确认修复', ...candidateContract() })
  fs.chmodSync(cockpit, 0o755)
  assert.equal(response.status, 500)
  assert.equal(fs.readFileSync(target, 'utf8'), oldPayload)
  assert.equal(fs.readdirSync(cockpit).some(name => name.includes('.repair-') && name.endsWith('.tmp')), false)
})

test('严格审计失败时数据库与正式入口同时回滚', async () => {
  resetFiles()
  db.exec('DROP TABLE operation_logs')
  const response = await repair({ confirmation: '确认修复', ...candidateContract() })
  assert.equal(response.status, 500)
  assert.equal(fs.readFileSync(target, 'utf8'), oldPayload)
  assert.equal(fs.readdirSync(cockpit).some(name => name.includes('.repair-') && name.endsWith('.tmp')), false)
})
