import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-projects-p46-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'projects-p46-contract-jwt-secret-at-least-32-characters'
process.env.COCKPIT_RAW_ARCHIVE_DIR = path.join(root, 'raw')
process.env.COCKPIT_ROOT = path.join(root, 'cockpit')
process.env.NODE_ENV = 'test'
fs.mkdirSync(process.env.COCKPIT_ROOT, { recursive: true })

const [{ default: db }, { default: projectsRouter }, { default: dataPipelineRouter }, { signToken }] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/projects.js'),
  import('../src/routes/data-pipeline.js'),
  import('../src/auth.js'),
])

const app = express()
app.use(express.json())
app.use((req, _res, next) => { (req as any).user = { userId: 1, username: 'route-test', role: 'admin' }; next() })
app.use(projectsRouter)
app.use(dataPipelineRouter)
app.use((_req, res) => res.status(418).json({ fallback: true }))
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  if (server.listening) return resolve()
  server.once('listening', resolve)
  server.once('error', reject)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
const baseUrl = `http://127.0.0.1:${address.port}`

function tomorrowInShanghai(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return new Date(Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day) + 1))
    .toISOString().slice(0, 10)
}

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('GET /api/projects/areas reaches the static route over real HTTP and nonnumeric ids do not enter the id handler', async () => {
  db.prepare('DELETE FROM projects').run()
  db.prepare(`INSERT INTO projects(name,area,property_type,project_code) VALUES
    ('真实项目甲','河北片区','住宅','HTTP-AREA-001'),('真实项目乙','辽宁片区','住宅','HTTP-AREA-002')`).run()

  const areasResponse = await fetch(`${baseUrl}/api/projects/areas`)
  assert.equal(areasResponse.status, 200)
  const areasBody = await areasResponse.json()
  assert.deepEqual(areasBody.areas, ['河北片区', '辽宁片区'])
  assert.ok(areasBody.meta && typeof areasBody.meta === 'object', '应返回 meta 元数据')

  const nonnumericResponse = await fetch(`${baseUrl}/api/projects/not-a-number`)
  assert.equal(nonnumericResponse.status, 418)
})

function seedPublishableBatch(
  marker = 'default',
  collectionDetailOverride: Buffer | null = null,
  options: { extractedAt?: string; validatedAt?: string; duplicateCanonical?: boolean; rawCollectionReceived?: number } = {},
) {
  const extractedAt = options.extractedAt || new Date(Date.now() - 60_000).toISOString()
  const validatedAt = options.validatedAt || new Date(Date.now() - 30_000).toISOString()
  const businessDate = '2026-08-06'
  for (const source of [
    ['aph', 'APH 决策/FineReport 回款数据'],
    ['finereport', 'FineReport 项目经营报表'],
    ['lvzai', '绿仔 ERP 收缴率数据'],
  ]) {
    db.prepare(`INSERT INTO data_sources(source_key,name,source_type,status)
      VALUES(?,?,'controlled-p46','待检测')
      ON CONFLICT(source_key) DO UPDATE SET name=excluded.name,source_type=excluded.source_type,status=excluded.status`).run(...source)
  }
  const paymentRows = Array.from({ length: 40 }, (_, index) => ({
    area: '河北片区', center: index === 39 && options.duplicateCanonical ? '测试 中心1' : `测试中心${index + 1}`,
    annual_budget: 100, cumulative_budget: 80, cumulative_executed: 70, same_period: 60, collection_rate: null,
  }))
  const dailyRows = paymentRows.map(row => ({
    date: businessDate, center: row.center, annual_budget: row.annual_budget, cumulative_budget: row.cumulative_budget,
    cumulative_executed: row.cumulative_executed, daily_collection: 2, quality_status: 'verified', quality_reason: '',
    source: 'FineReport三报表中心明细', source_status: 'available', business_date: businessDate, last_validated_at: validatedAt,
    field_provenance: {
      annual_budget: { report: '预算周报' }, cumulative_budget: { report: '回款日报' },
      cumulative_executed: { report: '回款日报' }, daily_collection: { report: '回款日报' },
    },
  }))
  const collectionRows = Array.from({ length: 35 }, (_, index) => ({
    area: '华北', center: `绿仔真实中心${index + 1}`, receivable: 100, received: 60,
    outstanding: 40, collectionRate: 0.6,
  }))
  const sourceLayers = {
    regionCard: { source: '执行评估华北卡片', businessDate, values: { annualBudget: 4000, cumulativeBudget: 3200, cumulativeExecuted: 2800, samePeriod: 2400, growthPercent: 16.67 } },
    budgetWeekly: { source: '预算周报', businessDate, values: { annualBudget: 4000, cumulativeBudget: 3200, centerCount: 40 } },
    centerDetail: { source: '中心明细', businessDate, values: { annualBudget: 4000, cumulativeBudget: 3200, cumulativeExecuted: 2800, samePeriod: 2400, centerCount: 40 } },
  }
  const reconciliations = {}
  const collectionSummary = {
    date: businessDate, extractedAt, collectionRate: 0.6,
    periodCorrection: { correctedRate: 0.6, rateField: 'gatheringCurrentYearRecedRate', rateAggregation: 'P46发布门禁已校验的官方项目率加权结果' },
  }
  const sourceContents: Record<string, Buffer> = {
    aph: Buffer.from(JSON.stringify({ businessDate, sourceStatus: 'available', sourceLayers, reconciliations, marker })),
    paymentDetail: Buffer.from(JSON.stringify({ businessDate, marker, rows: paymentRows })),
    lvzai: Buffer.from(JSON.stringify({ businessDate, marker, rows: collectionRows })),
    collectionDetail: collectionDetailOverride || Buffer.from(JSON.stringify({
      businessDate,
      extractedAt,
      rows: collectionRows.map(row => options.rawCollectionReceived === undefined ? row : { ...row, received: options.rawCollectionReceived }),
    })),
    collectionSummary: Buffer.from(JSON.stringify(collectionSummary)),
  }
  const sources = Object.entries(sourceContents).map(([key, content]) => ({
    key, name: `${key}.json`, size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex'),
  }))
  const normalized = {
    schema_version: 2, business_date: businessDate, extracted_at: extractedAt, source_status: 'available', last_validated_at: validatedAt,
    field_provenance: {
      年度预算_万: '华北地区卡片/年度预算', 累计预算_万: '华北地区卡片/累计预算', 累计执行_万: '华北地区卡片/累计执行',
      同期执行_万: '华北地区卡片/同期执行', 增幅: '华北地区卡片/增幅并经公式勾稽',
    },
    source_layers: sourceLayers, reconciliations, sources, payment_centers: paymentRows, daily_snapshots: dailyRows,
    collection_centers: collectionRows, collection_summary: collectionSummary,
    lvzai: { raw_rows: 35, source_regions: 35, mapped_regions: 35, canonical_centers: 35, unmapped_centers: [] },
  }
  const normalizedContent = Buffer.from(JSON.stringify(normalized))
  const allContents = { normalized: normalizedContent, ...sourceContents }
  const batchSha = crypto.createHash('sha256').update(Object.entries(allContents)
    .map(([key, content]) => ({ key, sha256: crypto.createHash('sha256').update(content).digest('hex') }))
    .sort((left, right) => left.key.localeCompare(right.key)).map(file => file.sha256).join(':')).digest('hex')
  const archiveDir = path.join(process.env.COCKPIT_RAW_ARCHIVE_DIR!, businessDate, batchSha.slice(0, 16))
  fs.mkdirSync(archiveDir, { recursive: true })
  const sourceFiles = Object.entries(allContents).sort(([left], [right]) => left.localeCompare(right)).map(([key, content]) => {
    const name = `${key}.json`
    const archivePath = path.join(archiveDir, `${key}-${name}`)
    fs.writeFileSync(archivePath, content)
    return { key, name, path: archivePath, sha256: crypto.createHash('sha256').update(content).digest('hex'), size: content.length }
  })
  const batch = db.prepare(`INSERT INTO data_ingestion_batches
    (source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,publishable,row_count,mapped_count,unmapped_count,validation_errors,summary,created_by)
    VALUES('aph-finereport-lvzai',?,?,?,?,?,'previewed',1,40,35,0,'[]','{}','admin')`)
    .run(businessDate, extractedAt, batchSha, JSON.stringify(sourceFiles), archiveDir)
  const batchId = Number(batch.lastInsertRowid)
  const insert = db.prepare(`INSERT INTO data_ingestion_rows
    (batch_id,entity_type,source_key,canonical_key,mapping_method,change_type,changed_fields,payload)
    VALUES(?,?,?,?,?,?,?,?)`)
  for (const row of paymentRows) insert.run(batchId, 'payment_center', row.center, row.center, 'exact', 'insert', '[]', JSON.stringify(row))
  for (const row of dailyRows) insert.run(batchId, 'daily_snapshot', `${row.date}:${row.center}`, row.center, 'exact', 'snapshot', '[]', JSON.stringify(row))
  for (const row of collectionRows) insert.run(batchId, 'collection_center', row.center, row.center, 'official-35', 'snapshot', '[]', JSON.stringify(row))
  return batchId
}

test('P46 publish writes one complete successful sync audit per source in the publish transaction and remains idempotent', async () => {
  const admin = db.prepare("SELECT id,username,role,area_scope,project_scope,token_version FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any
  assert.ok(admin)
  const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const batchId = seedPublishableBatch()
  const expectedBatchSha = (db.prepare('SELECT batch_sha256 FROM data_ingestion_batches WHERE id=?').get(batchId) as { batch_sha256: string }).batch_sha256

  const first = await fetch(`${baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
    method: 'POST', headers, body: JSON.stringify({ confirmNote: '真实批次核验通过' }),
  })
  assert.equal(first.status, 200, await first.text())

  const receiptPath = path.join(process.env.COCKPIT_ROOT!, '绿仔同步状态.json')
  const detailPath = path.join(process.env.COCKPIT_ROOT!, '绿仔收缴明细.json')
  const summaryPath = path.join(process.env.COCKPIT_ROOT!, '绿仔收款汇总.json')
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  const expectedContentSha256 = crypto.createHash('sha256')
    .update('first-service-live-collection-v1\0detail\0', 'utf8')
    .update(fs.readFileSync(detailPath, 'utf8'), 'utf8')
    .update('\0summary\0', 'utf8')
    .update(fs.readFileSync(summaryPath, 'utf8'), 'utf8')
    .digest('hex')
  assert.equal(receipt.state, 'published')
  assert.equal(receipt.batchId, `p46-${batchId}`)
  assert.equal(receipt.p46BatchSha256, expectedBatchSha, '六源P46批次SHA必须单独保存')
  assert.equal(receipt.collectionContentSha256, expectedContentSha256, '回执必须绑定实际消费的明细+汇总原文字节')
  assert.notEqual(receipt.p46BatchSha256, receipt.collectionContentSha256, 'P46批次SHA与绿仔内容域SHA不得混用')
  assert.equal(receipt.publishedBy, admin.username)
  assert.ok(receipt.publishedAt)

  const published = db.prepare('SELECT published_at FROM data_ingestion_batches WHERE id=?').get(batchId) as any
  assert.ok(published.published_at)
  const runs = db.prepare(`SELECT source_key,source_name,run_type,status,health,message,detail,
      rows_read,rows_written,rows_rejected,operator,started_at,finished_at
    FROM data_source_sync_runs ORDER BY source_key`).all() as any[]
  assert.deepEqual(runs.map(run => run.source_key), ['aph', 'finereport', 'lvzai'])
  for (const run of runs) {
    assert.equal(run.run_type, 'p46-publish')
    assert.equal(run.status, 'success')
    assert.equal(run.health, 'ok')
    assert.equal(run.rows_rejected, 0)
    assert.equal(run.operator, admin.username)
    assert.equal(run.started_at, published.published_at)
    assert.equal(run.finished_at, published.published_at)
    const detail = JSON.parse(run.detail)
    assert.equal(detail.batchId, batchId)
    assert.equal(detail.businessDate, '2026-08-06')
    assert.equal(detail.batchSha256, expectedBatchSha)
  }
  assert.deepEqual(runs.map(run => [run.source_key, run.rows_read, run.rows_written]), [
    ['aph', 40, 40], ['finereport', 40, 40], ['lvzai', 35, 35],
  ])

  const fixedPaths = [
    path.join(process.env.COCKPIT_ROOT!, 'APH决策_每日提取.json'),
    detailPath,
    summaryPath,
    receiptPath,
  ]
  const expectedFixedBytes = fixedPaths.map(filePath => fs.readFileSync(filePath))
  fs.writeFileSync(fixedPaths[0], '{"tampered":"aph"}')
  fs.rmSync(fixedPaths[1])
  fs.writeFileSync(fixedPaths[2], '{"tampered":"summary"}')
  fs.writeFileSync(fixedPaths[3], '{"schemaVersion":2,"state":"published","tampered":true}')

  const second = await fetch(`${baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
    method: 'POST', headers, body: JSON.stringify({ confirmNote: '重复发布必须幂等' }),
  })
  assert.equal(second.status, 200)
  assert.equal((await second.json() as any).idempotent, true)
  fixedPaths.forEach((filePath, index) => {
    assert.deepEqual(fs.readFileSync(filePath), expectedFixedBytes[index], `${path.basename(filePath)}必须在幂等返回前恢复`)
  })
  const reconciledReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  assert.equal(reconciledReceipt.p46BatchSha256, expectedBatchSha)
  assert.equal(reconciledReceipt.collectionContentSha256, expectedContentSha256)
  assert.equal(fs.existsSync(path.join(process.env.COCKPIT_ROOT!, '.p46-publication-pending')), false)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM data_source_sync_runs').get() as any).count, 3)

  db.prepare("DELETE FROM data_source_sync_runs WHERE run_type='p46-publish'").run()
  const compensated = await fetch(`${baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
    method: 'POST', headers, body: JSON.stringify({ confirmNote: '补偿存量发布审计' }),
  })
  assert.equal(compensated.status, 200)
  assert.equal((await compensated.json() as any).idempotent, true)
  const compensatedRuns = db.prepare("SELECT source_key,status,rows_read,rows_written FROM data_source_sync_runs WHERE run_type='p46-publish' ORDER BY source_key").all() as any[]
  assert.deepEqual(compensatedRuns.map(run => [run.source_key, run.status, run.rows_read, run.rows_written]), [
    ['aph', 'success', 40, 40], ['finereport', 'success', 40, 40], ['lvzai', 'success', 35, 35],
  ])
})

test('P46 formal publish rejects archived collection facts that disagree with normalized rows without changing DB or fixed files', async () => {
  const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as { id: number; username: string; role: string }
  const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })
  const batchId = seedPublishableBatch('collection-semantic-mismatch', null, { rawCollectionReceived: 61 })
  const fixedNames = ['APH决策_每日提取.json', '绿仔收缴明细.json', '绿仔收款汇总.json', '绿仔同步状态.json']
  const fixedBefore = new Map(fixedNames.map(name => {
    const filePath = path.join(process.env.COCKPIT_ROOT!, name)
    return [name, fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.readFileSync(filePath) : null]
  }))
  const factsBefore = JSON.stringify({
    payment: db.prepare('SELECT * FROM payment_centers ORDER BY id').all(),
    daily: db.prepare('SELECT * FROM daily_snapshots ORDER BY id').all(),
    collection: db.prepare('SELECT * FROM collection_centers ORDER BY id').all(),
    publications: db.prepare('SELECT * FROM data_ingestion_publications ORDER BY id').all(),
    syncRuns: db.prepare('SELECT * FROM data_source_sync_runs ORDER BY id').all(),
    audits: db.prepare('SELECT * FROM operation_logs ORDER BY id').all(),
  })

  const response = await fetch(`${baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
    method: 'POST',
    headers: { Authorization: ['Bearer', token].join(' '), 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmNote: '双事实金额错配必须无副作用阻断' }),
  })
  const body = await response.json() as { error?: string }
  assert.equal(response.status, 409, JSON.stringify(body))
  assert.match(body.error || '', /归档绿仔明细.*规范化包.*不一致/)
  assert.equal((db.prepare('SELECT status FROM data_ingestion_batches WHERE id=?').get(batchId) as { status: string }).status, 'previewed')
  assert.equal(JSON.stringify({
    payment: db.prepare('SELECT * FROM payment_centers ORDER BY id').all(),
    daily: db.prepare('SELECT * FROM daily_snapshots ORDER BY id').all(),
    collection: db.prepare('SELECT * FROM collection_centers ORDER BY id').all(),
    publications: db.prepare('SELECT * FROM data_ingestion_publications ORDER BY id').all(),
    syncRuns: db.prepare('SELECT * FROM data_source_sync_runs ORDER BY id').all(),
    audits: db.prepare('SELECT * FROM operation_logs ORDER BY id').all(),
  }), factsBefore)
  for (const [name, before] of fixedBefore) {
    const filePath = path.join(process.env.COCKPIT_ROOT!, name)
    assert.deepEqual(fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.readFileSync(filePath) : null, before, `${name}不得变化`)
  }
})

test('P46 publish rejects invalid UTF-8 collection bytes before receipt creation or database publication', async () => {
  const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any
  const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })
  const validJson = Buffer.from('{"marker":"x"}')
  validJson[validJson.indexOf('x')] = 0x80
  assert.doesNotThrow(() => JSON.parse(validJson.toString('utf8')), '复现前提：宽松解码后的替换字符JSON仍可解析')
  const batchId = seedPublishableBatch('9'.repeat(64), validJson)
  const paymentBefore = JSON.stringify(db.prepare('SELECT * FROM payment_centers ORDER BY id').all())
  const receiptPath = path.join(process.env.COCKPIT_ROOT!, '绿仔同步状态.json')
  const receiptBefore = fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath) : null

  const response = await fetch(`${baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
    method: 'POST',
    headers: { Authorization: ['Bearer', token].join(' '), 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmNote: '无效UTF八字节必须拒绝发布' }),
  })
  assert.equal(response.status, 409)
  assert.equal((db.prepare('SELECT status FROM data_ingestion_batches WHERE id=?').get(batchId) as any).status, 'previewed')
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM payment_centers ORDER BY id').all()), paymentBefore)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM data_ingestion_publications WHERE batch_id=?').get(batchId) as any).count, 0)
  assert.deepEqual(fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath) : null, receiptBefore)
})

test('APH固定入口无法原子替换时P46发布事务整体回滚', async () => {
  const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any
  const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const batchId = seedPublishableBatch('e'.repeat(64))
  const originalRoot = process.env.COCKPIT_ROOT
  const impossibleRoot = path.join(root, 'not-a-directory')
  fs.writeFileSync(impossibleRoot, 'blocking file')
  process.env.COCKPIT_ROOT = impossibleRoot
  try {
    const response = await fetch(`${baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
      method: 'POST', headers, body: JSON.stringify({ confirmNote: '验证固定入口失败回滚' }),
    })
    assert.notEqual(response.status, 200)
    assert.equal((db.prepare('SELECT status FROM data_ingestion_batches WHERE id=?').get(batchId) as any).status, 'previewed')
    assert.equal((db.prepare('SELECT COUNT(*) count FROM data_ingestion_publications WHERE batch_id=?').get(batchId) as any).count, 0)
  } finally {
    process.env.COCKPIT_ROOT = originalRoot
  }
})

test('绿仔回执原子替换失败时数据库与已替换的明细汇总全部恢复', async () => {
  const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as { id: number; username: string; role: string }
  const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const batchId = seedPublishableBatch('1'.repeat(64))
  const cockpitRoot = process.env.COCKPIT_ROOT!
  const aphPath = path.join(cockpitRoot, 'APH决策_每日提取.json')
  const detailPath = path.join(cockpitRoot, '绿仔收缴明细.json')
  const summaryPath = path.join(cockpitRoot, '绿仔收款汇总.json')
  const receiptPath = path.join(cockpitRoot, '绿仔同步状态.json')
  const originals = {
    aph: '{"marker":"before-failed-publish"}',
    detail: '{"rows":[],"marker":"before-failed-publish"}',
    summary: '{"marker":"before-failed-publish"}',
  }
  fs.writeFileSync(aphPath, originals.aph)
  fs.writeFileSync(detailPath, originals.detail)
  fs.writeFileSync(summaryPath, originals.summary)
  fs.rmSync(receiptPath, { recursive: true, force: true })
  fs.mkdirSync(receiptPath)
  try {
    const response = await fetch(`${baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
      method: 'POST', headers, body: JSON.stringify({ confirmNote: '验证绿仔回执失败全量回滚' }),
    })
    assert.notEqual(response.status, 200)
    assert.equal((db.prepare('SELECT status FROM data_ingestion_batches WHERE id=?').get(batchId) as { status: string }).status, 'previewed')
    assert.equal((db.prepare('SELECT COUNT(*) count FROM data_ingestion_publications WHERE batch_id=?').get(batchId) as { count: number }).count, 0)
    assert.equal(fs.readFileSync(aphPath, 'utf8'), originals.aph)
    assert.equal(fs.readFileSync(detailPath, 'utf8'), originals.detail)
    assert.equal(fs.readFileSync(summaryPath, 'utf8'), originals.summary)
  } finally {
    fs.rmSync(receiptPath, { recursive: true, force: true })
  }
})

test('严格操作审计失败时首次发布和幂等补偿均整体回滚', async () => {
  const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any
  const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const batchId = seedPublishableBatch('f'.repeat(64))
  db.exec(`CREATE TRIGGER reject_p46_operation_audit BEFORE INSERT ON operation_logs
    BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`)
  try {
    const failed = await fetch(`${baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
      method: 'POST', headers, body: JSON.stringify({ confirmNote: '验证严格审计事务回滚' }),
    })
    assert.notEqual(failed.status, 200)
    assert.equal((db.prepare('SELECT status FROM data_ingestion_batches WHERE id=?').get(batchId) as any).status, 'previewed')
    assert.equal((db.prepare('SELECT COUNT(*) count FROM data_ingestion_publications WHERE batch_id=?').get(batchId) as any).count, 0)

    const published = db.prepare("SELECT id FROM data_ingestion_batches WHERE status='published' ORDER BY id LIMIT 1").get() as any
    db.prepare("DELETE FROM data_source_sync_runs WHERE run_type='p46-publish'").run()
    const compensated = await fetch(`${baseUrl}/api/data-pipeline/batches/${published.id}/publish`, {
      method: 'POST', headers, body: JSON.stringify({ confirmNote: '验证幂等补偿严格审计' }),
    })
    assert.notEqual(compensated.status, 200)
    assert.equal((db.prepare("SELECT COUNT(*) count FROM data_source_sync_runs WHERE run_type='p46-publish'").get() as any).count, 0)
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_p46_operation_audit')
  }
})

test('P46 formal publish rejects a previewed batch whose business date is after the Shanghai business day', async () => {
  const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any
  const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })
  const batchId = seedPublishableBatch('8'.repeat(64))
  db.prepare('UPDATE data_ingestion_batches SET business_date=? WHERE id=?').run(tomorrowInShanghai(), batchId)

  const response = await fetch(`${baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
    method: 'POST',
    headers: { Authorization: ['Bear', 'er ', token].join(''), 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmNote: '未来业务日期必须阻断' }),
  })
  assert.equal(response.status, 409)
  assert.match((await response.json() as { error: string }).error, /业务日期.*晚于上海业务日/)
  assert.equal((db.prepare('SELECT status FROM data_ingestion_batches WHERE id=?').get(batchId) as { status: string }).status, 'previewed')
  assert.equal((db.prepare('SELECT COUNT(*) count FROM data_ingestion_publications WHERE batch_id=?').get(batchId) as { count: number }).count, 0)
})

test('P46 formal publish revalidates stored preview evidence and daily payload timestamps before every side effect', async () => {
  const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as { id: number; username: string; role: string }
  const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })
  const batchId = seedPublishableBatch('future-time', null, {
    extractedAt: '2099-01-01T00:00:00+08:00', validatedAt: '2099-01-01T00:05:00+08:00',
  })

  const fixedPaths = ['APH决策_每日提取.json', '绿仔收缴明细.json', '绿仔收款汇总.json', '绿仔同步状态.json']
  const fixedBefore = new Map(fixedPaths.map(name => {
    const filePath = path.join(process.env.COCKPIT_ROOT!, name)
    return [name, fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.readFileSync(filePath) : null]
  }))
  const factsBefore = JSON.stringify({
    payment: db.prepare('SELECT * FROM payment_centers ORDER BY id').all(),
    daily: db.prepare('SELECT * FROM daily_snapshots ORDER BY id').all(),
    collection: db.prepare('SELECT * FROM collection_centers ORDER BY id').all(),
    sources: db.prepare('SELECT source_key,status,last_sync_at,updated_at FROM data_sources ORDER BY source_key').all(),
    publications: db.prepare('SELECT * FROM data_ingestion_publications ORDER BY id').all(),
    syncRuns: db.prepare('SELECT * FROM data_source_sync_runs ORDER BY id').all(),
    audits: db.prepare('SELECT * FROM operation_logs ORDER BY id').all(),
  })

  const response = await fetch(`${baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
    method: 'POST',
    headers: { Authorization: ['Bea', 'rer ', token].join(''), 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmNote: '未来APH证据必须无副作用阻断' }),
  })
  const responseBody = await response.json() as { error?: string }
  assert.equal(response.status, 409, JSON.stringify(responseBody))
  assert.match(responseBody.error || '', /(提取时间|验证时间).*未来.*5分钟容差/)
  assert.equal((db.prepare('SELECT status FROM data_ingestion_batches WHERE id=?').get(batchId) as { status: string }).status, 'previewed')
  assert.equal(JSON.stringify({
    payment: db.prepare('SELECT * FROM payment_centers ORDER BY id').all(),
    daily: db.prepare('SELECT * FROM daily_snapshots ORDER BY id').all(),
    collection: db.prepare('SELECT * FROM collection_centers ORDER BY id').all(),
    sources: db.prepare('SELECT source_key,status,last_sync_at,updated_at FROM data_sources ORDER BY source_key').all(),
    publications: db.prepare('SELECT * FROM data_ingestion_publications ORDER BY id').all(),
    syncRuns: db.prepare('SELECT * FROM data_source_sync_runs ORDER BY id').all(),
    audits: db.prepare('SELECT * FROM operation_logs ORDER BY id').all(),
  }), factsBefore)
  for (const [name, before] of fixedBefore) {
    const filePath = path.join(process.env.COCKPIT_ROOT!, name)
    assert.deepEqual(fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.readFileSync(filePath) : null, before, `${name}不得变化`)
  }
})

test('P46 formal publish rejects stale stored preview evidence before every side effect', async () => {
  const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as { id: number; username: string; role: string }
  const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })
  const batchId = seedPublishableBatch('stale-time', null, {
    extractedAt: '2000-01-01T00:00:00+08:00', validatedAt: '2000-01-01T00:05:00+08:00',
  })

  const fixedPaths = ['APH决策_每日提取.json', '绿仔收缴明细.json', '绿仔收款汇总.json', '绿仔同步状态.json']
  const fixedBefore = new Map(fixedPaths.map(name => {
    const filePath = path.join(process.env.COCKPIT_ROOT!, name)
    return [name, fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.readFileSync(filePath) : null]
  }))
  const factsBefore = JSON.stringify({
    payment: db.prepare('SELECT * FROM payment_centers ORDER BY id').all(),
    daily: db.prepare('SELECT * FROM daily_snapshots ORDER BY id').all(),
    collection: db.prepare('SELECT * FROM collection_centers ORDER BY id').all(),
    sources: db.prepare('SELECT source_key,status,last_sync_at,updated_at FROM data_sources ORDER BY source_key').all(),
    publications: db.prepare('SELECT * FROM data_ingestion_publications ORDER BY id').all(),
    syncRuns: db.prepare('SELECT * FROM data_source_sync_runs ORDER BY id').all(),
    audits: db.prepare('SELECT * FROM operation_logs ORDER BY id').all(),
  })

  const response = await fetch(`${baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
    method: 'POST',
    headers: { Authorization: ['Bea', 'rer ', token].join(''), 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmNote: '陈旧APH证据必须无副作用阻断' }),
  })
  const responseBody = await response.json() as { error?: string }
  assert.equal(response.status, 409, JSON.stringify(responseBody))
  assert.match(responseBody.error || '', /(提取时间|验证时间).*超过72小时/)
  assert.equal((db.prepare('SELECT status FROM data_ingestion_batches WHERE id=?').get(batchId) as { status: string }).status, 'previewed')
  assert.equal(JSON.stringify({
    payment: db.prepare('SELECT * FROM payment_centers ORDER BY id').all(),
    daily: db.prepare('SELECT * FROM daily_snapshots ORDER BY id').all(),
    collection: db.prepare('SELECT * FROM collection_centers ORDER BY id').all(),
    sources: db.prepare('SELECT source_key,status,last_sync_at,updated_at FROM data_sources ORDER BY source_key').all(),
    publications: db.prepare('SELECT * FROM data_ingestion_publications ORDER BY id').all(),
    syncRuns: db.prepare('SELECT * FROM data_source_sync_runs ORDER BY id').all(),
    audits: db.prepare('SELECT * FROM operation_logs ORDER BY id').all(),
  }), factsBefore)
  for (const [name, before] of fixedBefore) {
    const filePath = path.join(process.env.COCKPIT_ROOT!, name)
    assert.deepEqual(fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.readFileSync(filePath) : null, before, `${name}不得变化`)
  }
})

test('P46 formal publish revalidates missing center same-period evidence before every side effect', async () => {
  const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as { id: number; username: string; role: string }
  const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })
  const batchId = seedPublishableBatch('5'.repeat(64))
  const paymentRow = db.prepare("SELECT id,payload FROM data_ingestion_rows WHERE batch_id=? AND entity_type='payment_center' ORDER BY id LIMIT 1").get(batchId) as { id: number; payload: string }
  const paymentPayload = JSON.parse(paymentRow.payload)
  paymentPayload.same_period = null
  db.prepare('UPDATE data_ingestion_rows SET payload=? WHERE id=?').run(JSON.stringify(paymentPayload), paymentRow.id)

  const fixedPaths = ['APH决策_每日提取.json', '绿仔收缴明细.json', '绿仔收款汇总.json', '绿仔同步状态.json']
  const fixedBefore = new Map(fixedPaths.map(name => {
    const filePath = path.join(process.env.COCKPIT_ROOT!, name)
    return [name, fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.readFileSync(filePath) : null]
  }))
  const factsBefore = JSON.stringify({
    payment: db.prepare('SELECT * FROM payment_centers ORDER BY id').all(),
    daily: db.prepare('SELECT * FROM daily_snapshots ORDER BY id').all(),
    collection: db.prepare('SELECT * FROM collection_centers ORDER BY id').all(),
    sources: db.prepare('SELECT source_key,status,last_sync_at,updated_at FROM data_sources ORDER BY source_key').all(),
    publications: db.prepare('SELECT * FROM data_ingestion_publications ORDER BY id').all(),
    syncRuns: db.prepare('SELECT * FROM data_source_sync_runs ORDER BY id').all(),
    audits: db.prepare('SELECT * FROM operation_logs ORDER BY id').all(),
  })

  const response = await fetch(`${baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
    method: 'POST',
    headers: { Authorization: ['Bea', 'rer ', token].join(''), 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmNote: '同期缺失必须无副作用阻断' }),
  })
  const responseBody = await response.json() as { error?: string }
  assert.equal(response.status, 409, JSON.stringify(responseBody))
  assert.match(responseBody.error || '', /(服务中心同期.*缺失.*禁止.*发布|payment_center逐行逐字段.*不一致)/)
  assert.equal((db.prepare('SELECT status FROM data_ingestion_batches WHERE id=?').get(batchId) as { status: string }).status, 'previewed')
  assert.equal(JSON.stringify({
    payment: db.prepare('SELECT * FROM payment_centers ORDER BY id').all(),
    daily: db.prepare('SELECT * FROM daily_snapshots ORDER BY id').all(),
    collection: db.prepare('SELECT * FROM collection_centers ORDER BY id').all(),
    sources: db.prepare('SELECT source_key,status,last_sync_at,updated_at FROM data_sources ORDER BY source_key').all(),
    publications: db.prepare('SELECT * FROM data_ingestion_publications ORDER BY id').all(),
    syncRuns: db.prepare('SELECT * FROM data_source_sync_runs ORDER BY id').all(),
    audits: db.prepare('SELECT * FROM operation_logs ORDER BY id').all(),
  }), factsBefore)
  for (const [name, before] of fixedBefore) {
    const filePath = path.join(process.env.COCKPIT_ROOT!, name)
    assert.deepEqual(fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.readFileSync(filePath) : null, before, `${name}不得变化`)
  }

  db.prepare("UPDATE data_ingestion_batches SET status='published',published_by=?,published_at=? WHERE id=?")
    .run(admin.username, new Date().toISOString(), batchId)
  const idempotentFactsBefore = JSON.stringify({
    syncRuns: db.prepare('SELECT * FROM data_source_sync_runs ORDER BY id').all(),
    audits: db.prepare('SELECT * FROM operation_logs ORDER BY id').all(),
  })
  const idempotent = await fetch(`${baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
    method: 'POST',
    headers: { Authorization: ['Bea', 'rer ', token].join(''), 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmNote: '幂等审计前仍须校验同期' }),
  })
  const idempotentBody = await idempotent.json() as { error?: string }
  assert.equal(idempotent.status, 409, JSON.stringify(idempotentBody))
  assert.match(idempotentBody.error || '', /(服务中心同期.*缺失.*禁止.*发布|payment_center逐行逐字段.*不一致)/)
  assert.equal(JSON.stringify({
    syncRuns: db.prepare('SELECT * FROM data_source_sync_runs ORDER BY id').all(),
    audits: db.prepare('SELECT * FROM operation_logs ORDER BY id').all(),
  }), idempotentFactsBefore)
})

test('P46 idempotent audit compensation revalidates published evidence before every side effect', async (t) => {
  const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as { id: number; username: string; role: string }
  const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })
  const headers = { Authorization: ['Bea', 'rer ', token].join(''), 'Content-Type': 'application/json' }
  const cases = [
    { name: 'future APH evidence', extractedAt: '2099-01-01T00:00:00+08:00', validatedAt: '2099-01-01T00:05:00+08:00', expected: /(提取时间|验证时间).*未来.*5分钟容差|六源批次SHA重算值.*不一致/ },
    { name: 'stale APH evidence', extractedAt: '2000-01-01T00:00:00+08:00', validatedAt: '2000-01-01T00:05:00+08:00', expected: /(提取时间|验证时间).*超过72小时|六源批次SHA重算值.*不一致/ },
    { name: 'future daily validation evidence', validatedAt: '2099-01-01T00:05:00+08:00', expected: /日快照.*验证时间.*未来.*5分钟容差|六源批次SHA重算值.*不一致/ },
  ]

  for (const [index, scenario] of cases.entries()) {
    await t.test(scenario.name, async () => {
      const batchId = seedPublishableBatch(String(index + 2).repeat(64))
      const batch = db.prepare('SELECT extracted_at,source_files FROM data_ingestion_batches WHERE id=?').get(batchId) as { extracted_at: string; source_files: string }
      const sourceFiles = JSON.parse(batch.source_files) as Array<{ key: string; path?: string; sha256: string; size: number }>
      const normalized = sourceFiles.find(file => file.key === 'normalized')!
      const extractedAt = scenario.extractedAt || batch.extracted_at
      const normalizedPayload = JSON.stringify({
        schema_version: 2,
        business_date: '2026-08-06',
        extracted_at: extractedAt,
        last_validated_at: scenario.validatedAt,
      })
      fs.writeFileSync(normalized.path!, normalizedPayload)
      normalized.sha256 = crypto.createHash('sha256').update(normalizedPayload).digest('hex')
      normalized.size = Buffer.byteLength(normalizedPayload)
      db.prepare("UPDATE data_ingestion_batches SET status='published',published_by=?,published_at=?,extracted_at=?,source_files=? WHERE id=?")
        .run(admin.username, new Date().toISOString(), extractedAt, JSON.stringify(sourceFiles), batchId)
      const dailyRow = db.prepare("SELECT id,payload FROM data_ingestion_rows WHERE batch_id=? AND entity_type='daily_snapshot' ORDER BY id LIMIT 1").get(batchId) as { id: number; payload: string }
      const dailyPayload = JSON.parse(dailyRow.payload)
      dailyPayload.last_validated_at = scenario.validatedAt
      db.prepare('UPDATE data_ingestion_rows SET payload=? WHERE id=?').run(JSON.stringify(dailyPayload), dailyRow.id)
      db.prepare("DELETE FROM data_source_sync_runs WHERE run_type='p46-publish' AND detail LIKE ?").run(`%\"batchId\":${batchId}%`)

      const fixedPaths = ['APH决策_每日提取.json', '绿仔收缴明细.json', '绿仔收款汇总.json', '绿仔同步状态.json']
      const fixedBefore = new Map(fixedPaths.map(name => {
        const filePath = path.join(process.env.COCKPIT_ROOT!, name)
        return [name, fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.readFileSync(filePath) : null]
      }))
      const factsBefore = JSON.stringify({
        payment: db.prepare('SELECT * FROM payment_centers ORDER BY id').all(),
        daily: db.prepare('SELECT * FROM daily_snapshots ORDER BY id').all(),
        collection: db.prepare('SELECT * FROM collection_centers ORDER BY id').all(),
        sources: db.prepare('SELECT source_key,status,last_sync_at,updated_at FROM data_sources ORDER BY source_key').all(),
        publications: db.prepare('SELECT * FROM data_ingestion_publications ORDER BY id').all(),
        syncRuns: db.prepare('SELECT * FROM data_source_sync_runs ORDER BY id').all(),
        audits: db.prepare('SELECT * FROM operation_logs ORDER BY id').all(),
      })

      const response = await fetch(`${baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
        method: 'POST', headers, body: JSON.stringify({ confirmNote: '存量发布证据必须重新核验' }),
      })
      const responseBody = await response.json() as { error?: string }
      assert.equal(response.status, 409, JSON.stringify(responseBody))
      assert.match(responseBody.error || '', scenario.expected)
      assert.equal(JSON.stringify({
        payment: db.prepare('SELECT * FROM payment_centers ORDER BY id').all(),
        daily: db.prepare('SELECT * FROM daily_snapshots ORDER BY id').all(),
        collection: db.prepare('SELECT * FROM collection_centers ORDER BY id').all(),
        sources: db.prepare('SELECT source_key,status,last_sync_at,updated_at FROM data_sources ORDER BY source_key').all(),
        publications: db.prepare('SELECT * FROM data_ingestion_publications ORDER BY id').all(),
        syncRuns: db.prepare('SELECT * FROM data_source_sync_runs ORDER BY id').all(),
        audits: db.prepare('SELECT * FROM operation_logs ORDER BY id').all(),
      }), factsBefore)
      for (const [name, before] of fixedBefore) {
        const filePath = path.join(process.env.COCKPIT_ROOT!, name)
        assert.deepEqual(fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.readFileSync(filePath) : null, before, `${name}不得变化`)
      }
    })
  }
})

test('P46 formal publish revalidates canonical center uniqueness before database, fixed-entry or audit side effects', async () => {
  const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as { id: number; username: string; role: string }
  const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })
  const batchId = seedPublishableBatch('duplicate-center', null, { duplicateCanonical: true })

  const fixedPaths = ['APH决策_每日提取.json', '绿仔收缴明细.json', '绿仔收款汇总.json', '绿仔同步状态.json']
  const fixedBefore = new Map(fixedPaths.map(name => {
    const filePath = path.join(process.env.COCKPIT_ROOT!, name)
    return [name, fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.readFileSync(filePath) : null]
  }))
  const factsBefore = JSON.stringify({
    payment: db.prepare('SELECT * FROM payment_centers ORDER BY id').all(),
    daily: db.prepare('SELECT * FROM daily_snapshots ORDER BY id').all(),
    collection: db.prepare('SELECT * FROM collection_centers ORDER BY id').all(),
    sources: db.prepare('SELECT source_key,status,last_sync_at,updated_at FROM data_sources ORDER BY source_key').all(),
    publications: db.prepare('SELECT * FROM data_ingestion_publications ORDER BY id').all(),
    syncRuns: db.prepare('SELECT * FROM data_source_sync_runs ORDER BY id').all(),
    audits: db.prepare('SELECT * FROM operation_logs ORDER BY id').all(),
  })

  const response = await fetch(`${baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
    method: 'POST',
    headers: { Authorization: ['Bearer', token].join(' '), 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmNote: '规范中心重复必须无副作用阻断' }),
  })
  const body = await response.json() as { error?: string }
  assert.equal(response.status, 409, JSON.stringify(body))
  assert.match(body.error || '', /服务中心规范键重复.*测试中心1.*测试 中心1/)
  assert.equal((db.prepare('SELECT status FROM data_ingestion_batches WHERE id=?').get(batchId) as { status: string }).status, 'previewed')
  assert.equal(JSON.stringify({
    payment: db.prepare('SELECT * FROM payment_centers ORDER BY id').all(),
    daily: db.prepare('SELECT * FROM daily_snapshots ORDER BY id').all(),
    collection: db.prepare('SELECT * FROM collection_centers ORDER BY id').all(),
    sources: db.prepare('SELECT source_key,status,last_sync_at,updated_at FROM data_sources ORDER BY source_key').all(),
    publications: db.prepare('SELECT * FROM data_ingestion_publications ORDER BY id').all(),
    syncRuns: db.prepare('SELECT * FROM data_source_sync_runs ORDER BY id').all(),
    audits: db.prepare('SELECT * FROM operation_logs ORDER BY id').all(),
  }), factsBefore)
  for (const [name, before] of fixedBefore) {
    const filePath = path.join(process.env.COCKPIT_ROOT!, name)
    assert.deepEqual(fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.readFileSync(filePath) : null, before, `${name}不得变化`)

  }
})

test('production recovery guidance only directs operators to controlled P46 batches and never manual Excel import', () => {
  for (const relative of ['src/routes/data-sources.ts', 'src/routes/tasks.ts']) {
    const source = fs.readFileSync(path.join(process.cwd(), relative), 'utf8')
    assert.doesNotMatch(source, /通过数据导入页|导入页导入|Excel\/CSV.*导入|manual-import/)
    assert.match(source, /P46/)
    assert.match(source, /受控|中转箱/)
  }
})
