import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-live-publication-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'live-collection-publication-contract-secret-32'
process.env.NODE_ENV = 'test'

const [
  { default: db },
  { default: dataSourcesRouter },
  { default: operatingCapabilitiesRouter },
  { default: summaryRouter },
  { default: collectionsRouter },
  { default: aiRouter },
  { readLiveCollectionPublication },
  { getFormalCollectionDataset },
] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/data-sources.js'),
  import('../src/routes/operating-capabilities.js'),
  import('../src/routes/summary.js'),
  import('../src/routes/collections.js'),
  import('../src/routes/ai.js'),
  import('../src/live-collection-publication.js'),
  import('../src/collection-dataset.js'),
])

const app = express()
app.use((req, _res, next) => {
  ;(req as unknown as { user: { userId: number; username: string; role: string } }).user = { userId: 1, username: 'receipt-test', role: 'admin' }
  next()
})
app.use(dataSourcesRouter)
app.use(operatingCapabilitiesRouter)
app.use(summaryRouter)
app.use(collectionsRouter)
app.use(aiRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  if (server.listening) return resolve()
  server.once('listening', resolve)
  server.once('error', reject)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('live publication contract server did not bind')
const baseUrl = `http://127.0.0.1:${address.port}`

const businessDate = new Date().toISOString().slice(0, 10)
const extractedAt = new Date().toISOString()
const p46BatchSha256 = 'a'.repeat(64)
const detailPath = path.join(root, '绿仔收缴明细.json')
const summaryPath = path.join(root, '绿仔收款汇总.json')
const receiptPath = path.join(root, '绿仔同步状态.json')
const detail = {
  businessDate,
  extractedAt,
  rows: Array.from({ length: 35 }, (_, index) => ({
    area: '华北', center: `受控中心${index + 1}`, receivable: 100, received: 60, collectionRate: 0.6,
  })),
}
const summary = {
  date: businessDate,
  extractedAt,
  collectionRate: 0.6,
  receivable_万: 3500,
  received_万: 2100,
  outstanding_万: 1400,
  source: '绿仔管家·受控测试源',
  periodCorrection: {
    correctedRate: 0.6,
    rateField: 'gatheringCurrentYearRecedRate',
    rateAggregation: 'P46发布门禁已校验的官方项目率加权结果',
  },
}
const detailContent = JSON.stringify(detail)
const summaryContent = JSON.stringify(summary)
const contentSha256 = crypto.createHash('sha256')
  .update('first-service-live-collection-v1\0detail\0', 'utf8')
  .update(detailContent, 'utf8')
  .update('\0summary\0', 'utf8')
  .update(summaryContent, 'utf8')
  .digest('hex')

fs.writeFileSync(path.join(root, 'APH决策_每日提取.json'), JSON.stringify({
  businessDate, sourceStatus: 'available', extractedAt, lastValidatedAt: extractedAt,
}))
fs.writeFileSync(detailPath, detailContent)
fs.writeFileSync(summaryPath, summaryContent)

const batch = db.prepare(`INSERT INTO data_ingestion_batches
  (source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,publishable,row_count,
   mapped_count,unmapped_count,validation_errors,summary,created_by,published_by,published_at)
  VALUES('aph-finereport-lvzai',?,?,?,?,'/archive','published',1,1,35,0,'[]',?,'receipt-test','receipt-test',?)`)
  .run(businessDate, new Date(Date.now() - 1000).toISOString(), p46BatchSha256, '[]', JSON.stringify({
    totals: { after: { collection_rate: 0.6, collection_receivable: 3500, collection_received: 2100 } },
  }), extractedAt)
const batchId = Number(batch.lastInsertRowid)
const insertRow = db.prepare(`INSERT INTO data_ingestion_rows
  (batch_id,entity_type,source_key,canonical_key,mapping_method,change_type,changed_fields,payload)
  VALUES(?,?,?,?,?,?,?,?)`)
insertRow.run(batchId, 'payment_center', '受控中心1', '受控中心1', 'exact', 'snapshot', '[]', JSON.stringify({ center: '受控中心1' }))
insertRow.run(batchId, 'daily_snapshot', `${businessDate}:受控中心1`, '受控中心1', 'exact', 'snapshot', '[]', JSON.stringify({ center: '受控中心1' }))
for (const row of detail.rows) {
  insertRow.run(batchId, 'collection_center', row.center, row.center, 'official-35', 'snapshot', '[]', JSON.stringify(row))
}
db.prepare(`INSERT INTO data_ingestion_publications
  (batch_id,business_date,backup_payload,backup_sha256,payment_rows,snapshot_rows,collection_rows,published_by,published_at)
  VALUES(?,?,'{}',?,1,1,35,'receipt-test',?)`).run(batchId, businessDate, 'b'.repeat(64), extractedAt)
for (const key of ['aph', 'finereport', 'lvzai']) {
  db.prepare(`INSERT INTO data_source_sync_runs
    (source_key,source_name,run_type,status,health,message,detail,operator,started_at,finished_at)
    VALUES(?,?,'p46-publish','success','ok','受控发布',?,'receipt-test',?,?)`)
    .run(key, key, JSON.stringify({ batchId, businessDate }), extractedAt, extractedAt)
}
db.prepare(`INSERT INTO payment_centers(area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
  VALUES('华北','受控中心1',100,80,70,60,NULL)`).run()
db.prepare(`INSERT INTO daily_snapshots
  (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,quality_status,source_status,business_date,last_validated_at)
  VALUES(?,?,?,?,?,?,'verified','available',?,?)`)
  .run(businessDate, '受控中心1', 100, 80, 70, 2, businessDate, extractedAt)

function writeReceipt(overrides: Record<string, unknown> = {}) {
  fs.writeFileSync(receiptPath, JSON.stringify({
    schemaVersion: 2,
    ok: true,
    state: 'published',
    date: businessDate,
    batchId: `p46-${batchId}`,
    p46BatchSha256,
    collectionContentSha256: contentSha256,
    publishedBy: 'receipt-test',
    publishedAt: extractedAt,
    finishedAt: extractedAt,
    ...overrides,
  }))
}
writeReceipt()

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

async function sourceStates() {
  // These assertions cover each consumer's publication contract, not socket
  // concurrency. Keep requests sequential so a cold, resource-constrained CI
  // host cannot terminate one of several simultaneous first-use connections.
  const publicationResponse = await fetch(`${baseUrl}/api/data-sources/publication-status`)
  const publication = await publicationResponse.json() as {
    code: string
    isComplete: boolean
    sources: Array<{ sourceKey: string; status: string; message: string }>
  }
  const capabilitiesResponse = await fetch(`${baseUrl}/api/operating-capabilities`)
  const capabilities = await capabilitiesResponse.json() as {
    sources: { lvzai: { status: string; publicationStatus: string } }
  }
  const summaryResponse = await fetch(`${baseUrl}/api/summary`)
  const summary = await summaryResponse.json() as { collectionPublicationStatus: string; collectionRate: number | null }
  const collectionsResponse = await fetch(`${baseUrl}/api/collections`)
  const collections = await collectionsResponse.json() as { publicationStatus: string; rows: unknown[] }
  const aiResponse = await fetch(`${baseUrl}/api/ai/service-centers`)
  const ai = await aiResponse.json() as { collectionPublicationStatus: string }
  return {
    publication,
    capabilities,
    summary,
    collections: { status: collectionsResponse.status, body: collections },
    ai,
    lvzaiPublication: publication.sources.find(row => row.sourceKey === 'lvzai')!,
  }
}

function invalidUtf8Json(label: string): Buffer {
  return Buffer.concat([Buffer.from(`{"label":"${label}`), Buffer.from([0x80]), Buffer.from('"}')])
}

const canonicalEvidence = new Map<string, string | Buffer>([
  [detailPath, detailContent],
  [summaryPath, summaryContent],
  [receiptPath, fs.readFileSync(receiptPath)],
])

function restoreCanonicalEvidence() {
  for (const [filePath, content] of canonicalEvidence) fs.writeFileSync(filePath, content)
}

async function assertAllCollectionConsumersClosed(label: string) {
  const state = await sourceStates()
  assert.equal(state.lvzaiPublication.status, 'failed', `${label}: publication-status必须显式failed`)
  assert.equal(state.publication.isComplete, false, `${label}: publication-status不得complete`)
  assert.notEqual(state.capabilities.sources.lvzai.status, 'ready', `${label}: capabilities不得ready`)
  assert.notEqual(state.capabilities.sources.lvzai.publicationStatus, 'published', `${label}: capabilities不得published`)
  assert.notEqual(state.summary.collectionPublicationStatus, 'published', `${label}: 首页不得published`)
  assert.equal(state.summary.collectionRate, null, `${label}: 首页不得回退旧批次收缴率`)
  assert.equal(state.collections.status, 503, `${label}: 收缴明细必须失败关闭`)
  assert.notEqual(state.collections.body.publicationStatus, 'published', `${label}: 收缴明细不得published`)
  assert.deepEqual(state.collections.body.rows, [], `${label}: 收缴明细不得返回旧批次行`)
  assert.notEqual(state.ai.collectionPublicationStatus, 'published', `${label}: AI服务中心不得published`)
}

function writeEvidence(detailValue: unknown, summaryValue: unknown, statusValue: unknown) {
  fs.writeFileSync(detailPath, JSON.stringify(detailValue))
  fs.writeFileSync(summaryPath, JSON.stringify(summaryValue))
  fs.writeFileSync(receiptPath, JSON.stringify(statusValue))
}

function shaFor(detailValue: unknown, summaryValue: unknown): string {
  return crypto.createHash('sha256')
    .update('first-service-live-collection-v1\0detail\0', 'utf8')
    .update(JSON.stringify(detailValue), 'utf8')
    .update('\0summary\0', 'utf8')
    .update(JSON.stringify(summaryValue), 'utf8')
    .digest('hex')
}

function tomorrowInShanghai(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return new Date(Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day) + 1))
    .toISOString().slice(0, 10)
}

test('共享validator接受字段分离且绑定实际原文字节与P46批次的published回执', async () => {
  const state = await sourceStates()
  assert.equal(state.lvzaiPublication.status, 'ready')
  assert.equal(state.publication.code, 'complete')
  assert.equal(state.capabilities.sources.lvzai.status, 'ready')
  assert.equal(state.capabilities.sources.lvzai.publicationStatus, 'published')
})

test('合法JSON但业务结构无效时共享validator与全部HTTP消费者均失败关闭', async () => {
  const cases: Array<{ label: string; detail: unknown; summary: unknown; status: unknown }> = [
    { label: '三文件均为空对象', detail: {}, summary: {}, status: {} },
    { label: 'detail空对象-summary数组-status空对象', detail: {}, summary: [], status: {} },
    { label: 'detail空数组', detail: [], summary, status: JSON.parse(String(canonicalEvidence.get(receiptPath))) },
    { label: 'detail空rows', detail: { rows: [] }, summary, status: JSON.parse(String(canonicalEvidence.get(receiptPath))) },
    { label: 'detail标量', detail: 'invalid-detail', summary, status: JSON.parse(String(canonicalEvidence.get(receiptPath))) },
    { label: 'summary数组', detail, summary: [], status: JSON.parse(String(canonicalEvidence.get(receiptPath))) },
    { label: 'summary缺少业务日期与汇总字段', detail, summary: { collectionRate: 0.6 }, status: JSON.parse(String(canonicalEvidence.get(receiptPath))) },
    { label: 'summary标量', detail, summary: 1, status: JSON.parse(String(canonicalEvidence.get(receiptPath))) },
    { label: 'status空对象', detail, summary, status: {} },
    { label: 'status数组', detail, summary, status: [] },
    { label: 'status缺少业务日期与回执字段', detail, summary, status: { ok: true } },
    { label: 'status标量', detail, summary, status: true },
  ]

  try {
    for (const scenario of cases) {
      writeEvidence(scenario.detail, scenario.summary, scenario.status)
      const validation = readLiveCollectionPublication(db, root)
      assert.equal(validation.filesComplete, true, `${scenario.label}: 三文件物理存在`)
      assert.equal(validation.jsonComplete, true, `${scenario.label}: 三文件均为合法UTF-8/JSON`)
      assert.equal(validation.structureComplete, false, `${scenario.label}: 业务结构必须无效`)
      assert.equal(validation.evidenceComplete, false, `${scenario.label}: 无效结构不得成为完整证据`)
      assert.equal(validation.ready, false, `${scenario.label}: validator不得ready`)
      const formal = getFormalCollectionDataset()
      assert.notEqual(formal.dataset?.summary?.publicationStatus, 'published', `${scenario.label}: 共享读取器必须保留现场失败对象而非旧批次`)
      assert.notEqual(formal.publication.publicationStatus, 'published', `${scenario.label}: 共享读取器不得published`)
      assert.equal(formal.publication.collectionRate, null, `${scenario.label}: 共享读取器正式率必须为null`)
      await assertAllCollectionConsumersClosed(scenario.label)
    }
  } finally {
    restoreCanonicalEvidence()
  }
})

test('未来detail、summary或finishedAt分别使共享读取器与全部HTTP消费者失败关闭', async () => {
  const futureAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const canonicalStatus = JSON.parse(String(canonicalEvidence.get(receiptPath))) as Record<string, unknown>
  const futureDetail = { ...detail, extractedAt: futureAt }
  const futureSummary = { ...summary, extractedAt: futureAt }
  const cases = [
    {
      label: '未来detail.extractedAt', detail: futureDetail, summary,
      status: { ...canonicalStatus, collectionContentSha256: shaFor(futureDetail, summary) },
    },
    {
      label: '未来summary.extractedAt', detail, summary: futureSummary,
      status: { ...canonicalStatus, collectionContentSha256: shaFor(detail, futureSummary) },
    },
    {
      label: '未来status.finishedAt', detail, summary,
      status: { ...canonicalStatus, finishedAt: futureAt },
    },
  ]

  try {
    for (const scenario of cases) {
      writeEvidence(scenario.detail, scenario.summary, scenario.status)
      const validation = readLiveCollectionPublication(db, root)
      assert.equal(validation.ready, false, `${scenario.label}: 共享读取器不得ready`)
      assert.match(validation.reasons.join('；'), /未来/, `${scenario.label}: 必须给出未来时间门禁原因`)
      await assertAllCollectionConsumersClosed(scenario.label)
    }
  } finally {
    restoreCanonicalEvidence()
  }
})

test('非法或未来业务日期使正式P46绑定、共享读取器与五个HTTP消费者全部失败关闭', async () => {
  const canonicalStatus = JSON.parse(String(canonicalEvidence.get(receiptPath))) as Record<string, unknown>
  const originalBatchDate = (db.prepare('SELECT business_date FROM data_ingestion_batches WHERE id=?').get(batchId) as { business_date: string }).business_date
  const originalPublicationDate = (db.prepare('SELECT business_date FROM data_ingestion_publications WHERE batch_id=?').get(batchId) as { business_date: string }).business_date
  const cases = [
    { label: '非法日历日期', businessDate: '2026-02-30' },
    { label: '上海明日业务日期', businessDate: tomorrowInShanghai() },
  ]
  try {
    for (const scenario of cases) {
      const scenarioDetail = { ...detail, businessDate: scenario.businessDate }
      const scenarioSummary = { ...summary, date: scenario.businessDate }
      const scenarioStatus = {
        ...canonicalStatus,
        date: scenario.businessDate,
        collectionContentSha256: shaFor(scenarioDetail, scenarioSummary),
      }
      db.prepare('UPDATE data_ingestion_batches SET business_date=? WHERE id=?').run(scenario.businessDate, batchId)
      db.prepare('UPDATE data_ingestion_publications SET business_date=? WHERE batch_id=?').run(scenario.businessDate, batchId)
      writeEvidence(scenarioDetail, scenarioSummary, scenarioStatus)

      const validation = readLiveCollectionPublication(db, root)
      assert.equal(validation.ready, false, `${scenario.label}: 共享读取器不得ready`)
      assert.match(validation.reasons.join('；'), /业务日期.*(无效|未来|晚于)/, `${scenario.label}: 必须给出严格业务日期门禁原因`)
      await assertAllCollectionConsumersClosed(scenario.label)
    }
  } finally {
    db.prepare('UPDATE data_ingestion_batches SET business_date=? WHERE id=?').run(originalBatchDate, batchId)
    db.prepare('UPDATE data_ingestion_publications SET business_date=? WHERE batch_id=?').run(originalPublicationDate, batchId)
    restoreCanonicalEvidence()
  }
})

test('完成时间早于提取时间或发布时间早于完成时间时全部消费者失败关闭', async () => {
  const canonicalStatus = JSON.parse(String(canonicalEvidence.get(receiptPath))) as Record<string, unknown>
  const beforeExtraction = new Date(Date.parse(extractedAt) - 60_000).toISOString()
  const cases = [
    { label: '完成早于提取', status: { ...canonicalStatus, finishedAt: beforeExtraction } },
    { label: '发布早于完成', status: { ...canonicalStatus, publishedAt: beforeExtraction } },
  ]
  try {
    for (const scenario of cases) {
      writeEvidence(detail, summary, scenario.status)
      const validation = readLiveCollectionPublication(db, root)
      assert.equal(validation.ready, false, `${scenario.label}: 共享读取器不得ready`)
      assert.match(validation.reasons.join('；'), /早于/, `${scenario.label}: 必须给出时间顺序门禁原因`)
      await assertAllCollectionConsumersClosed(scenario.label)
    }
  } finally {
    restoreCanonicalEvidence()
  }
})

test('篡改绿仔明细原文字节后publication-status与operating-capabilities同时失败关闭', async () => {
  fs.appendFileSync(detailPath, '\n')
  try {
    const state = await sourceStates()
    assert.equal(state.lvzaiPublication.status, 'failed')
    assert.match(state.lvzaiPublication.message, /SHA256|原文字节|篡改/)
    assert.equal(state.publication.isComplete, false)
    assert.notEqual(state.capabilities.sources.lvzai.status, 'ready')
    assert.notEqual(state.capabilities.sources.lvzai.publicationStatus, 'published')
  } finally {
    fs.writeFileSync(detailPath, detailContent)
  }
})

test('无效UTF-8绿仔JSON即使可被替换字符解析也不能进入published或ready', async () => {
  const invalidBytes = Buffer.from(detailContent)
  const marker = invalidBytes.indexOf(Buffer.from('受控中心1'))
  assert.ok(marker >= 0)
  invalidBytes[marker] = 0x80
  const replacementDecoded = invalidBytes.toString('utf8')
  assert.doesNotThrow(() => JSON.parse(replacementDecoded), '复现前提：宽松UTF-8解码后JSON仍可解析')
  const invalidContentSha256 = crypto.createHash('sha256')
    .update('first-service-live-collection-v1\0detail\0', 'utf8')
    .update(invalidBytes)
    .update('\0summary\0', 'utf8')
    .update(Buffer.from(summaryContent))
    .digest('hex')
  fs.writeFileSync(detailPath, invalidBytes)
  writeReceipt({ collectionContentSha256: invalidContentSha256 })
  try {
    const state = await sourceStates()
    assert.notEqual(state.lvzaiPublication.status, 'ready')
    assert.match(state.lvzaiPublication.message, /UTF-8/)
    assert.equal(state.publication.isComplete, false)
    assert.notEqual(state.capabilities.sources.lvzai.status, 'ready')
    assert.notEqual(state.capabilities.sources.lvzai.publicationStatus, 'published')
  } finally {
    fs.writeFileSync(detailPath, detailContent)
    writeReceipt()
  }
})

test('任一固定入口文件残留或部分证据有效/无效时全部HTTP消费端均阻断旧批次回退', async () => {
  const cases: Array<{ label: string; files: Array<[string, string | Buffer]> }> = [
    { label: '仅无效detail', files: [[detailPath, invalidUtf8Json('detail')]] },
    { label: '仅无效summary', files: [[summaryPath, invalidUtf8Json('summary')]] },
    { label: '仅无效status', files: [[receiptPath, invalidUtf8Json('status')]] },
    { label: '仅有效detail', files: [[detailPath, detailContent]] },
    { label: '仅有效summary', files: [[summaryPath, summaryContent]] },
    { label: '仅有效status', files: [[receiptPath, canonicalEvidence.get(receiptPath)!]] },
    { label: '缺detail且summary有效/status无效', files: [[summaryPath, summaryContent], [receiptPath, invalidUtf8Json('status')]] },
    { label: '缺summary且detail有效/status无效', files: [[detailPath, detailContent], [receiptPath, invalidUtf8Json('status')]] },
    { label: '缺status且detail有效/summary无效', files: [[detailPath, detailContent], [summaryPath, invalidUtf8Json('summary')]] },
  ]

  try {
    for (const scenario of cases) {
      for (const filePath of [detailPath, summaryPath, receiptPath]) fs.rmSync(filePath, { force: true })
      for (const [filePath, content] of scenario.files) fs.writeFileSync(filePath, content)
      await assertAllCollectionConsumersClosed(scenario.label)
    }
  } finally {
    restoreCanonicalEvidence()
  }
})

test('篡改绿仔汇总内容后回执失效且不得回退旧批次冒充published', async () => {
  fs.writeFileSync(summaryPath, JSON.stringify({ ...summary, collectionRate: 0.61 }))
  try {
    const state = await sourceStates()
    assert.equal(state.lvzaiPublication.status, 'failed')
    assert.equal(state.publication.isComplete, false)
    assert.notEqual(state.capabilities.sources.lvzai.status, 'ready')
    assert.notEqual(state.capabilities.sources.lvzai.publicationStatus, 'published')
  } finally {
    fs.writeFileSync(summaryPath, summaryContent)
    writeReceipt()
  }
})

test('stale、invalid、unpublished与覆盖不完整均由共享validator失败关闭', async () => {
  const assertClosed = async () => {
    const state = await sourceStates()
    assert.notEqual(state.lvzaiPublication.status, 'ready')
    assert.equal(state.publication.isComplete, false)
    assert.notEqual(state.capabilities.sources.lvzai.status, 'ready')
  }

  writeReceipt({ state: 'staged' })
  await assertClosed()

  const invalidDetailContent = JSON.stringify({ ...detail, rows: detail.rows.slice(0, 34) })
  fs.writeFileSync(detailPath, invalidDetailContent)
  const invalidContentSha256 = crypto.createHash('sha256')
    .update('first-service-live-collection-v1\0detail\0', 'utf8')
    .update(invalidDetailContent, 'utf8')
    .update('\0summary\0', 'utf8')
    .update(summaryContent, 'utf8')
    .digest('hex')
  writeReceipt({ collectionContentSha256: invalidContentSha256 })
  await assertClosed()

  const staleAt = '2020-01-01T00:00:00.000Z'
  const staleDetailContent = JSON.stringify({ ...detail, extractedAt: staleAt })
  const staleSummaryContent = JSON.stringify({ ...summary, extractedAt: staleAt })
  fs.writeFileSync(detailPath, staleDetailContent)
  fs.writeFileSync(summaryPath, staleSummaryContent)
  const staleContentSha256 = crypto.createHash('sha256')
    .update('first-service-live-collection-v1\0detail\0', 'utf8')
    .update(staleDetailContent, 'utf8')
    .update('\0summary\0', 'utf8')
    .update(staleSummaryContent, 'utf8')
    .digest('hex')
  writeReceipt({ collectionContentSha256: staleContentSha256 })
  await assertClosed()

  fs.rmSync(summaryPath)
  await assertClosed()

  fs.writeFileSync(detailPath, detailContent)
  fs.writeFileSync(summaryPath, summaryContent)
  writeReceipt()
})
