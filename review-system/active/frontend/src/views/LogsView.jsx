import { useEffect, useId, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Copy, Download, ListChecks, Search, Trash2 } from '../lib/lucide.js'
import { api, filenameFromContentDisposition, getUser } from '../lib/api'
import { reportClientErrorForTest } from '../lib/clientErrorReporter'
import { copyText } from '../lib/clipboard'
import { csvCell } from '../lib/csv'
import { hasPermission } from '../lib/permissions'
import Panel from '../components/Panel'
import CopyFallbackDialog from '../components/CopyFallbackDialog'

const defaultLogTypeOptions = ['全部', '审核动作', '执行动作', '系统配置', '账号安全']
const userSecurityLogTypeOptions = ['全部', '审核动作', '执行动作', '账号安全']
const userLogTypeOptions = ['全部', '审核动作', '执行动作']
const logRangeOptions = ['全部', '今天', '近7天', '近30天']
const baseActionGroupOptions = ['全部', '批量操作', 'AI调用', '人工复核', '签发归档', '催办', '导出', '前端异常']
const systemActionGroupOptions = ['Hermes配置', '上线确认', '公网诊断']
const defaultResultOptions = ['全部', '成功', '待确认', '回退', '失败', '锁定', '拦截', '拒绝', '未记录']
const pageSize = 500
const launchApprovalFreshHoursKey = 'launchApprovalFreshHours'

function mergeLogTypeOptions(options = [], fallback = userLogTypeOptions) {
  const merged = ['全部']
  ;[...fallback, ...options].forEach(option => {
    if (option && option !== '全部' && !merged.includes(option)) merged.push(option)
  })
  return merged
}

function mergeActionGroupOptions(options = [], fallback = baseActionGroupOptions) {
  const merged = ['全部']
  ;[...fallback, ...options].forEach(option => {
    if (option && option !== '全部' && !merged.includes(option)) merged.push(option)
  })
  return merged
}

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

function olderThanHours(value, hours) {
  const timestamp = Date.parse(value || '')
  return !Number.isNaN(timestamp) && Date.now() - timestamp > Math.max(1, Number(hours) || 1) * 60 * 60 * 1000
}

function ageText(value = '') {
  const timestamp = Date.parse(value || '')
  if (Number.isNaN(timestamp)) return '距今未知'
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / (1000 * 60)))
  if (minutes < 60) return `${Math.max(1, minutes)}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  return `${Math.floor(hours / 24)}天前`
}

function detailSectionByAction(action = '') {
  const text = String(action || '')
  if (text.includes('人工复核') || text.includes('复核备注')) return 'manualReview'
  if (text.includes('签发') || text.includes('归档')) return 'signOff'
  if (text.includes('催办')) return 'reminder'
  if (text.includes('意见书') || text.includes('预览')) return 'exports'
  return ''
}

function exportSourceText(source = '') {
  if (source === 'detail') return '详情页'
  if (source === 'submit') return '提交结果'
  if (source === 'review') return '审核中心'
  return '未标注'
}

function exportSourceForLog(item = {}) {
  const source = String(item.metadata?.source || item.source || '').trim()
  return ['detail', 'submit', 'review'].includes(source) ? source : ''
}

function exportTypeText(type = '') {
  if (type === 'word') return 'Word'
  if (type === 'pdf') return 'PDF'
  if (type === 'preview') return '预览'
  return type || '未记录'
}

function extractProposalTitle(item = {}) {
  if (item.proposalTitle) return item.proposalTitle
  const match = String(item.action || '').match(/《([^》]+)》/)
  return match?.[1] || ''
}

function rolePermissionChangeRows(item = {}) {
  const changes = item.metadata?.changes || {}
  const impact = item.metadata?.roleImpact || {}
  if (!String(item.action || '').includes('角色权限矩阵') || !changes || typeof changes !== 'object') return []
  return Object.entries(changes).map(([role, change]) => ({
    role,
    added: change?.addedNames || change?.added || [],
    removed: change?.removedNames || change?.removed || [],
    enabledUsers: impact[role]?.enabled ?? null,
    totalUsers: impact[role]?.total ?? null
  })).filter(row => row.added.length || row.removed.length)
}

function clientErrorInfo(item = {}) {
  const metadata = item.metadata || {}
  if (metadata.kind !== 'client-error') return null
  return {
    type: metadata.type || 'runtime',
    route: metadata.route || '',
    source: metadata.source || '',
    appVersion: metadata.appVersion || '',
    appBuildLabel: metadata.appBuildLabel || '',
    appBuildTime: metadata.appBuildTime || '',
    stack: metadata.stack || ''
  }
}

function clientErrorText(item = {}) {
  const info = clientErrorInfo(item)
  if (!info) return ''
  return [
    item.action || '前端异常',
    '来源：第一服务研发小组审核系统 / 日志中心 / 前端异常',
    `操作人：${item.actor || '未知账号'}`,
    `日志时间：${item.at || '未记录'}`,
    `结果：${item.result || '未记录'}`,
    `类型：${info.type || '未记录'}`,
    `版本：${info.appVersion || '未记录'}`,
    `构建标识：${info.appBuildLabel || info.appVersion || '未记录'}`,
    `构建时间：${info.appBuildTime || '未记录'}`,
    `路由：${info.route || '未记录'}`,
    `来源文件：${info.source || '未记录'}`,
    info.stack ? `堆栈：\n${info.stack}` : '堆栈：未记录'
  ].join('\n')
}

function exportEventInfo(item = {}) {
  const metadata = item.metadata || {}
  const isExportAction = detectActionGroup(item.action) === '导出'
  if (!isExportAction && metadata.kind !== 'export-event') return null
  const source = exportSourceForLog(item)
  const type = metadata.type || (String(item.action || '').includes('预览') ? 'preview' : String(item.action || '').includes('PDF') ? 'pdf' : String(item.action || '').includes('Word') ? 'word' : '')
  return {
    type,
    typeText: metadata.typeText || exportTypeText(type),
    source,
    sourceText: metadata.sourceText || exportSourceText(source),
    appVersion: metadata.appVersion || '',
    appBuildLabel: metadata.appBuildLabel || '',
    appBuildTime: metadata.appBuildTime || '',
    exportEventId: metadata.exportEventId || '',
    proposalId: item.proposalId || metadata.proposalId || '',
    proposalTitle: extractProposalTitle(item) || metadata.proposalTitle || ''
  }
}

function exportEventText(item = {}) {
  const info = exportEventInfo(item)
  if (!info) return ''
  return [
    item.action || '意见书导出留痕',
    '来源：第一服务研发小组审核系统 / 日志中心 / 导出',
    `操作人：${item.actor || '未知账号'}`,
    `日志时间：${item.at || '未记录'}`,
    `结果：${item.result || '未记录'}`,
    `方案：${info.proposalTitle || '未记录'}`,
    `方案ID：${info.proposalId || '未记录'}`,
    `导出类型：${info.typeText || '未记录'}`,
    `入口来源：${info.sourceText || '未标注'}`,
    `前端版本：${info.appVersion || '未记录'}`,
    `构建标识：${info.appBuildLabel || info.appVersion || '未记录'}`,
    `构建时间：${info.appBuildTime || '未记录'}`,
    `导出事件ID：${info.exportEventId || '未记录'}`
  ].join('\n')
}

function accountSecurityInfo(item = {}) {
  if (detectLogType(item) !== '账号安全') return null
  const metadata = item.metadata || {}
  const riskSummary = metadata.riskSummary || {}
  return {
    auditId: metadata.auditId || '',
    exportAuditId: metadata.exportAuditId || '',
    targetUsername: metadata.targetUsername || metadata.username || '',
    targetRole: metadata.targetRole || '',
    targetUsernames: Array.isArray(metadata.targetUsernames) ? metadata.targetUsernames : [],
    targetNames: Array.isArray(metadata.targetNames) ? metadata.targetNames : [],
    skippedUsernames: Array.isArray(metadata.skippedUsernames) ? metadata.skippedUsernames : [],
    noticeCount: metadata.affectedAccountCount ?? metadata.noticeCount ?? null,
    sentCount: metadata.sentCount ?? 0,
    deliveryStatus: metadata.deliveryStatus || (metadata.noticeCount !== undefined ? '未发送' : ''),
    noticeChannel: metadata.noticeChannel || '',
    requestedCount: metadata.requestedCount ?? null,
    changedCount: metadata.changedCount ?? null,
    skippedCount: metadata.skippedCount ?? null,
    skippedAdminCount: metadata.skippedAdminCount ?? null,
    skippedAlreadyRequiredCount: metadata.skippedAlreadyRequiredCount ?? null,
    skippedAlreadyDisabledCount: metadata.skippedAlreadyDisabledCount ?? null,
    skippedUnlockedCount: metadata.skippedUnlockedCount ?? null,
    mustChangePassword: metadata.mustChangePassword ?? null,
    status: metadata.status || '',
    role: metadata.role || '',
    previousUsername: metadata.previousUsername || '',
    reason: metadata.reason || '',
    defaultPasswordCount: riskSummary.defaultPasswordCount ?? null,
    mustChangePasswordCount: riskSummary.mustChangePasswordCount ?? null,
    loginLockedCount: riskSummary.loginLockedCount ?? null,
    inactiveLoginCount: riskSummary.inactiveLoginCount ?? null,
    roleSummary: Array.isArray(riskSummary.roleSummary) ? riskSummary.roleSummary : [],
    rolePermissionSnapshot: Array.isArray(riskSummary.rolePermissionSnapshot) ? riskSummary.rolePermissionSnapshot : [],
    defaultPasswordLogUrl: metadata.defaultPasswordLogUrl || ''
  }
}

function accountSecurityText(item = {}) {
  const info = accountSecurityInfo(item)
  if (!info) return ''
  return [
    item.action || '账号安全日志',
    '来源：第一服务研发小组审核系统 / 日志中心 / 账号安全',
    `操作人：${item.actor || '未知账号'}`,
    `日志时间：${item.at || '未记录'}`,
    `结果：${item.result || '未记录'}`,
    info.auditId ? `批量批次：${info.auditId}` : '',
    info.exportAuditId ? `导出批次：${info.exportAuditId}` : '',
    info.targetUsername ? `目标账号：${info.targetUsername}` : '',
    info.targetRole ? `目标角色：${info.targetRole}` : '',
    info.previousUsername ? `原账号：${info.previousUsername}` : '',
    info.role ? `当前角色：${info.role}` : '',
    info.status ? `当前状态：${info.status}` : '',
    info.reason ? `原因：${info.reason}` : '',
    info.mustChangePassword !== null ? `需改密：${info.mustChangePassword ? '是' : '否'}` : '',
    info.requestedCount !== null ? `请求处理：${info.requestedCount} 个` : '',
    info.noticeCount !== null ? `通知文案涉及账号：${info.noticeCount} 个` : '',
    info.noticeCount !== null ? `发送数：${info.sentCount} 个；交付状态：${info.deliveryStatus || '未发送'}` : '',
    info.noticeChannel ? `文案生成方式：${info.noticeChannel}` : '',
    info.changedCount !== null ? `实际更新：${info.changedCount} 个` : '',
    info.skippedCount !== null ? `跳过：${info.skippedCount} 个` : '',
    info.skippedAdminCount ? `跳过管理员：${info.skippedAdminCount} 个` : '',
    info.skippedAlreadyRequiredCount ? `跳过已需改密：${info.skippedAlreadyRequiredCount} 个` : '',
    info.skippedAlreadyDisabledCount ? `跳过已停用：${info.skippedAlreadyDisabledCount} 个` : '',
    info.skippedUnlockedCount ? `跳过未锁定：${info.skippedUnlockedCount} 个` : '',
    info.defaultPasswordCount !== null ? `默认密码风险：${info.defaultPasswordCount} 个` : '',
    info.mustChangePasswordCount !== null ? `需改密：${info.mustChangePasswordCount} 个` : '',
    info.loginLockedCount !== null ? `登录锁定：${info.loginLockedCount} 个` : '',
    info.inactiveLoginCount !== null ? `长期未登录：${info.inactiveLoginCount} 个` : '',
    info.roleSummary.length ? `角色分布：${info.roleSummary.map(item => `${item.role || '-'} ${item.enabled || 0}/${item.total || 0}`).join('、')}` : '',
    info.rolePermissionSnapshot.length ? `角色权限矩阵：${info.rolePermissionSnapshot.map(item => `${item.role || '-'} ${item.permissionText || (Array.isArray(item.permissions) ? item.permissions.join('/') : '无权限')}`).join('、')}` : '',
    info.defaultPasswordLogUrl ? `默认密码拒绝日志：${info.defaultPasswordLogUrl}` : '',
    info.targetNames.length ? `涉及姓名：${info.targetNames.join('、')}` : '',
    info.targetUsernames.length ? `${info.noticeCount !== null ? '文案涉及账号' : '更新账号'}：${info.targetUsernames.join('、')}` : '',
    info.skippedUsernames.length ? `跳过账号：${info.skippedUsernames.join('、')}` : ''
  ].filter(Boolean).join('\n')
}

function systemConfigChangeInfo(item = {}) {
  const metadata = item.metadata || {}
  const kind = String(metadata.kind || '')
  const isRuntimeConfig = String(item.action || '').includes('系统运行与账号安全配置')
  if (!isRuntimeConfig && !['rule-create', 'rule-update', 'rule-status-update', 'rule-delete', 'reminder-config-update'].includes(kind)) return null
  const rule = metadata.rule || metadata.after || metadata.before || {}
  const changes = Array.isArray(metadata.changes) ? metadata.changes : []
  const runtimeChanges = isRuntimeConfig ? [
    metadata.sessionTtlMinutes !== undefined ? { field: 'sessionTtlMinutes', label: '会话有效期', after: `${metadata.sessionTtlMinutes} 分钟` } : null,
    metadata.maxLoginFailures !== undefined ? { field: 'maxLoginFailures', label: '锁定前失败次数', after: `${metadata.maxLoginFailures} 次` } : null,
    metadata.loginLockMinutes !== undefined ? { field: 'loginLockMinutes', label: '锁定时长', after: `${metadata.loginLockMinutes} 分钟` } : null,
    metadata.inactiveLoginDays !== undefined ? { field: 'inactiveLoginDays', label: '长期未登录阈值', after: `${metadata.inactiveLoginDays} 天` } : null,
    metadata.sharedLoginIpAccountThreshold !== undefined ? { field: 'sharedLoginIpAccountThreshold', label: '同 IP 风险阈值', after: `${metadata.sharedLoginIpAccountThreshold} 个账号` } : null,
    metadata.maxFileSizeMb !== undefined ? { field: 'maxFileSizeMb', label: '单文件上限', after: `${metadata.maxFileSizeMb}MB` } : null,
    metadata.maxUploadFiles !== undefined ? { field: 'maxUploadFiles', label: '单次上传文件数', after: `${metadata.maxUploadFiles}` } : null,
    metadata.aiProvider ? { field: 'aiProvider', label: 'AI Provider', after: metadata.aiProvider } : null,
    metadata.aiModel ? { field: 'aiModel', label: 'AI 模型', after: metadata.aiModel } : null
  ].filter(Boolean) : changes
  const labelMap = {
    'rule-create': '新增规则',
    'rule-update': '修改规则',
    'rule-status-update': '规则启停',
    'rule-delete': '删除规则',
    'reminder-config-update': '自动催办规则',
    'runtime-config-update': '运行与账号安全配置'
  }
  return {
    kind: isRuntimeConfig ? 'runtime-config-update' : kind,
    label: isRuntimeConfig ? labelMap['runtime-config-update'] : labelMap[kind] || '配置变更',
    changeCount: metadata.changeCount ?? runtimeChanges.length,
    ruleName: rule.name || '',
    ruleCategory: rule.category || '',
    ruleStatus: rule.status || '',
    changes: runtimeChanges
  }
}

function hermesConfigInfo(item = {}) {
  if (detectActionGroup(item.action) !== 'Hermes配置') return null
  const metadata = item.metadata || {}
  return {
    provider: metadata.provider || '',
    model: metadata.model || '',
    checkedAt: metadata.checkedAt || '',
    webCount: metadata.webCount ?? null,
    remoteCount: metadata.remoteCount ?? null,
    matchedCount: metadata.matchedCount ?? null,
    missingCount: metadata.missingCount ?? null,
    driftCount: metadata.driftCount ?? null,
    changedProfileCount: metadata.changedProfileCount ?? null,
    profileCount: metadata.profileCount ?? null,
    missingProfiles: metadata.missingProfiles || [],
    driftProfiles: metadata.driftProfiles || [],
    profileNames: metadata.profileNames || [],
    changes: metadata.changes || [],
    diagnostic: metadata.diagnostic || null,
    message: metadata.message || ''
  }
}

function hermesConfigText(item = {}) {
  const info = hermesConfigInfo(item)
  if (!info) return ''
  return [
    item.action || 'Hermes 配置日志',
    '来源：第一服务研发小组审核系统 / 日志中心 / Hermes配置',
    `操作人：${item.actor || '未知账号'}`,
    `日志时间：${item.at || '未记录'}`,
    `结果：${item.result || '未记录'}`,
    info.checkedAt ? `检查时间：${info.checkedAt}` : '',
    info.provider ? `Provider：${info.provider}` : '',
    info.model ? `模型：${info.model}` : '',
    info.webCount !== null ? `网页 Profile：${info.webCount} 个` : '',
    info.remoteCount !== null ? `云端 Profile：${info.remoteCount} 个` : '',
    info.matchedCount !== null ? `已匹配：${info.matchedCount} 个` : '',
    info.missingCount !== null ? `未匹配：${info.missingCount} 个` : '',
    info.driftCount !== null ? `待同步差异：${info.driftCount} 个` : '',
    info.changedProfileCount !== null ? `变化专业：${info.changedProfileCount} 个` : '',
    info.profileCount !== null ? `Profile 数量：${info.profileCount} 个` : '',
    info.missingProfiles.length ? `未匹配专业：${info.missingProfiles.join('、')}` : '',
    info.driftProfiles.length ? `差异专业：${info.driftProfiles.join('、')}` : '',
    info.profileNames.length ? `涉及专业：${info.profileNames.join('、')}` : '',
    info.changes.length ? `变更字段：${info.changes.map(change => `${change.code || change.id || ''} ${change.name || ''}：${(change.changedFields || []).join('、') || '字段未记录'}`.trim()).join('\n')}` : '',
    info.diagnostic?.nextAction ? `接入排查建议：${info.diagnostic.nextAction}` : '',
    ...(info.diagnostic?.checks || []).map(check => `${check.label}：${check.status}；${check.detail}`),
    info.message ? `说明：${info.message}` : ''
  ].filter(Boolean).join('\n')
}

function launchApprovalInfo(item = {}) {
  if (detectActionGroup(item.action) !== '上线确认') return null
  const metadata = item.metadata || {}
  const riskSummary = metadata.riskSummary || {}
  const items = Array.isArray(metadata.items)
    ? metadata.items.map(entry => ({
      label: String(entry?.label || ''),
      status: String(entry?.status || ''),
      detail: String(entry?.detail || ''),
      action: String(entry?.action || '')
    })).filter(entry => entry.label)
    : []
  return {
    id: metadata.id || item.id || '',
    generatedAt: metadata.generatedAt || item.at || '',
    refreshedAt: metadata.refreshedAt || '',
    appVersion: metadata.appVersion || '',
    appBuildLabel: metadata.appBuildLabel || '',
    appBuildTime: metadata.appBuildTime || '',
    passed: metadata.passed ?? null,
    total: metadata.total ?? null,
    items,
    reason: metadata.reason || '',
    riskSummary: {
      defaultPassword: riskSummary.defaultPassword ?? null,
      mustChangePassword: riskSummary.mustChangePassword ?? null,
      loginLocked: riskSummary.loginLocked ?? null,
      riskCount: riskSummary.riskCount ?? null,
      byRole: Array.isArray(riskSummary.byRole) ? riskSummary.byRole : [],
      latestPasswordNotice: riskSummary.latestPasswordNotice || null
    }
  }
}

function accountRiskActions(riskSummary = {}) {
  const actions = [
    (Number(riskSummary.defaultPassword) || 0) > 0
      ? { label: `默认密码 ${riskSummary.defaultPassword}`, to: '/users?password=默认密码&select=visible', className: 'border-red-200/30 text-red-100 hover:border-red-100/60' }
      : null,
    (Number(riskSummary.mustChangePassword) || 0) > 0
      ? { label: `需改密 ${riskSummary.mustChangePassword}`, to: '/users?password=需改密&select=visible', className: 'border-amber-200/30 text-amber-100 hover:border-amber-100/60' }
      : null,
    (Number(riskSummary.loginLocked) || 0) > 0
      ? { label: `登录锁定 ${riskSummary.loginLocked}`, to: '/users?security=登录锁定&select=visible', className: 'border-orange-200/30 text-orange-100 hover:border-orange-100/60' }
      : null,
    Array.isArray(riskSummary.latestPasswordNotice?.targetUsernames) && riskSummary.latestPasswordNotice.targetUsernames.length > 0
      ? { label: '最近文案涉及账号', to: '/users?notice=latest&select=visible', className: 'border-blue-200/30 text-blue-100 hover:border-blue-100/60' }
      : null
  ].filter(Boolean)
  return actions.length ? actions : [{ label: '查看人员管理', to: '/users', className: 'border-red-200/30 text-red-100 hover:border-red-100/60' }]
}

function launchApprovalText(item = {}, freshHours = 24) {
  const info = launchApprovalInfo(item)
  if (!info) return ''
  const confirmedAt = item.at || info.generatedAt || ''
  const expired = olderThanHours(confirmedAt, freshHours)
  return [
    item.action || '上线确认记录',
    '来源：第一服务研发小组审核系统 / 日志中心 / 上线确认',
    `记录编号：${info.id || '未记录'}`,
    `操作人：${item.actor || '未知账号'}`,
    `日志时间：${item.at || '未记录'}`,
    `生成时间：${info.generatedAt || '未记录'}`,
    `有效阈值：${normalizeLaunchApprovalFreshHours(freshHours)} 小时`,
    `有效状态：${expired ? '建议重新确认' : '当前有效'}`,
    `最近刷新：${info.refreshedAt || '未记录'}`,
    `前端版本：${info.appVersion || '未记录'}`,
    `构建标识：${info.appBuildLabel || info.appVersion || '未记录'}`,
    `构建时间：${info.appBuildTime || '未记录'}`,
    info.passed !== null || info.total !== null ? `检查结论：${info.passed ?? 0}/${info.total ?? 0} 项通过` : '',
    info.reason ? `拦截原因：${info.reason}` : '',
    info.riskSummary.riskCount !== null
      ? `账号风险：默认密码 ${info.riskSummary.defaultPassword ?? 0} 个，需改密 ${info.riskSummary.mustChangePassword ?? 0} 个，登录锁定 ${info.riskSummary.loginLocked ?? 0} 个`
      : '',
    info.riskSummary.byRole.length ? `角色分布：${info.riskSummary.byRole.map(item => `${item.role || '-'} ${item.enabled || 0}/${item.total || 0}`).join('、')}` : '',
    info.riskSummary.latestPasswordNotice
      ? `最近改密通知文案：${info.riskSummary.latestPasswordNotice.auditId || '未记录'}，涉及 ${info.riskSummary.latestPasswordNotice.affectedAccountCount ?? info.riskSummary.latestPasswordNotice.noticeCount ?? 0} 个账号，未发送，操作人 ${info.riskSummary.latestPasswordNotice.actor || '未知账号'}，时间 ${info.riskSummary.latestPasswordNotice.at || '未记录'}`
      : info.riskSummary.riskCount !== null && (Number(info.riskSummary.mustChangePassword) || 0) > 0
        ? '最近改密通知文案：尚未发现文案生成留痕'
        : '',
    '',
    ...(info.items.length ? info.items.map(entry => `${entry.status || '未记录'}｜${entry.label || '-'}｜${entry.detail || '-'}${entry.action ? `｜建议：${entry.action}` : ''}`) : [])
  ].filter(Boolean).join('\n')
}

function networkDiagnosticsInfo(item = {}) {
  if (detectActionGroup(item.action) !== '公网诊断') return null
  const metadata = item.metadata || {}
  return {
    domain: metadata.domain || '',
    expectedIp: metadata.expectedIp || '',
    resolvedIps: Array.isArray(metadata.resolvedIps) ? metadata.resolvedIps : [],
    message: metadata.message || ''
  }
}

function networkDiagnosticsText(item = {}) {
  const info = networkDiagnosticsInfo(item)
  if (!info) return ''
  return [
    item.action || '公网解析诊断',
    '来源：第一服务研发小组审核系统 / 日志中心 / 公网诊断',
    `操作人：${item.actor || '未知账号'}`,
    `日志时间：${item.at || '未记录'}`,
    `结果：${item.result || '未记录'}`,
    `公网域名：${info.domain || '未记录'}`,
    `预期公网 IP：${info.expectedIp || '未记录'}`,
    `实际解析 IP：${info.resolvedIps.length ? info.resolvedIps.join('、') : '未记录'}`,
    `说明：${info.message || '未记录'}`
  ].join('\n')
}

function aiTraceModeText(mode = '', fallback = false) {
  if (mode === 'hermes-agent') return 'Hermes Agent'
  if (mode === 'external') return '外部 AI'
  if (mode === 'fallback-local' || fallback) return '本地兜底'
  if (mode === 'local') return '本地规则'
  return '未记录模式'
}

function aiTraceResultText(trace = {}) {
  if (trace.fallback === true || trace.status === 'fallback') return '回退'
  if (trace.status === 'failed') return '失败'
  if (trace.status === 'success') return '成功'
  return '待人工复核'
}

function resultToneClass(result = '') {
  if (result === '成功') return 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
  if (result === '回退') return 'border-amber-400/30 bg-amber-500/10 text-amber-200'
  if (result === '待确认') return 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200'
  if (!result || result === '未记录') return 'border-slate-400/30 bg-slate-500/10 text-slate-300'
  return 'border-red-400/30 bg-red-500/10 text-red-200'
}

function aiTraceInfo(item = {}) {
  if (detectActionGroup(item.action) !== 'AI调用' && item.metadata?.kind !== 'ai-review-trace') return null
  const metadata = item.metadata || {}
  const items = Array.isArray(metadata.items) ? metadata.items : []
  return {
    source: metadata.source || '',
    traceId: metadata.traceId || '',
    provider: metadata.provider || '',
    model: metadata.model || '',
    mode: metadata.mode || '',
    modeName: metadata.modeName || aiTraceModeText(metadata.mode, metadata.fallback === true),
    status: metadata.status || item.result || '',
    fallback: metadata.fallback === true || item.result === '回退',
    durationMs: metadata.durationMs ?? null,
    profileCount: metadata.profileCount ?? null,
    opinionCount: metadata.opinionCount ?? null,
    result: metadata.result || '',
    error: metadata.error || '',
    reviewedAt: metadata.reviewedAt || item.at || '',
    requestedCount: metadata.requestedCount ?? null,
    successCount: metadata.successCount ?? null,
    failedCount: metadata.failedCount ?? null,
    fallbackCount: metadata.fallbackCount ?? null,
    items
  }
}

function aiTraceText(item = {}) {
  const info = aiTraceInfo(item)
  if (!info) return ''
  return [
    item.action || 'AI 调用日志',
    '来源：第一服务研发小组审核系统 / 日志中心 / AI调用',
    `操作人：${item.actor || '未知账号'}`,
    `日志时间：${item.at || '未记录'}`,
    `结果：${item.result || '未记录'}`,
    `方案：${extractProposalTitle(item) || item.proposalTitle || '未绑定方案'}`,
    info.requestedCount !== null ? `批量数量：请求 ${info.requestedCount}，成功 ${info.successCount ?? 0}，回退 ${info.fallbackCount ?? 0}，失败 ${info.failedCount ?? 0}` : '',
    info.provider ? `Provider：${info.provider}` : '',
    info.model ? `模型：${info.model}` : '',
    `模式：${info.modeName || '未记录模式'}`,
    info.status ? `调用状态：${info.status}` : '',
    info.durationMs !== null ? `耗时：${info.durationMs} ms` : '',
    info.profileCount !== null ? `Profile：${info.profileCount}` : '',
    info.opinionCount !== null ? `意见：${info.opinionCount}` : '',
    info.result ? `审核结论：${info.result}` : '',
    info.error ? `原因：${info.error}` : '',
    info.items.length ? `批量明细：\n${info.items.map(entry => {
      const ai = entry.ai || {}
      return `${entry.title || entry.id}：${entry.ok ? aiTraceResultText(ai) : '失败'}${entry.message ? `，${entry.message}` : ''}${ai.error ? `，${ai.error}` : ''}`
    }).join('\n')}` : ''
  ].filter(Boolean).join('\n')
}

function bulkOperationInfo(item = {}) {
  const metadata = item.metadata || {}
  const isBulkAiReview = metadata.bulkKind === 'bulk-ai-review' || metadata.source === 'bulk-rerun'
  const action = String(item.action || '')
  const hasStructuredBulk = ['bulk-status', 'bulk-delete', 'bulk-reminder', 'knowledge-bulk-status', 'knowledge-bulk-delete'].includes(metadata.kind) || isBulkAiReview
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
          : ''
  if (!hasStructuredBulk && !legacyLabel) return null
  const titles = Array.isArray(metadata.titles) ? metadata.titles.filter(Boolean) : Array.isArray(metadata.items) ? metadata.items.map(item => item.title).filter(Boolean) : []
  const proposalIds = Array.isArray(metadata.proposalIds) ? metadata.proposalIds.filter(Boolean) : []
  const knowledgeIds = Array.isArray(metadata.knowledgeIds) ? metadata.knowledgeIds.filter(Boolean) : []
  const skippedItems = Array.isArray(metadata.skippedItems) ? metadata.skippedItems : []
  const isKnowledgeBulk = ['knowledge-bulk-status', 'knowledge-bulk-delete'].includes(metadata.kind) || legacyLabel.includes('知识条款')
  const labelMap = {
    'bulk-status': '批量状态更新',
    'bulk-delete': '批量删除',
    'bulk-reminder': '批量催办',
    'knowledge-bulk-status': '知识条款批量状态',
    'knowledge-bulk-delete': '知识条款批量删除',
    'ai-review-trace': '批量AI重审'
  }
  return {
    kind: metadata.kind || legacyLabel,
    label: hasStructuredBulk ? isBulkAiReview ? '批量AI重审' : labelMap[metadata.kind] || '批量操作' : legacyLabel,
    requestedCount: metadata.requestedCount ?? null,
    updatedCount: metadata.updatedCount ?? null,
    removedCount: metadata.removedCount ?? null,
    createdCount: metadata.createdCount ?? null,
    skippedCount: metadata.skippedCount ?? null,
    successCount: metadata.successCount ?? null,
    failedCount: metadata.failedCount ?? null,
    fallbackCount: metadata.fallbackCount ?? null,
    source: metadata.source || '',
    status: metadata.status || '',
    objectLabel: isKnowledgeBulk ? '知识条款' : '方案',
    proposalIds,
    knowledgeIds,
    titles,
    skippedItems,
    legacyAction: hasStructuredBulk ? '' : action
  }
}

function isBulkOperationLog(item = {}) {
  return Boolean(bulkOperationInfo(item))
}

function bulkOperationText(item = {}) {
  const info = bulkOperationInfo(item)
  if (!info) return ''
  return [
    item.action || info.label,
    '来源：第一服务研发小组审核系统 / 日志中心 / 批量操作',
    `操作人：${item.actor || '未知账号'}`,
    `日志时间：${item.at || '未记录'}`,
    `操作类型：${info.label}`,
    info.status ? `目标状态：${info.status}` : '',
    info.source ? `来源：${info.source === 'auto' ? '自动催办' : '人工登记'}` : '',
    info.requestedCount !== null ? `请求数量：${info.requestedCount}` : '',
    info.updatedCount !== null ? `更新数量：${info.updatedCount}` : '',
    info.removedCount !== null ? `删除数量：${info.removedCount}` : '',
    info.createdCount !== null ? `生成数量：${info.createdCount}` : '',
    info.skippedCount !== null ? `跳过数量：${info.skippedCount}` : '',
    info.successCount !== null ? `成功数量：${info.successCount}` : '',
    info.fallbackCount !== null ? `回退数量：${info.fallbackCount}` : '',
    info.failedCount !== null ? `失败数量：${info.failedCount}` : '',
    info.legacyAction ? `原始动作：${info.legacyAction}` : '',
    info.titles.length ? `涉及${info.objectLabel}：${info.titles.map(title => `《${title}》`).join('、')}` : '',
    info.skippedItems.length ? `跳过方案：${info.skippedItems.map(entry => `《${entry.title || entry.id}》(${entry.reason || '未记录原因'})`).join('、')}` : '',
    info.proposalIds.length ? `方案ID：${info.proposalIds.join('、')}` : '',
    info.knowledgeIds.length ? `知识条款ID：${info.knowledgeIds.join('、')}` : ''
  ].filter(Boolean).join('\n')
}

function rolePermissionChangeText(item = {}) {
  const rows = rolePermissionChangeRows(item)
  if (!rows.length) return ''
  const currentUser = getUser()
  return [
    item.action || '角色权限矩阵变更',
    '来源：第一服务研发小组审核系统 / 日志中心 / 权限变更',
    `生成账号：${currentUser?.name || currentUser?.username || '未知账号'}`,
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `操作人：${item.actor || '未知账号'}`,
    `日志时间：${item.at || '未记录'}`,
    ...rows.map(row => [
      row.role,
      row.enabledUsers !== null ? `影响账号：启用 ${row.enabledUsers} / 总计 ${row.totalUsers ?? 0}` : '',
      row.added.length ? `新增：${row.added.join('、')}` : '',
      row.removed.length ? `移除：${row.removed.join('、')}` : ''
    ].filter(Boolean).join('；'))
  ].join('\n')
}

function parseLogDate(value = '') {
  const text = String(value || '').trim()
  if (!text) return null
  const normalized = text.replace(/\//g, '-')
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

function inRange(date, range) {
  if (!date || range === '全部') return true
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (range === '今天') return date >= startOfToday
  const diffMs = now.getTime() - date.getTime()
  const diffDays = diffMs / (1000 * 60 * 60 * 24)
  if (range === '近7天') return diffDays <= 7
  if (range === '近30天') return diffDays <= 30
  return true
}

function detectLogType(item = '') {
  if (item && typeof item === 'object') {
    if (item.category) return item.category
    return detectLogType(item.action)
  }
  const text = String(item || '')
  if (
    text.includes('登录') ||
    text.includes('退出') ||
    text.includes('密码') ||
    text.includes('账号')
  ) {
    return '账号安全'
  }
  if (text.includes('自动催办规则配置') || text.includes('角色权限矩阵') || text.includes('系统运行与账号安全配置') || text.includes('公网解析诊断')) {
    return '系统配置'
  }
  if (text.includes('AI调用') || text.includes('AI 审核')) {
    return '执行动作'
  }
  if (
    text.includes('人工复核') ||
    text.includes('复核备注') ||
    text.includes('签发') ||
    text.includes('归档') ||
    text.includes('催办') ||
    text.includes('意见书') ||
    text.includes('预览')
  ) {
    return '执行动作'
  }
  if (
    text.includes('机器人') ||
    text.includes('知识条款') ||
    text.includes('规则') ||
    text.includes('账号') ||
    text.includes('自动催办规则配置')
  ) {
    return '系统配置'
  }
  return '审核动作'
}

function detectActionGroup(action = '') {
  const text = String(action || '')
  if (text.includes('前端异常')) return '前端异常'
  if (text.includes('AI调用') || text.includes('AI 审核')) return 'AI调用'
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

export default function LogsView() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [logs, setLogs] = useState([])
  const [logTotal, setLogTotal] = useState(0)
  const [logSummary, setLogSummary] = useState(null)
  const currentUser = getUser()
  const canSubmitProposal = hasPermission(currentUser, 'submitProposal')
  const canManageSystem = hasPermission(currentUser, 'manageSystem')
  const canManageUsers = hasPermission(currentUser, 'manageUsers')
  const canViewSecurityLogs = canManageSystem || canManageUsers
  const fallbackLogTypeOptions = canManageSystem ? defaultLogTypeOptions : canManageUsers ? userSecurityLogTypeOptions : userLogTypeOptions
  const fallbackActionGroupOptions = useMemo(
    () => canManageSystem
      ? [...baseActionGroupOptions.slice(0, 3), ...systemActionGroupOptions, ...baseActionGroupOptions.slice(3)]
      : baseActionGroupOptions,
    [canManageSystem]
  )
  const [logOptions, setLogOptions] = useState({ actors: ['全部'], categories: fallbackLogTypeOptions, actionGroups: fallbackActionGroupOptions, results: defaultResultOptions, ips: ['全部'] })
  const [proposalItems, setProposalItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pruning, setPruning] = useState(false)
  const [testingClientError, setTestingClientError] = useState(false)
  const [retentionDays, setRetentionDays] = useState(180)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [copyFallback, setCopyFallback] = useState({ open: false, title: '', description: '', content: '' })
  const [launchApprovalFreshHours, setLaunchApprovalFreshHours] = useState(initialLaunchApprovalFreshHours)
  const actorFilterId = useId()
  const rangeFilterId = useId()
  const resultFilterId = useId()
  const ipFilterId = useId()
  const submitterFilterId = useId()
  const proposalTypeFilterId = useId()
  const proposalIdFilterId = useId()
  const exportSourceFilterId = useId()
  const launchApprovalFreshHoursId = useId()
  function updateLaunchApprovalFreshHours(value) {
    const next = normalizeLaunchApprovalFreshHours(value)
    setLaunchApprovalFreshHours(next)
    try {
      localStorage.setItem(launchApprovalFreshHoursKey, String(next))
    } catch {
      // 忽略本地存储不可用场景，页面状态仍然生效。
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const [proposalData, optionData] = await Promise.all([
          api.get('/proposals').catch(() => ({ items: [] })),
          api.get('/logs/options').catch(() => ({ options: {} }))
        ])
        setProposalItems(proposalData.items || [])
        setLogOptions({
          actors: optionData.options?.actors?.length ? optionData.options.actors : ['全部'],
          categories: mergeLogTypeOptions(optionData.options?.categories || [], fallbackLogTypeOptions),
          actionGroups: mergeActionGroupOptions(optionData.options?.actionGroups || [], fallbackActionGroupOptions),
          results: optionData.options?.results?.length ? optionData.options.results : defaultResultOptions,
          ips: optionData.options?.ips?.length ? optionData.options.ips : ['全部']
        })
      } catch (err) {
        setError(err.message || '日志筛选项加载失败')
      }
    })()
  }, [fallbackActionGroupOptions, fallbackLogTypeOptions])

  useEffect(() => {
    (async () => {
      setLoading(true)
      setError('')
      try {
        const query = new URLSearchParams(searchParams)
        query.set('limit', String(pageSize))
        query.set('offset', '0')
        const [logData, summaryData] = await Promise.all([
          api.get(`/logs?${query.toString()}`),
          api.get(`/logs/summary?${searchParams.toString()}`)
        ])
        setLogs(logData.logs || [])
        setLogTotal(logData.total || (logData.logs || []).length)
        setLogSummary(summaryData.summary || null)
      } catch (err) {
        setError(err.message || '日志加载失败')
      } finally {
        setLoading(false)
      }
    })()
  }, [searchParams])

  const keyword = searchParams.get('q') || ''
  const typeFilter = searchParams.get('type') || '全部'
  const actorFilter = searchParams.get('actor') || '全部'
  const rangeFilter = searchParams.get('range') || '全部'
  const ipFilter = searchParams.get('ip') || '全部'
  const exportSourceFilter = searchParams.get('exportSource') || '全部'
  const resultFilter = searchParams.get('result') || '全部'
  const submitterFilter = searchParams.get('submitter') || '全部'
  const proposalTypeFilter = searchParams.get('proposalType') || '全部'
  const proposalIdFilter = searchParams.get('proposalId') || ''
  const proposalIdsFilter = searchParams.get('proposalIds') || ''
  const actionGroupFilter = searchParams.get('actionGroup') || '全部'
  const normalizedKeyword = keyword.trim().toLowerCase()
  const exportAuditKeyword = keyword.trim().startsWith('USER-EXPORT-') ? keyword.trim() : ''
  const bulkAuditKeyword = keyword.trim().startsWith('USER-BULK-') ? keyword.trim() : ''
  const proposalIdList = useMemo(
    () => [...new Set(proposalIdsFilter.split(',').map(item => item.trim()).filter(Boolean))],
    [proposalIdsFilter]
  )
  const proposalScopeIds = proposalIdList.length > 0
    ? proposalIdList
    : proposalIdFilter
      ? [proposalIdFilter]
      : []
  const actorOptions = logOptions.actors || ['全部']
  const typeOptions = logOptions.categories || defaultLogTypeOptions
  const visibleActionGroupOptions = logOptions.actionGroups || fallbackActionGroupOptions
  const effectiveTypeFilter = typeFilter === '全部' || typeOptions.includes(typeFilter) ? typeFilter : '全部'
  const effectiveActionGroupFilter = actionGroupFilter === '全部' || visibleActionGroupOptions.includes(actionGroupFilter) ? actionGroupFilter : '全部'
  const resultOptions = logOptions.results || defaultResultOptions
  const ipOptions = logOptions.ips || ['全部']

  useEffect(() => {
    if (actionGroupFilter === '全部' || visibleActionGroupOptions.includes(actionGroupFilter)) return
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('actionGroup')
      return next
    }, { replace: true })
  }, [actionGroupFilter, setSearchParams, visibleActionGroupOptions])

  useEffect(() => {
    if (typeFilter === '全部' || typeOptions.includes(typeFilter)) return
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('type')
      return next
    }, { replace: true })
  }, [setSearchParams, typeFilter, typeOptions])

  const proposalOptions = useMemo(() => {
    const proposalMap = new Map()

    proposalItems.forEach(item => {
      proposalMap.set(item.id, {
        id: item.id,
        title: item.title,
        submitter: item.submitter || '',
        type: item.type || ''
      })
    })

    logs
      .filter(item => item.proposalId && extractProposalTitle(item))
      .forEach(item => {
        const existing = proposalMap.get(item.proposalId)
        if (existing) {
          proposalMap.set(item.proposalId, {
            ...existing,
            title: existing.title || extractProposalTitle(item)
          })
          return
        }

        proposalMap.set(item.proposalId, {
          id: item.proposalId,
          title: extractProposalTitle(item),
          submitter: '',
          type: ''
        })
      })

    return Array.from(proposalMap.values())
  }, [logs, proposalItems])
  const proposalMetaById = useMemo(
    () => new Map(proposalOptions.map(item => [item.id, item])),
    [proposalOptions]
  )
  const submitterOptions = useMemo(
    () => ['全部', ...Array.from(new Set(proposalOptions.map(item => item.submitter).filter(Boolean)))],
    [proposalOptions]
  )
  const proposalTypeOptions = ['全部', '内部运营方案', '市场拓展方案']

  const filtered = useMemo(() => logs.filter(item => {
    const proposalMeta = proposalMetaById.get(item.proposalId) || null
    const searchable = [
      item.actor,
      item.action,
      item.at,
      item.category,
      item.result,
      item.ip,
      item.userAgent,
      JSON.stringify(item.metadata || {}),
      proposalMeta?.title,
      proposalMeta?.submitter,
      proposalMeta?.type
    ].join(' ').toLowerCase()
    const matchKeyword = !normalizedKeyword || searchable.includes(normalizedKeyword)
    const matchType = typeFilter === '全部' || detectLogType(item) === typeFilter
    const matchActor = actorFilter === '全部' || item.actor === actorFilter
    const matchResult = resultFilter === '全部' || (item.result || '未记录') === resultFilter
    const matchRange = inRange(parseLogDate(item.at), rangeFilter)
    const matchProposal = proposalScopeIds.length === 0 || proposalScopeIds.includes(item.proposalId)
    const matchSubmitter = submitterFilter === '全部' || proposalMeta?.submitter === submitterFilter
    const matchProposalType = proposalTypeFilter === '全部' || proposalMeta?.type === proposalTypeFilter
    const matchActionGroup = actionGroupFilter === '全部' || (actionGroupFilter === '批量操作' ? isBulkOperationLog(item) : detectActionGroup(item.action) === actionGroupFilter)
    const matchExportSource =
      exportSourceFilter === '全部' ||
      (exportSourceFilter === '详情页' && exportSourceForLog(item) === 'detail') ||
      (exportSourceFilter === '提交结果' && exportSourceForLog(item) === 'submit') ||
      (exportSourceFilter === '审核中心' && exportSourceForLog(item) === 'review') ||
      (exportSourceFilter === '未标注' && !exportSourceForLog(item))
    return matchKeyword && matchType && matchActor && matchResult && matchRange && matchProposal && matchSubmitter && matchProposalType && matchActionGroup && matchExportSource
  }), [actionGroupFilter, actorFilter, exportSourceFilter, logs, normalizedKeyword, proposalMetaById, proposalScopeIds, proposalTypeFilter, rangeFilter, resultFilter, submitterFilter, typeFilter])

  const proposalExecutionSummary = useMemo(() => {
    if (proposalScopeIds.length === 0) return null
    const targetLogs = filtered.filter(item => proposalScopeIds.includes(item.proposalId))
    const matchedProposalIds = [...new Set(targetLogs.map(item => item.proposalId).filter(Boolean))]
    const displayProposalIds = matchedProposalIds.length > 0 ? matchedProposalIds : proposalScopeIds
    const actionGroupCounts = visibleActionGroupOptions
      .filter(option => option !== '全部')
      .map(option => ({
        label: option,
        count: targetLogs.filter(item => detectActionGroup(item.action) === option).length
      }))
    const scopedProposals = displayProposalIds.map(id => {
      const matched = proposalMetaById.get(id)
      return {
        id,
        title: matched?.title || extractProposalTitle(targetLogs.find(item => item.proposalId === id)) || id
      }
    })
    const submitterNames = [...new Set(
      scopedProposals
        .map(item => proposalMetaById.get(item.id)?.submitter)
        .filter(Boolean)
    )]
    return {
      title: proposalScopeIds.length === 1 ? scopedProposals[0]?.title || '' : `${proposalScopeIds.length} 个方案`,
      proposalCount: displayProposalIds.length,
      selectedProposalCount: proposalScopeIds.length,
      matchedProposalCount: matchedProposalIds.length,
      proposals: scopedProposals,
      submitterNames,
      total: targetLogs.length,
      executionCount: targetLogs.filter(item => detectLogType(item) === '执行动作').length,
      reviewCount: targetLogs.filter(item => detectLogType(item) === '审核动作').length,
      configCount: targetLogs.filter(item => detectLogType(item) === '系统配置').length,
      accountSecurityCount: targetLogs.filter(item => detectLogType(item) === '账号安全').length,
      accountSecurityLockedCount: targetLogs.filter(item => detectLogType(item) === '账号安全' && item.result === '锁定').length,
      accountSecurityInterceptCount: targetLogs.filter(item => detectLogType(item) === '账号安全' && item.result === '拦截').length,
      accountSecurityRejectedCount: targetLogs.filter(item => detectLogType(item) === '账号安全' && item.result === '拒绝').length,
      bulkOperationCount: targetLogs.filter(item => isBulkOperationLog(item)).length,
      actionGroupCounts,
      latestAt: targetLogs[0]?.at || '',
      latestActor: targetLogs[0]?.actor || ''
    }
  }, [filtered, proposalMetaById, proposalScopeIds, visibleActionGroupOptions])

  const groupedSummaryRows = useMemo(() => {
    const rows = new Map()
    const sourceLogs = proposalScopeIds.length > 0
      ? filtered.filter(item => proposalScopeIds.includes(item.proposalId))
      : filtered

    sourceLogs.forEach(item => {
      const proposalMeta = proposalMetaById.get(item.proposalId) || null
      const key = item.proposalId || '__NO_PROPOSAL__'
      const current = rows.get(key) || {
        proposalId: item.proposalId || '',
        proposalTitle: proposalMeta?.title || extractProposalTitle(item) || '未绑定方案',
        submitter: proposalMeta?.submitter || '',
        proposalType: proposalMeta?.type || '',
        total: 0,
        executionCount: 0,
        reviewCount: 0,
        configCount: 0,
        accountSecurityCount: 0,
        accountSecurityLockedCount: 0,
        accountSecurityInterceptCount: 0,
        accountSecurityRejectedCount: 0,
        bulkOperationCount: 0,
        manualReviewCount: 0,
        signOffArchiveCount: 0,
        reminderCount: 0,
        exportCount: 0,
        aiTraceCount: 0,
        hermesConfigCount: 0,
        frontEndErrorCount: 0,
        latestAt: '',
        latestActor: ''
      }

      current.total += 1
      if (detectLogType(item) === '执行动作') current.executionCount += 1
      if (detectLogType(item) === '审核动作') current.reviewCount += 1
      if (detectLogType(item) === '系统配置') current.configCount += 1
      if (detectLogType(item) === '账号安全') current.accountSecurityCount += 1
      if (detectLogType(item) === '账号安全' && item.result === '锁定') current.accountSecurityLockedCount += 1
      if (detectLogType(item) === '账号安全' && item.result === '拦截') current.accountSecurityInterceptCount += 1
      if (detectLogType(item) === '账号安全' && item.result === '拒绝') current.accountSecurityRejectedCount += 1
      if (isBulkOperationLog(item)) current.bulkOperationCount += 1
      if (detectActionGroup(item.action) === '人工复核') current.manualReviewCount += 1
      if (detectActionGroup(item.action) === '签发归档') current.signOffArchiveCount += 1
      if (detectActionGroup(item.action) === '催办') current.reminderCount += 1
      if (detectActionGroup(item.action) === '导出') current.exportCount += 1
      if (detectActionGroup(item.action) === 'AI调用') current.aiTraceCount += 1
      if (detectActionGroup(item.action) === 'Hermes配置') current.hermesConfigCount += 1
      if (detectActionGroup(item.action) === '前端异常') current.frontEndErrorCount += 1
      if (String(item.at || '').localeCompare(String(current.latestAt || ''), 'zh-CN') > 0) {
        current.latestAt = item.at || ''
        current.latestActor = item.actor || ''
      }

      rows.set(key, current)
    })

    return Array.from(rows.values()).sort((a, b) => (
      b.total - a.total ||
      String(b.latestAt || '').localeCompare(String(a.latestAt || ''), 'zh-CN')
    ))
  }, [filtered, proposalMetaById, proposalScopeIds])

  const syncSearchParam = (key, value) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (key === 'proposalId') next.delete('proposalIds')
      if (key === 'proposalIds') next.delete('proposalId')
      if (!value || value === '全部') next.delete(key)
      else next.set(key, value)
      return next
    })
  }

  const applyBulkOperationFilter = (keywordValue = '批量', actionGroup = '全部') => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('range', '近30天')
      next.delete('proposalId')
      next.delete('proposalIds')
      next.delete('submitter')
      next.delete('proposalType')
      next.delete('exportSource')
      next.delete('result')
      if (actionGroup && actionGroup !== '全部') {
        next.set('type', '执行动作')
        next.set('actionGroup', actionGroup)
      } else {
        next.delete('type')
        next.set('actionGroup', '批量操作')
      }
      if (keywordValue && keywordValue !== '批量') next.set('q', keywordValue)
      else next.delete('q')
      return next
    })
  }

  const loadMoreLogs = async () => {
    setLoadingMore(true)
    setError('')
    try {
      const query = new URLSearchParams(searchParams)
      query.set('limit', String(pageSize))
      query.set('offset', String(logs.length))
      const logData = await api.get(`/logs?${query.toString()}`)
      setLogs(prev => [...prev, ...(logData.logs || [])])
      setLogTotal(logData.total || logTotal)
    } catch (err) {
      setError(err.message || '更多日志加载失败')
    } finally {
      setLoadingMore(false)
    }
  }

  const reloadLogs = async (params = searchParams) => {
    const query = new URLSearchParams(params)
    query.set('limit', String(pageSize))
    query.set('offset', '0')
    const [logData, summaryData, optionData] = await Promise.all([
      api.get(`/logs?${query.toString()}`),
      api.get(`/logs/summary?${params.toString()}`),
      api.get('/logs/options').catch(() => ({ options: {} }))
    ])
    setLogs(logData.logs || [])
    setLogTotal(logData.total || (logData.logs || []).length)
    setLogSummary(summaryData.summary || null)
    setLogOptions({
      actors: optionData.options?.actors?.length ? optionData.options.actors : ['全部'],
      categories: mergeLogTypeOptions(optionData.options?.categories || [], fallbackLogTypeOptions),
      actionGroups: mergeActionGroupOptions(optionData.options?.actionGroups || [], fallbackActionGroupOptions),
      results: optionData.options?.results?.length ? optionData.options.results : defaultResultOptions,
      ips: optionData.options?.ips?.length ? optionData.options.ips : ['全部']
    })
  }

  const pruneLogs = async () => {
    const days = Number(retentionDays) || 180
    const confirmText = window.prompt(`将清理 ${days} 天前的审计日志，该操作会保留清理记录。\n请输入“清理旧日志”继续：`)?.trim()
    if (confirmText !== '清理旧日志') {
      setError('请输入“清理旧日志”后再执行清理')
      return
    }
    setPruning(true)
    setError('')
    setMessage('')
    try {
      const result = await api.post('/logs/prune', { retentionDays: days, confirmText })
      await reloadLogs()
      setMessage(`已清理 ${result.removed || 0} 条旧审计日志，当前剩余 ${result.total || 0} 条。`)
    } catch (err) {
      setError(err.message || '日志清理失败')
    } finally {
      setPruning(false)
    }
  }

  const currentFilterSummary = `类型：${effectiveTypeFilter}；动作分组：${effectiveActionGroupFilter}；操作人：${actorFilter}；来源IP：${ipFilter}；结果：${resultFilter}；时间范围：${rangeFilter}；导出来源：${exportSourceFilter}；提交人：${submitterFilter}；方案类型：${proposalTypeFilter}；方案：${proposalScopeIds.length > 1 ? `${proposalScopeIds.length} 个方案联查` : proposalOptions.find(item => item.id === proposalIdFilter)?.title || (proposalIdFilter ? '指定方案' : '全部')}；关键词：${keyword.trim() || '无'}；结果数：${filtered.length}`
  const hasMoreLogs = logs.length < logTotal
  const latestRolePermissionChangeCopyable = Boolean(rolePermissionChangeText(logSummary?.latestRolePermissionChange || {}))
  const latestExportEventCopyable = Boolean(exportEventText(logSummary?.latestExportEvent || {}))
  const latestAccountSecurityExport = logSummary?.latestAccountSecurityExport || null
  const latestAccountSecurityExportId = latestAccountSecurityExport?.metadata?.exportAuditId || ''
  const latestAccountSecurityExportRisk = latestAccountSecurityExport?.metadata?.riskSummary || {}
  const latestAccountSecurityExportRoleSummary = Array.isArray(latestAccountSecurityExportRisk.roleSummary)
    ? latestAccountSecurityExportRisk.roleSummary
    : []
  const latestAccountSecurityExportRoleText = latestAccountSecurityExportRoleSummary.length
    ? latestAccountSecurityExportRoleSummary.map(item => `${item.role || '-'} ${item.enabled || 0}/${item.total || 0}`).join('、')
    : ''
  const latestAccountSecurityExportPermissionSnapshot = Array.isArray(latestAccountSecurityExportRisk.rolePermissionSnapshot)
    ? latestAccountSecurityExportRisk.rolePermissionSnapshot
    : []
  const latestAccountSecurityExportPermissionText = latestAccountSecurityExportPermissionSnapshot.length
    ? latestAccountSecurityExportPermissionSnapshot.map(item => `${item.role || '-'} ${item.permissionText || (Array.isArray(item.permissions) ? item.permissions.join('/') : '无权限')}`).join('、')
    : ''
  const latestAccountSecurityBulk = logSummary?.latestAccountSecurityBulk || null
  const latestAccountSecurityBulkId = latestAccountSecurityBulk?.metadata?.auditId || ''
  const latestAccountSecurityBulkNeedsNotice = latestAccountSecurityBulk
    ? String(latestAccountSecurityBulk.action || '').includes('改密') ||
      Number(latestAccountSecurityBulk.metadata?.skippedAlreadyRequiredCount || 0) > 0
    : false
  const latestAccountSecurityNotice = logSummary?.latestAccountSecurityNotice || null
  const latestAccountSecurityNoticeId = latestAccountSecurityNotice?.metadata?.auditId || ''

  const exportFilteredLogs = async () => {
    setError('')
    setMessage('')
    try {
      const token = localStorage.getItem('token')
      const query = new URLSearchParams(searchParams)
      const res = await fetch(`/api/logs/export?${query.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      })
      if (!res.ok) throw new Error(`导出失败 (${res.status})`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filenameFromContentDisposition(res.headers.get('content-disposition')) || `日志中心-${Date.now()}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      setMessage(actionGroupFilter === '上线确认'
        ? '上线确认 CSV 已导出，文件名已标识账号风险和角色快照。'
        : '当前筛选结果已由后端导出 CSV。')
    } catch (err) {
      setError(err.message || '日志导出失败')
    }
  }

  const exportGroupedSummary = () => {
    if (groupedSummaryRows.length === 0) {
      setError('当前筛选条件下暂无可导出的日志摘要。')
      setMessage('')
      return
    }

    const summaryHeader = ['筛选摘要', currentFilterSummary]
    const countHeader = ['命中日志数', String(filtered.length)]
    const proposalHeader = ['命中方案数', String(groupedSummaryRows.filter(item => item.proposalId).length)]
    const blankRow = ['']
    const summaryColumns = [
      ['方案名称', item => item.proposalTitle],
      ['方案ID', item => item.proposalId || '未绑定方案'],
      ['提交人', item => item.submitter || ''],
      ['方案类型', item => item.proposalType || ''],
      ['留痕总数', item => item.total],
      ['执行动作', item => item.executionCount],
      ['审核动作', item => item.reviewCount],
      ['系统配置', item => item.configCount, canManageSystem],
      ['账号安全', item => item.accountSecurityCount, canViewSecurityLogs],
      ['账号锁定', item => item.accountSecurityLockedCount, canViewSecurityLogs],
      ['账号拦截', item => item.accountSecurityInterceptCount, canViewSecurityLogs],
      ['账号拒绝', item => item.accountSecurityRejectedCount, canViewSecurityLogs],
      ['批量操作', item => item.bulkOperationCount],
      ['人工复核', item => item.manualReviewCount],
      ['签发归档', item => item.signOffArchiveCount],
      ['催办', item => item.reminderCount],
      ['导出', item => item.exportCount],
      ['AI调用', item => item.aiTraceCount],
      ['Hermes配置', item => item.hermesConfigCount, canManageSystem],
      ['前端异常', item => item.frontEndErrorCount],
      ['最近动作人', item => item.latestActor || ''],
      ['最近动作时间', item => item.latestAt || '']
    ].filter(([, , visible = true]) => visible)
    const header = summaryColumns.map(([label]) => label)
    const rows = groupedSummaryRows.map(item => summaryColumns.map(([, getter]) => getter(item)))
    const csv = [summaryHeader, countHeader, proposalHeader, blankRow, header, ...rows]
      .map(row => row.map(csvCell).join(','))
      .join('\n')

    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${proposalScopeIds.length > 0 ? '日志联查摘要' : '日志筛选摘要'}-${Date.now()}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    setMessage(proposalScopeIds.length > 0 ? '当前联查摘要已导出 CSV。' : '当前筛选摘要已导出 CSV。')
    setError('')
  }

  const copyFilterSummary = async () => {
    const content = [
      '日志中心筛选视图',
      `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      `链接：${window.location.href}`,
      currentFilterSummary,
      `当前加载：${logs.length} 条`,
      `后端命中：${logTotal} 条`
    ].join('\n')
    try {
      await copyText(content)
      setMessage('当前筛选链接和摘要已复制。')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: '日志中心筛选链接和摘要',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const clearProposalScope = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('proposalId')
      next.delete('proposalIds')
      return next
    })
  }

  const applySecurityFilter = (result = '') => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('type', '账号安全')
      next.delete('actionGroup')
      next.delete('proposalId')
      next.delete('proposalIds')
      if (result) next.set('result', result)
      else next.delete('result')
      return next
    })
  }

  const applyAdminPasswordDeniedFilter = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('type', '账号安全')
      next.set('result', '拒绝')
      next.set('q', '管理员账号修改密码被拒绝')
      next.delete('actionGroup')
      next.delete('proposalId')
      next.delete('proposalIds')
      return next
    })
  }

  const applyAdminForcePasswordChangeDeniedFilter = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('type', '账号安全')
      next.set('result', '拒绝')
      next.set('q', '下次登录改密被拒绝')
      next.delete('actionGroup')
      next.delete('proposalId')
      next.delete('proposalIds')
      return next
    })
  }

  const applyAdminDefaultPasswordDeniedFilter = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('type', '账号安全')
      next.set('result', '拒绝')
      next.set('q', '默认密码')
      next.delete('actionGroup')
      next.delete('proposalId')
      next.delete('proposalIds')
      return next
    })
  }

  const applyRolePermissionFilter = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('type', '系统配置')
      next.set('q', '角色权限矩阵')
      next.delete('actionGroup')
      next.delete('proposalId')
      next.delete('proposalIds')
      return next
    })
  }

  const applySystemConfigChangeFilter = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('type', '系统配置')
      next.set('q', '配置')
      next.delete('actionGroup')
      next.delete('proposalId')
      next.delete('proposalIds')
      return next
    })
  }

  const copyRolePermissionChange = async (item) => {
    const content = rolePermissionChangeText(item)
    if (!content) return
    try {
      await copyText(content)
      setMessage('权限变更摘要已复制。')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: '权限变更摘要',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const copyClientError = async (item) => {
    const content = clientErrorText(item)
    if (!content) return
    try {
      await copyText(content)
      setMessage('前端异常详情已复制。')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: '前端异常详情',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const copyExportEvent = async (item) => {
    const content = exportEventText(item)
    if (!content) return
    try {
      await copyText(content)
      setMessage('导出留痕详情已复制。')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: '导出留痕详情',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const copyHermesConfig = async (item) => {
    const content = hermesConfigText(item)
    if (!content) return
    try {
      await copyText(content)
      setMessage('Hermes 配置日志详情已复制。')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: 'Hermes 配置日志详情',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const copyAccountSecurity = async (item) => {
    const content = accountSecurityText(item)
    if (!content) return
    try {
      await copyText(content)
      setMessage('账号安全日志详情已复制。')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: '账号安全日志详情',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const copyLaunchApproval = async (item) => {
    const content = launchApprovalText(item, launchApprovalFreshHours)
    if (!content) return
    try {
      await copyText(content)
      setMessage('上线确认记录已复制。')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: '上线确认记录',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const copyNetworkDiagnostics = async (item) => {
    const content = networkDiagnosticsText(item)
    if (!content) return
    try {
      await copyText(content)
      setMessage('公网诊断记录已复制。')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: '公网诊断记录',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const copyAiTrace = async (item) => {
    const content = aiTraceText(item)
    if (!content) return
    try {
      await copyText(content)
      setMessage('AI 调用记录已复制。')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: 'AI 调用记录',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const copyBulkOperation = async (item) => {
    const content = bulkOperationText(item)
    if (!content) return
    try {
      await copyText(content)
      setMessage('批量操作记录已复制。')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: '批量操作记录',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const copyLatestRolePermissionChange = async () => {
    if (!latestRolePermissionChangeCopyable) {
      setError('最近权限变更缺少可复制明细')
      setMessage('')
      return
    }
    await copyRolePermissionChange(logSummary.latestRolePermissionChange)
  }

  const testClientErrorReport = async () => {
    setTestingClientError(true)
    setError('')
    setMessage('')
    try {
      const ok = await reportClientErrorForTest()
      if (!ok) throw new Error('前端异常测试日志发送失败')
      const next = new URLSearchParams(searchParams)
      next.set('type', '执行动作')
      next.set('actionGroup', '前端异常')
      next.set('result', '失败')
      next.delete('proposalId')
      next.delete('proposalIds')
      const previousFilter = searchParams.toString()
      const nextFilter = next.toString()
      setSearchParams(next)
      if (nextFilter === previousFilter) {
        await reloadLogs(next)
      }
      setMessage('前端异常测试日志已写入，已刷新当前筛选。')
    } catch (err) {
      setError(err.message || '前端异常测试日志发送失败')
    } finally {
      setTestingClientError(false)
    }
  }

  return (
    <div className="space-y-4">
      <Panel className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h1 className="text-xl font-bold text-blue-200 flex items-center gap-2">
              <ListChecks size={21} />
              日志中心
            </h1>
              <p className="text-sm text-slate-400 mt-1">记录账号维护、方案提交、重新审核、状态更新和规则配置操作。</p>
              {logTotal > logs.length && (
                <p className="text-xs text-amber-300 mt-1">当前加载最近 {logs.length} 条，后端导出会覆盖符合筛选条件的全部 {logTotal} 条日志。</p>
              )}
            </div>
          <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
            <div className="flex items-center gap-2 px-4 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-slate-400 w-full md:w-72">
              <Search size={16} />
              <input
                value={keyword}
                onChange={e => syncSearchParam('q', e.target.value)}
                aria-label={`搜索日志，当前筛选：${currentFilterSummary}`}
                title={`搜索日志，当前筛选：${currentFilterSummary}`}
                className="bg-transparent outline-none text-sm text-white placeholder-slate-500 flex-1"
                placeholder="搜索日志..."
              />
            </div>
            <button
              type="button"
              onClick={copyFilterSummary}
              title={`复制当前日志筛选链接和摘要：${currentFilterSummary}`}
              aria-label={`复制当前日志筛选链接和摘要：${currentFilterSummary}`}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-400/30 bg-blue-500/10 text-blue-100 text-sm"
            >
              <Copy size={15} />
              复制链接
            </button>
            <button
              type="button"
              onClick={exportFilteredLogs}
              title={`导出当前筛选日志 CSV，当前已加载 ${logs.length} 条，后端命中 ${logTotal} 条，${currentFilterSummary}`}
              aria-label={`导出当前筛选日志 CSV，当前已加载 ${logs.length} 条，后端命中 ${logTotal} 条，${currentFilterSummary}`}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 text-emerald-100 text-sm"
            >
              <Download size={15} />
              导出 CSV
            </button>
            <button
              type="button"
              onClick={exportGroupedSummary}
              title={`导出当前日志筛选摘要，${currentFilterSummary}`}
              aria-label={`导出当前日志筛选摘要，${currentFilterSummary}`}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-violet-400/30 bg-violet-500/10 text-violet-100 text-sm"
            >
              <Download size={15} />
              导出摘要
            </button>
            {canManageSystem && (
              <>
                <button
                  type="button"
                  onClick={testClientErrorReport}
                  disabled={testingClientError}
                  title={testingClientError ? '正在写入前端异常测试日志' : '写入一条前端异常测试日志并刷新当前筛选'}
                  aria-label={testingClientError ? '正在写入前端异常测试日志' : '写入一条前端异常测试日志并刷新当前筛选'}
                  className="inline-flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100 disabled:opacity-50"
                >
                  {testingClientError ? '测试中' : '测试前端异常'}
                </button>
                <div className="flex items-center gap-2 rounded-lg border border-red-400/25 bg-red-500/10 px-2 py-1.5">
                  <input
                    type="number"
                    min="30"
                    max="3650"
                    value={retentionDays}
                    onChange={e => setRetentionDays(e.target.value)}
                    aria-label={`旧日志清理保留天数，当前 ${retentionDays} 天`}
                    title={`旧日志清理保留天数，当前 ${retentionDays} 天`}
                    className="w-20 rounded-md border border-red-400/20 bg-slate-950/70 px-2 py-1 text-sm text-red-100 outline-none focus:border-red-300/60"
                  />
                  <button
                    type="button"
                    onClick={pruneLogs}
                    disabled={pruning}
                    title={`${pruning ? '正在清理' : '清理'} ${retentionDays} 天前的审计日志，需要输入“清理旧日志”确认`}
                    aria-label={`${pruning ? '正在清理' : '清理'} ${retentionDays} 天前的审计日志，需要输入“清理旧日志”确认`}
                    className="inline-flex items-center gap-1 text-sm text-red-100 disabled:opacity-50"
                  >
                    <Trash2 size={15} />
                    {pruning ? '清理中' : '清理旧日志'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {logSummary && (
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-11 gap-3 mb-4">
            {[
              ['命中日志', logSummary.total, 'text-blue-100'],
              ['账号安全', logSummary.accountSecurityCount, 'text-amber-200'],
              ['失败登录', logSummary.failureCount, 'text-red-200'],
              ['锁定', logSummary.lockedOnlyCount, 'text-yellow-200'],
              ['拦截', logSummary.interceptCount, 'text-orange-200'],
              ['拒绝', logSummary.rejectedCount, 'text-red-200'],
              ['系统配置', logSummary.systemConfigCount, 'text-violet-200'],
              ['权限变更', logSummary.rolePermissionChangeCount, 'text-fuchsia-200'],
              ['批量操作', logSummary.bulkOperationCount, 'text-cyan-200'],
              ['导出留痕', logSummary.exportEventCount, 'text-cyan-200'],
              ['来源 IP', logSummary.uniqueIpCount, 'text-cyan-200']
            ].filter(([label]) => {
              if (['账号安全', '失败登录', '锁定', '拦截', '拒绝'].includes(label)) return canViewSecurityLogs
              if (['系统配置', '权限变更'].includes(label)) return canManageSystem
              return true
            }).map(([label, value, color]) => (
              <button
                key={label}
              type="button"
              onClick={label === '权限变更'
                ? applyRolePermissionFilter
                : label === '批量操作'
                  ? () => applyBulkOperationFilter()
                  : label === '导出留痕'
                    ? () => syncSearchParam('actionGroup', '导出')
                  : label === '系统配置'
                    ? () => syncSearchParam('type', '系统配置')
                  : label === '账号安全'
                    ? () => applySecurityFilter()
                  : label === '失败登录'
                    ? () => applySecurityFilter('失败')
                  : ['锁定', '拦截', '拒绝'].includes(label)
                    ? () => applySecurityFilter(label)
                    : undefined}
                className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-3 text-left transition hover:border-blue-300/40"
              >
                <div className="text-xs text-slate-500">{label}</div>
                <div className={`mt-2 text-lg font-semibold ${color}`}>{value ?? 0}</div>
              </button>
            ))}
            {(logSummary.latestFailureAt || logSummary.latestFailureActor) && (
              <button
                type="button"
                onClick={() => {
                  setSearchParams(prev => {
                    const next = new URLSearchParams(prev)
                    next.set('type', '账号安全')
                    if (logSummary.latestFailureResult) next.set('result', logSummary.latestFailureResult)
                    if (logSummary.latestFailureAction) next.set('q', logSummary.latestFailureAction)
                    next.delete('actionGroup')
                    next.delete('proposalId')
                    next.delete('proposalIds')
                    return next
                  })
                }}
                className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-3 text-left transition hover:border-red-300/45 md:col-span-3 xl:col-span-6"
              >
                <div className="text-xs text-red-200">最近异常</div>
                <div className="mt-1 text-sm text-red-100">
                  {logSummary.latestFailureResult || '异常'} · {logSummary.latestFailureActor || '未知账号'} · {logSummary.latestFailureAt || '时间未记录'}
                </div>
                {logSummary.latestFailureAction && (
                  <div className="mt-1 line-clamp-1 text-xs text-red-100/75">{logSummary.latestFailureAction}</div>
                )}
              </button>
            )}
            {(logSummary.latestRolePermissionChangeAt || logSummary.latestRolePermissionChangeActor) && (
              <div className="rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/10 px-3 py-3 md:col-span-3 xl:col-span-7">
                <div className="text-xs text-fuchsia-200">最近权限变更</div>
                <div className="mt-1 text-sm text-fuchsia-100">
                  {logSummary.latestRolePermissionChangeActor || '未知账号'} · {logSummary.latestRolePermissionChangeAt || '时间未记录'}
                </div>
                {logSummary.latestRolePermissionChangeAction && (
                  <div className="mt-1 text-xs text-fuchsia-200/80">{logSummary.latestRolePermissionChangeAction}</div>
                )}
                {!latestRolePermissionChangeCopyable && (
                  <div className="mt-2 text-xs text-amber-200">该日志缺少角色权限变更明细，仅支持查看原始日志。</div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={applyRolePermissionFilter} className="rounded-lg border border-fuchsia-300/30 px-3 py-1.5 text-xs text-fuchsia-100 hover:border-fuchsia-200/60">
                    查看日志
                  </button>
                  <button type="button" onClick={copyLatestRolePermissionChange} disabled={!latestRolePermissionChangeCopyable} className="rounded-lg border border-fuchsia-300/30 px-3 py-1.5 text-xs text-fuchsia-100 hover:border-fuchsia-200/60 disabled:opacity-50">
                    {latestRolePermissionChangeCopyable ? '复制最近变更' : '无可复制明细'}
                  </button>
                </div>
              </div>
            )}
            {(logSummary.latestExportEventAt || logSummary.latestExportEventActor) && (
              <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-3 py-3 md:col-span-3 xl:col-span-7">
                <div className="text-xs text-cyan-200">最近导出留痕</div>
                <div className="mt-1 text-sm text-cyan-100">
                  {logSummary.latestExportEventActor || '未知账号'} · {logSummary.latestExportEventAt || '时间未记录'}
                </div>
                {logSummary.latestExportEventAction && (
                  <div className="mt-1 text-xs text-cyan-200/80">{logSummary.latestExportEventAction}</div>
                )}
                {!latestExportEventCopyable && (
                  <div className="mt-2 text-xs text-amber-200">该日志缺少导出留痕明细，仅支持查看原始日志。</div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => syncSearchParam('actionGroup', '导出')} className="rounded-lg border border-cyan-300/30 px-3 py-1.5 text-xs text-cyan-100 hover:border-cyan-200/60">
                    查看日志
                  </button>
                  <button type="button" onClick={() => copyExportEvent(logSummary.latestExportEvent)} disabled={!latestExportEventCopyable} className="rounded-lg border border-cyan-300/30 px-3 py-1.5 text-xs text-cyan-100 hover:border-cyan-200/60 disabled:opacity-50">
                    {latestExportEventCopyable ? '复制最近导出' : '无可复制明细'}
                  </button>
                </div>
              </div>
            )}
            {(logSummary.latestAccountSecurityExportAt || logSummary.latestAccountSecurityExportActor) && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-3 md:col-span-3 xl:col-span-7">
                <div className="text-xs text-amber-200">最近账号清单导出</div>
                <div className="mt-1 text-sm text-amber-100">
                  {logSummary.latestAccountSecurityExportActor || '未知账号'} · {logSummary.latestAccountSecurityExportAt || '时间未记录'}
                </div>
                {logSummary.latestAccountSecurityExportAction && (
                  <div className="mt-1 text-xs text-amber-200/80">{logSummary.latestAccountSecurityExportAction}</div>
                )}
                {latestAccountSecurityExportId && (
                  <div className="mt-1 break-all text-xs text-amber-100/80">批次：{latestAccountSecurityExportId}</div>
                )}
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5 text-amber-100">导出 {latestAccountSecurityExport?.metadata?.count ?? 0}</span>
                  <span className="rounded border border-red-300/20 bg-red-500/10 px-2 py-0.5 text-red-100">默认密码 {latestAccountSecurityExportRisk.defaultPasswordCount ?? 0}</span>
                  <span className="rounded border border-amber-300/20 bg-amber-500/10 px-2 py-0.5 text-amber-100">需改密 {latestAccountSecurityExportRisk.mustChangePasswordCount ?? 0}</span>
                  <span className="rounded border border-orange-300/20 bg-orange-500/10 px-2 py-0.5 text-orange-100">锁定 {latestAccountSecurityExportRisk.loginLockedCount ?? 0}</span>
                  {latestAccountSecurityExportRoleText && (
                    <span className="rounded border border-cyan-300/20 bg-cyan-500/10 px-2 py-0.5 text-cyan-100">角色 {latestAccountSecurityExportRoleText}</span>
                  )}
                  {latestAccountSecurityExportPermissionText && (
                    <span className="rounded border border-blue-300/20 bg-blue-500/10 px-2 py-0.5 text-blue-100">权限矩阵 {latestAccountSecurityExportPermissionText}</span>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (latestAccountSecurityExportId) {
                        setSearchParams(prev => {
                          const next = new URLSearchParams(prev)
                          next.set('type', '账号安全')
                          next.set('q', latestAccountSecurityExportId)
                          next.delete('actionGroup')
                          next.delete('proposalId')
                          next.delete('proposalIds')
                          return next
                        })
                      } else {
                        syncSearchParam('type', '账号安全')
                      }
                    }}
                    className="rounded-lg border border-amber-300/30 px-3 py-1.5 text-xs text-amber-100 hover:border-amber-200/60"
                  >
                    {latestAccountSecurityExportId ? '查看本批' : '查看账号安全日志'}
                  </button>
                  <button
                    type="button"
                    onClick={() => copyAccountSecurity(latestAccountSecurityExport)}
                    disabled={!latestAccountSecurityExport}
                    className="rounded-lg border border-amber-300/30 px-3 py-1.5 text-xs text-amber-100 hover:border-amber-200/60 disabled:opacity-50"
                  >
                    复制导出摘要
                  </button>
                  {(latestAccountSecurityExportRisk.defaultPasswordCount || 0) > 0 && (
                    <button
                      type="button"
                      onClick={() => navigate('/users?password=默认密码&select=visible')}
                      className="rounded-lg border border-red-300/30 px-3 py-1.5 text-xs text-red-100 hover:border-red-200/60"
                    >
                      处理 {latestAccountSecurityExportRisk.defaultPasswordCount || 0} 个默认密码
                    </button>
                  )}
                  {(latestAccountSecurityExportRisk.mustChangePasswordCount || 0) > 0 && (
                    <button
                      type="button"
                      onClick={() => navigate('/users?password=需改密&select=visible')}
                      className="rounded-lg border border-amber-300/30 px-3 py-1.5 text-xs text-amber-100 hover:border-amber-200/60"
                    >
                      处理 {latestAccountSecurityExportRisk.mustChangePasswordCount || 0} 个需改密
                    </button>
                  )}
                  {(latestAccountSecurityExportRisk.loginLockedCount || 0) > 0 && (
                    <button
                      type="button"
                      onClick={() => navigate('/users?security=登录锁定&select=visible')}
                      className="rounded-lg border border-orange-300/30 px-3 py-1.5 text-xs text-orange-100 hover:border-orange-200/60"
                    >
                      处理 {latestAccountSecurityExportRisk.loginLockedCount || 0} 个登录锁定
                    </button>
                  )}
                </div>
              </div>
            )}
            {(logSummary.latestAccountSecurityBulkAt || logSummary.latestAccountSecurityBulkActor) && (
              <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-3 py-3 md:col-span-3 xl:col-span-7">
                <div className="text-xs text-cyan-200">最近账号批量处理</div>
                <div className="mt-1 text-sm text-cyan-100">
                  {logSummary.latestAccountSecurityBulkActor || '未知账号'} · {logSummary.latestAccountSecurityBulkAt || '时间未记录'}
                </div>
                {logSummary.latestAccountSecurityBulkAction && (
                  <div className="mt-1 text-xs text-cyan-200/80">{logSummary.latestAccountSecurityBulkAction}</div>
                )}
                {latestAccountSecurityBulkId && (
                  <div className="mt-1 break-all text-xs text-cyan-100/80">批次：{latestAccountSecurityBulkId}</div>
                )}
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5 text-cyan-100">请求 {latestAccountSecurityBulk?.metadata?.requestedCount ?? 0}</span>
                  <span className="rounded border border-emerald-300/20 bg-emerald-500/10 px-2 py-0.5 text-emerald-100">更新 {latestAccountSecurityBulk?.metadata?.changedCount ?? 0}</span>
                  <span className="rounded border border-amber-300/20 bg-amber-500/10 px-2 py-0.5 text-amber-100">跳过 {latestAccountSecurityBulk?.metadata?.skippedCount ?? 0}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (latestAccountSecurityBulkId) {
                        setSearchParams(prev => {
                          const next = new URLSearchParams(prev)
                          next.set('type', '账号安全')
                          next.set('q', latestAccountSecurityBulkId)
                          next.delete('actionGroup')
                          next.delete('proposalId')
                          next.delete('proposalIds')
                          return next
                        })
                      } else {
                        syncSearchParam('type', '账号安全')
                      }
                    }}
                    className="rounded-lg border border-cyan-300/30 px-3 py-1.5 text-xs text-cyan-100 hover:border-cyan-200/60"
                  >
                    {latestAccountSecurityBulkId ? '查看本批' : '查看账号安全日志'}
                  </button>
                  <button
                    type="button"
                    onClick={() => copyAccountSecurity(latestAccountSecurityBulk)}
                    disabled={!latestAccountSecurityBulk}
                    className="rounded-lg border border-cyan-300/30 px-3 py-1.5 text-xs text-cyan-100 hover:border-cyan-200/60 disabled:opacity-50"
                  >
                    复制批量摘要
                  </button>
                  {canManageUsers && latestAccountSecurityBulkNeedsNotice && (
                    <button
                      type="button"
                      onClick={() => navigate('/users?password=需改密&select=visible')}
                      className="rounded-lg border border-amber-300/30 bg-slate-950/20 px-3 py-1.5 text-xs text-amber-100 hover:border-amber-200/60"
                    >
                      准备改密通知文案（未发送）
                    </button>
                  )}
                </div>
              </div>
            )}
            {(logSummary.latestAccountSecurityNoticeAt || logSummary.latestAccountSecurityNoticeActor) && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-3 md:col-span-3 xl:col-span-7">
                <div className="text-xs text-amber-200">最近改密通知文案</div>
                <div className="mt-1 text-sm text-amber-100">
                  {logSummary.latestAccountSecurityNoticeActor || '未知账号'} · {logSummary.latestAccountSecurityNoticeAt || '时间未记录'}
                </div>
                {logSummary.latestAccountSecurityNoticeAction && (
                  <div className="mt-1 text-xs text-amber-200/80">{logSummary.latestAccountSecurityNoticeAction}</div>
                )}
                {latestAccountSecurityNoticeId && (
                  <div className="mt-1 break-all text-xs text-amber-100/80">编号：{latestAccountSecurityNoticeId}</div>
                )}
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5 text-amber-100">涉及 {latestAccountSecurityNotice?.metadata?.affectedAccountCount ?? latestAccountSecurityNotice?.metadata?.noticeCount ?? 0}</span>
                  <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5 text-amber-100">未发送</span>
                  <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5 text-amber-100">{latestAccountSecurityNotice?.metadata?.noticeChannel || '复制通知文案'}</span>
                  <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5 text-amber-100">跳过 {latestAccountSecurityNotice?.metadata?.skippedCount ?? 0}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (latestAccountSecurityNoticeId) {
                        setSearchParams(prev => {
                          const next = new URLSearchParams(prev)
                          next.set('type', '账号安全')
                          next.set('q', latestAccountSecurityNoticeId)
                          next.delete('actionGroup')
                          next.delete('proposalId')
                          next.delete('proposalIds')
                          return next
                        })
                      } else {
                        syncSearchParam('type', '账号安全')
                      }
                    }}
                    className="rounded-lg border border-amber-300/30 px-3 py-1.5 text-xs text-amber-100 hover:border-amber-200/60"
                  >
                    {latestAccountSecurityNoticeId ? '查看本次文案留痕' : '查看账号安全日志'}
                  </button>
                  <button
                    type="button"
                    onClick={() => copyAccountSecurity(latestAccountSecurityNotice)}
                    disabled={!latestAccountSecurityNotice}
                    className="rounded-lg border border-amber-300/30 px-3 py-1.5 text-xs text-amber-100 hover:border-amber-200/60 disabled:opacity-50"
                  >
                    复制文案生成摘要
                  </button>
                  {canManageUsers && Array.isArray(latestAccountSecurityNotice?.metadata?.targetUsernames) && latestAccountSecurityNotice.metadata.targetUsernames.length > 0 && (
                    <button
                      type="button"
                      onClick={() => navigate('/users?notice=latest&select=visible')}
                      className="rounded-lg border border-blue-300/30 bg-slate-950/20 px-3 py-1.5 text-xs text-blue-100 hover:border-blue-200/60"
                    >
                      查看文案涉及账号
                    </button>
                  )}
                  {canManageUsers && (
                    <button
                      type="button"
                      onClick={() => navigate('/users?password=需改密&select=visible')}
                      className="rounded-lg border border-amber-300/30 bg-slate-950/20 px-3 py-1.5 text-xs text-amber-100 hover:border-amber-200/60"
                    >
                      查看需改密账号
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-4">
          {typeOptions.map(option => (
            <button
              key={option}
              type="button"
              onClick={() => syncSearchParam('type', option)}
              className={`px-3 py-1.5 rounded-lg border text-sm transition ${
                typeFilter === option
                  ? 'border-cyan-300/60 bg-cyan-500/15 text-cyan-100'
                  : 'border-blue-500/25 bg-slate-900/60 text-slate-300 hover:border-blue-300/40'
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        {canViewSecurityLogs && (
          <div className="flex flex-wrap gap-2 mb-4">
            {canManageSystem && (
              <>
                <button
                  type="button"
                  onClick={applyRolePermissionFilter}
                  className={`px-3 py-1.5 rounded-lg border text-sm transition ${
                    typeFilter === '系统配置' && keyword.trim() === '角色权限矩阵'
                      ? 'border-fuchsia-300/60 bg-fuchsia-500/15 text-fuchsia-100'
                      : 'border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-200 hover:border-fuchsia-300/40'
                  }`}
                >
                  权限变更
                </button>
                <button
                  type="button"
                  onClick={applySystemConfigChangeFilter}
                  className={`px-3 py-1.5 rounded-lg border text-sm transition ${
                    typeFilter === '系统配置' && keyword.trim() === '配置'
                      ? 'border-violet-300/60 bg-violet-500/15 text-violet-100'
                      : 'border-violet-500/25 bg-violet-500/10 text-violet-200 hover:border-violet-300/40'
                  }`}
                >
                  配置变更
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => applySecurityFilter()}
              className={`px-3 py-1.5 rounded-lg border text-sm transition ${
                typeFilter === '账号安全' && resultFilter === '全部'
                  ? 'border-amber-300/60 bg-amber-500/15 text-amber-100'
                  : 'border-amber-500/25 bg-amber-500/10 text-amber-200 hover:border-amber-300/40'
              }`}
            >
              账号安全
            </button>
            {['失败', '锁定', '拦截', '拒绝'].map(result => (
              <button
                key={result}
                type="button"
                onClick={() => applySecurityFilter(result)}
                className={`px-3 py-1.5 rounded-lg border text-sm transition ${
                  typeFilter === '账号安全' && resultFilter === result
                    ? 'border-red-300/60 bg-red-500/15 text-red-100'
                    : 'border-red-500/25 bg-red-500/10 text-red-200 hover:border-red-300/40'
                }`}
              >
                {result === '拒绝' ? '权限拒绝' : result}
              </button>
            ))}
            <button
              type="button"
              onClick={applyAdminPasswordDeniedFilter}
              className={`px-3 py-1.5 rounded-lg border text-sm transition ${
                typeFilter === '账号安全' && resultFilter === '拒绝' && keyword.trim() === '管理员账号修改密码被拒绝'
                  ? 'border-orange-300/60 bg-orange-500/15 text-orange-100'
                  : 'border-orange-500/25 bg-orange-500/10 text-orange-200 hover:border-orange-300/40'
              }`}
            >
              管理员改密拒绝
            </button>
            <button
              type="button"
              onClick={applyAdminForcePasswordChangeDeniedFilter}
              className={`px-3 py-1.5 rounded-lg border text-sm transition ${
                typeFilter === '账号安全' && resultFilter === '拒绝' && keyword.trim() === '下次登录改密被拒绝'
                  ? 'border-amber-300/60 bg-amber-500/15 text-amber-100'
                  : 'border-amber-500/25 bg-amber-500/10 text-amber-200 hover:border-amber-300/40'
              }`}
            >
              管理员强制改密拒绝
            </button>
            <button
              type="button"
              onClick={applyAdminDefaultPasswordDeniedFilter}
              className={`px-3 py-1.5 rounded-lg border text-sm transition ${
                typeFilter === '账号安全' && resultFilter === '拒绝' && keyword.trim() === '默认密码'
                  ? 'border-rose-300/60 bg-rose-500/15 text-rose-100'
                  : 'border-rose-500/25 bg-rose-500/10 text-rose-200 hover:border-rose-300/40'
              }`}
            >
              管理员默认密码拒绝
            </button>
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-4">
          {visibleActionGroupOptions.map(option => (
            <button
              key={option}
              type="button"
              onClick={() => syncSearchParam('actionGroup', option)}
              className={`px-3 py-1.5 rounded-lg border text-sm transition ${
                actionGroupFilter === option
                  ? 'border-emerald-300/60 bg-emerald-500/15 text-emerald-100'
                  : 'border-blue-500/25 bg-slate-900/60 text-slate-300 hover:border-blue-300/40'
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-8 gap-3 mb-4">
          <label className="block" htmlFor={actorFilterId}>
            <span className="text-xs text-slate-400">操作人</span>
            <select
              id={actorFilterId}
              value={actorFilter}
              onChange={e => syncSearchParam('actor', e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
            >
              {actorOptions.map(actor => (
                <option key={actor} value={actor}>{actor}</option>
              ))}
            </select>
          </label>
          <label className="block" htmlFor={rangeFilterId}>
            <span className="text-xs text-slate-400">时间范围</span>
            <select
              id={rangeFilterId}
              value={rangeFilter}
              onChange={e => syncSearchParam('range', e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
            >
              {logRangeOptions.map(range => (
                <option key={range} value={range}>{range}</option>
              ))}
            </select>
          </label>
          <label className="block" htmlFor={resultFilterId}>
            <span className="text-xs text-slate-400">执行结果</span>
            <select
              id={resultFilterId}
              value={resultFilter}
              onChange={e => syncSearchParam('result', e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
            >
              {resultOptions.map(result => (
                <option key={result} value={result}>{result}</option>
              ))}
            </select>
          </label>
          <label className="block" htmlFor={ipFilterId}>
            <span className="text-xs text-slate-400">来源 IP</span>
            <select
              id={ipFilterId}
              value={ipFilter}
              onChange={e => syncSearchParam('ip', e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
            >
              {ipOptions.map(ip => (
                <option key={ip} value={ip}>{ip}</option>
              ))}
            </select>
          </label>
          <label className="block" htmlFor={submitterFilterId}>
            <span className="text-xs text-slate-400">提交人</span>
            <select
              id={submitterFilterId}
              value={submitterFilter}
              onChange={e => syncSearchParam('submitter', e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
            >
              {submitterOptions.map(item => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </label>
          <label className="block" htmlFor={proposalTypeFilterId}>
            <span className="text-xs text-slate-400">方案类型</span>
            <select
              id={proposalTypeFilterId}
              value={proposalTypeFilter}
              onChange={e => syncSearchParam('proposalType', e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
            >
              {proposalTypeOptions.map(item => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </label>
          <label className="block" htmlFor={proposalIdFilterId}>
            <span className="text-xs text-slate-400">方案</span>
            <select
              id={proposalIdFilterId}
              value={proposalScopeIds.length > 1 ? '' : proposalIdFilter}
              onChange={e => syncSearchParam('proposalId', e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
            >
              <option value="">全部</option>
              {proposalOptions.map(item => (
                <option key={item.id} value={item.id}>{item.title}</option>
              ))}
            </select>
          </label>
          <label className="block" htmlFor={exportSourceFilterId}>
            <span className="text-xs text-slate-400">导出来源</span>
            <select
              id={exportSourceFilterId}
              value={exportSourceFilter}
              onChange={e => syncSearchParam('exportSource', e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
            >
              {['全部', '详情页', '提交结果', '审核中心', '未标注'].map(source => (
                <option key={source} value={source}>{source}</option>
              ))}
            </select>
          </label>
        </div>

        {proposalExecutionSummary && (
          <div className="mb-4 rounded-lg border border-cyan-400/20 bg-slate-900/60 px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs text-slate-500">{proposalExecutionSummary.selectedProposalCount > 1 ? '当前筛选方案执行留痕' : '当前方案执行留痕'}</div>
                <div className="mt-1 text-sm font-medium text-cyan-100">{proposalExecutionSummary.title}</div>
                {proposalExecutionSummary.submitterNames?.length > 0 && (
                  <div className="mt-1 text-xs text-slate-500">
                    提交人：{proposalExecutionSummary.submitterNames.join('、')}
                  </div>
                )}
                {proposalExecutionSummary.selectedProposalCount !== proposalExecutionSummary.matchedProposalCount && (
                  <div className="mt-1 text-xs text-slate-500">
                    {proposalExecutionSummary.matchedProposalCount > 0
                      ? `筛选后命中 ${proposalExecutionSummary.matchedProposalCount} 个方案`
                      : '筛选后暂无留痕'}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                {proposalExecutionSummary.proposalCount === 1 && proposalScopeIds[0] && (
                  <button
                    type="button"
                    onClick={() => navigate(`/review/${proposalScopeIds[0]}`)}
                    className="text-xs text-cyan-300 hover:text-cyan-200"
                  >
                    返回方案详情
                  </button>
                )}
                <button
                  type="button"
                  onClick={clearProposalScope}
                  className="text-xs text-slate-400 hover:text-slate-300"
                >
                  清除方案范围
                </button>
              </div>
            </div>
            {proposalExecutionSummary.proposals.length > 1 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {proposalExecutionSummary.proposals.slice(0, 6).map(item => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(`/review/${item.id}`)}
                    className="px-2 py-1 rounded border border-blue-500/20 bg-slate-950/45 text-xs text-slate-300 hover:border-blue-300/40"
                  >
                    {item.title}
                  </button>
                ))}
                {proposalExecutionSummary.proposals.length > 6 && (
                  <span className="px-2 py-1 text-xs text-slate-500">还有 {proposalExecutionSummary.proposals.length - 6} 个方案</span>
                )}
              </div>
            )}
            <div className="mt-3 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
              <div className="rounded-lg border border-blue-500/15 bg-slate-950/45 px-3 py-3">
                <div className="text-xs text-slate-500">留痕总数</div>
                <div className="mt-2 text-lg font-semibold text-blue-100">{proposalExecutionSummary.total}</div>
              </div>
              <div className="rounded-lg border border-cyan-500/15 bg-slate-950/45 px-3 py-3">
                <div className="text-xs text-slate-500">执行动作</div>
                <div className="mt-2 text-lg font-semibold text-cyan-200">{proposalExecutionSummary.executionCount}</div>
              </div>
              <div className="rounded-lg border border-blue-500/15 bg-slate-950/45 px-3 py-3">
                <div className="text-xs text-slate-500">审核动作</div>
                <div className="mt-2 text-lg font-semibold text-blue-200">{proposalExecutionSummary.reviewCount}</div>
              </div>
              {canManageSystem && (
                <div className="rounded-lg border border-violet-500/15 bg-slate-950/45 px-3 py-3">
                  <div className="text-xs text-slate-500">系统配置</div>
                  <div className="mt-2 text-lg font-semibold text-violet-200">{proposalExecutionSummary.configCount}</div>
                </div>
              )}
              {canViewSecurityLogs && (
                <div className="rounded-lg border border-amber-500/15 bg-slate-950/45 px-3 py-3">
                  <div className="text-xs text-slate-500">账号安全</div>
                  <div className="mt-2 text-lg font-semibold text-amber-200">{proposalExecutionSummary.accountSecurityCount}</div>
                  <div className="mt-1 text-[11px] text-slate-500">
                    锁定 {proposalExecutionSummary.accountSecurityLockedCount} · 拦截 {proposalExecutionSummary.accountSecurityInterceptCount} · 拒绝 {proposalExecutionSummary.accountSecurityRejectedCount}
                  </div>
                </div>
              )}
              {proposalExecutionSummary.bulkOperationCount > 0 && (
                <div className="rounded-lg border border-cyan-500/15 bg-slate-950/45 px-3 py-3">
                  <div className="text-xs text-slate-500">批量操作</div>
                  <div className="mt-2 text-lg font-semibold text-cyan-200">{proposalExecutionSummary.bulkOperationCount}</div>
                </div>
              )}
              <div className="rounded-lg border border-slate-500/15 bg-slate-950/45 px-3 py-3">
                <div className="text-xs text-slate-500">最近动作</div>
                <div className="mt-2 text-xs font-medium text-slate-300">{proposalExecutionSummary.latestActor || '未记录'}</div>
                <div className="mt-1 text-[11px] text-slate-500">{proposalExecutionSummary.latestAt || '-'}</div>
              </div>
              {proposalExecutionSummary.actionGroupCounts.find(item => item.label === '前端异常')?.count > 0 && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-3">
                  <div className="text-xs text-red-200/80">前端异常</div>
                  <div className="mt-2 text-lg font-semibold text-red-100">
                    {proposalExecutionSummary.actionGroupCounts.find(item => item.label === '前端异常')?.count || 0}
                  </div>
                </div>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {proposalExecutionSummary.actionGroupCounts
                .filter(item => item.count > 0)
                .map(item => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => syncSearchParam('actionGroup', item.label)}
                    className={`px-3 py-1.5 rounded-lg border text-xs transition ${
                      actionGroupFilter === item.label
                        ? 'border-emerald-300/60 bg-emerald-500/15 text-emerald-100'
                        : 'border-slate-500/30 bg-slate-950/45 text-slate-300 hover:border-emerald-300/40'
                    }`}
                  >
                    {item.label} {item.count}
                  </button>
                ))}
            </div>
          </div>
        )}

        {exportAuditKeyword && (
          <div className="mb-4 rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
            正在查看账号安全清单导出批次：<span className="font-mono">{exportAuditKeyword}</span>
          </div>
        )}
        {bulkAuditKeyword && (
          <div className="mb-4 rounded-lg border border-cyan-400/25 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
            正在查看账号批量处理批次：<span className="font-mono">{bulkAuditKeyword}</span>
          </div>
        )}

        {(effectiveTypeFilter !== '全部' || effectiveActionGroupFilter !== '全部' || actorFilter !== '全部' || ipFilter !== '全部' || resultFilter !== '全部' || rangeFilter !== '全部' || exportSourceFilter !== '全部' || submitterFilter !== '全部' || proposalTypeFilter !== '全部' || proposalScopeIds.length > 0 || keyword.trim()) && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-3">
            <div className="text-sm text-slate-300">
              当前筛选：
              {effectiveTypeFilter !== '全部' ? ` 类型“${effectiveTypeFilter}”` : ' 全部类型'}
              {effectiveActionGroupFilter !== '全部' ? `，动作分组“${effectiveActionGroupFilter}”` : ''}
              {actorFilter !== '全部' ? `，操作人“${actorFilter}”` : ''}
              {ipFilter !== '全部' ? `，来源 IP“${ipFilter}”` : ''}
              {resultFilter !== '全部' ? `，结果“${resultFilter}”` : ''}
              {rangeFilter !== '全部' ? `，范围“${rangeFilter}”` : ''}
              {exportSourceFilter !== '全部' ? `，导出来源“${exportSourceFilter}”` : ''}
              {submitterFilter !== '全部' ? `，提交人“${submitterFilter}”` : ''}
              {proposalTypeFilter !== '全部' ? `，方案类型“${proposalTypeFilter}”` : ''}
              {proposalScopeIds.length === 1 ? `，方案“${proposalOptions.find(item => item.id === proposalScopeIds[0])?.title || proposalScopeIds[0]}”` : ''}
              {proposalScopeIds.length > 1 ? `，联查 ${proposalScopeIds.length} 个方案` : ''}
              {keyword.trim() ? `，关键词“${keyword.trim()}”` : ''}
            </div>
            <button
              type="button"
              onClick={() => setSearchParams(new URLSearchParams())}
              title={`清除当前日志筛选：${currentFilterSummary}`}
              aria-label={`清除当前日志筛选：${currentFilterSummary}`}
              className="text-xs text-blue-300 hover:text-blue-200"
            >
              清除筛选
            </button>
          </div>
        )}

        {message && <div role="status" aria-live="polite" className="mb-4 text-sm text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">{message}</div>}
        {error && <div role="alert" className="mb-4 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>}
        {actionGroupFilter === 'AI调用' && (
          <div className="mb-4 rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            当前为 AI 调用日志视图；“导出 CSV”会包含 AI调用摘要列，可用于追踪 Hermes 调用、外部 AI 失败和本地兜底原因。
          </div>
        )}
        {canManageSystem && actionGroupFilter === 'Hermes配置' && (
          <div className="mb-4 rounded-lg border border-violet-400/20 bg-violet-500/10 px-3 py-2 text-sm text-violet-100">
            当前为 Hermes 配置日志视图；“导出 CSV”会包含 Hermes配置摘要列，“导出摘要”会统计 Hermes配置次数。
          </div>
        )}
        {canManageSystem && actionGroupFilter === '上线确认' && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
            <div>
              当前为上线确认日志视图；“导出 CSV”会包含上线确认摘要、上线账号风险和上线角色快照列，适合上线留档归档。
              <span className="ml-2 text-emerald-100/70">超过阈值的记录会标记为建议重新确认。</span>
            </div>
            <label className="inline-flex items-center gap-2 text-xs text-emerald-100/80" htmlFor={launchApprovalFreshHoursId}>
              有效阈值
              <input
                id={launchApprovalFreshHoursId}
                type="number"
                min="1"
                max="168"
                value={launchApprovalFreshHours}
                onChange={event => updateLaunchApprovalFreshHours(event.target.value)}
                title={`上线确认有效阈值，当前 ${launchApprovalFreshHours} 小时`}
                aria-label={`上线确认有效阈值，当前 ${launchApprovalFreshHours} 小时，超过阈值的上线确认记录会标记为建议重新确认`}
                className="w-20 rounded-md border border-emerald-300/20 bg-slate-950/40 px-2 py-1 text-emerald-50 outline-none focus:border-emerald-200/60"
              />
              小时
            </label>
          </div>
        )}
        {actionGroupFilter === '导出' && (
          <div className="mb-4 rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-100">
            当前为导出留痕视图；“导出 CSV”会包含导出类型、入口来源、构建标识和导出事件 ID。
          </div>
        )}
        {canManageSystem && actionGroupFilter === '公网诊断' && (
          <div className="mb-4 rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-100">
            当前为公网诊断日志视图；“导出 CSV”会包含公网诊断摘要列，可用于核对域名解析、预期公网 IP 和实际解析 IP。
          </div>
        )}
        {typeFilter === '账号安全' && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            <div>当前为账号安全日志视图；“导出 CSV”会包含账号安全摘要列，可用于留档批量改密、停用、解锁和跳过原因。</div>
            <button
              type="button"
              onClick={() => navigate('/stats?focus=security')}
              title="查看账号安全分析，包含默认密码、需改密、登录锁定和批量账号安全操作"
              aria-label="查看账号安全分析，包含默认密码、需改密、登录锁定和批量账号安全操作"
              className="rounded-lg border border-amber-300/30 bg-slate-950/25 px-2.5 py-1 text-xs text-amber-100 hover:border-amber-200/60"
            >
              查看安全分析
            </button>
          </div>
        )}
        {canManageSystem && typeFilter === '系统配置' && keyword.trim() === '配置' && (
          <div className="mb-4 rounded-lg border border-violet-400/20 bg-violet-500/10 px-3 py-2 text-sm text-violet-100">
            当前为配置变更追溯视图；“导出 CSV”会包含配置变更摘要列，可用于核对规则、自动催办、系统运行和权限配置调整。
          </div>
        )}
        {(actionGroupFilter === '批量操作' || keyword.trim().includes('批量')) && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-100">
            <div>当前为批量操作追溯视图；“导出 CSV”会包含批量操作摘要列，可用于留档批量状态更新和批量删除结果。</div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => applyBulkOperationFilter('批量更新方案状态')}
                title={`筛选批量状态更新日志，当前筛选：${currentFilterSummary}`}
                aria-label={`筛选批量状态更新日志，当前筛选：${currentFilterSummary}`}
                className="rounded-lg border border-cyan-300/30 bg-slate-950/25 px-2.5 py-1 text-xs text-cyan-100 hover:border-cyan-200/60"
              >
                状态更新
              </button>
              <button
                type="button"
                onClick={() => applyBulkOperationFilter('批量删除方案')}
                title={`筛选批量删除方案日志，当前筛选：${currentFilterSummary}`}
                aria-label={`筛选批量删除方案日志，当前筛选：${currentFilterSummary}`}
                className="rounded-lg border border-rose-300/30 bg-rose-500/10 px-2.5 py-1 text-xs text-rose-100 hover:border-rose-200/60"
              >
                批量删除
              </button>
              <button
                type="button"
                onClick={() => applyBulkOperationFilter('批量自动催办', '催办')}
                title={`筛选批量自动催办日志，当前筛选：${currentFilterSummary}`}
                aria-label={`筛选批量自动催办日志，当前筛选：${currentFilterSummary}`}
                className="rounded-lg border border-violet-300/30 bg-violet-500/10 px-2.5 py-1 text-xs text-violet-100 hover:border-violet-200/60"
              >
                批量催办
              </button>
              <button
                type="button"
                onClick={() => applyBulkOperationFilter('批量重新发起 AI 审核', 'AI调用')}
                title={`筛选批量重新发起 AI 审核日志，当前筛选：${currentFilterSummary}`}
                aria-label={`筛选批量重新发起 AI 审核日志，当前筛选：${currentFilterSummary}`}
                className="rounded-lg border border-emerald-300/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-100 hover:border-emerald-200/60"
              >
                AI重审
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 text-slate-400">加载中...</div>
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-10 text-center">
            <div className="text-sm font-medium text-slate-300">当前条件下暂无日志</div>
            <div className="mt-2 text-xs text-slate-500">
              {canManageSystem
                ? '可以清除筛选查看全部留痕，或进入设置页生成上线确认、网络诊断、备份快照等系统日志。'
                : '可以清除筛选查看当前权限范围内的全部留痕，或调整类型、动作分组和关键词重新查询。'}
            </div>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={() => setSearchParams(new URLSearchParams())}
                title={`清除当前日志筛选：${currentFilterSummary}`}
                aria-label={`清除当前日志筛选：${currentFilterSummary}`}
                className="rounded-lg border border-blue-400/30 bg-blue-500/10 px-3 py-2 text-sm text-blue-100 hover:border-blue-300/60"
              >
                清除筛选
              </button>
              {canManageSystem && (
                <button
                  type="button"
                  onClick={() => navigate('/settings')}
                  className="rounded-lg border border-violet-400/30 bg-violet-500/10 px-3 py-2 text-sm text-violet-100 hover:border-violet-300/60"
                >
                  进入系统设置
                </button>
              )}
              {canSubmitProposal && (
                <button
                  type="button"
                  onClick={() => navigate('/submit')}
                  className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100 hover:border-emerald-300/60"
                >
                  提交测试方案
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              {filtered.map(item => {
                const clientError = clientErrorInfo(item)
                const exportEvent = exportEventInfo(item)
                const hermesConfig = hermesConfigInfo(item)
                const aiTrace = aiTraceInfo(item)
                const bulkOperation = bulkOperationInfo(item)
                const accountSecurity = accountSecurityInfo(item)
                const systemConfigChange = systemConfigChangeInfo(item)
                const launchApproval = launchApprovalInfo(item)
                const networkDiagnostics = networkDiagnosticsInfo(item)
                const launchApprovalConfirmedAt = item.at || launchApproval?.generatedAt || ''
                const launchApprovalExpired = launchApproval ? olderThanHours(launchApprovalConfirmedAt, launchApprovalFreshHours) : false
                return (
                <div key={item.id} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`px-2 py-1 rounded text-xs border ${
                        detectLogType(item) === '执行动作'
                          ? 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200'
                          : detectLogType(item) === '系统配置'
                            ? 'border-violet-400/30 bg-violet-500/10 text-violet-200'
                            : detectLogType(item) === '账号安全'
                              ? 'border-amber-400/30 bg-amber-500/10 text-amber-200'
                              : 'border-blue-400/30 bg-blue-500/10 text-blue-200'
                      }`}>
                        {detectLogType(item)}
                      </span>
                      {item.result && (
                        <span className={`px-2 py-1 rounded text-xs border ${resultToneClass(item.result)}`}>
                          {item.result}
                        </span>
                      )}
                      <div className="font-medium text-blue-100 truncate">{item.action}</div>
                    </div>
                    <div className="text-xs text-slate-400 mt-1">操作人：{item.actor}</div>
                    {(item.ip || item.userAgent) && (
                      <div className="mt-1 text-xs text-slate-500">
                        {item.ip ? `IP：${item.ip}` : 'IP 未记录'}
                        {item.userAgent ? ` · ${item.userAgent}` : ''}
                      </div>
                    )}
                    {extractProposalTitle(item) && (
                      <div className="mt-1 text-xs text-slate-400">
                        方案：{item.proposalId ? (
                          <button
                            type="button"
                            onClick={() => {
                              const section = detailSectionByAction(item.action)
                              navigate(`/review/${item.proposalId}${section ? `?section=${section}` : ''}`)
                            }}
                            className="text-cyan-300 hover:text-cyan-200"
                          >
                            {extractProposalTitle(item)}
                          </button>
                        ) : (
                          <span className="text-slate-300">{extractProposalTitle(item)}</span>
                        )}
                      </div>
                    )}
                    {(proposalMetaById.get(item.proposalId)?.submitter || proposalMetaById.get(item.proposalId)?.type) && (
                      <div className="mt-1 text-xs text-slate-500">
                        {proposalMetaById.get(item.proposalId)?.submitter ? `提交人：${proposalMetaById.get(item.proposalId)?.submitter}` : '提交人未标注'}
                        {proposalMetaById.get(item.proposalId)?.type ? ` · ${proposalMetaById.get(item.proposalId)?.type}` : ''}
                      </div>
                    )}
                    {String(item.action || '').includes('意见书') && (
                      <div className="mt-1">
                        <span className="px-2 py-1 rounded text-[11px] border border-emerald-400/25 bg-emerald-500/10 text-emerald-200">
                          {exportSourceText(exportSourceForLog(item))}
                        </span>
                      </div>
                    )}
                    {aiTrace && (
                      <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
                        aiTrace.fallback
                          ? 'border-amber-400/25 bg-amber-500/10 text-amber-100'
                          : aiTrace.status === 'failed' || item.result === '失败'
                            ? 'border-rose-400/25 bg-rose-500/10 text-rose-100'
                            : aiTrace.status === 'success'
                              ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100'
                              : 'border-cyan-400/20 bg-cyan-500/10 text-cyan-100'
                      }`}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-medium">AI 调用上下文</div>
                          <div className="flex flex-wrap items-center gap-2">
                            {aiTrace.fallback && canManageSystem && (
                              <button
                                type="button"
                                onClick={() => navigate('/bots?focus=hermes&from=ai-fallback')}
                                className="inline-flex items-center gap-1 opacity-80 hover:opacity-100"
                              >
                                检查 Hermes
                              </button>
                            )}
                            {item.proposalId && (
                              <button
                                type="button"
                                onClick={() => navigate(`/review/${item.proposalId}`)}
                                className="inline-flex items-center gap-1 opacity-80 hover:opacity-100"
                              >
                                查看方案
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => copyAiTrace(item)}
                              className="inline-flex items-center gap-1 opacity-80 hover:opacity-100"
                            >
                              <Copy size={13} />
                              复制记录
                            </button>
                          </div>
                        </div>
                        <div className="mt-1 opacity-80">
                          {aiTrace.provider ? `Provider：${aiTrace.provider}` : 'Provider 未记录'}
                          {aiTrace.model ? ` · 模型：${aiTrace.model}` : ''}
                          {aiTrace.modeName ? ` · 模式：${aiTrace.modeName}` : ''}
                          {aiTrace.durationMs !== null ? ` · 耗时：${aiTrace.durationMs}ms` : ''}
                        </div>
                        {(aiTrace.profileCount !== null || aiTrace.opinionCount !== null || aiTrace.result) && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {aiTrace.profileCount !== null && <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">Profile {aiTrace.profileCount}</span>}
                            {aiTrace.opinionCount !== null && <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">意见 {aiTrace.opinionCount}</span>}
                            {aiTrace.result && <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">结论 {aiTrace.result}</span>}
                          </div>
                        )}
                        {aiTrace.requestedCount !== null && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">请求 {aiTrace.requestedCount}</span>
                            <span className="rounded border border-emerald-300/20 bg-emerald-500/10 px-2 py-0.5 text-emerald-100">成功 {aiTrace.successCount ?? 0}</span>
                            <span className="rounded border border-amber-300/20 bg-amber-500/10 px-2 py-0.5 text-amber-100">回退 {aiTrace.fallbackCount ?? 0}</span>
                            <span className="rounded border border-rose-300/20 bg-rose-500/10 px-2 py-0.5 text-rose-100">失败 {aiTrace.failedCount ?? 0}</span>
                          </div>
                        )}
                        {aiTrace.error && <div className="mt-1 opacity-80">原因：{aiTrace.error}</div>}
                      </div>
                    )}
                    {bulkOperation && (
                      <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
                        bulkOperation.kind === 'bulk-delete'
                          ? 'border-rose-400/20 bg-rose-500/10 text-rose-100'
                          : 'border-cyan-400/20 bg-cyan-500/10 text-cyan-100'
                      }`}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-medium">批量操作上下文</div>
                          <button
                            type="button"
                            onClick={() => copyBulkOperation(item)}
                            className="inline-flex items-center gap-1 opacity-80 hover:opacity-100"
                          >
                            <Copy size={13} />
                            复制记录
                          </button>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {bulkOperation.requestedCount !== null && <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">请求 {bulkOperation.requestedCount}</span>}
                          {bulkOperation.updatedCount !== null && <span className="rounded border border-emerald-300/20 bg-emerald-500/10 px-2 py-0.5 text-emerald-100">更新 {bulkOperation.updatedCount}</span>}
                          {bulkOperation.removedCount !== null && <span className="rounded border border-rose-300/20 bg-rose-500/10 px-2 py-0.5 text-rose-100">删除 {bulkOperation.removedCount}</span>}
                          {bulkOperation.createdCount !== null && <span className="rounded border border-violet-300/20 bg-violet-500/10 px-2 py-0.5 text-violet-100">生成 {bulkOperation.createdCount}</span>}
                          {bulkOperation.skippedCount !== null && <span className="rounded border border-amber-300/20 bg-amber-500/10 px-2 py-0.5 text-amber-100">跳过 {bulkOperation.skippedCount}</span>}
                          {bulkOperation.successCount !== null && <span className="rounded border border-emerald-300/20 bg-emerald-500/10 px-2 py-0.5 text-emerald-100">成功 {bulkOperation.successCount}</span>}
                          {bulkOperation.fallbackCount !== null && <span className="rounded border border-amber-300/20 bg-amber-500/10 px-2 py-0.5 text-amber-100">回退 {bulkOperation.fallbackCount}</span>}
                          {bulkOperation.failedCount !== null && <span className="rounded border border-rose-300/20 bg-rose-500/10 px-2 py-0.5 text-rose-100">失败 {bulkOperation.failedCount}</span>}
                          {bulkOperation.status && <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">目标 {bulkOperation.status}</span>}
                          {bulkOperation.source && <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">来源 {bulkOperation.source === 'auto' ? '自动催办' : '人工登记'}</span>}
                        </div>
                        {bulkOperation.titles.length > 0 && (
                          <div className="mt-1 opacity-80 break-all">
                            涉及：{bulkOperation.titles.slice(0, 6).map(title => `《${title}》`).join('、')}{bulkOperation.titles.length > 6 ? ' 等' : ''}
                          </div>
                        )}
                        {bulkOperation.legacyAction && (
                          <div className="mt-1 opacity-80 break-all">原始动作：{bulkOperation.legacyAction}</div>
                        )}
                        {bulkOperation.skippedItems.length > 0 && (
                          <div className="mt-1 text-amber-100/80 break-all">
                            跳过：{bulkOperation.skippedItems.slice(0, 5).map(entry => `《${entry.title || entry.id}》(${entry.reason || '未记录原因'})`).join('、')}{bulkOperation.skippedItems.length > 5 ? ' 等' : ''}
                          </div>
                        )}
                      </div>
                    )}
                    {clientError && (
                      <div className="mt-3 rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-100">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-medium">前端异常上下文</div>
                          <button
                            type="button"
                            onClick={() => copyClientError(item)}
                            className="inline-flex items-center gap-1 text-red-100/80 hover:text-red-50"
                          >
                            <Copy size={13} />
                            复制详情
                          </button>
                        </div>
                        <div className="mt-1 text-red-100/80">
                          类型：{clientError.type}
                          {clientError.appVersion ? ` · 版本：${clientError.appVersion}` : ''}
                          {clientError.appBuildLabel ? ` · 构建：${clientError.appBuildLabel}` : ''}
                          {clientError.route ? ` · 路由：${clientError.route}` : ''}
                        </div>
                        {clientError.source && (
                          <div className="mt-1 text-red-100/70 break-all">来源：{clientError.source}</div>
                        )}
                      </div>
                    )}
                    {exportEvent && (
                      <div className="mt-3 rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-medium">导出留痕上下文</div>
                          <button
                            type="button"
                            onClick={() => copyExportEvent(item)}
                            className="inline-flex items-center gap-1 text-cyan-100/80 hover:text-cyan-50"
                          >
                            <Copy size={13} />
                            复制详情
                          </button>
                        </div>
                        <div className="mt-1 text-cyan-100/80">
                          类型：{exportEvent.typeText}
                          {exportEvent.sourceText ? ` · 来源：${exportEvent.sourceText}` : ''}
                          {exportEvent.appVersion ? ` · 版本：${exportEvent.appVersion}` : ''}
                          {exportEvent.appBuildLabel ? ` · 构建：${exportEvent.appBuildLabel}` : ''}
                        </div>
                        {(exportEvent.proposalTitle || exportEvent.proposalId || exportEvent.exportEventId) && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {exportEvent.proposalTitle && <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">方案《{exportEvent.proposalTitle}》</span>}
                            {exportEvent.proposalId && <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">ID {exportEvent.proposalId}</span>}
                            {exportEvent.exportEventId && <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">事件 {exportEvent.exportEventId}</span>}
                          </div>
                        )}
                      </div>
                    )}
                    {systemConfigChange && (
                      <div className="mt-3 rounded-lg border border-violet-400/20 bg-violet-500/10 px-3 py-2 text-xs text-violet-100">
                        <div className="font-medium">配置变更上下文</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">{systemConfigChange.label}</span>
                          {systemConfigChange.changeCount !== null && (
                            <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">变更 {systemConfigChange.changeCount} 项</span>
                          )}
                          {systemConfigChange.ruleName && (
                            <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">规则《{systemConfigChange.ruleName}》</span>
                          )}
                          {systemConfigChange.ruleCategory && (
                            <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">类别 {systemConfigChange.ruleCategory}</span>
                          )}
                          {systemConfigChange.ruleStatus && (
                            <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">状态 {systemConfigChange.ruleStatus}</span>
                          )}
                        </div>
                        {systemConfigChange.changes.length > 0 && (
                          <div className="mt-2 space-y-1 opacity-90">
                            {systemConfigChange.changes.slice(0, 6).map(change => (
                              <div key={`${change.field}-${change.label}`} className="break-all">
                                {change.label || change.field}: {String(change.before ?? '')} -&gt; {String(change.after ?? '')}
                              </div>
                            ))}
                            {systemConfigChange.changes.length > 6 && (
                              <div className="opacity-75">其余 {systemConfigChange.changes.length - 6} 项变更已收起，可导出 CSV 查看完整摘要。</div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {accountSecurity && (
                      <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-medium">账号安全上下文</div>
                          <button
                            type="button"
                            onClick={() => copyAccountSecurity(item)}
                            className="inline-flex items-center gap-1 text-amber-100/80 hover:text-amber-50"
                          >
                            <Copy size={13} />
                            复制详情
                          </button>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <span className={`rounded border px-2 py-0.5 ${
                            item.result === '成功'
                              ? 'border-emerald-300/20 bg-emerald-500/10 text-emerald-100'
                              : item.result === '锁定'
                                ? 'border-yellow-300/20 bg-yellow-500/10 text-yellow-100'
                                : item.result === '拦截'
                                  ? 'border-orange-300/20 bg-orange-500/10 text-orange-100'
                                  : item.result === '拒绝'
                                    ? 'border-red-300/20 bg-red-500/10 text-red-100'
                                    : 'border-white/10 bg-slate-950/25 text-amber-100'
                          }`}>
                            结果 {item.result || '未记录'}
                          </span>
                        </div>
                        {(accountSecurity.targetUsername || accountSecurity.targetRole || accountSecurity.role || accountSecurity.status) && (
                          <div className="mt-1 text-amber-100/80">
                            {accountSecurity.targetUsername ? `目标账号：${accountSecurity.targetUsername}` : ''}
                            {accountSecurity.targetRole ? `${accountSecurity.targetUsername ? ' · ' : ''}目标角色：${accountSecurity.targetRole}` : ''}
                            {accountSecurity.role ? `${accountSecurity.targetUsername || accountSecurity.targetRole ? ' · ' : ''}当前角色：${accountSecurity.role}` : ''}
                            {accountSecurity.status ? ` · 状态：${accountSecurity.status}` : ''}
                          </div>
                        )}
                        {accountSecurity.reason && (
                          <div className="mt-1 text-amber-50/90">原因：{accountSecurity.reason}</div>
                        )}
                        {accountSecurity.auditId && (
                          <div className="mt-1 break-all text-amber-100/80">批量批次：{accountSecurity.auditId}</div>
                        )}
                        {accountSecurity.exportAuditId && (
                          <div className="mt-1 break-all text-amber-100/80">导出批次：{accountSecurity.exportAuditId}</div>
                        )}
                        {accountSecurity.requestedCount !== null && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">请求 {accountSecurity.requestedCount}</span>
                            {accountSecurity.noticeCount !== null ? <span className="rounded border border-amber-300/20 bg-amber-500/10 px-2 py-0.5 text-amber-100">文案涉及 {accountSecurity.noticeCount}，未发送</span> : null}
                            {accountSecurity.noticeChannel ? <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">{accountSecurity.noticeChannel}</span> : null}
                            <span className="rounded border border-emerald-300/20 bg-emerald-500/10 px-2 py-0.5 text-emerald-100">更新 {accountSecurity.changedCount ?? 0}</span>
                            <span className="rounded border border-amber-300/20 bg-amber-500/10 px-2 py-0.5 text-amber-100">跳过 {accountSecurity.skippedCount ?? 0}</span>
                            {accountSecurity.skippedAdminCount ? <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">管理员 {accountSecurity.skippedAdminCount}</span> : null}
                            {accountSecurity.skippedAlreadyRequiredCount ? <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">已需改密 {accountSecurity.skippedAlreadyRequiredCount}</span> : null}
                            {accountSecurity.skippedAlreadyDisabledCount ? <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">已停用 {accountSecurity.skippedAlreadyDisabledCount}</span> : null}
                            {accountSecurity.skippedUnlockedCount ? <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">未锁定 {accountSecurity.skippedUnlockedCount}</span> : null}
                          </div>
                        )}
                        {accountSecurity.defaultPasswordCount !== null && (
                          <div className="mt-2 space-y-2">
                            <div className="flex flex-wrap gap-2">
                              <span className="rounded border border-red-300/20 bg-red-500/10 px-2 py-0.5 text-red-100">默认密码 {accountSecurity.defaultPasswordCount}</span>
                              <span className="rounded border border-amber-300/20 bg-amber-500/10 px-2 py-0.5 text-amber-100">需改密 {accountSecurity.mustChangePasswordCount ?? 0}</span>
                              <span className="rounded border border-orange-300/20 bg-orange-500/10 px-2 py-0.5 text-orange-100">登录锁定 {accountSecurity.loginLockedCount ?? 0}</span>
                              <span className="rounded border border-rose-300/20 bg-rose-500/10 px-2 py-0.5 text-rose-100">长期未登录 {accountSecurity.inactiveLoginCount ?? 0}</span>
                            </div>
                            {accountSecurity.roleSummary.length > 0 && (
                              <div className="flex flex-wrap gap-2">
                                {accountSecurity.roleSummary.map(item => (
                                  <span key={item.role} className="rounded border border-blue-300/20 bg-blue-500/10 px-2 py-0.5 text-blue-100">
                                    {item.role || '-'} {item.enabled || 0}/{item.total || 0}
                                  </span>
                                ))}
                              </div>
                            )}
                            {accountSecurity.rolePermissionSnapshot.length > 0 && (
                              <div className="rounded border border-cyan-300/20 bg-cyan-500/10 px-2 py-1.5 text-cyan-100">
                                <div className="font-medium">角色权限矩阵快照</div>
                                <div className="mt-1 flex flex-wrap gap-1.5">
                                  {accountSecurity.rolePermissionSnapshot.map(item => (
                                    <span key={item.role} className="rounded border border-cyan-200/20 bg-slate-950/30 px-2 py-0.5">
                                      {item.role || '-'}：{item.permissionText || (Array.isArray(item.permissions) ? item.permissions.join('/') : '无权限')}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                            <div className="flex flex-wrap gap-2">
                              {(accountSecurity.defaultPasswordCount || 0) > 0 && (
                                <button
                                  type="button"
                                  onClick={() => navigate('/users?password=默认密码&select=visible')}
                                  className="rounded border border-red-300/30 px-2 py-1 text-[11px] text-red-100 hover:border-red-200/60"
                                >
                                  处理 {accountSecurity.defaultPasswordCount} 个默认密码
                                </button>
                              )}
                              {(accountSecurity.mustChangePasswordCount || 0) > 0 && (
                                <button
                                  type="button"
                                  onClick={() => navigate('/users?password=需改密&select=visible')}
                                  className="rounded border border-amber-300/30 px-2 py-1 text-[11px] text-amber-100 hover:border-amber-200/60"
                                >
                                  处理 {accountSecurity.mustChangePasswordCount} 个需改密
                                </button>
                              )}
                              {(accountSecurity.loginLockedCount || 0) > 0 && (
                                <button
                                  type="button"
                                  onClick={() => navigate('/users?security=登录锁定&select=visible')}
                                  className="rounded border border-orange-300/30 px-2 py-1 text-[11px] text-orange-100 hover:border-orange-200/60"
                                >
                                  处理 {accountSecurity.loginLockedCount} 个登录锁定
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                        {accountSecurity.defaultPasswordLogUrl && (
                          <div className="mt-1 break-all text-amber-100/70">默认密码拒绝日志：{accountSecurity.defaultPasswordLogUrl}</div>
                        )}
                        {accountSecurity.targetNames.length > 0 && (
                          <div className="mt-1 text-amber-100/70 break-all">涉及姓名：{accountSecurity.targetNames.join('、')}</div>
                        )}
                        {accountSecurity.targetUsernames.length > 0 && (
                          <div className="mt-1 text-amber-100/70 break-all">{accountSecurity.noticeCount !== null ? '文案涉及账号' : '更新账号'}：{accountSecurity.targetUsernames.join('、')}</div>
                        )}
                        {accountSecurity.skippedUsernames.length > 0 && (
                          <div className="mt-1 text-amber-100/70 break-all">跳过账号：{accountSecurity.skippedUsernames.join('、')}</div>
                        )}
                      </div>
                    )}
                    {hermesConfig && (
                      <div className="mt-3 rounded-lg border border-violet-400/20 bg-violet-500/10 px-3 py-2 text-xs text-violet-100">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-medium">Hermes 配置上下文</div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => navigate('/bots?focus=hermes')}
                              className="inline-flex items-center gap-1 text-violet-100/80 hover:text-violet-50"
                            >
                              查看机器人配置
                            </button>
                            <button
                              type="button"
                              onClick={() => copyHermesConfig(item)}
                              className="inline-flex items-center gap-1 text-violet-100/80 hover:text-violet-50"
                            >
                              <Copy size={13} />
                              复制详情
                            </button>
                          </div>
                        </div>
                        <div className="mt-1 text-violet-100/80">
                          {hermesConfig.provider ? `Provider：${hermesConfig.provider}` : 'Provider 未记录'}
                          {hermesConfig.model ? ` · 模型：${hermesConfig.model}` : ''}
                          {hermesConfig.checkedAt ? ` · 检查：${hermesConfig.checkedAt}` : ''}
                        </div>
                        {(hermesConfig.webCount !== null || hermesConfig.remoteCount !== null || hermesConfig.matchedCount !== null || hermesConfig.missingCount !== null || hermesConfig.driftCount !== null) && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {hermesConfig.webCount !== null && <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">网页 {hermesConfig.webCount}</span>}
                            {hermesConfig.remoteCount !== null && <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-0.5">云端 {hermesConfig.remoteCount}</span>}
                            {hermesConfig.matchedCount !== null && <span className="rounded border border-emerald-300/20 bg-emerald-500/10 px-2 py-0.5 text-emerald-100">匹配 {hermesConfig.matchedCount}</span>}
                            {hermesConfig.missingCount !== null && <span className="rounded border border-amber-300/20 bg-amber-500/10 px-2 py-0.5 text-amber-100">缺失 {hermesConfig.missingCount}</span>}
                            {hermesConfig.driftCount !== null && <span className="rounded border border-orange-300/20 bg-orange-500/10 px-2 py-0.5 text-orange-100">差异 {hermesConfig.driftCount}</span>}
                          </div>
                        )}
                        {(hermesConfig.changedProfileCount !== null || hermesConfig.profileCount !== null) && (
                          <div className="mt-1 text-violet-100/75">
                            {hermesConfig.changedProfileCount !== null ? `变化专业：${hermesConfig.changedProfileCount} 个` : ''}
                            {hermesConfig.profileCount !== null ? `${hermesConfig.changedProfileCount !== null ? ' · ' : ''}Profile：${hermesConfig.profileCount} 个` : ''}
                          </div>
                        )}
                        {hermesConfig.message && <div className="mt-1 text-violet-100/70">{hermesConfig.message}</div>}
                        {hermesConfig.diagnostic && (
                          <div className="mt-2 rounded-lg border border-white/10 bg-slate-950/30 px-2 py-2">
                            <div className="font-medium text-violet-100">接入排查建议</div>
                            <div className="mt-1 text-violet-100/75">{hermesConfig.diagnostic.nextAction || '请刷新 Hermes Profile 接入状态。'}</div>
                            <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                              {(hermesConfig.diagnostic.checks || []).map(check => {
                                const checkClass = check.status === '通过'
                                  ? 'border-emerald-300/20 bg-emerald-500/10 text-emerald-100'
                                  : check.status === '待确认'
                                    ? 'border-blue-300/20 bg-blue-500/10 text-blue-100'
                                    : 'border-amber-300/25 bg-amber-500/10 text-amber-100'
                                return (
                                  <div key={check.label} className={`rounded border px-2 py-1.5 ${checkClass}`}>
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="font-medium">{check.label}</span>
                                      <span className="rounded border border-white/10 bg-slate-950/35 px-1.5 py-0.5 text-[11px]">{check.status}</span>
                                    </div>
                                    <div className="mt-1 leading-relaxed text-slate-300">{check.detail}</div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {launchApproval && (
                      <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
                        launchApprovalExpired
                          ? 'border-amber-400/25 bg-amber-500/10 text-amber-100'
                          : 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100'
                      }`}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2 font-medium">
                            <span>上线确认上下文</span>
                            <span className={`rounded border px-2 py-0.5 text-[11px] ${
                              launchApprovalExpired
                                ? 'border-amber-300/25 bg-amber-500/10 text-amber-100'
                                : 'border-emerald-300/25 bg-emerald-500/10 text-emerald-100'
                            }`}>
                              {launchApprovalExpired ? '建议重新确认' : '当前有效'}
                            </span>
                            <span className="text-[11px] opacity-75">阈值 {launchApprovalFreshHours} 小时</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => copyLaunchApproval(item)}
                            className="inline-flex items-center gap-1 opacity-80 hover:opacity-100"
                          >
                            <Copy size={13} />
                            复制记录
                          </button>
                        </div>
                        <div className="mt-1 opacity-80">
                          {launchApproval.passed !== null || launchApproval.total !== null
                            ? `检查结论：${launchApproval.passed ?? 0}/${launchApproval.total ?? 0} 项通过`
                            : '检查结论未记录'}
                          {launchApproval.appVersion ? ` · 版本：${launchApproval.appVersion}` : ''}
                          {launchApproval.appBuildLabel ? ` · 构建：${launchApproval.appBuildLabel}` : ''}
                        </div>
                        <div className="mt-1 opacity-70">
                          {launchApproval.generatedAt ? `生成：${launchApproval.generatedAt}` : '生成时间未记录'}
                          {launchApproval.refreshedAt ? ` · 刷新：${launchApproval.refreshedAt}` : ''}
                          {launchApprovalConfirmedAt ? ` · ${ageText(launchApprovalConfirmedAt)}` : ''}
                        </div>
                        {launchApproval.reason && <div className="mt-1 text-amber-100">拦截原因：{launchApproval.reason}</div>}
                        {launchApproval.riskSummary.byRole.length > 0 && (
                          <div className="mt-2 rounded border border-blue-300/20 bg-blue-500/10 px-2 py-1.5 text-blue-100">
                            <div className="font-medium">角色权限快照</div>
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {launchApproval.riskSummary.byRole.map(item => (
                                <span key={item.role} className="rounded border border-blue-200/20 bg-slate-950/25 px-2 py-0.5">
                                  {item.role || '-'} {item.enabled || 0}/{item.total || 0}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {launchApproval.riskSummary.riskCount !== null && (
                          <div className="mt-2 rounded border border-red-300/20 bg-red-500/10 px-2 py-1.5 text-red-100">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-medium">账号风险尚未收口</span>
                              <div className="flex flex-wrap gap-1.5">
                                {accountRiskActions(launchApproval.riskSummary).map(action => (
                                  <button
                                    key={action.to}
                                    type="button"
                                    onClick={() => navigate(action.to)}
                                    className={`rounded border px-2 py-0.5 text-[11px] ${action.className}`}
                                  >
                                    处理{action.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              <span className="rounded border border-red-200/20 bg-slate-950/25 px-2 py-0.5">默认密码 {launchApproval.riskSummary.defaultPassword ?? 0}</span>
                              <span className="rounded border border-amber-200/20 bg-slate-950/25 px-2 py-0.5">需改密 {launchApproval.riskSummary.mustChangePassword ?? 0}</span>
                              <span className="rounded border border-orange-200/20 bg-slate-950/25 px-2 py-0.5">登录锁定 {launchApproval.riskSummary.loginLocked ?? 0}</span>
                            </div>
                            <div className="mt-2 rounded border border-white/10 bg-slate-950/25 px-2 py-1 text-[11px] text-red-100">
                              {launchApproval.riskSummary.latestPasswordNotice
                                ? `最近改密通知文案：${launchApproval.riskSummary.latestPasswordNotice.auditId || '未记录'}，涉及 ${launchApproval.riskSummary.latestPasswordNotice.affectedAccountCount ?? launchApproval.riskSummary.latestPasswordNotice.noticeCount ?? 0} 个账号，未发送，${launchApproval.riskSummary.latestPasswordNotice.actor || '未知账号'} ${launchApproval.riskSummary.latestPasswordNotice.at || '时间未记录'}`
                                : (Number(launchApproval.riskSummary.mustChangePassword) || 0) > 0
                                  ? '最近改密通知文案：尚未发现文案生成留痕'
                                  : '最近改密通知文案：当前无需生成'}
                              {Array.isArray(launchApproval.riskSummary.latestPasswordNotice?.targetNames) && launchApproval.riskSummary.latestPasswordNotice.targetNames.length > 0 && (
                                <div className="mt-1 break-all text-red-100/80">
                                  涉及姓名：{launchApproval.riskSummary.latestPasswordNotice.targetNames.slice(0, 6).join('、')}{launchApproval.riskSummary.latestPasswordNotice.targetNames.length > 6 ? ` 等 ${launchApproval.riskSummary.latestPasswordNotice.targetNames.length} 人` : ''}
                                </div>
                              )}
                              {Array.isArray(launchApproval.riskSummary.latestPasswordNotice?.targetUsernames) && launchApproval.riskSummary.latestPasswordNotice.targetUsernames.length > 0 && (
                                <div className="mt-1 break-all text-red-100/70">
                                  涉及账号：{launchApproval.riskSummary.latestPasswordNotice.targetUsernames.slice(0, 6).join('、')}{launchApproval.riskSummary.latestPasswordNotice.targetUsernames.length > 6 ? ` 等 ${launchApproval.riskSummary.latestPasswordNotice.targetUsernames.length} 个` : ''}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                        {launchApproval.items.length > 0 && (
                          <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                            {launchApproval.items.slice(0, 6).map(entry => (
                              <div key={`${entry.label}-${entry.status}`} className="rounded border border-white/10 bg-slate-950/25 px-2 py-1.5">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-medium">{entry.label}</span>
                                  <span className="rounded border border-white/10 bg-slate-950/35 px-1.5 py-0.5 text-[11px]">{entry.status || '未记录'}</span>
                                </div>
                                {entry.detail && <div className="mt-1 leading-relaxed opacity-75">{entry.detail}</div>}
                                {entry.action && <div className="mt-1 rounded border border-white/10 bg-slate-950/35 px-1.5 py-1 text-amber-100">建议：{entry.action}</div>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {networkDiagnostics && (
                      <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
                        item.result === '成功'
                          ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100'
                          : 'border-amber-400/25 bg-amber-500/10 text-amber-100'
                      }`}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-medium">公网诊断上下文</div>
                          <button
                            type="button"
                            onClick={() => copyNetworkDiagnostics(item)}
                            className="inline-flex items-center gap-1 opacity-80 hover:opacity-100"
                          >
                            <Copy size={13} />
                            复制记录
                          </button>
                        </div>
                        <div className="mt-1 opacity-80">
                          域名：{networkDiagnostics.domain || '未记录'}
                          {networkDiagnostics.expectedIp ? ` · 预期 IP：${networkDiagnostics.expectedIp}` : ''}
                        </div>
                        <div className="mt-1 opacity-75">
                          解析 IP：{networkDiagnostics.resolvedIps.length ? networkDiagnostics.resolvedIps.join('、') : '未记录'}
                        </div>
                        {networkDiagnostics.message && <div className="mt-1 opacity-70">{networkDiagnostics.message}</div>}
                      </div>
                    )}
                    {rolePermissionChangeRows(item).length > 0 && (
                      <div className="mt-3">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <div className="text-xs text-violet-200">权限变更明细</div>
                          <button
                            type="button"
                            onClick={() => copyRolePermissionChange(item)}
                            className="inline-flex items-center gap-1 text-xs text-violet-200 hover:text-violet-100"
                          >
                            <Copy size={13} />
                            复制摘要
                          </button>
                        </div>
                        <div className="grid gap-2 md:grid-cols-2">
                          {rolePermissionChangeRows(item).map(change => (
                            <div key={change.role} className="rounded-lg border border-violet-400/20 bg-violet-500/10 px-3 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-xs font-medium text-violet-100">{change.role}</div>
                                {change.enabledUsers !== null && (
                                  <div className="text-[11px] text-slate-400">启用 {change.enabledUsers} / 总计 {change.totalUsers ?? 0}</div>
                                )}
                              </div>
                              {change.added.length > 0 && <div className="mt-1 text-xs text-emerald-200">新增：{change.added.join('、')}</div>}
                              {change.removed.length > 0 && <div className="mt-1 text-xs text-red-200">移除：{change.removed.join('、')}</div>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="text-sm text-slate-400 whitespace-nowrap">{item.at}</div>
                </div>
                )
              })}
            </div>
            {hasMoreLogs && (
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  onClick={loadMoreLogs}
                  disabled={loadingMore}
                  title={`${loadingMore ? '正在加载' : '加载更多'}日志，当前已加载 ${logs.length} 条，后端共 ${logTotal} 条`}
                  aria-label={`${loadingMore ? '正在加载' : '加载更多'}日志，当前已加载 ${logs.length} 条，后端共 ${logTotal} 条`}
                  className="px-4 py-2 rounded-lg border border-blue-400/30 bg-blue-500/10 text-blue-100 text-sm disabled:opacity-50"
                >
                  {loadingMore ? '加载中...' : `加载更多（${logs.length}/${logTotal}）`}
                </button>
              </div>
            )}
          </div>
        )}
      </Panel>

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
