import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import jwt from 'jsonwebtoken'
import { dailyCenterFixture } from './helpers/daily-reconciliation-fixture.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-daily-reconciliation-route-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_RAW_ARCHIVE_DIR = path.join(root, 'raw')
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'y'.repeat(40)
process.env.DAILY_RECONCILIATION_JWT_SECRET = 'automation-only-secret-'.repeat(2)
process.env.NODE_ENV = 'test'

const [{ default: express }, { default: db }, { default: router }, auth] = await Promise.all([
  import('express'),
  import('../src/db.js'),
  import('../src/routes/data-pipeline.js'),
  import('../src/auth.js'),
])
const center = '第一服务专项复核API测试服务中心'
const fixture = dailyCenterFixture(center)
const insertSnapshot = db.prepare(`INSERT INTO daily_snapshots
  (date,center,business_date,annual_budget,cumulative_budget,cumulative_executed,daily_collection,
   quality_status,source,source_status,last_validated_at,field_provenance)
  VALUES('2026-08-28',?,'2026-08-28',200,160,100,1,'verified','FineReport回款日报','available',
   '2026-08-28T17:30:00+08:00','{}')`)
for (const canonical of fixture.canonicalCenters) insertSnapshot.run(canonical)

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(auth.requireAuth)
app.use(router)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('历史日报专项复核API测试服务启动失败')
const base = `http://127.0.0.1:${address.port}`
const admin = db.prepare("SELECT id,username FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any
const humanToken = auth.signToken({ userId: admin.id, username: admin.username, role: 'admin' })
const automationToken = auth.signDailyReconciliationAutomationToken()
const token = automationToken
const authHeaders = (value: string) => ({ Authorization: ['Bea', 'rer ', value].join(''), 'Content-Type': 'application/json' })

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('专项自动化身份仅通过受控API预览并发布并以专用主体审计', async () => {
  const previewResponse = await fetch(`${base}/api/data-pipeline/daily-reconciliations/preview`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 1,
      businessDate: '2026-08-28',
      extractedAt: '2026-08-29T08:30:00+08:00',
      reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
      region: '华北地区',
      officialTotal: 2.5,
      rows: fixture.rawRows(2.5),
    }),
  })
  assert.equal(previewResponse.status, 200)
  const preview = await previewResponse.json() as any
  assert.equal(preview.batch.status, 'previewed')
  assert.equal(preview.batch.publishable, true)

  const publishResponse = await fetch(`${base}/api/data-pipeline/daily-reconciliations/${preview.batch.id}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmNote: '次日官方日报复核通过' }),
  })
  assert.equal(publishResponse.status, 200)
  const published = await publishResponse.json() as any
  assert.equal(published.batch.status, 'published')

  const snapshot = db.prepare(`SELECT daily_collection,cumulative_budget,cumulative_executed
    FROM daily_snapshots WHERE date='2026-08-28' AND center=?`).get(center) as any
  assert.deepEqual(snapshot, { daily_collection: 2.5, cumulative_budget: 160, cumulative_executed: 100 })
  const reconciliation = db.prepare('SELECT created_by,published_by FROM daily_collection_reconciliations WHERE id=?').get(preview.batch.id) as any
  assert.deepEqual(reconciliation, {
    created_by: 'daily-reconciliation-automation',
    published_by: 'daily-reconciliation-automation',
  })
  const audits = db.prepare(`SELECT username,action,detail FROM operation_logs
    WHERE target=? ORDER BY id`).all(`daily_collection_reconciliation:${preview.batch.id}`) as any[]
  assert.deepEqual(audits.map(row => ({ username: row.username, action: row.action })), [
    { username: 'daily-reconciliation-automation', action: '生成历史日报专项复核预览' },
    { username: 'daily-reconciliation-automation', action: '发布历史日报专项复核' },
  ])
  for (const audit of audits) {
    const detail = JSON.parse(audit.detail)
    assert.equal(detail.publication_mode, 'snapshot_revision')
    assert.equal(detail.zeroValueAudit, 'not_applicable')
  }

  const management = await fetch(`${base}/api/data-pipeline/daily-reconciliations`, { headers: authHeaders(humanToken) }).then(response => response.json()) as any
  const managementRow = management.rows.find((row: any) => row.id === preview.batch.id)
  assert.equal(managementRow.publicationMode, 'snapshot_revision')
  assert.equal(managementRow.zeroValueAudit, 'not_applicable')

  const forbidden = await fetch(`${base}/api/data-pipeline/batches`, { headers: authHeaders(automationToken) })
  assert.equal(forbidden.status, 401)

  const repeated = await fetch(`${base}/api/data-pipeline/daily-reconciliations/${preview.batch.id}/publish`, {
    method: 'POST', headers: authHeaders(automationToken), body: JSON.stringify({
      confirmNote: '不得写入幂等审计的新请求说明', zeroValueConfirmNote: '不得伪造成既有全零确认说明',
    }),
  })
  assert.equal(repeated.status, 200)
  const repeatedAudit = db.prepare(`SELECT detail FROM operation_logs
    WHERE target=? AND action='发布历史日报专项复核' ORDER BY id DESC LIMIT 1`).get(`daily_collection_reconciliation:${preview.batch.id}`) as any
  const repeatedDetail = JSON.parse(repeatedAudit.detail)
  assert.equal(repeatedDetail.confirmNote, '次日官方日报复核通过')
  assert.equal(repeatedDetail.zeroValueConfirmNote, '')
  assert.equal(repeatedDetail.confirmationDisposition, 'reuse_existing_confirmation')
})

test('全零复核重复发布复用持久确认说明且审计不被空请求覆盖', async () => {
  const insertZeroSnapshot = db.prepare(`INSERT INTO daily_snapshots
    (date,center,business_date,annual_budget,cumulative_budget,cumulative_executed,daily_collection,
     quality_status,source,source_status,last_validated_at,field_provenance)
    VALUES('2026-08-27',?,'2026-08-27',200,160,100,1,'verified','FineReport回款日报','available',
     '2026-08-27T17:30:00+08:00','{}')`)
  for (const canonical of fixture.canonicalCenters) insertZeroSnapshot.run(canonical)
  const preview = await fetch(`${base}/api/data-pipeline/daily-reconciliations/preview`, {
    method: 'POST', headers: authHeaders(humanToken), body: JSON.stringify({
      schemaVersion: 1, businessDate: '2026-08-27', extractedAt: '2026-08-28T08:30:00+08:00',
      reportId: '810ca5a0-b239-466b-85c2-386373244c8e', region: '华北地区', officialTotal: 0,
      rows: fixture.rawRows(0),
    }),
  }).then(response => response.json()) as any
  assert.equal(preview.batch.zeroValueAudit, 'requires_business_confirmation')
  const forgedAutomationConfirmation = await fetch(`${base}/api/data-pipeline/daily-reconciliations/${preview.batch.id}/publish`, {
    method: 'POST', headers: authHeaders(automationToken), body: JSON.stringify({
      confirmNote: '自动化不得替代业务负责人确认', zeroValueConfirmed: true,
      zeroValueConfirmNote: '自动化即使提供足够长说明也不得确认全零日报',
    }),
  })
  assert.equal(forgedAutomationConfirmation.status, 403)
  assert.match(((await forgedAutomationConfirmation.json()) as any).error, /全零日报.*管理员/)
  const blockedRow = db.prepare('SELECT status,zero_value_confirmed FROM daily_collection_reconciliations WHERE id=?').get(preview.batch.id) as any
  assert.deepEqual(blockedRow, { status: 'previewed', zero_value_confirmed: 0 })

  const first = await fetch(`${base}/api/data-pipeline/daily-reconciliations/${preview.batch.id}/publish`, {
    method: 'POST', headers: authHeaders(humanToken), body: JSON.stringify({
      confirmNote: '业务负责人完成全零日报发布复核', zeroValueConfirmed: true,
      zeroValueConfirmNote: '已与华北财务负责人核对原始日报，全零属实',
    }),
  })
  assert.equal(first.status, 200)
  assert.equal(((await first.json()) as any).batch.zeroValueAudit, 'business_confirmed')

  const repeated = await fetch(`${base}/api/data-pipeline/daily-reconciliations/${preview.batch.id}/publish`, {
    method: 'POST', headers: authHeaders(humanToken), body: '{}',
  })
  assert.equal(repeated.status, 200)
  assert.equal(((await repeated.json()) as any).batch.zeroValueAudit, 'business_confirmed')
  const logs = db.prepare("SELECT detail FROM operation_logs WHERE target=? AND action='发布历史日报专项复核' ORDER BY id").all(`daily_collection_reconciliation:${preview.batch.id}`) as any[]
  assert.equal(logs.length, 2)
  const repeatedDetail = JSON.parse(logs[1].detail)
  assert.equal(repeatedDetail.confirmNote, '业务负责人完成全零日报发布复核')
  assert.equal(repeatedDetail.zeroValueConfirmNote, '已与华北财务负责人核对原始日报，全零属实')
  assert.equal(repeatedDetail.confirmationDisposition, 'reuse_existing_confirmation')
})

test('人类管理员JWT仍可访问历史日报专项复核端点', async () => {
  const response = await fetch(`${base}/api/data-pipeline/daily-reconciliations/preview`, {
    method: 'POST',
    headers: authHeaders(humanToken),
    body: JSON.stringify({
      schemaVersion: 1,
      businessDate: '2026-08-28',
      extractedAt: '2026-08-29T08:30:00+08:00',
      reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
      region: '华北地区',
      officialTotal: 2.5,
      rows: fixture.rawRows(2.5),
    }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json() as any).batch.status, 'published')
})

test('汇总明细差异只能由人类管理员首次确认且重复发布复用持久审计', async () => {
  const insertDifferenceSnapshot = db.prepare(`INSERT INTO daily_snapshots
    (date,center,business_date,annual_budget,cumulative_budget,cumulative_executed,daily_collection,
     quality_status,source,source_status,last_validated_at,field_provenance)
    VALUES('2026-08-26',?,'2026-08-26',200,160,100,1,'verified','FineReport回款日报','available',
     '2026-08-26T17:30:00+08:00','{}')`)
  for (const canonical of fixture.canonicalCenters) insertDifferenceSnapshot.run(canonical)
  const preview = await fetch(`${base}/api/data-pipeline/daily-reconciliations/preview`, {
    method: 'POST', headers: authHeaders(automationToken), body: JSON.stringify({
      schemaVersion: 1, businessDate: '2026-08-26', extractedAt: '2026-08-27T08:30:00+08:00',
      reportId: '810ca5a0-b239-466b-85c2-386373244c8e', region: '华北地区',
      officialTotal: 2.53, rows: fixture.rawRows(2.5),
    }),
  }).then(response => response.json()) as any
  assert.equal(preview.batch.status, 'previewed')
  assert.equal(preview.batch.totalDifferenceAudit, 'requires_business_confirmation')
  assert.equal(preview.batch.totalDifference, 0.03)

  const forged = await fetch(`${base}/api/data-pipeline/daily-reconciliations/${preview.batch.id}/publish`, {
    method: 'POST', headers: authHeaders(automationToken), body: JSON.stringify({
      confirmNote: '自动化不得代替业务负责人确认汇总明细差异',
      totalDifferenceConfirmed: true,
      totalDifferenceConfirmNote: '自动化即使提供足够长说明也不得确认官方汇总优先',
    }),
  })
  assert.equal(forged.status, 403)
  assert.match(((await forged.json()) as any).error, /汇总与明细差异.*管理员/)

  const confirmed = await fetch(`${base}/api/data-pipeline/daily-reconciliations/${preview.batch.id}/publish`, {
    method: 'POST', headers: authHeaders(humanToken), body: JSON.stringify({
      confirmNote: '业务负责人确认按FineReport官方汇总发布',
      totalDifferenceConfirmed: true,
      totalDifferenceConfirmNote: '张野确认以FineReport官方汇总为正式总额，中心明细保持原值并留痕',
    }),
  })
  assert.equal(confirmed.status, 200)
  assert.equal(((await confirmed.json()) as any).batch.totalDifferenceAudit, 'business_confirmed')

  const repeated = await fetch(`${base}/api/data-pipeline/daily-reconciliations/${preview.batch.id}/publish`, {
    method: 'POST', headers: authHeaders(automationToken), body: '{}',
  })
  assert.equal(repeated.status, 200)
  assert.equal(((await repeated.json()) as any).batch.totalDifferenceAudit, 'business_confirmed')
  const audit = db.prepare(`SELECT detail FROM operation_logs WHERE target=? AND action='发布历史日报专项复核' ORDER BY id DESC LIMIT 1`)
    .get(`daily_collection_reconciliation:${preview.batch.id}`) as any
  const detail = JSON.parse(audit.detail)
  assert.equal(detail.totalDifferenceConfirmNote, '张野确认以FineReport官方汇总为正式总额，中心明细保持原值并留痕')
  assert.equal(detail.confirmationDisposition, 'reuse_existing_confirmation')
})

test('泄露专项自动化密钥不能伪造verifyToken接受的人类JWT', () => {
  const forgedHumanToken = jwt.sign({
    userId: admin.id,
    username: admin.username,
    role: 'admin',
    tokenVersion: 0,
  }, process.env.DAILY_RECONCILIATION_JWT_SECRET!)
  assert.equal(auth.verifyToken(forgedHumanToken), null)
})
