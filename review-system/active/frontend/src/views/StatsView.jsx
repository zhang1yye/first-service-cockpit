import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { BellRing, Bot, ChartNoAxesCombined, Download, FileText, FolderKanban, ShieldAlert, Signature, TrendingUp } from '../lib/lucide.js'
import { api, getUser } from '../lib/api'
import { appVersion } from '../lib/appVersion'
import { hasPermission } from '../lib/permissions'
import { loadReviewCharts } from '../lib/chartPreload'
import Panel from '../components/Panel'

const statusColors = {
  待审核: '#bd1e2d',
  审核中: '#d76a73',
  待复核: '#f59e0b',
  待修改: '#8b5cf6',
  已通过: '#10b981'
}

const focusMeta = {
  status: '审核状态分布',
  type: '方案类型统计',
  score: '方案评分分布',
  users: '账号结构',
  security: '账号安全分析',
  rules: '规则结构',
  workflow: '审核编排',
  execution: '执行漏斗',
  reminder: '催办分析',
  export: '意见书导出分析',
  attachments: '附件解析质量',
  ai: 'AI 调用质量'
}

const extractionTypeTextMap = {
  pdf: 'PDF 文本',
  'pdf-table': 'PDF 表格增强',
  docx: 'DOCX',
  doc: '旧版 DOC',
  excel: 'Excel 表格',
  table: '文本表格',
  text: '纯文本',
  unknown: '未知类型',
  error: '解析异常',
  未标注: '未标注'
}

const StatusPieChart = lazy(() => loadReviewCharts().then(module => ({ default: module.StatusPieChart })))
const TypeBarChart = lazy(() => loadReviewCharts().then(module => ({ default: module.TypeBarChart })))
const ScoreBarChart = lazy(() => loadReviewCharts().then(module => ({ default: module.ScoreBarChart })))
const ReminderStageBarChart = lazy(() => loadReviewCharts().then(module => ({ default: module.ReminderStageBarChart })))

function ChartLoading({ className = 'h-full' }) {
  return <div className={`${className} grid place-items-center text-sm text-slate-500`}>正在加载图表...</div>
}

function formatBytes(value = 0) {
  const bytes = Number(value) || 0
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function accountSecurityRiskSummaryText(riskSummary = {}) {
  if (typeof riskSummary === 'string') return riskSummary
  if (!riskSummary || typeof riskSummary !== 'object') return ''
  return [
    `默认密码 ${riskSummary.defaultPasswordCount ?? 0}`,
    `需改密 ${riskSummary.mustChangePasswordCount ?? 0}`,
    `登录锁定 ${riskSummary.loginLockedCount ?? 0}`,
    `长期未登录 ${riskSummary.inactiveLoginCount ?? 0}`
  ].join(' · ')
}

export default function StatsView() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [items, setItems] = useState([])
  const [dashboard, setDashboard] = useState(null)
  const [loading, setLoading] = useState(true)
  const [dataError, setDataError] = useState('')
  const sectionRefs = useRef({})
  const focus = searchParams.get('focus') || ''
  const currentUser = getUser()
  const canReview = hasPermission(currentUser, 'reviewProposal')
  const canManageSystem = hasPermission(currentUser, 'manageSystem')
  const canManageUsers = hasPermission(currentUser, 'manageUsers')
  const canViewLogs = hasPermission(currentUser, 'viewLogs')
  const canViewSecurityStats = (canManageUsers || canManageSystem) && canViewLogs
  const canViewStatsFocus = (key) => {
    if (key === 'users') return canManageUsers
    if (key === 'security') return canViewSecurityStats
    if (key === 'rules' || key === 'workflow') return canManageSystem
    return true
  }
  const requestedFocusTitle = focusMeta[focus] || ''
  const focusedTitle = canViewStatsFocus(focus) ? requestedFocusTitle : ''
  const unauthorizedFocusTitle = focus && requestedFocusTitle && !canViewStatsFocus(focus) ? requestedFocusTitle : ''

  useEffect(() => {
    (async () => {
      try {
        const [proposalData, dashboardData] = await Promise.all([
          api.get('/proposals'),
          api.get('/dashboard')
        ])
        setItems(proposalData.items || [])
        setDashboard(dashboardData)
        setDataError('')
      } catch {
        setItems([])
        setDashboard(null)
        setDataError('数据分析加载失败，当前显示为空值；请重试，勿将空值视为真实业务数据。')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  useEffect(() => {
    if (loading || !focus || !canViewStatsFocus(focus)) return
    const target = sectionRefs.current[focus]
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [canManageSystem, canManageUsers, focus, loading])

  const stats = useMemo(() => {
    const byStatus = Object.entries(
      items.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1
        return acc
      }, {})
    ).map(([name, value]) => ({ name, value, color: statusColors[name] || '#64748b' }))

    const byType = Object.entries(
      items.reduce((acc, item) => {
        acc[item.type] = (acc[item.type] || 0) + 1
        return acc
      }, {})
    ).map(([name, value]) => ({ name, value }))

    const riskTotal = items.reduce((sum, item) => sum + (item.highRiskCount || 0), 0)
    const scoredItems = items.filter(item => item.avgScore != null && Number.isFinite(Number(item.avgScore)))
    const avgScore = scoredItems.length > 0
      ? Math.round(scoredItems.reduce((sum, item) => sum + Number(item.avgScore), 0) / scoredItems.length)
      : null
    const scoreBars = scoredItems.map(item => ({
      name: item.title.length > 8 ? `${item.title.slice(0, 8)}...` : item.title,
      score: Number(item.avgScore)
    }))

    return { byStatus, byType, riskTotal, avgScore, scoreBars }
  }, [items])

  const userStats = dashboard?.userStats || { total: 0, enabled: 0, disabled: 0, admins: 0, byRole: [], mustChangePassword: 0, defaultPassword: 0, loginLocked: 0 }
  const userStatsByRole = Array.isArray(userStats.byRole) ? userStats.byRole : []
  const securityStats = dashboard?.securityStats || {
    total: 0,
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
  const latestAccountSecurityExportRisk = securityStats.latestAccountSecurityExport?.metadata?.riskSummary || {}
  const latestAccountSecurityExportRiskText = accountSecurityRiskSummaryText(latestAccountSecurityExportRisk)
  const latestAccountSecurityNoticeId = securityStats.latestAccountSecurityNotice?.metadata?.auditId || ''
  const latestAccountSecurityNoticeMeta = securityStats.latestAccountSecurityNotice?.metadata || {}
  const latestAccountSecurityNoticeNames = Array.isArray(latestAccountSecurityNoticeMeta.targetNames)
    ? latestAccountSecurityNoticeMeta.targetNames
    : []
  const latestAccountSecurityNoticeUsers = Array.isArray(latestAccountSecurityNoticeMeta.targetUsernames)
    ? latestAccountSecurityNoticeMeta.targetUsernames
    : []
  const latestAccountSecurityBulkNeedsNotice = securityStats.latestAccountSecurityBulk
    ? String(securityStats.latestAccountSecurityBulk.action || '').includes('改密') ||
      Number(securityStats.latestAccountSecurityBulk.metadata?.skippedAlreadyRequiredCount || 0) > 0
    : false
  const defaultPasswordCount = Number(userStats.defaultPassword) || Number(latestAccountSecurityExportRisk?.defaultPasswordCount) || 0
  const mustChangePasswordCount = Number(userStats.mustChangePassword) || Number(latestAccountSecurityExportRisk?.mustChangePasswordCount) || 0
  const loginLockedCount = Number(userStats.loginLocked) || Number(latestAccountSecurityExportRisk?.loginLockedCount) || 0
  const ruleStats = dashboard?.ruleStats || { total: 0, enabled: 0, disabled: 0, byCategory: [] }
  const executionStats = dashboard?.executionStats || { reviewed: 0, pendingSignOff: 0, signed: 0, pendingArchive: 0, archived: 0 }
  const executionQueues = dashboard?.executionQueues || {
    highRiskPendingReview: [],
    pendingSignOff: [],
    pendingArchive: [],
    recentReminders: [],
    overdueReminders: [],
    approachingReminders: []
  }
  const reminderStats = dashboard?.reminderStats || {
    totalWithReminder: 0,
    totalNeedReminder: 0,
    autoCount: 0,
    manualCount: 0,
    noneCount: 0,
    bySource: [],
    byStage: [],
    pendingBySource: []
  }
  const workflow = dashboard?.workflow || {
    internal: { enabledCount: 0, reviewerNames: [] },
    market: { initiatorName: '', reviewCount: 0, reviewerNames: [] }
  }
  const exportStats = dashboard?.exportStats || {
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
  const attachmentStats = dashboard?.attachmentStats || {
    total: 0,
    parsed: 0,
    failed: 0,
    unsupported: 0,
    pending: 0,
    parseRate: 0,
    totalBytes: 0,
    totalTextChars: 0,
    pdfTableFiles: 0,
    pdfTableCount: 0,
    byStatus: [],
    byType: [],
    issueProposalCount: 0,
    recentIssues: []
  }
  const aiTraceStats = dashboard?.aiTraceStats || {
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
    byProvider: [],
    byModel: [],
    recent: []
  }

  if (loading) return <div className="flex items-center justify-center h-64 text-slate-400">加载中...</div>

  const Metric = ({ icon: Icon, label, value, sub, colorClass, to }) => {
    const Component = to ? 'button' : 'div'
    const actionLabel = to
      ? `查看${label}，当前值 ${value}${sub ? `，${sub}` : ''}，跳转目标 ${to}`
      : `${label}，当前值 ${value}${sub ? `，${sub}` : ''}`
    return (
      <Component
        type={to ? 'button' : undefined}
        onClick={to ? () => navigate(to) : undefined}
        title={actionLabel}
        aria-label={actionLabel}
        className={`w-full rounded-lg text-left transition ${to ? 'hover:-translate-y-0.5' : ''}`}
      >
        <Panel className={`p-4 flex items-center gap-4 min-h-[86px] ${to ? 'hover:border-cyan-300/40' : ''}`}>
      <div className={`h-12 w-12 rounded-lg border grid place-items-center ${colorClass}`}>
        <Icon size={23} aria-hidden="true" />
      </div>
      <div>
        <div className="text-sm text-slate-400">{label}</div>
        <div className="text-2xl font-bold text-blue-100">{value}</div>
        {sub && <div className="text-xs text-slate-500">{sub}</div>}
      </div>
        </Panel>
      </Component>
    )
  }

  const executionQueueStats = [
    {
      key: 'highRisk',
      label: '待高风险复核',
      value: executionQueues.highRiskPendingReview.length,
      icon: ShieldAlert,
      colorClass: 'bg-amber-500/10 border-amber-400/30 text-amber-300'
    },
    {
      key: 'signOff',
      label: '待签发',
      value: executionQueues.pendingSignOff.length,
      icon: Signature,
      colorClass: 'bg-emerald-500/10 border-emerald-400/30 text-emerald-300'
    },
    {
      key: 'archive',
      label: '待归档',
      value: executionQueues.pendingArchive.length,
      icon: FolderKanban,
      colorClass: 'bg-cyan-500/10 border-cyan-400/30 text-cyan-300'
    },
    {
      key: 'reminder',
      label: '最近催办',
      value: executionQueues.recentReminders.length,
      icon: BellRing,
      colorClass: 'bg-blue-500/10 border-blue-400/30 text-blue-300'
    },
    {
      key: 'overdue',
      label: '超时催办',
      value: executionQueues.overdueReminders.length,
      icon: ShieldAlert,
      colorClass: 'bg-red-500/10 border-red-400/30 text-red-300'
    },
    {
      key: 'approaching',
      label: '临近超时',
      value: executionQueues.approachingReminders.length,
      icon: BellRing,
      colorClass: 'bg-amber-500/10 border-amber-400/30 text-amber-300'
    }
  ]

  const registerSection = (key) => (node) => {
    if (node) sectionRefs.current[key] = node
  }

  const focusPanelClass = (key) => (
    focus === key
      ? 'border-cyan-300/60 ring-1 ring-cyan-300/70 shadow-[0_0_28px_rgba(34,211,238,.12)]'
      : ''
  )

  const exportFilterPath = (mode = 'all') => {
    switch (mode) {
      case 'preview':
        return '/review?export=预览&sort=最近导出优先'
      case 'word':
        return '/review?export=Word&sort=导出次数优先'
      case 'pdf':
        return '/review?export=PDF&sort=最近导出优先'
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
    return exportFilterPath()
  }

  const hermesFocusPath = '/bots?focus=hermes&from=ai-fallback'
  const aiLogPath = (result = '') => {
    const query = new URLSearchParams({ type: '执行动作', actionGroup: 'AI调用', range: '近30天' })
    if (result) query.set('result', result)
    return `/logs?${query.toString()}`
  }
  const accountSecurityLogPath = (result = '', keyword = '') => {
    const query = new URLSearchParams({ type: '账号安全', range: '近30天' })
    if (result) query.set('result', result)
    if (keyword) query.set('q', keyword)
    return `/logs?${query.toString()}`
  }
  const latestFailureLogPath = securityStats.latestFailureAction
    ? accountSecurityLogPath(securityStats.latestFailureResult || '', securityStats.latestFailureAction)
    : accountSecurityLogPath('失败')
  const aiResultText = (item = {}) => {
    if (item.fallback || item.status === 'fallback') return '回退'
    if (item.status === 'failed') return '失败'
    if (item.status === 'success') return '成功'
    return '待确认'
  }

  const DrilldownCard = ({ label, value, sub, valueClass, to, borderClass = 'border-blue-500/20', hoverClass = 'hover:border-blue-300/35' }) => {
    const Component = to ? 'button' : 'div'
    const actionLabel = to
      ? `查看${label}明细，当前值 ${value}${sub ? `，${sub}` : ''}，跳转目标 ${to}`
      : `${label}，当前值 ${value}${sub ? `，${sub}` : ''}`
    return (
      <Component
        type={to ? 'button' : undefined}
        onClick={to ? () => navigate(to) : undefined}
        title={actionLabel}
        aria-label={actionLabel}
        className={`rounded-lg border ${borderClass} bg-slate-900/60 p-4 text-left transition ${to ? hoverClass : ''}`}
      >
        <div className="text-sm text-slate-400">{label}</div>
        <div className={`mt-2 text-2xl font-semibold ${valueClass}`}>{value}</div>
        <div className="mt-1 text-xs text-slate-500">{sub}</div>
      </Component>
    )
  }

  return (
    <div className="space-y-4">
      {dataError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          <span>{dataError}</span>
          <button type="button" onClick={() => window.location.reload()} className="rounded-lg border border-red-300/40 px-3 py-1.5 text-xs hover:border-red-200/70">
            重新加载
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-blue-200 flex items-center gap-2">
            <ChartNoAxesCombined size={21} aria-hidden="true" />
            数据分析
          </h1>
          <p className="text-sm text-slate-400 mt-1">汇总方案审核状态、类型、风险项和评分分布。</p>
          {focusedTitle && (
            <div className="mt-2 inline-flex items-center rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1 text-xs text-cyan-100">
              当前聚焦：{focusedTitle}
            </div>
          )}
          {unauthorizedFocusTitle && (
            <div className="mt-2 rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100">
              当前账号无权查看“{unauthorizedFocusTitle}”聚焦模块，已保留可访问的数据分析内容。
            </div>
          )}
          {canViewLogs && !canReview && (
            <div className="mt-2 rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100">
              当前账号为只读分析视图：可查看数据、日志和趋势，涉及方案流转的入口已按权限关闭。
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <Metric label="方案总数" value={items.length} sub="累计提交" icon={FileText} colorClass="bg-blue-500/15 border-blue-400/40 text-blue-300" to={canReview ? '/review?sort=最新提交优先' : ''} />
        <Metric label="平均评分" value={stats.avgScore == null ? '暂无评分' : stats.avgScore} sub="仅统计已有真实评分的方案" icon={TrendingUp} colorClass="bg-cyan-500/10 border-cyan-400/30 text-cyan-300" to="/stats?focus=score" />
        <Metric label="高风险项" value={stats.riskTotal} sub="待重点复核" icon={ShieldAlert} colorClass="bg-red-500/10 border-red-400/30 text-red-300" to={canReview ? '/review?risk=高风险&sort=最新提交优先' : '/stats?focus=score'} />
        <Metric label="AI 成功率" value={aiTraceStats.total > 0 ? `${aiTraceStats.successRate || 0}%` : '暂无调用'} sub={aiTraceStats.total > 0 ? `${aiTraceStats.successCount}/${aiTraceStats.total} 成功` : '无可计算记录'} icon={Bot} colorClass="bg-emerald-500/10 border-emerald-400/30 text-emerald-300" to="/stats?focus=ai" />
        <Metric label="附件解析率" value={attachmentStats.total > 0 ? `${attachmentStats.parseRate || 0}%` : '暂无附件'} sub={attachmentStats.total > 0 ? `${attachmentStats.parsed}/${attachmentStats.total} 已解析` : '无可计算记录'} icon={FileText} colorClass="bg-violet-500/10 border-violet-400/30 text-violet-300" to="/stats?focus=attachments" />
      </div>

      <Panel ref={registerSection('ai')} className={`p-5 ${focusPanelClass('ai')}`}>
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="font-semibold flex items-center gap-2">
              <Bot size={18} className="text-emerald-300" aria-hidden="true" />
              AI 调用质量
            </h2>
            <p className="mt-1 text-sm text-slate-400">汇总 Hermes 调用耗时、成功率、回退次数和最近审核链路。</p>
          </div>
          <div className="text-right text-xs text-slate-500">
            <div>最近调用：{aiTraceStats.latestAt || '暂无'}</div>
            <div>{aiTraceStats.latestProvider || '-'} / {aiTraceStats.latestModel || '-'}</div>
            {aiTraceStats.latestModeName && <div>模式：{aiTraceStats.latestModeName}</div>}
            {(canViewLogs || canManageSystem) && (
              <div className="mt-2 flex flex-wrap justify-end gap-2">
                {canViewLogs && (
                  <button
                    type="button"
                    onClick={() => navigate(aiLogPath())}
                    title={`查看近30天 AI 调用日志，总调用 ${aiTraceStats.total} 次，成功率 ${aiTraceStats.successRate || 0}%`}
                    aria-label={`查看近30天 AI 调用日志，总调用 ${aiTraceStats.total} 次，成功率 ${aiTraceStats.successRate || 0}%`}
                    className="rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-200 hover:border-cyan-300/60"
                  >
                    AI 调用日志
                  </button>
                )}
                {canViewLogs && (aiTraceStats.fallbackCount || 0) > 0 && (
                  <button
                    type="button"
                    onClick={() => navigate(aiLogPath('回退'))}
                    title={`查看近30天 AI 回退日志，共 ${aiTraceStats.fallbackCount || 0} 次回退`}
                    aria-label={`查看近30天 AI 回退日志，共 ${aiTraceStats.fallbackCount || 0} 次回退`}
                    className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 hover:border-amber-300/60"
                  >
                    查看回退日志
                  </button>
                )}
                {canManageSystem && (aiTraceStats.fallbackCount || 0) > 0 && (
                  <button
                    type="button"
                    onClick={() => navigate(hermesFocusPath)}
                    title={`检查 Hermes Profile 状态，当前 AI 回退 ${aiTraceStats.fallbackCount || 0} 次`}
                    aria-label={`检查 Hermes Profile 状态，当前 AI 回退 ${aiTraceStats.fallbackCount || 0} 次`}
                    className="rounded-lg border border-violet-400/30 bg-violet-500/10 px-3 py-1.5 text-xs text-violet-200 hover:border-violet-300/60"
                  >
                    检查 Hermes
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <DrilldownCard label="总调用" value={aiTraceStats.total} sub="已记录审核链路" valueClass="text-blue-100" to={canViewLogs ? aiLogPath() : ''} />
          <DrilldownCard label="成功调用" value={aiTraceStats.successCount} sub={aiTraceStats.total > 0 ? `成功率 ${aiTraceStats.successRate || 0}%` : '暂无调用记录'} valueClass="text-emerald-200" borderClass="border-emerald-500/20" hoverClass="hover:border-emerald-300/35" to={canViewLogs ? aiLogPath('成功') : ''} />
          <DrilldownCard label="回退次数" value={aiTraceStats.fallbackCount} sub="自动改用规则引擎" valueClass="text-amber-200" borderClass="border-amber-500/20" hoverClass="hover:border-amber-300/35" to={canManageSystem && (aiTraceStats.fallbackCount || 0) > 0 ? hermesFocusPath : canViewLogs ? aiLogPath('回退') : ''} />
          <DrilldownCard label="平均耗时" value={aiTraceStats.total > 0 ? `${aiTraceStats.avgDurationMs} ms` : '暂无记录'} sub={aiTraceStats.total > 0 ? '含成功与回退记录' : '无可计算记录'} valueClass="text-cyan-200" borderClass="border-cyan-500/20" hoverClass="hover:border-cyan-300/35" to={canViewLogs ? aiLogPath() : ''} />
        </div>
        <div className="mt-3 grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
            <h3 className="text-sm font-medium text-slate-200 mb-3">Provider 分布</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(aiTraceStats.byProvider || []).length === 0 ? (
                <div className="text-sm text-slate-500">暂无调用数据</div>
              ) : (
                (aiTraceStats.byProvider || []).map(item => (
                  <div key={item.label} className="rounded-lg border border-blue-500/15 bg-slate-950/45 p-3 flex items-center justify-between">
                    <span className="text-sm text-slate-400">{item.label}</span>
                    <span className="text-blue-100 font-semibold">{item.value}</span>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
            <h3 className="text-sm font-medium text-slate-200 mb-3">最近 AI 调用</h3>
            {(aiTraceStats.recent || []).length === 0 ? (
              <div className="rounded-lg border border-blue-500/15 bg-slate-950/45 px-4 py-8 text-sm text-slate-500">暂无 AI 调用记录</div>
            ) : (
              <div className="space-y-3">
                {(aiTraceStats.recent || []).map(item => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      if (canReview && item.proposalId) navigate(`/review/${item.proposalId}?section=aiTrace`)
                      else if (canViewLogs) navigate(aiLogPath(aiResultText(item)))
                    }}
                    disabled={!(canReview && item.proposalId) && !canViewLogs}
                    className={`w-full rounded-lg border border-blue-500/15 bg-slate-950/45 p-3 text-left transition ${(canReview && item.proposalId) || canViewLogs ? 'hover:border-blue-300/35' : 'cursor-default opacity-80'}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm text-blue-100 truncate">{item.proposalTitle}</div>
                        <div className="mt-1 text-xs text-slate-500">{item.provider} / {item.model}</div>
                      </div>
                      <span className={`px-2 py-1 rounded border text-xs whitespace-nowrap ${
                        item.fallback || item.status === 'fallback'
                          ? 'border-amber-400/30 bg-amber-500/10 text-amber-200'
                          : item.status === 'failed'
                            ? 'border-rose-400/30 bg-rose-500/10 text-rose-200'
                            : item.status === 'success'
                              ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                              : 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200'
                      }`}>
                        {aiResultText(item)}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-slate-400">
                      {item.at || '-'} · {item.durationMs || 0} ms · Profile {item.profileCount || 0} · 意见 {item.opinionCount || 0}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </Panel>

      <Panel ref={registerSection('attachments')} className={`p-5 ${focusPanelClass('attachments')}`}>
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="font-semibold flex items-center gap-2">
              <FileText size={18} className="text-violet-300" aria-hidden="true" />
              附件解析质量
            </h2>
            <p className="mt-1 text-sm text-slate-400">统计附件正文提取、PDF 表格识别和异常附件，便于复核审核输入质量。</p>
          </div>
          {canReview && (
            <button type="button" onClick={() => navigate('/review?attachment=有附件&sort=最新提交优先')} className="text-sm text-blue-300 hover:text-blue-200">
              进入审核中心
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <DrilldownCard label="附件总数" value={attachmentStats.total} sub={`${formatBytes(attachmentStats.totalBytes)} · ${attachmentStats.totalTextChars} 字符`} valueClass="text-blue-100" to={canReview ? '/review?attachment=有附件&sort=最新提交优先' : ''} />
          <DrilldownCard label="已解析" value={attachmentStats.parsed} sub={attachmentStats.total > 0 ? `成功率 ${attachmentStats.parseRate || 0}%` : '暂无附件记录'} valueClass="text-emerald-200" borderClass="border-emerald-500/20" hoverClass="hover:border-emerald-300/35" to={canReview ? '/review?attachment=已解析附件&sort=最新提交优先' : ''} />
          <DrilldownCard label="异常附件" value={(attachmentStats.failed || 0) + (attachmentStats.unsupported || 0) + (attachmentStats.pending || 0)} sub={`涉及 ${attachmentStats.issueProposalCount || 0} 个方案`} valueClass="text-amber-200" borderClass="border-amber-500/20" hoverClass="hover:border-amber-300/35" to={canReview ? '/review?attachment=附件异常&sort=最新提交优先' : ''} />
          <DrilldownCard label="PDF 表格识别" value={attachmentStats.pdfTableCount} sub={`覆盖 ${attachmentStats.pdfTableFiles || 0} 个 PDF`} valueClass="text-violet-200" borderClass="border-violet-500/20" hoverClass="hover:border-violet-300/35" to={canReview ? '/review?attachment=PDF表格&sort=最新提交优先' : ''} />
        </div>
        <div className="mt-3 grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
            <h3 className="text-sm font-medium text-slate-200 mb-3">解析类型</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(attachmentStats.byType || []).length === 0 ? (
                <div className="text-sm text-slate-500">暂无附件类型数据</div>
              ) : (
                (attachmentStats.byType || []).map(item => (
                  <div key={item.label} className="rounded-lg border border-blue-500/15 bg-slate-950/45 p-3 flex items-center justify-between">
                    <span className="text-sm text-slate-400">{extractionTypeTextMap[item.label] || item.label}</span>
                    <span className="text-blue-100 font-semibold">{item.value}</span>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
            <h3 className="text-sm font-medium text-slate-200 mb-3">最近异常附件</h3>
            {(attachmentStats.recentIssues || []).length === 0 ? (
              <div className="rounded-lg border border-blue-500/15 bg-slate-950/45 px-4 py-8 text-sm text-slate-500">暂无解析异常</div>
            ) : (
              <div className="space-y-3">
                {(attachmentStats.recentIssues || []).map(item => (
                  <button
                    key={`${item.proposalId}-${item.fileName}`}
                    type="button"
                    onClick={() => canReview && navigate(`/review/${item.proposalId}`)}
                    disabled={!canReview}
                    className={`w-full rounded-lg border border-blue-500/15 bg-slate-950/45 p-3 text-left transition ${canReview ? 'hover:border-blue-300/35' : 'cursor-default opacity-80'}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm text-blue-100 truncate">{item.fileName}</div>
                        <div className="mt-1 text-xs text-slate-500 truncate">{item.proposalTitle}</div>
                      </div>
                      <span className="px-2 py-1 rounded border border-amber-400/30 bg-amber-500/10 text-xs text-amber-200 whitespace-nowrap">{item.status}</span>
                    </div>
                    {item.error && <div className="mt-2 text-xs text-red-300 line-clamp-1">{item.error}</div>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </Panel>

      <Panel ref={registerSection('export')} className={`p-5 ${focusPanelClass('export')}`}>
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="font-semibold flex items-center gap-2">
              <Download size={18} className="text-blue-300" aria-hidden="true" />
              意见书导出分析
            </h2>
            <p className="mt-1 text-sm text-slate-400">统计意见书预览、Word 导出、PDF 导出和入口来源。</p>
          </div>
          <div className="text-right text-xs text-slate-500">
            <div>当前系统版本：{appVersion}</div>
            <div>最近留痕版本：{exportStats.latestVersion || '暂无'}</div>
            <div>最近构建标识：{exportStats.latestBuildLabel || exportStats.latestVersion || '暂无'}</div>
            <div>最近导出人：{exportStats.lastExporter || '暂无'}</div>
            {canReview && (
              <button type="button" onClick={() => navigate(exportFilterPath())} className="mt-2 text-blue-300 hover:text-blue-200">
                进入审核中心
              </button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <DrilldownCard label="导出总次数" value={exportStats.total} sub={`覆盖 ${exportStats.proposalCount} 个方案`} valueClass="text-blue-100" to={canReview ? exportFilterPath() : ''} />
          <DrilldownCard label="预览次数" value={exportStats.previewCount} sub="在线查看意见书" valueClass="text-cyan-200" borderClass="border-cyan-500/20" hoverClass="hover:border-cyan-300/35" to={canReview ? exportFilterPath('preview') : ''} />
          <DrilldownCard label="Word 导出" value={exportStats.wordCount} sub="正式下载留痕" valueClass="text-emerald-200" borderClass="border-emerald-500/20" hoverClass="hover:border-emerald-300/35" to={canReview ? exportFilterPath('word') : ''} />
          <DrilldownCard label="PDF 导出" value={exportStats.pdfCount} sub="打印输出留痕" valueClass="text-violet-200" borderClass="border-violet-500/20" hoverClass="hover:border-violet-300/35" to={canReview ? exportFilterPath('pdf') : ''} />
        </div>
        <div className="mt-3 grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
            <h3 className="text-sm font-medium text-slate-200 mb-3">来源分布</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(exportStats.bySource || []).map(item => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => canReview && navigate(exportSourceFilterPath(item.label))}
                  disabled={!canReview}
                  className={`rounded-lg border border-blue-500/15 bg-slate-950/45 p-3 text-left transition ${canReview ? 'hover:border-blue-300/35' : 'cursor-default opacity-80'}`}
                >
                  <div className="text-sm text-slate-400">{item.label}</div>
                  <div className="mt-2 text-2xl font-semibold text-blue-100">{item.value}</div>
                </button>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <button type="button" onClick={() => canReview && navigate(exportSourceFilterPath('方案详情页'))} disabled={!canReview} className={`rounded-lg border border-blue-500/15 bg-slate-950/45 p-3 flex items-center justify-between transition ${canReview ? 'hover:border-blue-300/35' : 'cursor-default opacity-80'}`}>
                <span className="text-slate-400">详情页导出</span>
                <span className="text-cyan-200 font-semibold">{exportStats.detailCount}</span>
              </button>
              <button type="button" onClick={() => canReview && navigate(exportSourceFilterPath('提交结果区'))} disabled={!canReview} className={`rounded-lg border border-blue-500/15 bg-slate-950/45 p-3 flex items-center justify-between transition ${canReview ? 'hover:border-blue-300/35' : 'cursor-default opacity-80'}`}>
                <span className="text-slate-400">提交结果区导出</span>
                <span className="text-emerald-200 font-semibold">{exportStats.submitCount}</span>
              </button>
            </div>
          </div>
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
            <h3 className="text-sm font-medium text-slate-200 mb-3">最近导出记录</h3>
            {(exportStats.recent || []).length === 0 ? (
              <div className="rounded-lg border border-blue-500/15 bg-slate-950/45 px-4 py-8 text-sm text-slate-500">暂无导出记录</div>
            ) : (
              <div className="space-y-3">
                {(exportStats.recent || []).map(item => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => canReview && navigate(`/review/${item.proposalId}?section=exports`)}
                    disabled={!canReview}
                    className={`w-full rounded-lg border border-blue-500/15 bg-slate-950/45 p-3 text-left transition ${canReview ? 'hover:border-blue-300/35' : 'cursor-default opacity-80'}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm text-blue-100 truncate">{item.proposalTitle}</div>
                        <div className="mt-1 text-xs text-slate-500">{item.actor || '管理员'} · {item.sourceText}</div>
                      </div>
                    <span className="px-2 py-1 rounded border border-blue-400/30 bg-blue-500/10 text-xs text-blue-200 whitespace-nowrap">
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

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel ref={registerSection('status')} className={`p-5 h-[320px] ${focusPanelClass('status')}`}>
          <h2 className="font-semibold mb-3">审核状态分布</h2>
          {stats.byStatus.length === 0 ? (
            <div className="h-[250px] grid place-items-center text-slate-500">暂无数据</div>
          ) : (
            <Suspense fallback={<ChartLoading className="h-[250px]" />}>
              <StatusPieChart data={stats.byStatus} />
            </Suspense>
          )}
        </Panel>

        <Panel ref={registerSection('type')} className={`p-5 h-[320px] ${focusPanelClass('type')}`}>
          <h2 className="font-semibold mb-3">方案类型统计</h2>
          {stats.byType.length === 0 ? (
            <div className="h-[250px] grid place-items-center text-slate-500">暂无数据</div>
          ) : (
            <Suspense fallback={<ChartLoading className="h-[250px]" />}>
              <TypeBarChart data={stats.byType} />
            </Suspense>
          )}
        </Panel>
      </div>

      <Panel ref={registerSection('score')} className={`p-5 h-[340px] ${focusPanelClass('score')}`}>
        <h2 className="font-semibold mb-3">方案评分分布</h2>
        {stats.scoreBars.length === 0 ? (
          <div className="h-[260px] grid place-items-center text-slate-500">暂无数据</div>
        ) : (
          <Suspense fallback={<ChartLoading className="h-[260px]" />}>
            <ScoreBarChart data={stats.scoreBars} />
          </Suspense>
        )}
      </Panel>

      {(canManageUsers || canManageSystem) && (
        <div className={`grid grid-cols-1 gap-4 ${(canManageUsers && canManageSystem) ? 'xl:grid-cols-3' : 'xl:grid-cols-2'}`}>
          {canManageUsers && (
            <Panel ref={registerSection('users')} className={`p-5 ${focusPanelClass('users')}`}>
              <h2 className="font-semibold mb-3">账号结构</h2>
              <div className="space-y-3 text-sm">
                <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-3 flex items-center justify-between">
                  <span className="text-slate-400">总账号数</span>
                  <span className="text-blue-100 font-semibold">{userStats.total}</span>
                </div>
                <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-3 flex items-center justify-between">
                  <span className="text-slate-400">启用账号</span>
                  <span className="text-emerald-200 font-semibold">{userStats.enabled}</span>
                </div>
                {userStatsByRole.length > 0 && (
                  <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-slate-400">角色分布</span>
                      <span className="text-xs text-slate-500">启用 / 总计</span>
                    </div>
                    <div className="space-y-2">
                      {userStatsByRole.map(item => (
                        <button
                          key={item.role}
                          type="button"
                          onClick={() => navigate(`/users?role=${encodeURIComponent(item.role)}&status=${encodeURIComponent('启用')}`)}
                          className="flex w-full items-center justify-between rounded-md border border-blue-500/10 bg-slate-950/35 px-3 py-2 text-left transition hover:border-blue-300/35"
                        >
                          <span className="text-slate-300">{item.role}</span>
                          <span className="text-blue-100 font-semibold">{item.enabled}/{item.total}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => navigate('/users?password=默认密码&select=visible')}
                  disabled={defaultPasswordCount === 0}
                  className="w-full rounded-lg border border-red-500/20 bg-slate-900/60 p-3 flex items-center justify-between text-left transition disabled:cursor-default disabled:opacity-70 enabled:hover:border-red-300/40"
                >
                  <span className="text-slate-400">默认密码风险</span>
                  <span className="text-red-200 font-semibold">{defaultPasswordCount}</span>
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/users?password=需改密&select=visible')}
                  disabled={mustChangePasswordCount === 0}
                  className="w-full rounded-lg border border-amber-500/20 bg-slate-900/60 p-3 flex items-center justify-between text-left transition disabled:cursor-default disabled:opacity-70 enabled:hover:border-amber-300/40"
                >
                  <span className="text-slate-400">需改密账号</span>
                  <span className="text-amber-200 font-semibold">{mustChangePasswordCount}</span>
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/users?security=登录锁定&select=visible')}
                  disabled={loginLockedCount === 0}
                  className="w-full rounded-lg border border-orange-500/20 bg-slate-900/60 p-3 flex items-center justify-between text-left transition disabled:cursor-default disabled:opacity-70 enabled:hover:border-orange-300/40"
                >
                  <span className="text-slate-400">登录锁定账号</span>
                  <span className="text-orange-200 font-semibold">{loginLockedCount}</span>
                </button>
              </div>
            </Panel>
          )}

          {canManageSystem && (
            <Panel ref={registerSection('rules')} className={`p-5 ${focusPanelClass('rules')}`}>
              <h2 className="font-semibold mb-3">规则结构</h2>
              <div className="space-y-3 text-sm">
                {(ruleStats.byCategory || []).map(item => (
                  <div key={item.category} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-300">{item.category}</span>
                      <span className="text-blue-100 font-semibold">{item.enabled}/{item.total}</span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">启用 / 总数</div>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {canManageSystem && (
            <Panel ref={registerSection('workflow')} className={`p-5 ${focusPanelClass('workflow')}`}>
              <h2 className="font-semibold mb-3">审核编排</h2>
              <div className="space-y-3 text-sm">
                <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-3">
                  <div className="text-slate-300">内部运营并行审核</div>
                  <div className="mt-2 text-xl font-semibold text-emerald-200">{workflow.internal.enabledCount} 个专业</div>
                  <div className="mt-1 text-xs text-slate-500 line-clamp-2">{workflow.internal.reviewerNames?.join('、') || '暂无启用专业'}</div>
                </div>
                <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-3">
                  <div className="text-slate-300">市场拓展立项与会审</div>
                  <div className="mt-2 text-xl font-semibold text-cyan-200">{workflow.market.initiatorName || '未配置牵头角色'}</div>
                  <div className="mt-1 text-xs text-slate-500">会审专业 {workflow.market.reviewCount} 个</div>
                </div>
              </div>
            </Panel>
          )}
        </div>
      )}

      {canViewSecurityStats && (
        <Panel ref={registerSection('security')} className={`p-5 ${focusPanelClass('security')}`}>
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="font-semibold flex items-center gap-2">
                <ShieldAlert size={18} className="text-amber-300" aria-hidden="true" />
                账号安全分析
              </h2>
              <p className="mt-1 text-sm text-slate-400">汇总登录失败、锁定拦截、来源 IP 和账号安全导出/批量处理留痕。</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {canManageUsers && (
                <button
                  type="button"
                  onClick={() => navigate('/users')}
                  title={`进入人员管理，总账号 ${userStats.total}，启用 ${userStats.enabled}`}
                  aria-label={`进入人员管理，总账号 ${userStats.total}，启用 ${userStats.enabled}`}
                  className="rounded-lg border border-blue-400/30 bg-blue-500/10 px-3 py-1.5 text-xs text-blue-200 hover:border-blue-300/60"
                >
                  人员管理
                </button>
              )}
              {canManageUsers && defaultPasswordCount > 0 && (
                <button
                  type="button"
                  onClick={() => navigate('/users?password=默认密码&select=visible')}
                  title={`筛选并选择 ${defaultPasswordCount} 个默认密码风险账号`}
                  aria-label={`筛选并选择 ${defaultPasswordCount} 个默认密码风险账号`}
                  className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-200 hover:border-red-300/60"
                >
                  处理 {defaultPasswordCount} 个默认密码
                </button>
              )}
              {canManageUsers && mustChangePasswordCount > 0 && (
                <button
                  type="button"
                  onClick={() => navigate('/users?password=需改密&select=visible')}
                  title={`筛选并选择 ${mustChangePasswordCount} 个需改密账号`}
                  aria-label={`筛选并选择 ${mustChangePasswordCount} 个需改密账号`}
                  className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 hover:border-amber-300/60"
                >
                  处理 {mustChangePasswordCount} 个需改密
                </button>
              )}
              {canManageUsers && loginLockedCount > 0 && (
                <button
                  type="button"
                  onClick={() => navigate('/users?security=登录锁定&select=visible')}
                  title={`筛选并选择 ${loginLockedCount} 个登录锁定账号`}
                  aria-label={`筛选并选择 ${loginLockedCount} 个登录锁定账号`}
                  className="rounded-lg border border-orange-400/30 bg-orange-500/10 px-3 py-1.5 text-xs text-orange-200 hover:border-orange-300/60"
                >
                  处理 {loginLockedCount} 个登录锁定
                </button>
              )}
              <button
                type="button"
                onClick={() => navigate(accountSecurityLogPath())}
                title={`查看近30天账号安全日志，共 ${securityStats.total} 条`}
                aria-label={`查看近30天账号安全日志，共 ${securityStats.total} 条`}
                className="rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-200 hover:border-cyan-300/60"
              >
                查看账号安全日志
              </button>
              <button
                type="button"
                onClick={() => navigate(accountSecurityLogPath('锁定'))}
                title={`查看账号锁定日志，当前锁定账号 ${loginLockedCount} 个`}
                aria-label={`查看账号锁定日志，当前锁定账号 ${loginLockedCount} 个`}
                className="rounded-lg border border-yellow-400/30 bg-yellow-500/10 px-3 py-1.5 text-xs text-yellow-200 hover:border-yellow-300/60"
              >
                查看锁定
              </button>
              <button
                type="button"
                onClick={() => navigate(accountSecurityLogPath('拦截'))}
                title={`查看账号安全拦截日志，共 ${securityStats.interceptCount || 0} 条拦截`}
                aria-label={`查看账号安全拦截日志，共 ${securityStats.interceptCount || 0} 条拦截`}
                className="rounded-lg border border-orange-400/30 bg-orange-500/10 px-3 py-1.5 text-xs text-orange-200 hover:border-orange-300/60"
              >
                查看拦截
              </button>
              <button type="button" onClick={() => navigate(accountSecurityLogPath('拒绝', '管理员账号修改密码被拒绝'))} title="查看管理员账号修改密码被拒绝日志" aria-label="查看管理员账号修改密码被拒绝日志" className="rounded-lg border border-orange-400/30 bg-orange-500/10 px-3 py-1.5 text-xs text-orange-200 hover:border-orange-300/60">
                管理员改密拒绝
              </button>
              <button type="button" onClick={() => navigate(accountSecurityLogPath('拒绝', '下次登录改密被拒绝'))} title="查看下次登录强制改密被拒绝日志" aria-label="查看下次登录强制改密被拒绝日志" className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 hover:border-amber-300/60">
                强制改密拒绝
              </button>
              <button type="button" onClick={() => navigate(accountSecurityLogPath('拒绝', '默认密码'))} title="查看默认密码相关拒绝日志" aria-label="查看默认密码相关拒绝日志" className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-200 hover:border-red-300/60">
                默认密码拒绝
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <DrilldownCard label="安全日志" value={securityStats.total} sub="近 30 天账号相关留痕" valueClass="text-blue-100" to={accountSecurityLogPath()} />
            <DrilldownCard label="登录失败" value={securityStats.failureCount} sub={securityStats.latestFailureAt ? `最近：${securityStats.latestFailureResult || '异常'} · ${securityStats.latestFailureActor || '未知账号'}` : '暂无失败记录'} valueClass="text-amber-200" borderClass="border-amber-500/20" hoverClass="hover:border-amber-300/35" to={latestFailureLogPath} />
            <DrilldownCard label="锁定/拦截/拒绝" value={securityStats.lockedCount} sub={`锁定 ${securityStats.lockedOnlyCount || 0} · 拦截 ${securityStats.interceptCount || 0} · 拒绝 ${securityStats.rejectedCount || 0}`} valueClass="text-red-200" borderClass="border-red-500/20" hoverClass="hover:border-red-300/35" to={accountSecurityLogPath('拒绝')} />
            <DrilldownCard label="当前锁定账号" value={loginLockedCount} sub="仍需人员管理解锁" valueClass={loginLockedCount > 0 ? 'text-orange-200' : 'text-emerald-200'} borderClass="border-orange-500/20" hoverClass="hover:border-orange-300/35" to={canManageUsers ? '/users?security=登录锁定&select=visible' : accountSecurityLogPath('锁定')} />
            <DrilldownCard label="来源 IP" value={securityStats.uniqueIpCount} sub="已记录的访问来源数量" valueClass="text-cyan-200" borderClass="border-cyan-500/20" hoverClass="hover:border-cyan-300/35" to={accountSecurityLogPath()} />
          </div>
          <div className="mt-3 grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
              <h3 className="text-sm font-medium text-slate-200 mb-3">最近账号安全导出</h3>
              {securityStats.latestAccountSecurityExport ? (
                <button
                  type="button"
                  onClick={() => navigate(accountSecurityLogPath())}
                  className="w-full rounded-lg border border-blue-500/15 bg-slate-950/45 p-3 text-left transition hover:border-blue-300/35"
                >
                  <div className="text-sm text-blue-100">{securityStats.latestAccountSecurityExport.action || '账号安全清单导出'}</div>
                  <div className="mt-1 text-xs text-slate-500">{securityStats.latestAccountSecurityExport.actor || '未知账号'} · {securityStats.latestAccountSecurityExport.at || '-'}</div>
                  <div className="mt-2 text-xs text-slate-400">
                    {latestAccountSecurityExportRiskText || '已记录导出留痕'}
                  </div>
                </button>
              ) : (
                <div className="rounded-lg border border-blue-500/15 bg-slate-950/45 px-4 py-8 text-sm text-slate-500">暂无账号安全导出记录</div>
              )}
            </div>
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
              <h3 className="text-sm font-medium text-slate-200 mb-3">最近账号批量处理</h3>
              {securityStats.latestAccountSecurityBulk ? (
                <>
                  <button
                    type="button"
                    onClick={() => navigate(accountSecurityLogPath())}
                    className="w-full rounded-lg border border-blue-500/15 bg-slate-950/45 p-3 text-left transition hover:border-blue-300/35"
                  >
                    <div className="text-sm text-blue-100">{securityStats.latestAccountSecurityBulk.action || '账号批量处理'}</div>
                    <div className="mt-1 text-xs text-slate-500">{securityStats.latestAccountSecurityBulk.actor || '未知账号'} · {securityStats.latestAccountSecurityBulk.at || '-'}</div>
                    <div className="mt-2 text-xs text-slate-400">
                      审计编号：{securityStats.latestAccountSecurityBulk.metadata?.auditId || '未记录'}
                    </div>
                  </button>
                  {canManageUsers && latestAccountSecurityBulkNeedsNotice && (
                    <button
                      type="button"
                      onClick={() => navigate('/users?password=需改密&select=visible')}
                      className="mt-2 w-full rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-left text-xs text-amber-200 hover:border-amber-300/60"
                    >
                      准备改密通知文案（未发送）
                    </button>
                  )}
                </>
              ) : (
                <div className="rounded-lg border border-blue-500/15 bg-slate-950/45 px-4 py-8 text-sm text-slate-500">暂无账号批量处理记录</div>
              )}
            </div>
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
              <h3 className="text-sm font-medium text-slate-200 mb-3">最近改密通知文案</h3>
              {securityStats.latestAccountSecurityNotice ? (
                <>
                  <button
                    type="button"
                    onClick={() => navigate(latestAccountSecurityNoticeId ? accountSecurityLogPath('', latestAccountSecurityNoticeId) : accountSecurityLogPath())}
                    className="w-full rounded-lg border border-blue-500/15 bg-slate-950/45 p-3 text-left transition hover:border-blue-300/35"
                  >
                    <div className="text-sm text-blue-100">{securityStats.latestAccountSecurityNotice.action || '账号改密通知文案生成'}</div>
                    <div className="mt-1 text-xs text-slate-500">{securityStats.latestAccountSecurityNotice.actor || '未知账号'} · {securityStats.latestAccountSecurityNotice.at || '-'}</div>
                    <div className="mt-2 text-xs text-slate-400">
                      涉及 {securityStats.latestAccountSecurityNotice.metadata?.affectedAccountCount ?? securityStats.latestAccountSecurityNotice.metadata?.noticeCount ?? 0} 个账号；状态：未发送；编号：{securityStats.latestAccountSecurityNotice.metadata?.auditId || '未记录'}
                    </div>
                    {latestAccountSecurityNoticeNames.length > 0 && (
                      <div className="mt-1 truncate text-xs text-slate-400">
                        涉及姓名：{latestAccountSecurityNoticeNames.slice(0, 4).join('、')}{latestAccountSecurityNoticeNames.length > 4 ? ` 等 ${latestAccountSecurityNoticeNames.length} 人` : ''}
                      </div>
                    )}
                    {latestAccountSecurityNoticeUsers.length > 0 && (
                      <div className="mt-1 truncate text-xs text-slate-500">
                        涉及账号：{latestAccountSecurityNoticeUsers.slice(0, 4).join('、')}{latestAccountSecurityNoticeUsers.length > 4 ? ` 等 ${latestAccountSecurityNoticeUsers.length} 个` : ''}
                      </div>
                    )}
                  </button>
                  {canManageUsers && latestAccountSecurityNoticeUsers.length > 0 && (
                    <button
                      type="button"
                      onClick={() => navigate('/users?notice=latest&select=visible')}
                      className="mt-2 w-full rounded-lg border border-blue-400/30 bg-blue-500/10 px-3 py-2 text-left text-xs text-blue-100 hover:border-blue-300/60"
                    >
                      查看本次文案涉及账号
                    </button>
                  )}
                  {canManageUsers && mustChangePasswordCount > 0 && (
                    <button
                      type="button"
                      onClick={() => navigate('/users?password=需改密&select=visible')}
                      className="mt-2 w-full rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-left text-xs text-amber-200 hover:border-amber-300/60"
                    >
                      处理 {mustChangePasswordCount} 个需改密账号
                    </button>
                  )}
                </>
              ) : (
                <div className="rounded-lg border border-blue-500/15 bg-slate-950/45 px-4 py-8 text-sm text-slate-500">暂无改密通知文案生成留痕</div>
              )}
            </div>
          </div>
        </Panel>
      )}

      <Panel ref={registerSection('execution')} className={`p-5 ${focusPanelClass('execution')}`}>
        <h2 className="font-semibold mb-3">执行漏斗</h2>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 text-sm">
          <div className="rounded-lg border border-emerald-500/20 bg-slate-900/60 p-4">
            <div className="text-slate-400">已人工复核</div>
            <div className="mt-2 text-2xl font-semibold text-emerald-200">{executionStats.reviewed}</div>
          </div>
          <div className="rounded-lg border border-amber-500/20 bg-slate-900/60 p-4">
            <div className="text-slate-400">待签发</div>
            <div className="mt-2 text-2xl font-semibold text-amber-200">{executionStats.pendingSignOff}</div>
          </div>
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
            <div className="text-slate-400">已签发</div>
            <div className="mt-2 text-2xl font-semibold text-blue-200">{executionStats.signed}</div>
          </div>
          <div className="rounded-lg border border-cyan-500/20 bg-slate-900/60 p-4">
            <div className="text-slate-400">待归档</div>
            <div className="mt-2 text-2xl font-semibold text-cyan-200">{executionStats.pendingArchive}</div>
          </div>
          <div className="rounded-lg border border-violet-500/20 bg-slate-900/60 p-4">
            <div className="text-slate-400">已归档</div>
            <div className="mt-2 text-2xl font-semibold text-violet-200">{executionStats.archived}</div>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel ref={registerSection('reminder')} className={`p-5 ${focusPanelClass('reminder')}`}>
          <h2 className="font-semibold mb-3">执行催办结构</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {executionQueueStats.map(item => (
              <div key={item.key} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4 flex items-center gap-3">
                <div className={`h-11 w-11 rounded-lg border grid place-items-center ${item.colorClass}`}>
                  <item.icon size={20} />
                </div>
                <div>
                  <div className="text-sm text-slate-400">{item.label}</div>
                  <div className="mt-1 text-2xl font-semibold text-blue-100">{item.value}</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel className={`p-5 ${focusPanelClass('reminder')}`}>
          <h2 className="font-semibold mb-3">自动催办明细</h2>
          <div className="space-y-3">
            {([...(executionQueues.overdueReminders || []), ...(executionQueues.approachingReminders || [])]).length === 0 ? (
              <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-8 text-sm text-slate-500">暂无自动催办方案</div>
            ) : ([...(executionQueues.overdueReminders || []), ...(executionQueues.approachingReminders || [])]).map(item => (
              <div key={item.id} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-blue-100 truncate">{item.title}</div>
                    <div className="mt-1 text-xs text-slate-500">{item.submitter} · {item.type}</div>
                  </div>
                  <span className={`px-2 py-1 rounded text-xs border ${
                    item.overdueReminder?.level === '高'
                      ? 'border-red-400/30 bg-red-500/10 text-red-200'
                      : item.overdueReminder?.overdue
                        ? 'border-amber-400/30 bg-amber-500/10 text-amber-200'
                        : 'border-blue-400/30 bg-blue-500/10 text-blue-200'
                  }`}>
                    {item.overdueReminder?.stage || '待跟进'}
                  </span>
                </div>
                <div className="mt-2 text-xs text-slate-400">
                  {item.overdueReminder?.label || '正常'} · 阈值 {item.overdueReminder?.thresholdHours || 0}h · 基准时间 {item.overdueReminder?.sourceTime || '-'}
                </div>
                <p className="mt-2 text-sm text-slate-300 line-clamp-2">
                  建议催办：{item.recommendedReminderStage || '进度确认'}；最近催办：{item.lastReminderStage || '未催办'}{item.lastReminderAt ? `（${item.lastReminderSource === 'auto' ? '自动催办' : '人工登记'}）` : ''}
                </p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel className={`p-5 ${focusPanelClass('reminder')}`}>
          <h2 className="font-semibold mb-3">催办来源分布</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {(reminderStats.bySource || []).map(item => (
              <div key={item.label} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
                <div className="text-sm text-slate-400">{item.label}</div>
                <div className="mt-2 text-2xl font-semibold text-blue-100">{item.value}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg border border-amber-500/20 bg-slate-900/60 p-4">
              <div className="text-slate-400">建议催办方案</div>
              <div className="mt-2 text-2xl font-semibold text-amber-200">{reminderStats.totalNeedReminder || 0}</div>
            </div>
            <div className="rounded-lg border border-cyan-500/20 bg-slate-900/60 p-4">
              <div className="text-slate-400">已留痕催办</div>
              <div className="mt-2 text-2xl font-semibold text-cyan-200">{reminderStats.totalWithReminder || 0}</div>
            </div>
          </div>
        </Panel>

        <Panel className={`p-5 ${focusPanelClass('reminder')}`}>
          <h2 className="font-semibold mb-3">建议催办阶段分布</h2>
          {!(reminderStats.byStage || []).some(item => item.value > 0) ? (
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-8 text-sm text-slate-500">暂无建议催办阶段数据</div>
          ) : (
            <div className="space-y-4">
              <div className="h-[220px]">
                <Suspense fallback={<ChartLoading />}>
                  <ReminderStageBarChart data={reminderStats.byStage} />
                </Suspense>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                {(reminderStats.pendingBySource || []).map(item => (
                  <div key={item.label} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-3 flex items-center justify-between">
                    <span className="text-slate-400">{item.label}</span>
                    <span className="text-violet-200 font-semibold">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Panel>
      </div>

      <Panel className={`p-5 ${focusPanelClass('reminder')}`}>
        <h2 className="font-semibold mb-3">催办动作交叉统计</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
            <div className="text-sm text-slate-400">自动催办留痕</div>
            <div className="mt-2 text-2xl font-semibold text-violet-200">{reminderStats.autoCount || 0}</div>
          </div>
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
            <div className="text-sm text-slate-400">人工登记留痕</div>
            <div className="mt-2 text-2xl font-semibold text-slate-200">{reminderStats.manualCount || 0}</div>
          </div>
          {(reminderStats.pendingBySource || []).map(item => (
            <div key={item.label} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
              <div className="text-sm text-slate-400">{item.label}</div>
              <div className="mt-2 text-2xl font-semibold text-amber-200">{item.value}</div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}
