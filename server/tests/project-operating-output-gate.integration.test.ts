import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import express from 'express'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-project-output-gate-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'project-output-gate-shadow-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'

const [
  { default: db },
  { default: projectsRouter },
  { default: projectProfilesRouter },
  { default: aiRouter },
  { default: forecastsRouter },
  { default: formalOutputsRouter },
  { default: exportRouter },
  { requireAuth, signToken },
] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/projects.js'),
  import('../src/routes/project-profiles.js'),
  import('../src/routes/ai.js'),
  import('../src/routes/forecasts.js'),
  import('../src/routes/formal-outputs.js'),
  import('../src/routes/export.js'),
  import('../src/auth.js'),
])

const DIRECTORY_COUNT = 42
const UNMATCHED_PROJECT = '易水名苑'
const SERVICE_CENTER_SENTINEL = 987654321

type SourceEvidence = {
  linkStatus: string
  paymentCenters: string[]
  collectionCenters: string[]
  operatingFactsAvailable: boolean
}
type ResponseRow = {
  id?: number
  name?: string
  service_center?: string
  validation_status?: string
  dataAvailability?: { operatingFactsAvailable: boolean }
  sourceEvidence?: SourceEvidence
  [key: string]: unknown
}
type ResponsePayload = {
  code?: string
  dataQuality?: {
    projectCount?: number
    directoryOnlyProjectCount?: number
    copiedSnapshotProjectCount?: number
  }
  rows?: ResponseRow[]
  total?: number
  profile?: ResponseRow
}

const profileBatch = Number(db.prepare(`INSERT INTO project_profile_import_batches
  (source_file,source_sha256,source_sheet,filter_status,profile_count,phase_count)
  VALUES('project-master-20260326.xlsx',?,'项目','在管',?,0)`)
  .run('d'.repeat(64), DIRECTORY_COUNT).lastInsertRowid)
const insertProfile = db.prepare(`INSERT INTO project_profiles
  (batch_id,service_center,area,management_status,property_type,managed_area,movedin_units,source_rows_json)
  VALUES(?,?,?,'在管','住宅',?,?,?)`)
const insertProject = db.prepare(`INSERT INTO projects
  (area,name,area_sqm,units,property_type,annual_income,annual_cost,ytd_income,ytd_cost,
   receivable,received,official_collection_rate,quality_score,safety_incidents,
   customer_satisfaction,complaint_count,project_code,source_system,source_project_id,
   active_status,validation_status,source_batch,field_provenance)
  VALUES(?,?,?,?,?,NULL,NULL,NULL,NULL,?,?,?,NULL,NULL,NULL,NULL,?,'project_profiles',?,
    'active','directory_only',?,?)`)
const insertLink = db.prepare(`INSERT INTO project_profile_center_links
  (batch_id,profile_id,source_system,source_center,link_method)
  VALUES(?,?,'payment',?,'exact')`)

for (let index = 0; index < DIRECTORY_COUNT; index += 1) {
  const name = index === DIRECTORY_COUNT - 1 ? UNMATCHED_PROJECT : `第一服务权威项目目录${String(index + 1).padStart(2, '0')}`
  const area = ['朝阳片区', '京东片区', '海淀片区', '顺平片区', '河北片区', '辽宁片区'][index % 6]
  const profileId = Number(insertProfile.run(profileBatch, name, area, 1000 + index, 100 + index, JSON.stringify([index + 2])).lastInsertRowid)
  const hasServiceCenterFacts = index < 32
  insertProject.run(
    area,
    name,
    1000 + index,
    100 + index,
    '住宅',
    hasServiceCenterFacts ? SERVICE_CENTER_SENTINEL + index : null,
    hasServiceCenterFacts ? 800000000 + index : null,
    hasServiceCenterFacts ? 0.8 : null,
    `DIR-${profileId}`,
    String(profileId),
    `project-profile:${profileBatch}:${'d'.repeat(64)}`,
    JSON.stringify({ state: 'directory_only', source: { table: 'project_profiles', profileId } }),
  )
  if (name !== UNMATCHED_PROJECT) insertLink.run(profileBatch, profileId, name)
}

assert.equal(Number((db.prepare('SELECT COUNT(*) count FROM projects').get() as { count: number }).count), DIRECTORY_COUNT)
assert.equal(Number((db.prepare('SELECT COUNT(*) count FROM project_monthly_snapshots').get() as { count: number }).count), 0)

const admin = db.prepare("SELECT id,username FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as { id: number; username: string }
const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })
const app = express()
app.use(express.json())
app.use(requireAuth)
app.use(projectsRouter)
app.use(projectProfilesRouter)
app.use(aiRouter)
app.use(forecastsRouter)
app.use(formalOutputsRouter)
app.use(exportRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  if (server.listening) return resolve()
  server.once('listening', resolve)
  server.once('error', reject)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('项目经营输出门禁测试端口未绑定')
const baseUrl = `http://127.0.0.1:${address.port}`

async function request(pathname: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let payload: ResponsePayload = {}
  try { payload = JSON.parse(text) as ResponsePayload } catch {}
  return { response, text, payload }
}

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('42条directory_only且0项目月快照时，项目经营输出旁路全部409 JSON失败关闭', async () => {
  const operatingOutputs: Array<[string, string, unknown?]> = [
    ['/api/ai/trends', 'GET'],
    ['/api/ai/risk-trends', 'GET'],
    ['/api/ai/health', 'GET'],
    ['/api/alerts', 'GET'],
    ['/api/ai/monthly-report', 'GET'],
    ['/api/ai/brief', 'GET'],
    ['/api/ai/week-focus', 'GET'],
    ['/api/ai/project/1/diagnosis', 'GET'],
    ['/api/ai/ask', 'POST', { question: '项目经营怎么样' }],
    ['/api/ai/interpret', 'POST', { type: 'project', data: { id: 1 } }],
    ['/api/forecasts?month=2026-08&area=华北', 'GET'],
    ['/api/formal-outputs/generate', 'POST', { type: 'monthly', area: '华北', period: '2026-08' }],
    ['/api/export/projects-csv', 'GET'],
  ]

  for (const [pathname, method, body] of operatingOutputs) {
    const blocked = await request(pathname, method, body)
    assert.equal(blocked.response.status, 409, `${pathname}应409：${blocked.text}`)
    assert.match(blocked.response.headers.get('content-type') || '', /^application\/json\b/i, `${pathname}必须返回JSON`)
    assert.equal(blocked.payload.code, 'PROJECT_DATA_QUALITY_BLOCKED', pathname)
    assert.equal(blocked.payload.dataQuality?.projectCount, DIRECTORY_COUNT, pathname)
    assert.equal(blocked.payload.dataQuality?.directoryOnlyProjectCount, DIRECTORY_COUNT, pathname)
    assert.equal(blocked.payload.dataQuality?.copiedSnapshotProjectCount, 0, pathname)
    assert.equal(blocked.text.includes(String(SERVICE_CENTER_SENTINEL)), false, `${pathname}不得输出服务中心金额`)
  }

  const csv = await request('/api/export/projects-csv')
  assert.equal(csv.response.headers.has('content-disposition'), false, '门禁失败不得生成CSV附件')
  assert.equal(csv.text.startsWith('\uFEFF'), false, '门禁失败不得生成CSV BOM')
})

test('42条权威目录仍可读，但易水名苑保持unmatched、0链路且经营值为null', async () => {
  const projects = await request('/api/projects')
  assert.equal(projects.response.status, 200, projects.text)
  assert.equal(projects.payload.rows?.length, DIRECTORY_COUNT)
  const project = projects.payload.rows?.find(row => row.name === UNMATCHED_PROJECT)
  assert.ok(project)
  assert.equal(project.validation_status, 'directory_only')
  for (const field of [
    'annual_income', 'annual_cost', 'ytd_income', 'ytd_cost', 'receivable', 'received',
    'official_collection_rate', 'quality_score', 'safety_incidents', 'customer_satisfaction', 'complaint_count',
  ]) assert.equal(project[field], null, `${field}必须为null`)
  assert.equal(project.dataAvailability?.operatingFactsAvailable, false)

  const profiles = await request('/api/project-profiles')
  assert.equal(profiles.response.status, 200, profiles.text)
  assert.equal(profiles.payload.total, DIRECTORY_COUNT)
  const profile = profiles.payload.rows?.find(row => row.service_center === UNMATCHED_PROJECT)
  assert.ok(profile)
  assert.equal(profile.sourceEvidence?.linkStatus, 'unmatched')
  assert.deepEqual(profile.sourceEvidence?.paymentCenters, [])
  assert.deepEqual(profile.sourceEvidence?.collectionCenters, [])
  assert.equal(profile.sourceEvidence?.operatingFactsAvailable, false)
  assert.equal('operating' in profile, false)

  const detail = await request(`/api/project-profiles/${profile.id}`)
  assert.equal(detail.response.status, 200, detail.text)
  assert.equal(detail.payload.profile?.sourceEvidence?.linkStatus, 'unmatched')
  assert.equal((detail.payload.profile?.sourceEvidence?.paymentCenters.length || 0)
    + (detail.payload.profile?.sourceEvidence?.collectionCenters.length || 0), 0)
  assert.equal(detail.payload.profile ? 'operating' in detail.payload.profile : false, false)
})
