import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-headquarters-home-parity-')))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'headquarters-home-parity-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'

const [{ default: express }, { default: db }, { default: summary }, { default: payments }] = await Promise.all([
  import('express'),
  import('../src/db.js'),
  import('../src/routes/summary.js'),
  import('../src/routes/payments.js'),
])

const centerA = '第一服务总部同口径甲服务中心'
const centerB = '第一服务总部同口径乙服务中心'
const insertPayment = db.prepare(`INSERT INTO payment_centers
  (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
  VALUES(?,?,100,80,70,60,80)`)
insertPayment.run('朝阳片区', centerA)
insertPayment.run('河北片区', centerB)

// 权威项目目录仅登记甲中心，用于证明总部职能不能被当前目录覆盖误截成局部回款范围。
const profileBatch = Number(db.prepare(`INSERT INTO project_profile_import_batches
  (source_file,source_sha256,source_sheet,filter_status,profile_count,phase_count)
  VALUES('headquarters-scope.xlsx',?,'项目','在管',1,0)`).run('a'.repeat(64)).lastInsertRowid)
db.prepare(`INSERT INTO project_profiles
  (batch_id,service_center,area,management_status,property_type,source_rows_json)
  VALUES(?,?,'朝阳片区','在管','住宅','[]')`).run(profileBatch, centerA)

const businessDate = new Date().toISOString().slice(0, 10)
const lastValidatedAt = new Date().toISOString()
const sourceLayer = { source: '测试正式来源', businessDate }
fs.writeFileSync(path.join(root, 'APH决策_每日提取.json'), JSON.stringify({
  sourceStatus: 'available',
  source: 'FineReport回款额执行评估·华北地区卡片',
  extractedAt: lastValidatedAt,
  businessDate,
  lastValidatedAt,
  华北地区: { 回款额: { 年度预算_万: 999, 累计预算_万: 800, 累计执行_万: 700, 同期执行_万: 600 } },
  fieldProvenance: {
    年度预算_万: 'regionCard', 累计预算_万: 'regionCard', 累计执行_万: 'regionCard', 同期执行_万: 'regionCard',
  },
  sourceLayers: { regionCard: sourceLayer, budgetWeekly: sourceLayer, centerDetail: sourceLayer },
  reconciliations: {
    annualBudgetCardVsWeekly: { status: 'ok' },
    annualBudgetCardVsCenterDetail: { status: 'ok' },
    samePeriodCardVsCenterDetail: { status: 'ok' },
  },
}))

const app = express()
app.use((req, _res, next) => {
  const role = String(req.headers['x-test-role'] || 'admin')
  ;(req as any).user = role === 'hq_function'
    ? { role, username: 'headquarters', serviceCenterScope: '华北地区公司本部职能' }
    : role === 'viewer'
      ? { role, username: 'viewer', serviceCenterScope: centerA }
      : { role: 'admin', username: 'admin' }
  next()
})
app.use(summary)
app.use(payments)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('总部首页同口径测试端口获取失败')
const base = `http://127.0.0.1:${address.port}`

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

async function get(pathname: string, role: string) {
  const response = await fetch(`${base}${pathname}`, { headers: { 'X-Test-Role': role } })
  assert.equal(response.status, 200)
  return response.json() as Promise<any>
}

test('所有已认证账号首页使用同一APH华北正式卡片', async () => {
  const admin = await get('/api/summary', 'admin')
  const headquarters = await get('/api/summary', 'hq_function')
  const viewer = await get('/api/summary', 'viewer')

  for (const field of ['annualBudget', 'cumulativeBudget', 'cumulativeExecuted', 'samePeriod']) {
    assert.equal(headquarters[field], admin[field], `headquarters.${field}`)
    assert.equal(viewer[field], admin[field], `viewer.${field}`)
  }
  assert.deepEqual(
    [headquarters.annualBudget, headquarters.cumulativeBudget, headquarters.cumulativeExecuted, headquarters.samePeriod],
    [999, 800, 700, 600],
  )
})

test('首页回款公共视图读全量，回款明细仍按角色授权', async () => {
  const admin = await get('/api/payments', 'admin')
  const headquarters = await get('/api/payments', 'hq_function')
  const viewer = await get('/api/payments', 'viewer')
  const viewerHome = await get('/api/home/payments', 'viewer')

  assert.deepEqual(headquarters.map((row: any) => row.center).sort(), admin.map((row: any) => row.center).sort())
  assert.equal(headquarters.length, 2)
  assert.deepEqual(viewer.map((row: any) => row.center), [centerA])
  assert.deepEqual(viewerHome.map((row: any) => row.center).sort(), admin.map((row: any) => row.center).sort())
})
