import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import express from 'express'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-r66-full-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'r66-full-function-shadow-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'

const [
  { default: db },
  { default: projectsRouter },
  { default: trendsRouter },
  { default: governanceRouter },
  { default: exportRouter },
  { default: aiRouter },
  { default: projectProfilesRouter },
  { requireAuth, signToken },
  { getFormalCollectionDataset },
  centerAccess,
] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/projects.js'),
  import('../src/routes/trends.js'),
  import('../src/routes/governance.js'),
  import('../src/routes/export.js'),
  import('../src/routes/ai.js'),
  import('../src/routes/project-profiles.js'),
  import('../src/auth.js'),
  import('../src/collection-dataset.js'),
  import('../src/service-center-access.js'),
])

const AREA = '朝阳片区'
const CENTER_A = '第一服务R66同片区甲服务中心'
const CENTER_B = '第一服务R66同片区乙服务中心'
const B_SENTINEL = 987654
const shanghaiDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date)
const shiftDate = (value: string, days: number) => {
  const date = new Date(`${value}T12:00:00+08:00`)
  date.setUTCDate(date.getUTCDate() + days)
  return shanghaiDate(date)
}
const REPORT_DATE = shanghaiDate()
const FACT_EXTRACTED_AT = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
const FACT_PUBLISHED_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString()

const profileBatch = Number(db.prepare(`INSERT INTO project_profile_import_batches
  (source_file,source_sha256,source_sheet,filter_status,profile_count,phase_count)
  VALUES('r66-authoritative-projects.xlsx',?,'项目','在管',2,0)`).run('a'.repeat(64)).lastInsertRowid)
const insertProfile = db.prepare(`INSERT INTO project_profiles
  (batch_id,service_center,area,management_status,property_type,managed_area,movedin_units,source_rows_json)
  VALUES(?,?,?,'在管','住宅',?,?,?)`)
const profileA = Number(insertProfile.run(profileBatch, CENTER_A, AREA, 1000, 100, '[1]').lastInsertRowid)
const profileB = Number(insertProfile.run(profileBatch, CENTER_B, AREA, 2000, 200, '[2]').lastInsertRowid)
const insertLink = db.prepare(`INSERT INTO project_profile_center_links
  (batch_id,profile_id,source_system,source_center,link_method) VALUES(?,?,'collection',?,'exact')`)
insertLink.run(profileBatch, profileA, CENTER_A)
insertLink.run(profileBatch, profileB, CENTER_B)

const factBatch = Number(db.prepare(`INSERT INTO data_ingestion_batches
  (source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,
   publishable,row_count,mapped_count,unmapped_count,validation_errors,summary,published_by,published_at)
  VALUES('r66-controlled',?,?,?,'[]',?,'published',1,37,37,0,'[]','{}','r66-qa',?)`)
  .run(REPORT_DATE, FACT_EXTRACTED_AT, 'b'.repeat(64), root, FACT_PUBLISHED_AT).lastInsertRowid)
const insertFact = db.prepare(`INSERT INTO data_ingestion_rows
  (batch_id,entity_type,source_key,canonical_key,mapping_method,change_type,changed_fields,payload)
  VALUES(?,?,?,?, 'exact','snapshot','[]',?)`)
const collectionAreas = ['朝阳片区', '京东片区', '海淀片区', '顺平片区', '河北片区', '辽宁片区']
const collectionRows = [
  { center: CENTER_A, area: AREA, receivable: 100, received: 88, collectionRate: 0.88 },
  { center: CENTER_B, area: AREA, receivable: B_SENTINEL, received: 500000, collectionRate: 0.8 },
  ...Array.from({ length: 33 }, (_, index) => ({
    center: `第一服务R66官方${String(index + 1).padStart(2, '0')}服务中心`,
    area: collectionAreas[index % collectionAreas.length],
    receivable: 1000 + index,
    received: 800 + index,
    collectionRate: 0.8,
  })),
]
for (const row of collectionRows) {
  insertFact.run(factBatch, 'collection_center', row.center, row.center, JSON.stringify(row))
}
db.prepare('UPDATE data_ingestion_batches SET summary=? WHERE id=?').run(JSON.stringify({
  totals: { after: { collection_rate: 0.8, collection_receivable: 100, collection_received: 88 } },
}), factBatch)
for (const [index, row] of [
  { center: CENTER_A, area: AREA, annual_budget: 100, cumulative_budget: 80, cumulative_executed: 70, same_period: 60 },
  { center: CENTER_B, area: AREA, annual_budget: 200, cumulative_budget: 160, cumulative_executed: 140, same_period: 120 },
].entries()) {
  insertFact.run(factBatch, 'payment_center', `payment-${index + 1}`, row.center, JSON.stringify(row))
}
db.prepare(`INSERT INTO data_ingestion_publications
  (batch_id,business_date,backup_payload,backup_sha256,payment_rows,snapshot_rows,collection_rows,published_by,published_at)
  VALUES(?,?,?, ?,2,0,35,'r66-qa',?)`)
  .run(factBatch, REPORT_DATE, '{}', 'c'.repeat(64), FACT_PUBLISHED_AT)

const insertUser = db.prepare(`INSERT INTO users
  (username,password_hash,role,area_scope,project_scope,service_center_scope)
  VALUES(?,'r66-not-used','viewer','','',?)`)
const memberA = Number(insertUser.run('r66-member-a', CENTER_A).lastInsertRowid)
const memberB = Number(insertUser.run('r66-member-b', CENTER_B).lastInsertRowid)
const unassigned = Number(insertUser.run('r66-member-unassigned', '').lastInsertRowid)
const admin = db.prepare("SELECT id,username FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any
const tokens = {
  admin: signToken({ userId: admin.id, username: admin.username, role: 'admin' }),
  a: signToken({ userId: memberA, username: 'r66-member-a', role: 'viewer', serviceCenterScope: CENTER_A }),
  b: signToken({ userId: memberB, username: 'r66-member-b', role: 'viewer', serviceCenterScope: CENTER_B }),
  unassigned: signToken({ userId: unassigned, username: 'r66-member-unassigned', role: 'viewer', serviceCenterScope: '' }),
}

const app = express()
app.use(express.json())
app.use(requireAuth)
app.use(projectsRouter)
app.use(trendsRouter)
app.use(governanceRouter)
app.use(exportRouter)
app.use(aiRouter)
app.use(projectProfilesRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  if (server.listening) return resolve()
  server.once('listening', resolve)
  server.once('error', reject)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('R66影子端口未绑定')
const baseUrl = `http://127.0.0.1:${address.port}`

async function request(token: string, pathname: string, method = 'GET', body?: any) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let payload: any = text
  try { payload = JSON.parse(text) } catch {}
  return { response, payload, text }
}

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('R66 三个正式动作经真实HTTP持久化、回读、审计并保持幂等', async () => {
  for (const pathname of [
    '/api/projects/directory/publish',
    '/api/trends/rebuild',
    '/api/governance/report-archives/generate',
  ]) {
    const missing = await request(tokens.admin, pathname, 'POST', {})
    assert.equal(missing.response.status, 400, `${pathname}缺确认应失败：${missing.text}`)
  }

  const published = await request(tokens.admin, '/api/projects/directory/publish', 'POST', { confirmation: '确认发布项目目录' })
  assert.equal(published.response.status, 200, published.text)
  assert.equal(published.payload.status.state, 'directory_ready')
  assert.equal(published.payload.inserted, 2)
  const projectRead = await request(tokens.admin, '/api/projects')
  assert.equal(projectRead.response.status, 200, projectRead.text)
  assert.equal(projectRead.payload.rows.length, 2)
  const projectA = projectRead.payload.rows.find((row: any) => row.name === CENTER_A)
  const projectB = projectRead.payload.rows.find((row: any) => row.name === CENTER_B)
  assert.ok(projectA && projectB)
  assert.equal(projectA.validation_status, 'directory_only')
  assert.equal(projectA.receivable, 100)
  assert.equal(projectA.received, 88)
  assert.equal(projectA.official_collection_rate, 0.88)
  for (const field of ['annual_income', 'annual_cost', 'ytd_income', 'ytd_cost', 'quality_score', 'customer_satisfaction']) {
    assert.equal(projectA[field], null, `${field}不得补零`)
  }

  const rebuilt = await request(tokens.admin, '/api/trends/rebuild', 'POST', { confirmation: '确认重建月度趋势' })
  assert.equal(rebuilt.response.status, 200, rebuilt.text)
  assert.equal(rebuilt.payload.rows.length, 1)
  assert.equal(rebuilt.payload.status.state, 'ready')
  for (const area of ['华北汇总', '朝阳片区', '京东片区', '海淀片区', '顺平片区', '河北片区', '辽宁片区']) {
    const value = rebuilt.payload.rows[0][area]
    assert.ok(value === null || (Number.isFinite(value) && value >= 0 && value <= 1), `${area}必须返回0-1正式比例或null`)
  }
  const trends = await request(tokens.admin, '/api/trends')
  assert.equal(trends.response.status, 200, trends.text)
  assert.deepEqual(trends.payload.rows, rebuilt.payload.rows)

  const generated = await request(tokens.admin, '/api/governance/report-archives/generate', 'POST', {
    confirmation: '确认生成正式归档', area: '华北', version: 'operation', reportDate: REPORT_DATE,
  })
  assert.equal(generated.response.status, 201, generated.text)
  assert.equal(generated.payload.payload.summary.ytd_income, null)
  assert.equal(generated.payload.payload.summary.profitRate, null)
  assert.equal(generated.payload.payload.completeness.state, 'partial_verified')
  const generatedAgain = await request(tokens.admin, '/api/governance/report-archives/generate', 'POST', {
    confirmation: '确认生成正式归档', area: '华北', version: 'operation', reportDate: REPORT_DATE,
  })
  assert.equal(generatedAgain.response.status, 200, generatedAgain.text)
  assert.equal(generatedAgain.payload.idempotent, true)
  assert.equal(generatedAgain.payload.id, generated.payload.id)
  const archives = await request(tokens.admin, '/api/governance/report-archives')
  assert.equal(archives.response.status, 200, archives.text)
  assert.equal(archives.payload.rows.length, 1)
  assert.equal(archives.payload.status.state, 'ready')
  const detail = await request(tokens.admin, `/api/governance/report-archives/${generated.payload.id}`)
  assert.equal(detail.response.status, 200, detail.text)
  assert.equal(detail.payload.immutable, true)

  const profiles = await request(tokens.admin, '/api/project-profiles')
  assert.equal(profiles.response.status, 200, profiles.text)
  const profile = profiles.payload.rows.find((row: any) => row.service_center === CENTER_A)
  assert.equal('operating' in profile, false, '项目目录不得挂接服务中心经营金额')
  assert.equal(profile.sourceEvidence.granularity, 'service_center_link_only')
  assert.equal('payment' in profile.sourceEvidence, false)
  assert.equal('collection' in profile.sourceEvidence, false)
  const profileSummary = await request(tokens.admin, '/api/project-profiles/summary')
  assert.equal(profileSummary.response.status, 200, profileSummary.text)
  assert.equal(profileSummary.payload.summary.granularity, 'project_directory')
  for (const field of ['annual_budget', 'cumulative_budget', 'cumulative_executed', 'collection_receivable', 'collection_received', 'collection_outstanding', 'collection_rate']) {
    assert.equal(field in profileSummary.payload.totals, false, `${field}不得进入项目目录汇总`)
  }

  const actions = (db.prepare(`SELECT action FROM operation_logs WHERE username=? ORDER BY id`).all(admin.username) as any[]).map(row => row.action)
  assert.ok(actions.some(action => /发布权威项目目录/.test(action)), actions)
  assert.ok(actions.some(action => /重建官方月度趋势/.test(action)), actions)
  assert.ok(actions.some(action => /生成可追溯经营归档/.test(action)), actions)
})

test('directory_only 详情不产生经营结论，AI与项目CSV均409', async () => {
  const projects = await request(tokens.admin, '/api/projects')
  const row = projects.payload.rows.find((item: any) => item.name === CENTER_A)
  const detail = await request(tokens.admin, `/api/projects/${row.id}`)
  assert.equal(detail.response.status, 200, detail.text)
  assert.equal(detail.payload.collectionRate, 88)
  assert.equal(detail.payload.profitRate, null)
  assert.equal(detail.payload.riskProfile.dataAvailable, false)
  assert.equal(detail.payload.riskProfile.status, 'insufficient')
  assert.equal(detail.payload.riskProfile.healthScore, null)
  assert.deepEqual(detail.payload.riskProfile.dimensions, [])
  assert.equal(detail.payload.benchmarks, null)

  for (const [pathname, method, body] of [
    ['/api/ai/health', 'GET', undefined],
    [`/api/ai/project/${row.id}/diagnosis`, 'GET', undefined],
    ['/api/ai/ask', 'POST', { question: '经营怎么样' }],
    ['/api/ai/interpret', 'POST', { type: 'project', data: { id: row.id } }],
  ] as const) {
    const blocked = await request(tokens.admin, pathname, method, body)
    assert.equal(blocked.response.status, 409, `${pathname}应失败关闭：${blocked.text}`)
    assert.equal(blocked.payload.code, 'PROJECT_DATA_QUALITY_BLOCKED')
    assert.equal(blocked.payload.state, 'directory_only')
    assert.equal(blocked.payload.dataAvailable, false)
  }

  const csv = await request(tokens.admin, '/api/export/projects-csv')
  assert.equal(csv.response.status, 409, csv.text)
  assert.equal(csv.payload.code, 'PROJECT_DATA_QUALITY_BLOCKED')
  assert.match(csv.response.headers.get('content-type') || '', /^application\/json\b/i)
  assert.equal(csv.response.headers.has('content-disposition'), false)
  assert.equal(csv.text.includes(CENTER_A), false)
})

test('同片区双中心及未分配成员在目录、详情和CSV门禁上失败关闭', async () => {
  const reads = await Promise.all([
    request(tokens.a, '/api/projects'),
    request(tokens.b, '/api/projects'),
    request(tokens.unassigned, '/api/projects'),
  ])
  assert.deepEqual(reads[0].payload.rows.map((row: any) => row.name), [CENTER_A])
  assert.deepEqual(reads[1].payload.rows.map((row: any) => row.name), [CENTER_B])
  assert.equal(reads[2].response.status, 401)
  assert.equal(reads[2].payload.error, '登录已过期，请重新登录')
  assert.equal(reads[0].text.includes(CENTER_B), false)
  assert.equal(reads[0].text.includes(String(B_SENTINEL)), false)

  const projectB = reads[1].payload.rows[0]
  const cross = await request(tokens.a, `/api/projects/${projectB.id}`)
  assert.equal(cross.response.status, 404, cross.text)
  assert.equal(cross.text.includes(CENTER_B), false)

  const csvA = await request(tokens.a, '/api/export/projects-csv')
  assert.equal(csvA.response.status, 409, csvA.text)
  assert.equal(csvA.payload.code, 'PROJECT_DATA_QUALITY_BLOCKED')
  assert.equal(csvA.text.includes(CENTER_B), false)
  assert.equal(csvA.text.includes(String(B_SENTINEL)), false)
  const csvUnassigned = await request(tokens.unassigned, '/api/export/projects-csv')
  assert.equal(csvUnassigned.response.status, 401, csvUnassigned.text)
  assert.equal(csvUnassigned.payload.error, '登录已过期，请重新登录')
  assert.equal(csvUnassigned.text.includes(CENTER_A), false)
  assert.equal(csvUnassigned.text.includes(CENTER_B), false)

  const before = Number((db.prepare('SELECT COUNT(*) count FROM report_archives').get() as any).count)
  for (const [pathname, body] of [
    ['/api/projects/directory/publish', { confirmation: '确认发布项目目录' }],
    ['/api/trends/rebuild', { confirmation: '确认重建月度趋势' }],
    ['/api/governance/report-archives/generate', { confirmation: '确认生成正式归档', area: '华北', version: 'operation' }],
  ] as const) {
    const denied = await request(tokens.a, pathname, 'POST', body)
    assert.equal(denied.response.status, 403, `${pathname}普通成员应被拒绝：${denied.text}`)
  }
  assert.equal(Number((db.prepare('SELECT COUNT(*) count FROM report_archives').get() as any).count), before)
})

test('伪published高ID批次和回执行数不一致均不能覆盖正式收缴、AI映射或权限别名', async () => {
  const fakeAlias = '第一服务R66伪发布越权别名服务中心'
  const insertFakeBatch = (sha: string, businessDate: string) => Number(db.prepare(`INSERT INTO data_ingestion_batches
    (source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,
     publishable,row_count,mapped_count,unmapped_count,validation_errors,summary,published_by,published_at)
    VALUES('r66-fake',?,?,?,'[]',?,'published',1,37,37,0,'[]',?,'fake',?)`)
    .run(businessDate, `${businessDate}T08:00:00+08:00`, sha, root,
      JSON.stringify({ totals: { after: { collection_rate: 0.99, collection_receivable: 999999, collection_received: 999998 } } }),
      `${businessDate}T09:00:00+08:00`).lastInsertRowid)
  const seedFakeRows = (batchId: number, rate: number) => {
    for (const [index, row] of [
      { source: CENTER_A, canonical: CENTER_B, center: CENTER_A },
      { source: fakeAlias, canonical: CENTER_A, center: fakeAlias },
      ...Array.from({ length: 33 }, (_, offset) => ({
        source: `R66伪发布${offset + 1}`, canonical: `R66伪发布${offset + 1}`, center: `R66伪发布${offset + 1}`,
      })),
    ].entries()) {
      insertFact.run(batchId, 'collection_center', row.source, row.canonical, JSON.stringify({
        center: row.center, area: AREA, receivable: 100 + index, received: 99, collectionRate: rate,
      }))
    }
    for (const [index, center] of [CENTER_A, CENTER_B].entries()) {
      insertFact.run(batchId, 'payment_center', `fake-payment-${batchId}-${index}`, center, JSON.stringify({
        center, area: AREA, annual_budget: 1, cumulative_budget: 1, cumulative_executed: 1, same_period: 1,
      }))
    }
  }

  const noReceiptDate = shiftDate(REPORT_DATE, 1)
  const badReceiptDate = shiftDate(REPORT_DATE, 2)
  const olderFormalDate = shiftDate(REPORT_DATE, -1)
  const noReceipt = insertFakeBatch('d'.repeat(64), noReceiptDate)
  seedFakeRows(noReceipt, 0.99)
  const badReceipt = insertFakeBatch('e'.repeat(64), badReceiptDate)
  seedFakeRows(badReceipt, 0.77)
  db.prepare(`INSERT INTO data_ingestion_publications
    (batch_id,business_date,backup_payload,backup_sha256,payment_rows,snapshot_rows,collection_rows,published_by,published_at)
    VALUES(?,?,?, ?,2,0,34,'fake',?)`)
    .run(badReceipt, badReceiptDate, '{}', 'f'.repeat(64), `${badReceiptDate}T09:00:00+08:00`)

  // 高 id 但业务日期更旧的批次即便有完整正式回执，也不能覆盖更新的业务事实。
  const olderFormal = insertFakeBatch('1'.repeat(64), olderFormalDate)
  seedFakeRows(olderFormal, 0.66)
  db.prepare(`INSERT INTO data_ingestion_publications
    (batch_id,business_date,backup_payload,backup_sha256,payment_rows,snapshot_rows,collection_rows,published_by,published_at)
    VALUES(?,?,?, ?,2,0,35,'r66-qa',?)`)
    .run(olderFormal, olderFormalDate, '{}', '2'.repeat(64), `${olderFormalDate}T09:00:00+08:00`)

  const formal = getFormalCollectionDataset()
  assert.equal(formal.publication.publicationStatus, 'published')
  assert.equal(formal.publication.businessDate, REPORT_DATE)
  assert.equal(formal.dataset?.rows.find((row: any) => row.center === CENTER_A)?.collectionRate, 0.88)
  assert.equal(formal.dataset?.rows.some((row: any) => row.center === fakeAlias), false)
  assert.equal(centerAccess.resolveServiceCenterSelection(fakeAlias), null)

  const insertPayment = db.prepare(`INSERT INTO payment_centers
    (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
    VALUES(?,?,100,80,70,60,NULL)`)
  insertPayment.run(AREA, CENTER_A)
  insertPayment.run(AREA, CENTER_B)
  const ai = await request(tokens.admin, '/api/ai/service-centers')
  assert.equal(ai.response.status, 200, ai.text)
  const centerA = ai.payload.rows.find((row: any) => row.center === CENTER_A)
  assert.equal(centerA.metrics.officialCollectionRate, 0.88)
  assert.equal(ai.text.includes(fakeAlias), false)

  const archiveCount = Number((db.prepare('SELECT COUNT(*) count FROM report_archives').get() as any).count)
  const staleMonth = await request(tokens.admin, '/api/governance/report-archives/generate', 'POST', {
    confirmation: '确认生成正式归档', area: '华北', version: 'operation', reportDate: '2026-09-01',
  })
  assert.equal(staleMonth.response.status, 409, staleMonth.text)
  assert.match(staleMonth.text, /同月正式回款和官方收缴事实/)
  assert.equal(Number((db.prepare('SELECT COUNT(*) count FROM report_archives').get() as any).count), archiveCount)
})

test('归档比较保留未知值、按业务日期选前序且快照增量方向正确', async () => {
  const insertSnapshot = db.prepare(`INSERT INTO project_monthly_snapshots
    (month,project_name,area,ytd_income,ytd_cost,receivable,received,quality_score,
     safety_incidents,complaint_count,source,quality_status,source_status,business_date)
    VALUES(?,?,?,?,?,?,?,?,?,?,'r66-verified-fixture','verified','verified',?)`)
  insertSnapshot.run('2026-07', 'R66快照方向项目', AREA, null, null, 100, 50, null, 0, 5, '2026-07-31')
  insertSnapshot.run('2026-08', 'R66快照方向项目', AREA, null, null, 100, 80, null, 0, 3, '2026-08-31')
  insertSnapshot.run('2026-07', 'R66快照未知项目', AREA, null, null, null, null, null, null, null, '2026-07-31')
  insertSnapshot.run('2026-08', 'R66快照未知项目', AREA, null, null, null, null, null, null, null, '2026-08-31')

  const insertArchive = db.prepare(`INSERT INTO report_archives
    (report_date,area,version,title,summary,payload,archive_version,snapshot_month,traceability,created_by)
    VALUES(?,?, 'leader',?,?,?,1,?,'{}','r66-qa')`)
  const archivePayload = (collectionRate: number) => JSON.stringify({
    summary: {
      collectionRate,
      ytd_income: null,
      profitRate: null,
      avg_quality: null,
      total_complaints: null,
    },
    sections: [],
  })
  const june = Number(insertArchive.run('2026-06-30', '华北', 'R66六月归档', '{}', archivePayload(60), '2026-06').lastInsertRowid)
  assert.ok(june > 0)
  const future = Number(insertArchive.run('2026-10-31', '华北', 'R66未来归档', '{}', archivePayload(90), '2026-10').lastInsertRowid)
  const backfilled = Number(insertArchive.run('2026-07-31', '华北', 'R66七月回填归档', '{}', archivePayload(70), '2026-07').lastInsertRowid)
  assert.ok(future < backfilled, 'fixture必须让未来归档id小于后回填归档，覆盖旧id排序缺陷')

  const detail = await request(tokens.admin, `/api/governance/report-archives/${backfilled}`)
  assert.equal(detail.response.status, 200, detail.text)
  assert.equal(detail.payload.comparison.previous.report_date, '2026-06-30')
  const collectionMetric = detail.payload.comparison.metricChanges.find((metric: any) => metric.key === 'collectionRate')
  assert.equal(collectionMetric.current, 70)
  assert.equal(collectionMetric.previous, 60)
  assert.equal(collectionMetric.delta, 10)
  const unknownMetric = detail.payload.comparison.metricChanges.find((metric: any) => metric.key === 'ytd_income')
  assert.equal(unknownMetric.current, null)
  assert.equal(unknownMetric.previous, null)
  assert.equal(unknownMetric.delta, null)
  assert.equal(detail.payload.comparison.judgement.improved.some((metric: any) => metric.key === 'ytd_income'), false)
  assert.equal(detail.payload.comparison.judgement.worsened.some((metric: any) => metric.key === 'ytd_income'), false)

  const knownSnapshot = detail.payload.snapshotComparison.rows.find((row: any) => row.project_name === 'R66快照方向项目')
  assert.equal(knownSnapshot.currentMonth, '2026-08')
  assert.equal(knownSnapshot.previousMonth, '2026-07')
  assert.equal(knownSnapshot.curRate, 80)
  assert.equal(knownSnapshot.prevRate, 50)
  assert.equal(knownSnapshot.rateDelta, 30)
  assert.equal(knownSnapshot.incomeDelta, null)
  assert.equal(knownSnapshot.qualityDelta, null)
  assert.deepEqual(knownSnapshot.riskFlags, ['收费率低'])
  assert.equal(knownSnapshot.status, '改善')

  const unknownSnapshot = detail.payload.snapshotComparison.rows.find((row: any) => row.project_name === 'R66快照未知项目')
  assert.equal(unknownSnapshot.curRate, null)
  assert.equal(unknownSnapshot.prevRate, null)
  for (const key of ['incomeDelta', 'costDelta', 'rateDelta', 'qualityDelta', 'complaintDelta', 'incidentDelta']) {
    assert.equal(unknownSnapshot[key], null, `${key}未知时必须保持null`)
  }
  assert.deepEqual(unknownSnapshot.riskFlags, [])
  assert.equal(unknownSnapshot.status, '数据不足')
})

test('目录发布按稳定profile身份支持重命名，并拒绝归一后重名', async () => {
  const before = db.prepare("SELECT id,project_code FROM projects WHERE source_project_id=? AND source_system='project_profiles'").get(String(profileA)) as any
  assert.ok(before)
  const renamed = `${CENTER_A}（更名）`
  db.prepare('UPDATE project_profiles SET service_center=? WHERE id=?').run(renamed, profileA)
  const republished = await request(tokens.admin, '/api/projects/directory/publish', 'POST', { confirmation: '确认发布项目目录' })
  assert.equal(republished.response.status, 200, republished.text)
  const after = db.prepare("SELECT id,name,project_code,active_status FROM projects WHERE source_project_id=? AND source_system='project_profiles'").get(String(profileA)) as any
  assert.equal(after.id, before.id)
  assert.equal(after.project_code, before.project_code)
  assert.equal(after.name, renamed.normalize('NFKC'))
  assert.equal(after.active_status, 'active')
  assert.equal((db.prepare("SELECT COUNT(*) count FROM projects WHERE source_project_id=? AND source_system='project_profiles'").get(String(profileA)) as any).count, 1)

  db.prepare('UPDATE project_profiles SET service_center=? WHERE id=?').run(renamed.replace('（更名）', ' （更名）'), profileB)
  const duplicate = await request(tokens.admin, '/api/projects/directory/publish', 'POST', { confirmation: '确认发布项目目录' })
  assert.equal(duplicate.response.status, 409, duplicate.text)
  assert.match(duplicate.text, /归一.*重复/)
})

test('verified缺少经营数值时门禁和详情失败关闭，不补0或健康结论', async () => {
  const inserted = db.prepare(`INSERT INTO projects
    (area,name,annual_income,annual_cost,ytd_income,ytd_cost,receivable,received,quality_score,
     safety_incidents,customer_satisfaction,complaint_count,project_code,active_status,
     validation_status,source_batch)
    VALUES(?,?,100,80,NULL,50,100,80,90,0,90,1,?,'active','verified','verified-null-fixture')`)
    .run(AREA, 'R66 verified缺字段项目', 'R66-VERIFIED-NULL')
  const projectId = Number(inserted.lastInsertRowid)
  const gate = await request(tokens.admin, '/api/data-quality/project-gate')
  assert.equal(gate.response.status, 200, gate.text)
  assert.equal(gate.payload.ready, false)
  assert.ok(Number(gate.payload.incompleteVerifiedProjectCount) >= 1)
  const detail = await request(tokens.admin, `/api/projects/${projectId}`)
  assert.equal(detail.response.status, 200, detail.text)
  assert.equal(detail.payload.profitRate, null)
  assert.equal(detail.payload.riskProfile.healthScore, null)
  assert.equal(detail.payload.riskProfile.status, 'insufficient')
  assert.equal(detail.payload.project.dataAvailability.state, 'operating_incomplete')
  assert.ok(detail.payload.project.dataAvailability.missingFields.includes('ytd_income'))
  db.prepare("UPDATE projects SET active_status='inactive' WHERE id=?").run(projectId)
})

test('项目CSV严格审计失败时不返回CSV正文', async () => {
  db.prepare(`UPDATE projects SET validation_status='verified',active_status='active',
    source_batch=COALESCE(NULLIF(source_batch,''),'r66-audit-fixture'),
    annual_income=COALESCE(annual_income,100),annual_cost=COALESCE(annual_cost,80),
    ytd_income=COALESCE(ytd_income,70),ytd_cost=COALESCE(ytd_cost,50),
    receivable=COALESCE(receivable,100),received=COALESCE(received,80),
    quality_score=COALESCE(quality_score,90),safety_incidents=COALESCE(safety_incidents,0),
    customer_satisfaction=COALESCE(customer_satisfaction,90),complaint_count=COALESCE(complaint_count,1)`)
    .run()
  db.exec('DROP TABLE operation_logs')
  const exported = await request(tokens.admin, '/api/export/projects-csv')
  assert.equal(exported.response.status, 503, exported.text)
  assert.equal(exported.payload.code, 'AUDIT_WRITE_FAILED')
  assert.equal(exported.response.headers.get('content-type')?.includes('text/csv') || false, false)
  assert.equal(exported.text.includes('片区,项目名称'), false)
})

test('项目档案无论正式回执状态如何都只返回目录与链接证据', async () => {
  db.prepare('UPDATE data_ingestion_publications SET collection_rows=34').run()
  db.prepare('UPDATE payment_centers SET same_period=NULL WHERE center=?').run(CENTER_A)
  const profiles = await request(tokens.admin, '/api/project-profiles')
  assert.equal(profiles.response.status, 200, profiles.text)
  const row = profiles.payload.rows.find((item: any) => item.id === profileA)
  assert.equal('operating' in row, false)
  assert.equal(row.sourceEvidence.granularity, 'service_center_link_only')
  assert.deepEqual(row.sourceEvidence.collectionCenters, [CENTER_A])
})
