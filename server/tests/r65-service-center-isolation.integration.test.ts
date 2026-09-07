import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import bcrypt from 'bcryptjs'
import Database from 'better-sqlite3'
import { calculateLiveCollectionContentSha256 } from '../src/collection-quality.js'
import { readLiveCollectionPublication } from '../src/live-collection-publication.js'
import { unresolvedPublishedDailyConflict } from '../src/daily-reconciliation-gate.js'

const CENTER_A = '第一服务QA同片区甲服务中心'
const CENTER_B = '第一服务QA同片区乙服务中心'
const SAME_AREA = 'QA同片区'
const MEMBER_PASSWORD = 'Member-QA-2026!'
const ADMIN_PASSWORD = 'Admin-QA-2026!'
const B_SENTINEL = 222222
const OUT_OF_SCOPE_CENTER_NAMES = [
  '葫芦岛龙港区公共行政服务中心',
  '葫芦岛龙港区政府行政管理服务中心',
  '天津中信珺台服务中心',
  '葫芦岛首创·象墅服务中心',
  ...Array.from({ length: 33 }, (_, index) => `第一服务QA其他${String(index + 1).padStart(2, '0')}服务中心`),
]

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('未取得隔离测试端口')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

async function waitFor(url: string, child: ReturnType<typeof spawn>, logs: () => string) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`影子服务提前退出：${child.exitCode}\n${logs()}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await wait(100)
  }
  throw new Error(`影子服务启动超时：${url}\n${logs()}`)
}

async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    wait(2_000),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function startHermesStub() {
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      requests.push(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        model: 'qa-center-scope-stub',
        choices: [{ message: { content: 'AI判断：当前存在回款预算缺口，收缴节奏是首要关注点。' } }],
      }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('未取得Hermes隔离测试端口')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

function seedDatabase(db: Database.Database, root: string) {
  const columns = new Set((db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map(row => row.name))
  assert.equal(columns.has('service_center_scope'), true, 'users表必须有服务中心范围列')

  const passwordHash = bcrypt.hashSync(MEMBER_PASSWORD, 4)
  const insertUser = db.prepare(`INSERT INTO users
    (username,password_hash,role,area_scope,project_scope,service_center_scope)
    VALUES(?,?,'viewer','','',?)`)
  const memberA = Number(insertUser.run('qa-member-a', passwordHash, CENTER_A).lastInsertRowid)
  const memberB = Number(insertUser.run('qa-member-b', passwordHash, CENTER_B).lastInsertRowid)
  const unassigned = Number(insertUser.run('qa-member-unassigned', passwordHash, '').lastInsertRowid)
  const legacyMember = Number(db.prepare(`INSERT INTO users
    (username,password_hash,role,area_scope,project_scope,service_center_scope)
    VALUES(?,?,'hq_function','华北','',?)`).run('qa-legacy-member-a', passwordHash, '华北地区公司本部职能').lastInsertRowid)

  const profileBatch = Number(db.prepare(`INSERT INTO project_profile_import_batches
    (source_file,source_sha256,source_sheet,filter_status,profile_count,phase_count)
    VALUES('qa-authoritative.xlsx',?,'项目','在管',2,0)`).run('a'.repeat(64)).lastInsertRowid)
  const insertProfile = db.prepare(`INSERT INTO project_profiles
    (batch_id,service_center,area,management_status,property_type,source_rows_json)
    VALUES(?,?,?,'在管','住宅','[]')`)
  const profileA = Number(insertProfile.run(profileBatch, CENTER_A, SAME_AREA).lastInsertRowid)
  const profileB = Number(insertProfile.run(profileBatch, CENTER_B, SAME_AREA).lastInsertRowid)

  const insertLink = db.prepare(`INSERT INTO project_profile_center_links
    (batch_id,profile_id,source_system,source_center,link_method)
    VALUES(?,?,?,?, 'exact')`)
  for (const [profileId, center] of [[profileA, CENTER_A], [profileB, CENTER_B]] as const) {
    insertLink.run(profileBatch, profileId, 'payment', center)
    insertLink.run(profileBatch, profileId, 'collection', center)
  }

  const insertProject = db.prepare(`INSERT INTO projects
    (area,name,annual_income,annual_cost,ytd_income,ytd_cost,receivable,received,
     quality_score,safety_incidents,customer_satisfaction,complaint_count,
     project_code,active_status,validation_status,source_batch)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'active','verified','qa-r65')`)
  const projectA = Number(insertProject.run(
    SAME_AREA, CENTER_A, 1111, 500, 700, 300, 1000, 800, 91, 0, 90, 1, 'QA-A',
  ).lastInsertRowid)
  const projectB = Number(insertProject.run(
    SAME_AREA, CENTER_B, B_SENTINEL, 900, 1200, 800, 2000, 1200, 72, 2, 70, 22, 'QA-B',
  ).lastInsertRowid)

  const insertSnapshot = db.prepare(`INSERT INTO project_monthly_snapshots
    (month,project_id,project_name,area,property_type,ytd_income,ytd_cost,receivable,received,
     quality_score,safety_incidents,customer_satisfaction,complaint_count,source,quality_status,
     quality_reason,source_status,business_date,last_validated_at,field_provenance)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'QA受控月快照','verified','','available',?,?,'{}')`)
  for (const [month, offset] of [['2026-07', 0], ['2026-08', 10]] as const) {
    insertSnapshot.run(month, projectA, CENTER_A, SAME_AREA, '住宅', 700 + offset, 300, 1000, 800, 91, 0, 90, 1, `${month}-31`, extractedDate(month))
    insertSnapshot.run(month, projectB, CENTER_B, SAME_AREA, '住宅', B_SENTINEL + offset, 800, 2000, 1200, 72, 2, 70, 22, `${month}-31`, extractedDate(month))
  }

  const now = new Date().toISOString()
  const insertForecast = db.prepare(`INSERT INTO project_forecasts
    (month,project_id,project_name,area,annual_income,annual_cost,ytd_income,ytd_cost,
     calculated_income,calculated_cost,forecast_income,forecast_cost,method,explanation,owner,
     data_source,created_by,created_at,updated_at)
    VALUES('2026-08',?,?,?,?,?,?,?,?,?,?,?,'rolling','QA预测','QA负责人','qa-snapshot','qa',?,?)`)
  const forecastA = Number(insertForecast.run(projectA, CENTER_A, SAME_AREA, 1111, 500, 700, 300, 1111, 500, 1111, 500, now, now).lastInsertRowid)
  const forecastB = Number(insertForecast.run(projectB, CENTER_B, SAME_AREA, B_SENTINEL, 900, 1200, 800, B_SENTINEL, 900, B_SENTINEL, 900, now, now).lastInsertRowid)

  const meeting = Number(db.prepare(`INSERT INTO weekly_meetings
    (week_start,area,title,status,summary,created_by,created_at,updated_at)
    VALUES('2026-08-10',?,'QA同片区经营周会','held','同片区双中心隔离验收','qa',?,?)`)
    .run(SAME_AREA, now, now).lastInsertRowid)
  const insertMeetingItem = db.prepare(`INSERT INTO weekly_meeting_items
    (meeting_id,source_type,source_id,source_signature,project_id,project_name,risk_type,
     issue,decision,owner,status,created_at,updated_at)
    VALUES(?,'project',?,?,?,?,?,'QA问题','QA决定','QA负责人','decided',?,?)`)
  insertMeetingItem.run(meeting, `project:${projectA}`, `qa-a-${projectA}`, projectA, CENTER_A, '收费率', now, now)
  insertMeetingItem.run(meeting, `project:${projectB}`, `qa-b-${projectB}`, projectB, CENTER_B, '收费率', now, now)

  const insertArrearsBatch = db.prepare(`INSERT INTO arrears_upload_batches
    (project_id,project_name,business_date,ledger_filename,ledger_sha256,
     communication_filename,communication_sha256,status,parser_version,ledger_rows,
     communication_rows,matched_resources,unmatched_communication_rows,validation_errors,
     created_by,created_at,retention_until)
    VALUES(?,?,?,'qa-ledger.xlsx',?,'',?,'analyzed','qa-r65',1,0,1,0,'[]','qa',?,'2027-08-31')`)
  const arrearsBatchA = Number(insertArrearsBatch.run(profileA, CENTER_A, '2026-08-10', 'c'.repeat(64), 'd'.repeat(64), now).lastInsertRowid)
  const arrearsBatchB = Number(insertArrearsBatch.run(profileB, CENTER_B, '2026-08-10', 'e'.repeat(64), 'f'.repeat(64), now).lastInsertRowid)
  const insertArrearsLedger = db.prepare(`INSERT INTO arrears_ledger_rows
    (batch_id,source_row,evidence_ref,resource_hash,resource_masked,arrears_amount,fee_item,
     period_start,period_end,ageing_days,source_status,evidence_json)
    VALUES(?,2,?,?,?,?,'物业费','2025-01','2026-07',580,'欠费','{}')`)
  insertArrearsLedger.run(arrearsBatchA, 'L-A-1', 'hash-a', '甲中心资源***', 3333)
  insertArrearsLedger.run(arrearsBatchB, 'L-B-1', 'hash-b', '乙中心资源***', B_SENTINEL)
  const insertArrearsResult = db.prepare(`INSERT INTO arrears_analysis_results
    (batch_id,resource_hash,resource_ref,resource_masked,rule_category,rule_confidence,
     analysis_status,human_status,human_category,human_note,reviewed_by,reviewed_at)
    VALUES(?,?,?,?,'unknown',0.2,'ai_analyzed','confirmed','other','QA人工已确认','qa',?)`)
  insertArrearsResult.run(arrearsBatchA, 'hash-a', 'R-A-1', '甲中心资源***', now)
  insertArrearsResult.run(arrearsBatchB, 'hash-b', 'R-B-1', '乙中心资源***', now)

  const insertPayment = db.prepare(`INSERT INTO payment_centers
    (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
    VALUES(?,?,?,?,?,?,?)`)
  const paymentA = Number(insertPayment.run(SAME_AREA, CENTER_A, 11111, 900, 800, 700, 0.8).lastInsertRowid)
  const paymentB = Number(insertPayment.run(SAME_AREA, CENTER_B, B_SENTINEL, 1900, 1200, 900, 0.6).lastInsertRowid)

  const businessDate = new Date().toISOString().slice(0, 10)
  const extractedAt = new Date().toISOString()
  const insertDaily = db.prepare(`INSERT INTO daily_snapshots
    (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,
     quality_status,source,source_status,business_date,last_validated_at)
    VALUES(?,?,?,?,?,?,'verified','QA受控快照','available',?,?)`)
  insertDaily.run(businessDate, CENTER_A, 11111, 900, 800, 11, businessDate, extractedAt)
  insertDaily.run(businessDate, CENTER_B, B_SENTINEL, 1900, 1200, 22, businessDate, extractedAt)

  const collectionRows = [
    { area: SAME_AREA, center: CENTER_A, receivable: 1000, received: 800, outstanding: 200, collectionRate: 0.8 },
    { area: SAME_AREA, center: CENTER_B, receivable: B_SENTINEL, received: 1200, outstanding: B_SENTINEL - 1200, collectionRate: 0.6 },
    ...Array.from({ length: 33 }, (_, index) => ({
      area: `QA其他片区${index + 1}`,
      center: `第一服务QA其他${String(index + 1).padStart(2, '0')}服务中心`,
      receivable: 100 + index,
      received: 80 + index,
      outstanding: 20,
      collectionRate: 0.8,
    })),
  ]
  const insertCollection = db.prepare(`INSERT INTO collection_centers
    (area,center,receivable,received,overdue30,overdue90) VALUES(?,?,?,?,NULL,NULL)`)
  for (const row of collectionRows) insertCollection.run(row.area, row.center, row.receivable, row.received)

  const collectionReceivable = collectionRows.reduce((sum, row) => sum + row.receivable, 0)
  const collectionReceived = collectionRows.reduce((sum, row) => sum + row.received, 0)
  const collectionRate = collectionRows.reduce((sum, row) => sum + row.receivable * row.collectionRate, 0) / collectionReceivable
  const batchSummary = JSON.stringify({ totals: { after: {
    collection_rate: collectionRate,
    collection_receivable: collectionReceivable,
    collection_received: collectionReceived,
  } } })
  const ingestionBatch = Number(db.prepare(`INSERT INTO data_ingestion_batches
    (source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,
     publishable,row_count,mapped_count,unmapped_count,validation_errors,summary,published_by,published_at)
    VALUES('qa-r65',?,?,?,'[]','/qa-controlled','published',1,2,35,0,'[]',?,'qa',?)`)
    .run(businessDate, extractedAt, 'b'.repeat(64), batchSummary, extractedAt).lastInsertRowid)
  const insertIngestion = db.prepare(`INSERT INTO data_ingestion_rows
    (batch_id,entity_type,source_key,canonical_key,mapping_method,change_type,changed_fields,payload)
    VALUES(?,'collection_center',?,?, 'exact','snapshot','[]',?)`)
  for (const row of collectionRows) {
    insertIngestion.run(ingestionBatch, row.center, row.center, JSON.stringify(row))
  }
  db.prepare(`INSERT INTO data_ingestion_rows
    (batch_id,entity_type,source_key,canonical_key,mapping_method,change_type,changed_fields,payload)
    VALUES(?,'payment_center',? ,?,'exact','snapshot','[]',?)`)
    .run(ingestionBatch, CENTER_A, CENTER_A, JSON.stringify({ center: CENTER_A }))
  db.prepare(`INSERT INTO data_ingestion_rows
    (batch_id,entity_type,source_key,canonical_key,mapping_method,change_type,changed_fields,payload)
    VALUES(?,'daily_snapshot',? ,?,'exact','snapshot','[]',?)`)
    .run(ingestionBatch, `${businessDate}:${CENTER_A}`, CENTER_A, JSON.stringify({ center: CENTER_A }))
  db.prepare(`INSERT INTO data_ingestion_publications
    (batch_id,business_date,backup_payload,backup_sha256,payment_rows,snapshot_rows,collection_rows,published_by,published_at)
    VALUES(?,?,'{}',?,1,1,35,'r65-admin',?)`)
    .run(ingestionBatch, businessDate, 'c'.repeat(64), extractedAt)

  const detailContent = JSON.stringify({ businessDate, rows: collectionRows, extractedAt })
  const summaryContent = JSON.stringify({
    date: businessDate,
    extractedAt,
    collectionRate,
    receivable_万: collectionReceivable,
    received_万: collectionReceived,
    outstanding_万: collectionReceivable - collectionReceived,
    periodCorrection: {
      correctedRate: collectionRate,
      rateField: 'gatheringCurrentYearRecedRate',
      rateAggregation: 'QA官方项目率按应收加权',
    },
  })
  fs.writeFileSync(path.join(root, '绿仔收缴明细.json'), detailContent)
  fs.writeFileSync(path.join(root, '绿仔收款汇总.json'), summaryContent)
  fs.writeFileSync(path.join(root, '绿仔同步状态.json'), JSON.stringify({
    schemaVersion: 2,
    ok: true,
    state: 'published',
    date: businessDate,
    finishedAt: extractedAt,
    batchId: `p46-${ingestionBatch}`,
    p46BatchSha256: 'b'.repeat(64),
    collectionContentSha256: calculateLiveCollectionContentSha256(detailContent, summaryContent),
    publishedAt: extractedAt,
    publishedBy: 'r65-admin',
  }))
  const liveValidation = readLiveCollectionPublication(db, root)
  assert.equal(liveValidation.structureComplete, true, liveValidation.reasons.join('；'))
  assert.equal(liveValidation.ready, true, liveValidation.reasons.join('；'))
  assert.equal(unresolvedPublishedDailyConflict(db, businessDate), null)

  const aphValues = {
    annualBudget: 11111 + B_SENTINEL,
    cumulativeBudget: 900 + 1900,
    cumulativeExecuted: 800 + 1200,
    samePeriod: 700 + 900,
  }
  fs.writeFileSync(path.join(root, 'APH决策_每日提取.json'), JSON.stringify({
    sourceStatus: 'available',
    businessDate,
    lastValidatedAt: extractedAt,
    sourceLayers: {
      regionCard: { businessDate, source: 'QA受控APH地区卡片', values: aphValues },
      budgetWeekly: { businessDate, source: 'QA受控APH预算周报', values: aphValues },
      centerDetail: {
        businessDate,
        source: 'QA受控APH中心明细',
        values: {
          centerCount: 2,
          ...aphValues,
          samePeriodPresentCount: 2,
          samePeriodMissingCount: 0,
        },
      },
    },
    reconciliations: {
      annualBudgetCardVsWeekly: { leftValue: aphValues.annualBudget, rightValue: aphValues.annualBudget, difference: 0, status: 'ok' },
      annualBudgetCardVsCenterDetail: { leftValue: aphValues.annualBudget, rightValue: aphValues.annualBudget, difference: 0, status: 'ok' },
      samePeriodCardVsCenterDetail: { leftValue: aphValues.samePeriod, rightValue: aphValues.samePeriod, difference: 0, status: 'ok' },
    },
  }))

  return {
    memberA, memberB, unassigned, legacyMember, profileA, profileB, projectA, projectB,
    paymentA, paymentB, forecastA, forecastB, meeting, arrearsBatchA, arrearsBatchB, businessDate, ingestionBatch,
  }
}

function extractedDate(month: string) {
  return `${month}-28T08:00:00+08:00`
}

async function login(baseUrl: string, username: string, password: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const body = await response.json() as any
  assert.equal(response.status, 200, `${username}登录失败：${JSON.stringify(body)}`)
  assert.equal(typeof body.token, 'string')
  return body
}

async function request(baseUrl: string, token: string, pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers })
  const text = await response.text()
  let body: any = text
  try { body = JSON.parse(text) } catch {}
  return { response, body, text }
}

function assertNoCenterLeak(text: string, allowed: string) {
  const denied = allowed === CENTER_A ? CENTER_B : CENTER_A
  assert.equal(text.includes(denied), false, `响应泄露其他服务中心：${denied}`)
  if (allowed === CENTER_A) assert.equal(text.includes(String(B_SENTINEL)), false, '响应泄露乙中心哨兵值')
  for (const center of OUT_OF_SCOPE_CENTER_NAMES) {
    assert.equal(text.includes(center), false, `响应泄露范围外服务中心名称：${center}`)
  }
}

test('R65 服务中心成员权限：同片区双中心端到端隔离', { timeout: 120_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-r65-center-scope-'))
  const dbPath = path.join(root, 'cockpit.db')
  const rawRoot = path.join(root, 'arrears-raw')
  const encryptionKey = path.join(root, 'arrears-key')
  fs.mkdirSync(rawRoot, { recursive: true, mode: 0o700 })
  fs.writeFileSync(encryptionKey, 'qa-encryption-key-material-at-least-32-characters', { mode: 0o600 })
  const port = await freePort()
  const hermes = await startHermesStub()
  let logs = ''
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      COCKPIT_DB_PATH: dbPath,
      COCKPIT_ROOT: root,
      COCKPIT_ADMIN_PASSWORD: ADMIN_PASSWORD,
      JWT_SECRET: 'r65-service-center-shadow-secret-at-least-32-characters',
      DAILY_RECONCILIATION_JWT_SECRET: 'r65-daily-automation-secret-at-least-32-characters',
      ARREARS_RAW_ROOT: rawRoot,
      ARREARS_ENCRYPTION_KEY_FILE: encryptionKey,
      ARREARS_ENCRYPTION_KEY_VERSION: 'qa-v1',
      ARREARS_RESOURCE_HASH_KEY: 'r65-resource-hash-secret-at-least-32-characters',
      COCKPIT_ALLOW_DEMO_DATA: 'false',
      HERMES_COCKPIT_BASE_URL: hermes.url,
      HERMES_COCKPIT_API_KEY: 'qa-hermes-key',
      HERMES_COCKPIT_MODEL: 'qa-center-scope-stub',
      NORTH_KNOWLEDGE_DB: path.join(root, 'missing-approved-knowledge.db'),
      DEEPSEEK_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { logs += chunk })
  child.stderr.on('data', chunk => { logs += chunk })

  let db: Database.Database | null = null
  try {
    const baseUrl = `http://127.0.0.1:${port}`
    await waitFor(`${baseUrl}/api/health/ready`, child, () => logs)
    db = new Database(dbPath)
    db.pragma('foreign_keys = ON')
    const ids = seedDatabase(db, root)

    const adminLogin = await login(baseUrl, 'admin', ADMIN_PASSWORD)
    const aLogin = await login(baseUrl, 'qa-member-a', MEMBER_PASSWORD)
    const bLogin = await login(baseUrl, 'qa-member-b', MEMBER_PASSWORD)
    const unassignedLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'qa-member-unassigned', password: MEMBER_PASSWORD }),
    })
    const unassignedLoginBody = await unassignedLoginResponse.json() as any
    const legacyLogin = await login(baseUrl, 'qa-legacy-member-a', MEMBER_PASSWORD)
    assert.equal(aLogin.user.role, 'viewer')
    assert.equal(aLogin.user.serviceCenterScope, CENTER_A)
    assert.equal(bLogin.user.serviceCenterScope, CENTER_B)
    assert.equal(unassignedLoginResponse.status, 403)
    assert.equal(unassignedLoginBody.code, 'SERVICE_CENTER_ASSIGNMENT_REQUIRED')
    assert.equal(legacyLogin.user.role, 'hq_function')
    assert.equal(legacyLogin.user.serviceCenterScope, '华北地区公司本部职能')

    await t.test('管理员读取全量后台，并且成员不能进入后台管理API', async () => {
      const adminReads = [
        '/api/admin/overview',
        '/api/admin/quality',
        '/api/admin/quality-cases',
        '/api/data-sources/status',
        '/api/data-sources/alerts',
        '/api/data-sources/sync-runs?limit=10',
        '/api/data-sources/auto-jobs',
        '/api/data-sources/quality',
        '/api/data-sources/publication-status',
        '/api/admin/mappings',
        '/api/governance/rules',
        '/api/governance/permissions',
        '/api/users',
        '/api/governance/logs?limit=10',
        '/api/governance/audit-summary',
        '/api/governance/disaster-recovery',
        '/api/import/backups',
        '/api/admin/system',
        '/api/admin/quarantine',
        '/api/governance/report-archives',
        '/api/formal-outputs',
      ]
      for (const pathname of adminReads) {
        const { response, text } = await request(baseUrl, adminLogin.token, pathname)
        assert.equal(response.status, 200, `${pathname}：${text}`)
      }
      for (const pathname of ['/api/admin/overview', '/api/users', '/api/governance/logs']) {
        const { response } = await request(baseUrl, aLogin.token, pathname)
        assert.equal(response.status, 403, `普通成员不应访问${pathname}`)
      }

      const adminBusiness = await request(baseUrl, adminLogin.token, '/api/payments')
      assert.equal(adminBusiness.response.status, 200, adminBusiness.text)
      assert.match(adminBusiness.text, new RegExp(CENTER_A))
      assert.match(adminBusiness.text, new RegExp(CENTER_B))
    })

    await t.test('权威中心选项拒绝自由文本，项目经理可绑定同片区多个中心', async () => {
      const optionsResult = await request(baseUrl, adminLogin.token, '/api/users/service-centers')
      assert.equal(optionsResult.response.status, 200, optionsResult.text)
      const options = Array.isArray(optionsResult.body) ? optionsResult.body : (optionsResult.body.rows || optionsResult.body.options || [])
      assert.ok(options.some((row: any) => (row.center || row.value) === CENTER_A))
      assert.ok(options.some((row: any) => (row.center || row.value) === CENTER_B))

      const invalid = await request(baseUrl, adminLogin.token, '/api/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'qa-invalid-center', password: MEMBER_PASSWORD, role: 'viewer', service_center_scope: '随手输入的不存在中心' }),
      })
      assert.equal(invalid.response.status, 400, invalid.text)

      const multi = await request(baseUrl, adminLogin.token, '/api/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'qa-multi-center', password: MEMBER_PASSWORD, role: 'project_manager', area_scope: SAME_AREA, service_center_scope: `${CENTER_A},${CENTER_B}` }),
      })
      assert.equal(multi.response.status, 201, multi.text)
      assert.equal(multi.body.service_center_scope, `${CENTER_A},${CENTER_B}`)

      const valid = await request(baseUrl, adminLogin.token, '/api/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'qa-valid-member', password: MEMBER_PASSWORD, role: 'viewer', area_scope: SAME_AREA, service_center_scope: CENTER_A }),
      })
      assert.equal(valid.response.status, 201, valid.text)
      assert.equal(valid.body.service_center_scope, CENTER_A)
    })

    await t.test('同片区甲乙成员的列表、汇总、详情、AI和欠费入口互不泄露', async () => {
      const scopedReads: Array<[string, (body: any) => any[]]> = [
        ['/api/payments', body => body],
        [`/api/daily?date=${ids.businessDate}`, body => body.rows],
        ['/api/collections', body => Array.isArray(body) ? body : body.rows],
        ['/api/projects', body => body.rows],
        ['/api/project-profiles', body => body.rows],
        ['/api/arrears/projects', body => body.rows],
        ['/api/arrears/batches', body => body.rows],
        ['/api/ai/service-centers', body => body.rows],
      ]
      for (const [pathname, rowsOf] of scopedReads) {
        const a = await request(baseUrl, aLogin.token, pathname)
        assert.equal(a.response.status, 200, `${pathname}：${a.text}`)
        assertNoCenterLeak(a.text, CENTER_A)
        const aRows = rowsOf(a.body) || []
        assert.ok(aRows.length >= 1, `${pathname}未返回甲中心数据`)
        assert.equal(aRows.every((row: any) => !JSON.stringify(row).includes(CENTER_B)), true)

        const b = await request(baseUrl, bLogin.token, pathname)
        assert.equal(b.response.status, 200, `${pathname}：${b.text}`)
        assertNoCenterLeak(b.text, CENTER_B)
        const bRows = rowsOf(b.body) || []
        assert.ok(bRows.length >= 1, `${pathname}未返回乙中心数据`)
        assert.equal(bRows.every((row: any) => !JSON.stringify(row).includes(CENTER_A)), true)
      }

      for (const pathname of ['/api/summary', '/api/projects/summary', '/api/project-profiles/summary', '/api/ai/assistant/context']) {
        const a = await request(baseUrl, aLogin.token, pathname)
        assert.equal(a.response.status, 200, `${pathname}：${a.text}`)
        assertNoCenterLeak(a.text, CENTER_A)
      }

      for (const pathname of [`/api/projects/${ids.projectB}`, `/api/project-profiles/${ids.profileB}`]) {
        const denied = await request(baseUrl, aLogin.token, pathname)
        assert.ok([403, 404].includes(denied.response.status), `${pathname}应拒绝直接越权，实际${denied.response.status}`)
        assert.equal(denied.text.includes(CENTER_B), false)
      }
      const ownProject = await request(baseUrl, aLogin.token, `/api/projects/${ids.projectA}`)
      assert.equal(ownProject.response.status, 200, ownProject.text)
      assertNoCenterLeak(ownProject.text, CENTER_A)

      const diagnosis = await request(baseUrl, aLogin.token, `/api/ai/project/${ids.projectA}/diagnosis`)
      assert.equal(diagnosis.response.status, 200, diagnosis.text)
      assertNoCenterLeak(diagnosis.text, CENTER_A)
      assert.match(diagnosis.text, /片区均值80\.0%/, '成员项目诊断基准必须只使用本中心项目')
      assert.doesNotMatch(diagnosis.text, /片区均值70\.0%/, '诊断不得混入同片区乙中心均值')

      const arrearsOverview = await request(baseUrl, aLogin.token, '/api/arrears/overview')
      assert.equal(arrearsOverview.response.status, 200, arrearsOverview.text)
      assertNoCenterLeak(arrearsOverview.text, CENTER_A)
      assert.equal(arrearsOverview.body.projectCount, 1)
      assert.equal(arrearsOverview.body.totalAmount, 3333)

      for (const suffix of ['', '/runs', '/results', '/conclusion', '/audit', '/export']) {
        const denied = await request(baseUrl, aLogin.token, `/api/arrears/batches/${ids.arrearsBatchB}${suffix}`)
        assert.equal(denied.response.status, 404, `跨中心欠费批次${suffix || '/detail'}应隐藏存在性：${denied.text}`)
        assert.equal(denied.text.includes(CENTER_B), false)
        assert.equal(denied.text.includes(String(B_SENTINEL)), false)
      }
      for (const suffix of ['', '/runs', '/results', '/conclusion', '/audit']) {
        const own = await request(baseUrl, aLogin.token, `/api/arrears/batches/${ids.arrearsBatchA}${suffix}`)
        assert.equal(own.response.status, 200, `本中心欠费批次${suffix || '/detail'}不可用：${own.text}`)
        assertNoCenterLeak(own.text, CENTER_A)
      }
      const ownArrearsExport = await request(baseUrl, aLogin.token, `/api/arrears/batches/${ids.arrearsBatchA}/export`)
      assert.equal(ownArrearsExport.response.status, 200, ownArrearsExport.text)
      assertNoCenterLeak(ownArrearsExport.text, CENTER_A)

      for (const pathname of [
        `/api/payments?center=${encodeURIComponent(CENTER_B)}`,
        `/api/daily?date=${ids.businessDate}&center=${encodeURIComponent(CENTER_B)}`,
        `/api/collections?center=${encodeURIComponent(CENTER_B)}`,
        `/api/projects?area=${encodeURIComponent(SAME_AREA)}&center=${encodeURIComponent(CENTER_B)}`,
        `/api/project-profiles?area=${encodeURIComponent(SAME_AREA)}&center=${encodeURIComponent(CENTER_B)}`,
        `/api/ai/service-centers?center=${encodeURIComponent(CENTER_B)}`,
      ]) {
        const bypass = await request(baseUrl, aLogin.token, pathname)
        assert.equal(bypass.response.status, 200, `${pathname}：${bypass.text}`)
        assertNoCenterLeak(bypass.text, CENTER_A)
      }
    })

    await t.test('地区职能覆盖全部中心，但不获得系统管理或业务写入权限', async () => {
      const read = await request(baseUrl, legacyLogin.token, '/api/payments')
      assert.equal(read.response.status, 200, read.text)
      assert.match(read.text, new RegExp(CENTER_A))
      assert.match(read.text, new RegExp(CENTER_B))

      const adminApi = await request(baseUrl, legacyLogin.token, '/api/users')
      assert.equal(adminApi.response.status, 403, adminApi.text)
      const write = await request(baseUrl, legacyLogin.token, `/api/payments/${ids.paymentA}`, {
        method: 'PUT',
        body: JSON.stringify({ cumulativeExecuted: 999999 }),
      })
      assert.equal(write.response.status, 403, write.text)
    })

    await t.test('普通成员可导出本中心，CSV不包含同片区其他中心', async () => {
      const a = await request(baseUrl, aLogin.token, '/api/export/projects-csv')
      assert.equal(a.response.status, 200, a.text)
      assert.match(a.text, new RegExp(CENTER_A))
      assertNoCenterLeak(a.text, CENTER_A)

      const b = await request(baseUrl, bLogin.token, '/api/export/projects-csv')
      assert.equal(b.response.status, 200, b.text)
      assert.match(b.text, new RegExp(CENTER_B))
      assertNoCenterLeak(b.text, CENTER_B)
    })

    await t.test('AI、月报、预测、周会和旧导出旁路均不泄露同片区其他中心', async () => {
      const readPaths: Array<[string, number]> = [
        ['/api/ai/trends', 200],
        ['/api/ai/risk-trends', 200],
        ['/api/alerts', 200],
        [`/api/ai/monthly-report?area=${encodeURIComponent(SAME_AREA)}`, 200],
        ['/api/ai/health', 200],
        ['/api/ai/brief', 200],
        ['/api/command/data-reliability', 403],
        ['/api/ai/week-focus', 200],
        ['/api/data-quality/project-gate', 200],
        ['/api/export/report', 410],
        ['/api/export/monthly-report-doc', 410],
        ['/api/forecasts?month=2026-08&area=华北', 200],
        [`/api/forecasts/${ids.forecastA}/versions`, 200],
        [`/api/weekly-meetings?area=${encodeURIComponent(SAME_AREA)}`, 200],
        [`/api/weekly-meetings/${ids.meeting}`, 200],
        ['/api/ai/assistant/context', 200],
        ['/api/daily/dates', 200],
        ['/api/projects/areas', 200],
        ['/api/arrears/readiness', 200],
        ['/api/arrears/overview', 200],
        ['/api/arrears/batches', 200],
      ]
      for (const [pathname, expectedStatus] of readPaths) {
        const result = await request(baseUrl, aLogin.token, pathname)
        assert.equal(result.response.status, expectedStatus, `${pathname}：${result.text}`)
        assertNoCenterLeak(result.text, CENTER_A)
      }

      const forecast = await request(baseUrl, aLogin.token, '/api/forecasts?month=2026-08&area=华北')
      if (forecast.response.status === 200) {
        assert.deepEqual((forecast.body.rows || []).map((row: any) => row.project_name), [CENTER_A])
        assert.deepEqual(forecast.body.discipline?.roles || {}, {}, '成员不得读取全局审批角色数量')
      }

      const projectGate = await request(baseUrl, aLogin.token, '/api/data-quality/project-gate')
      assert.equal(projectGate.body.projectCount, 1, '成员真实性门禁不得透出全局项目数')
      const monthly = await request(baseUrl, aLogin.token, `/api/ai/monthly-report?area=${encodeURIComponent(SAME_AREA)}`)
      assert.equal(monthly.body.summary?.project_count, 1)
      assert.equal(monthly.body.dataQuality?.projectCount, 1, '成员月报质量摘要必须是本中心口径')
      assert.equal(monthly.body.autoTaskReview, null, '成员月报不得读取全局数据流水线治理信息')

      const weekly = await request(baseUrl, aLogin.token, `/api/weekly-meetings/${ids.meeting}`)
      assert.deepEqual((weekly.body.items || []).map((row: any) => row.project_name), [CENTER_A])

      for (const pathname of [
        `/api/ai/trends?projectId=${ids.projectB}`,
        `/api/ai/risk-trends?projectId=${ids.projectB}`,
        `/api/ai/project/${ids.projectB}/diagnosis`,
      ]) {
        const denied = await request(baseUrl, aLogin.token, pathname)
        assert.equal(denied.response.status, 404, `${pathname}应隐藏跨中心记录存在性：${denied.text}`)
        assertNoCenterLeak(denied.text, CENTER_A)
      }
      const deniedForecast = await request(baseUrl, aLogin.token, `/api/forecasts/${ids.forecastB}/versions`)
      assert.equal(deniedForecast.response.status, 403, deniedForecast.text)
      assertNoCenterLeak(deniedForecast.text, CENTER_A)

      const legacyAsk = await request(baseUrl, aLogin.token, '/api/ai/ask', {
        method: 'POST',
        body: JSON.stringify({ question: '哪个项目收费率最低？' }),
      })
      assert.equal(legacyAsk.response.status, 200, legacyAsk.text)
      assert.match(legacyAsk.text, new RegExp(CENTER_A))
      assertNoCenterLeak(legacyAsk.text, CENTER_A)

      const interpretation = await request(baseUrl, aLogin.token, '/api/ai/interpret', {
        method: 'POST',
        body: JSON.stringify({
          type: 'region',
          data: { rows: [{ id: ids.projectA, name: CENTER_A, area: SAME_AREA, receivable: 1000, received: 800 }] },
        }),
      })
      assert.equal(interpretation.response.status, 200, interpretation.text)
      assertNoCenterLeak(interpretation.text, CENTER_A)

      const assistant = await request(baseUrl, aLogin.token, '/api/ai/assistant/ask', {
        method: 'POST',
        body: JSON.stringify({ question: `${CENTER_A}的回款情况怎么样？`, history: [] }),
      })
      assert.equal(assistant.response.status, 200, assistant.text)
      assert.match(assistant.text, new RegExp(CENTER_A))
      assertNoCenterLeak(assistant.text, CENTER_A)
      assert.ok(hermes.requests.length >= 1, '权限内回款问数未进入受控AI链路')
      const latestHermesRequest = hermes.requests.at(-1) || ''
      assert.match(latestHermesRequest, new RegExp(CENTER_A))
      assert.equal(latestHermesRequest.includes(CENTER_B), false, 'AI编排上下文泄露乙中心')
      assert.equal(latestHermesRequest.includes(String(B_SENTINEL)), false, 'AI编排上下文泄露乙中心哨兵值')

      const crossCenterQuestion = await request(baseUrl, aLogin.token, '/api/ai/assistant/ask', {
        method: 'POST',
        body: JSON.stringify({ question: `${CENTER_B}的回款情况怎么样？`, history: [] }),
      })
      assert.ok([403, 409, 422].includes(crossCenterQuestion.response.status), crossCenterQuestion.text)
      assert.equal(crossCenterQuestion.text.includes(String(B_SENTINEL)), false, '跨中心问数不得返回乙中心事实')
      assert.equal(hermes.requests.length, 1, '跨中心问数不得进入AI编排链路')
    })

    await t.test('未分配成员在签发令牌前失败关闭', async () => {
      assert.equal(unassignedLoginResponse.status, 403)
      assert.equal(unassignedLoginBody.code, 'SERVICE_CENTER_ASSIGNMENT_REQUIRED')
      assert.equal(unassignedLoginBody.token, undefined)
      assert.equal(JSON.stringify(unassignedLoginBody).includes(CENTER_A), false)
      assert.equal(JSON.stringify(unassignedLoginBody).includes(CENTER_B), false)
    })

    await t.test('普通成员所有管理和业务写入均被拒绝且数据库未变化', async () => {
      const paymentBefore = db!.prepare('SELECT cumulative_executed FROM payment_centers WHERE id=?').get(ids.paymentA) as any
      const denialLogStartId = Number((db!.prepare('SELECT COALESCE(MAX(id), 0) id FROM operation_logs').get() as any).id)
      const writes: Array<[string, string, any]> = [
        [`/api/payments/${ids.paymentA}`, 'PUT', { cumulativeExecuted: 999999 }],
        [`/api/collections/${ids.paymentA}`, 'PUT', { received: 999999 }],
        ['/api/trends', 'POST', { month: '2026-08', '华北汇总': 999999 }],
        ['/api/governance/rules/1', 'PUT', { threshold_value: 999999, enabled: true }],
        ['/api/forecasts/refresh', 'POST', { month: '2026-08', area: SAME_AREA }],
        ['/api/data-sources/sync/aph', 'POST', {}],
        ['/api/data-sources/repair/aph', 'POST', {}],
        ['/api/users', 'POST', { username: 'qa-forbidden-create', password: MEMBER_PASSWORD, role: 'viewer', service_center_scope: CENTER_A }],
        [`/api/users/${ids.memberB}`, 'DELETE', {}],
        ['/api/governance/report-archives', 'POST', { area: SAME_AREA, version: 'leader', payload: {} }],
        ['/api/formal-outputs/generate', 'POST', { type: 'monthly', area: SAME_AREA, period: '2026-08' }],
      ]
      for (const [pathname, method, body] of writes) {
        const result = await request(baseUrl, aLogin.token, pathname, { method, body: JSON.stringify(body) })
        assert.equal(result.response.status, 403, `普通成员写入${pathname}应403，实际${result.response.status}：${result.text}`)
      }
      const paymentAfter = db!.prepare('SELECT cumulative_executed FROM payment_centers WHERE id=?').get(ids.paymentA) as any
      assert.deepEqual(paymentAfter, paymentBefore)
      assert.equal((db!.prepare("SELECT COUNT(*) count FROM users WHERE username='qa-forbidden-create'").get() as any).count, 0)
      assert.equal((db!.prepare("SELECT COUNT(*) count FROM users WHERE username='qa-member-b'").get() as any).count, 1)

      const denialLogs = db!.prepare(`SELECT target,detail FROM operation_logs
        WHERE id>? AND username='qa-member-a' AND action='越权请求拦截' ORDER BY id`).all(denialLogStartId) as any[]
      assert.ok(denialLogs.length >= writes.length, `每次成员写拒绝都必须审计：请求${writes.length}，日志${denialLogs.length}`)
      for (const row of denialLogs) {
        const detail = JSON.parse(row.detail || '{}')
        assert.deepEqual(Object.keys(detail).sort(), ['method', 'reason', 'role'], `${row.target}审计字段不得扩张`)
        assert.equal(detail.role, 'viewer')
        assert.equal(/999999|222222|qa-forbidden-create/.test(row.detail), false, `${row.target}审计不得记录请求正文或业务哨兵`)
      }
    })

    await t.test('收缴源未发布时成员失败关闭，不透出全局质量与中心信息', async () => {
      const syncPath = path.join(root, '绿仔同步状态.json')
      try {
        db!.prepare("UPDATE data_ingestion_batches SET status='blocked' WHERE source_key='qa-r65'").run()
        fs.writeFileSync(syncPath, JSON.stringify({ ok: false, date: ids.businessDate, finishedAt: new Date().toISOString() }))
        const result = await request(baseUrl, aLogin.token, '/api/collections')
        assert.equal(result.response.status, 503, result.text)
        assert.deepEqual(result.body.rows, [])
        assert.equal(result.body.sourceQuality?.scoped, true, '成员失败响应必须标记为权限内质量')
        assert.equal(result.body.sourceQuality?.rowCount, 0, '不得暴露全局收缴行数')
        assertNoCenterLeak(result.text, CENTER_A)
      } finally {
        db!.prepare("UPDATE data_ingestion_batches SET status='published' WHERE source_key='qa-r65'").run()
        const publishedAt = new Date().toISOString()
        const collectionContentSha256 = calculateLiveCollectionContentSha256(
          fs.readFileSync(path.join(root, '绿仔收缴明细.json'), 'utf8'),
          fs.readFileSync(path.join(root, '绿仔收款汇总.json'), 'utf8'),
        )
        fs.writeFileSync(syncPath, JSON.stringify({
          ok: true,
          state: 'published',
          date: ids.businessDate,
          finishedAt: publishedAt,
          schemaVersion: 2,
          batchId: `p46-${ids.ingestionBatch}`,
          p46BatchSha256: 'b'.repeat(64),
          collectionContentSha256,
          publishedAt,
          publishedBy: 'r65-admin',
        }))
      }
    })

    await t.test('退役任务入口保持410，不能重新暴露', async () => {
      for (const pathname of [
        '/api/data-sources/auto-jobs/repair-tasks',
        '/api/data-sources/master-data/migrate-legacy-tasks',
      ]) {
        const result = await request(baseUrl, adminLogin.token, pathname, { method: 'POST', body: '{}' })
        assert.equal(result.response.status, 410, `${pathname}应保持410`)
        assert.equal(result.body.moduleRemoved, true)
      }
    })
  } catch (error: any) {
    throw new Error(`${error?.message || String(error)}\n${error?.stack || ''}\nSERVER LOGS:\n${logs}`)
  } finally {
    db?.close()
    await stop(child)
    await hermes.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
