import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import crypto from 'crypto'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import net from 'net'
import dns from 'dns/promises'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'url'
import { generateTemporaryPassword } from './account-password.js'
import {
  BACKUP_ARCHIVE_SUFFIX,
  createBackupArchive,
  openBackupArchiveForRead,
  previewBackupArchive,
  restoreBackupArchive
} from './backup-archive.js'

const noFollowFlag = fs.constants.O_NOFOLLOW || 0

const app = express()
const port = process.env.PORT || 3001
const allowedBindHosts = new Set(['127.0.0.1'])
const bindHost = String(process.env.BIND_HOST || '127.0.0.1').trim()
if (!allowedBindHosts.has(bindHost)) {
  console.error('BIND_HOST 仅允许 127.0.0.1')
  process.exit(1)
}
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data')
const storeFile = process.env.STORE_FILE || path.join(dataDir, 'store.json')
const filesDir = process.env.FILES_DIR || path.join(dataDir, 'files')
const backupsDir = process.env.BACKUPS_DIR || path.join(dataDir, 'backups')
const restoreJournalFile = path.join(dataDir, '.restore-transaction.json')
const ssoNonceStateFile = process.env.SSO_NONCE_STATE_FILE || '/var/lib/first-service-review-api/cockpit-sso-consumed.json'
const authRateStateFile = process.env.AUTH_RATE_STATE_FILE || '/var/lib/first-service-review-api/auth-rate-limits.json'
const maintenanceGateFile = process.env.MAINTENANCE_GATE_FILE || '/var/lib/first-service-review-gate/maintenance'
const shutdownMarkerFile = process.env.SHUTDOWN_MARKER_FILE || ''
const gracefulShutdownTimeoutMs = Math.min(120_000, Math.max(90_000, Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS) || 100_000))
const defaultSessionTtlMinutes = Math.max(30, Number(process.env.SESSION_TTL_MINUTES) || 480)
const uploadHardMaxFileSize = 20 * 1024 * 1024
const uploadHardMaxFileCount = 12
const uploadHardMaxTotalSize = 48 * 1024 * 1024
// 附件总库存必须有明确硬上限，保证任一合法库存都能生成、上传并恢复同一份备份。
// 业务上传仍是单次 48MiB；备份入口单独接受其 Base64 展开与有界 store 开销。
const configuredAttachmentStorageMaxBytes = Number(process.env.ATTACHMENT_STORAGE_MAX_BYTES)
const attachmentStorageHardMaxBytes = Math.min(
  20 * 1024 * 1024 * 1024,
  Math.max(5 * 1024 * 1024 * 1024, Number.isSafeInteger(configuredAttachmentStorageMaxBytes) ? configuredAttachmentStorageMaxBytes : 5 * 1024 * 1024 * 1024)
)
const backupHardMaxFileCount = 2000
const attachmentStorageHardMaxFileCount = backupHardMaxFileCount
const backupHardMaxStoreBytes = 12 * 1024 * 1024
const backupArchiveGenerationAllowanceBytes = 64 * 1024 * 1024
const backupHardMaxArchiveBytes = attachmentStorageHardMaxBytes + backupHardMaxStoreBytes + backupArchiveGenerationAllowanceBytes
const productionBackupRestoreReserveBytes = 2 * 1024 * 1024 * 1024
const productionBackupRestoreMinimumFreeBytes = Math.max(
  18 * 1024 * 1024 * 1024,
  attachmentStorageHardMaxBytes * 3 + 3 * 1024 * 1024 * 1024
)
const testBackupRestoreMinimumFreeBytes = Number(process.env.BACKUP_RESTORE_MIN_FREE_BYTES)
const backupRestoreConfiguredMinimumFreeBytes = process.env.NODE_ENV === 'test' && Number.isSafeInteger(testBackupRestoreMinimumFreeBytes)
  ? Math.max(4 * 1024 * 1024, testBackupRestoreMinimumFreeBytes)
  : productionBackupRestoreMinimumFreeBytes
const backupRestoreReserveBytes = process.env.NODE_ENV === 'test'
  ? Math.min(productionBackupRestoreReserveBytes, Math.max(2 * 1024 * 1024, Math.floor(backupRestoreConfiguredMinimumFreeBytes / 4)))
  : productionBackupRestoreReserveBytes
const attachmentParseTimeoutMs = 12_000
const attachmentParseRequestDeadlineMs = 30_000
const maxConcurrentAttachmentWorkers = 2
const proposalAttachmentExtensions = new Set(['.pdf', '.docx', '.xlsx', '.csv', '.tsv', '.txt'])
const jsonUploadExtensions = new Set(['.json'])
const csvUploadExtensions = new Set(['.csv'])
const knowledgeDraftExtensions = new Set(['.txt', '.docx', '.pdf'])
const exposedCorsHeaders = ['X-User-Role', 'X-User-Permissions', 'X-User-Must-Change-Password', 'X-Session-Expires-At']
const configuredCorsOrigins = new Set(
  String(process.env.CORS_ORIGIN || '')
    .split(',')
    .map(value => value.trim().replace(/\/$/, ''))
    .filter(Boolean)
)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadHardMaxFileSize, files: uploadHardMaxFileCount }
})
const backupUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      try {
        ensureBackupDirectory()
        callback(null, backupsDir)
      } catch (error) {
        callback(error)
      }
    },
    filename: (_req, _file, callback) => callback(null, `.upload-${process.pid}-${Date.now()}-${crypto.randomBytes(12).toString('hex')}${BACKUP_ARCHIVE_SUFFIX}`)
  }),
  limits: { fileSize: backupHardMaxArchiveBytes, files: 1 }
})

let activeMutationCount = 0
let restoreRecoveryRequired = false
let activeAttachmentWorkerCount = 0
let reservedAttachmentBytes = 0
let reservedAttachmentFileCount = 0
let backupOperationInProgress = false
let activeBackupAbortController = null
const maxAuditLogEntries = 10_000
const maxAuditLogEntryBytes = 8 * 1024
const configuredTestAuditLogCollectionBytes = Number(process.env.AUDIT_LOG_COLLECTION_TEST_MAX_BYTES)
const maxAuditLogCollectionBytes = process.env.NODE_ENV === 'test' && Number.isSafeInteger(configuredTestAuditLogCollectionBytes)
  ? Math.min(4 * 1024 * 1024, Math.max(64 * 1024, configuredTestAuditLogCollectionBytes))
  : 4 * 1024 * 1024
const storeNextMutationReserveBytes = 128 * 1024
const permanentAuditLogIds = new Set(['L-R51-FACTORY-QUARANTINE'])
const maxClientErrorLogEntries = 500
const attachmentWorkerWaiters = []

function trackedMutation(handler) {
  return async (req, res, next) => {
    // 正常 /api 请求已在 body parser/multer 之前按整个请求生命周期占位。
    // 保留独立占位分支，仅供未经全局 admission 的内部调用失败关闭。
    const ownsAdmission = req.reviewDataOperationAdmitted !== true
    if (ownsAdmission) {
      if (restoreRecoveryRequired) {
        return res.status(503).json({ message: '备份恢复已提交但待启动恢复收敛，已拒绝新写操作' })
      }
      if (backupOperationInProgress) {
        res.setHeader('Retry-After', '5')
        return res.status(409).json({ message: '系统正在生成或校验一致性备份，请稍后重试写操作' })
      }
      activeMutationCount += 1
    }
    try {
      await handler(req, res, next)
    } catch (error) {
      next(error)
    } finally {
      if (ownsAdmission) {
        activeMutationCount = Math.max(0, activeMutationCount - 1)
        tryCompleteGracefulShutdown()
      }
    }
  }
}

function requireExclusiveBackupOperation(_req, res, next) {
  // 请求先在全局 admission 中占 1 个槽，使 auth/权限拒绝审计也纳入互斥。
  // 通过权限后在同一个事件循环 tick 内把自己的普通槽原子转换为备份独占锁。
  const ownAdmission = _req.reviewDataOperationAdmitted === true ? 1 : 0
  if (backupOperationInProgress || activeMutationCount !== ownAdmission) {
    res.setHeader('Retry-After', '5')
    return res.status(409).json({ message: '当前存在未完成的数据操作，请稍后再执行备份任务' })
  }
  backupOperationInProgress = true
  _req.releaseReviewDataOperation?.()
  _req.reviewDataOperationAdmitted = false
  const controller = new AbortController()
  activeBackupAbortController = controller
  _req.backupOperationSignal = controller.signal
  _req.backupOperationOwnsAsync = false
  let released = false
  const release = () => {
    if (released) return
    released = true
    if (activeBackupAbortController === controller) activeBackupAbortController = null
    backupOperationInProgress = false
    tryCompleteGracefulShutdown()
  }
  _req.releaseBackupOperation = release
  res.once('finish', release)
  res.once('close', () => {
    if (!res.writableFinished) controller.abort(new Error('客户端在备份操作完成前断开'))
    if (!_req.backupOperationOwnsAsync) release()
  })
  next()
}

function backupFileUpload(req, res, next) {
  req.backupOperationOwnsAsync = true
  backupUpload.single('backup')(req, res, error => {
    if (!error) {
      try {
        if (req.file?.path) {
          const info = fs.lstatSync(req.file.path)
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
            throw new Error('上传的备份归档不是单链接普通文件')
          }
          fs.chmodSync(req.file.path, 0o600)
          req.backupUploadIdentity = fs.lstatSync(req.file.path)
          if (!sameFileIdentity(info, req.backupUploadIdentity)) throw new Error('上传备份归档在固定身份时发生替换')
        }
        return next()
      } catch (uploadError) {
        return next(uploadError)
      }
    }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      cleanupUploadedBackup(req)
      req.releaseBackupOperation?.()
      return res.status(413).json({ message: `备份归档不能超过 ${formatUploadSize(backupHardMaxArchiveBytes)}` })
    }
    cleanupUploadedBackup(req)
    req.releaseBackupOperation?.()
    return next(error)
  })
}

function cleanupUploadedBackup(req) {
  const filePath = req.file?.path
  const expected = req.backupUploadIdentity
  if (!filePath || !expected) return
  try {
    if (unlinkOwnedStoreFile(filePath, expected)) syncDirectoryPath(backupsDir)
  } catch (error) {
    console.error('上传备份临时文件清理失败', error)
  }
  req.backupUploadIdentity = null
}

function backupArchiveUploadNameAllowed(file) {
  const name = String(file?.originalname || '').trim().toLowerCase()
  return name.endsWith('.tgz') || name.endsWith('.gz') || name.endsWith(BACKUP_ARCHIVE_SUFFIX)
}

function admitReviewDataRequest(req, res, next) {
  // health 与已消费票据的固定 FD 下载纯读；其余 /api 全部先占位，
  // 包括备份路由的 auth/权限阶段，防止权限拒绝审计与归档/恢复并发写 store。
  if (req.path === '/api/health' || req.path.startsWith('/api/system-backup/download/')) return next()
  if (!req.path.startsWith('/api/')) return next()
  if (restoreRecoveryRequired) {
    res.setHeader('Retry-After', '30')
    return res.status(503).json({ message: '备份恢复正在安全收敛，已拒绝新数据操作' })
  }
  if (backupOperationInProgress) {
    res.setHeader('Retry-After', '5')
    return res.status(409).json({ message: '系统正在生成、校验或恢复一致性备份，请稍后重试' })
  }

  activeMutationCount += 1
  req.reviewDataOperationAdmitted = true
  let released = false
  const release = () => {
    if (released) return
    released = true
    activeMutationCount = Math.max(0, activeMutationCount - 1)
    tryCompleteGracefulShutdown()
  }
  req.releaseReviewDataOperation = release
  res.once('finish', release)
  res.once('close', release)
  try {
    next()
  } catch (error) {
    release()
    throw error
  }
}

// 发布事务的进程级写屏障：即使本机进程绕过 Nginx 直连 3001，
// gate 存在时也只允许无副作用 health，不允许登录/SSO/提交改写 data。
app.use((req, res, next) => {
  if (req.path === '/api/health') return next()
  if (restoreRecoveryRequired) {
    res.setHeader('Retry-After', '30')
    return res.status(503).json({ message: '备份恢复正在安全收敛，已失败关闭业务写入' })
  }
  try {
    const gate = fs.statSync(maintenanceGateFile)
    if (!gate.isFile() || gate.uid !== 0 || (gate.mode & 0o777) !== 0o400) {
      throw new Error('维护门闩必须是 root:root 0400 普通文件')
    }
    res.setHeader('Retry-After', '30')
    return res.status(503).json({ message: '审核系统正在安全维护，请稍后重试' })
  } catch (error) {
    if (error?.code === 'ENOENT') return next()
    console.error('维护门闩检查失败', error)
    return res.status(503).json({ message: '无法确认维护状态，已失败关闭' })
  }
})

function normalizedRequestOrigin(req) {
  const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const protocol = forwardedProtocol || req.protocol || 'http'
  const host = String(req.headers.host || '').trim()
  return host ? `${protocol}://${host}`.replace(/\/$/, '') : ''
}

function isCorsOriginAllowed(req, origin = '') {
  if (!origin) return true
  const value = String(origin).trim().replace(/\/$/, '')
  if (!value) return false
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value) return false
  } catch {
    return false
  }
  return configuredCorsOrigins.has(value) || value === normalizedRequestOrigin(req)
}

const corsResponse = cors({
  origin: (origin, callback) => callback(null, origin || false),
  exposedHeaders: exposedCorsHeaders,
  optionsSuccessStatus: 204
})

app.use(helmet())
app.use((req, res, next) => {
  const origin = String(req.headers.origin || '').trim()
  if (!isCorsOriginAllowed(req, origin)) {
    return res.status(403).json({ message: 'CORS Origin 不在允许列表中' })
  }
  return corsResponse(req, res, next)
})
// 必须早于 express.json 和所有 multer：慢上传从第一个 body byte 前即阻止备份/恢复抢占。
app.use(admitReviewDataRequest)
app.use(express.json({ limit: '4mb' }))
app.use(morgan((tokens, req, res) => boundedHttpAccessLine(tokens, req, res), {
  skip: req => req.path.startsWith('/api/system-backup/download/')
}))
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.removeHeader('ETag')
  next()
})

let users = []
let proposals = []
let logs = []
let rules = []
let knowledgeEntries = []
let botProfiles = []
let reminderConfig = {}
let rolePermissions = {}
let systemConfig = {}

const tokens = new Map()
const backupDownloadTickets = new Map()
const configuredBackupDownloadTicketTtlMs = Number(process.env.BACKUP_DOWNLOAD_TICKET_TTL_MS)
const backupDownloadTicketTtlMs = process.env.NODE_ENV === 'test' && Number.isSafeInteger(configuredBackupDownloadTicketTtlMs)
  ? Math.min(60 * 1000, Math.max(100, configuredBackupDownloadTicketTtlMs))
  : 60 * 1000
const backupDownloadTicketLimit = 32
const loginFailures = new Map()
const loginIpFailures = new Map()
const loginPairFailures = new Map()
const ssoIpFailures = new Map()
const hermesSyncPreviews = new Map()
const hermesSyncPreviewTtlMs = 10 * 60 * 1000

const permissionCatalog = [
  { key: 'submitProposal', name: '提交方案', description: '允许提交方案和上传附件' },
  { key: 'reviewProposal', name: '审核流转', description: '允许复核、流转、签发、归档和催办' },
  { key: 'manageSystem', name: '系统配置', description: '允许维护机器人、规则、知识库和系统设置' },
  { key: 'manageUsers', name: '人员管理', description: '允许新增、修改、停用和删除账号' },
  { key: 'viewLogs', name: '查看日志', description: '允许查看日志中心和执行留痕' }
]

const defaultRolePermissions = {
  管理员: ['submitProposal', 'reviewProposal', 'manageSystem', 'manageUsers', 'viewLogs'],
  使用者: ['submitProposal'],
  审核员: ['reviewProposal', 'viewLogs'],
  提交人: ['submitProposal'],
  观察员: ['viewLogs']
}
const assignableUserRoles = new Set(['管理员', '审核员', '提交人', '观察员'])

function normalizeUserRole(role = '') {
  const value = String(role || '').trim()
  return Object.prototype.hasOwnProperty.call(defaultRolePermissions, value) ? value : ''
}

function isKnownUserRole(role = '') {
  return Object.prototype.hasOwnProperty.call(defaultRolePermissions, String(role || '').trim())
}

function isAssignableUserRole(role = '') {
  return assignableUserRoles.has(String(role || '').trim())
}

function normalizeUserStatus(status = '') {
  const value = String(status || '').trim()
  return value === '启用' || value === '停用' ? value : ''
}

function usernameIdentityKey(username = '') {
  return String(username || '').trim().toLowerCase()
}

function shouldForcePasswordChange(user = {}) {
  return normalizeUserRole(user.role) !== '管理员' && user.mustChangePassword === true
}

function normalizeRolePermissions(value = defaultRolePermissions, { strict = false } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  if (!source && strict) throw new Error('角色权限矩阵必须是对象')
  const roleNames = Object.keys(defaultRolePermissions)
  const roleSet = new Set(roleNames)
  const permissionOrder = permissionCatalog.map(item => item.key)
  const permissionSet = new Set(permissionOrder)
  const unknownRoles = source ? Object.keys(source).filter(role => !roleSet.has(role)) : []
  if (strict && unknownRoles.length > 0) throw new Error(`角色权限矩阵包含未知角色：${unknownRoles.join('、')}`)

  return Object.fromEntries(roleNames.map(role => {
    const fixed = role === '管理员' || role === '使用者'
    const ceiling = defaultRolePermissions[role]
    let submitted = source?.[role]
    if (submitted === undefined) {
      if (strict) throw new Error(`角色权限矩阵缺少角色：${role}`)
      submitted = ceiling
    }
    if (!Array.isArray(submitted)) {
      if (strict) throw new Error(`角色 ${role} 的权限必须是数组`)
      submitted = ceiling
    }
    if (strict && new Set(submitted).size !== submitted.length) throw new Error(`角色 ${role} 的权限不能重复`)
    const unknown = submitted.filter(permission => typeof permission !== 'string' || !permissionSet.has(permission))
    if (strict && unknown.length > 0) throw new Error(`角色 ${role} 包含未知权限：${unknown.join('、')}`)
    const ceilingSet = new Set(ceiling)
    const overLimit = submitted.filter(permission => permissionSet.has(permission) && !ceilingSet.has(permission))
    if (strict && overLimit.length > 0) throw new Error(`角色 ${role} 超出安全权限上限：${overLimit.join('、')}`)
    const normalized = permissionOrder.filter(permission => ceilingSet.has(permission) && submitted.includes(permission))
    if (fixed && JSON.stringify(normalized) !== JSON.stringify(ceiling)) {
      if (strict) throw new Error(`角色 ${role} 为固定安全权限，不允许增减`)
      return [role, [...ceiling]]
    }
    return [role, fixed ? [...ceiling] : normalized]
  }))
}

function permissionsForRole(role = '') {
  const normalizedRole = normalizeUserRole(role)
  return normalizedRole ? rolePermissions[normalizedRole] || [] : []
}

function permissionName(key = '') {
  return permissionCatalog.find(item => item.key === key)?.name || key
}

function rolePermissionDiff(nextPermissions = {}, previousPermissions = {}) {
  const changes = {}
  let changeCount = 0

  for (const role of Object.keys(defaultRolePermissions)) {
    const nextSet = new Set(nextPermissions[role] || [])
    const previousSet = new Set(previousPermissions[role] || [])
    const added = [...nextSet].filter(key => !previousSet.has(key))
    const removed = [...previousSet].filter(key => !nextSet.has(key))
    if (added.length || removed.length) {
      changes[role] = {
        added,
        addedNames: added.map(permissionName),
        removed,
        removedNames: removed.map(permissionName)
      }
      changeCount += added.length + removed.length
    }
  }

  return { changeCount, changes }
}

function rolePermissionImpact() {
  const impact = {}
  for (const role of Object.keys(defaultRolePermissions)) {
    const roleUsers = users.filter(user => normalizeUserRole(user.role) === role)
    impact[role] = {
      total: roleUsers.length,
      enabled: roleUsers.filter(user => user.status !== '停用').length,
      disabled: roleUsers.filter(user => user.status === '停用').length
    }
  }
  return impact
}

function latestRolePermissionUpdate() {
  const latest = logs.find(log => String(log.action || '').includes('角色权限矩阵'))
  return latest ? {
    actor: latest.actor || '',
    at: latest.at || '',
    action: latest.action || ''
  } : null
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function splitIpWhitelist(value = []) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[\n,，]/)
  return [...new Set(items.map(item => String(item || '').trim()).filter(Boolean))]
}

function normalizeIp(value = '') {
  const ip = String(value || '').trim()
  return ip.startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip
}

function normalizeIpWhitelist(value = []) {
  return [...new Set(splitIpWhitelist(value).map(normalizeIp).filter(item => net.isIP(item)))]
}

function defaultSystemConfig() {
  const publicDomain = process.env.PUBLIC_DOMAIN || 'firstcare.cloud'
  return {
    frontendUrl: `https://${String(publicDomain).replace(/^https?:\/\//, '').replace(/\/$/, '')}/review-system/`,
    publicDomain,
    publicIp: process.env.PUBLIC_IP || '82.157.119.78',
    apiPrefix: '/api',
    backendPort: String(port),
    aiProvider: process.env.AI_REVIEW_PROVIDER || (process.env.NODE_ENV === 'production' ? 'hermes' : 'local'),
    aiModel: process.env.AI_REVIEW_MODEL || (process.env.NODE_ENV === 'production' ? 'hermes-eight-profile-v1' : 'local-rule-engine-v0.1'),
    aiBaseUrl: process.env.AI_REVIEW_BASE_URL || (process.env.NODE_ENV === 'production' ? 'http://127.0.0.1:3100/v1' : ''),
    aiApiKeyEnv: 'AI_REVIEW_API_KEY',
    sessionTtlMinutes: defaultSessionTtlMinutes,
    loginFailureWindowMinutes: 15,
    loginLockMinutes: 10,
    inactiveLoginDays: 30,
    sharedLoginIpAccountThreshold: 3,
    trustedLoginIps: [],
    maxLoginFailures: 5,
    maxFileSizeMb: 20,
    maxUploadFiles: 12
  }
}

function normalizeSystemConfig(value = {}) {
  const defaults = defaultSystemConfig()
  const provider = String(value.aiProvider || defaults.aiProvider).trim().toLowerCase()
  const normalizedProvider = ['local', 'hermes', 'openai'].includes(provider) ? provider : 'local'
  const submittedBaseUrl = String(value.aiBaseUrl || defaults.aiBaseUrl).trim().replace(/\/+$/, '')
  const safeBaseUrl = normalizedProvider === 'hermes'
    ? reviewedAiEndpoints.hermes
    : normalizedProvider === 'openai'
      ? reviewedAiEndpoints.openai
      : ''
  return {
    frontendUrl: String(value.frontendUrl || defaults.frontendUrl).trim(),
    publicDomain: String(value.publicDomain || defaults.publicDomain).trim(),
    publicIp: normalizeIp(value.publicIp || defaults.publicIp),
    apiPrefix: String(value.apiPrefix || defaults.apiPrefix).trim() || '/api',
    backendPort: String(value.backendPort || defaults.backendPort).trim(),
    aiProvider: normalizedProvider,
    aiModel: String(value.aiModel || defaults.aiModel).trim() || defaults.aiModel,
    aiBaseUrl: submittedBaseUrl === safeBaseUrl ? safeBaseUrl : submittedBaseUrl,
    aiApiKeyEnv: 'AI_REVIEW_API_KEY',
    sessionTtlMinutes: clampNumber(value.sessionTtlMinutes, 30, 1440, defaults.sessionTtlMinutes),
    loginFailureWindowMinutes: clampNumber(value.loginFailureWindowMinutes, 1, 120, defaults.loginFailureWindowMinutes),
    loginLockMinutes: clampNumber(value.loginLockMinutes, 1, 120, defaults.loginLockMinutes),
    inactiveLoginDays: clampNumber(value.inactiveLoginDays, 7, 365, defaults.inactiveLoginDays),
    sharedLoginIpAccountThreshold: clampNumber(value.sharedLoginIpAccountThreshold, 2, 50, defaults.sharedLoginIpAccountThreshold),
    trustedLoginIps: normalizeIpWhitelist(value.trustedLoginIps),
    maxLoginFailures: clampNumber(value.maxLoginFailures, 3, 20, defaults.maxLoginFailures),
    maxFileSizeMb: clampNumber(value.maxFileSizeMb, 1, 20, defaults.maxFileSizeMb),
    maxUploadFiles: clampNumber(value.maxUploadFiles, 1, 12, defaults.maxUploadFiles)
  }
}

const reviewedAiEndpoints = Object.freeze({
  hermes: 'http://127.0.0.1:3100/v1',
  openai: 'https://api.openai.com/v1'
})

const deploymentManagedSystemFields = Object.freeze([
  'frontendUrl', 'backendPort', 'apiPrefix',
  'aiProvider', 'aiModel', 'aiBaseUrl', 'aiApiKeyEnv'
])

function deploymentManagedSystemConfig() {
  const publicDomain = String(process.env.PUBLIC_DOMAIN || 'firstcare.cloud').trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
  return {
    frontendUrl: `https://${publicDomain || 'firstcare.cloud'}/review-system/`,
    backendPort: String(port),
    apiPrefix: '/api',
    aiProvider: String(process.env.AI_REVIEW_PROVIDER || 'hermes').trim().toLowerCase(),
    aiModel: String(process.env.AI_REVIEW_MODEL || 'hermes-eight-profile-v1').trim(),
    aiBaseUrl: String(process.env.AI_REVIEW_BASE_URL || reviewedAiEndpoints.hermes).trim().replace(/\/+$/, ''),
    aiApiKeyEnv: 'AI_REVIEW_API_KEY'
  }
}

function systemConfigForResponse(config = systemConfig) {
  return { ...normalizeSystemConfig(config), ...deploymentManagedSystemConfig() }
}

function ignoredDeploymentManagedFields(submitted = {}) {
  if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) return []
  const managed = deploymentManagedSystemConfig()
  return deploymentManagedSystemFields.filter(field => (
    Object.prototype.hasOwnProperty.call(submitted, field) && String(submitted[field] ?? '') !== String(managed[field])
  ))
}

function validateAiRuntimeBoundary(runtime = {}, { production = process.env.NODE_ENV === 'production' } = {}) {
  const provider = String(runtime.provider || '').trim().toLowerCase()
  const baseUrl = String(runtime.baseUrl || '').trim().replace(/\/+$/, '')
  const apiKeyEnv = String(runtime.apiKeyEnv || 'AI_REVIEW_API_KEY').trim()
  if (apiKeyEnv !== 'AI_REVIEW_API_KEY') throw new Error('AI 密钥环境变量只允许 AI_REVIEW_API_KEY')
  if (production && provider !== 'hermes') throw new Error('生产环境只允许经审核的本机 Hermes Gateway')
  if (provider === 'local') {
    if (production) throw new Error('生产环境不允许本地伪完成 AI 链路')
    return { ...runtime, provider, baseUrl: '', apiKeyEnv }
  }
  if (!Object.prototype.hasOwnProperty.call(reviewedAiEndpoints, provider)) {
    throw new Error(`AI Provider ${provider || '空'} 未经出站白名单审核`)
  }
  if (baseUrl !== reviewedAiEndpoints[provider]) {
    throw new Error(`AI Base URL 不在 ${provider} 精确白名单`)
  }
  const parsed = new URL(baseUrl)
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('AI Base URL 不得包含凭据、查询或片段')
  }
  return { ...runtime, provider, baseUrl, apiKeyEnv }
}

function aiRuntimeConfig(config = systemConfig) {
  const source = normalizeSystemConfig(config || systemConfig)
  const provider = process.env.AI_REVIEW_PROVIDER || source.aiProvider || 'local'
  const model = process.env.AI_REVIEW_MODEL || source.aiModel || (provider === 'local' ? 'local-rule-engine-v0.1' : provider)
  const baseUrl = process.env.AI_REVIEW_BASE_URL || source.aiBaseUrl || (provider === 'openai' ? 'https://api.openai.com/v1' : '')
  const apiKeyEnv = 'AI_REVIEW_API_KEY'
  const apiKeyConfigured = Boolean(process.env.AI_REVIEW_API_KEY)
  const deploymentAgentEnabled = process.env.AI_REVIEW_AGENT_CONFIGURED === 'true'
  const candidate = {
    provider,
    model,
    baseUrl,
    apiKeyEnv,
    apiKeyConfigured,
    deploymentAgentEnabled
  }
  try {
    const validated = validateAiRuntimeBoundary(candidate)
    const gatewayConfigured = provider === 'local' || apiKeyConfigured
    const agentConfigured = provider !== 'local' && gatewayConfigured && deploymentAgentEnabled
    const adapterReady = provider === 'local' || agentConfigured
    return {
      ...validated,
      gatewayConfigured,
      agentConfigured,
      inferenceEnabled: agentConfigured,
      adapterReady,
      activeMode: provider === 'local'
        ? '本地规则引擎'
        : agentConfigured
          ? '外部 AI 已配置'
          : gatewayConfigured
            ? 'Hermes Profile 网关已连接；AI 推理未启用'
            : 'Hermes Profile 网关配置不完整',
      fallback: provider !== 'local' && !agentConfigured,
      boundaryError: ''
    }
  } catch (error) {
    return {
      ...candidate,
      gatewayConfigured: false,
      agentConfigured: false,
      inferenceEnabled: false,
      adapterReady: false,
      activeMode: '已拒绝的 AI 配置',
      fallback: provider !== 'local',
      boundaryError: error.message
    }
  }
}

function aiChatCompletionsUrl(baseUrl = '') {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!normalized) return ''
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`
}

function aiProfilesUrl(baseUrl = '') {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!normalized) return ''
  if (normalized.endsWith('/profiles')) return normalized
  if (normalized.endsWith('/chat/completions')) return `${normalized.slice(0, -'/chat/completions'.length)}/profiles`
  return `${normalized}/profiles`
}

function aiHealthUrl(baseUrl = '') {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!normalized) return ''
  if (normalized.endsWith('/health')) return normalized
  if (normalized.endsWith('/v1/chat/completions')) return `${normalized.slice(0, -'/v1/chat/completions'.length)}/health`
  if (normalized.endsWith('/chat/completions')) return `${normalized.slice(0, -'/chat/completions'.length)}/health`
  if (normalized.endsWith('/v1/profiles')) return `${normalized.slice(0, -'/v1/profiles'.length)}/health`
  if (normalized.endsWith('/profiles')) return `${normalized.slice(0, -'/profiles'.length)}/health`
  if (normalized.endsWith('/v1')) return `${normalized.slice(0, -'/v1'.length)}/health`
  return `${normalized}/health`
}

function aiProbeProposal() {
  return {
    id: 'AI-PROBE',
    title: 'AI 连通性探测方案',
    type: '内部运营方案',
    submitter: '系统',
    department: '研发小组',
    description: [
      '本次探测用于验证 AI 审核适配器能否返回结构化 JSON。',
      '请围绕服务范围、成本测算、合规要求、交付风险输出简短审核意见。',
      '这是系统自检数据，不会保存为正式审核方案。'
    ].join('\n'),
    files: [],
    timeline: [],
    createdAt: nowText(),
    updatedAt: nowText()
  }
}

function sessionTtlMs() {
  return (systemConfig.sessionTtlMinutes || defaultSystemConfig().sessionTtlMinutes) * 60 * 1000
}

function loginFailureWindowMs() {
  return (systemConfig.loginFailureWindowMinutes || 15) * 60 * 1000
}

function loginLockMs() {
  return (systemConfig.loginLockMinutes || 10) * 60 * 1000
}

function clientIp(req) {
  const peer = normalizeIp(req.socket?.remoteAddress || '')
  const forwarded = String(req.headers['x-forwarded-for'] || '').trim()
  // 服务仅绑定 loopback；只在固定 loopback 反向代理连接上接受由 Nginx 覆写的 XFF。
  return peer === '127.0.0.1' && forwarded && !forwarded.includes(',') && net.isIP(normalizeIp(forwarded))
    ? normalizeIp(forwarded)
    : peer
}

function redactAuditSecrets(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [已脱敏]')
    .replace(/\b(token|secret|password|authorization|api[_-]?key)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[已脱敏]')
    .replace(/((?:https?:\/\/|\/api\/|\/review-api\/)[^\s?]*)\?[^\s]*/gi, '$1?[查询参数已省略]')
}

function boundedAuditText(value, maxBytes = 512) {
  const normalized = redactAuditSecrets(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  let result = ''
  let size = 0
  for (const character of normalized) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (size + characterBytes > maxBytes) break
    result += character
    size += characterBytes
  }
  return result
}

function boundedHttpAccessLine(tokens, req, res) {
  const event = {
    event: 'review-http-access',
    method: boundedAuditText(tokens.method(req, res) || req.method || '', 16),
    path: boundedAuditText(req.path || '', 512),
    status: Number(tokens.status(req, res)) || 0,
    responseBytes: Number(tokens.res(req, res, 'content-length')) || 0,
    durationMs: Number(tokens['response-time'](req, res)) || 0,
    remoteAddress: boundedAuditText(req.socket?.remoteAddress || '', 128)
  }
  const serialized = JSON.stringify(event)
  return Buffer.byteLength(serialized, 'utf8') <= 2048 && !/[\r\n]/.test(serialized)
    ? serialized
    : '{"event":"review-http-access","error":"access-bounds-failed"}'
}

function normalizeAuditMetadataValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return boundedAuditText(value, 512)
  if (depth >= 4 || !value || typeof value !== 'object') return '[已截断]'
  if (seen.has(value)) return '[循环引用已截断]'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.slice(0, 32).map(item => normalizeAuditMetadataValue(item, depth + 1, seen))
    }
    const normalized = {}
    const entries = Object.entries(value)
      .filter(([key]) => /^[A-Za-z0-9_.:-]{1,64}$/.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 32)
    for (const [key, item] of entries) {
      normalized[key] = /(?:token|secret|password|authorization|api[_-]?key)/i.test(key)
        ? '[已脱敏]'
        : normalizeAuditMetadataValue(item, depth + 1, seen)
    }
    return normalized
  } finally {
    seen.delete(value)
  }
}

function normalizeAuditLog(raw = {}) {
  const log = {
    id: boundedAuditText(raw.id || `L${Date.now()}${crypto.randomBytes(2).toString('hex')}`, 128),
    actor: boundedAuditText(raw.actor || '系统', 256),
    action: boundedAuditText(raw.action || '未记录动作', 1024),
    at: boundedAuditText(raw.at || nowText(), 128)
  }
  const optionalTextFields = {
    category: 128,
    result: 128,
    ip: 128,
    userAgent: 512,
    proposalId: 128,
    proposalTitle: 512,
    source: 128
  }
  for (const [field, maxBytes] of Object.entries(optionalTextFields)) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) log[field] = boundedAuditText(raw[field], maxBytes)
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'metadata')) {
    log.metadata = normalizeAuditMetadataValue(raw.metadata)
  }

  let serialized = JSON.stringify(log)
  if (Buffer.byteLength(serialized, 'utf8') > maxAuditLogEntryBytes) {
    const kind = boundedAuditText(log.metadata?.kind || '', 128)
    log.metadata = { truncated: true, ...(kind ? { kind } : {}) }
    log.action = boundedAuditText(log.action, 512)
    log.proposalTitle = boundedAuditText(log.proposalTitle || '', 256)
    log.userAgent = boundedAuditText(log.userAgent || '', 256)
    serialized = JSON.stringify(log)
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxAuditLogEntryBytes || /[\r\n]/.test(serialized)) {
    throw new Error('审计日志单条超过安全字节上限')
  }
  return log
}

function auditLogStorageCost(log) {
  const serialized = JSON.stringify(log, null, 2)
  const lineCount = 1 + (serialized.match(/\n/g) || []).length
  return Buffer.byteLength(serialized, 'utf8') + lineCount * 8 + 16
}

function appendLog({ req, actor = '系统', action, category = '审核动作', result = '未记录', proposalId = '', proposalTitle = '', metadata = {} }) {
  logs.unshift(normalizeAuditLog({
    id: `L${Date.now()}${crypto.randomBytes(2).toString('hex')}`,
    actor,
    action,
    category,
    result,
    ip: req ? clientIp(req) : '',
    userAgent: req ? String(req.headers['user-agent'] || '') : '',
    proposalId,
    proposalTitle,
    metadata,
    at: nowText()
  }))
  if (metadata?.kind === 'client-error') {
    let seenClientErrors = 0
    logs = logs.filter(log => {
      if (log?.metadata?.kind !== 'client-error') return true
      seenClientErrors += 1
      return seenClientErrors <= maxClientErrorLogEntries
    })
  }
  logs = boundedAuditLogs(logs)
}

function boundedAuditLogs(items = []) {
  if (!Array.isArray(items)) return []
  const retained = items.slice(0, maxAuditLogEntries)
  for (const id of permanentAuditLogIds) {
    const permanent = items.find(item => item?.id === id)
    if (permanent && !retained.some(item => item?.id === id)) {
      if (retained.length >= maxAuditLogEntries) retained[retained.length - 1] = permanent
      else retained.push(permanent)
    }
  }
  const normalized = retained.map(normalizeAuditLog)
  const mandatoryIndexes = new Set()
  for (const id of permanentAuditLogIds) {
    const index = normalized.findIndex(item => item.id === id)
    if (index >= 0) mandatoryIndexes.add(index)
  }
  let remainingBytes = maxAuditLogCollectionBytes
  const selectedIndexes = new Set()
  for (const index of mandatoryIndexes) {
    const cost = auditLogStorageCost(normalized[index])
    if (cost > remainingBytes) throw new Error('永久审计锚点超过日志集合字节上限')
    selectedIndexes.add(index)
    remainingBytes -= cost
  }
  for (let index = 0; index < normalized.length; index += 1) {
    if (selectedIndexes.has(index)) continue
    const cost = auditLogStorageCost(normalized[index])
    if (cost > remainingBytes) continue
    selectedIndexes.add(index)
    remainingBytes -= cost
  }
  return normalized.filter((_item, index) => selectedIndexes.has(index))
}

function hashPassword(password = '') {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex')
  return `scrypt:${salt}:${hash}`
}

function verifyPassword(password = '', passwordHash = '') {
  const [algorithm, salt, storedHash] = String(passwordHash || '').split(':')
  if (algorithm !== 'scrypt' || !salt || !storedHash) return false

  const hash = crypto.scryptSync(String(password), salt, 64)
  const stored = Buffer.from(storedHash, 'hex')
  return stored.length === hash.length && crypto.timingSafeEqual(stored, hash)
}

function passwordStrengthMessage(password = '') {
  const value = String(password || '')
  if (value.length < 8) return '密码至少需要 8 位'
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return '密码需同时包含字母和数字'
  return ''
}

function isKnownDefaultPassword(password = '') {
  return ['admin123', 'First123456'].includes(String(password || ''))
}

function formatUploadSize(value = 0) {
  const size = Number(value) || 0
  if (size >= 1024 * 1024) return `${Math.round(size / 1024 / 1024)}MB`
  if (size >= 1024) return `${Math.round(size / 1024)}KB`
  return `${size}B`
}

function uploadLimitConfig(config = systemConfig) {
  const normalized = normalizeSystemConfig(config || systemConfig)
  return {
    maxFileSizeMb: normalized.maxFileSizeMb,
    maxFileSizeBytes: normalized.maxFileSizeMb * 1024 * 1024,
    maxUploadFiles: normalized.maxUploadFiles,
    maxTotalSizeBytes: uploadHardMaxTotalSize
  }
}

function uploadLimitError(files = [], config = systemConfig) {
  const limits = uploadLimitConfig(config)
  if (files.length > limits.maxUploadFiles) {
    return `文件上传失败：一次最多上传 ${limits.maxUploadFiles} 个附件`
  }
  const oversized = files.filter(file => Number(file.size) > limits.maxFileSizeBytes)
  if (oversized.length > 0) {
    const preview = oversized.slice(0, 3).map(file => file.originalname || file.name || '未命名文件').join('、')
    const moreText = oversized.length > 3 ? ` 等 ${oversized.length} 个文件` : ''
    return `文件上传失败：${preview}${moreText} 超过单个附件上限 ${formatUploadSize(limits.maxFileSizeBytes)}`
  }
  const totalBytes = files.reduce((sum, file) => sum + Math.max(0, Number(file.size) || 0), 0)
  if (totalBytes > uploadHardMaxTotalSize) {
    return `文件上传失败：单次附件总量不能超过 ${formatUploadSize(uploadHardMaxTotalSize)}`
  }
  return ''
}

function attachmentStorageUsage() {
  if (!fs.existsSync(filesDir)) return { bytes: 0, files: 0 }
  const root = fs.lstatSync(filesDir)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('附件目录类型不安全，拒绝计算容量')
  let totalBytes = 0
  const names = fs.readdirSync(filesDir)
  if (names.length > attachmentStorageHardMaxFileCount) {
    throw new Error(`附件库存数量已超过 ${attachmentStorageHardMaxFileCount} 个可恢复上限`)
  }
  for (const name of names) {
    if (!safeStoredName(name)) throw new Error(`附件目录包含非法名称：${name}`)
    let descriptor
    try {
      descriptor = openStoredAttachment(name)
      const info = fs.fstatSync(descriptor)
      totalBytes += info.size
      if (!Number.isSafeInteger(totalBytes)) throw new Error('附件库存容量溢出')
    } finally {
      closeStoreDescriptor(descriptor)
    }
  }
  return { bytes: totalBytes, files: names.length }
}

function attachmentStorageCapacity() {
  const usage = attachmentStorageUsage()
  return {
    capacityBytes: attachmentStorageHardMaxBytes,
    capacityFiles: attachmentStorageHardMaxFileCount,
    usedBytes: usage.bytes,
    usedFiles: usage.files,
    reservedBytes: reservedAttachmentBytes,
    reservedFiles: reservedAttachmentFileCount,
    remainingBytes: Math.max(0, attachmentStorageHardMaxBytes - usage.bytes - reservedAttachmentBytes),
    remainingFiles: Math.max(0, attachmentStorageHardMaxFileCount - usage.files - reservedAttachmentFileCount)
  }
}

function filesystemFreeBytes(directory = dataDir) {
  const testOverride = Number(process.env.BACKUP_TEST_FILESYSTEM_FREE_BYTES)
  if (process.env.NODE_ENV === 'test' && Number.isSafeInteger(testOverride) && testOverride >= 0) {
    return testOverride
  }
  const stats = fs.statfsSync(directory)
  const blockSize = Number(stats.bsize)
  const availableBlocks = Number(stats.bavail)
  const bytes = blockSize * availableBlocks
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('无法安全计算 data 文件系统可用空间')
  return bytes
}

function assertBackupRestoreDiskHeadroom(requiredBytes, phase, directory = dataDir) {
  const required = Number(requiredBytes)
  if (!Number.isSafeInteger(required) || required < backupRestoreReserveBytes) {
    throw new Error(`恢复阶段 ${phase} 的磁盘需求不正确`)
  }
  const free = filesystemFreeBytes(directory)
  if (free < required) {
    const error = new Error(`备份/恢复阶段“${phase}”磁盘可用空间不足：需要 ${formatUploadSize(required)}，当前 ${formatUploadSize(free)}`)
    error.code = 'RESTORE_DISK_SPACE'
    throw error
  }
  return free
}

function backupFailureStatus(error, fallback = 400) {
  if (error?.code === 'RESTORE_DISK_SPACE') return 507
  if (/上限|超出|过大/i.test(String(error?.message || ''))) return 413
  return fallback
}

function requireBackupRestoreUploadCapacity(req, res, next) {
  try {
    const contentLength = Number(req.headers['content-length'])
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
      return res.status(411).json({ message: '备份恢复上传必须提供可验证的 Content-Length' })
    }
    if (contentLength > backupHardMaxArchiveBytes + 1024 * 1024) {
      return res.status(413).json({ message: `备份恢复请求不能超过 ${formatUploadSize(backupHardMaxArchiveBytes)}` })
    }
    // 上传文件自身也占用 data 文件系统；门禁保证它完整落盘后仍保有 18GiB，
    // 足以并存解包 staging、恢复前快照和旧附件回滚目录。
    assertBackupRestoreDiskHeadroom(backupRestoreConfiguredMinimumFreeBytes + contentLength, '接收归档前')
    next()
  } catch (error) {
    res.status(507).json({ message: error.message || '备份恢复磁盘空间不足' })
  }
}

function requireBackupPreviewUploadCapacity(req, res, next) {
  try {
    const contentLength = Number(req.headers['content-length'])
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
      return res.status(411).json({ message: '备份预览上传必须提供可验证的 Content-Length' })
    }
    if (contentLength > backupHardMaxArchiveBytes + 1024 * 1024) {
      return res.status(413).json({ message: `备份预览请求不能超过 ${formatUploadSize(backupHardMaxArchiveBytes)}` })
    }
    assertBackupRestoreDiskHeadroom(contentLength + backupRestoreReserveBytes, '接收预览归档前')
    next()
  } catch (error) {
    res.status(507).json({ message: error.message || '备份预览磁盘空间不足' })
  }
}

function requireAttachmentStorageCapacity(req, res, next) {
  try {
    const capacity = attachmentStorageCapacity()
    if (capacity.reservedBytes > 0) {
      res.setHeader('Retry-After', '5')
      return res.status(409).json({ message: '已有附件提交正在处理，请稍后重试' })
    }
    if (capacity.remainingBytes <= 0 || capacity.remainingFiles <= 0) {
      return res.status(413).json({ message: '附件库存已达到受控容量或文件数量上限，请先归档或删除不再使用的方案' })
    }
    const contentLength = Number(req.headers['content-length'])
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
      return res.status(411).json({ message: '附件提交必须提供可验证的 Content-Length' })
    }
    if (contentLength > uploadHardMaxTotalSize + 1024 * 1024) {
      return res.status(413).json({ message: `附件请求总量不能超过 ${formatUploadSize(uploadHardMaxTotalSize)}` })
    }
    // 在 multer 读取 body 之前同步占位；同时只允许一个附件请求进入内存，
    // 防止多个 48MiB multipart 同时通过门禁后耗尽主进程内存。
    const preReservedBytes = Math.min(contentLength, uploadHardMaxTotalSize)
    if (preReservedBytes > capacity.remainingBytes) {
      return res.status(413).json({ message: `附件库存剩余 ${formatUploadSize(capacity.remainingBytes)}，本次请求无法完整保存` })
    }
    if (uploadHardMaxFileCount > capacity.remainingFiles) {
      return res.status(413).json({ message: `附件库存剩余 ${capacity.remainingFiles} 个文件名额，本次请求无法安全预留` })
    }
    reservedAttachmentBytes += preReservedBytes
    reservedAttachmentFileCount += uploadHardMaxFileCount
    let released = false
    const reservation = {
      reservedBytes: preReservedBytes,
      reservedFiles: uploadHardMaxFileCount,
      release() {
        if (released) return
        released = true
        reservedAttachmentBytes = Math.max(0, reservedAttachmentBytes - reservation.reservedBytes)
        reservedAttachmentFileCount = Math.max(0, reservedAttachmentFileCount - reservation.reservedFiles)
      }
    }
    req.attachmentStorageReservation = reservation
    res.once('finish', reservation.release)
    res.once('close', reservation.release)
    next()
  } catch (error) {
    req.attachmentStorageReservation?.release?.()
    return res.status(503).json({ message: `无法安全确认附件库存容量：${error.message}` })
  }
}

function proposalFileUpload(req, res, next) {
  upload.array('files')(req, res, error => {
    if (!error) return next()
    req.attachmentStorageReservation?.release?.()
    return next(error)
  })
}

function finalizeAttachmentStorageReservation(req, files = []) {
  const reservation = req.attachmentStorageReservation
  if (!reservation || typeof reservation.release !== 'function') {
    return { ok: false, status: 503, message: '附件容量预留状态缺失，已拒绝写入' }
  }
  const requestBytes = files.reduce((sum, file) => sum + Math.max(0, Number(file.size) || 0), 0)
  const requestFiles = files.length
  const usage = attachmentStorageUsage()
  const otherReservedBytes = Math.max(0, reservedAttachmentBytes - reservation.reservedBytes)
  const otherReservedFiles = Math.max(0, reservedAttachmentFileCount - reservation.reservedFiles)
  if (usage.bytes + otherReservedBytes + requestBytes > attachmentStorageHardMaxBytes) {
    return {
      ok: false,
      status: 413,
      message: `附件库存总量不能超过 ${formatUploadSize(attachmentStorageHardMaxBytes)}，当前已用 ${formatUploadSize(usage.bytes)}`
    }
  }
  if (usage.files + otherReservedFiles + requestFiles > attachmentStorageHardMaxFileCount) {
    return {
      ok: false,
      status: 413,
      message: `附件库存文件数量不能超过 ${attachmentStorageHardMaxFileCount} 个，当前已有 ${usage.files} 个`
    }
  }
  reservedAttachmentBytes = otherReservedBytes + requestBytes
  reservedAttachmentFileCount = otherReservedFiles + requestFiles
  reservation.reservedBytes = requestBytes
  reservation.reservedFiles = requestFiles
  return { ok: true, release: reservation.release }
}

function multerErrorMessage(err, config = systemConfig) {
  const limits = uploadLimitConfig(config)
  const messages = {
    LIMIT_FILE_SIZE: `文件上传失败：单个附件不能超过 ${formatUploadSize(limits.maxFileSizeBytes)}`,
    LIMIT_FILE_COUNT: `文件上传失败：一次最多上传 ${limits.maxUploadFiles} 个附件`,
    LIMIT_UNEXPECTED_FILE: `文件上传失败：附件字段不符合要求，请重新选择文件`
  }
  return messages[err.code] || `文件上传失败：${err.message || '请检查附件后重试'}`
}


function loadReviewSsoSecret() {
  const inlineSecret = String(process.env.REVIEW_SSO_SECRET || '')
  if (inlineSecret) {
    if (inlineSecret.length < 32) throw new Error('REVIEW_SSO_SECRET 缺失或过短，拒绝启动')
    return inlineSecret
  }

  const configuredPath = String(process.env.REVIEW_SSO_SECRET_FILE || '').trim()
  if (!configuredPath) throw new Error('必须配置 REVIEW_SSO_SECRET_FILE 或 REVIEW_SSO_SECRET，拒绝运行时生成新密钥')
  let secret
  try {
    const info = fs.lstatSync(configuredPath)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error('SSO 密钥必须是单链接普通文件')
    }
    secret = fs.readFileSync(configuredPath, 'utf8').trim()
  } catch (error) {
    throw new Error(`无法读取 REVIEW_SSO_SECRET_FILE：${error.message || error}`)
  }
  if (secret.length < 32) throw new Error('REVIEW_SSO_SECRET_FILE 内容缺失或过短，拒绝启动')
  return secret
}

// 启动时立即验证共享密钥，不把故障延迟到首个 SSO 请求。
const reviewSsoSecret = loadReviewSsoSecret()

const consumedCockpitSsoNonces = new Map()
const cockpitSsoNoncePattern = /^[A-Za-z0-9_-]{16,128}$/
const maxConsumedCockpitSsoNonces = 4096

function persistConsumedCockpitSsoNonces() {
  const entries = [...consumedCockpitSsoNonces.entries()]
    .sort((left, right) => left[1] - right[1])
    .slice(-maxConsumedCockpitSsoNonces)
  durableWriteJsonFileEarly(ssoNonceStateFile, {
    schema: 'first-service-cockpit-sso-nonce-v1',
    entries
  }, 0o600)
}

function durableWriteJsonFileEarly(filePath, value, mode = 0o600) {
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  let descriptor
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag,
      mode
    )
    fs.fchmodSync(descriptor, mode)
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2))
    fs.fsyncSync(descriptor)
    fs.renameSync(temporary, filePath)
    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | noFollowFlag)
    try {
      fs.fsyncSync(directoryDescriptor)
    } finally {
      fs.closeSync(directoryDescriptor)
    }
  } finally {
    closeStoreDescriptor(descriptor)
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    } catch {}
  }
}

function loadConsumedCockpitSsoNonces() {
  let descriptor
  try {
    descriptor = fs.openSync(ssoNonceStateFile, fs.constants.O_RDONLY | noFollowFlag)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw new Error(`无法打开 SSO nonce 状态：${error.message}`)
  }
  try {
    const info = fs.fstatSync(descriptor)
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 512 * 1024) {
      throw new Error('SSO nonce 状态必须是 512KiB 内的 0600 单链接普通文件')
    }
    const parsed = JSON.parse(fs.readFileSync(descriptor, 'utf8'))
    if (parsed?.schema !== 'first-service-cockpit-sso-nonce-v1' || !Array.isArray(parsed.entries)) {
      throw new Error('SSO nonce 状态 schema 不正确')
    }
    const now = Date.now()
    let removedExpired = false
    for (const item of parsed.entries) {
      if (!Array.isArray(item) || item.length !== 2) throw new Error('SSO nonce 状态项结构不正确')
      const [nonce, expiresAt] = item
      if (typeof nonce !== 'string' || !cockpitSsoNoncePattern.test(nonce) || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
        throw new Error('SSO nonce 状态项值不正确')
      }
      if (expiresAt > now) consumedCockpitSsoNonces.set(nonce, expiresAt)
      else removedExpired = true
    }
    if (consumedCockpitSsoNonces.size > maxConsumedCockpitSsoNonces) throw new Error('SSO nonce 状态超出有界上限')
    if (removedExpired) persistConsumedCockpitSsoNonces()
  } finally {
    closeStoreDescriptor(descriptor)
  }
}

function cleanupConsumedCockpitSsoNonces(now = Date.now()) {
  for (const [nonce, expiresAt] of consumedCockpitSsoNonces.entries()) {
    if (expiresAt <= now) consumedCockpitSsoNonces.delete(nonce)
  }
}

loadConsumedCockpitSsoNonces()

function timingSafeEqualText(a = '', b = '') {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function verifyCockpitSsoToken(token = '') {
  const tokenParts = String(token || '').split('.')
  if (tokenParts.length !== 2) return null
  const [payloadPart, signaturePart] = tokenParts
  if (!payloadPart || !signaturePart) return null
  const expected = crypto.createHmac('sha256', reviewSsoSecret).update(payloadPart).digest('base64url')
  if (!timingSafeEqualText(signaturePart, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))
    const now = Date.now()
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= now) return null
    if (typeof payload.nonce !== 'string' || !cockpitSsoNoncePattern.test(payload.nonce)) return null

    // Node 单进程中这段代码没有异步让渡，检查与占用 nonce 是同步原子操作。
    cleanupConsumedCockpitSsoNonces(now)
    if (consumedCockpitSsoNonces.has(payload.nonce)) return null
    consumedCockpitSsoNonces.set(payload.nonce, payload.exp)
    if (consumedCockpitSsoNonces.size > maxConsumedCockpitSsoNonces) {
      consumedCockpitSsoNonces.delete(payload.nonce)
      return null
    }
    try {
      persistConsumedCockpitSsoNonces()
    } catch (error) {
      consumedCockpitSsoNonces.delete(payload.nonce)
      console.error('SSO nonce 无法持久化，已拒绝票据', error)
      return null
    }
    return payload
  } catch {
    return null
  }
}

function findCockpitSsoUser(payload = {}) {
  if (normalizeUserRole(payload.role) !== '管理员') return null
  const preferred = usernameIdentityKey(payload.username || '')
  const exact = users.find(user => usernameIdentityKey(user.username) === preferred && user.status === '启用')
  if (exact) return exact
  const enabledAdmin = users.find(user => normalizeUserRole(user.role) === '管理员' && user.status === '启用')
  if (enabledAdmin) return enabledAdmin
  return {
    id: 'cockpit-sso',
    username: String(payload.username || 'cockpit-admin').trim() || 'cockpit-admin',
    name: String(payload.name || payload.username || '驾驶舱管理员').trim() || '驾驶舱管理员',
    role: '管理员',
    status: '启用',
    ssoOnly: true
  }
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = Date.now() + sessionTtlMs()
  tokens.set(token, {
    name: user.name,
    role: user.role,
    username: user.username,
    ssoOnly: user.ssoOnly === true,
    createdAt: Date.now(),
    expiresAt
  })
  return { token, expiresAt }
}

function createHermesSyncPreview(username = '', keepRuntimeFlags = true) {
  const now = Date.now()
  for (const [token, item] of hermesSyncPreviews.entries()) {
    if (item.expiresAt <= now || item.username === username) hermesSyncPreviews.delete(token)
  }
  const token = crypto.randomBytes(32).toString('hex')
  const preview = {
    username,
    keepRuntimeFlags,
    generatedAt: new Date(now).toISOString(),
    expiresAt: now + hermesSyncPreviewTtlMs
  }
  hermesSyncPreviews.set(token, preview)
  return { token, ...preview, expiresAt: new Date(preview.expiresAt).toISOString() }
}

function consumeHermesSyncPreview(token = '', username = '') {
  const preview = hermesSyncPreviews.get(String(token || ''))
  if (!preview || preview.username !== username || preview.expiresAt <= Date.now()) {
    if (preview) hermesSyncPreviews.delete(String(token || ''))
    return null
  }
  hermesSyncPreviews.delete(String(token || ''))
  return preview
}

function tokenFingerprint(token = '') {
  if (!token) return ''
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12)
}

function loginFailureKey(username = '') {
  const normalized = usernameIdentityKey(username)
  return normalized ? crypto.createHash('sha256').update(`account:${normalized}`).digest('hex') : ''
}

function authRateKey(namespace, value = '') {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized ? crypto.createHash('sha256').update(`${namespace}:${normalized}`).digest('hex') : ''
}

function cleanupRateMap(map, now = Date.now()) {
  let changed = false
  for (const [key, record] of map.entries()) {
    const expiry = Math.max(Number(record.lockedUntil) || 0, Number(record.firstFailedAt) + (Number(record.windowMs) || 0))
    if (!Number.isFinite(expiry) || expiry <= now) {
      map.delete(key)
      changed = true
    }
  }
  return changed
}

function boundedRateSet(map, key, record, maxEntries) {
  if (!key) return
  if (!map.has(key) && map.size >= maxEntries) {
    const oldest = [...map.entries()].sort((left, right) => (
      (Number(left[1].lockedUntil) || Number(left[1].firstFailedAt) || 0) -
      (Number(right[1].lockedUntil) || Number(right[1].firstFailedAt) || 0)
    ))[0]
    if (oldest) map.delete(oldest[0])
  }
  map.set(key, record)
}

function rateRecord(map, key, { threshold, windowMs, lockMs, maxEntries }) {
  const now = Date.now()
  cleanupRateMap(map, now)
  const current = map.get(key)
  const record = current && current.firstFailedAt + current.windowMs > now
    ? { ...current }
    : { count: 0, firstFailedAt: now, lockedUntil: 0, windowMs }
  record.count += 1
  record.windowMs = windowMs
  if (record.count >= threshold) record.lockedUntil = Math.max(record.lockedUntil || 0, now + lockMs)
  boundedRateSet(map, key, record, maxEntries)
  return record
}

function rateRetryAfter(record, now = Date.now()) {
  return Math.max(1, Math.ceil((Math.max(record?.lockedUntil || 0, now + 1000) - now) / 1000))
}

function persistAuthRateState() {
  const encode = map => [...map.entries()].map(([key, value]) => [key, value])
  durableWriteJsonFileEarly(authRateStateFile, {
    schema: 'first-service-auth-rate-v1',
    loginAccounts: encode(loginFailures),
    loginIps: encode(loginIpFailures),
    loginPairs: encode(loginPairFailures),
    ssoIps: encode(ssoIpFailures)
  }, 0o600)
}

function loadAuthRateState() {
  let descriptor
  try {
    descriptor = fs.openSync(authRateStateFile, fs.constants.O_RDONLY | noFollowFlag)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw new Error(`无法打开认证限流状态：${error.message}`)
  }
  try {
    const info = fs.fstatSync(descriptor)
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 1024 * 1024) {
      throw new Error('认证限流状态必须是 1MiB 内的 0600 单链接普通文件')
    }
    const payload = JSON.parse(fs.readFileSync(descriptor, 'utf8'))
    if (payload?.schema !== 'first-service-auth-rate-v1') throw new Error('认证限流状态 schema 不正确')
    const restore = (map, entries, maxEntries) => {
      if (!Array.isArray(entries) || entries.length > maxEntries) throw new Error('认证限流状态条目超出有界上限')
      for (const item of entries) {
        if (!Array.isArray(item) || item.length !== 2 || !/^[a-f0-9]{64}$/.test(item[0])) throw new Error('认证限流状态 key 不正确')
        const record = item[1]
        if (!record || !Number.isFinite(record.count) || !Number.isFinite(record.firstFailedAt) || !Number.isFinite(record.lockedUntil) || !Number.isFinite(record.windowMs)) {
          throw new Error('认证限流状态记录不正确')
        }
        map.set(item[0], record)
      }
      cleanupRateMap(map)
    }
    restore(loginFailures, payload.loginAccounts, 512)
    restore(loginIpFailures, payload.loginIps, 1024)
    restore(loginPairFailures, payload.loginPairs, 2048)
    restore(ssoIpFailures, payload.ssoIps, 1024)
  } finally {
    closeStoreDescriptor(descriptor)
  }
}

loadAuthRateState()

function currentLoginFailure(username = '') {
  const key = loginFailureKey(username)
  const record = loginFailures.get(key)
  if (!record) return null
  if (record.lockedUntil && record.lockedUntil > Date.now()) return record
  if (record.firstFailedAt + loginFailureWindowMs() < Date.now()) {
    loginFailures.delete(key)
    return null
  }
  return record
}

function recordLoginFailure(username = '') {
  const key = loginFailureKey(username)
  if (!key) return null
  const current = currentLoginFailure(username)
  const record = current || { count: 0, firstFailedAt: Date.now(), lockedUntil: 0, windowMs: loginFailureWindowMs() }
  record.windowMs = loginFailureWindowMs()
  record.count += 1
  if (record.count >= (systemConfig.maxLoginFailures || 5)) record.lockedUntil = Date.now() + loginLockMs()
  boundedRateSet(loginFailures, key, record, 512)
  return record
}

function clearLoginFailures(username = '') {
  const key = loginFailureKey(username)
  if (key) loginFailures.delete(key)
}

function clearLoginRateSuccess(req, username = '') {
  clearLoginFailures(username)
  loginPairFailures.delete(authRateKey('pair', `${clientIp(req) || 'unknown'}\0${usernameIdentityKey(username)}`))
  persistAuthRateState()
}

function loginRateLimit(req, username = '') {
  const ipKey = authRateKey('ip', clientIp(req) || 'unknown')
  const pairKey = authRateKey('pair', `${clientIp(req) || 'unknown'}\0${usernameIdentityKey(username)}`)
  const records = [loginIpFailures.get(ipKey), loginPairFailures.get(pairKey), currentLoginFailure(username)].filter(Boolean)
  return records.find(record => record.lockedUntil > Date.now()) || null
}

function recordLoginRateFailure(req, username = '', knownAccount = false) {
  const ip = clientIp(req) || 'unknown'
  const windowMs = loginFailureWindowMs()
  const lockMs = loginLockMs()
  const ipRecord = rateRecord(loginIpFailures, authRateKey('ip', ip), {
    threshold: 30, windowMs, lockMs, maxEntries: 1024
  })
  const pairRecord = rateRecord(loginPairFailures, authRateKey('pair', `${ip}\0${usernameIdentityKey(username)}`), {
    threshold: 8, windowMs, lockMs, maxEntries: 2048
  })
  const accountRecord = knownAccount ? recordLoginFailure(username) : null
  persistAuthRateState()
  return [accountRecord, pairRecord, ipRecord].filter(Boolean).sort((a, b) => (b.lockedUntil || 0) - (a.lockedUntil || 0))[0]
}

function recordSsoRateFailure(req) {
  const record = rateRecord(ssoIpFailures, authRateKey('sso-ip', clientIp(req) || 'unknown'), {
    threshold: 20,
    windowMs: 5 * 60 * 1000,
    lockMs: 10 * 60 * 1000,
    maxEntries: 1024
  })
  persistAuthRateState()
  return record
}

function currentSsoRateLimit(req) {
  cleanupRateMap(ssoIpFailures)
  const record = ssoIpFailures.get(authRateKey('sso-ip', clientIp(req) || 'unknown'))
  return record?.lockedUntil > Date.now() ? record : null
}

function sendRateLimited(res, record, message = '请求过于频繁，请稍后再试') {
  res.setHeader('Retry-After', String(rateRetryAfter(record)))
  return res.status(429).json({ message })
}

const nonPersistingReadMethods = new Set(['GET', 'HEAD'])
const securityAuditEventMaxBytes = 4 * 1024
const securityAuditMetadataMaxBytes = 1536
const securityAuditMetadataKeys = new Set([
  'requiredPermission',
  'requiredPermissions',
  'role',
  'permissions',
  'username',
  'proposalId',
  'fileId',
  'submitterUsername'
])

function boundedSecurityAuditText(value, maxBytes = 512) {
  return boundedAuditText(value, maxBytes)
}

function boundedSecurityAuditMetadata(metadata = {}) {
  const bounded = {}
  for (const key of securityAuditMetadataKeys) {
    if (!Object.prototype.hasOwnProperty.call(metadata, key)) continue
    const raw = metadata[key]
    let value
    if (Array.isArray(raw)) {
      value = raw.slice(0, 16).map(item => boundedSecurityAuditText(item, 96))
    } else if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      value = typeof raw === 'string' ? boundedSecurityAuditText(raw, 256) : raw
    } else {
      continue
    }
    const candidate = { ...bounded, [key]: value }
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > securityAuditMetadataMaxBytes) break
    bounded[key] = value
  }
  return bounded
}

function writeBoundedSecurityAudit(event) {
  let serialized = JSON.stringify(event)
  if (Buffer.byteLength(serialized, 'utf8') > securityAuditEventMaxBytes) {
    serialized = JSON.stringify({
      event: 'review-permission-denied',
      occurredAt: event.occurredAt,
      actor: boundedSecurityAuditText(event.actor, 128),
      method: boundedSecurityAuditText(event.method, 16),
      path: boundedSecurityAuditText(event.path, 256),
      action: '权限拒绝（事件字段已按容量上限缩减）',
      metadata: {}
    })
  }
  if (Buffer.byteLength(serialized, 'utf8') > securityAuditEventMaxBytes || /[\r\n]/.test(serialized)) {
    console.warn('{"event":"review-permission-denied","error":"audit-bounds-failed"}')
    return
  }
  console.warn(serialized)
}

function recordPermissionDenial({ req, action, metadata = {} }) {
  const actor = req.user?.name || req.user?.username || '未知账号'
  if (nonPersistingReadMethods.has(String(req.method || '').toUpperCase())) {
    // GET/HEAD 的所有响应路径都必须保持业务 store 字节、inode 与 mtime 不变。
    // 安全拒绝仍写单行、有界的结构化 stderr/journald；只记录不含 query 的 path。
    writeBoundedSecurityAudit({
      event: 'review-permission-denied',
      occurredAt: new Date().toISOString(),
      actor: boundedSecurityAuditText(actor, 256),
      method: boundedSecurityAuditText(String(req.method || '').toUpperCase(), 16),
      path: boundedSecurityAuditText(req.path || '', 512),
      action: boundedSecurityAuditText(action, 512),
      metadata: boundedSecurityAuditMetadata(metadata)
    })
    return
  }
  appendLog({
    req,
    actor,
    action,
    category: '账号安全',
    result: '拒绝',
    metadata
  })
  saveStore()
}

function requirePermission(permission) {
  return (req, res, next) => {
    const permissions = req.user?.permissions || permissionsForRole(req.user?.role)
    if (!permissions.includes(permission)) {
      recordPermissionDenial({
        req,
        action: `权限拒绝：${req.method} ${req.path || ''}`,
        metadata: {
          requiredPermission: permission,
          role: req.user?.role || '',
          permissions
        }
      })
      return res.status(403).json({ message: '当前账号无权限执行该操作' })
    }
    next()
  }
}

function requireAnyPermission(requiredPermissions = []) {
  return (req, res, next) => {
    const permissions = req.user?.permissions || permissionsForRole(req.user?.role)
    if (!requiredPermissions.some(permission => permissions.includes(permission))) {
      recordPermissionDenial({
        req,
        action: `权限拒绝：${req.method} ${req.path || ''}`,
        metadata: {
          requiredPermissions,
          role: req.user?.role || '',
          permissions
        }
      })
      return res.status(403).json({ message: '当前账号无权限执行该操作' })
    }
    next()
  }
}

function requireConfirmText(req, res, expectedText = '') {
  const expected = String(expectedText || '').trim()
  if (!expected) return true
  if (String(req.body?.confirmText || '').trim() === expected) return true
  res.status(400).json({ message: `请输入“${expected}”后再执行该操作` })
  return false
}

function requireAdministrator(req, res, action = '执行管理员级操作') {
  if (normalizeUserRole(req.user?.role) === '管理员') return true
  appendLog({
    req,
    actor: req.user?.name || req.user?.username || '未知账号',
    action: `权限拒绝：${action}`,
    category: '账号安全',
    result: '拒绝',
    metadata: {
      requiredRole: '管理员',
      role: req.user?.role || '',
      permissions: req.user?.permissions || []
    }
  })
  saveStore()
  res.status(403).json({ message: '仅管理员角色可执行该操作' })
  return false
}

function requireAssignableRole(req, res, role, action = '分配账号角色') {
  if (!isAssignableUserRole(role)) {
    res.status(400).json({ message: '该角色为遗留角色或无效角色，不可新分配' })
    return false
  }
  if (normalizeUserRole(req.user?.role) === '管理员') return true
  const actorPermissions = req.user?.permissions || permissionsForRole(req.user?.role)
  const targetPermissions = permissionsForRole(role)
  if (targetPermissions.every(permission => actorPermissions.includes(permission))) return true
  appendLog({
    req,
    actor: req.user?.name || req.user?.username || '未知账号',
    action: `权限拒绝：${action}`,
    category: '账号安全',
    result: '拒绝',
    metadata: {
      targetRole: normalizeUserRole(role),
      actorRole: req.user?.role || '',
      actorPermissions,
      targetPermissions
    }
  })
  saveStore()
  res.status(403).json({ message: '不能分配超出当前账号权限范围的角色' })
  return false
}

function canManageTargetUser(req, user = {}) {
  if (normalizeUserRole(req.user?.role) === '管理员') return true
  if (normalizeUserRole(user.role) === '管理员') return false
  const actorPermissions = req.user?.permissions || permissionsForRole(req.user?.role)
  return permissionsForRole(user.role).every(permission => actorPermissions.includes(permission))
}

function requireManageableUser(req, res, user, action = '管理目标账号') {
  if (canManageTargetUser(req, user)) return true
  appendLog({
    req,
    actor: req.user?.name || req.user?.username || '未知账号',
    action: `权限拒绝：${action}`,
    category: '账号安全',
    result: '拒绝',
    metadata: {
      targetUsername: user?.username || '',
      targetRole: user?.role || '',
      actorRole: req.user?.role || '',
      actorPermissions: req.user?.permissions || [],
      targetPermissions: permissionsForRole(user?.role)
    }
  })
  saveStore()
  res.status(403).json({ message: '不能管理超出当前账号权限范围的账号' })
  return false
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token || !tokens.has(token)) return res.status(401).json({ message: '未登录' })
  const session = tokens.get(token)
  if (!session.expiresAt || session.expiresAt <= Date.now()) {
    tokens.delete(token)
    return res.status(401).json({ message: '登录已过期，请重新登录' })
  }
  let user
  if (session.ssoOnly === true) {
    if (normalizeUserRole(session.role) !== '管理员') {
      tokens.delete(token)
      return res.status(401).json({ message: '单点登录会话权限无效' })
    }
    user = {
      username: session.username,
      name: session.name,
      role: '管理员',
      status: '启用',
      ssoOnly: true
    }
  } else {
    user = users.find(item => item.username === session.username)
    if (!user || user.status === '停用') {
      tokens.delete(token)
      return res.status(401).json({ message: '账号已停用，请联系管理员' })
    }
  }
  session.expiresAt = Date.now() + sessionTtlMs()
  req.user = {
    ...session,
    role: user.role,
    name: user.name,
    username: user.username,
    permissions: permissionsForRole(user.role),
    mustChangePassword: shouldForcePasswordChange(user)
  }
  res.setHeader('X-User-Role', encodeURIComponent(req.user.role))
  res.setHeader('X-User-Permissions', req.user.permissions.join(','))
  res.setHeader('X-User-Must-Change-Password', req.user.mustChangePassword ? 'true' : 'false')
  res.setHeader('X-Session-Expires-At', new Date(session.expiresAt).toISOString())
  if (req.user.mustChangePassword) {
    const passwordChangeAllowedPaths = ['/api/auth/session', '/api/auth/logout', '/api/auth/change-password']
    if (!passwordChangeAllowedPaths.includes(req.path)) {
      recordPermissionDenial({
        req,
        action: `强制改密拦截：${req.method} ${req.path || ''}`,
        metadata: {
          username: req.user?.username || '',
          role: req.user?.role || ''
        }
      })
      return res.status(403).json({ message: '请先修改初始密码后再继续操作', mustChangePassword: true })
    }
  }
  next()
}


app.post('/api/auth/cockpit-sso', (req, res) => {
  const blocked = currentSsoRateLimit(req)
  if (blocked) return sendRateLimited(res, blocked, '单点登录尝试过于频繁，请稍后再试')
  const payload = verifyCockpitSsoToken(req.body?.token || '')
  if (!payload) {
    const failure = recordSsoRateFailure(req)
    if (failure.lockedUntil > Date.now()) return sendRateLimited(res, failure, '单点登录尝试过于频繁，请稍后再试')
    return res.status(401).json({ message: '驾驶舱单点登录凭证无效或已过期' })
  }
  const user = findCockpitSsoUser(payload)
  if (!user) return res.status(403).json({ message: '审核系统未找到可用管理员账号' })
  clearLoginRateSuccess(req, user.username)
  user.lastLoginAt = nowText()
  user.lastLoginIp = clientIp(req)
  const { token, expiresAt } = createSession(user)
  appendLog({
    req,
    actor: user.name,
    action: '驾驶舱单点登录',
    category: '账号安全',
    result: '成功',
    metadata: { cockpitUsername: payload.username || '', cockpitRole: payload.role || '' }
  })
  saveStore()
  res.json({
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    user: {
      username: user.username,
      name: user.name,
      role: user.role,
      permissions: permissionsForRole(user.role),
      mustChangePassword: false
    }
  })
})

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {}
  const normalizedUsername = String(username || '').trim()
  const usernameKey = usernameIdentityKey(normalizedUsername)
  const user = users.find(u => usernameIdentityKey(u.username) === usernameKey && u.status === '启用')
  const blocked = loginRateLimit(req, normalizedUsername)
  if (blocked) return sendRateLimited(res, blocked, '登录尝试过于频繁，请稍后再试')
  if (!user) {
    const failure = recordLoginRateFailure(req, normalizedUsername, false)
    if (failure.lockedUntil > Date.now()) return sendRateLimited(res, failure, '登录尝试过于频繁，请稍后再试')
    // 未知账号不写业务 store/审计日志，避免随机用户名制造无界磁盘写。
    return res.status(401).json({ message: '用户名或密码错误' })
  }
  if (!verifyPassword(password, user.passwordHash)) {
    const failure = recordLoginRateFailure(req, normalizedUsername, true)
    appendLog({
      req,
      actor: normalizedUsername || '未知账号',
      action: `登录失败${failure?.lockedUntil ? '，账号临时锁定' : ''}`,
      category: '账号安全',
      result: failure?.lockedUntil ? '锁定' : '失败',
      metadata: { failureCount: failure?.count || 1 }
    })
    saveStore()
    if (failure?.lockedUntil > Date.now()) return sendRateLimited(res, failure, '登录尝试过于频繁，请稍后再试')
    return res.status(401).json({ message: '用户名或密码错误' })
  }

  if (shouldForcePasswordChange(user) && user.temporaryCredentialIssuedAt) {
    if (user.temporaryCredentialConsumedAt) {
      return res.status(401).json({ message: '临时凭据已使用，请联系管理员重置密码' })
    }
    user.temporaryCredentialConsumedAt = nowText()
  }

  clearLoginRateSuccess(req, user.username)
  user.lastLoginAt = nowText()
  user.lastLoginIp = clientIp(req)
  const { token, expiresAt } = createSession(user)
  appendLog({ req, actor: user.name, action: '登录系统', category: '账号安全', result: '成功' })
  saveStore()
  res.json({
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    user: {
      username: user.username,
      name: user.name,
      role: user.role,
      permissions: permissionsForRole(user.role),
      mustChangePassword: shouldForcePasswordChange(user)
    }
  })
})

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  const token = (req.headers.authorization || '').slice(7)
  tokens.delete(token)
  appendLog({ req, actor: req.user?.name || '未知账号', action: '退出登录', category: '账号安全', result: '成功' })
  saveStore()
  res.json({ ok: true })
})

app.get('/api/auth/session', authMiddleware, (req, res) => {
  res.json({
    ok: true,
    expiresAt: new Date(req.user.expiresAt).toISOString(),
    user: {
      username: req.user.username,
      name: req.user.name,
      role: req.user.role,
      permissions: req.user.permissions,
      mustChangePassword: req.user.mustChangePassword === true
    }
  })
})

app.get('/api/upload-limits', authMiddleware, (_req, res) => {
  const limits = uploadLimitConfig()
  const storage = attachmentStorageCapacity()
  const readiness = aiReviewReadinessState()
  res.json({
    maxFileSizeMb: limits.maxFileSizeMb,
    maxFileSizeBytes: limits.maxFileSizeBytes,
    maxUploadFiles: limits.maxUploadFiles,
    maxTotalSizeBytes: limits.maxTotalSizeBytes,
    attachmentStorageCapacityBytes: storage.capacityBytes,
    attachmentStorageCapacityFiles: storage.capacityFiles,
    attachmentStorageUsedBytes: storage.usedBytes,
    attachmentStorageUsedFiles: storage.usedFiles,
    attachmentStorageRemainingBytes: storage.remainingBytes,
    attachmentStorageRemainingFiles: storage.remainingFiles,
    allowedExtensions: [...proposalAttachmentExtensions],
    reviewReady: readiness.reviewReady,
    submissionMode: readiness.submissionMode,
    reviewReadinessMessage: readiness.message,
    activeProfileCount: readiness.activeProfileCount,
    profileWorkflowReady: readiness.profileWorkflowReady,
    gatewayConfigured: readiness.gatewayConfigured,
    agentConfigured: readiness.agentConfigured
  })
})

app.get('/api/notifications/summary', authMiddleware, requireAnyPermission(['reviewProposal', 'viewLogs']), (req, res) => {
  const userPermissions = req.user?.permissions || permissionsForRole(req.user?.role)
  const canReview = userPermissions.includes('reviewProposal')
  const reminderStats = canReview ? reminderStatsSummary() : null
  res.json({
    needReminderCount: reminderStats?.totalNeedReminder || 0,
    canOpenReminderQueue: canReview
  })
})

app.post('/api/auth/change-password', authMiddleware, (req, res) => {
  const { oldPassword = '', newPassword = '' } = req.body || {}
  const user = users.find(item => item.username === req.user.username)
  if (!user) return res.status(404).json({ message: '账号不存在' })
  if (normalizeUserRole(user.role) === '管理员') {
    appendLog({
      req,
      actor: user.name || user.username || '管理员',
      action: '管理员账号修改密码被拒绝',
      category: '账号安全',
      result: '拒绝',
      metadata: {
        username: user.username,
        role: user.role
      }
    })
    saveStore()
    return res.status(403).json({ message: '管理员账号不开放自助修改密码，请在人员管理中维护账号安全。' })
  }
  if (!verifyPassword(oldPassword, user.passwordHash)) return res.status(400).json({ message: '原密码不正确' })

  const strengthMessage = passwordStrengthMessage(newPassword)
  if (strengthMessage) return res.status(400).json({ message: strengthMessage })
  if (isKnownDefaultPassword(newPassword)) return res.status(400).json({ message: '新密码不能使用系统默认密码' })
  if (verifyPassword(newPassword, user.passwordHash)) return res.status(400).json({ message: '新密码不能与原密码相同' })

  user.passwordHash = hashPassword(newPassword)
  delete user.password
  delete user.temporaryCredentialIssuedAt
  delete user.temporaryCredentialConsumedAt
  user.mustChangePassword = false
  user.passwordUpdatedAt = nowText()
  revokeTokensByUsername(user.username)

  const { token, expiresAt } = createSession(user)
  appendLog({ req, actor: user.name, action: '修改登录密码', category: '账号安全', result: '成功' })
  saveStore()
  res.json({
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    user: {
      username: user.username,
      name: user.name,
      role: user.role,
      permissions: permissionsForRole(user.role),
      mustChangePassword: false
    }
  })
})

// ===== 审核机器人 Hermes Profile 默认模板 =====
const baseBotProfiles = [
  {
    id: 'investment',
    code: 'H01',
    name: '投资发展总监',
    hermesName: 'Hermes-投资发展',
    scope: '招投标研判、市场进入、投资测算、项目立项',
    standards: ['招标文件响应完整性', '投资测算合理性', '市场容量与竞争风险', '项目收益边界'],
    output: '立项报告、投资风险意见、商务边界建议'
  },
  {
    id: 'facility',
    code: 'H02',
    name: '科技设施总监',
    hermesName: 'Hermes-科技设施',
    scope: '设施设备、工程维保、智慧化系统、技术可行性',
    standards: ['设施设备配置标准', '工程维保响应标准', '智慧化系统适配', '安全与能耗边界'],
    output: '技术可行性意见、设施成本风险、工程实施建议'
  },
  {
    id: 'customer',
    code: 'H03',
    name: '客户服务总监',
    hermesName: 'Hermes-客户服务',
    scope: '客服体系、业主体验、投诉闭环、满意度管理',
    standards: ['客户触点服务标准', '投诉处理时限', '满意度提升动作', '服务承诺一致性'],
    output: '客户体验风险、服务承诺校验、客服动作建议'
  },
  {
    id: 'community',
    code: 'H04',
    name: '社区经营总监',
    hermesName: 'Hermes-社区经营',
    scope: '社区增值经营、公共收益、活动运营、资源整合',
    standards: ['社区经营合规', '公共收益使用规范', '活动安全标准', '经营转化指标'],
    output: '经营可行性意见、收益风险、社区资源建议'
  },
  {
    id: 'fiveThree',
    code: 'H05',
    name: '五个三总监',
    hermesName: 'Hermes-五个三',
    scope: '品质动作、现场标准、基础服务执行、检查闭环',
    standards: ['三清三关三报事', '现场品质检查', '基础服务频次', '整改闭环标准'],
    output: '现场执行意见、品质风险清单、整改要求'
  },
  {
    id: 'finance',
    code: 'H06',
    name: '计划财务总监',
    hermesName: 'Hermes-计划财务',
    scope: '预算、成本、现金流、税务与收益测算',
    standards: ['预算编制口径', '成本费用边界', '现金流安全线', '收益测算完整性'],
    output: '财务测算意见、成本风险、预算控制建议'
  },
  {
    id: 'operations',
    code: 'H07',
    name: '信息运营总监',
    hermesName: 'Hermes-信息运营',
    scope: '系统支撑、数据口径、流程线上化、运营监控',
    standards: ['数据口径一致性', '流程节点可追踪', '系统权限边界', '运营指标看板'],
    output: '信息化支撑意见、数据风险、系统落地建议'
  },
  {
    id: 'hrAdmin',
    code: 'H08',
    name: '人力资源与行政总监',
    hermesName: 'Hermes-人事行政',
    scope: '组织编制、岗位职责、行政合规、培训保障',
    standards: ['人员编制标准', '岗位职责匹配', '培训认证要求', '行政合规边界'],
    output: '组织保障意见、用工风险、培训与行政建议'
  }
]

const statuses = {
  draft: '待审核',
  configurationPending: '待专业配置',
  running: '审核中',
  review: '待复核',
  revision: '待修改',
  passed: '已通过'
}

const proposalStatusValues = new Set(Object.values(statuses))

function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function verificationActor(req) {
  return String(req?.user?.name || req?.user?.username || '').trim()
}

function ruleIsVerified(rule = {}) {
  return Boolean(String(rule.basisVerifiedBy || '').trim() && String(rule.basisVerifiedAt || '').trim())
}

function knowledgeIsVerified(entry = {}) {
  return Boolean(
    String(entry.source || '').trim() &&
    String(entry.sourceVerifiedBy || '').trim() &&
    String(entry.sourceVerifiedAt || '').trim()
  )
}

function parseTimeText(value = '') {
  const timestamp = Date.parse(String(value || ''))
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function cloneProfileStandards(value = []) {
  return Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean)
    : []
}

function profileDefinitionPayload(profile = {}) {
  return {
    id: String(profile.id || '').trim(),
    code: String(profile.code || '').trim(),
    name: String(profile.name || '').trim(),
    hermesName: String(profile.hermesName || '').trim(),
    scope: String(profile.scope || '').trim(),
    standards: cloneProfileStandards(profile.standards),
    output: String(profile.output || '').trim(),
    internalEnabled: profile.internalEnabled !== false,
    marketEnabled: profile.marketEnabled !== false,
    canInitiate: profile.canInitiate === true,
    sortOrder: Number(profile.sortOrder) || 0
  }
}

function profileDefinitionHash(profile = {}) {
  return crypto.createHash('sha256').update(JSON.stringify(profileDefinitionPayload(profile))).digest('hex')
}

function profileDefinitionIsVerified(profile = {}) {
  return Boolean(
    cloneProfileStandards(profile.standards).length > 0 &&
    String(profile.definitionVerifiedBy || '').trim() &&
    String(profile.definitionVerifiedAt || '').trim() &&
    String(profile.definitionVerifiedHash || '').trim() === profileDefinitionHash(profile)
  )
}

function profileStandardsAreVerified(profile = {}) {
  return profileDefinitionIsVerified(profile)
}

function verifiedProfileStandards(profile = {}) {
  return profileStandardsAreVerified(profile) ? cloneProfileStandards(profile.standards) : []
}

function defaultBotProfiles() {
  return baseBotProfiles.map((profile, index) => ({
    ...profile,
    standards: cloneProfileStandards(profile.standards),
    standardsVerifiedBy: '',
    standardsVerifiedAt: '',
    definitionVerifiedBy: '',
    definitionVerifiedAt: '',
    definitionVerifiedHash: '',
    status: '停用',
    internalEnabled: true,
    marketEnabled: true,
    canInitiate: profile.id === 'investment',
    sortOrder: index + 1,
    updatedAt: nowText()
  }))
}

function currentBotProfiles() {
  return botProfiles.length > 0 ? botProfiles : defaultBotProfiles()
}

function orderedBotProfiles() {
  return [...currentBotProfiles()].sort((a, b) => (
    (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) ||
    String(a.code || '').localeCompare(String(b.code || ''), 'zh-CN')
  ))
}

function activeBotProfiles() {
  return orderedBotProfiles().filter(profile => profile.status === '启用' && profileDefinitionIsVerified(profile))
}

function requireReviewProfilesReady(_req, res, next) {
  const readiness = aiReviewReadinessState()
  _req.submissionMode = readiness.submissionMode
  _req.reviewReadiness = readiness
  next()
}

function workflowSummary() {
  const activeProfiles = activeBotProfiles()
  const internalReviewers = activeProfiles.filter(profile => profile.internalEnabled !== false)
  const marketInitiator = activeProfiles.find(profile => profile.id === 'investment' && profile.marketEnabled !== false && profile.canInitiate)
  const marketReviewers = activeProfiles.filter(profile => profile.id !== 'investment' && profile.marketEnabled !== false)

  return {
    internal: {
      enabledCount: internalReviewers.length,
      reviewerNames: internalReviewers.map(profile => profile.name),
      description: `${internalReviewers.length}个启用专业参与内部运营并行审核`
    },
    market: {
      initiatorName: marketInitiator?.name || '',
      reviewCount: marketReviewers.length,
      reviewerNames: marketReviewers.map(profile => profile.name),
      description: marketInitiator
        ? `${marketInitiator.name}先行立项，${marketReviewers.length}个专业参与市场拓展会审`
        : `当前未配置立项牵头角色，${marketReviewers.length}个专业处于市场拓展会审范围`
    }
  }
}

function latestPasswordNoticeSummary() {
  const latestNotice = logs.find(log => detectLogCategory(log) === '账号安全' && String(log.metadata?.auditId || '').startsWith('PWD-NOTICE-'))
  return latestNotice ? {
    auditId: latestNotice.metadata?.auditId || '',
    actor: latestNotice.actor || '',
    at: latestNotice.at || '',
    noticeCount: 0,
    sentCount: 0,
    draftCount: latestNotice.metadata?.draftCount || latestNotice.metadata?.affectedAccountCount || latestNotice.metadata?.noticeCount || 0,
    affectedAccountCount: latestNotice.metadata?.affectedAccountCount || latestNotice.metadata?.draftCount || latestNotice.metadata?.noticeCount || 0,
    skippedCount: latestNotice.metadata?.skippedCount || 0,
    noticeChannel: latestNotice.metadata?.noticeChannel || '复制通知文案',
    deliveryStatus: '未发送',
    targetUsernames: Array.isArray(latestNotice.metadata?.targetUsernames) ? latestNotice.metadata.targetUsernames : [],
    targetNames: Array.isArray(latestNotice.metadata?.targetNames) ? latestNotice.metadata.targetNames : []
  } : null
}

function userStatsSummary() {
  const enabledUsers = users.filter(user => user.status !== '停用')
  const enabledAdmins = enabledUsers.filter(user => user.role === '管理员')
  const roles = Object.keys(defaultRolePermissions)
  const byRole = roles.map(role => {
    const roleUsers = users.filter(user => normalizeUserRole(user.role) === role)
    return {
      role,
      total: roleUsers.length,
      enabled: roleUsers.filter(user => user.status !== '停用').length,
      disabled: roleUsers.filter(user => user.status === '停用').length
    }
  })
  const mustChangePasswordUsers = users.filter(user => shouldForcePasswordChange(user))
  const defaultPasswordUsers = users.filter(user => user.usesDefaultPassword === true)
  const loginLockedUsers = users.filter(user => {
    const failure = currentLoginFailure(user.username)
    return Boolean(failure?.lockedUntil && failure.lockedUntil > Date.now())
  })
  const userBrief = (user) => ({
    username: user.username || '',
    name: user.name || user.username || ''
  })

  return {
    total: users.length,
    enabled: enabledUsers.length,
    disabled: users.length - enabledUsers.length,
    admins: enabledAdmins.length,
    byRole,
    mustChangePassword: mustChangePasswordUsers.length,
    defaultPassword: defaultPasswordUsers.length,
    loginLocked: loginLockedUsers.length,
    mustChangePasswordUsers: mustChangePasswordUsers.map(userBrief),
    defaultPasswordUsers: defaultPasswordUsers.map(userBrief),
    loginLockedUsers: loginLockedUsers.map(userBrief),
    latestPasswordNotice: latestPasswordNoticeSummary(),
    adminNames: enabledAdmins.map(user => user.name || user.username)
  }
}

function launchAccountRiskSummary() {
  const stats = userStatsSummary()
  const riskCount = (Number(stats.defaultPassword) || 0) + (Number(stats.mustChangePassword) || 0) + (Number(stats.loginLocked) || 0)
  return {
    defaultPassword: stats.defaultPassword || 0,
    mustChangePassword: stats.mustChangePassword || 0,
    loginLocked: stats.loginLocked || 0,
    riskCount,
    defaultPasswordUsers: stats.defaultPasswordUsers || [],
    mustChangePasswordUsers: stats.mustChangePasswordUsers || [],
    loginLockedUsers: stats.loginLockedUsers || [],
    byRole: stats.byRole || [],
    latestPasswordNotice: stats.latestPasswordNotice || null
  }
}

function ruleStatsSummary() {
  const enabledRules = rules.filter(rule => rule.status === '启用' && ruleIsVerified(rule))

  return {
    total: rules.length,
    enabled: enabledRules.length,
    disabled: rules.length - enabledRules.length,
    byCategory: ['通用', '内部运营', '市场拓展', '风险阈值'].map(category => ({
      category,
      total: rules.filter(rule => rule.category === category).length,
      enabled: enabledRules.filter(rule => rule.category === category).length
    }))
  }
}

function defaultReminderConfig() {
  return {
    highRiskReview: { enabled: true, warningHours: 12, overdueHours: 24 },
    manualReview: { enabled: true, warningHours: 24, overdueHours: 48 },
    signOff: { enabled: true, warningHours: 6, overdueHours: 12 },
    archive: { enabled: true, warningHours: 12, overdueHours: 24 },
    autoCreateEnabled: true,
    defaultChannel: '企业微信',
    updatedAt: nowText()
  }
}

function normalizeReminderConfig(value = {}) {
  const base = defaultReminderConfig()
  const normalizeStage = (stageKey) => ({
    enabled: value?.[stageKey]?.enabled !== false,
    warningHours: Math.max(1, Number(value?.[stageKey]?.warningHours) || base[stageKey].warningHours),
    overdueHours: Math.max(
      Math.max(1, Number(value?.[stageKey]?.warningHours) || base[stageKey].warningHours),
      Number(value?.[stageKey]?.overdueHours) || base[stageKey].overdueHours
    )
  })

  return {
    highRiskReview: normalizeStage('highRiskReview'),
    manualReview: normalizeStage('manualReview'),
    signOff: normalizeStage('signOff'),
    archive: normalizeStage('archive'),
    autoCreateEnabled: value?.autoCreateEnabled !== false,
    defaultChannel: String(value?.defaultChannel || base.defaultChannel).trim() || base.defaultChannel,
    updatedAt: String(value?.updatedAt || base.updatedAt).trim() || nowText()
  }
}

function ruleSnapshot(rule = {}) {
  return {
    id: String(rule.id || ''),
    category: String(rule.category || ''),
    name: String(rule.name || ''),
    status: String(rule.status || ''),
    weight: Number(rule.weight) || 0,
    description: String(rule.description || '')
  }
}

function diffRuleSnapshot(before = {}, after = {}) {
  const labels = {
    category: '类别',
    name: '名称',
    status: '状态',
    weight: '权重',
    description: '说明'
  }
  return Object.keys(labels)
    .filter(key => String(before[key] ?? '') !== String(after[key] ?? ''))
    .map(key => ({
      field: key,
      label: labels[key],
      before: before[key],
      after: after[key]
    }))
}

function reminderConfigSnapshot(config = {}) {
  const normalized = normalizeReminderConfig(config)
  return {
    highRiskReview: normalized.highRiskReview,
    manualReview: normalized.manualReview,
    signOff: normalized.signOff,
    archive: normalized.archive,
    autoCreateEnabled: normalized.autoCreateEnabled,
    defaultChannel: normalized.defaultChannel
  }
}

function diffReminderConfig(before = {}, after = {}) {
  const stageLabels = {
    highRiskReview: '高风险复核',
    manualReview: '人工复核',
    signOff: '签发',
    archive: '归档'
  }
  const fieldLabels = {
    enabled: '启用状态',
    warningHours: '预警阈值',
    overdueHours: '超时阈值'
  }
  const changes = []
  for (const [stageKey, stageLabel] of Object.entries(stageLabels)) {
    for (const [fieldKey, fieldLabel] of Object.entries(fieldLabels)) {
      if (String(before?.[stageKey]?.[fieldKey] ?? '') !== String(after?.[stageKey]?.[fieldKey] ?? '')) {
        changes.push({
          field: `${stageKey}.${fieldKey}`,
          label: `${stageLabel}${fieldLabel}`,
          before: before?.[stageKey]?.[fieldKey],
          after: after?.[stageKey]?.[fieldKey]
        })
      }
    }
  }
  if (String(before.autoCreateEnabled) !== String(after.autoCreateEnabled)) {
    changes.push({ field: 'autoCreateEnabled', label: '自动催办动作', before: before.autoCreateEnabled, after: after.autoCreateEnabled })
  }
  if (String(before.defaultChannel || '') !== String(after.defaultChannel || '')) {
    changes.push({ field: 'defaultChannel', label: '默认催办渠道', before: before.defaultChannel, after: after.defaultChannel })
  }
  return changes
}

function executionStatsSummary() {
  const reviewed = proposals.filter(item => hasManualReviewContent(item.manualReview)).length
  const pendingSignOff = proposals.filter(item => (
    hasManualReviewContent(item.manualReview) &&
    normalizeExecutionRecord(item.executionRecord).signOff.status === '待签发'
  )).length
  const signed = proposals.filter(item => normalizeExecutionRecord(item.executionRecord).signOff.status === '已签发').length
  const pendingArchive = proposals.filter(item => (
    normalizeExecutionRecord(item.executionRecord).signOff.status === '已签发' &&
    normalizeExecutionRecord(item.executionRecord).archive.status === '待归档'
  )).length
  const archived = proposals.filter(item => normalizeExecutionRecord(item.executionRecord).archive.status === '已归档').length

  return {
    reviewed,
    pendingSignOff,
    signed,
    pendingArchive,
    archived
  }
}

function parseDateTime(value = '') {
  const text = String(value || '').trim()
  if (!text) return null
  const normalized = text.replace(/\./g, '/').replace('T', ' ').replace(/-/g, '/')
  const timestamp = Date.parse(normalized)
  return Number.isNaN(timestamp) ? null : new Date(timestamp)
}

function diffHoursFromNow(value = '') {
  const target = parseDateTime(value)
  if (!target) return 0
  const hours = Math.floor((Date.now() - target.getTime()) / (1000 * 60 * 60))
  return Math.max(0, hours)
}

function escalationLevel(hours = 0, threshold = 24) {
  if (hours >= threshold * 2) return '高'
  if (hours >= threshold) return '中'
  return '低'
}

function overdueReminderSummary(item = {}) {
  const manualReview = normalizeManualReview(item.manualReview)
  const executionRecord = normalizeExecutionRecord(item.executionRecord)
  const highRiskCount = proposalHighRiskCount(item)
  const reminderAdvice = reminderSuggestion(item)
  const config = normalizeReminderConfig(reminderConfig)

  if (!hasManualReviewContent(manualReview)) {
    const ageHours = diffHoursFromNow(item.updatedAt || item.createdAt)
    const stageConfig = highRiskCount > 0 ? config.highRiskReview : config.manualReview
    const threshold = stageConfig.overdueHours
    const warningHours = stageConfig.warningHours
    return {
      stage: highRiskCount > 0 ? '高风险复核' : '人工复核',
      ageHours,
      thresholdHours: threshold,
      warningHours,
      overdue: stageConfig.enabled && ageHours >= threshold,
      approaching: stageConfig.enabled && ageHours >= warningHours,
      level: escalationLevel(ageHours, threshold),
      label: ageHours >= threshold ? `超时 ${ageHours - threshold}h` : `${threshold - ageHours}h 内跟进`,
      sourceTime: item.updatedAt || item.createdAt || '',
      needsReminder: reminderAdvice.pending
    }
  }

  if (executionRecord.signOff.status !== '已签发') {
    const ageHours = diffHoursFromNow(manualReview.reviewedAt || item.updatedAt || item.createdAt)
    const stageConfig = config.signOff
    const threshold = stageConfig.overdueHours
    const warningHours = stageConfig.warningHours
    return {
      stage: '签发',
      ageHours,
      thresholdHours: threshold,
      warningHours,
      overdue: stageConfig.enabled && ageHours >= threshold,
      approaching: stageConfig.enabled && ageHours >= warningHours,
      level: escalationLevel(ageHours, threshold),
      label: ageHours >= threshold ? `超时 ${ageHours - threshold}h` : `${threshold - ageHours}h 内签发`,
      sourceTime: manualReview.reviewedAt || item.updatedAt || item.createdAt || '',
      needsReminder: reminderAdvice.pending
    }
  }

  if (executionRecord.archive.status !== '已归档') {
    const ageHours = diffHoursFromNow(executionRecord.signOff.signedAt || item.updatedAt || item.createdAt)
    const stageConfig = config.archive
    const threshold = stageConfig.overdueHours
    const warningHours = stageConfig.warningHours
    return {
      stage: '归档',
      ageHours,
      thresholdHours: threshold,
      warningHours,
      overdue: stageConfig.enabled && ageHours >= threshold,
      approaching: stageConfig.enabled && ageHours >= warningHours,
      level: escalationLevel(ageHours, threshold),
      label: ageHours >= threshold ? `超时 ${ageHours - threshold}h` : `${threshold - ageHours}h 内归档`,
      sourceTime: executionRecord.signOff.signedAt || item.updatedAt || item.createdAt || '',
      needsReminder: reminderAdvice.pending
    }
  }

  return {
    stage: '进度确认',
    ageHours: 0,
    thresholdHours: 0,
    warningHours: 0,
    overdue: false,
    approaching: false,
    level: '低',
    label: '执行已闭环',
    sourceTime: item.updatedAt || item.createdAt || '',
    needsReminder: false
  }
}

function executionQueuesSummary() {
  const listItems = proposals.map(proposalListItem)
  const highRiskPendingReview = listItems
    .filter(item => !item.hasManualReview && (item.highRiskCount || 0) > 0)
    .sort((a, b) => (b.highRiskCount || 0) - (a.highRiskCount || 0) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''), 'zh-CN'))

  const pendingSignOff = listItems
    .filter(item => item.hasManualReview && item.signOffStatus === '待签发')
    .sort((a, b) => String(b.manualReviewedAt || '').localeCompare(String(a.manualReviewedAt || ''), 'zh-CN'))

  const pendingArchive = listItems
    .filter(item => item.signOffStatus === '已签发' && item.archiveStatus === '待归档')
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''), 'zh-CN'))

  const recentReminders = listItems
    .filter(item => item.lastReminderAt)
    .sort((a, b) => String(b.lastReminderAt || '').localeCompare(String(a.lastReminderAt || ''), 'zh-CN'))

  const overdueReminders = listItems
    .filter(item => item.overdueReminder?.overdue)
    .sort((a, b) => (
      (b.overdueReminder?.ageHours || 0) - (a.overdueReminder?.ageHours || 0) ||
      String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''), 'zh-CN')
    ))

  const approachingReminders = listItems
    .filter(item => !item.overdueReminder?.overdue && item.overdueReminder?.approaching)
    .sort((a, b) => (
      (b.overdueReminder?.ageHours || 0) - (a.overdueReminder?.ageHours || 0) ||
      String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''), 'zh-CN')
    ))

  return {
    highRiskPendingReview: highRiskPendingReview.slice(0, 6),
    pendingSignOff: pendingSignOff.slice(0, 6),
    pendingArchive: pendingArchive.slice(0, 6),
    recentReminders: recentReminders.slice(0, 6),
    overdueReminders: overdueReminders.slice(0, 6),
    approachingReminders: approachingReminders.slice(0, 6)
  }
}

function reminderStatsSummary() {
  const listItems = proposals.map(proposalListItem)
  const totals = {
    totalWithReminder: 0,
    totalNeedReminder: 0,
    autoCount: 0,
    manualCount: 0,
    noneCount: 0
  }
  const sourceMap = new Map([
    ['自动催办', 0],
    ['人工登记', 0],
    ['未催办', 0]
  ])
  const stageMap = new Map([
    ['人工复核', 0],
    ['高风险复核', 0],
    ['补充修改', 0],
    ['签发', 0],
    ['归档', 0],
    ['进度确认', 0]
  ])
  const pendingSourceMap = new Map([
    ['建议自动催办', 0],
    ['建议人工跟进', 0]
  ])

  for (const item of listItems) {
    if (item.lastReminderAt) {
      totals.totalWithReminder += 1
      if (item.lastReminderSource === 'auto') {
        totals.autoCount += 1
        sourceMap.set('自动催办', (sourceMap.get('自动催办') || 0) + 1)
      } else {
        totals.manualCount += 1
        sourceMap.set('人工登记', (sourceMap.get('人工登记') || 0) + 1)
      }
    } else {
      totals.noneCount += 1
      sourceMap.set('未催办', (sourceMap.get('未催办') || 0) + 1)
    }

    const stage = item.recommendedReminderStage || '进度确认'
    stageMap.set(stage, (stageMap.get(stage) || 0) + 1)

    if (item.needsReminder) {
      totals.totalNeedReminder += 1
      const pendingLabel = item.lastReminderSource === 'auto' ? '建议人工跟进' : '建议自动催办'
      pendingSourceMap.set(pendingLabel, (pendingSourceMap.get(pendingLabel) || 0) + 1)
    }
  }

  return {
    ...totals,
    bySource: Array.from(sourceMap.entries()).map(([label, value]) => ({ label, value })),
    byStage: Array.from(stageMap.entries()).map(([label, value]) => ({ label, value })),
    pendingBySource: Array.from(pendingSourceMap.entries()).map(([label, value]) => ({ label, value }))
  }
}

function exportStatsSummary() {
  const exportEvents = proposals.flatMap(item => normalizeExportEvents(item.exportEvents).map(event => ({
    ...event,
    proposalId: item.id,
    proposalTitle: item.title,
    proposalType: item.type,
    sourceText: exportSourceText(event.source),
    typeText: exportTypeText(event.type)
  })))

  exportEvents.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''), 'zh-CN'))

  const totals = {
    total: exportEvents.length,
    previewCount: 0,
    wordCount: 0,
    pdfCount: 0,
    proposalCount: 0,
    detailCount: 0,
    submitCount: 0,
    reviewCount: 0,
    lastExportAt: exportEvents[0]?.at || '',
    lastExporter: exportEvents[0]?.actor || '',
    latestVersion: exportEvents[0]?.appVersion || '',
    latestBuildTime: exportEvents[0]?.appBuildTime || '',
    latestBuildLabel: exportEvents[0]?.appBuildLabel || exportEvents[0]?.appVersion || ''
  }
  const sourceMap = new Map([
    ['方案详情页', 0],
    ['提交结果区', 0],
    ['审核中心', 0]
  ])
  const proposalIds = new Set()

  for (const event of exportEvents) {
    if (event.type === 'preview') totals.previewCount += 1
    if (event.type === 'pdf') totals.pdfCount += 1
    if (event.type === 'word') totals.wordCount += 1

    if (event.source === 'submit') totals.submitCount += 1
    else if (event.source === 'review') totals.reviewCount += 1
    else if (event.source === 'detail') totals.detailCount += 1

    sourceMap.set(event.sourceText, (sourceMap.get(event.sourceText) || 0) + 1)
    proposalIds.add(event.proposalId)
  }

  totals.proposalCount = proposalIds.size

  return {
    ...totals,
    bySource: Array.from(sourceMap.entries()).map(([label, value]) => ({ label, value })),
    recent: exportEvents.slice(0, 6)
  }
}

function attachmentStatsSummary() {
  const files = proposals.flatMap(item => (item.files || []).map(file => ({
    ...file,
    proposalId: item.id,
    proposalTitle: item.title,
    proposalUpdatedAt: item.updatedAt || item.createdAt || ''
  })))
  const statusTotal = files.reduce((acc, file) => {
    const status = file.extractionStatus || '未解析'
    acc[status] = (acc[status] || 0) + 1
    return acc
  }, {})
  const typeTotal = files.reduce((acc, file) => {
    const type = file.extractionType || '未标注'
    acc[type] = (acc[type] || 0) + 1
    return acc
  }, {})
  const parsed = statusTotal['已解析'] || 0
  const issueStatuses = new Set(['解析失败', '不支持', '待解析', '未解析'])
  const recentIssues = files
    .filter(file => issueStatuses.has(file.extractionStatus || '未解析') || file.extractionError)
    .sort((a, b) => String(b.proposalUpdatedAt || '').localeCompare(String(a.proposalUpdatedAt || ''), 'zh-CN'))
    .slice(0, 6)
    .map(file => ({
      proposalId: file.proposalId,
      proposalTitle: file.proposalTitle,
      fileName: file.name || '未命名附件',
      status: file.extractionStatus || '未解析',
      type: file.extractionType || '未标注',
      error: file.extractionError || '',
      updatedAt: file.proposalUpdatedAt
    }))

  return {
    total: files.length,
    parsed,
    failed: statusTotal['解析失败'] || 0,
    unsupported: statusTotal['不支持'] || 0,
    pending: (statusTotal['待解析'] || 0) + (statusTotal['未解析'] || 0),
    parseRate: files.length > 0 ? Math.round((parsed / files.length) * 100) : 0,
    totalBytes: files.reduce((sum, file) => sum + (Number(file.size) || 0), 0),
    totalTextChars: files.reduce((sum, file) => sum + (Number(file.wordCount) || 0), 0),
    pdfTableFiles: files.filter(file => file.extractionType === 'pdf-table').length,
    pdfTableCount: files.reduce((sum, file) => sum + (Number(file.pdfTableCount) || 0), 0),
    byStatus: Object.entries(statusTotal).map(([label, value]) => ({ label, value })),
    byType: Object.entries(typeTotal).map(([label, value]) => ({ label, value })),
    issueProposalCount: new Set(recentIssues.map(item => item.proposalId)).size,
    recentIssues
  }
}

function isExecutionLogAction(action = '') {
  const text = String(action || '')
  if (text.includes('自动催办规则配置')) return false
  return (
    text.includes('人工复核') ||
    text.includes('复核备注') ||
    text.includes('签发') ||
    text.includes('归档') ||
    text.includes('催办') ||
    text.includes('意见书') ||
    text.includes('预览')
  )
}

function detectLogCategory(log = {}) {
  if (log.category) return log.category
  const text = String(log.action || '')
  if (text.includes('登录') || text.includes('退出') || text.includes('密码') || text.includes('账号')) return '账号安全'
  if (text.includes('上线确认') || text.includes('公网解析诊断')) return '系统配置'
  if (text.includes('自动催办规则配置') || text.includes('角色权限矩阵') || text.includes('系统运行与账号安全配置')) return '系统配置'
  if (text.includes('AI调用') || text.includes('AI 审核')) return '执行动作'
  if (isExecutionLogAction(text)) return '执行动作'
  if (text.includes('机器人') || text.includes('知识条款') || text.includes('规则')) return '系统配置'
  return '审核动作'
}

function isBulkOperationLog(log = {}) {
  const metadata = log.metadata || {}
  const action = String(log.action || '')
  return ['bulk-status', 'bulk-delete', 'bulk-reminder', 'knowledge-bulk-status', 'knowledge-bulk-delete'].includes(metadata.kind) ||
    metadata.bulkKind === 'bulk-ai-review' ||
    metadata.source === 'bulk-rerun' ||
    action.includes('批量更新方案状态') ||
    action.includes('批量删除方案') ||
    action.includes('批量自动催办') ||
    action.includes('批量登记催办') ||
    action.includes('批量重新发起 AI 审核') ||
    action.includes('批量启用知识条款') ||
    action.includes('批量停用知识条款') ||
    action.includes('批量删除知识条款')
}

function parseDateText(value = '') {
  const date = new Date(String(value || '').replace(/\//g, '-'))
  return Number.isNaN(date.getTime()) ? null : date
}

function logInRange(log = {}, range = '全部') {
  if (!range || range === '全部') return true
  const date = parseDateText(log.at)
  if (!date) return false
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (range === '今天') return date >= startOfToday
  const diffDays = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24)
  if (range === '近7天') return diffDays <= 7
  if (range === '近30天') return diffDays <= 30
  return true
}

function logActionGroup(log = {}) {
  const text = String(log.action || '')
  if (text.includes('前端异常') || log.metadata?.kind === 'client-error') return '前端异常'
  if (text.includes('AI调用') || text.includes('AI 审核') || log.metadata?.kind === 'ai-review-trace') return 'AI调用'
  if (text.includes('上线确认')) return '上线确认'
  if (text.includes('公网解析诊断')) return '公网诊断'
  if (
    text.includes('Hermes Profile') ||
    text.includes('Hermes 云端') ||
    text.includes('审核机器人')
  ) return 'Hermes配置'
  if (text.includes('人工复核') || text.includes('复核备注')) return '人工复核'
  if (text.includes('签发') || text.includes('归档')) return '签发归档'
  if (text.includes('催办')) return '催办'
  if (text.includes('意见书') || text.includes('预览')) return '导出'
  return '全部'
}

function proposalMetaForLog(log = {}) {
  if (!log.proposalId) return null
  const proposal = proposals.find(item => item.id === log.proposalId)
  return proposal ? proposalListItem(proposal) : null
}

function allowedLogCategoriesForUser(user = {}) {
  const permissions = user.permissions || permissionsForRole(user.role)
  if (permissions.includes('manageSystem')) return null
  const categories = ['审核动作', '执行动作']
  if (permissions.includes('manageUsers')) categories.push('账号安全')
  return new Set(categories)
}

function allowedActionGroupsForUser(user = {}) {
  const permissions = user.permissions || permissionsForRole(user.role)
  const baseGroups = ['批量操作', 'AI调用', '人工复核', '签发归档', '催办', '导出', '前端异常']
  if (permissions.includes('manageSystem')) return ['Hermes配置', '上线确认', '公网诊断', ...baseGroups]
  return baseGroups
}

function logFilterOptionsForUser(user = {}) {
  return {
    allowedCategories: allowedLogCategoriesForUser(user),
    allowedActionGroups: allowedActionGroupsForUser(user)
  }
}

function filterLogs(query = {}, options = {}) {
  const keyword = String(query.q || '').trim().toLowerCase()
  const type = String(query.type || '全部')
  const actor = String(query.actor || '全部')
  const result = String(query.result || '全部')
  const ip = String(query.ip || '全部')
  const range = String(query.range || '全部')
  const actionGroup = String(query.actionGroup || '全部')
  const exportSource = String(query.exportSource || '全部')
  const submitter = String(query.submitter || '全部')
  const proposalType = String(query.proposalType || '全部')
  const proposalId = String(query.proposalId || '')
  const proposalIds = String(query.proposalIds || '').split(',').map(item => item.trim()).filter(Boolean)
  const proposalScopeIds = proposalIds.length > 0 ? proposalIds : proposalId ? [proposalId] : []

  const allowedCategories = options.allowedCategories || null
  const allowedActionGroups = options.allowedActionGroups || null
  if (allowedActionGroups && actionGroup !== '全部' && !allowedActionGroups.includes(actionGroup)) return []

  return logs.filter(log => {
    const logCategory = detectLogCategory(log)
    if (allowedCategories && !allowedCategories.has(logCategory)) return false
    const proposalMeta = proposalMetaForLog(log)
    const searchable = [
      log.actor,
      log.action,
      log.at,
      log.category,
      log.result,
      log.ip,
      log.userAgent,
      JSON.stringify(log.metadata || {}),
      proposalMeta?.title,
      proposalMeta?.submitter,
      proposalMeta?.type
    ].join(' ').toLowerCase()
    const matchesExportSource =
      exportSource === '全部' ||
      (exportSource === '详情页' && exportSourceForLog(log) === 'detail') ||
      (exportSource === '提交结果' && exportSourceForLog(log) === 'submit') ||
      (exportSource === '审核中心' && exportSourceForLog(log) === 'review') ||
      (exportSource === '未标注' && !exportSourceForLog(log))

    return (!keyword || searchable.includes(keyword)) &&
      (type === '全部' || logCategory === type) &&
      (actor === '全部' || log.actor === actor) &&
      (result === '全部' || (log.result || '未记录') === result) &&
      (ip === '全部' || log.ip === ip) &&
      logInRange(log, range) &&
      (actionGroup === '全部' || (actionGroup === '批量操作' ? isBulkOperationLog(log) : logActionGroup(log) === actionGroup)) &&
      matchesExportSource &&
      (submitter === '全部' || proposalMeta?.submitter === submitter) &&
      (proposalType === '全部' || proposalMeta?.type === proposalType) &&
      (proposalScopeIds.length === 0 || proposalScopeIds.includes(log.proposalId))
  })
}

function logSummary(query = {}, options = {}) {
  const items = filterLogs(query, options)
  const uniqueIps = new Set(items.map(item => item.ip).filter(Boolean))
  const latestFailure = items.find(item => ['失败', '锁定', '拦截', '拒绝'].includes(item.result || ''))
  const latestRolePermissionChange = items.find(item => String(item.action || '').includes('角色权限矩阵'))
  const exportEventLogs = items.filter(item => logActionGroup(item) === '导出')
  const latestExportEvent = exportEventLogs[0] || null
  const latestAccountSecurityExport = items.find(item => detectLogCategory(item) === '账号安全' && String(item.action || '').includes('导出账号安全清单'))
  const latestAccountSecurityBulk = items.find(item => detectLogCategory(item) === '账号安全' && String(item.metadata?.auditId || '').startsWith('USER-BULK-'))
  const latestAccountSecurityNotice = items.find(item => detectLogCategory(item) === '账号安全' && String(item.metadata?.auditId || '').startsWith('PWD-NOTICE-'))
  return {
    total: items.length,
    accountSecurityCount: items.filter(item => detectLogCategory(item) === '账号安全').length,
    failureCount: items.filter(item => (item.result || '') === '失败').length,
    lockedOnlyCount: items.filter(item => (item.result || '') === '锁定').length,
    interceptCount: items.filter(item => (item.result || '') === '拦截').length,
    rejectedCount: items.filter(item => (item.result || '') === '拒绝').length,
    lockedCount: items.filter(item => ['锁定', '拦截', '拒绝'].includes(item.result || '')).length,
    systemConfigCount: items.filter(item => detectLogCategory(item) === '系统配置').length,
    rolePermissionChangeCount: items.filter(item => String(item.action || '').includes('角色权限矩阵')).length,
    bulkOperationCount: items.filter(item => isBulkOperationLog(item)).length,
    exportEventCount: exportEventLogs.length,
    uniqueIpCount: uniqueIps.size,
    latestFailureAt: latestFailure?.at || '',
    latestFailureActor: latestFailure?.actor || '',
    latestFailureAction: latestFailure?.action || '',
    latestFailureResult: latestFailure?.result || '',
    latestFailureId: latestFailure?.id || '',
    latestRolePermissionChangeAt: latestRolePermissionChange?.at || '',
    latestRolePermissionChangeActor: latestRolePermissionChange?.actor || '',
    latestRolePermissionChangeAction: latestRolePermissionChange?.action || '',
    latestExportEventAt: latestExportEvent?.at || '',
    latestExportEventActor: latestExportEvent?.actor || '',
    latestExportEventAction: latestExportEvent?.action || '',
    latestExportEvent: latestExportEvent ? {
      action: latestExportEvent.action || '',
      actor: latestExportEvent.actor || '',
      at: latestExportEvent.at || '',
      proposalId: latestExportEvent.proposalId || '',
      proposalTitle: latestExportEvent.proposalTitle || '',
      source: latestExportEvent.source || '',
      result: latestExportEvent.result || '',
      metadata: latestExportEvent.metadata || {}
    } : null,
    latestAccountSecurityExportAt: latestAccountSecurityExport?.at || '',
    latestAccountSecurityExportActor: latestAccountSecurityExport?.actor || '',
    latestAccountSecurityExportAction: latestAccountSecurityExport?.action || '',
    latestAccountSecurityExport: latestAccountSecurityExport ? {
      action: latestAccountSecurityExport.action || '',
      actor: latestAccountSecurityExport.actor || '',
      at: latestAccountSecurityExport.at || '',
      result: latestAccountSecurityExport.result || '',
      metadata: latestAccountSecurityExport.metadata || {}
    } : null,
    latestAccountSecurityBulkAt: latestAccountSecurityBulk?.at || '',
    latestAccountSecurityBulkActor: latestAccountSecurityBulk?.actor || '',
    latestAccountSecurityBulkAction: latestAccountSecurityBulk?.action || '',
    latestAccountSecurityBulk: latestAccountSecurityBulk ? {
      action: latestAccountSecurityBulk.action || '',
      actor: latestAccountSecurityBulk.actor || '',
      at: latestAccountSecurityBulk.at || '',
      result: latestAccountSecurityBulk.result || '',
      metadata: latestAccountSecurityBulk.metadata || {}
    } : null,
    latestAccountSecurityNoticeAt: latestAccountSecurityNotice?.at || '',
    latestAccountSecurityNoticeActor: latestAccountSecurityNotice?.actor || '',
    latestAccountSecurityNoticeAction: latestAccountSecurityNotice?.action || '',
    latestAccountSecurityNotice: latestAccountSecurityNotice ? {
      action: latestAccountSecurityNotice.action || '',
      actor: latestAccountSecurityNotice.actor || '',
      at: latestAccountSecurityNotice.at || '',
      result: latestAccountSecurityNotice.result || '',
      metadata: latestAccountSecurityNotice.metadata || {}
    } : null,
    latestRolePermissionChange: latestRolePermissionChange ? {
      action: latestRolePermissionChange.action || '',
      actor: latestRolePermissionChange.actor || '',
      at: latestRolePermissionChange.at || '',
      metadata: latestRolePermissionChange.metadata || {}
    } : null
  }
}

function logOptions(options = {}) {
  const allowedCategories = options.allowedCategories || null
  const allowedActionGroups = options.allowedActionGroups || null
  const visibleLogs = allowedCategories
    ? logs.filter(item => allowedCategories.has(detectLogCategory(item)))
    : logs
  const categoryOptions = allowedCategories
    ? Array.from(allowedCategories)
    : Array.from(new Set(visibleLogs.map(item => detectLogCategory(item)).filter(Boolean)))
  const actionGroupOptions = allowedActionGroups
    ? allowedActionGroups
    : Array.from(new Set(visibleLogs.map(item => logActionGroup(item)).filter(group => group && group !== '全部')))
  return {
    actors: ['全部', ...Array.from(new Set(visibleLogs.map(item => item.actor).filter(Boolean)))],
    categories: ['全部', ...categoryOptions],
    actionGroups: ['全部', ...actionGroupOptions],
    results: ['全部', ...Array.from(new Set(visibleLogs.map(item => item.result || '未记录').filter(Boolean)))],
    ips: ['全部', ...Array.from(new Set(visibleLogs.map(item => item.ip).filter(Boolean)))]
  }
}

function pruneLogs(retentionDays = 180) {
  const days = clampNumber(retentionDays, 30, 3650, 180)
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const before = logs.length
  logs = logs.filter(log => {
    if (permanentAuditLogIds.has(log?.id)) return true
    const date = parseDateText(log.at)
    return !date || date.getTime() >= cutoff
  })
  return {
    retentionDays: days,
    removed: before - logs.length,
    remaining: logs.length
  }
}

function splitLogsByExecution(logItems = []) {
  const executionLogs = []
  const reviewLogs = []

  for (const log of logItems) {
    if (isExecutionLogAction(log?.action)) {
      executionLogs.push(log)
    } else {
      reviewLogs.push(log)
    }
  }

  return {
    reviewLogs: reviewLogs.slice(0, 8),
    executionLogs: executionLogs.slice(0, 8)
  }
}

function proposalHighRiskCount(item = {}) {
  return Number(item.summary?.riskCount?.high || 0)
}

function reminderSuggestion(item = {}) {
  const executionRecord = normalizeExecutionRecord(item.executionRecord)
  const hasManualReview = hasManualReviewContent(item.manualReview)

  if (item.status === statuses.revision) {
    return { stage: '补充修改', pending: true }
  }

  if (executionRecord.signOff.status === '已签发' && executionRecord.archive.status !== '已归档') {
    return { stage: '归档', pending: true }
  }

  if (hasManualReview && executionRecord.signOff.status !== '已签发') {
    return { stage: '签发', pending: true }
  }

  if (!hasManualReview) {
    return {
      stage: proposalHighRiskCount(item) > 0 ? '高风险复核' : '人工复核',
      pending: true
    }
  }

  return {
    stage: '进度确认',
    pending: false
  }
}

function addTimeline(item, actor, action, detail = '') {
  if (!Array.isArray(item.timeline)) item.timeline = []
  item.timeline.unshift({
    id: `T${Date.now()}${crypto.randomBytes(3).toString('hex')}`,
    actor,
    action,
    detail,
    at: nowText()
  })
}

function addAiReviewTrace(item, trace = {}) {
  if (!Array.isArray(item.aiReviewTrace)) item.aiReviewTrace = []
  item.aiReviewTrace.unshift({
    id: `AIR${Date.now()}${crypto.randomBytes(3).toString('hex')}`,
    provider: String(trace.provider || '').trim(),
    model: String(trace.model || '').trim(),
    mode: String(trace.mode || '').trim(),
    status: String(trace.status || 'success').trim(),
    fallback: trace.fallback === true,
    durationMs: Math.max(0, Number(trace.durationMs) || 0),
    profileCount: Math.max(0, Number(trace.profileCount) || 0),
    opinionCount: Math.max(0, Number(trace.opinionCount) || 0),
    profileId: String(trace.profileId || '').trim(),
    profileIds: Array.isArray(trace.profileIds) ? trace.profileIds.map(value => String(value).trim()).filter(Boolean) : [],
    result: String(trace.result || '').trim(),
    error: String(trace.error || '').trim(),
    at: nowText()
  })
}

function defaultManualReview() {
  return {
    conclusion: '',
    basis: [],
    actions: [],
    summary: '',
    reviewer: '',
    reviewedAt: ''
  }
}

function normalizeTextList(value = []) {
  return Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean)
    : []
}

function normalizeManualReview(review = {}) {
  const base = defaultManualReview()
  return {
    ...base,
    ...review,
    conclusion: String(review?.conclusion || '').trim(),
    basis: normalizeTextList(review?.basis),
    actions: normalizeTextList(review?.actions),
    summary: String(review?.summary || '').trim(),
    reviewer: String(review?.reviewer || '').trim(),
    reviewedAt: String(review?.reviewedAt || '').trim()
  }
}

function hasManualReviewContent(review = {}) {
  const normalized = normalizeManualReview(review)
  return Boolean(
    normalized.conclusion ||
    normalized.summary ||
    normalized.basis.length > 0 ||
    normalized.actions.length > 0
  )
}

function hasCompleteManualReview(review = {}) {
  const normalized = normalizeManualReview(review)
  return Boolean(
    normalized.conclusion &&
    normalized.summary &&
    normalized.basis.length > 0 &&
    normalized.actions.length > 0 &&
    normalized.reviewer &&
    normalized.reviewedAt
  )
}

function defaultExecutionRecord() {
  return {
    signOff: {
      status: '待签发',
      signer: '',
      signedAt: '',
      documentCode: '',
      comment: ''
    },
    archive: {
      status: '待归档',
      archivist: '',
      archivedAt: '',
      archiveCode: '',
      location: '',
      comment: ''
    }
  }
}

function defaultReminders() {
  return []
}

function defaultExportEvents() {
  return []
}

function normalizeExportType(value = '') {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'preview') return 'preview'
  if (normalized === 'pdf') return 'pdf'
  return 'word'
}

function exportTypeText(type = '') {
  return {
    preview: '预览',
    word: 'Word',
    pdf: 'PDF'
  }[normalizeExportType(type)] || 'Word'
}

function exportSourceText(source = '') {
  const normalized = normalizeExportSource(source)
  if (normalized === 'submit') return '提交结果区'
  if (normalized === 'review') return '审核中心'
  return '方案详情页'
}

function exportSourceForLog(log = {}) {
  const source = String(log.metadata?.source || log.source || '').trim()
  if (source === 'submit' || source === 'review' || source === 'detail') return source
  return ''
}

function exportSourceTextForLog(log = {}) {
  const source = exportSourceForLog(log)
  if (source === 'submit') return '提交结果区'
  if (source === 'review') return '审核中心'
  if (source === 'detail') return '方案详情页'
  return '未标注'
}

function normalizeExportSource(value = '') {
  const normalized = String(value || '').trim()
  if (normalized === 'submit') return 'submit'
  if (normalized === 'review') return 'review'
  return 'detail'
}

function normalizeIdentity(value = '') {
  return String(value || '').trim().toLowerCase()
}

function uniqueUsernameByName(name = '') {
  const normalizedName = normalizeIdentity(name)
  if (!normalizedName) return ''
  const matches = users.filter(user => normalizeIdentity(user.name) === normalizedName)
  return matches.length === 1 ? matches[0].username : ''
}

function isProposalSubmitter(user = {}, item = {}) {
  const submitterUsername = normalizeIdentity(item.submitterUsername)
  if (submitterUsername && normalizeIdentity(user.username) === submitterUsername) return true

  const submitter = normalizeIdentity(item.submitter)
  return Boolean(submitter && [user.name, user.username].some(value => normalizeIdentity(value) === submitter))
}

function canRecordProposalExportEvent(user = {}, item = {}) {
  const permissions = user.permissions || permissionsForRole(user.role)
  if (permissions.includes('reviewProposal')) return true
  if (!permissions.includes('submitProposal')) return false

  return isProposalSubmitter(user, item)
}

function normalizeExportEvent(event = {}) {
  return {
    id: String(event.id || `E${Date.now()}${crypto.randomBytes(3).toString('hex')}`).trim(),
    type: normalizeExportType(event.type),
    actor: String(event.actor || '').trim(),
    at: String(event.at || '').trim(),
    appVersion: String(event.appVersion || '').trim(),
    appBuildTime: String(event.appBuildTime || '').trim(),
    appBuildLabel: String(event.appBuildLabel || event.appVersion || '').trim(),
    source: normalizeExportSource(event.source)
  }
}

function normalizeExportEvents(value = []) {
  return Array.isArray(value)
    ? value.map(event => normalizeExportEvent(event))
    : defaultExportEvents()
}

function normalizeReminderSource(value = '') {
  return String(value || '').trim() === 'auto' ? 'auto' : 'manual'
}

function normalizeReminder(reminder = {}) {
  const source = normalizeReminderSource(reminder.source)
  const isDraft = source === 'auto'
  return {
    id: String(reminder.id || `M${Date.now()}${crypto.randomBytes(3).toString('hex')}`).trim(),
    stage: String(reminder.stage || '').trim() || '进度确认',
    channel: String(reminder.channel || '').trim() || '企业微信',
    note: String(reminder.note || '').trim(),
    remindedBy: isDraft ? '' : String(reminder.remindedBy || '').trim(),
    remindedAt: isDraft ? '' : String(reminder.remindedAt || '').trim(),
    createdBy: String(reminder.createdBy || reminder.remindedBy || '').trim(),
    createdAt: String(reminder.createdAt || reminder.remindedAt || '').trim() || nowText(),
    deliveryStatus: isDraft ? '未发送' : '用户登记已沟通',
    source
  }
}

function normalizeReminders(value = []) {
  return Array.isArray(value)
    ? value.map(reminder => normalizeReminder(reminder))
    : defaultReminders()
}

function defaultReminderNote(stage = '', item = {}) {
  switch (stage) {
    case '补充修改':
      return `建议提醒提交人补充《${item.title || '当前方案'}》材料并重新提交审核。`
    case '高风险复核':
      return '建议提醒相关负责人优先处理高风险问题，并尽快提交人工复核结论。'
    case '人工复核':
      return '建议提醒相关负责人尽快完成人工复核并形成结论。'
    case '签发':
      return '建议提醒签发责任人完成签发登记并回填签发文号。'
    case '归档':
      return '建议提醒归档责任人完成归档登记并回填归档编号、归档位置。'
    default:
      return '建议提醒相关负责人同步当前处理进度。'
  }
}

function reminderScript(item = {}, stageOverride = '') {
  const executionRecord = normalizeExecutionRecord(item.executionRecord)
  const stage = String(stageOverride || reminderSuggestion(item).stage || '进度确认').trim()
  const highRiskCount = proposalHighRiskCount(item)
  const riskText = highRiskCount > 0 ? `当前存在 ${highRiskCount} 项高风险，请优先处理。` : ''
  const statusText = [item.status, executionRecord.signOff.status, executionRecord.archive.status]
    .filter(Boolean)
    .join(' / ') || '待跟进'
  const actionText = {
    补充修改: '请尽快补齐材料并重新提交审核。',
    高风险复核: '请尽快完成高风险问题处理，并提交人工复核结论。',
    人工复核: '请尽快完成人工复核，并同步复核结论。',
    签发: '请尽快完成签发登记，并回填签发文号。',
    归档: '请尽快完成归档登记，并回填归档编号与归档位置。',
    进度确认: '请同步当前处理进度和下一步安排。'
  }[stage] || '请同步当前处理进度。'

  return `【第一服务审核催办】\n方案：${item.title || '当前方案'}\n阶段：${stage}\n当前状态：${statusText}\n${riskText}${actionText}`.trim()
}

function appendReminder(item, reminderPayload = {}) {
  const reminder = normalizeReminder(reminderPayload)
  const action = reminder.source === 'auto'
    ? `生成${reminder.stage}催办草稿（未发送）`
    : `登记${reminder.stage}沟通留痕（用户确认）`

  item.reminders = normalizeReminders(item.reminders)
  item.reminders.unshift(reminder)
  if (reminder.source !== 'auto') item.updatedAt = nowText()
  addTimeline(
    item,
    reminder.remindedBy,
    action,
    `${reminder.channel}${reminder.note ? `：${reminder.note}` : ''}`
  )

  return reminder
}

function appendExportEvent(item, exportPayload = {}) {
  const exportEvent = normalizeExportEvent(exportPayload)
  const exportLabel = exportTypeText(exportEvent.type)
  const exportAction = exportEvent.type === 'preview' ? '预览意见书' : `导出${exportLabel}意见书`
  const sourceLabel = exportSourceText(exportEvent.source)
  const versionText = exportEvent.appBuildLabel || exportEvent.appVersion ? ` · ${exportEvent.appBuildLabel || exportEvent.appVersion}` : ''

  item.exportEvents = normalizeExportEvents(item.exportEvents)
  item.exportEvents.unshift(exportEvent)
  item.updatedAt = nowText()
  addTimeline(
    item,
    exportEvent.actor,
    exportAction,
    `${sourceLabel}${versionText}`
  )

  return exportEvent
}

function normalizeExecutionRecord(record = {}) {
  const base = defaultExecutionRecord()
  const signOff = record?.signOff || {}
  const archive = record?.archive || {}

  return {
    signOff: {
      ...base.signOff,
      ...signOff,
      status: signOff.status === '已签发' ? '已签发' : '待签发',
      signer: String(signOff.signer || '').trim(),
      signedAt: String(signOff.signedAt || '').trim(),
      documentCode: String(signOff.documentCode || '').trim(),
      comment: String(signOff.comment || '').trim()
    },
    archive: {
      ...base.archive,
      ...archive,
      status: archive.status === '已归档' ? '已归档' : '待归档',
      archivist: String(archive.archivist || '').trim(),
      archivedAt: String(archive.archivedAt || '').trim(),
      archiveCode: String(archive.archiveCode || '').trim(),
      location: String(archive.location || '').trim(),
      comment: String(archive.comment || '').trim()
    }
  }
}

function proposalId() {
  return `P${Date.now()}${crypto.randomBytes(3).toString('hex')}`
}

function safeFileName(name = 'file') {
  const safe = path.basename(name).replace(/[^\p{L}\p{N}._\-()（）\s]/gu, '_')
  return safe || 'file'
}

function normalizeUploadName(name = 'file') {
  const decoded = Buffer.from(name, 'latin1').toString('utf8')
  return decoded.includes('�') ? name : decoded
}

function fileExtension(name = '') {
  return path.extname(String(name || '')).toLowerCase()
}

function unsupportedUploadNames(files = [], allowedExtensions = proposalAttachmentExtensions) {
  return files
    .map(file => safeFileName(normalizeUploadName(file.originalname || 'file')))
    .filter(name => !allowedExtensions.has(fileExtension(name)))
}

function uploadExtensionError(file, allowedExtensions, label) {
  const name = safeFileName(normalizeUploadName(file?.originalname || 'file'))
  if (allowedExtensions.has(fileExtension(name))) return ''
  return `${label}格式不支持：${name}。请上传 ${[...allowedExtensions].map(item => item.toUpperCase().replace('.', '')).join('、')} 文件。`
}

function textSummary(text = '') {
  const normalized = String(text).replace(/\s+/g, ' ').trim()
  return {
    text: normalized.slice(0, 12000),
    textPreview: normalized.slice(0, 600),
    wordCount: normalized ? normalized.length : 0
  }
}

function releaseAttachmentWorkerSlot() {
  activeAttachmentWorkerCount = Math.max(0, activeAttachmentWorkerCount - 1)
  while (attachmentWorkerWaiters.length > 0 && activeAttachmentWorkerCount < maxConcurrentAttachmentWorkers) {
    const waiter = attachmentWorkerWaiters.shift()
    if (waiter.cancelled) continue
    clearTimeout(waiter.timer)
    activeAttachmentWorkerCount += 1
    waiter.resolve(true)
  }
}

function acquireAttachmentWorkerSlot(deadlineAt) {
  if (activeAttachmentWorkerCount < maxConcurrentAttachmentWorkers) {
    activeAttachmentWorkerCount += 1
    return Promise.resolve(true)
  }
  return new Promise(resolve => {
    const waiter = { resolve, cancelled: false, timer: null }
    waiter.timer = setTimeout(() => {
      waiter.cancelled = true
      resolve(false)
    }, Math.max(1, deadlineAt - Date.now()))
    waiter.timer.unref()
    attachmentWorkerWaiters.push(waiter)
  })
}

async function extractFileTextIsolated(file, name, deadlineAt = Date.now() + attachmentParseRequestDeadlineMs) {
  const acquired = await acquireAttachmentWorkerSlot(deadlineAt)
  if (!acquired) {
    return {
      ...textSummary(''),
      extractionStatus: '解析失败',
      extractionType: 'isolated-deadline',
      extractionError: '本次附件解析达到 30 秒总时限，文件将保存并标记待人工复核。'
    }
  }
  return new Promise(resolve => {
    const transferable = Uint8Array.from(file.buffer)
    let worker
    let resultReady = false
    let exited = false
    let pendingResult = null
    let slotReleased = false
    const releaseSlotOnce = () => {
      if (slotReleased) return
      slotReleased = true
      releaseAttachmentWorkerSlot()
    }
    const resolveAfterExit = result => {
      if (resultReady) return
      resultReady = true
      pendingResult = result
      clearTimeout(timeout)
      if (exited) {
        releaseSlotOnce()
        resolve(pendingResult)
      }
    }
    const onExit = code => {
      exited = true
      if (!resultReady) {
        resultReady = true
        pendingResult = {
          ...textSummary(''),
          extractionStatus: '解析失败',
          extractionType: 'isolated-exit',
          extractionError: `附件解析 worker 异常退出（${code}），文件已保存待人工复核。`
        }
      }
      releaseSlotOnce()
      resolve(pendingResult)
    }
    let timeout
    try {
      worker = new Worker(new URL('./attachment-parser-worker.js', import.meta.url), {
        workerData: {
          name,
          mimetype: String(file.mimetype || ''),
          buffer: transferable
        },
        transferList: [transferable.buffer],
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4
        }
      })
    } catch (error) {
      releaseSlotOnce()
      resolve({
        ...textSummary(''),
        extractionStatus: '解析失败',
        extractionType: 'isolated-spawn-error',
        extractionError: String(error.message || '附件解析 worker 无法启动').slice(0, 500)
      })
      return
    }
    timeout = setTimeout(() => {
      resolveAfterExit({
        ...textSummary(''),
        extractionStatus: '解析失败',
        extractionType: 'isolated-timeout',
        extractionError: '附件解析超时，文件已安全保存，请人工复核。'
      })
      worker.terminate().catch(() => {})
    }, Math.max(1, Math.min(attachmentParseTimeoutMs, deadlineAt - Date.now())))
    timeout.unref()
    worker.once('message', message => {
      resolveAfterExit(message?.ok === true
        ? message.result
        : {
            ...textSummary(''),
            extractionStatus: '解析失败',
            extractionType: 'isolated-error',
            extractionError: String(message?.error || '附件解析失败').slice(0, 500)
          })
      worker.terminate().catch(() => {})
    })
    worker.once('error', error => {
      resolveAfterExit({
        ...textSummary(''),
        extractionStatus: '解析失败',
        extractionType: 'isolated-error',
        extractionError: String(error.message || '附件解析子进程失败').slice(0, 500)
      })
      worker.terminate().catch(() => {})
    })
    worker.once('exit', onExit)
  })
}

async function prepareUploadedFiles(files = []) {
  fs.mkdirSync(filesDir, { recursive: true })
  const deadlineAt = Date.now() + attachmentParseRequestDeadlineMs
  return Promise.all(files.map(async file => {
    const id = `F${Date.now()}${crypto.randomBytes(4).toString('hex')}`
    const name = safeFileName(normalizeUploadName(file.originalname))
    const storedName = `${id}-${name}`
    const extraction = await extractFileTextIsolated(file, name, deadlineAt)
    return {
      buffer: file.buffer,
      record: {
        id,
        name,
        storedName,
        size: file.size,
        type: file.mimetype,
        uploadedAt: nowText(),
        ...extraction
      }
    }
  }))
}

function publishPreparedAttachments(prepared = []) {
  const published = []
  try {
    for (const item of prepared) {
      persistAttachmentAtomically(item.record.storedName, item.buffer)
      published.push(item.record)
    }
    return published
  } catch (error) {
    try {
      removeProposalFiles({ files: published })
    } catch {}
    throw error
  }
}

function syncDirectoryPath(directory) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | noFollowFlag
  const fd = fs.openSync(directory, flags)
  try {
    fs.fsyncSync(fd)
  } finally {
    closeStoreDescriptor(fd)
  }
}

function ensureBackupDirectory() {
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 })
  const info = fs.lstatSync(backupsDir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('备份目录必须是普通目录')
  if ((info.mode & 0o777) !== 0o700) fs.chmodSync(backupsDir, 0o700)
  syncDirectoryPath(backupsDir)
}

function persistAttachmentAtomically(storedName, content) {
  if (!safeStoredName(storedName)) throw new Error('附件存储名不安全，拒绝写入')
  fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 })
  const target = path.join(filesDir, storedName)
  const temporary = path.join(filesDir, `.${storedName}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
  let fd
  let published = false
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag, 0o600)
    fs.fchmodSync(fd, 0o600)
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
    const prepared = fs.fstatSync(fd)
    fs.linkSync(temporary, target)
    published = true
    const installed = fs.lstatSync(target)
    if (!installed.isFile() || installed.nlink !== 2 || !sameFileIdentity(prepared, installed)) {
      throw new Error('附件原子发布身份校验失败')
    }
    fs.unlinkSync(temporary)
    syncDirectoryPath(filesDir)
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
      if (published && fs.existsSync(target)) fs.unlinkSync(target)
      syncDirectoryPath(filesDir)
    } catch {}
    throw error
  } finally {
    closeStoreDescriptor(fd)
  }
}

function removeProposalFiles(item) {
  const directoryFlags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | noFollowFlag
  const directoryFd = fs.openSync(filesDir, directoryFlags)
  try {
  for (const file of item.files || []) {
    if (!file.storedName) continue
    if (!safeStoredName(file.storedName)) throw new Error('附件存储名不安全，拒绝删除')
    const pinnedPath = `/proc/self/fd/${directoryFd}/${file.storedName}`
    try {
      const info = fs.lstatSync(pinnedPath)
      if (!info.isFile() || info.nlink !== 1) throw new Error('附件必须是单链接普通文件')
      fs.unlinkSync(pinnedPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  } finally {
    closeStoreDescriptor(directoryFd)
  }
}

function proposalCorpus(proposal) {
  const fileText = (proposal.files || []).map(file => [file.name, file.textPreview, file.text].filter(Boolean).join(' ')).join(' ')
  return `${proposal.title || ''} ${proposal.description || ''} ${fileText}`
}

function activeRulesFor(proposal) {
  return rules.filter(rule => (
    rule.status === '启用' &&
    ruleIsVerified(rule) &&
    (rule.category === '通用' || rule.category === '风险阈值' || proposal.type.includes(rule.category))
  ))
}

function normalizeKeywords(value = []) {
  const source = Array.isArray(value) ? value : String(value).split(/[，,、；;\n]/)
  return [...new Set(source.map(item => String(item).trim()).filter(Boolean))]
}

function normalizeClauseCode(value = '') {
  return String(value || '').trim().toUpperCase()
}

function knowledgeClauseKey(profileId = '', clauseCode = '') {
  const normalizedProfileId = String(profileId || '').trim()
  const normalizedClauseCode = normalizeClauseCode(clauseCode)
  if (!normalizedProfileId || !normalizedClauseCode) return ''
  return `${normalizedProfileId}::${normalizedClauseCode}`
}

function findKnowledgeEntryByClauseCode(profileId = '', clauseCode = '', excludeId = '') {
  const targetKey = knowledgeClauseKey(profileId, clauseCode)
  if (!targetKey) return null

  return knowledgeEntries.find(entry => (
    entry.id !== excludeId &&
    knowledgeClauseKey(entry.profileId, entry.clauseCode) === targetKey
  )) || null
}

function generateKnowledgeClauseCode(profileId, reservedKeys = new Set()) {
  const profile = currentBotProfiles().find(item => item.id === profileId)
  const prefix = String(profile?.code || 'KN').toUpperCase()
  const base = `${prefix}-${String(Date.now()).slice(-6)}`
  let serial = 1
  let clauseCode = base
  let clauseKey = knowledgeClauseKey(profileId, clauseCode)

  while (reservedKeys.has(clauseKey) || findKnowledgeEntryByClauseCode(profileId, clauseCode)) {
    serial += 1
    clauseCode = `${base}-${serial}`
    clauseKey = knowledgeClauseKey(profileId, clauseCode)
  }

  return clauseCode
}

function nextDraftClauseCodes(profile, total = 0) {
  const prefix = `${String(profile?.code || 'KN').toUpperCase()}-D`
  const usedCodes = new Set(
    knowledgeEntries
      .filter(entry => entry.profileId === profile.id)
      .map(entry => normalizeClauseCode(entry.clauseCode))
      .filter(code => code.startsWith(prefix))
  )

  const codes = []
  let cursor = 1

  while (codes.length < total) {
    const nextCode = `${prefix}${String(cursor).padStart(2, '0')}`
    if (!usedCodes.has(nextCode)) {
      usedCodes.add(nextCode)
      codes.push(nextCode)
    }
    cursor += 1
  }

  return codes
}

function profileNameById(profileId) {
  return currentBotProfiles().find(item => item.id === profileId)?.name || profileId
}

function activeKnowledgeEntriesFor(profileId) {
  return knowledgeEntries.filter(entry => (
    entry.status === '启用' &&
    knowledgeIsVerified(entry) &&
    (entry.profileId === profileId || entry.profileId === 'all')
  ))
}

function normalizeSnippetText(text = '') {
  return String(text).replace(/\s+/g, ' ').trim()
}

function snippetAroundKeyword(text = '', keyword = '', radius = 48) {
  const normalized = normalizeSnippetText(text)
  if (!normalized || !keyword) return ''

  const lowerText = normalized.toLowerCase()
  const lowerKeyword = keyword.toLowerCase()
  const index = lowerText.indexOf(lowerKeyword)
  if (index === -1) return normalized.slice(0, radius * 2)

  const start = Math.max(0, index - radius)
  const end = Math.min(normalized.length, index + keyword.length + radius)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < normalized.length ? '...' : ''
  return `${prefix}${normalized.slice(start, end)}${suffix}`
}

function buildHitEvidence(proposal, matchedKeywords = []) {
  const files = proposal.files || []
  const sources = [
    ...files
      .map(file => ({
        sourceType: '附件正文',
        sourceLabel: file.name || '未命名附件',
        text: file.text || file.textPreview || ''
      }))
      .filter(source => source.text),
    {
      sourceType: '方案说明',
      sourceLabel: '方案说明',
      text: proposal.description || ''
    },
    {
      sourceType: '方案标题',
      sourceLabel: '方案标题',
      text: proposal.title || ''
    },
    ...files
      .map(file => ({
        sourceType: '附件名称',
        sourceLabel: file.name || '未命名附件',
        text: file.name || ''
      }))
      .filter(source => source.text)
  ]

  const evidence = []
  for (const source of sources) {
    const lowerText = String(source.text).toLowerCase()
    const matchedInSource = matchedKeywords.filter(keyword => lowerText.includes(keyword.toLowerCase()))
    if (matchedInSource.length === 0) continue

    evidence.push({
      sourceType: source.sourceType,
      sourceLabel: source.sourceLabel,
      matchedKeywords: matchedInSource,
      snippet: snippetAroundKeyword(source.text, matchedInSource[0], source.sourceType === '附件名称' ? 20 : 56)
    })

    if (evidence.length >= 2) break
  }

  return evidence
}

function matchKnowledgeEntries(profile, proposal) {
  const corpus = proposalCorpus(proposal).toLowerCase()

  return activeKnowledgeEntriesFor(profile.id)
    .map(entry => {
      const keywords = normalizeKeywords(entry.keywords)
      const matchedKeywords = keywords.filter(keyword => corpus.includes(keyword.toLowerCase()))

      if (matchedKeywords.length === 0) return null

      return {
        id: entry.id,
        profileId: entry.profileId,
        profileName: profileNameById(entry.profileId),
        clauseCode: entry.clauseCode,
        title: entry.title,
        source: entry.source,
        content: entry.content,
        keywords,
        matchedKeywords,
        evidence: buildHitEvidence(proposal, matchedKeywords),
        priority: entry.priority,
        updatedAt: entry.updatedAt,
        matchScore: matchedKeywords.length * 10 + (entry.priority === '高' ? 4 : entry.priority === '中' ? 2 : 1)
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.matchScore - a.matchScore || a.clauseCode.localeCompare(b.clauseCode, 'zh-CN'))
    .slice(0, 3)
}

function evaluateRule(rule, proposal) {
  const files = proposal.files || []
  const corpus = proposalCorpus(proposal)
  const hasFile = files.length > 0
  const hasText = files.some(file => (file.wordCount || 0) > 0)
  const hasTender = /招标|tender|标书|采购|投标|评分办法|服务范围/i.test(corpus)
  const hasMeasure = /测算|预算|报价|收入|成本|现金流|xls|xlsx|人工费用|税费/i.test(corpus)
  const hasMarketInitiator = activeBotProfiles().some(profile => (
    profile.id === 'investment' &&
    profile.canInitiate &&
    profile.marketEnabled !== false
  ))

  if (rule.name.includes('附件')) {
    const passed = proposal.type === '市场拓展方案' ? hasTender && hasMeasure : hasFile && (hasText || proposal.description.length >= 20)
    return {
      ...rule,
      passed,
      impact: passed ? 0 : Math.min(10, Math.ceil((rule.weight || 10) / 3)),
      message: passed ? '附件或正文依据已满足。' : '附件或正文依据不足，需补充关键材料。'
    }
  }

  if (rule.category === '市场拓展') {
    const passed = proposal.type !== '市场拓展方案' || (hasTender && hasMarketInitiator)
    return {
      ...rule,
      passed,
      impact: passed ? 0 : Math.min(8, Math.ceil((rule.weight || 10) / 4)),
      message: passed
        ? '市场拓展立项规则已覆盖。'
        : !hasMarketInitiator
          ? '未启用投资发展立项机器人，市场拓展流程配置需补齐。'
          : '缺少招标或采购依据，立项判断需补强。'
    }
  }

  if (rule.category === '内部运营') {
    const passed = proposal.type !== '内部运营方案' || hasText || proposal.description.length >= 20
    return {
      ...rule,
      passed,
      impact: passed ? 0 : Math.min(6, Math.ceil((rule.weight || 10) / 5)),
      message: passed ? '内部运营审核规则已覆盖。' : '内部运营方案依据不足，需补充执行标准或附件。'
    }
  }

  return {
    ...rule,
    passed: true,
    impact: 0,
    message: '规则已纳入审核口径。'
  }
}

function evaluateRules(proposal) {
  return activeRulesFor(proposal).map(rule => evaluateRule(rule, proposal))
}

function buildOpinion(profile, proposal) {
  const ruleMatches = evaluateRules(proposal)
  const knowledgeHits = matchKnowledgeEntries(profile, proposal)
  const isMarket = proposal.type === '市场拓展方案'
  const focus = isMarket ? '招标文件、测算表与项目边界' : '内部运营方案与作业标准'
  const failedRules = ruleMatches.filter(rule => !rule.passed)
  const risk = failedRules.length > 0
    ? failedRules.some(rule => Number(rule.weight) >= 20 || Number(rule.impact) >= 8) ? '高' : '中'
    : '未评估'
  const knowledgeFinding = knowledgeHits.length > 0
    ? `命中 ${knowledgeHits.length} 条专业知识库条款：${knowledgeHits.map(item => `${item.clauseCode} ${item.title}`).join('；')}。`
    : '暂未命中专业知识库条款，建议补充与本专业相关的制度依据、测算口径或执行标准。'

  return {
    profileId: profile.id,
    code: profile.code,
    name: profile.name,
    hermesName: profile.hermesName,
    status: '待人工复核',
    score: null,
    risk,
    focus,
    ruleMatches,
    knowledgeHits,
    conclusion: failedRules.length > 0
      ? `经已验证规则初筛发现 ${failedRules.length} 项待补强依据；本地链路不生成评分，须人工复核。`
      : '未获得真实 AI 评分，已保留已验证规则和知识命中依据，须人工复核。',
    findings: [
      `${profile.scope}仅按已核验的规则与知识条款执行可追溯初筛。`,
      `${focus}的当前风险标记为「${risk}」，不代表 AI 实时评分。`,
      `已执行 ${ruleMatches.length} 条有审批留痕的规则，${failedRules.length} 条需补强。`,
      knowledgeFinding,
      `输出要求：${profile.output}。`
    ],
    suggestions: [
      ...knowledgeHits.slice(0, 2).map(item => `结合「${item.clauseCode} ${item.title}」补充：${item.content}`),
      ...failedRules.slice(0, 2).map(rule => `按「${rule.name}」补充：${rule.message}`),
      ...(knowledgeHits.length === 0 ? [`补充与「${profile.name}」相关的制度条款、SOP 或测算依据，提升条款命中率。`] : []),
      ...verifiedProfileStandards(profile).slice(0, 3).map(item => `补充或核对已核验标准「${item}」相关依据。`)
    ].slice(0, 4),
    completedAt: nowText()
  }
}

function buildInitiationReport(proposal) {
  if (proposal.type !== '市场拓展方案') return null
  const corpus = proposalCorpus(proposal)
  const hasTender = /招标|tender|标书|采购|投标|评分办法|服务范围/i.test(corpus)
  const hasMeasure = /测算|预算|报价|收入|成本|现金流|xls|xlsx|人工费用|税费/i.test(corpus)
  const parsedFiles = proposal.files.filter(file => file.extractionStatus === '已解析').length
  const investmentProfile = activeBotProfiles().find(item => item.id === 'investment' && item.canInitiate)
  if (!investmentProfile) {
    return {
      title: `${proposal.title}立项报告`,
      owner: '未配置立项机器人',
      status: '待配置',
      generatedAt: nowText(),
      summary: '当前未启用投资发展立项机器人，市场拓展方案需先完成机器人配置后再发起正式立项审核。',
      viability: '待配置',
      knowledgeHits: [],
      keyPoints: [
        '请在审核机器人配置中启用投资发展总监，并保留市场拓展立项能力。',
        '完成配置后重新发起审核，系统将自动生成立项报告与后续专业会审意见。',
        '如需临时停用，请同步安排人工立项审核流程。'
      ],
      risks: [
        '市场拓展方案缺少立项牵头专业时，立项判断和后续会审链路存在流程缺口。'
      ]
    }
  }
  const knowledgeHits = investmentProfile ? matchKnowledgeEntries(investmentProfile, proposal) : []

  return {
    title: `${proposal.title}立项报告`,
    owner: investmentProfile.name,
    status: '待人工复核',
    generatedAt: nowText(),
    summary: `仅完成本地关键词与已验证条款初筛，不构成立项判断。本次解析 ${parsedFiles} 个附件，命中 ${knowledgeHits.length} 条已验证投资发展知识条款，须由人工结合原件评估。`,
    viability: '待人工评估',
    knowledgeHits,
    keyPoints: [
      hasTender ? '已识别招标文件附件，建议继续校验评分条款、服务边界和废标风险。' : '未识别明确招标文件，需补充正式招标文件或采购需求书。',
      hasMeasure ? '已识别测算表附件，建议复核收入、人工、外包、税费和现金流假设。' : '未识别测算表，需补充项目测算表后再进入完整评审。',
      '需明确项目目标、合同周期、付款条件、交付边界和重大偏离项。'
    ],
    risks: [
      '商务条款与实际服务成本不匹配可能影响项目毛利。',
      '服务承诺超出标准配置时，需要同步调整人力和设施预算。',
      '投标响应材料应与公司作业标准保持一致，避免承诺无法落地。'
    ]
  }
}

function buildSummary(proposal, opinions, initiationKnowledgeHits = []) {
  if (opinions.length === 0) {
    return {
      result: '待人工复核',
      avgScore: null,
      riskCount: { high: 0, medium: 0, low: 0 },
      mainRisks: ['当前未启用可参与该方案审核的机器人，请先完成机器人配置。'],
      ruleMatches: [],
      knowledgeHits: [...initiationKnowledgeHits],
      knowledgeHitCount: initiationKnowledgeHits.length,
      failedRuleCount: 0,
      finalOpinion: `${proposal.type}当前未匹配到可参与审核的机器人，请启用相关专业后重新发起审核。`,
      generatedAt: nowText()
    }
  }

  const scores = opinions.map(item => item.score).filter(value => Number.isFinite(value))
  const avg = scores.length > 0 ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : null
  const highRisks = opinions.filter(item => item.risk === '高')
  const mediumRisks = opinions.filter(item => item.risk === '中')
  const result = '待人工复核'
  const ruleMap = new Map()
  for (const opinion of opinions) {
    for (const rule of opinion.ruleMatches || []) {
      if (!ruleMap.has(rule.id)) ruleMap.set(rule.id, rule)
    }
  }
  const ruleMatches = [...ruleMap.values()]
  const failedRules = ruleMatches.filter(rule => !rule.passed)
  const knowledgeMap = new Map()
  for (const hit of initiationKnowledgeHits) {
    if (!knowledgeMap.has(hit.id)) knowledgeMap.set(hit.id, hit)
  }
  for (const opinion of opinions) {
    for (const hit of opinion.knowledgeHits || []) {
      if (!knowledgeMap.has(hit.id)) knowledgeMap.set(hit.id, hit)
    }
  }
  const knowledgeHits = [...knowledgeMap.values()]

  return {
    result,
    avgScore: avg,
    riskCount: { high: highRisks.length, medium: mediumRisks.length, low: opinions.length - highRisks.length - mediumRisks.length },
    mainRisks: [...highRisks, ...mediumRisks].slice(0, 5).map(item => `${item.name}：${item.suggestions[0]}`),
    ruleMatches,
    knowledgeHits,
    knowledgeHitCount: knowledgeHits.length,
    failedRuleCount: failedRules.length,
    finalOpinion: `${proposal.type}已完成 ${opinions.length} 个专业的可追溯本地初筛；未获得真实 AI 评分，不作出通过结论。本次执行 ${ruleMatches.length} 条已验证规则，${failedRules.length} 条需补强，命中 ${knowledgeHits.length} 条已验证知识条款，待人工复核。`,
    generatedAt: nowText()
  }
}

function buildLocalReview(proposal) {
  const allProfiles = activeBotProfiles()
  const marketInitiator = allProfiles.find(profile => profile.id === 'investment' && profile.canInitiate)
  const internalReviewers = allProfiles.filter(profile => profile.internalEnabled !== false)
  const marketReviewers = allProfiles.filter(profile => profile.id !== 'investment' && profile.marketEnabled !== false)

  const flow =
    proposal.type === '市场拓展方案'
      ? [
          marketInitiator ? `${marketInitiator.name}立项报告` : '市场拓展立项报告',
          `${marketReviewers.length}专业并行审核`,
          '汇总意见'
        ]
      : [`${internalReviewers.length}专业并行审核`, '汇总意见']

  const reviewers =
    proposal.type === '市场拓展方案'
      ? marketReviewers
      : internalReviewers

  const opinions = reviewers.map(profile => buildOpinion(profile, proposal))
  const initiationReport = buildInitiationReport(proposal)
  const summary = buildSummary(proposal, opinions, initiationReport?.knowledgeHits || [])

  proposal.flow = flow
  proposal.robot = proposal.type === '市场拓展方案'
    ? `${marketInitiator?.name || '投资发展总监'} + ${marketReviewers.length}专业`
    : `${internalReviewers.length}专业并行`
  proposal.status = statuses.review
  proposal.initiationReport = initiationReport
  proposal.opinions = opinions
  proposal.summary = summary
  proposal.updatedAt = nowText()
  addTimeline(proposal, '系统', '生成本地规则初筛草稿', summary.finalOpinion)
  return proposal
}

function compactProposalForAi(proposal = {}) {
  return {
    id: proposal.id,
    title: proposal.title,
    type: proposal.type,
    description: proposal.description,
    files: (proposal.files || []).map(file => ({
      name: file.name,
      type: file.type,
      extractionStatus: file.extractionStatus,
      extractionType: file.extractionType,
      wordCount: file.wordCount || 0,
      text: String(file.text || file.textPreview || '').slice(0, 3000)
    }))
  }
}

function compactBaselineForAi(baseline = {}) {
  return {
    flow: baseline.flow || [],
    initiationReport: baseline.initiationReport ? {
      summary: baseline.initiationReport.summary,
      viability: baseline.initiationReport.viability,
      keyPoints: baseline.initiationReport.keyPoints || [],
      risks: baseline.initiationReport.risks || []
    } : null,
    opinions: (baseline.opinions || []).map(opinion => ({
      profileId: opinion.profileId,
      name: opinion.name,
      score: opinion.score,
      risk: opinion.risk,
      conclusion: opinion.conclusion,
      findings: opinion.findings || [],
      suggestions: opinion.suggestions || [],
      knowledgeHits: (opinion.knowledgeHits || []).map(hit => ({
        clauseCode: hit.clauseCode,
        title: hit.title,
        content: hit.content,
        matchedKeywords: hit.matchedKeywords || []
      }))
    })),
    summary: baseline.summary ? {
      result: baseline.summary.result,
      avgScore: baseline.summary.avgScore,
      riskCount: baseline.summary.riskCount,
      mainRisks: baseline.summary.mainRisks || [],
      finalOpinion: baseline.summary.finalOpinion,
      knowledgeHitCount: baseline.summary.knowledgeHitCount || 0,
      failedRuleCount: baseline.summary.failedRuleCount || 0
    } : null
  }
}

function buildAiReviewMessages(proposal, baseline, aiRuntime) {
  return [
    {
      role: 'system',
      content: [
        '你是第一服务研发小组的多专业方案审核 AI。',
        '你的任务是基于方案正文、附件解析内容、专业 Profile、知识库命中和本地规则基线，输出可直接落库的结构化审核 JSON。',
        '必须只输出 JSON，不要 Markdown，不要解释。',
        'JSON 字段：summary、opinions、initiationReport。',
        'summary 包含 result、avgScore、finalOpinion、mainRisks。',
        'opinions 数组每项包含 profileId、score、risk、conclusion、findings、suggestions。',
        'risk 只能是 低、中、高；score 为 0-100 整数。'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        aiRuntime: { provider: aiRuntime.provider, model: aiRuntime.model },
        proposal: compactProposalForAi(proposal),
        botProfiles: activeBotProfiles().map(profile => ({
          id: profile.id,
          code: profile.code,
          name: profile.name,
          scope: profile.scope,
          output: profile.output,
          standards: verifiedProfileStandards(profile),
          standardsStatus: profileStandardsAreVerified(profile) ? '已核验' : '未核验，未作为审核依据',
          internalEnabled: profile.internalEnabled,
          marketEnabled: profile.marketEnabled,
          canInitiate: profile.canInitiate
        })),
        activeRules: activeRulesFor(proposal).map(rule => ({
          category: rule.category,
          name: rule.name,
          weight: rule.weight,
          description: rule.description
        })),
        baseline: compactBaselineForAi(baseline)
      })
    }
  ]
}

function extractJsonObject(text = '') {
  const raw = String(text || '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    try {
      return JSON.parse(fenced[1])
    } catch {}
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1))
    } catch {}
  }
  return null
}

function normalizeAiRisk(value = '', fallback = '未评估') {
  return ['低', '中', '高'].includes(value) ? value : fallback
}

function verifiedAiScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.round(value)
    : null
}

function mergeAiReviewResult(proposal, baseline, aiResult = {}, aiRuntime) {
  const now = nowText()
  const opinionsByProfile = new Map((baseline.opinions || []).map(item => [item.profileId, item]))
  const aiOpinions = Array.isArray(aiResult.opinions) ? aiResult.opinions : []
  const nextOpinions = (baseline.opinions || []).map(opinion => {
    const incoming = aiOpinions.find(item => item.profileId === opinion.profileId || item.name === opinion.name)
    if (!incoming) return opinion
    const score = verifiedAiScore(incoming.score)
    return {
      ...opinion,
      score,
      risk: normalizeAiRisk(incoming.risk, opinion.risk || '未评估'),
      conclusion: String(incoming.conclusion || opinion.conclusion || '').trim(),
      findings: normalizeTextList(incoming.findings).length > 0 ? normalizeTextList(incoming.findings).slice(0, 6) : opinion.findings,
      suggestions: normalizeTextList(incoming.suggestions).length > 0 ? normalizeTextList(incoming.suggestions).slice(0, 6) : opinion.suggestions,
      completedAt: now
    }
  })

  for (const incoming of aiOpinions) {
    if (opinionsByProfile.has(incoming.profileId)) continue
    const profile = activeBotProfiles().find(item => item.id === incoming.profileId)
    if (!profile) continue
    nextOpinions.push({
      profileId: profile.id,
      code: profile.code,
      name: profile.name,
      hermesName: profile.hermesName,
      status: '已完成',
      score: verifiedAiScore(incoming.score),
      risk: normalizeAiRisk(incoming.risk),
      focus: profile.scope,
      ruleMatches: [],
      knowledgeHits: [],
      conclusion: String(incoming.conclusion || '').trim() || '已完成 AI 审核。',
      findings: normalizeTextList(incoming.findings).slice(0, 6),
      suggestions: normalizeTextList(incoming.suggestions).slice(0, 6),
      completedAt: now
    })
  }

  const aiSummary = aiResult.summary || {}
  const summary = buildSummary(proposal, nextOpinions, baseline.initiationReport?.knowledgeHits || [])
  summary.result = String(aiSummary.result || summary.result).trim() || summary.result
  const opinionScores = nextOpinions.map(item => item.score).filter(value => Number.isFinite(value))
  const reportedAverage = verifiedAiScore(aiSummary.avgScore)
  summary.avgScore = reportedAverage ?? (opinionScores.length > 0
    ? Math.round(opinionScores.reduce((sum, value) => sum + value, 0) / opinionScores.length)
    : null)
  summary.finalOpinion = String(aiSummary.finalOpinion || summary.finalOpinion).trim() || summary.finalOpinion
  summary.mainRisks = normalizeTextList(aiSummary.mainRisks).length > 0 ? normalizeTextList(aiSummary.mainRisks).slice(0, 8) : summary.mainRisks
  summary.generatedAt = now

  const aiInitiation = aiResult.initiationReport || null
  const allowedAiViability = new Set(['建议立项', '有条件立项', '不建议立项', '待人工评估'])
  const aiViability = String(aiInitiation?.viability || '').trim()
  const aiInitiationSummary = String(aiInitiation?.summary || '').trim()
  const hasValidAiInitiation = Boolean(
    baseline.initiationReport &&
    aiInitiation &&
    allowedAiViability.has(aiViability) &&
    aiInitiationSummary.length >= 4
  )
  const initiationReport = hasValidAiInitiation ? {
    ...baseline.initiationReport,
    status: 'AI 初筛已返回，待人工复核',
    summary: aiInitiationSummary,
    viability: aiViability,
    keyPoints: normalizeTextList(aiInitiation.keyPoints).length > 0 ? normalizeTextList(aiInitiation.keyPoints).slice(0, 8) : baseline.initiationReport.keyPoints,
    risks: normalizeTextList(aiInitiation.risks).length > 0 ? normalizeTextList(aiInitiation.risks).slice(0, 8) : baseline.initiationReport.risks
  } : baseline.initiationReport

  proposal.flow = baseline.flow
  proposal.robot = baseline.robot
  proposal.status = summary.result === '需修改后复核' ? statuses.revision : statuses.review
  proposal.initiationReport = initiationReport
  proposal.opinions = nextOpinions
  proposal.summary = summary
  proposal.updatedAt = now
  addTimeline(proposal, 'AI 审核机器人', '调用外部 AI 审核', `${aiRuntime.provider}/${aiRuntime.model} 已返回结构化审核意见。`)
  return proposal
}

async function requestExternalAiReview(proposal, baseline, aiRuntime) {
  const safeRuntime = validateAiRuntimeBoundary(aiRuntime)
  const apiKey = process.env.AI_REVIEW_API_KEY
  if (!apiKey) throw new Error('AI_REVIEW_API_KEY 未配置')
  const url = aiChatCompletionsUrl(safeRuntime.baseUrl)
  const controller = new AbortController()
  const configuredTimeout = Number(process.env.AI_REVIEW_TIMEOUT_MS)
  const timeoutMs = Math.min(40_000, Math.max(5_000, Number.isFinite(configuredTimeout) ? configuredTimeout : 35_000))
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: aiRuntime.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: buildAiReviewMessages(proposal, baseline, aiRuntime)
      })
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error?.message || `外部 AI 请求失败 (${response.status})`)
    if (data.summary || data.opinions) {
      if (data._meta?.fallback === true) throw new Error(data._meta?.error || 'Hermes 网关已回退规则引擎')
      return data
    }
    const content = data.choices?.[0]?.message?.content || data.output_text || ''
    const parsed = extractJsonObject(content)
    if (!parsed) throw new Error('外部 AI 未返回可解析 JSON')
    if (parsed._meta?.fallback === true) throw new Error(parsed._meta?.error || 'Hermes 网关已回退规则引擎')
    return parsed
  } finally {
    clearTimeout(timeout)
  }
}

async function requestHermesProfiles(aiRuntime = aiRuntimeConfig()) {
  const safeRuntime = validateAiRuntimeBoundary(aiRuntime)
  if (safeRuntime.provider !== 'hermes') throw new Error('Profile 接口只允许本机 Hermes Gateway')
  const apiKey = process.env.AI_REVIEW_API_KEY
  if (!apiKey) throw new Error('AI_REVIEW_API_KEY 未配置')
  const url = aiProfilesUrl(safeRuntime.baseUrl)
  if (!url) throw new Error('Hermes Base URL 未配置')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error?.message || data.message || `Hermes Profile 请求失败 (${response.status})`)
    return Array.isArray(data.data) ? data.data : Array.isArray(data.profiles) ? data.profiles : []
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Hermes Profile 请求超过 8 秒，已中止')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function requestHermesHealth(aiRuntime = aiRuntimeConfig()) {
  const safeRuntime = validateAiRuntimeBoundary(aiRuntime)
  if (safeRuntime.provider !== 'hermes') throw new Error('Hermes health 只允许本机 Gateway')
  const apiKey = process.env.AI_REVIEW_API_KEY
  if (!apiKey) throw new Error('AI_REVIEW_API_KEY 未配置')
  const url = aiHealthUrl(safeRuntime.baseUrl)
  if (!url) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error?.message || data.message || `Hermes Health 请求失败 (${response.status})`)
    return data && typeof data === 'object' ? data : null
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Hermes Health 请求超过 8 秒，已中止')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function hermesStatusDiagnostic(runtime = {}, error = null) {
  const message = String(error?.message || '').trim()
  const providerReady = runtime.provider === 'hermes'
  const baseUrlReady = Boolean(runtime.baseUrl)
  const keyReady = runtime.provider === 'local' || Boolean(runtime.apiKeyConfigured)
  const remoteReady = !message && providerReady && baseUrlReady && keyReady
  const agentReady = runtime.agentConfigured === true
  const keyEnv = runtime.apiKeyEnv || 'AI_REVIEW_API_KEY'

  const checks = [
    {
      label: 'AI Provider',
      status: providerReady ? '通过' : '需处理',
      detail: providerReady ? '当前 Provider 已设置为 Hermes。' : `当前 Provider 为 ${runtime.provider || '未配置'}，请切换为 Hermes。`
    },
    {
      label: 'Base URL',
      status: baseUrlReady ? '通过' : '需处理',
      detail: baseUrlReady ? `当前 Base URL：${runtime.baseUrl}` : '未配置 AI_REVIEW_BASE_URL 或系统设置 Base URL。'
    },
    {
      label: '密钥环境变量',
      status: keyReady ? '通过' : '需处理',
      detail: keyReady ? `已读取 ${keyEnv}。` : `未读取 ${keyEnv}，请在 systemd 环境变量中配置。`
    },
    {
      label: '远端响应',
      status: remoteReady ? '通过' : message ? '需处理' : '待确认',
      detail: remoteReady ? 'Hermes Profile 接口已返回可解析数据。' : message || '尚未发起远端请求。'
    },
    {
      label: 'AI 推理凭据',
      status: agentReady ? '通过' : '需处理',
      detail: agentReady ? 'AI 推理已通过受控部署开启。' : aiInferenceDisabledMessage
    }
  ]

  let nextAction = '请点击检查 Profile 接入确认远端返回。'
  if (!providerReady) {
    nextAction = '请在系统设置中把 AI Provider 切换为 Hermes。'
  } else if (!baseUrlReady) {
    nextAction = '请在系统设置或 first-service-review-api.service 中配置 Hermes Base URL。'
  } else if (!keyReady) {
    nextAction = `请在 first-service-review-api.service 中配置 ${keyEnv}，并确保与 Hermes Gateway 的 HERMES_API_KEY 一致。`
  } else if (/401|unauthorized|api key|token|密钥|无效/i.test(message)) {
    nextAction = `请核对 ${keyEnv} 与 Hermes Gateway 的 HERMES_API_KEY 是否一致。`
  } else if (/fetch failed|econnrefused|enotfound|timeout|aborted|network/i.test(message)) {
    nextAction = '请检查 Hermes Gateway 服务、3100 端口、Nginx /hermes 反向代理和服务器网络。'
  } else if (message) {
    nextAction = '请查看 Hermes Gateway 日志，并复制本诊断给运维继续排查。'
  } else if (remoteReady && !agentReady) {
    nextAction = '请先在供应商控制台轮换旧密钥，再通过独立受控流程以 0600 权限配置并启用 AI 推理。'
  } else if (remoteReady) {
    nextAction = 'Hermes Profile 接入链路已打通，请继续核对 8 个一级专业 Profile 的缺失和差异。'
  }

  return { checks, nextAction, gatewayConfigured: remoteReady, agentConfigured: agentReady }
}

async function runAiReview(proposal) {
  const startedAt = Date.now()
  const aiRuntime = aiRuntimeConfig()
  const { provider, model } = aiRuntime
  proposal.aiProvider = provider
  proposal.aiModel = model

  if (provider !== 'local' && !aiRuntime.agentConfigured) {
    throw new Error(aiInferenceDisabledMessage)
  }

  if (provider === 'local' || aiRuntime.fallback) {
    const reason = aiRuntime.fallback
      ? `未完成 ${provider} 的 Base URL 或 ${aiRuntime.apiKeyEnv} 配置`
      : '当前使用本地规则引擎'
    if (aiRuntime.fallback) addTimeline(proposal, '系统', 'AI 适配层回退', `${reason}，已使用本地规则引擎。`)
    const reviewed = buildLocalReview(proposal)
    addAiReviewTrace(reviewed, {
      provider,
      model,
      mode: aiRuntime.fallback ? 'fallback-local' : 'local',
      status: aiRuntime.fallback ? 'fallback' : 'needs-human-review',
      fallback: aiRuntime.fallback,
      durationMs: Date.now() - startedAt,
      profileCount: activeBotProfiles().length,
      opinionCount: reviewed.opinions?.length || 0,
      result: reviewed.summary?.result || '',
      error: aiRuntime.fallback ? reason : ''
    })
    return reviewed
  }

  const baseline = buildLocalReview(JSON.parse(JSON.stringify(proposal)))
  try {
    const aiResult = await requestExternalAiReview(proposal, baseline, aiRuntime)
    const reviewed = mergeAiReviewResult(proposal, baseline, aiResult, aiRuntime)
    addAiReviewTrace(reviewed, {
      provider,
      model,
      mode: aiResult._meta?.engine === 'hermes-agent' ? 'hermes-agent' : 'external',
      status: 'success',
      durationMs: Date.now() - startedAt,
      profileCount: activeBotProfiles().length,
      opinionCount: reviewed.opinions?.length || 0,
      result: reviewed.summary?.result || ''
    })
    return reviewed
  } catch (err) {
    addTimeline(proposal, '系统', 'AI 适配层回退', `${provider} 调用失败：${err.message || '未知错误'}，已使用本地规则引擎。`)
    const reviewed = buildLocalReview(proposal)
    addAiReviewTrace(reviewed, {
      provider,
      model,
      mode: 'fallback-local',
      status: 'fallback',
      fallback: true,
      durationMs: Date.now() - startedAt,
      profileCount: activeBotProfiles().length,
      opinionCount: reviewed.opinions?.length || 0,
      result: reviewed.summary?.result || '',
      error: err.message || '未知错误'
    })
    return reviewed
  }
}

async function createProposal(data) {
  const item = {
    id: proposalId(),
    title: data.title.trim(),
    type: data.type || '内部运营方案',
    submitter: data.submitter || '管理员',
    submitterUsername: data.submitterUsername || '',
    description: data.description || '',
    files: data.files || [],
    robot: '待分配',
    status: statuses.draft,
    createdAt: nowText(),
    updatedAt: nowText(),
    flow: [],
    initiationReport: null,
    opinions: [],
    summary: null,
    manualReview: defaultManualReview(),
    executionRecord: defaultExecutionRecord(),
    reminders: defaultReminders(),
    exportEvents: defaultExportEvents(),
    reviewNotes: [],
    aiReviewTrace: [],
    timeline: []
  }
  if (data.submissionMode === 'draft-only') {
    item.status = statuses.configurationPending
    item.robot = '待配置审核 Profile'
    addTimeline(item, item.submitter, '保存待配置草稿（未执行 AI）', `${item.type}已安全保存，附件 ${item.files.length} 个；待正式核验 Profile 后再发起审核。`)
    return item
  }
  addTimeline(item, item.submitter, '提交方案', `${item.type}已提交，附件 ${item.files.length} 个。`)
  return runAiReview(item)
}

function defaultUsers() {
  const bootstrapAdminPassword = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || '')
  const passwordError = passwordStrengthMessage(bootstrapAdminPassword)
  if (passwordError || isKnownDefaultPassword(bootstrapAdminPassword)) {
    throw new Error('首次初始化必须通过 BOOTSTRAP_ADMIN_PASSWORD 提供非默认强密码')
  }
  return [
    {
      id: 'U001',
      username: 'admin',
      passwordHash: hashPassword(bootstrapAdminPassword),
      role: '管理员',
      name: '管理员',
      department: '研发小组',
      status: '启用',
      createdAt: nowText(),
      mustChangePassword: false
    }
  ]
}

function defaultProposals() {
  // 首次初始化只建系统配置，绝不注入任何示例业务方案。
  return []
}

function defaultLogs() {
  // 新库从空业务审计记录开始；工厂初始化不得伪装成真实业务动作。
  return []
}

function defaultRules() {
  // 规则会直接影响审核结论，新库不得注入未审批的工厂模板。
  return []
}

function defaultKnowledgeEntries() {
  // 知识会直接进入 AI 提示与审核意见，新库仅允许从空集合开始。
  return []
}

function defaultStore() {
  return {
    users: defaultUsers(),
    proposals: defaultProposals(),
    logs: defaultLogs(),
    rules: defaultRules(),
    knowledgeEntries: defaultKnowledgeEntries(),
    botProfiles: defaultBotProfiles(),
    reminderConfig: defaultReminderConfig(),
    rolePermissions: normalizeRolePermissions(defaultRolePermissions),
    systemConfig: defaultSystemConfig()
  }
}

const storeArrayFields = ['users', 'proposals', 'logs', 'rules', 'knowledgeEntries', 'botProfiles']
const storeObjectFields = ['reminderConfig', 'rolePermissions', 'systemConfig']
const storeDirectory = path.dirname(storeFile)

function isPlainStoreObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function storeError(message, cause) {
  const error = new Error(`数据文件 ${storeFile} ${message}`)
  if (cause) error.cause = cause
  return error
}

function validateStoreStructure(value) {
  if (!isPlainStoreObject(value)) {
    throw storeError('顶层结构必须是 JSON 对象')
  }

  for (const field of storeArrayFields) {
    if (!Object.prototype.hasOwnProperty.call(value, field) || !Array.isArray(value[field])) {
      throw storeError(`字段 ${field} 必须是数组`)
    }
    const invalidIndex = value[field].findIndex(item => !isPlainStoreObject(item))
    if (invalidIndex >= 0) {
      throw storeError(`字段 ${field}[${invalidIndex}] 必须是 JSON 对象`)
    }
  }

  for (const field of storeObjectFields) {
    if (!Object.prototype.hasOwnProperty.call(value, field) || !isPlainStoreObject(value[field])) {
      throw storeError(`字段 ${field} 必须是 JSON 对象`)
    }
  }

  try {
    normalizeRolePermissions(value.rolePermissions, { strict: true })
  } catch (error) {
    throw storeError(`字段 rolePermissions 不安全：${error.message}`)
  }

  for (const [proposalIndex, proposal] of value.proposals.entries()) {
    if (!Array.isArray(proposal.files || [])) {
      throw storeError(`字段 proposals[${proposalIndex}].files 必须是数组`)
    }
    for (const [fileIndex, file] of (proposal.files || []).entries()) {
      if (!isPlainStoreObject(file)) {
        throw storeError(`字段 proposals[${proposalIndex}].files[${fileIndex}] 必须是对象`)
      }
      const storedName = String(file.storedName || '').trim()
      if (storedName && !safeStoredName(storedName)) {
        throw storeError(`字段 proposals[${proposalIndex}].files[${fileIndex}].storedName 不安全`)
      }
    }
  }

  return value
}

function safeStoredName(value = '') {
  const name = String(value).trim()
  return Boolean(name) && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !name.includes('\0') && path.basename(name) === name
}

function openStoredAttachment(storedName) {
  if (!safeStoredName(storedName)) throw new Error('附件存储名不安全')
  const directoryFlags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | noFollowFlag
  const directoryFd = fs.openSync(filesDir, directoryFlags)
  try {
    const directoryInfo = fs.fstatSync(directoryFd)
    // Linux /proc/self/fd 把已固定的目录 fd 作为父级，避免再次走可替换的中间路径。
    // macOS 单测没有 /proc，退回路径后用父目录和叶子 inode 双重快照失败关闭。
    const target = process.platform === 'linux'
      ? `/proc/self/fd/${directoryFd}/${storedName}`
      : path.join(filesDir, storedName)
    const pathBefore = fs.lstatSync(target)
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollowFlag)
    const info = fs.fstatSync(descriptor)
    const directoryAfter = fs.fstatSync(directoryFd)
    const pathAfter = fs.lstatSync(target)
    if (!info.isFile() || info.nlink !== 1 || !sameFileIdentity(pathBefore, info) || !sameFileIdentity(info, pathAfter) || !sameFileIdentity(directoryInfo, directoryAfter)) {
      closeStoreDescriptor(descriptor)
      throw new Error('附件必须是固定目录内未替换的单链接普通文件')
    }
    return descriptor
  } finally {
    closeStoreDescriptor(directoryFd)
  }
}

function downloadStoredAttachment(res, file) {
  let descriptor
  try {
    descriptor = openStoredAttachment(file.storedName)
    const info = fs.fstatSync(descriptor)
    const name = safeFileName(file.name || file.storedName)
    res.setHeader('Content-Type', file.type || 'application/octet-stream')
    res.setHeader('Content-Length', String(info.size))
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
    const stream = fs.createReadStream('/dev/null', { fd: descriptor, autoClose: true })
    descriptor = undefined
    stream.on('error', error => {
      console.error('附件读取失败', error)
      if (!res.headersSent) res.status(500).json({ message: '附件读取失败' })
      else res.destroy(error)
    })
    stream.pipe(res)
  } catch (error) {
    closeStoreDescriptor(descriptor)
    if (error?.code === 'ENOENT') return res.status(404).json({ message: '附件文件不存在' })
    console.error('附件打开失败', error)
    return res.status(400).json({ message: '附件路径或类型不安全' })
  }
}

function closeStoreDescriptor(fd) {
  if (fd === undefined || fd === null) return
  try {
    fs.closeSync(fd)
  } catch {}
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino)
}

function unlinkOwnedStoreFile(filePath, expectedStat) {
  try {
    const currentStat = fs.lstatSync(filePath)
    if (!currentStat.isFile() || !sameFileIdentity(currentStat, expectedStat)) return false
    fs.unlinkSync(filePath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function syncStoreDirectory() {
  const directoryFlags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | noFollowFlag
  const directoryFd = fs.openSync(storeDirectory, directoryFlags)
  try {
    fs.fsyncSync(directoryFd)
  } finally {
    closeStoreDescriptor(directoryFd)
  }
}

function createPreparedStoreFile(value) {
  validateStoreStructure(value)
  const content = Buffer.from(JSON.stringify(value, null, 2))
  if (content.length > backupHardMaxStoreBytes) {
    throw storeError(`store 超出 ${formatUploadSize(backupHardMaxStoreBytes)} 可备份上限，拒绝写入`)
  }
  const basename = path.basename(storeFile)
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tempPath = path.join(
      storeDirectory,
      `.${basename}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`
    )
    let fd
    try {
      fd = fs.openSync(tempPath, flags, 0o600)
      fs.fchmodSync(fd, 0o600)
      fs.writeFileSync(fd, content)
      fs.fsyncSync(fd)
      return { path: tempPath, fd, stat: fs.fstatSync(fd) }
    } catch (error) {
      closeStoreDescriptor(fd)
      if (error?.code === 'EEXIST') continue
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
      } catch {}
      throw error
    }
  }

  throw storeError('无法创建唯一的同目录临时文件')
}

function assertExistingStoreIsRegularFile() {
  let fd
  try {
    fd = fs.openSync(storeFile, fs.constants.O_RDONLY | noFollowFlag)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw storeError('不是常规文件，拒绝覆盖')
  } finally {
    closeStoreDescriptor(fd)
  }
}

function persistStoreAtomically(value, { initialize = false } = {}) {
  fs.mkdirSync(storeDirectory, { recursive: true, mode: 0o700 })
  const prepared = createPreparedStoreFile(value)
  let initialLinkCreated = false
  let renamed = false

  try {
    if (initialize) {
      try {
        // link(2) 在目标不存在时是原子 no-replace；并发初始化只能有一个发布者成功。
        fs.linkSync(prepared.path, storeFile)
        initialLinkCreated = true
      } catch (error) {
        if (error?.code === 'EEXIST') {
          throw storeError('首次初始化期间检测到并发创建，已拒绝覆盖')
        }
        throw error
      }

      const installedStat = fs.lstatSync(storeFile)
      const installedMode = installedStat.mode & 0o777
      if (!installedStat.isFile() || !sameFileIdentity(installedStat, prepared.stat) || installedMode !== 0o600) {
        throw storeError('首次初始化文件的 inode 或权限校验失败')
      }
      if (!unlinkOwnedStoreFile(prepared.path, prepared.stat)) {
        throw storeError('首次初始化无法清理临时文件')
      }
      syncStoreDirectory()
      console.log('数据文件首次初始化完成')
      return
    } else {
      assertExistingStoreIsRegularFile()
    }

    fs.renameSync(prepared.path, storeFile)
    renamed = true
    const installedStat = fs.lstatSync(storeFile)
    if (!installedStat.isFile() || !sameFileIdentity(installedStat, prepared.stat)) {
      throw storeError('原子替换后文件身份校验失败')
    }
    syncStoreDirectory()
  } catch (error) {
    if (initialize && initialLinkCreated) {
      try {
        const removedStore = unlinkOwnedStoreFile(storeFile, prepared.stat)
        const removedTemp = unlinkOwnedStoreFile(prepared.path, prepared.stat)
        if (removedStore || removedTemp) syncStoreDirectory()
      } catch {}
    } else if (!renamed) {
      try {
        unlinkOwnedStoreFile(prepared.path, prepared.stat)
      } catch {}
    }
    throw error
  } finally {
    closeStoreDescriptor(prepared.fd)
  }
}

function readStoreFileIfPresent() {
  let fd
  try {
    fd = fs.openSync(storeFile, fs.constants.O_RDONLY | noFollowFlag)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw storeError('读取失败，拒绝启动', error)
  }

  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw storeError('不是常规文件，拒绝启动')
    if (stat.nlink !== 1) throw storeError('不是单链接常规文件，拒绝启动')
    if (stat.size > backupHardMaxStoreBytes) {
      throw storeError(`超出 ${formatUploadSize(backupHardMaxStoreBytes)} 可备份上限，拒绝读入与启动`)
    }
    // 依 fstat 的有界尺寸分配内存，禁止 readFileSync 在同 UID 进程并发
    // 增长文件时越过 12MiB 硬上限。读后再核对 inode/size/mtime/ctime。
    const buffer = Buffer.allocUnsafe(stat.size)
    let offset = 0
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (bytesRead <= 0) throw storeError('读取时遇到意外 EOF，拒绝启动')
      offset += bytesRead
    }
    const after = fs.fstatSync(fd)
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      throw storeError('读取期间发生替换或变更，拒绝启动')
    }
    return buffer.toString('utf8')
  } catch (error) {
    if (String(error?.message || '').startsWith('数据文件 ')) throw error
    throw storeError('读取失败，拒绝启动', error)
  } finally {
    closeStoreDescriptor(fd)
  }
}

function loadStore() {
  const content = readStoreFileIfPresent()
  if (content === null) {
    const initialStore = defaultStore()
    persistStoreAtomically(initialStore, { initialize: true })
    return initialStore
  }

  let parsed
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw storeError('JSON 解析失败，拒绝启动', error)
  }
  return validateStoreStructure(parsed)
}

function normalizeBotProfile(profile = {}, index = 0) {
  const fallback = baseBotProfiles.find(item => item.id === profile.id) || baseBotProfiles[index] || {}
  return {
    ...fallback,
    ...profile,
    code: String(profile.code || fallback.code || `H${String(index + 1).padStart(2, '0')}`).trim(),
    name: String(profile.name || fallback.name || `审核机器人${index + 1}`).trim(),
    hermesName: String(profile.hermesName || fallback.hermesName || `Hermes-${index + 1}`).trim(),
    scope: String(profile.scope || fallback.scope || '').trim(),
    standards: cloneProfileStandards(profile.standards || fallback.standards || []),
    standardsVerifiedBy: String(profile.standardsVerifiedBy || '').trim(),
    standardsVerifiedAt: String(profile.standardsVerifiedAt || '').trim(),
    definitionVerifiedBy: String(profile.definitionVerifiedBy || '').trim(),
    definitionVerifiedAt: String(profile.definitionVerifiedAt || '').trim(),
    definitionVerifiedHash: String(profile.definitionVerifiedHash || '').trim().toLowerCase(),
    output: String(profile.output || fallback.output || '').trim(),
    status: profile.status === '停用' ? '停用' : '启用',
    internalEnabled: profile.internalEnabled !== false,
    marketEnabled: profile.marketEnabled !== false,
    canInitiate: fallback.id === 'investment' ? profile.canInitiate !== false : false,
    sortOrder: Number(profile.sortOrder) || index + 1,
    updatedAt: profile.updatedAt || nowText()
  }
}

function normalizeUser(user = {}) {
  const nextUser = { ...user }
  if (!nextUser.passwordHash && nextUser.password) {
    nextUser.passwordHash = hashPassword(nextUser.password)
    if (passwordStrengthMessage(nextUser.password)) nextUser.mustChangePassword = true
  }
  if (!nextUser.passwordHash) {
    nextUser.passwordHash = hashPassword(generateTemporaryPassword())
    nextUser.mustChangePassword = true
    nextUser.status = '停用'
    nextUser.credentialRecoveryRequired = true
  }
  const usesDefaultPassword = ['admin123', 'First123456'].some(defaultPassword => verifyPassword(defaultPassword, nextUser.passwordHash))
  if (usesDefaultPassword) {
    nextUser.passwordHash = hashPassword(generateTemporaryPassword())
    nextUser.mustChangePassword = true
    nextUser.status = '停用'
    nextUser.credentialRecoveryRequired = true
  }
  delete nextUser.password
  nextUser.role = normalizeUserRole(nextUser.role) || String(nextUser.role || '').trim()
  nextUser.department = nextUser.department || '研发小组'
  nextUser.status = normalizeUserStatus(nextUser.status) || '停用'
  nextUser.mustChangePassword = shouldForcePasswordChange(nextUser)
  nextUser.createdAt = nextUser.createdAt || nowText()
  return nextUser
}

function normalizeProposal(item, profileSource = null) {
  const currentProfiles = Array.isArray(profileSource)
    ? [...profileSource]
      .filter(profile => profile.status === '启用' && profileDefinitionIsVerified(profile))
      .sort((a, b) => (
        (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) ||
        String(a.code || '').localeCompare(String(b.code || ''), 'zh-CN')
      ))
    : activeBotProfiles()
  const marketInitiator = currentProfiles.find(profile => profile.id === 'investment' && profile.canInitiate)
  const internalReviewers = currentProfiles.filter(profile => profile.internalEnabled !== false)
  const marketReviewers = currentProfiles.filter(profile => profile.id !== 'investment' && profile.marketEnabled !== false)

  if (!Array.isArray(item.reviewNotes)) item.reviewNotes = []
  item.manualReview = normalizeManualReview(item.manualReview)
  item.executionRecord = normalizeExecutionRecord(item.executionRecord)
  item.reminders = normalizeReminders(item.reminders)
  item.exportEvents = normalizeExportEvents(item.exportEvents)
  item.aiReviewTrace = Array.isArray(item.aiReviewTrace) ? item.aiReviewTrace.map(trace => ({
    id: trace.id || `AIR${Date.now()}${crypto.randomBytes(3).toString('hex')}`,
    provider: String(trace.provider || item.aiProvider || 'local').trim(),
    model: String(trace.model || item.aiModel || 'local-rule-engine-v0.1').trim(),
    mode: String(trace.mode || '').trim(),
    status: String(trace.status || 'success').trim(),
    fallback: trace.fallback === true,
    durationMs: Math.max(0, Number(trace.durationMs) || 0),
    profileCount: Math.max(0, Number(trace.profileCount) || 0),
    opinionCount: Math.max(0, Number(trace.opinionCount) || 0),
    profileId: String(trace.profileId || '').trim(),
    profileIds: Array.isArray(trace.profileIds) ? trace.profileIds.map(value => String(value).trim()).filter(Boolean) : [],
    result: String(trace.result || '').trim(),
    error: String(trace.error || '').trim(),
    at: trace.at || item.updatedAt || item.createdAt || nowText()
  })) : []
  if (item.executionRecord.signOff.status === '已签发') item.status = statuses.passed
  if (!item.aiProvider) item.aiProvider = 'local'
  if (!item.aiModel) item.aiModel = 'local-rule-engine-v0.1'
  if (item.summary && !Array.isArray(item.summary.knowledgeHits)) item.summary.knowledgeHits = []
  if (item.summary && item.summary.knowledgeHitCount === undefined) item.summary.knowledgeHitCount = item.summary.knowledgeHits.length
  item.submitterUsername = String(item.submitterUsername || uniqueUsernameByName(item.submitter)).trim()
  if (Array.isArray(item.opinions)) {
    item.opinions = item.opinions.map(opinion => ({
      ...opinion,
      knowledgeHits: (opinion.knowledgeHits || []).map(hit => ({ evidence: [], ...hit })),
      ruleMatches: opinion.ruleMatches || []
    }))
  }
  if (item.summary) {
    item.summary.knowledgeHits = (item.summary.knowledgeHits || []).map(hit => ({ evidence: [], ...hit }))
  }
  if (item.initiationReport) {
    item.initiationReport.knowledgeHits = (item.initiationReport.knowledgeHits || []).map(hit => ({ evidence: [], ...hit }))
  }
  item.files = (item.files || []).map(file => ({
    extractionStatus: file.text || file.textPreview ? '已解析' : file.storedName ? '待解析' : '历史元数据',
    extractionType: file.extractionType || 'unknown',
    textPreview: file.textPreview || '',
    wordCount: file.wordCount || 0,
    ...file
  }))
  if (!Array.isArray(item.timeline)) {
    item.timeline = [
      {
        id: `T${Date.now()}${crypto.randomBytes(3).toString('hex')}`,
        actor: item.submitter || '系统',
        action: '历史方案导入',
        detail: item.summary?.finalOpinion || '方案已从历史数据迁移。',
        at: item.updatedAt || item.createdAt || nowText()
      }
    ]
  }
  // 没有已审批 Profile 时不得用“0 专业”或未核验模板重写历史流转口径。
  // 历史方案保留其原始 robot/flow；新提交已由 readiness 门禁阻断。
  if (currentProfiles.length > 0) {
    if (item.type === '市场拓展方案') {
      item.robot = `${marketInitiator?.name || '待配置立项牵头'} + ${marketReviewers.length}专业`
      item.flow = [
        marketInitiator ? `${marketInitiator.name}立项报告` : '待配置立项牵头',
        `${marketReviewers.length}专业并行审核`,
        '汇总意见'
      ]
    } else {
      item.robot = `${internalReviewers.length}专业并行`
      item.flow = [`${internalReviewers.length}专业并行审核`, '汇总意见']
    }
  } else {
    item.robot = String(item.robot || '待配置审核 Profile').trim()
    item.flow = Array.isArray(item.flow) ? item.flow : []
  }
  return item
}

function normalizeKnowledgeEntry(entry) {
  return {
    ...entry,
    source: String(entry.source || '').trim(),
    clauseCode: normalizeClauseCode(entry.clauseCode) || `KN-${String(entry.id || '').slice(-4)}`.toUpperCase(),
    title: entry.title || '未命名条款',
    content: entry.content || '',
    priority: entry.priority || '中',
    status: entry.status === '启用' ? '启用' : '停用',
    keywords: normalizeKeywords(entry.keywords),
    updatedAt: entry.updatedAt || nowText(),
    sourceVerifiedBy: String(entry.sourceVerifiedBy || '').trim(),
    sourceVerifiedAt: String(entry.sourceVerifiedAt || '').trim()
  }
}

function ensureUniqueProposalIds(items = []) {
  const seen = new Set()
  return items.map(item => {
    if (!item.id || seen.has(item.id)) item.id = proposalId()
    seen.add(item.id)
    return item
  })
}

function storeValueWithLogs(logItems) {
  return {
    users,
    proposals,
    logs: logItems,
    rules,
    knowledgeEntries,
    botProfiles,
    reminderConfig,
    rolePermissions,
    systemConfig
  }
}

function preparedStoreByteLimit() {
  const maxPreparedStoreBytes = backupHardMaxStoreBytes - storeNextMutationReserveBytes
  if (maxPreparedStoreBytes <= 0 || storeNextMutationReserveBytes < maxAuditLogEntryBytes * 2) {
    throw storeError('审计日志与下一次业务写入的字节余量配置不安全')
  }
  return maxPreparedStoreBytes
}

function prepareStoreValue(inputValue, { protectedLogIds = [] } = {}) {
  const source = validateStoreStructure(inputValue)
  let candidateLogs = boundedAuditLogs(source.logs)
  const maxPreparedStoreBytes = preparedStoreByteLimit()
  const protectedIds = new Set([...permanentAuditLogIds, ...protectedLogIds])

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = validateStoreStructure({ ...source, logs: candidateLogs })
    const actualBytes = Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8')
    if (actualBytes <= maxPreparedStoreBytes) return value

    let requiredReduction = actualBytes - maxPreparedStoreBytes + maxAuditLogEntryBytes
    const removeIndexes = new Set()
    for (let index = candidateLogs.length - 1; index >= 0 && requiredReduction > 0; index -= 1) {
      if (protectedIds.has(candidateLogs[index]?.id)) continue
      removeIndexes.add(index)
      requiredReduction -= auditLogStorageCost(candidateLogs[index])
    }
    if (removeIndexes.size === 0) {
      throw storeError('非日志业务数据已占满可备份上限，无法保留下一次正常业务写入余量')
    }
    candidateLogs = candidateLogs.filter((_item, index) => !removeIndexes.has(index))
  }
  throw storeError('按实际字节淘汰历史审计后仍无法满足 store 上限')
}

function prepareStoreValueForSave() {
  return prepareStoreValue(storeValueWithLogs(logs))
}

function saveStore() {
  try {
    // copy -> 规范化 -> 真实 pretty JSON 字节校验/淘汰 -> 原子持久化 -> swap。
    // 任何 route 即使先把日志压入内存，也不能把超限态带进后续请求。
    const prepared = prepareStoreValueForSave()
    persistStoreAtomically(prepared)
    logs = prepared.logs
  } catch (error) {
    // 所有 route 都先改内存再调用 saveStore；任何持久化失败必须把内存恢复到
    // 实际磁盘状态，避免后续请求看到“未落盘成功”的幽灵数据。
    try {
      const disk = validateStoreStructure(JSON.parse(readStoreFileIfPresent()))
      users = disk.users
      proposals = disk.proposals
      logs = boundedAuditLogs(disk.logs)
      rules = disk.rules
      knowledgeEntries = disk.knowledgeEntries
      botProfiles = disk.botProfiles
      reminderConfig = disk.reminderConfig
      rolePermissions = disk.rolePermissions
      systemConfig = disk.systemConfig
    } catch (recoveryError) {
      restoreRecoveryRequired = true
      console.error('store 写入失败且内存无法恢复，服务已失败关闭', recoveryError)
    }
    throw error
  }
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function isSha256Hex(value = '') {
  return /^[a-f0-9]{64}$/i.test(String(value || '').trim())
}

function hashStatusText(expectedHash = '', actualHash = '') {
  const expected = String(expectedHash || '').trim()
  const actual = String(actualHash || '').trim()
  if (!expected || !actual) return ''
  return expected === actual ? '指纹一致' : '指纹不一致'
}

function backupArchiveLimits() {
  return {
    maxAttachmentBytes: attachmentStorageHardMaxBytes,
    maxFileCount: attachmentStorageHardMaxFileCount,
    maxStoreBytes: backupHardMaxStoreBytes,
    maxArchiveBytes: backupHardMaxArchiveBytes,
    maxTarBytes: attachmentStorageHardMaxBytes + 48 * 1024 * 1024
  }
}

function currentBackupStore() {
  return validateStoreStructure(JSON.parse(JSON.stringify({
    users,
    proposals,
    logs,
    rules,
    knowledgeEntries,
    botProfiles,
    reminderConfig,
    rolePermissions,
    systemConfig
  })))
}

function backupStoreBuffer(storeValue = currentBackupStore()) {
  const buffer = Buffer.from(JSON.stringify(storeValue, null, 2))
  if (buffer.length > backupHardMaxStoreBytes) {
    throw new Error(`业务 store 超出 ${formatUploadSize(backupHardMaxStoreBytes)} 备份上限，请先归档历史日志`)
  }
  return buffer
}

function canonicalStoreBuffer(storeValue) {
  const buffer = Buffer.from(JSON.stringify(storeValue, null, 2))
  const maxPreparedStoreBytes = preparedStoreByteLimit()
  if (buffer.length > maxPreparedStoreBytes) {
    throw new Error(`恢复后的业务 store 未保留 ${formatUploadSize(storeNextMutationReserveBytes)} 下一次写入余量`)
  }
  return buffer
}

function backupArchivePreview(inspected) {
  const storeValue = validateStoreStructure(inspected.store)
  validateRestoredAttachmentReferences(storeValue.proposals, inspected.files)
  const manifest = inspected.manifest
  return {
    schema: manifest.schema,
    version: manifest.version,
    checksum: manifest.store.sha256,
    checksumVerified: true,
    exportedAt: manifest.createdAt,
    users: storeValue.users.length,
    proposals: storeValue.proposals.length,
    logs: storeValue.logs.length,
    rules: storeValue.rules.length,
    knowledgeEntries: storeValue.knowledgeEntries.length,
    botProfiles: storeValue.botProfiles.length,
    files: manifest.totals.fileCount,
    verifiedFiles: inspected.files.length,
    fileBytes: manifest.totals.fileBytes,
    archiveBytes: inspected.archiveBytes
  }
}

async function createCurrentBackupArchive(archivePath, signal) {
  if (activeMutationCount !== 0) throw new Error('当前存在未完成的数据写操作，拒绝生成可能不一致的备份')
  ensureBackupDirectory()
  fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 })
  const storeValue = currentBackupStore()
  const initialStoreHash = storeDiskSha256()
  const initialFiles = flatAttachmentRecords(filesDir)
  const storeBuffer = backupStoreBuffer(storeValue)
  const attachmentBytes = initialFiles.reduce((sum, file) => {
    const next = sum + Number(file.size)
    if (!Number.isSafeInteger(next) || next < 0) throw new Error('备份附件容量无法安全计算')
    return next
  }, 0)
  const archiveUpperBound = attachmentBytes + storeBuffer.length + backupArchiveGenerationAllowanceBytes
  const requiredFreeBytes = archiveUpperBound + backupRestoreReserveBytes
  if (!Number.isSafeInteger(requiredFreeBytes)) throw new Error('备份归档磁盘需求无法安全计算')
  // 必须在 createBackupArchive 创建任何临时归档前失败关闭；
  // 历史快照已占用的空间由当前 free 自然扣除，额外保留 2GiB 给 store/journal。
  assertBackupRestoreDiskHeadroom(requiredFreeBytes, '生成备份归档前', backupsDir)
  const created = await createBackupArchive({
    archivePath,
    storeBuffer,
    filesDir,
    mode: 0o600,
    signal,
    limits: backupArchiveLimits()
  })
  try {
    if (storeDiskSha256() !== initialStoreHash) throw new Error('业务 store 在归档生成期间发生变化')
    assertFlatAttachmentRecords(filesDir, initialFiles)
    validateRestoredAttachmentReferences(storeValue.proposals, created.files)
    return created
  } catch (error) {
    const installed = fs.lstatSync(archivePath)
    unlinkOwnedStoreFile(archivePath, installed)
    syncDirectoryPath(backupsDir)
    throw error
  }
}

async function inspectBackupArchive(archivePath, stagingDir = '', signal) {
  const inspected = stagingDir
    ? await restoreBackupArchive({
        archivePath,
        stagingDir,
        expectedStagingUid: typeof process.geteuid === 'function' ? process.geteuid() : undefined,
        signal,
        limits: backupArchiveLimits()
      })
    : await previewBackupArchive({ archivePath, signal, limits: backupArchiveLimits() })
  return { ...inspected, preview: backupArchivePreview(inspected) }
}

async function writeServerBackupSnapshot(prefix = 'pre-restore', signal) {
  if (!['manual-backup', 'pre-restore', 'pre-delete', 'pre-bulk-delete'].includes(prefix)) {
    throw new Error('备份快照前缀不在白名单')
  }
  ensureBackupDirectory()
  const backupPath = path.join(
    backupsDir,
    `${prefix}-${Date.now()}-${crypto.randomBytes(12).toString('hex')}${BACKUP_ARCHIVE_SUFFIX}`
  )
  await createCurrentBackupArchive(backupPath, signal)
  return backupPath
}

async function writePreRestoreBackup(signal) {
  return writeServerBackupSnapshot('pre-restore', signal)
}

function exactSnapshotName(value = '') {
  const name = String(value || '')
  if (
    !name ||
    name !== path.basename(name) ||
    !/^(?:manual-backup|pre-restore|pre-delete|pre-bulk-delete)-[A-Za-z0-9._-]+\.firstcare-review-backup\.tgz$/.test(name)
  ) {
    throw new Error('备份快照文件名不正确')
  }
  return name
}

function snapshotArchivePath(name) {
  return path.join(backupsDir, exactSnapshotName(name))
}

function unlinkSnapshotFile(name) {
  const archivePath = snapshotArchivePath(name)
  const lease = openBackupArchiveForRead({ archivePath, limits: backupArchiveLimits() })
  const expected = lease.info
  lease.close()
  if (!unlinkOwnedStoreFile(archivePath, expected)) throw new Error('备份快照在删除前发生替换')
  syncDirectoryPath(backupsDir)
}

function listBackupSnapshots() {
  if (!fs.existsSync(backupsDir)) return []
  return fs.readdirSync(backupsDir)
    .filter(name => /^(?:manual-backup|pre-restore|pre-delete|pre-bulk-delete)-[A-Za-z0-9._-]+\.firstcare-review-backup\.tgz$/.test(name))
    .map(name => {
      const lease = openBackupArchiveForRead({ archivePath: snapshotArchivePath(name), limits: backupArchiveLimits() })
      try {
        return {
          name,
          type: name.startsWith('manual-backup-') ? '手动备份' : '恢复前',
          size: lease.size,
          updatedAt: lease.info.mtime.toISOString()
        }
      } finally {
        lease.close()
      }
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

function removeOwnedBackupArchive(archivePath, expected) {
  if (!archivePath || !expected) return false
  const removed = unlinkOwnedStoreFile(archivePath, expected)
  if (removed) syncDirectoryPath(backupsDir)
  return removed
}

function closeBackupDownloadTicket(ticket, removeTemporary = true) {
  if (!ticket || ticket.closed) return
  ticket.closed = true
  if (ticket.timer) clearTimeout(ticket.timer)
  try {
    ticket.lease.close()
  } catch {}
  if (removeTemporary && ticket.deleteAfterUse) {
    try {
      removeOwnedBackupArchive(ticket.archivePath, ticket.archiveIdentity)
    } catch (error) {
      console.error('一次性备份下载临时归档清理失败', error)
    }
  }
}

function pruneBackupDownloadTickets() {
  const now = Date.now()
  for (const [token, ticket] of backupDownloadTickets) {
    if (ticket.expiresAtMs <= now) {
      backupDownloadTickets.delete(token)
      closeBackupDownloadTicket(ticket)
    }
  }
}

function issueBackupDownloadTicket(archivePath, filename, deleteAfterUse = false) {
  pruneBackupDownloadTickets()
  if (backupDownloadTickets.size >= backupDownloadTicketLimit) {
    throw new Error('未消费的备份下载票据过多，请等待旧票据过期')
  }
  const lease = openBackupArchiveForRead({ archivePath, limits: backupArchiveLimits() })
  let token
  do {
    token = crypto.randomBytes(32).toString('base64url')
  } while (backupDownloadTickets.has(token))
  const expiresAtMs = Date.now() + backupDownloadTicketTtlMs
  const ticket = {
    token,
    lease,
    archivePath,
    archiveIdentity: lease.info,
    filename: String(filename || `first-service-review-backup${BACKUP_ARCHIVE_SUFFIX}`),
    deleteAfterUse,
    expiresAtMs,
    closed: false,
    timer: null
  }
  ticket.timer = setTimeout(() => {
    if (backupDownloadTickets.get(token) !== ticket) return
    backupDownloadTickets.delete(token)
    closeBackupDownloadTicket(ticket)
  }, backupDownloadTicketTtlMs + 1000)
  ticket.timer.unref()
  backupDownloadTickets.set(token, ticket)
  return {
    ticket,
    response: {
      downloadUrl: `/review-api/system-backup/download/${token}`,
      filename: ticket.filename,
      expiresAt: new Date(expiresAtMs).toISOString(),
      oneTime: true
    }
  }
}

function revokeBackupDownloadTicket(ticket) {
  if (!ticket) return
  if (backupDownloadTickets.get(ticket.token) === ticket) backupDownloadTickets.delete(ticket.token)
  closeBackupDownloadTicket(ticket)
}

function streamBackupDownloadTicket(req, res) {
  const token = String(req.params.ticket || '')
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return res.status(404).json({ message: '下载票据不存在或已过期' })
  pruneBackupDownloadTickets()
  const ticket = backupDownloadTickets.get(token)
  if (!ticket || ticket.expiresAtMs <= Date.now()) {
    if (ticket) {
      backupDownloadTickets.delete(token)
      closeBackupDownloadTicket(ticket)
    }
    return res.status(404).json({ message: '下载票据不存在或已过期' })
  }
  // 先从有界集合中移除，保证并发 GET 最多一个能固定同一 FD。
  backupDownloadTickets.delete(token)
  if (ticket.timer) clearTimeout(ticket.timer)
  let stream
  try {
    stream = ticket.lease.createReadStream()
  } catch (error) {
    closeBackupDownloadTicket(ticket)
    return res.status(410).json({ message: error.message || '下载票据已被消费' })
  }
  res.setHeader('Content-Type', 'application/gzip')
  res.setHeader('Content-Length', String(ticket.lease.size))
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(ticket.filename)}`)
  res.setHeader('Cache-Control', 'no-store, private, max-age=0')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Accept-Ranges', 'none')
  let cleaned = false
  let responseFinished = false
  const finalize = () => {
    if (cleaned) return
    cleaned = true
    closeBackupDownloadTicket(ticket)
  }
  stream.once('close', finalize)
  res.once('finish', () => {
    responseFinished = true
    if (stream.closed) finalize()
  })
  res.once('close', () => {
    if (!responseFinished && !stream.closed) stream.destroy()
    if (stream.closed) finalize()
  })
  stream.once('error', error => {
    console.error('备份归档流式下载失败', error)
    if (!res.headersSent) res.status(500).json({ message: '备份归档读取失败' })
    else res.destroy(error)
    if (!stream.closed) stream.destroy()
  })
  stream.pipe(res)
}

function cleanupBackupOperationOrphans() {
  if (!fs.existsSync(backupsDir)) return
  const candidates = fs.readdirSync(backupsDir).filter(name =>
    /^\.(?:upload|export)-[A-Za-z0-9._-]+\.firstcare-review-backup\.tgz$/.test(name)
  )
  for (const name of candidates) {
    const target = path.join(backupsDir, name)
    const info = fs.lstatSync(target)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error(`备份临时路径类型不安全，拒绝启动：${target}`)
    }
    fs.unlinkSync(target)
  }
  if (candidates.length > 0) syncDirectoryPath(backupsDir)
}

function backupSnapshotSummary(snapshots = listBackupSnapshots()) {
  const totalBytes = snapshots.reduce((sum, item) => sum + (Number(item.size) || 0), 0)
  return {
    total: snapshots.length,
    manualCount: snapshots.filter(item => item.type === '手动备份').length,
    preRestoreCount: snapshots.filter(item => item.type === '恢复前').length,
    totalBytes,
    latestAt: snapshots[0]?.updatedAt || ''
  }
}

function backupSnapshotFresh(value = '', days = 7) {
  const timestamp = Date.parse(value || '')
  if (Number.isNaN(timestamp)) return false
  return Date.now() - timestamp <= Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000
}

async function backupSnapshotLaunchReadiness() {
  const snapshots = listBackupSnapshots()
  const summary = backupSnapshotSummary(snapshots)
  const fresh = backupSnapshotFresh(summary.latestAt, 7)
  let integrityVerified = false
  let integrityError = ''
  if (summary.total > 0 && fresh) {
    try {
      await inspectBackupArchive(snapshotArchivePath(snapshots[0].name))
      integrityVerified = true
    } catch (error) {
      integrityError = error.message || '最近快照完整性校验失败'
    }
  }
  const ok = summary.total > 0 && fresh && integrityVerified
  return {
    ok,
    summary,
    fresh,
    integrityVerified,
    latest: snapshots[0] || null,
    reason: ok
      ? ''
      : summary.total <= 0
        ? '缺少服务器本地备份快照'
        : !fresh
          ? '最近服务器本地备份快照已超过 7 天'
          : integrityError || '最近服务器本地备份快照未通过 manifest/hash 校验'
  }
}

function pruneBackupSnapshots(retentionDays = 30) {
  if (activeMutationCount !== 0) throw new Error('当前存在未完成的数据写操作，拒绝清理备份快照')
  const days = clampNumber(retentionDays, 1, 3650, 30)
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const snapshots = listBackupSnapshots()
  const removed = []

  for (const snapshot of snapshots) {
    const timestamp = Date.parse(snapshot.updatedAt)
    if (!Number.isNaN(timestamp) && timestamp < cutoff) {
      unlinkSnapshotFile(snapshot.name)
      removed.push(snapshot.name)
    }
  }

  return {
    retentionDays: days,
    removedCount: removed.length,
    removed,
    snapshots: listBackupSnapshots()
  }
}

function durableWriteJsonFile(filePath, value, mode = 0o600) {
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  let fd
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag, mode)
    fs.fchmodSync(fd, mode)
    fs.writeFileSync(fd, JSON.stringify(value, null, 2))
    fs.fsyncSync(fd)
    fs.renameSync(temporary, filePath)
    syncDirectoryPath(directory)
  } finally {
    closeStoreDescriptor(fd)
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    } catch {}
  }
}

function durableRemoveRegularFile(filePath) {
  try {
    const info = fs.lstatSync(filePath)
    if (!info.isFile() || info.nlink !== 1) throw new Error(`拒绝删除非单链接普通事务文件：${filePath}`)
    fs.unlinkSync(filePath)
    syncDirectoryPath(path.dirname(filePath))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function assertRestorePath(filePath, prefix) {
  const resolved = path.resolve(filePath)
  const expectedParent = path.resolve(dataDir)
  if (path.dirname(resolved) !== expectedParent || !path.basename(resolved).startsWith(prefix)) {
    throw new Error(`恢复事务路径超出精确白名单：${filePath}`)
  }
  return resolved
}

function removeFlatAttachmentDirectory(directory) {
  if (!fs.existsSync(directory)) return
  const root = fs.lstatSync(directory)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(`附件事务目录类型不安全：${directory}`)
  for (const name of fs.readdirSync(directory)) {
    if (!safeStoredName(name) && !name.startsWith('.restore-attachment-')) {
      throw new Error(`附件事务目录包含非法名称：${name}`)
    }
    const filePath = path.join(directory, name)
    const info = fs.lstatSync(filePath)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error(`附件事务目录包含非单链接普通文件：${name}`)
    }
    fs.unlinkSync(filePath)
  }
  syncDirectoryPath(directory)
  fs.rmdirSync(directory)
  syncDirectoryPath(path.dirname(directory))
}

function removeRestoreExtractionDirectory(directory) {
  if (!fs.existsSync(directory)) return
  assertRestorePath(directory, '.restore-extract-')
  const root = fs.lstatSync(directory)
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o777) !== 0o700) {
    throw new Error(`恢复解包目录类型或权限不安全：${directory}`)
  }
  const allowed = new Set(['manifest.json', 'store.json', 'files'])
  for (const name of fs.readdirSync(directory)) {
    if (!allowed.has(name)) throw new Error(`恢复解包目录包含未知条目：${name}`)
    const target = path.join(directory, name)
    if (name === 'files') {
      removeFlatAttachmentDirectory(target)
      continue
    }
    const info = fs.lstatSync(target)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error(`恢复解包元数据不是单链接普通文件：${name}`)
    }
    fs.unlinkSync(target)
  }
  syncDirectoryPath(directory)
  fs.rmdirSync(directory)
  syncDirectoryPath(dataDir)
}

function cleanupUnjournaledRestoreOrphans() {
  if (fs.existsSync(restoreJournalFile) || !fs.existsSync(dataDir)) return
  for (const name of fs.readdirSync(dataDir)) {
    const target = path.join(dataDir, name)
    if (/^\.restore-extract-[A-Za-z0-9-]+$/.test(name)) {
      removeRestoreExtractionDirectory(target)
    } else if (/^\.restore-stage-[A-Za-z0-9-]+$/.test(name)) {
      removeFlatAttachmentDirectory(target)
    } else if (/^\.restore-previous-[A-Za-z0-9-]+$/.test(name)) {
      // journal 丢失时无法证明 previous 是可删除候选还是唯一旧附件，必须人工处理。
      throw new Error(`发现无 journal 的恢复回滚目录，拒绝自动删除：${target}`)
    }
  }
}

function validateRestoredAttachmentReferences(nextProposals, preparedFiles) {
  const actual = new Set(preparedFiles.map(file => file.name))
  const referenced = []
  for (const proposal of nextProposals) {
    for (const file of proposal.files || []) {
      const storedName = file.storedName
      if (!storedName) continue
      if (!safeStoredName(storedName)) throw new Error('恢复数据包含不安全附件存储名')
      referenced.push(storedName)
    }
  }
  if (new Set(referenced).size !== referenced.length) throw new Error('恢复数据存在重复附件实体引用')
  const referenceSet = new Set(referenced)
  const missing = [...referenceSet].filter(name => !actual.has(name))
  const orphaned = [...actual].filter(name => !referenceSet.has(name))
  if (missing.length || orphaned.length) {
    throw new Error(`恢复数据附件引用不一致：missing=${missing.slice(0, 5)} orphaned=${orphaned.slice(0, 5)}`)
  }
}

function flatAttachmentRecords(directory) {
  if (!fs.existsSync(directory)) return []
  const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | noFollowFlag
  const rootFd = fs.openSync(directory, flags)
  try {
    const root = fs.fstatSync(rootFd)
    if (!root.isDirectory()) throw new Error(`附件目录类型不安全：${directory}`)
    // Linux 生产通过固定 dirfd 避免中间路径 TOCTOU；macOS 测试环境没有 /proc，
    // 退回完整路径并用根目录及叶子 inode 的前后快照失败关闭。
    const rootPath = process.platform === 'linux' ? `/proc/self/fd/${rootFd}` : directory
    const names = fs.readdirSync(rootPath).sort(compareUtf8Names)
    const records = names.map(name => {
      if (!safeStoredName(name)) throw new Error(`附件目录包含非法名称：${name}`)
      const childPath = path.join(rootPath, name)
      const pathBefore = fs.lstatSync(childPath)
      const descriptor = fs.openSync(childPath, fs.constants.O_RDONLY | noFollowFlag)
      try {
        const before = fs.fstatSync(descriptor)
        if (!before.isFile() || before.nlink !== 1 || !sameFileIdentity(pathBefore, before)) {
          throw new Error(`附件必须是未替换的单链接普通文件：${name}`)
        }
        const hash = crypto.createHash('sha256')
        const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, before.size)))
        let position = 0
        while (position < before.size) {
          const length = Math.min(chunk.length, before.size - position)
          const bytesRead = fs.readSync(descriptor, chunk, 0, length, position)
          if (bytesRead <= 0) throw new Error(`附件读取遇到意外 EOF：${name}`)
          hash.update(chunk.subarray(0, bytesRead))
          position += bytesRead
        }
        const after = fs.fstatSync(descriptor)
        const pathAfter = fs.lstatSync(childPath)
        if (!sameFileIdentity(before, after) || !sameFileIdentity(after, pathAfter) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          throw new Error(`附件在读取期间发生变化：${name}`)
        }
        return { name, size: before.size, sha256: hash.digest('hex') }
      } finally {
        closeStoreDescriptor(descriptor)
      }
    })
    const afterRoot = fs.fstatSync(rootFd)
    if (!sameFileIdentity(root, afterRoot) || JSON.stringify(names) !== JSON.stringify(fs.readdirSync(rootPath).sort(compareUtf8Names))) {
      throw new Error(`附件集合在读取期间发生变化：${directory}`)
    }
    return records
  } finally {
    closeStoreDescriptor(rootFd)
  }
}

function assertFlatAttachmentRecords(directory, expected = []) {
  const actual = flatAttachmentRecords(directory)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`附件事务目录与持久化基线不一致：${directory}`)
  }
}

function storeDiskSha256() {
  return sha256Hex(fs.readFileSync(storeFile))
}

function recoverInterruptedBackupRestore() {
  if (!fs.existsSync(restoreJournalFile)) return
  const journalInfo = fs.lstatSync(restoreJournalFile)
  if (!journalInfo.isFile() || journalInfo.isSymbolicLink() || journalInfo.nlink !== 1 || journalInfo.size > 64 * 1024) {
    throw new Error('备份恢复 journal 不安全，拒绝启动')
  }
  const journal = JSON.parse(fs.readFileSync(restoreJournalFile, 'utf8'))
  const stageDir = assertRestorePath(journal.stageDir, '.restore-stage-')
  const rollbackDir = assertRestorePath(journal.rollbackDir, '.restore-previous-')
  const diskHash = storeDiskSha256()
  if (diskHash === journal.targetStoreSha256) {
    if (!fs.existsSync(filesDir) || !fs.lstatSync(filesDir).isDirectory()) {
      if (!fs.existsSync(stageDir)) throw new Error('恢复事务已提交 store 但附件候选丢失')
      fs.renameSync(stageDir, filesDir)
      syncDirectoryPath(dataDir)
    }
    assertFlatAttachmentRecords(filesDir, journal.targetFiles)
    removeFlatAttachmentDirectory(rollbackDir)
    removeFlatAttachmentDirectory(stageDir)
    durableRemoveRegularFile(restoreJournalFile)
    return
  }
  if (diskHash !== journal.previousStoreSha256) {
    throw new Error('恢复事务 store 哈希不属于提交前或提交后状态，拒绝自动处理')
  }
  if (fs.existsSync(rollbackDir)) {
    if (fs.existsSync(filesDir)) removeFlatAttachmentDirectory(filesDir)
    fs.renameSync(rollbackDir, filesDir)
    syncDirectoryPath(dataDir)
  } else if (journal.previousFilesDirectoryExists !== true && fs.existsSync(filesDir)) {
    removeFlatAttachmentDirectory(filesDir)
  }
  if (journal.previousFilesDirectoryExists === true || fs.existsSync(filesDir)) {
    assertFlatAttachmentRecords(filesDir, journal.previousFiles)
  }
  removeFlatAttachmentDirectory(stageDir)
  durableRemoveRegularFile(restoreJournalFile)
}

function installRestoredStoreState(nextStore) {
  users = nextStore.users
  proposals = nextStore.proposals
  logs = nextStore.logs
  rules = nextStore.rules
  knowledgeEntries = nextStore.knowledgeEntries
  botProfiles = nextStore.botProfiles
  reminderConfig = nextStore.reminderConfig
  rolePermissions = nextStore.rolePermissions
  systemConfig = nextStore.systemConfig
  tokens.clear()
  // 认证限流状态独立持久化，不随业务数据恢复清空。
}

function compareUtf8Names(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'))
}

function promoteRestoredAttachments(extractionDir, stageDir, targetFiles) {
  const extraction = assertRestorePath(extractionDir, '.restore-extract-')
  const stage = assertRestorePath(stageDir, '.restore-stage-')
  const root = fs.lstatSync(extraction)
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o777) !== 0o700) {
    throw new Error('恢复解包目录类型或权限不安全')
  }
  const entries = fs.readdirSync(extraction).sort()
  if (JSON.stringify(entries) !== JSON.stringify(['files', 'manifest.json', 'store.json'])) {
    throw new Error('恢复解包目录不符合固定布局')
  }
  const extractedFiles = path.join(extraction, 'files')
  assertFlatAttachmentRecords(extractedFiles, targetFiles)
  for (const name of ['manifest.json', 'store.json']) {
    const metadataPath = path.join(extraction, name)
    const info = fs.lstatSync(metadataPath)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) {
      throw new Error(`恢复解包元数据不安全：${name}`)
    }
    fs.unlinkSync(metadataPath)
  }
  syncDirectoryPath(extraction)
  if (fs.existsSync(stage)) throw new Error('恢复附件候选目录已存在')
  fs.renameSync(extractedFiles, stage)
  syncDirectoryPath(extraction)
  syncDirectoryPath(dataDir)
  fs.rmdirSync(extraction)
  syncDirectoryPath(dataDir)
  assertFlatAttachmentRecords(stage, targetFiles)
}

async function applyBackupArchive(inspected, req, options = {}) {
  const preview = backupArchivePreview(inspected)
  const restoredStore = inspected.store || {}

  const nextUsers = restoredStore.users.map(normalizeUser)
  const nextBotProfiles = (Array.isArray(restoredStore.botProfiles) && restoredStore.botProfiles.length > 0
    ? restoredStore.botProfiles
    : defaultBotProfiles()).map(normalizeBotProfile).map(profile => ({
      ...profile,
      standardsVerifiedBy: '',
      standardsVerifiedAt: '',
      definitionVerifiedBy: '',
      definitionVerifiedAt: '',
      definitionVerifiedHash: '',
      status: '停用'
    }))
  const nextReminderConfig = normalizeReminderConfig(restoredStore.reminderConfig || defaultReminderConfig())
  const nextRolePermissions = normalizeRolePermissions(restoredStore.rolePermissions || defaultRolePermissions, { strict: true })
  const nextSystemConfig = normalizeSystemConfig(restoredStore.systemConfig || defaultSystemConfig())
  const nextProposals = ensureUniqueProposalIds(
    (Array.isArray(restoredStore.proposals) ? restoredStore.proposals : [])
      .map(item => normalizeProposal(item, nextBotProfiles))
  )
  const nextRules = (Array.isArray(restoredStore.rules) ? restoredStore.rules : defaultRules()).map(rule => ({
    ...rule,
    status: '停用',
    basisVerifiedBy: '',
    basisVerifiedAt: ''
  }))
  const nextKnowledgeEntries = (Array.isArray(restoredStore.knowledgeEntries) ? restoredStore.knowledgeEntries : [])
    .map(normalizeKnowledgeEntry)
    .map(entry => ({
      ...entry,
      status: '停用',
      sourceVerifiedBy: '',
      sourceVerifiedAt: ''
    }))
  const targetFiles = inspected.files
    .map(file => ({ name: file.name, size: file.size, sha256: file.sha256 }))
    .sort((left, right) => compareUtf8Names(left.name, right.name))
  validateRestoredAttachmentReferences(nextProposals, targetFiles)

  // 在创建任何恢复前快照之前，先对归档中的全部审计做与正常写入同源的
  // 单条规范化、条数/集合字节上限与 pretty JSON 实际字节余量校验。
  // 这使旧归档中的超长、控制字符或近 12MiB 日志不能重新进入运行态。
  const normalizedRestoredStore = prepareStoreValue({
    users: nextUsers,
    proposals: nextProposals,
    logs: Array.isArray(restoredStore.logs) ? restoredStore.logs : [],
    rules: nextRules,
    knowledgeEntries: nextKnowledgeEntries,
    botProfiles: nextBotProfiles,
    reminderConfig: nextReminderConfig,
    rolePermissions: nextRolePermissions,
    systemConfig: nextSystemConfig
  })

  const currentAttachmentBytes = attachmentStorageUsage().bytes
  assertBackupRestoreDiskHeadroom(currentAttachmentBytes + backupRestoreReserveBytes, '创建恢复前快照')
  const preRestoreBackupPath = await writePreRestoreBackup(options.signal)
  const preRestoreBackup = path.basename(preRestoreBackupPath)
  assertBackupRestoreDiskHeadroom(backupRestoreReserveBytes, '提交 store 与附件切换前')
  const actor = req.user?.name || '管理员'
  const restoreAuditId = `L${Date.now()}${crypto.randomBytes(3).toString('hex')}`
  const restoreAudit = normalizeAuditLog({
    id: restoreAuditId,
    actor,
    action: options.action || '恢复系统数据备份',
    category: '系统配置',
    result: '成功',
    metadata: {
      ...preview,
      preRestoreBackup,
      ...(options.metadata || {})
    },
    at: nowText()
  })

  // 恢复审计本身也必须纳入同一字节边界，且不能被淘汰。
  const nextStore = prepareStoreValue({
    ...normalizedRestoredStore,
    logs: [restoreAudit, ...normalizedRestoredStore.logs]
  }, { protectedLogIds: [restoreAuditId] })
  const nextStoreBuffer = canonicalStoreBuffer(nextStore)
  const transactionId = options.transactionId || `${Date.now()}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  const extractionDir = assertRestorePath(options.extractionDir, '.restore-extract-')
  const stageDir = assertRestorePath(path.join(dataDir, `.restore-stage-${transactionId}`), '.restore-stage-')
  const rollbackDir = assertRestorePath(path.join(dataDir, `.restore-previous-${transactionId}`), '.restore-previous-')
  const previousStoreSha256 = storeDiskSha256()
  const targetStoreSha256 = sha256Hex(nextStoreBuffer)
  const previousFilesDirectoryExists = fs.existsSync(filesDir)
  const previousFiles = flatAttachmentRecords(filesDir)
  promoteRestoredAttachments(extractionDir, stageDir, targetFiles)
  durableWriteJsonFile(restoreJournalFile, {
    schema: 'first-service-review-restore-transaction-v1',
    status: 'prepared',
    transactionId,
    stageDir,
    rollbackDir,
    previousStoreSha256,
    targetStoreSha256,
    previousFilesDirectoryExists,
    previousFiles,
    targetFiles,
    preRestoreBackup
  })

  let committed = false
  try {
    if (fs.existsSync(filesDir)) fs.renameSync(filesDir, rollbackDir)
    fs.renameSync(stageDir, filesDir)
    syncDirectoryPath(dataDir)
    assertFlatAttachmentRecords(filesDir, targetFiles)
    try {
      persistStoreAtomically(nextStore)
      committed = true
    } catch (error) {
      committed = storeDiskSha256() === targetStoreSha256
      if (!committed) throw error
    }
    installRestoredStoreState(nextStore)
    assertFlatAttachmentRecords(filesDir, targetFiles)
    removeFlatAttachmentDirectory(rollbackDir)
    durableRemoveRegularFile(restoreJournalFile)
  } catch (error) {
    if (!committed) {
      recoverInterruptedBackupRestore()
      throw error
    }
    // store 已原子提交后禁止伪装成普通 400 并继续接受写入。
    // 保留 durable journal，进程立即 fail-closed，由下次启动恢复完成附件/清理收敛。
    restoreRecoveryRequired = true
    const committedError = new Error(`备份恢复已提交，但收尾校验失败，服务已关闭写入并待安全重启：${error.message}`)
    committedError.restoreCommitted = true
    setImmediate(() => gracefulShutdown('RESTORE_RECOVERY'))
    throw committedError
  }

  return { preview, preRestoreBackup }
}

async function restoreArchiveTransaction(archivePath, req, options = {}) {
  if (activeMutationCount !== 0) throw new Error('当前存在未完成的数据写操作，请稍后再恢复')
  if (fs.existsSync(restoreJournalFile)) throw new Error('存在尚未收敛的恢复事务，拒绝启动新恢复')
  assertBackupRestoreDiskHeadroom(backupRestoreConfiguredMinimumFreeBytes, '读取归档前')
  const envelope = await inspectBackupArchive(archivePath, '', options.signal)
  const currentAttachmentBytes = attachmentStorageUsage().bytes
  assertBackupRestoreDiskHeadroom(
    envelope.manifest.totals.fileBytes + currentAttachmentBytes + backupRestoreReserveBytes,
    '解包与恢复前快照并存'
  )
  const transactionId = `${Date.now()}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  const extractionDir = assertRestorePath(path.join(dataDir, `.restore-extract-${transactionId}`), '.restore-extract-')
  fs.mkdirSync(extractionDir, { mode: 0o700 })
  const extractionInfo = fs.lstatSync(extractionDir)
  if (!extractionInfo.isDirectory() || extractionInfo.isSymbolicLink() || (extractionInfo.mode & 0o777) !== 0o700) {
    throw new Error('无法创建安全恢复解包目录')
  }
  syncDirectoryPath(dataDir)
  try {
    const inspected = await inspectBackupArchive(archivePath, extractionDir, options.signal)
    if (
      inspected.manifest.store.sha256 !== envelope.manifest.store.sha256 ||
      JSON.stringify(inspected.files) !== JSON.stringify(envelope.files)
    ) {
      throw new Error('备份归档在预检与解包之间发生内容漂移')
    }
    return await applyBackupArchive(inspected, req, {
      ...options,
      transactionId,
      extractionDir,
      signal: options.signal
    })
  } finally {
    // durable journal 存在时，候选/旧附件目录由启动恢复状态机独占处理。
    if (!fs.existsSync(restoreJournalFile)) cleanupUnjournaledRestoreOrphans()
  }
}

ensureBackupDirectory()
cleanupBackupOperationOrphans()
recoverInterruptedBackupRestore()
cleanupUnjournaledRestoreOrphans()
const store = loadStore()
users = store.users.map(normalizeUser)
proposals = ensureUniqueProposalIds(store.proposals.map(normalizeProposal))
logs = boundedAuditLogs(store.logs)
rules = store.rules
knowledgeEntries = (store.knowledgeEntries || []).map(normalizeKnowledgeEntry)
botProfiles = (store.botProfiles || defaultBotProfiles()).map(normalizeBotProfile)
reminderConfig = normalizeReminderConfig(store.reminderConfig || defaultReminderConfig())
rolePermissions = normalizeRolePermissions(store.rolePermissions || defaultRolePermissions, { strict: true })
systemConfig = normalizeSystemConfig(store.systemConfig || defaultSystemConfig())
// 启动只在内存中完成兼容性归一化，存量 store 必须保持字节不变。
if (process.env.NODE_ENV === 'production') {
  const productionAiRuntime = aiRuntimeConfig(systemConfig)
  if (productionAiRuntime.boundaryError || !productionAiRuntime.gatewayConfigured) {
    throw new Error(`生产 Hermes Profile 网关配置未通过失败关闭校验：${productionAiRuntime.boundaryError || '网关认证密钥未配置'}`)
  }
}

function proposalListItem(item) {
  const manualReview = normalizeManualReview(item.manualReview)
  const hasManualReview = hasManualReviewContent(manualReview)
  const executionRecord = normalizeExecutionRecord(item.executionRecord)
  const reminders = normalizeReminders(item.reminders)
  const exportEvents = normalizeExportEvents(item.exportEvents)
  const files = item.files || []
  const attachmentSummary = {
    total: files.length,
    parsed: files.filter(file => file.extractionStatus === '已解析').length,
    failed: files.filter(file => file.extractionStatus === '解析失败').length,
    unsupported: files.filter(file => file.extractionStatus === '不支持').length,
    pending: files.filter(file => ['待解析', '未解析'].includes(file.extractionStatus || '未解析')).length,
    historical: files.filter(file => file.extractionStatus === '历史元数据').length,
    pdfTableFiles: files.filter(file => file.extractionType === 'pdf-table').length,
    pdfTableCount: files.reduce((sum, file) => sum + (Number(file.pdfTableCount) || 0), 0),
    textChars: files.reduce((sum, file) => sum + (Number(file.wordCount) || 0), 0)
  }
  const sentReminders = reminders.filter(reminder => reminder.source !== 'auto' && reminder.deliveryStatus === '用户登记已沟通')
  const reminderDrafts = reminders.filter(reminder => reminder.source === 'auto')
  const lastReminder = sentReminders[0] || null
  const lastReminderDraft = reminderDrafts[0] || null
  const lastExport = exportEvents[0] || null
  const latestAiTrace = Array.isArray(item.aiReviewTrace) ? item.aiReviewTrace[0] || null : null
  const reminderAdvice = reminderSuggestion(item)
  const overdueReminder = overdueReminderSummary({
    ...item,
    manualReview,
    executionRecord
  })
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    submitter: item.submitter,
    submitterUsername: item.submitterUsername || '',
    robot: item.robot,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    avgScore: Number.isFinite(item.summary?.avgScore) ? item.summary.avgScore : null,
    result: item.summary?.result || '待审核',
    highRiskCount: item.summary?.riskCount?.high || 0,
    fileCount: files.length,
    attachmentSummary,
    hasManualReview,
    manualReviewStatus: hasManualReview ? '已复核' : '待复核',
    manualReviewConclusion: manualReview.conclusion || '',
    manualReviewer: manualReview.reviewer || '',
    manualReviewedAt: manualReview.reviewedAt || '',
    signOffStatus: executionRecord.signOff.status,
    archiveStatus: executionRecord.archive.status,
    reminderCount: sentReminders.length,
    reminderDraftCount: reminderDrafts.length,
    exportCount: exportEvents.length,
    lastExportType: lastExport?.type || '',
    lastExportAt: lastExport?.at || '',
    lastExportSource: lastExport?.source || '',
    latestAiTrace: latestAiTrace ? {
      id: latestAiTrace.id || '',
      provider: latestAiTrace.provider || item.aiProvider || '',
      model: latestAiTrace.model || item.aiModel || '',
      mode: latestAiTrace.mode || '',
      status: latestAiTrace.status || '',
      fallback: latestAiTrace.fallback === true,
      durationMs: Number(latestAiTrace.durationMs) || 0,
      profileCount: Number(latestAiTrace.profileCount) || 0,
      opinionCount: Number(latestAiTrace.opinionCount) || 0,
      result: latestAiTrace.result || '',
      error: latestAiTrace.error || '',
      at: latestAiTrace.at || ''
    } : null,
    aiTraceCount: Array.isArray(item.aiReviewTrace) ? item.aiReviewTrace.length : 0,
    lastReminderStage: lastReminder?.stage || '',
    lastReminderChannel: lastReminder?.channel || '',
    lastReminderNote: lastReminder?.note || '',
    lastReminderBy: lastReminder?.remindedBy || '',
    lastReminderAt: lastReminder?.remindedAt || '',
    lastReminderSource: lastReminder?.source || '',
    lastReminderDeliveryStatus: lastReminder?.deliveryStatus || '',
    lastReminderDraftAt: lastReminderDraft?.createdAt || '',
    recommendedReminderStage: reminderAdvice.stage,
    needsReminder: reminderAdvice.pending,
    overdueReminder
  }
}

function userListItem(user) {
  const usesDefaultPassword = ['admin123', 'First123456'].some(defaultPassword => verifyPassword(defaultPassword, user.passwordHash))
  const loginFailure = currentLoginFailure(user.username)
  const loginLocked = Boolean(loginFailure?.lockedUntil && loginFailure.lockedUntil > Date.now())
  const lastLoginTimestamp = parseTimeText(user.lastLoginAt)
  const inactiveLoginThresholdDays = systemConfig.inactiveLoginDays || defaultSystemConfig().inactiveLoginDays
  const inactiveDays = lastLoginTimestamp ? Math.max(0, Math.floor((Date.now() - lastLoginTimestamp) / (24 * 60 * 60 * 1000))) : null
  const loginRisk = !user.lastLoginAt ? '从未登录' : inactiveDays >= inactiveLoginThresholdDays ? '长期未登录' : ''
  const normalizedLastLoginIp = normalizeIp(user.lastLoginIp)
  const sameLoginIpAccounts = normalizedLastLoginIp
    ? users
      .filter(item => normalizeIp(item.lastLoginIp) === normalizedLastLoginIp)
      .map(item => ({ username: item.username, name: item.name }))
    : []
  const sameLoginIpAccountCount = sameLoginIpAccounts.length
  const sharedLoginIpAccountThreshold = systemConfig.sharedLoginIpAccountThreshold || defaultSystemConfig().sharedLoginIpAccountThreshold
  const trustedLoginIp = normalizeIpWhitelist(systemConfig.trustedLoginIps).includes(normalizedLastLoginIp)

  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    permissions: permissionsForRole(user.role),
    department: user.department,
    status: user.status,
    failedLoginCount: loginFailure?.count || 0,
    loginLocked,
    loginLockedUntil: loginLocked ? new Date(loginFailure.lockedUntil).toISOString() : '',
    mustChangePassword: shouldForcePasswordChange(user),
    usesDefaultPassword,
    passwordUpdatedAt: user.passwordUpdatedAt || '',
    lastLoginAt: user.lastLoginAt || '',
    lastLoginIp: normalizedLastLoginIp,
    sameLoginIpAccountCount,
    sameLoginIpAccounts,
    sharedLoginIpAccountThreshold,
    trustedLoginIp,
    inactiveDays,
    inactiveLoginThresholdDays,
    loginRisk,
    createdAt: user.createdAt
  }
}

function activeAdminCount(list = users, excludeUserId = '') {
  return list.filter(user => (
    user.id !== excludeUserId &&
    user.role === '管理员' &&
    user.status !== '停用'
  )).length
}

function revokeTokensByUsername(username = '') {
  const target = String(username || '').trim()
  if (!target) return

  for (const [token, session] of tokens.entries()) {
    if (session.username === target) tokens.delete(token)
  }
}

function revokeTokensByRoles(roles = [], excludeUsername = '') {
  const roleSet = new Set((Array.isArray(roles) ? roles : []).map(normalizeUserRole))
  const excluded = String(excludeUsername || '').trim()
  let revoked = 0

  if (roleSet.size === 0) return revoked

  for (const [token, session] of tokens.entries()) {
    if (session.username === excluded) continue
    const user = users.find(item => item.username === session.username)
    const role = normalizeUserRole(user?.role || session.role)
    if (roleSet.has(role)) {
      tokens.delete(token)
      revoked += 1
    }
  }

  return revoked
}

function knowledgeListItem(entry) {
  return {
    ...entry,
    profileName: profileNameById(entry.profileId),
    keywordCount: normalizeKeywords(entry.keywords).length
  }
}

function proposalProfileIds(proposal = {}) {
  const ids = new Set()
  for (const opinion of Array.isArray(proposal.opinions) ? proposal.opinions : []) {
    if (opinion?.profileId) ids.add(String(opinion.profileId))
  }
  const robot = String(proposal.robot || '').trim()
  for (const profile of orderedBotProfiles()) {
    if (robot && [profile.id, profile.name, profile.hermesName].filter(Boolean).includes(robot)) ids.add(profile.id)
  }
  return ids
}

function profileMetrics(profile) {
  const related = proposals.filter(item => proposalProfileIds(item).has(profile.id))
  const today = validBusinessDate(new Date())
  const todayTasks = related.filter(item => validBusinessDate(item.createdAt) === today).length
  const durations = related.flatMap(item => (
    Array.isArray(item.aiReviewTrace) ? item.aiReviewTrace : []
  )).flatMap(trace => {
    const traceProfiles = new Set([
      String(trace?.profileId || '').trim(),
      ...(Array.isArray(trace?.profileIds) ? trace.profileIds.map(value => String(value).trim()) : [])
    ].filter(Boolean))
    if (traceProfiles.size === 0 || !traceProfiles.has(profile.id)) return []
    const duration = Number(trace?.durationMs)
    return Number.isFinite(duration) && duration >= 0 ? [duration] : []
  })
  const totalAssignments = orderedBotProfiles().reduce(
    (sum, item) => sum + proposals.filter(proposal => proposalProfileIds(proposal).has(item.id)).length,
    0
  )
  return {
    totalTasks: related.length,
    todayTasks,
    avgSeconds: durations.length > 0
      ? Math.round((durations.reduce((sum, value) => sum + value, 0) / durations.length / 1000) * 10) / 10
      : null,
    pct: totalAssignments > 0 ? Math.round((related.length / totalAssignments) * 1000) / 10 : 0
  }
}

function profileListItem(profile) {
  const configuredEnabled = profile.status === '启用'
  const isActive = configuredEnabled && profileDefinitionIsVerified(profile)
  const agentConfigured = aiRuntimeConfig().agentConfigured === true
  const roleTag = profile.id === 'investment' && profile.canInitiate ? '立项牵头' : '专业审核'
  const metrics = profileMetrics(profile)
  return {
    ...profile,
    standardsVerified: profileStandardsAreVerified(profile),
    standardsVerifiedBy: profile.definitionVerifiedBy || profile.standardsVerifiedBy || '',
    standardsVerifiedAt: profile.definitionVerifiedAt || profile.standardsVerifiedAt || '',
    definitionVerified: profileDefinitionIsVerified(profile),
    definitionVerifiedBy: profile.definitionVerifiedBy || '',
    definitionVerifiedAt: profile.definitionVerifiedAt || '',
    definitionVerifiedHash: profile.definitionVerifiedHash || '',
    definitionCurrentHash: profileDefinitionHash(profile),
    standardsStatus: profileDefinitionIsVerified(profile) ? '完整 Profile 定义与正式依据已核验' : '待核验，不参与审核',
    status: configuredEnabled ? '启用' : '停用',
    online: false,
    onlineLabel: isActive
      ? agentConfigured ? '已启用且已核验' : '已核验，AI 推理未启用'
      : configuredEnabled ? '启用待核验' : '停用',
    tag: roleTag,
    domain: profile.scope,
    totalTasks: metrics.totalTasks,
    todayTasks: metrics.todayTasks,
    avgSeconds: metrics.avgSeconds,
    avgSecondsAvailable: metrics.avgSeconds !== null,
    pct: metrics.pct
  }
}

function validateBotProfileState(nextProfiles = []) {
  const ids = nextProfiles.map(profile => String(profile.id || '').trim())
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) return 'Profile ID 不能为空或重复'
  return ''
}

function profileWorkflowReadinessMessage() {
  const activeProfiles = activeBotProfiles()
  if (activeProfiles.length === 0) return ''
  const internalCount = activeProfiles.filter(profile => profile.internalEnabled !== false).length
  const marketReviewCount = activeProfiles.filter(profile => profile.id !== 'investment' && profile.marketEnabled !== false).length
  const hasMarketInitiator = activeProfiles.some(profile => (
    profile.id === 'investment' &&
    profile.marketEnabled !== false &&
    profile.canInitiate
  ))

  if (internalCount === 0) {
    return '至少需要保留 1 个内部运营审核机器人'
  }
  if (!hasMarketInitiator) {
    return '市场拓展方案至少需要保留 1 个立项牵头机器人'
  }
  if (marketReviewCount === 0) {
    return '市场拓展方案至少需要保留 1 个专业审核机器人'
  }
  return ''
}

const aiInferenceDisabledMessage = 'AI 推理凭据已安全停用，待供应商密钥完成轮换并以 0600 权限受控配置后再启用'

function aiReviewReadinessState(runtime = aiRuntimeConfig()) {
  const activeProfileCount = activeBotProfiles().length
  const profileMessage = activeProfileCount === 0
    ? '审核 Profile 尚未完成正式核验'
    : profileWorkflowReadinessMessage()
  const gatewayMessage = runtime.gatewayConfigured
    ? ''
    : 'Hermes Profile 网关认证未配置'
  const agentMessage = runtime.agentConfigured ? '' : aiInferenceDisabledMessage
  const issues = [profileMessage, gatewayMessage, agentMessage].filter(Boolean)
  const message = issues.length > 0
    ? `${issues.join('；')}；当前仅可保存待专业配置草稿，不会调用 AI 或生成评分/意见`
    : ''
  return {
    reviewReady: issues.length === 0,
    submissionMode: issues.length === 0 ? 'ai-review' : 'draft-only',
    message,
    activeProfileCount,
    profileWorkflowReady: !profileMessage,
    gatewayConfigured: runtime.gatewayConfigured === true,
    agentConfigured: runtime.agentConfigured === true,
    inferenceEnabled: runtime.agentConfigured === true
  }
}

const botProfileComparableFields = [
  ['name', '机器人名称'],
  ['hermesName', 'Hermes 名称'],
  ['scope', '审核范围'],
  ['standards', '作业标准'],
  ['output', '输出物'],
  ['status', '状态'],
  ['internalEnabled', '内部运营审核'],
  ['marketEnabled', '市场拓展审核'],
  ['canInitiate', '立项牵头']
]

function botProfileChangedFields(nextProfile = {}, currentProfile = {}) {
  return botProfileComparableFields
    .filter(([field]) => JSON.stringify(nextProfile[field]) !== JSON.stringify(currentProfile[field]))
    .map(([, label]) => label)
}

function parseImportedBotProfiles(payload = {}) {
  const sourceProfiles = Array.isArray(payload) ? payload : payload.profiles
  if (!Array.isArray(sourceProfiles)) throw new Error('导入文件缺少 profiles 数组')

  const expectedIds = baseBotProfiles.map(profile => profile.id)
  const sourceById = new Map(sourceProfiles.map(profile => [String(profile?.id || '').trim(), profile]))
  if (sourceProfiles.length !== expectedIds.length || sourceById.size !== expectedIds.length || expectedIds.some(id => !sourceById.has(id))) {
    throw new Error(`导入文件必须完整包含 ${expectedIds.length} 个固定专业 Profile`)
  }

  const importedAt = nowText()
  const profiles = baseBotProfiles.map((fallback, index) => {
    const source = sourceById.get(fallback.id) || {}
    const name = String(source.name || '').trim()
    const standards = cloneProfileStandards(source.standards)
    if (name.length < 2) throw new Error(`${fallback.code} 机器人名称不能为空且不少于2个字符`)
    if (standards.length === 0) throw new Error(`${fallback.code} 请至少保留 1 条作业标准`)
    return normalizeBotProfile({
      id: fallback.id,
      code: fallback.code,
      name,
      hermesName: String(source.hermesName || fallback.hermesName).trim(),
      scope: String(source.scope || '').trim(),
      standards,
      standardsVerifiedBy: '',
      standardsVerifiedAt: '',
      definitionVerifiedBy: '',
      definitionVerifiedAt: '',
      definitionVerifiedHash: '',
      output: String(source.output || '').trim(),
      status: '停用',
      internalEnabled: source.internalEnabled !== false,
      marketEnabled: source.marketEnabled !== false,
      canInitiate: fallback.id === 'investment' && source.canInitiate !== false,
      sortOrder: index + 1,
      updatedAt: importedAt
    }, index)
  })

  const validationMessage = validateBotProfileState(profiles)
  if (validationMessage) throw new Error(validationMessage)
  return profiles
}

function botProfileImportPreview(profiles = []) {
  const activeProfiles = profiles.filter(profile => profile.status !== '停用')
  const currentById = new Map(orderedBotProfiles().map(profile => [profile.id, profile]))
  const changes = profiles.map(profile => {
    const current = currentById.get(profile.id) || {}
    const changedFields = botProfileChangedFields(profile, current)
    return {
      id: profile.id,
      code: profile.code,
      name: profile.name,
      changedFields
    }
  }).filter(profile => profile.changedFields.length > 0)

  return {
    profileCount: profiles.length,
    enabledCount: activeProfiles.length,
    internalEnabledCount: activeProfiles.filter(profile => profile.internalEnabled !== false).length,
    marketEnabledCount: activeProfiles.filter(profile => profile.marketEnabled !== false).length,
    initiatorName: activeProfiles.find(profile => profile.id === 'investment' && profile.canInitiate)?.name || '',
    changedProfileCount: changes.length,
    changes,
    profiles: profiles.map(profile => ({
      id: profile.id,
      code: profile.code,
      name: profile.name,
      hermesName: profile.hermesName,
      status: profile.status
    }))
  }
}

function latestHermesProfileSync() {
  const latest = logs.find(log => log.action === '同步 Hermes 云端 Profile' && log.result === '成功')
  return latest ? {
    actor: latest.actor || '',
    at: latest.at || '',
    remoteCount: latest.metadata?.remoteCount || 0,
    changedProfileCount: latest.metadata?.changedProfileCount || 0,
    changes: latest.metadata?.changes || []
  } : null
}

function latestHermesProfileImport() {
  const latest = logs.find(log => String(log.action || '').startsWith('导入 Hermes Profile 配置 ') && log.result === '成功')
  return latest ? {
    actor: latest.actor || '',
    at: latest.at || '',
    profileCount: latest.metadata?.profileCount || 0,
    changedProfileCount: latest.metadata?.changedProfileCount || 0,
    changes: latest.metadata?.changes || []
  } : null
}

function latestHermesProfileManualEdit() {
  const latest = logs.find(log => String(log.action || '').startsWith('更新审核机器人《') && log.result === '成功')
  return latest ? {
    actor: latest.actor || '',
    at: latest.at || '',
    profileId: latest.metadata?.profileId || '',
    profileCode: latest.metadata?.profileCode || '',
    profileName: latest.metadata?.profileName || '',
    changedFields: latest.metadata?.changedFields || []
  } : null
}

function latestHermesProfileStatusCheck() {
  const latest = logs.find(log => log.action === '检查 Hermes Profile 接入状态')
  return latest ? {
    actor: latest.actor || '',
    at: latest.at || '',
    result: latest.result || '',
    checkedAt: latest.metadata?.checkedAt || latest.at || '',
    provider: latest.metadata?.provider || '',
    model: latest.metadata?.model || '',
    webCount: latest.metadata?.webCount || 0,
    remoteCount: latest.metadata?.remoteCount || 0,
    matchedCount: latest.metadata?.matchedCount || 0,
    missingCount: latest.metadata?.missingCount || 0,
    driftCount: latest.metadata?.driftCount || 0,
    health: latest.metadata?.health || null,
    healthError: latest.metadata?.healthError || '',
    missingProfiles: latest.metadata?.missingProfiles || [],
    driftProfiles: latest.metadata?.driftProfiles || [],
    message: latest.metadata?.message || ''
  } : null
}

function hermesProfileCheckFresh(check = null, hours = 24) {
  const timestamp = Date.parse(check?.checkedAt || check?.at || '')
  if (Number.isNaN(timestamp)) return false
  return Date.now() - timestamp <= Math.max(1, Number(hours) || 24) * 60 * 60 * 1000
}

function hermesProfileLaunchReadiness() {
  const latest = latestHermesProfileStatusCheck()
  const fresh = hermesProfileCheckFresh(latest, 24)
  const webCount = Number(latest?.webCount) || 0
  const matchedCount = Number(latest?.matchedCount) || 0
  const missingCount = Number(latest?.missingCount) || 0
  const driftCount = Number(latest?.driftCount) || 0
  const approvedProfiles = orderedBotProfiles().filter(profile => profile.status === '启用' && profileDefinitionIsVerified(profile))
  const approvalComplete = approvedProfiles.length === baseBotProfiles.length
  const ok = Boolean(
    latest &&
    latest.result === '成功' &&
    fresh &&
    webCount > 0 &&
    matchedCount === webCount &&
    missingCount === 0 &&
    driftCount === 0 &&
    approvalComplete &&
    !profileWorkflowReadinessMessage()
  )
  return {
    ok,
    latest,
    fresh,
    approvedProfileCount: approvedProfiles.length,
    requiredApprovedProfileCount: baseBotProfiles.length,
    reason: ok
      ? ''
      : !approvalComplete
        ? `完整 Profile 定义仅审批 ${approvedProfiles.length}/${baseBotProfiles.length} 个`
        : profileWorkflowReadinessMessage()
          ? profileWorkflowReadinessMessage()
          : !latest
        ? '缺少最近 Hermes Profile 接入检查记录'
        : latest.result !== '成功'
          ? latest.message || `最近 Hermes Profile 接入检查结果为 ${latest.result || '未记录'}`
          : !fresh
            ? '最近 Hermes Profile 接入检查已超过 24 小时'
            : webCount <= 0
              ? '网页 Profile 数量未记录'
              : matchedCount !== webCount
                ? `Hermes Profile 仅匹配 ${matchedCount}/${webCount} 个`
                : missingCount > 0
                  ? `Hermes Profile 缺失 ${missingCount} 个`
                  : driftCount > 0
                    ? `Hermes Profile 存在 ${driftCount} 个待同步差异`
                    : 'Hermes Profile 接入未通过上线要求'
  }
}

function latestAiAdapterTest() {
  const latest = logs.find(log => log.action === '测试 AI 审核适配器')
  if (!latest) return null
  const metadata = latest.metadata || {}
  return {
    ok: latest.result === '成功' || latest.result === '警告',
    result: latest.result || '',
    actor: latest.actor || '',
    at: latest.at || '',
    runtime: {
      provider: metadata.provider || '',
      model: metadata.model || '',
      adapterReady: metadata.adapterReady === true
    },
    durationMs: metadata.durationMs ?? null,
    mode: metadata.mode || '',
    modeName: metadata.modeName || aiTraceModeName(metadata.mode || ''),
    engine: metadata.engine || '',
    agentProvider: metadata.agentProvider || '',
    agentModel: metadata.agentModel || '',
    fallback: metadata.fallback === true || latest.result === '警告',
    error: metadata.error || '',
    message: latest.result === '失败'
      ? metadata.error || 'AI 适配器探测失败'
      : latest.result === '警告'
        ? '最近 AI 适配器探测触发回退。'
        : '最近 AI 适配器探测通过。'
  }
}

function aiAdapterTestFresh(test = null, hours = 24) {
  const timestamp = Date.parse(test?.at || '')
  if (Number.isNaN(timestamp)) return false
  return Date.now() - timestamp <= Math.max(1, Number(hours) || 24) * 60 * 60 * 1000
}

function aiLaunchReadiness() {
  const runtime = aiRuntimeConfig()
  const latest = latestAiAdapterTest()
  const fresh = aiAdapterTestFresh(latest, 24)
  const ok = Boolean(
    runtime.agentConfigured &&
    latest && latest.ok && fresh && latest.mode === 'hermes-agent' && latest.fallback !== true
  )
  return {
    ok,
    gatewayConfigured: runtime.gatewayConfigured,
    agentConfigured: runtime.agentConfigured,
    latest,
    fresh,
    reason: ok
      ? ''
      : !runtime.agentConfigured
        ? aiInferenceDisabledMessage
        : !latest
        ? '缺少最近 AI 连接实测记录'
        : latest.ok === false
          ? latest.error || latest.message || '最近 AI 连接实测失败'
          : !fresh
            ? '最近 AI 连接实测已超过 24 小时'
            : latest.mode !== 'hermes-agent'
              ? `最近 AI 连接实测模式为 ${latest.modeName || latest.mode || '未记录'}`
              : latest.fallback === true
                ? '最近 AI 连接实测发生回退'
                : '最近 AI 连接实测未通过上线要求'
  }
}

function hermesProfileConfigHistory(limit = 12) {
  return logs
    .filter(log => (
      log.action === '检查 Hermes Profile 接入状态' ||
      log.action === '同步 Hermes 云端 Profile' ||
      log.action === '生成 Hermes 云端同步预览' ||
      log.action === '校验 Hermes Profile 时间线审计 JSON' ||
      String(log.action || '').startsWith('导入 Hermes Profile 配置 ') ||
      String(log.action || '').startsWith('更新审核机器人《')
    ))
    .slice(0, limit)
    .map(log => {
      const isSync = log.action === '同步 Hermes 云端 Profile'
      const isStatusCheck = log.action === '检查 Hermes Profile 接入状态'
      const isPreview = log.action === '生成 Hermes 云端同步预览'
      const isIntercept = isSync && log.result === '拦截'
      const isAuditVerification = log.action === '校验 Hermes Profile 时间线审计 JSON'
      const isImport = String(log.action || '').startsWith('导入 Hermes Profile 配置 ')
      return {
        id: log.id,
        type: isAuditVerification ? '审计校验' : isStatusCheck ? '接入检查' : isPreview ? '同步预览' : isIntercept ? '同步拦截' : isSync ? '云端同步' : isImport ? 'JSON 导入' : '人工编辑',
        result: log.result || '',
        actor: log.actor || '',
        at: log.at || '',
        action: log.action || '',
        auditLogStatus: isAuditVerification ? (log.result === '拦截' ? '已拦截' : '已记录') : '',
        filename: log.metadata?.filename || '',
        reason: log.metadata?.reason || '',
        previewTokenFingerprint: log.metadata?.previewTokenFingerprint || '',
        expectedHash: log.metadata?.expectedHash || '',
        actualHash: log.metadata?.actualHash || '',
        hashMismatch: log.metadata?.hashMismatch === true || Boolean(log.metadata?.expectedHash && log.metadata?.actualHash && log.metadata.expectedHash !== log.metadata.actualHash),
        hashStatus: log.metadata?.hashStatus || hashStatusText(log.metadata?.expectedHash, log.metadata?.actualHash),
        verifiedCount: log.metadata?.count || 0,
        filterSummary: log.metadata?.filterSummary || '',
        filterSummarySource: log.metadata?.filterSummarySource || (log.metadata?.filterSummaryGenerated === true ? '系统回填' : '文件自带'),
        filterSummaryGenerated: log.metadata?.filterSummaryGenerated === true,
        filterType: log.metadata?.filterType || '',
        filterProfileId: log.metadata?.filterProfileId || '',
        filterProfileName: log.metadata?.filterProfileName || '',
        filterProfileActive: log.metadata?.filterProfileActive === true,
        filterProfileDisabled: log.metadata?.filterProfileDisabled === true,
        filterKeyword: log.metadata?.filterKeyword || '',
        filterMatchedCount: log.metadata?.filterMatchedCount ?? 0,
        filterTotalCount: log.metadata?.filterTotalCount ?? 0,
        filterHistoryLimit: log.metadata?.filterHistoryLimit ?? 0,
        filterLoadedAt: log.metadata?.filterLoadedAt || '',
        filterLoadDurationMs: log.metadata?.filterLoadDurationMs ?? null,
        filterLoadStatus: log.metadata?.filterLoadStatus || '',
        sanitizedNumberFields: log.metadata?.sanitizedNumberFields || [],
        generatedAt: log.metadata?.generatedAt || log.metadata?.previewGeneratedAt || '',
        expiresAt: log.metadata?.expiresAt || '',
        webCount: log.metadata?.webCount || 0,
        remoteCount: log.metadata?.remoteCount || 0,
        matchedCount: log.metadata?.matchedCount || 0,
        missingCount: log.metadata?.missingCount || 0,
        driftCount: log.metadata?.driftCount || 0,
        profileCode: log.metadata?.profileCode || '',
        profileName: log.metadata?.profileName || '',
        changedProfileCount: log.metadata?.changedProfileCount || (isSync || isImport ? 0 : 1),
        changedFields: log.metadata?.changedFields || [],
        changes: log.metadata?.changes || []
      }
    })
}

function configHistoryFilterSummaryFromFilters(filters = {}, count = 0) {
  const type = String(filters.type || '全部').trim() || '全部'
  const profileText = filters.profileFilterDisabled === true
    ? '专业筛选未参与'
    : filters.profileFilterActive === true
      ? `专业 ${String(filters.profileName || filters.profileId || '未记录').trim() || '未记录'}`
      : ''
  return [
    `类型 ${type}`,
    profileText,
    String(filters.keyword || '').trim() ? `关键词“${String(filters.keyword || '').trim()}”` : '',
    `命中 ${filters.matchedCount ?? count}/${filters.totalCount ?? '未知'} 条`
  ].filter(Boolean).join(' · ')
}

function csvEscape(value = '') {
  const raw = String(value ?? '')
  // Excel/表格软件会把 = + - @、Tab、CR 开头的字符串当公式执行。
  // 仅转义字符串输入，真实 number 仍保持数值单元格语义。
  const text = typeof value === 'string' && /^(?:[\t\r]|\s*[=+\-@])/.test(raw) ? `'${raw}` : raw
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

function aiTraceModeName(mode = '') {
  if (mode === 'hermes-agent') return 'Hermes Agent'
  if (mode === 'external') return '外部 AI'
  if (mode === 'fallback-local') return '本地兜底'
  if (mode === 'local') return '本地规则'
  return '未记录模式'
}

function latestAiTraceForProposal(item = {}) {
  return Array.isArray(item.aiReviewTrace) ? item.aiReviewTrace[0] || null : null
}

function aiTraceLogMetadata(item = {}, source = '') {
  const trace = latestAiTraceForProposal(item) || {}
  return {
    kind: 'ai-review-trace',
    source,
    traceId: trace.id || '',
    provider: trace.provider || item.aiProvider || '',
    model: trace.model || item.aiModel || '',
    mode: trace.mode || '',
    modeName: aiTraceModeName(trace.mode || ''),
    status: trace.status || '',
    fallback: trace.fallback === true,
    durationMs: Number(trace.durationMs) || 0,
    profileCount: Number(trace.profileCount) || 0,
    opinionCount: Number(trace.opinionCount) || 0,
    result: trace.result || item.summary?.result || '',
    error: trace.error || '',
    reviewedAt: trace.at || nowText()
  }
}

function aiTraceLogResult(item = {}) {
  const trace = latestAiTraceForProposal(item)
  if (!trace) return '未执行'
  if (trace.fallback === true || trace.status === 'fallback') return '回退'
  if (trace.status === 'failed') return '失败'
  if (trace.status === 'needs-human-review') return '待确认'
  return '成功'
}

function aiTraceLogSummary(log = {}) {
  if (logActionGroup(log) !== 'AI调用') return ''
  const metadata = log.metadata || {}
  return [
    metadata.provider ? `Provider ${metadata.provider}` : '',
    metadata.model ? `模型 ${metadata.model}` : '',
    metadata.modeName || metadata.mode ? `模式 ${metadata.modeName || aiTraceModeName(metadata.mode)}` : '',
    metadata.status ? `状态 ${metadata.status}` : '',
    metadata.fallback === true ? '已回退本地规则' : '',
    metadata.durationMs !== undefined ? `耗时 ${metadata.durationMs}ms` : '',
    metadata.profileCount !== undefined ? `Profile ${metadata.profileCount}` : '',
    metadata.opinionCount !== undefined ? `意见 ${metadata.opinionCount}` : '',
    metadata.result ? `结论 ${metadata.result}` : '',
    metadata.error ? `原因 ${metadata.error}` : ''
  ].filter(Boolean).join('；')
}

function rolePermissionChangeSummary(log = {}) {
  const changes = log.metadata?.changes || {}
  const impact = log.metadata?.roleImpact || {}
  if (!String(log.action || '').includes('角色权限矩阵') || !changes || typeof changes !== 'object') return ''
  const changeText = Object.entries(changes)
    .map(([role, change]) => {
      const added = change?.addedNames || change?.added || []
      const removed = change?.removedNames || change?.removed || []
      const roleImpact = impact[role] || {}
      const roleText = roleImpact.enabled !== undefined ? `${role}（影响：启用 ${roleImpact.enabled} / 总计 ${roleImpact.total || 0}）` : role
      return [
        roleText,
        added.length ? `新增：${added.join('、')}` : '',
        removed.length ? `移除：${removed.join('、')}` : ''
      ].filter(Boolean).join('：')
    })
    .filter(Boolean)
    .join('\n')
  if (!changeText) return ''
  return ['来源：第一服务研发小组审核系统 / 日志中心 / 权限变更', `动作：${log.action || '角色权限矩阵变更'}`, `操作人：${log.actor || '未知账号'}`, `日志时间：${log.at || '未记录'}`, changeText].filter(Boolean).join('\n')
}

function systemConfigChangeSummary(log = {}) {
  const metadata = log.metadata || {}
  const kind = String(metadata.kind || '')
  if (!['rule-create', 'rule-update', 'rule-status-update', 'rule-delete', 'reminder-config-update'].includes(kind)) return ''
  const rule = metadata.rule || metadata.after || metadata.before || {}
  const changes = Array.isArray(metadata.changes) ? metadata.changes : []
  const changeText = changes.map(change => `${change.label || change.field || '字段'}：${change.before ?? ''} -> ${change.after ?? ''}`)
  return [
    kind === 'rule-create' ? '新增规则' : '',
    kind === 'rule-delete' ? '删除规则' : '',
    kind === 'rule-update' ? '修改规则' : '',
    kind === 'rule-status-update' ? '规则启停' : '',
    kind === 'reminder-config-update' ? '自动催办规则配置' : '',
    rule.name ? `规则 ${rule.name}` : '',
    rule.category ? `类别 ${rule.category}` : '',
    rule.status ? `状态 ${rule.status}` : '',
    metadata.changeCount !== undefined ? `变更 ${metadata.changeCount} 项` : '',
    ...changeText
  ].filter(Boolean).join('；')
}

function hermesConfigLogSummary(log = {}) {
  if (logActionGroup(log) !== 'Hermes配置') return ''
  const metadata = log.metadata || {}
  return [
    metadata.checkedAt ? `检查时间 ${metadata.checkedAt}` : '',
    metadata.provider ? `Provider ${metadata.provider}` : '',
    metadata.model ? `模型 ${metadata.model}` : '',
    metadata.webCount !== undefined ? `网页 ${metadata.webCount}` : '',
    metadata.remoteCount !== undefined ? `云端 ${metadata.remoteCount}` : '',
    metadata.matchedCount !== undefined ? `匹配 ${metadata.matchedCount}` : '',
    metadata.missingCount !== undefined ? `缺失 ${metadata.missingCount}` : '',
    metadata.driftCount !== undefined ? `差异 ${metadata.driftCount}` : '',
    metadata.changedProfileCount !== undefined ? `变化专业 ${metadata.changedProfileCount}` : '',
    metadata.profileCount !== undefined ? `Profile ${metadata.profileCount}` : '',
    Array.isArray(metadata.missingProfiles) && metadata.missingProfiles.length ? `未匹配 ${metadata.missingProfiles.join('、')}` : '',
    Array.isArray(metadata.driftProfiles) && metadata.driftProfiles.length ? `差异专业 ${metadata.driftProfiles.join('、')}` : '',
    Array.isArray(metadata.profileNames) && metadata.profileNames.length ? `涉及专业 ${metadata.profileNames.join('、')}` : '',
    metadata.diagnostic?.nextAction ? `接入排查建议 ${metadata.diagnostic.nextAction}` : '',
    ...(metadata.diagnostic?.checks || []).map(check => `${check.label} ${check.status} ${check.detail}`),
    metadata.message ? `说明 ${metadata.message}` : ''
  ].filter(Boolean).join('；')
}

function launchApprovalLogSummary(log = {}) {
  if (logActionGroup(log) !== '上线确认') return ''
  const metadata = log.metadata || {}
  const riskSummary = metadata.riskSummary || {}
  const latestNotice = riskSummary.latestPasswordNotice || null
  return [
    metadata.id ? `记录编号 ${metadata.id}` : '',
    metadata.passed !== undefined || metadata.total !== undefined ? `检查结论 ${metadata.passed || 0}/${metadata.total || 0} 项通过` : '',
    metadata.appVersion ? `前端版本 ${metadata.appVersion}` : '',
    metadata.appBuildLabel ? `构建标识 ${metadata.appBuildLabel}` : '',
    metadata.appBuildTime ? `构建时间 ${metadata.appBuildTime}` : '',
    metadata.generatedAt ? `生成时间 ${metadata.generatedAt}` : '',
    metadata.refreshedAt ? `最近刷新 ${metadata.refreshedAt}` : '',
    metadata.reason ? `拦截原因 ${metadata.reason}` : '',
    riskSummary.riskCount !== undefined
      ? `账号风险 默认密码 ${riskSummary.defaultPassword || 0} 个、需改密 ${riskSummary.mustChangePassword || 0} 个、登录锁定 ${riskSummary.loginLocked || 0} 个`
      : '',
    Array.isArray(riskSummary.byRole) && riskSummary.byRole.length ? `角色分布 ${riskSummary.byRole.map(item => `${item.role || '-'} ${item.enabled || 0}/${item.total || 0}`).join('、')}` : '',
    latestNotice
      ? `最近改密通知 ${latestNotice.auditId || '未记录'}，通知 ${latestNotice.noticeCount || 0} 个，操作人 ${latestNotice.actor || '未知账号'}，时间 ${latestNotice.at || '未记录'}`
      : riskSummary.riskCount !== undefined && (Number(riskSummary.mustChangePassword) || 0) > 0
        ? '最近改密通知 尚未发现通知留痕'
        : '',
    latestNotice && Array.isArray(latestNotice.targetNames) && latestNotice.targetNames.length ? `通知姓名 ${latestNotice.targetNames.join('、')}` : '',
    latestNotice && Array.isArray(latestNotice.targetUsernames) && latestNotice.targetUsernames.length ? `通知账号 ${latestNotice.targetUsernames.join('、')}` : '',
    Array.isArray(metadata.items) && metadata.items.length
      ? `检查项 ${metadata.items.map(item => `${item.label || '-'}：${item.status || '-'}${item.action ? `（建议：${item.action}）` : ''}`).join('、')}`
      : ''
  ].filter(Boolean).join('；')
}

function launchApprovalRiskCsvSummary(log = {}) {
  if (logActionGroup(log) !== '上线确认') return ''
  const riskSummary = log.metadata?.riskSummary || {}
  if (riskSummary.riskCount === undefined) return ''
  return `默认密码 ${riskSummary.defaultPassword || 0} 个；需改密 ${riskSummary.mustChangePassword || 0} 个；登录锁定 ${riskSummary.loginLocked || 0} 个；总风险 ${riskSummary.riskCount || 0} 个`
}

function launchApprovalRoleCsvSummary(log = {}) {
  if (logActionGroup(log) !== '上线确认') return ''
  const byRole = log.metadata?.riskSummary?.byRole
  return Array.isArray(byRole) && byRole.length
    ? byRole.map(item => `${item.role || '-'} ${item.enabled || 0}/${item.total || 0}`).join('；')
    : ''
}

function exportEventLogSummary(log = {}) {
  if (logActionGroup(log) !== '导出') return ''
  const metadata = log.metadata || {}
  return [
    metadata.typeText || metadata.type ? `导出类型 ${metadata.typeText || exportTypeText(metadata.type)}` : '',
    metadata.sourceText || exportSourceForLog(log) ? `入口来源 ${metadata.sourceText || exportSourceTextForLog(log)}` : '',
    metadata.appVersion ? `前端版本 ${metadata.appVersion}` : '',
    metadata.appBuildLabel ? `构建标识 ${metadata.appBuildLabel}` : '',
    metadata.appBuildTime ? `构建时间 ${metadata.appBuildTime}` : '',
    metadata.exportEventId ? `事件ID ${metadata.exportEventId}` : '',
    log.proposalTitle ? `方案 ${log.proposalTitle}` : '',
    log.proposalId ? `方案ID ${log.proposalId}` : ''
  ].filter(Boolean).join('；')
}

function networkDiagnosticsLogSummary(log = {}) {
  if (logActionGroup(log) !== '公网诊断') return ''
  const metadata = log.metadata || {}
  return [
    metadata.domain ? `域名 ${metadata.domain}` : '',
    metadata.expectedIp ? `预期IP ${metadata.expectedIp}` : '',
    Array.isArray(metadata.resolvedIps) && metadata.resolvedIps.length ? `解析IP ${metadata.resolvedIps.join('、')}` : '',
    metadata.message ? `说明 ${metadata.message}` : ''
  ].filter(Boolean).join('；')
}

function accountSecurityLogSummary(log = {}) {
  if (detectLogCategory(log) !== '账号安全') return ''
  const metadata = log.metadata || {}
  const riskSummary = metadata.riskSummary || {}
  return [
    log.result ? `结果 ${log.result}` : '',
    metadata.auditId ? `批量批次 ${metadata.auditId}` : '',
    metadata.exportAuditId ? `导出批次 ${metadata.exportAuditId}` : '',
    metadata.targetUsername || metadata.username ? `目标账号 ${metadata.targetUsername || metadata.username}` : '',
    metadata.targetRole ? `目标角色 ${metadata.targetRole}` : '',
    metadata.previousUsername ? `原账号 ${metadata.previousUsername}` : '',
    metadata.role ? `当前角色 ${metadata.role}` : '',
    metadata.status ? `当前状态 ${metadata.status}` : '',
    metadata.reason ? `原因 ${metadata.reason}` : '',
    metadata.mustChangePassword !== undefined ? `需改密 ${metadata.mustChangePassword ? '是' : '否'}` : '',
    metadata.noticeCount !== undefined ? `通知账号 ${metadata.noticeCount}` : '',
    metadata.noticeChannel ? `通知方式 ${metadata.noticeChannel}` : '',
    metadata.requestedCount !== undefined ? `请求 ${metadata.requestedCount}` : '',
    metadata.changedCount !== undefined ? `更新 ${metadata.changedCount}` : '',
    metadata.skippedCount !== undefined ? `跳过 ${metadata.skippedCount}` : '',
    riskSummary.defaultPasswordCount !== undefined ? `默认密码 ${riskSummary.defaultPasswordCount}` : '',
    riskSummary.mustChangePasswordCount !== undefined ? `需改密 ${riskSummary.mustChangePasswordCount}` : '',
    riskSummary.loginLockedCount !== undefined ? `登录锁定 ${riskSummary.loginLockedCount}` : '',
    riskSummary.inactiveLoginCount !== undefined ? `长期未登录 ${riskSummary.inactiveLoginCount}` : '',
    Array.isArray(riskSummary.roleSummary) && riskSummary.roleSummary.length ? `角色分布 ${riskSummary.roleSummary.map(item => `${item.role || '-'} ${item.enabled || 0}/${item.total || 0}`).join('、')}` : '',
    Array.isArray(riskSummary.rolePermissionSnapshot) && riskSummary.rolePermissionSnapshot.length ? `角色权限矩阵 ${riskSummary.rolePermissionSnapshot.map(item => `${item.role || '-'} ${item.permissionText || (Array.isArray(item.permissions) ? item.permissions.join('/') : '无权限')}`).join('、')}` : '',
    metadata.defaultPasswordLogUrl ? `默认密码拒绝日志 ${metadata.defaultPasswordLogUrl}` : '',
    metadata.skippedAdminCount ? `跳过管理员 ${metadata.skippedAdminCount}` : '',
    metadata.skippedAlreadyRequiredCount ? `跳过已需改密 ${metadata.skippedAlreadyRequiredCount}` : '',
    metadata.skippedAlreadyDisabledCount ? `跳过已停用 ${metadata.skippedAlreadyDisabledCount}` : '',
    metadata.skippedUnlockedCount ? `跳过未锁定 ${metadata.skippedUnlockedCount}` : '',
    Array.isArray(metadata.targetUsernames) && metadata.targetUsernames.length ? `${metadata.noticeCount !== undefined ? '通知账号' : '更新账号'} ${metadata.targetUsernames.join('、')}` : '',
    Array.isArray(metadata.skippedUsernames) && metadata.skippedUsernames.length ? `跳过账号 ${metadata.skippedUsernames.join('、')}` : ''
  ].filter(Boolean).join('；')
}

function bulkOperationLogSummary(log = {}) {
  const metadata = log.metadata || {}
  const action = String(log.action || '')
  const isBulkAiReview = metadata.bulkKind === 'bulk-ai-review' || metadata.source === 'bulk-rerun'
  if (!['bulk-status', 'bulk-delete', 'bulk-reminder', 'knowledge-bulk-status', 'knowledge-bulk-delete'].includes(metadata.kind) && !isBulkAiReview) {
    if (!isBulkOperationLog(log)) return ''
    const legacyLabel = action.includes('批量更新方案状态')
      ? '批量状态更新'
      : action.includes('批量删除方案')
        ? '批量删除'
        : action.includes('批量自动催办') || action.includes('批量登记催办')
          ? '批量催办'
          : action.includes('批量重新发起 AI 审核')
            ? '批量AI重审'
            : action.includes('批量启用知识条款') || action.includes('批量停用知识条款')
              ? '知识条款批量状态'
              : action.includes('批量删除知识条款')
                ? '知识条款批量删除'
                : '批量操作'
    return [legacyLabel, action].filter(Boolean).join('；')
  }
  const kindLabelMap = {
    'bulk-status': '批量状态更新',
    'bulk-delete': '批量删除',
    'bulk-reminder': '批量催办',
    'knowledge-bulk-status': '知识条款批量状态',
    'knowledge-bulk-delete': '知识条款批量删除',
    'ai-review-trace': '批量AI重审'
  }
  return [
    isBulkAiReview ? '批量AI重审' : kindLabelMap[metadata.kind] || '批量操作',
    metadata.status ? `目标状态 ${metadata.status}` : '',
    metadata.source ? `来源 ${reminderSourceText(metadata.source)}` : '',
    metadata.requestedCount !== undefined ? `请求 ${metadata.requestedCount}` : '',
    metadata.completedCount !== undefined ? `处理完成 ${metadata.completedCount}` : metadata.successCount !== undefined ? `兼容计数 ${metadata.successCount}` : '',
    metadata.fallbackCount !== undefined ? `回退 ${metadata.fallbackCount}` : '',
    metadata.failedCount !== undefined ? `失败 ${metadata.failedCount}` : '',
    metadata.updatedCount !== undefined ? `更新 ${metadata.updatedCount}` : '',
    metadata.removedCount !== undefined ? `删除 ${metadata.removedCount}` : '',
    metadata.createdCount !== undefined ? `生成 ${metadata.createdCount}` : '',
    metadata.skippedCount !== undefined ? `跳过 ${metadata.skippedCount}` : '',
    Array.isArray(metadata.titles) && metadata.titles.length ? `涉及对象 ${metadata.titles.join('、')}` : '',
    Array.isArray(metadata.items) && metadata.items.length ? `明细 ${metadata.items.map(item => `${item.title || item.id || '-'}(${item.ok ? '处理完成' : '失败'}${item.message ? `：${item.message}` : ''})`).join('、')}` : '',
    Array.isArray(metadata.skippedItems) && metadata.skippedItems.length ? `跳过方案 ${metadata.skippedItems.map(item => `${item.title || item.id || '-'}(${item.reason || '未记录原因'})`).join('、')}` : '',
    Array.isArray(metadata.proposalIds) && metadata.proposalIds.length ? `方案ID ${metadata.proposalIds.join('、')}` : ''
  ].filter(Boolean).join('；')
}

function networkDiagnosticsDashboardSummary() {
  const diagnosticLogs = logs
    .filter(log => logActionGroup(log) === '公网诊断')
    .sort((a, b) => parseTimeText(b.at) - parseTimeText(a.at))
  const latest = diagnosticLogs[0]
  if (!latest) {
    return {
      ok: false,
      status: 'none',
      statusText: '暂无诊断',
      recordCount: 0,
      latest: null
    }
  }

  const metadata = latest.metadata || {}
  return {
    ok: latest.result === '成功',
    status: latest.result === '成功' ? 'valid' : 'failed',
    statusText: latest.result === '成功' ? '解析正常' : '需处理',
    recordCount: diagnosticLogs.length,
    latest: {
      actor: latest.actor || '',
      at: latest.at || '',
      domain: metadata.domain || '',
      expectedIp: metadata.expectedIp || '',
      resolvedIps: Array.isArray(metadata.resolvedIps) ? metadata.resolvedIps : [],
      message: metadata.message || ''
    }
  }
}

function launchApprovalDashboardSummary(freshHours = 24) {
  const thresholdHours = Math.max(1, Number(freshHours) || 24)
  const approvalLogs = logs
    .filter(log => logActionGroup(log) === '上线确认')
    .sort((a, b) => parseTimeText(b.at || b.metadata?.generatedAt) - parseTimeText(a.at || a.metadata?.generatedAt))
  const latest = approvalLogs[0]
  if (!latest) {
    return {
      ok: false,
      status: 'none',
      statusText: '暂无确认',
      thresholdHours,
      recordCount: 0,
      latest: null
    }
  }

  const metadata = latest.metadata || {}
  const confirmedAt = latest.at || metadata.generatedAt || ''
  const ageHours = diffHoursFromNow(confirmedAt)
  const expired = ageHours >= thresholdHours
  const blocked = latest.result === '拦截'
  const passed = Number(metadata.passed) || 0
  const total = Number(metadata.total) || 0

  return {
    ok: !expired && !blocked,
    status: blocked ? 'blocked' : expired ? 'expired' : 'valid',
    statusText: blocked ? '确认拦截' : expired ? '建议重确' : '当前有效',
    thresholdHours,
    ageHours,
    recordCount: approvalLogs.length,
    latest: {
      id: metadata.id || latest.id || '',
      actor: latest.actor || metadata.actor || '',
      at: latest.at || '',
      generatedAt: metadata.generatedAt || '',
      refreshedAt: metadata.refreshedAt || '',
      appVersion: metadata.appVersion || '',
      result: latest.result || '未记录',
      reason: metadata.reason || '',
      passed,
      total,
      riskSummary: metadata.riskSummary || null,
      summary: total > 0 ? `${passed}/${total} 项通过` : '检查项未记录'
    }
  }
}

async function networkDiagnosticsSummary(config = systemConfig) {
  const normalized = normalizeSystemConfig(config)
  const domain = normalized.publicDomain || ''
  const expectedIp = normalized.publicIp || ''

  if (!domain) {
    return {
      ok: false,
      domain,
      expectedIp,
      resolvedIps: [],
      message: '未配置公网域名'
    }
  }

  try {
    const resolvedIps = [...new Set(await dns.resolve4(domain))]
    const matched = expectedIp ? resolvedIps.includes(expectedIp) : resolvedIps.length > 0
    return {
      ok: matched,
      domain,
      expectedIp,
      resolvedIps,
      message: matched
        ? `域名 ${domain} 已解析到 ${expectedIp || resolvedIps.join('、')}`
        : `域名 ${domain} 当前解析到 ${resolvedIps.join('、') || '空'}，未命中 ${expectedIp || '预期公网 IP'}`
    }
  } catch (err) {
    return {
      ok: false,
      domain,
      expectedIp,
      resolvedIps: [],
      message: `域名解析失败：${err.message || '未知错误'}`
    }
  }
}

async function networkLaunchReadiness() {
  const diagnostics = await networkDiagnosticsSummary(systemConfig)
  return {
    ok: diagnostics.ok === true,
    diagnostics,
    reason: diagnostics.ok ? '' : diagnostics.message || '公网域名解析未通过'
  }
}

function parseCsvLine(line = '') {
  if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > 64 * 1024) {
    throw new Error('CSV 单行超出 64KiB 上限')
  }
  const cells = []
  let current = ''
  let inQuotes = false
  let quotedField = false
  let quoteClosed = false

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    const next = line[i + 1]

    if (inQuotes && ch === '"' && next === '"') {
      current += '"'
      i += 1
      continue
    }
    if (inQuotes && ch === '"') {
      inQuotes = false
      quoteClosed = true
      continue
    }
    if (!inQuotes && ch === '"') {
      if (current.length !== 0 || quoteClosed) throw new Error('CSV 引号只能出现在字段起始位置')
      inQuotes = true
      quotedField = true
      continue
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current)
      current = ''
      quotedField = false
      quoteClosed = false
      continue
    }
    if (quoteClosed) throw new Error('CSV 引号闭合后只能紧跟逗号或行尾')
    current += ch
    if (Buffer.byteLength(current, 'utf8') > 32 * 1024) throw new Error('CSV 字段超出 32KiB 上限')
  }
  if (inQuotes) throw new Error('CSV 存在未闭合引号；不支持 quoted multiline')
  if (quotedField && !quoteClosed) throw new Error('CSV 引号字段格式无效')
  cells.push(current)
  return cells.map(cell => cell.trim())
}

function parseKnowledgeCsv(text = '') {
  const raw = String(text)
  if (Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) throw new Error('CSV 总量超出 2MiB 上限')
  const lines = raw
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')

  if (lines.length < 2) return []
  if (lines.length > 5001) throw new Error('CSV 数据行超出 5000 行上限')

  const headers = parseCsvLine(lines[0])
  const allowedHeaders = new Set(['profileId', 'clauseCode', 'title', 'source', 'content', 'keywords', 'priority', 'status'])
  const requiredHeaders = ['profileId', 'title', 'content']
  const dangerousHeaders = new Set(['__proto__', 'prototype', 'constructor'])
  if (headers.some(header => !header || dangerousHeaders.has(header) || !allowedHeaders.has(header))) {
    throw new Error('CSV 包含空白、危险或未知 header')
  }
  if (new Set(headers).size !== headers.length) throw new Error('CSV header 不得重复')
  if (requiredHeaders.some(header => !headers.includes(header))) {
    throw new Error(`CSV 必须包含 ${requiredHeaders.join('、')} header`)
  }
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line)
    if (cells.length !== headers.length) throw new Error('CSV 数据列数与 header 不一致')
    const row = Object.create(null)
    headers.forEach((header, index) => {
      row[header] = cells[index]
    })
    return row
  })
}

function splitKnowledgeSegments(text = '') {
  const normalized = String(text)
    .replace(/\r/g, '\n')
    .split(/\n+/)
    .flatMap(line => line.split(/[。；;！？!?]/))
    .map(segment => normalizeSnippetText(segment))
    .filter(segment => segment.length >= 12)

  return [...new Set(normalized)]
}

function buildDraftProfileTerms(profile) {
  return [...new Set([
    ...verifiedProfileStandards(profile),
    ...String(profile.scope || '').split(/[、，,\s]/).map(item => item.trim()).filter(Boolean),
    ...String(profile.output || '').split(/[、，,\s]/).map(item => item.trim()).filter(Boolean)
  ])]
}

function buildDraftKeywords(segment, profileTerms = []) {
  const matchedTerms = profileTerms.filter(term => term && segment.includes(term))
  const fallbackTerms = profileTerms.filter(term => term.length >= 2).slice(0, 4)
  return normalizeKeywords(matchedTerms.length > 0 ? matchedTerms.slice(0, 5) : fallbackTerms)
}

function buildDraftTitle(segment, profile, profileTerms = []) {
  const exactStandard = verifiedProfileStandards(profile).find(item => segment.includes(item))
  if (exactStandard) return exactStandard

  const scopeTerm = profileTerms.find(term => term.length >= 2 && segment.includes(term))
  if (scopeTerm) return `${scopeTerm}要求`

  return `${segment.slice(0, 14)}${segment.length > 14 ? '...' : ''}`
}

function buildKnowledgeDrafts(profile, sourceName, text = '') {
  const profileTerms = buildDraftProfileTerms(profile)
  const segments = splitKnowledgeSegments(text)
    .map(segment => {
      const matchedTerms = profileTerms.filter(term => term && segment.includes(term))
      return {
        segment,
        matchedTerms,
        score: matchedTerms.length * 10 + Math.min(8, Math.floor(segment.length / 18))
      }
    })
    .sort((a, b) => b.score - a.score || b.segment.length - a.segment.length)
    .slice(0, 6)

  const clauseCodes = nextDraftClauseCodes(profile, segments.length)

  return segments.map((item, index) => ({
    profileId: profile.id,
    clauseCode: clauseCodes[index],
    title: buildDraftTitle(item.segment, profile, profileTerms),
    source: sourceName,
    content: item.segment,
    keywords: buildDraftKeywords(item.segment, profileTerms),
    matchedTerms: item.matchedTerms.slice(0, 5),
    priority: index < 2 ? '高' : '中',
    status: '停用'
  }))
}

function aiTraceStatsSummary() {
  const traces = proposals.flatMap(item => (Array.isArray(item.aiReviewTrace) ? item.aiReviewTrace : []).map(trace => ({
    ...trace,
    proposalId: item.id,
    proposalTitle: item.title,
    proposalType: item.type
  })))
  traces.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''), 'zh-CN'))

  const success = traces.filter(trace => trace.status === 'success' && trace.fallback !== true)
  const fallback = traces.filter(trace => trace.fallback === true || trace.status === 'fallback')
  const failed = traces.filter(trace => trace.status === 'failed')
  const providerMap = new Map()
  const modelMap = new Map()

  for (const trace of traces) {
    const provider = trace.provider || 'unknown'
    const model = trace.model || 'unknown'
    providerMap.set(provider, (providerMap.get(provider) || 0) + 1)
    modelMap.set(model, (modelMap.get(model) || 0) + 1)
  }

  return {
    total: traces.length,
    successCount: success.length,
    fallbackCount: fallback.length,
    failedCount: failed.length,
    successRate: traces.length > 0 ? Math.round((success.length / traces.length) * 100) : 0,
    avgDurationMs: traces.length > 0 ? Math.round(traces.reduce((sum, trace) => sum + (Number(trace.durationMs) || 0), 0) / traces.length) : 0,
    latestAt: traces[0]?.at || '',
    latestProvider: traces[0]?.provider || '',
    latestModel: traces[0]?.model || '',
    latestMode: traces[0]?.mode || '',
    latestModeName: aiTraceModeName(traces[0]?.mode || ''),
    byProvider: Array.from(providerMap.entries()).map(([label, value]) => ({ label, value })),
    byModel: Array.from(modelMap.entries()).map(([label, value]) => ({ label, value })),
    recent: traces.slice(0, 8)
  }
}

function validBusinessDate(value) {
  if (!value) return null
  const text = String(value).trim()
  const explicitDate = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:\D|$)/)
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
  if (explicitDate && !hasExplicitZone) return `${explicitDate[1]}-${explicitDate[2]}-${explicitDate[3]}`
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return null
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  })
  const parts = Object.fromEntries(formatter.formatToParts(parsed).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function proposalTrend() {
  const buckets = new Map()
  const ensure = date => {
    if (!buckets.has(date)) buckets.set(date, { date: date.slice(5), submit: 0, pass: 0 })
    return buckets.get(date)
  }
  for (const proposal of proposals) {
    const submittedAt = validBusinessDate(proposal.createdAt)
    if (submittedAt) ensure(submittedAt).submit += 1
    if (proposal.status !== statuses.passed) continue
    const passedAt = validBusinessDate(proposal.executionRecord?.signOff?.signedAt)
    if (passedAt) ensure(passedAt).pass += 1
  }
  return Array.from(buckets.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-7)
    .map(([, value]) => value)
}

// ===== 公开接口 =====
app.get('/api/health', (_req, res) => {
  const runtime = aiRuntimeConfig()
  const readiness = aiReviewReadinessState(runtime)
  res.json({
    ok: true,
    service: 'first-service-review-system',
    port: String(port),
    apiPrefix: systemConfig.apiPrefix || '/api',
    sessionTtlMinutes: systemConfig.sessionTtlMinutes || defaultSessionTtlMinutes,
    gatewayConfigured: runtime.gatewayConfigured,
    inferenceEnabled: runtime.agentConfigured,
    agentConfigured: runtime.agentConfigured,
    reviewReady: readiness.reviewReady,
    submissionMode: readiness.submissionMode,
    reviewReadinessMessage: readiness.message
  })
})

// ===== 需要认证的接口 =====
app.get('/api/dashboard', authMiddleware, (req, res) => {
  const activeProfiles = activeBotProfiles()
  const aiRuntime = aiRuntimeConfig()
  const profileItems = orderedBotProfiles().map(profileListItem)
  const pending = proposals.filter(item => ['待审核', '审核中', '待复核'].includes(item.status)).length
  const configurationPending = proposals.filter(item => item.status === statuses.configurationPending).length
  const needRevision = proposals.filter(item => item.status === '待修改').length
  const passed = proposals.filter(item => item.status === '已通过').length
  const scored = proposals
    .map(item => item.summary?.avgScore)
    .filter(value => Number.isFinite(value))
  const avgScore = scored.length > 0
    ? Math.round(scored.reduce((sum, value) => sum + value, 0) / scored.length)
    : null
  const executionStats = executionStatsSummary()
  const executionQueues = executionQueuesSummary()
  const reminderStats = reminderStatsSummary()
  const exportStats = exportStatsSummary()
  const attachmentStats = attachmentStatsSummary()
  const aiTraceStats = aiTraceStatsSummary()
  const userPermissions = req.user?.permissions || permissionsForRole(req.user?.role)
  const canReview = userPermissions.includes('reviewProposal')
  const canViewLogs = userPermissions.includes('viewLogs')
  const canManageUsers = userPermissions.includes('manageUsers')
  const canManageSystem = userPermissions.includes('manageSystem')
  const canViewSecurityOps = (canManageUsers || canManageSystem) && canViewLogs
  const allowedLogCategories = allowedLogCategoriesForUser(req.user || {})
  const visibleLogs = canViewLogs
    ? (allowedLogCategories ? logs.filter(log => allowedLogCategories.has(log.category || '')) : logs)
    : []
  const logBuckets = splitLogsByExecution(visibleLogs)
  const canViewReviewData = canReview || canViewLogs

  const payload = {
    stats: {
      pending,
      configurationPending,
      passed,
      needRevision,
      onlineRobots: aiRuntime.agentConfigured ? activeProfiles.length : 0,
      enabledProfiles: activeProfiles.length,
      totalRobots: orderedBotProfiles().length,
      avgScore
    },
    robots: profileItems,
    trend: proposalTrend(),
    proposals: canViewReviewData ? proposals.map(proposalListItem) : [],
    logs: visibleLogs,
    reviewLogs: logBuckets.reviewLogs,
    executionLogs: logBuckets.executionLogs,
    executionStats: canViewReviewData ? executionStats : null,
    executionQueues: canViewReviewData ? executionQueues : null,
    reminderStats: canViewReviewData ? reminderStats : null,
    exportStats: canViewReviewData ? exportStats : null,
    attachmentStats: canViewReviewData ? attachmentStats : null,
    aiTraceStats: canViewReviewData ? aiTraceStats : null
  }

  if (canManageSystem) {
    payload.workflow = workflowSummary()
    payload.ruleStats = ruleStatsSummary()
  }
  if (canManageUsers) {
    payload.userStats = userStatsSummary()
  }
  if (canViewSecurityOps) {
    payload.securityStats = logSummary({ type: '账号安全' })
  }
  if (canManageSystem && canViewLogs) {
    payload.launchApprovalStats = launchApprovalDashboardSummary()
    payload.networkDiagnosticsStats = networkDiagnosticsDashboardSummary()
  }

  res.json(payload)
})

app.get('/api/bots', authMiddleware, requirePermission('manageSystem'), (_req, res) => res.json({ bots: orderedBotProfiles().map(profileListItem) }))

app.get('/api/profiles', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  const historyLimit = clampNumber(req.query.historyLimit, 12, 100, 50)
  res.json({
    profiles: orderedBotProfiles().map(profileListItem),
    latestHermesProfileSync: latestHermesProfileSync(),
    latestHermesProfileImport: latestHermesProfileImport(),
    latestHermesProfileManualEdit: latestHermesProfileManualEdit(),
    latestHermesProfileStatusCheck: latestHermesProfileStatusCheck(),
    configHistory: hermesProfileConfigHistory(historyLimit),
    configHistoryLimit: historyLimit
  })
})

app.post('/api/profiles/config-history-verification', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  const expectedHash = String(req.body?.expectedHash || '').trim().toLowerCase()
  const actualHash = String(req.body?.actualHash || '').trim().toLowerCase()
  const filename = String(req.body?.filename || '').trim().slice(0, 160)
  const sanitizedNumberFields = []
  const clampAuditNumber = (field, value, min, max, fallback) => {
    const sanitized = clampNumber(value, min, max, fallback)
    if (value !== undefined && value !== null && value !== '' && Number(value) !== sanitized) sanitizedNumberFields.push(field)
    return sanitized
  }
  const count = clampAuditNumber('count', req.body?.count, 0, 10000, 0)
  const algorithm = String(req.body?.algorithm || 'SHA-256').trim().toUpperCase()
  const checkedAt = String(req.body?.checkedAt || '').trim().slice(0, 80)
  const filters = req.body?.filters && typeof req.body.filters === 'object' ? req.body.filters : {}
  const filterLoadedAt = String(filters.loadedAt || '').trim().slice(0, 80)
  const filterLoadStatus = String(filters.loadStatus || '').trim().slice(0, 40)
  const allowedLoadStatuses = ['响应正常', '响应偏慢', '响应很慢', '未判断']
  const hasProvidedFilterSummary = String(filters.summary || '').trim() !== ''
  const requestedFilterSummarySource = String(filters.summarySource || '').trim()
  const filterSummarySource = ['文件自带', '系统回填'].includes(requestedFilterSummarySource)
    ? requestedFilterSummarySource
    : hasProvidedFilterSummary ? '文件自带' : '系统回填'
  const filterMetadata = {
    filterSummary: String(filters.summary || configHistoryFilterSummaryFromFilters(filters, count)).trim().slice(0, 240),
    filterSummarySource,
    filterSummaryGenerated: filterSummarySource === '系统回填',
    filterType: String(filters.type || '全部').trim().slice(0, 40),
    filterProfileId: String(filters.profileId || '全部').trim().slice(0, 80),
    filterProfileName: String(filters.profileName || '').trim().slice(0, 120),
    filterProfileActive: filters.profileFilterActive === true,
    filterProfileDisabled: filters.profileFilterDisabled === true,
    filterKeyword: String(filters.keyword || '').trim().slice(0, 120),
    filterMatchedCount: clampAuditNumber('filters.matchedCount', filters.matchedCount, 0, 10000, 0),
    filterTotalCount: clampAuditNumber('filters.totalCount', filters.totalCount, 0, 10000, 0),
    filterHistoryLimit: clampAuditNumber('filters.historyLimit', filters.historyLimit, 0, 100, 0),
    filterLoadedAt,
    filterLoadDurationMs: clampAuditNumber('filters.loadDurationMs', filters.loadDurationMs, 0, 60000, 0),
    filterLoadStatus,
    sanitizedNumberFields
  }
  const rejectVerification = (message, reason) => {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '校验 Hermes Profile 时间线审计 JSON',
      category: '系统配置',
      result: '拦截',
      metadata: {
        reason,
        filename,
        count,
        algorithm,
        expectedHash: expectedHash.slice(0, 16),
        actualHash: actualHash.slice(0, 16),
        hashMismatch: Boolean(expectedHash && actualHash && expectedHash !== actualHash),
        hashStatus: hashStatusText(expectedHash, actualHash),
        checkedAt,
        ...filterMetadata
      }
    })
    saveStore()
    return res.status(400).json({
      message,
      reason,
      hashMismatch: Boolean(expectedHash && actualHash && expectedHash !== actualHash),
      hashStatus: hashStatusText(expectedHash, actualHash),
      sanitizedNumberFields
    })
  }
  if (!filename) return rejectVerification('请提供审计文件名。', '文件名为空')
  if (algorithm !== 'SHA-256') return rejectVerification('仅支持 SHA-256 校验。', '校验算法不支持')
  if (!isSha256Hex(expectedHash) || !isSha256Hex(actualHash)) return rejectVerification('校验指纹格式无效。', '校验指纹格式无效')
  if (filterLoadedAt && !parseTimeText(filterLoadedAt)) return rejectVerification('载入刷新时间格式无效。', '载入刷新时间格式无效')
  if (filterLoadStatus && !allowedLoadStatuses.includes(filterLoadStatus)) return rejectVerification('载入响应状态无效。', '载入响应状态无效')
  const ok = req.body?.ok === true && expectedHash === actualHash
  const hashMismatch = expectedHash !== actualHash
  const hashStatus = hashStatusText(expectedHash, actualHash)
  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: '校验 Hermes Profile 时间线审计 JSON',
    category: '系统配置',
    result: ok ? '成功' : '失败',
    metadata: {
      filename,
      count,
      algorithm,
      expectedHash: expectedHash.slice(0, 16),
      actualHash: actualHash.slice(0, 16),
      hashMismatch,
      hashStatus,
      checkedAt,
      ...filterMetadata
    }
  })
  saveStore()
  res.json({
    ok: true,
    message: '审计 JSON 校验结果已记录。',
    hashMismatch,
    hashStatus,
    sanitizedNumberFields
  })
})

app.get('/api/profiles/export', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  const profiles = orderedBotProfiles().map(profileListItem)
  // GET 导出必须纯读：页面刷新/只读巡检不应改写 store，
  // 也不应在一致性备份期间隐式制造新业务状态。
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="hermes-profiles-${Date.now()}.json"`)
  res.send(JSON.stringify({
    source: '第一服务研发小组审核系统 / Hermes Profile',
    exportedAt: nowText(),
    exportedBy: req.user?.name || req.user?.username || '未知账号',
    profileCount: profiles.length,
    profiles
  }, null, 2))
})

app.post('/api/profiles/import-preview', authMiddleware, requirePermission('manageSystem'), upload.single('profiles'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: '请上传 Hermes Profile JSON 文件' })
  const extensionError = uploadExtensionError(req.file, jsonUploadExtensions, 'Hermes Profile')
  if (extensionError) return res.status(400).json({ message: extensionError })
  try {
    const profiles = parseImportedBotProfiles(JSON.parse(req.file.buffer.toString('utf8')))
    const preview = botProfileImportPreview(profiles)
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: `校验 Hermes Profile 导入文件 ${profiles.length} 个`,
      category: '系统配置',
      result: '成功',
      metadata: preview
    })
    saveStore()
    res.json({ ok: true, preview })
  } catch (err) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '校验 Hermes Profile 导入文件失败',
      category: '系统配置',
      result: '失败',
      metadata: { message: err.message || 'Profile 文件解析失败' }
    })
    saveStore()
    res.status(400).json({ message: err.message || 'Profile 文件解析失败' })
  }
})

app.post('/api/profiles/import', authMiddleware, requirePermission('manageSystem'), upload.single('profiles'), (req, res) => {
  if (String(req.body?.confirmText || '').trim() !== '确认导入') {
    return res.status(400).json({ message: '请输入“确认导入”后再覆盖 Profile 配置' })
  }
  if (!req.file) return res.status(400).json({ message: '请上传 Hermes Profile JSON 文件' })
  const extensionError = uploadExtensionError(req.file, jsonUploadExtensions, 'Hermes Profile')
  if (extensionError) return res.status(400).json({ message: extensionError })
  try {
    const profiles = parseImportedBotProfiles(JSON.parse(req.file.buffer.toString('utf8')))
    const preview = botProfileImportPreview(profiles)
    botProfiles = profiles
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: `导入 Hermes Profile 配置 ${profiles.length} 个`,
      category: '系统配置',
      result: '成功',
      metadata: preview
    })
    saveStore()
    res.json({ ok: true, preview, profiles: orderedBotProfiles().map(profileListItem), message: `已导入 ${profiles.length} 个 Hermes Profile 技术配置；作业标准须另行核验后才会作为审核依据。` })
  } catch (err) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '导入 Hermes Profile 配置失败',
      category: '系统配置',
      result: '失败',
      metadata: { message: err.message || 'Profile 文件解析失败' }
    })
    saveStore()
    res.status(400).json({ message: err.message || 'Profile 文件解析失败' })
  }
})

async function respondHermesProfileStatus(req, res, { audit = false } = {}) {
  const runtime = aiRuntimeConfig()
  const webProfiles = orderedBotProfiles().map(profileListItem)
  const checkedAt = nowText()

  if (runtime.provider !== 'hermes') {
    const diagnostic = hermesStatusDiagnostic(runtime)
    const summary = {
      webCount: webProfiles.length,
      remoteCount: 0,
      matchedCount: 0,
      missingCount: webProfiles.length,
      driftCount: 0
    }
    if (audit) {
      appendLog({
        req,
        actor: req.user?.name || '管理员',
        action: '检查 Hermes Profile 接入状态',
        category: '系统配置',
        result: '跳过',
        metadata: {
        checkedAt,
        provider: runtime.provider,
        model: runtime.model,
        apiKeyEnv: runtime.apiKeyEnv,
        apiKeyConfigured: runtime.apiKeyConfigured,
        gatewayConfigured: runtime.gatewayConfigured,
        agentConfigured: runtime.agentConfigured,
        baseUrlConfigured: Boolean(runtime.baseUrl),
        ...summary,
        message: '当前 AI Provider 不是 Hermes。',
          diagnostic
        }
      })
      saveStore()
    }
    return res.json({
      ok: true,
      runtime,
      enabled: false,
      gatewayConfigured: runtime.gatewayConfigured,
      agentConfigured: runtime.agentConfigured,
      checkedAt,
      profiles: webProfiles.map(profile => ({
        id: profile.id,
        code: profile.code,
        name: profile.name,
        hermesName: profile.hermesName,
        matched: false,
        remote: null
      })),
      summary,
      diagnostic,
      message: '当前 AI Provider 不是 Hermes。'
    })
  }

  try {
    const [remoteProfiles, healthResult] = await Promise.all([
      requestHermesProfiles(runtime),
      requestHermesHealth(runtime).then(data => ({ ok: true, data })).catch(err => ({ ok: false, error: err.message || 'Hermes Health 请求失败' }))
    ])
    const hermesHealth = healthResult.ok ? healthResult.data : null
    const diagnostic = hermesStatusDiagnostic(runtime)
    const syncedProfiles = buildHermesSyncedProfiles(remoteProfiles, true)
    const remoteByKey = new Map()
    for (const profile of remoteProfiles) {
      for (const key of [profile.id, profile.code, profile.hermesName, profile.name]) {
        const normalized = String(key || '').trim().toLowerCase()
        if (normalized) remoteByKey.set(normalized, profile)
      }
    }
    const syncedByKey = new Map()
    for (const profile of syncedProfiles) {
      for (const key of [profile.id, profile.code, profile.hermesName, profile.name]) {
        const normalized = String(key || '').trim().toLowerCase()
        if (normalized) syncedByKey.set(normalized, profile)
      }
    }

    const profiles = webProfiles.map(profile => {
      const remote = [profile.id, profile.code, profile.hermesName, profile.name]
        .map(key => remoteByKey.get(String(key || '').trim().toLowerCase()))
        .find(Boolean) || null
      const synced = [profile.id, profile.code, profile.hermesName, profile.name]
        .map(key => syncedByKey.get(String(key || '').trim().toLowerCase()))
        .find(Boolean) || null
      const changedFields = synced ? botProfileChangedFields(synced, profile) : []
      return {
        id: profile.id,
        code: profile.code,
        name: profile.name,
        hermesName: profile.hermesName,
        matched: Boolean(remote),
        drifted: changedFields.length > 0,
        changedFields,
        source: remote ? 'hermes' : 'web-config',
        remote: remote ? {
          id: remote.id || '',
          code: remote.code || '',
          name: remote.name || '',
          hermesName: remote.hermesName || '',
          scope: remote.scope || ''
        } : null
      }
    })

    const matchedCount = profiles.filter(profile => profile.matched).length
    const driftCount = profiles.filter(profile => profile.drifted).length
    const missingProfiles = profiles.filter(profile => !profile.matched).map(profile => profile.name)
    const driftProfiles = profiles.filter(profile => profile.drifted).map(profile => profile.name)
    const summary = {
      webCount: webProfiles.length,
      remoteCount: remoteProfiles.length,
      matchedCount,
      missingCount: webProfiles.length - matchedCount,
      driftCount
    }
    if (audit) {
      appendLog({
        req,
        actor: req.user?.name || '管理员',
        action: '检查 Hermes Profile 接入状态',
        category: '系统配置',
        result: '成功',
        metadata: {
        checkedAt,
        provider: runtime.provider,
        model: runtime.model,
        apiKeyEnv: runtime.apiKeyEnv,
        apiKeyConfigured: runtime.apiKeyConfigured,
        gatewayConfigured: runtime.gatewayConfigured,
        agentConfigured: runtime.agentConfigured,
        baseUrlConfigured: Boolean(runtime.baseUrl),
        ...summary,
        health: hermesHealth,
        healthError: healthResult.ok ? '' : healthResult.error,
        missingProfiles,
        driftProfiles,
          diagnostic
        }
      })
      saveStore()
    }
    res.json({
      ok: true,
      runtime,
      enabled: true,
      gatewayConfigured: runtime.gatewayConfigured,
      agentConfigured: runtime.agentConfigured,
      checkedAt,
      profiles,
      remoteProfiles,
      summary,
      health: hermesHealth,
      healthError: healthResult.ok ? '' : healthResult.error,
      diagnostic,
      message: runtime.agentConfigured
        ? `网页已接入 Hermes Profile ${matchedCount}/${webProfiles.length} 个，待同步差异 ${driftCount} 个。AI 推理已启用。`
        : `网页已接入 Hermes Profile ${matchedCount}/${webProfiles.length} 个，待同步差异 ${driftCount} 个。${aiInferenceDisabledMessage}。`
    })
  } catch (err) {
    const diagnostic = hermesStatusDiagnostic(runtime, err)
    const summary = {
      webCount: webProfiles.length,
      remoteCount: 0,
      matchedCount: 0,
      missingCount: webProfiles.length,
      driftCount: 0
    }
    if (audit) {
      appendLog({
        req,
        actor: req.user?.name || '管理员',
        action: '检查 Hermes Profile 接入状态',
        category: '系统配置',
        result: '失败',
        metadata: {
        checkedAt,
        provider: runtime.provider,
        model: runtime.model,
        apiKeyEnv: runtime.apiKeyEnv,
        apiKeyConfigured: runtime.apiKeyConfigured,
        gatewayConfigured: runtime.gatewayConfigured,
        agentConfigured: runtime.agentConfigured,
        baseUrlConfigured: Boolean(runtime.baseUrl),
        ...summary,
        message: err.message || 'Hermes Profile 状态读取失败',
          diagnostic
        }
      })
      saveStore()
    }
    res.status(502).json({
      ok: false,
      runtime,
      enabled: true,
      gatewayConfigured: runtime.gatewayConfigured,
      agentConfigured: runtime.agentConfigured,
      checkedAt,
      profiles: webProfiles.map(profile => ({
        id: profile.id,
        code: profile.code,
        name: profile.name,
        hermesName: profile.hermesName,
        matched: false,
        source: 'web-config',
        remote: null
      })),
      summary,
      diagnostic,
      message: err.message || 'Hermes Profile 状态读取失败'
    })
  }
}

// 初始载入/自动刷新必须纯读，不写 store、不制造审计噪声。
app.get('/api/profiles/hermes-status', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  respondHermesProfileStatus(req, res, { audit: false }).catch(error => {
    console.error('Hermes Profile 状态读取失败', error)
    if (!res.headersSent) res.status(502).json({ ok: false, message: error.message || '状态读取失败' })
  })
})

// 只有用户明确点击“检查 Profile 接入”才写审计。
app.post('/api/profiles/hermes-status', authMiddleware, requirePermission('manageSystem'), trackedMutation(async (req, res) => {
  await respondHermesProfileStatus(req, res, { audit: true })
}))

function buildHermesSyncedProfiles(remoteProfiles = [], keepRuntimeFlags = true) {
  const currentByKey = new Map()
  for (const profile of botProfiles) {
    for (const key of [profile.id, profile.code, profile.hermesName, profile.name]) {
      const normalized = String(key || '').trim().toLowerCase()
      if (normalized) currentByKey.set(normalized, profile)
    }
  }

  return remoteProfiles.map((remote, index) => {
    const current = [remote.id, remote.code, remote.hermesName, remote.name]
      .map(key => currentByKey.get(String(key || '').trim().toLowerCase()))
      .find(Boolean) || {}
    return normalizeBotProfile({
      ...current,
      id: String(remote.id || current.id || `hermes-${index + 1}`).trim(),
      code: String(remote.code || current.code || `H${String(index + 1).padStart(2, '0')}`).trim(),
      name: String(remote.name || current.name || `Hermes Profile ${index + 1}`).trim(),
      hermesName: String(remote.hermesName || remote.name || current.hermesName || `Hermes-${index + 1}`).trim(),
      scope: String(remote.scope || current.scope || '').trim(),
      standards: cloneProfileStandards(remote.standards || current.standards || []),
      // 技术同步不等于业务审批，同步得到的标准不得直接成为审核依据。
      standardsVerifiedBy: '',
      standardsVerifiedAt: '',
      output: String(remote.output || current.output || '').trim(),
      status: '停用',
      internalEnabled: keepRuntimeFlags ? current.internalEnabled !== false : true,
      marketEnabled: keepRuntimeFlags ? current.marketEnabled !== false : true,
      canInitiate: keepRuntimeFlags ? current.canInitiate === true : index === 0,
      sortOrder: Number(remote.sortOrder || current.sortOrder || index + 1),
      updatedAt: nowText()
    }, index)
  })
}

app.post('/api/profiles/sync-hermes-preview', authMiddleware, requirePermission('manageSystem'), trackedMutation(async (req, res) => {
  const runtime = aiRuntimeConfig()
  if (runtime.provider !== 'hermes') return res.status(400).json({ message: '当前 AI Provider 不是 Hermes，无法同步。' })

  try {
    const remoteProfiles = await requestHermesProfiles(runtime)
    if (remoteProfiles.length === 0) return res.status(400).json({ message: 'Hermes 未返回 Profile。' })
    const profiles = buildHermesSyncedProfiles(remoteProfiles, req.body?.keepRuntimeFlags !== false)
    const validationMessage = validateBotProfileState(profiles)
    if (validationMessage) return res.status(400).json({ message: validationMessage })
    const confirmation = createHermesSyncPreview(req.user?.username || '', req.body?.keepRuntimeFlags !== false)
    const preview = botProfileImportPreview(profiles)
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '生成 Hermes 云端同步预览',
      category: '系统配置',
      result: '成功',
      metadata: {
        remoteCount: remoteProfiles.length,
        changedProfileCount: preview.changedProfileCount,
        changes: preview.changes,
        previewTokenFingerprint: tokenFingerprint(confirmation.token),
        generatedAt: confirmation.generatedAt,
        expiresAt: confirmation.expiresAt
      }
    })
    saveStore()
    res.json({
      ok: true,
      preview,
      previewToken: confirmation.token,
      generatedAt: confirmation.generatedAt,
      expiresAt: confirmation.expiresAt,
      remoteCount: remoteProfiles.length
    })
  } catch (err) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '生成 Hermes 云端同步预览',
      category: '系统配置',
      result: '失败',
      metadata: { message: err.message || 'Hermes Profile 同步预览失败' }
    })
    saveStore()
    res.status(502).json({ message: err.message || 'Hermes Profile 同步预览失败' })
  }
}))

app.post('/api/profiles/sync-hermes', authMiddleware, requirePermission('manageSystem'), trackedMutation(async (req, res) => {
  const runtime = aiRuntimeConfig()
  if (runtime.provider !== 'hermes') return res.status(400).json({ message: '当前 AI Provider 不是 Hermes，无法同步。' })
  if (String(req.body?.confirmText || '').trim() !== '确认同步') {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '同步 Hermes 云端 Profile',
      category: '系统配置',
      result: '拦截',
      metadata: { reason: '未确认同步', previewTokenFingerprint: tokenFingerprint(req.body?.previewToken) }
    })
    saveStore()
    return res.status(400).json({ message: '请先预览差异并确认同步' })
  }
  const confirmation = consumeHermesSyncPreview(req.body?.previewToken, req.user?.username || '')
  if (!confirmation) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '同步 Hermes 云端 Profile',
      category: '系统配置',
      result: '拦截',
      metadata: {
        reason: '同步预览不存在或已过期',
        previewTokenFingerprint: tokenFingerprint(req.body?.previewToken)
      }
    })
    saveStore()
    return res.status(400).json({ message: '同步预览不存在或已超过 10 分钟，请重新生成预览。' })
  }

  try {
    const remoteProfiles = await requestHermesProfiles(runtime)
    if (remoteProfiles.length === 0) return res.status(400).json({ message: 'Hermes 未返回 Profile。' })

    const keepRuntimeFlags = confirmation.keepRuntimeFlags
    const syncedProfiles = buildHermesSyncedProfiles(remoteProfiles, keepRuntimeFlags)
    const preview = botProfileImportPreview(syncedProfiles)

    const validationMessage = validateBotProfileState(syncedProfiles)
    if (validationMessage) return res.status(400).json({ message: validationMessage })

    botProfiles = syncedProfiles
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '同步 Hermes 云端 Profile',
      category: '系统配置',
      result: '成功',
      metadata: {
        remoteCount: remoteProfiles.length,
        profileNames: syncedProfiles.map(profile => profile.name),
        changedProfileCount: preview.changedProfileCount,
        changes: preview.changes,
        previewTokenFingerprint: tokenFingerprint(req.body?.previewToken),
        previewGeneratedAt: confirmation.generatedAt
      }
    })
    saveStore()

    res.json({
      ok: true,
      profiles: orderedBotProfiles().map(profileListItem),
      summary: {
        webCount: syncedProfiles.length,
        remoteCount: remoteProfiles.length,
        matchedCount: syncedProfiles.length,
        missingCount: 0
      },
      message: `已从 Hermes 同步 ${syncedProfiles.length} 个 Profile。`
    })
  } catch (err) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '同步 Hermes 云端 Profile',
      category: '系统配置',
      result: '失败',
      metadata: { message: err.message || '未知错误' }
    })
    saveStore()
    res.status(502).json({ message: err.message || 'Hermes Profile 同步失败' })
  }
}))

app.patch('/api/profiles/:id', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  const profileIndex = botProfiles.findIndex(item => item.id === req.params.id)
  if (profileIndex === -1) return res.status(404).json({ message: '审核机器人不存在' })
  const profile = botProfiles[profileIndex]
  const nextProfile = { ...profile }

  const {
    name,
    hermesName,
    scope,
    output,
    standards,
    status,
    internalEnabled,
    marketEnabled,
    canInitiate,
    sortOrder
  } = req.body || {}
  const standardsVerified = req.body?.standardsVerified === true

  if (name !== undefined) {
    if (String(name).trim().length < 2) return res.status(400).json({ message: '机器人名称不能为空且不少于2个字符' })
    nextProfile.name = String(name).trim()
  }
  if (hermesName !== undefined) nextProfile.hermesName = String(hermesName).trim() || profile.hermesName
  if (scope !== undefined) nextProfile.scope = String(scope).trim()
  if (output !== undefined) nextProfile.output = String(output).trim()
  if (standards !== undefined) {
    const nextStandards = cloneProfileStandards(standards)
    if (nextStandards.length === 0) return res.status(400).json({ message: '请至少保留 1 条作业标准' })
    nextProfile.standards = nextStandards
  }
  if (status !== undefined) {
    nextProfile.status = status === '停用' ? '停用' : '启用'
  }
  if (internalEnabled !== undefined) nextProfile.internalEnabled = Boolean(internalEnabled)
  if (marketEnabled !== undefined) nextProfile.marketEnabled = Boolean(marketEnabled)
  if (profile.id === 'investment' && canInitiate !== undefined) nextProfile.canInitiate = Boolean(canInitiate)
  if (sortOrder !== undefined) nextProfile.sortOrder = Number(sortOrder) || profile.sortOrder
  const changedFields = botProfileChangedFields(nextProfile, profile)
  if (changedFields.length === 0) {
    return res.json({ ...profileListItem(profile, orderedBotProfiles().findIndex(item => item.id === profile.id)), noChange: true })
  }
  nextProfile.updatedAt = nowText()
  const definitionChanged = profileDefinitionHash(nextProfile) !== profileDefinitionHash(profile)
  if (definitionChanged || nextProfile.status === '启用') {
    if (!standardsVerified) {
      return res.status(400).json({ message: '修改或启用 Profile 前须确认完整定义与正式依据已核验' })
    }
    if (cloneProfileStandards(nextProfile.standards).length === 0) {
      return res.status(400).json({ message: '启用 Profile 前须配置作业标准' })
    }
    const verifiedBy = verificationActor(req)
    const verifiedAt = nowText()
    nextProfile.standardsVerifiedBy = verifiedBy
    nextProfile.standardsVerifiedAt = verifiedAt
    nextProfile.definitionVerifiedBy = verifiedBy
    nextProfile.definitionVerifiedAt = verifiedAt
    nextProfile.definitionVerifiedHash = profileDefinitionHash(nextProfile)
  } else if (nextProfile.status !== '启用') {
    nextProfile.standardsVerifiedBy = ''
    nextProfile.standardsVerifiedAt = ''
    nextProfile.definitionVerifiedBy = ''
    nextProfile.definitionVerifiedAt = ''
    nextProfile.definitionVerifiedHash = ''
  }

  const simulatedProfiles = botProfiles.map((item, index) => (
    index === profileIndex ? normalizeBotProfile(nextProfile, index) : item
  ))
  const validationMessage = validateBotProfileState(simulatedProfiles)
  if (validationMessage) return res.status(400).json({ message: validationMessage })
  if (!requireConfirmText(req, res, '保存Profile配置')) return

  botProfiles = simulatedProfiles

  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: `更新审核机器人《${nextProfile.name}》配置（${changedFields.length} 项变更）`,
    category: '系统配置',
    result: '成功',
    metadata: {
      profileId: nextProfile.id,
      profileCode: nextProfile.code,
      profileName: nextProfile.name,
      changedFields
    }
  })
  saveStore()
  const persistedProfile = botProfiles.find(item => item.id === req.params.id)
  res.json(profileListItem(persistedProfile, orderedBotProfiles().findIndex(item => item.id === persistedProfile.id)))
})

app.get('/api/knowledge', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  const profileId = String(req.query.profileId || '').trim()
  const items = profileId
    ? knowledgeEntries.filter(entry => entry.profileId === profileId)
    : knowledgeEntries
  res.json({ items: items.map(knowledgeListItem), profiles: orderedBotProfiles().map(profileListItem) })
})

app.get('/api/knowledge/export', authMiddleware, requirePermission('manageSystem'), (_req, res) => {
  const headers = ['profileId', 'profileName', 'clauseCode', 'title', 'source', 'content', 'keywords', 'priority', 'status', 'updatedAt']
  const rows = knowledgeEntries.map(entry => [
    entry.profileId,
    profileNameById(entry.profileId),
    entry.clauseCode,
    entry.title,
    entry.source,
    entry.content,
    normalizeKeywords(entry.keywords).join('；'),
    entry.priority,
    entry.status,
    entry.updatedAt
  ])
  const csv = [headers.join(','), ...rows.map(row => row.map(csvEscape).join(','))].join('\n')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="knowledge-entries.csv"')
  res.send(`\uFEFF${csv}`)
})

app.get('/api/knowledge/template', authMiddleware, requirePermission('manageSystem'), (_req, res) => {
  const headers = ['profileId', 'clauseCode', 'title', 'source', 'content', 'keywords', 'priority', 'status']
  // 模板不携带任何伪造条款或来源；导入后仍强制停用待核验。
  const rows = []
  const csv = [headers.join(','), ...rows.map(row => row.map(csvEscape).join(','))].join('\n')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="knowledge-template.csv"')
  res.send(`\uFEFF${csv}`)
})

app.post('/api/knowledge/import', authMiddleware, requirePermission('manageSystem'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: '请上传 CSV 文件' })
  const extensionError = uploadExtensionError(req.file, csvUploadExtensions, '知识库导入文件')
  if (extensionError) return res.status(400).json({ message: extensionError })

  let rows
  try {
    rows = parseKnowledgeCsv(req.file.buffer.toString('utf8'))
  } catch (error) {
    return res.status(400).json({ message: error.message || 'CSV 格式无效' })
  }
  if (rows.length === 0) return res.status(400).json({ message: 'CSV 内容为空或格式无效' })
  if (!requireConfirmText(req, res, '导入知识库')) return

  let created = 0
  let updated = 0

  for (const row of rows) {
    const profileId = String(row.profileId || '').trim()
    const clauseCode = String(row.clauseCode || '').trim()
    const title = String(row.title || '').trim()
    const content = String(row.content || '').trim()

    if (!profileId || !botProfiles.some(item => item.id === profileId) || !title || !content) continue

    const target = knowledgeEntries.find(entry => entry.clauseCode === clauseCode && entry.profileId === profileId)
    const nextData = {
      profileId,
      clauseCode: clauseCode || `${botProfiles.find(item => item.id === profileId)?.code || 'KN'}-${String(Date.now()).slice(-4)}`,
      title,
      source: String(row.source || '').trim(),
      content,
      keywords: normalizeKeywords(row.keywords || ''),
      priority: ['高', '中', '低'].includes(String(row.priority).trim()) ? String(row.priority).trim() : '中',
      status: '停用',
      sourceVerifiedBy: '',
      sourceVerifiedAt: '',
      updatedAt: nowText()
    }

    if (target) {
      Object.assign(target, nextData)
      updated += 1
    } else {
      knowledgeEntries.unshift(normalizeKnowledgeEntry({ id: `K${Date.now()}${crypto.randomBytes(2).toString('hex')}`, ...nextData }))
      created += 1
    }
  }

  logs.unshift({ id: `L${Date.now()}`, actor: req.user?.name || '管理员', action: `导入知识条款 ${created} 条，更新 ${updated} 条`, at: nowText() })
  saveStore()
  res.json({ created, updated, total: created + updated })
})

app.post('/api/knowledge/draft', authMiddleware, requirePermission('manageSystem'), upload.single('file'), trackedMutation(async (req, res) => {
  const { profileId = '', sourceName = '' } = req.body || {}
  const profile = botProfiles.find(item => item.id === String(profileId).trim())
  if (!profile) return res.status(400).json({ message: '请选择有效的专业' })
  if (!req.file) return res.status(400).json({ message: '请上传制度文件' })
  const extensionError = uploadExtensionError(req.file, knowledgeDraftExtensions, '制度文件')
  if (extensionError) return res.status(400).json({ message: extensionError })

  const fileName = safeFileName(normalizeUploadName(req.file.originalname))
  const extracted = await extractFileTextIsolated(req.file, fileName)
  const content = extracted.text || extracted.textPreview || ''
  if (!content.trim()) {
    return res.status(400).json({ message: extracted.extractionError || '文件未提取到可用正文' })
  }

  const drafts = buildKnowledgeDrafts(profile, String(sourceName || fileName).trim() || fileName, content)
  if (drafts.length === 0) return res.status(400).json({ message: '未提取到可生成条款的有效内容' })

  res.json({
    drafts,
    file: {
      name: fileName,
      extractionStatus: extracted.extractionStatus,
      wordCount: extracted.wordCount || 0
    }
  })
}))

app.post('/api/knowledge', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  const {
    profileId,
    clauseCode,
    title,
    source = '',
    content = '',
    keywords = [],
    priority = '中',
    status = '停用',
    sourceVerified = false
  } = req.body || {}

  if (!profileId || !botProfiles.some(item => item.id === profileId)) {
    return res.status(400).json({ message: '请选择有效的专业' })
  }
  if (!title || title.trim().length < 2) return res.status(400).json({ message: '条款标题不能为空且不少于2个字符' })
  if (!content || content.trim().length < 6) return res.status(400).json({ message: '条款内容不能为空且不少于6个字符' })
  const nextStatus = status === '启用' ? '启用' : '停用'
  const normalizedSource = String(source || '').trim()
  if (nextStatus === '启用' && (sourceVerified !== true || !normalizedSource)) {
    return res.status(400).json({ message: '启用知识条款必须确认正式来源' })
  }

  const nextClauseCode = normalizeClauseCode(clauseCode) || generateKnowledgeClauseCode(profileId)
  const conflictEntry = findKnowledgeEntryByClauseCode(profileId, nextClauseCode)
  if (conflictEntry) {
    return res.status(409).json({ message: `条款编号 ${nextClauseCode} 已存在，请更换后重试` })
  }
  if (!requireConfirmText(req, res, '新增知识条款')) return

  const entry = normalizeKnowledgeEntry({
    id: `K${Date.now()}`,
    profileId,
    clauseCode: nextClauseCode,
    title: title.trim(),
    source: normalizedSource,
    content: content.trim(),
    keywords,
    priority,
    status: nextStatus,
    sourceVerifiedBy: nextStatus === '启用' ? verificationActor(req) : '',
    sourceVerifiedAt: nextStatus === '启用' ? nowText() : '',
    updatedAt: nowText()
  })

  knowledgeEntries.unshift(entry)
  logs.unshift({ id: `L${Date.now()}`, actor: req.user?.name || '管理员', action: `新增知识条款《${entry.title}》`, at: nowText() })
  saveStore()
  res.status(201).json(knowledgeListItem(entry))
})

app.post('/api/knowledge/bulk', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  if (items.length === 0) return res.status(400).json({ message: '请提供待导入条款' })

  const reservedKeys = new Set()
  const invalidItems = []
  const conflictItems = []
  const preparedItems = []

  for (const [index, raw] of items.entries()) {
    const profileId = String(raw.profileId || '').trim()
    const title = String(raw.title || '').trim()
    const content = String(raw.content || '').trim()

    if (!profileId || !botProfiles.some(item => item.id === profileId)) {
      invalidItems.push({ index, clauseCode: normalizeClauseCode(raw.clauseCode), title, reason: '专业无效' })
      continue
    }
    if (title.length < 2) {
      invalidItems.push({ index, clauseCode: normalizeClauseCode(raw.clauseCode), title, reason: '标题不少于2个字符' })
      continue
    }
    if (content.length < 6) {
      invalidItems.push({ index, clauseCode: normalizeClauseCode(raw.clauseCode), title, reason: '内容不少于6个字符' })
      continue
    }

    const clauseCode = normalizeClauseCode(raw.clauseCode) || generateKnowledgeClauseCode(profileId, reservedKeys)
    const clauseKey = knowledgeClauseKey(profileId, clauseCode)
    const existedEntry = findKnowledgeEntryByClauseCode(profileId, clauseCode)

    if (reservedKeys.has(clauseKey)) {
      conflictItems.push({ index, profileId, clauseCode, title, reason: '本次导入草稿存在重复编号' })
      continue
    }

    if (existedEntry) {
      conflictItems.push({ index, profileId, clauseCode, title, reason: `与现有条款《${existedEntry.title}》编号重复` })
      continue
    }

    reservedKeys.add(clauseKey)
    preparedItems.push({
      profileId,
      clauseCode,
      title,
      source: String(raw.source || '').trim(),
      content,
      keywords: raw.keywords || [],
      priority: raw.priority || '中',
      // 批量导入只创建待审草稿，绝不信任输入的“启用”。
      status: '停用'
    })
  }

  if (invalidItems.length > 0) {
    return res.status(400).json({
      message: '存在无效草稿，请完善标题、内容和专业后重试',
      invalidItems
    })
  }

  if (conflictItems.length > 0) {
    return res.status(409).json({
      message: '存在重复条款编号，请修改后再导入',
      conflictItems
    })
  }
  if (!requireConfirmText(req, res, '批量新增知识条款')) return

  const createdEntries = []
  for (const raw of preparedItems) {
    const entry = normalizeKnowledgeEntry({
      id: `K${Date.now()}${crypto.randomBytes(2).toString('hex')}`,
      profileId: raw.profileId,
      clauseCode: raw.clauseCode,
      title: raw.title,
      source: raw.source,
      content: raw.content,
      keywords: raw.keywords || [],
      priority: raw.priority || '中',
      status: '停用',
      sourceVerifiedBy: '',
      sourceVerifiedAt: '',
      updatedAt: nowText()
    })
    knowledgeEntries.unshift(entry)
    createdEntries.push(entry)
  }

  if (createdEntries.length === 0) return res.status(400).json({ message: '没有可导入的有效条款' })

  logs.unshift({ id: `L${Date.now()}`, actor: req.user?.name || '管理员', action: `批量新增知识条款 ${createdEntries.length} 条`, at: nowText() })
  saveStore()
  res.status(201).json({ created: createdEntries.length, items: createdEntries.map(knowledgeListItem) })
})

app.post('/api/knowledge/bulk-status', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(item => String(item).trim()).filter(Boolean) : []
  const nextStatus = req.body?.status === '停用' ? '停用' : '启用'
  if (ids.length === 0) return res.status(400).json({ message: '请至少选择 1 条知识条款' })
  if (!requireConfirmText(req, res, '批量更新知识状态')) return

  const idSet = new Set(ids)
  const targetEntries = knowledgeEntries.filter(entry => idSet.has(entry.id))
  if (targetEntries.length === 0) return res.status(404).json({ message: '未找到可更新的知识条款' })
  if (nextStatus === '启用' && (
    req.body?.sourceVerified !== true ||
    targetEntries.some(entry => !String(entry.source || '').trim())
  )) {
    return res.status(400).json({ message: '批量启用知识条款必须确认每条正式来源' })
  }
  const targetTitles = targetEntries.map(entry => entry.title).filter(Boolean)
  const targetIds = targetEntries.map(entry => entry.id).filter(Boolean)

  for (const entry of targetEntries) {
    entry.status = nextStatus
    if (nextStatus === '启用') {
      entry.sourceVerifiedBy = verificationActor(req)
      entry.sourceVerifiedAt = nowText()
    }
    entry.updatedAt = nowText()
  }

  logs.unshift({
    id: `L${Date.now()}`,
    actor: req.user?.name || '管理员',
    action: `批量${nextStatus === '启用' ? '启用' : '停用'}知识条款 ${targetEntries.length} 条`,
    category: '系统配置',
    metadata: {
      kind: 'knowledge-bulk-status',
      status: nextStatus,
      requestedCount: ids.length,
      updatedCount: targetEntries.length,
      knowledgeIds: targetIds,
      titles: targetTitles
    },
    at: nowText()
  })
  saveStore()
  res.json({ ok: true, updated: targetEntries.length, items: targetEntries.map(knowledgeListItem) })
})

app.post('/api/knowledge/bulk-delete', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(item => String(item).trim()).filter(Boolean) : []
  if (ids.length === 0) return res.status(400).json({ message: '请至少选择 1 条知识条款' })
  if (!requireConfirmText(req, res, `删除${ids.length}条知识条款`)) return

  const idSet = new Set(ids)
  const beforeCount = knowledgeEntries.length
  const removedTitles = knowledgeEntries
    .filter(entry => idSet.has(entry.id))
    .map(entry => entry.title)
  const removedIds = knowledgeEntries
    .filter(entry => idSet.has(entry.id))
    .map(entry => entry.id)
  knowledgeEntries = knowledgeEntries.filter(entry => !idSet.has(entry.id))

  const removedCount = beforeCount - knowledgeEntries.length
  if (removedCount === 0) return res.status(404).json({ message: '未找到可删除的知识条款' })

  logs.unshift({
    id: `L${Date.now()}`,
    actor: req.user?.name || '管理员',
    action: `批量删除知识条款 ${removedCount} 条`,
    category: '系统配置',
    metadata: {
      kind: 'knowledge-bulk-delete',
      requestedCount: ids.length,
      removedCount,
      knowledgeIds: removedIds,
      titles: removedTitles
    },
    at: nowText()
  })
  saveStore()
  res.json({ ok: true, removed: removedCount, titles: removedTitles })
})

app.patch('/api/knowledge/:id', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  const entry = knowledgeEntries.find(item => item.id === req.params.id)
  if (!entry) return res.status(404).json({ message: '知识条款不存在' })

  const { profileId, clauseCode, title, source, content, keywords, priority, status, sourceVerified } = req.body || {}
  const nextProfileId = profileId ? String(profileId).trim() : entry.profileId

  if (profileId) {
    if (!botProfiles.some(item => item.id === profileId)) return res.status(400).json({ message: '专业不存在' })
  }
  const nextClauseCode = clauseCode !== undefined
    ? normalizeClauseCode(clauseCode) || entry.clauseCode
    : entry.clauseCode
  const conflictEntry = findKnowledgeEntryByClauseCode(nextProfileId, nextClauseCode, entry.id)
  if (conflictEntry) {
    return res.status(409).json({ message: `条款编号 ${nextClauseCode} 已存在，请更换后重试` })
  }
  const nextTitle = title !== undefined ? String(title).trim() : entry.title
  const nextContent = content !== undefined ? String(content).trim() : entry.content
  const nextSource = source !== undefined ? String(source).trim() : String(entry.source || '').trim()
  const nextStatus = status !== undefined ? (status === '启用' ? '启用' : '停用') : entry.status
  const semanticChanged = [profileId, clauseCode, title, source, content].some(value => value !== undefined)
  if (title !== undefined && nextTitle.length < 2) return res.status(400).json({ message: '条款标题不能为空且不少于2个字符' })
  if (content !== undefined && nextContent.length < 6) return res.status(400).json({ message: '条款内容不能为空且不少于6个字符' })
  if (nextStatus === '启用' && (
    !nextSource ||
    ((status === '启用' || semanticChanged || !knowledgeIsVerified(entry)) && sourceVerified !== true)
  )) {
    return res.status(400).json({ message: '启用或修改生效知识条款必须重新确认正式来源' })
  }
  if (!requireConfirmText(req, res, '保存知识条款')) return

  entry.profileId = nextProfileId
  entry.clauseCode = nextClauseCode
  if (title !== undefined) entry.title = nextTitle
  if (source !== undefined) entry.source = nextSource
  if (content !== undefined) entry.content = nextContent
  if (keywords !== undefined) entry.keywords = normalizeKeywords(keywords)
  if (priority) entry.priority = priority
  entry.status = nextStatus
  if (nextStatus === '启用' && (sourceVerified === true || !knowledgeIsVerified(entry))) {
    entry.sourceVerifiedBy = verificationActor(req)
    entry.sourceVerifiedAt = nowText()
  } else if (nextStatus !== '启用') {
    entry.sourceVerifiedBy = ''
    entry.sourceVerifiedAt = ''
  }
  entry.updatedAt = nowText()

  logs.unshift({ id: `L${Date.now()}`, actor: req.user?.name || '管理员', action: `修改知识条款《${entry.title}》`, at: nowText() })
  saveStore()
  res.json(knowledgeListItem(entry))
})

app.delete('/api/knowledge/:id', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  const idx = knowledgeEntries.findIndex(item => item.id === req.params.id)
  if (idx === -1) return res.status(404).json({ message: '知识条款不存在' })
  if (!requireConfirmText(req, res, '删除知识条款')) return

  const [removed] = knowledgeEntries.splice(idx, 1)
  logs.unshift({ id: `L${Date.now()}`, actor: req.user?.name || '管理员', action: `删除知识条款《${removed.title}》`, at: nowText() })
  saveStore()
  res.json({ ok: true })
})

app.get('/api/logs', authMiddleware, requirePermission('viewLogs'), (req, res) => {
  const filteredLogs = filterLogs(req.query, logFilterOptionsForUser(req.user))
  const limit = clampNumber(req.query.limit, 1, 500, 200)
  const offset = clampNumber(req.query.offset, 0, Math.max(0, filteredLogs.length), 0)
  res.json({
    logs: filteredLogs.slice(offset, offset + limit),
    total: filteredLogs.length,
    limit,
    offset
  })
})

app.get('/api/logs/summary', authMiddleware, requirePermission('viewLogs'), (req, res) => {
  res.json({
    summary: logSummary(req.query, logFilterOptionsForUser(req.user))
  })
})

app.get('/api/logs/options', authMiddleware, requirePermission('viewLogs'), (req, res) => {
  res.json({
    options: logOptions(logFilterOptionsForUser(req.user))
  })
})

app.post('/api/client-errors', authMiddleware, (req, res) => {
  const message = String(req.body?.message || '前端运行时异常').slice(0, 300)
  const source = String(req.body?.source || '').slice(0, 180)
  const stack = String(req.body?.stack || '').slice(0, 1200)
  const route = String(req.body?.route || '').slice(0, 180)
  const errorType = String(req.body?.type || 'runtime').slice(0, 40)
  const clientAppVersion = String(req.body?.appVersion || '').slice(0, 40)
  const clientAppBuildTime = String(req.body?.appBuildTime || '').slice(0, 40)
  const clientAppBuildLabel = String(req.body?.appBuildLabel || '').slice(0, 80)

  appendLog({
    req,
    actor: req.user?.name || req.user?.username || '使用者',
    action: `前端异常：${message}`,
    category: '执行动作',
    result: '失败',
    metadata: {
      kind: 'client-error',
      type: errorType,
      route,
      appVersion: clientAppVersion,
      appBuildTime: clientAppBuildTime,
      appBuildLabel: clientAppBuildLabel,
      source,
      stack
    }
  })
  saveStore()
  res.json({ ok: true })
})

app.post('/api/logs/prune', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  if (!requireConfirmText(req, res, '清理旧日志')) return

  const result = pruneLogs(req.body?.retentionDays)
  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: `清理 ${result.retentionDays} 天前审计日志 ${result.removed} 条`,
    category: '系统配置',
    result: '成功',
    metadata: result
  })
  saveStore()
  res.json({ ok: true, ...result, total: logs.length })
})

app.get('/api/logs/export', authMiddleware, requirePermission('viewLogs'), (req, res) => {
  const header = ['类型', '结果', '操作人', '动作', '动作分组', 'AI调用摘要', 'Hermes配置摘要', '上线确认摘要', '上线账号风险', '上线角色快照', '导出留痕摘要', '公网诊断摘要', '账号安全摘要', '配置变更摘要', '批量操作摘要', '权限变更项数', '权限变更摘要', 'IP', 'User-Agent', '方案名称', '方案ID', '提交人', '方案类型', '导出来源', '时间']
  const rows = filterLogs(req.query, logFilterOptionsForUser(req.user)).map(log => {
    const proposalMeta = proposalMetaForLog(log)
    return [
      detectLogCategory(log),
      log.result || '未记录',
      log.actor || '',
      log.action || '',
      logActionGroup(log),
      aiTraceLogSummary(log),
      hermesConfigLogSummary(log),
      launchApprovalLogSummary(log),
      launchApprovalRiskCsvSummary(log),
      launchApprovalRoleCsvSummary(log),
      exportEventLogSummary(log),
      networkDiagnosticsLogSummary(log),
      accountSecurityLogSummary(log),
      systemConfigChangeSummary(log),
      bulkOperationLogSummary(log),
      String(log.action || '').includes('角色权限矩阵') ? log.metadata?.changeCount || 0 : '',
      rolePermissionChangeSummary(log),
      log.ip || '',
      log.userAgent || '',
      proposalMeta?.title || log.proposalTitle || '',
      log.proposalId || '',
      proposalMeta?.submitter || '',
      proposalMeta?.type || '',
      (String(log.action || '').includes('意见书') || String(log.action || '').includes('预览')) ? exportSourceTextForLog(log) : '',
      log.at || ''
    ]
  })
  const csv = [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\n')
  const actionGroup = String(req.query.actionGroup || '')
  const logType = String(req.query.type || '')
  const filenamePrefix = actionGroup === 'Hermes配置'
    ? 'logs-hermes-config'
    : actionGroup === '上线确认'
      ? 'logs-launch-approval-risk-role'
      : actionGroup === '公网诊断'
        ? 'logs-network-diagnostics'
        : actionGroup === '批量操作'
          ? 'logs-bulk-operation'
          : actionGroup === 'AI调用'
            ? 'logs-ai-review-trace'
            : actionGroup === '导出'
              ? 'logs-export-events'
              : logType === '账号安全'
                ? 'logs-account-security'
                : 'logs'
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filenamePrefix}-${Date.now()}.csv"`)
  res.send(`\ufeff${csv}`)
})

app.get('/api/rules', authMiddleware, requirePermission('manageSystem'), (_req, res) => {
  res.json({ rules, reminderConfig })
})

app.get('/api/role-permissions', authMiddleware, requirePermission('manageSystem'), (_req, res) => {
  res.json({
    roles: [...assignableUserRoles],
    permissions: permissionCatalog,
    defaultRolePermissions: normalizeRolePermissions(defaultRolePermissions),
    rolePermissions: normalizeRolePermissions(rolePermissions),
    roleImpact: rolePermissionImpact(),
    latestRolePermissionUpdate: latestRolePermissionUpdate()
  })
})

app.patch('/api/role-permissions', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  if (!requireAdministrator(req, res, '修改角色权限矩阵')) return
  const previousRolePermissions = normalizeRolePermissions(rolePermissions)
  let nextRolePermissions
  try {
    nextRolePermissions = normalizeRolePermissions(req.body?.rolePermissions, { strict: true })
  } catch (error) {
    return res.status(400).json({ message: error.message || '角色权限矩阵不安全' })
  }
  const diff = rolePermissionDiff(nextRolePermissions, previousRolePermissions)
  if (diff.changeCount === 0) {
    return res.json({
      ok: true,
      noChange: true,
      roles: [...assignableUserRoles],
      permissions: permissionCatalog,
      defaultRolePermissions: normalizeRolePermissions(defaultRolePermissions),
      rolePermissions: previousRolePermissions,
      roleImpact: rolePermissionImpact(),
      latestRolePermissionUpdate: latestRolePermissionUpdate()
    })
  }
  if (!requireConfirmText(req, res, '保存权限矩阵')) return
  rolePermissions = nextRolePermissions
  const changedRoles = Object.keys(diff.changes || {})
  const revokedSessionCount = revokeTokensByRoles(changedRoles, req.user?.username)
  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: `更新角色权限矩阵（${diff.changeCount} 项变更）`,
    category: '系统配置',
    result: '成功',
    metadata: {
      changeCount: diff.changeCount,
      changes: diff.changes,
      revokedSessionCount,
      roleImpact: rolePermissionImpact()
    }
  })
  saveStore()
  res.json({
    ok: true,
    roles: [...assignableUserRoles],
    permissions: permissionCatalog,
    defaultRolePermissions: normalizeRolePermissions(defaultRolePermissions),
    rolePermissions,
    roleImpact: rolePermissionImpact(),
    latestRolePermissionUpdate: latestRolePermissionUpdate(),
    revokedSessionCount
  })
})

app.get('/api/system-config', authMiddleware, requirePermission('manageSystem'), (_req, res) => {
  const managedConfig = deploymentManagedSystemConfig()
  res.json({
    config: systemConfigForResponse(systemConfig),
    managedConfig,
    managedFields: [...deploymentManagedSystemFields],
    runtime: {
      service: 'first-service-review-system',
      port: String(port),
      publicDomain: systemConfig.publicDomain,
      publicIp: systemConfig.publicIp,
      dataStore: storeFile,
      filesDir,
      ai: aiRuntimeConfig()
    },
    latestAiAdapterTest: latestAiAdapterTest()
  })
})

app.get('/api/network-diagnostics', authMiddleware, requirePermission('manageSystem'), async (_req, res) => {
  res.json({ diagnostics: await networkDiagnosticsSummary() })
})

app.post('/api/network-diagnostics', authMiddleware, requirePermission('manageSystem'), trackedMutation(async (req, res) => {
  const previewConfig = normalizeSystemConfig({ ...systemConfig, ...(req.body?.config || req.body || {}) })
  const diagnostics = await networkDiagnosticsSummary(previewConfig)
  if (req.body?.audit !== false) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: `公网解析诊断（${diagnostics.ok ? '通过' : '需处理'}）`,
      category: '系统配置',
      result: diagnostics.ok ? '成功' : '失败',
      metadata: {
        domain: diagnostics.domain,
        expectedIp: diagnostics.expectedIp,
        resolvedIps: diagnostics.resolvedIps,
        message: diagnostics.message
      }
    })
    saveStore()
  }
  res.json({ diagnostics })
}))

app.patch('/api/system-config', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  if (!requireConfirmText(req, res, '保存系统配置')) return

  const submittedConfig = req.body?.config || req.body || {}
  const ignoredTrustedLoginIps = splitIpWhitelist(submittedConfig.trustedLoginIps).filter(item => !net.isIP(item))
  const managedConfig = deploymentManagedSystemConfig()
  const ignoredManagedFields = ignoredDeploymentManagedFields(submittedConfig)
  // 运行态固定项不从请求读入，也不让旧 store 中的 local/开发地址阻断
  // 会话、限流、上传等可编辑安全配置保存。
  const editableSubmittedConfig = Object.fromEntries(
    Object.entries(submittedConfig).filter(([key]) => !deploymentManagedSystemFields.includes(key))
  )
  const nextSystemConfig = {
    ...normalizeSystemConfig({ ...systemConfig, ...editableSubmittedConfig }),
    ...managedConfig
  }
  try {
    validateAiRuntimeBoundary({
      provider: nextSystemConfig.aiProvider,
      baseUrl: nextSystemConfig.aiBaseUrl,
      apiKeyEnv: nextSystemConfig.aiApiKeyEnv
    })
  } catch (error) {
    return res.status(400).json({ message: error.message })
  }
  systemConfig = nextSystemConfig
  // 修改业务配置不得清空认证限流状态，防止借配置更新绕过锁定。
  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: '更新系统运行与账号安全配置',
    category: '系统配置',
    result: '成功',
    metadata: {
      sessionTtlMinutes: systemConfig.sessionTtlMinutes,
      maxLoginFailures: systemConfig.maxLoginFailures,
      loginLockMinutes: systemConfig.loginLockMinutes,
      inactiveLoginDays: systemConfig.inactiveLoginDays,
      sharedLoginIpAccountThreshold: systemConfig.sharedLoginIpAccountThreshold,
      maxFileSizeMb: systemConfig.maxFileSizeMb,
      maxUploadFiles: systemConfig.maxUploadFiles,
      trustedLoginIps: systemConfig.trustedLoginIps,
      ignoredTrustedLoginIps,
      aiProvider: systemConfig.aiProvider,
      aiModel: systemConfig.aiModel
    }
  })
  saveStore()
  res.json({
    ok: true,
    config: systemConfigForResponse(systemConfig),
    managedConfig,
    managedFields: [...deploymentManagedSystemFields],
    ignoredManagedFields,
    ignoredTrustedLoginIps,
    runtime: { ai: aiRuntimeConfig() },
    latestAiAdapterTest: latestAiAdapterTest()
  })
})

app.post('/api/launch-approvals', authMiddleware, requirePermission('manageSystem'), trackedMutation(async (req, res) => {
  const summary = req.body?.summary || {}
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  const passed = Number(summary.passed ?? items.filter(item => item?.status === '通过').length)
  const total = Number(summary.total ?? items.length)
  const issueCount = items.filter(item => item?.status !== '通过').length
  const accountRisk = launchAccountRiskSummary()
  const networkReadiness = await networkLaunchReadiness()
  const backupReadiness = await backupSnapshotLaunchReadiness()
  const aiReadiness = aiLaunchReadiness()
  const hermesReadiness = hermesProfileLaunchReadiness()

  if (accountRisk.riskCount > 0) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '生成上线确认记录',
      category: '系统配置',
      result: '拦截',
      metadata: {
        reason: '账号风险尚未收口',
        passed: Number.isFinite(passed) ? passed : 0,
        total: Number.isFinite(total) ? total : items.length,
        issueCount: issueCount + 1,
        riskSummary: accountRisk
      }
    })
    saveStore()
    return res.status(400).json({
      ok: false,
      message: `账号风险尚未收口：默认密码 ${accountRisk.defaultPassword} 个，需改密 ${accountRisk.mustChangePassword} 个，登录锁定 ${accountRisk.loginLocked} 个。`,
      riskSummary: accountRisk
    })
  }

  if (!networkReadiness.ok) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '生成上线确认记录',
      category: '系统配置',
      result: '拦截',
      metadata: {
        reason: '公网域名解析未通过',
        detail: networkReadiness.reason,
        passed: Number.isFinite(passed) ? passed : 0,
        total: Number.isFinite(total) ? total : items.length,
        issueCount: issueCount + 1,
        networkDiagnostics: networkReadiness.diagnostics
      }
    })
    saveStore()
    return res.status(400).json({
      ok: false,
      message: `公网域名解析未通过：${networkReadiness.reason}。请点击“刷新公网诊断”，确认域名解析到当前腾讯云公网 IP。`,
      networkDiagnostics: networkReadiness.diagnostics
    })
  }

  if (!backupReadiness.ok) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '生成上线确认记录',
      category: '系统配置',
      result: '拦截',
      metadata: {
        reason: '服务器备份快照未通过',
        detail: backupReadiness.reason,
        passed: Number.isFinite(passed) ? passed : 0,
        total: Number.isFinite(total) ? total : items.length,
        issueCount: issueCount + 1,
        backupSnapshotSummary: backupReadiness.summary,
        latestBackupSnapshot: backupReadiness.latest
      }
    })
    saveStore()
    return res.status(400).json({
      ok: false,
      message: `服务器备份快照未通过：${backupReadiness.reason}。请点击“创建上线快照”，保留 7 天内可回滚版本。`,
      backupSnapshotSummary: backupReadiness.summary,
      latestBackupSnapshot: backupReadiness.latest
    })
  }

  if (!hermesReadiness.ok) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '生成上线确认记录',
      category: '系统配置',
      result: '拦截',
      metadata: {
        reason: 'Hermes Profile 接入未通过',
        detail: hermesReadiness.reason,
        passed: Number.isFinite(passed) ? passed : 0,
        total: Number.isFinite(total) ? total : items.length,
        issueCount: issueCount + 1,
        latestHermesProfileStatusCheck: hermesReadiness.latest
      }
    })
    saveStore()
    return res.status(400).json({
      ok: false,
      message: `Hermes Profile 接入未通过：${hermesReadiness.reason}。请点击“检查 Profile 接入”，确认 24 小时内 8 个一级专业 Profile 全部匹配且无差异。`,
      latestHermesProfileStatusCheck: hermesReadiness.latest
    })
  }

  if (!aiReadiness.ok) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '生成上线确认记录',
      category: '系统配置',
      result: '拦截',
      metadata: {
        reason: 'AI 实测链路未通过',
        detail: aiReadiness.reason,
        passed: Number.isFinite(passed) ? passed : 0,
        total: Number.isFinite(total) ? total : items.length,
        issueCount: issueCount + 1,
        latestAiAdapterTest: aiReadiness.latest
      }
    })
    saveStore()
    return res.status(400).json({
      ok: false,
      message: `AI 实测链路未通过：${aiReadiness.reason}。请点击“测试 AI 连接”，确认 24 小时内返回 Hermes Agent 且未回退。`,
      latestAiAdapterTest: aiReadiness.latest
    })
  }

  if (!items.length || passed !== total || issueCount > 0) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '生成上线确认记录',
      category: '系统配置',
      result: '拦截',
      metadata: {
        reason: '上线检查尚未全部通过',
        passed: Number.isFinite(passed) ? passed : 0,
        total: Number.isFinite(total) ? total : items.length,
        issueCount
      }
    })
    saveStore()
    return res.status(400).json({ ok: false, message: '上线检查尚未全部通过，不能生成上线确认记录。' })
  }

  const approval = {
    id: `LA${Date.now()}${crypto.randomBytes(2).toString('hex')}`,
    actor: req.user?.name || '管理员',
    generatedAt: nowText(),
    refreshedAt: String(req.body?.refreshedAt || ''),
    appVersion: String(req.body?.appVersion || ''),
    appBuildTime: String(req.body?.appBuildTime || ''),
    appBuildLabel: String(req.body?.appBuildLabel || ''),
    passed,
    total,
    riskSummary: accountRisk,
    networkReadiness,
    backupReadiness,
    hermesReadiness,
    aiReadiness,
    items: items.map(item => ({
      label: String(item?.label || ''),
      status: String(item?.status || ''),
      detail: String(item?.detail || ''),
      action: String(item?.action || '')
    })).filter(item => item.label)
  }

  appendLog({
    req,
    actor: approval.actor,
    action: `生成上线确认记录（${passed}/${total} 项通过）`,
    category: '系统配置',
    result: '成功',
    metadata: approval
  })
  saveStore()
  res.json({ ok: true, approval, message: '上线确认记录已写入系统日志。' })
}))

app.post('/api/system-config/ai-test', authMiddleware, requirePermission('manageSystem'), trackedMutation(async (req, res) => {
  const testConfig = normalizeSystemConfig({ ...systemConfig, ...(req.body?.config || {}) })
  const runtime = aiRuntimeConfig(testConfig)
  const startedAt = Date.now()

  if (runtime.provider !== 'local' && !runtime.agentConfigured) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '测试 AI 审核适配器',
      category: '系统配置',
      result: '未执行',
      metadata: {
        provider: runtime.provider,
        model: runtime.model,
        gatewayConfigured: runtime.gatewayConfigured,
        agentConfigured: false,
        mode: 'not-configured',
        fallback: false,
        error: aiInferenceDisabledMessage,
        durationMs: Date.now() - startedAt
      }
    })
    saveStore()
    return res.status(503).json({
      ok: false,
      runtime,
      durationMs: Date.now() - startedAt,
      mode: 'not-configured',
      fallback: false,
      message: aiInferenceDisabledMessage
    })
  }

  if (runtime.provider === 'local' || runtime.fallback) {
    const proposal = buildLocalReview(aiProbeProposal())
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '测试 AI 审核适配器',
      category: '系统配置',
      result: runtime.fallback ? '警告' : '成功',
      metadata: {
        provider: runtime.provider,
        model: runtime.model,
        adapterReady: runtime.adapterReady,
        mode: runtime.fallback ? 'fallback-local' : 'local',
        modeName: runtime.fallback ? aiTraceModeName('fallback-local') : aiTraceModeName('local')
      }
    })
    saveStore()
    return res.json({
      ok: true,
      runtime,
      durationMs: Date.now() - startedAt,
      mode: runtime.fallback ? 'fallback-local' : 'local',
      modeName: runtime.fallback ? aiTraceModeName('fallback-local') : aiTraceModeName('local'),
      fallback: runtime.fallback,
      sample: {
        title: proposal.title,
        result: proposal.summary?.result || '',
        avgScore: Number.isFinite(proposal.summary?.avgScore) ? proposal.summary.avgScore : null,
        opinions: proposal.opinions?.length || 0
      },
      message: runtime.fallback
        ? `外部 AI 配置未就绪，已验证本地回退链路：缺少 Base URL 或 ${runtime.apiKeyEnv}。`
        : '本地规则引擎探测通过。'
    })
  }

  const probe = aiProbeProposal()
  const baseline = buildLocalReview(JSON.parse(JSON.stringify(probe)))
  try {
    const aiResult = await requestExternalAiReview(probe, baseline, runtime)
    const aiMeta = aiResult._meta || {}
    const mode = aiMeta.engine === 'hermes-agent' ? 'hermes-agent' : 'external'
    const merged = mergeAiReviewResult(probe, baseline, aiResult, runtime)
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '测试 AI 审核适配器',
      category: '系统配置',
      result: '成功',
      metadata: {
        provider: runtime.provider,
        model: runtime.model,
        adapterReady: runtime.adapterReady,
        mode,
        modeName: aiTraceModeName(mode),
        engine: aiMeta.engine || '',
        agentProvider: aiMeta.provider || '',
        agentModel: aiMeta.model || '',
        fallback: aiMeta.fallback === true,
        durationMs: Date.now() - startedAt
      }
    })
    saveStore()
    res.json({
      ok: true,
      runtime,
      durationMs: Date.now() - startedAt,
      mode,
      modeName: aiTraceModeName(mode),
      engine: aiMeta.engine || '',
      agentProvider: aiMeta.provider || '',
      agentModel: aiMeta.model || '',
      fallback: aiMeta.fallback === true,
      sample: {
        title: merged.title,
        result: merged.summary?.result || '',
        avgScore: Number.isFinite(merged.summary?.avgScore) ? merged.summary.avgScore : null,
        opinions: merged.opinions?.length || 0
      },
      message: '外部 AI 适配器探测通过，已收到结构化审核 JSON。'
    })
  } catch (err) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '测试 AI 审核适配器',
      category: '系统配置',
      result: '失败',
      metadata: {
        provider: runtime.provider,
        model: runtime.model,
        adapterReady: runtime.adapterReady,
        mode: 'external',
        modeName: aiTraceModeName('external'),
        fallback: false,
        error: err.message || '未知错误',
        durationMs: Date.now() - startedAt
      }
    })
    saveStore()
    res.status(502).json({
      ok: false,
      runtime,
      durationMs: Date.now() - startedAt,
      message: err.message || '外部 AI 适配器探测失败'
    })
  }
}))

app.get('/api/system-backup/download/:ticket', streamBackupDownloadTicket)

// 旧 JSON/Base64 下载入口永久停用；大备份只能通过短期一次性票据原生流式下载。
app.get('/api/system-backup/export', authMiddleware, requirePermission('manageSystem'), (_req, res) => {
  res.status(410).json({ message: 'JSON/Base64 备份已停用，请改用 export-ticket 流式归档' })
})

app.post('/api/system-backup/export-ticket', authMiddleware, requirePermission('manageSystem'), requireExclusiveBackupOperation, async (req, res) => {
  req.backupOperationOwnsAsync = true
  ensureBackupDirectory()
  const filename = `first-service-review-backup-${Date.now()}${BACKUP_ARCHIVE_SUFFIX}`
  const archivePath = path.join(backupsDir, `.export-${process.pid}-${Date.now()}-${crypto.randomBytes(12).toString('hex')}${BACKUP_ARCHIVE_SUFFIX}`)
  let created
  let issued
  try {
    created = await createCurrentBackupArchive(archivePath, req.backupOperationSignal)
    issued = issueBackupDownloadTicket(archivePath, filename, true)
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '生成系统备份流式下载票据',
      category: '系统配置',
      result: '成功',
      metadata: { bytes: created.archiveBytes, fileCount: created.totals.fileCount, expiresAt: issued.response.expiresAt }
    })
    saveStore()
    res.json(issued.response)
  } catch (error) {
    if (issued?.ticket) revokeBackupDownloadTicket(issued.ticket)
    else if (created && fs.existsSync(archivePath)) {
      try { removeOwnedBackupArchive(archivePath, fs.lstatSync(archivePath)) } catch {}
    }
    console.error('生成系统备份下载票据失败', error)
    res.status(backupFailureStatus(error)).json({ message: error.message || '备份生成失败' })
  } finally {
    req.releaseBackupOperation?.()
  }
})

app.post('/api/system-backup/preview', authMiddleware, requirePermission('manageSystem'), requireExclusiveBackupOperation, requireBackupPreviewUploadCapacity, backupFileUpload, async (req, res) => {
  req.backupOperationOwnsAsync = true
  try {
    if (!req.file) return res.status(400).json({ message: '请上传 .firstcare-review-backup.tgz 备份归档' })
    if (!backupArchiveUploadNameAllowed(req.file)) return res.status(400).json({ message: '备份文件扩展名必须是 .tgz 或 .gz' })
    const inspected = await inspectBackupArchive(req.file.path, '', req.backupOperationSignal)
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: '校验系统流式备份归档',
      category: '系统配置',
      result: '成功',
      metadata: inspected.preview
    })
    saveStore()
    res.json({ ok: true, preview: inspected.preview })
  } catch (error) {
    console.error('校验系统流式备份归档失败', error)
    res.status(backupFailureStatus(error)).json({ message: error.message || '备份归档校验失败' })
  } finally {
    cleanupUploadedBackup(req)
    req.releaseBackupOperation?.()
  }
})

app.post('/api/system-backup/restore', authMiddleware, requirePermission('manageSystem'), requireExclusiveBackupOperation, requireBackupRestoreUploadCapacity, backupFileUpload, async (req, res) => {
  req.backupOperationOwnsAsync = true
  try {
    if (String(req.body?.confirmText || '').trim() !== '确认恢复') {
      return res.status(400).json({ message: '请输入“确认恢复”后再执行恢复' })
    }
    if (!req.file) return res.status(400).json({ message: '请上传 .firstcare-review-backup.tgz 备份归档' })
    if (!backupArchiveUploadNameAllowed(req.file)) return res.status(400).json({ message: '备份文件扩展名必须是 .tgz 或 .gz' })
    const result = await restoreArchiveTransaction(req.file.path, req, {
      action: '从上传流式备份归档恢复系统数据',
      metadata: { restoreSource: 'upload' },
      signal: req.backupOperationSignal
    })
    const snapshots = listBackupSnapshots()
    res.json({ ok: true, ...result, snapshots, summary: backupSnapshotSummary(snapshots) })
  } catch (error) {
    console.error('恢复系统流式备份归档失败', error)
    res.status(error.restoreCommitted === true ? 503 : backupFailureStatus(error)).json({
      message: error.message || '系统备份恢复失败',
      recoveryRequired: error.restoreCommitted === true
    })
  } finally {
    cleanupUploadedBackup(req)
    req.releaseBackupOperation?.()
  }
})

app.get('/api/system-backup/snapshots', authMiddleware, requirePermission('manageSystem'), (_req, res) => {
  const snapshots = listBackupSnapshots()
  res.json({ snapshots, summary: backupSnapshotSummary(snapshots) })
})

app.post('/api/system-backup/snapshots', authMiddleware, requirePermission('manageSystem'), requireExclusiveBackupOperation, async (req, res) => {
  if (!requireConfirmText(req, res, '创建备份快照')) return
  req.backupOperationOwnsAsync = true
  let snapshotPath = ''
  try {
    snapshotPath = await writeServerBackupSnapshot('manual-backup', req.backupOperationSignal)
    const snapshotName = path.basename(snapshotPath)
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: `创建服务器本地流式备份快照《${snapshotName}》`,
      category: '系统配置',
      result: '成功',
      metadata: { snapshotName }
    })
    saveStore()
    const snapshots = listBackupSnapshots()
    res.json({ ok: true, snapshotName, snapshots, summary: backupSnapshotSummary(snapshots) })
  } catch (error) {
    if (snapshotPath) {
      try { unlinkSnapshotFile(path.basename(snapshotPath)) } catch {}
    }
    throw error
  } finally {
    req.releaseBackupOperation?.()
  }
})

app.post('/api/system-backup/snapshots/prune', authMiddleware, requirePermission('manageSystem'), requireExclusiveBackupOperation, (req, res) => {
  if (!requireConfirmText(req, res, '清理旧快照')) return
  const result = pruneBackupSnapshots(req.body?.retentionDays)
  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: '清理本地备份快照',
    category: '系统配置',
    result: '成功',
    metadata: { retentionDays: result.retentionDays, removedCount: result.removedCount, removed: result.removed }
  })
  saveStore()
  res.json({ ok: true, ...result, summary: backupSnapshotSummary(result.snapshots) })
})

app.post('/api/system-backup/snapshots/:name/restore', authMiddleware, requirePermission('manageSystem'), requireExclusiveBackupOperation, async (req, res) => {
  if (String(req.body?.confirmText || '').trim() !== '确认恢复') {
    return res.status(400).json({ message: '请输入“确认恢复”后再执行恢复' })
  }
  req.backupOperationOwnsAsync = true
  let snapshotName = ''
  try {
    snapshotName = exactSnapshotName(req.params.name)
    const result = await restoreArchiveTransaction(snapshotArchivePath(snapshotName), req, {
      action: `从本地流式备份快照恢复《${snapshotName}》`,
      metadata: { restoreSource: 'snapshot', snapshotName },
      signal: req.backupOperationSignal
    })
    const snapshots = listBackupSnapshots()
    res.json({ ok: true, snapshotName, ...result, snapshots, summary: backupSnapshotSummary(snapshots) })
  } catch (error) {
    console.error(`从本地流式备份快照恢复失败《${snapshotName || '未验证文件名'}》`, error)
    res.status(error.restoreCommitted === true ? 503 : error?.code === 'ENOENT' ? 404 : backupFailureStatus(error)).json({
      message: error.message || '本地备份快照恢复失败',
      recoveryRequired: error.restoreCommitted === true
    })
  } finally {
    req.releaseBackupOperation?.()
  }
})

app.get('/api/system-backup/snapshots/:name/preview', authMiddleware, requirePermission('manageSystem'), requireExclusiveBackupOperation, async (req, res) => {
  req.backupOperationOwnsAsync = true
  let snapshotName = ''
  try {
    snapshotName = exactSnapshotName(req.params.name)
    const inspected = await inspectBackupArchive(snapshotArchivePath(snapshotName), '', req.backupOperationSignal)
    // GET 预览必须保持无持久副作用，避免巡检或页面刷新改写业务 store。
    res.json({ ok: true, snapshotName, preview: inspected.preview })
  } catch (error) {
    console.error(`预览本地流式备份快照失败《${snapshotName || '未验证文件名'}》`, error)
    res.status(error?.code === 'ENOENT' ? 404 : 400).json({ message: error.message || '本地备份快照预览失败' })
  } finally {
    req.releaseBackupOperation?.()
  }
})

app.post('/api/system-backup/snapshots/:name/download-ticket', authMiddleware, requirePermission('manageSystem'), requireExclusiveBackupOperation, (req, res) => {
  let issued
  try {
    const snapshotName = exactSnapshotName(req.params.name)
    issued = issueBackupDownloadTicket(snapshotArchivePath(snapshotName), snapshotName, false)
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: `生成本地备份快照下载票据《${snapshotName}》`,
      category: '系统配置',
      result: '成功',
      metadata: { snapshotName, expiresAt: issued.response.expiresAt }
    })
    saveStore()
    res.json(issued.response)
  } catch (error) {
    if (issued?.ticket) revokeBackupDownloadTicket(issued.ticket)
    res.status(error?.code === 'ENOENT' ? 404 : 400).json({ message: error.message || '备份快照下载票据生成失败' })
  }
})

app.get('/api/system-backup/snapshots/:name', authMiddleware, requirePermission('manageSystem'), (_req, res) => {
  res.status(410).json({ message: '带长期凭证的快照直下已停用，请改用 download-ticket' })
})

app.delete('/api/system-backup/snapshots/:name', authMiddleware, requirePermission('manageSystem'), requireExclusiveBackupOperation, (req, res) => {
  if (!requireConfirmText(req, res, '删除备份快照')) return
  let name
  try {
    name = exactSnapshotName(req.params.name)
    unlinkSnapshotFile(name)
  } catch (error) {
    return res.status(error?.code === 'ENOENT' ? 404 : 400).json({ message: error.message || '备份快照删除失败' })
  }
  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: `删除本地备份快照《${name}》`,
    category: '系统配置',
    result: '成功',
    metadata: { snapshotName: name }
  })
  saveStore()
  const snapshots = listBackupSnapshots()
  res.json({ ok: true, snapshots, summary: backupSnapshotSummary(snapshots) })
})

app.patch('/api/reminder-config', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  const beforeConfig = reminderConfigSnapshot(reminderConfig)
  const { confirmText: _confirmText, ...submittedConfig } = req.body || {}
  const nextConfig = normalizeReminderConfig({
    ...reminderConfig,
    ...submittedConfig,
    updatedAt: nowText()
  })
  const afterConfig = reminderConfigSnapshot(nextConfig)
  const changes = diffReminderConfig(beforeConfig, afterConfig)
  if (changes.length > 0 && !requireConfirmText(req, res, '保存催办规则')) return
  reminderConfig = nextConfig
  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: `更新自动催办规则配置（${changes.length} 项变更）`,
    category: '系统配置',
    result: changes.length ? '成功' : '无变更',
    metadata: {
      kind: 'reminder-config-update',
      changeCount: changes.length,
      changes,
      before: beforeConfig,
      after: afterConfig
    }
  })
  saveStore()
  res.json({ reminderConfig, changeCount: changes.length, changes })
})

app.post('/api/rules', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  if (!requireConfirmText(req, res, '保存审核规则')) return

  const { category = '通用', name, status = '停用', weight = 10, description = '', basisVerified = false } = req.body || {}
  if (!name || name.trim().length < 2) return res.status(400).json({ message: '规则名称不能为空且不少于2个字符' })
  const nextStatus = status === '启用' ? '启用' : '停用'
  if (nextStatus === '启用' && basisVerified !== true) {
    return res.status(400).json({ message: '启用审核规则必须确认已核验正式制度依据' })
  }

  const rule = {
    id: `R${Date.now()}`,
    category,
    name: name.trim(),
    status: nextStatus,
    weight: Number(weight) || 10,
    description,
    updatedAt: nowText(),
    basisVerifiedBy: nextStatus === '启用' ? verificationActor(req) : '',
    basisVerifiedAt: nextStatus === '启用' ? nowText() : ''
  }
  rules.unshift(rule)
  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: `新增规则《${rule.name}》`,
    category: '系统配置',
    result: '成功',
    metadata: {
      kind: 'rule-create',
      rule: ruleSnapshot(rule)
    }
  })
  saveStore()
  res.status(201).json(rule)
})

app.patch('/api/rules/:id', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  const rule = rules.find(item => item.id === req.params.id)
  if (!rule) return res.status(404).json({ message: '规则不存在' })

  const { category, name, status, weight, description, basisVerified } = req.body || {}
  const beforeRule = ruleSnapshot(rule)
  const nextStatus = status !== undefined ? (status === '启用' ? '启用' : '停用') : rule.status
  const semanticChanged = [category, name, weight, description].some(value => value !== undefined)
  if (nextStatus === '启用' && (
    (status === '启用' || semanticChanged || !ruleIsVerified(rule)) && basisVerified !== true
  )) {
    return res.status(400).json({ message: '启用或修改生效规则必须重新确认已核验正式制度依据' })
  }
  const nextRule = {
    ...rule,
    ...(category ? { category } : {}),
    ...(name ? { name: name.trim() } : {}),
    status: nextStatus,
    ...(weight !== undefined ? { weight: Number(weight) || rule.weight } : {}),
    ...(description !== undefined ? { description } : {}),
    updatedAt: nowText(),
    ...(nextStatus === '启用' && basisVerified === true
      ? { basisVerifiedBy: verificationActor(req), basisVerifiedAt: nowText() }
      : nextStatus !== '启用' || semanticChanged
        ? { basisVerifiedBy: '', basisVerifiedAt: '' }
        : {})
  }
  const afterRule = ruleSnapshot(nextRule)
  const changes = diffRuleSnapshot(beforeRule, afterRule)
  const statusOnlyChange = changes.some(change => change.field === 'status') && changes.length === 1
  if (changes.length > 0 && !requireConfirmText(req, res, statusOnlyChange ? '切换规则状态' : '保存审核规则')) return
  Object.assign(rule, nextRule)

  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: statusOnlyChange
      ? `${afterRule.status === '启用' ? '启用' : '停用'}规则《${rule.name}》`
      : `修改规则《${rule.name}》（${changes.length} 项变更）`,
    category: '系统配置',
    result: changes.length ? '成功' : '无变更',
    metadata: {
      kind: statusOnlyChange ? 'rule-status-update' : 'rule-update',
      changeCount: changes.length,
      changes,
      before: beforeRule,
      after: afterRule
    }
  })
  saveStore()
  res.json({ ...rule, changeCount: changes.length, changes })
})

app.delete('/api/rules/:id', authMiddleware, requirePermission('manageSystem'), (req, res) => {
  const index = rules.findIndex(item => item.id === req.params.id)
  if (index === -1) return res.status(404).json({ message: '规则不存在' })
  if (!requireConfirmText(req, res, '删除规则')) return

  const [rule] = rules.splice(index, 1)
  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: `删除规则《${rule.name}》`,
    category: '系统配置',
    result: '成功',
    metadata: {
      kind: 'rule-delete',
      rule: ruleSnapshot(rule)
    }
  })
  saveStore()
  res.json({ ok: true })
})

app.get('/api/users', authMiddleware, requirePermission('manageUsers'), (_req, res) => {
  res.json({
    users: users.map(userListItem),
    rolePermissions: normalizeRolePermissions(rolePermissions),
    config: {
      inactiveLoginThresholdDays: systemConfig.inactiveLoginDays || defaultSystemConfig().inactiveLoginDays,
      sharedLoginIpAccountThreshold: systemConfig.sharedLoginIpAccountThreshold || defaultSystemConfig().sharedLoginIpAccountThreshold,
      trustedLoginIpCount: normalizeIpWhitelist(systemConfig.trustedLoginIps).length,
      latestPasswordNotice: latestPasswordNoticeSummary()
    }
  })
})

app.post('/api/users/export-audit', authMiddleware, requirePermission('manageUsers'), (req, res) => {
  const { count = 0, filters = {}, riskSummary = {}, defaultPasswordLogUrl = '', exportAuditId = '' } = req.body || {}
  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: `导出账号安全清单 ${Number(count) || 0} 条`,
    category: '账号安全',
    result: '成功',
    metadata: {
      count: Number(count) || 0,
      filters,
      riskSummary,
      defaultPasswordLogUrl,
      exportAuditId
    }
  })
  saveStore()
  res.json({ ok: true })
})

app.post('/api/users/password-change-notice-audit', authMiddleware, requirePermission('manageUsers'), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(id => String(id)) : []
  const source = String(req.body?.source || '人员管理').trim() || '人员管理'
  const targetUsers = users.filter(user => ids.includes(String(user.id)) && shouldForcePasswordChange(user))
  const auditId = `PWD-NOTICE-${Date.now()}`

  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: `生成账号改密通知文案，涉及 ${targetUsers.length} 个账号（未发送）`,
    category: '账号安全',
    result: '成功',
    metadata: {
      auditId,
      source,
      requestedCount: ids.length,
      noticeCount: 0,
      sentCount: 0,
      draftCount: targetUsers.length,
      affectedAccountCount: targetUsers.length,
      noticeChannel: '复制通知文案',
      deliveryStatus: '未发送',
      targetUsernames: targetUsers.map(user => user.username),
      targetNames: targetUsers.map(user => user.name || user.username),
      skippedCount: Math.max(0, ids.length - targetUsers.length)
    }
  })
  saveStore()
  res.json({
    ok: true,
    auditId,
    count: targetUsers.length,
    sentCount: 0,
    draftCount: targetUsers.length,
    affectedAccountCount: targetUsers.length,
    deliveryStatus: '未发送',
    auditKeyword: '生成账号改密通知文案'
  })
})

app.post('/api/users/trusted-login-ip', authMiddleware, requirePermission('manageUsers'), (req, res) => {
  const ip = normalizeIp(req.body?.ip)
  const action = req.body?.action === 'remove' ? 'remove' : 'add'
  if (!ip) return res.status(400).json({ message: '登录 IP 不能为空' })
  if (!net.isIP(ip)) return res.status(400).json({ message: '登录 IP 格式不正确' })

  const currentTrustedLoginIps = normalizeIpWhitelist(systemConfig.trustedLoginIps)
  const trustedLoginIps = action === 'remove'
    ? currentTrustedLoginIps.filter(item => item !== ip)
    : normalizeIpWhitelist([...currentTrustedLoginIps, ip])
  const changed = trustedLoginIps.length !== currentTrustedLoginIps.length
  if (changed && !requireConfirmText(req, res, '维护可信IP')) return
  systemConfig = normalizeSystemConfig({ ...systemConfig, trustedLoginIps })
  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: `${action === 'remove' ? '移除' : changed ? '添加' : '确认'}可信登录 IP《${ip}》`,
    category: '账号安全',
    result: '成功',
    metadata: { ip, action, changed }
  })
  saveStore()
  res.json({ ok: true, action, changed, trustedLoginIps: systemConfig.trustedLoginIps })
})

app.post('/api/users', authMiddleware, requirePermission('manageUsers'), (req, res) => {
  const { username, password: requestedPassword = '', name, role = '提交人', department = '研发小组', status = '启用' } = req.body || {}
  if (!isAssignableUserRole(role)) return res.status(400).json({ message: '账号角色不合法或不可分配' })
  const normalizedStatus = normalizeUserStatus(status)
  if (!normalizedStatus) return res.status(400).json({ message: '账号状态仅支持启用或停用' })

  const normalizedRole = normalizeUserRole(role)
  if (normalizedRole === '管理员' && !requireAdministrator(req, res, '创建管理员账号')) return
  if (!requireAssignableRole(req, res, normalizedRole, '创建超出权限范围的账号')) return
  if (!username || username.trim().length < 2) return res.status(400).json({ message: '账号不能为空且不少于2个字符' })
  if (!name || name.trim().length < 2) return res.status(400).json({ message: '姓名不能为空且不少于2个字符' })
  const suppliedPassword = String(requestedPassword || '').trim()
  if (normalizedRole !== '管理员' && suppliedPassword) {
    return res.status(400).json({ message: '普通账号初始密码由服务端生成，请勿提交共享密码' })
  }
  if (normalizedRole === '管理员' && !suppliedPassword) {
    return res.status(400).json({ message: '管理员账号必须指定非默认强密码' })
  }
  const temporaryPassword = normalizedRole === '管理员' ? '' : generateTemporaryPassword()
  const password = normalizedRole === '管理员' ? suppliedPassword : temporaryPassword
  const strengthMessage = passwordStrengthMessage(password)
  if (strengthMessage) return res.status(400).json({ message: strengthMessage })
  if (isKnownDefaultPassword(password)) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: `新增账号《${name.trim()}》被拒绝：默认密码`,
      category: '账号安全',
      result: '拒绝',
      metadata: {
        targetUsername: username.trim(),
        targetRole: normalizedRole,
        reason: '账号不能使用已知默认密码'
      }
    })
    saveStore()
    return res.status(400).json({ message: '账号不能使用系统默认密码' })
  }
  if (users.some(user => usernameIdentityKey(user.username) === usernameIdentityKey(username))) {
    return res.status(409).json({ message: '账号已存在，用户名不区分大小写' })
  }
  if (!requireConfirmText(req, res, '新增账号')) return

  const user = {
    id: `U${Date.now()}`,
    username: username.trim(),
    passwordHash: hashPassword(password),
    name: name.trim(),
    role: normalizedRole,
    department: String(department || '').trim() || '研发小组',
    status: normalizedStatus,
    mustChangePassword: normalizedRole !== '管理员',
    ...(normalizedRole === '管理员' ? {} : { temporaryCredentialIssuedAt: nowText() }),
    createdAt: nowText()
  }
  users.push(user)
  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: `新增账号《${user.name}》`,
    category: '账号安全',
    result: '成功',
    metadata: {
      targetUsername: user.username,
      targetRole: user.role,
      mustChangePassword: user.mustChangePassword === true
    }
  })
  saveStore()
  res.set('Cache-Control', 'no-store').status(201).json({ ...userListItem(user), temporaryPassword: temporaryPassword || undefined })
})

app.patch('/api/users/:id', authMiddleware, requirePermission('manageUsers'), (req, res) => {
  const user = users.find(item => item.id === req.params.id)
  if (!user) return res.status(404).json({ message: '账号不存在' })
  if (!requireManageableUser(req, res, user, '修改超出权限范围的账号')) return

  const previousUsername = user.username
  const previousRole = user.role
  const previousStatus = user.status
  const { username, password, name, role, department, status, mustChangePassword } = req.body || {}
  const normalizedUsername = username !== undefined ? String(username || '').trim() : ''
  const normalizedName = name !== undefined ? String(name || '').trim() : ''
  const normalizedDepartment = department !== undefined ? String(department || '').trim() : ''
  if (role !== undefined && !isAssignableUserRole(role)) {
    return res.status(400).json({ message: '账号角色不合法或不可分配' })
  }
  const normalizedStatus = status !== undefined ? normalizeUserStatus(status) : ''
  if (status !== undefined && !normalizedStatus) {
    return res.status(400).json({ message: '账号状态仅支持启用或停用' })
  }
  if (mustChangePassword !== undefined && typeof mustChangePassword !== 'boolean') {
    return res.status(400).json({ message: '下次登录改密标记必须为布尔值' })
  }
  if (username !== undefined && normalizedUsername.length < 2) {
    return res.status(400).json({ message: '账号不能为空且不少于2个字符' })
  }
  if (name !== undefined && normalizedName.length < 2) {
    return res.status(400).json({ message: '姓名不能为空且不少于2个字符' })
  }
  if (department !== undefined && !normalizedDepartment) {
    return res.status(400).json({ message: '部门不能为空' })
  }
  if (normalizedUsername && users.some(item => item.id !== user.id && usernameIdentityKey(item.username) === usernameIdentityKey(normalizedUsername))) {
    return res.status(409).json({ message: '账号已存在，用户名不区分大小写' })
  }

  const nextRole = role !== undefined ? normalizeUserRole(role) : user.role
  const nextStatus = status !== undefined ? normalizedStatus : user.status
  if (nextStatus === '启用' && !isAssignableUserRole(nextRole)) {
    return res.status(400).json({ message: '遗留角色账号需先分配有效角色才能启用' })
  }
  if ((user.role === '管理员' || nextRole === '管理员') && !requireAdministrator(req, res, '修改管理员账号')) return
  const roleChanged = role !== undefined && nextRole !== user.role
  const editingSelf = usernameIdentityKey(previousUsername) === usernameIdentityKey(req.user?.username)
  if (roleChanged && editingSelf && normalizeUserRole(req.user?.role) !== '管理员') {
    if (!requireAdministrator(req, res, '修改当前账号角色')) return
  }
  if (roleChanged && !requireAssignableRole(req, res, nextRole, '分配超出权限范围的账号角色')) return
  const profileChanged = [
    username !== undefined && normalizedUsername !== user.username,
    password !== undefined && String(password || '') !== '',
    name !== undefined && normalizedName !== user.name,
    roleChanged,
    department !== undefined && normalizedDepartment !== String(user.department || '')
  ].some(Boolean)
  const statusChanged = status !== undefined && nextStatus !== user.status
  const mustChangePasswordChanged = mustChangePassword !== undefined && user.role !== '管理员' && Boolean(mustChangePassword) !== Boolean(user.mustChangePassword)
  if (profileChanged && !requireConfirmText(req, res, '保存账号资料')) return
  if (!profileChanged && statusChanged && !requireConfirmText(req, res, '切换账号状态')) return
  if (!profileChanged && !statusChanged && mustChangePasswordChanged && mustChangePassword === true && !requireConfirmText(req, res, '要求账号改密')) return
  const willDeactivateLastAdmin = user.role === '管理员' && user.status !== '停用' && (
    nextRole !== '管理员' || nextStatus === '停用'
  ) && activeAdminCount(users, user.id) === 0

  if (willDeactivateLastAdmin) {
    return res.status(400).json({ message: '至少需要保留 1 个启用状态的管理员账号' })
  }

  if (nextRole === '管理员' && mustChangePassword === true) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: `要求管理员账号《${user.name}》下次登录改密被拒绝`,
      category: '账号安全',
      result: '拒绝',
      metadata: {
        targetUsername: user.username,
        targetRole: nextRole,
        previousUsername,
        reason: '管理员账号不支持自助强制改密，请由人员管理员设置非默认强密码'
      }
    })
    saveStore()
    return res.status(400).json({ message: '管理员账号不支持要求下次登录改密，请直接设置非默认强密码' })
  }

  if (normalizedUsername) user.username = normalizedUsername
  if (password) {
    if (nextRole !== '管理员') {
      return res.status(400).json({ message: '普通账号请使用重置密码操作生成一次性临时密码' })
    }
    const strengthMessage = passwordStrengthMessage(password)
    if (strengthMessage) return res.status(400).json({ message: strengthMessage })
    if (nextRole === '管理员' && isKnownDefaultPassword(password)) {
      appendLog({
        req,
        actor: req.user?.name || '管理员',
        action: `修改管理员账号《${user.name}》密码被拒绝：默认密码`,
        category: '账号安全',
        result: '拒绝',
        metadata: {
          targetUsername: user.username,
          targetRole: nextRole,
          previousUsername,
          reason: '管理员账号不能使用系统默认密码'
        }
      })
      saveStore()
      return res.status(400).json({ message: '管理员账号不能使用系统默认密码' })
    }
    user.passwordHash = hashPassword(password)
    user.mustChangePassword = nextRole !== '管理员'
    user.passwordUpdatedAt = nowText()
    delete user.password
  }
  if (normalizedName) user.name = normalizedName
  if (role !== undefined) user.role = normalizeUserRole(role)
  if (normalizedDepartment) user.department = normalizedDepartment
  if (status !== undefined) user.status = normalizedStatus
  if (mustChangePassword !== undefined) {
    user.mustChangePassword = user.role !== '管理员' && Boolean(mustChangePassword)
    revokeTokensByUsername(user.username)
  }
  if (user.role === '管理员') user.mustChangePassword = false

  if (
    previousUsername !== user.username ||
    previousRole !== user.role ||
    previousStatus !== user.status ||
    password ||
    mustChangePassword !== undefined
  ) {
    revokeTokensByUsername(previousUsername)
    if (previousUsername !== user.username) revokeTokensByUsername(user.username)
  }

  const passwordActionText = mustChangePassword === true ? '，要求下次登录改密' : ''
  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: `修改账号《${user.name}》${passwordActionText}`,
    category: '账号安全',
    result: '成功',
    metadata: {
      targetUsername: user.username,
      previousUsername,
      mustChangePassword: user.mustChangePassword === true,
      status: user.status,
      role: user.role
    }
  })
  saveStore()
  res.json(userListItem(user))
})

app.post('/api/users/:id/reset-password', authMiddleware, requirePermission('manageUsers'), (req, res) => {
  const user = users.find(item => item.id === req.params.id)
  if (!user) return res.status(404).json({ message: '账号不存在' })
  if (!requireManageableUser(req, res, user, '重置超出权限范围账号的密码')) return
  if (user.role === '管理员' && !requireAdministrator(req, res, '重置管理员账号密码')) return
  if (!requireConfirmText(req, res, '重置账号密码')) return

  const suppliedPassword = String(req.body?.password || '').trim()
  if (user.role !== '管理员' && suppliedPassword) {
    return res.status(400).json({ message: '普通账号临时密码由服务端生成，请勿提交共享密码' })
  }
  const temporaryPassword = user.role === '管理员' ? '' : generateTemporaryPassword()
  const nextPassword = user.role === '管理员' ? suppliedPassword : temporaryPassword
  const strengthMessage = passwordStrengthMessage(nextPassword)
  if (strengthMessage) return res.status(400).json({ message: strengthMessage })
  if (user.role === '管理员' && (!suppliedPassword || isKnownDefaultPassword(nextPassword))) {
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: `重置管理员账号《${user.name}》密码被拒绝：默认密码`,
      category: '账号安全',
      result: '拒绝',
      metadata: {
        targetUsername: user.username,
        targetRole: user.role,
        reason: '管理员账号重置密码时必须指定非默认强密码'
      }
    })
    saveStore()
    return res.status(400).json({ message: '管理员账号重置密码时必须指定非默认强密码' })
  }

  user.passwordHash = hashPassword(nextPassword)
  delete user.password
  user.mustChangePassword = user.role !== '管理员'
  if (user.role === '管理员') {
    delete user.temporaryCredentialIssuedAt
    delete user.temporaryCredentialConsumedAt
  } else {
    user.temporaryCredentialIssuedAt = nowText()
    delete user.temporaryCredentialConsumedAt
  }
  user.passwordUpdatedAt = nowText()
  revokeTokensByUsername(user.username)
  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: `重置账号《${user.name}》密码`,
    category: '账号安全',
    result: '成功',
    metadata: { targetUsername: user.username }
  })
  saveStore()
  res.set('Cache-Control', 'no-store').json({ ok: true, user: userListItem(user), temporaryPassword: temporaryPassword || undefined })
})

app.post('/api/users/:id/unlock-login', authMiddleware, requirePermission('manageUsers'), (req, res) => {
  const user = users.find(item => item.id === req.params.id)
  if (!user) return res.status(404).json({ message: '账号不存在' })
  if (!requireManageableUser(req, res, user, '解除超出权限范围账号的登录锁定')) return
  if (!requireConfirmText(req, res, '解除登录锁定')) return

  const loginFailure = currentLoginFailure(user.username)
  clearLoginFailures(user.username)
  persistAuthRateState()
  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: `解除账号《${user.name}》登录锁定`,
    category: '账号安全',
    result: '成功',
    metadata: {
      targetUsername: user.username,
      previousFailureCount: loginFailure?.count || 0,
      previousLockedUntil: loginFailure?.lockedUntil ? new Date(loginFailure.lockedUntil).toISOString() : ''
    }
  })
  saveStore()
  res.json({ ok: true, user: userListItem(user) })
})

app.post('/api/users/bulk-action', authMiddleware, requirePermission('manageUsers'), (req, res) => {
  const { ids = [], action = '' } = req.body || {}
  const targetIds = Array.isArray(ids) ? ids.map(id => String(id || '')).filter(Boolean) : []
  const uniqueIds = [...new Set(targetIds)]
  const targetUsers = users.filter(user => uniqueIds.includes(user.id))
  if (!targetUsers.length) return res.status(400).json({ message: '请选择需要处理的账号' })
  const unmanageableTarget = targetUsers.find(user => !canManageTargetUser(req, user))
  if (unmanageableTarget && !requireManageableUser(req, res, unmanageableTarget, '批量处理超出权限范围的账号')) return
  const includesAdministrator = targetUsers.some(user => user.role === '管理员')
  if (includesAdministrator && action !== 'requirePasswordChange' && !requireAdministrator(req, res, '批量处理管理员账号')) return
  if (!requireConfirmText(req, res, '批量处理账号')) return
  const auditId = `USER-BULK-${Date.now()}`

  if (action === 'disable') {
    const activeAdminsAfterDisable = users.filter(user => (
      user.role === '管理员' &&
      user.status !== '停用' &&
      !uniqueIds.includes(user.id)
    )).length
    if (activeAdminsAfterDisable === 0) {
      return res.status(400).json({ message: '至少需要保留 1 个启用状态的管理员账号' })
    }

    const changedUsers = targetUsers.filter(user => user.status !== '停用')
    const alreadyDisabledUsers = targetUsers.filter(user => user.status === '停用')
    changedUsers.forEach(user => {
      user.status = '停用'
      revokeTokensByUsername(user.username)
    })
    const skippedCount = targetUsers.length - changedUsers.length
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: `批量停用账号 ${changedUsers.length} 个`,
      category: '账号安全',
      result: '成功',
      metadata: {
        targetUsernames: changedUsers.map(user => user.username),
        requestedCount: targetUsers.length,
        changedCount: changedUsers.length,
        auditId,
        skippedCount,
        skippedAlreadyDisabledCount: alreadyDisabledUsers.length,
        skippedUsernames: alreadyDisabledUsers.map(user => user.username)
      }
    })
    saveStore()
    return res.json({ ok: true, users: targetUsers.map(userListItem), count: targetUsers.length, changedCount: changedUsers.length, skippedCount, skippedAlreadyDisabledCount: alreadyDisabledUsers.length, auditKeyword: '批量停用账号', auditId })
  }

  if (action === 'requirePasswordChange') {
    const changedUsers = targetUsers.filter(user => user.role !== '管理员' && user.mustChangePassword !== true)
    const skippedAdminUsers = targetUsers.filter(user => user.role === '管理员')
    const skippedAlreadyRequiredUsers = targetUsers.filter(user => user.role !== '管理员' && user.mustChangePassword === true)
    changedUsers.forEach(user => {
      user.mustChangePassword = true
      revokeTokensByUsername(user.username)
    })
    const skippedCount = targetUsers.length - changedUsers.length
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: `批量要求账号改密 ${changedUsers.length} 个`,
      category: '账号安全',
      result: '成功',
      metadata: {
        targetUsernames: changedUsers.map(user => user.username),
        requestedCount: targetUsers.length,
        changedCount: changedUsers.length,
        auditId,
        skippedCount,
        skippedAdminCount: skippedAdminUsers.length,
        skippedAlreadyRequiredCount: skippedAlreadyRequiredUsers.length,
        skippedUsernames: [...skippedAdminUsers, ...skippedAlreadyRequiredUsers].map(user => user.username)
      }
    })
    saveStore()
    return res.json({
      ok: true,
      users: targetUsers.map(userListItem),
      count: targetUsers.length,
      changedCount: changedUsers.length,
      skippedCount,
      skippedAdminCount: skippedAdminUsers.length,
      skippedAlreadyRequiredCount: skippedAlreadyRequiredUsers.length,
      auditKeyword: '批量要求账号改密',
      auditId
    })
  }

  if (action === 'unlockLogin') {
    const changedUsers = targetUsers.filter(user => {
      const loginFailure = currentLoginFailure(user.username)
      return Boolean(loginFailure?.lockedUntil && loginFailure.lockedUntil > Date.now())
    })
    const skippedUnlockedUsers = targetUsers.filter(user => !changedUsers.includes(user))
    changedUsers.forEach(user => clearLoginFailures(user.username))
    persistAuthRateState()
    const skippedCount = targetUsers.length - changedUsers.length
    appendLog({
      req,
      actor: req.user?.name || '管理员',
      action: `批量解除登录锁定 ${changedUsers.length} 个`,
      category: '账号安全',
      result: '成功',
      metadata: {
        targetUsernames: changedUsers.map(user => user.username),
        requestedCount: targetUsers.length,
        changedCount: changedUsers.length,
        auditId,
        skippedCount,
        skippedUnlockedCount: skippedUnlockedUsers.length,
        skippedUsernames: skippedUnlockedUsers.map(user => user.username)
      }
    })
    saveStore()
    return res.json({ ok: true, users: targetUsers.map(userListItem), count: targetUsers.length, changedCount: changedUsers.length, skippedCount, skippedUnlockedCount: skippedUnlockedUsers.length, auditKeyword: '批量解除登录锁定', auditId })
  }

  return res.status(400).json({ message: '不支持的批量操作' })
})

app.delete('/api/users/:id', authMiddleware, requirePermission('manageUsers'), (req, res) => {
  const index = users.findIndex(item => item.id === req.params.id)
  if (index === -1) return res.status(404).json({ message: '账号不存在' })
  if (!requireManageableUser(req, res, users[index], '删除超出权限范围的账号')) return
  if (users[index].role === '管理员' && !requireAdministrator(req, res, '删除管理员账号')) return
  if (!requireConfirmText(req, res, '删除账号')) return

  const [user] = users.splice(index, 1)
  const removedLastAdmin = user.role === '管理员' && user.status !== '停用' && activeAdminCount(users) === 0
  if (removedLastAdmin) {
    users.splice(index, 0, user)
    return res.status(400).json({ message: '至少需要保留 1 个启用状态的管理员账号' })
  }

  revokeTokensByUsername(user.username)
  appendLog({
    req,
    actor: req.user?.name || '管理员',
    action: `删除账号《${user.name}》`,
    category: '账号安全',
    result: '成功',
    metadata: { targetUsername: user.username, targetRole: user.role }
  })
  saveStore()
  res.json({ ok: true })
})

app.get('/api/my-proposals', authMiddleware, requirePermission('submitProposal'), (req, res) => {
  const items = proposals
    .filter(item => isProposalSubmitter(req.user, item))
    .map(proposalListItem)
  res.json({ items })
})

app.get('/api/my-proposals/:id', authMiddleware, requirePermission('submitProposal'), (req, res) => {
  const item = proposals.find(p => p.id === req.params.id)
  if (!item) return res.status(404).json({ message: '方案不存在' })
  if (!isProposalSubmitter(req.user, item)) {
    recordPermissionDenial({
      req,
      action: '权限拒绝：查看非本人提交方案',
      metadata: {
        proposalId: item.id
      }
    })
    return res.status(403).json({ message: '当前账号只能查看自己提交的方案' })
  }
  res.json(item)
})

app.get('/api/my-proposals/:id/files/:fileId', authMiddleware, requirePermission('submitProposal'), (req, res) => {
  const item = proposals.find(p => p.id === req.params.id)
  if (!item) return res.status(404).json({ message: '方案不存在' })
  if (!isProposalSubmitter(req.user, item)) {
    recordPermissionDenial({
      req,
      action: '权限拒绝：下载非本人提交方案附件',
      metadata: {
        proposalId: item.id,
        fileId: req.params.fileId,
        submitterUsername: item.submitterUsername || ''
      }
    })
    return res.status(403).json({ message: '当前账号只能下载自己提交方案的附件' })
  }
  const file = (item.files || []).find(f => f.id === req.params.fileId)
  if (!file || !file.storedName) return res.status(404).json({ message: '附件不存在或仅有历史元数据' })
  return downloadStoredAttachment(res, file)
})

app.get('/api/proposals', authMiddleware, requireAnyPermission(['reviewProposal', 'viewLogs']), (_req, res) => res.json({ items: proposals.map(proposalListItem) }))

app.get('/api/proposals/:id', authMiddleware, requirePermission('reviewProposal'), (req, res) => {
  const item = proposals.find(p => p.id === req.params.id)
  if (!item) return res.status(404).json({ message: '方案不存在' })
  res.json(item)
})

app.get('/api/proposals/:id/files/:fileId', authMiddleware, requirePermission('reviewProposal'), (req, res) => {
  const item = proposals.find(p => p.id === req.params.id)
  if (!item) return res.status(404).json({ message: '方案不存在' })
  const file = (item.files || []).find(f => f.id === req.params.fileId)
  if (!file || !file.storedName) return res.status(404).json({ message: '附件不存在或仅有历史元数据' })
  return downloadStoredAttachment(res, file)
})

app.post('/api/proposals', authMiddleware, requirePermission('submitProposal'), requireReviewProfilesReady, requireAttachmentStorageCapacity, proposalFileUpload, trackedMutation(async (req, res) => {
  const { title, type = '内部运营方案', description = '' } = req.body || {}
  const normalizedTitle = typeof title === 'string' ? title.trim() : ''
  const titleLength = [...normalizedTitle].length
  if (titleLength < 2) return res.status(400).json({ message: '方案标题不能为空且不少于2个字' })
  if (titleLength > 120) return res.status(400).json({ message: '方案标题不能超过120个字符' })
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(normalizedTitle)) {
    return res.status(400).json({ message: '方案标题不能包含换行或控制字符' })
  }
  const limitError = uploadLimitError(req.files || [])
  if (limitError) return res.status(400).json({ message: limitError })

  const unsupportedFiles = unsupportedUploadNames(req.files || [])
  if (unsupportedFiles.length > 0) {
    const preview = unsupportedFiles.slice(0, 3).join('、')
    const moreText = unsupportedFiles.length > 3 ? ` 等 ${unsupportedFiles.length} 个文件` : ''
    return res.status(400).json({
      message: `附件格式不支持：${preview}${moreText}。请上传 PDF、DOCX、XLSX、CSV、TSV 或 TXT 文件。`
    })
  }

  const storageReservation = finalizeAttachmentStorageReservation(req, req.files || [])
  if (!storageReservation.ok) {
    if (storageReservation.status === 409) res.setHeader('Retry-After', '5')
    return res.status(storageReservation.status).json({ message: storageReservation.message })
  }
  let files = []
  try {
    const preparedAttachments = await prepareUploadedFiles(req.files || [])
    const attachmentRecords = preparedAttachments.map(item => item.record)
    let item
    let auditLog
    try {
      item = await createProposal({
        title: normalizedTitle,
        type,
        description,
        submitter: req.user?.name || '管理员',
        submitterUsername: req.user?.username || '',
        files: attachmentRecords,
        submissionMode: req.submissionMode
      })

      // AI/解析等所有异步步骤结束后才发布附件；发布附件与原子 store 写入之间
      // 不再 await，SIGTERM 会由 trackedMutation 等到该同步提交段完整结束。
      files = publishPreparedAttachments(preparedAttachments)
      proposals.unshift(item)
      auditLog = {
        id: `L${Date.now()}`,
        actor: item.submitter,
        action: req.submissionMode === 'draft-only'
          ? `保存待配置草稿《${item.title}》（未执行 AI）`
          : `AI调用：提交《${item.title}》并触发${item.robot}审核`,
        category: '执行动作',
        result: aiTraceLogResult(item),
        metadata: req.submissionMode === 'draft-only'
          ? { kind: 'proposal-draft', submissionMode: 'draft-only', aiExecuted: false }
          : aiTraceLogMetadata(item, 'submit'),
        at: nowText(),
        proposalId: item.id,
        proposalTitle: item.title
      }
      logs.unshift(auditLog)
      saveStore()
      res.status(201).json(item)
    } catch (error) {
      if (item) proposals = proposals.filter(proposal => proposal !== item)
      if (auditLog) logs = logs.filter(log => log !== auditLog)
      let storeCommitted = false
      if (item) {
        try {
          const diskStore = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
          storeCommitted = Array.isArray(diskStore.proposals) && diskStore.proposals.some(proposal => proposal.id === item.id)
        } catch {}
      }
      if (!storeCommitted) {
        try {
          removeProposalFiles({ files })
        } catch (cleanupError) {
          console.error('提交失败后清理附件失败', cleanupError)
        }
      }
      throw error
    }
  } finally {
    storageReservation.release()
  }
}))

app.post('/api/proposals/:id/review', authMiddleware, requirePermission('reviewProposal'), trackedMutation(async (req, res) => {
  const item = proposals.find(p => p.id === req.params.id)
  if (!item) return res.status(404).json({ message: '方案不存在' })
  const readiness = aiReviewReadinessState()
  if (!readiness.reviewReady) return res.status(409).json({ message: readiness.message })
  if (!requireConfirmText(req, res, '重新发起AI审核')) return
  await runAiReview(item)
  addTimeline(item, req.user?.name || '管理员', '重新发起 AI 审核', '已根据当前机器人配置重新生成审核意见和汇总意见。')
  logs.unshift({
    id: `L${Date.now()}`,
    actor: req.user?.name || '管理员',
    action: `AI调用：重新发起《${item.title}》AI 并行审核`,
    category: '执行动作',
    result: aiTraceLogResult(item),
    metadata: aiTraceLogMetadata(item, 'manual-rerun'),
    at: nowText(),
    proposalId: item.id,
    proposalTitle: item.title
  })
  saveStore()
  res.json(item)
}))

app.post('/api/proposals/:id/export-events', authMiddleware, requireAnyPermission(['submitProposal', 'reviewProposal']), (req, res) => {
  const item = proposals.find(p => p.id === req.params.id)
  if (!item) return res.status(404).json({ message: '方案不存在' })
  if (item.status === statuses.configurationPending || !item.summary) {
    return res.status(409).json({ message: '待专业配置草稿尚未形成审核意见，不能登记意见书预览或导出' })
  }

  const type = normalizeExportType(req.body?.type)
  const appVersion = String(req.body?.appVersion || '').trim()
  const appBuildTime = String(req.body?.appBuildTime || '').trim()
  const appBuildLabel = String(req.body?.appBuildLabel || appVersion).trim()
  const source = normalizeExportSource(req.body?.source)
  const actor = req.user?.name || '管理员'

  if (!canRecordProposalExportEvent(req.user, item)) {
    appendLog({
      req,
      actor,
      action: `权限拒绝：登记《${item.title}》导出事件`,
      category: '账号安全',
      result: '拒绝',
      metadata: {
        proposalId: item.id,
        proposalTitle: item.title,
        submitter: item.submitter || '',
        source,
        type
      }
    })
    saveStore()
    return res.status(403).json({ message: '当前账号只能登记自己提交方案的导出事件' })
  }
  if (req.body?.bulk === true && !requireConfirmText(req, res, '批量导出Word')) return

  const exportEvent = appendExportEvent(item, {
    type,
    actor,
    at: nowText(),
    appVersion,
    appBuildTime,
    appBuildLabel,
    source
  })
  const actionLabel = exportEvent.type === 'preview'
    ? `预览《${item.title}》意见书`
    : `导出《${item.title}》${exportTypeText(exportEvent.type)}意见书`
  logs.unshift({
    id: `L${Date.now()}`,
    actor,
    action: actionLabel,
    category: '执行动作',
    result: '成功',
    metadata: {
      kind: 'export-event',
      type: exportEvent.type,
      typeText: exportTypeText(exportEvent.type),
      source: exportEvent.source,
      sourceText: exportSourceText(exportEvent.source),
      appVersion: exportEvent.appVersion,
      appBuildTime: exportEvent.appBuildTime,
      appBuildLabel: exportEvent.appBuildLabel,
      exportEventId: exportEvent.id
    },
    at: nowText(),
    source: exportEvent.source,
    proposalId: item.id,
    proposalTitle: item.title
  })
  saveStore()
  res.status(201).json({
    ok: true,
    exportEvent,
    exportEvents: item.exportEvents,
    summary: proposalListItem(item)
  })
})

app.patch('/api/proposals/:id/status', authMiddleware, requirePermission('reviewProposal'), (req, res) => {
  const item = proposals.find(p => p.id === req.params.id)
  if (!item) return res.status(404).json({ message: '方案不存在' })
  if (item.status === statuses.configurationPending) {
    return res.status(409).json({ message: '待专业配置草稿必须先发起 AI 审核，不能通过通用状态接口跳过审核' })
  }
  const nextStatus = String(req.body?.status || '').trim()
  const remark = req.body?.remark || ''
  if (!proposalStatusValues.has(nextStatus)) return res.status(400).json({ message: '方案状态不在允许范围内' })
  if (nextStatus === statuses.passed) return res.status(409).json({ message: '已通过状态只能由完整人工复核后的签发流程生成' })
  if (normalizeExecutionRecord(item.executionRecord).signOff.status === '已签发') {
    return res.status(409).json({ message: '已签发方案不得通过通用状态接口覆盖，请走独立更正流程' })
  }
  if (!requireConfirmText(req, res, '更新方案状态')) return
  item.status = nextStatus
  item.updatedAt = nowText()
  addTimeline(item, req.user?.name || '管理员', `状态更新为${nextStatus}`, remark)
  logs.unshift({
    id: `L${Date.now()}`,
    actor: req.user?.name || '管理员',
    action: `更新《${item.title}》状态为${item.status}`,
    at: nowText(),
    proposalId: item.id,
    proposalTitle: item.title
  })
  saveStore()
  res.json(item)
})

app.post('/api/proposals/bulk-status', authMiddleware, requirePermission('reviewProposal'), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(item => String(item).trim()).filter(Boolean) : []
  const nextStatus = String(req.body?.status || '').trim()
  const remark = String(req.body?.remark || '').trim()
  if (ids.length === 0) return res.status(400).json({ message: '请至少选择 1 个方案' })
  if (!proposalStatusValues.has(nextStatus)) return res.status(400).json({ message: '方案状态不在允许范围内' })
  if (nextStatus === statuses.passed) return res.status(409).json({ message: '已通过状态只能逐项完成人工复核并签发' })
  if (!requireConfirmText(req, res, '批量更新方案状态')) return

  const idSet = new Set(ids)
  const targetItems = proposals.filter(item => idSet.has(item.id))
  if (targetItems.length === 0) return res.status(404).json({ message: '未找到可更新的方案' })
  if (targetItems.some(item => item.status === statuses.configurationPending)) {
    return res.status(409).json({ message: '选择中包含待专业配置草稿，必须先逐项或批量发起 AI 审核' })
  }
  if (targetItems.some(item => normalizeExecutionRecord(item.executionRecord).signOff.status === '已签发')) {
    return res.status(409).json({ message: '选择中包含已签发方案，不得批量覆盖状态' })
  }

  for (const item of targetItems) {
    item.status = nextStatus
    item.updatedAt = nowText()
    addTimeline(item, req.user?.name || '管理员', `批量状态更新为${nextStatus}`, remark)
  }

  logs.unshift({
    id: `L${Date.now()}`,
    actor: req.user?.name || '管理员',
    action: `批量更新方案状态 ${targetItems.length} 个为${nextStatus}`,
    category: '执行动作',
    result: '成功',
    metadata: {
      kind: 'bulk-status',
      requestedCount: ids.length,
      updatedCount: targetItems.length,
      status: nextStatus,
      proposalIds: targetItems.map(item => item.id),
      titles: targetItems.map(item => item.title)
    },
    at: nowText()
  })
  saveStore()
  res.json({ ok: true, updated: targetItems.length, items: targetItems.map(proposalListItem) })
})

app.post('/api/proposals/bulk-review', authMiddleware, requirePermission('reviewProposal'), trackedMutation(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(item => String(item).trim()).filter(Boolean) : []
  if (ids.length === 0) return res.status(400).json({ message: '请至少选择 1 个方案' })
  if (ids.length > 2) return res.status(400).json({ message: '为保证 AI 审核与发布优雅停机，单次最多重新审核 2 个方案' })
  const readiness = aiReviewReadinessState()
  if (!readiness.reviewReady) return res.status(409).json({ message: readiness.message })
  if (!requireConfirmText(req, res, '批量重新审核')) return

  const idSet = new Set(ids)
  const targetItems = proposals.filter(item => idSet.has(item.id))
  if (targetItems.length === 0) return res.status(404).json({ message: '未找到可重新审核的方案' })

  const results = []
  for (const item of targetItems) {
    if (shutdownStarted) {
      results.push({ id: item.id, title: item.title, ok: false, message: '服务正在安全停止，未启动新的 AI 审核' })
      continue
    }
    try {
      await runAiReview(item)
      const trace = latestAiTraceForProposal(item)
      if (item.status !== statuses.review || !item.summary || !trace) {
        throw new Error('AI 审核未形成可追溯汇总，方案仍保持待人工处理')
      }
      addTimeline(item, req.user?.name || '管理员', '批量重新发起 AI 审核', '已根据当前 Hermes Profile 和审核配置重新生成意见。')
      results.push({ id: item.id, title: item.title, ok: true, summary: proposalListItem(item) })
    } catch (err) {
      results.push({ id: item.id, title: item.title, ok: false, message: err.message || '重新审核失败' })
    }
  }

  const completedCount = results.filter(item => item.ok).length
  const failedCount = results.length - completedCount
  const completedTraces = results
    .filter(item => item.ok)
    .map(result => latestAiTraceForProposal(proposals.find(item => item.id === result.id)))
    .filter(Boolean)
  const confirmedSuccessCount = completedTraces.filter(trace => trace.status === 'success' && trace.fallback !== true).length
  const needsHumanReviewCount = completedTraces.filter(trace => trace.status === 'needs-human-review').length
  const fallbackCount = completedTraces.filter(trace => trace.fallback === true || trace.status === 'fallback').length
  logs.unshift({
    id: `L${Date.now()}`,
    actor: req.user?.name || '管理员',
    action: `AI调用：批量重新发起 AI 审核，处理完成 ${completedCount} 个${failedCount ? `，失败 ${failedCount} 个` : ''}`,
    category: '执行动作',
    result: failedCount > 0 ? '失败' : (needsHumanReviewCount > 0 || fallbackCount > 0) ? '待确认' : '成功',
    metadata: {
      kind: 'ai-review-trace',
      bulkKind: 'bulk-ai-review',
      source: 'bulk-rerun',
      requestedCount: ids.length,
      completedCount,
      successCount: completedCount,
      confirmedSuccessCount,
      needsHumanReviewCount,
      failedCount,
      fallbackCount,
      items: results.map(result => {
        const proposal = proposals.find(item => item.id === result.id)
        return {
          id: result.id,
          title: result.title,
          ok: result.ok,
          message: result.message || '',
          ai: result.ok ? aiTraceLogMetadata(proposal, 'bulk-rerun-item') : null
        }
      })
    },
    at: nowText()
  })
  saveStore()
  res.json({
    ok: true,
    requested: ids.length,
    reviewed: completedCount,
    completedCount,
    successCount: completedCount,
    confirmedSuccessCount,
    needsHumanReviewCount,
    failed: failedCount,
    items: results
  })
}))

app.post('/api/proposals/:id/notes', authMiddleware, requirePermission('reviewProposal'), (req, res) => {
  const item = proposals.find(p => p.id === req.params.id)
  if (!item) return res.status(404).json({ message: '方案不存在' })
  const content = String(req.body?.content || '').trim()
  if (content.length < 2) return res.status(400).json({ message: '复核备注不能为空且不少于2个字符' })

  const note = {
    id: `N${Date.now()}${crypto.randomBytes(3).toString('hex')}`,
    actor: req.user?.name || '管理员',
    content,
    at: nowText()
  }
  if (!Array.isArray(item.reviewNotes)) item.reviewNotes = []
  item.reviewNotes.unshift(note)
  item.updatedAt = nowText()
  addTimeline(item, note.actor, '新增复核备注', content)
  logs.unshift({
    id: `L${Date.now()}`,
    actor: note.actor,
    action: `为《${item.title}》新增复核备注`,
    at: nowText(),
    proposalId: item.id,
    proposalTitle: item.title
  })
  saveStore()
  res.status(201).json(item)
})

app.post('/api/proposals/:id/manual-review', authMiddleware, requirePermission('reviewProposal'), (req, res) => {
  const item = proposals.find(p => p.id === req.params.id)
  if (!item) return res.status(404).json({ message: '方案不存在' })
  if (item.status === statuses.configurationPending) {
    return res.status(409).json({ message: '待专业配置草稿尚未完成审核，不能提交人工复核结论' })
  }

  const conclusion = String(req.body?.conclusion || '').trim()
  const basis = normalizeTextList(req.body?.basis)
  const actions = normalizeTextList(req.body?.actions)
  const summary = String(req.body?.summary || '').trim()

  if (!conclusion) return res.status(400).json({ message: '请填写人工复核结论' })
  if (basis.length < 1) return res.status(400).json({ message: '请至少填写 1 条已核验的复核依据' })
  if (actions.length < 1) return res.status(400).json({ message: '请至少填写 1 条明确的后续动作' })
  if (summary.length < 4) return res.status(400).json({ message: '复核摘要不能少于4个字' })
  if (normalizeExecutionRecord(item.executionRecord).signOff.status === '已签发') {
    return res.status(409).json({ message: '已签发方案不得覆盖人工复核记录，请走独立更正流程' })
  }
  if (!requireConfirmText(req, res, '保存人工复核')) return

  item.manualReview = normalizeManualReview({
    conclusion,
    basis,
    actions,
    summary,
    reviewer: req.user?.name || '管理员',
    reviewedAt: nowText()
  })
  item.updatedAt = nowText()
  addTimeline(
    item,
    item.manualReview.reviewer,
    '提交人工复核结论',
    `${item.manualReview.conclusion}${item.manualReview.summary ? `：${item.manualReview.summary}` : ''}`
  )
  logs.unshift({
    id: `L${Date.now()}`,
    actor: item.manualReview.reviewer,
    action: `提交《${item.title}》人工复核结论`,
    at: nowText(),
    proposalId: item.id,
    proposalTitle: item.title
  })
  saveStore()
  res.status(201).json(item)
})

app.post('/api/proposals/:id/sign-off', authMiddleware, requirePermission('reviewProposal'), (req, res) => {
  const item = proposals.find(p => p.id === req.params.id)
  if (!item) return res.status(404).json({ message: '方案不存在' })
  if (item.status === statuses.configurationPending) {
    return res.status(409).json({ message: '待专业配置草稿尚未完成审核，不能签发' })
  }
  if (!hasCompleteManualReview(item.manualReview)) {
    return res.status(400).json({ message: '签发前须完整填写人工复核结论、依据、动作、摘要、复核人和复核时间' })
  }

  const currentExecution = normalizeExecutionRecord(item.executionRecord)
  if (currentExecution.signOff.status === '已签发' || currentExecution.archive.status === '已归档') {
    return res.status(409).json({ message: '方案已经签发或归档，不得重复覆盖；请走独立更正流程' })
  }

  const documentCode = String(req.body?.documentCode || '').trim()
  const comment = String(req.body?.comment || '').trim()
  if (!documentCode) return res.status(400).json({ message: '请填写签发文号' })
  if (proposals.some(other => other.id !== item.id && normalizeExecutionRecord(other.executionRecord).signOff.documentCode === documentCode)) {
    return res.status(409).json({ message: '签发文号已被其他方案使用' })
  }
  if (!requireConfirmText(req, res, '登记签发')) return

  item.executionRecord = normalizeExecutionRecord(item.executionRecord)
  item.executionRecord.signOff = {
    status: '已签发',
    signer: req.user?.name || '管理员',
    signedAt: nowText(),
    documentCode,
    comment
  }
  item.status = statuses.passed
  item.updatedAt = nowText()
  addTimeline(
    item,
    item.executionRecord.signOff.signer,
    '完成签发',
    `${documentCode}${comment ? `：${comment}` : ''}`
  )
  logs.unshift({
    id: `L${Date.now()}`,
    actor: item.executionRecord.signOff.signer,
    action: `签发《${item.title}》`,
    at: nowText(),
    proposalId: item.id,
    proposalTitle: item.title
  })
  saveStore()
  res.status(201).json(item)
})

app.post('/api/proposals/:id/archive', authMiddleware, requirePermission('reviewProposal'), (req, res) => {
  const item = proposals.find(p => p.id === req.params.id)
  if (!item) return res.status(404).json({ message: '方案不存在' })
  if (item.status === statuses.configurationPending) {
    return res.status(409).json({ message: '待专业配置草稿尚未完成审核，不能归档' })
  }
  item.executionRecord = normalizeExecutionRecord(item.executionRecord)
  if (item.executionRecord.signOff.status !== '已签发') {
    return res.status(400).json({ message: '请先完成签发，再登记归档信息' })
  }
  if (item.executionRecord.archive.status === '已归档') {
    return res.status(409).json({ message: '方案已经归档，不得重复覆盖；请走独立更正流程' })
  }

  const archiveCode = String(req.body?.archiveCode || '').trim()
  const location = String(req.body?.location || '').trim()
  const comment = String(req.body?.comment || '').trim()
  if (!archiveCode) return res.status(400).json({ message: '请填写归档编号' })
  if (!location) return res.status(400).json({ message: '请填写归档位置' })
  if (proposals.some(other => other.id !== item.id && normalizeExecutionRecord(other.executionRecord).archive.archiveCode === archiveCode)) {
    return res.status(409).json({ message: '归档编号已被其他方案使用' })
  }
  if (!requireConfirmText(req, res, '登记归档')) return

  item.executionRecord.archive = {
    status: '已归档',
    archivist: req.user?.name || '管理员',
    archivedAt: nowText(),
    archiveCode,
    location,
    comment
  }
  item.updatedAt = nowText()
  addTimeline(
    item,
    item.executionRecord.archive.archivist,
    '完成归档',
    `${archiveCode} · ${location}${comment ? `：${comment}` : ''}`
  )
  logs.unshift({
    id: `L${Date.now()}`,
    actor: item.executionRecord.archive.archivist,
    action: `归档《${item.title}》`,
    at: nowText(),
    proposalId: item.id,
    proposalTitle: item.title
  })
  saveStore()
  res.status(201).json(item)
})

app.post('/api/proposals/:id/reminders', authMiddleware, requirePermission('reviewProposal'), (req, res) => {
  const item = proposals.find(p => p.id === req.params.id)
  if (!item) return res.status(404).json({ message: '方案不存在' })

  const recommended = reminderSuggestion(item)
  const stage = String(req.body?.stage || recommended.stage || '进度确认').trim()
  const channel = String(req.body?.channel || '企业微信').trim()
  const note = String(req.body?.note || defaultReminderNote(stage, item)).trim()
  const source = normalizeReminderSource(req.body?.source)
  const config = normalizeReminderConfig(reminderConfig)

  if (!stage) return res.status(400).json({ message: '请提供催办阶段' })
  if (!channel) return res.status(400).json({ message: '请提供催办渠道' })
  if (note.length < 4) return res.status(400).json({ message: '催办记录不能少于4个字' })
  if (source === 'auto' && config.autoCreateEnabled !== true) {
    return res.status(409).json({ message: '未发送催办草稿生成功能已停用' })
  }
  if (!requireConfirmText(req, res, '登记催办')) return

  const reminder = appendReminder(item, {
    stage,
    channel,
    note,
    remindedBy: source === 'auto' ? '' : req.user?.name || '管理员',
    remindedAt: source === 'auto' ? '' : nowText(),
    createdBy: req.user?.name || '管理员',
    createdAt: nowText(),
    source
  })
  logs.unshift({
    id: `L${Date.now()}`,
    actor: reminder.createdBy,
    action: source === 'auto'
      ? `生成《${item.title}》${stage}催办草稿（未发送）`
      : `登记《${item.title}》${stage}沟通留痕（用户确认）`,
    at: nowText(),
    source,
    proposalId: item.id,
    proposalTitle: item.title
  })
  saveStore()
  res.status(201).json({
    ok: true,
    reminder,
    summary: proposalListItem(item),
    reminders: item.reminders
  })
})

app.post('/api/proposals/bulk-reminders', authMiddleware, requirePermission('reviewProposal'), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(item => String(item).trim()).filter(Boolean) : []
  const mode = String(req.body?.mode || 'auto').trim()
  const channelInput = String(req.body?.channel || '').trim()
  const noteInput = String(req.body?.note || '').trim()
  const source = normalizeReminderSource(mode)

  if (ids.length === 0) return res.status(400).json({ message: '请至少选择 1 个方案' })
  if (!requireConfirmText(req, res, '批量生成催办')) return

  const idSet = new Set(ids)
  const targetItems = proposals.filter(item => idSet.has(item.id))
  if (targetItems.length === 0) return res.status(404).json({ message: '未找到可催办的方案' })

  const config = normalizeReminderConfig(reminderConfig)
  if (source === 'auto' && config.autoCreateEnabled !== true) {
    return res.status(409).json({ message: '未发送催办草稿生成功能已停用' })
  }
  const operator = req.user?.name || '管理员'
  const created = []
  const skippedItems = []

  for (const item of targetItems) {
    const stage = reminderSuggestion(item).stage || '进度确认'
    const channel = channelInput || item.reminders?.[0]?.channel || config.defaultChannel || '企业微信'
    const note = noteInput || reminderScript(item, stage)
    if (note.trim().length < 4) {
      skippedItems.push({
        id: item.id,
        title: item.title,
        reason: '催办内容少于 4 个字'
      })
      continue
    }

    const reminder = appendReminder(item, {
      stage,
      channel,
      note,
      remindedBy: source === 'auto' ? '' : operator,
      remindedAt: source === 'auto' ? '' : nowText(),
      createdBy: operator,
      createdAt: nowText(),
      source
    })
    created.push({
      id: item.id,
      title: item.title,
      reminder,
      summary: proposalListItem(item)
    })
  }

  if (created.length === 0) {
    return res.status(400).json({
      message: '没有生成可保存的催办记录',
      requested: ids.length,
      created: 0,
      skipped: skippedItems.length,
      skippedItems
    })
  }

  logs.unshift({
    id: `L${Date.now()}`,
    actor: operator,
    action: source === 'auto'
      ? `批量生成 ${created.length} 个方案催办草稿（未发送）`
      : `批量登记 ${created.length} 个方案沟通留痕（用户确认）`,
    category: '执行动作',
    result: skippedItems.length > 0 ? '部分成功' : '成功',
    at: nowText(),
    source,
    proposalTitle: `批量催办 ${created.length} 个方案`,
    metadata: {
      kind: 'bulk-reminder',
      source,
      requestedCount: ids.length,
      createdCount: created.length,
      skippedCount: skippedItems.length,
      proposalIds: created.map(item => item.id),
      titles: created.map(item => item.title),
      skippedItems
    }
  })
  saveStore()
  res.status(201).json({
    ok: true,
    requested: ids.length,
    created: created.length,
    skipped: skippedItems.length,
    items: created,
    skippedItems
  })
})

app.delete('/api/proposals/:id', authMiddleware, requirePermission('manageSystem'), requireExclusiveBackupOperation, async (req, res) => {
  const idx = proposals.findIndex(p => p.id === req.params.id)
  if (idx === -1) return res.status(404).json({ message: '方案不存在' })
  if (!requireConfirmText(req, res, '删除方案')) return
  req.backupOperationOwnsAsync = true
  const removed = proposals[idx]
  let preDeleteBackup
  try {
    preDeleteBackup = path.basename(await writeServerBackupSnapshot('pre-delete', req.backupOperationSignal))
  } catch (error) {
    req.releaseBackupOperation?.()
    return res.status(backupFailureStatus(error, 500)).json({ message: error.message || '无法创建删除前恢复快照' })
  }
  const auditLog = {
    id: `L${Date.now()}`,
    actor: req.user?.name || '管理员',
    action: `删除方案《${removed.title}》`,
    category: '执行动作',
    result: '成功',
    metadata: { kind: 'proposal-delete', preDeleteBackup },
    at: nowText()
  }
  proposals.splice(idx, 1)
  logs.unshift(auditLog)
  try {
    // 先原子提交 store，再清理已无引用的附件；saveStore 失败时附件不会丢失。
    saveStore()
  } catch (error) {
    proposals.splice(idx, 0, removed)
    logs = logs.filter(log => log !== auditLog)
    req.releaseBackupOperation?.()
    return res.status(500).json({ message: error.message || '方案删除持久化失败，附件未删除', preDeleteBackup })
  }
  try {
    removeProposalFiles(removed)
    res.json({ ok: true, preDeleteBackup })
  } catch (error) {
    console.error('方案已从活动 store 移除，但附件清理失败，保留删除前快照供恢复', error)
    res.status(500).json({ message: '方案记录已移除，但附件清理失败；已保留删除前恢复快照', preDeleteBackup })
  } finally {
    req.releaseBackupOperation?.()
  }
})

app.post('/api/proposals/bulk-delete', authMiddleware, requirePermission('manageSystem'), requireExclusiveBackupOperation, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(item => String(item).trim()).filter(Boolean) : []
  if (ids.length === 0) return res.status(400).json({ message: '请至少选择 1 个方案' })
  if (!requireConfirmText(req, res, `删除${ids.length}个方案`)) return

  const idSet = new Set(ids)
  const removedItems = proposals.filter(item => idSet.has(item.id))
  if (removedItems.length === 0) return res.status(404).json({ message: '未找到可删除的方案' })

  req.backupOperationOwnsAsync = true
  let preDeleteBackup
  try {
    preDeleteBackup = path.basename(await writeServerBackupSnapshot('pre-bulk-delete', req.backupOperationSignal))
  } catch (error) {
    req.releaseBackupOperation?.()
    return res.status(backupFailureStatus(error, 500)).json({ message: error.message || '无法创建批量删除前恢复快照' })
  }
  const beforeProposals = proposals
  proposals = proposals.filter(item => !idSet.has(item.id))

  const auditLog = {
    id: `L${Date.now()}`,
    actor: req.user?.name || '管理员',
    action: `批量删除方案 ${removedItems.length} 个`,
    category: '执行动作',
    result: '成功',
    metadata: {
      kind: 'bulk-delete',
      requestedCount: ids.length,
      removedCount: removedItems.length,
      titles: removedItems.map(item => item.title),
      preDeleteBackup
    },
    at: nowText()
  }
  logs.unshift(auditLog)
  try {
    saveStore()
  } catch (error) {
    proposals = beforeProposals
    logs = logs.filter(log => log !== auditLog)
    req.releaseBackupOperation?.()
    return res.status(500).json({ message: error.message || '批量删除持久化失败，附件未删除', preDeleteBackup })
  }
  const cleanupErrors = []
  for (const item of removedItems) {
    try {
      removeProposalFiles(item)
    } catch (error) {
      cleanupErrors.push({ id: item.id, message: error.message || '附件清理失败' })
    }
  }
  if (cleanupErrors.length > 0) {
    res.status(500).json({
      message: '方案记录已移除，但部分附件清理失败；已保留删除前恢复快照',
      preDeleteBackup,
      cleanupErrors
    })
    req.releaseBackupOperation?.()
    return
  }
  res.json({ ok: true, removed: removedItems.length, titles: removedItems.map(item => item.title), preDeleteBackup })
  req.releaseBackupOperation?.()
})

// ===== 错误处理 =====
app.use((err, req, res, _next) => {
  console.error(err)
  cleanupUploadedBackup(req)
  req.releaseBackupOperation?.()
  if (err instanceof multer.MulterError) return res.status(400).json({ message: multerErrorMessage(err, systemConfig) })
  if (err?.code === 'RESTORE_DISK_SPACE') return res.status(507).json({ message: err.message || '备份/恢复磁盘空间不足' })
  res.status(500).json({ message: '服务器内部错误' })
})

const server = app.listen(port, bindHost, () => {
  console.log(`API server listening on ${bindHost}:${port}`)
})
// 大型 tgz 恢复请求允许最长 30 分钟完整流入；公网层仍以 Nginx
// client_body_timeout/limit_conn 限制慢连接，业务处理自身另有更短超时。
server.requestTimeout = 30 * 60 * 1000
server.headersTimeout = 30 * 1000

let shutdownStarted = false
let shutdownForced = false
let shutdownServerClosed = false
let shutdownSignal = ''
let shutdownTimeout = null
let shutdownMarkerWritten = false

function writeCleanShutdownMarker() {
  if (!shutdownMarkerFile || shutdownMarkerWritten) return
  const directory = path.dirname(shutdownMarkerFile)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${shutdownMarkerFile}.tmp-${process.pid}-${Date.now()}`
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
  try {
    fs.writeFileSync(descriptor, `${process.pid}:${shutdownSignal}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporary, shutdownMarkerFile)
  const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY)
  try {
    fs.fsyncSync(directoryDescriptor)
  } finally {
    fs.closeSync(directoryDescriptor)
  }
  shutdownMarkerWritten = true
}

function tryCompleteGracefulShutdown() {
  if (!shutdownStarted || shutdownForced || !shutdownServerClosed || activeMutationCount !== 0 || backupOperationInProgress || shutdownMarkerWritten) return
  if (shutdownTimeout) clearTimeout(shutdownTimeout)
  try {
    writeCleanShutdownMarker()
  } catch (markerError) {
    console.error('审核 API 无法持久化 clean-drain 标记', markerError)
    process.exitCode = 1
  }
}

function gracefulShutdown(signal) {
  if (shutdownStarted) return
  shutdownStarted = true
  shutdownSignal = signal
  console.log(`收到 ${signal}，停止接收新请求并等待在途请求完成`)
  activeBackupAbortController?.abort(new Error(`收到 ${signal}，中止尚未提交的备份流操作`))
  shutdownTimeout = setTimeout(() => {
    console.error(`在途请求未在 ${gracefulShutdownTimeoutMs}ms 内完成，安全退出`)
    shutdownForced = true
    process.exitCode = 1
    server.closeAllConnections?.()
  }, gracefulShutdownTimeoutMs)
  server.close(error => {
    if (error) {
      console.error('审核 API 优雅停止失败', error)
      shutdownForced = true
      process.exitCode = 1
      return
    }
    shutdownServerClosed = true
    tryCompleteGracefulShutdown()
  })
  server.closeIdleConnections?.()
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
