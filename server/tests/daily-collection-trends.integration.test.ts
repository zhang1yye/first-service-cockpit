import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-daily-collection-trends-')))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.COCKPIT_HISTORICAL_BACKFILL_SOURCE_ROOTS = path.join(root, 'historical-sources')
process.env.JWT_SECRET = 'daily-collection-trends-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'

const withdrawnCenter = '第一服务每日趋势撤场服务中心'
const viewerCenter = '第一服务每日趋势11服务中心'
const areas = ['朝阳片区', '京东片区', '海淀片区', '顺平片区', '河北片区', '辽宁片区']
const centerForIndex = (index: number) => index === 0
  ? '第一服务北京万国城MOMΛ服务中心'
  : index === 4
    ? withdrawnCenter
    : `第一服务每日趋势${index + 1}服务中心`

const [{ default: express }, { default: db }, { default: trendsRouter }, { signToken }] = await Promise.all([
  import('express'),
  import('../src/db.js'),
  import('../src/routes/trends.js'),
  import('../src/auth.js'),
])

function insertFormalBatch(businessDate: string, rate: number, marker: string) {
  const batchId = Number(db.prepare(`INSERT INTO data_ingestion_batches
    (source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,
     publishable,row_count,mapped_count,unmapped_count,validation_errors,summary,published_by,published_at)
    VALUES('daily-trend-test',?,?,?,'[]',?,'published',1,36,35,0,'[]','{}','tester',?)`)
    .run(businessDate, `${businessDate}T09:00:00+08:00`, marker.repeat(64), root, `${businessDate}T10:00:00+08:00`).lastInsertRowid)
  const insertRow = db.prepare(`INSERT INTO data_ingestion_rows
    (batch_id,entity_type,source_key,canonical_key,mapping_method,change_type,changed_fields,payload)
    VALUES(?,?,?,?, 'exact','snapshot','[]',?)`)
  insertRow.run(batchId, 'payment_center', `payment-${marker}`, `payment-${marker}`, JSON.stringify({
    center: `回款${marker}`, area: '朝阳片区', annual_budget: 1, cumulative_budget: 1, cumulative_executed: 1,
  }))
  for (let index = 0; index < 35; index += 1) {
    const center = centerForIndex(index)
    insertRow.run(batchId, 'collection_center', `${center}-${marker}`, `${center}-${marker}`, JSON.stringify({
      center,
      area: areas[index % areas.length],
      receivable: 100,
      received: index === 0 ? 50 : index === 4 ? 10 : 100 * rate,
      collectionRate: index === 4 ? 0.1 : rate,
    }))
  }
  db.prepare(`INSERT INTO data_ingestion_publications
    (batch_id,business_date,backup_payload,backup_sha256,payment_rows,snapshot_rows,collection_rows,published_by,published_at)
    VALUES(?,?, '{}',?,1,0,35,'tester',?)`)
    .run(batchId, businessDate, marker.toUpperCase().repeat(64), `${businessDate}T10:00:00+08:00`)
  return batchId
}

insertFormalBatch('2026-08-26', 0.80, 'a')
const latestSameDay = insertFormalBatch('2026-08-26', 0.82, 'b')
insertFormalBatch('2026-08-27', 0.90, 'c')
const nextWeek = insertFormalBatch('2026-09-01', 0.92, 'd')
const profileBatch = Number(db.prepare(`INSERT INTO project_profile_import_batches
  (source_file,source_sha256,source_sheet,filter_status,profile_count,phase_count)
  VALUES('trend-scope.xlsx',?,'项目','在管',35,0)`).run('e'.repeat(64)).lastInsertRowid)
const insertProfile = db.prepare(`INSERT INTO project_profiles
  (batch_id,service_center,area,management_status,property_type,source_rows_json)
  VALUES(?,?,?,'在管','住宅','[]')`)
for (let index = 0; index < 35; index += 1) {
  insertProfile.run(profileBatch, centerForIndex(index), areas[index % areas.length])
}

const masterChangeId = Number(db.prepare(`INSERT INTO service_center_master_changes
  (center_key,service_center,action_type,previous_area,new_area,previous_status,new_status,effective_date,reason,evidence,reconciliation_json,created_by_name)
  VALUES(?,?,'withdraw','河北片区','撤场项目','在管','已撤场','2026-08-27','趋势测试撤场','','{}','tester')`)
  .run(withdrawnCenter.normalize('NFKC').replace(/\s+/g, ''), withdrawnCenter).lastInsertRowid)

const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  const scope = String(req.headers['x-test-scope'] || 'admin')
  ;(req as any).user = scope === 'hq'
    ? { role: 'hq_function', username: 'hq', serviceCenterScope: '华北地区公司本部职能' }
    : scope === 'area'
      ? { role: 'area_manager', username: 'area', areaScope: '河北片区', serviceCenterScope: '' }
      : scope === 'viewer'
        ? { role: 'viewer', username: 'viewer', serviceCenterScope: viewerCenter }
        : scope === 'invalid'
          ? { role: 'viewer', username: 'invalid', serviceCenterScope: '' }
          : { role: 'admin', username: 'tester' }
  next()
})
app.use(trendsRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('每日趋势测试服务启动失败')
const base = `http://127.0.0.1:${address.port}`
const admin = db.prepare("SELECT id,username FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any
const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('收缴率历史趋势按正式业务日期逐日返回且同日只取最新批次', async () => {
  const response = await fetch(`${base}/api/collection-trends/daily`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(response.status, 200)
  const rows = await response.json() as any[]
  assert.deepEqual(rows.map(row => row.m), ['2026-08-26', '2026-08-27', '2026-09-01'])
  assert.equal(rows[0]['华北汇总'], (33 * 0.82 + 0.5 + 0.1) / 35)
  assert.equal(rows[1]['华北汇总'], (33 * 0.9 + 0.5 + 0.1) / 35)
  assert.ok(Math.abs(rows[0]['朝阳片区'] - ((5 * 0.82 + 0.5) / 6)) < 1e-12)
  assert.ok(Math.abs(rows[0]['河北片区'] - ((5 * 0.82 + 0.1) / 6)) < 1e-12)
  assert.equal(rows[1]['河北片区'], 0.9)
  assert.equal(rows[0]['撤场项目'], undefined)
  assert.equal(rows[1]['撤场项目'], 0.1)
  assert.deepEqual(rows[0].field_provenance.serviceCenterMasterChangeIds, [])
  assert.deepEqual(rows[1].field_provenance.serviceCenterMasterChangeIds, [masterChangeId])
  assert.equal(rows[0].field_provenance.batchId, latestSameDay)
  assert.equal(rows[0].field_provenance.methodology, 'official-project-rate-weighted-with-heating-adjustments')
  assert.equal(rows[0].quality_status, 'verified')
  assert.equal(rows[0].source_status, 'published')
})

test('周度收缴趋势按自然周取最后一个已发布业务日且不累计日数据', async () => {
  const response = await fetch(`${base}/api/collection-trends/weekly`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(response.status, 200)
  const rows = await response.json() as any[]
  assert.deepEqual(rows.map(row => row.m), ['08-24~08-30', '08-31~09-06'])
  assert.deepEqual(rows.map(row => row.snapshot_business_date), ['2026-08-27', '2026-09-01'])
  assert.deepEqual(rows.map(row => row.week_start), ['2026-08-24', '2026-08-31'])
  assert.deepEqual(rows.map(row => row.week_end), ['2026-08-30', '2026-09-06'])
  assert.ok(Math.abs(rows[0]['华北汇总'] - ((33 * 0.9 + 0.5 + 0.1) / 35)) < 1e-12)
  assert.ok(Math.abs(rows[1]['华北汇总'] - ((33 * 0.92 + 0.5 + 0.1) / 35)) < 1e-12)
  assert.equal(rows[0]['河北片区'], 0.9)
  assert.equal(rows[1]['河北片区'], 0.92)
  assert.equal(rows[0]['撤场项目'], 0.1)
  assert.equal(rows[1]['撤场项目'], 0.1)
  assert.equal(rows[1].field_provenance.batchId, nextWeek)
  assert.equal(rows[1].field_provenance.weeklyMethodology, 'latest-published-business-date-in-natural-week')
})

test('收缴趋势按账号服务中心授权范围返回且不泄露未授权片区', async () => {
  const fetchWeekly = async (scope: string) => {
    const response = await fetch(`${base}/api/collection-trends/weekly`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Test-Scope': scope },
    })
    return { response, rows: response.status === 200 ? await response.json() as any[] : [] }
  }

  const hq = await fetchWeekly('hq')
  assert.equal(hq.response.status, 200)
  assert.equal(hq.rows.at(-1)['华北汇总'] !== undefined, true)
  assert.equal(hq.rows.at(-1)['授权汇总'], undefined)
  assert.equal(hq.rows.at(-1).field_provenance.includedRowCount, 35)
  assert.deepEqual(hq.rows.at(-1).field_provenance.serviceCenterMasterChangeIds, [masterChangeId])

  const area = await fetchWeekly('area')
  assert.equal(area.response.status, 200)
  assert.equal(area.rows.at(-1)['华北汇总'], undefined)
  assert.equal(area.rows.at(-1)['朝阳片区'], undefined)
  assert.equal(area.rows.at(-1)['河北片区'], 0.92)
  assert.equal(area.rows.at(-1)['授权汇总'], 0.92)
  assert.equal(area.rows.at(-1).field_provenance.includedRowCount, 5)
  assert.deepEqual(area.rows.at(-1).field_provenance.serviceCenterMasterChangeIds, [])

  const viewer = await fetchWeekly('viewer')
  assert.equal(viewer.response.status, 200)
  assert.equal(viewer.rows.at(-1)['华北汇总'], undefined)
  assert.equal(viewer.rows.at(-1)['河北片区'], 0.92)
  assert.equal(viewer.rows.at(-1)['授权汇总'], 0.92)
  assert.equal(viewer.rows.at(-1).field_provenance.includedRowCount, 1)
  assert.deepEqual(viewer.rows.at(-1).field_provenance.serviceCenterMasterChangeIds, [])

  const invalid = await fetchWeekly('invalid')
  assert.equal(invalid.response.status, 403)
})

test('历史收缴归档必须经过预览、人工确认发布和读取时哈希复验', async () => {
  const sourceDir = path.join(root, 'historical-sources', '2026-08-16')
  fs.mkdirSync(sourceDir, { recursive: true })
  const sourcePath = path.join(sourceDir, '绿仔收缴明细.json')
  const areas = ['朝阳片区', '京东片区', '海淀片区', '顺平片区', '河北片区', '辽宁片区']
  const sourcePayload = {
    extractedAt: '2026-08-17T09:32:55.439657',
    date: '2026-08-16',
    businessDate: '2026-08-16',
    rows: Array.from({ length: 35 }, (_, index) => ({
      center: `第一服务历史补录${String(index + 1).padStart(2, '0')}服务中心`,
      area: areas[index % areas.length], receivable: 100, received: 70, outstanding: 30, collectionRate: 0.7,
    })),
  }
  fs.writeFileSync(sourcePath, JSON.stringify(sourcePayload))

  const previewResponse = await fetch(`${base}/api/collection-trends/historical-backfills/preview`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessDate: '2026-08-16', sourcePath }),
  })
  assert.equal(previewResponse.status, 200, await previewResponse.clone().text())
  const preview = await previewResponse.json() as any
  assert.equal(preview.backfill.status, 'previewed')
  assert.equal(preview.backfill.row_count, 35)
  assert.equal(preview.values['华北汇总'], 0.7)

  const blocked = await fetch(`${base}/api/collection-trends/historical-backfills/${preview.backfill.id}/publish`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmation: '确认', confirmNote: '确认补录历史收缴趋势归档' }),
  })
  assert.equal(blocked.status, 400)

  const publishResponse = await fetch(`${base}/api/collection-trends/historical-backfills/${preview.backfill.id}/publish`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmation: '确认发布历史收缴趋势补录', confirmNote: '用户明确确认补录2026-08-16历史收缴归档' }),
  })
  assert.equal(publishResponse.status, 200, await publishResponse.clone().text())
  const published = await publishResponse.json() as any
  assert.equal(published.backfill.status, 'published')

  const weeklyResponse = await fetch(`${base}/api/collection-trends/weekly`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(weeklyResponse.status, 200)
  const weekly = await weeklyResponse.json() as any[]
  assert.deepEqual(weekly.map(row => row.m), ['08-10~08-16', '08-24~08-30', '08-31~09-06'])
  assert.equal(weekly[0].source, 'lvzai-verified-historical-archive')
  assert.equal(weekly[0]['华北汇总'], 0.7)

  const archived = fs.readFileSync(preview.backfill.archive_path)
  fs.appendFileSync(preview.backfill.archive_path, ' ')
  const tampered = await fetch(`${base}/api/collection-trends/weekly`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(tampered.status, 409)
  fs.writeFileSync(preview.backfill.archive_path, archived)
})
