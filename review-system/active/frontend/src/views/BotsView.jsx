import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Bot, BookOpenCheck, BriefcaseBusiness, CheckCircle2, Cloud, Copy, Download, History, RefreshCw, Save, Search, Settings2, Sparkles, Upload } from '../lib/lucide.js'
import { api, downloadFile, getUser, uploadFile } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { uploadFormatError } from '../lib/uploadValidation'
import Panel from '../components/Panel'
import CopyFallbackDialog from '../components/CopyFallbackDialog'

function standardsToText(items = []) {
  return (items || []).join('\n')
}

function textToStandards(text = '') {
  return String(text)
    .split(/\n+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function profileSummaryText(profiles = []) {
  const currentUser = getUser()
  return [
    `Hermes Profile 配置共 ${profiles.length} 个`,
    '来源：第一服务研发小组审核系统 / 审核机器人配置',
    `生成账号：${currentUser?.name || currentUser?.username || '未知账号'}`,
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ...profiles.map(profile => [
      `${profile.code} ${profile.name}`,
      `Hermes：${profile.hermesName}`,
      `范围：${profile.scope}`,
      `审核提示：${(profile.standards || []).join('、')}`,
      `完整定义核验：${profile.definitionVerifiedAt && profile.definitionVerifiedBy ? `${profile.definitionVerifiedBy} / ${profile.definitionVerifiedAt}` : '未核验，不参与审核'}`,
      `输出：${profile.output}`,
      `状态：${profile.status}；内部运营：${profile.internalEnabled !== false ? '启用' : '停用'}；市场拓展：${profile.marketEnabled !== false ? '启用' : '停用'}${profile.canInitiate ? '；立项牵头：启用' : ''}`
    ].join('\n'))
  ].join('\n\n')
}

function profileFormChanges(profile = {}, form = null) {
  if (!profile || !form) return []
  const values = {
    name: String(form.name || '').trim(),
    hermesName: String(form.hermesName || '').trim(),
    scope: String(form.scope || '').trim(),
    output: String(form.output || '').trim(),
    standards: textToStandards(form.standardsText),
    standardsVerified: form.standardsVerified === true,
    status: form.status,
    internalEnabled: form.internalEnabled,
    marketEnabled: form.marketEnabled,
    canInitiate: profile.id === 'investment' ? form.canInitiate : false
  }
  return [
    ['name', '机器人名称'],
    ['hermesName', 'Hermes 名称'],
    ['scope', '审核范围'],
    ['output', '输出物'],
    ['standards', '审核提示'],
    ['standardsVerified', '完整 Profile 定义核验'],
    ['status', '状态'],
    ['internalEnabled', '内部运营审核'],
    ['marketEnabled', '市场拓展审核'],
    ['canInitiate', '立项牵头']
  ].filter(([field]) => JSON.stringify(values[field]) !== JSON.stringify(
    field === 'standardsVerified'
      ? profile.definitionVerified === true
      : profile[field]
  ))
    .map(([, label]) => label)
}

function hermesSyncSummaryText(sync = {}) {
  return [
    'Hermes 云端 Profile 最近同步摘要',
    '来源：第一服务研发小组审核系统 / 审核机器人配置',
    `操作人：${sync.actor || '未知账号'}`,
    `同步时间：${sync.at || '未记录'}`,
    `云端 Profile：${sync.remoteCount || 0} 个`,
    `变化专业：${sync.changedProfileCount || 0} 个`,
    ...(sync.changes || []).map(change => `${change.code} ${change.name}：${(change.changedFields || []).join('、')}`)
  ].join('\n')
}

function hermesImportSummaryText(item = {}) {
  return [
    'Hermes Profile 最近 JSON 导入摘要',
    '来源：第一服务研发小组审核系统 / 审核机器人配置',
    `操作人：${item.actor || '未知账号'}`,
    `导入时间：${item.at || '未记录'}`,
    `导入 Profile：${item.profileCount || 0} 个`,
    `变化专业：${item.changedProfileCount || 0} 个`,
    ...(item.changes || []).map(change => `${change.code} ${change.name}：${(change.changedFields || []).join('、')}`)
  ].join('\n')
}

function hermesManualEditSummaryText(item = {}) {
  return [
    'Hermes Profile 最近人工编辑摘要',
    '来源：第一服务研发小组审核系统 / 审核机器人配置',
    `操作人：${item.actor || '未知账号'}`,
    `编辑时间：${item.at || '未记录'}`,
    `专业：${item.profileCode || ''} ${item.profileName || item.profileId || '未记录'}`.trim(),
    `变化字段：${(item.changedFields || []).join('、') || '未记录'}`
  ].join('\n')
}

function hermesStatusCheckSummaryText(item = {}) {
  const healthStatus = item.health || {}
  return [
    'Hermes Profile 最近接入检查摘要',
    '来源：第一服务研发小组审核系统 / 审核机器人配置',
    `操作人：${item.actor || '未知账号'}`,
    `检查时间：${item.checkedAt || item.at || '未记录'}`,
    `检查结果：${item.result || '未记录'}`,
    `Provider：${item.provider || '-'}`,
    `模型：${item.model || '-'}`,
    `网关引擎：${healthStatus.engine || '未记录'}`,
    `Agent：${healthStatus.agentProvider || '未记录'} / ${healthStatus.agentModel || healthStatus.model || '未记录'}`,
    `Health 异常：${item.healthError || '无'}`,
    `汇总：网页 ${item.webCount || 0} 个，云端 ${item.remoteCount || 0} 个，匹配 ${item.matchedCount || 0} 个，缺失 ${item.missingCount || 0} 个，差异 ${item.driftCount || 0} 个。`,
    `未匹配专业：${(item.missingProfiles || []).join('、') || '无'}`,
    `差异专业：${(item.driftProfiles || []).join('、') || '无'}`,
    item.message ? `说明：${item.message}` : ''
  ].filter(Boolean).join('\n')
}

function hermesConfigHistoryText(items = [], context = {}) {
  return [
    `Hermes Profile 配置变更时间线，共 ${items.length} 条`,
    '来源：第一服务研发小组审核系统 / 审核机器人配置',
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ...(context.historyLimit ? [`载入范围：最近 ${context.historyCount ?? items.length}/${context.historyLimit} 条配置与审计记录`] : []),
    ...(context.loadedAt ? [`最后刷新：${new Date(context.loadedAt).toLocaleString('zh-CN', { hour12: false })}`] : []),
    ...(context.durationMs !== null && context.durationMs !== undefined ? [`刷新耗时：${context.durationMs} ms；状态：${context.statusLabel || '未判断'}`] : []),
    ...(context.filterSummary ? [`当前筛选：${context.filterSummary}`] : []),
    ...items.map(item => {
      const detail = item.type === '人工编辑'
        ? `${item.profileCode || ''} ${item.profileName || ''}：${(item.changedFields || []).join('、') || '字段未记录'}`
        : item.type === '接入检查'
          ? `结果：${item.result || '未记录'}；网页 ${item.webCount || 0} 个；云端 ${item.remoteCount || 0} 个；匹配 ${item.matchedCount || 0} 个；缺失 ${item.missingCount || 0} 个；差异 ${item.driftCount || 0} 个`
        : item.type === '同步预览'
          ? `结果：${item.result || '未记录'}；变化专业：${item.changedProfileCount || 0} 个；令牌指纹：${item.previewTokenFingerprint || '未记录'}；过期：${item.expiresAt || '未记录'}`
          : item.type === '同步拦截'
            ? `原因：${item.reason || '未记录'}；令牌指纹：${item.previewTokenFingerprint || '未记录'}`
            : item.type === '审计校验'
              ? `结果：${item.result || '未记录'}；审计日志：${configHistoryAuditLogStatus(item)}；文件：${item.filename || '未记录'}；记录：${item.verifiedCount || 0} 条；${item.reason ? `拦截原因：${item.reason}；` : ''}指纹状态：${configHistoryHashSummary(item) || '未记录'}；文件指纹：${item.expectedHash || '未记录'}；实算指纹：${item.actualHash || '未记录'}；${hermesConfigHistoryFilterText(item)}`
        : `变化专业：${item.changedProfileCount || 0} 个`
      return `${item.at || '时间未记录'} · ${item.type} · ${item.actor || '未知账号'}\n${detail}`
    })
  ].join('\n\n')
}

function hermesConfigHistoryFilterText(item = {}) {
  const profileText = item.filterProfileDisabled
    ? '专业未参与'
    : item.filterProfileActive
      ? `专业：${item.filterProfileName || item.filterProfileId || '未记录'}`
      : '全部专业'
  const keywordText = item.filterKeyword ? `；关键词：${item.filterKeyword}` : ''
  const totalText = item.filterTotalCount || item.filterTotalCount === 0 ? item.filterTotalCount : '未知'
  const historyLimitText = item.filterHistoryLimit ? `；载入范围：最近 ${item.filterHistoryLimit} 条` : ''
  const loadedAtText = item.filterLoadedAt ? `；最后刷新：${new Date(item.filterLoadedAt).toLocaleString('zh-CN', { hour12: false })}` : ''
  const durationText = item.filterLoadDurationMs != null ? `；耗时：${item.filterLoadDurationMs} ms` : ''
  const statusText = item.filterLoadStatus ? `；状态：${item.filterLoadStatus}` : ''
  const sanitizedText = item.sanitizedNumberFields?.length ? `；已修正字段：${item.sanitizedNumberFields.join('、')}` : ''
  const summaryText = item.filterSummary ? `筛选摘要：${item.filterSummary}；摘要来源：${item.filterSummarySource || (isConfigHistoryGeneratedSummary(item) ? '系统回填' : '文件自带')}；` : ''
  return `${summaryText}筛选：${item.filterType || '全部'}；${profileText}${keywordText}；命中：${item.filterMatchedCount ?? item.verifiedCount ?? 0}/${totalText} 条${historyLimitText}${loadedAtText}${durationText}${statusText}${sanitizedText}`
}

function hermesConfigHistoryItemText(item = {}) {
  return hermesConfigHistoryText([item])
}

function configHistoryFilterSummaryFromFilters(filters = {}, fallbackCount = 0) {
  const type = filters.type || '全部'
  const profileText = filters.profileFilterDisabled
    ? '专业筛选未参与'
    : filters.profileFilterActive
      ? `专业 ${filters.profileName || filters.profileId || '未记录'}`
      : ''
  return [
    `类型 ${type}`,
    profileText,
    filters.keyword ? `关键词“${filters.keyword}”` : '',
    `命中 ${filters.matchedCount ?? fallbackCount}/${filters.totalCount ?? '未知'} 条`
  ].filter(Boolean).join(' · ')
}

function configHistorySummarySource(filters = {}, generated = false) {
  return filters.summarySource || (generated ? '系统回填' : filters.summary ? '文件自带' : '系统回填')
}

function isConfigHistoryGeneratedSummary(item = {}) {
  if (item.filterSummarySource) return item.filterSummarySource === '系统回填'
  return item.filterSummaryGenerated === true
}

function configHistoryHashSummary(item = {}) {
  const expected = item.expectedHash ? `文件 ${item.expectedHash.slice(0, 12)}` : ''
  const actual = item.actualHash ? `实算 ${item.actualHash.slice(0, 12)}` : ''
  const status = item.expectedHash && item.actualHash
    ? item.hashStatus || (isConfigHistoryHashMismatch(item) ? '指纹不一致' : '指纹一致')
    : ''
  return [expected, actual, status].filter(Boolean).join(' / ')
}

function isConfigHistoryHashMismatch(item = {}) {
  if (item.hashStatus) return item.hashStatus === '指纹不一致'
  if (item.hashMismatch === true) return true
  return Boolean(item.expectedHash && item.actualHash && item.expectedHash !== item.actualHash)
}

function isConfigHistoryHashUnknown(item = {}) {
  return item.type === '审计校验' && !item.hashStatus && (!item.expectedHash || !item.actualHash)
}

function configHistoryAuditLogStatus(item = {}) {
  if (item.auditLogStatus) return item.auditLogStatus
  if (item.blockedReason || item.result === '拦截') return '已拦截'
  if (item.result) return '已记录'
  return '未记录'
}

function hasAuditVerificationCriticalRisk(stats = {}) {
  return (stats.failed || 0) > 0 || (stats.blocked || 0) > 0 || (stats.logBlocked || 0) > 0 || (stats.hashMismatch || 0) > 0
}

function hasAuditVerificationReviewRisk(stats = {}) {
  return hasAuditVerificationCriticalRisk(stats) || (stats.hashUnknown || 0) > 0 || (stats.sanitized || 0) > 0 || (stats.generatedSummary || 0) > 0
}

function auditVerificationRiskText(stats = {}) {
  if (hasAuditVerificationCriticalRisk(stats)) return '存在严重审计异常，需要立即复核'
  if (hasAuditVerificationReviewRisk(stats)) return '存在审计复核提醒，建议检查文件口径'
  return '最近审计文件校验正常'
}

function auditVerificationRiskLevel(stats = {}) {
  if (hasAuditVerificationCriticalRisk(stats)) return '严重'
  if (hasAuditVerificationReviewRisk(stats)) return '提醒'
  return '正常'
}

function auditVerificationPanelClass(stats = {}) {
  if (hasAuditVerificationCriticalRisk(stats)) return 'border-rose-400/25 bg-rose-500/10 text-rose-100'
  if (hasAuditVerificationReviewRisk(stats)) return 'border-amber-400/25 bg-amber-500/10 text-amber-100'
  return 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100'
}

function auditVerificationButtonClass(stats = {}) {
  if (hasAuditVerificationCriticalRisk(stats)) return 'border-rose-300/35 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20'
  if (hasAuditVerificationReviewRisk(stats)) return 'border-amber-300/35 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20'
  return 'border-emerald-300/35 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20'
}

function hermesConfigHistoryExportReceiptText(receipt = {}) {
  const filterSummary = receipt.filters?.summary || configHistoryFilterSummaryFromFilters(receipt.filters || {}, receipt.count ?? 0)
  return [
    'Hermes Profile 配置时间线审计导出校验',
    `文件名：${receipt.filename || '未记录'}`,
    `导出时间：${receipt.exportedAt || '未记录'}`,
    `导出账号：${receipt.exportedBy || '未知账号'}`,
    `记录数量：${receipt.count ?? 0} 条`,
    `筛选摘要：${filterSummary || '未记录'}`,
    `摘要来源：${configHistorySummarySource(receipt.filters || {})}`,
    `筛选类型：${receipt.filters?.type || '全部'}`,
    `筛选专业：${receipt.filters?.profileId || '全部'}`,
    `专业筛选状态：${receipt.filters?.profileFilterDisabled ? '未参与' : receipt.filters?.profileFilterActive ? '已参与' : '全部专业'}`,
    `专业名称：${receipt.filters?.profileName || '无'}`,
    `关键词：${receipt.filters?.keyword || '无'}`,
    `命中数量：${receipt.filters?.matchedCount ?? receipt.count ?? 0}/${receipt.filters?.totalCount ?? '未知'} 条`,
    `载入范围：最近 ${receipt.filters?.historyLimit || '未知'} 条`,
    `最后刷新：${receipt.filters?.loadedAt ? new Date(receipt.filters.loadedAt).toLocaleString('zh-CN', { hour12: false }) : '未记录'}`,
    `刷新耗时：${receipt.filters?.loadDurationMs ?? '未记录'}${receipt.filters?.loadDurationMs == null ? '' : ' ms'}`,
    `响应状态：${receipt.filters?.loadStatus || '未判断'}`,
    `已修正字段：${(receipt.sanitizedNumberFields || receipt.filters?.sanitizedNumberFields || []).join('、') || '无'}`,
    `校验算法：${receipt.contentHashAlgorithm || 'SHA-256'}`,
    `校验指纹：${receipt.contentHash || '未记录'}`
  ].join('\n')
}

function hermesConfigHistoryVerificationText(result = {}) {
  const filterSummary = result.filters?.summary || configHistoryFilterSummaryFromFilters(result.filters || {}, result.count ?? 0)
  return [
    'Hermes Profile 配置时间线审计文件校验结果',
    `文件名：${result.filename || '未记录'}`,
    `校验时间：${result.checkedAt || '未记录'}`,
    `校验结果：${result.ok ? '通过' : '不通过'}`,
    `审计日志状态：${configHistoryAuditLogStatus(result)}`,
    `拦截原因：${result.blockedReason || '无'}`,
    `记录数量：${result.count ?? 0} 条`,
    `筛选摘要：${filterSummary || '未记录'}`,
    `摘要来源：${configHistorySummarySource(result.filters || {}, result.filterSummaryGenerated)}`,
    `筛选类型：${result.filters?.type || '全部'}`,
    `专业筛选状态：${result.filters?.profileFilterDisabled ? '未参与' : result.filters?.profileFilterActive ? '已参与' : '全部专业'}`,
    `专业名称：${result.filters?.profileName || '无'}`,
    `关键词：${result.filters?.keyword || '无'}`,
    `命中数量：${result.filters?.matchedCount ?? result.count ?? 0}/${result.filters?.totalCount ?? '未知'} 条`,
    `载入范围：最近 ${result.filters?.historyLimit || '未知'} 条`,
    `最后刷新：${result.filters?.loadedAt ? new Date(result.filters.loadedAt).toLocaleString('zh-CN', { hour12: false }) : '未记录'}`,
    `刷新耗时：${result.filters?.loadDurationMs ?? '未记录'}${result.filters?.loadDurationMs == null ? '' : ' ms'}`,
    `响应状态：${result.filters?.loadStatus || '未判断'}`,
    `已修正字段：${(result.sanitizedNumberFields || result.filters?.sanitizedNumberFields || []).join('、') || '无'}`,
    `校验算法：${result.algorithm || 'SHA-256'}`,
    `指纹状态：${configHistoryHashSummary(result) || '未记录'}`,
    `文件指纹：${result.expectedHash || '未记录'}`,
    `实算指纹：${result.actualHash || '未记录'}`
  ].join('\n')
}

function hermesAuditVerificationStatsText(stats = {}) {
  const latest = stats.latest || {}
  const latestHash = configHistoryHashSummary(latest)
  return [
    'Hermes Profile 审计校验概览',
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `校验总次数：${stats.total || 0}`,
    `日志已记录：${stats.logRecorded || 0}`,
    `日志已拦截：${stats.logBlocked || 0}`,
    `通过次数：${stats.passed || 0}`,
    `失败次数：${stats.failed || 0}`,
    `校验拦截：${stats.blocked || 0}`,
    `指纹一致：${stats.hashMatched || 0}`,
    `指纹异常：${stats.hashMismatch || 0}`,
    `指纹未记录：${stats.hashUnknown || 0}`,
    `修正次数：${stats.sanitized || 0}`,
    `回填次数：${stats.generatedSummary || 0}`,
    `最近校验：${latest.result || '未记录'} · 日志 ${configHistoryAuditLogStatus(latest)} · ${latest.filename || '未记录文件'} · ${latest.at ? new Date(latest.at).toLocaleString('zh-CN', { hour12: false }) : '未记录时间'}${latestHash ? ` · ${latestHash}` : ''}`,
    `风险等级：${auditVerificationRiskLevel(stats)}`,
    `当前判断：${auditVerificationRiskText(stats)}`
  ].join('\n')
}

function downloadJsonFile(filename = 'data.json', data = {}) {
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

async function sha256Text(text = '') {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buffer)).map(value => value.toString(16).padStart(2, '0')).join('')
}

function hermesDriftSummaryText(status = {}) {
  const currentUser = getUser()
  const driftProfiles = (status.profiles || []).filter(profile => profile.drifted)
  return [
    `Hermes 云端 Profile 待同步差异，共 ${driftProfiles.length} 个专业`,
    '来源：第一服务研发小组审核系统 / 审核机器人配置',
    `生成账号：${currentUser?.name || currentUser?.username || '未知账号'}`,
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ...driftProfiles.map(profile => `${profile.code} ${profile.name}：${(profile.changedFields || []).join('、') || '字段未记录'}`)
  ].join('\n')
}

function readRecentHermesChecks() {
  try {
    const checks = JSON.parse(localStorage.getItem('recentHermesProfileChecks') || '[]')
    if (!Array.isArray(checks)) return []
    return checks
      .filter(item => item && item.at && typeof item.ok === 'boolean' && Number.isFinite(item.durationMs))
      .slice(0, 5)
  } catch {
    return []
  }
}

function readConfigHistoryRequestLimit() {
  const limit = Number(localStorage.getItem('hermesConfigHistoryLimit') || 50)
  return [12, 50, 100].includes(limit) ? limit : 50
}

function hermesCheckStats(checks = []) {
  const successCount = checks.filter(item => item.ok).length
  const totalDurationMs = checks.reduce((total, item) => total + item.durationMs, 0)
  return {
    successRate: checks.length > 0 ? Math.round(successCount / checks.length * 100) : 0,
    averageDurationMs: checks.length > 0 ? Math.round(totalDurationMs / checks.length) : 0
  }
}

function configHistoryLoadStatus(durationMs) {
  if (durationMs == null) return { level: 'pending', label: '' }
  if (durationMs > 2000) return { level: 'slow', label: '响应很慢' }
  if (durationMs > 800) return { level: 'warning', label: '响应偏慢' }
  return { level: 'healthy', label: '响应正常' }
}

function hermesHealthAssessment(status = {}, failure = {}, metrics = {}, checks = [], stale = false) {
  const summary = status.summary || {}
  const checkStats = hermesCheckStats(checks)
  if (!status || Object.keys(status).length === 0) {
    return { level: 'pending', label: '检查中', reason: '正在读取 Hermes 云端 Profile 状态。', action: '等待本次状态检查完成。' }
  }
  if (status.ok === false || failure.count > 0) {
    return { level: 'error', label: '异常', reason: `状态检查连续失败 ${failure.count || 1} 次，请立即重试并复制诊断。`, action: status.diagnostic?.nextAction || '先点击“立即重试”；如仍失败，复制状态诊断并检查 Hermes Gateway 服务、网络连接和运行配置。' }
  }
  if (stale) {
    return { level: 'warning', label: '需关注', reason: 'Hermes 状态已超过 10 分钟未更新，当前结果可能已过期。', action: '点击“刷新状态”获取最新结果；刷新完成前不要执行云端同步。' }
  }
  if (status.enabled === false) {
    return { level: 'warning', label: '需关注', reason: '当前 AI Provider 不是 Hermes，云端 Profile 未启用。', action: '进入系统设置，将 AI Provider 切换为 Hermes，并确认 Gateway 地址配置正确。' }
  }
  if ((summary.missingCount || 0) > 0) {
    return { level: 'warning', label: '需关注', reason: `存在 ${summary.missingCount} 个未匹配 Profile，请检查云端配置。`, action: '检查 Hermes 云端是否已建立完整的 8 个一级专业 Profile，并核对 Profile ID、编号和名称。' }
  }
  if ((summary.driftCount || 0) > 0) {
    return { level: 'warning', label: '需关注', reason: `存在 ${summary.driftCount} 个待同步差异，请预览后确认是否同步。`, action: '先复制待同步差异，再点击“预览云端同步”；确认变更内容无误后执行同步。' }
  }
  if ((metrics.lastDurationMs || 0) > 3000 || checkStats.averageDurationMs > 3000) {
    return { level: 'warning', label: '需关注', reason: 'Hermes 状态响应偏慢，请持续观察网络和网关负载。', action: '持续观察最近检查记录；如平均耗时仍超过 3000 ms，检查云服务器负载、Gateway 日志和网络延迟。' }
  }
  if (checks.length >= 3 && checkStats.successRate < 100) {
    return { level: 'warning', label: '需关注', reason: `近期检查成功率为 ${checkStats.successRate}%，存在偶发异常。`, action: '继续保留 5 分钟自动刷新；如再次失败，复制状态诊断并检查 Gateway 日志。' }
  }
  return { level: 'healthy', label: '健康', reason: 'Hermes Profile 匹配正常，近期状态检查稳定。', action: '保持 5 分钟自动刷新，无需人工处理。' }
}

function hermesHealthActionText(health = {}, status = {}) {
  const currentUser = getUser()
  const summary = status.summary || {}
  return [
    'Hermes 云端 Profile 处理建议',
    '来源：第一服务研发小组审核系统 / 审核机器人配置',
    `生成账号：${currentUser?.name || currentUser?.username || '未知账号'}`,
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `健康判断：${health.label || '未检查'}`,
    `判断原因：${health.reason || '暂无判断结果'}`,
    `处理建议：${health.action || '等待状态检查完成。'}`,
    `未匹配 Profile：${summary.missingCount ?? 0} 个`,
    `待同步差异：${summary.driftCount ?? 0} 个`
  ].join('\n')
}

function hermesStatusDiagnosisText(status = {}, failure = {}, checkedAt = '', metrics = {}, checks = [], stale = false) {
  const currentUser = getUser()
  const summary = status.summary || {}
  const diagnostic = status.diagnostic || {}
  const healthStatus = status.health || {}
  const checkStats = hermesCheckStats(checks)
  const health = hermesHealthAssessment(status, failure, metrics, checks, stale)
  return [
    'Hermes 云端 Profile 状态诊断',
    '来源：第一服务研发小组审核系统 / 审核机器人配置',
    `生成账号：${currentUser?.name || currentUser?.username || '未知账号'}`,
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `最近检查：${checkedAt ? new Date(checkedAt).toLocaleString('zh-CN', { hour12: false }) : '未记录'}`,
    `最近成功：${metrics.lastSuccessAt ? new Date(metrics.lastSuccessAt).toLocaleString('zh-CN', { hour12: false }) : '未记录'}`,
    `响应耗时：${metrics.lastDurationMs ?? '未记录'}${metrics.lastDurationMs == null ? '' : ' ms'}`,
    `状态：${status.ok === false ? '异常' : '正常'}`,
    `网关引擎：${healthStatus.engine || '未记录'}`,
    `Agent Provider：${healthStatus.agentProvider || '未记录'}`,
    `Agent 模型：${healthStatus.agentModel || healthStatus.model || '未记录'}`,
    `Health 异常：${status.healthError || '无'}`,
    `状态是否过期：${stale ? '是' : '否'}`,
    `健康判断：${health.label}`,
    `判断原因：${health.reason}`,
    `处理建议：${health.action}`,
    diagnostic.nextAction ? `接入排查建议：${diagnostic.nextAction}` : '',
    ...(diagnostic.checks || []).map(check => `${check.label}：${check.status}；${check.detail}`),
    `连续失败：${failure.count || 0} 次`,
    `最近失败：${failure.at ? new Date(failure.at).toLocaleString('zh-CN', { hour12: false }) : '无'}`,
    `异常信息：${failure.message || status.message || '无'}`,
    `网页 Profile：${summary.webCount ?? 0} 个`,
    `云端 Profile：${summary.remoteCount ?? 0} 个`,
    `已接入：${summary.matchedCount ?? 0} 个`,
    `未匹配：${summary.missingCount ?? 0} 个`,
    `待同步差异：${summary.driftCount ?? 0} 个`,
    '',
    `最近检查记录：${checks.length} 条`,
    `近期成功率：${checkStats.successRate}%`,
    `平均响应耗时：${checkStats.averageDurationMs} ms`,
    ...checks.map(item => `${new Date(item.at).toLocaleString('zh-CN', { hour12: false })} · ${item.ok ? '成功' : '失败'} · ${item.durationMs} ms${item.message ? ` · ${item.message}` : ''}`)
  ].join('\n')
}

export default function BotsView() {
  const navigate = useNavigate()
  const importInputRef = useRef(null)
  const auditVerifyInputRef = useRef(null)
  const hermesPanelRef = useRef(null)
  const aiFallbackAutoRefreshRef = useRef(false)
  const autoRefreshHermesInputId = useId()
  const profileNameInputId = useId()
  const profileHermesNameInputId = useId()
  const profileStatusInputId = useId()
  const profileScopeInputId = useId()
  const profileOutputInputId = useId()
  const profileStandardsInputId = useId()
  const profileStandardsVerifiedInputId = useId()
  const profileInternalEnabledInputId = useId()
  const profileMarketEnabledInputId = useId()
  const profileCanInitiateInputId = useId()
  const configHistoryKeywordInputId = useId()
  const [searchParams, setSearchParams] = useSearchParams()
  const [profiles, setProfiles] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [form, setForm] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadingHermes, setLoadingHermes] = useState(false)
  const [syncingHermes, setSyncingHermes] = useState(false)
  const [previewingHermesSync, setPreviewingHermesSync] = useState(false)
  const [hermesSyncPreview, setHermesSyncPreview] = useState(null)
  const [exportingProfiles, setExportingProfiles] = useState(false)
  const [exportingConfigHistory, setExportingConfigHistory] = useState(false)
  const [latestConfigHistoryExport, setLatestConfigHistoryExport] = useState(null)
  const [latestConfigHistoryVerification, setLatestConfigHistoryVerification] = useState(null)
  const [previewingImport, setPreviewingImport] = useState(false)
  const [importingProfiles, setImportingProfiles] = useState(false)
  const [importFile, setImportFile] = useState(null)
  const [importPreview, setImportPreview] = useState(null)
  const [hermesStatus, setHermesStatus] = useState(null)
  const [hermesStatusCheckedAt, setHermesStatusCheckedAt] = useState('')
  const [highlightHermesPanel, setHighlightHermesPanel] = useState(false)
  const [statusClock, setStatusClock] = useState(Date.now())
  const [autoRefreshHermes, setAutoRefreshHermes] = useState(() => localStorage.getItem('autoRefreshHermesProfiles') !== 'false')
  const [hermesStatusFailure, setHermesStatusFailure] = useState({ count: 0, at: '', message: '' })
  const [hermesStatusMetrics, setHermesStatusMetrics] = useState({ lastDurationMs: null, lastSuccessAt: '' })
  const [recentHermesChecks, setRecentHermesChecks] = useState(readRecentHermesChecks)
  const [latestHermesProfileSync, setLatestHermesProfileSync] = useState(null)
  const [latestHermesProfileImport, setLatestHermesProfileImport] = useState(null)
  const [latestHermesProfileManualEdit, setLatestHermesProfileManualEdit] = useState(null)
  const [latestHermesProfileStatusCheck, setLatestHermesProfileStatusCheck] = useState(null)
  const [configHistory, setConfigHistory] = useState([])
  const [refreshingConfigHistory, setRefreshingConfigHistory] = useState(false)
  const [configHistoryRequestLimit, setConfigHistoryRequestLimit] = useState(readConfigHistoryRequestLimit)
  const [configHistoryLimit, setConfigHistoryLimit] = useState(50)
  const [configHistoryLoadedAt, setConfigHistoryLoadedAt] = useState('')
  const [configHistoryLoadDurationMs, setConfigHistoryLoadDurationMs] = useState(null)
  const [configHistoryType, setConfigHistoryType] = useState('全部')
  const [configHistoryProfileId, setConfigHistoryProfileId] = useState('全部')
  const [configHistoryKeyword, setConfigHistoryKeyword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const focusSource = searchParams.get('from') || ''
  const focusedFromAiFallback = focusSource === 'ai-fallback'
  const [aiFallbackFocusActive, setAiFallbackFocusActive] = useState(false)
  const [copyFallback, setCopyFallback] = useState({ open: false, title: '', description: '', content: '' })

  const loadProfiles = async (preferredId = '', requestedHistoryLimit = configHistoryRequestLimit, options = {}) => {
    const silent = options.silent === true
    const startedAt = performance.now()
    if (!silent) setLoading(true)
    setError('')
    try {
      const data = await api.get(`/profiles?historyLimit=${requestedHistoryLimit}`)
      const nextProfiles = data.profiles || []
      setProfiles(nextProfiles)
      setLatestHermesProfileSync(data.latestHermesProfileSync || null)
      setLatestHermesProfileImport(data.latestHermesProfileImport || null)
      setLatestHermesProfileManualEdit(data.latestHermesProfileManualEdit || null)
      setLatestHermesProfileStatusCheck(data.latestHermesProfileStatusCheck || null)
      const nextConfigHistory = data.configHistory || []
      const nextConfigHistoryLimit = data.configHistoryLimit || requestedHistoryLimit
      setConfigHistory(nextConfigHistory)
      setConfigHistoryLimit(nextConfigHistoryLimit)
      setConfigHistoryLoadedAt(new Date().toISOString())
      const durationMs = Math.round(performance.now() - startedAt)
      setConfigHistoryLoadDurationMs(durationMs)
      const queryProfileId = searchParams.get('profile') || ''
      const activeId = preferredId || queryProfileId || selectedId || nextProfiles[0]?.id || ''
      setSelectedId(activeId)
      return {
        historyCount: nextConfigHistory.length,
        historyLimit: nextConfigHistoryLimit,
        durationMs
      }
    } catch (err) {
      setError(err.message || '审核机器人加载失败')
      if (!silent) setProfiles([])
      return null
    } finally {
      if (!silent) setLoading(false)
    }
  }

  const updateConfigHistoryRequestLimit = (nextLimit) => {
    const safeLimit = [12, 50, 100].includes(nextLimit) ? nextLimit : 50
    setConfigHistoryRequestLimit(safeLimit)
    localStorage.setItem('hermesConfigHistoryLimit', String(safeLimit))
    loadProfiles(selectedId, safeLimit)
  }

  const refreshConfigHistory = async () => {
    setRefreshingConfigHistory(true)
    try {
      const result = await loadProfiles(selectedId, configHistoryRequestLimit, { silent: true })
      if (!result) return
      setMessage(`Profile 配置变更时间线已刷新：最近 ${result.historyCount}/${result.historyLimit} 条，用时 ${result.durationMs} ms`)
    } finally {
      setRefreshingConfigHistory(false)
    }
  }

  const loadHermesStatus = async ({ audit = false } = {}) => {
    const startedAt = performance.now()
    setLoadingHermes(true)
    try {
      // 初载和定时刷新只读；只有用户显式点击“刷新状态”才留下服务端审计记录。
      const data = audit
        ? await api.post('/profiles/hermes-status', {})
        : await api.get('/profiles/hermes-status')
      const checkedAt = new Date().toISOString()
      const durationMs = Math.round(performance.now() - startedAt)
      setHermesStatus(data)
      setHermesSyncPreview(null)
      setHermesStatusFailure({ count: 0, at: '', message: '' })
      setHermesStatusMetrics({
        lastDurationMs: durationMs,
        lastSuccessAt: checkedAt
      })
      setRecentHermesChecks(prev => [{ at: checkedAt, ok: true, durationMs, message: '' }, ...prev].slice(0, 5))
    } catch (err) {
      const checkedAt = new Date().toISOString()
      const durationMs = Math.round(performance.now() - startedAt)
      const failureMessage = err.message || 'Hermes Profile 状态读取失败'
      setHermesStatus({
        ...(err.data || {}),
        ok: false,
        message: failureMessage,
        profiles: err.data?.profiles || [],
        summary: err.data?.summary || { webCount: profiles.length, remoteCount: 0, matchedCount: 0, missingCount: profiles.length, driftCount: 0 }
      })
      setHermesSyncPreview(null)
      setHermesStatusFailure(prev => ({
        count: prev.count + 1,
        at: checkedAt,
        message: failureMessage
      }))
      setHermesStatusMetrics(prev => ({
        ...prev,
        lastDurationMs: durationMs
      }))
      setRecentHermesChecks(prev => [{ at: checkedAt, ok: false, durationMs, message: failureMessage }, ...prev].slice(0, 5))
    } finally {
      setHermesStatusCheckedAt(new Date().toISOString())
      setLoadingHermes(false)
    }
  }

  const previewHermesSync = async () => {
    if (selectedProfileChanges.length > 0) return setError('当前 Profile 有未保存改动，请先保存或撤销后再预览同步。')
    if (!hermesStatus) return setError('Hermes Profile 状态尚未读取完成，请稍后再试。')
    if (hermesStatus.ok === false) return setError('Hermes Profile 状态异常，请先刷新状态并排查连接问题。')
    if (hermesStatus.enabled === false) return setError('当前 AI Provider 不是 Hermes，无法预览云端同步。')
    if (hermesStatusStale) return setError('Hermes Profile 状态已超过 10 分钟，请先刷新状态。')
    setPreviewingHermesSync(true)
    setHermesSyncPreview(null)
    setError('')
    setMessage('')
    try {
      const data = await api.post('/profiles/sync-hermes-preview', {})
      setHermesSyncPreview(data.preview ? {
        ...data.preview,
        previewToken: data.previewToken,
        generatedAt: data.generatedAt || new Date().toISOString(),
        expiresAt: data.expiresAt || ''
      } : null)
      setMessage('Hermes 云端同步差异已生成，请确认后覆盖网页配置。')
    } catch (err) {
      setError(err.message || 'Hermes Profile 同步预览失败')
    } finally {
      setPreviewingHermesSync(false)
    }
  }

  const syncHermesProfiles = async () => {
    if (!hermesSyncPreview) return
    if (hermesStatus?.ok === false) return setError('Hermes Profile 状态异常，请先刷新状态并重新生成同步预览。')
    if (hermesStatusStale) return setError('Hermes Profile 状态已超过 10 分钟，请先刷新状态并重新生成同步预览。')
    if (hermesSyncPreviewStale) return setError('云端同步预览已超过 10 分钟，请重新生成预览。')
    if ((hermesSyncPreview.changedProfileCount || 0) === 0) return setError('云端 Hermes Profile 与网页配置一致，无需同步。')
    const confirmText = window.prompt(`将从云端 Hermes 同步 ${hermesSyncPreview.changedProfileCount || 0} 个变化专业，网页 Profile 配置将被覆盖。\n请输入“确认同步”继续：`)?.trim()
    if (confirmText !== '确认同步') {
      setError('请输入“确认同步”后再覆盖网页 Profile 配置')
      return
    }

    setSyncingHermes(true)
    setError('')
    setMessage('')
    try {
      const data = await api.post('/profiles/sync-hermes', {
        confirmText,
        previewToken: hermesSyncPreview.previewToken
      })
      const nextProfiles = data.profiles || []
      setProfiles(nextProfiles)
      setHermesSyncPreview(null)
      setMessage(data.message || 'Hermes Profile 已同步')
      await loadHermesStatus()
      await loadProfiles(selectedId)
      if (selectedId && !nextProfiles.some(profile => profile.id === selectedId)) {
        setSelectedId(nextProfiles[0]?.id || '')
      }
    } catch (err) {
      setError(err.message || 'Hermes Profile 同步失败')
    } finally {
      setSyncingHermes(false)
    }
  }

  const copyProfiles = async () => {
    const content = profileSummaryText(profiles)
    try {
      await copyText(content)
      setError('')
      setMessage(`已复制 ${profiles.length} 个 Hermes Profile 配置摘要`)
    } catch {
      setCopyFallback({
        open: true,
        title: '复制 Hermes Profile 配置',
        description: '浏览器未允许自动复制，请在下方文本框中手动复制。',
        content
      })
    }
  }

  const copyHermesDriftSummary = async () => {
    const driftCount = hermesStatus?.summary?.driftCount || 0
    if (driftCount === 0) return setError('当前没有待同步的 Hermes Profile 差异。')
    if (hermesStatusStale) return setError('Hermes Profile 状态已超过 10 分钟，请先刷新状态。')
    const content = hermesDriftSummaryText(hermesStatus)
    try {
      await copyText(content)
      setError('')
      setMessage(`已复制 ${driftCount} 个 Hermes Profile 待同步差异`)
    } catch {
      setCopyFallback({
        open: true,
        title: '复制 Hermes Profile 待同步差异',
        description: '浏览器未允许自动复制，请在下方文本框中手动复制。',
        content
      })
    }
  }

  const copyHermesStatusDiagnosis = async () => {
    const content = hermesStatusDiagnosisText(hermesStatus || {}, hermesStatusFailure, hermesStatusCheckedAt, hermesStatusMetrics, recentHermesChecks, hermesStatusStale)
    try {
      await copyText(content)
      setError('')
      setMessage('已复制 Hermes Profile 状态诊断')
    } catch {
      setCopyFallback({
        open: true,
        title: '复制 Hermes Profile 状态诊断',
        description: '浏览器未允许自动复制，请在下方文本框中手动复制。',
        content
      })
    }
  }

  const copyHermesHealthAction = async () => {
    const content = hermesHealthActionText(hermesHealth, hermesStatus || {})
    try {
      await copyText(content)
      setError('')
      setMessage('已复制 Hermes Profile 处理建议')
    } catch {
      setCopyFallback({
        open: true,
        title: '复制 Hermes Profile 处理建议',
        description: '浏览器未允许自动复制，请在下方文本框中手动复制。',
        content
      })
    }
  }

  const copyLatestHermesSync = async () => {
    if (!latestHermesProfileSync) return
    const content = hermesSyncSummaryText(latestHermesProfileSync)
    try {
      await copyText(content)
      setError('')
      setMessage('已复制最近一次 Hermes 云端同步摘要')
    } catch {
      setCopyFallback({
        open: true,
        title: '复制 Hermes 云端同步摘要',
        description: '浏览器未允许自动复制，请在下方文本框中手动复制。',
        content
      })
    }
  }

  const copyLatestHermesImport = async () => {
    if (!latestHermesProfileImport) return
    const content = hermesImportSummaryText(latestHermesProfileImport)
    try {
      await copyText(content)
      setError('')
      setMessage('已复制最近一次 Hermes Profile JSON 导入摘要')
    } catch {
      setCopyFallback({
        open: true,
        title: '复制 Hermes Profile JSON 导入摘要',
        description: '浏览器未允许自动复制，请在下方文本框中手动复制。',
        content
      })
    }
  }

  const copyLatestHermesManualEdit = async () => {
    if (!latestHermesProfileManualEdit) return
    const content = hermesManualEditSummaryText(latestHermesProfileManualEdit)
    try {
      await copyText(content)
      setError('')
      setMessage('已复制最近一次 Hermes Profile 人工编辑摘要')
    } catch {
      setCopyFallback({
        open: true,
        title: '复制 Hermes Profile 人工编辑摘要',
        description: '浏览器未允许自动复制，请在下方文本框中手动复制。',
        content
      })
    }
  }

  const copyLatestHermesStatusCheck = async () => {
    if (!latestHermesProfileStatusCheck) return
    const content = hermesStatusCheckSummaryText(latestHermesProfileStatusCheck)
    try {
      await copyText(content)
      setError('')
      setMessage('已复制最近一次 Hermes Profile 接入检查摘要')
    } catch {
      setCopyFallback({
        open: true,
        title: '复制 Hermes Profile 接入检查摘要',
        description: '浏览器未允许自动复制，请在下方文本框中手动复制。',
        content
      })
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

  const openAiFallbackLogs = () => {
    const query = new URLSearchParams({
      type: '执行动作',
      actionGroup: 'AI调用',
      result: '回退',
      range: '近30天'
    })
    navigate(`/logs?${query.toString()}`)
  }

  const copyConfigHistory = async () => {
    const content = hermesConfigHistoryText(visibleConfigHistory, {
      historyCount: configHistory.length,
      historyLimit: configHistoryLimit,
      loadedAt: configHistoryLoadedAt,
      durationMs: configHistoryLoadDurationMs,
      statusLabel: configHistoryLoadStatusInfo.label,
      filterSummary: configHistoryFilterSummary
    })
    try {
      await copyText(content)
      setError('')
      setMessage(`已复制当前筛选下的 ${visibleConfigHistory.length} 条 Hermes Profile 配置变更`)
    } catch {
      setCopyFallback({
        open: true,
        title: '复制 Hermes Profile 配置变更时间线',
        description: '浏览器未允许自动复制，请在下方文本框中手动复制。',
        content
      })
    }
  }

  const copyConfigHistoryItem = async (item) => {
    const content = hermesConfigHistoryItemText(item)
    try {
      await copyText(content)
      setError('')
      setMessage(`已复制 ${item.type || 'Hermes'} 时间线记录`)
    } catch {
      setCopyFallback({
        open: true,
        title: '复制 Hermes Profile 时间线记录',
        description: '浏览器未允许自动复制，请在下方文本框中手动复制。',
        content
      })
    }
  }

  const exportConfigHistory = async () => {
    setExportingConfigHistory(true)
    setError('')
    try {
      const currentUser = getUser()
      const payload = {
        title: 'Hermes Profile 配置时间线审计',
        exportedAt: new Date().toISOString(),
        exportedBy: currentUser?.name || currentUser?.username || '未知账号',
        filters: {
          summary: configHistoryFilterSummary,
          summarySource: '文件自带',
          type: configHistoryType,
          profileId: configHistoryProfileId,
          profileName: configHistoryProfileFilterActive
            ? profiles.find(profile => profile.id === configHistoryProfileId)?.name || configHistoryProfileId
            : '',
          profileFilterActive: configHistoryProfileFilterActive,
          profileFilterDisabled: configHistoryProfileFilterDisabled,
          keyword: configHistoryKeyword.trim(),
          matchedCount: visibleConfigHistory.length,
          totalCount: configHistory.length,
          historyLimit: configHistoryLimit,
          loadedAt: configHistoryLoadedAt,
          loadDurationMs: configHistoryLoadDurationMs,
          loadStatus: configHistoryLoadStatusInfo.label
        },
        count: visibleConfigHistory.length,
        items: visibleConfigHistory
      }
      const contentHash = await sha256Text(JSON.stringify(payload))
      const filename = `hermes-config-history-${Date.now()}.json`
      const exportedData = {
        ...payload,
        contentHashAlgorithm: 'SHA-256',
        contentHash
      }
      downloadJsonFile(filename, exportedData)
      setLatestConfigHistoryExport({ filename, ...exportedData })
      setMessage(`已导出 ${visibleConfigHistory.length} 条 Hermes Profile 时间线审计记录，校验指纹 ${contentHash.slice(0, 12)}`)
    } catch (err) {
      setError(err.message || 'Hermes Profile 时间线导出失败')
    } finally {
      setExportingConfigHistory(false)
    }
  }

  const copyConfigHistoryExportReceipt = async () => {
    if (!latestConfigHistoryExport) return
    const content = hermesConfigHistoryExportReceiptText(latestConfigHistoryExport)
    try {
      await copyText(content)
      setError('')
      setMessage('已复制最近一次审计导出校验说明')
    } catch {
      setCopyFallback({
        open: true,
        title: '复制审计导出校验说明',
        description: '浏览器未允许自动复制，请在下方文本框中手动复制。',
        content
      })
    }
  }

  const verifyConfigHistoryExport = async (file) => {
    if (!file) return
    setError('')
    setLatestConfigHistoryVerification(null)
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      const expectedHash = String(data.contentHash || '')
      if (!expectedHash) throw new Error('文件缺少 contentHash，无法校验。')
      const { contentHash, contentHashAlgorithm, ...payload } = data
      const actualHash = await sha256Text(JSON.stringify(payload))
      const summarySource = String(data.filters?.summarySource || '').trim()
      const filterSummaryGenerated = summarySource ? summarySource === '系统回填' : !String(data.filters?.summary || '').trim()
      const verification = {
        filename: file.name,
        checkedAt: new Date().toISOString(),
        count: data.count ?? 0,
        expectedHash,
        actualHash,
        ok: expectedHash === actualHash,
        algorithm: contentHashAlgorithm || 'SHA-256',
        filters: data.filters || {},
        filterSummaryGenerated
      }
      setLatestConfigHistoryVerification(verification)
      let sanitizedNumberFields = []
      let serverHashMismatch = verification.ok ? false : expectedHash !== actualHash
      let blockedReason = ''
      try {
        const logResult = await api.post('/profiles/config-history-verification', verification)
        sanitizedNumberFields = Array.isArray(logResult.sanitizedNumberFields) ? logResult.sanitizedNumberFields : []
        if (typeof logResult.hashMismatch === 'boolean') serverHashMismatch = logResult.hashMismatch
        const serverHashStatus = logResult.hashStatus || (serverHashMismatch ? '指纹不一致' : '指纹一致')
        setLatestConfigHistoryVerification({
          ...verification,
          hashMismatch: serverHashMismatch,
          hashStatus: serverHashStatus,
          sanitizedNumberFields,
          auditLogStatus: '已记录'
        })
        await loadProfiles(selectedId)
      } catch (logErr) {
        const errorData = logErr.data || {}
        sanitizedNumberFields = Array.isArray(errorData.sanitizedNumberFields) ? errorData.sanitizedNumberFields : sanitizedNumberFields
        if (typeof errorData.hashMismatch === 'boolean') serverHashMismatch = errorData.hashMismatch
        const serverHashStatus = errorData.hashStatus || (serverHashMismatch ? '指纹不一致' : '指纹一致')
        setLatestConfigHistoryVerification({
          ...verification,
          hashMismatch: serverHashMismatch,
          hashStatus: serverHashStatus,
          sanitizedNumberFields,
          auditLogStatus: '已拦截',
          blockedReason: errorData.reason || logErr.message || '日志写入失败'
        })
        blockedReason = errorData.reason || logErr.message || '日志写入失败'
        await loadProfiles(selectedId, configHistoryRequestLimit, { silent: true })
        setError(errorData.reason ? `后端已拦截：${errorData.reason}` : logErr.message || '审计 JSON 校验已完成，但日志写入失败')
      }
      const sanitizedText = sanitizedNumberFields.length > 0 ? `；后端已修正字段：${sanitizedNumberFields.join('、')}` : ''
      const serverHashText = serverHashMismatch ? '；服务端确认指纹异常' : '；服务端确认指纹一致'
      const baseMessage = blockedReason
        ? `审计 JSON 校验已完成，但后端审计日志已拦截：${blockedReason}`
        : expectedHash === actualHash ? '审计 JSON 校验通过，内容未被修改。' : '审计 JSON 校验不通过，请核对文件来源。'
      setMessage(`${baseMessage}${serverHashText}${sanitizedText}`)
    } catch (err) {
      setError(err.message || '审计 JSON 校验失败')
    } finally {
      if (auditVerifyInputRef.current) auditVerifyInputRef.current.value = ''
    }
  }

  const copyConfigHistoryVerification = async () => {
    if (!latestConfigHistoryVerification) return
    const content = hermesConfigHistoryVerificationText(latestConfigHistoryVerification)
    try {
      await copyText(content)
      setError('')
      setMessage('已复制审计 JSON 校验结果')
    } catch {
      setCopyFallback({
        open: true,
        title: '复制审计 JSON 校验结果',
        description: '浏览器未允许自动复制，请在下方文本框中手动复制。',
        content
      })
    }
  }

  const copyAuditVerificationStats = async () => {
    const content = hermesAuditVerificationStatsText(auditVerificationStats)
    try {
      await copyText(content)
      setError('')
      setMessage('已复制审计校验概览')
    } catch {
      setCopyFallback({
        open: true,
        title: '复制审计校验概览',
        description: '浏览器未允许自动复制，请在下方文本框中手动复制。',
        content
      })
    }
  }

  const exportProfiles = async () => {
    setExportingProfiles(true)
    setError('')
    setMessage('')
    try {
      await downloadFile('/profiles/export', `hermes-profiles-${Date.now()}.json`)
      setMessage(`已导出 ${profiles.length} 个 Hermes Profile 配置`)
    } catch (err) {
      setError(err.message || 'Hermes Profile 导出失败')
    } finally {
      setExportingProfiles(false)
    }
  }

  const previewProfileImport = async (file) => {
    if (!file) return
    const formatError = uploadFormatError(file, ['.json'], 'Hermes Profile')
    if (formatError) {
      setImportFile(null)
      setImportPreview(null)
      setError(formatError)
      setMessage('')
      if (importInputRef.current) importInputRef.current.value = ''
      return
    }
    setPreviewingImport(true)
    setImportFile(file)
    setImportPreview(null)
    setError('')
    setMessage('')
    try {
      const data = await uploadFile('/profiles/import-preview', file, 'profiles')
      setImportPreview(data.preview || null)
      setMessage('Profile 导入文件校验通过，请确认后覆盖当前配置。')
    } catch (err) {
      setImportFile(null)
      setError(err.message || 'Profile 导入文件校验失败')
    } finally {
      setPreviewingImport(false)
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  const importProfiles = async () => {
    if (!importFile || !importPreview) return
    if ((importPreview.changedProfileCount || 0) === 0) return setError('导入文件与当前配置一致，无需覆盖。')
    const confirmText = window.prompt(`将导入 ${importPreview.profileCount || 0} 个 Hermes Profile，当前网页 Profile 配置将被覆盖。\n请输入“确认导入”继续：`)?.trim()
    if (confirmText !== '确认导入') {
      setError('请输入“确认导入”后再覆盖网页 Profile 配置')
      return
    }
    setImportingProfiles(true)
    setError('')
    setMessage('')
    try {
      const data = await uploadFile('/profiles/import', importFile, 'profiles', { confirmText })
      const nextProfiles = data.profiles || []
      setProfiles(nextProfiles)
      setImportFile(null)
      setImportPreview(null)
      setMessage(data.message || 'Hermes Profile 配置已导入')
      await loadHermesStatus()
      await loadProfiles(selectedId)
      if (selectedId && !nextProfiles.some(profile => profile.id === selectedId)) {
        setSelectedId(nextProfiles[0]?.id || '')
      }
    } catch (err) {
      setError(err.message || 'Hermes Profile 导入失败')
    } finally {
      setImportingProfiles(false)
    }
  }

  useEffect(() => {
    loadProfiles(searchParams.get('profile') || '')
    loadHermesStatus()
  }, [])

  useEffect(() => {
    if (searchParams.get('focus') !== 'hermes') return undefined
    const fromAiFallback = searchParams.get('from') === 'ai-fallback'
    if (fromAiFallback) setAiFallbackFocusActive(true)
    const timer = window.setTimeout(() => {
      hermesPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setHighlightHermesPanel(true)
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        next.delete('focus')
        next.delete('from')
        return next
      }, { replace: true })
    }, 150)
    const clearHighlightTimer = window.setTimeout(() => setHighlightHermesPanel(false), 2400)
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(clearHighlightTimer)
    }
  }, [searchParams, setSearchParams])

  useEffect(() => {
    if (!aiFallbackFocusActive || loadingHermes || aiFallbackAutoRefreshRef.current) return undefined
    aiFallbackAutoRefreshRef.current = true
    const timer = window.setTimeout(async () => {
      setMessage('AI 回退排查入口已进入，正在刷新 Hermes Profile 状态。')
      await loadHermesStatus()
      setMessage('Hermes Profile 状态已刷新，请查看缺失、差异和最近检查记录。')
    }, 450)
    return () => window.clearTimeout(timer)
  }, [aiFallbackFocusActive, loadingHermes])

  useEffect(() => {
    const timer = window.setInterval(() => setStatusClock(Date.now()), 60 * 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    localStorage.setItem('autoRefreshHermesProfiles', String(autoRefreshHermes))
    if (!autoRefreshHermes) return undefined

    const refreshIfVisible = () => {
      if (document.visibilityState !== 'visible' || loadingHermes) return
      loadHermesStatus()
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'visible' || loadingHermes) return
      const checkedTimestamp = Date.parse(hermesStatusCheckedAt || '')
      if (!checkedTimestamp || Date.now() - checkedTimestamp >= 5 * 60 * 1000) loadHermesStatus()
    }
    const timer = window.setInterval(refreshIfVisible, 5 * 60 * 1000)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [autoRefreshHermes, hermesStatusCheckedAt, loadingHermes])

  useEffect(() => {
    localStorage.setItem('recentHermesProfileChecks', JSON.stringify(recentHermesChecks))
  }, [recentHermesChecks])

  const selectedProfile = useMemo(
    () => profiles.find(item => item.id === selectedId) || profiles[0] || null,
    [profiles, selectedId]
  )
  const configHistoryLoadStatusInfo = useMemo(
    () => configHistoryLoadStatus(configHistoryLoadDurationMs),
    [configHistoryLoadDurationMs]
  )
  const scopeFilter = searchParams.get('scope') || '全部'
  const selectedProfileChanges = useMemo(
    () => profileFormChanges(selectedProfile, form),
    [form, selectedProfile]
  )
  const configHistoryProfileFilterDisabled = !['全部', '人工编辑'].includes(configHistoryType)
  const configHistoryProfileFilterActive = !configHistoryProfileFilterDisabled && configHistoryProfileId !== '全部'
  const visibleConfigHistory = useMemo(
    () => configHistory.filter(item => {
      const keyword = configHistoryKeyword.trim().toLowerCase()
      const matchesType = configHistoryType === '全部' || item.type === configHistoryType
      const matchesProfile = configHistoryProfileFilterDisabled || configHistoryProfileId === '全部' || (
        item.type === '人工编辑'
          ? item.profileId === configHistoryProfileId
          : (item.changes || []).some(change => change.id === configHistoryProfileId)
      )
      const searchable = [
        item.type,
        item.actor,
        item.at,
        item.profileCode,
        item.profileName,
        item.result,
        item.auditLogStatus,
        item.reason,
        item.filename,
        item.previewTokenFingerprint,
        item.expectedHash,
        item.actualHash,
        item.hashMismatch ? 'hashMismatch' : '',
        item.hashStatus,
        isConfigHistoryHashMismatch(item) ? '指纹不一致 指纹异常' : item.hashStatus === '指纹一致' ? '指纹一致 指纹正常' : '',
        isConfigHistoryHashUnknown(item) ? '指纹未记录' : '',
        item.filterSummary,
        item.filterSummarySource,
        item.filterSummaryGenerated ? '系统回填' : '',
        item.filterType,
        item.filterProfileId,
        item.filterProfileName,
        item.filterKeyword,
        item.filterHistoryLimit,
        item.filterLoadedAt,
        item.filterLoadDurationMs,
        item.filterLoadStatus,
        item.sanitizedNumberFields?.length ? '已修正字段' : '',
        ...(item.sanitizedNumberFields || []),
        item.filterProfileDisabled ? '专业未参与' : '',
        item.filterProfileActive ? '专业已参与' : '',
        item.filterMatchedCount,
        item.filterTotalCount,
        item.generatedAt,
        item.expiresAt,
        ...(item.changedFields || []),
        ...(item.changes || []).flatMap(change => [change.code, change.name, ...(change.changedFields || [])])
      ].join(' ').toLowerCase()
      return matchesType && matchesProfile && (!keyword || searchable.includes(keyword))
    }),
    [configHistory, configHistoryKeyword, configHistoryProfileFilterDisabled, configHistoryProfileId, configHistoryType]
  )
  const configHistoryFiltered = configHistoryType !== '全部' || configHistoryProfileFilterActive || configHistoryKeyword.trim()
  const configHistoryCounts = useMemo(() => ({
    全部: configHistory.length,
    接入检查: configHistory.filter(item => item.type === '接入检查').length,
    云端同步: configHistory.filter(item => item.type === '云端同步').length,
    同步预览: configHistory.filter(item => item.type === '同步预览').length,
    同步拦截: configHistory.filter(item => item.type === '同步拦截').length,
    审计校验: configHistory.filter(item => item.type === '审计校验').length,
    'JSON 导入': configHistory.filter(item => item.type === 'JSON 导入').length,
    人工编辑: configHistory.filter(item => item.type === '人工编辑').length
  }), [configHistory])
  const updateConfigHistoryType = (type) => {
    setConfigHistoryType(type)
    if (!['全部', '人工编辑'].includes(type)) setConfigHistoryProfileId('全部')
  }
  const auditQuickFilterLabels = {
    失败: '失败',
    拦截: '拦截',
    已记录: '日志已记录',
    已拦截: '日志已拦截',
    已修正字段: '修正',
    系统回填: '回填',
    指纹不一致: '指纹异常',
    指纹一致: '指纹正常',
    指纹未记录: '指纹未记录'
  }
  const auditQuickFilterMessageLabels = {
    ...auditQuickFilterLabels,
    已修正字段: '修正记录',
    系统回填: '回填记录',
    指纹不一致: '指纹异常记录',
    指纹一致: '指纹正常记录',
    指纹未记录: '指纹未记录'
  }
  const focusAuditVerificationHistory = (keyword) => {
    setConfigHistoryType('审计校验')
    setConfigHistoryProfileId('全部')
    setConfigHistoryKeyword(keyword)
    const label = auditQuickFilterMessageLabels[keyword] || `${keyword}记录`
    setMessage(`已筛选审计校验${label}`)
  }
  const returnAuditVerificationOverview = () => {
    setConfigHistoryType('审计校验')
    setConfigHistoryProfileId('全部')
    setConfigHistoryKeyword('')
    setMessage('已返回审计校验概览')
  }
  const clearConfigHistoryFilter = () => {
    setConfigHistoryType('全部')
    setConfigHistoryProfileId('全部')
    setConfigHistoryKeyword('')
    setMessage('已清除时间线筛选')
  }
  const auditQuickFilterActive = configHistoryType === '审计校验' && Object.keys(auditQuickFilterLabels).includes(configHistoryKeyword.trim())
  const auditQuickFilterLabel = auditQuickFilterLabels[configHistoryKeyword.trim()] || configHistoryKeyword.trim()
  const configHistoryFilterSummary = [
    `类型 ${configHistoryType}`,
    auditQuickFilterActive ? `快捷视图 ${auditQuickFilterLabel}` : '',
    configHistoryProfileFilterActive ? `专业 ${profiles.find(profile => profile.id === configHistoryProfileId)?.name || configHistoryProfileId}` : '',
    configHistoryProfileFilterDisabled ? '专业筛选未参与' : '',
    !auditQuickFilterActive && configHistoryKeyword.trim() ? `关键词“${configHistoryKeyword.trim()}”` : '',
    `命中 ${visibleConfigHistory.length}/${configHistory.length} 条`
  ].filter(Boolean).join(' · ')
  const auditVerificationStats = useMemo(() => {
    const items = configHistory.filter(item => item.type === '审计校验')
    const latest = items[0] || {}
    return {
      total: items.length,
      logRecorded: items.filter(item => configHistoryAuditLogStatus(item) === '已记录').length,
      logBlocked: items.filter(item => configHistoryAuditLogStatus(item) === '已拦截').length,
      passed: items.filter(item => item.result === '成功').length,
      failed: items.filter(item => item.result === '失败').length,
      blocked: items.filter(item => item.result === '拦截').length,
      hashMismatch: items.filter(isConfigHistoryHashMismatch).length,
      hashMatched: items.filter(item => item.hashStatus === '指纹一致').length,
      hashUnknown: items.filter(isConfigHistoryHashUnknown).length,
      sanitized: items.filter(item => (item.sanitizedNumberFields || []).length > 0).length,
      generatedSummary: items.filter(isConfigHistoryGeneratedSummary).length,
      latest: {
        result: latest.result || '',
        auditLogStatus: latest.auditLogStatus || '',
        filename: latest.filename || '',
        at: latest.at || '',
        expectedHash: latest.expectedHash || '',
        actualHash: latest.actualHash || ''
      }
    }
  }, [configHistory])
  const auditLatestHashSummary = configHistoryHashSummary(auditVerificationStats.latest)

  useEffect(() => {
    const queryProfileId = searchParams.get('profile') || ''
    if (!queryProfileId || queryProfileId === selectedId) return
    if (profiles.some(item => item.id === queryProfileId)) {
      if (selectedProfileChanges.length > 0 && !window.confirm(`当前《${selectedProfile?.name || 'Profile'}》有未保存改动，确认放弃并切换？`)) {
        setSearchParams(prev => {
          const next = new URLSearchParams(prev)
          if (selectedId) next.set('profile', selectedId)
          else next.delete('profile')
          return next
        })
        return
      }
      setSelectedId(queryProfileId)
    }
  }, [profiles, searchParams, selectedId, selectedProfile?.name, selectedProfileChanges.length, setSearchParams])

  useEffect(() => {
    const warnBeforeUnload = (event) => {
      if (selectedProfileChanges.length === 0) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [selectedProfileChanges.length])

  useEffect(() => {
    if (!selectedProfile) {
      setForm(null)
      return
    }
    setForm({
      name: selectedProfile.name || '',
      hermesName: selectedProfile.hermesName || '',
      scope: selectedProfile.scope || '',
      output: selectedProfile.output || '',
      standardsText: standardsToText(selectedProfile.standards),
      standardsVerified: selectedProfile.definitionVerified === true,
      status: selectedProfile.status || '启用',
      internalEnabled: selectedProfile.internalEnabled !== false,
      marketEnabled: selectedProfile.marketEnabled !== false,
      canInitiate: selectedProfile.canInitiate === true
    })
  }, [selectedProfile])

  const configuredEnabledCount = profiles.filter(item => item.status === '启用').length
  const activeProfiles = profiles.filter(item => item.status === '启用' && item.definitionVerified === true)
  const enabledCount = activeProfiles.length
  const internalCount = activeProfiles.filter(item => item.internalEnabled !== false).length
  const marketCount = activeProfiles.filter(item => item.id !== 'investment' && item.marketEnabled !== false).length
  const hasInitiator = activeProfiles.some(item => item.id === 'investment' && item.marketEnabled !== false && item.canInitiate)
  const hermesProfileMap = useMemo(() => new Map((hermesStatus?.profiles || []).map(item => [item.id, item])), [hermesStatus])
  const hermesStatusCheckedTimestamp = Date.parse(hermesStatusCheckedAt || '')
  const hermesStatusStale = Boolean(hermesStatusCheckedTimestamp && statusClock - hermesStatusCheckedTimestamp > 10 * 60 * 1000)
  const hermesSyncPreviewExpiresTimestamp = Date.parse(hermesSyncPreview?.expiresAt || '')
  const hermesSyncPreviewStale = Boolean(hermesSyncPreviewExpiresTimestamp && statusClock >= hermesSyncPreviewExpiresTimestamp)
  const recentHermesCheckStats = useMemo(() => hermesCheckStats(recentHermesChecks), [recentHermesChecks])
  const hermesHealth = useMemo(
    () => hermesHealthAssessment(hermesStatus || {}, hermesStatusFailure, hermesStatusMetrics, recentHermesChecks, hermesStatusStale),
    [hermesStatus, hermesStatusFailure, hermesStatusMetrics, recentHermesChecks, hermesStatusStale]
  )
  const hermesActionSummary = `Hermes 状态：${hermesHealth.label}；网页 ${hermesStatus?.summary?.webCount ?? profiles.length} 个；云端 ${hermesStatus?.summary?.remoteCount ?? 0} 个；匹配 ${hermesStatus?.summary?.matchedCount ?? 0} 个；缺失 ${hermesStatus?.summary?.missingCount ?? profiles.length} 个；待同步差异 ${hermesStatus?.summary?.driftCount ?? 0} 个${hermesStatusStale ? '；状态已过期' : ''}`
  const hermesSyncPreviewSummary = hermesSyncPreview
    ? `同步预览：将覆盖 ${hermesSyncPreview.changedProfileCount || 0} 个专业 Profile${hermesSyncPreviewStale ? '；预览已过期' : '；预览 10 分钟内有效'}`
    : '尚未生成同步预览'
  const filteredProfiles = useMemo(() => profiles.filter(profile => {
    const active = profile.status === '启用' && profile.definitionVerified === true
    if (scopeFilter === '内部运营') return active && profile.internalEnabled !== false
    if (scopeFilter === '市场拓展') return active && profile.marketEnabled !== false
    if (scopeFilter === '立项牵头') return active && profile.id === 'investment' && profile.marketEnabled !== false && profile.canInitiate
    if (scopeFilter === '待同步差异') return hermesProfileMap.get(profile.id)?.drifted === true
    return true
  }), [hermesProfileMap, profiles, scopeFilter])
  const profileFilterSummary = `范围：${scopeFilter}；当前显示 ${filteredProfiles.length} 个；总 Profile ${profiles.length} 个；内部运营 ${internalCount} 个；市场拓展 ${marketCount} 个；立项牵头${hasInitiator ? '已配置' : '缺失'}`
  const scopeFilterLabel = (scope) => `筛选 Hermes Profile 范围为“${scope}”，${profileFilterSummary}`
  const profileCardLabel = (profile = {}) => {
    const hermesProfile = hermesProfileMap.get(profile.id)
    const hermesText = hermesProfile?.drifted
      ? `Hermes 有差异，待同步字段 ${(hermesProfile.changedFields || []).join('、') || '未记录'}`
      : hermesProfile?.matched
        ? 'Hermes 已对接'
        : 'Hermes 未匹配'
    return `选择 ${profile.code || ''} ${profile.name || '未命名 Profile'}，Hermes 名称 ${profile.hermesName || '未记录'}，配置状态 ${profile.status || '未知'}，核验状态 ${profile.onlineLabel || (profile.definitionVerified ? '已核验' : '待核验')}，内部运营 ${profile.internalEnabled !== false ? '已配置参与' : '已关闭'}，市场拓展 ${profile.marketEnabled !== false ? '已配置参与' : '已关闭'}，${hermesText}`
  }
  const importPreviewSummary = importPreview
    ? `导入预览：Profile ${importPreview.profileCount || 0} 个，启用 ${importPreview.enabledCount || 0} 个，内部运营 ${importPreview.internalEnabledCount || 0} 个，市场拓展 ${importPreview.marketEnabledCount || 0} 个，将修改 ${importPreview.changedProfileCount || 0} 个专业 Profile`
    : '尚未生成导入预览'
  const selectedProfileSaveLabel = selectedProfile
    ? saving
      ? `正在保存《${selectedProfile.name || '当前 Profile'}》配置`
      : selectedProfileChanges.length > 0
        ? `保存《${selectedProfile.name || '当前 Profile'}》配置，待保存变更 ${selectedProfileChanges.join('、')}，执行前需要输入“保存Profile配置”确认`
        : `《${selectedProfile.name || '当前 Profile'}》当前没有未保存改动`
    : '请选择 Profile 后再保存配置'

  const updateForm = (key, value) => {
    setForm(prev => ({
      ...prev,
      [key]: value,
      ...(['name', 'hermesName', 'scope', 'output', 'standardsText', 'status', 'internalEnabled', 'marketEnabled', 'canInitiate'].includes(key) ? { standardsVerified: false } : {})
    }))
  }

  const updateSelectedProfile = (profileId) => {
    if (profileId === selectedId) return
    if (selectedProfileChanges.length > 0 && !window.confirm(`当前《${selectedProfile?.name || 'Profile'}》有未保存改动，确认放弃并切换？`)) return
    setSelectedId(profileId)
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (!profileId) next.delete('profile')
      else next.set('profile', profileId)
      return next
    })
  }

  const resetSelectedProfile = () => {
    if (!selectedProfile) return
    setForm({
      name: selectedProfile.name || '',
      hermesName: selectedProfile.hermesName || '',
      scope: selectedProfile.scope || '',
      output: selectedProfile.output || '',
      standardsText: standardsToText(selectedProfile.standards),
      standardsVerified: selectedProfile.definitionVerified === true,
      status: selectedProfile.status || '启用',
      internalEnabled: selectedProfile.internalEnabled !== false,
      marketEnabled: selectedProfile.marketEnabled !== false,
      canInitiate: selectedProfile.canInitiate === true
    })
    setError('')
    setMessage('已撤销当前机器人未保存改动')
  }

  const updateScopeFilter = (scope) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (!scope || scope === '全部') next.delete('scope')
      else next.set('scope', scope)
      return next
    })
  }

  const saveProfile = async (e) => {
    e.preventDefault()
    if (!selectedProfile || !form) return

    const standards = textToStandards(form.standardsText)
    if (String(form.name).trim().length < 2) return setError('机器人名称不能少于 2 个字符')
    if (standards.length === 0) return setError('请至少填写 1 条审核提示')
    if (form.status !== '停用' && !form.standardsVerified) return setError('启用 Profile 前必须核对完整定义与正式依据，并勾选“已完成完整定义核验”。Hermes 同步不等于业务审批。')
    if (selectedProfileChanges.length === 0) return setError('当前机器人配置没有变化，无需保存。')
    const confirmText = '保存Profile配置'
    const typed = window.prompt(`确认保存《${selectedProfile.name}》配置的 ${selectedProfileChanges.length} 项变更？\n${selectedProfileChanges.join('、')}\n勾选核验表示你已核对名称、范围、输出物、审核提示、适用路由和排序的完整定义及正式依据；Hermes 同步不等于业务审批。\n\n如确认继续，请输入：${confirmText}`)?.trim()
    if (typed !== confirmText) {
      setError(`Profile 配置保存已取消：需输入“${confirmText}”才会执行。`)
      return
    }

    setSaving(true)
    setError('')
    setMessage('')
    try {
      const data = await api.patch(`/profiles/${selectedProfile.id}`, {
        name: form.name.trim(),
        hermesName: form.hermesName.trim(),
        scope: form.scope.trim(),
        output: form.output.trim(),
        standards,
        standardsVerified: form.standardsVerified,
        status: form.status,
        internalEnabled: form.internalEnabled,
        marketEnabled: form.marketEnabled,
        canInitiate: selectedProfile.id === 'investment' ? form.canInitiate : false,
        confirmText
      })
      setMessage(data.noChange ? '当前机器人配置没有变化，无需保存。' : `机器人配置已保存：${selectedProfileChanges.join('、')}`)
      await loadProfiles(selectedProfile.id)
    } catch (err) {
      setError(err.message || '机器人配置保存失败')
    } finally {
      setSaving(false)
    }
  }

  const StatusBadge = ({ status }) => (
    <span className={`px-2 py-1 rounded text-xs border whitespace-nowrap ${
      status === '启用'
        ? 'text-emerald-300 bg-emerald-500/10 border-emerald-400/30'
        : 'text-slate-300 bg-slate-500/10 border-slate-400/30'
    }`}>
      {status}
    </span>
  )

  return (
    <div className="grid grid-cols-12 gap-4">
      <section className="col-span-12 xl:col-span-7 space-y-4">
        <Panel
          ref={hermesPanelRef}
          className={`p-5 transition-shadow duration-500 ${highlightHermesPanel ? 'shadow-[0_0_0_2px_rgba(34,211,238,0.45),0_0_32px_rgba(34,211,238,0.18)]' : ''}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <div>
              <h1 className="text-xl font-bold text-blue-200 mb-1">审核机器人配置</h1>
              <p className="text-sm text-slate-400">维护审核范围、输出要求、适用场景与启停状态，配置将直接影响 AI 审核流程。</p>
            </div>
            <span className="px-3 py-1.5 rounded-lg border border-emerald-400/30 bg-emerald-500/10 text-emerald-300 text-sm">
              {enabledCount}/{profiles.length || 0} 个已核验启用（配置启用 {configuredEnabledCount} 个）
            </span>
          </div>
          {(focusedFromAiFallback || aiFallbackFocusActive) && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              <div>AI 审核出现本地兜底回退，系统会自动刷新 Hermes Profile 状态；如仍有缺失或差异，复制诊断并核对云端 8 个一级专业 Profile。</div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={openAiFallbackLogs}
                  className="rounded-lg border border-amber-300/30 bg-slate-950/30 px-3 py-1.5 text-xs text-amber-100 hover:bg-amber-500/10"
                >
                  查看 AI 回退日志
                </button>
                <button
                  type="button"
                  onClick={copyHermesStatusDiagnosis}
                  disabled={!hermesStatus}
                  className="rounded-lg border border-amber-300/30 bg-slate-950/30 px-3 py-1.5 text-xs text-amber-100 hover:bg-amber-500/10 disabled:opacity-50"
                >
                  复制诊断
                </button>
              </div>
            </div>
          )}

          <div className={`mb-5 rounded-lg border px-4 py-3 ${
            hermesHealth.level === 'error'
              ? 'border-rose-400/25 bg-rose-500/10'
              : hermesHealth.level === 'warning'
                ? 'border-amber-400/25 bg-amber-500/10'
                : 'border-emerald-400/25 bg-emerald-500/10'
          }`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-lg border border-white/10 bg-slate-950/40 grid place-items-center shrink-0">
                  <Cloud size={18} className={hermesStatus?.ok === false ? 'text-rose-200' : 'text-cyan-200'} />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="font-semibold text-blue-100">Hermes 云端 Profile</div>
                    <span className={`rounded border px-2 py-0.5 text-xs ${
                      hermesHealth.level === 'error'
                        ? 'border-rose-400/30 bg-rose-500/10 text-rose-200'
                        : hermesHealth.level === 'warning'
                          ? 'border-amber-400/30 bg-amber-500/10 text-amber-200'
                          : hermesHealth.level === 'healthy'
                            ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                            : 'border-slate-400/30 bg-slate-500/10 text-slate-300'
                    }`}>
                      {hermesHealth.label}
                    </span>
                  </div>
                  <div className="mt-1 text-sm text-slate-300">
                    {hermesStatus?.message || '正在读取 Hermes Profile 状态...'}
                  </div>
                  {(hermesStatus?.health || hermesStatus?.healthError) && (
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      {hermesStatus?.health?.engine && (
                        <span className="rounded border border-cyan-300/20 bg-cyan-500/10 px-2 py-1 text-cyan-100">
                          引擎：{hermesStatus.health.engine}
                        </span>
                      )}
                      {hermesStatus?.health?.agentProvider && (
                        <span className="rounded border border-violet-300/20 bg-violet-500/10 px-2 py-1 text-violet-100">
                          Agent：{hermesStatus.health.agentProvider} / {hermesStatus.health.agentModel || '-'}
                        </span>
                      )}
                      {hermesStatus?.healthError && (
                        <span className="rounded border border-amber-300/25 bg-amber-500/10 px-2 py-1 text-amber-100">
                          Health：{hermesStatus.healthError}
                        </span>
                      )}
                    </div>
                  )}
                  <div className={`mt-1 text-xs ${
                    hermesHealth.level === 'error'
                      ? 'text-rose-200'
                      : hermesHealth.level === 'warning'
                        ? 'text-amber-200'
                        : 'text-slate-500'
                  }`}>
                    {hermesHealth.reason}
                  </div>
                  <div className="mt-1 text-xs text-slate-400">
                    处理建议：{hermesHealth.action}
                  </div>
                  {hermesStatus?.diagnostic && (
                    <div className="mt-2 rounded-lg border border-white/10 bg-slate-950/35 px-3 py-2">
                      <div className="text-xs font-semibold text-slate-200">接入排查建议</div>
                      <div className="mt-1 text-xs text-slate-300">{hermesStatus.diagnostic.nextAction || '请刷新 Hermes Profile 状态。'}</div>
                      <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                        {(hermesStatus.diagnostic.checks || []).map(check => {
                          const checkClass = check.status === '通过'
                            ? 'border-emerald-300/20 bg-emerald-500/10 text-emerald-100'
                            : check.status === '待确认'
                              ? 'border-blue-300/20 bg-blue-500/10 text-blue-100'
                              : 'border-amber-300/25 bg-amber-500/10 text-amber-100'
                          return (
                            <div key={check.label} className={`rounded border px-2 py-1.5 ${checkClass}`}>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-medium">{check.label}</span>
                                <span className="rounded border border-white/10 bg-slate-950/35 px-1.5 py-0.5 text-[11px]">{check.status}</span>
                              </div>
                              <div className="mt-1 text-xs leading-relaxed text-slate-300">{check.detail}</div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  {hermesStatusCheckedAt && (
                    <div className={`mt-1 text-xs ${hermesStatusStale ? 'text-amber-200' : 'text-slate-500'}`}>
                      最近检查：{new Date(hermesStatusCheckedAt).toLocaleString('zh-CN', { hour12: false })}
                      {hermesStatusStale ? ' · 状态已超过 10 分钟，请刷新后再同步' : ''}
                    </div>
                  )}
                  {hermesStatusMetrics.lastDurationMs != null && (
                    <div className={`mt-1 text-xs ${hermesStatusMetrics.lastDurationMs > 3000 ? 'text-amber-200' : 'text-slate-500'}`}>
                      响应耗时：{hermesStatusMetrics.lastDurationMs} ms
                      {hermesStatusMetrics.lastSuccessAt ? ` · 最近成功：${new Date(hermesStatusMetrics.lastSuccessAt).toLocaleString('zh-CN', { hour12: false })}` : ''}
                      {hermesStatusMetrics.lastDurationMs > 3000 ? ' · 响应偏慢' : ''}
                    </div>
                  )}
                  {hermesStatusFailure.count > 0 && (
                    <div className="mt-2 rounded border border-rose-400/25 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-200">
                      状态检查连续失败 {hermesStatusFailure.count} 次 · 最近失败：{new Date(hermesStatusFailure.at).toLocaleString('zh-CN', { hour12: false })}
                      <button type="button" onClick={() => loadHermesStatus({ audit: true })} disabled={loadingHermes} title={`立即重试 Hermes Profile 状态检查，${hermesActionSummary}`} aria-label={`立即重试 Hermes Profile 状态检查，${hermesActionSummary}`} className="ml-2 text-rose-100 underline hover:text-white disabled:opacity-50">
                        立即重试
                      </button>
                      <button type="button" onClick={copyHermesStatusDiagnosis} title={`复制 Hermes Profile 状态诊断，${hermesActionSummary}`} aria-label={`复制 Hermes Profile 状态诊断，${hermesActionSummary}`} className="ml-2 text-rose-100 underline hover:text-white">
                        复制诊断
                      </button>
                    </div>
                  )}
                  {recentHermesChecks.length > 0 && (
                    <div className="mt-2 rounded border border-white/10 bg-slate-950/25 px-2 py-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-medium text-slate-300">
                          最近检查记录 · 成功率 {recentHermesCheckStats.successRate}% · 平均 {recentHermesCheckStats.averageDurationMs} ms
                        </span>
                        <button
                          type="button"
                          onClick={() => setRecentHermesChecks([])}
                          title={`清空最近 ${recentHermesChecks.length} 条 Hermes 状态检查记录`}
                          aria-label={`清空最近 ${recentHermesChecks.length} 条 Hermes 状态检查记录`}
                          className="text-slate-400 underline hover:text-slate-200"
                        >
                          清空记录
                        </button>
                      </div>
                      <div className="mt-1 space-y-1 text-xs">
                        {recentHermesChecks.map(item => (
                          <div key={`${item.at}-${item.durationMs}`} className="flex flex-wrap gap-x-2 gap-y-0.5">
                            <span className="text-slate-500">{new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                            <span className={item.ok ? 'text-emerald-200' : 'text-rose-200'}>{item.ok ? '成功' : '失败'}</span>
                            <span className={item.durationMs > 3000 ? 'text-amber-200' : 'text-slate-400'}>{item.durationMs} ms</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    <span className="rounded border border-white/10 bg-slate-950/35 px-2 py-1 text-slate-300">云端 {hermesStatus?.summary?.remoteCount ?? 0} 个</span>
                    <span className="rounded border border-white/10 bg-slate-950/35 px-2 py-1 text-emerald-200">网页已接入 {hermesStatus?.summary?.matchedCount ?? 0} 个</span>
                    <span className="rounded border border-white/10 bg-slate-950/35 px-2 py-1 text-amber-200">未匹配 {hermesStatus?.summary?.missingCount ?? profiles.length} 个</span>
                    <button
                      type="button"
                      onClick={() => updateScopeFilter('待同步差异')}
                      title={`筛选待同步差异专业，共 ${hermesStatus?.summary?.driftCount ?? 0} 个`}
                      aria-label={`筛选待同步差异专业，共 ${hermesStatus?.summary?.driftCount ?? 0} 个，${hermesActionSummary}`}
                      className="rounded border border-orange-300/25 bg-slate-950/35 px-2 py-1 text-orange-200 hover:border-orange-300/50 hover:bg-orange-500/10"
                    >
                      待同步差异 {hermesStatus?.summary?.driftCount ?? 0} 个
                    </button>
                  </div>
                  {latestHermesProfileSync && (
                    <div className="mt-2 text-xs text-slate-400">
                      最近同步：{latestHermesProfileSync.actor || '未知账号'} · {latestHermesProfileSync.at || '时间未记录'} · 变化 {latestHermesProfileSync.changedProfileCount || 0} 个专业
                    </div>
                  )}
                  {latestHermesProfileStatusCheck && (
                    <div className="mt-1 text-xs text-slate-400">
                      最近接入检查：{latestHermesProfileStatusCheck.actor || '未知账号'} · {latestHermesProfileStatusCheck.checkedAt || latestHermesProfileStatusCheck.at || '时间未记录'} · {latestHermesProfileStatusCheck.result || '结果未记录'} · 匹配 {latestHermesProfileStatusCheck.matchedCount || 0} / 缺失 {latestHermesProfileStatusCheck.missingCount || 0} / 差异 {latestHermesProfileStatusCheck.driftCount || 0}
                    </div>
                  )}
                  {latestHermesProfileImport && (
                    <div className="mt-1 text-xs text-slate-400">
                      最近导入：{latestHermesProfileImport.actor || '未知账号'} · {latestHermesProfileImport.at || '时间未记录'} · 变化 {latestHermesProfileImport.changedProfileCount || 0} 个专业
                    </div>
                  )}
                  {latestHermesProfileManualEdit && (
                    <div className="mt-1 text-xs text-slate-400">
                      最近人工编辑：{latestHermesProfileManualEdit.actor || '未知账号'} · {latestHermesProfileManualEdit.at || '时间未记录'} · {latestHermesProfileManualEdit.profileCode || latestHermesProfileManualEdit.profileId || '专业未记录'}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={copyHermesStatusDiagnosis}
                  disabled={!hermesStatus}
                  title={`复制 Hermes Profile 状态诊断，${hermesActionSummary}`}
                  aria-label={`复制 Hermes Profile 状态诊断，${hermesActionSummary}`}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-cyan-300/35 bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-50 text-sm text-cyan-100"
                >
                  <Copy size={15} />
                  复制状态诊断
                </button>
                <button
                  type="button"
                  onClick={copyHermesHealthAction}
                  disabled={!hermesStatus}
                  title={`复制 Hermes Profile 处理建议，${hermesHealth.action}`}
                  aria-label={`复制 Hermes Profile 处理建议，当前状态 ${hermesHealth.label}，建议：${hermesHealth.action}`}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-cyan-300/35 bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-50 text-sm text-cyan-100"
                >
                  <Copy size={15} />
                  复制处理建议
                </button>
                <button
                  type="button"
                  onClick={openHermesConfigLogs}
                  title="查看 Hermes Profile 配置相关日志"
                  aria-label="查看 Hermes Profile 配置相关日志"
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-violet-300/35 bg-violet-500/10 hover:bg-violet-500/20 text-sm text-violet-100"
                >
                  <History size={15} />
                  查看配置日志
                </button>
                <button
                  type="button"
                  onClick={copyHermesDriftSummary}
                  disabled={(hermesStatus?.summary?.driftCount || 0) === 0}
                  title={`复制 ${hermesStatus?.summary?.driftCount || 0} 个 Hermes Profile 待同步差异`}
                  aria-label={`复制 ${hermesStatus?.summary?.driftCount || 0} 个 Hermes Profile 待同步差异，${hermesActionSummary}`}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-orange-300/35 bg-orange-500/10 hover:bg-orange-500/20 disabled:opacity-50 text-sm text-orange-100"
                >
                  <Copy size={15} />
                  复制待同步差异
                </button>
                {latestHermesProfileSync && (
                  <button
                    type="button"
                    onClick={copyLatestHermesSync}
                    title={`复制最近一次 Hermes 云端同步摘要，变化 ${latestHermesProfileSync.changedProfileCount || 0} 个专业`}
                    aria-label={`复制最近一次 Hermes 云端同步摘要，操作人 ${latestHermesProfileSync.actor || '未知账号'}，变化 ${latestHermesProfileSync.changedProfileCount || 0} 个专业`}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-blue-300/35 bg-blue-500/10 hover:bg-blue-500/20 text-sm text-blue-100"
                  >
                    <Copy size={15} />
                    复制最近同步
                  </button>
                )}
                {latestHermesProfileStatusCheck && (
                  <button
                    type="button"
                    onClick={copyLatestHermesStatusCheck}
                    title={`复制最近一次 Hermes Profile 接入检查摘要，结果 ${latestHermesProfileStatusCheck.result || '未记录'}`}
                    aria-label={`复制最近一次 Hermes Profile 接入检查摘要，结果 ${latestHermesProfileStatusCheck.result || '未记录'}，匹配 ${latestHermesProfileStatusCheck.matchedCount || 0} 个，缺失 ${latestHermesProfileStatusCheck.missingCount || 0} 个，差异 ${latestHermesProfileStatusCheck.driftCount || 0} 个`}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-blue-300/35 bg-blue-500/10 hover:bg-blue-500/20 text-sm text-blue-100"
                  >
                    <Copy size={15} />
                    复制最近检查
                  </button>
                )}
                {latestHermesProfileImport && (
                  <button
                    type="button"
                    onClick={copyLatestHermesImport}
                    title={`复制最近一次 Hermes Profile JSON 导入摘要，变化 ${latestHermesProfileImport.changedProfileCount || 0} 个专业`}
                    aria-label={`复制最近一次 Hermes Profile JSON 导入摘要，操作人 ${latestHermesProfileImport.actor || '未知账号'}，变化 ${latestHermesProfileImport.changedProfileCount || 0} 个专业`}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-blue-300/35 bg-blue-500/10 hover:bg-blue-500/20 text-sm text-blue-100"
                  >
                    <Copy size={15} />
                    复制最近导入
                  </button>
                )}
                {latestHermesProfileManualEdit && (
                  <button
                    type="button"
                    onClick={copyLatestHermesManualEdit}
                    title={`复制最近一次 Hermes Profile 人工编辑摘要，专业 ${latestHermesProfileManualEdit.profileName || latestHermesProfileManualEdit.profileId || '未记录'}`}
                    aria-label={`复制最近一次 Hermes Profile 人工编辑摘要，专业 ${latestHermesProfileManualEdit.profileName || latestHermesProfileManualEdit.profileId || '未记录'}，变化字段 ${(latestHermesProfileManualEdit.changedFields || []).join('、') || '未记录'}`}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-blue-300/35 bg-blue-500/10 hover:bg-blue-500/20 text-sm text-blue-100"
                  >
                    <Copy size={15} />
                    复制最近人工编辑
                  </button>
                )}
                <button
                  type="button"
                  onClick={copyProfiles}
                  disabled={loading || profiles.length === 0}
                  title={`复制 ${profiles.length} 个 Hermes Profile 配置摘要`}
                  aria-label={`复制 ${profiles.length} 个 Hermes Profile 配置摘要`}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-blue-300/35 bg-blue-500/10 hover:bg-blue-500/20 disabled:opacity-50 text-sm text-blue-100"
                >
                  <Copy size={15} />
                  复制配置摘要
                </button>
                <button
                  type="button"
                  onClick={exportProfiles}
                  disabled={exportingProfiles || loading || profiles.length === 0}
                  title={`${exportingProfiles ? '正在导出' : '导出'} ${profiles.length} 个 Hermes Profile JSON 配置`}
                  aria-label={`${exportingProfiles ? '正在导出' : '导出'} ${profiles.length} 个 Hermes Profile JSON 配置`}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-blue-300/35 bg-blue-500/10 hover:bg-blue-500/20 disabled:opacity-50 text-sm text-blue-100"
                >
                  <Download size={15} />
                  {exportingProfiles ? '导出中...' : '导出 JSON'}
                </button>
                <button
                  type="button"
                  onClick={() => importInputRef.current?.click()}
                  disabled={previewingImport || importingProfiles}
                  title={previewingImport ? '正在校验 Hermes Profile JSON 导入文件' : '选择 Hermes Profile JSON 文件并生成导入预览'}
                  aria-label={previewingImport ? '正在校验 Hermes Profile JSON 导入文件' : '选择 Hermes Profile JSON 文件并生成导入预览'}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-blue-300/35 bg-blue-500/10 hover:bg-blue-500/20 disabled:opacity-50 text-sm text-blue-100"
                >
                  <Upload size={15} />
                  {previewingImport ? '校验中...' : '导入 JSON'}
                </button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={event => previewProfileImport(event.target.files?.[0])}
                  aria-label="选择 Hermes Profile JSON 导入文件"
                />
                <button
                  type="button"
                  onClick={previewHermesSync}
                  disabled={previewingHermesSync || syncingHermes || loadingHermes || !hermesStatus || hermesStatus.ok === false || hermesStatus.enabled === false || hermesStatusStale}
                  title={`${previewingHermesSync ? '正在预览' : '预览'} Hermes 云端同步，${hermesActionSummary}`}
                  aria-label={`${previewingHermesSync ? '正在预览' : '预览'} Hermes 云端同步，${hermesActionSummary}`}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-emerald-300/35 bg-emerald-500/10 hover:bg-emerald-500/20 disabled:opacity-50 text-sm text-emerald-100"
                >
                  <Cloud size={15} />
                  {previewingHermesSync ? '预览中...' : '预览云端同步'}
                </button>
                <button
                  type="button"
                  onClick={() => loadHermesStatus({ audit: true })}
                  disabled={loadingHermes}
                  title={`${loadingHermes ? '正在刷新' : '刷新'} Hermes Profile 状态，${hermesActionSummary}`}
                  aria-label={`${loadingHermes ? '正在刷新' : '刷新'} Hermes Profile 状态，${hermesActionSummary}`}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-cyan-300/35 bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-50 text-sm text-cyan-100"
                >
                  <RefreshCw size={15} className={loadingHermes ? 'animate-spin' : ''} />
                  {loadingHermes ? '刷新中...' : '刷新状态'}
                </button>
                <label className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/25 bg-cyan-500/5 px-3 py-1.5 text-sm text-cyan-100" htmlFor={autoRefreshHermesInputId}>
                  <input
                    id={autoRefreshHermesInputId}
                    type="checkbox"
                    checked={autoRefreshHermes}
                    onChange={event => setAutoRefreshHermes(event.target.checked)}
                    title={`${autoRefreshHermes ? '关闭' : '开启'} Hermes Profile 5 分钟自动刷新`}
                    aria-label={`${autoRefreshHermes ? '关闭' : '开启'} Hermes Profile 5 分钟自动刷新，${hermesActionSummary}`}
                    className="h-4 w-4 rounded border-cyan-300/40 bg-slate-900 text-cyan-500"
                  />
                  5 分钟自动刷新
	                </label>
	              </div>
	              <div className="mt-3 rounded-lg border border-blue-400/20 bg-blue-500/10 px-3 py-2 text-xs leading-5 text-blue-100">
	                Hermes Profile 导入仅支持系统导出的 JSON 文件；导入前会先生成差异预览，确认后才会覆盖网页配置。
	              </div>
	            </div>
	          </div>

          {hermesSyncPreview && (
            <div className="mb-5 rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-emerald-100">云端同步预览</div>
                  <div className={`mt-1 text-sm ${hermesSyncPreview.changedProfileCount > 0 ? 'text-amber-200' : 'text-emerald-200'}`}>
                    {hermesSyncPreview.changedProfileCount > 0
                      ? `将覆盖 ${hermesSyncPreview.changedProfileCount} 个专业 Profile`
                      : '云端配置与网页配置一致，无需同步'}
                  </div>
                  <div className={`mt-1 text-xs ${hermesSyncPreviewStale ? 'text-rose-200' : 'text-slate-400'}`}>
                    预览生成：{new Date(hermesSyncPreview.generatedAt).toLocaleString('zh-CN', { hour12: false })}
                    {hermesSyncPreviewStale ? ' · 已超过 10 分钟，请重新生成预览' : ' · 10 分钟内有效'}
                  </div>
                  {hermesSyncPreview.changes?.length > 0 && (
                    <div className="mt-2 space-y-1 text-xs text-slate-300">
                      {hermesSyncPreview.changes.map(change => (
                        <div key={change.id}>{change.code} {change.name}：{change.changedFields.join('、')}</div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={syncHermesProfiles}
                    disabled={syncingHermes || hermesSyncPreviewStale || hermesStatusStale || hermesStatus?.ok === false || (hermesSyncPreview.changedProfileCount || 0) === 0}
                    title={`${syncingHermes ? '正在同步' : '确认同步'} Hermes 云端 Profile，${hermesSyncPreviewSummary}`}
                    aria-label={`${syncingHermes ? '正在同步' : '确认同步'} Hermes 云端 Profile，${hermesSyncPreviewSummary}`}
                    className="inline-flex items-center gap-2 rounded-lg border border-emerald-300/35 bg-emerald-500/15 px-3 py-1.5 text-sm text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-50"
                  >
                    <Cloud size={15} />
                    {syncingHermes ? '同步中...' : '确认同步'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setHermesSyncPreview(null)}
                    disabled={syncingHermes}
                    title="取消当前 Hermes 云端同步预览"
                    aria-label={`取消当前 Hermes 云端同步预览，${hermesSyncPreviewSummary}`}
                    className="rounded-lg border border-slate-500/35 bg-slate-900/60 px-3 py-1.5 text-sm text-slate-300 hover:text-white disabled:opacity-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          )}

          {importPreview && (
            <div className="mb-5 rounded-lg border border-cyan-400/25 bg-cyan-500/10 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-cyan-100">导入预览已通过</div>
                  <div className="mt-1 text-sm text-slate-300">
                    Profile {importPreview.profileCount || 0} 个 · 启用 {importPreview.enabledCount || 0} 个 · 内部运营 {importPreview.internalEnabledCount || 0} 个 · 市场拓展 {importPreview.marketEnabledCount || 0} 个
                  </div>
                  <div className="mt-1 text-xs text-slate-400">立项牵头：{importPreview.initiatorName || '未配置'}</div>
                  <div className={`mt-2 text-sm ${importPreview.changedProfileCount > 0 ? 'text-amber-200' : 'text-emerald-200'}`}>
                    {importPreview.changedProfileCount > 0
                      ? `将修改 ${importPreview.changedProfileCount} 个专业 Profile`
                      : '导入文件与当前配置一致，无需覆盖'}
                  </div>
                  {importPreview.changes?.length > 0 && (
                    <div className="mt-2 space-y-1 text-xs text-slate-300">
                      {importPreview.changes.map(change => (
                        <div key={change.id}>{change.code} {change.name}：{change.changedFields.join('、')}</div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={importProfiles}
                    disabled={importingProfiles || (importPreview.changedProfileCount || 0) === 0}
                    title={`${importingProfiles ? '正在导入' : '确认导入'} Hermes Profile JSON，${importPreviewSummary}，执行前需要输入“确认导入”`}
                    aria-label={`${importingProfiles ? '正在导入' : '确认导入'} Hermes Profile JSON，${importPreviewSummary}，执行前需要输入“确认导入”`}
                    className="inline-flex items-center gap-2 rounded-lg border border-emerald-300/35 bg-emerald-500/15 px-3 py-1.5 text-sm text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-50"
                  >
                    <Upload size={15} />
                    {importingProfiles ? '导入中...' : '确认导入'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setImportFile(null)
                      setImportPreview(null)
                    }}
                    disabled={importingProfiles}
                    title={`取消 Hermes Profile JSON 导入预览，${importPreviewSummary}`}
                    aria-label={`取消 Hermes Profile JSON 导入预览，${importPreviewSummary}`}
                    className="rounded-lg border border-slate-500/35 bg-slate-900/60 px-3 py-1.5 text-sm text-slate-300 hover:text-white disabled:opacity-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
            <button type="button" onClick={() => updateScopeFilter('内部运营')} title={scopeFilterLabel('内部运营')} aria-label={scopeFilterLabel('内部运营')} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4 text-left transition hover:-translate-y-0.5 hover:border-white/25">
              <div className="text-xs text-slate-500">内部运营可用机器人</div>
              <div className="mt-2 text-2xl font-bold text-blue-100">{internalCount}</div>
              <div className="mt-1 text-xs text-slate-400">当前会参与内部运营并行审核</div>
              <div className="mt-3 text-xs text-blue-300">点击筛选内部运营机器人</div>
            </button>
            <button type="button" onClick={() => updateScopeFilter('市场拓展')} title={scopeFilterLabel('市场拓展')} aria-label={scopeFilterLabel('市场拓展')} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4 text-left transition hover:-translate-y-0.5 hover:border-white/25">
              <div className="text-xs text-slate-500">市场拓展会审机器人</div>
              <div className="mt-2 text-2xl font-bold text-cyan-200">{marketCount}</div>
              <div className="mt-1 text-xs text-slate-400">不含立项牵头角色</div>
              <div className="mt-3 text-xs text-blue-300">点击筛选市场拓展机器人</div>
            </button>
            <button type="button" onClick={() => updateScopeFilter('立项牵头')} title={scopeFilterLabel('立项牵头')} aria-label={scopeFilterLabel('立项牵头')} className={`rounded-lg border p-4 text-left transition hover:-translate-y-0.5 ${
              hasInitiator
                ? 'border-emerald-400/20 bg-emerald-500/10 hover:border-emerald-300/45'
                : 'border-red-400/20 bg-red-500/10 hover:border-red-300/45'
            }`}>
              <div className="text-xs text-slate-500">立项牵头状态</div>
              <div className={`mt-2 text-lg font-bold ${hasInitiator ? 'text-emerald-200' : 'text-red-200'}`}>
                {hasInitiator ? '已配置' : '缺失'}
              </div>
              <div className="mt-1 text-xs text-slate-400">市场拓展方案生成立项报告所需</div>
              <div className={`mt-3 text-xs ${hasInitiator ? 'text-emerald-300' : 'text-red-200'}`}>点击查看立项牵头机器人</div>
            </button>
          </div>

          <div className="flex flex-wrap gap-2 mb-5">
            {['全部', '内部运营', '市场拓展', '立项牵头', '待同步差异'].map(scope => (
              <button
                key={scope}
                type="button"
                onClick={() => updateScopeFilter(scope)}
                title={scopeFilterLabel(scope)}
                aria-label={scopeFilterLabel(scope)}
                className={`px-3 py-1.5 rounded-lg border text-sm transition ${
                  scopeFilter === scope
                    ? 'border-cyan-300/60 bg-cyan-500/15 text-cyan-100'
                    : 'border-blue-500/25 bg-slate-900/60 text-slate-300 hover:border-blue-300/40'
                }`}
              >
                {scope}
              </button>
            ))}
          </div>

          {scopeFilter !== '全部' && (
            <div className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-3">
              <div className="text-sm text-slate-300">当前筛选：机器人范围为“{scopeFilter}”</div>
              <button type="button" onClick={() => updateScopeFilter('全部')} title={`清除 Hermes Profile 范围筛选，${profileFilterSummary}`} aria-label={`清除 Hermes Profile 范围筛选，${profileFilterSummary}`} className="text-xs text-blue-300 hover:text-blue-200">清除筛选</button>
            </div>
          )}

          {loading ? (
            <div className="text-center py-12 text-slate-400">加载中...</div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {filteredProfiles.map(profile => (
                (() => {
                  const hermesProfile = hermesProfileMap.get(profile.id)
                  return (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => updateSelectedProfile(profile.id)}
                  title={profileCardLabel(profile)}
                  aria-label={profileCardLabel(profile)}
                  className={`text-left rounded-lg border p-4 transition ${
                    selectedId === profile.id
                      ? 'border-cyan-300/70 bg-cyan-500/10 shadow-cyan'
                      : 'border-blue-500/25 bg-slate-900/65 hover:border-cyan-300/50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="h-12 w-12 rounded-lg bg-blue-500/15 border border-blue-300/40 grid place-items-center shrink-0">
                        <Bot className="text-blue-200" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs text-slate-500">{profile.code} · {profile.hermesName}</div>
                        <div className="font-semibold text-blue-100 truncate">{profile.name}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                          <span className={profile.definitionVerified && profile.status === '启用' ? 'text-emerald-400' : profile.status === '启用' ? 'text-amber-300' : 'text-slate-500'}>● {profile.onlineLabel || (profile.status === '启用' ? '启用待核验' : '停用')}</span>
                          <span className="text-cyan-300">{profile.tag}</span>
                          <span className={hermesProfile?.drifted ? 'text-orange-300' : hermesProfile?.matched ? 'text-emerald-300' : 'text-amber-300'}>
                            {hermesProfile?.drifted ? 'Hermes 有差异' : hermesProfile?.matched ? 'Hermes 已对接' : 'Hermes 未匹配'}
                          </span>
                        </div>
                        {hermesProfile?.changedFields?.length > 0 && (
                          <div className="mt-1 text-xs text-orange-200">待同步：{hermesProfile.changedFields.join('、')}</div>
                        )}
                      </div>
                    </div>
                    <StatusBadge status={profile.status} />
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                    <div className="rounded-lg border border-blue-500/15 bg-slate-950/50 px-3 py-2">
                      <div className="text-slate-500">内部运营</div>
                      <div className={profile.internalEnabled ? 'text-emerald-300 mt-1' : 'text-slate-400 mt-1'}>{profile.internalEnabled ? '参与审核' : '已关闭'}</div>
                    </div>
                    <div className="rounded-lg border border-blue-500/15 bg-slate-950/50 px-3 py-2">
                      <div className="text-slate-500">市场拓展</div>
                      <div className={profile.marketEnabled ? 'text-emerald-300 mt-1' : 'text-slate-400 mt-1'}>{profile.marketEnabled ? '参与审核' : '已关闭'}</div>
                    </div>
                  </div>

                  <p className="mt-3 text-xs leading-5 text-slate-400 line-clamp-2">{profile.scope}</p>
                </button>
                  )
                })()
              ))}
            </div>
          )}
        </Panel>
        <Panel className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <History size={18} className="text-cyan-300" />
              <div>
                <h2 className="font-semibold text-blue-100">Profile 配置变更时间线</h2>
                <div className="mt-1 text-xs text-slate-500">
                  当前载入最近 {configHistory.length}/{configHistoryLimit} 条配置与审计记录
                  {configHistoryLoadedAt ? ` · 最后刷新 ${new Date(configHistoryLoadedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}
                  {configHistoryLoadDurationMs !== null && (
                    <span className={
                      configHistoryLoadStatusInfo.level === 'slow'
                        ? 'text-rose-300'
                        : configHistoryLoadStatusInfo.level === 'warning'
                          ? 'text-amber-300'
                          : 'text-emerald-300'
                    }>
                      {' '}· 用时 {configHistoryLoadDurationMs} ms · {configHistoryLoadStatusInfo.label}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <select
              value={configHistoryRequestLimit}
              onChange={event => updateConfigHistoryRequestLimit(Number(event.target.value))}
              className="rounded-lg border border-blue-500/25 bg-slate-900/60 px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-cyan-300/60"
              title="调整时间线载入范围"
            >
              <option value={12}>最近 12 条</option>
              <option value={50}>最近 50 条</option>
              <option value={100}>最近 100 条</option>
            </select>
            <button
              type="button"
              onClick={refreshConfigHistory}
              disabled={loading || refreshingConfigHistory}
              className="inline-flex items-center gap-2 rounded-lg border border-blue-300/35 bg-blue-500/10 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-500/20 disabled:opacity-50"
            >
              <RefreshCw size={15} className={refreshingConfigHistory ? 'animate-spin' : ''} />
              刷新时间线
            </button>
            <button
              type="button"
              onClick={copyConfigHistory}
              disabled={visibleConfigHistory.length === 0}
              className="inline-flex items-center gap-2 rounded-lg border border-blue-300/35 bg-blue-500/10 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-500/20 disabled:opacity-50"
            >
              <Copy size={15} />
              复制时间线摘要
            </button>
            <button
              type="button"
              onClick={exportConfigHistory}
              disabled={exportingConfigHistory || visibleConfigHistory.length === 0}
              className="inline-flex items-center gap-2 rounded-lg border border-blue-300/35 bg-blue-500/10 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-500/20 disabled:opacity-50"
            >
              <Download size={15} />
              {exportingConfigHistory ? '导出中...' : '导出审计 JSON'}
            </button>
            <button
              type="button"
              onClick={() => auditVerifyInputRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg border border-blue-300/35 bg-blue-500/10 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-500/20"
            >
              <Upload size={15} />
              校验审计 JSON
            </button>
            <input
              ref={auditVerifyInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={event => verifyConfigHistoryExport(event.target.files?.[0])}
            />
            {latestConfigHistoryExport && (
              <button
                type="button"
                onClick={copyConfigHistoryExportReceipt}
                className="inline-flex items-center gap-2 rounded-lg border border-emerald-300/35 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-100 hover:bg-emerald-500/20"
              >
                <Copy size={15} />
                复制校验说明
              </button>
            )}
          </div>
          {latestConfigHistoryExport && (
            <div className="mb-4 rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
              最近导出：{latestConfigHistoryExport.filename} · {latestConfigHistoryExport.count} 条 · 最近 {latestConfigHistoryExport.filters?.historyLimit || '未知'} 条范围 · 摘要来源 {configHistorySummarySource(latestConfigHistoryExport.filters || {})} · {latestConfigHistoryExport.filters?.loadStatus || '未判断'} · SHA-256 {latestConfigHistoryExport.contentHash.slice(0, 12)}
            </div>
          )}
          {latestConfigHistoryVerification && (
            <div className={`mb-4 rounded-lg border px-3 py-2 text-xs ${
              latestConfigHistoryVerification.ok
                ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100'
                : 'border-rose-400/25 bg-rose-500/10 text-rose-100'
            }`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  校验结果：{latestConfigHistoryVerification.ok ? '通过' : '不通过'} · 审计日志 {configHistoryAuditLogStatus(latestConfigHistoryVerification)} · {latestConfigHistoryVerification.filename} · {latestConfigHistoryVerification.count} 条 · 指纹状态 {configHistoryHashSummary(latestConfigHistoryVerification) || '未记录'} · 文件指纹 {latestConfigHistoryVerification.expectedHash?.slice(0, 12) || '未记录'} · 实算指纹 {latestConfigHistoryVerification.actualHash?.slice(0, 12) || '未记录'}
                  <span className="ml-1 text-slate-400">
                    · 筛选 {latestConfigHistoryVerification.filters?.type || '全部'}
                    {latestConfigHistoryVerification.filters?.profileFilterDisabled ? ' · 专业未参与' : latestConfigHistoryVerification.filters?.profileFilterActive ? ` · 专业 ${latestConfigHistoryVerification.filters?.profileName || latestConfigHistoryVerification.filters?.profileId || '未记录'}` : ' · 全部专业'}
                    {latestConfigHistoryVerification.filters?.keyword ? ` · 关键词“${latestConfigHistoryVerification.filters.keyword}”` : ''}
                    · 命中 {latestConfigHistoryVerification.filters?.matchedCount ?? latestConfigHistoryVerification.count}/{latestConfigHistoryVerification.filters?.totalCount ?? '未知'} 条
                    · 最近 {latestConfigHistoryVerification.filters?.historyLimit || '未知'} 条范围
                    · 摘要来源 {configHistorySummarySource(latestConfigHistoryVerification.filters || {}, latestConfigHistoryVerification.filterSummaryGenerated)}
                    · {latestConfigHistoryVerification.filters?.loadDurationMs ?? '未知'} ms
                    · {latestConfigHistoryVerification.filters?.loadStatus || '未判断'}
                    {(latestConfigHistoryVerification.sanitizedNumberFields || latestConfigHistoryVerification.filters?.sanitizedNumberFields || []).length > 0
                      ? ` · 已修正字段 ${(latestConfigHistoryVerification.sanitizedNumberFields || latestConfigHistoryVerification.filters?.sanitizedNumberFields || []).join('、')}`
                      : ''}
                    {latestConfigHistoryVerification.blockedReason ? ` · 拦截原因 ${latestConfigHistoryVerification.blockedReason}` : ''}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={copyConfigHistoryVerification}
                  className={`inline-flex items-center gap-1 rounded border px-2 py-1 ${
                    latestConfigHistoryVerification.ok
                      ? 'border-emerald-300/35 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20'
                      : 'border-rose-300/35 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20'
                  }`}
                >
                  <Copy size={12} />
                  复制校验结果
                </button>
              </div>
            </div>
          )}
          {auditVerificationStats.total > 0 && (
            <div className={`mb-4 rounded-lg border px-3 py-2 text-xs ${auditVerificationPanelClass(auditVerificationStats)}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block">
                    审计校验概览：共 {auditVerificationStats.total} 次 · 日志已记录 {auditVerificationStats.logRecorded} 次 · 日志已拦截 {auditVerificationStats.logBlocked} 次 · 通过 {auditVerificationStats.passed} 次 · 失败 {auditVerificationStats.failed} 次 · 校验拦截 {auditVerificationStats.blocked} 次 · 指纹正常 {auditVerificationStats.hashMatched} 次 · 指纹异常 {auditVerificationStats.hashMismatch} 次 · 指纹未记录 {auditVerificationStats.hashUnknown} 次 · 修正 {auditVerificationStats.sanitized} 次 · 回填 {auditVerificationStats.generatedSummary} 次
                    · 等级 {auditVerificationRiskLevel(auditVerificationStats)} · {auditVerificationRiskText(auditVerificationStats)}
                  </span>
                  <span className="mt-1 block truncate opacity-80">
                    最近校验：{auditVerificationStats.latest.result || '未记录'} · 日志 {configHistoryAuditLogStatus(auditVerificationStats.latest)} · {auditVerificationStats.latest.filename || '未记录文件'} · {auditVerificationStats.latest.at ? new Date(auditVerificationStats.latest.at).toLocaleString('zh-CN', { hour12: false }) : '未记录时间'}{auditLatestHashSummary ? ` · ${auditLatestHashSummary}` : ''}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={copyAuditVerificationStats}
                  className={`inline-flex items-center gap-1 rounded border px-2 py-1 ${auditVerificationButtonClass(auditVerificationStats)}`}
                >
                  <Copy size={12} />
                  复制概览
                </button>
                {auditVerificationStats.failed > 0 && (
                  <button
                    type="button"
                    onClick={() => focusAuditVerificationHistory('失败')}
                    className="inline-flex items-center gap-1 rounded border border-rose-300/35 bg-rose-500/10 px-2 py-1 text-rose-100 hover:bg-rose-500/20"
                  >
                    查看失败
                  </button>
                )}
                {auditVerificationStats.blocked > 0 && (
                  <button
                    type="button"
                    onClick={() => focusAuditVerificationHistory('拦截')}
                    className="inline-flex items-center gap-1 rounded border border-rose-300/35 bg-rose-500/10 px-2 py-1 text-rose-100 hover:bg-rose-500/20"
                  >
                    查看校验拦截
                  </button>
                )}
                {auditVerificationStats.logBlocked > 0 && (
                  <button
                    type="button"
                    onClick={() => focusAuditVerificationHistory('已拦截')}
                    className="inline-flex items-center gap-1 rounded border border-rose-300/35 bg-rose-500/10 px-2 py-1 text-rose-100 hover:bg-rose-500/20"
                  >
                    查看日志拦截
                  </button>
                )}
                {auditVerificationStats.logRecorded > 0 && (
                  <button
                    type="button"
                    onClick={() => focusAuditVerificationHistory('已记录')}
                    className="inline-flex items-center gap-1 rounded border border-emerald-300/35 bg-emerald-500/10 px-2 py-1 text-emerald-100 hover:bg-emerald-500/20"
                  >
                    查看日志记录
                  </button>
                )}
                {auditVerificationStats.hashMismatch > 0 && (
                  <button
                    type="button"
                    onClick={() => focusAuditVerificationHistory('指纹不一致')}
                    className="inline-flex items-center gap-1 rounded border border-rose-300/35 bg-rose-500/10 px-2 py-1 text-rose-100 hover:bg-rose-500/20"
                  >
                    查看指纹异常
                  </button>
                )}
                {auditVerificationStats.hashMatched > 0 && (
                  <button
                    type="button"
                    onClick={() => focusAuditVerificationHistory('指纹一致')}
                    className="inline-flex items-center gap-1 rounded border border-emerald-300/35 bg-emerald-500/10 px-2 py-1 text-emerald-100 hover:bg-emerald-500/20"
                  >
                    查看指纹正常
                  </button>
                )}
                {auditVerificationStats.hashUnknown > 0 && (
                  <button
                    type="button"
                    onClick={() => focusAuditVerificationHistory('指纹未记录')}
                    className="inline-flex items-center gap-1 rounded border border-amber-300/35 bg-amber-500/10 px-2 py-1 text-amber-100 hover:bg-amber-500/20"
                  >
                    查看指纹未记录
                  </button>
                )}
                {auditVerificationStats.sanitized > 0 && (
                  <button
                    type="button"
                    onClick={() => focusAuditVerificationHistory('已修正字段')}
                    className="inline-flex items-center gap-1 rounded border border-amber-300/35 bg-amber-500/10 px-2 py-1 text-amber-100 hover:bg-amber-500/20"
                  >
                    查看修正
                  </button>
                )}
                {auditVerificationStats.generatedSummary > 0 && (
                  <button
                    type="button"
                    onClick={() => focusAuditVerificationHistory('系统回填')}
                    className="inline-flex items-center gap-1 rounded border border-amber-300/35 bg-amber-500/10 px-2 py-1 text-amber-100 hover:bg-amber-500/20"
                  >
                    查看回填
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="mb-4 flex flex-wrap gap-2">
            {['全部', '接入检查', '云端同步', '同步预览', '同步拦截', '审计校验', 'JSON 导入', '人工编辑'].map(type => (
              <button
                key={type}
                type="button"
                onClick={() => updateConfigHistoryType(type)}
                className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                  configHistoryType === type
                    ? 'border-cyan-300/60 bg-cyan-500/15 text-cyan-100'
                    : 'border-blue-500/25 bg-slate-900/60 text-slate-300 hover:border-blue-300/40'
                }`}
              >
                {type} {configHistoryCounts[type] || 0}
              </button>
            ))}
            <div className="flex flex-col gap-1">
              <select
                value={configHistoryProfileId}
                onChange={event => setConfigHistoryProfileId(event.target.value)}
                disabled={configHistoryProfileFilterDisabled}
                title={configHistoryProfileFilterDisabled ? '当前时间线类型不按专业筛选' : '按专业筛选时间线记录'}
                className="rounded-lg border border-blue-500/25 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-cyan-300/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="全部">{configHistoryProfileFilterDisabled ? '非专业事件' : '全部专业'}</option>
                {profiles.map(profile => (
                  <option key={profile.id} value={profile.id}>{profile.code} {profile.name}</option>
                ))}
              </select>
              <span className={`text-[11px] ${configHistoryProfileFilterDisabled ? 'text-slate-500' : 'text-slate-600'}`}>
                {configHistoryProfileFilterDisabled ? '该类型不按专业筛选' : '可按专业筛选'}
              </span>
            </div>
            <label className="flex min-w-[180px] flex-1 items-center gap-2 rounded-lg border border-blue-500/25 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-300 focus-within:border-cyan-300/60" htmlFor={configHistoryKeywordInputId}>
              <Search size={14} className="shrink-0 text-slate-500" aria-hidden="true" />
              <input
                id={configHistoryKeywordInputId}
                value={configHistoryKeyword}
                onChange={event => setConfigHistoryKeyword(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-slate-200 outline-none placeholder:text-slate-500"
                placeholder="搜索操作人、专业或字段"
              />
            </label>
            {configHistoryFiltered && (
              <button
                type="button"
                onClick={clearConfigHistoryFilter}
                className="rounded-lg border border-slate-500/35 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-300 hover:text-white"
              >
                清除筛选
              </button>
            )}
            {auditQuickFilterActive && (
              <button
                type="button"
                onClick={returnAuditVerificationOverview}
                className="rounded-lg border border-cyan-300/35 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/20"
              >
                返回审计概览
              </button>
            )}
          </div>
          {configHistoryFiltered && (
            <div className="mb-4 rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-2 text-xs text-slate-300">
              当前筛选：{configHistoryFilterSummary}
            </div>
          )}
          {visibleConfigHistory.length === 0 ? (
            <div className="text-sm text-slate-500">暂无 Profile 配置变更记录。</div>
          ) : (
            <div className="space-y-2">
              {visibleConfigHistory.map(item => (
                <div key={item.id} className="rounded-lg border border-blue-500/15 bg-slate-900/60 px-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-medium text-blue-100">{item.type}</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => copyConfigHistoryItem(item)}
                        className="inline-flex items-center gap-1 rounded border border-blue-300/25 bg-blue-500/10 px-2 py-1 text-xs text-blue-100 hover:bg-blue-500/20"
                      >
                        <Copy size={12} />
                        复制记录
                      </button>
                      <div className="text-xs text-slate-500">{item.at || '时间未记录'}</div>
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-slate-400">操作人：{item.actor || '未知账号'}</div>
                  <div className="mt-1 text-xs text-slate-300">
                    {item.type === '人工编辑'
                      ? (
                        <>
                          <button type="button" onClick={() => updateSelectedProfile(item.profileId)} className="text-cyan-300 hover:text-cyan-100">
                            {item.profileCode || ''} {item.profileName || ''}
                          </button>
                          ：{(item.changedFields || []).join('、') || '字段未记录'}
                        </>
                      )
                      : item.type === '接入检查'
                        ? `结果：${item.result || '未记录'} · 网页 ${item.webCount || 0} 个 · 云端 ${item.remoteCount || 0} 个 · 匹配 ${item.matchedCount || 0} 个 · 缺失 ${item.missingCount || 0} 个 · 差异 ${item.driftCount || 0} 个`
                      : item.type === '同步预览'
                        ? `结果：${item.result || '未记录'} · 变化专业：${item.changedProfileCount || 0} 个 · 令牌指纹：${item.previewTokenFingerprint || '未记录'}`
                          : item.type === '同步拦截'
                            ? `原因：${item.reason || '未记录'} · 令牌指纹：${item.previewTokenFingerprint || '未记录'}`
                            : item.type === '审计校验'
                            ? `结果：${item.result || '未记录'} · 审计日志 ${configHistoryAuditLogStatus(item)} · ${item.filename || '文件未记录'} · ${item.verifiedCount || 0} 条${item.reason ? ` · 拦截原因 ${item.reason}` : ''} · 指纹状态 ${configHistoryHashSummary(item) || '未记录'} · 文件指纹 ${item.expectedHash || '未记录'} · 实算指纹 ${item.actualHash || '未记录'} · ${hermesConfigHistoryFilterText(item)}`
                      : `变化专业：${item.changedProfileCount || 0} 个`}
                  </div>
                  {item.type === '同步预览' && (
                    <div className="mt-1 text-xs text-slate-500">
                      生成：{item.generatedAt || '未记录'} · 过期：{item.expiresAt || '未记录'} · 云端 {item.remoteCount || 0} 个
                    </div>
                  )}
                  {item.type !== '人工编辑' && item.changes?.length > 0 && (
                    <div className="mt-2 space-y-1 border-t border-blue-500/10 pt-2 text-xs text-slate-400">
                      {item.changes.map(change => (
                        <div key={`${item.id}-${change.id}`}>
                          <button type="button" onClick={() => updateSelectedProfile(change.id)} className="text-cyan-300 hover:text-cyan-100">
                            {change.code} {change.name}
                          </button>
                          ：{(change.changedFields || []).join('、') || '字段未记录'}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </section>

      <aside className="col-span-12 xl:col-span-5 space-y-4">
        <Panel className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <Settings2 size={18} className="text-cyan-300" aria-hidden="true" />
            <h2 className="font-semibold text-blue-100">配置详情</h2>
          </div>

          {!selectedProfile || !form ? (
            <div className="text-sm text-slate-500">请选择审核机器人</div>
          ) : (
            <form onSubmit={saveProfile} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-1 gap-3">
                <label className="block" htmlFor={profileNameInputId}>
                  <span className="text-sm text-slate-300">机器人名称</span>
                  <input
                    id={profileNameInputId}
                    value={form.name}
                    onChange={e => updateForm('name', e.target.value)}
                    aria-label={`机器人名称，当前 Profile：${selectedProfile.name || '未命名'}`}
                    className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
                  />
                </label>

                <label className="block" htmlFor={profileHermesNameInputId}>
                  <span className="text-sm text-slate-300">Hermes 名称</span>
                  <input
                    id={profileHermesNameInputId}
                    value={form.hermesName}
                    onChange={e => updateForm('hermesName', e.target.value)}
                    aria-label={`Hermes 名称，当前 Profile：${selectedProfile.name || '未命名'}`}
                    className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
                  />
                </label>

                <label className="block" htmlFor={profileStatusInputId}>
                  <span className="text-sm text-slate-300">机器人状态</span>
                  <select
                    id={profileStatusInputId}
                    value={form.status}
                    onChange={e => updateForm('status', e.target.value)}
                    aria-label={`机器人状态，当前 Profile：${selectedProfile.name || '未命名'}`}
                    className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
                  >
                    <option value="启用">启用</option>
                    <option value="停用">停用</option>
                  </select>
                </label>
              </div>

              <label className="block" htmlFor={profileScopeInputId}>
                <span className="text-sm text-slate-300">审核范围</span>
                <textarea
                  id={profileScopeInputId}
                  value={form.scope}
                  onChange={e => updateForm('scope', e.target.value)}
                  rows={3}
                  aria-label={`审核范围，当前 Profile：${selectedProfile.name || '未命名'}`}
                  className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60 resize-none"
                />
              </label>

              <label className="block" htmlFor={profileOutputInputId}>
                <span className="text-sm text-slate-300">输出物</span>
                <textarea
                  id={profileOutputInputId}
                  value={form.output}
                  onChange={e => updateForm('output', e.target.value)}
                  rows={3}
                  aria-label={`输出物，当前 Profile：${selectedProfile.name || '未命名'}`}
                  className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60 resize-none"
                />
              </label>

              <label className="block" htmlFor={profileStandardsInputId}>
                <span className="text-sm text-slate-300">审核提示</span>
                <textarea
                  id={profileStandardsInputId}
                  value={form.standardsText}
                  onChange={e => updateForm('standardsText', e.target.value)}
                  rows={6}
                  aria-label={`审核提示，每行一条，当前 Profile：${selectedProfile.name || '未命名'}`}
                  className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60 resize-none"
                  placeholder="每行一条待核对的审核提示"
                />
              </label>

              <label className={`rounded-lg border px-3 py-3 flex items-start gap-3 ${form.standardsVerified ? 'border-emerald-400/25 bg-emerald-500/10' : 'border-amber-400/30 bg-amber-500/10'}`} htmlFor={profileStandardsVerifiedInputId}>
                <input
                  id={profileStandardsVerifiedInputId}
                  type="checkbox"
                  checked={form.standardsVerified}
                  onChange={e => updateForm('standardsVerified', e.target.checked)}
                  aria-label={`确认已核对《${selectedProfile.name || '未命名'}》完整 Profile 定义及正式依据`}
                  className="mt-1"
                />
                <div>
                  <div className="text-sm text-amber-100">已完成完整 Profile 定义核验</div>
                  <div className="mt-1 text-xs leading-5 text-slate-300">已核对名称、范围、输出物、提示、路由与排序的正式依据。系统会记录核验人、时间和定义指纹；任一物料变更都需重新核验。</div>
                </div>
              </label>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-3 flex items-start gap-3" htmlFor={profileInternalEnabledInputId}>
                  <input
                    id={profileInternalEnabledInputId}
                    type="checkbox"
                    checked={form.internalEnabled}
                    onChange={e => updateForm('internalEnabled', e.target.checked)}
                    aria-label={`是否参与内部运营审核，当前 Profile：${selectedProfile.name || '未命名'}`}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-sm text-blue-100">参与内部运营审核</div>
                    <div className="text-xs text-slate-400 mt-1">控制该机器人是否参与内部运营方案并行审核。</div>
                  </div>
                </label>

                <label className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-3 flex items-start gap-3" htmlFor={profileMarketEnabledInputId}>
                  <input
                    id={profileMarketEnabledInputId}
                    type="checkbox"
                    checked={form.marketEnabled}
                    onChange={e => updateForm('marketEnabled', e.target.checked)}
                    aria-label={`是否参与市场拓展审核，当前 Profile：${selectedProfile.name || '未命名'}`}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-sm text-blue-100">参与市场拓展审核</div>
                    <div className="text-xs text-slate-400 mt-1">控制该机器人是否参与市场拓展方案审核链路。</div>
                  </div>
                </label>
              </div>

              {selectedProfile.id === 'investment' && (
                <label className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-3 flex items-start gap-3" htmlFor={profileCanInitiateInputId}>
                  <input
                    id={profileCanInitiateInputId}
                    type="checkbox"
                    checked={form.canInitiate}
                    onChange={e => updateForm('canInitiate', e.target.checked)}
                    aria-label="是否保留市场拓展立项牵头能力，关闭后市场拓展方案无法生成待人工复核的初筛材料"
                    className="mt-1"
                  />
                  <div>
                    <div className="text-sm text-emerald-200">保留市场拓展立项牵头能力</div>
                    <div className="text-xs text-slate-400 mt-1">关闭后，市场拓展方案将无法生成待人工复核的立项初筛材料。</div>
                  </div>
                </label>
              )}

              {error && <div role="alert" className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>}
              {message && <div role="status" aria-live="polite" className="text-sm text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">{message}</div>}
              {selectedProfileChanges.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
                  <span>待保存变更：{selectedProfileChanges.join('、')}</span>
                  <button
                    type="button"
                    onClick={resetSelectedProfile}
                    title={`撤销《${selectedProfile.name || '当前 Profile'}》未保存改动：${selectedProfileChanges.join('、')}`}
                    aria-label={`撤销《${selectedProfile.name || '当前 Profile'}》未保存改动：${selectedProfileChanges.join('、')}`}
                    className="text-xs text-amber-100 hover:text-white"
                  >
                    撤销未保存改动
                  </button>
                </div>
              )}

              <button
                type="submit"
                disabled={saving || selectedProfileChanges.length === 0}
                title={selectedProfileSaveLabel}
                aria-label={selectedProfileSaveLabel}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm border border-blue-300/40"
              >
                <Save size={16} />
                {saving ? '保存中...' : '保存机器人配置'}
              </button>
            </form>
          )}
        </Panel>

        {selectedProfile && (
          <Panel className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles size={17} className="text-amber-300" />
              <h2 className="font-semibold text-blue-100">当前能力摘要</h2>
            </div>
            <div className="space-y-3 text-sm">
              <div className="rounded-lg border border-blue-500/15 bg-slate-900/60 p-3">
                <div className="flex items-center gap-2 text-slate-200 font-medium mb-2">
                  <BriefcaseBusiness size={16} className="text-cyan-300" />
                  审核范围
                </div>
                <p className="text-slate-400 leading-6">{selectedProfile.scope}</p>
              </div>

              <div className="rounded-lg border border-blue-500/15 bg-slate-900/60 p-3">
                <div className="flex items-center gap-2 text-slate-200 font-medium mb-2">
                  <CheckCircle2 size={16} className="text-emerald-300" />
                  输出物
                </div>
                <p className="text-slate-400 leading-6">{selectedProfile.output}</p>
              </div>

              <div className="rounded-lg border border-blue-500/15 bg-slate-900/60 p-3">
                <div className="flex items-center gap-2 text-slate-200 font-medium mb-2">
                  <BookOpenCheck size={16} className="text-amber-300" />
                  审核提示
                </div>
                <div className="flex flex-wrap gap-2">
                  {(selectedProfile.standards || []).map(item => (
                    <span key={item} className="px-2 py-1 rounded text-xs border border-blue-500/20 bg-blue-500/10 text-slate-300">
                      {item}
                    </span>
                  ))}
                </div>
                <div className={`mt-3 text-xs ${selectedProfile.definitionVerified ? 'text-emerald-200' : 'text-amber-200'}`}>
                  {selectedProfile.definitionVerified
                    ? `完整定义已核验：${selectedProfile.definitionVerifiedBy || '未记录'} · ${selectedProfile.definitionVerifiedAt || '未记录'} · 指纹 ${(selectedProfile.definitionVerifiedHash || '').slice(0, 12)}`
                    : '完整定义未核验：该 Profile 不参与审核，也不得作为自动通过或立项结论依据。'}
                </div>
              </div>
            </div>
          </Panel>
        )}
      </aside>
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
