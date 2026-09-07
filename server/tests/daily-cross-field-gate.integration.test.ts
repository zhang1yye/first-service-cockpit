import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { dailyCenterFixture } from './helpers/daily-reconciliation-fixture.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-daily-cross-field-gate-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_RAW_ARCHIVE_DIR = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'daily-cross-field-gate-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'

const [{ default: express }, { default: db }, { default: dailyRouter }, { hasCurrentPublishedSnapshotRevision }] = await Promise.all([
  import('express'),
  import('../src/db.js'),
  import('../src/routes/daily.js'),
  import('../src/daily-reconciliation.js'),
])

type DailyPayload = {
  dailyTotal: number | null
  sourceStatus: string
  fallbackReason?: string
  note?: string
  rows: Array<{ center: string; daily: number | null }>
}

const center = '第一服务批次22结构化夹具服务中心'
db.prepare(`INSERT INTO payment_centers
  (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
  VALUES('华北',?,200,160,128.18,100,NULL)`).run(center)

const insertSnapshot = db.prepare(`INSERT INTO daily_snapshots
  (date,center,business_date,annual_budget,cumulative_budget,cumulative_executed,daily_collection,
   quality_status,source,source_status,last_validated_at)
  VALUES(?,?,?,?,?,?,?,'verified','FineReport回款日报','available',?)`)
insertSnapshot.run('2026-08-27', center, '2026-08-27', 200, 160, 99, 0, '2026-08-27T17:30:00+08:00')
insertSnapshot.run('2026-08-28', center, '2026-08-28', 200, 160, 100, 0, '2026-08-28T17:30:00+08:00')
insertSnapshot.run('2026-08-29', center, '2026-08-29', 200, 160, 128.18, 0, '2026-08-29T17:30:00+08:00')
insertSnapshot.run('2026-08-30', center, '2026-08-30', 200, 160, 130, null, '2026-08-30T17:30:00+08:00')

function writeFormalArchive(bundle: Record<string, unknown>) {
  const businessDate = String(bundle.business_date)
  const sources = [
    { key: 'aph', name: 'aph.json', content: Buffer.from('{}') },
    { key: 'paymentDetail', name: 'payment-detail.json', content: Buffer.from('[]') },
    { key: 'lvzai', name: 'lvzai.json', content: Buffer.from('{}') },
    { key: 'collectionDetail', name: 'collection-detail.json', content: Buffer.from('[]') },
    { key: 'collectionSummary', name: 'collection-summary.json', content: Buffer.from('{}') },
    { key: 'normalized', name: 'normalized.json', content: Buffer.from(JSON.stringify(bundle)) },
  ].map(file => ({ ...file, sha256: crypto.createHash('sha256').update(file.content).digest('hex') }))
  const batchSha256 = crypto.createHash('sha256')
    .update(sources.slice().sort((left, right) => left.key.localeCompare(right.key)).map(file => file.sha256).join(':'))
    .digest('hex')
  const archiveDir = path.join(root, businessDate, batchSha256.slice(0, 16))
  fs.mkdirSync(archiveDir, { recursive: true })
  const sourceFiles = sources.map(file => {
    const filePath = path.join(archiveDir, `${file.key}-${file.name}`)
    fs.writeFileSync(filePath, file.content)
    return { key: file.key, name: file.name, path: filePath, size: file.content.length, sha256: file.sha256 }
  })
  return {
    archiveDir,
    batchSha256,
    sourceFiles,
    normalized: sources.find(file => file.key === 'normalized')!.content,
    normalizedPath: sourceFiles.find(file => file.key === 'normalized')!.path,
  }
}

const batch22Bundle = {
  schema_version: 2,
  business_date: '2026-08-29',
  payment_centers: [{ area: '华北', center, annual_budget: 200, cumulative_budget: 160, cumulative_executed: 128.18, same_period: 100, collection_rate: null }],
  daily_snapshots: [{
    date: '2026-08-29', center, annual_budget: 200, cumulative_budget: 160, cumulative_executed: 128.18,
    daily_collection: 0, quality_status: 'verified', source: 'FineReport回款日报', source_status: 'available',
    business_date: '2026-08-29', last_validated_at: '2026-08-29T17:30:00+08:00', field_provenance: {},
  }],
  collection_centers: Array.from({ length: 35 }, (_, index) => ({
    area: '华北', center: `收缴中心${index}`, receivable: 10, received: 5, collectionRate: 0.5,
  })),
}
const {
  archiveDir: batch22ArchiveDir,
  batchSha256: batch22Sha256,
  sourceFiles: batch22SourceFiles,
  normalized: batch22Normalized,
  normalizedPath: batch22NormalizedPath,
} = writeFormalArchive(batch22Bundle)

const batch21Bundle = {
  ...batch22Bundle,
  business_date: '2026-08-28',
  payment_centers: batch22Bundle.payment_centers.map(row => ({ ...row, cumulative_executed: 100 })),
  daily_snapshots: batch22Bundle.daily_snapshots.map(row => ({
    ...row,
    date: '2026-08-28',
    business_date: '2026-08-28',
    cumulative_executed: 100,
    last_validated_at: '2026-08-28T17:30:00+08:00',
  })),
}
const {
  archiveDir: batch21ArchiveDir,
  batchSha256: batch21Sha256,
  sourceFiles: batch21SourceFiles,
} = writeFormalArchive(batch21Bundle)
db.prepare(`INSERT INTO data_ingestion_batches
  (id,source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,publishable,
   row_count,mapped_count,unmapped_count,validation_errors,summary,published_by,published_at)
  VALUES(21,'aph-finereport-lvzai','2026-08-28','2026-08-28T17:30:00+08:00',?,?,?,'published',1,
   1,35,0,'[]',?,'Hermes','2026-08-28 17:34:52')`)
  .run(batch21Sha256, JSON.stringify(batch21SourceFiles), batch21ArchiveDir, JSON.stringify({
    dailyReview: { status: 'not_applicable', reason: null, cumulativeChange: null, officialDailyTotal: null, baselineBatchId: null },
  }))

db.prepare(`INSERT INTO data_ingestion_batches
  (id,source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,publishable,
   row_count,mapped_count,unmapped_count,validation_errors,summary,published_by,published_at,confirm_note)
  VALUES(22,'aph-finereport-lvzai','2026-08-29','2026-08-29T17:30:00+08:00',?,?,?,'published',1,
   56,35,0,'[]',?,'Hermes','2026-08-29 17:34:52','Hermes 17:30每日双源校验通过自动发布')`)
  .run(batch22Sha256, JSON.stringify(batch22SourceFiles), batch22ArchiveDir, JSON.stringify({
    diff: { changed: 11 },
    dailyReview: { status: 'pending_review', reason: '累计执行变动28.18万元与官方日回款0万元不勾稽', cumulativeChange: 28.18, officialDailyTotal: 0, baselineBatchId: 21 },
    totals: {
      before: { cumulative_executed: 13832.32 },
      after: { cumulative_executed: 13860.50, daily_collection: 0 },
    },
  }))

function insertFormalPublication(batchId: number, businessDate: string) {
  const insertRow = db.prepare(`INSERT INTO data_ingestion_rows
    (batch_id,entity_type,source_key,canonical_key,mapping_method,change_type,changed_fields,payload)
    VALUES(?,?,?,?,?,?,?,?)`)
  insertRow.run(batchId, 'payment_center', 'payment-0', 'payment-0', 'exact', 'snapshot', '[]', '{}')
  insertRow.run(batchId, 'daily_snapshot', 'daily-0', 'daily-0', 'exact', 'snapshot', '[]', '{}')
  for (let index = 0; index < 35; index += 1) {
    insertRow.run(batchId, 'collection_center', `collection-${index}`, `collection-${index}`, 'exact', 'snapshot', '[]', '{}')
  }
  db.prepare(`INSERT INTO data_ingestion_publications
    (batch_id,business_date,backup_payload,backup_sha256,payment_rows,snapshot_rows,collection_rows,published_by,published_at)
    VALUES(?,?,?,?,1,1,35,'tester','2026-08-29 17:34:52')`)
    .run(batchId, businessDate, '{}', String(batchId).padStart(64, '0').slice(-64))
}

insertFormalPublication(21, '2026-08-28')
insertFormalPublication(22, '2026-08-29')

db.prepare(`INSERT INTO data_ingestion_batches
  (id,source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,publishable,
   row_count,mapped_count,unmapped_count,validation_errors,summary,published_by,published_at,confirm_note)
  VALUES(23,'伪published遮蔽批次','2026-08-29','2026-08-29T17:35:00+08:00',?,'[]',?,'published',1,
   56,35,0,'[]',?,'tester','2026-08-29 17:35:00','无正式发布回执')`)
  .run('3'.repeat(64), root, JSON.stringify({
    totals: { before: { cumulative_executed: 13860.50 }, after: { cumulative_executed: 13860.50, daily_collection: 0 } },
  }))

db.prepare(`INSERT INTO data_ingestion_batches
  (id,source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,publishable,
   row_count,mapped_count,unmapped_count,validation_errors,summary,published_by,published_at,confirm_note)
  VALUES(24,'伪published污染批次','2026-08-28','2026-08-28T17:35:00+08:00',?,'[]',?,'published',1,
   56,35,0,'[]',?,'tester','2026-08-28 17:35:00','无正式发布回执')`)
  .run('4'.repeat(64), root, JSON.stringify({
    totals: { before: { cumulative_executed: 100 }, after: { cumulative_executed: 128.18, daily_collection: 0 } },
  }))

db.prepare(`INSERT INTO data_ingestion_batches
  (id,source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,publishable,
   row_count,mapped_count,unmapped_count,validation_errors,summary,published_by,published_at,confirm_note)
  VALUES(25,'回执失效批次','2026-08-27','2026-08-27T17:35:00+08:00',?,'[]',?,'published',1,
   1,35,0,'[]','{}','tester','2026-08-27 17:35:00','无有效正式回执')`)
  .run('5'.repeat(64), root)

const app = express()
app.use((req, _res, next) => { Object.assign(req, { user: { role: 'admin', username: 'tester' } }); next() })
app.use(dailyRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('每日回款跨字段门禁测试服务启动失败')
const base = `http://127.0.0.1:${address.port}`

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('17:30正式批次保留两个源的原值并标记待次日复核', async () => {
  assert.equal(hasCurrentPublishedSnapshotRevision(db, '2026-08-29'), false)
  const response = await fetch(`${base}/api/daily?date=2026-08-29`)
  assert.equal(response.status, 200)
  const payload = await response.json() as DailyPayload
  assert.equal(payload.dailyTotal, 0)
  assert.equal(payload.sourceStatus, 'pending_review')
  assert.match(payload.fallbackReason, /批次22/)
  assert.match(payload.fallbackReason, /累计执行.*28\.18.*日回款.*0/)
  assert.match(payload.note, /待次日复核/)
  assert.equal(payload.rows[0].daily, 0)
  assert.notEqual(payload.rows[0].daily, 28.18)
})

test('17:30待复核接口忽略发布后可变快照中的伪造日报值', async () => {
  db.prepare("UPDATE daily_snapshots SET daily_collection=28.18 WHERE date='2026-08-29' AND center=?").run(center)
  try {
    const response = await fetch(`${base}/api/daily?date=2026-08-29`)
    assert.equal(response.status, 200)
    const payload = await response.json() as DailyPayload
    assert.equal(payload.sourceStatus, 'pending_review')
    assert.equal(payload.dailyTotal, 0)
    assert.equal(payload.rows[0].daily, 0)
  } finally {
    db.prepare("UPDATE daily_snapshots SET daily_collection=0 WHERE date='2026-08-29' AND center=?").run(center)
  }
})

test('17:30待复核归档被修改后接口失败关闭且不回退可变快照', async () => {
  fs.appendFileSync(batch22NormalizedPath, '\n')
  try {
    const response = await fetch(`${base}/api/daily?date=2026-08-29`)
    assert.equal(response.status, 200)
    const payload = await response.json() as DailyPayload
    assert.equal(payload.sourceStatus, 'partial')
    assert.equal(payload.dailyTotal, null)
    assert.equal(payload.rows[0].daily, null)
    assert.match(payload.note || '', /归档.*变化|证据.*异常/)
  } finally {
    fs.writeFileSync(batch22NormalizedPath, batch22Normalized)
  }
})

test('仅伪published冲突批次不能污染累计未变的真实0', async () => {
  const payload = await fetch(`${base}/api/daily?date=2026-08-28`).then(response => response.json()) as DailyPayload
  assert.equal(payload.dailyTotal, 0)
  assert.equal(payload.sourceStatus, 'available')
  assert.equal(payload.rows[0].daily, 0)
  assert.equal(payload.fallbackReason, undefined)
})

test('published批次正式回执失效时不回退可变快照', async () => {
  const payload = await fetch(`${base}/api/daily?date=2026-08-27`).then(response => response.json()) as DailyPayload
  assert.equal(payload.dailyTotal, null)
  assert.equal(payload.sourceStatus, 'partial')
  assert.equal(payload.rows[0].daily, null)
  assert.match(payload.fallbackReason || '', /正式回执|证据.*失效/)
})

test('官方日报NULL不使用累计差伪装为本日回款', async () => {
  const payload = await fetch(`${base}/api/daily?date=2026-08-30`).then(response => response.json()) as DailyPayload
  assert.equal(payload.dailyTotal, null)
  assert.equal(payload.sourceStatus, 'partial')
  assert.match(payload.fallbackReason, /官方日报字段缺失/)
  assert.match(payload.note, /待核验/)
  assert.equal(payload.rows[0].daily, null)
  assert.notEqual(payload.rows[0].daily, 1.82)
})

test('正式历史日报专项复核发布后解除旧批次冲突且仍不使用累计差', async () => {
  const fixture = dailyCenterFixture(center)
  for (const extraCenter of fixture.canonicalCenters.filter((value) => value !== center)) {
    insertSnapshot.run('2026-08-29', extraCenter, '2026-08-29', 200, 160, 128.18, 0, '2026-08-29T17:30:00+08:00')
  }
  const result = db.prepare(`INSERT INTO daily_collection_reconciliations
    (business_date,extracted_at,report_id,region,official_total,detail_total,source_row_count,
     payload_sha256,status,validation_errors,created_by,published_by,published_at,confirm_note)
    VALUES('2026-08-29','2026-08-30T08:30:00+08:00',
     '810ca5a0-b239-466b-85c2-386373244c8e','华北地区',12.34,12.34,61,?,'published','[]',
     'tester','tester','2026-08-30 08:31:00','次日官方日报复核通过')`).run('9'.repeat(64))
  const insertRevision = db.prepare(`INSERT INTO daily_collection_revision_rows
    (reconciliation_id,center,old_daily_collection,new_daily_collection,old_cumulative_budget,
     old_cumulative_executed,old_last_validated_at,old_field_provenance)
    VALUES(?,?,?,?,160,128.18,'2026-08-29T17:30:00+08:00','{}')`)
  for (const canonical of fixture.canonicalCenters) {
    const value = canonical === center ? 12.34 : 0
    insertRevision.run(result.lastInsertRowid, canonical, 0, value)
    const provenance = JSON.stringify({
      daily_collection: {
        source: 'FineReport回款日报历史专项复核',
        reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
        businessDate: '2026-08-29',
        extractedAt: '2026-08-30T08:30:00+08:00',
        dailyReconciliationId: Number(result.lastInsertRowid),
      },
    })
    db.prepare(`UPDATE daily_snapshots SET daily_collection=?,last_validated_at='2026-08-30T08:30:00+08:00',field_provenance=?
      WHERE date='2026-08-29' AND center=?`).run(value, provenance, canonical)
  }

  assert.equal(hasCurrentPublishedSnapshotRevision(db, '2026-08-29'), true)
  const crossDateSuccessor = db.prepare(`INSERT INTO daily_collection_reconciliations
    (business_date,extracted_at,report_id,region,official_total,detail_total,source_row_count,
     payload_sha256,status,validation_errors,supersedes_id,created_by,published_by,published_at,confirm_note)
    VALUES('2026-08-30','2026-08-31T08:30:00+08:00',
     '810ca5a0-b239-466b-85c2-386373244c8e','华北地区',0,0,61,?,'published','[]',?,
     'tester','tester','2026-08-31 08:31:00','跨日异常链数据不得遮蔽目标日链头')`)
    .run('8'.repeat(64), result.lastInsertRowid)
  assert.equal(hasCurrentPublishedSnapshotRevision(db, '2026-08-29'), true)
  db.prepare('DELETE FROM daily_collection_reconciliations WHERE id=?').run(crossDateSuccessor.lastInsertRowid)
  fs.appendFileSync(batch22NormalizedPath, '\n')
  try {
    const payload = await fetch(`${base}/api/daily?date=2026-08-29`).then(response => response.json()) as DailyPayload
    assert.equal(payload.dailyTotal, 12.34)
    assert.equal(payload.sourceStatus, 'available')
    const row = payload.rows.find((value) => value.center === center)!
    assert.equal(row.daily, 12.34)
    assert.notEqual(row.daily, 28.18)
    assert.equal(payload.fallbackReason, undefined)
  } finally {
    fs.writeFileSync(batch22NormalizedPath, batch22Normalized)
  }
})

test('已发布复核与当前快照不一致时重新触发冲突门禁', async () => {
  db.prepare(`UPDATE daily_snapshots SET daily_collection=99 WHERE date='2026-08-29' AND center=?`).run(center)
  assert.equal(hasCurrentPublishedSnapshotRevision(db, '2026-08-29'), false)
  const payload = await fetch(`${base}/api/daily?date=2026-08-29`).then(response => response.json()) as DailyPayload
  assert.equal(payload.dailyTotal, null)
  assert.equal(payload.sourceStatus, 'partial')
  assert.match(payload.fallbackReason || '', /未使用累计差/)
})
