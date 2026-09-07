import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, BellRing, Bot, BookOpenText, BookText, CheckCircle2, ClipboardCheck, Clock3, Download, Eye, FileText, ListChecks, MessageSquareText, RefreshCcw, RotateCcw, ShieldAlert, X, TrendingUp } from '../lib/lucide.js'
import { api, downloadFile, getUser } from '../lib/api'
import { appBuildLabel, appBuildTime, appVersion } from '../lib/appVersion'
import { hasPermission } from '../lib/permissions'
import { requestNotificationRefresh } from '../lib/notifications'
import { loadReportTools, preloadReportTools } from '../lib/reportPreload'
import Panel from '../components/Panel'
import firstServiceLogo from '../assets/brand/first-service-logo-2026-transparent.png'

const riskClass = {
  低: 'text-emerald-300 bg-emerald-500/10 border-emerald-400/30',
  中: 'text-amber-300 bg-amber-500/10 border-amber-400/30',
  高: 'text-red-300 bg-red-500/10 border-red-400/30'
}

const manualReviewTemplates = [
  {
    key: 'pass',
    label: '建议通过',
    conclusion: '建议通过',
    basis: [],
    actions: [],
    summary: ''
  },
  {
    key: 'conditional',
    label: '补充后通过',
    conclusion: '补充后通过',
    basis: [],
    actions: [],
    summary: ''
  },
  {
    key: 'revision',
    label: '退回修改',
    conclusion: '退回修改',
    basis: [],
    actions: [],
    summary: ''
  }
]

const reminderStageOptions = ['人工复核', '高风险复核', '补充修改', '签发', '归档', '进度确认']
const reminderChannelOptions = ['企业微信', '电话', '邮件', '当面沟通']
const reminderSourceTextMap = {
  manual: '人工登记',
  auto: '系统草稿（未发送）'
}

const exportTypeTextMap = {
  preview: '预览',
  word: 'Word',
  pdf: 'PDF'
}

const exportTypeFilterOptions = ['全部', '预览', 'Word', 'PDF']
const exportSourceFilterOptions = ['全部', '详情页', '提交结果', '审核中心']

const extractionTypeTextMap = {
  pdf: 'PDF 文本',
  'pdf-table': 'PDF 表格增强',
  docx: 'DOCX',
  doc: '旧版 DOC',
  excel: 'Excel 表格',
  table: '文本表格',
  text: '纯文本',
  unknown: '未知类型',
  error: '解析异常'
}

function splitTextLines(value = '') {
  return String(value || '')
    .split(/\n+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function joinTextLines(items = []) {
  return Array.isArray(items) ? items.join('\n') : ''
}

function reminderSourceText(source = '') {
  return reminderSourceTextMap[source] || '人工登记'
}

function exportTypeText(type = '') {
  return exportTypeTextMap[String(type || '').trim().toLowerCase()] || 'Word'
}

function aiModeText(mode = '') {
  if (mode === 'hermes-agent') return 'Hermes Agent'
  if (mode === 'external') return '外部 AI'
  if (mode === 'fallback-local') return '本地兜底'
  if (mode === 'local') return '本地规则'
  return '未记录模式'
}

function aiTraceLabel(trace = {}) {
  if (trace.fallback === true || trace.status === 'fallback') return '已回退'
  if (trace.status === 'failed') return '失败'
  if (trace.status === 'success') return '成功'
  return '待人工复核'
}

function aiTraceToneClass(trace = {}) {
  if (trace.fallback === true || trace.status === 'fallback') return 'border-amber-400/25 bg-amber-500/10'
  if (trace.status === 'failed') return 'border-rose-400/25 bg-rose-500/10'
  if (trace.status === 'success') return 'border-emerald-400/20 bg-slate-900/60'
  return 'border-cyan-400/25 bg-cyan-500/10'
}

function aiTraceBadgeClass(trace = {}) {
  if (trace.fallback === true || trace.status === 'fallback') return 'border-amber-400/30 text-amber-200 bg-amber-500/10'
  if (trace.status === 'failed') return 'border-rose-400/30 text-rose-200 bg-rose-500/10'
  if (trace.status === 'success') return 'border-emerald-400/30 text-emerald-200 bg-emerald-500/10'
  return 'border-cyan-400/30 text-cyan-200 bg-cyan-500/10'
}

export default function ProposalDetailView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [item, setItem] = useState(null)
  const [loading, setLoading] = useState(true)
  const [rerunning, setRerunning] = useState(false)
  const [updatingStatus, setUpdatingStatus] = useState(false)
  const [downloadingId, setDownloadingId] = useState('')
  const [note, setNote] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [savingManualReview, setSavingManualReview] = useState(false)
  const [error, setError] = useState('')
  const [exportingDoc, setExportingDoc] = useState(false)
  const [exportingPdf, setExportingPdf] = useState(false)
  const [previewingReport, setPreviewingReport] = useState(false)
  const [reportPreviewHtml, setReportPreviewHtml] = useState('')
  const [savingSignOff, setSavingSignOff] = useState(false)
  const [savingArchive, setSavingArchive] = useState(false)
  const [savingReminder, setSavingReminder] = useState(false)
  const [reviewReadiness, setReviewReadiness] = useState({
    ready: false,
    activeProfileCount: 0,
    message: '正在核验审核 Profile 配置。'
  })
  const [message, setMessage] = useState('')
  const [messageTarget, setMessageTarget] = useState('')
  const currentUser = useMemo(() => getUser(), [])
  const canReview = hasPermission(currentUser, 'reviewProposal')
  const canViewLogs = hasPermission(currentUser, 'viewLogs')
  const returnToReview = () => {
    if (window.history.length > 1) {
      navigate(-1)
      return
    }
    navigate('/review')
  }
  const [manualReviewForm, setManualReviewForm] = useState({
    conclusion: '',
    basisText: '',
    actionsText: '',
    summary: ''
  })
  const [executionForm, setExecutionForm] = useState({
    documentCode: '',
    signOffComment: '',
    archiveCode: '',
    archiveLocation: '',
    archiveComment: ''
  })
  const [reminderForm, setReminderForm] = useState({
    stage: '进度确认',
    channel: '企业微信',
    note: ''
  })
  const manualReviewSectionRef = useRef(null)
  const signOffSectionRef = useRef(null)
  const archiveSectionRef = useRef(null)
  const reminderSectionRef = useRef(null)
  const exportSectionRef = useRef(null)
  const exportTypeFilterId = useId()
  const exportSourceFilterId = useId()
  const manualConclusionInputId = useId()
  const manualBasisInputId = useId()
  const manualActionsInputId = useId()
  const manualSummaryInputId = useId()
  const signOffDocumentInputId = useId()
  const signOffCommentInputId = useId()
  const archiveCodeInputId = useId()
  const archiveLocationInputId = useId()
  const archiveCommentInputId = useId()
  const reminderStageInputId = useId()
  const reminderChannelInputId = useId()
  const reminderNoteInputId = useId()

  const sectionRefs = {
    manualReview: manualReviewSectionRef,
    signOff: signOffSectionRef,
    archive: archiveSectionRef,
    reminder: reminderSectionRef,
    exports: exportSectionRef
  }

  const scrollToSection = (sectionKey) => {
    const target = sectionRefs[sectionKey]?.current
    if (!target) return
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const requireTypedConfirm = (confirmText, description, cancelMessage) => {
    const typed = window.prompt(`${description}\n\n如确认继续，请输入：${confirmText}`) || ''
    if (typed.trim() === confirmText) return true
    setError(cancelMessage || `操作已取消：需输入“${confirmText}”才会执行。`)
    return false
  }

  const syncSearchParams = (updater) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      updater(next)
      Array.from(next.keys()).forEach(key => {
        if (!next.get(key)) next.delete(key)
      })
      return next
    })
  }

  const loadData = async () => {
    setLoading(true)
    setError('')
    setMessage('')
    setMessageTarget('')
    try {
      const data = await api.get(`/proposals/${id}`)
      setItem(data)
      try {
        const limits = await api.get('/upload-limits')
        setReviewReadiness({
          ready: limits.reviewReady === true && limits.submissionMode === 'ai-review',
          activeProfileCount: Number(limits.activeProfileCount || 0),
          message: limits.reviewReadinessMessage || '审核 Profile 尚未完成正式核验。'
        })
      } catch (readinessError) {
        setReviewReadiness({
          ready: false,
          activeProfileCount: 0,
          message: readinessError.message || '审核 Profile 就绪状态核验失败，请刷新后重试。'
        })
      }
      const manualReview = data.manualReview || {}
      setManualReviewForm({
        conclusion: manualReview.conclusion || '',
        basisText: joinTextLines(manualReview.basis || []),
        actionsText: joinTextLines(manualReview.actions || []),
        summary: manualReview.summary || ''
      })
      const executionRecord = data.executionRecord || {}
      setExecutionForm({
        documentCode: executionRecord.signOff?.documentCode || '',
        signOffComment: executionRecord.signOff?.comment || '',
        archiveCode: executionRecord.archive?.archiveCode || '',
        archiveLocation: executionRecord.archive?.location || '',
        archiveComment: executionRecord.archive?.comment || ''
      })
      setReminderForm({
        stage: data.summary?.riskCount?.high > 0 && !(data.manualReview?.conclusion || '').trim()
          ? '高风险复核'
          : (!data.manualReview?.conclusion ? '人工复核' : executionRecord.signOff?.status !== '已签发' ? '签发' : executionRecord.archive?.status !== '已归档' ? '归档' : '进度确认'),
        channel: data.reminders?.[0]?.channel || '企业微信',
        note: data.reminders?.[0]?.note || ''
      })
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [id])

  useEffect(() => {
    const section = searchParams.get('section') || ''
    if (!item || !sectionRefs[section]?.current) return
    requestAnimationFrame(() => scrollToSection(section))
  }, [item, searchParams])

  const rerunReview = async () => {
    if (!canReview) return setError('当前账号无权限重新发起 AI 审核')
    if (!reviewReadiness.ready) return setError(reviewReadiness.message || '审核 Profile 尚未完成正式核验，暂不能发起 AI 审核。')
    const confirmText = '重新发起AI审核'
    if (!requireTypedConfirm(confirmText, `即将对《${item?.title || '当前方案'}》重新发起 AI 审核，现有审核意见会按当前 Hermes Profile 重新生成。`, `重新审核已取消：需输入“${confirmText}”才会执行。`)) return
    setRerunning(true)
    setError('')
    setMessage('')
    setMessageTarget('')
    try {
      const data = await api.post(`/proposals/${id}/review`, { confirmText })
      setItem(data)
      setMessage('AI 审核已重新发起，页面内容已刷新。')
      requestNotificationRefresh()
    } catch (err) {
      setError(err.message || '重新审核失败')
    } finally {
      setRerunning(false)
    }
  }

  const updateStatus = async (status) => {
    if (!canReview) return setError('当前账号无权限流转方案状态')
    if (item?.status === '待专业配置' || !item?.summary) return setError('该方案尚未生成真实审核结果，请先完成 Profile 核验并发起 AI 审核。')
    const confirmText = '更新方案状态'
    if (!requireTypedConfirm(confirmText, `即将把《${item?.title || '当前方案'}》状态更新为「${status}」。`, `状态更新已取消：需输入“${confirmText}”才会执行。`)) return
    setUpdatingStatus(true)
    setError('')
    setMessage('')
    setMessageTarget('')
    try {
      const data = await api.patch(`/proposals/${id}/status`, { status, confirmText })
      setItem(data)
      setMessage(`方案状态已更新为${status}`)
      requestNotificationRefresh()
    } catch (err) {
      setError(err.message || '状态更新失败')
    } finally {
      setUpdatingStatus(false)
    }
  }

  const saveNote = async (e) => {
    e.preventDefault()
    if (!canReview) return setError('当前账号无权限新增复核备注')
    if (note.trim().length < 2) return setError('复核备注不能少于2个字')
    setSavingNote(true)
    setError('')
    setMessage('')
    setMessageTarget('')
    try {
      const data = await api.post(`/proposals/${id}/notes`, { content: note.trim() })
      setItem(data)
      setNote('')
      setMessage('人工复核备注已保存。')
    } catch (err) {
      setError(err.message || '备注保存失败')
    } finally {
      setSavingNote(false)
    }
  }

  const applyManualTemplate = (template) => {
    setManualReviewForm({
      conclusion: template.conclusion,
      basisText: joinTextLines(template.basis),
      actionsText: joinTextLines(template.actions),
      summary: template.summary
    })
  }

  const updateManualField = (field, value) => {
    setManualReviewForm(prev => ({ ...prev, [field]: value }))
  }

  const saveManualReview = async (e) => {
    e.preventDefault()
    if (!canReview) return setError('当前账号无权限提交人工复核结论')
    if (item?.status === '待专业配置' || !item?.summary) return setError('该方案尚未执行 AI 审核，不能填写人工复核结论。')
    const conclusion = manualReviewForm.conclusion.trim()
    const summary = manualReviewForm.summary.trim()
    const basis = splitTextLines(manualReviewForm.basisText)
    const actions = splitTextLines(manualReviewForm.actionsText)

    if (!conclusion) return setError('请先填写人工复核结论')
    if (basis.length === 0) return setError('请至少填写 1 条已核验的复核依据')
    if (actions.length === 0) return setError('请至少填写 1 条明确的后续动作')
    if (summary.length < 4) return setError('复核摘要不能少于4个字')
    const confirmText = '保存人工复核'
    if (!requireTypedConfirm(confirmText, `即将保存《${item?.title || '当前方案'}》的人工复核结论「${conclusion}」。`, `人工复核已取消：需输入“${confirmText}”才会执行。`)) return

    setSavingManualReview(true)
    setError('')
    setMessage('')
    setMessageTarget('')
    try {
      const data = await api.post(`/proposals/${id}/manual-review`, {
        conclusion,
        basis,
        actions,
        summary,
        confirmText
      })
      setItem(data)
      const nextReview = data.manualReview || {}
      setManualReviewForm({
        conclusion: nextReview.conclusion || '',
        basisText: joinTextLines(nextReview.basis || []),
        actionsText: joinTextLines(nextReview.actions || []),
        summary: nextReview.summary || ''
      })
      setMessage('人工复核已保存，可进入签发。')
      setMessageTarget('signOff')
      requestNotificationRefresh()
      requestAnimationFrame(() => scrollToSection('signOff'))
    } catch (err) {
      setError(err.message || '人工复核保存失败')
    } finally {
      setSavingManualReview(false)
    }
  }

  const downloadAttachment = async (file) => {
    setDownloadingId(file.id)
    setError('')
    try {
      await downloadFile(`/proposals/${item.id}/files/${file.id}`, file.name)
    } catch (err) {
      setError(err.message || '附件下载失败')
    } finally {
      setDownloadingId('')
    }
  }

  const exportOptions = {
    appVersion,
    logoUrl: firstServiceLogo
  }

  const recordExportEvent = async (type) => {
    const data = await api.post(`/proposals/${id}/export-events`, {
      type,
      appVersion,
      appBuildTime,
      appBuildLabel,
      source: 'detail'
    })
    if (data?.exportEvents) {
      setItem(prev => prev ? { ...prev, exportEvents: data.exportEvents, updatedAt: data.summary?.updatedAt || prev.updatedAt } : prev)
    }
  }

  const exportDoc = async () => {
    if (item?.status === '待专业配置' || !item?.summary) return setError('该方案尚未生成审核意见，不能导出 Word 意见书。')
    setExportingDoc(true)
    setError('')
    setMessage('')
    setMessageTarget('')
    try {
      const { downloadReviewReport } = await loadReportTools()
      await downloadReviewReport(item, exportOptions)
      await recordExportEvent('word')
      setMessage('Word 意见书已导出。')
    } catch (err) {
      setError(err.message || '意见书导出失败')
    } finally {
      setExportingDoc(false)
    }
  }

  const exportPdf = async () => {
    if (item?.status === '待专业配置' || !item?.summary) return setError('该方案尚未生成审核意见，不能导出 PDF。')
    setExportingPdf(true)
    setError('')
    setMessage('')
    setMessageTarget('')
    try {
      const { printReviewReportPdf } = await loadReportTools()
      await printReviewReportPdf(item, exportOptions)
      await recordExportEvent('pdf')
      setMessage('PDF 已开始导出。')
    } catch (err) {
      setError(err.message || 'PDF 导出失败')
    } finally {
      setExportingPdf(false)
    }
  }

  const openPreview = async () => {
    if (item?.status === '待专业配置' || !item?.summary) return setError('该方案尚未生成审核意见，不能预览意见书。')
    setPreviewingReport(true)
    setError('')
    setMessage('')
    setMessageTarget('')
    try {
      const { previewReviewReport } = await loadReportTools()
      const html = await previewReviewReport(item, exportOptions)
      setReportPreviewHtml(html)
      await recordExportEvent('preview')
    } catch (err) {
      setError(err.message || '意见书预览生成失败')
    } finally {
      setPreviewingReport(false)
    }
  }

  const closePreview = () => {
    setReportPreviewHtml('')
  }

  const updateExecutionField = (field, value) => {
    setExecutionForm(prev => ({ ...prev, [field]: value }))
  }

  const saveSignOff = async (e) => {
    e.preventDefault()
    if (!canReview) return setError('当前账号无权限登记签发信息')
    if (item?.status === '待专业配置' || !item?.summary) return setError('该方案尚未完成 AI 审核，不能进入签发。')
    const documentCode = executionForm.documentCode.trim()
    const comment = executionForm.signOffComment.trim()
    if (!documentCode) return setError('请先填写签发文号')
    const confirmText = '登记签发'
    if (!requireTypedConfirm(confirmText, `即将登记《${item?.title || '当前方案'}》签发信息，签发后方案会进入已通过状态。`, `签发登记已取消：需输入“${confirmText}”才会执行。`)) return

    setSavingSignOff(true)
    setError('')
    setMessage('')
    setMessageTarget('')
    try {
      const data = await api.post(`/proposals/${id}/sign-off`, { documentCode, comment, confirmText })
      setItem(data)
      const nextRecord = data.executionRecord || {}
      setExecutionForm(prev => ({
        ...prev,
        documentCode: nextRecord.signOff?.documentCode || documentCode,
        signOffComment: nextRecord.signOff?.comment || comment
      }))
      setMessage('签发已登记，可进入归档。')
      setMessageTarget('archive')
      requestNotificationRefresh()
      requestAnimationFrame(() => scrollToSection('archive'))
    } catch (err) {
      setError(err.message || '签发保存失败')
    } finally {
      setSavingSignOff(false)
    }
  }

  const saveArchive = async (e) => {
    e.preventDefault()
    if (!canReview) return setError('当前账号无权限登记归档信息')
    if (item?.status === '待专业配置' || !item?.summary) return setError('该方案尚未完成 AI 审核，不能进入归档。')
    const archiveCode = executionForm.archiveCode.trim()
    const location = executionForm.archiveLocation.trim()
    const comment = executionForm.archiveComment.trim()
    if (!archiveCode) return setError('请先填写归档编号')
    if (!location) return setError('请先填写归档位置')
    const confirmText = '登记归档'
    if (!requireTypedConfirm(confirmText, `即将登记《${item?.title || '当前方案'}》归档信息，执行链路将标记为完成。`, `归档登记已取消：需输入“${confirmText}”才会执行。`)) return

    setSavingArchive(true)
    setError('')
    setMessage('')
    setMessageTarget('')
    try {
      const data = await api.post(`/proposals/${id}/archive`, { archiveCode, location, comment, confirmText })
      setItem(data)
      const nextRecord = data.executionRecord || {}
      setExecutionForm(prev => ({
        ...prev,
        archiveCode: nextRecord.archive?.archiveCode || archiveCode,
        archiveLocation: nextRecord.archive?.location || location,
        archiveComment: nextRecord.archive?.comment || comment
      }))
      setMessage('归档已登记，执行链路已完成。')
      setMessageTarget('review')
      requestNotificationRefresh()
    } catch (err) {
      setError(err.message || '归档保存失败')
    } finally {
      setSavingArchive(false)
    }
  }

  const saveReminder = async (e) => {
    e.preventDefault()
    if (!canReview) return setError('当前账号无权限登记催办')
    const stage = reminderForm.stage.trim()
    const channel = reminderForm.channel.trim()
    const noteText = reminderForm.note.trim()

    if (!stage) return setError('请先选择催办阶段')
    if (!channel) return setError('请先选择催办渠道')
    if (noteText.length < 4) return setError('催办记录不能少于4个字')
    const confirmText = '登记催办'
    if (!requireTypedConfirm(confirmText, `即将为《${item?.title || '当前方案'}》登记「${stage}」催办记录。`, `催办登记已取消：需输入“${confirmText}”才会执行。`)) return

    setSavingReminder(true)
    setError('')
    setMessage('')
    setMessageTarget('')
    try {
      const data = await api.post(`/proposals/${id}/reminders`, {
        stage,
        channel,
        note: noteText,
        source: 'manual',
        confirmText
      })
      await loadData()
      setReminderForm(prev => ({
        ...prev,
        note: data.reminder?.note || noteText
      }))
      setMessage('催办记录已登记。')
      setMessageTarget('reminder')
      requestNotificationRefresh()
    } catch (err) {
      setError(err.message || '催办登记失败')
    } finally {
      setSavingReminder(false)
    }
  }

  if (loading) return <div className="flex items-center justify-center h-64 text-slate-400">加载中...</div>
  if (error && !item) return <Panel className="p-8 text-red-300">{error}</Panel>
  if (!item) return <Panel className="p-8 text-slate-400">方案不存在</Panel>

  const summary = item.summary || {}
  const configurationPending = item.status === '待专业配置' || !item.summary
  const reviewOutputAvailable = !configurationPending
  const opinions = item.opinions || []
  const summaryKnowledgeHits = summary.knowledgeHits || []
  const opinionSectionTitle = opinions.length > 0 ? `${opinions.length}专业审核意见` : '专业审核意见'
  const manualReview = item.manualReview || {}
  const executionRecord = item.executionRecord || {}
  const signOffRecord = executionRecord.signOff || {}
  const archiveRecord = executionRecord.archive || {}
  const reminders = item.reminders || []
  const exportEvents = item.exportEvents || []
  const exportTypeFilter = searchParams.get('exportType') || '全部'
  const exportSourceFilter = searchParams.get('exportSource') || '全部'
  const hasManualReview = Boolean(
    manualReview.conclusion ||
    manualReview.summary ||
    (manualReview.basis || []).length ||
    (manualReview.actions || []).length
  )
  const executionOverviewCards = [
    {
      key: 'manualReview',
      title: '人工复核',
      count: hasManualReview ? 1 : 0,
      status: configurationPending ? '待 AI 审核' : (manualReview.manualReviewStatus || (hasManualReview ? '已复核' : '待复核')),
      detail: hasManualReview
        ? `${manualReview.reviewer || '未记录'} · ${manualReview.reviewedAt || '未记录时间'}`
        : configurationPending ? '需先完成 Profile 核验并生成 AI 审核结果' : '尚未提交结构化人工复核结论',
      tone: hasManualReview ? 'emerald' : configurationPending ? 'amber' : 'slate',
      onClick: () => scrollToSection('manualReview')
    },
    {
      key: 'notes',
      title: '复核备注',
      count: (item.reviewNotes || []).length,
      status: (item.reviewNotes || []).length > 0 ? '已留痕' : '暂无备注',
      detail: (item.reviewNotes || [])[0]
        ? `${item.reviewNotes[0].actor || '未记录'} · ${item.reviewNotes[0].at || '未记录时间'}`
        : '可补充线下沟通、追记说明和临时决策',
      tone: (item.reviewNotes || []).length > 0 ? 'blue' : 'slate',
      onClick: () => scrollToSection('manualReview')
    },
    {
      key: 'signOff',
      title: '签发',
      count: signOffRecord.status === '已签发' ? 1 : 0,
      status: configurationPending ? '未开放' : (signOffRecord.status || '待签发'),
      detail: signOffRecord.status === '已签发'
        ? `${signOffRecord.signer || '未记录'} · ${signOffRecord.signedAt || '未记录时间'}`
        : configurationPending ? '需先生成真实审核结果并完成人工复核' : '待登记签发文号与签发说明',
      tone: signOffRecord.status === '已签发' ? 'emerald' : hasManualReview ? 'blue' : 'slate',
      onClick: () => scrollToSection('signOff')
    },
    {
      key: 'archive',
      title: '归档',
      count: archiveRecord.status === '已归档' ? 1 : 0,
      status: configurationPending ? '未开放' : (archiveRecord.status || '待归档'),
      detail: archiveRecord.status === '已归档'
        ? `${archiveRecord.archivist || '未记录'} · ${archiveRecord.archivedAt || '未记录时间'}`
        : configurationPending ? '需先完成审核与签发' : '待登记归档编号、位置和留档说明',
      tone: archiveRecord.status === '已归档' ? 'cyan' : signOffRecord.status === '已签发' ? 'blue' : 'slate',
      onClick: () => scrollToSection('archive')
    },
    {
      key: 'reminder',
      title: '催办',
      count: reminders.length,
      status: reminders.length > 0 ? `最近${reminders[0]?.stage || '进度确认'}` : '暂无催办',
      detail: reminders[0]
        ? `${reminders[0].remindedBy || '未记录'} · ${reminders[0].remindedAt || '未记录时间'}`
        : `建议阶段：${item.recommendedReminderStage || '进度确认'}`,
      tone: reminders.length > 0 ? 'violet' : item.needsReminder ? 'amber' : 'slate',
      onClick: () => scrollToSection('reminder')
    },
    {
      key: 'export',
      title: '意见书导出',
      count: exportEvents.length,
      status: exportEvents.length > 0 ? `最近${exportTypeText(exportEvents[0]?.type)}` : '未导出',
      detail: exportEvents[0]
        ? `${exportEvents[0].actor || '未记录'} · ${exportEvents[0].at || '未记录时间'}`
        : '支持预览、Word 与 PDF 导出留痕',
      tone: exportEvents.length > 0 ? 'cyan' : 'slate',
      onClick: () => scrollToSection('exports')
    }
  ]
  const executionOverviewToneClass = {
    emerald: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100',
    cyan: 'border-cyan-400/25 bg-cyan-500/10 text-cyan-100',
    blue: 'border-blue-400/25 bg-blue-500/10 text-blue-100',
    violet: 'border-violet-400/25 bg-violet-500/10 text-violet-100',
    amber: 'border-amber-400/25 bg-amber-500/10 text-amber-100',
    slate: 'border-slate-500/20 bg-slate-900/60 text-slate-200'
  }
  const exportSummary = (() => {
    const summary = {
      total: exportEvents.length,
      preview: 0,
      word: 0,
      pdf: 0,
      detail: 0,
      submit: 0,
      review: 0
    }
    const versionSet = new Set()

    exportEvents.forEach(event => {
      if (event.type === 'preview') summary.preview += 1
      else if (event.type === 'pdf') summary.pdf += 1
      else summary.word += 1

      if (event.source === 'submit') summary.submit += 1
      else if (event.source === 'review') summary.review += 1
      else summary.detail += 1

      if (event.appVersion) versionSet.add(event.appVersion)
    })

    return {
      ...summary,
      versions: Array.from(versionSet)
    }
  })()
  const filteredExportEvents = exportEvents.filter(event => {
    const matchType =
      exportTypeFilter === '全部' ||
      (exportTypeFilter === '预览' && event.type === 'preview') ||
      (exportTypeFilter === 'Word' && event.type === 'word') ||
      (exportTypeFilter === 'PDF' && event.type === 'pdf')
    const matchSource =
      exportSourceFilter === '全部' ||
      (exportSourceFilter === '详情页' && event.source === 'detail') ||
      (exportSourceFilter === '提交结果' && event.source === 'submit') ||
      (exportSourceFilter === '审核中心' && event.source === 'review')
    return matchType && matchSource
  })
  const nextActionCards = [
    {
      key: 'manualReview',
      title: '完成人工复核',
      description: configurationPending ? '需先完成 Profile 核验并发起 AI 审核，才能填写人工复核结论。' : '先补齐结构化人工复核结论，确认是否通过、补充后通过或退回修改。',
      done: hasManualReview,
      disabled: configurationPending,
      target: 'manualReview',
      tone: 'emerald'
    },
    {
      key: 'signOff',
      title: '登记签发',
      description: configurationPending ? '待 Profile 核验与 AI 审核完成后，再进入人工复核和签发。' : hasManualReview ? '人工复核已完成，可登记签发文号与签发说明。' : '需先完成人工复核，才能进入签发。',
      done: signOffRecord.status === '已签发',
      disabled: configurationPending || !hasManualReview,
      target: 'signOff',
      tone: 'blue'
    },
    {
      key: 'archive',
      title: '登记归档',
      description: configurationPending ? '待完成 AI 审核、人工复核与签发后，再登记归档。' : signOffRecord.status === '已签发' ? '签发已完成，可登记归档编号、位置与留档说明。' : '需先完成签发，才能进入归档。',
      done: archiveRecord.status === '已归档',
      disabled: configurationPending || signOffRecord.status !== '已签发',
      target: 'archive',
      tone: 'cyan'
    },
    {
      key: 'reminder',
      title: '跟进催办',
      description: item.needsReminder ? `当前建议催办阶段：${item.recommendedReminderStage || '进度确认'}。` : '当前没有强制催办要求，可按实际情况留痕。',
      done: reminders.length > 0,
      target: 'reminder',
      tone: 'violet'
    }
  ]

  const nextActionToneClass = {
    emerald: {
      done: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100',
      idle: 'border-emerald-400/20 bg-slate-900/60 text-slate-100',
      disabled: 'border-slate-600 bg-slate-900/40 text-slate-500'
    },
    blue: {
      done: 'border-blue-400/30 bg-blue-500/10 text-blue-100',
      idle: 'border-blue-400/20 bg-slate-900/60 text-slate-100',
      disabled: 'border-slate-600 bg-slate-900/40 text-slate-500'
    },
    cyan: {
      done: 'border-cyan-400/30 bg-cyan-500/10 text-cyan-100',
      idle: 'border-cyan-400/20 bg-slate-900/60 text-slate-100',
      disabled: 'border-slate-600 bg-slate-900/40 text-slate-500'
    },
    violet: {
      done: 'border-violet-400/30 bg-violet-500/10 text-violet-100',
      idle: 'border-violet-400/20 bg-slate-900/60 text-slate-100',
      disabled: 'border-slate-600 bg-slate-900/40 text-slate-500'
    }
  }

  const actionMessageMeta = {
    signOff: {
      label: '去签发区',
      action: () => scrollToSection('signOff')
    },
    archive: {
      label: '去归档区',
      action: () => scrollToSection('archive')
    },
    reminder: {
      label: '查看催办记录',
      action: () => scrollToSection('reminder')
    },
    review: {
      label: '返回上一页',
      action: returnToReview
    }
  }
  const proposalTitle = item.title || '当前方案'
  const statusActionLabel = (status) => (
    updatingStatus
      ? `正在更新方案《${proposalTitle}》状态`
      : `将方案《${proposalTitle}》状态更新为「${status}」，执行前需要输入“更新方案状态”确认，当前状态 ${item.status || '未知'}`
  )
  const reportActionLabel = (action, running = false) => (
    configurationPending
      ? `${action}暂不可用：方案《${proposalTitle}》尚未生成审核意见`
      : `${running ? '正在' : ''}${action}方案《${proposalTitle}》，当前状态 ${item.status || '未知'}，综合评分 ${summary.avgScore == null ? '暂无评分' : summary.avgScore}，高风险 ${summary.riskCount?.high || 0} 项`
  )
  const rerunReviewLabel = rerunning
    ? `正在重新发起方案《${proposalTitle}》AI 审核`
    : reviewReadiness.ready
      ? `重新发起方案《${proposalTitle}》AI 审核，执行前需要输入“重新发起AI审核”确认`
      : `AI 审核暂不可用：${reviewReadiness.message}`
  const nextActionLabel = (card) => (
    `${card.title}：${card.done ? '已完成' : card.disabled ? '当前阶段未开放' : '待处理'}。${card.description}`
  )
  const executionOverviewLabel = (card) => (
    `${card.title}：数量 ${card.count}，状态 ${card.status}，${card.detail}。点击跳转到对应操作区。`
  )
  const logsFilterLabel = (label, actionGroup = '') => `查看方案《${proposalTitle}》${label}执行留痕${actionGroup ? `，日志分组：${actionGroup}` : ''}`
  const manualTemplateLabel = (template) => `将方案《${proposalTitle}》人工复核模板切换为「${template.label}」`
  const saveManualReviewLabel = savingManualReview
    ? `正在保存方案《${proposalTitle}》人工复核结论`
    : configurationPending
      ? `人工复核暂不可用：方案《${proposalTitle}》尚未生成 AI 审核结果`
    : canReview
      ? `保存方案《${proposalTitle}》人工复核结论，结论为「${manualReviewForm.conclusion || '未填写'}」`
      : `无权限保存方案《${proposalTitle}》人工复核结论`
  const saveNoteLabel = savingNote
    ? `正在保存方案《${proposalTitle}》人工复核备注`
    : canReview
      ? `保存方案《${proposalTitle}》人工复核备注`
      : `无权限保存方案《${proposalTitle}》人工复核备注`
  const saveReminderLabel = savingReminder
    ? `正在登记方案《${proposalTitle}》催办记录`
    : canReview
      ? `登记方案《${proposalTitle}》催办记录，阶段 ${reminderForm.stage || '未选择'}，渠道 ${reminderForm.channel || '未选择'}`
      : `无权限登记方案《${proposalTitle}》催办记录`
  const applyReminderSuggestionLabel = `带入方案《${proposalTitle}》建议催办内容，建议阶段 ${item.recommendedReminderStage || reminderForm.stage || '进度确认'}`
  const saveSignOffLabel = savingSignOff
    ? `正在登记方案《${proposalTitle}》签发`
    : configurationPending
      ? `签发暂不可用：方案《${proposalTitle}》尚未生成 AI 审核结果`
    : !canReview
      ? `无权限登记方案《${proposalTitle}》签发`
      : hasManualReview
        ? `登记方案《${proposalTitle}》签发，签发文号 ${executionForm.documentCode || '未填写'}`
        : `方案《${proposalTitle}》待人工复核后开放签发`
  const saveArchiveLabel = savingArchive
    ? `正在登记方案《${proposalTitle}》归档`
    : configurationPending
      ? `归档暂不可用：方案《${proposalTitle}》尚未生成 AI 审核结果`
    : !canReview
      ? `无权限登记方案《${proposalTitle}》归档`
      : signOffRecord.status === '已签发'
        ? `登记方案《${proposalTitle}》归档，归档编号 ${executionForm.archiveCode || '未填写'}，位置 ${executionForm.archiveLocation || '未填写'}`
        : `方案《${proposalTitle}》待签发后开放归档`
  const attachmentDownloadLabel = (file) => (
    downloadingId === file.id
      ? `正在下载方案《${proposalTitle}》附件：${file.name || file.id}`
      : `下载方案《${proposalTitle}》附件：${file.name || file.id}，解析状态 ${file.extractionStatus || '未解析'}`
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={returnToReview}
          title="返回上一页或审核中心"
          aria-label="返回上一页或审核中心"
          className="flex items-center gap-2 text-sm text-slate-300 hover:text-white"
        >
          <ArrowLeft size={17} aria-hidden="true" />
          返回上一页
        </button>
        <div className="flex flex-wrap gap-2">
          {canReview && (
            <>
              {item.status !== '待修改' && !configurationPending && (
                <button
                  type="button"
                  onClick={() => updateStatus('待修改')}
                  disabled={updatingStatus}
                  title={statusActionLabel('待修改')}
                  aria-label={statusActionLabel('待修改')}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border border-amber-300/40 bg-amber-500/15 hover:bg-amber-500/25 disabled:opacity-50 text-sm text-amber-100"
                >
                  <RotateCcw size={16} aria-hidden="true" />
                  退回修改
                </button>
              )}
            </>
          )}
          <button
            type="button"
            onClick={openPreview}
            onFocus={preloadReportTools}
            onMouseEnter={preloadReportTools}
            disabled={previewingReport || configurationPending}
            title={reportActionLabel('预览意见书', previewingReport)}
            aria-label={reportActionLabel('预览意见书', previewingReport)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-violet-300/40 bg-violet-500/15 hover:bg-violet-500/25 disabled:opacity-50 text-sm text-violet-100"
          >
            <Eye size={16} aria-hidden="true" />
            {previewingReport ? '生成预览...' : '预览意见书'}
          </button>
          <button
            type="button"
            onClick={exportDoc}
            onFocus={preloadReportTools}
            onMouseEnter={preloadReportTools}
            disabled={exportingDoc || configurationPending}
            title={reportActionLabel('导出 Word 意见书', exportingDoc)}
            aria-label={reportActionLabel('导出 Word 意见书', exportingDoc)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-emerald-300/40 bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-50 text-sm text-emerald-100"
          >
            <Download size={16} aria-hidden="true" />
            {exportingDoc ? '导出中...' : '导出 Word 意见书'}
          </button>
          <button
            type="button"
            onClick={exportPdf}
            onFocus={preloadReportTools}
            onMouseEnter={preloadReportTools}
            disabled={exportingPdf || configurationPending}
            title={reportActionLabel('导出 PDF', exportingPdf)}
            aria-label={reportActionLabel('导出 PDF', exportingPdf)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-cyan-300/40 bg-cyan-500/15 hover:bg-cyan-500/25 disabled:opacity-50 text-sm text-cyan-100"
          >
            <FileText size={16} aria-hidden="true" />
            {exportingPdf ? '生成中...' : '导出 PDF'}
          </button>
          {canReview && (
            <button
              type="button"
              onClick={rerunReview}
              disabled={rerunning || !reviewReadiness.ready}
              title={rerunReviewLabel}
              aria-label={rerunReviewLabel}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm border border-blue-300/40"
            >
              <RefreshCcw size={16} className={rerunning ? 'animate-spin' : ''} aria-hidden="true" />
              重新发起 AI 审核
            </button>
          )}
        </div>
      </div>

      {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>}
      {message && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
          <span>{message}</span>
          {actionMessageMeta[messageTarget] && (
            <button
              type="button"
              onClick={actionMessageMeta[messageTarget].action}
              title={actionMessageMeta[messageTarget].label}
              aria-label={actionMessageMeta[messageTarget].label}
              className="text-xs text-emerald-200 hover:text-white"
            >
              {actionMessageMeta[messageTarget].label}
            </button>
          )}
        </div>
      )}

      {configurationPending && (
        <div role="status" className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-amber-100">
          <div className="font-semibold">这是待专业配置草稿，尚未执行 AI 审核</div>
          <p className="mt-1 text-sm leading-6 text-amber-50/90">
            标题与附件已安全保存；当前没有评分、专业意见、立项报告或人工复核结论。完成审核 Profile 正式核验后，再发起 AI 审核进入正常复核流程。
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            <span>已核验并启用 Profile：{reviewReadiness.activeProfileCount}</span>
            {!reviewReadiness.ready && <span>{reviewReadiness.message}</span>}
          </div>
        </div>
      )}

      {reportPreviewHtml && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm p-4 lg:p-6">
          <div className="h-full max-w-7xl mx-auto rounded-xl border border-blue-500/25 bg-slate-950 shadow-2xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-blue-500/20 bg-slate-950/95">
              <div>
                <div className="text-lg font-semibold text-blue-100">意见书预览</div>
                <div className="text-xs text-slate-400 mt-1">预览内容与导出 Word / PDF 使用同一份文档模板</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={exportDoc}
                  onFocus={preloadReportTools}
                  onMouseEnter={preloadReportTools}
                  disabled={exportingDoc || configurationPending}
                  title={reportActionLabel('导出 Word 意见书', exportingDoc)}
                  aria-label={reportActionLabel('导出 Word 意见书', exportingDoc)}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-300/40 bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-50 text-sm text-emerald-100"
                >
                  <Download size={15} aria-hidden="true" />
                  {exportingDoc ? '导出中...' : '导出 Word'}
                </button>
                <button
                  type="button"
                  onClick={exportPdf}
                  onFocus={preloadReportTools}
                  onMouseEnter={preloadReportTools}
                  disabled={exportingPdf || configurationPending}
                  title={reportActionLabel('导出 PDF', exportingPdf)}
                  aria-label={reportActionLabel('导出 PDF', exportingPdf)}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-cyan-300/40 bg-cyan-500/15 hover:bg-cyan-500/25 disabled:opacity-50 text-sm text-cyan-100"
                >
                  <BookOpenText size={15} aria-hidden="true" />
                  {exportingPdf ? '生成中...' : '导出 PDF'}
                </button>
                <button
                  type="button"
                  onClick={closePreview}
                  title={`关闭方案《${proposalTitle}》意见书预览`}
                  aria-label={`关闭方案《${proposalTitle}》意见书预览`}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-600 bg-slate-900/80 hover:bg-slate-800 text-sm text-slate-200"
                >
                  <X size={15} aria-hidden="true" />
                  关闭
                </button>
              </div>
            </div>
            <div className="flex-1 bg-slate-900">
              <iframe
                title="审核意见书预览"
                srcDoc={reportPreviewHtml}
                className="w-full h-full border-0 bg-white"
              />
            </div>
          </div>
        </div>
      )}

      <Panel className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap gap-2 mb-3">
              <span className="px-2 py-1 rounded text-xs border border-blue-400/30 text-blue-300 bg-blue-500/10">{item.type}</span>
              <span className="px-2 py-1 rounded text-xs border border-amber-400/30 text-amber-300 bg-amber-500/10">{item.status}</span>
              <span className="px-2 py-1 rounded text-xs border border-cyan-400/30 text-cyan-300 bg-cyan-500/10">{item.robot}</span>
            </div>
            <h1 className="text-2xl font-bold text-blue-100">{item.title}</h1>
            <p className="text-sm text-slate-400 mt-2 max-w-3xl">{item.description || '暂无方案说明'}</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 min-w-[300px]">
            <div className="rounded-lg border border-blue-500/25 bg-slate-900/65 p-3">
              <div className="text-xs text-slate-400">综合评分</div>
              <div className="text-2xl font-bold text-cyan-200">{summary.avgScore == null ? '暂无评分' : summary.avgScore}</div>
            </div>
            <div className="rounded-lg border border-blue-500/25 bg-slate-900/65 p-3">
              <div className="text-xs text-slate-400">高风险</div>
              <div className="text-2xl font-bold text-red-300">{summary.riskCount?.high || 0}</div>
            </div>
            <div className="rounded-lg border border-blue-500/25 bg-slate-900/65 p-3">
              <div className="text-xs text-slate-400">附件</div>
              <div className="text-2xl font-bold text-blue-200">{item.files?.length || 0}</div>
            </div>
            <div className="rounded-lg border border-blue-500/25 bg-slate-900/65 p-3">
              <div className="text-xs text-slate-400">命中条款</div>
              <div className="text-2xl font-bold text-emerald-200">{summary.knowledgeHitCount || 0}</div>
            </div>
          </div>
        </div>
      </Panel>

      <Panel className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="font-semibold text-blue-100 flex items-center gap-2">
            <Clock3 size={18} className="text-cyan-300" />
            AI 调用链路
          </h2>
          <div className="text-xs text-slate-500">
            当前引擎：{item.aiProvider || '未记录'} / {item.aiModel || '未记录'}
          </div>
        </div>
        {(item.aiReviewTrace || []).length === 0 ? (
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/55 px-4 py-5 text-sm text-slate-500">
            暂无 AI 调用记录，重新发起审核后会自动记录 Provider、模型、耗时和回退状态。
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {(item.aiReviewTrace || []).slice(0, 6).map(trace => (
              <div key={trace.id} className={`rounded-lg border p-4 ${aiTraceToneClass(trace)}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium text-blue-100">{trace.provider || 'local'} / {trace.model || '-'}</div>
                  <span className={`px-2 py-1 rounded text-xs border ${aiTraceBadgeClass(trace)}`}>
                    {aiTraceLabel(trace)}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
                  <div className="rounded border border-white/10 bg-slate-950/35 px-2 py-1 text-slate-300">耗时 {trace.durationMs || 0} ms</div>
                  <div className="rounded border border-white/10 bg-slate-950/35 px-2 py-1 text-slate-300">{aiModeText(trace.mode)}</div>
                  <div className="rounded border border-white/10 bg-slate-950/35 px-2 py-1 text-slate-300">Profile {trace.profileCount || 0}</div>
                  <div className="rounded border border-white/10 bg-slate-950/35 px-2 py-1 text-slate-300">意见 {trace.opinionCount || 0}</div>
                  <div className="rounded border border-white/10 bg-slate-950/35 px-2 py-1 text-slate-300">{trace.result || '未汇总'}</div>
                </div>
                <div className="mt-2 text-xs text-slate-500">{trace.at}</div>
                {trace.error && <p className="mt-2 text-xs leading-5 text-amber-100">{trace.error}</p>}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="font-semibold text-blue-100">执行下一步</h2>
            <p className="text-sm text-slate-400 mt-1">把人工复核、签发、归档和催办串成一条执行链，减少来回找入口。</p>
          </div>
          <div className="text-xs text-slate-500">
            当前状态：{configurationPending ? '待 AI 审核 / 未开放 / 未开放' : `${manualReview.manualReviewStatus || (hasManualReview ? '已复核' : '待复核')} / ${signOffRecord.status || '待签发'} / ${archiveRecord.status || '待归档'}`}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          {nextActionCards.map(card => {
            const tone = nextActionToneClass[card.tone] || nextActionToneClass.blue
            const cardClass = card.disabled ? tone.disabled : card.done ? tone.done : tone.idle
            return (
              <button
                key={card.key}
                type="button"
                disabled={card.disabled}
                onClick={() => scrollToSection(card.target)}
                title={nextActionLabel(card)}
                aria-label={nextActionLabel(card)}
                className={`rounded-lg border p-4 text-left transition ${cardClass} ${card.disabled ? 'cursor-not-allowed' : 'hover:-translate-y-0.5 hover:border-white/20'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">{card.title}</div>
                  <span className="text-xs">
                    {card.done ? '已完成' : card.disabled ? '未开放' : '待处理'}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 opacity-85">{card.description}</p>
                <div className="mt-3 text-xs opacity-70">{card.disabled ? '当前阶段未开放' : '点击跳转到对应操作区'}</div>
              </button>
            )
          })}
        </div>
      </Panel>

      {canViewLogs && (
        <Panel className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="font-semibold text-blue-100">执行留痕总览</h2>
            <p className="text-sm text-slate-400 mt-1">把人工复核、备注、签发、归档、催办和导出放在同一块看，方便判断当前卡点。</p>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/logs?proposalId=${id}&type=执行动作`)}
            title={logsFilterLabel('全部')}
            aria-label={logsFilterLabel('全部')}
            className="text-xs text-cyan-300 hover:text-cyan-200"
          >
            打开当前方案全部执行留痕
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {executionOverviewCards.map(card => (
            <button
              key={card.key}
              type="button"
              onClick={card.onClick}
              title={executionOverviewLabel(card)}
              aria-label={executionOverviewLabel(card)}
              className={`rounded-lg border p-4 text-left transition hover:-translate-y-0.5 hover:border-white/20 ${executionOverviewToneClass[card.tone] || executionOverviewToneClass.slate}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">{card.title}</div>
                <div className="text-lg font-semibold">{card.count}</div>
              </div>
              <div className="mt-3 text-xs opacity-80">状态：{card.status}</div>
              <div className="mt-1 text-xs opacity-70 leading-5">{card.detail}</div>
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => navigate(`/logs?proposalId=${id}&type=执行动作&actionGroup=人工复核`)}
            title={logsFilterLabel('人工复核', '人工复核')}
            aria-label={logsFilterLabel('人工复核', '人工复核')}
            className="px-3 py-1.5 rounded-lg border border-emerald-400/25 bg-emerald-500/10 text-xs text-emerald-100 hover:bg-emerald-500/20"
          >
            只看人工复核
          </button>
          <button
            type="button"
            onClick={() => navigate(`/logs?proposalId=${id}&type=执行动作&actionGroup=签发归档`)}
            title={logsFilterLabel('签发归档', '签发归档')}
            aria-label={logsFilterLabel('签发归档', '签发归档')}
            className="px-3 py-1.5 rounded-lg border border-blue-400/25 bg-blue-500/10 text-xs text-blue-100 hover:bg-blue-500/20"
          >
            只看签发归档
          </button>
          <button
            type="button"
            onClick={() => navigate(`/logs?proposalId=${id}&type=执行动作&actionGroup=催办`)}
            title={logsFilterLabel('催办', '催办')}
            aria-label={logsFilterLabel('催办', '催办')}
            className="px-3 py-1.5 rounded-lg border border-violet-400/25 bg-violet-500/10 text-xs text-violet-100 hover:bg-violet-500/20"
          >
            只看催办
          </button>
          <button
            type="button"
            onClick={() => navigate(`/logs?proposalId=${id}&type=执行动作&actionGroup=导出`)}
            title={logsFilterLabel('导出', '导出')}
            aria-label={logsFilterLabel('导出', '导出')}
            className="px-3 py-1.5 rounded-lg border border-cyan-400/25 bg-cyan-500/10 text-xs text-cyan-100 hover:bg-cyan-500/20"
          >
            只看导出
          </button>
        </div>
        </Panel>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel className="p-5" ref={manualReviewSectionRef}>
          <h2 className="font-semibold mb-3 flex items-center gap-2">
            <ClipboardCheck size={18} className="text-emerald-300" />
            人工复核结论
          </h2>
          <div className="flex flex-wrap gap-2 mb-3">
            {manualReviewTemplates.map(template => (
              <button
                key={template.key}
                type="button"
                onClick={() => applyManualTemplate(template)}
                disabled={!canReview || configurationPending}
                title={manualTemplateLabel(template)}
                aria-label={manualTemplateLabel(template)}
                className="px-3 py-1.5 rounded-lg border border-emerald-400/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-xs text-emerald-200"
              >
                {template.label}
              </button>
            ))}
          </div>
          <p className="mb-3 text-xs leading-5 text-amber-200">
            结论按钮只带入结论类型，不会代填事实。请根据已核验原件逐条填写复核依据、后续动作和摘要；完成后仍需登记签发文号，系统才会进入“已通过”。
          </p>
          <form onSubmit={saveManualReview} className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="space-y-2" htmlFor={manualConclusionInputId}>
                <div className="text-sm text-slate-300">复核结论</div>
                <input
                  id={manualConclusionInputId}
                  value={manualReviewForm.conclusion}
                  onChange={e => updateManualField('conclusion', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
                  placeholder="例如：建议通过 / 补充后通过 / 退回修改"
                />
              </label>
              <div className="space-y-2">
                <div className="text-sm text-slate-300">复核人</div>
                <div className="px-3 py-2 rounded-lg border border-blue-500/20 bg-slate-900/50 text-sm text-slate-300">
                  {manualReview.reviewer || currentUser?.name || '当前登录人'}
                </div>
              </div>
            </div>
            <label className="space-y-2 block" htmlFor={manualBasisInputId}>
              <div className="text-sm text-slate-300">复核依据</div>
              <textarea
                id={manualBasisInputId}
                value={manualReviewForm.basisText}
                onChange={e => updateManualField('basisText', e.target.value)}
                rows={4}
                className="w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60 resize-none"
                placeholder="每行一条，例如：已补充测算依据"
              />
            </label>
            <label className="space-y-2 block" htmlFor={manualActionsInputId}>
              <div className="text-sm text-slate-300">后续动作</div>
              <textarea
                id={manualActionsInputId}
                value={manualReviewForm.actionsText}
                onChange={e => updateManualField('actionsText', e.target.value)}
                rows={3}
                className="w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60 resize-none"
                placeholder="每行一条，例如：进入签发"
              />
            </label>
            <label className="space-y-2 block" htmlFor={manualSummaryInputId}>
              <div className="text-sm text-slate-300">复核摘要</div>
              <textarea
                id={manualSummaryInputId}
                value={manualReviewForm.summary}
                onChange={e => updateManualField('summary', e.target.value)}
                rows={4}
                className="w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60 resize-none"
                placeholder="概述人工复核后的最终判断"
              />
            </label>
            <button type="submit" disabled={savingManualReview || !canReview || configurationPending} title={saveManualReviewLabel} aria-label={saveManualReviewLabel} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm border border-emerald-300/40">
              {!canReview ? '无复核权限' : configurationPending ? '待 AI 审核后开放' : savingManualReview ? '保存中...' : '保存人工复核结论'}
            </button>
          </form>

          <div className="mt-4 rounded-lg border border-emerald-400/20 bg-emerald-500/5 p-4">
            {hasManualReview ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs text-slate-500">当前人工结论</div>
                    <div className="text-lg font-semibold text-emerald-200 mt-1">{manualReview.conclusion}</div>
                  </div>
                  <div className="text-xs text-slate-500 text-right">
                    <div>{manualReview.reviewer || '未记录复核人'}</div>
                    <div className="mt-1">{manualReview.reviewedAt || '未记录时间'}</div>
                  </div>
                </div>
                {(manualReview.basis || []).length > 0 && (
                  <div>
                    <div className="text-sm font-medium text-slate-200 mb-2">复核依据</div>
                    <ul className="space-y-1 text-sm text-slate-400">
                      {manualReview.basis.map(point => <li key={point}>· {point}</li>)}
                    </ul>
                  </div>
                )}
                {(manualReview.actions || []).length > 0 && (
                  <div>
                    <div className="text-sm font-medium text-slate-200 mb-2">后续动作</div>
                    <ul className="space-y-1 text-sm text-slate-400">
                      {manualReview.actions.map(point => <li key={point}>· {point}</li>)}
                    </ul>
                  </div>
                )}
                {manualReview.summary && (
                  <div>
                    <div className="text-sm font-medium text-slate-200 mb-2">复核摘要</div>
                    <p className="text-sm text-slate-300 leading-6">{manualReview.summary}</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-sm text-slate-500">暂无结构化人工复核结论</div>
            )}
          </div>
        </Panel>

        <Panel className="p-5">
          <h2 className="font-semibold mb-3 flex items-center gap-2">
            <MessageSquareText size={18} className="text-cyan-300" />
            人工复核备注
          </h2>
          <form onSubmit={saveNote} className="space-y-3">
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60 resize-none"
              placeholder="记录补充说明、口头沟通结果或临时追记事项"
            />
            <button type="submit" disabled={savingNote || !canReview} title={saveNoteLabel} aria-label={saveNoteLabel} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm border border-blue-300/40">
              {!canReview ? '无复核权限' : savingNote ? '保存中...' : '保存备注'}
            </button>
          </form>
          <div className="mt-4 space-y-2">
            {(item.reviewNotes || []).length === 0 ? (
              <div className="text-sm text-slate-500">暂无人工备注</div>
            ) : item.reviewNotes.map(row => (
              <div key={row.id} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-3">
                <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                  <span>{row.actor}</span>
                  <span>{row.at}</span>
                </div>
                <p className="text-sm text-slate-300 mt-2">{row.content}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel className="p-5">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <ListChecks size={18} className="text-cyan-300" />
          审核时间线
        </h2>
        <div className="space-y-2">
          {(item.timeline || []).length === 0 ? (
            <div className="text-sm text-slate-500">暂无时间线</div>
          ) : item.timeline.map(row => (
            <div key={row.id} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium text-blue-100">{row.action}</div>
                <div className="text-xs text-slate-500 whitespace-nowrap">{row.at}</div>
              </div>
              <div className="text-xs text-slate-500 mt-1">操作人：{row.actor}</div>
              {row.detail && <p className="text-sm text-slate-300 mt-2">{row.detail}</p>}
            </div>
          ))}
        </div>
      </Panel>

      <Panel className="p-5" ref={exportSectionRef}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold flex items-center gap-2">
            <Download size={18} className="text-emerald-300" />
            意见书导出记录
          </h2>
          {canViewLogs && (
            <button
              type="button"
              onClick={() => navigate(`/logs?type=执行动作&proposalId=${id}`)}
              title={logsFilterLabel('当前方案')}
              aria-label={logsFilterLabel('当前方案')}
              className="text-xs text-emerald-300 hover:text-emerald-200"
            >
              查看当前方案执行留痕
            </button>
          )}
        </div>
        <div className="mb-4 grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-3">
            <div className="text-xs text-slate-500">总次数</div>
            <div className="mt-2 text-xl font-semibold text-blue-100">{exportSummary.total}</div>
          </div>
          <div className="rounded-lg border border-violet-400/20 bg-slate-900/60 px-3 py-3">
            <div className="text-xs text-slate-500">预览</div>
            <div className="mt-2 text-xl font-semibold text-violet-200">{exportSummary.preview}</div>
          </div>
          <div className="rounded-lg border border-emerald-400/20 bg-slate-900/60 px-3 py-3">
            <div className="text-xs text-slate-500">Word</div>
            <div className="mt-2 text-xl font-semibold text-emerald-200">{exportSummary.word}</div>
          </div>
          <div className="rounded-lg border border-cyan-400/20 bg-slate-900/60 px-3 py-3">
            <div className="text-xs text-slate-500">PDF</div>
            <div className="mt-2 text-xl font-semibold text-cyan-200">{exportSummary.pdf}</div>
          </div>
          <div className="rounded-lg border border-slate-500/20 bg-slate-900/60 px-3 py-3">
            <div className="text-xs text-slate-500">详情页</div>
            <div className="mt-2 text-xl font-semibold text-slate-200">{exportSummary.detail}</div>
          </div>
          <div className="rounded-lg border border-slate-500/20 bg-slate-900/60 px-3 py-3">
            <div className="text-xs text-slate-500">提交结果</div>
            <div className="mt-2 text-xl font-semibold text-slate-200">{exportSummary.submit}</div>
          </div>
          <div className="rounded-lg border border-slate-500/20 bg-slate-900/60 px-3 py-3">
            <div className="text-xs text-slate-500">审核中心</div>
            <div className="mt-2 text-xl font-semibold text-slate-200">{exportSummary.review}</div>
          </div>
          <div className="rounded-lg border border-slate-500/20 bg-slate-900/60 px-3 py-3">
            <div className="text-xs text-slate-500">涉及版本</div>
            <div className="mt-2 text-sm font-medium text-slate-200 break-words">
              {exportSummary.versions.length > 0 ? exportSummary.versions.join(' / ') : '未记录'}
            </div>
          </div>
        </div>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="block" htmlFor={exportTypeFilterId}>
            <div className="text-xs text-slate-400 mb-1">导出类型</div>
            <select
              id={exportTypeFilterId}
              value={exportTypeFilter}
              onChange={e => syncSearchParams(next => {
                if (e.target.value === '全部') next.delete('exportType')
                else next.set('exportType', e.target.value)
                next.set('section', 'exports')
              })}
              className="px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
            >
              {exportTypeFilterOptions.map(option => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <label className="block" htmlFor={exportSourceFilterId}>
            <div className="text-xs text-slate-400 mb-1">导出来源</div>
            <select
              id={exportSourceFilterId}
              value={exportSourceFilter}
              onChange={e => syncSearchParams(next => {
                if (e.target.value === '全部') next.delete('exportSource')
                else next.set('exportSource', e.target.value)
                next.set('section', 'exports')
              })}
              className="px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
            >
              {exportSourceFilterOptions.map(option => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          {(exportTypeFilter !== '全部' || exportSourceFilter !== '全部') && (
            <button
              type="button"
              onClick={() => syncSearchParams(next => {
                next.delete('exportType')
                next.delete('exportSource')
                next.set('section', 'exports')
              })}
              title={`清除方案《${proposalTitle}》意见书导出记录筛选，当前结果 ${filteredExportEvents.length} 条`}
              aria-label={`清除方案《${proposalTitle}》意见书导出记录筛选，当前结果 ${filteredExportEvents.length} 条`}
              className="px-3 py-2 rounded-lg border border-slate-500/30 bg-slate-900/70 text-sm text-slate-300 hover:text-white"
            >
              清除筛选
            </button>
          )}
          <div className="text-xs text-slate-500">当前结果：{filteredExportEvents.length} 条</div>
        </div>
        {exportEvents.length === 0 ? (
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-6 text-sm text-slate-500">暂无导出留痕</div>
        ) : filteredExportEvents.length === 0 ? (
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-6 text-sm text-slate-500">当前筛选下暂无导出记录</div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {filteredExportEvents.map(event => (
              <div key={event.id} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`px-2 py-1 rounded text-xs border ${
                      event.type === 'preview'
                        ? 'border-violet-400/30 bg-violet-500/10 text-violet-200'
                        : event.type === 'pdf'
                          ? 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200'
                          : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                    }`}>
                      {exportTypeText(event.type)}
                    </span>
                    <span className="px-2 py-1 rounded text-xs border border-slate-500/30 bg-slate-500/10 text-slate-300">
                      {event.source === 'detail' ? '详情页' : event.source === 'review' ? '审核中心' : '提交结果'}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 whitespace-nowrap">{event.at || '-'}</div>
                </div>
                <div className="mt-2 text-sm text-slate-300">操作人：{event.actor || '未记录'}</div>
                <div className="mt-1 text-xs text-slate-500">留痕版本：{event.appVersion || '未记录版本'}</div>
                <div className="mt-1 text-xs text-slate-500">当前系统版本：{appVersion}</div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel className="p-5" ref={reminderSectionRef}>
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <BellRing size={18} className="text-cyan-300" aria-hidden="true" />
          催办记录
        </h2>
        <div className="grid grid-cols-1 xl:grid-cols-[360px_minmax(0,1fr)] gap-4">
          <div className="rounded-lg border border-cyan-400/20 bg-slate-900/60 p-4">
            <div className="text-sm font-medium text-slate-200">登记本次催办</div>
            <div className="text-xs text-slate-500 mt-1">记录催办阶段、沟通渠道和反馈内容，便于执行闭环留痕。</div>
            {item.recommendedReminderStage && (
              <div className="mt-3 rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                建议优先处理：{item.recommendedReminderStage}{item.needsReminder ? '，当前命中催办规则。' : '，当前可按实际情况跟进。'}
              </div>
            )}
            <form onSubmit={saveReminder} className="mt-4 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-1 gap-3">
                <label className="space-y-2 block" htmlFor={reminderStageInputId}>
                  <div className="text-sm text-slate-300">催办阶段</div>
                  <select
                    id={reminderStageInputId}
                    value={reminderForm.stage}
                    onChange={e => setReminderForm(prev => ({ ...prev, stage: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
                  >
                    {reminderStageOptions.map(option => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-2 block" htmlFor={reminderChannelInputId}>
                  <div className="text-sm text-slate-300">催办渠道</div>
                  <select
                    id={reminderChannelInputId}
                    value={reminderForm.channel}
                    onChange={e => setReminderForm(prev => ({ ...prev, channel: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
                  >
                    {reminderChannelOptions.map(option => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="space-y-2 block" htmlFor={reminderNoteInputId}>
                <div className="text-sm text-slate-300">催办内容</div>
                <textarea
                  id={reminderNoteInputId}
                  value={reminderForm.note}
                  onChange={e => setReminderForm(prev => ({ ...prev, note: e.target.value }))}
                  rows={5}
                  className="w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60 resize-none"
                  placeholder="记录已联系对象、承诺完成时间、下一步跟进安排。"
                />
              </label>
              <button type="submit" disabled={savingReminder || !canReview} title={saveReminderLabel} aria-label={saveReminderLabel} className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-sm border border-cyan-300/40">
                {!canReview ? '无复核权限' : savingReminder ? '保存中...' : '登记催办'}
              </button>
              <button
                type="button"
                onClick={() => setReminderForm(prev => ({
                  ...prev,
                  stage: item.recommendedReminderStage || prev.stage,
                  note: prev.note || `已根据当前进度发起${item.recommendedReminderStage || prev.stage}催办，请相关责任人反馈完成时间与补充动作。`
                }))}
                disabled={!canReview}
                title={applyReminderSuggestionLabel}
                aria-label={applyReminderSuggestionLabel}
                className="ml-2 px-4 py-2 rounded-lg border border-violet-300/40 bg-violet-500/10 hover:bg-violet-500/20 disabled:opacity-50 text-sm text-violet-100"
              >
                带入建议催办
              </button>
            </form>
          </div>

          <div className="space-y-2">
            {reminders.length === 0 ? (
              <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-6 text-sm text-slate-500">暂无催办记录</div>
            ) : reminders.map(row => (
              <div key={row.id} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="px-2 py-1 rounded text-xs border border-cyan-400/30 bg-cyan-500/10 text-cyan-200">{row.stage || '进度确认'}</span>
                    <span className="px-2 py-1 rounded text-xs border border-slate-500/30 bg-slate-500/10 text-slate-300">{row.channel || '企业微信'}</span>
                    <span className={`px-2 py-1 rounded text-xs border ${
                      row.source === 'auto'
                        ? 'border-violet-400/30 bg-violet-500/10 text-violet-200'
                        : 'border-slate-500/30 bg-slate-500/10 text-slate-300'
                    }`}>{reminderSourceText(row.source)}</span>
                  </div>
                  <div className="text-xs text-slate-500 whitespace-nowrap">{row.remindedAt || '-'}</div>
                </div>
                <div className="text-xs text-slate-500 mt-2">催办人：{row.remindedBy || '未记录'}</div>
                <p className="text-sm text-slate-300 mt-2 leading-6">{row.note || '无催办内容'}</p>
              </div>
            ))}
          </div>
        </div>
      </Panel>

      <Panel className="p-5" ref={signOffSectionRef}>
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <CheckCircle2 size={18} className="text-emerald-300" />
          签发与归档
        </h2>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="rounded-lg border border-emerald-400/20 bg-slate-900/60 p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="text-sm font-medium text-slate-200">签发记录</div>
                <div className="text-xs text-slate-500 mt-1">人工复核完成后方可签发，签发完成后方案自动进入已通过</div>
              </div>
              <span className={`px-2 py-1 rounded text-xs border ${
                signOffRecord.status === '已签发'
                  ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-slate-500/30 bg-slate-500/10 text-slate-300'
              }`}>
                {configurationPending ? '未开放' : (signOffRecord.status || '待签发')}
              </span>
            </div>
            <form onSubmit={saveSignOff} className="space-y-3">
              <label className="space-y-2 block" htmlFor={signOffDocumentInputId}>
                <div className="text-sm text-slate-300">签发文号</div>
                <input
                  id={signOffDocumentInputId}
                  value={executionForm.documentCode}
                  onChange={e => updateExecutionField('documentCode', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
                  placeholder="例如：FS-HERMES-MT-20260529-000001"
                />
              </label>
              <label className="space-y-2 block" htmlFor={signOffCommentInputId}>
                <div className="text-sm text-slate-300">签发说明</div>
                <textarea
                  id={signOffCommentInputId}
                  value={executionForm.signOffComment}
                  onChange={e => updateExecutionField('signOffComment', e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60 resize-none"
                  placeholder="记录签发补充说明或流转要求"
                />
              </label>
              <button
                type="submit"
                disabled={savingSignOff || configurationPending || !hasManualReview || !canReview}
                title={saveSignOffLabel}
                aria-label={saveSignOffLabel}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm border border-emerald-300/40"
              >
                {!canReview ? '无复核权限' : configurationPending ? '待 AI 审核后开放' : savingSignOff ? '保存中...' : hasManualReview ? '登记签发' : '待人工复核后开放'}
              </button>
              {!hasManualReview && (
                <div className="text-xs text-amber-300">{configurationPending ? '待完成 Profile 核验和 AI 审核后才开放人工复核与签发。' : '当前未完成人工复核，暂不建议直接登记签发。'}</div>
              )}
            </form>
            {signOffRecord.status === '已签发' && (
              <div className="mt-4 rounded-lg border border-emerald-400/15 bg-emerald-500/5 p-3 text-sm text-slate-300 space-y-1">
                <div>签发人：{signOffRecord.signer || '-'}</div>
                <div>签发时间：{signOffRecord.signedAt || '-'}</div>
                <div>签发文号：{signOffRecord.documentCode || '-'}</div>
                {signOffRecord.comment && <div>说明：{signOffRecord.comment}</div>}
              </div>
            )}
          </div>

          <div ref={archiveSectionRef} className="rounded-lg border border-cyan-400/20 bg-slate-900/60 p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="text-sm font-medium text-slate-200">归档记录</div>
                <div className="text-xs text-slate-500 mt-1">签发完成后方可归档，归档时登记编号与留存位置</div>
              </div>
              <span className={`px-2 py-1 rounded text-xs border ${
                archiveRecord.status === '已归档'
                  ? 'border-cyan-400/30 bg-cyan-500/10 text-cyan-300'
                  : 'border-slate-500/30 bg-slate-500/10 text-slate-300'
              }`}>
                {configurationPending ? '未开放' : (archiveRecord.status || '待归档')}
              </span>
            </div>
            <form onSubmit={saveArchive} className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="space-y-2 block" htmlFor={archiveCodeInputId}>
                  <div className="text-sm text-slate-300">归档编号</div>
                  <input
                    id={archiveCodeInputId}
                    value={executionForm.archiveCode}
                    onChange={e => updateExecutionField('archiveCode', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
                    placeholder="例如：ARC-20260529-001"
                  />
                </label>
                <label className="space-y-2 block" htmlFor={archiveLocationInputId}>
                  <div className="text-sm text-slate-300">归档位置</div>
                  <input
                    id={archiveLocationInputId}
                    value={executionForm.archiveLocation}
                    onChange={e => updateExecutionField('archiveLocation', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
                    placeholder="例如：综合档案室 A-03"
                  />
                </label>
              </div>
              <label className="space-y-2 block" htmlFor={archiveCommentInputId}>
                <div className="text-sm text-slate-300">归档说明</div>
                <textarea
                  id={archiveCommentInputId}
                  value={executionForm.archiveComment}
                  onChange={e => updateExecutionField('archiveComment', e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60 resize-none"
                  placeholder="记录留档说明、纸质件份数或电子件说明"
                />
              </label>
              <button
                type="submit"
                disabled={savingArchive || configurationPending || signOffRecord.status !== '已签发' || !canReview}
                title={saveArchiveLabel}
                aria-label={saveArchiveLabel}
                className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-sm border border-cyan-300/40"
              >
                {!canReview ? '无复核权限' : configurationPending ? '待 AI 审核后开放' : savingArchive ? '保存中...' : signOffRecord.status === '已签发' ? '登记归档' : '待签发后开放'}
              </button>
              {signOffRecord.status !== '已签发' && (
                <div className="text-xs text-amber-300">{configurationPending ? '当前仅为待配置草稿，归档流程尚未开放。' : '当前未完成签发，归档区先保留待办状态。'}</div>
              )}
            </form>
            {archiveRecord.status === '已归档' && (
              <div className="mt-4 rounded-lg border border-cyan-400/15 bg-cyan-500/5 p-3 text-sm text-slate-300 space-y-1">
                <div>归档人：{archiveRecord.archivist || '-'}</div>
                <div>归档时间：{archiveRecord.archivedAt || '-'}</div>
                <div>归档编号：{archiveRecord.archiveCode || '-'}</div>
                <div>归档位置：{archiveRecord.location || '-'}</div>
                {archiveRecord.comment && <div>说明：{archiveRecord.comment}</div>}
              </div>
            )}
          </div>
        </div>
      </Panel>

      <Panel className="p-5">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <FileText size={18} className="text-cyan-300" />
          附件清单
        </h2>
        {(item.files || []).length === 0 ? (
          <div className="text-sm text-slate-500">暂无附件</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {item.files.map(file => (
              <div key={file.id || file.name} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-blue-100 truncate">{file.name}</div>
                  <div className="text-xs text-slate-500 mt-1">
                    {Math.ceil((file.size || 0) / 1024)} KB · {file.type || '未知类型'} · {file.extractionStatus || '未解析'} · {extractionTypeTextMap[file.extractionType] || file.extractionType || '未标注'}
                    {file.pdfTableCount > 0 ? ` · 识别 ${file.pdfTableCount} 个表格` : ''}
                  </div>
                  {file.textPreview && <p className="mt-2 text-xs leading-5 text-slate-400 line-clamp-2">{file.textPreview}</p>}
                  {file.extractionError && <p className="mt-2 text-xs text-red-300">{file.extractionError}</p>}
                </div>
                {file.id ? (
                  <button
                    type="button"
                    onClick={() => downloadAttachment(file)}
                    disabled={downloadingId === file.id}
                    title={attachmentDownloadLabel(file)}
                    aria-label={attachmentDownloadLabel(file)}
                    className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded border border-blue-400/40 bg-blue-500/10 text-blue-200 disabled:opacity-50 text-sm"
                  >
                    <Download size={14} />
                    {downloadingId === file.id ? '下载中' : '下载'}
                  </button>
                ) : (
                  <span className="shrink-0 text-xs text-slate-500">历史附件</span>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel className="p-5">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <TrendingUp size={18} className="text-cyan-300" />
          审核流程
        </h2>
        {(item.flow || []).length === 0 ? (
          <div className="rounded-lg border border-amber-400/20 bg-amber-500/5 px-4 py-5 text-sm text-amber-100">
            尚未生成审核流程；完成 Profile 核验并发起 AI 审核后自动生成。
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {(item.flow || []).map((step, index) => (
              <div key={step} className="rounded-lg border border-blue-500/25 bg-slate-900/65 p-4">
                <div className="text-xs text-slate-500">步骤 {index + 1}</div>
                <div className="mt-1 font-semibold text-blue-100">{step}</div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {item.initiationReport && (
        <Panel className="p-5">
          <h2 className="font-semibold mb-3 flex items-center gap-2">
            <FileText size={18} className="text-cyan-300" />
            投资发展立项报告
          </h2>
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/55 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div>
                <div className="font-semibold text-blue-100">{item.initiationReport.title}</div>
                <div className="text-xs text-slate-400">{item.initiationReport.owner} · {item.initiationReport.generatedAt}</div>
              </div>
              <span className="px-2 py-1 rounded text-xs border border-emerald-400/30 text-emerald-300 bg-emerald-500/10">
                {item.initiationReport.viability}
              </span>
            </div>
            <p className="text-sm text-slate-300 mb-3">{item.initiationReport.summary}</p>
            {(item.initiationReport.knowledgeHits || []).length > 0 && (
              <div className="mb-4 space-y-2">
                <div className="text-sm font-medium text-slate-200">投资发展命中条款</div>
                {(item.initiationReport.knowledgeHits || []).map(hit => (
                  <div key={`init-${hit.id}`} className="rounded-lg border border-emerald-400/15 bg-slate-950/50 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="px-2 py-1 rounded text-xs border border-emerald-400/30 bg-emerald-500/10 text-emerald-300">{hit.clauseCode}</span>
                      <span className="text-sm font-medium text-blue-100">{hit.title}</span>
                    </div>
                    <p className="text-xs text-slate-400 mt-2 leading-5">{hit.content}</p>
                    {(hit.evidence || []).length > 0 && (
                      <div className="mt-3 space-y-2">
                        {(hit.evidence || []).map((evidence, index) => (
                          <div key={`init-${hit.id}-evidence-${index}`} className="rounded border border-blue-500/15 bg-slate-900/75 px-3 py-2">
                            <div className="text-[11px] text-slate-500">{evidence.sourceType} · {evidence.sourceLabel}</div>
                            <p className="text-xs text-slate-300 mt-1 leading-5">{evidence.snippet}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <div className="text-sm font-medium text-slate-200 mb-2">关键判断</div>
                <ul className="space-y-2 text-sm text-slate-400">
                  {item.initiationReport.keyPoints.map(point => <li key={point}>· {point}</li>)}
                </ul>
              </div>
              <div>
                <div className="text-sm font-medium text-slate-200 mb-2">立项风险</div>
                <ul className="space-y-2 text-sm text-slate-400">
                  {item.initiationReport.risks.map(point => <li key={point}>· {point}</li>)}
                </ul>
              </div>
            </div>
          </div>
        </Panel>
      )}

      <Panel className="p-5">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <Bot size={18} className="text-cyan-300" />
          {opinionSectionTitle}
        </h2>
        {opinions.length === 0 ? (
          <div className="rounded-lg border border-amber-400/20 bg-amber-500/5 px-4 py-5 text-sm text-amber-100">
            尚未生成专业审核意见；当前草稿不会伪造评分或审核结论。
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {opinions.map(opinion => (
            <div key={opinion.profileId} className="rounded-lg border border-blue-500/25 bg-slate-900/65 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs text-slate-500">{opinion.code} · {opinion.hermesName}</div>
                  <div className="font-semibold text-blue-100">{opinion.name}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-cyan-200">{opinion.score}</span>
                  <span className={`px-2 py-1 rounded text-xs border ${riskClass[opinion.risk] || riskClass.中}`}>{opinion.risk}风险</span>
                </div>
              </div>
              <p className="text-sm text-slate-300 mt-3">{opinion.conclusion}</p>
              {(opinion.ruleMatches || []).length > 0 && (
                <div className="mt-3 rounded-lg border border-blue-500/15 bg-slate-950/55 p-3">
                  <div className="text-xs text-slate-500 mb-2">规则校验</div>
                  <div className="flex flex-wrap gap-2">
                    {opinion.ruleMatches.map(rule => (
                      <span
                        key={`${opinion.profileId}-${rule.id}`}
                        className={`px-2 py-1 rounded text-xs border ${
                          rule.passed
                            ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'
                            : 'border-red-400/30 bg-red-500/10 text-red-300'
                        }`}
                      >
                        {rule.name}{rule.impact ? ` -${rule.impact}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {(opinion.knowledgeHits || []).length > 0 && (
                <div className="mt-3 rounded-lg border border-emerald-500/15 bg-emerald-500/5 p-3">
                  <div className="text-xs text-slate-500 mb-2">命中专业知识条款</div>
                  <div className="space-y-2">
                    {opinion.knowledgeHits.map(hit => (
                      <div key={`${opinion.profileId}-${hit.id}`} className="rounded-lg border border-emerald-400/15 bg-slate-950/45 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="px-2 py-1 rounded text-xs border border-emerald-400/30 bg-emerald-500/10 text-emerald-300">{hit.clauseCode}</span>
                          <span className="text-sm font-medium text-blue-100">{hit.title}</span>
                        </div>
                        <p className="text-xs text-slate-400 mt-2 leading-5">{hit.content}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(hit.matchedKeywords || []).map(keyword => (
                            <span key={`${hit.id}-${keyword}`} className="px-2 py-1 rounded text-[11px] border border-blue-400/20 bg-blue-500/10 text-blue-200">
                              命中：{keyword}
                            </span>
                          ))}
                        </div>
                        {(hit.evidence || []).length > 0 && (
                          <div className="mt-3 space-y-2">
                            {(hit.evidence || []).map((evidence, index) => (
                              <div key={`${hit.id}-evidence-${index}`} className="rounded border border-blue-500/15 bg-slate-900/75 px-3 py-2">
                                <div className="text-[11px] text-slate-500">{evidence.sourceType} · {evidence.sourceLabel}</div>
                                <p className="text-xs text-slate-300 mt-1 leading-5">{evidence.snippet}</p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-slate-500 mb-1">发现</div>
                  <ul className="space-y-1 text-xs text-slate-400">
                    {opinion.findings.map(point => <li key={point}>· {point}</li>)}
                  </ul>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">建议</div>
                  <ul className="space-y-1 text-xs text-slate-400">
                    {opinion.suggestions.map(point => <li key={point}>· {point}</li>)}
                  </ul>
                </div>
              </div>
            </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel className="p-5">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <BookText size={18} className="text-emerald-300" />
          审核命中条款
        </h2>
        {summaryKnowledgeHits.length === 0 ? (
          <div className="rounded-lg border border-blue-500/20 bg-slate-900/55 px-4 py-6 text-sm text-slate-500">
            {configurationPending ? '尚未执行 AI 审核，因此没有知识库命中记录。' : '本次审核暂未命中专业知识库条款。'}
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {summaryKnowledgeHits.map(hit => (
              <div key={hit.id} className="rounded-lg border border-emerald-400/20 bg-slate-900/60 p-4">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="px-2 py-1 rounded text-xs border border-emerald-400/30 bg-emerald-500/10 text-emerald-300">{hit.clauseCode}</span>
                  <span className="px-2 py-1 rounded text-xs border border-blue-400/30 bg-blue-500/10 text-blue-200">{hit.profileName}</span>
                </div>
              <div className="font-semibold text-blue-100">{hit.title}</div>
              <p className="mt-2 text-sm text-slate-300 leading-6">{hit.content}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(hit.matchedKeywords || []).map(keyword => (
                  <span key={`${hit.id}-${keyword}`} className="px-2 py-1 rounded text-xs border border-blue-400/20 bg-slate-950/55 text-slate-300">
                    {keyword}
                  </span>
                ))}
              </div>
              {(hit.evidence || []).length > 0 && (
                <div className="mt-3 space-y-2">
                  {(hit.evidence || []).map((evidence, index) => (
                    <div key={`${hit.id}-summary-evidence-${index}`} className="rounded-lg border border-blue-500/15 bg-slate-950/60 px-3 py-2">
                      <div className="text-[11px] text-slate-500">{evidence.sourceType} · {evidence.sourceLabel}</div>
                      <p className="text-xs text-slate-300 mt-1 leading-5">{evidence.snippet}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      </Panel>

      <Panel className="p-5">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <CheckCircle2 size={18} className="text-emerald-300" />
          最终汇总意见
        </h2>
        {!reviewOutputAvailable ? (
          <div className="rounded-lg border border-amber-400/20 bg-amber-500/5 px-4 py-5 text-sm text-amber-100">
            暂无最终汇总意见。该方案当前仅保存原始标题和附件，完成 Profile 核验并发起 AI 审核后才会生成真实结论。
          </div>
        ) : (
        <div className="rounded-lg border border-blue-500/20 bg-slate-900/55 p-4">
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <span className="px-2 py-1 rounded text-xs border border-cyan-400/30 text-cyan-300 bg-cyan-500/10">{summary.result}</span>
            <span className="text-xs text-slate-500">生成时间：{summary.generatedAt}</span>
          </div>
          <p className="text-sm text-slate-200">{summary.finalOpinion}</p>
          {(summary.ruleMatches || []).length > 0 && (
            <div className="mt-4">
              <div className="text-sm font-medium text-slate-200 mb-2">启用规则校验</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {summary.ruleMatches.map(rule => (
                  <div key={rule.id} className={`rounded-lg border p-3 ${
                    rule.passed
                      ? 'border-emerald-400/20 bg-emerald-500/10'
                      : 'border-red-400/20 bg-red-500/10'
                  }`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className={rule.passed ? 'text-emerald-200' : 'text-red-200'}>{rule.name}</span>
                      <span className="text-xs text-slate-400">权重 {rule.weight}</span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">{rule.message}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {summary.mainRisks?.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-200 mb-2">
                <ShieldAlert size={16} className="text-amber-300" />
                主要风险
              </div>
              <ul className="space-y-2 text-sm text-slate-400">
                {summary.mainRisks.map(point => <li key={point}>· {point}</li>)}
              </ul>
            </div>
          )}
        </div>
        )}
      </Panel>
    </div>
  )
}
