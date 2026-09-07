import jwt from 'jsonwebtoken'
import type { Request, Response, NextFunction } from 'express'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { areaValues, canAccessAreaForUser, projectValues } from './auth-scope.js'
import {
  canonicalServiceCentersForUser,
  serviceCenterValues,
} from './service-center-access.js'
import { normalizeCollectionCenter } from './collection-quality.js'
import { logOperation } from './audit.js'
import db from './db.js'
import { HEADQUARTERS_FUNCTION_ROLE, HEADQUARTERS_FUNCTION_SCOPE, PROJECT_MANAGER_ROLE, USER_ROLES } from './user-access.js'

function loadJwtSecret(): string {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) return process.env.JWT_SECRET
  const secretPath = process.env.JWT_SECRET_FILE || `${os.homedir()}/.cockpit_jwt_secret`
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim()
  const secret = crypto.randomBytes(48).toString('base64url')
  fs.writeFileSync(secretPath, secret, { mode: 0o600 })
  return secret
}

const JWT_SECRET = loadJwtSecret()
function loadDailyReconciliationSecret(): string {
  const secret = process.env.DAILY_RECONCILIATION_JWT_SECRET || ''
  if (secret.length >= 32 && secret !== JWT_SECRET) return secret
  if (process.env.NODE_ENV === 'test') return crypto.randomBytes(48).toString('base64url')
  if (secret === JWT_SECRET) throw new Error('DAILY_RECONCILIATION_JWT_SECRET 必须独立于人类 JWT_SECRET')
  throw new Error('生产环境缺少独立的 DAILY_RECONCILIATION_JWT_SECRET')
}
const DAILY_RECONCILIATION_JWT_SECRET = loadDailyReconciliationSecret()
const JWT_EXPIRES = '24h'
const DAILY_RECONCILIATION_PRINCIPAL = 'daily-reconciliation-automation'
const DAILY_RECONCILIATION_PURPOSE = 'daily-reconciliation'
const DAILY_RECONCILIATION_AUDIENCE = 'daily-reconciliation-api'
const AUTOMATION_TOKEN_ISSUER = 'first-service-cockpit'

export interface TokenPayload {
  userId: number
  username: string
  role: 'admin' | 'hq_function' | 'region_manager' | 'area_manager' | 'project_manager' | 'viewer'
  areaScope?: string
  projectScope?: string
  serviceCenterScope?: string
  tokenVersion?: number
}

export function getAreaScope(user?: TokenPayload): string[] { return areaValues(user) }
export function getProjectScope(user?: TokenPayload): number[] { return projectValues(user) }
export function getServiceCenterScope(user?: TokenPayload): string[] { return serviceCenterValues(user) }

/** 非管理员必须实时解析到有效权威范围；目录变更后旧令牌也立即失败关闭。 */
export function hasValidServiceCenterAssignment(user?: TokenPayload): boolean {
  if (!user || !USER_ROLES.includes(user.role)) return false
  if (user.role === 'admin') return true
  if (user.role === HEADQUARTERS_FUNCTION_ROLE) {
    return user.serviceCenterScope === HEADQUARTERS_FUNCTION_SCOPE
      && canonicalServiceCentersForUser(user).length > 0
  }
  if (user.role === 'area_manager') {
    return areaValues(user).length === 1
      && !String(user.serviceCenterScope || '').trim()
      && canonicalServiceCentersForUser(user).length > 0
  }
  const centerCount = canonicalServiceCentersForUser(user).length
  return user.role === PROJECT_MANAGER_ROLE ? centerCount > 0 : centerCount === 1
}

const REQUEST_CENTER_VALUES = Symbol('requestCenterValues')
function requestServiceCenterValues(req: Request): string[] {
  const request = req as any
  if (request.user?.role === 'admin') return []
  if (!Object.prototype.hasOwnProperty.call(request, REQUEST_CENTER_VALUES)) {
    request[REQUEST_CENTER_VALUES] = serviceCenterValues(request.user as TokenPayload | undefined)
  }
  return request[REQUEST_CENTER_VALUES]
}

export function serviceCenterScopeWhere(req: Request, field: string, alias = ''): { clause: string; params: string[] } {
  const user = (req as any).user as TokenPayload | undefined
  if (user?.role === 'admin') return { clause: '', params: [] }
  const centers = requestServiceCenterValues(req)
  if (!centers.length) return { clause: '1 = 0', params: [] }
  const prefix = alias ? `${alias}.` : ''
  return { clause: `${prefix}${field} IN (${centers.map(() => '?').join(',')})`, params: centers }
}

export function projectScopeWhere(req: Request, alias = ''): { clause: string; params: any[] } {
  return serviceCenterScopeWhere(req, 'name', alias)
}

export function taskScopeWhere(req: Request, alias = ''): { clause: string; params: any[] } {
  return serviceCenterScopeWhere(req, 'project_name', alias)
}

export function canAccessProjectRow(req: Request, project: any): boolean {
  return canAccessServiceCenter(req, project?.service_center ?? project?.name ?? project?.project_name)
}

export function canAccessServiceCenter(req: Request, center: unknown): boolean {
  const user = (req as any).user as TokenPayload | undefined
  if (user?.role === 'admin') return true
  const key = normalizeCollectionCenter(center)
  return Boolean(key) && requestServiceCenterValues(req).some(value => normalizeCollectionCenter(value) === key)
}

function auditDenied(req: Request, reason: string) {
  const user = (req as any).user as TokenPayload | undefined
  logOperation(req, '越权请求拦截', `security:${req.path}`, { method: req.method, role: user?.role || 'unknown', reason })
}

export function denyScopedAccess(req: Request, res: Response, reason = '超出授权数据范围'): void {
  auditDenied(req, reason)
  res.status(403).json({ error: reason })
}

/** 已知存在但越权的详情统一返回404，避免通过ID枚举确认其他服务中心资源。 */
export function denyScopedResource(req: Request, res: Response, reason = '资源不存在或无权访问'): void {
  auditDenied(req, reason)
  res.status(404).json({ error: reason })
}

export function canAccessRequestedArea(req: Request, area: string): boolean {
  const user = (req as any).user as TokenPayload | undefined
  return canAccessAreaForUser(user, area)
}

/** 生成 JWT */
export function signToken(payload: TokenPayload): string {
  const current = db.prepare('SELECT token_version FROM users WHERE id=?').get(payload.userId) as { token_version: number } | undefined
  if (!current) throw new Error('用户不存在，无法签发令牌')
  return jwt.sign({ ...payload, tokenVersion: current.token_version }, JWT_SECRET, { expiresIn: JWT_EXPIRES })
}

/** 验证 JWT，返回 payload */
export function verifyToken(token: string): TokenPayload | null {
  try {
    const signed = jwt.verify(token, JWT_SECRET) as TokenPayload
    const current = db.prepare(`SELECT id,username,role,area_scope,project_scope,service_center_scope,token_version FROM users WHERE id=?`).get(signed.userId) as any
    // 上线前签发的旧JWT没有tokenVersion；仅在数据库仍为初始0版本时兼容。
    // 一旦改密、改角色或改范围将版本+1，所有旧JWT立即失效。
    if (!current || Number(signed.tokenVersion ?? 0) !== Number(current.token_version ?? 0)) return null
    const payload: TokenPayload = {
      userId: current.id,
      username: current.username,
      role: current.role,
      areaScope: current.area_scope || '',
      projectScope: current.project_scope || '',
      serviceCenterScope: current.service_center_scope || '',
      tokenVersion: current.token_version,
    }
    return hasValidServiceCenterAssignment(payload) ? payload : null
  } catch {
    return null
  }
}

export interface DailyReconciliationAutomationPayload {
  userId: null
  username: 'daily-reconciliation-automation'
  role: 'automation'
  purpose: 'daily-reconciliation'
}

export function signDailyReconciliationAutomationToken(): string {
  return jwt.sign({
    actor: DAILY_RECONCILIATION_PRINCIPAL,
    purpose: DAILY_RECONCILIATION_PURPOSE,
    tokenKind: 'automation',
  }, DAILY_RECONCILIATION_JWT_SECRET, {
    algorithm: 'HS256',
    subject: DAILY_RECONCILIATION_PRINCIPAL,
    audience: DAILY_RECONCILIATION_AUDIENCE,
    issuer: AUTOMATION_TOKEN_ISSUER,
    expiresIn: '5m',
  })
}

function verifyDailyReconciliationAutomationToken(token: string): DailyReconciliationAutomationPayload | null {
  try {
    const signed = jwt.verify(token, DAILY_RECONCILIATION_JWT_SECRET, {
      algorithms: ['HS256'],
      subject: DAILY_RECONCILIATION_PRINCIPAL,
      audience: DAILY_RECONCILIATION_AUDIENCE,
      issuer: AUTOMATION_TOKEN_ISSUER,
    }) as jwt.JwtPayload
    if (signed.actor !== DAILY_RECONCILIATION_PRINCIPAL
      || signed.purpose !== DAILY_RECONCILIATION_PURPOSE
      || signed.tokenKind !== 'automation') return null
    const principal = db.prepare(`SELECT actor,purpose,active FROM automation_principals
      WHERE principal_id=?`).get(DAILY_RECONCILIATION_PRINCIPAL) as any
    if (!principal || principal.active !== 1 || principal.actor !== DAILY_RECONCILIATION_PRINCIPAL
      || principal.purpose !== DAILY_RECONCILIATION_PURPOSE) return null
    return {
      userId: null,
      username: DAILY_RECONCILIATION_PRINCIPAL,
      role: 'automation',
      purpose: DAILY_RECONCILIATION_PURPOSE,
    }
  } catch {
    return null
  }
}

export function isDailyReconciliationAutomationPath(req: Pick<Request, 'method' | 'path'>): boolean {
  if (req.method !== 'POST') return false
  return req.path === '/api/data-pipeline/daily-reconciliations/preview'
    || /^\/api\/data-pipeline\/daily-reconciliations\/\d+\/publish$/.test(req.path)
}

export function requireDailyReconciliationAccess(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: '缺少历史日报专项复核凭证' })
    return
  }
  const token = authHeader.slice(7)
  const human = verifyToken(token)
  if (human) {
    if (human.role !== 'admin') {
      auditDenied(req, '需要管理员权限')
      res.status(403).json({ error: '需要管理员权限' })
      return
    }
    ;(req as any).user = human
    next()
    return
  }
  const automation = verifyDailyReconciliationAutomationToken(token)
  if (!automation) {
    res.status(401).json({ error: '历史日报专项复核凭证无效或已过期' })
    return
  }
  ;(req as any).user = automation
  next()
}

/** Express 中间件：必须登录 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isDailyReconciliationAutomationPath(req)) {
    requireDailyReconciliationAccess(req, res, next)
    return
  }
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: '请先登录' })
    return
  }

  const payload = verifyToken(authHeader.slice(7))
  if (!payload) {
    res.status(401).json({ error: '登录已过期，请重新登录' })
    return
  }

  ;(req as any).user = payload
  next()
}

/** Express 中间件：必须是 admin */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    const user = (req as any).user as TokenPayload
    if (user.role !== 'admin') {
      auditDenied(req, '需要管理员权限')
      res.status(403).json({ error: '需要管理员权限' })
      return
    }
    next()
  })
}


/** Express 中间件：经营管理角色（admin/地区/片区/项目负责人） */
export function requireManager(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    const user = (req as any).user as TokenPayload
    if (!['admin', 'region_manager', 'area_manager', 'project_manager'].includes(user.role)) {
      auditDenied(req, '需要经营管理权限')
      res.status(403).json({ error: '需要经营管理权限' })
      return
    }
    next()
  })
}
