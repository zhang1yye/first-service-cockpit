import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-r5-contract-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'r5-publication-responsibility-contract-secret-32'
process.env.NODE_ENV = 'test'

const [{ default: db }, { default: adminRouter }, { default: dataSourcesRouter }, { signToken }] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/admin.js'),
  import('../src/routes/data-sources.js'),
  import('../src/auth.js'),
])

const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  ;(req as any).user = { userId: 1, username: 'r5-admin', role: 'admin' }
  next()
})
app.use(dataSourcesRouter)
app.use(adminRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  if (server.listening) return resolve()
  server.once('listening', resolve)
  server.once('error', reject)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('R5 contract server did not bind')
const baseUrl = `http://127.0.0.1:${address.port}`
const admin = db.prepare("SELECT id,username,role,area_scope,project_scope,token_version FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any
if (!admin) throw new Error('isolated R5 admin missing')
const adminToken = signToken({ userId: admin.id, username: admin.username, role: 'admin' })
const adminHeaders = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

function seedPartialPublication() {
  fs.writeFileSync(path.join(root, 'APH决策_每日提取.json'), JSON.stringify({
    businessDate: '2026-08-08', sourceStatus: 'available', extractedAt: '2026-08-08T08:30:00+08:00',
  }))
  fs.writeFileSync(path.join(root, '绿仔收款汇总.json'), JSON.stringify({
    date: '2026-08-08', extractedAt: '2026-08-08T21:30:00+08:00', collectionRate: 0.6317,
  }))
  fs.writeFileSync(path.join(root, '绿仔收缴明细.json'), JSON.stringify({
    businessDate: '2026-08-08', extractedAt: '2026-08-08T21:30:00+08:00',
    rows: Array.from({ length: 35 }, (_, index) => ({ center: `测试中心${index + 1}` })),
  }))
  fs.writeFileSync(path.join(root, '绿仔同步状态.json'), JSON.stringify({
    ok: true, date: '2026-08-08', finishedAt: '2026-08-08T21:31:00+08:00',
  }))

  for (const [key, name] of [['aph', 'APH回款'], ['finereport', '中心明细'], ['lvzai', '绿仔收缴']]) {
    db.prepare(`INSERT INTO data_sources(source_key,name,source_type,status,last_sync_at)
      VALUES(?,?,'controlled','已连接','2026-08-05 22:00:00')
      ON CONFLICT(source_key) DO UPDATE SET name=excluded.name,status=excluded.status,last_sync_at=excluded.last_sync_at`).run(key, name)
  }
  db.prepare(`INSERT INTO daily_snapshots
    (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,quality_status,source_status,business_date,last_validated_at)
    VALUES('2026-08-08','测试中心',100,80,70,2,'verified','available','2026-08-08','2026-08-08T08:30:00+08:00')`).run()
  const batch = db.prepare(`INSERT INTO data_ingestion_batches
    (source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,publishable,row_count,mapped_count,unmapped_count,validation_errors,summary,published_by,published_at)
    VALUES('aph-finereport-lvzai','2026-08-05','2026-08-05T21:00:00+08:00',?,'[]','/archive','published',1,56,35,0,'[]','{}','r5-admin','2026-08-05 22:00:00')`).run('a'.repeat(64))
  const batchId = Number(batch.lastInsertRowid)
  db.prepare(`INSERT INTO data_ingestion_publications
    (batch_id,business_date,backup_payload,backup_sha256,payment_rows,snapshot_rows,collection_rows,published_by,published_at)
    VALUES(?, '2026-08-05','{}',?,56,56,35,'r5-admin','2026-08-05 22:00:00')`).run(batchId, 'b'.repeat(64))
  for (const key of ['aph', 'finereport', 'lvzai']) {
    db.prepare(`INSERT INTO data_source_sync_runs
      (source_key,source_name,run_type,status,health,message,detail,rows_read,rows_written,operator,started_at,finished_at)
      VALUES(?,?,'p46-publish','success','ok','旧批次发布成功',?,1,1,'r5-admin','2026-08-05 22:00:00','2026-08-05 22:00:00')`)
      .run(key, key, JSON.stringify({ batchId, businessDate: '2026-08-05' }))
  }
}

test('publication status endpoint rejects live data without a content-bound formal receipt', async () => {
  seedPartialPublication()
  const response = await fetch(`${baseUrl}/api/data-sources/publication-status`)
  assert.equal(response.status, 200)
  const body = await response.json() as any
  assert.equal(body.code, 'partial')
  assert.equal(body.label, '部分更新')
  assert.equal(body.businessDate, '2026-08-08')
  assert.equal(body.officialBusinessDate, null)
  assert.equal(body.isComplete, false)
  assert.equal(body.latestBatch, null, '畸形回执不得成为正式批次证据')
  assert.equal(body.latestPublication, null, '回执行数与实际ingestion明细不一致时必须失败关闭')
  assert.deepEqual(body.advancedSourceKeys, ['aph', 'finereport', 'lvzai'])
  const lvzai = body.sources.find((row: any) => row.sourceKey === 'lvzai')
  assert.equal(lvzai.businessDate, '2026-08-08')
  assert.equal(lvzai.status, 'failed')
  assert.equal(lvzai.summaryAvailable, true)
  assert.equal(lvzai.detailAvailable, true)
  assert.equal(lvzai.syncStatusAvailable, true)
  assert.equal(lvzai.rowCount, 35)
  assert.match(lvzai.message, /回执|SHA256|P46/)
})

test('零行回执加三条成功审计也绝不能被判为完整发布', async () => {
  const batch = db.prepare(`INSERT INTO data_ingestion_batches
    (source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,publishable,
     row_count,mapped_count,unmapped_count,validation_errors,summary,published_by,published_at)
    VALUES('malformed-zero','2026-08-08','2026-08-08T20:00:00+08:00',?,'[]','/bad','published',1,
      0,0,0,'[]','{}','bad','2026-08-08 22:00:00')`).run('c'.repeat(64))
  const batchId = Number(batch.lastInsertRowid)
  db.prepare(`INSERT INTO data_ingestion_publications
    (batch_id,business_date,backup_payload,backup_sha256,payment_rows,snapshot_rows,collection_rows,published_by,published_at)
    VALUES(?,'2026-08-08','{}',?,0,0,0,'bad','2026-08-08 22:00:00')`).run(batchId, 'd'.repeat(64))
  for (const key of ['aph', 'finereport', 'lvzai']) {
    db.prepare(`INSERT INTO data_source_sync_runs
      (source_key,source_name,run_type,status,health,message,detail,operator,started_at,finished_at)
      VALUES(?,?,'p46-publish','success','ok','伪成功审计',?,'bad','2026-08-08 22:00:00','2026-08-08 22:00:00')`)
      .run(key, key, JSON.stringify({ batchId, businessDate: '2026-08-08' }))
  }
  const response = await fetch(`${baseUrl}/api/data-sources/publication-status`)
  assert.equal(response.status, 200)
  const body = await response.json() as any
  assert.equal(body.isComplete, false)
  assert.notEqual(body.code, 'complete')
  assert.notEqual(body.latestBatch?.id, batchId)

  const status = await fetch(`${baseUrl}/api/data-sources/status`)
  const statusBody = await status.json() as any
  assert.equal(statusBody.publication.isComplete, false)
  assert.notEqual(statusBody.publication.code, 'complete')
})

test('missing canonical lvzai summary never reports the source ready', async () => {
  fs.unlinkSync(path.join(root, '绿仔收款汇总.json'))
  const response = await fetch(`${baseUrl}/api/data-sources/publication-status`)
  assert.equal(response.status, 200)
  const body = await response.json() as any
  const lvzai = body.sources.find((row: any) => row.sourceKey === 'lvzai')
  assert.equal(lvzai.summaryAvailable, false)
  assert.equal(lvzai.detailAvailable, true)
  assert.equal(lvzai.syncStatusAvailable, true)
  assert.equal(lvzai.status, 'failed', '任一固定入口缺失时必须显式失败，不得静默视为未知')
  assert.ok(body.missingSourceKeys.includes('lvzai'))
})

test('quality responsibility migration and HTTP workflow preserve assignment, evidence and review separately', async () => {
  const columns = new Set((db.prepare('PRAGMA table_info(data_quality_cases)').all() as any[]).map(row => row.name))
  for (const name of ['due_date', 'sla_days', 'claimed_at', 'handling_note', 'evidence_ref', 'review_note', 'reviewed_by']) {
    assert.equal(columns.has(name), true, `missing R5 quality column ${name}`)
  }
  db.prepare(`INSERT INTO data_quality_cases
    (code,severity,category,title,detail,recommendation)
    VALUES('R5_TEST','high','source','R5责任闭环测试','测试异常','核对来源并提交证据')`).run()

  const missingDue = await fetch(`${baseUrl}/api/admin/quality-cases/R5_TEST/status`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ status: 'claimed', owner: '计划财务' }),
  })
  assert.equal(missingDue.status, 409)

  const claimed = await fetch(`${baseUrl}/api/admin/quality-cases/R5_TEST/status`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ status: 'claimed', owner: '计划财务', dueDate: '2026-08-12' }),
  })
  assert.equal(claimed.status, 200, await claimed.clone().text())
  const claimedRow = (await claimed.json() as any).row
  assert.equal(claimedRow.owner, '计划财务')
  assert.equal(claimedRow.due_date, '2026-08-12')
  assert.equal(claimedRow.sla_days, 3)
  assert.ok(claimedRow.claimed_at)
  assert.equal(typeof claimedRow.timing.isOverdue, 'boolean')

  const started = await fetch(`${baseUrl}/api/admin/quality-cases/R5_TEST/status`, {
    method: 'PUT', headers: adminHeaders, body: JSON.stringify({ status: 'in_progress' }),
  })
  assert.equal(started.status, 200)

  const missingEvidence = await fetch(`${baseUrl}/api/admin/quality-cases/R5_TEST/status`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ status: 'review', note: '已完成跨源核对' }),
  })
  assert.equal(missingEvidence.status, 409)

  const submitted = await fetch(`${baseUrl}/api/admin/quality-cases/R5_TEST/status`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ status: 'review', note: '已完成跨源核对', evidenceRef: 'P46批次#8 / SHA256' }),
  })
  assert.equal(submitted.status, 200, await submitted.text())

  const resolved = await fetch(`${baseUrl}/api/admin/quality-cases/R5_TEST/status`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ status: 'resolved', note: '复核通过，来源与正式批次一致' }),
  })
  assert.equal(resolved.status, 200, await resolved.clone().text())
  const row = (await resolved.json() as any).row
  assert.equal(row.handling_note, '已完成跨源核对')
  assert.equal(row.evidence_ref, 'P46批次#8 / SHA256')
  assert.equal(row.review_note, '复核通过，来源与正式批次一致')
  assert.equal(row.reviewed_by, admin.username)
  assert.equal(row.timing.isOverdue, false)

  const list = await fetch(`${baseUrl}/api/admin/quality-cases`, { headers: adminHeaders })
  assert.equal(list.status, 200)
  const listed = await list.json() as any
  assert.equal(listed.summary.total >= 1, true)
  assert.equal(typeof listed.summary.overdue, 'number')
  assert.equal(listed.rows.find((item: any) => item.code === 'R5_TEST').timing.isOverdue, false)
})
