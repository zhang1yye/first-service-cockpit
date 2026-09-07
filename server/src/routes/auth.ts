import { Router } from 'express'
import bcrypt from 'bcryptjs'
import db from '../db.js'
import { hasValidServiceCenterAssignment, signToken, requireAuth } from '../auth.js'
import { validatePassword } from '../password-policy.js'
import { logOperationStrict } from '../audit.js'
import { loginLocked, recordLoginFailure, resetLoginFailures, clientIp } from '../login-rate-limit.js'

const router = Router()

/** POST /api/auth/login */
router.post('/api/auth/login', (req, res) => {
  const locked = loginLocked(req)
  if (locked.locked) {
    res.status(429).json({ error: '登录尝试过于频繁，请稍后再试', retryAfterSeconds: locked.retryAfterSeconds })
    return
  }

  const { username, password } = req.body
  if (!username || !password) {
    res.status(400).json({ error: '请输入用户名和密码' })
    return
  }

  const user = db.prepare(
    'SELECT id, username, password_hash, role, area_scope, project_scope, service_center_scope FROM users WHERE username = ?'
  ).get(username) as any

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordLoginFailure(req)
    res.status(401).json({ error: '用户名或密码错误' })
    return
  }

  resetLoginFailures(req)
  const loginScope = {
    userId: user.id,
    username: user.username,
    role: user.role,
    areaScope: user.area_scope || '',
    projectScope: user.project_scope || '',
    serviceCenterScope: user.service_center_scope || '',
  }
  if (!hasValidServiceCenterAssignment(loginScope)) {
    res.status(403).json({
      error: '账号未绑定有效片区或服务中心，请联系系统管理员',
      code: 'SERVICE_CENTER_ASSIGNMENT_REQUIRED',
    })
    return
  }
  const token = signToken(loginScope)
  try { db.prepare('INSERT INTO operation_logs (user_id, username, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, user.username, '登录系统', 'auth', '{}', clientIp(req)) } catch {}
  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role, areaScope: user.area_scope || '', projectScope: user.project_scope || '', serviceCenterScope: user.service_center_scope || '' },
  })
})

/** GET /api/auth/me — 验证 token 有效性 */
router.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: (req as any).user })
})

/** PUT /api/auth/password — 当前用户修改自己的密码 */
router.put('/api/auth/password', requireAuth, (req, res) => {
  const user = (req as any).user
  const { oldPassword, newPassword } = req.body

  if (!oldPassword || !newPassword) {
    res.status(400).json({ error: '请输入旧密码和新密码' })
    return
  }
  const passwordValidation = validatePassword(newPassword, user.username)
  if (!passwordValidation.ok) return res.status(400).json({ error: passwordValidation.error })

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.userId) as any
  if (!row || !bcrypt.compareSync(oldPassword, row.password_hash)) {
    res.status(401).json({ error: '旧密码错误' })
    return
  }

  const hash = bcrypt.hashSync(newPassword, 10)
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hash, user.userId)
    logOperationStrict(req, '修改本人密码', 'auth/password', {})
  })()
  res.json({ success: true, reauthenticationRequired: true })
})

export default router
