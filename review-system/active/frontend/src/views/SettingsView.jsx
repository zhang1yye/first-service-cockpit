import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, CheckCircle2, Copy, Database, Download, History, RotateCcw, Save, Server, Settings, ShieldCheck, Trash2, Upload } from '../lib/lucide.js'
import { api, downloadFile, downloadWithOneTimeTicket, getUser, refreshSession, uploadFile } from '../lib/api'
import { appBuildLabel, appBuildTime, appBuildTimeText, appVersion } from '../lib/appVersion'
import { copyText } from '../lib/clipboard'
import { csvCell } from '../lib/csv'
import { uploadFormatError } from '../lib/uploadValidation'
import Panel from '../components/Panel'
import CopyFallbackDialog from '../components/CopyFallbackDialog'

const deployChecks = [
  '前端构建产物部署到 /var/www/first-service-dashboard',
  '后端 systemd 服务监听 3001 端口',
  'Nginx 将 /api 反向代理到后端服务',
  'backend/data/store.json 保存业务数据',
  '上线前配置强密码、HTTPS、防火墙和定期备份'
]

const numericSystemConfigFields = [
  ['sessionTtlMinutes', '会话有效期', '分钟'],
  ['maxLoginFailures', '锁定前失败次数', '次'],
  ['loginFailureWindowMinutes', '失败统计窗口', '分钟'],
  ['loginLockMinutes', '临时锁定时长', '分钟'],
  ['inactiveLoginDays', '长期未登录阈值', '天'],
  ['sharedLoginIpAccountThreshold', '同 IP 风险阈值', '个账号'],
  ['maxFileSizeMb', '单文件上限', 'MB'],
  ['maxUploadFiles', '单次上传文件数', '个']
]

function systemConfigNormalizationNotes(submitted = {}, normalized = {}) {
  return numericSystemConfigFields
    .map(([key, label, unit]) => {
      const before = Number(submitted?.[key])
      const after = Number(normalized?.[key])
      if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) return ''
      return `${label} ${before} 调整为 ${after}${unit}`
    })
    .filter(Boolean)
}

const launchApprovalFreshHoursKey = 'launchApprovalFreshHours'

function normalizeLaunchApprovalFreshHours(value) {
  return Math.min(168, Math.max(1, Number(value) || 24))
}

function initialLaunchApprovalFreshHours() {
  try {
    return normalizeLaunchApprovalFreshHours(localStorage.getItem(launchApprovalFreshHoursKey))
  } catch {
    return 24
  }
}

function snapshotAgeText(value) {
  const timestamp = Date.parse(value || '')
  if (Number.isNaN(timestamp)) return '距今未知'
  const hours = Math.max(0, Math.floor((Date.now() - timestamp) / (1000 * 60 * 60)))
  if (hours < 1) return '1小时内'
  if (hours < 24) return `距今${hours}小时`
  return `距今${Math.floor(hours / 24)}天`
}

function snapshotPruneDue(value, retentionDays) {
  const timestamp = Date.parse(value || '')
  const days = Math.max(1, Number(retentionDays) || 30)
  return !Number.isNaN(timestamp) && Date.now() - timestamp > days * 24 * 60 * 60 * 1000
}

function olderThanHours(value, hours) {
  const timestamp = Date.parse(value || '')
  return !Number.isNaN(timestamp) && Date.now() - timestamp > Math.max(1, Number(hours) || 1) * 60 * 60 * 1000
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0)
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function formatDateTime(value) {
  const timestamp = Date.parse(value || '')
  return Number.isNaN(timestamp) ? '未刷新' : new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

function rolePermissionsSnapshot(value = {}) {
  return JSON.stringify(Object.keys(value).sort().reduce((result, role) => ({
    ...result,
    [role]: [...new Set(value[role] || [])].sort()
  }), {}))
}

function rolePermissionDiffs(roles = [], permissions = [], current = {}, saved = {}, impactByRole = {}) {
  const permissionName = new Map(permissions.map(item => [item.key, item.name]))
  return roles.map(role => {
    const currentSet = new Set(current[role] || [])
    const savedSet = new Set(saved[role] || [])
    const added = [...currentSet].filter(key => !savedSet.has(key)).map(key => permissionName.get(key) || key)
    const removed = [...savedSet].filter(key => !currentSet.has(key)).map(key => permissionName.get(key) || key)
    return { role, added, removed, count: added.length + removed.length, impact: impactByRole[role] || {} }
  }).filter(item => item.count > 0)
}

function rolePermissionConfirmText(changes = []) {
  const changeCount = changes.reduce((sum, item) => sum + item.count, 0)
  return [
    `确认保存角色权限矩阵的 ${changeCount} 项变更？`,
    ...changes.map(change => [
      `${change.role}（启用 ${change.impact.enabled || 0} / 总计 ${change.impact.total || 0}）`,
      change.added.length ? `新增：${change.added.join('、')}` : '',
      change.removed.length ? `移除：${change.removed.join('、')}` : ''
    ].filter(Boolean).join('\n'))
  ].join('\n\n')
}

function rolePermissionUnsavedText(changes = [], operator = '') {
  const changeCount = changes.reduce((sum, item) => sum + item.count, 0)
  return [
    `当前角色权限矩阵有 ${changeCount} 项未保存改动。`,
    '来源：第一服务研发小组审核系统 / 系统设置 / 角色权限矩阵',
    `生成账号：${operator || '未知账号'}`,
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ...changes.map(change => [
      `${change.role}（启用 ${change.impact.enabled || 0} / 总计 ${change.impact.total || 0}）`,
      change.added.length ? `新增：${change.added.join('、')}` : '',
      change.removed.length ? `移除：${change.removed.join('、')}` : ''
    ].filter(Boolean).join('\n'))
  ].join('\n\n')
}

function rolePermissionDefaultDiffText(changes = [], operator = '') {
  const changeCount = changes.reduce((sum, item) => sum + item.count, 0)
  return [
    `当前角色权限相对系统默认值有 ${changeCount} 项差异。`,
    '来源：第一服务研发小组审核系统 / 系统设置 / 角色权限矩阵',
    `生成账号：${operator || '未知账号'}`,
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ...changes.map(change => [
      `${change.role}（启用 ${change.impact.enabled || 0} / 总计 ${change.impact.total || 0}）`,
      change.added.length ? `较默认新增：${change.added.join('、')}` : '',
      change.removed.length ? `较默认移除：${change.removed.join('、')}` : ''
    ].filter(Boolean).join('\n'))
  ].join('\n\n')
}

function hermesStatusText(status = {}, operator = '') {
  const summary = status.summary || {}
  const diagnostic = status.diagnostic || {}
  return [
    'Hermes Profile 接入诊断',
    '来源：第一服务研发小组审核系统 / 系统设置 / AI 运行配置',
    `生成账号：${operator || '未知账号'}`,
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `检查时间：${status.checkedAt || '未记录'}`,
    `运行状态：${status.message || (status.ok === false ? '读取失败' : '已读取')}`,
    `Provider：${status.runtime?.provider || '-'}`,
    `模型：${status.runtime?.model || '-'}`,
    diagnostic.nextAction ? `处理建议：${diagnostic.nextAction}` : '',
    ...(diagnostic.checks || []).map(check => `${check.label}：${check.status}；${check.detail}`),
    `汇总：网页 ${summary.webCount ?? 0} 个，云端 ${summary.remoteCount ?? 0} 个，匹配 ${summary.matchedCount ?? 0} 个，缺失 ${summary.missingCount ?? 0} 个，差异 ${summary.driftCount ?? 0} 个。`,
    '',
    ...(status.profiles || []).map(profile => {
      const state = profile.matched ? (profile.drifted ? '有差异' : '已匹配') : '未匹配'
      const remote = profile.remote?.name || profile.remote?.hermesName || '未找到'
      const drift = profile.changedFields?.length ? `；差异字段：${profile.changedFields.join('、')}` : ''
      return `${profile.code || profile.id} ${profile.name}：${state}；网页 Hermes：${profile.hermesName || '-'}；云端：${remote}${drift}`
    })
  ].join('\n')
}

function networkDiagnosticsText(diagnostics = {}, operator = '') {
  return [
    '公网解析诊断',
    '来源：第一服务研发小组审核系统 / 系统设置 / 运行与账号安全配置',
    `生成账号：${operator || '未知账号'}`,
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `诊断结论：${diagnostics.ok ? '通过' : '需处理'}`,
    `公网域名：${diagnostics.domain || '未配置'}`,
    `预期公网 IP：${diagnostics.expectedIp || '未配置'}`,
    `实际解析 IP：${diagnostics.resolvedIps?.length ? diagnostics.resolvedIps.join('、') : '未记录'}`,
    `说明：${diagnostics.message || '未记录'}`
  ].join('\n')
}

function launchReadinessText(items = [], operator = '', refreshedAt = '') {
  const passed = items.filter(item => item.status === '通过').length
  return [
    `上线检查：${passed}/${items.length} 项通过`,
    '来源：第一服务研发小组审核系统 / 系统设置 / 上线检查台',
    `生成账号：${operator || '未知账号'}`,
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `最近刷新：${formatDateTime(refreshedAt)}`,
    ...items.map(item => `${item.status}｜${item.label}｜${item.detail}${item.action ? `｜建议：${item.action}` : ''}`)
  ].join('\n')
}

function launchReadinessIssuesText(items = [], operator = '', refreshedAt = '') {
  const issues = items.filter(item => item.status !== '通过')
  return [
    `上线待处理项：${issues.length} 项`,
    '来源：第一服务研发小组审核系统 / 系统设置 / 上线检查台',
    `生成账号：${operator || '未知账号'}`,
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `最近刷新：${formatDateTime(refreshedAt)}`,
    '',
    ...(issues.length
      ? issues.map(item => `${item.status}｜${item.label}｜${item.detail}${item.action ? `｜建议：${item.action}` : ''}`)
      : ['暂无待处理项，当前上线检查均已通过。'])
  ].join('\n')
}

function launchApprovalText(items = [], operator = '', refreshedAt = '', version = '', buildLabel = '') {
  const passed = items.filter(item => item.status === '通过').length
  return [
    '上线确认记录',
    '来源：第一服务研发小组审核系统 / 系统设置 / 上线检查台',
    `确认账号：${operator || '未知账号'}`,
    `确认时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `最近刷新：${formatDateTime(refreshedAt)}`,
    `前端版本：${version || '-'}`,
    `构建标识：${buildLabel || version || '-'}`,
    `检查结论：${passed}/${items.length} 项通过`,
    '',
    '确认说明：核心上线检查均已通过，可进入正式上线使用。'
  ].join('\n')
}

function accountRiskBlockMessage(riskSummary = {}) {
  if (!riskSummary || typeof riskSummary !== 'object') return ''
  return accountRiskDetailText(riskSummary)
}

function accountRiskDetailText(riskSummary = {}) {
  const names = (items = []) => (Array.isArray(items) ? items : [])
    .map(item => item?.name || item?.username)
    .filter(Boolean)
    .slice(0, 6)
    .join('、')
  const summaryText = [
    `默认密码 ${riskSummary.defaultPassword || 0} 个`,
    `需改密 ${riskSummary.mustChangePassword || 0} 个`,
    `登录锁定 ${riskSummary.loginLocked || 0} 个`
  ].join('，')
  const roleSummaryText = Array.isArray(riskSummary.byRole) && riskSummary.byRole.length
    ? `角色分布：${riskSummary.byRole.map(item => `${item.role || '-'} ${item.enabled || 0}/${item.total || 0}`).join('、')}`
    : ''
  const latestNotice = riskSummary.latestPasswordNotice || null
  const latestNoticeText = latestNotice
    ? `最近改密通知文案：${latestNotice.actor || '未知账号'} ${latestNotice.at || '时间未记录'} 涉及 ${latestNotice.affectedAccountCount ?? latestNotice.noticeCount ?? 0} 个账号，未发送${latestNotice.auditId ? `（${latestNotice.auditId}）` : ''}`
    : (Number(riskSummary.mustChangePassword) || 0) > 0
      ? '最近改密通知文案：尚未发现文案生成留痕，请进入人员管理生成文案；系统不会自动发送'
      : ''
  const latestNoticeNames = latestNotice && Array.isArray(latestNotice.targetNames) && latestNotice.targetNames.length
    ? `最近文案涉及姓名：${latestNotice.targetNames.slice(0, 6).join('、')}${latestNotice.targetNames.length > 6 ? ` 等 ${latestNotice.targetNames.length} 人` : ''}`
    : ''
  const latestNoticeUsers = latestNotice && Array.isArray(latestNotice.targetUsernames) && latestNotice.targetUsernames.length
    ? `最近文案涉及账号：${latestNotice.targetUsernames.slice(0, 6).join('、')}${latestNotice.targetUsernames.length > 6 ? ` 等 ${latestNotice.targetUsernames.length} 个` : ''}`
    : ''
  const detailText = [
    names(riskSummary.defaultPasswordUsers) ? `默认密码账号：${names(riskSummary.defaultPasswordUsers)}` : '',
    names(riskSummary.mustChangePasswordUsers) ? `需改密账号：${names(riskSummary.mustChangePasswordUsers)}` : '',
    names(riskSummary.loginLockedUsers) ? `登录锁定账号：${names(riskSummary.loginLockedUsers)}` : '',
    roleSummaryText,
    latestNoticeText,
    latestNoticeNames,
    latestNoticeUsers
  ].filter(Boolean).join('；')
  return `${summaryText}${detailText ? `；${detailText}` : ''}`
}

function latestLaunchApprovalText(record = {}, freshHours = 24) {
  const metadata = record.metadata || {}
  const riskSummary = metadata.riskSummary || null
  const items = Array.isArray(metadata.items) ? metadata.items.map(item => ({
    label: String(item?.label || ''),
    status: String(item?.status || ''),
    detail: String(item?.detail || ''),
    action: String(item?.action || '')
  })).filter(item => item.label) : []
  const confirmedAt = record.at || metadata.generatedAt || ''
  const expired = olderThanHours(confirmedAt, freshHours)
  return [
    '最近上线确认记录',
    '来源：第一服务研发小组审核系统 / 系统设置 / 上线检查台',
    `记录编号：${metadata.id || record.id || '未记录'}`,
    `确认账号：${record.actor || metadata.actor || '未知账号'}`,
    `确认时间：${confirmedAt || '未记录'}`,
    `有效阈值：${normalizeLaunchApprovalFreshHours(freshHours)} 小时`,
    `有效状态：${expired ? '建议重新确认' : '当前有效'}`,
    `最近刷新：${metadata.refreshedAt || '未记录'}`,
    `前端版本：${metadata.appVersion || '未记录'}`,
    `检查结论：${metadata.passed ?? 0}/${metadata.total ?? 0} 项通过`,
    riskSummary ? `账号风险：${accountRiskDetailText(riskSummary)}` : '',
    '',
    ...(items.length ? items.map(item => `${item.status || '未记录'}｜${item.label || '-'}｜${item.detail || '-'}${item.action ? `｜建议：${item.action}` : ''}`) : ['检查项明细未记录'])
  ].filter(line => line !== '').join('\n')
}

function launchGateNameForAction(action = '') {
  const text = String(action || '')
  if (text.includes('公网解析诊断')) return '公网入口'
  if (text.includes('创建服务器本地备份快照')) return '数据备份'
  if (text.includes('检查 Hermes Profile 接入状态')) return 'Hermes 接入'
  if (text.includes('测试 AI 审核适配器')) return 'AI 实测'
  if (text.includes('角色权限矩阵')) return '权限账号'
  if (text.includes('系统运行与账号安全配置')) return '上传链路'
  return ''
}

function launchGateActivityFromLogs(logs = []) {
  return (Array.isArray(logs) ? logs : [])
    .map(log => ({
      id: log.id || `${log.action || 'log'}-${log.at || ''}`,
      gate: launchGateNameForAction(log.action),
      actor: log.actor || '未知账号',
      action: log.action || '未记录动作',
      result: log.result || '未记录',
      at: log.at || ''
    }))
    .filter(item => item.gate)
    .slice(0, 6)
}

function downloadJsonFile(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function downloadCsvFile(filename, rows = []) {
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\n')
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export default function SettingsView() {
  const navigate = useNavigate()
  const isAdministrator = getUser()?.role === '管理员'
  const runtimeConfigRef = useRef(null)
  const [health, setHealth] = useState(null)
  const [loading, setLoading] = useState(true)
  const [roles, setRoles] = useState([])
  const [permissions, setPermissions] = useState([])
  const [rolePermissions, setRolePermissions] = useState({})
  const [savedRolePermissions, setSavedRolePermissions] = useState({})
  const [defaultRolePermissions, setDefaultRolePermissions] = useState({})
  const [roleImpact, setRoleImpact] = useState({})
  const [latestRolePermissionUpdate, setLatestRolePermissionUpdate] = useState(null)
  const [systemConfig, setSystemConfig] = useState(null)
  const [runtime, setRuntime] = useState(null)
  const [dashboardStats, setDashboardStats] = useState(null)
  const [networkDiagnostics, setNetworkDiagnostics] = useState(null)
  const [checkingNetworkDiagnostics, setCheckingNetworkDiagnostics] = useState(false)
  const [downloadingNetworkDiagnostics, setDownloadingNetworkDiagnostics] = useState(false)
  const [testingAi, setTestingAi] = useState(false)
  const [aiTestResult, setAiTestResult] = useState(null)
  const [checkingHermesProfiles, setCheckingHermesProfiles] = useState(false)
  const [hermesStatus, setHermesStatus] = useState(null)
  const [refreshingLaunchReadiness, setRefreshingLaunchReadiness] = useState(false)
  const [launchReadinessRefreshedAt, setLaunchReadinessRefreshedAt] = useState('')
  const [downloadingLaunchReadiness, setDownloadingLaunchReadiness] = useState(false)
  const [downloadingLaunchAudit, setDownloadingLaunchAudit] = useState(false)
  const [downloadingLaunchAuditCsv, setDownloadingLaunchAuditCsv] = useState(false)
  const [confirmingLaunchApproval, setConfirmingLaunchApproval] = useState(false)
  const [exportingLaunchApprovalLogs, setExportingLaunchApprovalLogs] = useState(false)
  const [latestLaunchApproval, setLatestLaunchApproval] = useState(null)
  const [latestLaunchApprovalError, setLatestLaunchApprovalError] = useState('')
  const [launchGateActivity, setLaunchGateActivity] = useState([])
  const [launchGateActivityError, setLaunchGateActivityError] = useState('')
  const [loadingLaunchGateActivity, setLoadingLaunchGateActivity] = useState(false)
  const [loadingLatestLaunchApproval, setLoadingLatestLaunchApproval] = useState(false)
  const [downloadingLatestLaunchApproval, setDownloadingLatestLaunchApproval] = useState(false)
  const [launchApprovalFreshHours, setLaunchApprovalFreshHours] = useState(initialLaunchApprovalFreshHours)
  const [savingPermissions, setSavingPermissions] = useState(false)
  const [savingSystemConfig, setSavingSystemConfig] = useState(false)
  const [backupDownloading, setBackupDownloading] = useState(false)
  const [backupPreviewing, setBackupPreviewing] = useState(false)
  const [backupPreview, setBackupPreview] = useState(null)
  const [backupFile, setBackupFile] = useState(null)
  const [backupSnapshots, setBackupSnapshots] = useState([])
  const [backupSnapshotSummary, setBackupSnapshotSummary] = useState(null)
  const [snapshotLoadError, setSnapshotLoadError] = useState('')
  const [showAllSnapshots, setShowAllSnapshots] = useState(false)
  const [snapshotTypeFilter, setSnapshotTypeFilter] = useState('全部')
  const [snapshotKeyword, setSnapshotKeyword] = useState('')
  const [snapshotSort, setSnapshotSort] = useState('最新优先')
  const [snapshotsLoading, setSnapshotsLoading] = useState(false)
  const [creatingSnapshot, setCreatingSnapshot] = useState(false)
  const [deletingSnapshot, setDeletingSnapshot] = useState('')
  const [previewingSnapshot, setPreviewingSnapshot] = useState('')
  const [snapshotPreview, setSnapshotPreview] = useState(null)
  const [snapshotRetentionDays, setSnapshotRetentionDays] = useState(30)
  const [pruningSnapshots, setPruningSnapshots] = useState(false)
  const [restoreConfirm, setRestoreConfirm] = useState('')
  const [restoringBackup, setRestoringBackup] = useState(false)
  const [snapshotRestoreConfirm, setSnapshotRestoreConfirm] = useState('')
  const [restoringSnapshot, setRestoringSnapshot] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [copyFallback, setCopyFallback] = useState({ open: false, title: '', description: '', content: '' })
  const aiProviderInputId = useId()
  const aiModelInputId = useId()
  const aiBaseUrlInputId = useId()
  const aiApiKeyEnvInputId = useId()
  const frontendUrlInputId = useId()
  const publicDomainInputId = useId()
  const publicIpInputId = useId()
  const trustedLoginIpsInputId = useId()
  const backendPortInputId = useId()
  const apiPrefixInputId = useId()
  const backupFileInputId = useId()
  const restoreConfirmInputId = useId()
  const snapshotRestoreConfirmInputId = useId()
  const snapshotRetentionDaysInputId = useId()
  const latestLaunchApprovalFreshHoursInputId = useId()
  const filteredSnapshots = backupSnapshots.filter(snapshot => {
    const keyword = snapshotKeyword.trim().toLowerCase()
    const matchesType = snapshotTypeFilter === '全部' || snapshot.type === snapshotTypeFilter
    const searchable = [snapshot.name, snapshot.type, snapshot.updatedAt].join(' ').toLowerCase()
    return matchesType && (!keyword || searchable.includes(keyword))
  }).sort((a, b) => {
    if (snapshotSort === '最早优先') return String(a.updatedAt).localeCompare(String(b.updatedAt))
    if (snapshotSort === '文件最大') return (Number(b.size) || 0) - (Number(a.size) || 0)
    if (snapshotSort === '文件最小') return (Number(a.size) || 0) - (Number(b.size) || 0)
    return String(b.updatedAt).localeCompare(String(a.updatedAt))
  })
  const pruneDueSnapshots = backupSnapshots.filter(snapshot => snapshotPruneDue(snapshot.updatedAt, snapshotRetentionDays))
  const pruneDueBytes = pruneDueSnapshots.reduce((sum, snapshot) => sum + (Number(snapshot.size) || 0), 0)
  const visibleSnapshots = showAllSnapshots ? filteredSnapshots : filteredSnapshots.slice(0, 5)
  const aiRuntime = runtime?.ai || {}
  const managedAiProvider = aiRuntime.provider || systemConfig?.aiProvider || '未加载'
  const managedAiModel = aiRuntime.model || systemConfig?.aiModel || '未加载'
  const managedAiBaseUrl = aiRuntime.baseUrl || systemConfig?.aiBaseUrl || '未加载'
  const managedAiApiKeyEnv = aiRuntime.apiKeyEnv || 'AI_REVIEW_API_KEY'
  const managedPublicDomain = runtime?.publicDomain || systemConfig?.publicDomain || ''
  const managedFrontendUrl = managedPublicDomain
    ? `https://${managedPublicDomain}/review-system/`
    : (systemConfig?.frontendUrl || '未加载')
  const managedBackendPort = runtime?.port || systemConfig?.backendPort || '未加载'
  const managedApiPrefix = '/api'
  const aiInferenceState = aiRuntime.agentConfigured === true
    ? '外部推理已受控启用'
    : '外部推理已安全停用，等待供应商密钥轮换'
  const rolePermissionsChanged = useMemo(
    () => rolePermissionsSnapshot(rolePermissions) !== rolePermissionsSnapshot(savedRolePermissions),
    [rolePermissions, savedRolePermissions]
  )
  const rolePermissionsIsDefault = useMemo(
    () => rolePermissionsSnapshot(rolePermissions) === rolePermissionsSnapshot(defaultRolePermissions),
    [defaultRolePermissions, rolePermissions]
  )
  const defaultRolePermissionChanges = useMemo(
    () => rolePermissionDiffs(roles, permissions, rolePermissions, defaultRolePermissions, roleImpact),
    [defaultRolePermissions, permissions, roleImpact, rolePermissions, roles]
  )
  const rolePermissionChanges = useMemo(
    () => rolePermissionDiffs(roles, permissions, rolePermissions, savedRolePermissions, roleImpact),
    [permissions, roleImpact, rolePermissions, roles, savedRolePermissions]
  )
  const rolePermissionChangeCount = rolePermissionChanges.reduce((sum, item) => sum + item.count, 0)
  const defaultRolePermissionChangeCount = defaultRolePermissionChanges.reduce((sum, item) => sum + item.count, 0)
  const enabledProfileItems = useMemo(
    () => (dashboardStats?.robots || []).filter(profile => profile.status === '启用'),
    [dashboardStats?.robots]
  )
  const unverifiedProfileItems = useMemo(
    () => enabledProfileItems.filter(profile => profile.definitionVerified !== true),
    [enabledProfileItems]
  )
  const hermesProfileSummary = `Hermes Profile：网页 ${hermesStatus?.summary?.webCount ?? 0} 个，云端 ${hermesStatus?.summary?.remoteCount ?? 0} 个，匹配 ${hermesStatus?.summary?.matchedCount ?? 0} 个，缺失 ${hermesStatus?.summary?.missingCount ?? 0} 个，差异 ${hermesStatus?.summary?.driftCount ?? 0} 个`
  const aiRuntimeSummary = `AI Provider：${managedAiProvider}；模型：${managedAiModel}；网关认证：${aiRuntime.gatewayConfigured ? '已配置' : '未配置'}；推理状态：${aiInferenceState}`
  const launchReadinessItems = useMemo(() => {
    const backupLatestAt = backupSnapshotSummary?.latestAt || ''
    const backupFresh = backupLatestAt && !snapshotPruneDue(backupLatestAt, 7)
    const hermesSummary = hermesStatus?.summary || {}
    const userStats = dashboardStats?.userStats || {}
    const aiTraceStats = dashboardStats?.aiTraceStats || {}
    const aiProbeMode = aiTestResult?.mode || aiTraceStats.latestMode || ''
    const aiProbeModeName = aiTestResult?.modeName || aiTraceStats.latestModeName || ''
    const aiProbeFallback = aiTestResult?.fallback === true
    const aiProbeFailed = aiTestResult?.ok === false
    const aiProbeAt = aiTestResult?.at || aiTraceStats.latestAt || ''
    const aiProbeStale = aiProbeAt ? olderThanHours(aiProbeAt, 24) : false
    const aiProbeHasResult = Boolean(aiTestResult || aiTraceStats.latestAt)
    const accountRiskCount = (Number(userStats.defaultPassword) || 0) + (Number(userStats.mustChangePassword) || 0) + (Number(userStats.loginLocked) || 0)
    return [
      {
        label: '云端服务健康',
        status: health?.ok ? '通过' : '需处理',
        detail: health?.ok ? `API 正常，端口 ${health.port || runtime?.port || '-'}` : '健康检查未通过或尚未加载',
        action: health?.ok ? '' : '检查 first-service-review-api 服务、Nginx /api 反向代理和服务器 3001 端口。'
      },
      {
        label: '系统配置已加载',
        status: systemConfig ? '通过' : '需处理',
        detail: systemConfig ? `会话 ${systemConfig.sessionTtlMinutes || 480} 分钟，API 前缀 ${systemConfig.apiPrefix || '/api'}` : '系统运行配置未加载',
        action: systemConfig ? '' : '刷新系统设置；如仍失败，检查后端配置文件和接口权限。'
      },
      {
        label: '公网域名解析',
        status: networkDiagnostics ? (networkDiagnostics.ok ? '通过' : '需处理') : '待确认',
        detail: networkDiagnostics
          ? `${networkDiagnostics.message || '解析结果未记录'}${networkDiagnostics.resolvedIps?.length ? `；解析 IP：${networkDiagnostics.resolvedIps.join('、')}` : ''}`
          : `待检查 ${systemConfig?.publicDomain || '公网域名'} -> ${systemConfig?.publicIp || '公网 IP'}`,
        action: networkDiagnostics?.ok ? '' : '点击“刷新公网诊断”，确认 firstcare.cloud 解析到当前腾讯云公网 IP。'
      },
      {
        label: '角色权限已保存',
        status: rolePermissionsChanged ? '需处理' : '通过',
        detail: rolePermissionsChanged ? `还有 ${rolePermissionChangeCount} 项权限改动未保存` : '当前权限矩阵已保存',
        action: rolePermissionsChanged ? '点击“保存权限改动”，确保管理员、使用者、审核员、提交人和观察员权限边界生效。' : ''
      },
      {
        label: '上传链路限制',
        status: systemConfig && Number(systemConfig.maxFileSizeMb) >= 1 && Number(systemConfig.maxFileSizeMb) <= 20 && Number(systemConfig.maxUploadFiles) >= 1 && Number(systemConfig.maxUploadFiles) <= 12 ? '通过' : '需处理',
        detail: systemConfig
          ? `单文件 ${systemConfig.maxFileSizeMb || 20}MiB，单次 ${systemConfig.maxUploadFiles || 12} 个，总量 48MiB；Nginx 网关上限 50m。`
          : '上传限制配置未加载',
        action: systemConfig ? '' : '刷新系统配置；生产 Nginx 与后端必须同时保持上述硬上限。'
      },
      {
        label: '账号风险收口',
        status: dashboardStats ? (accountRiskCount > 0 ? '需处理' : '通过') : '待确认',
        detail: dashboardStats
          ? accountRiskDetailText(userStats)
          : '账号风险统计未加载',
        action: accountRiskCount > 0 ? '进入人员管理，完成默认密码改密、待改密账号跟进和登录锁定处理。' : ''
      },
      {
        label: '服务器备份快照',
        status: snapshotLoadError ? '待确认' : backupSnapshotSummary?.total > 0 ? (backupFresh ? '通过' : '待确认') : '需处理',
        detail: snapshotLoadError
          ? '备份快照读取失败，当前数量和新鲜度未知'
          : backupSnapshotSummary?.total > 0
            ? `已有 ${backupSnapshotSummary.total} 个快照，最近 ${backupLatestAt ? new Date(backupLatestAt).toLocaleString('zh-CN', { hour12: false }) : '未记录'}`
            : '上线前建议先创建一次服务器本地快照',
        action: snapshotLoadError
          ? '先刷新快照列表并确认服务器备份接口可用。'
          : backupSnapshotSummary?.total > 0 && backupFresh ? '' : '点击“创建上线快照”，保留当前云端可回滚版本。'
      },
      {
        label: 'Hermes Profile 接入',
        status: hermesStatus
          ? hermesStatus.ok === false
            ? '需处理'
            : hermesStatus.enabled === false || (hermesSummary.missingCount || 0) > 0 || (hermesSummary.driftCount || 0) > 0
              ? '待确认'
              : '通过'
          : '待确认',
        detail: hermesStatus
          ? hermesStatus.ok === false
            ? hermesStatus.message || 'Hermes 状态读取失败'
            : `匹配 ${hermesSummary.matchedCount || 0}/${hermesSummary.webCount || 0}，缺失 ${hermesSummary.missingCount || 0}，差异 ${hermesSummary.driftCount || 0}`
          : '上线前请点击“检查 Profile 接入”完成一次确认',
        action: hermesStatus?.diagnostic?.nextAction || (hermesStatus ? ((hermesSummary.missingCount || 0) > 0 || (hermesSummary.driftCount || 0) > 0 ? '进入机器人配置页核对 8 个一级专业 Profile 的缺失和差异。' : '') : '点击“检查 Hermes”，确认云端 8 个一级专业 Profile 已可读取。')
      },
      {
        label: '完整 Profile 定义核验',
        status: dashboardStats
          ? enabledProfileItems.length > 0 && unverifiedProfileItems.length === 0
            ? '通过'
            : '需处理'
          : '待确认',
        detail: dashboardStats
          ? enabledProfileItems.length === 0
            ? '当前没有已启用的专业 Profile'
            : unverifiedProfileItems.length > 0
              ? `${unverifiedProfileItems.length}/${enabledProfileItems.length} 个配置启用 Profile 尚未完成整个定义核验：${unverifiedProfileItems.slice(0, 4).map(profile => profile.name).join('、')}${unverifiedProfileItems.length > 4 ? '等' : ''}`
              : `${enabledProfileItems.length} 个启用 Profile 均已记录完整定义指纹、核验人和时间`
          : 'Profile 定义核验状态尚未加载',
        action: unverifiedProfileItems.length > 0
          ? '进入机器人配置，逐个核对名称、范围、输出物、提示、路由和排序的正式依据；Hermes 技术同步不能替代业务审批。'
          : enabledProfileItems.length === 0
            ? '先配置并启用需要参与审核的专业 Profile。'
            : ''
      },
      {
        label: 'AI 运行模式',
        status: aiRuntime.provider === 'hermes' && aiRuntime.agentConfigured === true ? '通过' : '需处理',
        detail: `当前 Provider：${managedAiProvider}；模型：${managedAiModel}；${aiInferenceState}`,
        action: aiRuntime.agentConfigured === true
          ? ''
          : '先在供应商控制台轮换并撤销旧密钥，再通过 root:root 0600 环境文件受控启用；未完成前系统保持 draft-only。'
      },
      {
        label: 'AI 实测链路',
        status: aiProbeFailed
          ? '需处理'
          : aiProbeMode === 'hermes-agent' && !aiProbeFallback && !aiProbeStale
            ? '通过'
            : aiProbeHasResult
              ? '待确认'
              : '待确认',
        detail: aiTestResult
          ? `最近测试：${aiProbeModeName || '未记录模式'}；${aiTestResult.at ? `时间 ${formatDateTime(aiTestResult.at)}；` : ''}引擎 ${aiTestResult.engine || '-'}；Agent ${aiTestResult.agentProvider || '-'}/${aiTestResult.agentModel || '-'}；样例意见 ${aiTestResult.sample?.opinions ?? 0} 条${aiProbeStale ? '；已超过24小时' : ''}`
          : aiTraceStats.latestAt
            ? `最近审核：${aiTraceStats.latestAt}；模式 ${aiProbeModeName || '未记录模式'}；${aiTraceStats.latestProvider || '-'}/${aiTraceStats.latestModel || '-'}${aiProbeStale ? '；已超过24小时' : ''}`
            : '尚未完成 AI 连接实测',
        action: aiProbeMode === 'hermes-agent' && !aiProbeFallback && !aiProbeStale
          ? ''
          : aiProbeFailed
            ? '点击“测试 AI 连接”，根据错误信息修复 Hermes 网关、密钥或模型配置。'
            : aiProbeStale
              ? '最近 AI 实测已超过 24 小时，请重新点击“测试 AI 连接”确认 Hermes Agent 链路。'
              : '点击“测试 AI 连接”，确认返回模式为 Hermes Agent 且未回退。'
      }
    ]
  }, [aiRuntime, aiTestResult, backupSnapshotSummary, dashboardStats, enabledProfileItems, health, hermesStatus, networkDiagnostics, rolePermissionChangeCount, rolePermissionsChanged, runtime?.port, snapshotLoadError, systemConfig, unverifiedProfileItems])
  const launchGateGroups = useMemo(() => {
    const itemByLabel = new Map(launchReadinessItems.map(item => [item.label, item]))
    const groups = [
      { title: '公网入口', labels: ['云端服务健康', '公网域名解析', '系统配置已加载'], tone: 'cyan', actionLabel: '刷新公网诊断' },
      { title: '权限账号', labels: ['角色权限已保存', '账号风险收口'], tone: 'amber', actionLabel: '处理账号权限' },
      { title: '数据备份', labels: ['服务器备份快照'], tone: 'emerald', actionLabel: '创建上线快照' },
      { title: 'Hermes 接入', labels: ['Hermes Profile 接入', '完整 Profile 定义核验'], tone: 'blue', actionLabel: '处理 Profile' },
      { title: 'AI 实测', labels: ['AI 运行模式', 'AI 实测链路'], tone: 'violet', actionLabel: '测试 AI 连接' },
      { title: '上传链路', labels: ['上传链路限制'], tone: 'slate', actionLabel: '调整上传配置' }
    ]
    return groups.map(group => {
      const items = group.labels.map(label => itemByLabel.get(label)).filter(Boolean)
      const passed = items.filter(item => item.status === '通过').length
      const primaryIssue = items.find(item => item.status === '需处理') || items.find(item => item.status !== '通过')
      const status = primaryIssue
        ? primaryIssue.status === '需处理' ? '需处理' : '待确认'
        : '通过'
      return {
        ...group,
        items,
        passed,
        total: items.length,
        status,
        primaryIssueLabel: primaryIssue?.label || '',
        detail: primaryIssue?.detail || '门禁已满足上线要求',
        action: primaryIssue?.action || ''
      }
    })
  }, [launchReadinessItems])
  const launchGateReadyCount = launchGateGroups.filter(group => group.status === '通过').length
  const launchReadinessPassed = launchReadinessItems.filter(item => item.status === '通过').length
  const launchReadinessIssueCount = launchReadinessItems.length - launchReadinessPassed
  const launchReadinessSummary = `上线准备度 ${launchReadinessPassed}/${launchReadinessItems.length} 项通过；待处理 ${launchReadinessIssueCount} 项；最近刷新 ${formatDateTime(launchReadinessRefreshedAt)}`
  const latestLaunchApprovalSummary = latestLaunchApprovalError
    ? '最近上线确认读取失败，当前数量未知'
    : latestLaunchApproval
      ? `最近上线确认：${latestLaunchApproval.actor || '未知账号'}，${latestLaunchApproval.at || '未记录'}，结论 ${latestLaunchApproval.metadata?.passed ?? 0}/${latestLaunchApproval.metadata?.total ?? 0}`
      : '近 30 天暂无上线确认记录'
  const accountRiskStats = dashboardStats?.userStats || {}
  const accountRiskActions = [
    accountRiskStats.defaultPassword > 0
      ? { label: `默认密码 ${accountRiskStats.defaultPassword}`, to: '/users?password=默认密码&select=visible', tone: 'red' }
      : null,
    accountRiskStats.mustChangePassword > 0
      ? { label: `需改密 ${accountRiskStats.mustChangePassword}`, to: '/users?password=需改密&select=visible', tone: 'amber' }
      : null,
    accountRiskStats.loginLocked > 0
      ? { label: `登录锁定 ${accountRiskStats.loginLocked}`, to: '/users?security=登录锁定&select=visible', tone: 'orange' }
      : null,
    Array.isArray(accountRiskStats.latestPasswordNotice?.targetUsernames) && accountRiskStats.latestPasswordNotice.targetUsernames.length > 0
      ? { label: '最近文案涉及账号', to: '/users?notice=latest&select=visible', tone: 'blue' }
      : null
  ].filter(Boolean)
  const latestLaunchApprovalRiskSummary = latestLaunchApproval?.metadata?.riskSummary || {}
  const latestLaunchApprovalRoleSummary = Array.isArray(latestLaunchApprovalRiskSummary.byRole)
    ? latestLaunchApprovalRiskSummary.byRole
    : []

  useEffect(() => {
    (async () => {
      try {
        const [healthData, permissionData, systemConfigData, networkData, dashboardData] = await Promise.all([
          api.get('/health'),
          api.get('/role-permissions'),
          api.get('/system-config'),
          api.get('/network-diagnostics').catch(() => ({ diagnostics: null })),
          api.get('/dashboard').catch(() => null)
        ])
        setHealth(healthData)
        setRoles(permissionData.roles || [])
        setPermissions(permissionData.permissions || [])
        setDefaultRolePermissions(permissionData.defaultRolePermissions || {})
        setRolePermissions(permissionData.rolePermissions || {})
        setSavedRolePermissions(permissionData.rolePermissions || {})
        setRoleImpact(permissionData.roleImpact || {})
        setLatestRolePermissionUpdate(permissionData.latestRolePermissionUpdate || null)
        setSystemConfig(systemConfigData.config || null)
        setRuntime(systemConfigData.runtime || null)
        setAiTestResult(systemConfigData.latestAiAdapterTest || null)
        setNetworkDiagnostics(networkData.diagnostics || null)
        setDashboardStats(dashboardData || null)
        setLaunchReadinessRefreshedAt(new Date().toISOString())
        loadBackupSnapshots()
        loadLatestLaunchApproval()
        loadLaunchGateActivity()
      } catch (err) {
        setHealth({ ok: false, service: 'first-service-review-system' })
        setError(err.message || '系统配置加载失败')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  useEffect(() => {
    const warnBeforeUnload = (event) => {
      if (!rolePermissionsChanged) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [rolePermissionsChanged])

  const loadBackupSnapshots = async () => {
    setSnapshotsLoading(true)
    try {
      const data = await api.get('/system-backup/snapshots')
      const snapshots = data.snapshots || []
      setBackupSnapshots(snapshots)
      setBackupSnapshotSummary(data.summary || null)
      setSnapshotLoadError('')
      setSnapshotPreview(prev => (prev && !snapshots.some(snapshot => snapshot.name === prev.name) ? null : prev))
    } catch {
      setSnapshotLoadError('备份快照读取失败，当前列表可能已过期；请刷新后再进行恢复或清理。')
    } finally {
      setSnapshotsLoading(false)
    }
  }

  const loadLatestLaunchApproval = async ({ notify = false } = {}) => {
    setLoadingLatestLaunchApproval(true)
    if (notify) {
      setMessage('')
      setError('')
    }
    try {
      const query = new URLSearchParams({
        type: '系统配置',
        actionGroup: '上线确认',
        range: '近30天',
        limit: '1',
        offset: '0'
      })
      const data = await api.get(`/logs?${query.toString()}`)
      setLatestLaunchApproval((data.logs || [])[0] || null)
      setLatestLaunchApprovalError('')
      if (notify) setMessage('最近上线确认已刷新')
    } catch {
      setLatestLaunchApprovalError('最近上线确认读取失败，当前记录状态未知。')
      if (notify) setError('最近上线确认读取失败')
    } finally {
      setLoadingLatestLaunchApproval(false)
    }
  }

  const loadLaunchGateActivity = async ({ notify = false } = {}) => {
    setLoadingLaunchGateActivity(true)
    if (notify) {
      setMessage('')
      setError('')
    }
    try {
      const query = new URLSearchParams({
        type: '系统配置',
        range: '近30天',
        limit: '80',
        offset: '0'
      })
      const data = await api.get(`/logs?${query.toString()}`)
      setLaunchGateActivity(launchGateActivityFromLogs(data.logs || []))
      setLaunchGateActivityError('')
      if (notify) setMessage('最近门禁处理记录已刷新')
    } catch {
      setLaunchGateActivityError('最近门禁处理记录读取失败，当前数量未知。')
      if (notify) setError('最近门禁处理记录读取失败')
    } finally {
      setLoadingLaunchGateActivity(false)
    }
  }

  const updateLaunchApprovalFreshHours = (value) => {
    const next = normalizeLaunchApprovalFreshHours(value)
    setLaunchApprovalFreshHours(next)
    try {
      localStorage.setItem(launchApprovalFreshHoursKey, String(next))
    } catch {
      // 忽略本地偏好写入失败，不影响上线检查功能
    }
  }

  const refreshLaunchReadiness = async ({ silent = false } = {}) => {
    setRefreshingLaunchReadiness(true)
    if (!silent) {
      setMessage('')
      setError('')
    }
    try {
      const [healthData, permissionData, systemConfigData, snapshotData, hermesData, approvalData, networkData, dashboardData, gateActivityData] = await Promise.all([
        api.get('/health'),
        api.get('/role-permissions'),
        api.get('/system-config'),
        api.get('/system-backup/snapshots').catch(() => ({ snapshots: null, summary: null, loadError: '备份快照读取失败，当前数量未知。' })),
        api.get('/profiles/hermes-status').catch(err => err.data?.ok === false ? err.data : null),
        api.get(`/logs?${new URLSearchParams({ type: '系统配置', actionGroup: '上线确认', range: '近30天', limit: '1', offset: '0' }).toString()}`).catch(() => ({ logs: null, loadError: '最近上线确认读取失败，当前记录状态未知。' })),
        api.get('/network-diagnostics').catch(() => ({ diagnostics: null })),
        api.get('/dashboard').catch(() => null),
        api.get(`/logs?${new URLSearchParams({ type: '系统配置', range: '近30天', limit: '80', offset: '0' }).toString()}`).catch(() => ({ logs: null, loadError: '最近门禁处理记录读取失败，当前数量未知。' }))
      ])
      setHealth(healthData)
      setRoles(permissionData.roles || [])
      setPermissions(permissionData.permissions || [])
      setDefaultRolePermissions(permissionData.defaultRolePermissions || {})
      if (!rolePermissionsChanged) {
        setRolePermissions(permissionData.rolePermissions || {})
        setSavedRolePermissions(permissionData.rolePermissions || {})
      } else {
        setSavedRolePermissions(permissionData.rolePermissions || savedRolePermissions)
      }
      setRoleImpact(permissionData.roleImpact || {})
      setLatestRolePermissionUpdate(permissionData.latestRolePermissionUpdate || null)
      setSystemConfig(systemConfigData.config || null)
      setRuntime(systemConfigData.runtime || null)
      setAiTestResult(systemConfigData.latestAiAdapterTest || null)
      setNetworkDiagnostics(networkData.diagnostics || null)
      setDashboardStats(dashboardData || null)
      if (!snapshotData.loadError) {
        setBackupSnapshots(snapshotData.snapshots || [])
        setBackupSnapshotSummary(snapshotData.summary || null)
      }
      setSnapshotLoadError(snapshotData.loadError || '')
      if (hermesData) setHermesStatus(hermesData)
      if (!approvalData.loadError) setLatestLaunchApproval((approvalData.logs || [])[0] || null)
      setLatestLaunchApprovalError(approvalData.loadError || '')
      if (!gateActivityData.loadError) setLaunchGateActivity(launchGateActivityFromLogs(gateActivityData.logs || []))
      setLaunchGateActivityError(gateActivityData.loadError || '')
      setLaunchReadinessRefreshedAt(new Date().toISOString())
      if (!silent) {
        setMessage(rolePermissionsChanged
          ? '上线检查已刷新。当前仍有未保存权限改动，已保留你的编辑。'
          : '上线检查已刷新。')
      }
    } catch (err) {
      if (!silent) setError(err.message || '上线检查刷新失败')
    } finally {
      setRefreshingLaunchReadiness(false)
    }
  }

  const togglePermission = (role, permissionKey) => {
    const roleCeiling = defaultRolePermissions[role] || []
    if (!isAdministrator) return setError('仅管理员角色可修改权限矩阵')
    if (role === '管理员') return setError('管理员固定保留全部权限，不允许增减')
    if (!roleCeiling.includes(permissionKey)) return setError('该权限超出角色安全上限，不允许启用')
    setMessage('')
    setError('')
    setRolePermissions(prev => {
      const current = prev[role] || []
      const exists = current.includes(permissionKey)
      return {
        ...prev,
        [role]: exists
          ? current.filter(item => item !== permissionKey)
          : [...current, permissionKey]
      }
    })
  }

  const saveRolePermissions = async () => {
    if (!isAdministrator) return setError('仅管理员角色可修改权限矩阵')
    if (!rolePermissionsChanged) return
    const confirmText = window.prompt(`${rolePermissionConfirmText(rolePermissionChanges)}\n\n如确认保存，请输入：保存权限矩阵`)?.trim()
    if (confirmText !== '保存权限矩阵') {
      setError('请输入“保存权限矩阵”后再保存角色权限改动')
      return
    }
    setSavingPermissions(true)
    setMessage('')
    setError('')
    try {
      const data = await api.patch('/role-permissions', { rolePermissions, confirmText })
      setRoles(data.roles || roles)
      setPermissions(data.permissions || permissions)
      setDefaultRolePermissions(data.defaultRolePermissions || defaultRolePermissions)
      setRolePermissions(data.rolePermissions || rolePermissions)
      setSavedRolePermissions(data.rolePermissions || rolePermissions)
      setRoleImpact(data.roleImpact || roleImpact)
      setLatestRolePermissionUpdate(data.latestRolePermissionUpdate || latestRolePermissionUpdate)
      if (data.noChange) {
        setMessage('角色权限矩阵没有变更，无需保存。')
        return
      }
      await refreshSession()
      const revokedSessionText = Number(data.revokedSessionCount) > 0
        ? `，已撤销受影响角色 ${data.revokedSessionCount} 个旧会话`
        : ''
      setMessage(`角色权限矩阵已保存，当前会话和新登录会话都会按新权限生效${revokedSessionText}。`)
    } catch (err) {
      setError(err.message || '角色权限保存失败')
    } finally {
      setSavingPermissions(false)
    }
  }

  const resetRolePermissions = () => {
    setRolePermissions(savedRolePermissions)
    setMessage('已撤销未保存的角色权限改动')
    setError('')
  }

  const restoreDefaultRolePermissions = () => {
    if (!isAdministrator) return setError('仅管理员角色可修改权限矩阵')
    if (rolePermissionsIsDefault) return
    if (!window.confirm('确认载入默认角色权限？该操作不会立即保存，可在确认变更明细后再保存。')) return
    setRolePermissions(defaultRolePermissions)
    setMessage('已载入默认角色权限，请确认变更后保存')
    setError('')
  }

  const copyDefaultRolePermissionDiff = async () => {
    const currentUser = getUser()
    const content = rolePermissionDefaultDiffText(defaultRolePermissionChanges, currentUser?.name || currentUser?.username || '')
    try {
      await copyText(content)
      setMessage('默认权限差异摘要已复制')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: '默认权限差异摘要',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const copyUnsavedRolePermissionChanges = async () => {
    const currentUser = getUser()
    const content = rolePermissionUnsavedText(rolePermissionChanges, currentUser?.name || currentUser?.username || '')
    try {
      await copyText(content)
      setMessage('未保存权限改动摘要已复制')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: '未保存权限改动摘要',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const updateSystemConfig = (key, value) => {
    setMessage('')
    setError('')
    setAiTestResult(null)
    setSystemConfig(prev => ({ ...(prev || {}), [key]: value }))
  }

  const focusRuntimeConfig = () => {
    runtimeConfigRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setMessage('已定位到运行与账号安全配置，可调整上传上限、公网域名和登录策略。')
    setError('')
  }

  const refreshNetworkDiagnostics = async ({ silent = false } = {}) => {
    setCheckingNetworkDiagnostics(true)
    if (!silent) {
      setMessage('')
      setError('')
    }
    try {
      const data = await api.post('/network-diagnostics', { config: systemConfig || {}, audit: !silent })
      setNetworkDiagnostics(data.diagnostics || null)
      if (!silent) {
        setMessage(data.diagnostics?.message || '公网解析诊断已刷新。')
      }
      return data.diagnostics || null
    } catch (err) {
      if (!silent) setError(err.message || '公网解析诊断失败')
      return null
    } finally {
      setCheckingNetworkDiagnostics(false)
    }
  }

  const copyNetworkDiagnostics = async () => {
    const diagnostics = await refreshNetworkDiagnostics({ silent: true })
    if (!diagnostics) {
      setError('公网解析诊断尚未生成')
      setMessage('')
      return
    }
    const currentUser = getUser()
    const content = networkDiagnosticsText(diagnostics, currentUser?.name || currentUser?.username || '')
    try {
      await copyText(content)
      setMessage('公网解析诊断已复制')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: '公网解析诊断',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const downloadNetworkDiagnostics = async () => {
    setDownloadingNetworkDiagnostics(true)
    setError('')
    try {
      const diagnostics = await refreshNetworkDiagnostics({ silent: true })
      if (!diagnostics) throw new Error('公网解析诊断尚未生成')
      const currentUser = getUser()
      const generatedAt = new Date().toISOString()
      downloadJsonFile(`network-diagnostics-${generatedAt.replace(/[:.]/g, '-')}.json`, {
        title: '公网解析诊断',
        source: '第一服务研发小组审核系统 / 系统设置 / 运行与账号安全配置',
        generatedAt,
        operator: currentUser?.name || currentUser?.username || '',
        config: {
          publicDomain: systemConfig?.publicDomain || '',
          publicIp: systemConfig?.publicIp || '',
          frontendUrl: systemConfig?.frontendUrl || ''
        },
        diagnostics
      })
      setMessage('公网解析诊断 JSON 已下载')
    } catch (err) {
      setError(err.message || '公网解析诊断 JSON 下载失败')
    } finally {
      setDownloadingNetworkDiagnostics(false)
    }
  }

  const saveSystemConfig = async () => {
    const confirmText = window.prompt('保存系统运行与账号安全配置会影响会话时长、登录锁定、上传限制、公网诊断参数和可信 IP；AI 与服务运行项由云端部署管理，不会在此修改。\n请输入“保存系统配置”继续：')?.trim()
    if (confirmText !== '保存系统配置') {
      setError('请输入“保存系统配置”后再保存系统配置')
      return
    }
    setSavingSystemConfig(true)
    setMessage('')
    setError('')
    try {
      const submittedConfig = systemConfig || {}
      const data = await api.patch('/system-config', { config: submittedConfig, confirmText })
      const normalizedConfig = data.config || submittedConfig
      setSystemConfig(normalizedConfig)
      if (data.runtime) setRuntime(prev => ({ ...(prev || {}), ...data.runtime }))
      setAiTestResult(data.latestAiAdapterTest || null)
      await refreshNetworkDiagnostics({ silent: true })
      const ignoredIps = data.ignoredTrustedLoginIps || []
      const ignoredManagedFields = Array.isArray(data.ignoredManagedFields) ? data.ignoredManagedFields : []
      const normalizationNotes = systemConfigNormalizationNotes(submittedConfig, normalizedConfig)
      const detailText = [
        ignoredIps.length ? `已忽略 ${ignoredIps.length} 个格式错误的 IP：${ignoredIps.join('、')}` : '',
        ignoredManagedFields.length ? `云端固定项保持运行态值：${ignoredManagedFields.join('、')}` : '',
        normalizationNotes.length ? `已按范围修正：${normalizationNotes.slice(0, 4).join('；')}${normalizationNotes.length > 4 ? ` 等 ${normalizationNotes.length} 项` : ''}` : ''
      ].filter(Boolean).join('；')
      setMessage(detailText ? `可编辑的账号安全与诊断配置已保存。${detailText}` : '可编辑的账号安全与诊断配置已保存；云端固定运行项未变更。')
    } catch (err) {
      setError(err.message || '系统配置保存失败')
    } finally {
      setSavingSystemConfig(false)
    }
  }

  const testAiAdapter = async () => {
    setTestingAi(true)
    setAiTestResult(null)
    setMessage('')
    setError('')
    try {
      const data = await api.post('/system-config/ai-test', { config: systemConfig })
      setAiTestResult(data)
      if (data.runtime) setRuntime(prev => ({ ...(prev || {}), ai: data.runtime }))
      const dashboardData = await api.get('/dashboard').catch(() => null)
      if (dashboardData) setDashboardStats(dashboardData)
      setMessage(data.message || 'AI 适配器探测通过。')
    } catch (err) {
      const data = err.data || {}
      if (data.runtime) setRuntime(prev => ({ ...(prev || {}), ai: data.runtime }))
      setAiTestResult(data.ok === false ? data : null)
      setError(data.message || err.message || 'AI 适配器探测失败')
    } finally {
      setTestingAi(false)
    }
  }

  const checkHermesProfiles = async () => {
    setCheckingHermesProfiles(true)
    setHermesStatus(null)
    setMessage('')
    setError('')
    try {
      // 人工执行的接入检查需要留痕；页面初载和“刷新全部检查”仍使用无副作用 GET。
      const data = await api.post('/profiles/hermes-status', {})
      setHermesStatus(data)
      if (data.runtime) setRuntime(prev => ({ ...(prev || {}), ai: data.runtime }))
      setMessage(data.message || 'Hermes Profile 接入状态已更新。')
    } catch (err) {
      const data = err.data || {}
      setHermesStatus(data.ok === false ? data : null)
      if (data.runtime) setRuntime(prev => ({ ...(prev || {}), ai: data.runtime }))
      setError(data.message || err.message || 'Hermes Profile 接入状态读取失败')
    } finally {
      setCheckingHermesProfiles(false)
    }
  }

  const handleLaunchGateAction = async (group) => {
    if (!group || group.status === '通过') return
    if (group.title === '公网入口') {
      await refreshNetworkDiagnostics()
      await refreshLaunchReadiness({ silent: true })
      return
    }
    if (group.title === '数据备份') {
      await createServerSnapshot()
      await refreshLaunchReadiness({ silent: true })
      return
    }
    if (group.title === 'Hermes 接入') {
      if (group.primaryIssueLabel === '完整 Profile 定义核验') {
        const profileId = unverifiedProfileItems[0]?.id || enabledProfileItems[0]?.id || ''
        navigate(`/bots${profileId ? `?profile=${encodeURIComponent(profileId)}` : ''}`)
        return
      }
      await checkHermesProfiles()
      await refreshLaunchReadiness({ silent: true })
      return
    }
    if (group.title === 'AI 实测') {
      await testAiAdapter()
      await refreshLaunchReadiness({ silent: true })
      return
    }
    if (group.title === '上传链路') {
      focusRuntimeConfig()
      return
    }
    if (group.title === '权限账号') {
      if (group.primaryIssueLabel === '角色权限已保存' && rolePermissionsChanged) {
        await saveRolePermissions()
        await refreshLaunchReadiness({ silent: true })
        return
      }
      const firstRiskAction = accountRiskActions[0]
      if (firstRiskAction) {
        navigate(firstRiskAction.to)
        return
      }
    }
    refreshLaunchReadiness()
  }

  const copyHermesStatus = async () => {
    if (!hermesStatus) return
    const currentUser = getUser()
    const content = hermesStatusText(hermesStatus, currentUser?.name || currentUser?.username || '')
    try {
      await copyText(content)
      setMessage('Hermes Profile 接入诊断已复制')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: 'Hermes Profile 接入诊断',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const copyLaunchReadiness = async () => {
    const currentUser = getUser()
    const content = launchReadinessText(launchReadinessItems, currentUser?.name || currentUser?.username || '', launchReadinessRefreshedAt)
    try {
      await copyText(content)
      setMessage('上线检查摘要已复制')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: '上线检查摘要',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const copyLaunchReadinessIssues = async () => {
    const currentUser = getUser()
    const content = launchReadinessIssuesText(launchReadinessItems, currentUser?.name || currentUser?.username || '', launchReadinessRefreshedAt)
    try {
      await copyText(content)
      setMessage('上线待处理项已复制')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: '上线待处理项',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const copyLaunchApproval = async () => {
    if (launchReadinessIssueCount > 0 || confirmingLaunchApproval) return
    setConfirmingLaunchApproval(true)
    const currentUser = getUser()
    const content = launchApprovalText(launchReadinessItems, currentUser?.name || currentUser?.username || '', launchReadinessRefreshedAt, appVersion, appBuildLabel)
    try {
      const data = await api.post('/launch-approvals', {
        appVersion,
        appBuildTime,
        appBuildLabel,
        refreshedAt: launchReadinessRefreshedAt || '',
        summary: {
          passed: launchReadinessPassed,
          total: launchReadinessItems.length
        },
        items: launchReadinessItems.map(item => ({
          label: item.label,
          status: item.status,
          detail: item.detail,
          action: item.action || ''
        }))
      })
      setLatestLaunchApproval({
        id: data.approval?.id || `LA${Date.now()}`,
        actor: data.approval?.actor || currentUser?.name || currentUser?.username || '未知账号',
        action: `生成上线确认记录（${launchReadinessPassed}/${launchReadinessItems.length} 项通过）`,
        result: '成功',
        at: data.approval?.generatedAt || new Date().toLocaleString('zh-CN', { hour12: false }),
        metadata: data.approval || {}
      })
      await copyText(content)
      setMessage('上线确认记录已写入系统日志并复制')
      setError('')
    } catch (err) {
      if (err?.status) {
        const riskMessage = accountRiskBlockMessage(err.data?.riskSummary)
        setError(riskMessage ? `${err.message || '上线确认记录写入失败'} 请先处理：${riskMessage}` : err.message || '上线确认记录写入失败')
        if (err.data?.networkDiagnostics) setNetworkDiagnostics(err.data.networkDiagnostics)
        if (err.data?.latestAiAdapterTest) setAiTestResult(err.data.latestAiAdapterTest)
        if (err.data?.backupSnapshotSummary) setBackupSnapshotSummary(err.data.backupSnapshotSummary)
        if (err.data?.latestBackupSnapshot) {
          setBackupSnapshots(prev => {
            const latest = err.data.latestBackupSnapshot
            const rest = (prev || []).filter(snapshot => snapshot.name !== latest.name)
            return [latest, ...rest]
          })
        }
        if (err.data?.latestHermesProfileStatusCheck) {
          const latestHermes = err.data.latestHermesProfileStatusCheck
          setHermesStatus(prev => ({
            ...(prev || {}),
            ok: latestHermes.result === '成功',
            enabled: true,
            checkedAt: latestHermes.checkedAt || latestHermes.at || '',
            runtime: {
              ...(prev?.runtime || {}),
              provider: latestHermes.provider || prev?.runtime?.provider || '',
              model: latestHermes.model || prev?.runtime?.model || ''
            },
            summary: {
              webCount: latestHermes.webCount || 0,
              remoteCount: latestHermes.remoteCount || 0,
              matchedCount: latestHermes.matchedCount || 0,
              missingCount: latestHermes.missingCount || 0,
              driftCount: latestHermes.driftCount || 0
            },
            health: latestHermes.health || prev?.health || null,
            healthError: latestHermes.healthError || '',
            message: latestHermes.message || 'Hermes Profile 接入检查未满足上线要求。'
          }))
        }
        if (err.data?.riskSummary) {
          setDashboardStats(prev => ({
            ...(prev || {}),
            userStats: {
              ...(prev?.userStats || {}),
              ...err.data.riskSummary,
              defaultPassword: err.data.riskSummary.defaultPassword || 0,
              mustChangePassword: err.data.riskSummary.mustChangePassword || 0,
              loginLocked: err.data.riskSummary.loginLocked || 0
            }
          }))
        }
        setMessage('')
        return
      }
      setCopyFallback({
        open: true,
        title: '上线确认记录',
        description: '上线确认记录已写入系统日志。当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('上线确认记录已写入系统日志')
      setError('')
    } finally {
      setConfirmingLaunchApproval(false)
    }
  }

  const copyLatestLaunchApproval = async () => {
    if (!latestLaunchApproval) return
    const content = latestLaunchApprovalText(latestLaunchApproval, launchApprovalFreshHours)
    try {
      await copyText(content)
      setMessage('最近上线确认记录已复制')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: '最近上线确认记录',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const downloadLatestLaunchApproval = () => {
    if (!latestLaunchApproval) return
    setDownloadingLatestLaunchApproval(true)
    setMessage('')
    setError('')
    const metadata = latestLaunchApproval.metadata || {}
    const items = Array.isArray(metadata.items) ? metadata.items.map(item => ({
      label: String(item?.label || ''),
      status: String(item?.status || ''),
      detail: String(item?.detail || ''),
      action: String(item?.action || '')
    })).filter(item => item.label) : []
    const generatedAt = new Date().toISOString()
    const confirmedAt = latestLaunchApproval.at || metadata.generatedAt || ''
    const freshHours = normalizeLaunchApprovalFreshHours(launchApprovalFreshHours)
    const expired = olderThanHours(confirmedAt, freshHours)
    const riskSummary = metadata.riskSummary || {}
    const roleSnapshot = Array.isArray(riskSummary.byRole) ? riskSummary.byRole : []
    const report = {
      source: '第一服务研发小组审核系统 / 系统设置 / 最近上线确认',
      exportedAt: generatedAt,
      id: metadata.id || latestLaunchApproval.id || '',
      actor: latestLaunchApproval.actor || metadata.actor || '',
      action: latestLaunchApproval.action || '',
      result: latestLaunchApproval.result || '',
      confirmedAt,
      refreshedAt: metadata.refreshedAt || '',
      appVersion: metadata.appVersion || '',
      freshness: {
        thresholdHours: freshHours,
        expired,
        status: expired ? '建议重新确认' : '当前有效'
      },
      summary: {
        passed: metadata.passed ?? 0,
        total: metadata.total ?? 0
      },
      accountRisk: {
        riskCount: riskSummary.riskCount ?? 0,
        defaultPassword: riskSummary.defaultPassword ?? 0,
        mustChangePassword: riskSummary.mustChangePassword ?? 0,
        loginLocked: riskSummary.loginLocked ?? 0,
        latestPasswordNotice: riskSummary.latestPasswordNotice || null
      },
      roleSnapshot,
      items
    }
    try {
      downloadJsonFile(`latest-launch-approval-${generatedAt.replace(/[:.]/g, '-')}.json`, report)
      setMessage('最近上线确认 JSON 已下载')
    } catch (err) {
      setError(err.message || '最近上线确认 JSON 下载失败')
      setMessage('')
    } finally {
      setDownloadingLatestLaunchApproval(false)
    }
  }

  const downloadLaunchReadiness = () => {
    setDownloadingLaunchReadiness(true)
    setMessage('')
    setError('')
    const currentUser = getUser()
    const generatedAt = new Date().toISOString()
    const report = {
      source: '第一服务研发小组审核系统 / 系统设置 / 上线检查台',
      appVersion,
      appBuildTime,
      appBuildLabel,
      generatedAt,
      refreshedAt: launchReadinessRefreshedAt || null,
      operator: currentUser?.name || currentUser?.username || '未知账号',
      summary: {
        passed: launchReadinessPassed,
        total: launchReadinessItems.length,
        status: launchReadinessPassed === launchReadinessItems.length
          ? 'ready'
          : launchReadinessItems.some(item => item.status === '需处理')
            ? 'blocked'
            : 'pending'
      },
      items: launchReadinessItems.map(item => ({
        label: item.label,
        status: item.status,
        detail: item.detail,
        action: item.action || ''
      }))
    }
    try {
      downloadJsonFile(`launch-readiness-${generatedAt.replace(/[:.]/g, '-')}.json`, report)
      setMessage('上线检查 JSON 摘要已下载')
    } catch (err) {
      setError(err.message || '上线检查 JSON 摘要下载失败')
    } finally {
      setDownloadingLaunchReadiness(false)
    }
  }

  const downloadLaunchAuditPackage = () => {
    setDownloadingLaunchAudit(true)
    setMessage('')
    setError('')
    const currentUser = getUser()
    const generatedAt = new Date().toISOString()
    const latestApprovalMetadata = latestLaunchApproval?.metadata || {}
    const report = {
      source: '第一服务研发小组审核系统 / 系统设置 / 上线审计包',
      appVersion,
      appBuildTime,
      appBuildLabel,
      generatedAt,
      refreshedAt: launchReadinessRefreshedAt || null,
      operator: currentUser?.name || currentUser?.username || '未知账号',
      readiness: {
        passed: launchReadinessPassed,
        total: launchReadinessItems.length,
        issueCount: launchReadinessIssueCount,
        status: launchReadinessPassed === launchReadinessItems.length
          ? 'ready'
          : launchReadinessItems.some(item => item.status === '需处理')
            ? 'blocked'
            : 'pending'
      },
      gateSummary: launchGateGroups.map(group => ({
        title: group.title,
        status: group.status,
        passed: group.passed,
        total: group.total,
        primaryIssue: group.primaryIssueLabel || '',
        detail: group.detail || '',
        action: group.action || ''
      })),
      checks: launchReadinessItems.map(item => ({
        label: item.label,
        status: item.status,
        detail: item.detail,
        action: item.action || ''
      })),
      recentGateActivity: launchGateActivity,
      latestLaunchApproval: latestLaunchApproval ? {
        id: latestApprovalMetadata.id || latestLaunchApproval.id || '',
        actor: latestLaunchApproval.actor || latestApprovalMetadata.actor || '',
        action: latestLaunchApproval.action || '',
        result: latestLaunchApproval.result || '',
        at: latestLaunchApproval.at || latestApprovalMetadata.generatedAt || '',
        passed: latestApprovalMetadata.passed ?? 0,
        total: latestApprovalMetadata.total ?? 0,
        appVersion: latestApprovalMetadata.appVersion || ''
      } : null,
      diagnostics: {
        network: networkDiagnostics || null,
        backupSnapshotSummary: backupSnapshotSummary || null,
        hermesProfileStatus: hermesStatus ? {
          ok: hermesStatus.ok !== false,
          checkedAt: hermesStatus.checkedAt || '',
          runtime: hermesStatus.runtime || null,
          health: hermesStatus.health || null,
          summary: hermesStatus.summary || null,
          message: hermesStatus.message || ''
        } : null,
        aiAdapterTest: aiTestResult || null,
        accountRisk: accountRiskStats || null,
        rolePermissionChanges: {
          unsaved: rolePermissionsChanged,
          changeCount: rolePermissionChangeCount,
          latestUpdate: latestRolePermissionUpdate || null
        }
      }
    }
    try {
      downloadJsonFile(`launch-audit-package-${generatedAt.replace(/[:.]/g, '-')}.json`, report)
      setMessage('上线审计包 JSON 已下载')
    } catch (err) {
      setError(err.message || '上线审计包 JSON 下载失败')
    } finally {
      setDownloadingLaunchAudit(false)
    }
  }

  const downloadLaunchAuditCsv = () => {
    setDownloadingLaunchAuditCsv(true)
    setMessage('')
    setError('')
    const currentUser = getUser()
    const generatedAt = new Date().toISOString()
    const latestApprovalMetadata = latestLaunchApproval?.metadata || {}
    const rows = [
      ['分组', '名称', '状态/结果', '通过数', '总数', '操作人', '时间', '详情', '建议/动作'],
      [
        '上线准备度',
        '总体结论',
        launchReadinessPassed === launchReadinessItems.length
          ? 'ready'
          : launchReadinessItems.some(item => item.status === '需处理')
            ? 'blocked'
            : 'pending',
        launchReadinessPassed,
        launchReadinessItems.length,
        currentUser?.name || currentUser?.username || '未知账号',
        generatedAt,
        `待处理 ${launchReadinessIssueCount} 项；最近刷新 ${formatDateTime(launchReadinessRefreshedAt)}`,
        '上线前请确保所有门禁均为通过'
      ],
      ...launchGateGroups.map(group => [
        '门禁总览',
        group.title,
        group.status,
        group.passed,
        group.total,
        '',
        '',
        group.detail || '',
        group.action || ''
      ]),
      ...launchReadinessItems.map(item => [
        '检查明细',
        item.label,
        item.status,
        '',
        '',
        '',
        '',
        item.detail || '',
        item.action || ''
      ]),
      ...launchGateActivity.map(item => [
        '处理记录',
        item.gate,
        item.result,
        '',
        '',
        item.actor,
        item.at,
        item.action,
        ''
      ])
    ]
    if (latestLaunchApproval) {
      rows.push([
        '最近上线确认',
        latestApprovalMetadata.id || latestLaunchApproval.id || '',
        latestLaunchApproval.result || '',
        latestApprovalMetadata.passed ?? 0,
        latestApprovalMetadata.total ?? 0,
        latestLaunchApproval.actor || latestApprovalMetadata.actor || '',
        latestLaunchApproval.at || latestApprovalMetadata.generatedAt || '',
        latestLaunchApproval.action || '',
        latestApprovalMetadata.appVersion ? `版本 ${latestApprovalMetadata.appVersion}` : ''
      ])
    }
    try {
      downloadCsvFile(`launch-audit-package-${generatedAt.replace(/[:.]/g, '-')}.csv`, rows)
      setMessage('上线审计包 CSV 已下载')
    } catch (err) {
      setError(err.message || '上线审计包 CSV 下载失败')
    } finally {
      setDownloadingLaunchAuditCsv(false)
    }
  }

  const openHermesConfigLogs = () => {
    const query = new URLSearchParams({
      type: '系统配置',
      actionGroup: 'Hermes配置',
      range: '近30天'
    })
    navigate(`/logs?${query.toString()}`)
  }

  const openLaunchApprovalLogs = () => {
    const query = new URLSearchParams({
      type: '系统配置',
      actionGroup: '上线确认',
      range: '近30天'
    })
    navigate(`/logs?${query.toString()}`)
  }

  const openSystemConfigLogs = () => {
    const query = new URLSearchParams({
      type: '系统配置',
      range: '近30天'
    })
    navigate(`/logs?${query.toString()}`)
  }

  const exportLaunchApprovalLogs = async () => {
    const query = new URLSearchParams({
      type: '系统配置',
      actionGroup: '上线确认',
      range: '近30天'
    })
    setExportingLaunchApprovalLogs(true)
    setMessage('')
    setError('')
    try {
      await downloadFile(`/logs/export?${query.toString()}`, `logs-launch-approval-risk-role-${Date.now()}.csv`)
      setMessage('上线确认日志 CSV 已开始下载，文件名已标识账号风险和角色快照。')
    } catch (err) {
      setError(err.message || '上线确认日志导出失败')
    } finally {
      setExportingLaunchApprovalLogs(false)
    }
  }

  const downloadBackup = async () => {
    setBackupDownloading(true)
    setMessage('')
    setError('')
    try {
      const ticket = await api.post('/system-backup/export-ticket')
      downloadWithOneTimeTicket(ticket)
      setMessage('流式系统备份已完成服务器端校验，并已交给浏览器原生下载；票据仅可使用一次且 60 秒后失效。')
    } catch (err) {
      setError(err.message || '系统备份下载失败')
    } finally {
      setBackupDownloading(false)
    }
  }

  const downloadSnapshot = async (name) => {
    setMessage('')
    setError('')
    try {
      const ticket = await api.post(`/system-backup/snapshots/${encodeURIComponent(name)}/download-ticket`)
      downloadWithOneTimeTicket(ticket)
      setMessage('本地备份快照已交给浏览器原生下载；票据仅可使用一次且 60 秒后失效。')
    } catch (err) {
      setError(err.message || '本地备份快照下载失败')
    }
  }

  const createServerSnapshot = async () => {
    const confirmText = '创建备份快照'
    const typed = window.prompt(`确认创建服务器本地备份快照？\n该快照可用于后续回滚当前账号、方案、日志、规则、知识库、机器人配置和附件。\n\n如确认继续，请输入：${confirmText}`)?.trim()
    if (typed !== confirmText) {
      setError(`服务器本地备份快照创建已取消：需输入“${confirmText}”才会执行。`)
      return
    }

    setCreatingSnapshot(true)
    setMessage('')
    setError('')
    try {
      const data = await api.post('/system-backup/snapshots', { confirmText })
      setBackupSnapshots(data.snapshots || [])
      setBackupSnapshotSummary(data.summary || null)
      setMessage(`服务器本地备份快照已创建：${data.snapshotName || '已保存'}`)
    } catch (err) {
      setError(err.message || '服务器本地备份快照创建失败')
    } finally {
      setCreatingSnapshot(false)
    }
  }

  const previewSnapshot = async (name) => {
    setPreviewingSnapshot(name)
    setSnapshotPreview(null)
    setMessage('')
    setError('')
    try {
      const data = await api.get(`/system-backup/snapshots/${encodeURIComponent(name)}/preview`)
      setSnapshotPreview({ name, ...(data.preview || {}) })
      setMessage('本地备份快照预览通过。')
    } catch (err) {
      setError(err.message || '本地备份快照预览失败')
    } finally {
      setPreviewingSnapshot('')
    }
  }

  const deleteSnapshot = async (name) => {
    const confirmText = window.prompt(`删除本地备份快照《${name}》后将不能用于回滚，且不可恢复。\n请输入“删除备份快照”继续：`)?.trim()
    if (confirmText !== '删除备份快照') {
      setError('请输入“删除备份快照”后再执行删除')
      return
    }

    setDeletingSnapshot(name)
    setMessage('')
    setError('')
    try {
      const data = await api.delete(`/system-backup/snapshots/${encodeURIComponent(name)}`, { confirmText })
      const snapshots = data.snapshots || []
      setBackupSnapshots(snapshots)
      setBackupSnapshotSummary(data.summary || null)
      if (snapshotPreview?.name === name) setSnapshotPreview(null)
      setMessage('本地备份快照已删除。')
    } catch (err) {
      setError(err.message || '本地备份快照删除失败')
    } finally {
      setDeletingSnapshot('')
    }
  }

  const restoreSnapshot = async (name) => {
    if (snapshotRestoreConfirm.trim() !== '确认恢复') {
      setError('请输入“确认恢复”后再执行快照恢复')
      return
    }

    setRestoringSnapshot(name)
    setMessage('')
    setError('')
    try {
      const data = await api.post(`/system-backup/snapshots/${encodeURIComponent(name)}/restore`, { confirmText: snapshotRestoreConfirm.trim() })
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      localStorage.removeItem('sessionExpiresAt')
      setMessage(`已从本地备份快照恢复：${data.snapshotName || name}。请重新登录。`)
      window.setTimeout(() => {
        window.location.href = '/login'
      }, 1200)
    } catch (err) {
      setError(err.message || '本地备份快照恢复失败')
    } finally {
      setRestoringSnapshot('')
    }
  }

  const pruneSnapshots = async () => {
    const days = Math.max(1, Number(snapshotRetentionDays) || 30)
    const confirmText = window.prompt(`将清理 ${days} 天以前的本地备份快照，预计删除 ${pruneDueSnapshots.length} 条，释放 ${formatBytes(pruneDueBytes)}。\n被清理的快照将不能再用于回滚。\n请输入“清理旧快照”继续：`)?.trim()
    if (confirmText !== '清理旧快照') {
      setError('请输入“清理旧快照”后再执行清理')
      return
    }

    setPruningSnapshots(true)
    setMessage('')
    setError('')
    try {
      const data = await api.post('/system-backup/snapshots/prune', { retentionDays: days, confirmText })
      const snapshots = data.snapshots || []
      setBackupSnapshots(snapshots)
      setBackupSnapshotSummary(data.summary || null)
      setSnapshotPreview(prev => (prev && !snapshots.some(snapshot => snapshot.name === prev.name) ? null : prev))
      setMessage(`本地备份快照清理完成，已删除 ${data.removedCount || 0} 个。`)
    } catch (err) {
      setError(err.message || '本地备份快照清理失败')
    } finally {
      setPruningSnapshots(false)
    }
  }

  const previewBackup = async (file) => {
    if (!file) return
    const formatError = uploadFormatError(file, ['.tgz'], '备份归档')
    if (formatError) {
      setBackupPreview(null)
      setBackupFile(null)
      setRestoreConfirm('')
      setMessage('')
      setError(formatError)
      return
    }
    setBackupPreviewing(true)
    setBackupPreview(null)
    setBackupFile(null)
    setRestoreConfirm('')
    setMessage('')
    setError('')
    try {
      const data = await uploadFile('/system-backup/preview', file, 'backup')
      setBackupPreview(data.preview || null)
      setBackupFile(file)
      setMessage('备份归档的清单、数据与附件指纹校验通过，可查看下方预览摘要。')
    } catch (err) {
      setError(err.message || '备份归档校验失败')
    } finally {
      setBackupPreviewing(false)
    }
  }

  const restoreBackup = async () => {
    if (!backupFile) {
      setError('请先选择并校验备份归档')
      return
    }
    if (restoreConfirm.trim() !== '确认恢复') {
      setError('请输入“确认恢复”后再执行恢复')
      return
    }

    setRestoringBackup(true)
    setMessage('')
    setError('')
    try {
      const data = await uploadFile('/system-backup/restore', backupFile, 'backup', { confirmText: restoreConfirm.trim() })
      setBackupPreview(null)
      setBackupFile(null)
      setRestoreConfirm('')
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      localStorage.removeItem('sessionExpiresAt')
      setMessage(`系统数据已恢复，恢复前快照已保存：${data.preRestoreBackup || '服务器本地备份目录'}。请重新登录。`)
      window.setTimeout(() => {
        window.location.href = '/login'
      }, 1200)
    } catch (err) {
      setError(err.message || '系统备份恢复失败')
    } finally {
      setRestoringBackup(false)
    }
  }

  const settingsMessageActions = useMemo(() => {
    if (!message) return []
    const actions = []
    if (message.includes('角色权限矩阵')) {
      actions.push({ label: '查看权限变更日志', to: '/logs?type=系统配置&q=角色权限矩阵' })
    }
    if (message.includes('系统运行与账号安全配置')) {
      actions.push({ label: '查看安全分析', to: '/stats?focus=security' })
      actions.push({ label: '查看账号安全日志', to: '/logs?type=账号安全&range=近30天' })
      actions.push({ label: '查看配置变更日志', to: '/logs?type=系统配置&q=系统运行与账号安全配置' })
    }
    if (message.includes('上线确认记录')) {
      actions.push({ label: '查看上线确认日志', to: '/logs?type=系统配置&actionGroup=上线确认&range=近30天' })
    }
    if (message.includes('备份快照') || message.includes('服务器本地备份快照')) {
      actions.push({ label: '查看快照操作日志', to: '/logs?type=系统配置&q=快照' })
    }
    if (message.includes('公网解析诊断')) {
      actions.push({ label: '查看公网诊断日志', to: '/logs?type=系统配置&actionGroup=公网诊断&range=近30天' })
    }
    if (message.includes('Hermes Profile') || message.includes('AI 适配器')) {
      actions.push({ label: '查看 Hermes 配置日志', to: '/logs?type=系统配置&actionGroup=Hermes配置&range=近30天' })
    }
    return actions
  }, [message])

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-blue-200 flex items-center gap-2">
          <Settings size={21} />
          系统设置
        </h1>
        <p className="text-sm text-slate-400 mt-1">查看系统运行状态、版本信息、数据存储、账号安全策略、部署检查项和角色权限矩阵。</p>
      </div>

      {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2">{error}</div>}
      {message && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-2">
          <span>{message}</span>
          {settingsMessageActions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {settingsMessageActions.map(action => (
                <button
                  key={action.to}
                  type="button"
                  onClick={() => navigate(action.to)}
                  className="rounded-lg border border-emerald-300/30 bg-slate-950/25 px-2.5 py-1 text-xs text-emerald-100 hover:border-emerald-200/60"
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Panel className="p-4 min-h-[110px]">
          <div className="flex items-center gap-3 text-blue-100 font-semibold">
            <ShieldCheck size={20} className="text-emerald-300" />
            前端版本
          </div>
          <div className="mt-3 text-2xl font-bold text-cyan-200">{appVersion}</div>
          <div className="text-xs text-slate-500 mt-1">构建时间：{appBuildTimeText || '本地开发模式'}</div>
        </Panel>
        <Panel className="p-4 min-h-[110px]">
          <div className="flex items-center gap-3 text-blue-100 font-semibold">
            <Server size={20} className="text-blue-300" />
            后端状态
          </div>
          <div className={`mt-3 text-2xl font-bold ${health?.ok ? 'text-emerald-300' : 'text-red-300'}`}>
            {loading ? '检测中' : health?.ok ? '运行正常' : '连接异常'}
          </div>
          <div className="text-xs text-slate-500 mt-1">{health?.service || 'first-service-review-system'}</div>
        </Panel>
        <Panel className="p-4 min-h-[110px]">
          <div className="flex items-center gap-3 text-blue-100 font-semibold">
            <Database size={20} className="text-amber-300" />
            数据存储
          </div>
          <div className="mt-3 text-lg font-semibold text-blue-100">JSON 持久化</div>
          <div className="text-xs text-slate-500 mt-1">{runtime?.dataStore || 'backend/data/store.json'}</div>
          <button
            type="button"
            onClick={downloadBackup}
            disabled={backupDownloading || loading}
            className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-amber-400/30 bg-amber-500/10 text-amber-100 text-xs disabled:opacity-50"
          >
            <Download size={14} />
            {backupDownloading ? '下载中...' : '下载备份'}
          </button>
        </Panel>
      </div>

      <Panel className="p-5">
	        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
	          <div>
	            <h2 className="font-semibold text-blue-100 mb-1">备份归档校验</h2>
	            <p className="text-sm text-slate-400">仅支持系统导出的 .firstcare-review-backup.tgz 流式归档。上传后会先校验 manifest、store 与每个附件的大小和 SHA256，不会覆盖当前系统数据。</p>
	          </div>
          <label className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-amber-400/30 bg-amber-500/10 text-amber-100 text-sm cursor-pointer" htmlFor={backupFileInputId}>
            <Upload size={16} aria-hidden="true" />
            {backupPreviewing ? '校验中...' : '选择备份归档'}
            <input
              id={backupFileInputId}
              type="file"
              accept="application/gzip,application/x-gzip,.tgz,.firstcare-review-backup.tgz"
              disabled={backupPreviewing}
              onChange={e => {
                previewBackup(e.target.files?.[0])
                e.target.value = ''
              }}
              className="hidden"
            />
          </label>
        </div>

        {backupPreview ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
              {[
                ['账号', backupPreview.users],
                ['方案', backupPreview.proposals],
                ['日志', backupPreview.logs],
                ['规则', backupPreview.rules],
                ['知识库', backupPreview.knowledgeEntries],
                ['机器人', backupPreview.botProfiles],
                ['附件', backupPreview.files],
                ['附件大小', formatBytes(backupPreview.fileBytes || 0)],
                ['附件校验', `${backupPreview.verifiedFiles || 0}/${backupPreview.files || 0}`],
                ['整体校验', backupPreview.checksumVerified ? '已通过' : '未通过']
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-3">
                  <div className="text-xs text-slate-500">{label}</div>
                  <div className="mt-2 text-lg font-semibold text-blue-100">{value}</div>
                </div>
              ))}
              <div className="md:col-span-4 xl:col-span-8 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
                备份时间：{backupPreview.exportedAt || '未记录'} · 格式版本：{backupPreview.version || '未记录'} · 校验码：{backupPreview.checksum ? backupPreview.checksum.slice(0, 12) : '未记录'}
              </div>
            </div>
            <div className="rounded-lg border border-amber-400/25 bg-amber-500/10 px-4 py-3">
              <div className="text-sm font-medium text-amber-100">恢复会覆盖当前系统数据，后端会先自动保存一份恢复前快照。</div>
              <div className="mt-3 flex flex-col md:flex-row gap-2">
                <input
                  id={restoreConfirmInputId}
                  value={restoreConfirm}
                  onChange={e => setRestoreConfirm(e.target.value)}
                  aria-label="备份恢复确认文本，输入 确认恢复 后才能执行"
                  placeholder="输入 确认恢复"
                  className="w-full md:w-56 px-3 py-2 rounded-lg border border-amber-400/25 bg-slate-950/80 text-white text-sm outline-none focus:border-amber-300/60"
                />
                <button
                  type="button"
                  onClick={restoreBackup}
                  disabled={restoringBackup || restoreConfirm.trim() !== '确认恢复'}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-sm border border-amber-300/40 text-white"
                >
                  <RotateCcw size={16} />
                  {restoringBackup ? '恢复中...' : '确认恢复备份'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-6 text-sm text-slate-500">尚未选择备份归档</div>
        )}

        <div className="mt-4 rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium text-blue-100">本地备份快照</div>
              <div className="text-xs text-slate-500 mt-1">可手动保存服务器本地备份；每次在线恢复前也会自动保存当前数据快照。</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-2 text-xs text-slate-400" htmlFor={snapshotRestoreConfirmInputId}>
                恢复确认
                <input
                  id={snapshotRestoreConfirmInputId}
                  value={snapshotRestoreConfirm}
                  onChange={e => setSnapshotRestoreConfirm(e.target.value)}
                  placeholder="输入 确认恢复"
                  className="w-28 px-2 py-1.5 rounded-lg border border-amber-400/25 bg-slate-950/80 text-white text-xs outline-none focus:border-amber-300/60"
                />
              </label>
              <button
                type="button"
                onClick={createServerSnapshot}
                disabled={creatingSnapshot}
                className="px-3 py-1.5 rounded-lg border border-emerald-400/30 bg-emerald-500/10 text-emerald-100 text-xs disabled:opacity-50"
              >
                {creatingSnapshot ? '创建中...' : '创建快照'}
              </button>
              <label className="inline-flex items-center gap-2 text-xs text-slate-400" htmlFor={snapshotRetentionDaysInputId}>
                保留
                <input
                  id={snapshotRetentionDaysInputId}
                  type="number"
                  min="1"
                  max="3650"
                  value={snapshotRetentionDays}
                  onChange={e => setSnapshotRetentionDays(e.target.value)}
                  className="w-20 px-2 py-1.5 rounded-lg border border-blue-500/25 bg-slate-950/80 text-white text-xs outline-none focus:border-blue-400/60"
                />
                天
              </label>
              <button
                type="button"
                onClick={pruneSnapshots}
                disabled={pruningSnapshots}
                className="px-3 py-1.5 rounded-lg border border-red-400/30 bg-red-500/10 text-red-100 text-xs disabled:opacity-50"
              >
                {pruningSnapshots ? '清理中...' : '清理旧快照'}
              </button>
              <button
                type="button"
                onClick={loadBackupSnapshots}
                disabled={snapshotsLoading}
                className="px-3 py-1.5 rounded-lg border border-blue-400/30 bg-blue-500/10 text-blue-100 text-xs disabled:opacity-50"
              >
                {snapshotsLoading ? '刷新中...' : '刷新快照'}
              </button>
            </div>
          </div>
          {snapshotLoadError && (
            <div role="alert" className="mt-3 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
              {snapshotLoadError}
            </div>
          )}
          {backupSnapshots.length > 0 ? (
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {['全部', '手动备份', '恢复前'].map(type => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => {
                      setSnapshotTypeFilter(type)
                      setShowAllSnapshots(false)
                    }}
                    className={`px-3 py-1.5 rounded-lg border ${
                      snapshotTypeFilter === type
                        ? 'border-blue-300/50 bg-blue-500/20 text-blue-100'
                        : 'border-blue-500/20 bg-slate-950/50 text-slate-400'
                    }`}
                  >
                    {type}
                  </button>
                ))}
                <input
                  value={snapshotKeyword}
                  onChange={e => {
                    setSnapshotKeyword(e.target.value)
                    setShowAllSnapshots(false)
                  }}
                  placeholder="搜索快照文件名"
                  className="w-full sm:w-52 px-3 py-1.5 rounded-lg border border-blue-500/25 bg-slate-950/80 text-white text-xs outline-none focus:border-blue-400/60"
                />
                <select
                  value={snapshotSort}
                  onChange={e => {
                    setSnapshotSort(e.target.value)
                    setShowAllSnapshots(false)
                  }}
                  className="px-3 py-1.5 rounded-lg border border-blue-500/25 bg-slate-950/80 text-white text-xs outline-none focus:border-blue-400/60"
                >
                  <option>最新优先</option>
                  <option>最早优先</option>
                  <option>文件最大</option>
                  <option>文件最小</option>
                </select>
                {(snapshotTypeFilter !== '全部' || snapshotKeyword || showAllSnapshots || snapshotSort !== '最新优先') && (
                  <button
                    type="button"
                    onClick={() => {
                      setSnapshotTypeFilter('全部')
                      setSnapshotKeyword('')
                      setSnapshotSort('最新优先')
                      setShowAllSnapshots(false)
                    }}
                    className="px-3 py-1.5 rounded-lg border border-slate-500/30 bg-slate-800/70 text-slate-200"
                  >
                    重置筛选
                  </button>
                )}
              </div>
              <div className="text-xs text-slate-500">
                当前显示 {visibleSnapshots.length} 条，命中 {filteredSnapshots.length} 条，总计 {backupSnapshots.length} 条 · {snapshotSort} · 当前保留 {Math.max(1, Number(snapshotRetentionDays) || 30)} 天将清理 {pruneDueSnapshots.length} 条，预计释放 {formatBytes(pruneDueBytes)}
              </div>
              {backupSnapshotSummary && (
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                  {[
                    ['总数', backupSnapshotSummary.total || 0],
                    ['手动备份', backupSnapshotSummary.manualCount || 0],
                    ['恢复前', backupSnapshotSummary.preRestoreCount || 0],
                    ['总大小', formatBytes(backupSnapshotSummary.totalBytes || 0)],
                    ['最近更新', backupSnapshotSummary.latestAt ? new Date(backupSnapshotSummary.latestAt).toLocaleString('zh-CN', { hour12: false }) : '暂无']
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-lg border border-blue-500/15 bg-slate-950/50 px-3 py-2">
                      <div className="text-xs text-slate-500">{label}</div>
                      <div className="mt-1 text-sm font-medium text-blue-100">{value}</div>
                    </div>
                  ))}
                </div>
              )}
              {snapshotPreview && (
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
                  {snapshotPreview.name} · 账号 {snapshotPreview.users} · 方案 {snapshotPreview.proposals} · 日志 {snapshotPreview.logs} · 附件校验 {snapshotPreview.verifiedFiles || 0}/{snapshotPreview.files || 0} · 整体校验 {snapshotPreview.checksumVerified ? '已通过' : '未通过'}
                </div>
              )}
              {visibleSnapshots.map(snapshot => (
                <div key={snapshot.name} className="flex flex-col md:flex-row md:items-center justify-between gap-2 rounded-lg border border-blue-500/15 bg-slate-950/50 px-3 py-2">
                  <div>
                    <div className="text-sm text-blue-100 break-all">{snapshot.name}</div>
                    <div className="text-xs text-slate-500 mt-1">
                      {snapshot.type || '本地备份'} · {new Date(snapshot.updatedAt).toLocaleString('zh-CN', { hour12: false })} · {snapshotAgeText(snapshot.updatedAt)} · {formatBytes(snapshot.size || 0)}
                      {snapshotPruneDue(snapshot.updatedAt, snapshotRetentionDays) && <span className="ml-2 text-red-300">将被清理</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => previewSnapshot(snapshot.name)}
                      disabled={previewingSnapshot === snapshot.name}
                      className="inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg border border-blue-400/30 bg-blue-500/10 text-blue-100 text-xs disabled:opacity-50"
                    >
                      {previewingSnapshot === snapshot.name ? '预览中...' : '预览'}
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadSnapshot(snapshot.name)}
                      className="inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg border border-amber-400/30 bg-amber-500/10 text-amber-100 text-xs"
                    >
                      <Download size={14} />
                      下载
                    </button>
                    <button
                      type="button"
                      onClick={() => restoreSnapshot(snapshot.name)}
                      disabled={restoringSnapshot === snapshot.name || snapshotRestoreConfirm.trim() !== '确认恢复'}
                      className="inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg border border-emerald-400/30 bg-emerald-500/10 text-emerald-100 text-xs disabled:opacity-50"
                    >
                      <RotateCcw size={14} />
                      {restoringSnapshot === snapshot.name ? '恢复中...' : '恢复'}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteSnapshot(snapshot.name)}
                      disabled={deletingSnapshot === snapshot.name}
                      className="inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg border border-red-400/30 bg-red-500/10 text-red-100 text-xs disabled:opacity-50"
                    >
                      <Trash2 size={14} />
                      {deletingSnapshot === snapshot.name ? '删除中...' : '删除'}
                    </button>
                  </div>
                </div>
              ))}
              {filteredSnapshots.length === 0 && (
                <div className="rounded-lg border border-blue-500/15 bg-slate-950/40 px-3 py-4 text-sm text-slate-500">当前筛选下暂无本地备份快照。</div>
              )}
              {filteredSnapshots.length > 5 && (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-blue-500/15 bg-slate-950/40 px-3 py-2 text-xs text-slate-400">
                  <span>{showAllSnapshots ? `已显示全部 ${filteredSnapshots.length} 条快照` : `还有 ${filteredSnapshots.length - 5} 条快照未显示`}</span>
                  <button
                    type="button"
                    onClick={() => setShowAllSnapshots(prev => !prev)}
                    className="px-3 py-1.5 rounded-lg border border-blue-400/30 bg-blue-500/10 text-blue-100"
                  >
                    {showAllSnapshots ? '收起列表' : '显示全部'}
                  </button>
                </div>
              )}
            </div>
          ) : !snapshotLoadError ? (
            <div className="mt-3 text-sm text-slate-500">暂无本地备份快照。</div>
          ) : null}
        </div>
      </Panel>

      <Panel className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="font-semibold text-blue-100 mb-1 flex items-center gap-2">
              <Bot size={18} className="text-cyan-300" />
              AI 运行配置
            </h2>
            <p className="text-sm text-slate-400">生产审核引擎固定使用云端受控的本机 Hermes Gateway。Provider、模型、Base URL 与网关认证变量由部署管理；外部推理在供应商密钥轮换前安全停用，系统保持 draft-only。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className={`rounded-lg border px-3 py-2 text-sm ${aiRuntime.adapterReady ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100' : 'border-amber-400/30 bg-amber-500/10 text-amber-100'}`}>
              {aiRuntime.activeMode || '运行状态未加载'}
            </div>
            <button
              type="button"
              onClick={testAiAdapter}
              disabled={testingAi || loading || !systemConfig}
              title={`${testingAi ? '正在测试' : '测试'} AI 连接，${aiRuntimeSummary}`}
              aria-label={`${testingAi ? '正在测试' : '测试'} AI 连接，${aiRuntimeSummary}`}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-cyan-300/35 bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-50 text-sm text-cyan-100"
            >
              <CheckCircle2 size={16} />
              {testingAi ? '测试中...' : '测试 AI 连接'}
            </button>
            <button
              type="button"
              onClick={checkHermesProfiles}
              disabled={checkingHermesProfiles || loading || !systemConfig}
              title={`${checkingHermesProfiles ? '正在检查' : '检查'} Hermes Profile 接入，${hermesProfileSummary}`}
              aria-label={`${checkingHermesProfiles ? '正在检查' : '检查'} Hermes Profile 接入，${hermesProfileSummary}`}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-300/35 bg-blue-500/10 hover:bg-blue-500/20 disabled:opacity-50 text-sm text-blue-100"
            >
              <Server size={16} />
              {checkingHermesProfiles ? '检查中...' : '检查 Profile 接入'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <label className="block rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-2" htmlFor={aiProviderInputId}>
            <span className="text-sm text-slate-300">AI Provider</span>
            <input
              id={aiProviderInputId}
              value={managedAiProvider}
              readOnly
              aria-readonly="true"
              aria-label={`AI Provider，当前为 ${managedAiProvider}，由云端部署管理`}
              title={`AI Provider：${managedAiProvider}；由云端部署管理`}
              className="mt-2 w-full cursor-default px-3 py-2 rounded-lg border border-blue-500/20 bg-slate-950/45 text-slate-300 text-sm"
            />
            <span className="mt-1 block text-xs text-slate-500">由云端部署管理</span>
          </label>
          <label className="block rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-2" htmlFor={aiModelInputId}>
            <span className="text-sm text-slate-300">模型 / Profile</span>
            <input
              id={aiModelInputId}
              value={managedAiModel}
              readOnly
              aria-readonly="true"
              aria-label={`AI 模型或 Hermes Profile，当前为 ${managedAiModel}，由云端部署管理`}
              title={`AI 模型或 Hermes Profile：${managedAiModel}；由云端部署管理`}
              className="mt-2 w-full cursor-default px-3 py-2 rounded-lg border border-blue-500/20 bg-slate-950/45 text-slate-300 text-sm"
            />
            <span className="mt-1 block text-xs text-slate-500">由云端部署管理</span>
          </label>
          <label className="block rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-2" htmlFor={aiBaseUrlInputId}>
            <span className="text-sm text-slate-300">Base URL</span>
            <input
              id={aiBaseUrlInputId}
              value={managedAiBaseUrl}
              readOnly
              aria-readonly="true"
              aria-label={`AI Base URL，当前为 ${managedAiBaseUrl}，由云端部署管理`}
              title={`AI Base URL：${managedAiBaseUrl}；由云端部署管理`}
              className="mt-2 w-full cursor-default px-3 py-2 rounded-lg border border-blue-500/20 bg-slate-950/45 text-slate-300 text-sm"
            />
            <span className="mt-1 block text-xs text-slate-500">仅允许本机回环地址</span>
          </label>
          <label className="block rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-2" htmlFor={aiApiKeyEnvInputId}>
            <span className="text-sm text-slate-300">Hermes 网关认证变量</span>
            <input
              id={aiApiKeyEnvInputId}
              value={managedAiApiKeyEnv}
              readOnly
              aria-readonly="true"
              aria-label={`Hermes 网关认证环境变量名，当前为 ${managedAiApiKeyEnv}，由云端部署管理`}
              title={`Hermes 网关认证环境变量名：${managedAiApiKeyEnv}；只读取受控环境文件，不在页面保存密钥`}
              className="mt-2 w-full cursor-default px-3 py-2 rounded-lg border border-blue-500/20 bg-slate-950/45 text-slate-300 text-sm"
            />
            <span className="mt-1 block text-xs text-slate-500">只读取 root 权限环境文件</span>
          </label>
        </div>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 text-sm">
          <div className="rounded-lg border border-blue-500/15 bg-slate-950/45 px-3 py-2">
            <div className="text-slate-500">当前 Provider</div>
            <div className="mt-1 text-blue-100">{managedAiProvider}</div>
          </div>
          <div className="rounded-lg border border-blue-500/15 bg-slate-950/45 px-3 py-2">
            <div className="text-slate-500">当前模型</div>
            <div className="mt-1 text-cyan-100">{managedAiModel}</div>
          </div>
          <div className="rounded-lg border border-blue-500/15 bg-slate-950/45 px-3 py-2">
            <div className="text-slate-500">网关认证</div>
            <div className={`mt-1 ${aiRuntime.gatewayConfigured ? 'text-emerald-200' : 'text-amber-200'}`}>
              {aiRuntime.gatewayConfigured ? `已配置 ${managedAiApiKeyEnv}` : `未配置 ${managedAiApiKeyEnv}`}
            </div>
          </div>
          <div className="rounded-lg border border-blue-500/15 bg-slate-950/45 px-3 py-2">
            <div className="text-slate-500">外部推理</div>
            <div className={`mt-1 ${aiRuntime.agentConfigured ? 'text-emerald-200' : 'text-amber-200'}`}>
              {aiRuntime.agentConfigured ? '已受控启用' : '已安全停用 · draft-only'}
            </div>
          </div>
        </div>
        {aiTestResult && (
          <div className={`mt-3 rounded-lg border px-3 py-3 text-sm ${aiTestResult.ok === false ? 'border-rose-400/30 bg-rose-500/10 text-rose-100' : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100'}`}>
            <div className="font-medium">{aiTestResult.message || (aiTestResult.ok === false ? 'AI 适配器探测失败' : 'AI 适配器探测通过')}</div>
            <div className="mt-2 grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
              <span>Provider：{aiTestResult.runtime?.provider || '-'}</span>
              <span>模型：{aiTestResult.runtime?.model || '-'}</span>
              <span>模式：{aiTestResult.modeName || '-'}</span>
              <span>耗时：{aiTestResult.durationMs ?? '-'} ms</span>
              {aiTestResult.at && <span>测试时间：{formatDateTime(aiTestResult.at)}</span>}
              <span>样例意见：{aiTestResult.sample?.opinions ?? 0} 条</span>
              {aiTestResult.engine && <span>引擎：{aiTestResult.engine}</span>}
              {aiTestResult.agentProvider && <span>Agent：{aiTestResult.agentProvider} / {aiTestResult.agentModel || '-'}</span>}
              {aiTestResult.fallback === true && <span>回退：是</span>}
            </div>
          </div>
        )}
        {hermesStatus && (
          <div className={`mt-3 rounded-lg border px-3 py-3 text-sm ${hermesStatus.ok === false ? 'border-rose-400/30 bg-rose-500/10 text-rose-100' : hermesStatus.enabled === false ? 'border-amber-400/30 bg-amber-500/10 text-amber-100' : 'border-blue-400/25 bg-blue-500/10 text-blue-100'}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-medium">{hermesStatus.message || 'Hermes Profile 接入状态'}</div>
                <div className="mt-1 text-xs text-slate-400">
                  Provider：{hermesStatus.runtime?.provider || aiRuntime.provider || '-'} · 模型：{hermesStatus.runtime?.model || aiRuntime.model || '-'}
                </div>
                <div className="mt-1 text-xs text-slate-500">检查时间：{hermesStatus.checkedAt || '未记录'}</div>
              </div>
              <div className="flex flex-wrap items-start justify-end gap-2">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
                  {[
                    ['网页', hermesStatus.summary?.webCount ?? 0],
                    ['云端', hermesStatus.summary?.remoteCount ?? 0],
                    ['匹配', hermesStatus.summary?.matchedCount ?? 0],
                    ['缺失', hermesStatus.summary?.missingCount ?? 0],
                    ['差异', hermesStatus.summary?.driftCount ?? 0]
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-md border border-white/10 bg-slate-950/35 px-2 py-1">
                      <div className="text-slate-500">{label}</div>
                      <div className="text-base font-semibold text-blue-50">{value}</div>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={checkHermesProfiles}
                  disabled={checkingHermesProfiles}
                  title={`${checkingHermesProfiles ? '正在刷新' : '刷新'} Hermes Profile 接入状态，${hermesProfileSummary}`}
                  aria-label={`${checkingHermesProfiles ? '正在刷新' : '刷新'} Hermes Profile 接入状态，${hermesProfileSummary}`}
                  className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/30 bg-slate-950/35 px-3 py-2 text-xs text-cyan-100 hover:bg-cyan-500/10 disabled:opacity-50"
                >
                  {checkingHermesProfiles ? '刷新中...' : '刷新状态'}
                </button>
                <button
                  type="button"
                  onClick={copyHermesStatus}
                  title={`复制 Hermes Profile 接入诊断，${hermesProfileSummary}`}
                  aria-label={`复制 Hermes Profile 接入诊断，${hermesProfileSummary}`}
                  className="inline-flex items-center gap-2 rounded-lg border border-blue-300/30 bg-slate-950/35 px-3 py-2 text-xs text-blue-100 hover:bg-blue-500/10"
                >
                  复制诊断
                </button>
                <button
                  type="button"
                  onClick={openHermesConfigLogs}
                  title="查看 Hermes Profile 配置日志"
                  aria-label="查看 Hermes Profile 配置日志"
                  className="inline-flex items-center gap-2 rounded-lg border border-violet-300/30 bg-slate-950/35 px-3 py-2 text-xs text-violet-100 hover:bg-violet-500/10"
                >
                  <History size={13} />
                  查看配置日志
                </button>
              </div>
            </div>
            {hermesStatus.diagnostic && (
              <div className="mt-3 rounded-lg border border-white/10 bg-slate-950/35 px-3 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold text-slate-200">接入排查建议</div>
                    <div className="mt-1 text-xs text-slate-300">{hermesStatus.diagnostic.nextAction || '请刷新 Hermes Profile 接入状态。'}</div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
                  {(hermesStatus.diagnostic.checks || []).map(check => {
                    const checkClass = check.status === '通过'
                      ? 'border-emerald-300/20 bg-emerald-500/10 text-emerald-100'
                      : check.status === '待确认'
                        ? 'border-blue-300/20 bg-blue-500/10 text-blue-100'
                        : 'border-amber-300/25 bg-amber-500/10 text-amber-100'
                    return (
                      <div key={check.label} className={`rounded-lg border px-3 py-2 ${checkClass}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium">{check.label}</span>
                          <span className="rounded border border-white/10 bg-slate-950/35 px-2 py-0.5 text-[11px]">{check.status}</span>
                        </div>
                        <div className="mt-1 text-xs leading-relaxed text-slate-300">{check.detail}</div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            <div className="mt-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
              {(hermesStatus.profiles || []).map(profile => {
                const statusText = profile.matched ? (profile.drifted ? '有差异' : '已匹配') : '未匹配'
                const statusClass = profile.matched
                  ? profile.drifted
                    ? 'border-amber-300/25 bg-amber-500/10 text-amber-100'
                    : 'border-emerald-300/25 bg-emerald-500/10 text-emerald-100'
                  : 'border-rose-300/25 bg-rose-500/10 text-rose-100'
                return (
                  <div key={profile.id} className="rounded-lg border border-blue-500/15 bg-slate-950/35 px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-medium text-blue-50">{profile.name}</div>
                        <div className="mt-1 text-xs text-slate-500">{profile.code || profile.id} · {profile.hermesName || '-'}</div>
                      </div>
                      <span className={`shrink-0 rounded-md border px-2 py-0.5 text-xs ${statusClass}`}>{statusText}</span>
                    </div>
                    <div className="mt-2 text-xs text-slate-400">
                      远端：{profile.remote?.name || profile.remote?.hermesName || '未找到'}
                    </div>
                    {profile.changedFields?.length > 0 && (
                      <div className="mt-1 text-xs text-amber-200">差异字段：{profile.changedFields.join('、')}</div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </Panel>

      <Panel ref={runtimeConfigRef} className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="font-semibold text-blue-100 mb-1">运行与账号安全配置</h2>
            <p className="text-sm text-slate-400">控制登录会话、连续失败锁定、附件上传上限、公网诊断参数和可信 IP；前端地址、后端端口与 API 前缀由云端部署管理，只读展示。</p>
          </div>
          <button
            type="button"
            onClick={saveSystemConfig}
            disabled={savingSystemConfig || loading || !systemConfig}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm border border-blue-300/40"
          >
            <Save size={16} />
            {savingSystemConfig ? '保存中...' : '保存安全配置'}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          {[
            ['sessionTtlMinutes', '会话有效期（分钟）', 30, 1440],
            ['maxLoginFailures', '锁定前失败次数', 3, 20],
            ['loginFailureWindowMinutes', '失败统计窗口（分钟）', 1, 120],
            ['loginLockMinutes', '临时锁定时长（分钟）', 1, 120],
            ['inactiveLoginDays', '长期未登录阈值（天）', 7, 365],
            ['sharedLoginIpAccountThreshold', '同 IP 风险阈值（账号数）', 2, 50],
            ['maxFileSizeMb', '单文件上限（MiB）', 1, 20],
            ['maxUploadFiles', '单次上传文件数', 1, 12]
          ].map(([key, label, min, max]) => (
            <label key={key} className="block rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-2" htmlFor={`system-config-${key}`}>
              <span className="text-sm text-slate-300">{label}</span>
              <input
                id={`system-config-${key}`}
                type="number"
                min={min}
                max={max}
                value={systemConfig?.[key] ?? ''}
                onChange={e => updateSystemConfig(key, e.target.value)}
                className="mt-2 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-950/80 text-white text-sm outline-none focus:border-blue-400/60"
              />
            </label>
          ))}
          <label className="block rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-2 md:col-span-2" htmlFor={frontendUrlInputId}>
            <span className="text-sm text-slate-300">前端地址</span>
            <input
              id={frontendUrlInputId}
              value={managedFrontendUrl}
              readOnly
              aria-readonly="true"
              aria-label={`前端地址，当前为 ${managedFrontendUrl}，由云端部署管理`}
              title={`前端地址：${managedFrontendUrl}；由云端部署管理`}
              className="mt-2 w-full cursor-default px-3 py-2 rounded-lg border border-blue-500/20 bg-slate-950/45 text-slate-300 text-sm"
            />
            <span className="mt-1 block text-xs text-slate-500">由云端 Nginx 路由固定</span>
          </label>
          <label className="block rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-2" htmlFor={publicDomainInputId}>
            <span className="text-sm text-slate-300">公网域名</span>
            <input
              id={publicDomainInputId}
              value={systemConfig?.publicDomain || ''}
              onChange={e => updateSystemConfig('publicDomain', e.target.value)}
              className="mt-2 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-950/80 text-white text-sm outline-none focus:border-blue-400/60"
              placeholder="firstcare.cloud"
            />
          </label>
          <label className="block rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-2" htmlFor={publicIpInputId}>
            <span className="text-sm text-slate-300">公网 IP</span>
            <input
              id={publicIpInputId}
              value={systemConfig?.publicIp || ''}
              onChange={e => updateSystemConfig('publicIp', e.target.value)}
              className="mt-2 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-950/80 text-white text-sm outline-none focus:border-blue-400/60"
              placeholder="82.157.119.78"
            />
          </label>
          <div className={`rounded-lg border px-3 py-2 md:col-span-2 ${
            networkDiagnostics?.ok
              ? 'border-emerald-400/20 bg-emerald-500/10'
              : networkDiagnostics
                ? 'border-amber-400/20 bg-amber-500/10'
                : 'border-blue-500/20 bg-slate-900/60'
          }`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm text-slate-200">公网解析诊断</div>
                <div className="mt-1 text-xs text-slate-400">
                  {networkDiagnostics?.message || `检查 ${systemConfig?.publicDomain || '公网域名'} 是否解析到 ${systemConfig?.publicIp || '公网 IP'}`}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => refreshNetworkDiagnostics()}
                  disabled={checkingNetworkDiagnostics}
                  className="rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-50"
                >
                  {checkingNetworkDiagnostics ? '诊断中...' : '刷新诊断'}
                </button>
                <button
                  type="button"
                  onClick={copyNetworkDiagnostics}
                  disabled={!networkDiagnostics}
                  className="inline-flex items-center gap-1 rounded-lg border border-blue-300/30 bg-blue-500/10 px-3 py-1.5 text-xs text-blue-100 hover:bg-blue-500/20 disabled:opacity-50"
                >
                  <Copy size={13} />
                  复制诊断
                </button>
                <button
                  type="button"
                  onClick={downloadNetworkDiagnostics}
                  disabled={downloadingNetworkDiagnostics}
                  className="inline-flex items-center gap-1 rounded-lg border border-violet-300/30 bg-violet-500/10 px-3 py-1.5 text-xs text-violet-100 hover:bg-violet-500/20 disabled:opacity-50"
                >
                  <Download size={13} />
                  {downloadingNetworkDiagnostics ? '下载中...' : '下载 JSON'}
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/logs?type=系统配置&actionGroup=公网诊断&range=近30天')}
                  className="inline-flex items-center gap-1 rounded-lg border border-emerald-300/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-100 hover:bg-emerald-500/20"
                >
                  <History size={13} />
                  查看日志
                </button>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <span className="rounded-md border border-white/10 bg-slate-950/35 px-2 py-1 text-slate-300">域名：{networkDiagnostics?.domain || systemConfig?.publicDomain || '-'}</span>
              <span className="rounded-md border border-white/10 bg-slate-950/35 px-2 py-1 text-slate-300">预期 IP：{networkDiagnostics?.expectedIp || systemConfig?.publicIp || '-'}</span>
              <span className={`rounded-md border px-2 py-1 ${networkDiagnostics?.ok ? 'border-emerald-300/20 bg-emerald-500/10 text-emerald-100' : 'border-amber-300/20 bg-amber-500/10 text-amber-100'}`}>
                解析 IP：{networkDiagnostics?.resolvedIps?.length ? networkDiagnostics.resolvedIps.join('、') : '未记录'}
              </span>
            </div>
          </div>
          <label className="block rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-2 md:col-span-2" htmlFor={trustedLoginIpsInputId}>
            <span className="text-sm text-slate-300">可信登录 IP 白名单</span>
            <textarea
              id={trustedLoginIpsInputId}
              rows={3}
              value={Array.isArray(systemConfig?.trustedLoginIps) ? systemConfig.trustedLoginIps.join('\n') : systemConfig?.trustedLoginIps || ''}
              onChange={e => updateSystemConfig('trustedLoginIps', e.target.value)}
              className="mt-2 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-950/80 text-white text-sm outline-none focus:border-blue-400/60"
              placeholder="每行一个 IP，或使用逗号分隔"
            />
            <div className="mt-1 text-xs text-slate-500">支持 IPv4 和 IPv6。办公网、VPN 或统一出口 IP 可加入白名单，不参与同 IP 多账号风险标记；非法条目保存时会自动忽略。</div>
          </label>
          <label className="block rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-2" htmlFor={backendPortInputId}>
            <span className="text-sm text-slate-300">后端端口</span>
            <input
              id={backendPortInputId}
              value={managedBackendPort}
              readOnly
              aria-readonly="true"
              aria-label={`后端端口，当前为 ${managedBackendPort}，由云端部署管理`}
              title={`后端端口：${managedBackendPort}；仅允许本机监听，由云端部署管理`}
              className="mt-2 w-full cursor-default px-3 py-2 rounded-lg border border-blue-500/20 bg-slate-950/45 text-slate-300 text-sm"
            />
            <span className="mt-1 block text-xs text-slate-500">仅本机监听</span>
          </label>
          <label className="block rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-2" htmlFor={apiPrefixInputId}>
            <span className="text-sm text-slate-300">内部 API 前缀</span>
            <input
              id={apiPrefixInputId}
              value={managedApiPrefix}
              readOnly
              aria-readonly="true"
              aria-label={`内部 API 前缀，当前为 ${managedApiPrefix}，由云端部署管理`}
              title={`内部 API 前缀：${managedApiPrefix}；公网由 /review-api/ 受控代理`}
              className="mt-2 w-full cursor-default px-3 py-2 rounded-lg border border-blue-500/20 bg-slate-950/45 text-slate-300 text-sm"
            />
            <span className="mt-1 block text-xs text-slate-500">公网通过 /review-api/ 代理</span>
          </label>
        </div>
      </Panel>

      <Panel className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="font-semibold text-blue-100 mb-1">角色权限矩阵</h2>
            <p className="text-sm text-slate-400">管理员固定保留全部权限；其它显示角色只能在默认安全上限内减配或恢复，超出上限的权限不可启用。遗留使用者固定提交权限，不在此处分配。</p>
            {!isAdministrator && <p role="status" className="mt-2 text-xs text-amber-200">当前为只读模式：仅管理员角色可修改和保存权限矩阵。</p>}
            {latestRolePermissionUpdate && (
              <p className="mt-2 text-xs text-slate-500">
                最近保存：{latestRolePermissionUpdate.actor || '未知账号'} · {latestRolePermissionUpdate.at || '时间未记录'}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={restoreDefaultRolePermissions}
              disabled={!isAdministrator || savingPermissions || loading || Object.keys(defaultRolePermissions).length === 0 || rolePermissionsIsDefault}
              className="px-4 py-2 rounded-lg border border-cyan-400/30 bg-cyan-500/10 text-sm text-cyan-100 disabled:opacity-50"
            >
              {rolePermissionsIsDefault ? '已是默认权限' : '恢复默认权限'}
            </button>
            {rolePermissionsChanged && (
              <button
                type="button"
                onClick={resetRolePermissions}
                disabled={!isAdministrator || savingPermissions}
                className="px-4 py-2 rounded-lg border border-slate-500/40 bg-slate-900/70 text-sm text-slate-200 disabled:opacity-50"
              >
                撤销改动
              </button>
            )}
            <button
              type="button"
              onClick={saveRolePermissions}
              disabled={!isAdministrator || savingPermissions || loading || !rolePermissionsChanged}
              className={`px-4 py-2 rounded-lg disabled:opacity-50 text-sm border ${
                rolePermissionsChanged
                  ? 'bg-amber-500/20 hover:bg-amber-500/30 border-amber-300/50 text-amber-100'
                  : 'bg-blue-600/20 border-blue-300/30 text-blue-100'
              }`}
            >
              {savingPermissions ? '保存中...' : rolePermissionsChanged ? '保存未保存改动' : '权限配置已保存'}
            </button>
          </div>
        </div>

        {rolePermissionsChanged && (
          <div className="mb-4 rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium">角色权限矩阵存在 {rolePermissionChangeCount} 项未保存改动，离开或刷新页面前请先保存。</div>
              <button type="button" onClick={copyUnsavedRolePermissionChanges} className="text-xs text-amber-100 hover:text-white">
                复制改动
              </button>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              {rolePermissionChanges.map(change => (
                <div key={change.role} className="rounded-lg border border-amber-300/20 bg-slate-950/40 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium text-amber-50">{change.role}</div>
                    <div className="text-[11px] text-slate-400">启用 {change.impact.enabled || 0} / 总计 {change.impact.total || 0}</div>
                  </div>
                  {change.added.length > 0 && <div className="mt-1 text-xs text-emerald-200">新增：{change.added.join('、')}</div>}
                  {change.removed.length > 0 && <div className="mt-1 text-xs text-red-200">移除：{change.removed.join('、')}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {!rolePermissionsIsDefault && defaultRolePermissionChangeCount > 0 && (
          <div className="mb-4 rounded-lg border border-cyan-400/25 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium">当前角色权限相对系统默认值有 {defaultRolePermissionChangeCount} 项差异。</div>
              <button type="button" onClick={copyDefaultRolePermissionDiff} className="text-xs text-cyan-100 hover:text-white">
                复制差异
              </button>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              {defaultRolePermissionChanges.map(change => (
                <div key={`default-${change.role}`} className="rounded-lg border border-cyan-300/20 bg-slate-950/40 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium text-cyan-50">{change.role}</div>
                    <div className="text-[11px] text-slate-400">启用 {change.impact.enabled || 0} / 总计 {change.impact.total || 0}</div>
                  </div>
                  {change.added.length > 0 && <div className="mt-1 text-xs text-emerald-200">较默认新增：{change.added.join('、')}</div>}
                  {change.removed.length > 0 && <div className="mt-1 text-xs text-red-200">较默认移除：{change.removed.join('、')}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mb-4 grid gap-3 md:grid-cols-2">
          {roles.map(role => {
            const impact = roleImpact[role] || {}
            return (
              <div key={role} className="rounded-lg border border-blue-500/15 bg-slate-900/60 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-blue-100">{role}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      {role === '管理员' ? '固定全部权限，不可修改' : '仅默认安全上限内可减配或恢复'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-bold text-cyan-200">{impact.enabled || 0}</div>
                    <div className="text-xs text-slate-500">启用 / 总计 {impact.total || 0}</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {(rolePermissions[role] || []).map(permissionKey => (
                    <span key={`${role}-${permissionKey}`} className="rounded-md border border-blue-400/20 bg-blue-500/10 px-2 py-0.5 text-xs text-blue-100">
                      {permissions.find(item => item.key === permissionKey)?.name || permissionKey}
                    </span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        <div className="overflow-x-auto">
          <table
            className="w-full text-sm"
            aria-label={`角色权限矩阵，共 ${roles.length} 个角色、${permissions.length} 个权限项`}
          >
            <caption className="sr-only">
              角色权限矩阵。共 {roles.length} 个角色、{permissions.length} 个权限项，当前有 {rolePermissionChangeCount} 项未保存改动。管理员权限固定启用；其它显示角色只能在默认安全上限内减配或恢复；超出角色安全上限的权限不可启用；非管理员全表只读。遗留使用者不在此表分配。
            </caption>
            <thead className="text-slate-400 bg-slate-900/70">
              <tr>
                <th className="text-left py-2 px-3 font-medium whitespace-nowrap">权限项</th>
                {roles.map(role => (
                  <th key={role} className="text-left py-2 px-3 font-medium whitespace-nowrap">{role}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permissions.map(permission => (
                <tr key={permission.key} className="border-b border-blue-500/10 hover:bg-blue-500/5">
                  <td className="px-3 py-3 min-w-[240px]">
                    <div className="font-medium text-blue-100">{permission.name}</div>
                    <div className="text-xs text-slate-500 mt-1">{permission.description}</div>
                  </td>
                  {roles.map(role => {
                    const checked = (rolePermissions[role] || []).includes(permission.key)
                    const withinRoleCeiling = (defaultRolePermissions[role] || []).includes(permission.key)
                    const lockedReason = !withinRoleCeiling
                      ? '超出角色安全上限，不可启用'
                      : role === '管理员'
                        ? '管理员固定启用，不可修改'
                        : !isAdministrator
                          ? '仅管理员可修改'
                          : ''
                    const locked = Boolean(lockedReason)
                    const stateText = !withinRoleCeiling
                      ? '安全上限外'
                      : role === '管理员'
                        ? '固定启用'
                        : !isAdministrator
                          ? '只读'
                          : checked ? '启用' : '停用'
                    const permissionInputId = `permission-${role}-${permission.key}`
                    return (
                      <td key={`${role}-${permission.key}`} className="px-3 py-3">
                        <label
                          className={`inline-flex items-center gap-2 ${locked ? 'cursor-not-allowed opacity-80' : 'cursor-pointer'}`}
                          htmlFor={permissionInputId}
                        >
                          <input
                            id={permissionInputId}
                            type="checkbox"
                            checked={checked}
                            disabled={locked}
                            onChange={() => togglePermission(role, permission.key)}
                            title={`${lockedReason || (checked ? '点击停用' : '点击启用')}：${role} / ${permission.name}`}
                            aria-label={`${role}的${permission.name}权限。说明：${permission.description || '无说明'}。当前状态：${stateText}。操作边界：${lockedReason || (checked ? '可停用' : '可启用')}。${roleImpact[role]?.accounts ? `影响 ${roleImpact[role].accounts} 个账号。` : ''}`}
                            className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-blue-500"
                          />
                          <span className={checked ? 'text-emerald-300' : 'text-slate-500'}>
                            {stateText}
                          </span>
                        </label>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel className="p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-blue-100 mb-1">上线检查台</h2>
              <p className="text-sm text-slate-400">聚合服务健康、权限、备份、Hermes 和 AI 运行状态。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={refreshLaunchReadiness}
                disabled={refreshingLaunchReadiness}
                title={`${refreshingLaunchReadiness ? '正在刷新' : '刷新'}上线检查，${launchReadinessSummary}`}
                aria-label={`${refreshingLaunchReadiness ? '正在刷新' : '刷新'}上线检查，${launchReadinessSummary}`}
                className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-50"
              >
                <RotateCcw size={15} className={refreshingLaunchReadiness ? 'animate-spin' : ''} />
                {refreshingLaunchReadiness ? '刷新中...' : '刷新上线检查'}
              </button>
              <button
                type="button"
                onClick={copyLaunchReadiness}
                title={`复制上线检查摘要，${launchReadinessSummary}`}
                aria-label={`复制上线检查摘要，${launchReadinessSummary}`}
                className="inline-flex items-center gap-2 rounded-lg border border-blue-300/30 bg-blue-500/10 px-3 py-2 text-sm text-blue-100 hover:bg-blue-500/20"
              >
                <Copy size={15} />
                复制上线检查
              </button>
              <button
                type="button"
                onClick={copyLaunchReadinessIssues}
                title={`复制上线检查待处理项，共 ${launchReadinessIssueCount} 项`}
                aria-label={`复制上线检查待处理项，共 ${launchReadinessIssueCount} 项，${launchReadinessSummary}`}
                className="inline-flex items-center gap-2 rounded-lg border border-amber-300/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100 hover:bg-amber-500/20"
              >
                <Copy size={15} />
                待处理 {launchReadinessIssueCount}
              </button>
              <button
                type="button"
                onClick={downloadLaunchReadiness}
                disabled={downloadingLaunchReadiness}
                title={`${downloadingLaunchReadiness ? '正在下载' : '下载'}上线检查 JSON，${launchReadinessSummary}`}
                aria-label={`${downloadingLaunchReadiness ? '正在下载' : '下载'}上线检查 JSON，${launchReadinessSummary}`}
                className="inline-flex items-center gap-2 rounded-lg border border-emerald-300/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100 hover:bg-emerald-500/20 disabled:opacity-50"
              >
                <Download size={15} className={downloadingLaunchReadiness ? 'animate-pulse' : ''} />
                {downloadingLaunchReadiness ? '下载中...' : '下载 JSON'}
              </button>
              <button
                type="button"
                onClick={downloadLaunchAuditPackage}
                disabled={downloadingLaunchAudit}
                title={`${downloadingLaunchAudit ? '正在下载' : '下载'}上线审计包 JSON，包含门禁总览、处理记录和最近上线确认`}
                aria-label={`${downloadingLaunchAudit ? '正在下载' : '下载'}上线审计包 JSON，${launchReadinessSummary}`}
                className="inline-flex items-center gap-2 rounded-lg border border-violet-300/30 bg-violet-500/10 px-3 py-2 text-sm text-violet-100 hover:bg-violet-500/20 disabled:opacity-50"
              >
                <Download size={15} className={downloadingLaunchAudit ? 'animate-pulse' : ''} />
                {downloadingLaunchAudit ? '下载中...' : '审计包'}
              </button>
              <button
                type="button"
                onClick={downloadLaunchAuditCsv}
                disabled={downloadingLaunchAuditCsv}
                title={`${downloadingLaunchAuditCsv ? '正在下载' : '下载'}上线审计包 CSV，适合表格留档`}
                aria-label={`${downloadingLaunchAuditCsv ? '正在下载' : '下载'}上线审计包 CSV，${launchReadinessSummary}`}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-400/30 bg-slate-500/10 px-3 py-2 text-sm text-slate-100 hover:bg-slate-500/20 disabled:opacity-50"
              >
                <Download size={15} className={downloadingLaunchAuditCsv ? 'animate-pulse' : ''} />
                {downloadingLaunchAuditCsv ? '下载中...' : '审计 CSV'}
              </button>
              <button
                type="button"
                onClick={copyLaunchApproval}
                disabled={launchReadinessIssueCount > 0 || confirmingLaunchApproval}
                className="inline-flex items-center gap-2 rounded-lg border border-emerald-300/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100 hover:bg-emerald-500/20 disabled:opacity-50"
                title={launchReadinessIssueCount > 0 ? `还有 ${launchReadinessIssueCount} 项待处理，暂不能生成上线确认记录` : '复制上线确认记录'}
                aria-label={launchReadinessIssueCount > 0 ? `还有 ${launchReadinessIssueCount} 项待处理，暂不能生成上线确认记录，${launchReadinessSummary}` : `生成并复制上线确认记录，${launchReadinessSummary}`}
              >
                <CheckCircle2 size={15} className={confirmingLaunchApproval ? 'animate-pulse' : ''} />
                {confirmingLaunchApproval ? '确认中...' : launchReadinessIssueCount > 0 ? `待通过 ${launchReadinessIssueCount}` : '上线确认'}
              </button>
              <button
                type="button"
                onClick={openLaunchApprovalLogs}
                title="查看上线确认日志"
                aria-label="查看上线确认日志"
                className="inline-flex items-center gap-2 rounded-lg border border-slate-400/30 bg-slate-500/10 px-3 py-2 text-sm text-slate-100 hover:bg-slate-500/20"
              >
                <History size={15} />
                确认日志
              </button>
              <button
                type="button"
                onClick={exportLaunchApprovalLogs}
                disabled={exportingLaunchApprovalLogs}
                title={`${exportingLaunchApprovalLogs ? '正在导出' : '导出'}上线确认 CSV 日志`}
                aria-label={`${exportingLaunchApprovalLogs ? '正在导出' : '导出'}上线确认 CSV 日志，包含上线确认摘要、账号风险和角色快照`}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-400/30 bg-slate-500/10 px-3 py-2 text-sm text-slate-100 hover:bg-slate-500/20 disabled:opacity-50"
              >
                <Download size={15} className={exportingLaunchApprovalLogs ? 'animate-pulse' : ''} />
                {exportingLaunchApprovalLogs ? '导出中...' : '导出确认 CSV'}
              </button>
            </div>
            <div className="mt-3 text-xs text-slate-400">
              导出确认 CSV 会包含上线确认摘要、上线账号风险和上线角色快照列，可直接用于上线留档。
            </div>
          </div>
          <div className={`mb-4 rounded-lg border px-4 py-3 ${
            launchReadinessPassed === launchReadinessItems.length
              ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100'
              : launchReadinessItems.some(item => item.status === '需处理')
                ? 'border-rose-400/25 bg-rose-500/10 text-rose-100'
                : 'border-amber-400/25 bg-amber-500/10 text-amber-100'
          }`}>
            <div className="text-sm font-medium">
              上线准备度：{launchReadinessPassed}/{launchReadinessItems.length} 项通过
            </div>
            <div className="mt-1 text-xs opacity-80">
              {launchReadinessPassed === launchReadinessItems.length
                ? '核心检查均已通过，可以进入正式上线确认。'
                : '仍有待确认或需处理事项，建议上线前逐项收口。'}
            </div>
            <div className="mt-2 text-xs opacity-70">
              最近刷新：{formatDateTime(launchReadinessRefreshedAt)}
            </div>
          </div>
          <div className="mb-4 grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {launchGateGroups.map(group => {
              const actionBusy = (
                refreshingLaunchReadiness ||
                (group.title === '公网入口' && checkingNetworkDiagnostics) ||
                (group.title === '数据备份' && creatingSnapshot) ||
                (group.title === 'Hermes 接入' && checkingHermesProfiles) ||
                (group.title === 'AI 实测' && testingAi) ||
                (group.title === '权限账号' && savingPermissions)
              )
              const toneClass = group.status === '通过'
                ? 'border-emerald-400/20 bg-emerald-500/10'
                : group.status === '需处理'
                  ? 'border-rose-400/20 bg-rose-500/10'
                  : group.tone === 'amber'
                    ? 'border-amber-400/20 bg-amber-500/10'
                    : group.tone === 'violet'
                      ? 'border-violet-400/20 bg-violet-500/10'
                      : group.tone === 'cyan'
                        ? 'border-cyan-400/20 bg-cyan-500/10'
                        : 'border-blue-400/20 bg-blue-500/10'
              const badgeClass = group.status === '通过'
                ? 'border-emerald-300/30 text-emerald-100'
                : group.status === '需处理'
                  ? 'border-rose-300/30 text-rose-100'
                  : 'border-amber-300/30 text-amber-100'
              return (
                <div key={group.title} className={`rounded-lg border px-3 py-3 ${toneClass}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-blue-100">{group.title}</div>
                    <span className={`rounded-md border px-2 py-0.5 text-xs ${badgeClass}`}>
                      {group.status}
                    </span>
                  </div>
                  <div className="mt-2 flex items-end justify-between gap-3">
                    <div>
                      <div className="text-2xl font-semibold text-slate-50">{group.passed}/{group.total}</div>
                      <div className="text-xs text-slate-400">门禁通过</div>
                    </div>
                    <div className="text-right text-xs text-slate-400">
                      总览 {launchGateReadyCount}/{launchGateGroups.length}
                    </div>
                  </div>
                  <div className="mt-2 line-clamp-2 text-xs text-slate-300">{group.detail}</div>
                  {group.action && (
                    <div className="mt-2 rounded border border-white/10 bg-slate-950/25 px-2 py-1 text-xs text-slate-300">
                      {group.action}
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs text-slate-500">
                      {group.status === '通过' ? '无需处理' : `主问题：${group.primaryIssueLabel || group.title}`}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleLaunchGateAction(group)}
                      disabled={group.status === '通过' || actionBusy}
                      title={group.status === '通过' ? `${group.title}已通过` : group.actionLabel}
                      aria-label={group.status === '通过' ? `${group.title}已通过，无需处理` : `${group.actionLabel}：${group.title}`}
                      className="rounded-lg border border-white/10 bg-slate-950/35 px-2.5 py-1.5 text-xs text-slate-100 hover:bg-slate-800/80 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {actionBusy ? '处理中...' : group.status === '通过' ? '已通过' : group.actionLabel}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="mb-4 rounded-lg border border-slate-400/20 bg-slate-950/35 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium text-blue-100">最近门禁处理记录</div>
                <div className="mt-1 text-xs text-slate-400">读取近 30 天系统日志中的公网、备份、Hermes、AI、权限和上传配置动作。</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => loadLaunchGateActivity({ notify: true })}
                  disabled={loadingLaunchGateActivity}
                  title="刷新最近门禁处理记录"
                  aria-label="刷新最近门禁处理记录"
                  className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-50"
                >
                  <RotateCcw size={14} className={loadingLaunchGateActivity ? 'animate-spin' : ''} />
                  {loadingLaunchGateActivity ? '刷新中...' : '刷新记录'}
                </button>
                <button
                  type="button"
                  onClick={openSystemConfigLogs}
                  title="打开系统日志查看完整门禁处理记录"
                  aria-label="打开系统日志查看完整门禁处理记录"
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-400/30 bg-slate-500/10 px-3 py-1.5 text-xs text-slate-100 hover:bg-slate-500/20"
                >
                  <History size={14} />
                  查看日志
                </button>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {launchGateActivityError ? (
                <div role="alert" className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                  {launchGateActivityError}
                </div>
              ) : launchGateActivity.length > 0 ? launchGateActivity.map(item => (
                <div key={item.id} className="grid gap-2 rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-xs text-slate-300 md:grid-cols-[96px_1fr_120px_160px_64px] md:items-center">
                  <span className="font-medium text-blue-100">{item.gate}</span>
                  <span className="min-w-0 truncate">{item.action}</span>
                  <span className="text-slate-400">{item.actor}</span>
                  <span className="text-slate-500">{item.at || '未记录时间'}</span>
                  <span className={`rounded border px-2 py-0.5 text-center ${
                    item.result === '失败'
                      ? 'border-rose-300/30 text-rose-100'
                      : item.result === '警告' || item.result === '拦截'
                        ? 'border-amber-300/30 text-amber-100'
                        : 'border-emerald-300/30 text-emerald-100'
                  }`}>
                    {item.result}
                  </span>
                </div>
              )) : (
                <div className="rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
                  近 30 天暂无门禁处理记录。
                </div>
              )}
            </div>
          </div>
          <div className="mb-4 rounded-lg border border-emerald-400/20 bg-slate-950/40 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium text-emerald-100">最近上线确认</div>
                <div className="mt-1 text-xs text-slate-400">
                  {latestLaunchApprovalError
                    ? latestLaunchApprovalError
                    : latestLaunchApproval
                    ? `${latestLaunchApproval.actor || '未知账号'} · ${latestLaunchApproval.at || '未记录'}`
                    : '近 30 天暂无上线确认记录'}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => loadLatestLaunchApproval({ notify: true })}
                  disabled={loadingLatestLaunchApproval}
                  title={`${loadingLatestLaunchApproval ? '正在刷新' : '刷新'}最近上线确认，${latestLaunchApprovalSummary}`}
                  aria-label={`${loadingLatestLaunchApproval ? '正在刷新' : '刷新'}最近上线确认，${latestLaunchApprovalSummary}`}
                  className="rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-50"
                >
                  {loadingLatestLaunchApproval ? '刷新中...' : '刷新'}
                </button>
                <button
                  type="button"
                  onClick={copyLatestLaunchApproval}
                  disabled={!latestLaunchApproval}
                  title={`复制最近上线确认，${latestLaunchApprovalSummary}`}
                  aria-label={`复制最近上线确认，${latestLaunchApprovalSummary}`}
                  className="rounded-lg border border-blue-300/30 bg-blue-500/10 px-3 py-1.5 text-xs text-blue-100 hover:bg-blue-500/20 disabled:opacity-50"
                >
                  复制
                </button>
                <button
                  type="button"
                  onClick={downloadLatestLaunchApproval}
                  disabled={!latestLaunchApproval || downloadingLatestLaunchApproval}
                  title={`${downloadingLatestLaunchApproval ? '正在下载' : '下载'}最近上线确认 JSON，${latestLaunchApprovalSummary}`}
                  aria-label={`${downloadingLatestLaunchApproval ? '正在下载' : '下载'}最近上线确认 JSON，${latestLaunchApprovalSummary}`}
                  className="rounded-lg border border-blue-300/30 bg-blue-500/10 px-3 py-1.5 text-xs text-blue-100 hover:bg-blue-500/20 disabled:opacity-50"
                >
                  {downloadingLatestLaunchApproval ? '下载中...' : '下载 JSON'}
                </button>
                <button
                  type="button"
                  onClick={openLaunchApprovalLogs}
                  title="查看上线确认日志"
                  aria-label="查看上线确认日志"
                  className="rounded-lg border border-emerald-300/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-100 hover:bg-emerald-500/20"
                >
                  查看确认日志
                </button>
              </div>
            </div>
            {latestLaunchApproval?.metadata && (
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <span className="rounded border border-white/10 bg-slate-900/80 px-2 py-0.5 text-slate-300">
                  结论 {latestLaunchApproval.metadata.passed ?? 0}/{latestLaunchApproval.metadata.total ?? 0}
                </span>
                <span className="rounded border border-white/10 bg-slate-900/80 px-2 py-0.5 text-slate-300">
                  确认 {snapshotAgeText(latestLaunchApproval.at || latestLaunchApproval.metadata.generatedAt)}
                </span>
                {olderThanHours(latestLaunchApproval.at || latestLaunchApproval.metadata.generatedAt, launchApprovalFreshHours) && (
                  <span className="rounded border border-amber-300/30 bg-amber-500/10 px-2 py-0.5 text-amber-100">
                    建议重新确认
                  </span>
                )}
                <label className="inline-flex items-center gap-1 rounded border border-white/10 bg-slate-900/80 px-2 py-0.5 text-slate-300" htmlFor={latestLaunchApprovalFreshHoursInputId}>
                  阈值
                  <input
                    id={latestLaunchApprovalFreshHoursInputId}
                    type="number"
                    min="1"
                    max="168"
                    value={launchApprovalFreshHours}
                    onChange={event => updateLaunchApprovalFreshHours(event.target.value)}
                    className="w-12 bg-transparent text-slate-100 outline-none"
                  />
                  小时
                </label>
                {latestLaunchApproval.metadata.appVersion && (
                  <span className="rounded border border-white/10 bg-slate-900/80 px-2 py-0.5 text-slate-300">
                    版本 {latestLaunchApproval.metadata.appVersion}
                  </span>
                )}
                {latestLaunchApproval.metadata.refreshedAt && (
                  <span className="rounded border border-white/10 bg-slate-900/80 px-2 py-0.5 text-slate-300">
                    刷新 {latestLaunchApproval.metadata.refreshedAt}
                  </span>
                )}
              </div>
            )}
            {latestLaunchApprovalRoleSummary.length > 0 && (
              <div className="mt-3 rounded-lg border border-blue-300/20 bg-blue-500/10 px-3 py-2 text-xs text-blue-100">
                <div className="font-medium">角色权限快照</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {latestLaunchApprovalRoleSummary.map(item => (
                    <span key={item.role} className="rounded border border-blue-200/20 bg-slate-950/30 px-2 py-0.5">
                      {item.role || '-'} {item.enabled || 0}/{item.total || 0}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="mb-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={refreshLaunchReadiness}
              disabled={refreshingLaunchReadiness}
              title={`${refreshingLaunchReadiness ? '正在刷新' : '刷新'}全部上线检查，${launchReadinessSummary}`}
              aria-label={`${refreshingLaunchReadiness ? '正在刷新' : '刷新'}全部上线检查，${launchReadinessSummary}`}
              className="rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-50"
            >
              {refreshingLaunchReadiness ? '刷新中...' : '刷新全部检查'}
            </button>
            <button
              type="button"
              onClick={createServerSnapshot}
              disabled={creatingSnapshot}
              title={`${creatingSnapshot ? '正在创建' : '创建'}上线快照，用于上线前备份留档`}
              aria-label={`${creatingSnapshot ? '正在创建' : '创建'}上线快照，用于上线前备份留档`}
              className="rounded-lg border border-emerald-300/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-100 hover:bg-emerald-500/20 disabled:opacity-50"
            >
              {creatingSnapshot ? '创建中...' : '创建上线快照'}
            </button>
            <button
              type="button"
              onClick={checkHermesProfiles}
              disabled={checkingHermesProfiles}
              title={`${checkingHermesProfiles ? '正在检查' : '检查'} Hermes Profile 接入，${hermesProfileSummary}`}
              aria-label={`${checkingHermesProfiles ? '正在检查' : '检查'} Hermes Profile 接入，${hermesProfileSummary}`}
              className="rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-50"
            >
              {checkingHermesProfiles ? '检查中...' : '检查 Hermes'}
            </button>
            <button
              type="button"
              onClick={() => refreshNetworkDiagnostics()}
              disabled={checkingNetworkDiagnostics}
              title={`${checkingNetworkDiagnostics ? '正在诊断' : '刷新'}公网诊断，检查域名解析和公网 IP`}
              aria-label={`${checkingNetworkDiagnostics ? '正在诊断' : '刷新'}公网诊断，检查域名解析和公网 IP`}
              className="rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-50"
            >
              {checkingNetworkDiagnostics ? '诊断中...' : '刷新公网诊断'}
            </button>
            <button
              type="button"
              onClick={saveRolePermissions}
              disabled={savingPermissions || !rolePermissionsChanged}
              title={rolePermissionsChanged ? `${savingPermissions ? '正在保存' : '保存'} ${rolePermissionChangeCount} 项角色权限改动` : '当前没有未保存的角色权限改动'}
              aria-label={rolePermissionsChanged ? `${savingPermissions ? '正在保存' : '保存'} ${rolePermissionChangeCount} 项角色权限改动` : '当前没有未保存的角色权限改动'}
              className="rounded-lg border border-amber-300/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-100 hover:bg-amber-500/20 disabled:opacity-50"
            >
              {savingPermissions ? '保存中...' : '保存权限改动'}
            </button>
            <button
              type="button"
              onClick={loadBackupSnapshots}
              disabled={snapshotsLoading}
              title={`${snapshotsLoading ? '正在刷新' : '刷新'}备份快照状态`}
              aria-label={`${snapshotsLoading ? '正在刷新' : '刷新'}备份快照状态`}
              className="rounded-lg border border-blue-300/30 bg-blue-500/10 px-3 py-1.5 text-xs text-blue-100 hover:bg-blue-500/20 disabled:opacity-50"
            >
              {snapshotsLoading ? '刷新中...' : '刷新备份状态'}
            </button>
          </div>
          <div className="space-y-2">
            {launchReadinessItems.map(item => (
              <div key={item.label} className={`rounded-lg border px-3 py-2 text-sm ${
                item.status === '通过'
                  ? 'border-emerald-400/20 bg-emerald-500/10'
                  : item.status === '需处理'
                    ? 'border-rose-400/20 bg-rose-500/10'
                    : 'border-amber-400/20 bg-amber-500/10'
              }`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium text-blue-100">{item.label}</div>
                  <span className={`rounded-md border px-2 py-0.5 text-xs ${
                    item.status === '通过'
                      ? 'border-emerald-300/30 text-emerald-100'
                      : item.status === '需处理'
                        ? 'border-rose-300/30 text-rose-100'
                        : 'border-amber-300/30 text-amber-100'
                  }`}>{item.status}</span>
                </div>
                <div className="mt-1 text-xs text-slate-400">{item.detail}</div>
                {item.action && (
                  <div className="mt-1 rounded border border-white/10 bg-slate-950/25 px-2 py-1 text-xs text-slate-300">
                    处理建议：{item.action}
                  </div>
                )}
                {item.status !== '通过' && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {item.label === '服务器备份快照' && (
                      <button
                        type="button"
                        onClick={createServerSnapshot}
                        disabled={creatingSnapshot}
                        className="rounded border border-emerald-300/30 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-100 disabled:opacity-50"
                      >
                        创建快照
                      </button>
                    )}
                    {item.label === 'Hermes Profile 接入' && (
                      <button
                        type="button"
                        onClick={checkHermesProfiles}
                        disabled={checkingHermesProfiles}
                        className="rounded border border-cyan-300/30 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-100 disabled:opacity-50"
                      >
                        检查接入
                      </button>
                    )}
                    {item.label === '完整 Profile 定义核验' && (
                      <button
                        type="button"
                        onClick={() => {
                          const profileId = unverifiedProfileItems[0]?.id || enabledProfileItems[0]?.id || ''
                          navigate(`/bots${profileId ? `?profile=${encodeURIComponent(profileId)}` : ''}`)
                        }}
                        className="rounded border border-cyan-300/30 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-100"
                      >
                        核验完整定义
                      </button>
                    )}
                    {item.label === '角色权限已保存' && (
                      <button
                        type="button"
                        onClick={saveRolePermissions}
                        disabled={savingPermissions || !rolePermissionsChanged}
                        className="rounded border border-amber-300/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-100 disabled:opacity-50"
                      >
                        保存权限
                      </button>
                    )}
                    {item.label === '上传链路限制' && (
                      <button
                        type="button"
                        onClick={focusRuntimeConfig}
                        className="rounded border border-blue-300/30 bg-blue-500/10 px-2 py-1 text-xs text-blue-100"
                      >
                        调整上传配置
                      </button>
                    )}
                    {item.label === '账号风险收口' && accountRiskActions.map(action => (
                      <button
                        key={action.to}
                        type="button"
                        onClick={() => navigate(action.to)}
                        className={`rounded border px-2 py-1 text-xs ${
                          action.tone === 'red'
                            ? 'border-red-300/30 bg-red-500/10 text-red-100'
                            : action.tone === 'amber'
                              ? 'border-amber-300/30 bg-amber-500/10 text-amber-100'
                              : action.tone === 'blue'
                                ? 'border-blue-300/30 bg-blue-500/10 text-blue-100'
                                : 'border-orange-300/30 bg-orange-500/10 text-orange-100'
                        }`}
                      >
                        处理{action.label}
                      </button>
                    ))}
                    {item.label === '公网域名解析' && (
                      <button
                        type="button"
                        onClick={() => refreshNetworkDiagnostics()}
                        disabled={checkingNetworkDiagnostics}
                        className="rounded border border-cyan-300/30 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-100 disabled:opacity-50"
                      >
                        刷新公网诊断
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="mt-4 border-t border-blue-500/10 pt-4">
            <div className="mb-2 text-xs font-medium text-slate-400">基础部署清单</div>
            <div className="space-y-2">
              {deployChecks.map(item => (
                <div key={item} className="flex items-start gap-3 rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-2 text-sm text-slate-300">
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-300" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>
        </Panel>

        <Panel className="p-5">
          <h2 className="font-semibold text-blue-100 mb-3">当前运行配置</h2>
          <div className="overflow-x-auto">
            <table
              className="w-full text-sm"
              aria-label="当前运行配置"
            >
              <caption className="sr-only">
                当前运行配置，包括前端地址、公网域名、公网 IP、API 前缀、后端端口、会话有效期、登录锁定策略、上传限制和版本递增方式。
              </caption>
              <tbody>
                {[
                  ['前端地址', systemConfig?.frontendUrl || 'http://127.0.0.1:5174'],
                  ['公网域名', systemConfig?.publicDomain || 'firstcare.cloud'],
                  ['公网 IP', systemConfig?.publicIp || '82.157.119.78'],
                  ['API 前缀', systemConfig?.apiPrefix || '/api'],
                  ['后端端口', runtime?.port || systemConfig?.backendPort || '3001'],
                  ['会话有效期', `${systemConfig?.sessionTtlMinutes || 480} 分钟`],
                  ['登录锁定策略', `${systemConfig?.loginFailureWindowMinutes || 15} 分钟内失败 ${systemConfig?.maxLoginFailures || 5} 次，锁定 ${systemConfig?.loginLockMinutes || 10} 分钟`],
                  ['长期未登录阈值', `${systemConfig?.inactiveLoginDays || 30} 天`],
                  ['同 IP 风险阈值', `${systemConfig?.sharedLoginIpAccountThreshold || 3} 个账号`],
                  ['可信登录 IP', `${Array.isArray(systemConfig?.trustedLoginIps) ? systemConfig.trustedLoginIps.length : String(systemConfig?.trustedLoginIps || '').split(/[\n,，]/).map(item => item.trim()).filter(Boolean).length} 个`],
                  ['单文件上限', `${systemConfig?.maxFileSizeMb || 20}MiB`],
                  ['单次上传文件数', `${systemConfig?.maxUploadFiles || 12}（总量 48MiB）`],
                  ['版本递增方式', '执行 npm run version:patch 后全站版本同步刷新']
                ].map(([label, value]) => (
                  <tr key={label} className="border-b border-blue-500/10 last:border-0">
                    <td className="py-2 pr-4 text-slate-400 whitespace-nowrap">{label}</td>
                    <td className="py-2 text-blue-100">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
      <CopyFallbackDialog
        open={copyFallback.open}
        title={copyFallback.title}
        description={copyFallback.description}
        content={copyFallback.content}
        onClose={() => setCopyFallback({ open: false, title: '', description: '', content: '' })}
      />
    </div>
  )
}
