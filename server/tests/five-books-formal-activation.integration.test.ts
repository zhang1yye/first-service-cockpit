import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-five-books-formal-')))
const standardPath = path.join(repositoryRoot,
  'production-overlays/cockpit-r128-screenshot-distillation-20260826-v1/payload/five-books-standard-pm5-xx-68-v1.js')
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.COCKPIT_FIVE_BOOKS_DATA_DIR = path.join(root, 'five-books')
process.env.COCKPIT_FIVE_BOOKS_STANDARD_PATH = standardPath
process.env.JWT_SECRET = 'five-books-formal-activation-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'

const [{ default: express }, { default: db }, { default: fiveBooks }, auth] = await Promise.all([
  import('express'),
  import('../src/db.js'),
  import('../src/routes/five-books.js'),
  import('../src/auth.js'),
])

const centerA = '第一服务五书甲服务中心'
const centerB = '第一服务五书乙服务中心'
const projectA = Number(db.prepare(`INSERT INTO projects(area,name,property_type,active_status,project_code)
  VALUES('朝阳片区',?,'住宅','active','FIVE-BOOKS-A')`).run(centerA).lastInsertRowid)
const projectB = Number(db.prepare(`INSERT INTO projects(area,name,property_type,active_status,project_code)
  VALUES('河北片区',?,'住宅','active','FIVE-BOOKS-B')`).run(centerB).lastInsertRowid)
const profileBatch = Number(db.prepare(`INSERT INTO project_profile_import_batches
  (source_file,source_sha256,source_sheet,filter_status,profile_count,phase_count)
  VALUES('five-books-scope.xlsx',?,'项目','在管',1,0)`).run('b'.repeat(64)).lastInsertRowid)
db.prepare(`INSERT INTO project_profiles
  (batch_id,service_center,area,management_status,property_type,source_rows_json)
  VALUES(?,?,'朝阳片区','在管','住宅','[]')`).run(profileBatch, centerA)
const viewerId = Number(db.prepare(`INSERT INTO users(username,password_hash,role,service_center_scope)
  VALUES('five_books_viewer','not-used','viewer',?)`).run(centerA).lastInsertRowid)
const admin = db.prepare(`SELECT id AS userId,username,role,area_scope AS areaScope,
  project_scope AS projectScope,service_center_scope AS serviceCenterScope FROM users WHERE role='admin' LIMIT 1`).get() as any
const viewer = db.prepare(`SELECT id AS userId,username,role,area_scope AS areaScope,
  project_scope AS projectScope,service_center_scope AS serviceCenterScope FROM users WHERE id=?`).get(viewerId) as any
const tokens = { admin: auth.signToken(admin), viewer: auth.signToken(viewer) }

const standardSource = fs.readFileSync(standardPath, 'utf8')
const standard = JSON.parse(standardSource.match(/window\.__FIVE_BOOKS_STANDARD__\s*=\s*([\s\S]+);\s*$/)![1])
const template = standard.templates.find((item: any) => item.key === 'pm5-sheet-06')
assert.ok(template)

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(auth.requireAuth)
app.use(fiveBooks)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('五书正式启用测试端口获取失败')
const base = `http://127.0.0.1:${address.port}`

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

function request(pathname: string, role: keyof typeof tokens, init: RequestInit = {}) {
  return fetch(`${base}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${tokens[role]}`, ...init.headers },
  })
}

test('五书评估读取按授权项目隔离，管理总表仅管理员可见', async () => {
  const adminResponse = await request('/api/five-books/subjects', 'admin')
  const viewerResponse = await request('/api/five-books/subjects', 'viewer')
  assert.equal(adminResponse.status, 200)
  assert.equal(viewerResponse.status, 200)
  const adminBody = await adminResponse.json() as any
  const viewerBody = await viewerResponse.json() as any
  assert.ok(adminBody.subjects.some((item: any) => item.key === 'organization:first-service'))
  assert.ok(adminBody.subjects.some((item: any) => item.key === 'region:north-china'))
  assert.deepEqual(viewerBody.subjects.map((item: any) => item.key), [`project:${projectA}`])

  const own = await request(`/api/five-books/records?subjectKey=project:${projectA}&period=half&templateKey=pm5-sheet-06`, 'viewer')
  const other = await request(`/api/five-books/records?subjectKey=project:${projectB}&period=half&templateKey=pm5-sheet-06`, 'viewer')
  assert.equal(own.status, 200)
  assert.equal(other.status, 400)
})

test('五书写入显式保持管理员门禁并使用正式完整模板', async () => {
  const body = {
    subjectKey: `project:${projectA}`,
    period: 'half',
    templateKey: template.key,
    version: 0,
    header: { principle: 'PM4-XX-48', professional: '运营专业' },
    records: template.metrics.map((metric: any) => ({
      metricId: metric.id,
      applicability: 'pending',
      targetValue: null,
      actualValue: null,
      manualWeight: null,
      manualScore: null,
      effectValue: null,
      dataSource: 'manual',
      evidenceNote: '',
    })),
  }
  const denied = await request('/api/five-books/records', 'viewer', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal(denied.status, 403)

  const saved = await request('/api/five-books/records', 'admin', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal(saved.status, 200, await saved.text())
  const records = await request(`/api/five-books/records?subjectKey=project:${projectA}&period=half&templateKey=${template.key}`, 'admin')
  const recordsBody = await records.json() as any
  assert.equal(recordsBody.records.length, template.metrics.length)
  assert.equal(recordsBody.header.version, 1)

  const prematureSubmit = await request('/api/five-books/review', 'admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      subjectKey: `project:${projectA}`, period: 'half', templateKey: template.key, action: 'submit', note: '',
    }),
  })
  assert.equal(prematureSubmit.status, 409)
})

test('五书证据下载逐次复验SHA-256，篡改后失败关闭', async () => {
  const metricId = template.metrics[0].id
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const form = new FormData()
  form.append('subjectKey', `project:${projectA}`)
  form.append('period', 'half')
  form.append('templateKey', template.key)
  form.append('metricId', metricId)
  form.append('note', '完整性测试')
  form.append('file', new Blob([png], { type: 'image/png' }), 'evidence.png')
  const uploaded = await request('/api/five-books/evidence', 'admin', { method: 'POST', body: form })
  const uploadedText = await uploaded.text()
  assert.equal(uploaded.status, 200, uploadedText)
  const uploadBody = JSON.parse(uploadedText) as any

  const valid = await request(`/api/five-books/evidence/${uploadBody.id}`, 'admin')
  assert.equal(valid.status, 200)
  assert.equal(valid.headers.get('x-content-sha256'), uploadBody.sha256)

  const files = fs.readdirSync(path.join(root, 'five-books', 'evidence'))
  assert.equal(files.length, 1)
  fs.appendFileSync(path.join(root, 'five-books', 'evidence', files[0]), 'tampered')
  const tampered = await request(`/api/five-books/evidence/${uploadBody.id}`, 'admin')
  assert.equal(tampered.status, 409)
  assert.match(String((await tampered.json() as any).error), /完整性校验失败/)

  fs.rmSync(path.join(root, 'five-books', 'evidence', files[0]))
  const missing = await request(`/api/five-books/evidence/${uploadBody.id}`, 'admin')
  assert.equal(missing.status, 410)
  const missingError = String((await missing.json() as any).error)
  assert.match(missingError, /证据文件已缺失/)
  assert.doesNotMatch(missingError, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})
