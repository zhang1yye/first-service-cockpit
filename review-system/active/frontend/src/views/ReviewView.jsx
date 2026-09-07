import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { BellRing, Copy, Download, RotateCcw, Search, Trash2, X } from '../lib/lucide.js'
import { api, getUser } from '../lib/api'
import { appBuildLabel, appBuildTime, appVersion } from '../lib/appVersion'
import { copyText } from '../lib/clipboard'
import { csvCell } from '../lib/csv'
import { hasPermission } from '../lib/permissions'
import { requestNotificationRefresh } from '../lib/notifications'
import { loadReportTools, preloadReportTools } from '../lib/reportPreload'
import { preloadRoute } from '../lib/routePreload'
import Panel from '../components/Panel'
import CopyFallbackDialog from '../components/CopyFallbackDialog'
import firstServiceLogo from '../assets/brand/first-service-logo-2026-transparent.png'

const statusTabs = ['全部', '待专业配置', '待审核', '审核中', '待复核', '待修改', '已通过']
const reminderChannels = ['企业微信', '电话', '邮件', '当面沟通']
const queueModes = ['默认视图', '待人工复核高风险', '已复核未签发', '已签发未归档', '超时催办', '临近超时', '最近催办']
const queuePresetMeta = {
  待人工复核高风险: {
    label: '待人工复核高风险',
    description: '只显示未完成人工复核且存在高风险项的方案。',
    chipClass: 'border-amber-400/30 bg-amber-500/10 text-amber-100'
  },
  已复核未签发: {
    label: '已复核未签发',
    description: '只显示已完成人工复核、待签发的方案。',
    chipClass: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100'
  },
  已签发未归档: {
    label: '已签发未归档',
    description: '只显示已签发、待归档的方案。',
    chipClass: 'border-cyan-400/30 bg-cyan-500/10 text-cyan-100'
  },
  超时催办: {
    label: '超时催办',
    description: '只显示已超过催办阈值、需要立即跟进的方案。',
    chipClass: 'border-red-400/30 bg-red-500/10 text-red-100'
  },
  临近超时: {
    label: '临近超时',
    description: '只显示接近催办阈值、建议提前跟进的方案。',
    chipClass: 'border-orange-400/30 bg-orange-500/10 text-orange-100'
  },
  最近催办: {
    label: '最近催办',
    description: '只显示最近已经形成催办留痕的方案。',
    chipClass: 'border-sky-400/30 bg-sky-500/10 text-sky-100'
  }
}
const reminderSourceTextMap = {
  manual: '人工登记',
  auto: '系统草稿（未发送）'
}
const exportTypeTextMap = {
  preview: '预览',
  word: 'Word',
  pdf: 'PDF'
}
const attachmentFilterOptions = ['全部', '有附件', '无附件', '已解析附件', '附件异常', '历史元数据', 'PDF表格']
const aiFilterOptions = ['全部', 'AI成功', '待人工复核', 'AI回退', 'AI失败', '无AI记录']

function isConfigurationPending(item = {}) {
  return item.status === '待专业配置'
}

function buildLogsPath({
  proposalIds = [],
  type = '执行动作',
  actionGroup = '全部',
  exportSource = '全部',
  submitter = '全部',
  proposalType = '全部',
  keyword = ''
} = {}) {
  const params = new URLSearchParams()
  const uniqueIds = [...new Set(proposalIds.filter(Boolean))]
  if (type) params.set('type', type)
  if (actionGroup && actionGroup !== '全部') params.set('actionGroup', actionGroup)
  if (uniqueIds.length === 1) params.set('proposalId', uniqueIds[0])
  if (uniqueIds.length > 1) params.set('proposalIds', uniqueIds.join(','))
  if (submitter && submitter !== '全部') params.set('submitter', submitter)
  if (proposalType && proposalType !== '全部') params.set('proposalType', proposalType)
  if (keyword) params.set('q', keyword)
  if (actionGroup === '导出' && exportSource && exportSource !== '全部' && exportSource !== '未导出') {
    params.set('exportSource', exportSource)
  }
  return `/logs?${params.toString()}`
}

function formatReminderScript(item, stageOverride = '') {
  const stage = stageOverride || item.recommendedReminderStage || '进度确认'
  const riskText = item.highRiskCount > 0 ? `当前存在 ${item.highRiskCount} 项高风险，请优先处理。` : ''
  const statusText = [item.status, item.signOffStatus, item.archiveStatus].filter(Boolean).join(' / ') || '待跟进'
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

function reminderSourceText(source = '') {
  return reminderSourceTextMap[source] || '人工登记'
}

function exportTypeText(type = '') {
  return exportTypeTextMap[String(type || '').trim().toLowerCase()] || '未导出'
}

function aiModeText(mode = '') {
  if (mode === 'hermes-agent') return 'Hermes Agent'
  if (mode === 'external') return '外部 AI'
  if (mode === 'fallback-local') return '本地兜底'
  if (mode === 'local') return '本地规则'
  return '未记录模式'
}

function aiTraceLabel(trace = {}) {
  if (trace.fallback === true || trace.status === 'fallback') return '回退'
  if (trace.status === 'failed') return '失败'
  if (trace.status === 'success') return '成功'
  return '待人工复核'
}

function aiTraceToneClass(trace = {}) {
  if (trace.fallback === true || trace.status === 'fallback') return 'border-amber-400/30 bg-amber-500/10 text-amber-200'
  if (trace.status === 'failed') return 'border-rose-400/30 bg-rose-500/10 text-rose-200'
  if (trace.status === 'success') return 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
  return 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200'
}

function matchQueueMode(item, queueMode = '默认视图') {
  switch (queueMode) {
    case '待人工复核高风险':
      return !item.hasManualReview && (item.highRiskCount || 0) > 0
    case '已复核未签发':
      return item.hasManualReview && item.signOffStatus === '待签发'
    case '已签发未归档':
      return item.signOffStatus === '已签发' && item.archiveStatus === '待归档'
    case '超时催办':
      return Boolean(item.overdueReminder?.overdue)
    case '临近超时':
      return Boolean(item.overdueReminder?.approaching) && !item.overdueReminder?.overdue
    case '最近催办':
      return Boolean(item.lastReminderAt)
    default:
      return true
  }
}

function matchAttachmentFilter(item, attachmentFilter = '全部') {
  const summary = item.attachmentSummary || {}
  switch (attachmentFilter) {
    case '有附件':
      return (summary.total || item.fileCount || 0) > 0
    case '无附件':
      return (summary.total || item.fileCount || 0) === 0
    case '已解析附件':
      return (summary.parsed || 0) > 0
    case '附件异常':
      return ((summary.failed || 0) + (summary.unsupported || 0) + (summary.pending || 0)) > 0
    case '历史元数据':
      return (summary.historical || 0) > 0
    case 'PDF表格':
      return (summary.pdfTableCount || 0) > 0
    default:
      return true
  }
}

export default function ReviewView() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const reminderDialogTitleId = useId()
  const reminderDialogDescId = useId()
  const reminderStageId = useId()
  const reminderChannelId = useId()
  const reminderNoteId = useId()
  const allFilteredSelectId = useId()
  const reminderDialogRef = useRef(null)
  const reminderRestoreFocusRef = useRef(null)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('全部')
  const [typeFilter, setTypeFilter] = useState('全部')
  const [riskFilter, setRiskFilter] = useState('全部')
  const [reminderSourceFilter, setReminderSourceFilter] = useState('全部')
  const [manualReviewFilter, setManualReviewFilter] = useState('全部')
  const [signOffFilter, setSignOffFilter] = useState('全部')
  const [archiveFilter, setArchiveFilter] = useState('全部')
  const [exportFilter, setExportFilter] = useState('全部')
  const [exportSourceFilter, setExportSourceFilter] = useState('全部')
  const [attachmentFilter, setAttachmentFilter] = useState('全部')
  const [aiFilter, setAiFilter] = useState('全部')
  const [submitterFilter, setSubmitterFilter] = useState('全部')
  const [sortMode, setSortMode] = useState('默认排序')
  const [queueMode, setQueueMode] = useState('默认视图')
  const [keyword, setKeyword] = useState('')
  const [statusGroup, setStatusGroup] = useState('')
  const [selectedIds, setSelectedIds] = useState([])
  const [actingBulk, setActingBulk] = useState(false)
  const [bulkExporting, setBulkExporting] = useState(false)
  const [savingReminderId, setSavingReminderId] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [bulkReminderResult, setBulkReminderResult] = useState(null)
  const [bulkActionResult, setBulkActionResult] = useState(null)
  const [reminderDraft, setReminderDraft] = useState(null)
  const [copyFallback, setCopyFallback] = useState({ open: false, title: '', description: '', content: '' })
  const currentUser = getUser()
  const canReview = hasPermission(currentUser, 'reviewProposal')
  const canManageSystem = hasPermission(currentUser, 'manageSystem')
  const canViewLogs = hasPermission(currentUser, 'viewLogs')

  const exportOptions = {
    appVersion,
    logoUrl: firstServiceLogo
  }

  const syncSearchParams = (updater) => {
    setSelectedIds([])
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      updater(next)
      Array.from(next.keys()).forEach(key => {
        if (!next.get(key)) next.delete(key)
      })
      return next
    })
  }

  useEffect(() => {
    const status = searchParams.get('status') || '全部'
    const type = searchParams.get('type') || '全部'
    const risk = searchParams.get('risk') || '全部'
    const source = searchParams.get('source') || '全部'
    const manualReview = searchParams.get('manualReview') || '全部'
    const signOff = searchParams.get('signOff') || '全部'
    const archive = searchParams.get('archive') || '全部'
    const exportState = searchParams.get('export') || '全部'
    const exportSource = searchParams.get('exportSource') || '全部'
    const attachment = searchParams.get('attachment') || '全部'
    const ai = searchParams.get('ai') || '全部'
    const submitter = searchParams.get('submitter') || '全部'
    const sort = searchParams.get('sort') || '默认排序'
    const queue = searchParams.get('queue') || '默认视图'
    const nextStatusGroup = searchParams.get('statusGroup') || ''
    const q = searchParams.get('q') || ''

    setFilter(statusTabs.includes(status) ? status : '全部')
    setTypeFilter(['全部', '内部运营方案', '市场拓展方案'].includes(type) ? type : '全部')
    setRiskFilter(['全部', '高风险', '无高风险'].includes(risk) ? risk : '全部')
    setReminderSourceFilter(['全部', '人工登记', '自动催办', '未催办'].includes(source) ? source : '全部')
    setManualReviewFilter(['全部', '已复核', '待复核'].includes(manualReview) ? manualReview : '全部')
    setSignOffFilter(['全部', '待签发', '已签发'].includes(signOff) ? signOff : '全部')
    setArchiveFilter(['全部', '待归档', '已归档'].includes(archive) ? archive : '全部')
    setExportFilter(['全部', '已导出', '未导出', '预览', 'Word', 'PDF'].includes(exportState) ? exportState : '全部')
    setExportSourceFilter(['全部', '详情页', '提交结果', '审核中心', '未导出'].includes(exportSource) ? exportSource : '全部')
    setAttachmentFilter(attachmentFilterOptions.includes(attachment) ? attachment : '全部')
    setAiFilter(aiFilterOptions.includes(ai) ? ai : '全部')
    setSubmitterFilter(submitter || '全部')
    setSortMode(['默认排序', '最近导出优先', '导出次数优先', '最新提交优先'].includes(sort) ? sort : '默认排序')
    setQueueMode(queueModes.includes(queue) ? queue : '默认视图')
    setStatusGroup(nextStatusGroup === '待复核队列' ? nextStatusGroup : '')
    setKeyword(q)
  }, [searchParams])

  const loadItems = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.get('/proposals')
      setItems(data.items || [])
    } catch (err) {
      setError(err.message || '方案加载失败')
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadItems() }, [])

  const updateStatus = async (item, status) => {
    if (!canReview) return setError('当前账号无权限流转方案状态')
    if (isConfigurationPending(item)) return setError('该方案尚未完成专业 Profile 配置与 AI 审核，请先进入详情发起 AI 审核。')
    setError('')
    setMessage('')
    setBulkReminderResult(null)
    try {
      await api.patch(`/proposals/${item.id}/status`, { status })
      setMessage(`《${item.title}》已更新为${status}`)
      await loadItems()
      requestNotificationRefresh()
    } catch (err) {
      setError(err.message || '状态更新失败')
    }
  }

  const deleteProposal = async (item) => {
    if (!canManageSystem) return setError('当前账号无权限删除方案')
    const confirmText = '删除方案'
    const typed = window.prompt(`删除《${item.title}》后不可恢复。\n\n如确认继续，请输入：${confirmText}`) || ''
    if (typed.trim() !== confirmText) {
      setError(`删除已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setError('')
    setMessage('')
    setBulkReminderResult(null)
    try {
      await api.delete(`/proposals/${item.id}`, { confirmText })
      setMessage(`已删除《${item.title}》`)
      await loadItems()
      requestNotificationRefresh()
    } catch (err) {
      setError(err.message || '删除失败')
    }
  }

  const openReminder = (item) => {
    if (!canReview) return setError('当前账号无权限登记催办')
    setError('')
    setMessage('')
    setBulkReminderResult(null)
    setReminderDraft({
      id: item.id,
      title: item.title,
      recommendedReminderStage: item.recommendedReminderStage || '进度确认',
      channel: item.lastReminderChannel || '企业微信',
      note: item.lastReminderNote || formatReminderScript(item, item.recommendedReminderStage)
    })
  }

  const closeReminder = () => {
    if (savingReminderId) return
    setReminderDraft(null)
  }

  useEffect(() => {
    if (!reminderDraft) return undefined

    reminderRestoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusFirstControl = window.setTimeout(() => {
      const firstControl = reminderDialogRef.current?.querySelector('button, select, textarea, input, [tabindex]:not([tabindex="-1"])')
      if (firstControl instanceof HTMLElement) firstControl.focus()
    }, 0)

    const handleKeyDown = event => {
      if (event.key === 'Escape' && !savingReminderId) {
        event.preventDefault()
        setReminderDraft(null)
        return
      }

      if (event.key === 'Tab') {
        const focusableControls = Array.from(
          reminderDialogRef.current?.querySelectorAll('button, select, textarea, input, [tabindex]:not([tabindex="-1"])') || []
        ).filter(element => (
          element instanceof HTMLElement &&
          !element.disabled &&
          element.tabIndex !== -1 &&
          element.offsetParent !== null
        ))
        if (focusableControls.length === 0) return

        const firstControl = focusableControls[0]
        const lastControl = focusableControls[focusableControls.length - 1]
        if (event.shiftKey && document.activeElement === firstControl) {
          event.preventDefault()
          lastControl.focus()
        } else if (!event.shiftKey && document.activeElement === lastControl) {
          event.preventDefault()
          firstControl.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusFirstControl)
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
      reminderRestoreFocusRef.current?.focus?.()
      reminderRestoreFocusRef.current = null
    }
  }, [reminderDraft, savingReminderId])

  const copyReminderScript = async (item) => {
    const content = formatReminderScript(item)
    try {
      await copyText(content)
      setMessage(`《${item.title}》催办话术已复制`)
      setBulkReminderResult(null)
      setError('')
    } catch (err) {
      setCopyFallback({
        open: true,
        title: `《${item.title}》催办话术`,
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage('')
      setError('')
    }
  }

  const submitReminder = async () => {
    if (!reminderDraft) return
    if (!canReview) return setError('当前账号无权限登记催办')
    setSavingReminderId(reminderDraft.id)
    setError('')
    setMessage('')
    setBulkReminderResult(null)
    try {
      const result = await api.post(`/proposals/${reminderDraft.id}/reminders`, {
        stage: reminderDraft.recommendedReminderStage,
        channel: reminderDraft.channel,
        note: reminderDraft.note,
        source: 'manual'
      })
      setItems(prev => prev.map(item => (
        item.id === reminderDraft.id ? { ...item, ...(result.summary || {}) } : item
      )))
      setMessage(`《${reminderDraft.title}》催办已登记`)
      setReminderDraft(null)
      requestNotificationRefresh()
    } catch (err) {
      setError(err.message || '催办登记失败')
    } finally {
      setSavingReminderId('')
    }
  }

  const autoCreateReminder = async (item) => {
    if (!canReview) return setError('当前账号无权限生成催办记录')
    setSavingReminderId(item.id)
    setError('')
    setMessage('')
    setBulkReminderResult(null)
    try {
      const result = await api.post(`/proposals/${item.id}/reminders`, {
        stage: item.recommendedReminderStage || item.overdueReminder?.stage || '进度确认',
        channel: item.lastReminderChannel || '企业微信',
        note: formatReminderScript(item, item.recommendedReminderStage || item.overdueReminder?.stage),
        source: 'auto'
      })
      setItems(prev => prev.map(row => (
        row.id === item.id ? { ...row, ...(result.summary || {}) } : row
      )))
      setMessage(`《${item.title}》催办草稿已保存，尚未发送`)
      requestNotificationRefresh()
    } catch (err) {
      setError(err.message || '催办草稿生成失败')
    } finally {
      setSavingReminderId('')
    }
  }

  const bulkAutoCreateReminders = async () => {
    if (selectedIds.length === 0) return
    if (!canReview) return setError('当前账号无权限批量生成催办记录')
    const confirmText = '批量生成催办'
    const typed = window.prompt(`即将对选中的 ${selectedIds.length} 个方案批量生成催办草稿。此操作不会发送企业微信、邮件或电话通知。\n${selectedTitlePreview()}\n\n如确认继续，请输入：${confirmText}`) || ''
    if (typed.trim() !== confirmText) {
      setError(`批量生成催办草稿已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setActingBulk(true)
    setError('')
    setMessage('')
    setBulkActionResult(null)
    setBulkReminderResult(null)
    try {
      const result = await api.post('/proposals/bulk-reminders', {
        ids: selectedIds,
        mode: 'auto',
        confirmText
      })
      setMessage(`已生成 ${result.created || 0} 个未发送催办草稿，跳过 ${result.skipped || 0} 个`)
      setSelectedIds([])
      setBulkReminderResult({
        requested: result.requested || selectedIds.length,
        created: result.created || 0,
        skipped: result.skipped || 0,
        items: result.items || [],
        skippedItems: result.skippedItems || []
      })
      await loadItems()
      requestNotificationRefresh()
    } catch (err) {
      setError(err.message || '批量生成催办草稿失败')
      setBulkReminderResult(err.data ? {
        requested: err.data.requested || selectedIds.length,
        created: err.data.created || 0,
        skipped: err.data.skipped || 0,
        items: err.data.items || [],
        skippedItems: err.data.skippedItems || []
      } : null)
    } finally {
      setActingBulk(false)
    }
  }

  const normalizedKeyword = keyword.trim().toLowerCase()
  const needReminderOnly = searchParams.get('needReminder') === '1'
  const submitterOptions = useMemo(
    () => ['全部', ...Array.from(new Set(items.map(item => item.submitter).filter(Boolean)))],
    [items]
  )
  const effectiveSubmitterFilter = submitterOptions.includes(submitterFilter) ? submitterFilter : '全部'
  const filtered = useMemo(() => items.filter(item => {
    const matchStatusGroup = statusGroup !== '待复核队列' || ['待审核', '审核中', '待复核'].includes(item.status)
    const matchStatus = (filter === '全部' || item.status === filter) && matchStatusGroup
    const matchType = typeFilter === '全部' || item.type === typeFilter
    const matchRisk =
      riskFilter === '全部' ||
      (riskFilter === '高风险' && (item.highRiskCount || 0) > 0) ||
      (riskFilter === '无高风险' && (item.highRiskCount || 0) === 0)
    const matchReminderSource =
      reminderSourceFilter === '全部' ||
      (reminderSourceFilter === '人工登记' && item.lastReminderSource === 'manual') ||
      (reminderSourceFilter === '自动催办' && item.lastReminderSource === 'auto') ||
      (reminderSourceFilter === '未催办' && !item.lastReminderAt)
    const matchManualReview =
      manualReviewFilter === '全部' ||
      (!isConfigurationPending(item) && (
        (manualReviewFilter === '已复核' && item.hasManualReview) ||
        (manualReviewFilter === '待复核' && !item.hasManualReview)
      ))
    const matchSignOff =
      signOffFilter === '全部' ||
      (!isConfigurationPending(item) && (
        (signOffFilter === '待签发' && item.signOffStatus === '待签发') ||
        (signOffFilter === '已签发' && item.signOffStatus === '已签发')
      ))
    const matchArchive =
      archiveFilter === '全部' ||
      (!isConfigurationPending(item) && (
        (archiveFilter === '待归档' && item.archiveStatus === '待归档') ||
        (archiveFilter === '已归档' && item.archiveStatus === '已归档')
      ))
    const matchExport =
      exportFilter === '全部' ||
      (exportFilter === '已导出' && (item.exportCount || 0) > 0) ||
      (exportFilter === '未导出' && (item.exportCount || 0) === 0) ||
      (exportFilter === '预览' && item.lastExportType === 'preview') ||
      (exportFilter === 'Word' && item.lastExportType === 'word') ||
      (exportFilter === 'PDF' && item.lastExportType === 'pdf')
    const matchExportSource =
      exportSourceFilter === '全部' ||
      (exportSourceFilter === '未导出' && !item.lastExportSource) ||
      (exportSourceFilter === '详情页' && item.lastExportSource === 'detail') ||
      (exportSourceFilter === '提交结果' && item.lastExportSource === 'submit') ||
      (exportSourceFilter === '审核中心' && item.lastExportSource === 'review')
    const matchSubmitter = effectiveSubmitterFilter === '全部' || item.submitter === effectiveSubmitterFilter
    const searchable = [item.title, item.type, item.submitter, item.robot, item.result].join(' ').toLowerCase()
    const matchKeyword = !normalizedKeyword || searchable.includes(normalizedKeyword)
    const matchNeedReminder = !needReminderOnly || item.needsReminder
    const matchQueuePreset = matchQueueMode(item, queueMode)
    const matchAttachment = matchAttachmentFilter(item, attachmentFilter)
    const aiTrace = item.latestAiTrace || null
    const matchAi =
      aiFilter === '全部' ||
      (aiFilter === '无AI记录' && !aiTrace) ||
      (aiFilter === 'AI成功' && aiTrace && aiTrace.status === 'success' && aiTrace.fallback !== true) ||
      (aiFilter === '待人工复核' && aiTrace && aiTrace.status === 'needs-human-review' && aiTrace.fallback !== true) ||
      (aiFilter === 'AI回退' && aiTrace && (aiTrace.fallback === true || aiTrace.status === 'fallback')) ||
      (aiFilter === 'AI失败' && aiTrace && aiTrace.status === 'failed')
    return matchStatus && matchType && matchRisk && matchReminderSource && matchManualReview && matchSignOff && matchArchive && matchExport && matchExportSource && matchAttachment && matchAi && matchSubmitter && matchKeyword && matchNeedReminder && matchQueuePreset
  }), [aiFilter, archiveFilter, attachmentFilter, effectiveSubmitterFilter, exportFilter, exportSourceFilter, filter, items, manualReviewFilter, needReminderOnly, normalizedKeyword, queueMode, reminderSourceFilter, riskFilter, signOffFilter, statusGroup, typeFilter])

  const sortedFiltered = useMemo(() => {
    const list = [...filtered]
    if (sortMode === '最近导出优先') {
      return list.sort((a, b) => String(b.lastExportAt || '').localeCompare(String(a.lastExportAt || ''), 'zh-CN'))
    }
    if (sortMode === '导出次数优先') {
      return list.sort((a, b) => (b.exportCount || 0) - (a.exportCount || 0) || String(b.lastExportAt || '').localeCompare(String(a.lastExportAt || ''), 'zh-CN'))
    }
    if (sortMode === '最新提交优先') {
      return list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''), 'zh-CN'))
    }
    return list
  }, [filtered, sortMode])

  const selectedItems = useMemo(
    () => sortedFiltered.filter(item => selectedIds.includes(item.id)),
    [selectedIds, sortedFiltered]
  )
  const activePinnedViews = useMemo(() => {
    const views = []
    if (queueMode !== '默认视图' && queuePresetMeta[queueMode]) {
      views.push(queuePresetMeta[queueMode])
    }
    if (needReminderOnly) {
      views.push({
        label: '仅看建议催办',
        description: '只显示当前命中催办规则、建议尽快跟进的方案。',
        chipClass: 'border-violet-400/30 bg-violet-500/10 text-violet-100'
      })
    }
    if (statusGroup === '待复核队列') {
      views.push({
        label: '待复核队列',
        description: '只显示待审核、审核中、待复核三类待处理方案。',
        chipClass: 'border-cyan-400/30 bg-cyan-500/10 text-cyan-100'
      })
    }
    return views
  }, [needReminderOnly, queueMode, statusGroup])
  const allFilteredSelected = sortedFiltered.length > 0 && sortedFiltered.every(item => selectedIds.includes(item.id))
  const selectedHighRiskCount = selectedItems.reduce((sum, item) => sum + (item.highRiskCount || 0), 0)
  const selectedPassedCount = selectedItems.filter(item => item.status === '已通过').length
  const selectedConfigurationPendingCount = selectedItems.filter(isConfigurationPending).length
  const selectedTitlePreview = (limit = 4) => {
    const titles = selectedItems.slice(0, limit).map(item => `《${item.title}》`).join('、')
    return `${titles}${selectedItems.length > limit ? ' 等' : ''}`
  }
  const bulkSelectionSummary = selectedIds.length > 0
    ? `当前已选择 ${selectedIds.length} 个方案，待专业配置 ${selectedConfigurationPendingCount} 个，已通过 ${selectedPassedCount} 个，高风险 ${selectedHighRiskCount} 项`
    : '当前未选择方案'
  const bulkActionLabel = (action, confirmText = '') => {
    if (actingBulk) return `${action}暂不可用：正在执行批量操作`
    if (bulkExporting && action.includes('导出')) return `${action}暂不可用：正在批量导出`
    if (selectedIds.length === 0) return `${action}暂不可用：请先选择方案`
    return `${action}：${bulkSelectionSummary}${confirmText ? `，执行前需要输入“${confirmText}”确认` : ''}`
  }
  const formatResultTitles = (items = [], limit = 5) => {
    const list = items
      .map(item => item?.title || item?.summary?.title || item)
      .filter(Boolean)
    return `${list.slice(0, limit).map(title => `《${title}》`).join('、')}${list.length > limit ? ' 等' : ''}`
  }
  const logsPathForIds = (ids = [], actionGroup = '全部') => buildLogsPath({
    proposalIds: ids,
    type: '执行动作',
    actionGroup,
    exportSource: exportSourceFilter,
    submitter: effectiveSubmitterFilter,
    proposalType: typeFilter
  })
  const bulkLogsPath = (keyword = '', actionGroup = '全部', type = '全部') => buildLogsPath({ type, actionGroup, keyword })
  const filteredReminderStats = useMemo(() => ({
    auto: sortedFiltered.filter(item => item.lastReminderSource === 'auto').length,
    manual: sortedFiltered.filter(item => item.lastReminderAt && item.lastReminderSource !== 'auto').length,
    none: sortedFiltered.filter(item => !item.lastReminderAt).length,
    needReminder: sortedFiltered.filter(item => item.needsReminder).length
  }), [sortedFiltered])

  const filteredExportStats = useMemo(() => ({
    exported: sortedFiltered.filter(item => (item.exportCount || 0) > 0).length,
    notExported: sortedFiltered.filter(item => (item.exportCount || 0) === 0).length,
    preview: sortedFiltered.filter(item => item.lastExportType === 'preview').length,
    word: sortedFiltered.filter(item => item.lastExportType === 'word').length,
    pdf: sortedFiltered.filter(item => item.lastExportType === 'pdf').length
  }), [sortedFiltered])
  const filteredAttachmentStats = useMemo(() => ({
    parsed: sortedFiltered.reduce((sum, item) => sum + (item.attachmentSummary?.parsed || 0), 0),
    issue: sortedFiltered.reduce((sum, item) => sum + (item.attachmentSummary?.failed || 0) + (item.attachmentSummary?.unsupported || 0) + (item.attachmentSummary?.pending || 0), 0),
    pdfTable: sortedFiltered.reduce((sum, item) => sum + (item.attachmentSummary?.pdfTableCount || 0), 0)
  }), [sortedFiltered])
  const filteredAiStats = useMemo(() => ({
    success: sortedFiltered.filter(item => item.latestAiTrace && item.latestAiTrace.status === 'success' && item.latestAiTrace.fallback !== true).length,
    manual: sortedFiltered.filter(item => item.latestAiTrace?.status === 'needs-human-review' && item.latestAiTrace.fallback !== true).length,
    fallback: sortedFiltered.filter(item => item.latestAiTrace && (item.latestAiTrace.fallback === true || item.latestAiTrace.status === 'fallback')).length,
    failed: sortedFiltered.filter(item => item.latestAiTrace?.status === 'failed').length,
    none: sortedFiltered.filter(item => !item.latestAiTrace).length
  }), [sortedFiltered])
  const filteredExecutionStats = useMemo(() => ({
    pendingManualReview: sortedFiltered.filter(item => !isConfigurationPending(item) && !item.hasManualReview).length,
    reviewed: sortedFiltered.filter(item => item.hasManualReview).length,
    pendingSignOff: sortedFiltered.filter(item => item.hasManualReview && item.signOffStatus !== '已签发').length,
    pendingArchive: sortedFiltered.filter(item => item.signOffStatus === '已签发' && item.archiveStatus !== '已归档').length,
    archived: sortedFiltered.filter(item => item.archiveStatus === '已归档').length
  }), [sortedFiltered])
  const filteredProposalIds = useMemo(
    () => [...new Set(sortedFiltered.map(item => item.id).filter(Boolean))],
    [sortedFiltered]
  )
  const filteredSubmitterCount = useMemo(
    () => new Set(sortedFiltered.map(item => item.submitter).filter(Boolean)).size,
    [sortedFiltered]
  )

  const currentFilterSummary = `状态：${statusGroup || filter}；类型：${typeFilter}；风险：${riskFilter}；催办来源：${reminderSourceFilter}；人工复核：${manualReviewFilter}；签发：${signOffFilter}；归档：${archiveFilter}；导出：${exportFilter}；导出来源：${exportSourceFilter}；附件解析：${attachmentFilter}；AI状态：${aiFilter}；提交人：${effectiveSubmitterFilter}；排序：${sortMode}；队列：${queueMode}；关键词：${keyword.trim() || '无'}；结果数：${sortedFiltered.length}`

  const copyFilterSummary = async () => {
    try {
      await copyText(currentFilterSummary)
      setMessage('当前筛选摘要已复制。')
      setError('')
    } catch {
      setCopyFallback({
        open: true,
        title: '审核中心筛选摘要',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content: currentFilterSummary
      })
      setMessage('')
      setError('')
    }
  }

  const exportFilteredItems = () => {
    const header = ['方案名称', '类型', '提交人', '审核机制', '状态', '人工复核', '签发', '归档', '附件解析', '导出状态', '导出来源', '导出次数', '最后导出时间', '最近催办', '综合评分', '高风险项', '提交时间']
    const rows = sortedFiltered.map(item => [
      item.title || '',
      item.type || '',
      item.submitter || '',
      item.robot || '',
      item.status || '',
      isConfigurationPending(item) ? '待 AI 审核' : (item.manualReviewStatus || (item.hasManualReview ? '已复核' : '待复核')),
      isConfigurationPending(item) ? '未开放' : (item.signOffStatus || '待签发'),
      isConfigurationPending(item) ? '未开放' : (item.archiveStatus || '待归档'),
      `${item.attachmentSummary?.parsed || 0}/${item.attachmentSummary?.total || item.fileCount || 0} 已解析，异常 ${(item.attachmentSummary?.failed || 0) + (item.attachmentSummary?.unsupported || 0) + (item.attachmentSummary?.pending || 0)}，PDF表格 ${item.attachmentSummary?.pdfTableCount || 0}`,
      item.exportCount > 0 ? exportTypeText(item.lastExportType) : '未导出',
      item.lastExportSource === 'detail' ? '详情页' : item.lastExportSource === 'submit' ? '提交结果' : item.lastExportSource === 'review' ? '审核中心' : '未记录来源',
      item.exportCount || 0,
      item.lastExportAt || '',
      item.lastReminderStage || '未催办',
      item.avgScore ?? '',
      item.highRiskCount || 0,
      item.createdAt || ''
    ])
    const csv = [header, ...rows]
      .map(row => row.map(csvCell).join(','))
      .join('\n')
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `审核中心-${Date.now()}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    setMessage('当前筛选结果已导出 CSV。')
    setError('')
  }

  const toggleItem = (id) => {
    setSelectedIds(prev => (
      prev.includes(id)
        ? prev.filter(itemId => itemId !== id)
        : [...prev, id]
    ))
  }

  const toggleAllFiltered = () => {
    if (allFilteredSelected) {
      const filteredIdSet = new Set(filtered.map(item => item.id))
      setSelectedIds(prev => prev.filter(id => !filteredIdSet.has(id)))
      return
    }
    setSelectedIds(prev => [...new Set([...prev, ...sortedFiltered.map(item => item.id)])])
  }

  const bulkUpdateStatus = async (status) => {
    if (selectedIds.length === 0) return
    if (!canReview) return setError('当前账号无权限批量流转方案状态')
    if (selectedConfigurationPendingCount > 0) return setError(`所选方案中有 ${selectedConfigurationPendingCount} 个“待专业配置”草稿，请先发起 AI 审核后再流转状态。`)
    const confirmText = '批量更新方案状态'
    const typed = window.prompt(`即将把选中的 ${selectedIds.length} 个方案批量更新为「${status}」。\n${selectedTitlePreview()}\n\n如确认继续，请输入：${confirmText}`) || ''
    if (typed.trim() !== confirmText) {
      setError(`批量状态更新已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setActingBulk(true)
    setError('')
    setMessage('')
    setBulkActionResult(null)
    try {
      const result = await api.post('/proposals/bulk-status', { ids: selectedIds, status, confirmText })
      setMessage(`已将 ${result.updated || 0} 个方案更新为${status}`)
      setBulkActionResult({
        tone: 'emerald',
        title: `批量状态更新完成`,
        summary: `已更新 ${result.updated || 0} 个方案为「${status}」。`,
        detail: formatResultTitles(result.items || []),
        logsTo: bulkLogsPath('批量更新方案状态')
      })
      setSelectedIds([])
      await loadItems()
      requestNotificationRefresh()
    } catch (err) {
      setError(err.message || '批量状态更新失败')
    } finally {
      setActingBulk(false)
    }
  }

  const bulkDelete = async () => {
    if (selectedIds.length === 0) return
    if (!canManageSystem) return setError('当前账号无权限批量删除方案')
    const confirmText = `删除${selectedIds.length}个方案`
    const typed = window.prompt(`批量删除会永久移除选中的 ${selectedIds.length} 个方案，删除后不可恢复。\n${selectedTitlePreview()}\n\n如确认继续，请输入：${confirmText}`) || ''
    if (typed.trim() !== confirmText) {
      setError(`批量删除已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setActingBulk(true)
    setError('')
    setMessage('')
    setBulkActionResult(null)
    try {
      const result = await api.post('/proposals/bulk-delete', { ids: selectedIds, confirmText })
      setSelectedIds([])
      setMessage(`已删除 ${result.removed || 0} 个方案`)
      setBulkActionResult({
        tone: 'rose',
        title: '批量删除完成',
        summary: `已删除 ${result.removed || 0} 个方案。`,
        detail: formatResultTitles(result.titles || []),
        logsTo: bulkLogsPath('批量删除方案')
      })
      await loadItems()
      requestNotificationRefresh()
    } catch (err) {
      setError(err.message || '批量删除失败')
    } finally {
      setActingBulk(false)
    }
  }

  const bulkRerunAiReview = async () => {
    if (selectedIds.length === 0) return
    if (!canReview) return setError('当前账号无权限批量重新发起 AI 审核')
    if (selectedIds.length > 2) return setError('为保证 AI 审核在发布停机窗口内可安全完成，单次最多选择 2 个方案。')
    const confirmText = '批量重新审核'
    const typed = window.prompt(`即将对选中的 ${selectedIds.length} 个方案重新发起 AI 审核。\n${selectedTitlePreview()}\n\n如确认继续，请输入：${confirmText}`) || ''
    if (typed.trim() !== confirmText) {
      setError(`批量 AI 重审已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setActingBulk(true)
    setError('')
    setMessage('')
    setBulkReminderResult(null)
    setBulkActionResult(null)
    try {
      const result = await api.post('/proposals/bulk-review', { ids: selectedIds, confirmText })
      setMessage(`已批量重新发起 AI 审核：处理完成 ${result.reviewed || 0} 个，失败 ${result.failed || 0} 个；处理完成不代表人工复核通过。`)
      setBulkActionResult({
        tone: (result.failed || 0) > 0 ? 'amber' : 'cyan',
        title: '批量 AI 重审完成',
        summary: `处理完成 ${result.reviewed || 0} 个，失败 ${result.failed || 0} 个；处理完成不代表人工复核通过。`,
        detail: formatResultTitles((result.items || []).filter(item => item.ok)),
        warning: formatResultTitles((result.items || []).filter(item => !item.ok)),
        logsTo: bulkLogsPath('批量重新发起 AI 审核', 'AI调用', '执行动作')
      })
      setSelectedIds([])
      await loadItems()
    } catch (err) {
      setError(err.message || '批量重新发起 AI 审核失败')
    } finally {
      setActingBulk(false)
    }
  }

  const recordExportEvent = async (proposalId, type, options = {}) => {
    await api.post(`/proposals/${proposalId}/export-events`, {
      type,
      appVersion,
      appBuildTime,
      appBuildLabel,
      source: 'review',
      ...options
    })
  }

  const bulkExportWord = async () => {
    if (selectedItems.length === 0) return
    if (selectedConfigurationPendingCount > 0) return setError(`所选方案中有 ${selectedConfigurationPendingCount} 个尚未生成审核意见的草稿，不能导出意见书。请先发起 AI 审核。`)
    const confirmText = '批量导出Word'
    const typed = window.prompt(`确认批量导出选中的 ${selectedItems.length} 份 Word 意见书？\n${selectedTitlePreview()}\n导出后会为每个方案登记导出留痕。\n\n如确认继续，请输入：${confirmText}`) || ''
    if (typed.trim() !== confirmText) {
      setError(`批量导出 Word 已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setBulkExporting(true)
    setError('')
    setMessage('')
    setBulkReminderResult(null)
    setBulkActionResult(null)
    try {
      const { downloadReviewReport } = await loadReportTools()
      for (const item of selectedItems) {
        await downloadReviewReport(item, exportOptions)
        await recordExportEvent(item.id, 'word', { bulk: true, confirmText })
      }
      setMessage(`已从审核中心批量导出 ${selectedItems.length} 份 Word 意见书`)
      setBulkActionResult({
        tone: 'emerald',
        title: '批量 Word 导出完成',
        summary: `已导出 ${selectedItems.length} 份 Word 意见书，并记录导出留痕。`,
        detail: formatResultTitles(selectedItems),
        logsTo: logsPathForIds(selectedItems.map(item => item.id), '导出')
      })
      setSelectedIds([])
      await loadItems()
    } catch (err) {
      setError(err.message || '批量导出 Word 失败')
    } finally {
      setBulkExporting(false)
    }
  }

  const stats = useMemo(() => ({
    total: items.length,
    configurationPending: items.filter(isConfigurationPending).length,
    needReview: items.filter(item => ['待审核', '审核中', '待复核'].includes(item.status)).length,
    needRevision: items.filter(item => item.status === '待修改').length,
    highRisk: items.reduce((sum, item) => sum + (item.highRiskCount || 0), 0),
    manualReviewed: items.filter(item => item.hasManualReview).length,
    pendingSignOff: items.filter(item => !isConfigurationPending(item) && item.signOffStatus === '待签发').length,
    pendingArchive: items.filter(item => !isConfigurationPending(item) && item.archiveStatus === '待归档').length
  }), [items])

  const activateQueuePreset = (nextQueueMode) => {
    setQueueMode(nextQueueMode)
    setStatusGroup('')
    setRiskFilter('全部')
    setReminderSourceFilter('全部')
    setManualReviewFilter('全部')
    setSignOffFilter('全部')
    setArchiveFilter('全部')
    setAttachmentFilter('全部')
    setSubmitterFilter('全部')
    syncSearchParams(next => {
      if (!nextQueueMode || nextQueueMode === '默认视图') next.delete('queue')
      else next.set('queue', nextQueueMode)
      next.delete('risk')
      next.delete('source')
      next.delete('manualReview')
      next.delete('signOff')
      next.delete('archive')
      next.delete('export')
      next.delete('exportSource')
      next.delete('attachment')
      next.delete('submitter')
      next.delete('sort')
      next.delete('needReminder')
      next.delete('statusGroup')
    })
  }

  const activateSummaryPreset = (preset = {}) => {
    setSelectedIds([])
    setSearchParams(() => {
      const next = new URLSearchParams()
      Object.entries(preset).forEach(([key, value]) => {
        if (value) next.set(key, value)
      })
      if (!next.has('sort')) next.set('sort', '最新提交优先')
      return next
    })
  }

  const SummaryStatCard = ({ label, value, valueClass, onClick }) => {
    const Component = onClick ? 'button' : 'div'
    return (
      <Component
        type={onClick ? 'button' : undefined}
        onClick={onClick}
        className={`rounded-lg border border-blue-500/20 bg-slate-900/60 p-4 text-left transition ${onClick ? 'hover:-translate-y-0.5 hover:border-cyan-300/40' : ''}`}
      >
        <div className="text-xs text-slate-500">{label}</div>
        <div className={`mt-2 text-2xl font-bold ${valueClass}`}>{value}</div>
      </Component>
    )
  }

  const toggleSearchParam = (key, value, active = false) => {
    syncSearchParams(next => {
      if (active) next.delete(key)
      else next.set(key, value)
    })
  }

  const FilterChip = ({ label, count, className, active, onClick }) => (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-1 rounded border transition hover:border-white/30 ${className} ${active ? 'ring-1 ring-white/25' : ''}`}
    >
      {label} {count}
    </button>
  )

  const activatePendingHighRiskQueue = () => {
    activateQueuePreset('待人工复核高风险')
  }

  const clearPinnedView = () => {
    setQueueMode('默认视图')
    setStatusGroup('')
    syncSearchParams(next => {
      next.delete('queue')
      next.delete('needReminder')
      next.delete('statusGroup')
    })
  }

  const resetQueueMode = () => {
    setQueueMode('默认视图')
    setFilter('全部')
    setTypeFilter('全部')
    setManualReviewFilter('全部')
    setRiskFilter('全部')
    setReminderSourceFilter('全部')
    setSignOffFilter('全部')
    setArchiveFilter('全部')
    setExportFilter('全部')
    setExportSourceFilter('全部')
    setAttachmentFilter('全部')
    setStatusGroup('')
    setSubmitterFilter('全部')
    setSortMode('默认排序')
    setKeyword('')
    setSearchParams(new URLSearchParams())
  }

  const activateReviewedPendingSignOffQueue = () => {
    activateQueuePreset('已复核未签发')
  }

  const activateSignedPendingArchiveQueue = () => {
    activateQueuePreset('已签发未归档')
  }

  const activateOverdueReminderQueue = () => {
    activateQueuePreset('超时催办')
  }

  const activateApproachingReminderQueue = () => {
    activateQueuePreset('临近超时')
  }

  const activateRecentReminderQueue = () => {
    activateQueuePreset('最近催办')
  }

  const activateNeedReminderOnly = () => {
    setQueueMode('默认视图')
    setSubmitterFilter('全部')
    syncSearchParams(next => {
      next.set('needReminder', '1')
      next.delete('queue')
      next.delete('submitter')
    })
  }

  const openFilteredLogs = (actionGroup = '全部') => {
    if (filteredProposalIds.length === 0) return
    navigate(buildLogsPath({
      proposalIds: filteredProposalIds,
      actionGroup,
      exportSource: exportSourceFilter,
      submitter: effectiveSubmitterFilter,
      proposalType: typeFilter
    }))
  }

  const openExecutionLogs = (actionGroup = '全部') => {
    navigate(buildLogsPath({
      actionGroup,
      exportSource: exportSourceFilter,
      submitter: effectiveSubmitterFilter,
      proposalType: typeFilter
    }))
  }

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
    <span className={`px-2 py-1 rounded text-xs border ${
      (text || '').includes('市场')
        ? 'bg-blue-500/10 border-blue-400/30 text-blue-300'
        : 'bg-emerald-500/10 border-emerald-400/30 text-emerald-300'
    }`}>{text}</span>
  )

  const ManualReviewBadge = ({ item }) => (
    <span className={`px-2 py-1 rounded text-xs border ${
      item.hasManualReview
        ? 'text-emerald-300 bg-emerald-500/10 border-emerald-400/30'
        : 'text-slate-300 bg-slate-500/10 border-slate-400/30'
    }`}>
      {item.manualReviewStatus || (item.hasManualReview ? '已复核' : '待复核')}
    </span>
  )

  const FlowBadge = ({ text, doneTone = 'emerald' }) => {
    const toneClass =
      text === '已签发' || text === '已归档'
        ? doneTone === 'cyan'
          ? 'text-cyan-300 bg-cyan-500/10 border-cyan-400/30'
          : 'text-emerald-300 bg-emerald-500/10 border-emerald-400/30'
        : 'text-slate-300 bg-slate-500/10 border-slate-400/30'
    return <span className={`px-2 py-1 rounded text-xs border ${toneClass}`}>{text}</span>
  }

  const ReminderBadge = ({ item }) => {
    if (!item.lastReminderAt) {
      return (
        <span className="px-2 py-1 rounded text-xs border border-amber-400/30 bg-amber-500/10 text-amber-200">
          未催办
        </span>
      )
    }

    return (
      <span className="px-2 py-1 rounded text-xs border border-cyan-400/30 bg-cyan-500/10 text-cyan-200">
        {item.lastReminderStage || '已催办'}
      </span>
    )
  }

  const OverdueBadge = ({ item }) => {
    if (!item.overdueReminder?.overdue) {
      return <div className="text-[11px] text-slate-500">{item.overdueReminder?.label || '正常跟进'}</div>
    }

    const toneClass = item.overdueReminder.level === '高'
      ? 'border-red-400/30 bg-red-500/10 text-red-200'
      : 'border-amber-400/30 bg-amber-500/10 text-amber-200'

    return (
      <span className={`px-2 py-1 rounded text-xs border ${toneClass}`}>
        {item.overdueReminder.stage} · {item.overdueReminder.label}
      </span>
    )
  }

  const ReminderSourceBadge = ({ source }) => {
    const toneClass = source === 'auto'
      ? 'border-violet-400/30 bg-violet-500/10 text-violet-200'
      : 'border-slate-500/30 bg-slate-500/10 text-slate-300'

    return (
      <span className={`px-2 py-1 rounded text-[11px] border ${toneClass}`}>
        {reminderSourceText(source)}
      </span>
    )
  }

  return (
    <div className="space-y-4">
      <Panel className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h1 className="text-xl font-bold text-blue-200">审核中心</h1>
            <p className="text-sm text-slate-400 mt-1">按状态、类型和风险筛选方案；系统可生成未发送催办草稿，真实沟通需人工登记留痕。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
            <div className="flex items-center gap-2 px-4 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-slate-400 w-full md:w-72">
              <Search size={16} aria-hidden="true" />
              <input
                value={keyword}
                onChange={e => {
                  const value = e.target.value
                  setKeyword(value)
                  syncSearchParams(next => {
                    if (!value.trim()) next.delete('q')
                    else next.set('q', value)
                  })
                }}
                aria-label="搜索方案"
                className="bg-transparent outline-none text-sm text-white placeholder-slate-500 flex-1"
                placeholder="搜索方案..."
              />
            </div>
            <button
              type="button"
              onClick={copyFilterSummary}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-400/30 bg-blue-500/10 text-blue-100 text-sm"
            >
              <Copy size={15} />
              复制摘要
            </button>
            <button
              type="button"
              onClick={exportFilteredItems}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 text-emerald-100 text-sm"
            >
              <Download size={15} />
              导出 CSV
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 xl:grid-cols-8 gap-3 mb-4">
          <SummaryStatCard label="方案总数" value={stats.total} valueClass="text-blue-100" onClick={() => activateSummaryPreset()} />
          <SummaryStatCard label="待专业配置" value={stats.configurationPending} valueClass="text-amber-200" onClick={() => activateSummaryPreset({ status: '待专业配置' })} />
          <SummaryStatCard label="待复核队列" value={stats.needReview} valueClass="text-cyan-200" onClick={() => activateSummaryPreset({ statusGroup: '待复核队列' })} />
          <SummaryStatCard label="待修改方案" value={stats.needRevision} valueClass="text-violet-200" onClick={() => activateSummaryPreset({ status: '待修改' })} />
          <SummaryStatCard label="高风险项" value={stats.highRisk} valueClass="text-amber-200" onClick={() => activateSummaryPreset({ risk: '高风险' })} />
          <SummaryStatCard label="已完成人工复核" value={stats.manualReviewed} valueClass="text-emerald-200" onClick={() => activateSummaryPreset({ manualReview: '已复核' })} />
          <SummaryStatCard label="待签发" value={stats.pendingSignOff} valueClass="text-emerald-100" onClick={() => activateSummaryPreset({ signOff: '待签发' })} />
          <SummaryStatCard label="待归档" value={stats.pendingArchive} valueClass="text-cyan-200" onClick={() => activateSummaryPreset({ archive: '待归档' })} />
        </div>

        {error && <div className="mb-4 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>}
        {message && <div className="mb-4 text-sm text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">{message}</div>}
        {bulkActionResult && (
          <div className={`mb-4 rounded-lg border px-4 py-3 ${
            bulkActionResult.tone === 'rose'
              ? 'border-rose-500/20 bg-rose-500/10'
              : bulkActionResult.tone === 'amber'
                ? 'border-amber-500/20 bg-amber-500/10'
                : bulkActionResult.tone === 'cyan'
                  ? 'border-cyan-500/20 bg-cyan-500/10'
                  : 'border-emerald-500/20 bg-emerald-500/10'
          }`}>
            <div className="text-sm font-semibold text-blue-100">{bulkActionResult.title}</div>
            <div className="mt-1 text-sm text-slate-300">{bulkActionResult.summary}</div>
            {bulkActionResult.detail && (
              <div className="mt-2 text-xs text-slate-400">涉及：{bulkActionResult.detail}</div>
            )}
            {bulkActionResult.warning && (
              <div className="mt-2 text-xs text-amber-200">失败：{bulkActionResult.warning}</div>
            )}
            {canViewLogs && bulkActionResult.logsTo && (
              <button
                type="button"
                onClick={() => navigate(bulkActionResult.logsTo)}
                className="mt-3 rounded-lg border border-blue-400/30 bg-blue-500/10 px-3 py-1.5 text-xs text-blue-100 hover:border-blue-300/60"
              >
                查看相关日志
              </button>
            )}
          </div>
        )}
        {bulkReminderResult && (
          <div className="mb-4 rounded-lg border border-violet-500/20 bg-violet-500/10 px-4 py-3">
            <div className="text-sm text-violet-100">
              本次批量催办共选择 {bulkReminderResult.requested || 0} 个方案，已生成未发送草稿 {bulkReminderResult.created || 0} 个，跳过 {bulkReminderResult.skipped || 0} 个。
            </div>
            {bulkReminderResult.items?.length > 0 && (
              <div className="mt-2 text-xs text-violet-200/90">
                已生成：{bulkReminderResult.items.slice(0, 4).map(item => `《${item.title}》`).join('、')}{bulkReminderResult.items.length > 4 ? ' 等' : ''}
              </div>
            )}
            {bulkReminderResult.skippedItems?.length > 0 && (
              <div className="mt-2 text-xs text-slate-300">
                已跳过：{bulkReminderResult.skippedItems.slice(0, 4).map(item => `《${item.title}》(${item.reason})`).join('、')}{bulkReminderResult.skippedItems.length > 4 ? ' 等' : ''}
              </div>
            )}
            {canViewLogs && bulkReminderResult.items?.length > 0 && (
              <button
                type="button"
                onClick={() => navigate(bulkLogsPath('批量生成催办草稿', '催办', '执行动作'))}
                className="mt-3 rounded-lg border border-violet-400/30 bg-violet-500/10 px-3 py-1.5 text-xs text-violet-100 hover:border-violet-300/60"
              >
                查看催办日志
              </button>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-4">
          {statusTabs.map(t => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setFilter(t)
                syncSearchParams(next => {
                  if (t === '全部') next.delete('status')
                  else next.set('status', t)
                })
              }}
              className={`px-3 py-1.5 rounded text-sm border transition ${
                filter === t
                  ? 'bg-blue-600/25 border-blue-400/60 text-white'
                  : 'border-blue-500/20 text-slate-400 hover:border-blue-400/40'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          <button
            type="button"
            onClick={activatePendingHighRiskQueue}
            className={`px-3 py-1.5 rounded text-sm border transition ${
              queueMode === '待人工复核高风险'
                ? 'bg-amber-500/20 border-amber-400/60 text-amber-100'
                : 'border-amber-400/30 text-amber-200 hover:border-amber-300/50'
            }`}
          >
            待人工复核高风险
          </button>
          <button
            type="button"
            onClick={activateReviewedPendingSignOffQueue}
            className={`px-3 py-1.5 rounded text-sm border transition ${
              queueMode === '已复核未签发'
                ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-100'
                : 'border-emerald-400/30 text-emerald-200 hover:border-emerald-300/50'
            }`}
          >
            已复核未签发
          </button>
          <button
            type="button"
            onClick={activateSignedPendingArchiveQueue}
            className={`px-3 py-1.5 rounded text-sm border transition ${
              queueMode === '已签发未归档'
                ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-100'
                : 'border-cyan-400/30 text-cyan-200 hover:border-cyan-300/50'
            }`}
          >
            已签发未归档
          </button>
          <button
            type="button"
            onClick={activateOverdueReminderQueue}
            className={`px-3 py-1.5 rounded text-sm border transition ${
              queueMode === '超时催办'
                ? 'bg-red-500/20 border-red-400/60 text-red-100'
                : 'border-red-400/30 text-red-200 hover:border-red-300/50'
            }`}
          >
            超时催办
          </button>
          <button
            type="button"
            onClick={activateApproachingReminderQueue}
            className={`px-3 py-1.5 rounded text-sm border transition ${
              queueMode === '临近超时'
                ? 'bg-orange-500/20 border-orange-400/60 text-orange-100'
                : 'border-orange-400/30 text-orange-200 hover:border-orange-300/50'
            }`}
          >
            临近超时
          </button>
          <button
            type="button"
            onClick={activateRecentReminderQueue}
            className={`px-3 py-1.5 rounded text-sm border transition ${
              queueMode === '最近催办'
                ? 'bg-sky-500/20 border-sky-400/60 text-sky-100'
                : 'border-sky-400/30 text-sky-200 hover:border-sky-300/50'
            }`}
          >
            最近催办
          </button>
          <button
            type="button"
            onClick={activateNeedReminderOnly}
            className={`px-3 py-1.5 rounded text-sm border transition ${
              needReminderOnly
                ? 'bg-violet-500/20 border-violet-400/60 text-violet-100'
                : 'border-violet-400/30 text-violet-200 hover:border-violet-300/50'
            }`}
          >
            仅看建议催办
          </button>
          <button
            type="button"
            onClick={resetQueueMode}
            className={`px-3 py-1.5 rounded text-sm border transition ${
              activePinnedViews.length === 0 &&
              filter === '全部' &&
              typeFilter === '全部' &&
              riskFilter === '全部' &&
              reminderSourceFilter === '全部' &&
              manualReviewFilter === '全部' &&
              signOffFilter === '全部' &&
              archiveFilter === '全部' &&
              !statusGroup &&
              !normalizedKeyword
                ? 'bg-slate-700/60 border-slate-500/70 text-white'
                : 'border-slate-600 text-slate-300 hover:border-slate-400'
            }`}
          >
            清空全部筛选
          </button>
        </div>

        {activePinnedViews.length > 0 && (
          <div className="mb-4 rounded-lg border border-blue-500/20 bg-slate-950/50 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-blue-100">当前正在查看预设队列</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {activePinnedViews.map(view => (
                    <span key={view.label} className={`px-2.5 py-1 rounded text-xs border ${view.chipClass}`}>
                      {view.label}
                    </span>
                  ))}
                </div>
                <div className="mt-2 text-xs text-slate-400 leading-5">
                  {activePinnedViews.map(view => view.description).join(' ')}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="text-2xl font-bold text-blue-100">{filtered.length}</div>
                  <div className="text-xs text-slate-500">当前命中方案</div>
                </div>
                <button
                  type="button"
                  onClick={clearPinnedView}
                  className="px-3 py-2 rounded-lg border border-blue-400/35 bg-blue-600/15 text-sm text-blue-100 hover:bg-blue-600/25"
                >
                  退出预设视图
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-6 gap-3 mb-4">
          <select aria-label="按方案类型筛选" value={typeFilter} onChange={e => {
            const value = e.target.value
            setTypeFilter(value)
            syncSearchParams(next => {
              if (value === '全部') next.delete('type')
              else next.set('type', value)
            })
          }} className="px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
            <option value="全部">全部类型</option>
            <option value="内部运营方案">内部运营方案</option>
            <option value="市场拓展方案">市场拓展方案</option>
          </select>
          <select aria-label="按风险状态筛选" value={riskFilter} onChange={e => {
            const value = e.target.value
            setRiskFilter(value)
            syncSearchParams(next => {
              if (value === '全部') next.delete('risk')
              else next.set('risk', value)
            })
          }} className="px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
            <option value="全部">全部风险</option>
            <option value="高风险">仅看有高风险</option>
            <option value="无高风险">仅看无高风险</option>
          </select>
          <select aria-label="按催办来源筛选" value={reminderSourceFilter} onChange={e => {
            const value = e.target.value
            setReminderSourceFilter(value)
            syncSearchParams(next => {
              if (value === '全部') next.delete('source')
              else next.set('source', value)
            })
          }} className="px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
            <option value="全部">全部催办来源</option>
            <option value="自动催办">仅看系统草稿（未发送）</option>
            <option value="人工登记">仅看人工登记</option>
            <option value="未催办">仅看未催办</option>
          </select>
          <select aria-label="按人工复核状态筛选" value={manualReviewFilter} onChange={e => {
            const value = e.target.value
            setManualReviewFilter(value)
            syncSearchParams(next => {
              if (value === '全部') next.delete('manualReview')
              else next.set('manualReview', value)
            })
          }} className="px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
            <option value="全部">全部人工复核状态</option>
            <option value="已复核">仅看已复核</option>
            <option value="待复核">仅看待复核</option>
          </select>
          <select aria-label="按签发状态筛选" value={signOffFilter} onChange={e => {
            const value = e.target.value
            setSignOffFilter(value)
            syncSearchParams(next => {
              if (value === '全部') next.delete('signOff')
              else next.set('signOff', value)
            })
          }} className="px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
            <option value="全部">全部签发状态</option>
            <option value="待签发">仅看待签发</option>
            <option value="已签发">仅看已签发</option>
          </select>
          <select aria-label="按归档状态筛选" value={archiveFilter} onChange={e => {
            const value = e.target.value
            setArchiveFilter(value)
            syncSearchParams(next => {
              if (value === '全部') next.delete('archive')
              else next.set('archive', value)
            })
          }} className="px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
            <option value="全部">全部归档状态</option>
            <option value="待归档">仅看待归档</option>
            <option value="已归档">仅看已归档</option>
          </select>
          <select aria-label="按提交人筛选" value={effectiveSubmitterFilter} onChange={e => {
            const value = e.target.value
            setSubmitterFilter(value)
            syncSearchParams(next => {
              if (value === '全部') next.delete('submitter')
              else next.set('submitter', value)
            })
          }} className="px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
            {submitterOptions.map(option => (
              <option key={option} value={option}>{option === '全部' ? '全部提交人' : option}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
          <select aria-label="按导出状态筛选" value={exportFilter} onChange={e => {
            const value = e.target.value
            setExportFilter(value)
            syncSearchParams(next => {
              if (value === '全部') next.delete('export')
              else next.set('export', value)
            })
          }} className="px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
            <option value="全部">全部导出状态</option>
            <option value="已导出">仅看已导出</option>
            <option value="未导出">仅看未导出</option>
            <option value="预览">最后一次为预览</option>
            <option value="Word">最后一次为 Word</option>
            <option value="PDF">最后一次为 PDF</option>
          </select>
          <select aria-label="按导出来源筛选" value={exportSourceFilter} onChange={e => {
            const value = e.target.value
            setExportSourceFilter(value)
            syncSearchParams(next => {
              if (value === '全部') next.delete('exportSource')
              else next.set('exportSource', value)
            })
          }} className="px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
            <option value="全部">全部导出来源</option>
            <option value="详情页">仅看详情页导出</option>
            <option value="提交结果">仅看提交结果导出</option>
            <option value="审核中心">仅看审核中心导出</option>
            <option value="未导出">仅看未导出</option>
          </select>
          <select aria-label="按附件解析状态筛选" value={attachmentFilter} onChange={e => {
            const value = e.target.value
            setAttachmentFilter(value)
            syncSearchParams(next => {
              if (value === '全部') next.delete('attachment')
              else next.set('attachment', value)
            })
          }} className="px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
            <option value="全部">全部附件解析</option>
            <option value="有附件">仅看有附件</option>
            <option value="无附件">仅看无附件</option>
            <option value="已解析附件">仅看已解析附件</option>
            <option value="附件异常">仅看附件异常</option>
            <option value="历史元数据">仅看历史元数据</option>
            <option value="PDF表格">仅看 PDF 表格</option>
          </select>
          <select aria-label="按 AI 审核状态筛选" value={aiFilter} onChange={e => {
            const value = e.target.value
            setAiFilter(value)
            syncSearchParams(next => {
              if (value === '全部') next.delete('ai')
              else next.set('ai', value)
            })
          }} className="px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
            <option value="全部">全部 AI 状态</option>
            <option value="AI成功">仅看 AI 成功</option>
            <option value="待人工复核">仅看待人工复核</option>
            <option value="AI回退">仅看 AI 回退</option>
            <option value="AI失败">仅看 AI 失败</option>
            <option value="无AI记录">仅看无 AI 记录</option>
          </select>
          <select aria-label="选择审核列表排序方式" value={sortMode} onChange={e => {
            const value = e.target.value
            setSortMode(value)
            syncSearchParams(next => {
              if (value === '默认排序') next.delete('sort')
              else next.set('sort', value)
            })
          }} className="px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
            <option value="默认排序">默认排序</option>
            <option value="最近导出优先">最近导出优先</option>
            <option value="导出次数优先">导出次数优先</option>
            <option value="最新提交优先">最新提交优先</option>
          </select>
        </div>

        <div className="rounded-lg border border-blue-500/20 bg-slate-950/45 px-3 py-3 mb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="inline-flex items-center gap-2 text-sm text-slate-300" htmlFor={allFilteredSelectId}>
              <input
                id={allFilteredSelectId}
                type="checkbox"
                checked={allFilteredSelected}
                onChange={toggleAllFiltered}
                title={`${allFilteredSelected ? '取消选择' : '选择'}当前筛选结果 ${sortedFiltered.length} 个方案`}
                aria-label={`${allFilteredSelected ? '取消选择' : '选择'}当前筛选结果 ${sortedFiltered.length} 个方案，筛选条件：${currentFilterSummary}`}
                className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-blue-500"
              />
              当前筛选结果全选
            </label>
            <div className="text-xs text-slate-400">
              已选 {selectedIds.length} 个，已通过 {selectedPassedCount} 个，高风险 {selectedHighRiskCount} 项
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <FilterChip label="系统草稿（未发送）" count={filteredReminderStats.auto} className="border-violet-400/20 bg-violet-500/10 text-violet-200" active={reminderSourceFilter === '自动催办'} onClick={() => toggleSearchParam('source', '自动催办', reminderSourceFilter === '自动催办')} />
            <FilterChip label="人工登记" count={filteredReminderStats.manual} className="border-slate-500/20 bg-slate-500/10 text-slate-300" active={reminderSourceFilter === '人工登记'} onClick={() => toggleSearchParam('source', '人工登记', reminderSourceFilter === '人工登记')} />
            <FilterChip label="未催办" count={filteredReminderStats.none} className="border-blue-400/20 bg-blue-500/10 text-blue-200" active={reminderSourceFilter === '未催办'} onClick={() => toggleSearchParam('source', '未催办', reminderSourceFilter === '未催办')} />
            <FilterChip label="建议催办" count={filteredReminderStats.needReminder} className="border-amber-400/20 bg-amber-500/10 text-amber-200" active={needReminderOnly} onClick={() => toggleSearchParam('needReminder', '1', needReminderOnly)} />
            <FilterChip label="已导出" count={filteredExportStats.exported} className="border-emerald-400/20 bg-emerald-500/10 text-emerald-200" active={exportFilter === '已导出'} onClick={() => toggleSearchParam('export', '已导出', exportFilter === '已导出')} />
            <FilterChip label="未导出" count={filteredExportStats.notExported} className="border-slate-500/20 bg-slate-500/10 text-slate-300" active={exportFilter === '未导出'} onClick={() => toggleSearchParam('export', '未导出', exportFilter === '未导出')} />
            <FilterChip label="预览" count={filteredExportStats.preview} className="border-cyan-400/20 bg-cyan-500/10 text-cyan-200" active={exportFilter === '预览'} onClick={() => toggleSearchParam('export', '预览', exportFilter === '预览')} />
            <FilterChip label="Word" count={filteredExportStats.word} className="border-blue-400/20 bg-blue-500/10 text-blue-200" active={exportFilter === 'Word'} onClick={() => toggleSearchParam('export', 'Word', exportFilter === 'Word')} />
            <FilterChip label="PDF" count={filteredExportStats.pdf} className="border-violet-400/20 bg-violet-500/10 text-violet-200" active={exportFilter === 'PDF'} onClick={() => toggleSearchParam('export', 'PDF', exportFilter === 'PDF')} />
            <FilterChip label="已解析附件" count={filteredAttachmentStats.parsed} className="border-emerald-400/20 bg-emerald-500/10 text-emerald-200" active={attachmentFilter === '已解析附件'} onClick={() => toggleSearchParam('attachment', '已解析附件', attachmentFilter === '已解析附件')} />
            <FilterChip label="附件异常" count={filteredAttachmentStats.issue} className="border-amber-400/20 bg-amber-500/10 text-amber-200" active={attachmentFilter === '附件异常'} onClick={() => toggleSearchParam('attachment', '附件异常', attachmentFilter === '附件异常')} />
            <FilterChip label="PDF表格" count={filteredAttachmentStats.pdfTable} className="border-cyan-400/20 bg-cyan-500/10 text-cyan-200" active={attachmentFilter === 'PDF表格'} onClick={() => toggleSearchParam('attachment', 'PDF表格', attachmentFilter === 'PDF表格')} />
            {[
              ['AI成功', filteredAiStats.success, 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200'],
              ['待人工复核', filteredAiStats.manual, 'border-cyan-400/20 bg-cyan-500/10 text-cyan-200'],
              ['AI回退', filteredAiStats.fallback, 'border-amber-400/20 bg-amber-500/10 text-amber-200'],
              ['AI失败', filteredAiStats.failed, 'border-rose-400/20 bg-rose-500/10 text-rose-200'],
              ['无AI记录', filteredAiStats.none, 'border-slate-500/20 bg-slate-500/10 text-slate-300']
            ].map(([label, count, className]) => (
              <FilterChip
                key={label}
                label={label}
                count={count}
                className={className}
                active={aiFilter === label}
                onClick={() => toggleSearchParam('ai', label, aiFilter === label)}
              />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {canReview && (
              <>
                <button
                  type="button"
                  onClick={() => bulkUpdateStatus('待修改')}
                  disabled={actingBulk || selectedIds.length === 0 || selectedConfigurationPendingCount > 0}
                  title={selectedConfigurationPendingCount > 0 ? '所选方案包含待专业配置草稿，请先发起 AI 审核' : bulkActionLabel('批量退回修改', '批量更新方案状态')}
                  aria-label={selectedConfigurationPendingCount > 0 ? '批量退回修改暂不可用：所选方案包含待专业配置草稿' : bulkActionLabel('批量退回修改', '批量更新方案状态')}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-400/40 bg-amber-500/15 text-amber-100 text-sm disabled:opacity-50"
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  批量退回修改
                </button>
                <button
                  type="button"
                  onClick={bulkAutoCreateReminders}
                  disabled={actingBulk || selectedIds.length === 0}
                  title={bulkActionLabel('批量生成未发送催办草稿', '批量生成催办')}
                  aria-label={bulkActionLabel('批量生成未发送催办草稿', '批量生成催办')}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-violet-400/40 bg-violet-500/15 text-violet-100 text-sm disabled:opacity-50"
                >
                  <BellRing size={15} aria-hidden="true" />
                  生成催办草稿
                </button>
                <button
                  type="button"
                  onClick={bulkRerunAiReview}
                  disabled={actingBulk || selectedIds.length === 0 || selectedIds.length > 2}
                  title={selectedIds.length > 2 ? '单次最多选择 2 个方案，请减少选择数量' : bulkActionLabel('批量 AI 重审', '批量重新审核')}
                  aria-label={selectedIds.length > 2 ? '批量 AI 重审暂不可用：单次最多选择 2 个方案' : bulkActionLabel('批量 AI 重审', '批量重新审核')}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-cyan-400/40 bg-cyan-500/15 text-cyan-100 text-sm disabled:opacity-50"
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  批量 AI 重审
                </button>
              </>
            )}
            <button
              type="button"
              onClick={bulkExportWord}
              onFocus={preloadReportTools}
              onMouseEnter={preloadReportTools}
              disabled={actingBulk || bulkExporting || selectedIds.length === 0 || selectedConfigurationPendingCount > 0}
              title={selectedConfigurationPendingCount > 0 ? '所选草稿尚未生成审核意见，不能导出意见书' : bulkActionLabel('批量导出 Word', '批量导出Word')}
              aria-label={selectedConfigurationPendingCount > 0 ? '批量导出 Word 暂不可用：所选草稿尚未生成审核意见' : bulkActionLabel('批量导出 Word', '批量导出Word')}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-400/40 bg-emerald-500/15 text-emerald-100 text-sm disabled:opacity-50"
            >
              <Download size={15} aria-hidden="true" />
              {bulkExporting ? '批量导出中' : '批量导出 Word'}
            </button>
            {canManageSystem && (
              <button
                type="button"
                onClick={bulkDelete}
                disabled={actingBulk || selectedIds.length === 0}
                title={bulkActionLabel('批量删除', `删除${selectedIds.length}个方案`)}
                aria-label={bulkActionLabel('批量删除', `删除${selectedIds.length}个方案`)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-400/40 bg-red-500/15 text-red-100 text-sm disabled:opacity-50"
              >
                <Trash2 size={15} aria-hidden="true" />
                批量删除
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-4">
          <button
            type="button"
            onClick={() => {
              setManualReviewFilter('待复核')
              syncSearchParams(next => {
                next.set('manualReview', '待复核')
              })
            }}
            className="rounded-lg border border-amber-500/20 bg-slate-900/60 p-4 text-left hover:border-amber-300/35 transition"
          >
            <div className="text-xs text-slate-500">待人工复核</div>
            <div className="mt-2 text-2xl font-bold text-amber-200">{filteredExecutionStats.pendingManualReview}</div>
          </button>
          <button
            type="button"
            onClick={() => {
              setManualReviewFilter('已复核')
              syncSearchParams(next => {
                next.set('manualReview', '已复核')
              })
            }}
            className="rounded-lg border border-emerald-500/20 bg-slate-900/60 p-4 text-left hover:border-emerald-300/35 transition"
          >
            <div className="text-xs text-slate-500">已人工复核</div>
            <div className="mt-2 text-2xl font-bold text-emerald-200">{filteredExecutionStats.reviewed}</div>
          </button>
          <button
            type="button"
            onClick={activateReviewedPendingSignOffQueue}
            className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4 text-left hover:border-blue-300/35 transition"
          >
            <div className="text-xs text-slate-500">待签发</div>
            <div className="mt-2 text-2xl font-bold text-blue-200">{filteredExecutionStats.pendingSignOff}</div>
          </button>
          <button
            type="button"
            onClick={activateSignedPendingArchiveQueue}
            className="rounded-lg border border-cyan-500/20 bg-slate-900/60 p-4 text-left hover:border-cyan-300/35 transition"
          >
            <div className="text-xs text-slate-500">待归档</div>
            <div className="mt-2 text-2xl font-bold text-cyan-200">{filteredExecutionStats.pendingArchive}</div>
          </button>
          <button
            type="button"
            onClick={() => {
              setArchiveFilter('已归档')
              syncSearchParams(next => {
                next.set('archive', '已归档')
              })
            }}
            className="rounded-lg border border-violet-500/20 bg-slate-900/60 p-4 text-left hover:border-violet-300/35 transition"
          >
            <div className="text-xs text-slate-500">已归档</div>
            <div className="mt-2 text-2xl font-bold text-violet-200">{filteredExecutionStats.archived}</div>
          </button>
        </div>

        {canViewLogs && sortedFiltered.length > 0 && (
          <div className="mb-4 rounded-lg border border-cyan-400/20 bg-slate-950/45 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm text-slate-300">当前筛选结果执行留痕联查</div>
                <div className="mt-1 text-xs text-slate-500">
                  共 {sortedFiltered.length} 个方案，涉及 {filteredSubmitterCount || 0} 位提交人，待人工复核 {filteredExecutionStats.pendingManualReview} 个，建议催办 {filteredReminderStats.needReminder} 个。
                </div>
              </div>
              <button
                type="button"
                onClick={() => openFilteredLogs('全部')}
                className="text-xs text-cyan-300 hover:text-cyan-200"
              >
                打开当前结果全部执行日志
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <button
                type="button"
                onClick={() => openFilteredLogs('人工复核')}
                className="px-2 py-1 rounded border border-emerald-400/20 bg-emerald-500/10 text-emerald-200 hover:border-emerald-300/40"
              >
                人工复核
              </button>
              <button
                type="button"
                onClick={() => openFilteredLogs('签发归档')}
                className="px-2 py-1 rounded border border-blue-400/20 bg-blue-500/10 text-blue-200 hover:border-blue-300/40"
              >
                签发归档
              </button>
              <button
                type="button"
                onClick={() => openFilteredLogs('催办')}
                className="px-2 py-1 rounded border border-violet-400/20 bg-violet-500/10 text-violet-200 hover:border-violet-300/40"
              >
                催办
              </button>
              <button
                type="button"
                onClick={() => openFilteredLogs('导出')}
                className="px-2 py-1 rounded border border-cyan-400/20 bg-cyan-500/10 text-cyan-200 hover:border-cyan-300/40"
              >
                导出
              </button>
            </div>
          </div>
        )}

        {canViewLogs && (
          <div className="mb-4 rounded-lg border border-blue-500/20 bg-slate-950/45 px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-slate-300">执行日志快捷查看</div>
              <button
                type="button"
                onClick={() => openExecutionLogs()}
                className="text-xs text-blue-300 hover:text-blue-200"
              >
                打开全部执行日志
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <button
                type="button"
                onClick={() => openExecutionLogs('人工复核')}
                className="px-2 py-1 rounded border border-emerald-400/20 bg-emerald-500/10 text-emerald-200 hover:border-emerald-300/40"
              >
                人工复核日志
              </button>
              <button
                type="button"
                onClick={() => openExecutionLogs('签发归档')}
                className="px-2 py-1 rounded border border-blue-400/20 bg-blue-500/10 text-blue-200 hover:border-blue-300/40"
              >
                签发归档日志
              </button>
              <button
                type="button"
                onClick={() => openExecutionLogs('催办')}
                className="px-2 py-1 rounded border border-violet-400/20 bg-violet-500/10 text-violet-200 hover:border-violet-300/40"
              >
                催办日志
              </button>
              <button
                type="button"
                onClick={() => openExecutionLogs('导出')}
                className="px-2 py-1 rounded border border-cyan-400/20 bg-cyan-500/10 text-cyan-200 hover:border-cyan-300/40"
              >
                导出日志
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 text-slate-400">加载中...</div>
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-10 text-center">
            <div className="text-sm font-medium text-slate-300">当前条件下暂无方案</div>
            <div className="mt-2 text-xs text-slate-500">
              可以清除筛选返回全部审核队列，或提交一条新方案验证完整审核流程。
            </div>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={resetQueueMode}
                className="rounded-lg border border-blue-400/30 bg-blue-500/10 px-3 py-2 text-sm text-blue-100 hover:border-blue-300/60"
              >
                清除筛选
              </button>
              <button
                type="button"
                onClick={() => navigate('/submit')}
                className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100 hover:border-emerald-300/60"
              >
                提交新方案
              </button>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table
              className="w-full text-sm"
              aria-label={`方案审核列表，当前显示 ${sortedFiltered.length} 个方案，已选择 ${selectedIds.length} 个方案`}
            >
              <caption className="sr-only">
                方案审核列表。当前显示 {sortedFiltered.length} 个方案，已选择 {selectedIds.length} 个方案。第一列复选框用于选择方案并执行批量操作。
              </caption>
              <thead className="text-slate-400 bg-slate-900/70">
                <tr>
                  <th className="text-left py-2 px-3 font-medium">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleAllFiltered}
                      className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-blue-500"
                      title={`${allFilteredSelected ? '取消选择' : '选择'}当前列表 ${sortedFiltered.length} 个方案`}
                      aria-label={`${allFilteredSelected ? '取消选择' : '选择'}当前列表 ${sortedFiltered.length} 个方案，筛选条件：${currentFilterSummary}`}
                    />
                  </th>
                  <th className="text-left py-2 px-3 font-medium">方案名称</th>
                  <th className="text-left py-2 px-3 font-medium">类型</th>
                  <th className="text-left py-2 px-3 font-medium">提交人</th>
                  <th className="text-left py-2 px-3 font-medium">审核机制</th>
                  <th className="text-left py-2 px-3 font-medium">当前状态</th>
                  <th className="text-left py-2 px-3 font-medium">人工复核</th>
                  <th className="text-left py-2 px-3 font-medium">签发</th>
                  <th className="text-left py-2 px-3 font-medium">归档</th>
                  <th className="text-left py-2 px-3 font-medium">附件</th>
                  <th className="text-left py-2 px-3 font-medium">导出</th>
                  <th className="text-left py-2 px-3 font-medium">AI调用</th>
                  <th className="text-left py-2 px-3 font-medium">最近催办</th>
                  <th className="text-left py-2 px-3 font-medium">综合评分</th>
                  <th className="text-left py-2 px-3 font-medium">高风险</th>
                  <th className="text-left py-2 px-3 font-medium">提交时间</th>
                  <th className="text-left py-2 px-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {sortedFiltered.map(item => (
                  <tr key={item.id} className="border-b border-blue-500/10 hover:bg-blue-500/5">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(item.id)}
                        onChange={() => toggleItem(item.id)}
                        className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-blue-500"
                        aria-label={`${selectedIds.includes(item.id) ? '取消选择' : '选择'}方案《${item.title || '未命名方案'}》，提交人 ${item.submitter || '未记录'}，状态 ${item.status || '未知'}，高风险 ${item.highRiskCount || 0} 项`}
                      />
                    </td>
                    <td className="px-3 py-2 min-w-[220px]">{item.title}</td>
                    <td className="px-3 py-2"><TypeBadge text={item.type} /></td>
                    <td className="px-3 py-2">{item.submitter}</td>
                    <td className="px-3 py-2 min-w-[160px]">{item.robot}</td>
                    <td className="px-3 py-2"><StatusBadge s={item.status} /></td>
                    <td className="px-3 py-2">
                      <div className="space-y-1 min-w-[112px]">
                        {isConfigurationPending(item)
                          ? <span className="px-2 py-1 rounded text-xs border border-amber-400/30 bg-amber-500/10 text-amber-200">待 AI 审核</span>
                          : <ManualReviewBadge item={item} />}
                        {item.manualReviewConclusion && (
                          <div className="text-xs text-slate-500 truncate" title={item.manualReviewConclusion}>
                            {item.manualReviewConclusion}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2"><FlowBadge text={isConfigurationPending(item) ? '未开放' : (item.signOffStatus || '待签发')} /></td>
                    <td className="px-3 py-2"><FlowBadge text={isConfigurationPending(item) ? '未开放' : (item.archiveStatus || '待归档')} doneTone="cyan" /></td>
                    <td className="px-3 py-2 min-w-[150px]">
                      {(item.attachmentSummary?.total || item.fileCount || 0) > 0 ? (
                        <div className="space-y-1">
                          <span className="px-2 py-1 rounded text-xs border border-blue-400/30 bg-blue-500/10 text-blue-200">
                            {item.attachmentSummary?.parsed || 0}/{item.attachmentSummary?.total || item.fileCount || 0} 已解析
                          </span>
                          {((item.attachmentSummary?.failed || 0) + (item.attachmentSummary?.unsupported || 0) + (item.attachmentSummary?.pending || 0)) > 0 && (
                            <div className="text-[11px] text-amber-300">
                              异常 {(item.attachmentSummary?.failed || 0) + (item.attachmentSummary?.unsupported || 0) + (item.attachmentSummary?.pending || 0)}
                            </div>
                          )}
                          {(item.attachmentSummary?.historical || 0) > 0 && (
                            <div className="text-[11px] text-slate-500">历史元数据 {item.attachmentSummary.historical}</div>
                          )}
                          {(item.attachmentSummary?.pdfTableCount || 0) > 0 && (
                            <div className="text-[11px] text-cyan-300">PDF表格 {item.attachmentSummary.pdfTableCount}</div>
                          )}
                        </div>
                      ) : (
                        <span className="px-2 py-1 rounded text-xs border border-slate-500/30 bg-slate-500/10 text-slate-300">
                          无附件
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 min-w-[150px]">
                      {(item.exportCount || 0) > 0 ? (
                        <div className="space-y-1">
                          <span className="px-2 py-1 rounded text-xs border border-emerald-400/30 bg-emerald-500/10 text-emerald-200">
                            {exportTypeText(item.lastExportType)} · {item.exportCount} 次
                          </span>
                          <div className="text-[11px] text-slate-400">
                            {item.lastExportSource === 'detail' ? '详情页' : item.lastExportSource === 'submit' ? '提交结果' : item.lastExportSource === 'review' ? '审核中心' : '未记录来源'}
                          </div>
                          <div className="text-[11px] text-slate-500 whitespace-nowrap">{item.lastExportAt || '-'}</div>
                        </div>
                      ) : (
                        <span className="px-2 py-1 rounded text-xs border border-slate-500/30 bg-slate-500/10 text-slate-300">
                          未导出
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 min-w-[170px]">
                      {item.latestAiTrace ? (
                        <div className="space-y-1">
                          <span className={`px-2 py-1 rounded text-xs border ${aiTraceToneClass(item.latestAiTrace)}`}>
                            {aiTraceLabel(item.latestAiTrace)}
                          </span>
                          <div className="text-[11px] text-slate-400">
                            {item.latestAiTrace.provider || '-'} · {aiModeText(item.latestAiTrace.mode)} · {item.latestAiTrace.durationMs || 0}ms
                          </div>
                          <div className="text-[11px] text-slate-500 whitespace-nowrap">
                            Profile {item.latestAiTrace.profileCount || 0} · 意见 {item.latestAiTrace.opinionCount || 0}
                          </div>
                        </div>
                      ) : (
                        <span className="px-2 py-1 rounded text-xs border border-slate-500/30 bg-slate-500/10 text-slate-300">
                          无记录
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 min-w-[210px]">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <ReminderBadge item={item} />
                          {item.needsReminder && (
                            <span className="text-[11px] text-amber-200">建议催办：{item.recommendedReminderStage}</span>
                          )}
                        </div>
                        <OverdueBadge item={item} />
                        {item.lastReminderAt ? (
                          <>
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-xs text-slate-300">
                                {item.lastReminderBy || '系统'} · {item.lastReminderChannel || '企业微信'}
                              </div>
                              <ReminderSourceBadge source={item.lastReminderSource} />
                            </div>
                            <div className="text-[11px] text-slate-500 whitespace-nowrap">{item.lastReminderAt}</div>
                          </>
                        ) : (
                          <div className="text-[11px] text-slate-500">暂无催办记录</div>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-cyan-200">{item.avgScore == null ? '暂无评分' : item.avgScore}</td>
                    <td className="px-3 py-2 text-amber-200">{item.highRiskCount || 0}</td>
                    <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{item.createdAt}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-3 min-w-[250px]">
                        <button
                          type="button"
                          onClick={() => navigate(`/review/${item.id}`)}
                          onFocus={() => preloadRoute('/review/:id')}
                          onMouseEnter={() => preloadRoute('/review/:id')}
                          aria-label={`查看方案《${item.title || '未命名方案'}》审核详情`}
                          className="text-blue-300 hover:text-blue-200 text-sm"
                        >
                          查看 ›
                        </button>
                        {(item.exportCount || 0) > 0 && (
                          <button
                            type="button"
                            onClick={() => navigate(`/review/${item.id}?section=exports`)}
                            onFocus={() => preloadRoute('/review/:id')}
                            onMouseEnter={() => preloadRoute('/review/:id')}
                            aria-label={`查看方案《${item.title || '未命名方案'}》的导出留痕，共 ${item.exportCount || 0} 次`}
                            className="text-emerald-300 hover:text-emerald-200 text-sm"
                          >
                            导出留痕
                          </button>
                        )}
                        <button type="button" onClick={() => copyReminderScript(item)} aria-label={`复制方案《${item.title || '未命名方案'}》的催办话术`} className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200 text-sm">
                          <Copy size={14} aria-hidden="true" />
                          复制催办
                        </button>
                        {canReview && (
                          <>
                            <button
                              type="button"
                              onClick={() => autoCreateReminder(item)}
                              disabled={savingReminderId === item.id}
                              aria-label={`${savingReminderId === item.id ? '正在生成' : '生成'}方案《${item.title || '未命名方案'}》的未发送催办草稿`}
                              className="inline-flex items-center gap-1 text-violet-300 hover:text-violet-200 text-sm disabled:opacity-50"
                            >
                              <BellRing size={14} aria-hidden="true" />
                              {savingReminderId === item.id ? '生成中' : '催办草稿'}
                            </button>
                            <button type="button" onClick={() => openReminder(item)} aria-label={`登记方案《${item.title || '未命名方案'}》的催办记录`} className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200 text-sm">
                              <BellRing size={14} aria-hidden="true" />
                              登记催办
                            </button>
                            {item.status !== '待修改' && !isConfigurationPending(item) && (
                              <button type="button" onClick={() => updateStatus(item, '待修改')} aria-label={`将方案《${item.title || '未命名方案'}》退回修改`} className="inline-flex items-center gap-1 text-amber-300 hover:text-amber-200 text-sm">
                                <RotateCcw size={14} aria-hidden="true" />
                                退回
                              </button>
                            )}
                          </>
                        )}
                        {canManageSystem && (
                          <button type="button" onClick={() => deleteProposal(item)} title="需要输入“删除方案”后才会执行" aria-label={`删除方案《${item.title || '未命名方案'}》，需要二次确认`} className="inline-flex items-center gap-1 text-red-300 hover:text-red-200 text-sm">
                            <Trash2 size={14} aria-hidden="true" />
                            删除
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {reminderDraft && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm p-4 lg:p-6"
          onMouseDown={event => {
            if (event.target === event.currentTarget) closeReminder()
          }}
        >
          <div
            ref={reminderDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={reminderDialogTitleId}
            aria-describedby={reminderDialogDescId}
            onMouseDown={event => event.stopPropagation()}
            className="mx-auto max-w-2xl rounded-2xl border border-blue-500/20 bg-slate-950/95 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4 border-b border-blue-500/10 px-5 py-4">
              <div>
                <h2 id={reminderDialogTitleId} className="text-lg font-semibold text-blue-100">登记催办</h2>
                <p id={reminderDialogDescId} className="mt-1 text-sm text-slate-400">{reminderDraft.title}</p>
              </div>
              <button
                type="button"
                onClick={closeReminder}
                className="rounded-lg border border-slate-700 p-2 text-slate-400 hover:text-white"
                aria-label="关闭催办弹层"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="space-y-2" htmlFor={reminderStageId}>
                  <div className="text-sm text-slate-300">催办阶段</div>
                  <select
                    id={reminderStageId}
                    value={reminderDraft.recommendedReminderStage}
                    onChange={e => setReminderDraft(prev => ({ ...prev, recommendedReminderStage: e.target.value }))}
                    aria-label={`催办阶段，当前方案《${reminderDraft.title || '未命名方案'}》`}
                    className="w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
                  >
                    {['人工复核', '高风险复核', '补充修改', '签发', '归档', '进度确认'].map(option => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </label>

                <label className="space-y-2" htmlFor={reminderChannelId}>
                  <div className="text-sm text-slate-300">催办渠道</div>
                  <select
                    id={reminderChannelId}
                    value={reminderDraft.channel}
                    onChange={e => setReminderDraft(prev => ({ ...prev, channel: e.target.value }))}
                    aria-label={`催办渠道，当前方案《${reminderDraft.title || '未命名方案'}》`}
                    className="w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
                  >
                    {reminderChannels.map(option => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block space-y-2" htmlFor={reminderNoteId}>
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm text-slate-300">催办记录</div>
                  <button
                    type="button"
                    onClick={() => setReminderDraft(prev => {
                      const currentItem = items.find(item => item.id === prev.id) || { title: prev.title }
                      return {
                        ...prev,
                        note: formatReminderScript(currentItem, prev.recommendedReminderStage)
                      }
                    })}
                    aria-label={`将方案《${reminderDraft.title || '未命名方案'}》的催办记录重置为推荐话术`}
                    className="text-xs text-cyan-300 hover:text-cyan-200"
                  >
                    重置为推荐话术
                  </button>
                </div>
                <textarea
                  id={reminderNoteId}
                  rows={6}
                  value={reminderDraft.note}
                  onChange={e => setReminderDraft(prev => ({ ...prev, note: e.target.value }))}
                  aria-label={`催办记录，当前方案《${reminderDraft.title || '未命名方案'}》`}
                  className="w-full rounded-xl border border-blue-500/20 bg-slate-900/75 px-3 py-3 text-sm text-white outline-none focus:border-blue-400/60"
                  placeholder="记录本次催办的沟通内容、反馈人和下一步承诺。"
                />
              </label>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-blue-500/10 px-5 py-4">
              <button
                type="button"
                onClick={closeReminder}
                disabled={Boolean(savingReminderId)}
                className="px-4 py-2 rounded-lg border border-slate-600 text-slate-300 text-sm disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submitReminder}
                disabled={Boolean(savingReminderId)}
                aria-label={`${savingReminderId ? '正在保存' : '确认登记'}方案《${reminderDraft.title || '未命名方案'}》的催办记录`}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-cyan-400/40 bg-cyan-500/15 text-cyan-100 text-sm disabled:opacity-50"
              >
                <BellRing size={15} aria-hidden="true" />
                {savingReminderId ? '保存中...' : '确认登记'}
              </button>
            </div>
          </div>
        </div>
      )}

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
