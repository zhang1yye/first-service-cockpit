import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-user-security-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'user-security-contract-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'

const [{ default: db }, { default: usersRouter }, { default: authRouter }, { requireAuth, signToken }] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/users.js'),
  import('../src/routes/auth.js'),
  import('../src/auth.js'),
])

const center = '第一服务成员安全测试中心'
const secondCenter = '第一服务成员安全测试二中心'
const profileBatch = Number(db.prepare(`INSERT INTO project_profile_import_batches
  (source_file,source_sha256,source_sheet,filter_status,profile_count,phase_count)
  VALUES('users.xlsx',?,'项目','在管',2,0)`).run('a'.repeat(64)).lastInsertRowid)
const insertProfile = db.prepare(`INSERT INTO project_profiles
  (batch_id,service_center,area,management_status,property_type,source_rows_json)
  VALUES(?,?,?,'在管','住宅','[]')`)
insertProfile.run(profileBatch, center, '测试片区')
insertProfile.run(profileBatch, secondCenter, '测试片区')

const app = express()
app.use(express.json())
app.use(authRouter)
app.use(requireAuth)
app.use(usersRouter)
app.use((_error: any, _req: any, res: any, _next: any) => res.status(500).json({ error: '测试捕获的严格审计失败' }))
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  if (server.listening) return resolve()
  server.once('listening', resolve)
  server.once('error', reject)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('成员安全测试端口未绑定')
const baseUrl = `http://127.0.0.1:${address.port}`
const admin = db.prepare("SELECT id,username,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as any
const token = signToken({ userId: admin.id, username: admin.username, role: 'admin' })

async function request(pathname: string, method = 'GET', body?: any) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  return { response, payload }
}

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('成员类型支持四类岗位，片区内可绑定多个权威服务中心', async () => {
  const options = await request('/api/users/service-centers')
  assert.equal(options.response.status, 200)
  assert.deepEqual(options.payload.rows.map((row: any) => row.center).sort(), [center, secondCenter].sort())

  const simplePasswordMember = await request('/api/users', 'POST', { username: 'simple-password-member', password: '123456', role: 'viewer', area_scope: '测试片区', service_center_scope: [center] })
  assert.equal(simplePasswordMember.response.status, 201)
  assert.equal(Object.hasOwn(simplePasswordMember.payload, 'mustChangePassword'), false)
  const simplePasswordLogin = await request('/api/auth/login', 'POST', { username: 'simple-password-member', password: '123456' })
  assert.equal(simplePasswordLogin.response.status, 200)
  assert.equal(Object.hasOwn(simplePasswordLogin.payload.user, 'mustChangePassword'), false)
  const roleCases = [
    { role: 'hq_function', username: 'role-hq', area_scope: '', service_center_scope: [] },
    { role: 'area_manager', username: 'role-area', area_scope: '测试片区', service_center_scope: [] },
    { role: 'project_manager', username: 'role-project', area_scope: '测试片区', service_center_scope: [center, secondCenter] },
    { role: 'viewer', username: 'secure-member', area_scope: '测试片区', service_center_scope: [center] },
  ]
  for (const [index, member] of roleCases.entries()) {
    const roleMember = await request('/api/users', 'POST', { ...member, password: `Role-Member-${index}-2026` })
    assert.equal(roleMember.response.status, 201, JSON.stringify(roleMember.payload))
    assert.equal(roleMember.payload.role, member.role)
  }
  const projectMember = db.prepare("SELECT area_scope,service_center_scope FROM users WHERE username='role-project'").get() as any
  assert.equal(projectMember.area_scope, '测试片区')
  assert.deepEqual(projectMember.service_center_scope.split(',').sort(), [center, secondCenter].sort())
  const invalidCenter = await request('/api/users', 'POST', { username: 'invalid-center', password: 'Invalid-Center-2026', role: 'viewer', area_scope: '测试片区', service_center_scope: ['自由文本中心'] })
  assert.equal(invalidCenter.response.status, 400)

  const created = db.prepare("SELECT area_scope,service_center_scope FROM users WHERE username='secure-member'").get() as any
  assert.equal(created.area_scope, '测试片区')
  assert.equal(created.service_center_scope, center)
})

test('创建或提升管理员必须二次确认，删除用户必须输入目标用户名', async () => {
  const withoutAdminConfirmation = await request('/api/users', 'POST', { username: 'second-admin', password: 'Second-Admin-2026', role: 'admin' })
  assert.equal(withoutAdminConfirmation.response.status, 400)
  const createdAdmin = await request('/api/users', 'POST', { username: 'second-admin', password: 'Second-Admin-2026', role: 'admin', confirmation: '确认管理员权限' })
  assert.equal(createdAdmin.response.status, 201)

  const member = db.prepare("SELECT id FROM users WHERE username='secure-member'").get() as any
  const promotionDenied = await request(`/api/users/${member.id}/role`, 'PUT', { role: 'admin' })
  assert.equal(promotionDenied.response.status, 400)
  const promoted = await request(`/api/users/${member.id}/role`, 'PUT', { role: 'admin', confirmation: '确认管理员权限' })
  assert.equal(promoted.response.status, 200)

  const disposable = await request('/api/users', 'POST', { username: 'delete-me', password: 'Delete-Member-2026', role: 'viewer', area_scope: '测试片区', service_center_scope: [center] })
  assert.equal(disposable.response.status, 201)
  const wrongConfirmation = await request(`/api/users/${disposable.payload.id}`, 'DELETE', { confirmation: '错误用户名' })
  assert.equal(wrongConfirmation.response.status, 400)
  assert.ok(db.prepare('SELECT id FROM users WHERE id=?').get(disposable.payload.id))
  const deleted = await request(`/api/users/${disposable.payload.id}`, 'DELETE', { confirmation: 'delete-me' })
  assert.equal(deleted.response.status, 200)
  assert.equal(db.prepare('SELECT id FROM users WHERE id=?').get(disposable.payload.id), undefined)
})

test('用户变更严格审计失败时业务写入整体回滚', async () => {
  db.exec('DROP TABLE operation_logs')
  const failed = await request('/api/users', 'POST', { username: 'must-rollback', password: 'Rollback-Member-2026', role: 'viewer', area_scope: '测试片区', service_center_scope: [center] })
  assert.equal(failed.response.status, 500)
  assert.equal(db.prepare("SELECT id FROM users WHERE username='must-rollback'").get(), undefined)
})
