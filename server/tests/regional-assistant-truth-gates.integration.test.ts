import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { calculateLiveCollectionContentSha256 } from '../src/collection-quality.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-assistant-truth-gates-'))
const databasePath = path.join(root, 'cockpit.db')
const businessDate = new Date().toISOString().slice(0, 10)
const validatedAt = new Date().toISOString()

process.env.COCKPIT_DB_PATH = databasePath
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.COCKPIT_ADMIN_PASSWORD = 'AssistantTruthGates-Test-Only-2026'
process.env.JWT_SECRET = 'assistant-truth-gates-integration-secret-2026'
process.env.NODE_ENV = 'test'
delete process.env.COCKPIT_ALLOW_DEMO_DATA

// 生产表将必填金额声明为 NOT NULL，但历史损坏库或 SQLite 弱类型数据
// 仍可能出现 NULL/文本。此隔离表专门复现这类存量脏数据，验证读链路失败关闭。
const bootstrap = new Database(databasePath)
bootstrap.exec(`
  CREATE TABLE payment_centers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    area TEXT,
    center TEXT,
    annual_budget REAL,
    cumulative_budget REAL,
    cumulative_executed REAL,
    same_period REAL,
    collection_rate REAL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT ''
  )
`)
bootstrap.close()

const [{ default: db }, { buildRegionalAssistantContext }] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/regional-assistant.js'),
])

const adminRequest = {
  method: 'GET',
  path: '/api/ai/assistant/context',
  headers: {},
  user: { userId: 1, username: 'truth-gate-admin', role: 'admin' },
} as any

const regularCenter = '第一服务真实性测试服务中心'
const heatingCenter = '第一服务北京万国城MOMΛ服务中心'
const p46BatchSha256 = 'e'.repeat(64)
let p46BatchId = 0

function memberRequest(center: string): any {
  return {
    method: 'GET',
    path: '/api/ai/assistant/context',
    headers: {},
    user: {
      userId: center === regularCenter ? 2 : 3,
      username: center === regularCenter ? 'truth-gate-member' : 'truth-gate-heating-member',
      role: 'viewer',
      serviceCenterScope: center,
    },
  }
}

function aphPayload(regionValues: Record<string, unknown> = {}) {
  const values = {
    annualBudget: 120,
    cumulativeBudget: 80.25,
    cumulativeExecuted: 70.5,
    samePeriod: 60.75,
    ...regionValues,
  }
  return {
    businessDate,
    sourceStatus: 'available',
    lastValidatedAt: validatedAt,
    sourceLayers: {
      regionCard: {
        source: 'FineReport回款额执行评估·华北地区卡片',
        businessDate,
        values: {
          annualBudget: 120,
          cumulativeBudget: 80,
          cumulativeExecuted: 70,
          samePeriod: 60,
          ...regionValues,
        },
      },
      budgetWeekly: {
        source: '预算周报',
        businessDate,
        values: { annualBudget: 100, cumulativeBudget: 80, centerCount: 1 },
      },
      centerDetail: {
        source: 'FineReport日报+预算周报+执行评估中心明细',
        businessDate,
        values: {
          centerCount: 56,
          annualBudget: 100,
          cumulativeBudget: 80,
          cumulativeExecuted: 70,
          samePeriod: 60,
          samePeriodPresentCount: 56,
          samePeriodMissingCount: 0,
        },
      },
    },
    fieldProvenance: {
      年度预算_万: 'FineReport回款额执行评估·华北地区卡片',
      累计预算_万: 'FineReport回款额执行评估·华北地区卡片',
      累计执行_万: 'FineReport回款额执行评估·华北地区卡片',
      同期执行_万: 'FineReport回款额执行评估·华北地区卡片',
    },
    华北地区: {
      回款额: {
        年度预算_万: values.annualBudget,
        累计预算_万: values.cumulativeBudget,
        累计执行_万: values.cumulativeExecuted,
        同期执行_万: values.samePeriod,
      },
    },
    reconciliations: {
      annualBudgetCardVsWeekly: { leftValue: 120, rightValue: 100, difference: 20, status: 'warning' },
      annualBudgetCardVsCenterDetail: { leftValue: 120, rightValue: 100, difference: 20, status: 'warning' },
      samePeriodCardVsCenterDetail: { leftValue: 60, rightValue: 60, difference: 0, status: 'ok' },
    },
  }
}

function writeAph(regionValues: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(root, 'APH决策_每日提取.json'), JSON.stringify(aphPayload(regionValues)))
}

type CollectionRow = {
  area: string
  center: string
  receivable: number
  received: number
  outstanding: number
  collectionRate?: number | null
  source: string
}

function collectionRows(overrides: Partial<Record<'regular' | 'heating', Partial<CollectionRow>>> = {}): CollectionRow[] {
  const rows: CollectionRow[] = Array.from({ length: 33 }, (_, index) => ({
    area: '测试片区',
    center: `第一服务真实性样本${String(index + 1).padStart(2, '0')}服务中心`,
    receivable: 100,
    received: 61,
    outstanding: 39,
    collectionRate: 0.61,
    source: '绿仔正式收缴明细',
  }))
  rows.push({
    area: '测试片区', center: regularCenter, receivable: 100, received: 40,
    outstanding: 73, collectionRate: 0.37, source: '绿仔正式收缴明细', ...overrides.regular,
  })
  rows.push({
    area: '测试片区', center: heatingCenter, receivable: 100, received: 40,
    outstanding: 77, collectionRate: null, source: '绿仔正式收缴明细', ...overrides.heating,
  })
  return rows
}

function writeCollection(rows: CollectionRow[], statusOverrides: Record<string, unknown> = {}): void {
  const detailContent = JSON.stringify({ businessDate, rows, extractedAt: validatedAt })
  const summaryContent = JSON.stringify({
    date: businessDate,
    extractedAt: validatedAt,
    collectionRate: 0.61,
    receivable_万: 3500,
    received_万: 2100,
    outstanding_万: 987.65,
    source: '绿仔正式发布摘要',
    periodCorrection: {
      correctedRate: 0.61,
      rateField: 'gatheringCurrentYearRecedRate',
      rateAggregation: '按官方项目率应收加权',
    },
  })
  fs.writeFileSync(path.join(root, '绿仔收缴明细.json'), detailContent)
  fs.writeFileSync(path.join(root, '绿仔收款汇总.json'), summaryContent)
  fs.writeFileSync(path.join(root, '绿仔同步状态.json'), JSON.stringify({
    schemaVersion: 2,
    ok: true,
    state: 'published',
    date: businessDate,
    finishedAt: validatedAt,
    batchId: `p46-${p46BatchId}`,
    p46BatchSha256,
    collectionContentSha256: calculateLiveCollectionContentSha256(detailContent, summaryContent),
    publishedAt: validatedAt,
    publishedBy: 'truth-gates-admin',
    ...statusOverrides,
  }))
}

writeAph()
db.prepare(`INSERT INTO payment_centers
  (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
  VALUES('测试片区',?,100,80,70,60,NULL)`).run(regularCenter)
db.prepare(`INSERT INTO daily_snapshots
  (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,
   quality_status,source,source_status,business_date,last_validated_at)
  VALUES(?,?,100,80,70,5,'verified','FineReport三报表中心明细','available',?,?)`)
  .run(businessDate, regularCenter, businessDate, validatedAt)
for (let index = 1; index <= 55; index += 1) {
  const fillerCenter = `第一服务真实性门禁补位${String(index).padStart(2, '0')}服务中心`
  db.prepare(`INSERT INTO payment_centers
    (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
    VALUES('测试片区',?,0,0,0,0,NULL)`).run(fillerCenter)
  db.prepare(`INSERT INTO daily_snapshots
    (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,
     quality_status,source,source_status,business_date,last_validated_at)
    VALUES(?,?,0,0,0,0,'verified','FineReport三报表中心明细','available',?,?)`)
    .run(businessDate, fillerCenter, businessDate, validatedAt)
}
const dailyReconciliationId = Number(db.prepare(`INSERT INTO daily_collection_reconciliations
  (business_date,extracted_at,report_id,region,official_total,detail_total,source_row_count,
   payload_sha256,status,validation_errors,created_by,published_by,published_at,confirm_note)
  VALUES(?,?,'810ca5a0-b239-466b-85c2-386373244c8e','华北地区',5,5,61,?,'published','[]',
    'truth-gates','truth-gates',?,'测试正式日报复核')`)
  .run(businessDate, validatedAt, 'a'.repeat(64), validatedAt).lastInsertRowid)
const reconciliationRevision = db.prepare(`INSERT INTO daily_collection_revision_rows
  (reconciliation_id,center,old_daily_collection,new_daily_collection,old_cumulative_budget,
   old_cumulative_executed,old_last_validated_at,old_field_provenance)
  VALUES(?,?,?,?,?,?,?,'{}')`)
const reconciliationSnapshots = db.prepare(`SELECT center,daily_collection,cumulative_budget,cumulative_executed
  FROM daily_snapshots WHERE date=? ORDER BY center`).all(businessDate) as any[]
for (const snapshot of reconciliationSnapshots) {
  reconciliationRevision.run(dailyReconciliationId, snapshot.center, snapshot.daily_collection, snapshot.daily_collection,
    snapshot.cumulative_budget, snapshot.cumulative_executed, validatedAt)
}
const dailyProvenance = JSON.stringify({ daily_collection: {
  reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
  businessDate,
  extractedAt: validatedAt,
  dailyReconciliationId,
} })
db.prepare('UPDATE daily_snapshots SET field_provenance=? WHERE date=?').run(dailyProvenance, businessDate)

const profileBatch = Number(db.prepare(`INSERT INTO project_profile_import_batches
  (source_file,source_sha256,source_sheet,filter_status,profile_count,phase_count)
  VALUES('assistant-truth-gates.xlsx',?,'项目','在管',2,0)`).run('d'.repeat(64)).lastInsertRowid)
const insertProfile = db.prepare(`INSERT INTO project_profiles
  (batch_id,service_center,area,management_status,property_type,source_rows_json)
  VALUES(?,?,?,'在管','住宅','[]')`)
insertProfile.run(profileBatch, regularCenter, '测试片区')
insertProfile.run(profileBatch, heatingCenter, '测试片区')
const p46Rows = collectionRows()
p46BatchId = Number(db.prepare(`INSERT INTO data_ingestion_batches
  (source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,publishable,row_count,
   mapped_count,unmapped_count,validation_errors,summary,created_by,published_by,published_at)
  VALUES('truth-gates',?,?,?,'[]','/truth-gates','published',1,1,35,0,'[]','{}','qa','qa',?)`)
  .run(businessDate, validatedAt, p46BatchSha256, validatedAt).lastInsertRowid)
const insertP46Row = db.prepare(`INSERT INTO data_ingestion_rows
  (batch_id,entity_type,source_key,canonical_key,mapping_method,change_type,changed_fields,payload)
  VALUES(?,?,?,?, 'exact','snapshot','[]',?)`)
insertP46Row.run(p46BatchId, 'payment_center', regularCenter, regularCenter, JSON.stringify({ center: regularCenter }))
insertP46Row.run(p46BatchId, 'daily_snapshot', `${businessDate}:${regularCenter}`, regularCenter, JSON.stringify({ center: regularCenter }))
for (const row of p46Rows) insertP46Row.run(p46BatchId, 'collection_center', row.center, row.center, JSON.stringify(row))
db.prepare(`INSERT INTO data_ingestion_publications
  (batch_id,business_date,backup_payload,backup_sha256,payment_rows,snapshot_rows,collection_rows,published_by,published_at)
  VALUES(?,?,'{}',?,1,1,35,'truth-gates-admin',?)`)
  .run(p46BatchId, businessDate, 'f'.repeat(64), validatedAt)
writeCollection(p46Rows)

after(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('APH regionCard 四个必填数值任一缺失或非数值都失败关闭', () => {
  const baseline = buildRegionalAssistantContext(adminRequest)
  assert.equal(baseline.aph.ready, true)
  assert.equal(baseline.paymentCenters.ready, true)
  assert.equal(baseline.aph.annualBudget, 120, '管理员地区问答必须使用APH华北卡片，不得被中心合计100覆盖')
  assert.equal(baseline.aph.cumulativeBudget, 80.25, 'AI必须读取与首页相同的精确卡片值，不得使用展示层整数80')
  assert.equal(baseline.aph.cumulativeExecuted, 70.5)
  assert.equal(baseline.aph.samePeriod, 60.75)
  assert.equal(baseline.aph.centerDetail.annualBudget, 100, '中心层仍保留独立明细口径供实体查询')

  for (const field of ['annualBudget', 'cumulativeBudget', 'cumulativeExecuted', 'samePeriod']) {
    for (const invalidValue of [null, '非数值']) {
      writeAph({ [field]: invalidValue })
      const context = buildRegionalAssistantContext(adminRequest)
      assert.equal(context.aph.ready, false, `${field}=${String(invalidValue)} 不得进入可用事实`)
      assert.equal(context.paymentCenters.ready, false, `${field}=${String(invalidValue)} 不得继续读中心明细`)
      assert.deepEqual(context.paymentCenters.rows, [])
    }
  }
  writeAph()
})

test('正式日报冲突只隔离当日回款，不封锁已验证的中心累计字段', () => {
  const conflictingSummary = JSON.stringify({
    totals: {
      before: { cumulative_executed: 60 },
      after: { cumulative_executed: 70, daily_collection: 5 },
    },
  })
  db.prepare('UPDATE data_ingestion_batches SET summary=? WHERE id=?').run(conflictingSummary, p46BatchId)
  db.prepare("UPDATE daily_collection_reconciliations SET status='previewed' WHERE id=?").run(dailyReconciliationId)
  try {
    const scoped = buildRegionalAssistantContext(adminRequest).paymentCenters
    assert.equal(scoped.ready, true)
    assert.match(scoped.dailyCollectionReason || '', /累计执行变动10万元与官方日回款5万元不勾稽/)
    assert.equal(scoped.rows.length, 56)
    const regular = scoped.rows.find(row => row.center === regularCenter)
    assert.ok(regular)
    assert.equal(regular.annualBudget, 100)
    assert.equal(regular.cumulativeBudget, 80)
    assert.equal(regular.cumulativeExecuted, 70)
    assert.equal(regular.samePeriod, 60)
    assert.equal(regular.dailyCollection, null, '冲突中的当日回款不得进入AI事实')
    assert.ok(scoped.rows.every(row => row.dailyCollection === null), '冲突日报中的所有中心日回款都必须隔离')
  } finally {
    db.prepare("UPDATE data_ingestion_batches SET summary='{}' WHERE id=?").run(p46BatchId)
    db.prepare("UPDATE daily_collection_reconciliations SET status='published' WHERE id=?").run(dailyReconciliationId)
  }
})

test('未来验证时间不能被误判为新鲜事实', () => {
  const future = '2099-01-01T00:00:00+08:00'
  const aph = aphPayload()
  aph.lastValidatedAt = future
  fs.writeFileSync(path.join(root, 'APH决策_每日提取.json'), JSON.stringify(aph))
  assert.equal(buildRegionalAssistantContext(adminRequest).aph.ready, false)

  writeAph()
  db.prepare('UPDATE daily_snapshots SET last_validated_at=? WHERE center=?').run(future, regularCenter)
  const context = buildRegionalAssistantContext(adminRequest)
  assert.equal(context.paymentCenters.ready, false)
  assert.deepEqual(context.paymentCenters.rows, [])
  db.prepare('UPDATE daily_snapshots SET last_validated_at=? WHERE center=?').run(validatedAt, regularCenter)
})

test('一条未来日报不能被其他正常日报的时间掩盖', () => {
  const secondCenter = '第一服务真实性未来时间测试服务中心'
  const aph = aphPayload()
  aph.sourceLayers.centerDetail.values = {
    centerCount: 2,
    annualBudget: 150,
    cumulativeBudget: 120,
    cumulativeExecuted: 100,
    samePeriod: 85,
    samePeriodPresentCount: 2,
    samePeriodMissingCount: 0,
  }
  fs.writeFileSync(path.join(root, 'APH决策_每日提取.json'), JSON.stringify(aph))
  try {
    db.prepare(`INSERT INTO payment_centers
      (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
      VALUES('测试片区',?,50,40,30,25,NULL)`).run(secondCenter)
    db.prepare(`INSERT INTO daily_snapshots
      (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,
       quality_status,source,source_status,business_date,last_validated_at)
      VALUES(?,?,50,40,30,2,'verified','FineReport三报表中心明细','available',?,'2099-01-01T00:00:00+08:00')`)
      .run(businessDate, secondCenter, businessDate)
    const context = buildRegionalAssistantContext(adminRequest)
    assert.equal(context.paymentCenters.ready, false)
    assert.deepEqual(context.paymentCenters.rows, [])
  } finally {
    db.prepare('DELETE FROM daily_snapshots WHERE center=?').run(secondCenter)
    db.prepare('DELETE FROM payment_centers WHERE center=?').run(secondCenter)
    writeAph()
  }
})

test('payment_centers 与 daily_snapshots 的 NULL/文本必填金额不得被当成0', () => {
  const mutations = [
    { table: 'payment_centers', column: 'annual_budget', restore: 100 },
    { table: 'payment_centers', column: 'cumulative_budget', restore: 80 },
    { table: 'payment_centers', column: 'cumulative_executed', restore: 70 },
    { table: 'daily_snapshots', column: 'daily_collection', restore: 5 },
    { table: 'daily_snapshots', column: 'annual_budget', restore: 100 },
    { table: 'daily_snapshots', column: 'cumulative_budget', restore: 80 },
    { table: 'daily_snapshots', column: 'cumulative_executed', restore: 70 },
  ] as const

  for (const mutation of mutations) {
    for (const invalidValue of [null, '不是数字']) {
      db.prepare(`UPDATE ${mutation.table} SET ${mutation.column}=? WHERE center=?`).run(invalidValue, regularCenter)
      const context = buildRegionalAssistantContext(adminRequest)
      assert.equal(
        context.paymentCenters.ready,
        false,
        `${mutation.table}.${mutation.column}=${String(invalidValue)} 应失败关闭`,
      )
      assert.deepEqual(context.paymentCenters.rows, [], '不得输出被伪造为0的中心事实')
      db.prepare(`UPDATE ${mutation.table} SET ${mutation.column}=? WHERE center=?`).run(mutation.restore, regularCenter)
    }
  }

  const restored = buildRegionalAssistantContext(adminRequest)
  assert.equal(restored.paymentCenters.ready, true)
  assert.equal(restored.paymentCenters.rows[0].dailyCollection, 5)
  assert.equal(restored.paymentCenters.rows[0].annualBudget, 100)
})

test('admin 收缴事实直接使用 formal publication 四字段，不根据明细反算', () => {
  const collection = buildRegionalAssistantContext(adminRequest).collection
  assert.equal(collection.ready, true)
  assert.equal(collection.rate, 61)
  assert.equal(collection.receivable, 3500)
  assert.equal(collection.received, 2100)
  assert.equal(collection.outstanding, 987.65)
  assert.notEqual(collection.outstanding, collection.receivable! - collection.received!)
  assert.match(collection.amountNote, /正式发布摘要原值/)
})

test('未来发布时刻和超范围正式收缴率都不能进入AI事实', () => {
  const summaryPath = path.join(root, '绿仔收款汇总.json')
  const statusPath = path.join(root, '绿仔同步状态.json')
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
  const future = '2099-01-01T00:00:00+08:00'

  fs.writeFileSync(summaryPath, JSON.stringify({ ...summary, extractedAt: future }))
  fs.writeFileSync(statusPath, JSON.stringify({ ok: true, date: businessDate, finishedAt: future }))
  assert.equal(buildRegionalAssistantContext(adminRequest).collection.ready, false)

  writeCollection(collectionRows())
  const invalidRate = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
  invalidRate.collectionRate = 2
  invalidRate.periodCorrection.correctedRate = 2
  fs.writeFileSync(summaryPath, JSON.stringify(invalidRate))
  assert.equal(buildRegionalAssistantContext(adminRequest).collection.ready, false)
  writeCollection(collectionRows())
})

test('非供暖中心缺官方 collectionRate 失败关闭；可用时 outstanding 保留源字段', () => {
  writeCollection(collectionRows({ regular: { collectionRate: null } }))
  const blocked = buildRegionalAssistantContext(memberRequest(regularCenter)).collection
  assert.equal(blocked.ready, false)
  assert.equal(blocked.rate, null)
  assert.equal(blocked.outstanding, null)

  writeCollection(collectionRows({ regular: { collectionRate: 1.2 } }))
  assert.equal(buildRegionalAssistantContext(memberRequest(regularCenter)).collection.ready, false)

  writeCollection(collectionRows({ regular: { collectionRate: 0.37, outstanding: -1 } }))
  assert.equal(buildRegionalAssistantContext(memberRequest(regularCenter)).collection.ready, false)

  writeCollection(collectionRows({ regular: { collectionRate: 0.37, outstanding: 73 } }))
  const available = buildRegionalAssistantContext(memberRequest(regularCenter)).collection
  assert.equal(available.ready, true)
  assert.equal(available.rate, 37, '非供暖中心必须用官方项目率，不得实收除以应收')
  assert.equal(available.receivable, 100)
  assert.equal(available.received, 40)
  assert.equal(available.outstanding, 73, '未收金额必须保留明细源字段，不得反算成60')
})

test('同步成功但仍为 staged 的现场数据不得成为正式发布数据', () => {
  writeCollection(collectionRows(), { state: 'staged' })
  const blocked = buildRegionalAssistantContext(adminRequest).collection
  assert.equal(blocked.ready, false)
  assert.equal(blocked.rate, null)
  writeCollection(collectionRows())
})

test('正式回执生成后明细文件被篡改时必须失败关闭', () => {
  writeCollection(collectionRows())
  const detailPath = path.join(root, '绿仔收缴明细.json')
  const detail = JSON.parse(fs.readFileSync(detailPath, 'utf8'))
  detail.rows[0].received += 1
  fs.writeFileSync(detailPath, JSON.stringify(detail))

  const blocked = buildRegionalAssistantContext(adminRequest).collection
  assert.equal(blocked.ready, false)
  assert.equal(blocked.rate, null)
  writeCollection(collectionRows())
})

test('供暖中心保留期间更正率例外，但 outstanding 仍使用源字段', () => {
  writeCollection(collectionRows({ heating: { collectionRate: null, outstanding: 77 } }))
  const collection = buildRegionalAssistantContext(memberRequest(heatingCenter)).collection
  assert.equal(collection.ready, true)
  assert.equal(collection.rate, 40, '供暖中心应按期间更正口径计算收缴率')
  assert.equal(collection.receivable, 100)
  assert.equal(collection.received, 40)
  assert.equal(collection.outstanding, 77, '供暖例外不得扩展到未收金额反算')
})
