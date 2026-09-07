import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { dailyCenterFixture } from './helpers/daily-reconciliation-fixture.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-daily-r160-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'r'.repeat(40)
process.env.NODE_ENV = 'test'

const [{ default: express }, { default: db }, reconciliation, { default: dailyRouter }] = await Promise.all([
  import('express'),
  import('../src/db.js'),
  import('../src/daily-reconciliation.js'),
  import('../src/routes/daily.js'),
])

const app = express()
app.use((req, _res, next) => {
  ;(req as any).user = { role: 'admin', username: 'r160-test' }
  next()
})
app.use(dailyRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('R160 test server failed')
const base = `http://127.0.0.1:${address.port}`

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('R160 schema defaults existing-style reconciliations to snapshot_revision', () => {
  const columns = db.prepare("PRAGMA table_info('daily_collection_reconciliations')").all() as any[]
  const mode = columns.find(column => column.name === 'publication_mode')
  assert.ok(mode)
  assert.equal(mode.notnull, 1)
  assert.equal(mode.dflt_value, "'snapshot_revision'")
})

test('59-row legacy snapshot publishes daily_only without upgrading or rewriting snapshots', () => {
  const fixture = dailyCenterFixture('第一服务R160焦点服务中心')
  const insertPayment = db.prepare(`INSERT INTO payment_centers
    (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
    VALUES('华北',?,200,160,100,80,NULL)`)
  for (const center of fixture.canonicalCenters) insertPayment.run(center)
  const insertLegacy = db.prepare(`INSERT INTO daily_snapshots
    (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,quality_status,source_status,business_date)
    VALUES('2026-06-17',?,999,888,777,666,'unverified','unverified',NULL)`)
  for (let index = 0; index < 59; index += 1) insertLegacy.run(`历史中心${index}`)
  const before = db.prepare("SELECT * FROM daily_snapshots WHERE date='2026-06-17' ORDER BY id").all()

  const preview = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1,
    businessDate: '2026-06-17',
    extractedAt: '2026-08-30T08:30:00+08:00',
    reportId: reconciliation.DAILY_REPORT_ID,
    region: reconciliation.DAILY_REPORT_REGION,
    officialTotal: 12.34,
    rows: fixture.rawRows(12.34),
  }, 'tester')
  assert.equal(preview.status, 'previewed')
  assert.equal(preview.publicationMode, 'daily_only')
  const published = reconciliation.publishDailyReconciliation(db, preview.id, 'tester', '历史日报daily-only复核')
  assert.equal(published.status, 'published')
  assert.equal(published.publicationMode, 'daily_only')
  assert.deepEqual(db.prepare("SELECT * FROM daily_snapshots WHERE date='2026-06-17' ORDER BY id").all(), before)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM daily_collection_revision_rows WHERE reconciliation_id=?').get(preview.id) as any).n, 56)
})

test('daily API uses daily_only revision facts and returns null cumulative fields while dates includes it', async () => {
  assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-06-17'), true)
  const payload = await fetch(`${base}/api/daily?date=2026-06-17`).then(response => response.json()) as any
  assert.equal(payload.rows.length, 56)
  assert.equal(payload.dailyTotal, 12.34)
  assert.equal(payload.sourceStatus, 'available')
  const focus = payload.rows.find((row: any) => row.center === '第一服务R160焦点服务中心')
  assert.deepEqual(focus, {
    center: '第一服务R160焦点服务中心', area: '华北', annual_budget: null,
    today: null, yesterday: null, daily: 12.34,
  })
  const dates = await fetch(`${base}/api/daily/dates`).then(response => response.json()) as any[]
  assert.ok(dates.some(row => row.date === '2026-06-17'))
})

test('daily_only current gate depends on unique published revision head, not legacy snapshot contents', () => {
  db.prepare("UPDATE daily_snapshots SET quality_status='corrupt',cumulative_executed=-999 WHERE date='2026-06-17'").run()
  assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-06-17'), true)
  db.prepare("DELETE FROM daily_snapshots WHERE date='2026-06-17'").run()
  assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-06-17'), true)
  const head = db.prepare("SELECT id FROM daily_collection_reconciliations WHERE business_date='2026-06-17' AND status='published'").get() as any
  db.prepare('UPDATE daily_collection_revision_rows SET old_cumulative_executed=1 WHERE reconciliation_id=? LIMIT 1').run(head.id)
  assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-06-17'), false)
  db.prepare('UPDATE daily_collection_revision_rows SET old_cumulative_executed=NULL WHERE reconciliation_id=?').run(head.id)
})

test('56 unverified legacy rows publish daily_only and remain unverified', () => {
  const fixture = dailyCenterFixture('第一服务R160焦点服务中心')
  const insert = db.prepare(`INSERT INTO daily_snapshots
    (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,quality_status,source_status,business_date)
    VALUES('2026-06-22',?,999,888,777,666,'unverified','unverified',NULL)`)
  for (const center of fixture.canonicalCenters) insert.run(center)
  const preview = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1, businessDate: '2026-06-22', extractedAt: '2026-08-30T08:30:00+08:00',
    reportId: reconciliation.DAILY_REPORT_ID, region: reconciliation.DAILY_REPORT_REGION,
    officialTotal: 1, rows: fixture.rawRows(1),
  }, 'tester')
  assert.equal(preview.publicationMode, 'daily_only')
  reconciliation.publishDailyReconciliation(db, preview.id, 'tester', '56条旧快照只发布日报')
  assert.deepEqual(db.prepare("SELECT DISTINCT quality_status,source_status,business_date FROM daily_snapshots WHERE date='2026-06-22'").all(), [
    { quality_status: 'unverified', source_status: 'unverified', business_date: null },
  ])
  assert.deepEqual(db.prepare('SELECT DISTINCT old_cumulative_budget,old_cumulative_executed FROM daily_collection_revision_rows WHERE reconciliation_id=?').all(preview.id), [
    { old_cumulative_budget: null, old_cumulative_executed: null },
  ])
})

test('missing target date remains blocked', () => {
  const fixture = dailyCenterFixture('第一服务R160焦点服务中心')
  const preview = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1, businessDate: '2026-06-18', extractedAt: '2026-08-30T08:30:00+08:00',
    reportId: reconciliation.DAILY_REPORT_ID, region: reconciliation.DAILY_REPORT_REGION,
    officialTotal: 1, rows: fixture.rawRows(1),
  }, 'tester')
  assert.equal(preview.status, 'blocked')
  assert.match(preview.validationErrors.join('\n'), /目标业务日不存在/)
})

test('complete verified 56-row snapshot retains snapshot_revision behavior', () => {
  const fixture = dailyCenterFixture('第一服务R160焦点服务中心')
  const insert = db.prepare(`INSERT INTO daily_snapshots
    (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,quality_status,source_status,business_date,last_validated_at,field_provenance)
    VALUES('2026-08-25',?,200,160,100,0,'verified','available','2026-08-25','2026-08-25T17:30:00+08:00','{}')`)
  for (const center of fixture.canonicalCenters) insert.run(center)
  const preview = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1, businessDate: '2026-08-25', extractedAt: '2026-08-30T08:30:00+08:00',
    reportId: reconciliation.DAILY_REPORT_ID, region: reconciliation.DAILY_REPORT_REGION,
    officialTotal: 2, rows: fixture.rawRows(2),
  }, 'tester')
  assert.equal(preview.publicationMode, 'snapshot_revision')
  reconciliation.publishDailyReconciliation(db, preview.id, 'tester', '完整快照保持原修订模式')
  const row = db.prepare("SELECT daily_collection,quality_status,cumulative_executed FROM daily_snapshots WHERE date='2026-08-25' AND center='第一服务R160焦点服务中心'").get()
  assert.deepEqual(row, { daily_collection: 2, quality_status: 'verified', cumulative_executed: 100 })
})

test('malformed formal snapshot cardinality cannot bypass snapshot_revision gates', () => {
  const fixture = dailyCenterFixture('第一服务R160焦点服务中心')
  const insert = db.prepare(`INSERT INTO daily_snapshots
    (date,center,quality_status,source_status,business_date)
    VALUES('2026-08-24',?,'verified','available','2026-08-24')`)
  for (const center of fixture.canonicalCenters) insert.run(center)
  insert.run('第一服务异常第57中心')
  const preview = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1, businessDate: '2026-08-24', extractedAt: '2026-08-30T08:30:00+08:00',
    reportId: reconciliation.DAILY_REPORT_ID, region: reconciliation.DAILY_REPORT_REGION,
    officialTotal: 2, rows: fixture.rawRows(2),
  }, 'tester')
  assert.equal(preview.publicationMode, 'snapshot_revision')
  assert.equal(preview.status, 'blocked')
  assert.match(preview.validationErrors.join('\n'), /正式快照必须恰好56条/)
})

test('daily_only repeated payload is idempotent and changed payload forms a supersedes chain', () => {
  const fixture = dailyCenterFixture('第一服务R160焦点服务中心')
  const first = db.prepare("SELECT id FROM daily_collection_reconciliations WHERE business_date='2026-06-22' AND status='published'").get() as any
  const repeated = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1, businessDate: '2026-06-22', extractedAt: '2026-08-31T08:30:00+08:00',
    reportId: reconciliation.DAILY_REPORT_ID, region: reconciliation.DAILY_REPORT_REGION,
    officialTotal: 1, rows: fixture.rawRows(1),
  }, 'tester')
  assert.equal(repeated.id, first.id)
  const revised = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1, businessDate: '2026-06-22', extractedAt: '2026-08-31T08:31:00+08:00',
    reportId: reconciliation.DAILY_REPORT_ID, region: reconciliation.DAILY_REPORT_REGION,
    officialTotal: 3, rows: fixture.rawRows(3),
  }, 'tester')
  reconciliation.publishDailyReconciliation(db, revised.id, 'tester', 'daily-only修订链复核')
  assert.equal((db.prepare('SELECT supersedes_id FROM daily_collection_reconciliations WHERE id=?').get(revised.id) as any).supersedes_id, first.id)
  assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-06-22'), true)
})

test('all-zero official daily report is explicitly marked for business audit', () => {
  const fixture = dailyCenterFixture('第一服务R160焦点服务中心')
  const insertZeroLegacy = db.prepare("INSERT INTO daily_snapshots(date,center) VALUES('2026-06-19',?)")
  for (let index = 0; index < 56; index += 1) insertZeroLegacy.run(`legacy-zero-${index}`)
  const preview = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1, businessDate: '2026-06-19', extractedAt: '2026-08-30T08:30:00+08:00',
    reportId: reconciliation.DAILY_REPORT_ID, region: reconciliation.DAILY_REPORT_REGION,
    officialTotal: 0, rows: fixture.rawRows(0),
  }, 'tester')
  assert.equal(preview.zeroValueAudit, 'requires_business_confirmation')
  assert.throws(() => reconciliation.publishDailyReconciliation(db, preview.id, 'tester', '自动化默认说明'), /全零官方日报/)
  db.prepare("UPDATE daily_collection_reconciliations SET status='published',published_by='fixture',published_at=datetime('now'),zero_value_confirmed=0 WHERE id=?").run(preview.id)
  assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-06-19'), false)
  db.prepare("UPDATE daily_collection_reconciliations SET status='previewed' WHERE id=?").run(preview.id)
  const published = reconciliation.publishDailyReconciliation(db, preview.id, 'tester', '业务负责人确认当日确为零回款', {
    confirmed: true, note: '已与华北财务负责人核对官方日报原表，确认全零属实',
  })
  assert.equal(published.zeroValueAudit, 'business_confirmed')
  assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-06-19'), true)
})

test('daily_only rejects garbage snapshot cardinality during preview and publish recheck', () => {
  const fixture = dailyCenterFixture('第一服务R160焦点服务中心')
  db.prepare("INSERT INTO daily_snapshots(date,center,quality_status,source_status,business_date) VALUES('2026-06-20','垃圾行','unverified','unverified',NULL)").run()
  const garbage = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1, businessDate: '2026-06-20', extractedAt: '2026-08-30T08:30:00+08:00', reportId: reconciliation.DAILY_REPORT_ID,
    region: reconciliation.DAILY_REPORT_REGION, officialTotal: 1, rows: fixture.rawRows(1),
  }, 'tester')
  assert.equal(garbage.publicationMode, 'daily_only')
  assert.equal(garbage.status, 'blocked')
  assert.match(garbage.validationErrors.join('\n'), /历史快照基数必须为56、59或61/)

  const insert = db.prepare("INSERT INTO daily_snapshots(date,center,quality_status,source_status,business_date) VALUES('2026-06-21',?,'unverified','unverified',NULL)")
  for (let i = 0; i < 56; i += 1) insert.run(`旧中心${i}`)
  const valid = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1, businessDate: '2026-06-21', extractedAt: '2026-08-30T08:31:00+08:00', reportId: reconciliation.DAILY_REPORT_ID,
    region: reconciliation.DAILY_REPORT_REGION, officialTotal: 1, rows: fixture.rawRows(1),
  }, 'tester')
  assert.equal(valid.status, 'previewed')
  db.prepare("DELETE FROM daily_snapshots WHERE date='2026-06-21' AND id=(SELECT max(id) FROM daily_snapshots WHERE date='2026-06-21')").run()
  assert.throws(() => reconciliation.publishDailyReconciliation(db, valid.id, 'tester', '发布前基数复核'), /历史快照基数/)
})

test('56-row unverified legacy snapshot with non-null business_date remains daily_only', () => {
  const fixture = dailyCenterFixture('第一服务R160焦点服务中心')
  const insert = db.prepare("INSERT INTO daily_snapshots(date,center,quality_status,source_status,business_date) VALUES('2026-06-23',?,'unverified','unverified','2026-06-23')")
  for (const center of fixture.canonicalCenters) insert.run(center)
  const preview = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1, businessDate: '2026-06-23', extractedAt: '2026-08-30T08:30:00+08:00', reportId: reconciliation.DAILY_REPORT_ID,
    region: reconciliation.DAILY_REPORT_REGION, officialTotal: 1, rows: fixture.rawRows(1),
  }, 'tester')
  assert.equal(preview.publicationMode, 'daily_only')
  assert.equal(preview.status, 'previewed')
})

test('A to B to A rollback creates a new auditable unique head and is idempotent', () => {
  const fixture = dailyCenterFixture('第一服务R160焦点服务中心')
  const payload = (value: number, extractedAt: string) => ({ schemaVersion: 1 as const, businessDate: '2026-06-22', extractedAt,
    reportId: reconciliation.DAILY_REPORT_ID, region: reconciliation.DAILY_REPORT_REGION, officialTotal: value, rows: fixture.rawRows(value) })
  const headB = db.prepare("SELECT current.id FROM daily_collection_reconciliations current WHERE current.business_date='2026-06-22' AND current.status='published' AND NOT EXISTS(SELECT 1 FROM daily_collection_reconciliations s WHERE s.supersedes_id=current.id AND s.status='published')").get() as any
  const rollback = reconciliation.previewDailyReconciliation(db, payload(1, '2026-09-01T08:30:00+08:00'), 'tester')
  assert.equal(rollback.status, 'previewed')
  assert.notEqual(rollback.id, headB.id)
  reconciliation.publishDailyReconciliation(db, rollback.id, 'tester', '业务确认回滚至A版本')
  assert.equal((db.prepare('SELECT supersedes_id FROM daily_collection_reconciliations WHERE id=?').get(rollback.id) as any).supersedes_id, headB.id)
  const repeated = reconciliation.previewDailyReconciliation(db, payload(1, '2026-09-02T08:30:00+08:00'), 'tester')
  assert.equal(repeated.id, rollback.id)
  const heads = db.prepare("SELECT current.id FROM daily_collection_reconciliations current WHERE current.business_date='2026-06-22' AND current.status='published' AND NOT EXISTS(SELECT 1 FROM daily_collection_reconciliations s WHERE s.supersedes_id=current.id AND s.status='published')").all()
  assert.deepEqual(heads, [{ id: rollback.id }])
})

test('bounded official-detail difference requires business confirmation and publishes official total without rewriting detail rows', async () => {
  const fixture = dailyCenterFixture('第一服务R161差异确认服务中心')
  const insertPayment = db.prepare(`INSERT OR IGNORE INTO payment_centers
    (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
    VALUES('华北',?,200,160,100,80,NULL)`)
  for (const canonical of fixture.canonicalCenters) insertPayment.run(canonical)
  const insertSnapshot = db.prepare(`INSERT INTO daily_snapshots
    (date,center,business_date,annual_budget,cumulative_budget,cumulative_executed,daily_collection,
     quality_status,source_status,last_validated_at,field_provenance)
    VALUES('2026-08-23',?,'2026-08-23',200,160,100,1,'verified','available','2026-08-23T17:30:00+08:00','{}')`)
  for (const canonical of fixture.canonicalCenters) insertSnapshot.run(canonical)

  const preview = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1, businessDate: '2026-08-23', extractedAt: '2026-08-30T08:30:00+08:00',
    reportId: reconciliation.DAILY_REPORT_ID, region: reconciliation.DAILY_REPORT_REGION,
    officialTotal: 10.03, rows: fixture.rawRows(10),
  }, 'tester')
  assert.equal(preview.status, 'previewed')
  assert.equal(preview.publishable, true)
  assert.equal(preview.totalDifferenceAudit, 'requires_business_confirmation')
  assert.equal(preview.totalDifference, 0.03)
  assert.throws(() => reconciliation.publishDailyReconciliation(db, preview.id, 'tester', '缺少差异业务确认'), /汇总与明细差异/)

  const published = reconciliation.publishDailyReconciliation(db, preview.id, 'zhangye', '按FineReport官方汇总发布并保留明细差异', undefined, {
    confirmed: true, note: '张野确认以FineReport官方汇总为正式总额，中心明细保持原值并留痕',
  })
  assert.equal(published.totalDifferenceAudit, 'business_confirmed')
  assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-08-23'), true)
  const persisted = db.prepare(`SELECT official_total,detail_total,total_difference_confirmed,total_difference_confirm_note
    FROM daily_collection_reconciliations WHERE id=?`).get(preview.id)
  assert.deepEqual(persisted, {
    official_total: 10.03, detail_total: 10,
    total_difference_confirmed: 1,
    total_difference_confirm_note: '张野确认以FineReport官方汇总为正式总额，中心明细保持原值并留痕',
  })
  const snapshot = db.prepare(`SELECT daily_collection,cumulative_budget,cumulative_executed
    FROM daily_snapshots WHERE date='2026-08-23' AND center=?`).get('第一服务R161差异确认服务中心')
  assert.deepEqual(snapshot, { daily_collection: 10, cumulative_budget: 160, cumulative_executed: 100 })

  const payload = await fetch(`${base}/api/daily?date=2026-08-23`).then(response => response.json()) as any
  assert.equal(payload.dailyTotal, 10.03)
  assert.equal(payload.officialTotal, 10.03)
  assert.equal(payload.detailTotal, 10)
  assert.equal(payload.reconciliationDifference, 0.03)
  assert.equal(payload.totalBasis, 'official_total_confirmed')
  assert.equal(payload.rows.reduce((sum: number, row: any) => sum + row.daily, 0), 10)

  const overPrecision = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1, businessDate: '2026-08-23', extractedAt: '2026-08-31T08:30:00+08:00',
    reportId: reconciliation.DAILY_REPORT_ID, region: reconciliation.DAILY_REPORT_REGION,
    officialTotal: 10.054, rows: fixture.rawRows(10),
  }, 'tester')
  assert.equal(overPrecision.status, 'blocked')
  assert.match(overPrecision.validationErrors.join('\n'), /officialTotal.*最多两位小数/)

  const overPrecisionRow = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1, businessDate: '2026-08-23', extractedAt: '2026-08-31T08:31:00+08:00',
    reportId: reconciliation.DAILY_REPORT_ID, region: reconciliation.DAILY_REPORT_REGION,
    officialTotal: 10, rows: fixture.rawRows(10.001),
  }, 'tester')
  assert.equal(overPrecisionRow.status, 'blocked')
  assert.match(overPrecisionRow.validationErrors.join('\n'), /中心日回款最多两位小数/)
})
