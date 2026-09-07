import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-master-financial-link-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'master-financial-link-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'

const [{ default: express }, { default: db }, { default: payments }, { default: daily }, { default: summary }, master] = await Promise.all([
  import('express'),
  import('../src/db.js'),
  import('../src/routes/payments.js'),
  import('../src/routes/daily.js'),
  import('../src/routes/summary.js'),
  import('../src/service-center-master.js'),
])

const center = '第一服务联动验证服务中心'
const oldArea = '原测试片区'
const newArea = '新测试片区'
const withdrawnCenter = '第一服务联动撤场服务中心'

db.prepare(`INSERT INTO payment_centers
  (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
  VALUES(?,?,100,80,60,50,75)`).run(oldArea, center)
db.prepare(`INSERT INTO payment_centers
  (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
  VALUES(?,?,200,160,120,100,75)`).run(oldArea, withdrawnCenter)
db.prepare(`INSERT INTO daily_snapshots
  (center,date,business_date,annual_budget,cumulative_budget,cumulative_executed,daily_collection,quality_status,last_validated_at)
  VALUES(?,?,?,100,80,60,10,'verified',datetime('now','localtime'))`).run(center, '2026-08-27', '2026-08-27')
db.prepare(`INSERT INTO daily_snapshots
  (center,date,business_date,annual_budget,cumulative_budget,cumulative_executed,daily_collection,quality_status,last_validated_at)
  VALUES(?,?,?,200,160,120,20,'verified',datetime('now','localtime'))`).run(withdrawnCenter, '2026-08-27', '2026-08-27')
db.prepare(`INSERT INTO service_center_master_changes
  (center_key,service_center,action_type,previous_area,new_area,previous_status,new_status,effective_date,reason,evidence,reconciliation_json,created_by_name)
  VALUES(?,?, 'transfer', ?, ?, '在管', '在管', '2026-08-27', '联动验证', '', '{}', 'tester')`)
  .run(master.masterCenterKey(center), center, oldArea, newArea)
db.prepare(`INSERT INTO service_center_master_changes
  (center_key,service_center,action_type,previous_area,new_area,previous_status,new_status,effective_date,reason,evidence,reconciliation_json,created_by_name)
  VALUES(?,?, 'withdraw', ?, ?, '在管', '已撤场', '2026-08-27', '联动验证', '', '{}', 'tester')`)
  .run(master.masterCenterKey(withdrawnCenter), withdrawnCenter, oldArea, oldArea)

const app = express()
app.use((req, _res, next) => { (req as any).user = { role: 'admin', username: 'tester' }; next() })
app.use(payments)
app.use(daily)
app.use(summary)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('测试服务启动失败')
const base = `http://127.0.0.1:${address.port}`

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('回款额执行评估按有效主数据片区返回并按新片区筛选', async () => {
  const all = await fetch(`${base}/api/payments`).then(response => response.json()) as any[]
  assert.equal(all.find(row => row.center === center)?.area, newArea)
  const moved = await fetch(`${base}/api/payments?area=${encodeURIComponent(newArea)}`).then(response => response.json()) as any[]
  assert.equal(moved.some(row => row.center === center), true)
  const old = await fetch(`${base}/api/payments?area=${encodeURIComponent(oldArea)}`).then(response => response.json()) as any[]
  assert.equal(old.some(row => row.center === center), false)
  assert.equal(all.find(row => row.center === withdrawnCenter)?.area, '撤场项目')
  const withdrawn = await fetch(`${base}/api/payments?area=${encodeURIComponent('撤场项目')}`).then(response => response.json()) as any[]
  assert.equal(withdrawn.some(row => row.center === withdrawnCenter), true)
})

test('每日回款明细按查询日期对应的有效主数据片区返回', async () => {
  const payload = await fetch(`${base}/api/daily?date=2026-08-27`).then(response => response.json()) as any
  assert.equal(payload.rows.find((row: any) => row.center === center)?.area, newArea)
  assert.equal(payload.rows.find((row: any) => row.center === withdrawnCenter)?.area, '撤场项目')
})

test('驾驶舱首页汇总保留已撤场服务中心经营数据', async () => {
  const payload = await fetch(`${base}/api/summary`).then(response => response.json()) as any
  assert.equal(payload.annualBudget, 300)
  assert.equal(payload.cumulativeBudget, 240)
  assert.equal(payload.cumulativeExecuted, 180)
})

test('收缴率接口在正式数据合并后使用有效主数据片区', () => {
  const source = fs.readFileSync(path.resolve('src/routes/collections.ts'), 'utf8')
  assert.match(source, /applyEffectiveMasterState\(lvzai\.rows\)/)
  assert.match(source, /area: r\.area/)
  assert.doesNotMatch(source, /area: live\?\.area \|\| r\.area/)
})
