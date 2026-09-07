import { Router } from 'express'
import bcrypt from 'bcryptjs'
import db from '../db.js'
import { requireAdmin } from '../auth.js'
import { logOperationStrict } from '../audit.js'
import {
  HEADQUARTERS_FUNCTION_ROLE,
  HEADQUARTERS_FUNCTION_SCOPE,
  AREA_MANAGER_ROLE,
  PROJECT_MANAGER_ROLE,
  MEMBER_ROLES,
  validateServiceCenterAssignment,
} from '../user-access.js'
import { listServiceCenterOptions, resolveAreaSelection, resolveServiceCenterSelections } from '../service-center-access.js'
import { validatePassword } from '../password-policy.js'

const router = Router()

function resolveAuthorizedScope(role: string, requestedArea: string, requestedCenter: string): {
  ok: boolean
  error?: string
  areaScope: string
  projectScope: string
  serviceCenterScope: string
} {
  const assignment = validateServiceCenterAssignment(role, requestedCenter)
  if (!assignment.ok) return { ok: false, error: assignment.error, areaScope: '', projectScope: '', serviceCenterScope: '' }
  if (role === 'admin') return { ok: true, areaScope: '', projectScope: '', serviceCenterScope: '' }
  if (role === HEADQUARTERS_FUNCTION_ROLE) {
    return {
      ok: true,
      areaScope: '华北',
      projectScope: '',
      serviceCenterScope: HEADQUARTERS_FUNCTION_SCOPE,
    }
  }
  if (role === AREA_MANAGER_ROLE) {
    if (requestedCenter) return { ok: false, error: '片区经理只选择片区，不需要选择服务中心', areaScope: '', projectScope: '', serviceCenterScope: '' }
    const area = resolveAreaSelection(requestedArea)
    if (!area) return { ok: false, error: '请选择片区清单中的一个有效片区', areaScope: '', projectScope: '', serviceCenterScope: '' }
    return { ok: true, areaScope: area, projectScope: '', serviceCenterScope: '' }
  }

  const resolvedCenters = resolveServiceCenterSelections(requestedCenter)
  if (!resolvedCenters?.length) {
    return { ok: false, error: '请选择服务中心清单中的一个有效中心', areaScope: '', projectScope: '', serviceCenterScope: '' }
  }
  if (role === PROJECT_MANAGER_ROLE) {
    const areas = [...new Set(resolvedCenters.map(center => center.area))]
    if (areas.length !== 1) {
      return { ok: false, error: '项目经理兼任的服务中心必须属于同一片区', areaScope: '', projectScope: '', serviceCenterScope: '' }
    }
    return {
      ok: true,
      areaScope: areas[0],
      projectScope: '',
      serviceCenterScope: resolvedCenters.map(center => center.center).join(','),
    }
  }
  if (resolvedCenters.length !== 1) {
    return { ok: false, error: '一线职员只能选择一个服务中心', areaScope: '', projectScope: '', serviceCenterScope: '' }
  }
  const center = resolvedCenters[0]
  return {
    ok: true,
    areaScope: center.area,
    // 旧片区/项目范围只保留字段兼容，不再作为授权来源。
    projectScope: '',
    serviceCenterScope: center.center,
  }
}

/** GET /api/users — 管理员查看所有用户 */
router.get('/api/users', requireAdmin, (_req, res) => {
  const users = db.prepare(
    'SELECT id, username, role, area_scope, project_scope, service_center_scope, created_at FROM users ORDER BY id'
  ).all()
  res.json(users)
})

/** GET /api/users/service-centers — 成员管理的权威片区和服务中心清单 */
router.get('/api/users/service-centers', requireAdmin, (_req, res) => {
  res.json({ rows: listServiceCenterOptions() })
})

/** POST /api/users — 管理员创建用户 */
router.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role, area_scope, service_center_scope } = req.body

  if (!username || !password) {
    res.status(400).json({ error: '用户名和密码不能为空' })
    return
  }
  const passwordValidation = validatePassword(password, username)
  if (!passwordValidation.ok) return res.status(400).json({ error: passwordValidation.error })

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (existing) {
    res.status(409).json({ error: '用户名已存在' })
    return
  }

  const hash = bcrypt.hashSync(password, 10)
  const allowedRoles = ['admin', ...MEMBER_ROLES]
  const requestedRole = String(role || 'viewer')
  if (!allowedRoles.includes(requestedRole as any)) return res.status(400).json({ error: '成员类型无效' })
  const userRole = requestedRole
  if (userRole === 'admin' && req.body?.confirmation !== '确认管理员权限') {
    return res.status(400).json({ error: '创建系统管理员必须确认管理员权限' })
  }

  const requestedCenter = Array.isArray(service_center_scope) ? service_center_scope.join(',') : String(service_center_scope || '').trim()
  const requestedArea = String(area_scope || '').trim()
  const scope = resolveAuthorizedScope(userRole, requestedArea, requestedCenter)
  if (!scope.ok) return res.status(400).json({ error: scope.error })
  const result = db.transaction(() => {
    const inserted = db.prepare('INSERT INTO users (username, password_hash, role, area_scope, project_scope, service_center_scope) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, hash, userRole, scope.areaScope, scope.projectScope, scope.serviceCenterScope)
    logOperationStrict(req, '创建用户', `user:${inserted.lastInsertRowid}`, { username, role: userRole, area_scope: scope.areaScope, service_center_scope: scope.serviceCenterScope })
    return inserted
  })()

  res.status(201).json({
    id: result.lastInsertRowid,
    username,
    role: userRole,
    area_scope: scope.areaScope,
    project_scope: scope.projectScope,
    service_center_scope: scope.serviceCenterScope,
  })
})

/** PUT /api/users/:id/scope — 管理员设置用户数据范围 */
router.put('/api/users/:id/scope', requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  const requestedCenter = Array.isArray(req.body?.service_center_scope) ? req.body.service_center_scope.join(',') : String(req.body?.service_center_scope || '').trim()
  const requestedArea = String(req.body?.area_scope || '').trim()
  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) as any
  if (!user) return res.status(404).json({ error: '用户不存在' })
  const scope = resolveAuthorizedScope(user.role, requestedArea, requestedCenter)
  if (!scope.ok) return res.status(400).json({ error: scope.error })
  db.transaction(() => {
    db.prepare('UPDATE users SET area_scope = ?, project_scope = ?, service_center_scope = ?, token_version = token_version + 1 WHERE id = ?').run(scope.areaScope, scope.projectScope, scope.serviceCenterScope, id)
    logOperationStrict(req, '修改用户数据范围', `user:${id}`, { username: user.username, area_scope: scope.areaScope, service_center_scope: scope.serviceCenterScope })
  })()
  res.json({ success: true, id, area_scope: scope.areaScope, project_scope: scope.projectScope, service_center_scope: scope.serviceCenterScope })
})

/** PUT /api/users/:id/role — 管理员修改角色并立即使旧JWT失效 */
router.put('/api/users/:id/role', requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  const user = db.prepare('SELECT id, username, role, area_scope, project_scope, service_center_scope FROM users WHERE id = ?').get(id) as any
  if (!user) return res.status(404).json({ error: '用户不存在' })
  const role = String(req.body?.role || '').trim()
  if (!['admin', ...MEMBER_ROLES].includes(role as any)) return res.status(400).json({ error: '成员类型无效' })
  if (user.role !== 'admin' && role === 'admin' && req.body?.confirmation !== '确认管理员权限') {
    return res.status(400).json({ error: '提升为系统管理员必须确认管理员权限' })
  }
  const centerInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'service_center_scope')
    ? req.body.service_center_scope
    : user.service_center_scope
  const areaInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'area_scope')
    ? req.body.area_scope
    : user.area_scope
  const requestedCenter = Array.isArray(centerInput) ? centerInput.join(',') : String(centerInput || '').trim()
  const requestedArea = String(areaInput || '').trim()
  const scope = resolveAuthorizedScope(role, requestedArea, requestedCenter)
  if (!scope.ok) return res.status(400).json({ error: scope.error })
  if (user.role === 'admin' && role !== 'admin') {
    const adminCount = (db.prepare('SELECT COUNT(*) cnt FROM users WHERE role = ?').get('admin') as { cnt: number }).cnt
    if (adminCount <= 1) return res.status(400).json({ error: '不能降级最后一个管理员' })
  }
  db.transaction(() => {
    db.prepare('UPDATE users SET role = ?, area_scope = ?, project_scope = ?, service_center_scope = ?, token_version = token_version + 1 WHERE id = ?')
      .run(role, scope.areaScope, scope.projectScope, scope.serviceCenterScope, id)
    logOperationStrict(req, '修改用户角色', `user:${id}`, { username: user.username, from_role: user.role, to_role: role, area_scope: scope.areaScope, service_center_scope: scope.serviceCenterScope })
  })()
  res.json({ success: true, id, role, area_scope: scope.areaScope, project_scope: scope.projectScope, service_center_scope: scope.serviceCenterScope })
})

/** DELETE /api/users/:id — 管理员删除用户 */
router.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id)

  // 不能删除最后一个 admin
  const adminCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM users WHERE role = ?'
  ).get('admin') as { cnt: number }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any
  if (!user) {
    res.status(404).json({ error: '用户不存在' })
    return
  }

  if (user.role === 'admin' && adminCount.cnt <= 1) {
    res.status(400).json({ error: '不能删除最后一个管理员' })
    return
  }

  if (req.body?.confirmation !== user.username) {
    res.status(400).json({ error: '删除用户前必须输入目标用户名确认' })
    return
  }

  db.transaction(() => {
    db.prepare('DELETE FROM users WHERE id = ?').run(id)
    logOperationStrict(req, '删除用户', `user:${id}`, { username: user.username, role: user.role, service_center_scope: user.service_center_scope || '' })
  })()
  res.json({ success: true })
})

/** PUT /api/users/:id/password — 修改密码 */
router.put('/api/users/:id/password', requireAdmin, (req, res) => {
  const id = Number(req.params.id)
  const { password } = req.body

  if (!password) {
    res.status(400).json({ error: '密码不能为空' })
    return
  }

  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) as any
  if (!user) {
    res.status(404).json({ error: '用户不存在' })
    return
  }

  const passwordValidation = validatePassword(password, user.username)
  if (!passwordValidation.ok) return res.status(400).json({ error: passwordValidation.error })

  const hash = bcrypt.hashSync(password, 10)
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hash, id)
    logOperationStrict(req, '重置用户密码', `user:${id}`, { username: user.username, role: user.role })
  })()
  res.json({ success: true })
})

export default router
