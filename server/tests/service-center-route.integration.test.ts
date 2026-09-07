import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-service-centers-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'service-centers-contract-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'

const [{ default: db }, { default: aiRouter }, { default: operatingCapabilitiesRouter }, { requireAuth, signToken }] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/ai.js'),
  import('../src/routes/operating-capabilities.js'),
  import('../src/auth.js'),
])

const app = express()
app.use(express.json())
app.use(requireAuth)
app.use(aiRouter)
app.use(operatingCapabilitiesRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  if (server.listening) return resolve()
  server.once('listening', resolve)
  server.once('error', reject)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('服务中心契约测试端口未绑定')
const baseUrl = `http://127.0.0.1:${address.port}`

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

function tokenFor(username: string, role: any, serviceCenterScope = '', areaScope = '', projectScope = '') {
  const result = db.prepare(`INSERT INTO users(username,password_hash,role,area_scope,project_scope,service_center_scope)
    VALUES(?,?,?,?,?,?)`).run(username, 'unused-test-hash', role, areaScope, projectScope, serviceCenterScope)
  return signToken({ userId: Number(result.lastInsertRowid), username, role, areaScope, projectScope, serviceCenterScope })
}

const businessDate = new Date().toISOString().slice(0, 10)
const extractedAt = new Date().toISOString()

function seedServiceCenters() {
  db.prepare('DELETE FROM payment_centers').run()
  db.prepare('DELETE FROM daily_snapshots').run()
  const payment = db.prepare(`INSERT INTO payment_centers
    (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
    VALUES(?,?,?,?,?,?,NULL)`)
  const daily = db.prepare(`INSERT INTO daily_snapshots
    (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,quality_status,source,source_status,business_date,last_validated_at)
    VALUES(?,?,?,?,?,?,'verified','FineReport三报表中心明细','available',?,?)`)
  const names: string[] = []
  for (let index = 1; index <= 56; index += 1) {
    const area = index <= 28 ? '朝阳片区' : '河北片区'
    const center = `第一服务路由测试·${String(index).padStart(2, '0')}服务中心`
    names.push(center)
    payment.run(area, center, 200, 100, index === 1 ? 80 : 110, 100)
    if (index < 56) daily.run(businessDate, center, 200, 100, 110, index === 2 ? 0 : 1, businessDate, extractedAt)
  }

  const profileBatch = Number(db.prepare(`INSERT INTO project_profile_import_batches
    (source_file,source_sha256,source_sheet,filter_status,profile_count,phase_count)
    VALUES('service-center-route.xlsx',?,'项目','在管',56,0)`).run('a'.repeat(64)).lastInsertRowid)
  const profile = db.prepare(`INSERT INTO project_profiles
    (batch_id,service_center,area,management_status,property_type,source_rows_json)
    VALUES(?,?,?,'在管','住宅','[]')`)
  names.forEach((center, index) => profile.run(profileBatch, center, index < 28 ? '朝阳片区' : '河北片区'))

  const summary = JSON.stringify({
    totals: { after: { collection_rate: 0.75, collection_receivable: 3500, collection_received: 2625 } },
  })
  const batch = db.prepare(`INSERT INTO data_ingestion_batches
    (source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,publishable,row_count,mapped_count,unmapped_count,validation_errors,summary,published_by,published_at)
    VALUES('aph-finereport-lvzai',?,?,?,'[]','/controlled/archive','published',1,56,35,0,'[]',?,'route-test',?)`)
    .run(businessDate, extractedAt, 'f'.repeat(64), summary, extractedAt)
  const batchId = Number(batch.lastInsertRowid)
  db.prepare(`INSERT INTO data_ingestion_publications
    (batch_id,business_date,backup_payload,backup_sha256,payment_rows,snapshot_rows,collection_rows,published_by,published_at)
    VALUES(?,?,'{}',?,56,55,35,'route-test',?)`).run(batchId, businessDate, 'e'.repeat(64), extractedAt)
  const ingest = db.prepare(`INSERT INTO data_ingestion_rows
    (batch_id,entity_type,source_key,canonical_key,mapping_method,change_type,changed_fields,payload)
    VALUES(?,'collection_center',?,?,'official-35','snapshot','[]',?)`)
  for (let index = 0; index < 35; index += 1) {
    const canonical = names[index]
    const sourceName = canonical.replace('·', '')
    ingest.run(batchId, sourceName, canonical, JSON.stringify({
      area: index < 28 ? '朝阳片区' : '河北片区',
      center: sourceName,
      receivable: 100,
      received: 75,
      collectionRate: index === 0 ? 0.75 : 0.85,
      source: '绿仔正式收缴明细',
    }))
  }
  const ingestOther = db.prepare(`INSERT INTO data_ingestion_rows
    (batch_id,entity_type,source_key,canonical_key,mapping_method,change_type,changed_fields,payload)
    VALUES(?,?,?,?, 'exact','snapshot','[]',?)`)
  names.forEach((center, index) => {
    ingestOther.run(batchId, 'payment_center', center, center, JSON.stringify({ center, area: index < 28 ? '朝阳片区' : '河北片区' }))
    if (index < 55) ingestOther.run(batchId, 'daily_snapshot', `${businessDate}:${center}`, center, JSON.stringify({ center, date: businessDate }))
  })
  return names
}

const expectedNames = seedServiceCenters()
const admin = db.prepare("SELECT id,username,role,token_version FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any
const adminToken = signToken({ userId: admin.id, username: admin.username, role: 'admin' })
const areaToken = tokenFor('service-center-area-manager', 'area_manager', '', '朝阳片区')
const projectToken = tokenFor('service-center-project-manager', 'project_manager', expectedNames[1], '', '1')
const viewerToken = tokenFor('service-center-viewer', 'viewer', expectedNames[2])
const unassignedToken = tokenFor('service-center-unassigned', 'viewer')

test('新端点不受旧projects门禁影响，只读返回56个APH中心和溯源证据', async () => {
  const writesBefore = db.totalChanges
  const response = await fetch(`${baseUrl}/api/ai/service-centers`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  assert.equal(response.status, 200)
  const payload = await response.json() as any
  assert.equal(payload.summary.total, 56)
  assert.equal(payload.rows.length, 56)
  assert.deepEqual(new Set(payload.rows.map((row: any) => row.center)), new Set(expectedNames))
  assert.equal(new Set(payload.rows.map((row: any) => row.id)).size, 56)
  assert.equal(payload.businessDate, businessDate)
  assert.equal(payload.publicationStatus, 'partial')
  assert.equal(payload.credibility.status, 'partial')
  assert.equal(payload.credibility.payment, 'verified')
  assert.equal(payload.credibility.daily, 'verified')
  assert.equal(payload.coverage.paymentCenters, 56)
  assert.equal(payload.coverage.dailyCenters, 55)
  assert.equal(payload.collectionPublicationStatus, 'published')
  assert.equal(payload.rows.find((row: any) => row.center === expectedNames[1]).metrics.dailyCollection, 0)
  assert.equal(payload.rows.find((row: any) => row.center === expectedNames[55]).metrics.dailyCollection, null)
  for (const row of payload.rows) {
    for (const evidence of [row.evidence.payment, row.evidence.daily, row.evidence.officialCollection].filter(Boolean)) {
      assert.deepEqual(Object.keys(evidence).sort(), ['businessDate', 'lastValidatedAt', 'methodology', 'rule', 'source'])
    }
  }
  assert.equal(db.totalChanges, writesBefore)

  const oldEndpoint = await fetch(`${baseUrl}/api/ai/trends`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  assert.equal(oldEndpoint.status, 409)
})

test('片区经理、项目经理与一线成员分别按当前授权模型读取中心', async () => {
  const scoped = await fetch(`${baseUrl}/api/ai/service-centers`, {
    headers: { Authorization: `Bearer ${areaToken}` },
  })
  assert.equal(scoped.status, 200)
  const scopedPayload = await scoped.json() as any
  assert.equal(scopedPayload.summary.total, 28)
  assert.deepEqual(scopedPayload.rows.map((row: any) => row.center), expectedNames.slice(0, 28))

  const unmappedProjectManager = await fetch(`${baseUrl}/api/ai/service-centers`, {
    headers: { Authorization: `Bearer ${projectToken}` },
  })
  assert.equal(unmappedProjectManager.status, 200)
  assert.deepEqual((await unmappedProjectManager.json() as any).rows.map((row: any) => row.center), [expectedNames[1]])

  const viewer = await fetch(`${baseUrl}/api/ai/service-centers`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  })
  assert.equal(viewer.status, 200)
  assert.deepEqual((await viewer.json() as any).rows.map((row: any) => row.center), [expectedNames[2]])

  const unassigned = await fetch(`${baseUrl}/api/ai/service-centers`, {
    headers: { Authorization: `Bearer ${unassignedToken}` },
  })
  assert.equal(unassigned.status, 401)
})

test('运行时能力清单按权限返回双来源能力，不把项目目录当经营事实', async () => {
  const adminResponse = await fetch(`${baseUrl}/api/operating-capabilities`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  assert.equal(adminResponse.status, 200)
  const adminPayload = await adminResponse.json() as any
  assert.equal(adminPayload.status, 'partial')
  assert.equal(adminPayload.sources.aph.paymentCenterCount, 56)
  assert.equal(adminPayload.sources.aph.verifiedDailyCenterCount, 55)
  assert.equal(adminPayload.sources.aph.status, 'partial')
  assert.equal(adminPayload.sources.lvzai.centerCount, 35)
  assert.equal(adminPayload.presentationPolicy.showProjectOperatingMetrics, false)
  assert.equal(adminPayload.meta.permissions.write, false)

  const scopedResponse = await fetch(`${baseUrl}/api/operating-capabilities`, {
    headers: { Authorization: `Bearer ${areaToken}` },
  })
  assert.equal(scopedResponse.status, 200)
  const scopedPayload = await scopedResponse.json() as any
  assert.equal(scopedPayload.sources.aph.paymentCenterCount, 28)
  assert.equal(scopedPayload.sources.aph.verifiedDailyCenterCount, 28)
  assert.equal(scopedPayload.sources.lvzai.centerCount, 28)
  assert.deepEqual(scopedPayload.meta.scope.serviceCenterScope, [])
  assert.deepEqual(scopedPayload.meta.scope.areaScope, ['朝阳片区'])

  const unassignedResponse = await fetch(`${baseUrl}/api/operating-capabilities`, {
    headers: { Authorization: `Bearer ${unassignedToken}` },
  })
  assert.equal(unassignedResponse.status, 401)
})

test('运行时能力清单不能用新验证时间掩盖陈旧APH业务日期', async () => {
  db.prepare("UPDATE daily_snapshots SET business_date='2026-01-01',date='2026-01-01',last_validated_at=?").run(extractedAt)
  try {
    const response = await fetch(`${baseUrl}/api/operating-capabilities`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert.equal(response.status, 200)
    const payload = await response.json() as any
    assert.equal(payload.sources.aph.status, 'stale')
    assert.equal(payload.supportedMetrics.filter((metric: any) => metric.source === 'APH').every((metric: any) => !metric.available), true)
  } finally {
    db.prepare('UPDATE daily_snapshots SET business_date=?,date=?,last_validated_at=?').run(businessDate, businessDate, extractedAt)
  }
})

test('运行时能力清单对任一APH中心的空、非法、未来或陈旧验证时间失败关闭', async () => {
  db.prepare(`INSERT INTO daily_snapshots
    (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,quality_status,source,source_status,business_date,last_validated_at)
    VALUES(?,?,?,?,?,?,'verified','FineReport三报表中心明细','available',?,?)`)
    .run(businessDate, expectedNames[55], 200, 100, 110, 1, businessDate, extractedAt)
  const cases: Array<[string, string | null]> = [
    ['空验证时间', null],
    ['非法验证时间', 'not-an-iso-time'],
    ['未来验证时间', new Date(Date.now() + 60 * 60 * 1000).toISOString()],
    ['陈旧验证时间', new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString()],
  ]
  try {
    for (const [label, value] of cases) {
      db.prepare('UPDATE daily_snapshots SET last_validated_at=? WHERE center=?').run(value, expectedNames[0])
      const response = await fetch(`${baseUrl}/api/operating-capabilities`, {
        headers: { Authorization: ['Bearer', adminToken].join(' ') },
      })
      assert.equal(response.status, 200, label)
      const payload = await response.json() as any
      assert.notEqual(payload.sources.aph.status, 'ready', label)
      assert.equal(payload.sources.aph.coverageComplete, true, `${label}不能依赖覆盖不全旁路证明失败`)
      assert.equal(payload.sources.aph.verifiedDailyCenterCount, 56, `${label}保留原始验证记录计数`)
      assert.equal(payload.supportedMetrics.filter((metric: any) => metric.source === 'APH').every((metric: any) => !metric.available), true, label)
    }
  } finally {
    db.prepare('UPDATE daily_snapshots SET last_validated_at=? WHERE center=?').run(extractedAt, expectedNames[0])
    db.prepare('DELETE FROM daily_snapshots WHERE center=?').run(expectedNames[55])
  }
})

test('运行时能力清单对任一APH中心的空、非法或未来业务日期失败关闭', async () => {
  db.prepare(`INSERT INTO daily_snapshots
    (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,quality_status,source,source_status,business_date,last_validated_at)
    VALUES(?,?,?,?,?,?,'verified','FineReport三报表中心明细','available',?,?)`)
    .run(businessDate, expectedNames[55], 200, 100, 110, 1, businessDate, extractedAt)
  const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const cases: Array<[string, string, string]> = [
    ['空业务日期', '', ''],
    ['非法业务日期', 'not-a-date', 'not-a-date'],
    ['未来业务日期', futureDate, futureDate],
  ]
  try {
    for (const [label, date, sourceDate] of cases) {
      db.prepare('UPDATE daily_snapshots SET business_date=?,date=? WHERE center=?').run(sourceDate, date, expectedNames[0])
      const response = await fetch(`${baseUrl}/api/operating-capabilities`, {
        headers: { Authorization: ['Bearer', adminToken].join(' ') },
      })
      assert.equal(response.status, 200, label)
      const payload = await response.json() as any
      assert.notEqual(payload.sources.aph.status, 'ready', label)
      assert.equal(payload.supportedMetrics.filter((metric: any) => metric.source === 'APH').every((metric: any) => !metric.available), true, label)
      db.prepare('UPDATE daily_snapshots SET business_date=?,date=? WHERE center=?').run(businessDate, businessDate, expectedNames[0])
    }
  } finally {
    db.prepare('UPDATE daily_snapshots SET business_date=?,date=? WHERE center=?').run(businessDate, businessDate, expectedNames[0])
    db.prepare('DELETE FROM daily_snapshots WHERE center=?').run(expectedNames[55])
  }
})

test('运行时能力清单按规范中心唯一键集合校验APH覆盖，重复中心不能掩盖缺失中心', async () => {
  db.prepare(`INSERT INTO daily_snapshots
    (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,quality_status,source,source_status,business_date,last_validated_at)
    VALUES(?,?,?,?,?,?,'verified','FineReport三报表中心明细','available',?,?)`)
    .run(businessDate, `${expectedNames[0]} `, 200, 100, 110, 1, businessDate, extractedAt)
  try {
    const response = await fetch(`${baseUrl}/api/operating-capabilities`, {
      headers: { Authorization: ['Bearer', adminToken].join(' ') },
    })
    assert.equal(response.status, 200)
    const payload = await response.json() as {
      sources: { aph: { paymentCenterCount: number; verifiedDailyCenterCount: number; status: string } }
    }
    assert.equal(payload.sources.aph.paymentCenterCount, 56)
    assert.equal(payload.sources.aph.verifiedDailyCenterCount, 55)
    assert.equal(payload.sources.aph.status, 'partial')
  } finally {
    db.prepare(`DELETE FROM daily_snapshots
      WHERE id=(SELECT MAX(id) FROM daily_snapshots WHERE center=?)`).run(`${expectedNames[0]} `)
  }
})

test('运行时能力清单要求payment和daily原始行数均等于规范唯一数，等量重复集合也绝不能ready', async () => {
  const originalPayment = expectedNames[55]
  const duplicateVariant = expectedNames[0].replace('第一服务', '第一 服务').replace('·', '•')
  db.prepare('UPDATE payment_centers SET center=? WHERE center=?').run(duplicateVariant, originalPayment)
  db.prepare(`INSERT INTO daily_snapshots
    (date,center,annual_budget,cumulative_budget,cumulative_executed,daily_collection,quality_status,source,source_status,business_date,last_validated_at)
    VALUES(?,?,?,?,?,?,'verified','FineReport三报表中心明细','available',?,?)`)
    .run(businessDate, duplicateVariant, 200, 100, 110, 1, businessDate, extractedAt)
  try {
    const writesBefore = db.totalChanges
    const response = await fetch(`${baseUrl}/api/operating-capabilities`, {
      headers: { Authorization: ['Bearer', adminToken].join(' ') },
    })
    assert.equal(response.status, 200)
    const payload = await response.json() as any
    assert.equal(payload.sources.aph.paymentCenterCount, 56)
    assert.equal(payload.sources.aph.verifiedDailyCenterCount, 56)
    assert.equal(payload.sources.aph.coverageComplete, false)
    assert.notEqual(payload.sources.aph.status, 'ready')
    assert.equal(payload.supportedMetrics.filter((metric: any) => metric.source === 'APH').every((metric: any) => !metric.available), true)
    assert.equal(db.totalChanges, writesBefore, '能力接口必须保持只读')
  } finally {
    db.prepare('DELETE FROM daily_snapshots WHERE center=?').run(duplicateVariant)
    db.prepare('UPDATE payment_centers SET center=? WHERE center=?').run(originalPayment, duplicateVariant)
  }
})
