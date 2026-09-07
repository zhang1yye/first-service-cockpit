import { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { BellRing, Bot, BriefcaseBusiness, Building2, CheckCircle2, Download, FileText, FolderKanban, ShieldAlert, Signature, Wrench } from '../lib/lucide.js'
import { api, getUser } from '../lib/api'
import { appVersion } from '../lib/appVersion'
import { copyText } from '../lib/clipboard'
import { hasPermission } from '../lib/permissions'
import { loadReviewCharts, preloadReviewCharts } from '../lib/chartPreload'
import { latestBusinessFreshness } from '../lib/businessTime'
import { preloadRoute } from '../lib/routePreload'
import CopyFallbackDialog from '../components/CopyFallbackDialog'
import Panel from '../components/Panel'
import lvzaiHero from '../assets/mascot/lvzai-full-static.png'

const pieColors = ['#bd1e2d', '#d76a73', '#8f5660', '#d88a1c', '#b8751d', '#2d8a5d', '#7a7f86', '#c92f3d']

const TrendAreaChart = lazy(() => loadReviewCharts().then(module => ({ default: module.TrendAreaChart })))
const ProfessionalPieChart = lazy(() => loadReviewCharts().then(module => ({ default: module.ProfessionalPieChart })))

function ChartLoading({ className = 'h-full' }) {
  return <div className={`${className} grid place-items-center text-sm text-slate-500`}>正在加载图表...</div>
}

function aiTraceLabel(trace = {}) {
  if (trace.fallback === true || trace.status === 'fallback') return '回退'
  if (trace.status === 'failed') return '失败'
  if (trace.status === 'success') return '成功'
  return '待人工复核'
}

function aiTraceLogResult(trace = {}) {
  const label = aiTraceLabel(trace)
  return label === '待人工复核' ? '待确认' : label
}

function aiTraceToneClass(trace = {}) {
  if (trace.fallback === true || trace.status === 'fallback') return 'border-amber-400/30 bg-amber-500/10 text-amber-200'
  if (trace.status === 'failed') return 'border-rose-400/30 bg-rose-500/10 text-rose-200'
  if (trace.status === 'success') return 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
  return 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200'
}

function robotReviewStatus(profile = {}) {
  const active = profile.status === '启用' && profile.definitionVerified === true
  return {
    active,
    label: active ? (profile.onlineLabel || '已启用且已核验') : profile.status === '启用' ? '启用待核验' : '停用'
  }
}

export default function HomeView() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [data, setData] = useState(null)
  const [dataError, setDataError] = useState('')
  const [message, setMessage] = useState('')
  const copyMessageTimerRef = useRef(null)
  const [copyFallback, setCopyFallback] = useState({ open: false, title: '', description: '', content: '' })

  const openStatsFocus = (focus) => navigate(`/stats?focus=${focus}`)
  const openSubmitterLogs = (submitter) => navigate(`/logs?type=执行动作&submitter=${encodeURIComponent(submitter)}`)
  const openSubmitterReview = (submitter) => navigate(`/review?submitter=${encodeURIComponent(submitter)}&sort=最新提交优先`)

  const loadData = useCallback(async () => {
    try {
      const res = await api.get('/dashboard')
      setData(res)
      setDataError('')
    } catch {
      setData({
        stats: { pending: 0, configurationPending: 0, passed: 0, needRevision: 0, onlineRobots: 0, totalRobots: 0, avgScore: null },
        robots: [],
        proposals: [],
        trend: [],
        logs: []
      })
      setDataError('审核驾驶舱数据加载失败，当前显示为空值；请重试，勿将空值视为真实业务数据。')
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  useEffect(() => () => window.clearTimeout(copyMessageTimerRef.current), [])

  const currentUser = getUser()
  const canReview = hasPermission(currentUser, 'reviewProposal')
  const canViewLogs = hasPermission(currentUser, 'viewLogs')
  const canManageSystem = hasPermission(currentUser, 'manageSystem')
  const canManageUsers = hasPermission(currentUser, 'manageUsers')
  const canViewSecurityOps = (canManageUsers || canManageSystem) && canViewLogs
  const canAccessOps = canManageSystem || canViewLogs || canManageUsers
  const notice = searchParams.get('notice') || ''
  const homeMode = canAccessOps && searchParams.get('mode') === 'ops' ? 'ops' : 'review'
  const homeTabRefs = useRef({})
  const visibleHomeModes = ['review', ...canAccessOps ? ['ops'] : []]

  const setHomeMode = (mode) => {
    const safeMode = mode === 'ops' && canAccessOps ? 'ops' : 'review'
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (safeMode === 'ops') next.set('mode', 'ops')
      else next.delete('mode')
      return next
    }, { replace: true })
  }

  const handleHomeTabKeyDown = (event, currentMode) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const currentIndex = visibleHomeModes.indexOf(currentMode)
    let nextIndex = currentIndex
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = visibleHomeModes.length - 1
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % visibleHomeModes.length
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + visibleHomeModes.length) % visibleHomeModes.length
    const nextMode = visibleHomeModes[nextIndex]
    setHomeMode(nextMode)
    window.requestAnimationFrame(() => homeTabRefs.current[nextMode]?.focus())
  }

  const dismissNotice = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('notice')
      return next
    }, { replace: true })
  }

  const stats = data?.stats || { pending: 0, configurationPending: 0, passed: 0, needRevision: 0, onlineRobots: 0, totalRobots: 0, avgScore: null }
  const enabledRobotCount = stats.enabledProfiles ?? 0
  const robots = data?.robots || []
  const proposals = data?.proposals || []
  const trend = data?.trend || []
  const logs = data?.logs || []
  const workflow = data?.workflow
  const userStats = data?.userStats
  const ruleStats = data?.ruleStats
  const executionStats = data?.executionStats || { reviewed: 0, pendingSignOff: 0, signed: 0, pendingArchive: 0, archived: 0 }
  const executionQueues = data?.executionQueues || {
    highRiskPendingReview: [],
    pendingSignOff: [],
    pendingArchive: [],
    recentReminders: [],
    overdueReminders: [],
    approachingReminders: []
  }
  const reminderStats = data?.reminderStats || {
    totalWithReminder: 0,
    totalNeedReminder: 0,
    autoCount: 0,
    manualCount: 0,
    noneCount: 0,
    bySource: [],
    byStage: [],
    pendingBySource: []
  }
  const reviewLogs = data?.reviewLogs || logs || []
  const executionLogs = data?.executionLogs || []
  const businessFreshness = useMemo(
    () => latestBusinessFreshness(proposals, data?.aiTraceStats || {}, executionLogs),
    [proposals, data?.aiTraceStats, executionLogs]
  )
  const exportStats = data?.exportStats || {
    total: 0,
    previewCount: 0,
    wordCount: 0,
    pdfCount: 0,
    proposalCount: 0,
    detailCount: 0,
    submitCount: 0,
    reviewCount: 0,
    lastExportAt: '',
    lastExporter: '',
    latestVersion: '',
    latestBuildTime: '',
    latestBuildLabel: '',
    bySource: [],
    recent: []
  }
  const attachmentStats = data?.attachmentStats || {
    total: 0,
    parsed: 0,
    failed: 0,
    unsupported: 0,
    pending: 0,
    parseRate: 0
  }
  const aiTraceStats = data?.aiTraceStats || {
    total: 0,
    successCount: 0,
    fallbackCount: 0,
    failedCount: 0,
    successRate: 0,
    avgDurationMs: 0,
    latestAt: '',
    latestProvider: '',
    latestModel: '',
    latestMode: '',
    latestModeName: '',
    recent: []
  }
  const securityStats = data?.securityStats || {
    total: 0,
    accountSecurityCount: 0,
    failureCount: 0,
    lockedOnlyCount: 0,
    interceptCount: 0,
    rejectedCount: 0,
    lockedCount: 0,
    uniqueIpCount: 0,
    latestFailureAt: '',
    latestFailureActor: '',
    latestFailureAction: '',
    latestFailureResult: '',
    latestAccountSecurityExport: null,
    latestAccountSecurityBulk: null,
    latestAccountSecurityNotice: null
  }
  const latestAccountSecurityExport = securityStats.latestAccountSecurityExport || null
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
  const latestAccountSecurityBulk = securityStats.latestAccountSecurityBulk || null
  const latestAccountSecurityBulkId = latestAccountSecurityBulk?.metadata?.auditId || ''
  const latestAccountSecurityNotice = securityStats.latestAccountSecurityNotice || null
  const latestAccountSecurityNoticeId = latestAccountSecurityNotice?.metadata?.auditId || ''
  const latestAccountSecurityBulkNeedsNotice = latestAccountSecurityBulk
    ? String(latestAccountSecurityBulk.action || '').includes('改密') ||
      Number(latestAccountSecurityBulk.metadata?.skippedAlreadyRequiredCount || 0) > 0
    : false
  const launchApprovalStats = data?.launchApprovalStats || {
    ok: false,
    status: 'none',
    statusText: '暂无确认',
    thresholdHours: 24,
    ageHours: 0,
    recordCount: 0,
    latest: null
  }
  const launchApprovalRiskSummary = launchApprovalStats.latest?.riskSummary || {}
  const launchApprovalRiskCount =
    Number(launchApprovalRiskSummary.riskCount) ||
    (Number(launchApprovalRiskSummary.defaultPassword) || 0) +
    (Number(launchApprovalRiskSummary.mustChangePassword) || 0) +
    (Number(launchApprovalRiskSummary.loginLocked) || 0)
  const accountRiskPath = (riskSummary = {}) => {
    if ((Number(riskSummary.defaultPassword) || 0) > 0) return '/users?password=默认密码&select=visible'
    if ((Number(riskSummary.mustChangePassword) || 0) > 0) return '/users?password=需改密&select=visible'
    if ((Number(riskSummary.loginLocked) || 0) > 0) return '/users?security=登录锁定&select=visible'
    return '/users'
  }
  const launchApprovalRiskActions = [
    (Number(launchApprovalRiskSummary.defaultPassword) || 0) > 0
      ? { label: `默认密码 ${launchApprovalRiskSummary.defaultPassword}`, to: '/users?password=默认密码&select=visible', className: 'border-red-300/30 text-red-100 hover:border-red-200/60' }
      : null,
    (Number(launchApprovalRiskSummary.mustChangePassword) || 0) > 0
      ? { label: `需改密 ${launchApprovalRiskSummary.mustChangePassword}`, to: '/users?password=需改密&select=visible', className: 'border-amber-300/30 text-amber-100 hover:border-amber-200/60' }
      : null,
    (Number(launchApprovalRiskSummary.loginLocked) || 0) > 0
      ? { label: `登录锁定 ${launchApprovalRiskSummary.loginLocked}`, to: '/users?security=登录锁定&select=visible', className: 'border-orange-300/30 text-orange-100 hover:border-orange-200/60' }
      : null
  ].filter(Boolean)
  const launchApprovalLogPath = '/logs?type=系统配置&actionGroup=上线确认&range=近30天'
  const launchApprovalPath = launchApprovalRiskCount > 0 && canManageUsers
    ? accountRiskPath(launchApprovalRiskSummary)
    : launchApprovalStats.latest
      ? launchApprovalLogPath
      : '/settings'
  const launchApprovalAgeText = launchApprovalStats.latest
    ? (launchApprovalStats.ageHours < 1 ? '1小时内' : launchApprovalStats.ageHours < 24 ? `${launchApprovalStats.ageHours}小时前` : `${Math.floor(launchApprovalStats.ageHours / 24)}天前`)
    : '尚未确认'
  const launchApprovalSubText = launchApprovalStats.latest
    ? launchApprovalRiskCount > 0
      ? `账号风险：默认密码 ${launchApprovalRiskSummary.defaultPassword || 0} · 需改密 ${launchApprovalRiskSummary.mustChangePassword || 0} · 登录锁定 ${launchApprovalRiskSummary.loginLocked || 0}`
      : launchApprovalStats.status === 'blocked' && launchApprovalStats.latest.reason
      ? `拦截原因：${launchApprovalStats.latest.reason}`
      : `${launchApprovalStats.latest.summary || '检查项未记录'} · ${launchApprovalAgeText} · 阈值 ${launchApprovalStats.thresholdHours || 24} 小时`
    : '进入设置页完成上线检查'
  const networkDiagnosticsStats = data?.networkDiagnosticsStats || {
    ok: false,
    status: 'none',
    statusText: '暂无诊断',
    recordCount: 0,
    latest: null
  }
  const networkDiagnosticsAgeText = networkDiagnosticsStats.latest
    ? (networkDiagnosticsStats.latest.at ? networkDiagnosticsStats.latest.at.slice(5, 16) : '时间未记录')
    : '尚未诊断'
  const networkDiagnosticsSubText = networkDiagnosticsStats.latest
    ? `${networkDiagnosticsStats.latest.domain || '域名未记录'} · ${networkDiagnosticsStats.latest.resolvedIps?.length ? networkDiagnosticsStats.latest.resolvedIps.join('、') : '解析未记录'} · ${networkDiagnosticsAgeText}`
    : '进入设置页刷新公网诊断'
  const securityLogPath = (result = '', keyword = '') => {
    const query = new URLSearchParams({ type: '账号安全' })
    if (result) query.set('result', result)
    if (keyword) query.set('q', keyword)
    return `/logs?${query.toString()}`
  }
  const latestFailureLogPath = securityStats.latestFailureAction
    ? securityLogPath(securityStats.latestFailureResult || '', securityStats.latestFailureAction)
    : securityLogPath(securityStats.latestFailureResult || '')
  const securitySplitText = `锁定 ${securityStats.lockedOnlyCount || 0} · 拦截 ${securityStats.interceptCount || 0} · 拒绝 ${securityStats.rejectedCount || 0} · IP ${securityStats.uniqueIpCount || 0}`
  const securityLatestLabel = securityStats.latestFailureResult
    ? `${securityStats.latestFailureResult} · ${securityStats.latestFailureActor || '未知账号'}`
    : `${securityStats.failureCount || 0} 个失败登录`
  const securityLatestSubText = securityStats.latestFailureAt
    ? `${securityStats.latestFailureAt}${securityStats.latestFailureAction ? ` · ${securityStats.latestFailureAction}` : ''}`
    : securitySplitText
  const accountSecurityExportLogPath = latestAccountSecurityExportId
    ? `/logs?type=${encodeURIComponent('账号安全')}&q=${encodeURIComponent(latestAccountSecurityExportId)}`
    : securityLogPath()
  const accountSecurityBulkLogPath = latestAccountSecurityBulkId
    ? `/logs?type=${encodeURIComponent('账号安全')}&q=${encodeURIComponent(latestAccountSecurityBulkId)}`
    : securityLogPath()
  const accountSecurityNoticeLogPath = latestAccountSecurityNoticeId
    ? `/logs?type=${encodeURIComponent('账号安全')}&q=${encodeURIComponent(latestAccountSecurityNoticeId)}`
    : securityLogPath()
  const accountRiskActionCards = [
    {
      key: 'default-password',
      label: '默认密码风险',
      value: userStats ? userStats.defaultPassword ?? 0 : null,
      desc: '进入人员管理并自动选中风险账号',
      to: '/users?password=默认密码&select=visible',
      toneClass: 'border-red-400/25 bg-red-500/10 text-red-100'
    },
    {
      key: 'must-change-password',
      label: '需改密账号',
      value: userStats ? userStats.mustChangePassword ?? 0 : null,
      desc: '进入人员管理并自动选中待处理账号',
      to: '/users?password=需改密&select=visible',
      toneClass: 'border-amber-400/25 bg-amber-500/10 text-amber-100'
    },
    {
      key: 'login-locked',
      label: '登录锁定账号',
      value: userStats ? userStats.loginLocked ?? 0 : null,
      desc: '进入人员管理并自动选中锁定账号',
      to: '/users?security=登录锁定&select=visible',
      toneClass: 'border-orange-400/25 bg-orange-500/10 text-orange-100'
    }
  ]
  const accountRiskOpenCount = userStats
    ? accountRiskActionCards.reduce((sum, card) => sum + (card.value || 0), 0)
    : null
  const executionCockpitCards = [
    {
      key: 'manualReview',
      label: '待人工复核高风险',
      value: executionQueues.highRiskPendingReview?.length || 0,
      sub: '优先处理高风险人工复核',
      to: '/review?queue=待人工复核高风险',
      toneClass: 'border-amber-500/20 text-amber-200',
      visible: canReview
    },
    {
      key: 'signOff',
      label: '待签发',
      value: executionStats.pendingSignOff || 0,
      sub: '已复核待签发',
      to: '/review?queue=已复核未签发',
      toneClass: 'border-emerald-500/20 text-emerald-200',
      visible: canReview
    },
    {
      key: 'archive',
      label: '待归档',
      value: executionStats.pendingArchive || 0,
      sub: '已签发待归档',
      to: '/review?queue=已签发未归档',
      toneClass: 'border-cyan-500/20 text-cyan-200',
      visible: canReview
    },
    {
      key: 'reminder',
      label: '建议催办',
      value: reminderStats.totalNeedReminder || 0,
      sub: '当前命中催办规则',
      to: '/review?needReminder=1',
      toneClass: 'border-violet-500/20 text-violet-200',
      visible: canReview
    },
    {
      key: 'export',
      label: '未导出方案',
      value: Math.max((stats.total || 0) - (exportStats.proposalCount || 0), 0),
      sub: '尚未形成意见书导出留痕',
      to: '/review?export=未导出&sort=最新提交优先',
      toneClass: 'border-slate-500/20 text-slate-200',
      visible: canReview
    }
  ].filter(item => item.visible)
  const executionEntryGroups = [
    {
      key: 'manual',
      label: '人工复核',
      value: executionLogs.filter(log => String(log.action || '').includes('人工复核') || String(log.action || '').includes('复核备注')).length,
      to: '/logs?type=执行动作&actionGroup=人工复核',
      visible: canViewLogs
    },
    {
      key: 'signArchive',
      label: '签发归档',
      value: executionLogs.filter(log => String(log.action || '').includes('签发') || String(log.action || '').includes('归档')).length,
      to: '/logs?type=执行动作&actionGroup=签发归档',
      visible: canViewLogs
    },
    {
      key: 'reminder',
      label: '催办',
      value: executionLogs.filter(log => String(log.action || '').includes('催办')).length,
      to: '/logs?type=执行动作&actionGroup=催办',
      visible: canViewLogs
    },
    {
      key: 'export',
      label: '导出',
      value: executionLogs.filter(log => String(log.action || '').includes('意见书') || String(log.action || '').includes('预览')).length,
      to: '/logs?type=执行动作&actionGroup=导出',
      visible: canViewLogs
    }
  ].filter(item => item.visible)
  const internalEnabledCount = workflow?.internal?.enabledCount || 0
  const marketReviewCount = workflow?.market?.reviewCount || 0
  const marketInitiatorName = workflow?.market?.initiatorName || '未配置立项牵头角色'
  const userRoleSummaryText = Array.isArray(userStats?.byRole) && userStats.byRole.length > 0
    ? userStats.byRole
      .filter(item => (Number(item.enabled) || 0) > 0)
      .map(item => `${item.role} ${item.enabled}`)
      .join(' · ')
    : `管理员 ${userStats?.admins || 0} 人`
  const systemOpsCards = [
    {
      key: 'users',
      label: '账号启用情况',
      value: `${userStats?.enabled || 0}/${userStats?.total || 0}`,
      sub: `${userRoleSummaryText || '暂无启用角色'} · 停用 ${userStats?.disabled || 0} 人 · 默认密码 ${userStats?.defaultPassword || 0} 人 · 需改密 ${userStats?.mustChangePassword || 0} 人`,
      valueClass: (userStats?.defaultPassword || 0) > 0 ? 'text-red-200' : (userStats?.mustChangePassword || 0) > 0 ? 'text-amber-200' : 'text-blue-100',
      to: (userStats?.defaultPassword || 0) > 0 ? '/users?password=默认密码&select=visible' : (userStats?.mustChangePassword || 0) > 0 ? '/users?password=需改密&select=visible' : '/users?status=启用',
      visible: canManageUsers
    },
    {
      key: 'accountSecurity',
      label: '账号安全',
      value: securityStats.latestFailureResult || (securityStats.lockedCount ? `${securityStats.lockedCount} 条异常` : `${securityStats.failureCount || 0} 次失败`),
      sub: securityStats.latestFailureAt ? `${securityStats.latestFailureActor || '未知账号'} · ${securityStats.latestFailureAt} · ${securitySplitText}` : securitySplitText,
      valueClass: (securityStats.failureCount || securityStats.lockedCount || 0) > 0 ? 'text-red-200' : 'text-emerald-200',
      to: latestFailureLogPath,
      visible: canViewSecurityOps
    },
    {
      key: 'rules',
      label: '启用规则',
      value: `${ruleStats?.enabled || 0}/${ruleStats?.total || 0}`,
      sub: `已停用 ${ruleStats?.disabled || 0} 条`,
      valueClass: 'text-cyan-200',
      to: '/rules?status=启用',
      visible: canManageSystem
    },
    {
      key: 'bots',
      label: '机器人会审能力',
      value: `${internalEnabledCount}/${marketReviewCount}`,
      sub: '内部运营 / 市场拓展会审',
      valueClass: 'text-emerald-200',
      to: '/bots?scope=内部运营',
      visible: canManageSystem
    },
    {
      key: 'export',
      label: '意见书导出',
      value: exportStats.total,
      sub: `当前 ${appVersion} · 最近构建 ${exportStats.latestBuildLabel || exportStats.latestVersion || '未记录版本'}`,
      valueClass: 'text-violet-200',
      to: '/stats?focus=export',
      visible: canViewLogs
    },
    {
      key: 'attachments',
      label: '附件解析率',
      value: attachmentStats.total > 0 ? `${attachmentStats.parseRate || 0}%` : '暂无附件',
      sub: attachmentStats.total > 0 ? `${attachmentStats.parsed || 0}/${attachmentStats.total} 已解析` : '无可计算记录',
      valueClass: 'text-amber-200',
      to: '/stats?focus=attachments',
      visible: canViewLogs
    },
    {
      key: 'launchApproval',
      label: '上线确认',
      value: launchApprovalStats.statusText || '暂无确认',
      sub: launchApprovalSubText,
      valueClass: launchApprovalStats.ok ? 'text-emerald-200' : launchApprovalStats.status === 'blocked' ? 'text-red-200' : launchApprovalStats.status === 'expired' ? 'text-amber-200' : 'text-slate-200',
      to: launchApprovalPath,
      visible: canManageSystem && canViewLogs
    },
    {
      key: 'networkDiagnostics',
      label: '公网诊断',
      value: networkDiagnosticsStats.statusText || '暂无诊断',
      sub: networkDiagnosticsSubText,
      valueClass: networkDiagnosticsStats.ok ? 'text-emerald-200' : networkDiagnosticsStats.status === 'failed' ? 'text-amber-200' : 'text-slate-200',
      to: networkDiagnosticsStats.latest ? '/logs?type=系统配置&actionGroup=公网诊断&range=近30天' : '/settings',
      visible: canManageSystem && canViewLogs
    }
  ].filter(item => item.visible)
  const pieData = (robots || []).map((item, index) => ({
    name: item.name,
    value: Number.isFinite(Number(item.pct)) ? Number(item.pct) : 0,
    color: pieColors[index % pieColors.length]
  }))
  const hasProfessionalTaskData = pieData.some(item => item.value > 0)
  const latestExecutionLog = [...(executionLogs || [])]
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''), 'zh-CN'))[0] || null
  const systemStatusRows = [
    {
      tag: businessFreshness.stale ? '关注' : '状态',
      text: businessFreshness.text,
      meta: '业务新鲜度',
      important: businessFreshness.stale
    },
    {
      tag: '配置',
      text: stats.totalRobots > 0
        ? `${enabledRobotCount}/${stats.totalRobots} 个审核机器人已完成定义核验并启用`
        : '暂无审核机器人配置',
      meta: '当前',
      important: false
    },
    {
      tag: '动作',
      text: latestExecutionLog
        ? `${latestExecutionLog.actor || '系统'}：${latestExecutionLog.action || '执行动作未命名'}`
        : '暂无执行动作记录',
      meta: latestExecutionLog?.at || '未记录时间',
      important: false
    }
  ]
  const submitterFollowups = useMemo(() => {
    const summary = new Map()

    for (const item of proposals || []) {
      const submitter = item.submitter || '未填写提交人'
      const current = summary.get(submitter) || {
        name: submitter,
        total: 0,
        pending: 0,
        needReminder: 0,
        highRisk: 0,
        unexported: 0,
        overdue: 0,
        latestAt: ''
      }

      current.total += 1
      if (['待审核', '审核中', '待复核', '待修改'].includes(item.status)) current.pending += 1
      if (item.needsReminder) current.needReminder += 1
      current.highRisk += item.highRiskCount || 0
      if ((item.exportCount || 0) === 0) current.unexported += 1
      if (item.overdueReminder?.overdue) current.overdue += 1
      if (String(item.createdAt || '').localeCompare(String(current.latestAt || ''), 'zh-CN') > 0) {
        current.latestAt = item.createdAt || ''
      }

      summary.set(submitter, current)
    }

    return Array.from(summary.values())
      .sort((a, b) => (
        (b.overdue || 0) - (a.overdue || 0) ||
        (b.needReminder || 0) - (a.needReminder || 0) ||
        (b.pending || 0) - (a.pending || 0) ||
        (b.highRisk || 0) - (a.highRisk || 0) ||
        String(b.latestAt || '').localeCompare(String(a.latestAt || ''), 'zh-CN')
      ))
      .slice(0, 6)
  }, [proposals])

  if (!data) return <div className="flex items-center justify-center h-64 text-slate-400">加载中...</div>

  const StatCard = ({ label, value, sub, icon: Icon, colorClass, to }) => (
    <button
      type="button"
      onClick={() => navigate(to)}
      className="w-full"
    >
      <Panel className="p-4 flex items-center gap-4 min-h-[86px] text-left transition hover:-translate-y-0.5 hover:border-white/25">
      <div className={`h-14 w-14 rounded-lg grid place-items-center border ${colorClass}`}>
        <Icon size={28} />
      </div>
      <div className="min-w-0">
        <div className="text-sm text-slate-300">{label}</div>
        <div className="text-3xl font-bold whitespace-nowrap">{value} <span className="text-xs font-normal text-slate-400">{sub}</span></div>
      </div>
      </Panel>
    </button>
  )

  const StatusBadge = ({ s }) => {
    const map = {
      待专业配置: 'text-orange-300 bg-orange-500/10 border-orange-400/30',
      待审核: 'text-blue-300 bg-blue-500/10 border-blue-400/30',
      审核中: 'text-cyan-300 bg-cyan-500/10 border-cyan-400/30',
      待复核: 'text-amber-300 bg-amber-500/10 border-amber-400/30',
      待修改: 'text-violet-300 bg-violet-500/10 border-violet-400/30',
      已通过: 'text-emerald-300 bg-emerald-500/10 border-emerald-400/30'
    }
    return <span className={`px-2 py-1 rounded text-xs border ${map[s] || 'text-slate-300 bg-slate-500/10 border-slate-400/30'}`}>{s}</span>
  }

  const TypeBadge = ({ text }) => (
    <span className={`px-2 py-1 rounded text-xs border whitespace-nowrap ${
      text === '市场拓展方案'
        ? 'bg-blue-500/10 border-blue-400/30 text-blue-300'
        : 'bg-emerald-500/10 border-emerald-400/30 text-emerald-300'
    }`}>{text}</span>
  )

  const ExecutionStageBadge = ({ label, tone }) => {
    const tones = {
      amber: 'border-amber-400/30 bg-amber-500/10 text-amber-200',
      emerald: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200',
      cyan: 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200',
      blue: 'border-blue-400/30 bg-blue-500/10 text-blue-200'
    }
    return <span className={`px-2 py-1 rounded text-xs border ${tones[tone] || tones.blue}`}>{label}</span>
  }

  const ExecutionFunnelCard = ({ label, value, toneClass, to }) => (
    <button
      type="button"
      onClick={() => navigate(to)}
      className={`rounded-lg border bg-slate-900/60 p-4 text-left transition hover:-translate-y-0.5 hover:border-white/25 ${toneClass}`}
    >
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
      <div className="mt-3 text-xs text-slate-400">点击查看对应方案</div>
    </button>
  )

  const OpsDrilldownCard = ({ label, value, sub, valueClass, to }) => (
    <button
      type="button"
      onClick={() => navigate(to)}
      className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4 text-left transition hover:-translate-y-0.5 hover:border-white/25"
    >
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-bold ${valueClass}`}>{value}</div>
      <div className="mt-1 text-xs text-slate-400">{sub}</div>
      <div className="mt-3 text-xs text-blue-300">点击进入对应管理页</div>
    </button>
  )

  const AiHealthMetric = ({ label, value, sub, valueClass, to }) => {
    const Component = to ? 'button' : 'div'
    return (
      <Component
        type={to ? 'button' : undefined}
        onClick={to ? () => navigate(to) : undefined}
        className={`rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-3 text-left transition ${to ? 'hover:-translate-y-0.5 hover:border-blue-300/40' : ''}`}
      >
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-bold ${valueClass}`}>{value}</div>
      <div className="mt-1 text-xs text-slate-400">{sub}</div>
      </Component>
    )
  }

  const aiReviewPath = (ai) => `/review?ai=${encodeURIComponent(ai)}&sort=${encodeURIComponent('最新提交优先')}`
  const hermesFocusPath = '/bots?focus=hermes&from=ai-fallback'
  const aiLogPath = (result = '') => {
    const query = new URLSearchParams({ type: '执行动作', actionGroup: 'AI调用', range: '近30天' })
    if (result) query.set('result', result)
    return `/logs?${query.toString()}`
  }
  const showCopyMessage = (text) => {
    setMessage(text)
    window.clearTimeout(copyMessageTimerRef.current)
    copyMessageTimerRef.current = window.setTimeout(() => setMessage(''), 3500)
  }

  const accountSecurityExportText = (item = latestAccountSecurityExport) => {
    if (!item) return ''
    const metadata = item.metadata || {}
    const riskSummary = metadata.riskSummary || {}
    return [
      '最近账号清单导出',
      `操作人：${item.actor || '未知账号'}`,
      `时间：${item.at || '时间未记录'}`,
      `动作：${item.action || '未记录'}`,
      `结果：${item.result || '未记录'}`,
      `导出批次：${metadata.exportAuditId || latestAccountSecurityExportId || '未记录'}`,
      `导出数量：${metadata.count ?? 0}`,
      `默认密码风险：${riskSummary.defaultPasswordCount ?? 0}`,
      `需改密账号：${riskSummary.mustChangePasswordCount ?? 0}`,
      `登录锁定：${riskSummary.loginLockedCount ?? 0}`,
      `长期未登录：${riskSummary.inactiveLoginCount ?? 0}`,
      latestAccountSecurityExportRoleText ? `角色分布：${latestAccountSecurityExportRoleText}` : '',
      latestAccountSecurityExportPermissionText ? `角色权限矩阵：${latestAccountSecurityExportPermissionText}` : '',
      metadata.defaultPasswordLogUrl ? `默认密码拒绝日志：${metadata.defaultPasswordLogUrl}` : '',
      `日志入口：${window.location.origin}${accountSecurityExportLogPath}`
    ].filter(Boolean).join('\n')
  }

  const copyAccountSecurityExport = async () => {
    const content = accountSecurityExportText()
    if (!content) return
    try {
      await copyText(content)
      showCopyMessage('账号清单导出摘要已复制')
    } catch {
      setCopyFallback({
        open: true,
        title: '账号清单导出摘要',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
    }
  }

  const accountSecurityBulkText = (item = latestAccountSecurityBulk) => {
    if (!item) return ''
    const metadata = item.metadata || {}
    return [
      '最近账号批量处理',
      `操作人：${item.actor || '未知账号'}`,
      `时间：${item.at || '时间未记录'}`,
      `动作：${item.action || '未记录'}`,
      `结果：${item.result || '未记录'}`,
      `批次：${metadata.auditId || latestAccountSecurityBulkId || '未记录'}`,
      `请求数：${metadata.requestedCount ?? 0}`,
      `更新数：${metadata.changedCount ?? 0}`,
      `跳过数：${metadata.skippedCount ?? 0}`,
      `日志入口：${window.location.origin}${accountSecurityBulkLogPath}`
    ].join('\n')
  }

  const copyAccountSecurityBulk = async () => {
    const content = accountSecurityBulkText()
    if (!content) return
    try {
      await copyText(content)
      showCopyMessage('账号批量处理摘要已复制')
    } catch {
      setCopyFallback({
        open: true,
        title: '账号批量处理摘要',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
    }
  }

  const accountSecurityNoticeText = (item = latestAccountSecurityNotice) => {
    if (!item) return ''
    const metadata = item.metadata || {}
    return [
      '最近改密通知文案（未发送）',
      `操作人：${item.actor || '未知账号'}`,
      `时间：${item.at || '时间未记录'}`,
      `动作：${item.action || '未记录'}`,
      `结果：${item.result || '未记录'}`,
      `文案编号：${metadata.auditId || latestAccountSecurityNoticeId || '未记录'}`,
      `涉及账号数：${metadata.affectedAccountCount ?? metadata.noticeCount ?? 0}`,
      `交付状态：${metadata.deliveryStatus || '未发送'}`,
      `生成方式：${metadata.noticeChannel || '复制通知文案'}`,
      `跳过数：${metadata.skippedCount ?? 0}`,
      Array.isArray(metadata.targetNames) && metadata.targetNames.length ? `涉及姓名：${metadata.targetNames.join('、')}` : '',
      Array.isArray(metadata.targetUsernames) && metadata.targetUsernames.length ? `涉及账号：${metadata.targetUsernames.join('、')}` : '',
      `日志入口：${window.location.origin}${accountSecurityNoticeLogPath}`
    ].filter(Boolean).join('\n')
  }

  const copyAccountSecurityNotice = async () => {
    const content = accountSecurityNoticeText()
    if (!content) return
    try {
      await copyText(content)
      showCopyMessage('改密通知文案生成摘要已复制')
    } catch {
      setCopyFallback({
        open: true,
        title: '改密通知文案生成摘要',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
    }
  }

  const adminLaunchEntries = [
    {
      key: 'snapshot',
      label: '备份快照',
      title: '创建上线快照',
      desc: '进入系统设置，创建可回滚的服务器本地快照。',
      to: '/settings',
      toneClass: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100',
      visible: canManageSystem
    },
    {
      key: 'launch',
      label: '上线确认',
      title: launchApprovalStats.statusText || '暂无确认',
      desc: launchApprovalSubText,
      to: launchApprovalPath,
      actions: launchApprovalRiskCount > 0 && canManageUsers ? launchApprovalRiskActions : [],
      toneClass: launchApprovalRiskCount > 0 || launchApprovalStats.status === 'blocked' ? 'border-red-400/25 bg-red-500/10 text-red-100' : launchApprovalStats.ok ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100' : 'border-amber-400/25 bg-amber-500/10 text-amber-100',
      visible: canManageSystem && canViewLogs
    },
    {
      key: 'config',
      label: '配置变更',
      title: '规则/催办/权限',
      desc: '查看后台配置调整和 CSV 配置变更摘要。',
      to: '/logs?type=系统配置&q=配置',
      toneClass: 'border-violet-400/25 bg-violet-500/10 text-violet-100',
      visible: canManageSystem && canViewLogs
    },
    {
      key: 'security',
      label: '账号安全',
      title: securityLatestLabel,
      desc: securityStats.latestFailureAt ? `${securityLatestSubText} · ${securitySplitText}` : securitySplitText,
      to: latestFailureLogPath,
      toneClass: (securityStats.failureCount || securityStats.lockedCount || 0) > 0 ? 'border-red-400/25 bg-red-500/10 text-red-100' : 'border-blue-400/25 bg-blue-500/10 text-blue-100',
      visible: canViewSecurityOps
    }
  ].filter(item => item.visible)
  const adminLaunchTitle = canManageSystem ? '管理员上线入口' : '账号安全入口'
  const adminLaunchDescription = canManageSystem
    ? '备份、上线确认、配置变更和账号安全集中入口。'
    : '人员管理、账号安全日志和批量处理追溯入口。'

  const reviewFilterPathByQueueTitle = (title) => {
    switch (title) {
      case '待高风险复核':
        return '/review?queue=待人工复核高风险'
      case '待签发':
        return '/review?queue=已复核未签发'
      case '待归档':
        return '/review?queue=已签发未归档'
      case '超时催办':
        return '/review?queue=超时催办'
      case '临近超时':
        return '/review?queue=临近超时'
      case '最近催办':
        return '/review?queue=最近催办'
      default:
        return '/review'
    }
  }

  const exportFilterPath = (mode = 'all') => {
    switch (mode) {
      case 'preview':
        return '/review?export=预览&sort=最近导出优先'
      case 'word':
        return '/review?export=Word&sort=导出次数优先'
      case 'pdf':
        return '/review?export=PDF&sort=最近导出优先'
      case 'exported':
        return '/review?export=已导出&sort=最近导出优先'
      case 'unexported':
        return '/review?export=未导出&sort=最新提交优先'
      default:
        return '/review?export=已导出&sort=最近导出优先'
    }
  }

  const exportSourceFilterPath = (label = '') => {
    if (label === '方案详情页') return '/review?export=已导出&exportSource=详情页&sort=最近导出优先'
    if (label === '提交结果区') return '/review?export=已导出&exportSource=提交结果&sort=最近导出优先'
    if (label === '审核中心') return '/review?export=已导出&exportSource=审核中心&sort=最近导出优先'
    return exportFilterPath('exported')
  }

  const executionLogMeta = (log = {}) => {
    const action = String(log.action || '')
    const proposalId = log.proposalId || ''
    const proposalPath = (section = '') => {
      if (canReview && proposalId) return `/review/${proposalId}${section ? `?section=${section}` : ''}`
      return '/logs?type=执行动作'
    }

    if (action.includes('人工复核') || action.includes('复核备注')) {
      return {
        label: '人工复核',
        badgeClass: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200',
        to: canReview && proposalId ? proposalPath('manualReview') : '/logs?type=执行动作&actionGroup=人工复核'
      }
    }
    if (action.includes('签发') || action.includes('归档')) {
      return {
        label: '签发归档',
        badgeClass: 'border-blue-400/30 bg-blue-500/10 text-blue-200',
        to: canReview && proposalId ? proposalPath('signOff') : '/logs?type=执行动作&actionGroup=签发归档'
      }
    }
    if (action.includes('催办')) {
      return {
        label: '催办',
        badgeClass: 'border-violet-400/30 bg-violet-500/10 text-violet-200',
        to: canReview && proposalId ? proposalPath('reminder') : '/logs?type=执行动作&actionGroup=催办'
      }
    }
    if (action.includes('意见书') || action.includes('预览')) {
      return {
        label: '导出',
        badgeClass: 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200',
        to: canReview && proposalId ? proposalPath('exports') : '/logs?type=执行动作&actionGroup=导出'
      }
    }
    return {
      label: '执行动作',
      badgeClass: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
      to: proposalPath()
    }
  }

  const QueueCard = ({ title, icon: Icon, items, emptyText, tone, renderMeta }) => (
    <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4 min-h-[230px]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-slate-100 font-medium">
          <Icon size={17} className={tone === 'amber' ? 'text-amber-300' : tone === 'emerald' ? 'text-emerald-300' : tone === 'cyan' ? 'text-cyan-300' : 'text-blue-300'} />
          {title}
        </div>
        <button type="button" onClick={() => navigate(reviewFilterPathByQueueTitle(title))} className="text-xs text-blue-300 hover:text-blue-200">
          查看全部
        </button>
      </div>
      <div className="mt-3 space-y-3">
        {items.length === 0 ? (
          <div className="rounded-lg border border-blue-500/15 bg-slate-950/45 px-3 py-6 text-sm text-slate-500">{emptyText}</div>
        ) : items.map(item => (
          <button
            key={item.id}
            type="button"
            onClick={() => navigate(`/review/${item.id}`)}
            aria-label={`查看方案：${item.title}，提交人 ${item.submitter}，类型 ${item.type}`}
            className="w-full text-left rounded-lg border border-blue-500/15 bg-slate-950/45 px-3 py-3 hover:border-blue-400/35 transition"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-blue-100 truncate">{item.title}</div>
                <div className="mt-1 text-xs text-slate-500 truncate">{item.submitter} · {item.type}</div>
              </div>
              {renderMeta(item)}
            </div>
            <div className="mt-2 text-xs text-slate-400">{item.robot}</div>
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <div className="grid grid-cols-12 gap-4">
      <section className="col-span-12 xl:col-span-9 space-y-4">
        {dataError && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            <span>{dataError}</span>
            <button type="button" onClick={loadData} className="rounded-lg border border-red-300/40 px-3 py-1.5 text-xs hover:border-red-200/70">
              重新加载
            </button>
          </div>
        )}
        {message && (
          <div className="rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
            {message}
          </div>
        )}
        <Panel className="relative overflow-hidden p-4 min-h-[164px] md:min-h-[148px]">
          <div className="review-home-intro-bg absolute inset-0" />
          <div className="absolute right-2 top-2 bottom-2 w-[92px] md:right-5 md:w-[96px]">
            <img
              src={lvzaiHero}
              alt="绿仔2025"
              className="h-full w-full object-contain object-bottom drop-shadow-[0_0_22px_rgba(16,185,129,.35)]"
            />
          </div>
          <div className="relative max-w-3xl py-3 pr-28 md:pr-36">
            <h1 className="text-2xl font-bold text-blue-100">让每一次方案审核，都有标准、有依据、有结论</h1>
            <p className="text-slate-300 mt-2">多专业智能协同，沉淀作业标准，提升立项、运营与复核效率。</p>
          </div>
        </Panel>

        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-blue-500/20 bg-slate-950/55 p-2">
          <div role="tablist" aria-label="首页工作视图" className="flex items-center gap-2">
            <button
              ref={element => { homeTabRefs.current.review = element }}
              id="home-tab-review"
              type="button"
              role="tab"
              aria-selected={homeMode === 'review'}
              aria-controls="home-panel"
              tabIndex={homeMode === 'review' ? 0 : -1}
              onClick={() => setHomeMode('review')}
              onKeyDown={event => handleHomeTabKeyDown(event, 'review')}
              className={`rounded-lg px-4 py-2 text-sm transition ${homeMode === 'review' ? 'bg-blue-500/20 text-blue-100 border border-blue-300/35' : 'text-slate-400 hover:text-slate-200'}`}
            >今日审核</button>
            {canAccessOps && (
              <button
                ref={element => { homeTabRefs.current.ops = element }}
                id="home-tab-ops"
                type="button"
                role="tab"
                aria-selected={homeMode === 'ops'}
                aria-controls="home-panel"
                tabIndex={homeMode === 'ops' ? 0 : -1}
                onClick={() => setHomeMode('ops')}
                onKeyDown={event => handleHomeTabKeyDown(event, 'ops')}
                className={`rounded-lg px-4 py-2 text-sm transition ${homeMode === 'ops' ? 'bg-violet-500/20 text-violet-100 border border-violet-300/35' : 'text-slate-400 hover:text-slate-200'}`}
              >运行与安全</button>
            )}
          </div>
          <div className="ml-auto flex min-w-0 flex-col items-end gap-0.5 px-2 text-right text-xs">
            <span className="text-slate-500">
              {homeMode === 'review' ? '处理复核、签发、归档与催办' : '检查AI、机器人、规则、账号与上线状态'}
            </span>
            <span
              role="status"
              aria-live="polite"
              aria-atomic="true"
              data-review-data-freshness={businessFreshness.stale ? 'stale' : 'fresh'}
              className={businessFreshness.stale ? 'text-amber-200' : 'text-emerald-200'}
            >
              {businessFreshness.text}
            </span>
          </div>
        </div>

        <div
          id="home-panel"
          role="tabpanel"
          aria-labelledby={`home-tab-${homeMode}`}
          tabIndex={0}
          className="space-y-4"
        >
        {notice === 'admin-password-self-service-disabled' && (
          <div className="rounded-lg border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>管理员账号不开放自助修改密码，请在人员管理中维护账号安全。</span>
              <div className="flex flex-wrap gap-2">
                {canManageUsers && (
                  <button type="button" onClick={() => navigate('/users?role=管理员')} className="rounded-lg border border-amber-300/30 px-3 py-1.5 text-xs hover:border-amber-200/60">
                    去人员管理
                  </button>
                )}
                <button type="button" onClick={dismissNotice} className="rounded-lg border border-amber-300/30 px-3 py-1.5 text-xs hover:border-amber-200/60">
                  知道了
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
          {canReview && (
            <>
              <StatCard label="待复核方案" value={stats.pending} sub="待人工处理" icon={FileText} colorClass="bg-blue-500/15 border-blue-400/40 text-blue-300" to="/review?status=待复核" />
              <StatCard label="待专业配置" value={stats.configurationPending || 0} sub="已保存，未执行 AI" icon={FolderKanban} colorClass="bg-orange-500/15 border-orange-400/40 text-orange-300" to="/review?status=待专业配置" />
              <StatCard label="已通过" value={stats.passed} sub="人工确认" icon={CheckCircle2} colorClass="bg-emerald-500/15 border-emerald-400/40 text-emerald-300" to="/review?status=已通过" />
              <StatCard label="待修改" value={stats.needRevision} sub="需补充后复核" icon={Wrench} colorClass="bg-amber-500/15 border-amber-400/40 text-amber-300" to="/review?status=待修改" />
            </>
          )}
          {(canManageSystem || canViewLogs) && (
            <StatCard label="已核验专业" value={`${enabledRobotCount}/${stats.totalRobots}`} sub="完整定义核验并启用" icon={Bot} colorClass="bg-violet-500/15 border-violet-400/40 text-violet-300" to={canManageSystem ? '/bots' : '/stats?focus=ai'} />
          )}
        </div>

        {homeMode === 'ops' && (
        <>
        {(canReview || canViewLogs) && (
        <Panel className="p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between mb-3">
            <div>
              <h2 className="font-semibold flex items-center gap-2">
                <Bot size={17} className="text-cyan-300" />
                AI 审核健康
              </h2>
              <div className="mt-1 text-xs text-slate-500">
                最近调用：{aiTraceStats.latestAt || '暂无'} · {aiTraceStats.latestProvider || '-'} / {aiTraceStats.latestModel || '-'}
                {aiTraceStats.latestModeName ? ` · 模式：${aiTraceStats.latestModeName}` : ''}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canViewLogs && (
                <button type="button" onClick={() => openStatsFocus('ai')} className="rounded-lg border border-blue-400/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-200 hover:border-blue-300/60">
                  进入 AI 分析
                </button>
              )}
              {canViewLogs && (
                <button type="button" onClick={() => navigate(aiLogPath())} className="rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200 hover:border-cyan-300/60">
                  AI 调用日志
                </button>
              )}
              {canReview && (
                <>
                  <button type="button" onClick={() => navigate(aiReviewPath('AI回退'))} className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 hover:border-amber-300/60">
                    查看 AI 回退
                  </button>
                  {canManageSystem && (
                    <button type="button" onClick={() => navigate(hermesFocusPath)} className="rounded-lg border border-violet-400/30 bg-violet-500/10 px-3 py-2 text-xs text-violet-200 hover:border-violet-300/60">
                      检查 Hermes
                    </button>
                  )}
                  <button type="button" onClick={() => navigate(aiReviewPath('无AI记录'))} className="rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200 hover:border-cyan-300/60">
                    补跑无记录
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <AiHealthMetric
              label="总调用"
              value={aiTraceStats.total || 0}
              sub={`失败 ${aiTraceStats.failedCount || 0} 次`}
              valueClass="text-blue-100"
              to={canViewLogs ? aiLogPath() : ''}
            />
            <AiHealthMetric
              label="成功率"
              value={aiTraceStats.total > 0 ? `${aiTraceStats.successRate || 0}%` : '暂无调用'}
              sub={aiTraceStats.total > 0 ? `${aiTraceStats.successCount || 0}/${aiTraceStats.total} 成功` : '无可计算记录'}
              valueClass={aiTraceStats.total > 0 ? ((aiTraceStats.successRate || 0) >= 90 ? 'text-emerald-200' : 'text-amber-200') : 'text-slate-300'}
              to={canReview ? aiReviewPath('AI成功') : ''}
            />
            <AiHealthMetric
              label="回退调用"
              value={aiTraceStats.fallbackCount || 0}
              sub={(aiTraceStats.fallbackCount || 0) > 0 ? '需要优先排查 Hermes 链路' : aiTraceStats.total > 0 ? '未记录回退' : '暂无调用记录'}
              valueClass={(aiTraceStats.fallbackCount || 0) > 0 ? 'text-amber-200' : aiTraceStats.total > 0 ? 'text-emerald-200' : 'text-slate-300'}
              to={canManageSystem && (aiTraceStats.fallbackCount || 0) > 0 ? hermesFocusPath : canViewLogs ? aiLogPath('回退') : canReview ? aiReviewPath('AI回退') : ''}
            />
            <AiHealthMetric
              label="平均耗时"
              value={aiTraceStats.total > 0 ? `${aiTraceStats.avgDurationMs || 0}ms` : '暂无记录'}
              sub={aiTraceStats.total > 0 ? '最近 AI 审核调用均值' : '无可计算记录'}
              valueClass="text-cyan-200"
              to={canViewLogs ? '/stats?focus=ai' : ''}
            />
          </div>
          <div className="mt-3 grid grid-cols-1 lg:grid-cols-3 gap-3">
            {(aiTraceStats.recent || []).slice(0, 3).length === 0 ? (
              <div className="lg:col-span-3 rounded-lg border border-blue-500/15 bg-slate-950/45 px-3 py-4 text-sm text-slate-500">暂无 AI 调用记录</div>
            ) : (
              (aiTraceStats.recent || []).slice(0, 3).map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    if (canReview && item.proposalId) navigate(`/review/${item.proposalId}?section=aiTrace`)
                    else if (canViewLogs) navigate(aiLogPath(aiTraceLogResult(item)))
                  }}
                  disabled={!canReview && !canViewLogs}
                  className={`rounded-lg border border-blue-500/15 bg-slate-950/45 p-3 text-left transition ${(canReview && item.proposalId) || canViewLogs ? 'hover:border-blue-300/35' : 'cursor-default opacity-80'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`px-2 py-1 rounded text-xs border ${aiTraceToneClass(item)}`}>
                      {aiTraceLabel(item)}
                    </span>
                    <span className="text-xs text-slate-500">{item.durationMs || 0}ms</span>
                  </div>
                  <div className="mt-2 text-sm text-blue-100 truncate">{item.title || item.proposalId || '未关联方案'}</div>
                  <div className="mt-1 text-xs text-slate-500 truncate">{item.provider || '-'} · Profile {item.profileCount || 0} · 意见 {item.opinionCount || 0}</div>
                </button>
              ))
            )}
          </div>
        </Panel>
        )}

        {(canReview || canViewLogs) && (
        <Panel className="p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="font-semibold">审核机器人</h2>
            {canManageSystem && <button type="button" onClick={() => navigate('/bots')} className="text-blue-300 text-sm">查看全部 ›</button>}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-4 gap-3">
            {(robots || []).map((r) => {
              const reviewStatus = robotReviewStatus(r)
              return (
              <div
                key={r.id}
                role={canManageSystem ? 'button' : undefined}
                tabIndex={canManageSystem ? 0 : undefined}
                aria-label={canManageSystem ? `查看机器人配置：${r.name}，状态 ${reviewStatus.label}` : undefined}
                onClick={() => canManageSystem && navigate(`/bots?profile=${encodeURIComponent(r.id)}`)}
                onKeyDown={event => {
                  if (canManageSystem && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault()
                    navigate(`/bots?profile=${encodeURIComponent(r.id)}`)
                  }
                }}
                className={`rounded-lg border border-blue-500/25 bg-slate-900/65 p-3 transition min-h-[132px] text-left ${canManageSystem ? 'cursor-pointer hover:border-cyan-300/60' : ''}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-11 w-11 rounded-lg bg-blue-500/15 border border-blue-300/40 grid place-items-center shrink-0">
                      <Bot className="text-blue-200" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-blue-100 truncate">{r.name}</div>
                      <div className={`text-xs ${reviewStatus.active ? 'text-emerald-400' : r.status === '启用' ? 'text-amber-300' : 'text-slate-500'}`}>● {reviewStatus.label}</div>
                    </div>
                  </div>
                  <span className="text-xs px-2 py-1 rounded border border-blue-400/40 text-blue-300 bg-blue-500/10 whitespace-nowrap">
                    {r.tag}
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-3 leading-5 line-clamp-2">{r.domain}</p>
                <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                  <span>今日真实任务 {Number.isFinite(Number(r.todayTasks)) ? Number(r.todayTasks) : 0}</span>
                  <span>{Number(r.avgSeconds) > 0 ? `平均 ${r.avgSeconds}s` : '暂无耗时记录'}</span>
                </div>
              </div>
              )
            })}
          </div>
        </Panel>
        )}

        <Panel className="p-4">
          <h2 className="font-semibold mb-3">审核流程模型</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div
              role={canManageSystem ? 'button' : undefined}
              tabIndex={canManageSystem ? 0 : undefined}
              aria-label={canManageSystem ? `查看内部运营方案审核机器人配置，当前启用 ${internalEnabledCount} 个专业` : undefined}
              onClick={() => canManageSystem && navigate('/bots?scope=内部运营')}
              onKeyDown={event => {
                if (canManageSystem && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault()
                  navigate('/bots?scope=内部运营')
                }
              }}
              className={`rounded-lg border border-emerald-500/25 bg-slate-900/65 p-4 text-left transition ${canManageSystem ? 'cursor-pointer hover:-translate-y-0.5 hover:border-emerald-300/45' : ''}`}
            >
              <div className="flex items-center gap-3 text-emerald-200 font-semibold">
                <Building2 size={20} />
                内部运营方案审核
              </div>
              <p className="text-sm text-slate-400 mt-2">{internalEnabledCount > 0 ? `当前由 ${internalEnabledCount} 个已核验启用专业并行审核，按公司作业标准输出专业风险、修改建议和最终汇总意见。` : '当前没有已核验启用的内部运营专业，AI 审核尚未开放。'}</p>
              <div className="mt-3 text-xs text-slate-500">{workflow?.internal?.reviewerNames?.join('、') || '暂无已核验专业'}</div>
              {canManageSystem && <div className="mt-3 text-xs text-emerald-300">点击查看机器人配置</div>}
            </div>
            <div
              role={canManageSystem ? 'button' : undefined}
              tabIndex={canManageSystem ? 0 : undefined}
              aria-label={canManageSystem ? `查看市场拓展方案审核机器人配置，当前启用 ${marketReviewCount} 个会审专业` : undefined}
              onClick={() => canManageSystem && navigate('/bots?scope=市场拓展')}
              onKeyDown={event => {
                if (canManageSystem && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault()
                  navigate('/bots?scope=市场拓展')
                }
              }}
              className={`rounded-lg border border-blue-500/25 bg-slate-900/65 p-4 text-left transition ${canManageSystem ? 'cursor-pointer hover:-translate-y-0.5 hover:border-blue-300/45' : ''}`}
            >
              <div className="flex items-center gap-3 text-blue-200 font-semibold">
                <BriefcaseBusiness size={20} />
                市场拓展方案审核
              </div>
              <p className="text-sm text-slate-400 mt-2">{marketInitiatorName && marketReviewCount > 0 ? `${marketInitiatorName}先根据招标文件和测算表形成立项判断，再由 ${marketReviewCount} 个已核验启用专业并行会审并形成汇总意见。` : '已核验的立项牵头或会审专业尚未配齐，市场拓展 AI 审核尚未开放。'}</p>
              <div className="mt-3 text-xs text-slate-500">{workflow?.market?.reviewerNames?.join('、') || '暂无已核验市场拓展会审专业'}</div>
              {canManageSystem && <div className="mt-3 text-xs text-blue-300">点击查看机器人配置</div>}
            </div>
          </div>
        </Panel>

        {systemOpsCards.length > 0 && (
          <Panel className="p-4">
            <h2 className="font-semibold mb-3">系统运行面板</h2>
            <div className={`grid grid-cols-1 gap-3 ${systemOpsCards.length >= 7 ? 'md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6' : systemOpsCards.length >= 6 ? 'md:grid-cols-3 xl:grid-cols-6' : systemOpsCards.length >= 5 ? 'md:grid-cols-5' : systemOpsCards.length >= 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
              {systemOpsCards.map(card => (
                <OpsDrilldownCard
                  key={card.key}
                  label={card.label}
                  value={card.value}
                  sub={card.sub}
                  valueClass={card.valueClass}
                  to={card.to}
                />
              ))}
            </div>
          </Panel>
        )}

        {adminLaunchEntries.length > 0 && (
          <Panel className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div>
                <h2 className="font-semibold">{adminLaunchTitle}</h2>
                <div className="mt-1 text-xs text-slate-500">{adminLaunchDescription}</div>
              </div>
              {canManageSystem && (
                <button type="button" onClick={() => navigate('/settings')} className="text-blue-300 text-sm">进入系统设置 ›</button>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              {adminLaunchEntries.map(entry => (
                <div
                  key={entry.key}
                  className={`rounded-lg border p-4 text-left transition hover:-translate-y-0.5 hover:border-white/30 ${entry.toneClass}`}
                >
                  <button type="button" onClick={() => navigate(entry.to)} className="block w-full text-left">
                    <div className="text-xs opacity-75">{entry.label}</div>
                    <div className="mt-2 text-lg font-semibold">{entry.title}</div>
                    <div className="mt-2 text-xs text-slate-300">{entry.desc}</div>
                  </button>
                  {entry.actions?.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {entry.actions.map(action => (
                        <button
                          key={action.to}
                        type="button"
                        onClick={() => navigate(action.to)}
                          aria-label={`处理上线准备事项：${entry.title}，${action.label}`}
                          className={`rounded border bg-slate-950/20 px-2 py-1 text-[11px] ${action.className}`}
                        >
                          处理{action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        )}

        {canViewSecurityOps && (
          <Panel className="p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between mb-3">
              <div>
                <h2 className="font-semibold flex items-center gap-2">
                  <ShieldAlert size={17} className="text-amber-300" />
                  账号安全态势
                </h2>
                <button
                  type="button"
                  onClick={() => navigate(latestFailureLogPath)}
                  aria-label={`查看最近账号安全异常日志：${securityStats.latestFailureResult || '暂无'}，账号 ${securityStats.latestFailureActor || '暂无'}，时间 ${securityStats.latestFailureAt || '暂无'}`}
                  className="mt-1 block text-left text-xs text-slate-500 transition hover:text-amber-200"
                >
                  最近异常：{securityStats.latestFailureResult || '暂无'} · {securityStats.latestFailureActor || '暂无'} · {securityStats.latestFailureAt || '暂无'}
                  {securityStats.latestFailureAction ? ` · ${securityStats.latestFailureAction}` : ''}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => openStatsFocus('security')} className="rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200 hover:border-cyan-300/60">
                  进入安全分析
                </button>
                <button type="button" onClick={() => navigate(securityLogPath())} className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 hover:border-amber-300/60">
                  进入安全日志
                </button>
                <button type="button" onClick={() => navigate(securityLogPath('锁定'))} className="rounded-lg border border-yellow-400/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200 hover:border-yellow-300/60">
                  查看锁定
                </button>
                <button type="button" onClick={() => navigate(securityLogPath('拦截'))} className="rounded-lg border border-orange-400/30 bg-orange-500/10 px-3 py-2 text-xs text-orange-200 hover:border-orange-300/60">
                  查看拦截
                </button>
                <button type="button" onClick={() => navigate(securityLogPath('拒绝'))} className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-200 hover:border-red-300/60">
                  权限拒绝
                </button>
                <button type="button" onClick={() => navigate(securityLogPath('拒绝', '管理员账号修改密码被拒绝'))} className="rounded-lg border border-orange-400/30 bg-orange-500/10 px-3 py-2 text-xs text-orange-200 hover:border-orange-300/60">
                  管理员改密拒绝
                </button>
                <button type="button" onClick={() => navigate(securityLogPath('拒绝', '下次登录改密被拒绝'))} className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 hover:border-amber-300/60">
                  强制改密拒绝
                </button>
                <button type="button" onClick={() => navigate(securityLogPath('拒绝', '默认密码'))} className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 hover:border-rose-300/60">
                  默认密码拒绝
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <AiHealthMetric
                label="安全日志"
                value={securityStats.accountSecurityCount || securityStats.total || 0}
                sub="账号安全事件总量"
                valueClass="text-amber-100"
                to={securityLogPath()}
              />
              <AiHealthMetric
                label="失败登录"
                value={securityStats.failureCount || 0}
                sub="用户名或密码错误"
                valueClass={(securityStats.failureCount || 0) > 0 ? 'text-red-200' : 'text-emerald-200'}
                to={securityLogPath('失败')}
              />
              <AiHealthMetric
                label="锁定/拦截/拒绝"
                value={securityStats.lockedCount || 0}
                sub={`锁定 ${securityStats.lockedOnlyCount || 0} · 拦截 ${securityStats.interceptCount || 0} · 拒绝 ${securityStats.rejectedCount || 0}`}
                valueClass={(securityStats.lockedCount || 0) > 0 ? 'text-orange-200' : 'text-emerald-200'}
                to={securityLogPath('拒绝')}
              />
              <AiHealthMetric
                label="来源 IP"
                value={securityStats.uniqueIpCount || 0}
                sub="账号安全事件来源"
                valueClass="text-cyan-200"
                to={securityLogPath()}
              />
            </div>
            {canManageUsers && (
              <div className={`mt-3 rounded-lg border px-4 py-3 ${accountRiskOpenCount === null ? 'border-slate-400/20 bg-slate-500/10' : accountRiskOpenCount > 0 ? 'border-red-400/20 bg-red-500/10' : 'border-emerald-400/20 bg-emerald-500/10'}`}>
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className={accountRiskOpenCount === null ? 'text-xs text-slate-300' : accountRiskOpenCount > 0 ? 'text-xs text-red-200' : 'text-xs text-emerald-200'}>账号待处理事项</div>
                    <div className={accountRiskOpenCount === null ? 'mt-1 text-sm text-slate-200' : accountRiskOpenCount > 0 ? 'mt-1 text-sm text-red-100' : 'mt-1 text-sm text-emerald-100'}>
                      {accountRiskOpenCount === null ? '账号风险统计未加载，当前状态未知' : accountRiskOpenCount > 0 ? `仍有 ${accountRiskOpenCount} 项账号风险待处理` : '默认密码、需改密和登录锁定均已收口'}
                    </div>
                  </div>
                  <div className="grid w-full grid-cols-1 gap-2 text-xs sm:grid-cols-3 lg:w-auto">
                    {accountRiskActionCards.map(card => (
                      <button
                        key={card.key}
                        type="button"
                        onClick={() => navigate(card.to)}
                        aria-label={`处理账号风险：${card.label}，当前 ${card.value === null ? '数量未知' : `${card.value} 项`}，${card.desc}`}
                        className={`rounded-lg border px-3 py-2 text-left transition hover:-translate-y-0.5 hover:border-white/30 ${card.value === null ? 'border-slate-400/20 bg-slate-500/10 text-slate-200' : card.value > 0 ? card.toneClass : 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100'}`}
                      >
                        <div className="opacity-75">{card.label}</div>
                        <div className="mt-1 text-lg font-semibold">{card.value === null ? '未知' : card.value}</div>
                        <div className="mt-1 text-[11px] opacity-80">{card.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {latestAccountSecurityExport && (
              <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-500/10 px-4 py-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="text-xs text-amber-200">最近账号清单导出</div>
                    <div className="mt-1 text-sm text-amber-100">
                      {latestAccountSecurityExport.actor || '未知账号'} · {latestAccountSecurityExport.at || '时间未记录'}
                    </div>
                    {latestAccountSecurityExportId && (
                      <div className="mt-1 break-all text-xs text-amber-100/75">批次：{latestAccountSecurityExportId}</div>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-1 text-amber-100">导出 {latestAccountSecurityExport.metadata?.count ?? 0}</span>
                    <span className="rounded border border-red-300/20 bg-red-500/10 px-2 py-1 text-red-100">默认密码 {latestAccountSecurityExportRisk.defaultPasswordCount ?? 0}</span>
                    <span className="rounded border border-amber-300/20 bg-amber-500/10 px-2 py-1 text-amber-100">需改密 {latestAccountSecurityExportRisk.mustChangePasswordCount ?? 0}</span>
                    <span className="rounded border border-orange-300/20 bg-orange-500/10 px-2 py-1 text-orange-100">锁定 {latestAccountSecurityExportRisk.loginLockedCount ?? 0}</span>
                    {latestAccountSecurityExportRoleText && (
                      <span className="rounded border border-cyan-300/20 bg-cyan-500/10 px-2 py-1 text-cyan-100">角色 {latestAccountSecurityExportRoleText}</span>
                    )}
                    {latestAccountSecurityExportPermissionText && (
                      <span className="rounded border border-blue-300/20 bg-blue-500/10 px-2 py-1 text-blue-100">权限矩阵 {latestAccountSecurityExportPermissionText}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => navigate(accountSecurityExportLogPath)}
                      aria-label={`查看最近账号清单导出批次，导出 ${latestAccountSecurityExport.metadata?.count ?? 0} 个账号`}
                      className="rounded-lg border border-amber-300/30 px-3 py-1.5 text-amber-100 hover:border-amber-200/60"
                    >
                      查看本批
                    </button>
                    <button
                      type="button"
                      onClick={copyAccountSecurityExport}
                      aria-label="复制最近账号清单导出摘要"
                      className="rounded-lg border border-amber-300/30 px-3 py-1.5 text-amber-100 hover:border-amber-200/60"
                    >
                      复制摘要
                    </button>
                    {(latestAccountSecurityExportRisk.defaultPasswordCount || 0) > 0 && canManageUsers && (
                      <button
                        type="button"
                        onClick={() => navigate('/users?password=默认密码&select=visible')}
                        aria-label={`处理账号清单中的默认密码账号，共 ${latestAccountSecurityExportRisk.defaultPasswordCount || 0} 个`}
                        className="rounded-lg border border-red-300/30 px-3 py-1.5 text-red-100 hover:border-red-200/60"
                      >
                        处理 {latestAccountSecurityExportRisk.defaultPasswordCount || 0} 个默认密码
                      </button>
                    )}
                    {(latestAccountSecurityExportRisk.mustChangePasswordCount || 0) > 0 && canManageUsers && (
                      <button
                        type="button"
                        onClick={() => navigate('/users?password=需改密&select=visible')}
                        aria-label={`处理账号清单中的需改密账号，共 ${latestAccountSecurityExportRisk.mustChangePasswordCount || 0} 个`}
                        className="rounded-lg border border-amber-300/30 px-3 py-1.5 text-amber-100 hover:border-amber-200/60"
                      >
                        处理 {latestAccountSecurityExportRisk.mustChangePasswordCount || 0} 个需改密
                      </button>
                    )}
                    {(latestAccountSecurityExportRisk.loginLockedCount || 0) > 0 && canManageUsers && (
                      <button
                        type="button"
                        onClick={() => navigate('/users?security=登录锁定&select=visible')}
                        aria-label={`处理账号清单中的登录锁定账号，共 ${latestAccountSecurityExportRisk.loginLockedCount || 0} 个`}
                        className="rounded-lg border border-orange-300/30 px-3 py-1.5 text-orange-100 hover:border-orange-200/60"
                      >
                        处理 {latestAccountSecurityExportRisk.loginLockedCount || 0} 个登录锁定
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
            {latestAccountSecurityBulk && (
              <div className="mt-3 rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-4 py-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="text-xs text-cyan-200">最近账号批量处理</div>
                    <div className="mt-1 text-sm text-cyan-100">
                      {latestAccountSecurityBulk.actor || '未知账号'} · {latestAccountSecurityBulk.at || '时间未记录'}
                    </div>
                    {latestAccountSecurityBulk.action && (
                      <div className="mt-1 text-xs text-cyan-100/75">{latestAccountSecurityBulk.action}</div>
                    )}
                    {latestAccountSecurityBulkId && (
                      <div className="mt-1 break-all text-xs text-cyan-100/75">批次：{latestAccountSecurityBulkId}</div>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-1 text-cyan-100">请求 {latestAccountSecurityBulk.metadata?.requestedCount ?? 0}</span>
                    <span className="rounded border border-emerald-300/20 bg-emerald-500/10 px-2 py-1 text-emerald-100">更新 {latestAccountSecurityBulk.metadata?.changedCount ?? 0}</span>
                    <span className="rounded border border-amber-300/20 bg-amber-500/10 px-2 py-1 text-amber-100">跳过 {latestAccountSecurityBulk.metadata?.skippedCount ?? 0}</span>
                    <button
                      type="button"
                      onClick={() => navigate(accountSecurityBulkLogPath)}
                      aria-label={`查看最近账号批量处理日志，请求 ${latestAccountSecurityBulk.metadata?.requestedCount ?? 0} 个账号，更新 ${latestAccountSecurityBulk.metadata?.changedCount ?? 0} 个`}
                      className="rounded-lg border border-cyan-300/30 px-3 py-1.5 text-cyan-100 hover:border-cyan-200/60"
                    >
                      {latestAccountSecurityBulkId ? '查看本批' : '查看安全日志'}
                    </button>
                    <button
                      type="button"
                      onClick={copyAccountSecurityBulk}
                      aria-label="复制最近账号批量处理摘要"
                      className="rounded-lg border border-cyan-300/30 px-3 py-1.5 text-cyan-100 hover:border-cyan-200/60"
                    >
                      复制摘要
                    </button>
                    {canManageUsers && latestAccountSecurityBulkNeedsNotice && (
                      <button
                        type="button"
                        onClick={() => navigate('/users?password=需改密&select=visible')}
                        aria-label="查看需生成改密通知文案的账号，不会发送"
                        className="rounded-lg border border-amber-300/30 bg-slate-950/20 px-3 py-1.5 text-amber-100 hover:border-amber-200/60"
                      >
                        准备通知文案
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
            {latestAccountSecurityNotice && (
              <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-500/10 px-4 py-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="text-xs text-amber-200">最近改密通知文案</div>
                    <div className="mt-1 text-sm text-amber-100">
                      {latestAccountSecurityNotice.actor || '未知账号'} · {latestAccountSecurityNotice.at || '时间未记录'}
                    </div>
                    {latestAccountSecurityNotice.action && (
                      <div className="mt-1 text-xs text-amber-100/75">{latestAccountSecurityNotice.action}</div>
                    )}
                    {latestAccountSecurityNoticeId && (
                      <div className="mt-1 break-all text-xs text-amber-100/75">编号：{latestAccountSecurityNoticeId}</div>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-1 text-amber-100">涉及 {latestAccountSecurityNotice.metadata?.affectedAccountCount ?? latestAccountSecurityNotice.metadata?.noticeCount ?? 0}</span>
                    <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-1 text-amber-100">未发送</span>
                    <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-1 text-amber-100">{latestAccountSecurityNotice.metadata?.noticeChannel || '复制通知文案'}</span>
                    <span className="rounded border border-white/10 bg-slate-950/25 px-2 py-1 text-amber-100">跳过 {latestAccountSecurityNotice.metadata?.skippedCount ?? 0}</span>
                    <button
                      type="button"
                      onClick={() => navigate(accountSecurityNoticeLogPath)}
                      aria-label={`查看最近改密通知文案生成日志，涉及 ${latestAccountSecurityNotice.metadata?.affectedAccountCount ?? latestAccountSecurityNotice.metadata?.noticeCount ?? 0} 个账号，未发送`}
                      className="rounded-lg border border-amber-300/30 px-3 py-1.5 text-amber-100 hover:border-amber-200/60"
                    >
                      {latestAccountSecurityNoticeId ? '查看本次文案留痕' : '查看安全日志'}
                    </button>
                    <button
                      type="button"
                      onClick={copyAccountSecurityNotice}
                      aria-label="复制最近改密通知文案生成摘要"
                      className="rounded-lg border border-amber-300/30 px-3 py-1.5 text-amber-100 hover:border-amber-200/60"
                    >
                      复制摘要
                    </button>
                    {canManageUsers && Array.isArray(latestAccountSecurityNotice.metadata?.targetUsernames) && latestAccountSecurityNotice.metadata.targetUsernames.length > 0 && (
                      <button
                        type="button"
                        onClick={() => navigate('/users?notice=latest&select=visible')}
                        aria-label={`查看最近改密通知文案涉及的账号，共 ${latestAccountSecurityNotice.metadata.targetUsernames.length} 个，未发送`}
                        className="rounded-lg border border-blue-300/30 bg-slate-950/20 px-3 py-1.5 text-blue-100 hover:border-blue-200/60"
                      >
                        查看文案涉及账号
                      </button>
                    )}
                    {canManageUsers && (userStats?.mustChangePassword || 0) > 0 && (
                      <button
                        type="button"
                        onClick={() => navigate('/users?password=需改密&select=visible')}
                        aria-label={`处理当前仍需改密账号，共 ${userStats.mustChangePassword || 0} 个`}
                        className="rounded-lg border border-amber-300/30 bg-slate-950/20 px-3 py-1.5 text-amber-100 hover:border-amber-200/60"
                      >
                        处理 {userStats.mustChangePassword || 0} 个需改密
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </Panel>
        )}

        <Panel className="p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="font-semibold flex items-center gap-2">
              <Download size={17} className="text-violet-300" />
              意见书导出看板
            </h2>
            <div className="flex items-center gap-3">
              {canReview && <button type="button" onClick={() => navigate(exportFilterPath('exported'))} className="text-blue-300 text-sm">进入审核中心 ›</button>}
              {canViewLogs && <button type="button" onClick={() => openStatsFocus('export')} className="text-blue-300 text-sm">进入分析 ›</button>}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
            <AiHealthMetric label="导出总次数" value={exportStats.total} sub={`覆盖 ${exportStats.proposalCount} 个方案`} valueClass="text-blue-100" to={canReview ? exportFilterPath('exported') : ''} />
            <AiHealthMetric label="预览" value={exportStats.previewCount} sub="在线查看次数" valueClass="text-cyan-200" to={canReview ? exportFilterPath('preview') : ''} />
            <AiHealthMetric label="Word 导出" value={exportStats.wordCount} sub="Word 文件下载" valueClass="text-emerald-200" to={canReview ? exportFilterPath('word') : ''} />
            <AiHealthMetric label="PDF 导出" value={exportStats.pdfCount} sub="PDF 文件下载" valueClass="text-violet-200" to={canReview ? exportFilterPath('pdf') : ''} />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
              <div className="text-sm text-slate-300">入口来源</div>
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                {(exportStats.bySource || []).map(item => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => canReview && navigate(exportSourceFilterPath(item.label))}
                    disabled={!canReview}
                    aria-label={`查看意见书导出入口来源：${item.label}，共 ${item.value} 次`}
                    className={`rounded-lg border border-blue-500/15 bg-slate-950/45 p-3 text-left ${canReview ? 'hover:border-blue-300/35' : 'cursor-default opacity-80'}`}
                  >
                    <div className="text-xs text-slate-500">{item.label}</div>
                    <div className="mt-2 text-2xl font-semibold text-blue-100">{item.value}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm text-slate-300">最近导出</div>
                {canViewLogs && <button type="button" onClick={() => navigate('/logs?type=执行动作&q=意见书')} className="text-xs text-blue-300">查看日志</button>}
              </div>
              <div className="mt-2 text-xs text-slate-500">当前系统版本：{appVersion}</div>
              {(exportStats.recent || []).length === 0 ? (
                <div className="mt-3 rounded-lg border border-blue-500/15 bg-slate-950/45 px-4 py-8 text-sm text-slate-500">暂无意见书导出记录</div>
              ) : (
                <div className="mt-3 space-y-3">
                  {(exportStats.recent || []).slice(0, 4).map(item => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => canReview && navigate(`/review/${item.proposalId}?section=exports`)}
                      disabled={!canReview}
                      aria-label={`查看最近导出的方案：${item.proposalTitle}，导出类型 ${item.typeText}，来源 ${item.sourceText}`}
                      className={`w-full rounded-lg border border-blue-500/15 bg-slate-950/45 px-3 py-3 text-left transition ${canReview ? 'hover:border-blue-300/35' : 'cursor-default opacity-80'}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm text-blue-100 truncate">{item.proposalTitle}</div>
                          <div className="mt-1 text-xs text-slate-500">{item.actor || '管理员'} · {item.sourceText}</div>
                        </div>
                        <span className="px-2 py-1 rounded border border-violet-400/30 bg-violet-500/10 text-xs text-violet-200 whitespace-nowrap">
                          {item.typeText}
                        </span>
                      </div>
                      <div className="mt-2 text-xs text-slate-400">{item.at || '-'} · 留痕版本 {item.appVersion || '未记录版本'}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Panel>
        </>
        )}

        {canReview && (
          <Panel className="p-4">
            <h2 className="font-semibold mb-3">执行漏斗</h2>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
              <ExecutionFunnelCard
                label="已人工复核"
                value={executionStats.reviewed}
                toneClass="border-emerald-500/20 text-emerald-200"
                to="/review?manualReview=已复核"
              />
              <ExecutionFunnelCard
                label="待签发"
                value={executionStats.pendingSignOff}
                toneClass="border-amber-500/20 text-amber-200"
                to="/review?queue=已复核未签发"
              />
              <ExecutionFunnelCard
                label="已签发"
                value={executionStats.signed}
                toneClass="border-blue-500/20 text-blue-200"
                to="/review?signOff=已签发"
              />
              <ExecutionFunnelCard
                label="待归档"
                value={executionStats.pendingArchive}
                toneClass="border-cyan-500/20 text-cyan-200"
                to="/review?queue=已签发未归档"
              />
              <ExecutionFunnelCard
                label="已归档"
                value={executionStats.archived}
                toneClass="border-violet-500/20 text-violet-200"
                to="/review?archive=已归档"
              />
            </div>
          </Panel>
        )}

        {(canReview || canViewLogs) && (
        <Panel className="p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="font-semibold">执行驾驶舱</h2>
            {canViewLogs && <button type="button" onClick={() => navigate('/logs?type=执行动作')} className="text-blue-300 text-sm">查看执行日志 ›</button>}
          </div>
          {canReview && (
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-3">
              {executionCockpitCards.map(card => (
                <button
                  key={card.key}
                  type="button"
                  onClick={() => navigate(card.to)}
                  aria-label={`查看执行驾驶舱指标：${card.label}，当前 ${card.value}，${card.sub}`}
                  className={`rounded-lg border bg-slate-900/60 p-4 text-left transition hover:-translate-y-0.5 hover:border-white/25 ${card.toneClass}`}
                >
                  <div className="text-xs text-slate-500">{card.label}</div>
                  <div className="mt-2 text-2xl font-bold">{card.value}</div>
                  <div className="mt-1 text-xs text-slate-400">{card.sub}</div>
                </button>
              ))}
            </div>
          )}
          {canViewLogs && (
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] gap-3">
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
              <div className="text-sm text-slate-300">执行动作分布</div>
              <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
                {executionEntryGroups.map(group => (
                  <button
                    key={group.key}
                    type="button"
                    onClick={() => navigate(group.to)}
                    aria-label={`查看执行动作分布：${group.label}，共 ${group.value} 条`}
                    className="rounded-lg border border-blue-500/15 bg-slate-950/45 p-3 text-left hover:border-blue-300/35 transition"
                  >
                    <div className="text-xs text-slate-500">{group.label}</div>
                    <div className="mt-2 text-2xl font-semibold text-blue-100">{group.value}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm text-slate-300">最近执行动作</div>
                <button type="button" onClick={() => navigate('/logs?type=执行动作')} className="text-xs text-blue-300">进入日志中心</button>
              </div>
              {(executionLogs || []).length === 0 ? (
                <div className="mt-3 rounded-lg border border-blue-500/15 bg-slate-950/45 px-4 py-8 text-sm text-slate-500">暂无执行动作</div>
              ) : (
                <div className="mt-3 space-y-3">
                  {(executionLogs || []).slice(0, 4).map(log => (
                    <button
                      key={log.id}
                      type="button"
                      onClick={() => navigate(log.proposalId ? `/logs?type=执行动作&proposalId=${log.proposalId}` : '/logs?type=执行动作')}
                      aria-label={`查看执行动作日志：${log.action}，执行人 ${log.actor || '系统'}，时间 ${log.at || '-'}`}
                      className="w-full rounded-lg border border-blue-500/15 bg-slate-950/45 px-3 py-3 text-left hover:border-blue-300/35 transition"
                    >
                      <div className="text-sm text-blue-100 truncate">{log.action}</div>
                      <div className="mt-1 text-xs text-slate-500">{log.actor || '系统'} · {log.at || '-'}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          )}
        </Panel>
        )}

        {canReview && (
        <Panel className="p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="font-semibold">提交人跟进视角</h2>
            <button type="button" onClick={() => navigate('/review?sort=最新提交优先')} className="text-blue-300 text-sm">进入审核中心 ›</button>
          </div>
          {submitterFollowups.length === 0 ? (
            <div className="rounded-lg border border-blue-500/15 bg-slate-950/45 px-4 py-8 text-sm text-slate-500">暂无提交人跟进数据</div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
              {submitterFollowups.map(item => (
                <div
                  key={item.name}
                  className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4 text-left transition hover:-translate-y-0.5 hover:border-white/25"
                >
                  <button
                    type="button"
                    onClick={() => openSubmitterReview(item.name)}
                    aria-label={`查看提交人 ${item.name} 的方案跟进情况，共 ${item.total} 个方案，待跟进 ${item.pending} 个，建议催办 ${item.needReminder} 个`}
                    className="w-full text-left"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-blue-100 truncate">{item.name}</div>
                        <div className="mt-1 text-xs text-slate-500">共 {item.total} 个方案</div>
                      </div>
                      <span className={`px-2 py-1 rounded border text-xs whitespace-nowrap ${
                        item.overdue > 0
                          ? 'border-red-400/30 bg-red-500/10 text-red-200'
                          : 'border-blue-400/20 bg-blue-500/10 text-blue-200'
                      }`}>
                        {item.overdue > 0 ? `${item.overdue} 个超时` : '正常跟进'}
                      </span>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3">
                      <div className="rounded-lg border border-amber-400/15 bg-slate-950/45 px-3 py-3">
                        <div className="text-xs text-slate-500">待跟进</div>
                        <div className="mt-2 text-xl font-semibold text-amber-200">{item.pending}</div>
                      </div>
                      <div className="rounded-lg border border-violet-400/15 bg-slate-950/45 px-3 py-3">
                        <div className="text-xs text-slate-500">建议催办</div>
                        <div className="mt-2 text-xl font-semibold text-violet-200">{item.needReminder}</div>
                      </div>
                      <div className="rounded-lg border border-red-400/15 bg-slate-950/45 px-3 py-3">
                        <div className="text-xs text-slate-500">高风险项</div>
                        <div className="mt-2 text-xl font-semibold text-red-200">{item.highRisk}</div>
                      </div>
                      <div className="rounded-lg border border-emerald-400/15 bg-slate-950/45 px-3 py-3">
                        <div className="text-xs text-slate-500">未导出方案</div>
                        <div className="mt-2 text-xl font-semibold text-emerald-200">{item.unexported}</div>
                      </div>
                    </div>
                    <div className="mt-3 text-xs text-slate-500">最近提交：{item.latestAt || '-'}</div>
                  </button>
                  <div className={`mt-3 grid gap-2 ${canViewLogs ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    <button
                      type="button"
                      onClick={() => openSubmitterReview(item.name)}
                      aria-label={`进入审核中心查看提交人 ${item.name} 的方案`}
                      className="rounded-lg border border-blue-400/20 bg-blue-500/10 px-3 py-2 text-xs text-blue-100 hover:border-blue-300/40"
                    >
                      审核中心
                    </button>
                    {canViewLogs && (
                      <button
                        type="button"
                        onClick={() => openSubmitterLogs(item.name)}
                        aria-label={`查看提交人 ${item.name} 的执行日志`}
                        className="rounded-lg border border-violet-400/20 bg-violet-500/10 px-3 py-2 text-xs text-violet-100 hover:border-violet-300/40"
                      >
                        执行日志
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
        )}

        {canReview && (
        <Panel className="p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="font-semibold">执行催办看板</h2>
            <button type="button" onClick={() => navigate('/review?needReminder=1')} className="text-blue-300 text-sm">进入审核中心 ›</button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-3">
              <div className="text-xs text-slate-500">催办来源</div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {(reminderStats.bySource || []).map(item => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => navigate(item.label === '未催办' ? '/review?source=未催办' : ['自动催办', '系统草稿（未发送）'].includes(item.label) ? '/review?source=自动催办' : '/review?source=人工登记')}
                    aria-label={`查看${item.label === '自动催办' ? '系统草稿（未发送）' : item.label}来源的催办方案，共 ${item.value} 个`}
                    className="px-2 py-1 rounded border border-blue-400/20 bg-slate-950/45 text-slate-300 hover:border-blue-300/40"
                  >
                    {item.label === '自动催办' ? '系统草稿（未发送）' : item.label} {item.value}
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-3">
              <div className="text-xs text-slate-500">建议催办方案</div>
              <button type="button" onClick={() => navigate('/review?needReminder=1')} aria-label={`查看建议催办方案，共 ${reminderStats.totalNeedReminder || 0} 个`} className="mt-2 text-2xl font-bold text-amber-200 hover:text-amber-100">
                {reminderStats.totalNeedReminder || 0}
              </button>
              <div className="mt-1 text-xs text-slate-400">待执行催办规则命中</div>
            </div>
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-3">
              <div className="text-xs text-slate-500">已留痕催办</div>
              <div className="mt-2 text-2xl font-bold text-cyan-200">{reminderStats.totalWithReminder || 0}</div>
              <div className="mt-1 text-xs text-slate-400">仅统计真实人工登记；未发送草稿不计完成</div>
            </div>
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-4 gap-3">
            <QueueCard
              title="待高风险复核"
              icon={ShieldAlert}
              items={executionQueues.highRiskPendingReview || []}
              emptyText="当前没有待高风险复核方案"
              tone="amber"
              renderMeta={(item) => (
                <ExecutionStageBadge label={`${item.highRiskCount || 0} 项高风险`} tone="amber" />
              )}
            />
            <QueueCard
              title="待签发"
              icon={Signature}
              items={executionQueues.pendingSignOff || []}
              emptyText="当前没有待签发方案"
              tone="emerald"
              renderMeta={(item) => (
                <ExecutionStageBadge label="待签发" tone="emerald" />
              )}
            />
            <QueueCard
              title="待归档"
              icon={FolderKanban}
              items={executionQueues.pendingArchive || []}
              emptyText="当前没有待归档方案"
              tone="cyan"
              renderMeta={(item) => (
                <ExecutionStageBadge label="待归档" tone="cyan" />
              )}
            />
            <QueueCard
              title="超时催办"
              icon={BellRing}
              items={executionQueues.overdueReminders || []}
              emptyText="当前没有超时催办方案"
              tone="blue"
              renderMeta={(item) => (
                <ExecutionStageBadge label={item.overdueReminder?.label || '正常'} tone={item.overdueReminder?.level === '高' ? 'amber' : 'blue'} />
              )}
            />
            <QueueCard
              title="临近超时"
              icon={ShieldAlert}
              items={executionQueues.approachingReminders || []}
              emptyText="当前没有临近超时方案"
              tone="amber"
              renderMeta={(item) => (
                <ExecutionStageBadge label={item.overdueReminder?.label || '待跟进'} tone="amber" />
              )}
            />
            <QueueCard
              title="最近催办"
              icon={BellRing}
              items={executionQueues.recentReminders || []}
              emptyText="当前没有催办记录"
              tone="blue"
              renderMeta={(item) => (
                <ExecutionStageBadge label={`${item.lastReminderStage || '已催办'} · ${item.lastReminderSource === 'auto' ? '自动' : '人工'}`} tone="blue" />
              )}
            />
          </div>
        </Panel>
        )}

        {canReview && (
        <Panel className="p-4">
          <div className="flex justify-between mb-2">
            <h2 className="font-semibold">方案审核队列 <span className="text-xs text-slate-400">（最近提交）</span></h2>
            <button type="button" onClick={() => navigate('/review')} className="text-blue-300 text-sm">查看全部 ›</button>
          </div>
          <p id="review-table-scroll-help" className="mb-2 text-xs text-slate-500 sm:sr-only">
            表格较宽，可在此区域横向滚动查看全部列。
          </p>
          <div
            className="review-table-scroll overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="方案审核队列表格，可横向滚动"
            aria-describedby="review-table-scroll-help"
          >
            <table
              className="w-full text-sm"
              aria-label={`方案审核队列，最近提交 ${proposals.length} 个方案`}
            >
              <caption className="sr-only">
                方案审核队列。展示最近提交的 {proposals.length} 个方案，包括方案名称、类型、审核机制、状态、评分、风险、提交时间和查看操作。
              </caption>
              <thead className="text-slate-400 bg-slate-900/70">
                <tr>
                  {['方案名称', '类型', '审核机制', '状态', '评分', '风险', '提交时间', '操作'].map(h => (
                    <th key={h} className="text-left py-2 px-3 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(proposals || []).map((p) => (
                  <tr key={p.id} className="border-b border-blue-500/10 hover:bg-blue-500/5">
                    <td className="px-3 py-2 min-w-[220px]">{p.title}</td>
                    <td className="px-3 py-2"><TypeBadge text={p.type} /></td>
                    <td className="px-3 py-2 text-slate-300 min-w-[150px]">{p.robot}</td>
                    <td className="px-3 py-2"><StatusBadge s={p.status} /></td>
                    <td className="px-3 py-2 text-cyan-200">{p.avgScore == null ? '暂无评分' : p.avgScore}</td>
                    <td className="px-3 py-2">{p.highRiskCount > 0 ? <span className="text-red-300">{p.highRiskCount} 项</span> : <span className="text-emerald-300">0 项</span>}</td>
                    <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{p.createdAt}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => navigate(`/review/${p.id}`)}
                        onFocus={() => preloadRoute('/review/:id')}
                        onMouseEnter={() => preloadRoute('/review/:id')}
                        aria-label={`查看方案：${p.title}`}
                        className="text-blue-300 hover:text-blue-200 text-sm whitespace-nowrap"
                      >
                        查看 ›
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        )}
        </div>
      </section>

      <aside className="col-span-12 xl:col-span-3 space-y-4">
        {homeMode === 'ops' && canViewLogs && (
        <button type="button" onClick={() => openStatsFocus('score')} onFocus={preloadReviewCharts} onMouseEnter={preloadReviewCharts} aria-label="进入分析页面查看审核效率趋势" className="block w-full text-left">
          <Panel className="p-4 h-[235px] transition hover:-translate-y-0.5 hover:border-white/25">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h2 className="font-semibold">审核效率趋势</h2>
              <span className="text-xs text-blue-300">进入分析</span>
            </div>
            {(trend || []).length > 0 ? (
              <Suspense fallback={<ChartLoading className="h-[82%]" />}>
                <TrendAreaChart data={trend || []} />
              </Suspense>
            ) : (
              <div className="grid h-[82%] place-items-center text-sm text-slate-400">暂无真实审核趋势数据</div>
            )}
          </Panel>
        </button>
        )}

        {homeMode === 'ops' && canViewLogs && (
        <button type="button" onClick={() => openStatsFocus('workflow')} onFocus={preloadReviewCharts} onMouseEnter={preloadReviewCharts} aria-label="进入分析页面查看专业任务占比" className="block w-full text-left">
          <Panel className="p-4 h-[235px] transition hover:-translate-y-0.5 hover:border-white/25">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h2 className="font-semibold">专业任务占比</h2>
              <span className="text-xs text-blue-300">进入分析</span>
            </div>
            {hasProfessionalTaskData ? (
              <div className="grid grid-cols-2 gap-2 h-[82%]">
                <Suspense fallback={<ChartLoading />}>
                  <ProfessionalPieChart data={pieData} />
                </Suspense>
                <div className="space-y-1 overflow-hidden">
                  {pieData.map(item => (
                    <div key={item.name} className="flex items-center justify-between gap-2 text-xs text-slate-300">
                      <span className="flex items-center gap-1 min-w-0">
                        <i className="h-2 w-2 rounded-full shrink-0" style={{ background: item.color }} />
                        <span className="truncate">{item.name}</span>
                      </span>
                      <span className="text-slate-400">{item.value}%</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="grid h-[82%] place-items-center text-sm text-slate-400">暂无真实专业任务数据</div>
            )}
          </Panel>
        </button>
        )}

        <Panel className="p-4">
          <div className="flex justify-between mb-2">
            <h2 className="font-semibold">系统状态</h2>
            <span className="text-xs text-slate-400">真实记录</span>
          </div>
          {systemStatusRows.map(item => (
            <div key={`${item.tag}-${item.text}`} className="flex gap-2 items-center py-2 border-b border-blue-500/10 text-sm last:border-0">
              <span className={`px-1.5 rounded text-xs ${item.important ? 'bg-amber-500/20 text-amber-200' : 'bg-blue-500/20 text-blue-200'}`}>{item.tag}</span>
              <span className="flex-1 text-slate-300 truncate" title={item.text}>{item.text}</span>
              <span className="max-w-28 truncate text-slate-400" title={item.meta}>{item.meta}</span>
            </div>
          ))}
        </Panel>

        {canViewLogs && (
        <Panel className="p-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <h2 className="font-semibold flex items-center gap-2">
              <FileText size={17} className="text-blue-300" />
              审核动作日志
            </h2>
            <button type="button" onClick={() => navigate('/logs?type=审核动作')} className="text-blue-300 text-xs">查看全部</button>
          </div>
          {(reviewLogs || []).slice(0, 5).map(log => (
            <div key={log.id} className="flex gap-2 py-2 text-sm border-b border-blue-500/10 last:border-0">
              <span className="text-blue-400">●</span>
              <span className="flex-1 text-slate-300 truncate"><b className="font-medium text-white">{log.actor}</b>　{log.action}</span>
              <span className="text-slate-400 whitespace-nowrap">{log.at?.slice(5, 16)}</span>
            </div>
          ))}
        </Panel>
        )}

        {canViewLogs && (
        <Panel className="p-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <h2 className="font-semibold flex items-center gap-2">
              <BellRing size={17} className="text-cyan-300" />
              执行动作日志
            </h2>
            <button type="button" onClick={() => navigate('/logs?type=执行动作')} className="text-blue-300 text-xs">查看全部</button>
          </div>
          {(executionLogs || []).length === 0 ? (
            <div className="py-4 text-sm text-slate-500">暂无执行动作</div>
          ) : (executionLogs || []).slice(0, 5).map(log => {
            const meta = executionLogMeta(log)
            return (
              <button
                key={log.id}
                type="button"
                onClick={() => navigate(meta.to)}
                className="w-full flex gap-2 py-2 text-sm border-b border-blue-500/10 last:border-0 text-left hover:bg-blue-500/5 transition"
              >
                <span className="text-cyan-400">●</span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2">
                    <span className={`px-1.5 py-0.5 rounded text-[11px] border shrink-0 ${meta.badgeClass}`}>{meta.label}</span>
                    <span className="text-slate-300 truncate"><b className="font-medium text-white">{log.actor}</b>　{log.action}</span>
                  </span>
                </span>
                <span className="text-slate-400 whitespace-nowrap">{log.at?.slice(5, 16)}</span>
              </button>
            )
          })}
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
