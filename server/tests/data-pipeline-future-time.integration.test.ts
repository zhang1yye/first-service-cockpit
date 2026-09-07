import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type { NormalizedBundle } from '../src/data-pipeline.js'
import { dailyCenterFixture } from './helpers/daily-reconciliation-fixture.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-p46-future-time-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'p46-future-time-jwt-secret-at-least-32-characters'
process.env.COCKPIT_RAW_ARCHIVE_DIR = path.join(root, 'raw')
process.env.COCKPIT_ROOT = path.join(root, 'cockpit')
fs.mkdirSync(process.env.COCKPIT_ROOT, { recursive: true })
process.env.NODE_ENV = 'test'

const [{ default: db }, { default: dataPipelineRouter }, { signToken }, { previewDailyReconciliation, publishDailyReconciliation }] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/data-pipeline.js'),
  import('../src/auth.js'),
  import('../src/daily-reconciliation.js'),
])

const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  (req as express.Request & { user?: { userId: number; username: string; role: string } }).user = {
    userId: 1, username: 'future-time-test', role: 'admin',
  }
  next()
})
app.use(dataPipelineRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  if (server.listening) return resolve()
  server.once('listening', resolve)
  server.once('error', reject)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
const baseUrl = `http://127.0.0.1:${address.port}`
const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as { id: number; username: string; role: string }
const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })

const sha = (content: Buffer) => crypto.createHash('sha256').update(content).digest('hex')
const businessDateInShanghai = (now: Date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now)
const validBusinessDate = businessDateInShanghai(new Date())
const priorBusinessDate = businessDateInShanghai(new Date(Date.now() - 86_400_000))
const trustedBusinessDate = businessDateInShanghai(new Date(Date.now() - 2 * 86_400_000))
const validExtractedAt = new Date(Date.now() - 10 * 60_000).toISOString()
const validValidatedAt = new Date(Date.now() - 5 * 60_000).toISOString()

const provenance = {
  annual_budget: { report: '预算周报', label: '全年预算' },
  cumulative_budget: { report: '回款日报', label: '累计预算' },
  cumulative_executed: { report: '回款日报', label: '累计执行' },
  daily_collection: { report: '回款日报', label: '本日回款' },
}

function validBundle(): NormalizedBundle {
  const businessDate = validBusinessDate
  const paymentCenters = Array.from({ length: 40 }, (_, index) => ({
    area: '测试片区', center: `APH未来时间测试中心${index + 1}`, annual_budget: 110,
    cumulative_budget: 95, cumulative_executed: 100, same_period: 90, collection_rate: null,
  }))
  return {
    schema_version: 2,
    business_date: businessDate,
    extracted_at: validExtractedAt,
    source_status: 'available',
    last_validated_at: validValidatedAt,
    field_provenance: {
      年度预算_万: '华北地区卡片/年度预算',
      累计预算_万: '华北地区卡片/累计预算',
      累计执行_万: '华北地区卡片/累计执行',
      同期执行_万: '华北地区卡片/同期执行',
      增幅: '华北地区卡片/增幅并经公式勾稽',
    },
    source_layers: {
      regionCard: { source: '执行评估华北卡片', businessDate, values: { annualBudget: 100, cumulativeBudget: 95, cumulativeExecuted: 100, samePeriod: 90, growthPercent: 11.11 } },
      budgetWeekly: { source: '预算周报', businessDate, values: { annualBudget: 103, cumulativeBudget: 96, centerCount: 40 } },
      centerDetail: { source: '中心明细', businessDate, values: { annualBudget: 4400, cumulativeBudget: 3800, cumulativeExecuted: 4000, samePeriod: 3600, centerCount: 40 } },
    },
    reconciliations: {},
    payment_centers: paymentCenters,
    daily_snapshots: paymentCenters.map(row => ({
      date: businessDate, center: row.center, annual_budget: row.annual_budget,
      cumulative_budget: row.cumulative_budget, cumulative_executed: row.cumulative_executed,
      daily_collection: 2, quality_status: 'verified', quality_reason: '',
      source: 'FineReport三报表中心明细', source_status: 'available', business_date: businessDate,
      last_validated_at: validValidatedAt, field_provenance: provenance,
    })),
    collection_centers: Array.from({ length: 35 }, (_, index) => ({
      area: '测试片区', center: `第一服务绿仔测试中心${index + 1}`, receivable: 100,
      received: 60, outstanding: 40, collectionRate: 0.6,
    })),
    collection_summary: {
      collectionRate: 0.6, receivable_万: 3500, received_万: 2100, outstanding_万: 1400,
      periodCorrection: { correctedRate: 0.6, rateField: 'gatheringCurrentYearRecedRate', rateAggregation: '按receCurrentPeriod对应收加权官方项目率' },
    },
    lvzai: { raw_rows: 100, source_regions: 35, mapped_regions: 35, canonical_centers: 35, unmapped_centers: [] },
  }
}

let previewSequence = 0

type CollectionSourceOverrides = {
  businessDate?: string
  extractedAt?: string
  rows?: NormalizedBundle['collection_centers']
  summary?: Record<string, unknown>
}

async function preview(bundle: NormalizedBundle, sourceOverrides: CollectionSourceOverrides = {}) {
  previewSequence += 1
  const sourceBusinessDate = sourceOverrides.businessDate || bundle.business_date
  const sourceExtractedAt = sourceOverrides.extractedAt || bundle.extracted_at
  const sourceRows = sourceOverrides.rows || bundle.collection_centers
  const sourceSummary = sourceOverrides.summary || bundle.collection_summary
  const payloads: Record<string, Buffer> = {
    aph: Buffer.from(JSON.stringify({ businessDate: bundle.business_date, sourceLayers: bundle.source_layers, reconciliations: bundle.reconciliations, previewSequence })),
    paymentDetail: Buffer.from(JSON.stringify({ marker: 'payment-detail', previewSequence })),
    lvzai: Buffer.from(JSON.stringify({ marker: 'lvzai', previewSequence })),
    collectionDetail: Buffer.from(JSON.stringify({
      businessDate: sourceBusinessDate,
      extractedAt: sourceExtractedAt,
      rows: sourceRows,
      periodCorrection: sourceSummary.periodCorrection,
    })),
    collectionSummary: Buffer.from(JSON.stringify({
      ...sourceSummary,
      date: sourceBusinessDate,
      extractedAt: sourceExtractedAt,
    })),
  }
  bundle.sources = Object.entries(payloads).map(([key, content]) => ({ key, name: `${key}.json`, size: content.length, sha256: sha(content) }))
  const normalized = Buffer.from(JSON.stringify(bundle))
  const form = new FormData()
  form.set('normalized', new Blob([normalized], { type: 'application/json' }), 'normalized.json')
  for (const [key, content] of Object.entries(payloads)) form.set(key, new Blob([content], { type: 'application/json' }), `${key}.json`)
  const response = await fetch(`${baseUrl}/api/data-pipeline/preview`, {
    method: 'POST',
    headers: { Authorization: ['Bear', 'er ', token].join('') },
    body: form,
  })
  return { response, body: await response.json() as {
    batch: {
      id: number
      batch_sha256: string
      publishable: boolean
      status: string
      validation_errors: string[]
      summary: { warnings?: string[]; dailyReview: { baselineBatchId?: number | null } }
    }
  } }
}

function fixedEntryBytes() {
  return new Map(['APH决策_每日提取.json', '绿仔收缴明细.json', '绿仔收款汇总.json', '绿仔同步状态.json'].map(name => {
    const filePath = path.join(process.env.COCKPIT_ROOT!, name)
    return [name, fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.readFileSync(filePath) : null]
  }))
}

function publicationSideEffects() {
  return JSON.stringify({
    payment: db.prepare('SELECT * FROM payment_centers ORDER BY id').all(),
    daily: db.prepare('SELECT * FROM daily_snapshots ORDER BY id').all(),
    collection: db.prepare('SELECT * FROM collection_centers ORDER BY id').all(),
    sources: db.prepare('SELECT source_key,status,last_sync_at,updated_at FROM data_sources ORDER BY source_key').all(),
    publications: db.prepare('SELECT * FROM data_ingestion_publications ORDER BY id').all(),
    syncRuns: db.prepare('SELECT * FROM data_source_sync_runs ORDER BY id').all(),
    audits: db.prepare('SELECT * FROM operation_logs ORDER BY id').all(),
  })
}

async function expectPublishConflictWithoutSideEffects(batchId: number, expected: RegExp) {
  const factsBefore = publicationSideEffects()
  const fixedBefore = fixedEntryBytes()
  const response = await fetch(`${baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
    method: 'POST',
    headers: { Authorization: ['Bearer', token].join(' '), 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmNote: '篡改证据必须无副作用阻断' }),
  })
  const responseText = await response.text()
  let body: { error?: string }
  try { body = JSON.parse(responseText) } catch { body = { error: responseText } }
  assert.equal(response.status, 409, JSON.stringify(body))
  assert.match(body.error || '', expected)
  assert.equal((db.prepare('SELECT status FROM data_ingestion_batches WHERE id=?').get(batchId) as { status: string }).status, 'previewed')
  assert.equal(publicationSideEffects(), factsBefore)
  for (const [name, before] of fixedBefore) {
    const filePath = path.join(process.env.COCKPIT_ROOT!, name)
    assert.deepEqual(fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.readFileSync(filePath) : null, before, `${name}不得变化`)
  }
}

function seedValidDailyOnlyReconciliation(reconciliationId: number, businessDate: string) {
  const fixture = dailyCenterFixture('第一服务P46正式日报修订焦点服务中心')
  db.prepare('DELETE FROM payment_centers').run()
  const insertPayment = db.prepare(`INSERT INTO payment_centers
    (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
    VALUES('测试片区',?,110,95,100,90,NULL)`)
  for (const center of fixture.canonicalCenters) insertPayment.run(center)
  db.prepare(`INSERT INTO daily_collection_reconciliations
    (id,business_date,extracted_at,report_id,region,official_total,detail_total,source_row_count,
     publication_mode,payload_sha256,business_payload_sha256,status,validation_errors,created_by,
     published_by,published_at,confirm_note)
    VALUES(?,?,?,'810ca5a0-b239-466b-85c2-386373244c8e','华北地区',1,1,61,
      'daily_only',?,?,'published','[]','tester','tester',?,'正式日报修订确认')`)
    .run(reconciliationId, businessDate, `${businessDate}T08:30:00+08:00`,
      String(reconciliationId).padStart(64, 'a').slice(-64),
      String(reconciliationId).padStart(64, 'b').slice(-64), `${businessDate} 08:31:00`)
  const insertRevision = db.prepare(`INSERT INTO daily_collection_revision_rows
    (reconciliation_id,center,new_daily_collection) VALUES(?,?,?)`)
  fixture.canonicalCenters.forEach((center, index) => insertRevision.run(reconciliationId, center, index === 0 ? 1 : 0))
  return fixture.canonicalCenters
}

function writeFormalSourceArchive(batchId: number, businessDate: string, bundle: Record<string, unknown>) {
  const sources = [
    { key: 'aph', name: 'aph.json', content: Buffer.from(JSON.stringify({ batchId })) },
    { key: 'paymentDetail', name: 'payment-detail.json', content: Buffer.from('[]') },
    { key: 'lvzai', name: 'lvzai.json', content: Buffer.from('{}') },
    { key: 'collectionDetail', name: 'collection-detail.json', content: Buffer.from('[]') },
    { key: 'collectionSummary', name: 'collection-summary.json', content: Buffer.from('{}') },
    { key: 'normalized', name: 'normalized.json', content: Buffer.from(JSON.stringify(bundle)) },
  ].map(file => ({ ...file, sha256: crypto.createHash('sha256').update(file.content).digest('hex') }))
  const batchSha256 = crypto.createHash('sha256')
    .update(sources.slice().sort((left, right) => left.key.localeCompare(right.key)).map(file => file.sha256).join(':'))
    .digest('hex')
  const archiveDir = path.join(process.env.COCKPIT_RAW_ARCHIVE_DIR!, businessDate, batchSha256.slice(0, 16))
  fs.mkdirSync(archiveDir, { recursive: true })
  const sourceFiles = sources.map(file => {
    const filePath = path.join(archiveDir, `${file.key}-${file.name}`)
    fs.writeFileSync(filePath, file.content)
    return { key: file.key, name: file.name, path: filePath, size: file.content.length, sha256: file.sha256 }
  })
  return { archiveDir, batchSha256, sourceFiles }
}

function seedFormalDailyBaselineForCenters(
  batchId: number,
  businessDate: string,
  rows: Array<{ center: string; cumulative_executed: number }>,
  summary: Record<string, unknown>,
) {
  const paymentRows = rows.map(row => ({
    area: '华北地区', center: row.center, annual_budget: 110, cumulative_budget: 95,
    cumulative_executed: row.cumulative_executed, same_period: 90, collection_rate: 0.5,
  }))
  const dailyRows = rows.map(row => ({
    date: businessDate, center: row.center, annual_budget: 110, cumulative_budget: 95,
    cumulative_executed: row.cumulative_executed, daily_collection: 0, quality_status: 'verified',
    source: 'FineReport回款日报', source_status: 'available', business_date: businessDate,
    last_validated_at: validValidatedAt, field_provenance: {},
  }))
  const collectionRows = Array.from({ length: 35 }, (_, index) => ({
    area: '华北地区', center: `第一服务绿仔测试中心${index + 1}`, receivable: 10, received: 5, collectionRate: 0.5,
  }))
  const bundle = {
    schema_version: 2, business_date: businessDate,
    payment_centers: paymentRows, daily_snapshots: dailyRows, collection_centers: collectionRows,
  }
  const { archiveDir, batchSha256, sourceFiles } = writeFormalSourceArchive(batchId, businessDate, bundle)
  db.prepare(`INSERT INTO data_ingestion_batches
    (id,source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,publishable,
     row_count,mapped_count,unmapped_count,validation_errors,summary,published_by,published_at)
    VALUES(?,?,?,?,?,?,?,'published',1,?,35,0,'[]',?,'tester',?)`)
    .run(batchId, 'formal-baseline', businessDate, `${businessDate}T17:30:00+08:00`,
      batchSha256, JSON.stringify(sourceFiles), archiveDir, rows.length, JSON.stringify(summary), `${businessDate} 17:30:00`)
  const insertSnapshot = db.prepare(`INSERT INTO daily_snapshots
    (date,center,business_date,annual_budget,cumulative_budget,cumulative_executed,daily_collection,
     quality_status,source,source_status,last_validated_at,field_provenance)
    VALUES(?,?,?,?,?,?,0,'verified','FineReport回款日报','available',?,'{}')`)
  const insertRow = db.prepare(`INSERT INTO data_ingestion_rows
    (batch_id,entity_type,source_key,canonical_key,mapping_method,change_type,changed_fields,payload)
    VALUES(?,?,?,?,?,?,?,?)`)
  for (const [index, row] of rows.entries()) {
    insertSnapshot.run(businessDate, row.center, businessDate, 110, 95, row.cumulative_executed, validValidatedAt)
    insertRow.run(batchId, 'payment_center', row.center, row.center, 'exact', 'snapshot', '[]', JSON.stringify(paymentRows[index]))
    insertRow.run(batchId, 'daily_snapshot', `${businessDate}:${row.center}`, row.center, 'exact', 'snapshot', '[]', JSON.stringify(dailyRows[index]))
  }
  for (const row of collectionRows) {
    insertRow.run(batchId, 'collection_center', row.center, row.center, 'exact', 'snapshot', '[]', JSON.stringify(row))
  }
  db.prepare(`INSERT INTO data_ingestion_publications
    (batch_id,business_date,backup_payload,backup_sha256,payment_rows,snapshot_rows,collection_rows,published_by,published_at)
    VALUES(?,?,?,?,?,?,35,'tester',?)`)
    .run(batchId, businessDate, '{}', String(batchId).padStart(64, '0').slice(-64), rows.length, rows.length, `${businessDate} 17:30:00`)
}

function seedFormalDailyBaseline(batchId: number, businessDate: string, firstCenterExecuted: number, summary: Record<string, unknown>, insertSnapshots = true) {
  const insertSnapshot = db.prepare(`INSERT INTO daily_snapshots
    (date,center,business_date,annual_budget,cumulative_budget,cumulative_executed,daily_collection,
     quality_status,source,source_status,last_validated_at)
    VALUES(?,?,?,?,?,?,?,'verified','FineReport回款日报','available',?)`)
  const insertRow = db.prepare(`INSERT INTO data_ingestion_rows
    (batch_id,entity_type,source_key,canonical_key,mapping_method,change_type,changed_fields,payload)
    VALUES(?,?,?,?,?,?,?,?)`)
  const paymentRows = Array.from({ length: 40 }, (_, index) => ({
    area: '华北地区', center: `APH未来时间测试中心${index + 1}`, annual_budget: 110, cumulative_budget: 95,
    cumulative_executed: index === 0 ? firstCenterExecuted : 100, same_period: 90, collection_rate: 0.5,
  }))
  const dailyRows = paymentRows.map(row => ({
    date: businessDate, center: row.center, annual_budget: 110, cumulative_budget: 95,
    cumulative_executed: row.cumulative_executed, daily_collection: 0, quality_status: 'verified',
    source: 'FineReport回款日报', source_status: 'available', business_date: businessDate,
    last_validated_at: validValidatedAt, field_provenance: {},
  }))
  const collectionRows = Array.from({ length: 35 }, (_, index) => ({
    area: '华北地区', center: `第一服务绿仔测试中心${index + 1}`, receivable: 10, received: 5, collectionRate: 0.5,
  }))
  const bundle = {
    schema_version: 2, business_date: businessDate,
    payment_centers: paymentRows, daily_snapshots: dailyRows, collection_centers: collectionRows,
  }
  const { archiveDir, batchSha256, sourceFiles } = writeFormalSourceArchive(batchId, businessDate, bundle)
  db.prepare(`INSERT INTO data_ingestion_batches
    (id,source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,publishable,
     row_count,mapped_count,unmapped_count,validation_errors,summary,published_by,published_at)
    VALUES(?,?,?,?,?,?,?,'published',1,40,35,0,'[]',?,'tester',?)`)
    .run(batchId, 'formal-baseline', businessDate, `${businessDate}T17:30:00+08:00`, batchSha256, JSON.stringify(sourceFiles), archiveDir, JSON.stringify(summary), `${businessDate} 17:30:00`)
  for (let index = 0; index < 40; index += 1) {
    const center = paymentRows[index].center
    const executed = paymentRows[index].cumulative_executed
    if (insertSnapshots) insertSnapshot.run(businessDate, center, businessDate, 110, 95, executed, 0, validValidatedAt)
    insertRow.run(batchId, 'payment_center', center, center, 'exact', 'snapshot', '[]', JSON.stringify(paymentRows[index]))
    insertRow.run(batchId, 'daily_snapshot', `${businessDate}:${center}`, center, 'exact', 'snapshot', '[]', JSON.stringify(dailyRows[index]))
  }
  for (const row of collectionRows) {
    insertRow.run(batchId, 'collection_center', row.center, row.center, 'exact', 'snapshot', '[]', JSON.stringify(row))
  }
  db.prepare(`INSERT INTO data_ingestion_publications
    (batch_id,business_date,backup_payload,backup_sha256,payment_rows,snapshot_rows,collection_rows,published_by,published_at)
    VALUES(?,?,?,?,40,40,35,'tester',?)`)
    .run(batchId, businessDate, '{}', String(batchId).padStart(64, '0'), `${businessDate} 17:30:00`)
}

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('real HTTP P46 preview fails closed when the prior trusted day uses a non-overlapping center set', async t => {
  t.after(() => {
    db.prepare('DELETE FROM data_ingestion_publications WHERE batch_id=9000000').run()
    db.prepare('DELETE FROM data_ingestion_rows WHERE batch_id=9000000').run()
    db.prepare('DELETE FROM data_ingestion_batches WHERE id=9000000').run()
    db.prepare('DELETE FROM daily_snapshots WHERE date=?').run(priorBusinessDate)
  })
  db.prepare('DELETE FROM daily_snapshots WHERE date=?').run(priorBusinessDate)
  seedFormalDailyBaseline(9000000, priorBusinessDate, 100, {
    totals: { before: { cumulative_executed: 4000 }, after: { cumulative_executed: 4000, daily_collection: 0 } },
  })

  const bundle = validBundle()
  bundle.payment_centers.forEach((row, index) => {
    row.center = `APH重命名后测试中心${index + 1}`
    if (index === 0) row.cumulative_executed = 128.18
  })
  bundle.daily_snapshots.forEach((row, index) => {
    row.center = bundle.payment_centers[index].center
    row.cumulative_executed = bundle.payment_centers[index].cumulative_executed
    row.daily_collection = 0
  })

  const { response, body } = await preview(bundle)

  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.batch.publishable, false)
  assert.equal(body.batch.status, 'blocked')
  assert.match(body.batch.validation_errors.join('；'), /上一可信日.*中心集合不一致/)
  assert.match((body.batch.summary.warnings || []).join('；'), /累计执行变动28\.18万元.*官方日回款全为0/)
})

test('real HTTP P46 preview uses the latest formal cumulative snapshot even when its daily field awaits reconciliation', async t => {
  t.after(() => {
    db.prepare('DELETE FROM data_ingestion_publications WHERE batch_id IN (9099999,9100000,9100001)').run()
    db.prepare('DELETE FROM data_ingestion_rows WHERE batch_id IN (9099999,9100000,9100001)').run()
    db.prepare('DELETE FROM data_ingestion_batches WHERE id IN (9099999,9100000,9100001)').run()
    db.prepare('DELETE FROM daily_snapshots WHERE date IN (?,?)').run(trustedBusinessDate, priorBusinessDate)
  })
  db.prepare('DELETE FROM daily_snapshots WHERE date IN (?,?)').run(trustedBusinessDate, priorBusinessDate)
  seedFormalDailyBaseline(9100000, trustedBusinessDate, 100, {
    totals: { before: { cumulative_executed: 4000 }, after: { cumulative_executed: 4000, daily_collection: 0 } },
  })
  seedFormalDailyBaseline(9099999, priorBusinessDate, 128.18, {
    totals: { before: { cumulative_executed: 4028.18 }, after: { cumulative_executed: 4028.18, daily_collection: 0 } },
  }, false)
  seedFormalDailyBaseline(9100001, priorBusinessDate, 128.18, {
    totals: { before: { cumulative_executed: 4000 }, after: { cumulative_executed: 4028.18, daily_collection: 0 } },
  })
  const bundle = validBundle()
  bundle.payment_centers[0].cumulative_executed = 128.18
  bundle.daily_snapshots[0].cumulative_executed = 128.18
  for (const row of bundle.daily_snapshots) row.daily_collection = 0

  const { response, body } = await preview(bundle)

  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.batch.publishable, true)
  assert.equal(body.batch.status, 'previewed')
  assert.equal(body.batch.validation_errors.length, 0)
  assert.equal(body.batch.summary.dailyReview.baselineBatchId, 9100001)
  assert.equal((body.batch.summary.warnings || []).some(warning => warning.includes('日回款待次日复核')), false)
})

test('real HTTP P46 publish rejects a cumulative baseline change after preview', async t => {
  const previewBaselineId = 9100030
  const laterBaselineId = 9100040
  t.after(() => {
    db.prepare('DELETE FROM data_ingestion_publications WHERE batch_id IN (?,?)').run(previewBaselineId, laterBaselineId)
    db.prepare('DELETE FROM data_ingestion_rows WHERE batch_id IN (?,?)').run(previewBaselineId, laterBaselineId)
    db.prepare('DELETE FROM data_ingestion_batches WHERE id IN (?,?)').run(previewBaselineId, laterBaselineId)
    db.prepare('DELETE FROM daily_snapshots WHERE date=?').run(priorBusinessDate)
  })
  db.prepare('DELETE FROM daily_snapshots WHERE date=?').run(priorBusinessDate)
  seedFormalDailyBaseline(previewBaselineId, priorBusinessDate, 100, {
    totals: { before: { cumulative_executed: 4000 }, after: { cumulative_executed: 4000, daily_collection: 0 } },
  })
  const { body } = await preview(validBundle())
  assert.equal(body.batch.status, 'previewed', JSON.stringify(body))
  assert.equal(body.batch.summary.dailyReview.baselineBatchId, previewBaselineId)

  seedFormalDailyBaseline(laterBaselineId, priorBusinessDate, 105, {
    totals: { before: { cumulative_executed: 4000 }, after: { cumulative_executed: 4200, daily_collection: 0 } },
  }, false)
  await expectPublishConflictWithoutSideEffects(body.batch.id, /累计基线.*(变化|重新预览)|baselineBatchId/)
})

test('real HTTP P46 preview keeps the latest cumulative baseline independent from a daily_only reconciliation', async t => {
  const trustedBatchId = 9100010
  const reconciledBatchId = 9100011
  const reconciliationId = 9200010
  t.after(() => {
    db.prepare('DELETE FROM daily_collection_revision_rows WHERE reconciliation_id=?').run(reconciliationId)
    db.prepare('DELETE FROM daily_collection_reconciliations WHERE id=?').run(reconciliationId)
    db.prepare('DELETE FROM payment_centers').run()
    db.prepare('DELETE FROM data_ingestion_publications WHERE batch_id IN (?,?)').run(trustedBatchId, reconciledBatchId)
    db.prepare('DELETE FROM data_ingestion_rows WHERE batch_id IN (?,?)').run(trustedBatchId, reconciledBatchId)
    db.prepare('DELETE FROM data_ingestion_batches WHERE id IN (?,?)').run(trustedBatchId, reconciledBatchId)
    db.prepare('DELETE FROM daily_snapshots WHERE date IN (?,?)').run(trustedBusinessDate, priorBusinessDate)
  })
  db.prepare('DELETE FROM daily_snapshots WHERE date IN (?,?)').run(trustedBusinessDate, priorBusinessDate)
  seedFormalDailyBaseline(trustedBatchId, trustedBusinessDate, 100, {
    totals: { before: { cumulative_executed: 4000 }, after: { cumulative_executed: 4000, daily_collection: 0 } },
  })
  seedFormalDailyBaseline(reconciledBatchId, priorBusinessDate, 128.18, {
    totals: { before: { cumulative_executed: 4000 }, after: { cumulative_executed: 4028.18, daily_collection: 0 } },
  })
  seedValidDailyOnlyReconciliation(reconciliationId, priorBusinessDate)
  const bundle = validBundle()
  bundle.payment_centers[0].cumulative_executed = 128.18
  bundle.daily_snapshots[0].cumulative_executed = 128.18
  for (const row of bundle.daily_snapshots) row.daily_collection = 0

  const { response, body } = await preview(bundle)

  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.batch.publishable, true)
  assert.equal(body.batch.status, 'previewed')
  assert.equal(body.batch.validation_errors.length, 0)
  assert.equal((body.batch.summary.warnings || []).some(warning => warning.includes('日回款待次日复核')), false)
})

test('real HTTP P46 preview accepts a conflicting prior day after a valid snapshot_revision reconciliation', async t => {
  const trustedBatchId = 9100020
  const reconciledBatchId = 9100021
  const fixture = dailyCenterFixture('第一服务P46正式快照修订焦点服务中心')
  const trustedRows = fixture.canonicalCenters.map(center => ({ center, cumulative_executed: 100 }))
  const priorRows = fixture.canonicalCenters.map((center, index) => ({ center, cumulative_executed: index === 0 ? 128.18 : 100 }))
  db.prepare('DELETE FROM daily_snapshots WHERE date IN (?,?)').run(trustedBusinessDate, priorBusinessDate)
  seedFormalDailyBaselineForCenters(trustedBatchId, trustedBusinessDate, trustedRows, {
    totals: { before: { cumulative_executed: 5600 }, after: { cumulative_executed: 5600, daily_collection: 0 } },
  })
  seedFormalDailyBaselineForCenters(reconciledBatchId, priorBusinessDate, priorRows, {
    totals: { before: { cumulative_executed: 5600 }, after: { cumulative_executed: 5628.18, daily_collection: 0 } },
  })
  const reconciliation = previewDailyReconciliation(db, {
    schemaVersion: 1,
    reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
    region: '华北地区',
    businessDate: priorBusinessDate,
    extractedAt: validExtractedAt,
    officialTotal: 1,
    rows: fixture.rawRows(1),
  }, 'tester')
  assert.equal(reconciliation.publicationMode, 'snapshot_revision')
  assert.equal(reconciliation.status, 'previewed', JSON.stringify(reconciliation.validationErrors))
  assert.equal(reconciliation.publishable, true, JSON.stringify(reconciliation.validationErrors))
  const publishedReconciliation = publishDailyReconciliation(db, reconciliation.id, 'tester', '正式快照日报修订确认')
  assert.equal(publishedReconciliation.status, 'published')
  t.after(() => {
    db.prepare('DELETE FROM daily_collection_revision_rows WHERE reconciliation_id=?').run(reconciliation.id)
    db.prepare('DELETE FROM daily_collection_reconciliations WHERE id=?').run(reconciliation.id)
    db.prepare('DELETE FROM data_ingestion_publications WHERE batch_id IN (?,?)').run(trustedBatchId, reconciledBatchId)
    db.prepare('DELETE FROM data_ingestion_rows WHERE batch_id IN (?,?)').run(trustedBatchId, reconciledBatchId)
    db.prepare('DELETE FROM data_ingestion_batches WHERE id IN (?,?)').run(trustedBatchId, reconciledBatchId)
    db.prepare('DELETE FROM daily_snapshots WHERE date IN (?,?)').run(trustedBusinessDate, priorBusinessDate)
  })
  const bundle = validBundle()
  bundle.payment_centers = priorRows.map(row => ({
    area: '测试片区', center: row.center, annual_budget: 110, cumulative_budget: 95,
    cumulative_executed: row.cumulative_executed, same_period: 90, collection_rate: null,
  }))
  bundle.daily_snapshots = bundle.payment_centers.map(row => ({
    date: validBusinessDate, center: row.center, annual_budget: row.annual_budget,
    cumulative_budget: row.cumulative_budget, cumulative_executed: row.cumulative_executed,
    daily_collection: 0, quality_status: 'verified', quality_reason: '',
    source: 'FineReport三报表中心明细', source_status: 'available', business_date: validBusinessDate,
    last_validated_at: validValidatedAt, field_provenance: provenance,
  }))

  const { response, body } = await preview(bundle)

  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.batch.publishable, true, JSON.stringify(body.batch.validation_errors))
  assert.equal(body.batch.status, 'previewed')
  assert.equal(body.batch.validation_errors.some(error => error.includes('日回款跨字段矛盾')), false)

  const expectCumulativeBaselineIndependentFromDailyReview = async () => {
    const result = await preview(bundle)
    assert.equal(result.response.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.batch.publishable, true)
    assert.equal(result.body.batch.status, 'previewed')
    assert.equal((result.body.batch.summary.warnings || []).some(warning => warning.includes('日回款待次日复核')), false)
  }

  db.prepare('UPDATE daily_collection_reconciliations SET status=? WHERE id=?').run('previewed', reconciliation.id)
  await expectCumulativeBaselineIndependentFromDailyReview()
  db.prepare('UPDATE daily_collection_reconciliations SET status=? WHERE id=?').run('published', reconciliation.id)

  const fakeHead = db.prepare(`INSERT INTO daily_collection_reconciliations
    (business_date,extracted_at,report_id,region,official_total,detail_total,source_row_count,
     publication_mode,payload_sha256,business_payload_sha256,status,validation_errors,created_by,
     published_by,published_at,confirm_note)
    VALUES(?,?,?,'华北地区',1,1,61,'snapshot_revision',?,?,'published','[]','tester','tester',?,'伪正式链头')`)
    .run(priorBusinessDate, validExtractedAt, '810ca5a0-b239-466b-85c2-386373244c8e',
      'f'.repeat(64), 'e'.repeat(64), `${priorBusinessDate} 08:32:00`)
  db.prepare('UPDATE daily_collection_reconciliations SET status=? WHERE id=?').run('previewed', reconciliation.id)
  await expectCumulativeBaselineIndependentFromDailyReview()
  db.prepare('DELETE FROM daily_collection_reconciliations WHERE id=?').run(fakeHead.lastInsertRowid)
  db.prepare('UPDATE daily_collection_reconciliations SET status=? WHERE id=?').run('published', reconciliation.id)

  const secondHead = db.prepare(`INSERT INTO daily_collection_reconciliations
    (business_date,extracted_at,report_id,region,official_total,detail_total,source_row_count,
     publication_mode,payload_sha256,business_payload_sha256,status,validation_errors,created_by,
     published_by,published_at,confirm_note)
    VALUES(?,?,?,'华北地区',1,1,61,'snapshot_revision',?,?,'published','[]','tester','tester',?,'异常第二链头')`)
    .run(priorBusinessDate, validExtractedAt, '810ca5a0-b239-466b-85c2-386373244c8e',
      'd'.repeat(64), 'c'.repeat(64), `${priorBusinessDate} 08:33:00`)
  await expectCumulativeBaselineIndependentFromDailyReview()
  db.prepare('DELETE FROM daily_collection_reconciliations WHERE id=?').run(secondHead.lastInsertRowid)

  const originalDaily = db.prepare('SELECT daily_collection FROM daily_snapshots WHERE date=? AND center=?')
    .get(priorBusinessDate, priorRows[0].center) as { daily_collection: number }
  db.prepare('UPDATE daily_snapshots SET daily_collection=? WHERE date=? AND center=?')
    .run(99, priorBusinessDate, priorRows[0].center)
  await expectCumulativeBaselineIndependentFromDailyReview()
  db.prepare('UPDATE daily_snapshots SET daily_collection=? WHERE date=? AND center=?')
    .run(originalDaily.daily_collection, priorBusinessDate, priorRows[0].center)
})

test('real HTTP P46 preview blocks future top-level extraction and validation timestamps', async () => {
  for (const field of ['extracted_at', 'last_validated_at'] as const) {
    const bundle = validBundle()
    bundle[field] = '2099-01-01T00:00:00+08:00'
    const { response, body } = await preview(bundle)
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.batch.publishable, false)
    assert.equal(body.batch.status, 'blocked')
    assert.match(body.batch.validation_errors.join('；'), /(提取时间|验证时间).*未来.*5分钟容差/)
  }
})

test('real HTTP P46 preview blocks one future daily validation timestamp hidden among normal rows', async () => {
  const bundle = validBundle()
  bundle.daily_snapshots[17].last_validated_at = '2099-01-01T00:00:00+08:00'
  const { response, body } = await preview(bundle)
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.batch.publishable, false)
  assert.equal(body.batch.status, 'blocked')
  assert.match(body.batch.validation_errors.join('；'), /日快照.*验证时间.*未来.*5分钟容差/)
})

test('real HTTP P46 preview blocks stale top-level and single-row daily APH evidence', async () => {
  for (const mutate of [
    (bundle: NormalizedBundle) => { bundle.extracted_at = '2000-01-01T00:00:00+08:00' },
    (bundle: NormalizedBundle) => { bundle.last_validated_at = '2000-01-01T00:00:00+08:00' },
    (bundle: NormalizedBundle) => { bundle.daily_snapshots[17].last_validated_at = '2000-01-01T00:00:00+08:00' },
  ]) {
    const bundle = validBundle()
    mutate(bundle)
    const { response, body } = await preview(bundle)
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.batch.publishable, false)
    assert.equal(body.batch.status, 'blocked')
    assert.match(body.batch.validation_errors.join('；'), /(提取时间|验证时间).*超过72小时/)
  }
})

test('real multipart P46 preview blocks normalized collection fact tampering despite correct source SHA declarations', async () => {
  const cases: Array<{ label: string; mutate: (bundle: NormalizedBundle) => void; expected: RegExp }> = [
    { label: '金额', mutate: bundle => { bundle.collection_centers[0].received = 61 }, expected: /归档绿仔明细.*received.*规范化包.*不一致/ },
    { label: '片区', mutate: bundle => { bundle.collection_centers[0].area = '被篡改片区' }, expected: /归档绿仔明细.*area.*规范化包.*不一致/ },
    { label: '中心', mutate: bundle => { bundle.collection_centers[0].center = '被篡改中心' }, expected: /服务中心规范键集合.*规范化包不一致/ },
    { label: '官方率', mutate: bundle => { bundle.collection_centers[0].collectionRate = 0.61 }, expected: /归档绿仔明细.*collectionRate.*规范化包.*不一致/ },
    {
      label: '业务日期',
      mutate: bundle => {
        bundle.business_date = priorBusinessDate
        for (const layer of Object.values(bundle.source_layers || {})) layer.businessDate = bundle.business_date
        for (const row of bundle.daily_snapshots) { row.date = bundle.business_date; row.business_date = bundle.business_date }
      },
      expected: /归档绿仔(明细|汇总)业务日期.*规范化包不一致/,
    },
    {
      label: '汇总修正率',
      mutate: bundle => { (bundle.collection_summary.periodCorrection as Record<string, unknown>).correctedRate = 0.61 },
      expected: /归档绿仔(明细|汇总)修正证据.*规范化包不一致/,
    },
  ]

  for (const item of cases) {
    const bundle = validBundle()
    const sourceRows = structuredClone(bundle.collection_centers)
    const sourceSummary = structuredClone(bundle.collection_summary)
    const sourceBusinessDate = bundle.business_date
    const sourceExtractedAt = bundle.extracted_at
    item.mutate(bundle)
    const { response, body } = await preview(bundle, {
      businessDate: sourceBusinessDate,
      extractedAt: sourceExtractedAt,
      rows: sourceRows,
      summary: sourceSummary,
    })
    assert.equal(response.status, 200, `${item.label}: ${JSON.stringify(body)}`)
    assert.equal(body.batch.publishable, false, `${item.label}篡改不得进入可发布预览`)
    assert.equal(body.batch.status, 'blocked', `${item.label}篡改批次必须blocked`)
    assert.match(body.batch.validation_errors.join('；'), item.expected, item.label)
  }
})

test('real HTTP P46 preview blocks canonical duplicate APH centers for whitespace, NFKC and separator variants', async () => {
  const variants = ['APH未来时间测试中心1 ', 'ＡＰＨ未来时间测试中心１', 'APH 未来时间测试中心1', 'APH未来时间测试•中心1']
  for (const variant of variants) {
    const bundle = validBundle()
    bundle.payment_centers[39].center = variant
    bundle.daily_snapshots[39].center = variant
    const { response, body } = await preview(bundle)
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.batch.publishable, false, variant)
    assert.equal(body.batch.status, 'blocked', variant)
    assert.match(body.batch.validation_errors.join('；'), /服务中心规范键重复/)
    assert.equal(body.batch.validation_errors.join('；').includes(JSON.stringify(variant)), true)
  }
})

test('real HTTP P46 publish rejects stored payment, daily and collection payload tampering before every side effect', async () => {
  type MutablePayload = Record<string, unknown>
  const mutations: Array<{ type: string; mutate: (row: MutablePayload) => void }> = [
    { type: 'payment_center', mutate: row => { row.annual_budget = 999999 } },
    { type: 'payment_center', mutate: row => { row.same_period = null } },
    { type: 'payment_center', mutate: row => { row.cumulative_budget = -1 } },
    { type: 'daily_snapshot', mutate: row => {
      row.daily_collection = 999999
      const provenance = row.field_provenance as Record<string, Record<string, unknown>>
      provenance.daily_collection.label = '篡改血缘'
    } },
    { type: 'daily_snapshot', mutate: row => { row.source_status = 'unavailable' } },
    { type: 'daily_snapshot', mutate: row => { row.business_date = priorBusinessDate } },
    { type: 'daily_snapshot', mutate: row => { row.center = '篡改中心名称' } },
    { type: 'collection_center', mutate: row => { row.received = 999999; row.collectionRate = 0.01 } },
    { type: 'collection_center', mutate: row => { row.receivable = null } },
    { type: 'collection_center', mutate: row => { row.received = -1 } },
    { type: 'collection_center', mutate: row => { row.center = '篡改绿仔名称' } },
  ]
  for (const mutation of mutations) {
    const { body } = await preview(validBundle())
    assert.equal(body.batch.status, 'previewed', JSON.stringify(body))
    const stored = db.prepare('SELECT id,payload FROM data_ingestion_rows WHERE batch_id=? AND entity_type=? ORDER BY id LIMIT 1')
      .get(body.batch.id, mutation.type) as { id: number; payload: string }
    const payload = JSON.parse(stored.payload)
    mutation.mutate(payload)
    db.prepare('UPDATE data_ingestion_rows SET payload=? WHERE id=?').run(JSON.stringify(payload), stored.id)
    await expectPublishConflictWithoutSideEffects(body.batch.id, /存量预览.*规范化包.*不一致/)
  }
  const { body } = await preview(validBundle())
  db.prepare("DELETE FROM data_ingestion_rows WHERE batch_id=? AND entity_type='collection_center' AND id=(SELECT MIN(id) FROM data_ingestion_rows WHERE batch_id=? AND entity_type='collection_center')")
    .run(body.batch.id, body.batch.id)
  await expectPublishConflictWithoutSideEffects(body.batch.id, /存量预览collection_center.*规范化包.*不一致/)

  const invalidSummary = await preview(validBundle())
  db.prepare('UPDATE data_ingestion_batches SET summary=? WHERE id=?').run('{', invalidSummary.body.batch.id)
  await expectPublishConflictWithoutSideEffects(invalidSummary.body.batch.id, /预览摘要.*JSON.*无效/)
})

test('real HTTP P46 publish rehashes all six archives and rejects archive, manifest and batch SHA tampering', async () => {
  for (const key of ['normalized', 'aph', 'paymentDetail', 'lvzai', 'collectionDetail', 'collectionSummary']) {
    const { body } = await preview(validBundle())
    assert.equal(body.batch.status, 'previewed', JSON.stringify(body))
    const batch = db.prepare('SELECT source_files FROM data_ingestion_batches WHERE id=?').get(body.batch.id) as { source_files: string }
    const files = JSON.parse(batch.source_files) as Array<{ key: string; path: string }>
    const archived = files.find(file => file.key === key)!
    fs.appendFileSync(archived.path, '\n')
    await expectPublishConflictWithoutSideEffects(body.batch.id, new RegExp(`源文件${key}.*(大小|SHA)`))
  }

  type MutableArchivedFile = { size: number; path: string }
  for (const mutateManifest of [
    (files: MutableArchivedFile[]) => { files[0].size += 1 },
    (files: MutableArchivedFile[]) => { files[0].path = files[1].path },
  ]) {
    const { body } = await preview(validBundle())
    const batch = db.prepare('SELECT source_files FROM data_ingestion_batches WHERE id=?').get(body.batch.id) as { source_files: string }
    const files = JSON.parse(batch.source_files)
    mutateManifest(files)
    db.prepare('UPDATE data_ingestion_batches SET source_files=? WHERE id=?').run(JSON.stringify(files), body.batch.id)
    await expectPublishConflictWithoutSideEffects(body.batch.id, /(归档路径|大小|清单)/)
  }

  const { body } = await preview(validBundle())
  db.prepare('UPDATE data_ingestion_batches SET batch_sha256=? WHERE id=?')
    .run(crypto.createHash('sha256').update(body.batch.batch_sha256).digest('hex'), body.batch.id)
  await expectPublishConflictWithoutSideEffects(body.batch.id, /批次SHA.*不一致/)

  const missing = await preview(validBundle())
  const missingBatch = db.prepare('SELECT source_files FROM data_ingestion_batches WHERE id=?').get(missing.body.batch.id) as { source_files: string }
  const missingFiles = JSON.parse(missingBatch.source_files) as Array<{ key: string; path: string }>
  fs.rmSync(missingFiles.find(file => file.key === 'lvzai')!.path)
  await expectPublishConflictWithoutSideEffects(missing.body.batch.id, /源文件lvzai归档读取失败/)
})
