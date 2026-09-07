import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-business-date-output-gates-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'business-date-output-gates-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'

const [{ default: db }, { default: summaryRouter }, { default: dataSourcesRouter }] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/summary.js'),
  import('../src/routes/data-sources.js'),
])

const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  ;(req as express.Request & { user?: { userId: number; username: string; role: string } }).user = {
    userId: 1, username: 'business-date-gate-admin', role: 'admin',
  }
  next()
})
app.use(summaryRouter)
app.use(dataSourcesRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  if (server.listening) return resolve()
  server.once('listening', resolve)
  server.once('error', reject)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('business-date gate server did not bind')
const baseUrl = `http://127.0.0.1:${address.port}`

const freshTimestamp = () => new Date(Date.now() - 60_000).toISOString()

function writeAph(businessDate: string) {
  const sourceLayers = Object.fromEntries(['regionCard', 'budgetWeekly', 'centerDetail'].map(key => [key, {
    source: `${key}测试源`, businessDate,
  }]))
  fs.writeFileSync(path.join(root, 'APH决策_每日提取.json'), JSON.stringify({
    businessDate,
    extractedAt: freshTimestamp(),
    lastValidatedAt: freshTimestamp(),
    sourceStatus: 'available',
    fieldProvenance: {
      年度预算_万: '地区卡片/年度预算',
      累计预算_万: '地区卡片/累计预算',
      累计执行_万: '地区卡片/累计执行',
      同期执行_万: '地区卡片/同期执行',
    },
    sourceLayers,
    reconciliations: {
      annualBudgetCardVsWeekly: { status: 'matched' },
      annualBudgetCardVsCenterDetail: { status: 'matched' },
      samePeriodCardVsCenterDetail: { status: 'matched' },
    },
    华北地区: { 回款额: { 年度预算_万: 100, 累计预算_万: 80, 累计执行_万: 70, 同期执行_万: 60 } },
  }))
}

function writeDaily(businessDate: string) {
  db.prepare('DELETE FROM daily_snapshots').run()
  db.prepare(`INSERT INTO daily_snapshots
    (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,
     quality_status,source_status,business_date,last_validated_at)
    VALUES(?,?,?,?,?,?,'verified','available',?,?)`)
    .run(businessDate, '业务日期门禁测试中心', 100, 80, 70, 1, businessDate, freshTimestamp())
}

type JsonObject = Record<string, unknown>
type PublicationSource = { sourceKey: string; status: string }

async function getJson(pathname: string): Promise<JsonObject> {
  const response = await fetch(`${baseUrl}${pathname}`)
  assert.equal(response.status, 200, await response.clone().text())
  return response.json() as Promise<JsonObject>
}

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('管理员首页使用通过门禁的APH华北地区正式卡片而非服务中心明细合计', async () => {
  const businessDate = new Date().toISOString().slice(0, 10)
  writeAph(businessDate)

  const summary = await getJson('/api/summary')
  assert.equal(summary.aphSourceStatus, 'available')
  assert.equal(summary.annualBudget, 100)
  assert.equal(summary.cumulativeBudget, 80)
  assert.equal(summary.cumulativeExecuted, 70)
  assert.equal(summary.samePeriod, 60)
})

test('summary and publication status reject stale or future business dates despite fresh validation and available status', async () => {
  for (const businessDate of ['2000-01-01', '2099-01-01']) {
    writeAph(businessDate)
    writeDaily(businessDate)

    const summary = await getJson('/api/summary')
    assert.equal(summary.aphSourceStatus, 'unavailable', `${businessDate}不得输出APH正式KPI`)
    assert.equal(summary.annualBudget, null)
    assert.equal(summary.cumulativeBudget, null)
    assert.equal(summary.cumulativeExecuted, null)
    assert.equal(summary.samePeriod, null)

    const publication = await getJson('/api/data-sources/publication-status')
    const sources = publication.sources as PublicationSource[]
    const aph = sources.find(source => source.sourceKey === 'aph')
    const finereport = sources.find(source => source.sourceKey === 'finereport')
    assert.ok(aph)
    assert.ok(finereport)
    assert.notEqual(aph.status, 'ready', `${businessDate} APH不得ready`)
    assert.notEqual(finereport.status, 'ready', `${businessDate}中心快照不得ready`)
    assert.equal(publication.isComplete, false)
  }
})
