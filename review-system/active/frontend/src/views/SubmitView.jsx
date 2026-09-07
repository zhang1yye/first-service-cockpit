import { useEffect, useId, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download, Send, Upload, FileText, X, Building2, BriefcaseBusiness } from '../lib/lucide.js'
import { api, downloadFile, getUser } from '../lib/api'
import { appBuildLabel, appBuildTime, appVersion } from '../lib/appVersion'
import { csvCell } from '../lib/csv'
import { hasPermission } from '../lib/permissions'
import { requestNotificationRefresh } from '../lib/notifications'
import { loadReportTools, preloadReportTools } from '../lib/reportPreload'
import { preloadRoute } from '../lib/routePreload'
import Panel from '../components/Panel'
import firstServiceLogo from '../assets/brand/first-service-logo-2026-transparent.png'

const controlFocusClass = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950'
const submissionControlClass = `rounded-lg border border-blue-500/25 bg-slate-900/80 px-3 py-2 text-sm text-white outline-none transition focus:border-blue-300/60 ${controlFocusClass}`
const proposalTitleMaxCodePoints = 120
const defaultUploadLimits = {
  maxUploadFiles: 12,
  maxFileSizeBytes: 20 * 1024 * 1024,
  maxTotalSizeBytes: 48 * 1024 * 1024,
  allowedExtensions: ['.pdf', '.docx', '.xlsx', '.csv', '.tsv', '.txt'],
  submissionMode: 'blocked',
  reviewReady: false,
  reviewReadinessMessage: '正在读取审核专业就绪状态。',
  activeProfileCount: 0
}

function formatFileSize(value = 0) {
  const size = Number(value) || 0
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)}MB`
  if (size >= 1024) return `${Math.round(size / 1024)}KB`
  return `${size}B`
}

function codePointLength(value = '') {
  return Array.from(String(value)).length
}

function clampCodePoints(value = '', maximum = proposalTitleMaxCodePoints) {
  return Array.from(String(value)).slice(0, maximum).join('')
}

export default function SubmitView() {
  const navigate = useNavigate()
  const canReview = hasPermission(getUser(), 'reviewProposal')
  const [title, setTitle] = useState('')
  const [type, setType] = useState('内部运营方案')
  const [description, setDescription] = useState('')
  const [files, setFiles] = useState([])
  const [reviewResult, setReviewResult] = useState(null)
  const [recentSubmissions, setRecentSubmissions] = useState([])
  const [loadingRecent, setLoadingRecent] = useState(true)
  const [recentLoadError, setRecentLoadError] = useState('')
  const [submissionStatusFilter, setSubmissionStatusFilter] = useState('全部')
  const [submissionTypeFilter, setSubmissionTypeFilter] = useState('全部')
  const [submissionScopeFilter, setSubmissionScopeFilter] = useState('全部')
  const [submissionKeyword, setSubmissionKeyword] = useState('')
  const [submissionSort, setSubmissionSort] = useState('最新提交')
  const [openingId, setOpeningId] = useState('')
  const [downloadingFileId, setDownloadingFileId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [exportingDoc, setExportingDoc] = useState(false)
  const [exportingPdf, setExportingPdf] = useState(false)
  const [uploadLimits, setUploadLimits] = useState(defaultUploadLimits)
  const [uploadLimitsError, setUploadLimitsError] = useState('')
  const proposalTypeGroupId = useId()
  const proposalTitleHelpId = useId()
  const proposalUploadHelpId = useId()

  const maxAttachmentCount = uploadLimits.maxUploadFiles || defaultUploadLimits.maxUploadFiles
  const maxAttachmentSize = uploadLimits.maxFileSizeBytes || defaultUploadLimits.maxFileSizeBytes
  const maxTotalAttachmentSize = uploadLimits.maxTotalSizeBytes || defaultUploadLimits.maxTotalSizeBytes
  const submissionMode = uploadLimits.submissionMode === 'ai-review' || uploadLimits.submissionMode === 'draft-only'
    ? uploadLimits.submissionMode
    : 'blocked'
  const draftOnly = submissionMode === 'draft-only'
  const reviewReady = uploadLimits.reviewReady === true
  const submissionAllowed = draftOnly || (submissionMode === 'ai-review' && reviewReady)
  const reviewReadinessMessage = uploadLimits.reviewReadinessMessage || '审核专业尚未就绪，请联系管理员完成定义核验。'
  const allowedAttachmentText = (uploadLimits.allowedExtensions || defaultUploadLimits.allowedExtensions)
    .map(item => String(item).replace('.', '').toUpperCase())
    .join('、')

  const loadRecentSubmissions = async () => {
    setLoadingRecent(true)
    try {
      const data = await api.get('/my-proposals')
      setRecentSubmissions(data.items || [])
      setRecentLoadError('')
    } catch {
      setRecentSubmissions([])
      setRecentLoadError('本人提交记录加载失败，当前显示为空值；请重试，勿将空值视为没有提交记录。')
    } finally {
      setLoadingRecent(false)
    }
  }

  useEffect(() => {
    loadRecentSubmissions()
    api.get('/upload-limits')
      .then(data => {
        setUploadLimits({
          maxUploadFiles: Number(data.maxUploadFiles) || defaultUploadLimits.maxUploadFiles,
          maxFileSizeBytes: Number(data.maxFileSizeBytes) || defaultUploadLimits.maxFileSizeBytes,
          maxTotalSizeBytes: Number(data.maxTotalSizeBytes) || defaultUploadLimits.maxTotalSizeBytes,
          allowedExtensions: Array.isArray(data.allowedExtensions) && data.allowedExtensions.length > 0
            ? data.allowedExtensions
            : defaultUploadLimits.allowedExtensions,
          submissionMode: data.submissionMode === 'ai-review' || data.submissionMode === 'draft-only'
            ? data.submissionMode
            : 'blocked',
          reviewReady: data.reviewReady === true,
          reviewReadinessMessage: String(data.reviewReadinessMessage || ''),
          activeProfileCount: Math.max(0, Number(data.activeProfileCount) || 0)
        })
        setUploadLimitsError('')
      })
      .catch(() => {
        setUploadLimits(defaultUploadLimits)
        setUploadLimitsError('未能读取上传与审核就绪状态，已安全禁用新提交；请刷新页面或联系管理员。')
      })
  }, [])

  const submissionStatusOptions = useMemo(
    () => ['全部', ...Array.from(new Set(recentSubmissions.map(item => item.status).filter(Boolean)))],
    [recentSubmissions]
  )
  const submissionTypeOptions = useMemo(
    () => ['全部', ...Array.from(new Set(recentSubmissions.map(item => item.type).filter(Boolean)))],
    [recentSubmissions]
  )
  const filteredSubmissions = useMemo(() => {
    const keyword = submissionKeyword.trim().toLowerCase()
    const matched = recentSubmissions.filter(item => {
      const statusMatched = submissionStatusFilter === '全部' || item.status === submissionStatusFilter
      const typeMatched = submissionTypeFilter === '全部' || item.type === submissionTypeFilter
      const scopeMatched = (
        submissionScopeFilter === '全部' ||
        (submissionScopeFilter === '含高风险' && Number(item.highRiskCount) > 0) ||
        (submissionScopeFilter === '带附件' && Number(item.fileCount) > 0)
      )
      const searchable = [item.title, item.type, item.status, item.result, item.createdAt].join(' ').toLowerCase()
      return statusMatched && typeMatched && scopeMatched && (!keyword || searchable.includes(keyword))
    })

    return [...matched].sort((a, b) => {
      if (submissionSort === '最早提交') return String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      if (submissionSort === '高风险优先') return (Number(b.highRiskCount) || 0) - (Number(a.highRiskCount) || 0)
      if (submissionSort === '评分最高') return (Number(b.avgScore) || 0) - (Number(a.avgScore) || 0)
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    })
  }, [recentSubmissions, submissionKeyword, submissionScopeFilter, submissionSort, submissionStatusFilter, submissionTypeFilter])
  const submissionSummary = useMemo(() => ({
    total: recentSubmissions.length,
    highRisk: recentSubmissions.filter(item => Number(item.highRiskCount) > 0).length,
    withFiles: recentSubmissions.filter(item => Number(item.fileCount) > 0).length
  }), [recentSubmissions])
  const submissionFiltersActive = submissionStatusFilter !== '全部' || submissionTypeFilter !== '全部' || submissionScopeFilter !== '全部' || Boolean(submissionKeyword.trim())
  const uploadLimitSummary = `支持 ${allowedAttachmentText}；最多 ${maxAttachmentCount} 个附件，单个不超过 ${formatFileSize(maxAttachmentSize)}，总量不超过 ${formatFileSize(maxTotalAttachmentSize)}`
  const submitActionLabel = submitting
    ? `${draftOnly ? '正在保存待配置草稿' : '正在提交审核'}《${title.trim() || '未填写标题'}》，已选择 ${files.length} 个附件`
    : `${draftOnly ? '保存待配置草稿' : '提交方案审核'}《${title.trim() || '未填写标题'}》，已选择 ${files.length} 个附件`
  const submissionFilterSummary = `范围：${submissionScopeFilter}；状态：${submissionStatusFilter}；类型：${submissionTypeFilter}；排序：${submissionSort}；关键词：${submissionKeyword.trim() || '无'}；结果数：${filteredSubmissions.length}`
  const reviewResultTitle = reviewResult?.title || reviewResult?.proposal?.title || title.trim() || '当前方案'
  const submissionResultSummary = `当前命中 ${filteredSubmissions.length} 条，本人提交 ${recentSubmissions.length} 条${submissionFiltersActive ? '，已应用筛选条件' : ''}`
  const submissionCardSummary = (item = {}) => (
    `方案《${item.title || '未命名方案'}》，类型 ${item.type || '未记录'}，状态 ${item.status || '未知'}，审核结论 ${item.result || '未生成'}，评分 ${item.avgScore == null ? '暂无评分' : item.avgScore}，高风险 ${item.highRiskCount || 0} 项，附件 ${item.fileCount || 0} 个，提交时间 ${item.createdAt || '未记录'}`
  )

  const resetSubmissionFilters = () => {
    setSubmissionStatusFilter('全部')
    setSubmissionTypeFilter('全部')
    setSubmissionScopeFilter('全部')
    setSubmissionKeyword('')
  }

  const handleFileChange = (e) => {
    const selected = Array.from(e.target.files || [])
    e.target.value = ''
    if (selected.length === 0) return
    if (!submissionAllowed) {
      setError(reviewReadinessMessage)
      setSuccess('')
      return
    }

    const oversized = selected.filter(file => file.size > maxAttachmentSize)
    if (oversized.length > 0) {
      setError(`以下附件超过 ${formatFileSize(maxAttachmentSize)}：${oversized.slice(0, 3).map(file => file.name).join('、')}${oversized.length > 3 ? ' 等' : ''}`)
      setSuccess('')
      return
    }

    setFiles(prev => {
      const nextTotalSize = [...prev, ...selected].reduce((sum, file) => sum + (Number(file.size) || 0), 0)
      if (nextTotalSize > maxTotalAttachmentSize) {
        setError(`附件总量不能超过 ${formatFileSize(maxTotalAttachmentSize)}，请移除部分文件后重试。`)
        setSuccess('')
        return prev
      }
      const remainingSlots = maxAttachmentCount - prev.length
      if (remainingSlots <= 0) {
        setError(`最多上传 ${maxAttachmentCount} 个附件，请先移除部分文件后再添加。`)
        setSuccess('')
        return prev
      }
      if (selected.length > remainingSlots) {
        setError(`最多上传 ${maxAttachmentCount} 个附件，本次仅加入前 ${remainingSlots} 个。`)
        setSuccess('')
      } else {
        setError('')
      }
      return [...prev, ...selected.slice(0, remainingSlots)]
    })
  }

  const removeFile = (idx) => setFiles(prev => prev.filter((_, i) => i !== idx))

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!submissionAllowed) return setError(reviewReadinessMessage)
    const trimmedTitle = title.trim()
    const titleCodePoints = codePointLength(trimmedTitle)
    if (titleCodePoints < 2) return setError('方案标题不能少于 2 个字')
    if (titleCodePoints > proposalTitleMaxCodePoints) return setError(`方案标题不能超过 ${proposalTitleMaxCodePoints} 个字`)
    setError('')
    setSuccess('')
    setReviewResult(null)
    setSubmitting(true)
    try {
      const form = new FormData()
      form.append('title', trimmedTitle)
      form.append('type', type)
      form.append('description', description.trim())
      files.forEach(f => form.append('files', f))
      const result = await api.post('/proposals', form)
      setReviewResult(result)
      const latestAiTrace = Array.isArray(result.aiReviewTrace) ? result.aiReviewTrace[0] : null
      const hasTrustedAiResult = latestAiTrace?.status === 'success' && latestAiTrace?.fallback !== true && ['hermes-agent', 'external'].includes(latestAiTrace?.mode)
      setSuccess(result.status === '待专业配置'
        ? '待配置草稿已安全保存；本次未调用 AI，也未生成评分、专业意见或立项结论。'
        : hasTrustedAiResult
          ? '方案提交成功，已收到真实 AI 审核结果。'
          : '方案提交成功；当前未生成可信 AI 评分，已转入人工复核。')
      setTitle('')
      setDescription('')
      setFiles([])
      await loadRecentSubmissions()
      requestNotificationRefresh()
    } catch (err) {
      setError(err.message || '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  const openRecentSubmission = async (proposalId) => {
    setOpeningId(proposalId)
    setError('')
    setSuccess('')
    try {
      const item = await api.get(`/my-proposals/${proposalId}`)
      setReviewResult(item)
      setSuccess('已打开本人提交方案的审核结果。')
    } catch (err) {
      setError(err.message || '打开提交记录失败')
    } finally {
      setOpeningId('')
    }
  }

  const exportOptions = {
    appVersion,
    logoUrl: firstServiceLogo
  }

  const recordExportEvent = async (proposalId, type) => {
    await api.post(`/proposals/${proposalId}/export-events`, {
      type,
      appVersion,
      appBuildTime,
      appBuildLabel,
      source: 'submit'
    })
  }

  const exportDoc = async () => {
    if (!reviewResult) return
    setExportingDoc(true)
    setError('')
    try {
      const { downloadReviewReport } = await loadReportTools()
      await downloadReviewReport(reviewResult, exportOptions)
      await recordExportEvent(reviewResult.id, 'word')
    } catch (err) {
      setError(err.message || '意见书导出失败')
    } finally {
      setExportingDoc(false)
    }
  }

  const exportPdf = async () => {
    if (!reviewResult) return
    setExportingPdf(true)
    setError('')
    try {
      const { printReviewReportPdf } = await loadReportTools()
      await printReviewReportPdf(reviewResult, exportOptions)
      await recordExportEvent(reviewResult.id, 'pdf')
    } catch (err) {
      setError(err.message || 'PDF 导出失败')
    } finally {
      setExportingPdf(false)
    }
  }

  const downloadAttachment = async (file) => {
    if (!reviewResult || !file?.id) return
    setDownloadingFileId(file.id)
    setError('')
    try {
      await downloadFile(`/my-proposals/${reviewResult.id}/files/${file.id}`, file.name)
    } catch (err) {
      setError(err.message || '附件下载失败')
    } finally {
      setDownloadingFileId('')
    }
  }

  const exportMySubmissions = () => {
    if (filteredSubmissions.length === 0) return
    const header = ['方案名称', '方案类型', '状态', '审核结论', '综合评分', '高风险项', '附件数', '提交人', '提交账号', '提交时间', '更新时间']
    const rows = filteredSubmissions.map(item => [
      item.title,
      item.type,
      item.status,
      item.result,
      item.avgScore ?? '暂无评分',
      item.highRiskCount || 0,
      item.fileCount || 0,
      item.submitter,
      item.submitterUsername,
      item.createdAt,
      item.updatedAt
    ])
    const csv = [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n')
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `我的提交-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      <Panel className="p-5">
        <div className="mb-5">
          <h1 className="text-xl font-bold text-blue-200 mb-1">方案提交</h1>
          <p className="text-sm text-slate-400">已核验专业就绪后进入 AI 审核；核验尚未完成时仍可保存待配置草稿，但不会生成评分、意见或立项结论。</p>
        </div>

        <div role={submissionAllowed ? 'status' : 'alert'} className={`mb-5 rounded-lg border px-4 py-3 text-sm ${reviewReady ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100' : draftOnly ? 'border-amber-400/30 bg-amber-500/10 text-amber-100' : 'border-red-400/30 bg-red-500/10 text-red-100'}`}>
          <div className="font-medium">
            {reviewReady
              ? `审核链路已就绪：${uploadLimits.activeProfileCount} 个已核验专业`
              : draftOnly
                ? '当前为待配置草稿模式'
                : '当前不能保存新方案'}
          </div>
          <div className="mt-1 text-xs opacity-90">
            {reviewReady
              ? '附件会在服务端完成资源限制和隔离解析后进入审核。'
              : reviewReadinessMessage}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 max-w-3xl">
          <div>
            <div id={proposalTypeGroupId} className="text-sm text-slate-300 mb-2">方案类型</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3" role="radiogroup" aria-labelledby={proposalTypeGroupId}>
              {[
                ['内部运营方案', Building2, draftOnly ? '先保存方案与附件；专业定义完成核验后再由人工发起审核。' : '按当前已核验专业并行审核，形成汇总意见。'],
                ['市场拓展方案', BriefcaseBusiness, draftOnly ? '先保存项目资料；本次不生成立项报告或专业意见。' : '由已核验的立项牵头专业先出立项报告，再进入专业并行审核。']
              ].map(([item, Icon, desc]) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setType(item)}
                  role="radio"
                  aria-checked={type === item}
                  className={`text-left rounded-lg border p-4 transition ${
                    type === item
                      ? 'border-blue-400/70 bg-blue-600/20 text-white shadow-cyan'
                      : 'border-blue-500/20 bg-slate-900/55 text-slate-300 hover:border-blue-400/40'
                  }`}
                >
                  <div className="flex items-center gap-3 font-semibold">
                    <Icon size={20} className="text-cyan-300" aria-hidden="true" />
                    {item}
                  </div>
                  <p className="text-xs text-slate-400 mt-2 leading-5">{desc}</p>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="proposal-title" className="text-sm text-slate-300 mb-1.5 block">方案标题 *</label>
            <input
              id="proposal-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(clampCodePoints(e.target.value))}
              aria-label={`方案标题，必填，2 至 ${proposalTitleMaxCodePoints} 个字，当前 ${codePointLength(title.trim())} 个字`}
              aria-describedby={proposalTitleHelpId}
              required
              minLength={2}
              className="w-full px-4 py-3 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-400/60 focus:ring-1 focus:ring-blue-400/30 transition"
              placeholder="请输入方案标题"
            />
            <div id={proposalTitleHelpId} className="mt-1.5 text-xs text-slate-500">2 至 {proposalTitleMaxCodePoints} 个字，当前 {codePointLength(title.trim())} 个字。{draftOnly ? '保存后将作为待配置草稿的主标题。' : '提交后将作为审核流转和导出意见书的主标题。'}</div>
          </div>

          <div>
            <label htmlFor="proposal-description" className="text-sm text-slate-300 mb-1.5 block">方案说明</label>
            <textarea
              id="proposal-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              aria-label={`方案说明，当前方案类型为${type}`}
              className="w-full px-4 py-3 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-400/60 focus:ring-1 focus:ring-blue-400/30 transition resize-none"
              placeholder={type === '市场拓展方案' ? '请说明项目位置、招标范围、合同周期、测算口径等信息' : '请说明运营目标、涉及项目、资源需求、执行周期等信息'}
            />
          </div>

          <div>
            <label htmlFor="proposal-files" className="text-sm text-slate-300 mb-1.5 block">附件文件（可上传多个）</label>
            <label
              htmlFor="proposal-files"
              className="flex items-center gap-2 px-4 py-3 rounded-lg border border-dashed border-blue-500/30 bg-slate-900/40 text-slate-400 cursor-pointer hover:border-blue-400/50 transition"
              title={`选择附件文件，${uploadLimitSummary}`}
            >
              <Upload size={18} aria-hidden="true" />
              <span className="text-sm">{type === '市场拓展方案' ? '上传招标文件、测算表、报价文件，可多选' : '上传方案正文、制度依据、预算附件，可多选'}</span>
              <input
                id="proposal-files"
                type="file"
                multiple
                disabled={!submissionAllowed}
                className="hidden"
                onChange={handleFileChange}
                accept=".pdf,.docx,.xlsx,.csv,.tsv,.txt"
                aria-label={`选择方案附件文件，${uploadLimitSummary}`}
                aria-describedby={proposalUploadHelpId}
              />
            </label>
            <div id={proposalUploadHelpId} className="mt-1.5 text-xs text-slate-500">
              支持 {allowedAttachmentText}；最多 {maxAttachmentCount} 个附件，单个不超过 {formatFileSize(maxAttachmentSize)}，总量不超过 {formatFileSize(maxTotalAttachmentSize)}；不支持旧版 DOC/XLS。
            </div>
            {uploadLimitsError && (
              <div role="status" className="mt-2 rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                {uploadLimitsError}
              </div>
            )}
            {files.length > 0 && (
              <div className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-slate-300 bg-slate-900/60 px-3 py-1.5 rounded">
                    <FileText size={14} aria-hidden="true" className="text-blue-400 shrink-0" />
                    <span className="flex-1 truncate">{f.name}</span>
                    <span className="text-xs text-slate-500 whitespace-nowrap">{formatFileSize(f.size)}</span>
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      title={`移除附件 ${f.name}`}
                      aria-label={`移除附件 ${f.name}，大小 ${formatFileSize(f.size)}`}
                      className="text-slate-500 hover:text-red-400"
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && <div role="alert" className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2">{error}</div>}
          {success && <div role="status" aria-live="polite" className="text-sm text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-2">{success}</div>}

          <button
            type="submit"
            disabled={submitting || !submissionAllowed}
            title={submitActionLabel}
            aria-label={submitActionLabel}
            className="flex items-center gap-2 px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition border border-blue-400/40 shadow-cyan"
          >
            {submitting ? (
              <><span className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />{draftOnly ? '保存中...' : '提交中...'}</>
            ) : (
              <><Send size={18} aria-hidden="true" />{draftOnly ? '保存待配置草稿' : '提交方案审核'}</>
            )}
          </button>
        </form>
      </Panel>

      <Panel className="p-5">
        <div className="mb-4">
          <div>
            <h2 className="text-lg font-semibold text-blue-100">我的提交</h2>
            <p className="text-sm text-slate-400 mt-1">仅显示当前账号本人提交的方案，可搜索筛选、重新打开审核结果并导出意见书。</p>
          </div>
        </div>

        <div className="mb-4 grid grid-cols-1 overflow-hidden rounded-lg border border-blue-500/15 bg-slate-950/35 md:grid-cols-3">
          <button type="button" aria-pressed={submissionScopeFilter === '全部'} aria-label={`筛选本人全部提交，共 ${submissionSummary.total} 条`} title={`筛选本人全部提交，共 ${submissionSummary.total} 条`} onClick={() => setSubmissionScopeFilter('全部')} className={`border-b px-4 py-3 text-left transition md:border-b-0 md:border-r ${controlFocusClass} ${submissionScopeFilter === '全部' ? 'border-blue-300/45 bg-blue-500/10' : 'border-blue-500/10 hover:bg-blue-500/5'}`}>
            <div className="text-xs text-slate-500">本人提交</div>
            <div className="mt-1 text-xl font-bold text-blue-100">{submissionSummary.total}</div>
          </button>
          <button type="button" aria-pressed={submissionScopeFilter === '含高风险'} aria-label={`筛选含高风险提交，共 ${submissionSummary.highRisk} 条`} title={`筛选含高风险提交，共 ${submissionSummary.highRisk} 条`} onClick={() => setSubmissionScopeFilter('含高风险')} className={`border-b px-4 py-3 text-left transition md:border-b-0 md:border-r ${controlFocusClass} ${submissionScopeFilter === '含高风险' ? 'border-red-300/45 bg-red-500/10' : 'border-blue-500/10 hover:bg-red-500/5'}`}>
            <div className="text-xs text-slate-500">含高风险</div>
            <div className="mt-1 text-xl font-bold text-red-200">{submissionSummary.highRisk}</div>
          </button>
          <button type="button" aria-pressed={submissionScopeFilter === '带附件'} aria-label={`筛选带附件提交，共 ${submissionSummary.withFiles} 条`} title={`筛选带附件提交，共 ${submissionSummary.withFiles} 条`} onClick={() => setSubmissionScopeFilter('带附件')} className={`px-4 py-3 text-left transition ${controlFocusClass} ${submissionScopeFilter === '带附件' ? 'bg-emerald-500/10' : 'hover:bg-emerald-500/5'}`}>
            <div className="text-xs text-slate-500">带附件</div>
            <div className="mt-1 text-xl font-bold text-emerald-200">{submissionSummary.withFiles}</div>
          </button>
        </div>

        <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[160px_160px_160px_minmax(260px,1fr)_auto]">
          <select
            aria-label="按提交状态筛选"
            value={submissionStatusFilter}
            onChange={e => setSubmissionStatusFilter(e.target.value)}
            className={submissionControlClass}
          >
            {submissionStatusOptions.map(option => <option key={option} value={option}>{option === '全部' ? '全部状态' : option}</option>)}
          </select>
          <select
            aria-label="按方案类型筛选"
            value={submissionTypeFilter}
            onChange={e => setSubmissionTypeFilter(e.target.value)}
            className={submissionControlClass}
          >
            {submissionTypeOptions.map(option => <option key={option} value={option}>{option === '全部' ? '全部类型' : option}</option>)}
          </select>
          <select
            aria-label="提交记录排序方式"
            value={submissionSort}
            onChange={e => setSubmissionSort(e.target.value)}
            className={submissionControlClass}
          >
            {['最新提交', '最早提交', '高风险优先', '评分最高'].map(option => <option key={option} value={option}>{option}</option>)}
          </select>
          <input
            aria-label="搜索本人提交记录"
            value={submissionKeyword}
            onChange={e => setSubmissionKeyword(e.target.value)}
            className={`${submissionControlClass} placeholder-slate-500 md:col-span-2 xl:col-span-1`}
            placeholder="搜索标题、类型、结论或提交时间"
          />
          <div aria-label="提交记录操作" className="flex flex-wrap gap-2 md:col-span-2 xl:col-span-1 xl:flex-nowrap xl:justify-end">
            <button
              type="button"
              onClick={resetSubmissionFilters}
              disabled={!submissionFiltersActive}
              title={submissionFiltersActive ? `重置提交记录筛选：${submissionFilterSummary}` : '当前没有启用提交记录筛选'}
              aria-label={submissionFiltersActive ? `重置提交记录筛选，当前筛选：${submissionFilterSummary}` : '当前没有启用提交记录筛选'}
              className={`rounded-lg border border-slate-500/30 bg-slate-900/70 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-300/45 disabled:opacity-50 ${controlFocusClass}`}
            >
              重置筛选
            </button>
            <button type="button" onClick={exportMySubmissions} disabled={filteredSubmissions.length === 0} title={`导出当前 ${filteredSubmissions.length} 条提交记录，${submissionFilterSummary}`} aria-label={`导出当前 ${filteredSubmissions.length} 条提交记录，筛选条件：${submissionFilterSummary}`} className={`inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-400/30 bg-slate-900/70 px-3 py-2 text-sm text-emerald-100 transition hover:border-emerald-300/55 disabled:opacity-50 ${controlFocusClass}`}>
              <Download size={15} aria-hidden="true" />
              导出
            </button>
            <button type="button" onClick={loadRecentSubmissions} disabled={loadingRecent} title={loadingRecent ? '正在刷新本人提交记录' : '刷新本人提交记录'} aria-label={loadingRecent ? '正在刷新本人提交记录' : '刷新本人提交记录'} className={`rounded-lg border border-blue-400/30 bg-slate-900/70 px-3 py-2 text-sm text-blue-100 transition hover:border-blue-300/55 disabled:opacity-50 ${controlFocusClass}`}>
              {loadingRecent ? '刷新中' : '刷新'}
            </button>
          </div>
        </div>
        <div className="mb-4 text-xs text-slate-500" role="status" aria-live="polite">
          {submissionResultSummary}
        </div>

        {recentLoadError && (
          <div role="alert" className="mb-4 rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {recentLoadError}
          </div>
        )}

        {recentSubmissions.length === 0 ? (
          <div className="rounded-lg border border-blue-500/15 bg-slate-950/45 px-4 py-6 text-sm text-slate-500">
            {loadingRecent ? '正在加载提交记录...' : recentLoadError ? '提交记录暂不可用，请点击“刷新”重试' : '暂无本人提交记录'}
          </div>
        ) : filteredSubmissions.length === 0 ? (
          <div className="rounded-lg border border-blue-500/15 bg-slate-950/45 px-4 py-6 text-sm text-slate-500">
            当前筛选下没有匹配的提交记录
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3" role="list" aria-label={`我的提交列表，${submissionResultSummary}，筛选条件：${submissionFilterSummary}`}>
            {filteredSubmissions.map(item => (
              <article
                key={item.id}
                role="listitem"
                aria-label={submissionCardSummary(item)}
                title={submissionCardSummary(item)}
                className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4 transition hover:border-blue-300/35"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-blue-100">{item.title}</div>
                    <div className="mt-1 text-xs text-slate-500">{item.type} · {item.createdAt}</div>
                    {item.submitterUsername && <div className="mt-1 text-xs text-slate-600">提交账号：{item.submitterUsername}</div>}
                  </div>
                  <span className="shrink-0 rounded-md border border-cyan-400/25 bg-cyan-500/10 px-2 py-0.5 text-xs text-cyan-100">{item.status}</span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded-md border border-blue-500/15 bg-slate-950/45 px-2 py-2">
                    <div className="text-slate-500">评分</div>
                    <div className="mt-1 text-base font-semibold text-cyan-200">{item.avgScore == null ? '暂无' : item.avgScore}</div>
                  </div>
                  <div className="rounded-md border border-blue-500/15 bg-slate-950/45 px-2 py-2">
                    <div className="text-slate-500">风险</div>
                    <div className="mt-1 text-base font-semibold text-red-200">{item.highRiskCount || 0}</div>
                  </div>
                  <div className="rounded-md border border-blue-500/15 bg-slate-950/45 px-2 py-2">
                    <div className="text-slate-500">附件</div>
                    <div className="mt-1 text-base font-semibold text-emerald-200">{item.fileCount || 0}</div>
                  </div>
                </div>
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => openRecentSubmission(item.id)}
                    disabled={openingId === item.id}
                    title={`${openingId === item.id ? '正在打开' : '查看'}方案《${item.title || '未命名方案'}》${item.status === '待专业配置' ? '待配置草稿' : '审核结果'}`}
                    aria-label={`${openingId === item.id ? '正在打开' : '查看'}方案《${item.title || '未命名方案'}》${item.status === '待专业配置' ? '待配置草稿' : '审核结果'}，状态 ${item.status || '未知'}，评分 ${item.avgScore == null ? '暂无评分' : item.avgScore}，高风险 ${item.highRiskCount || 0} 项`}
                    className={`rounded-md border border-blue-400/25 bg-slate-950/45 px-3 py-1.5 text-xs text-blue-100 transition hover:border-blue-300/50 disabled:opacity-50 ${controlFocusClass}`}
                  >
                    {openingId === item.id ? '打开中...' : item.status === '待专业配置' ? '查看草稿' : '查看结果'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>

      {reviewResult?.status === '待专业配置' && (
        <Panel className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-blue-100">待配置草稿已保存</h2>
              <p className="mt-1 text-sm text-slate-400">《{reviewResultTitle}》已保存业务原文与附件；本次未调用 AI，也没有生成评分、专业意见或立项结论。</p>
            </div>
            {canReview && (
              <button
                type="button"
                onClick={() => navigate(`/review/${reviewResult.id}`)}
                onFocus={() => preloadRoute('/review/:id')}
                onMouseEnter={() => preloadRoute('/review/:id')}
                className="rounded-lg border border-blue-300/40 bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500"
              >
                查看草稿详情
              </button>
            )}
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            {[
              ['当前状态', reviewResult.status],
              ['审核专业', reviewResult.robot || '待配置审核 Profile'],
              ['附件', `${reviewResult.files?.length || 0} 个`]
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-amber-400/20 bg-amber-500/10 p-3">
                <div className="text-xs text-slate-500">{label}</div>
                <div className="mt-1 text-sm font-semibold text-amber-100">{value}</div>
              </div>
            ))}
          </div>
          {reviewResult.files?.length > 0 && (
            <div className="mt-4 rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
              <div className="text-sm font-medium text-blue-100">已保存附件</div>
              <div className="mt-3 space-y-2">
                {reviewResult.files.map(file => (
                  <div key={file.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-500/15 bg-slate-950/45 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 break-all text-slate-300">{file.name}</span>
                    <button
                      type="button"
                      onClick={() => downloadAttachment(file)}
                      disabled={downloadingFileId === file.id}
                      className="rounded-md border border-blue-400/30 px-3 py-1.5 text-xs text-blue-100 disabled:opacity-50"
                    >
                      {downloadingFileId === file.id ? '下载中...' : '下载核对'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Panel>
      )}

      {reviewResult && reviewResult.status !== '待专业配置' && (
        <Panel className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-semibold text-blue-100">审核意见已生成</h2>
              <p className="text-sm text-slate-400 mt-1">{reviewResult.summary?.finalOpinion}</p>
            </div>
            <div className="flex gap-2">
              {canReview && (
                <button
                  type="button"
                  onClick={() => navigate(`/review/${reviewResult.id}`)}
                  onFocus={() => preloadRoute('/review/:id')}
                  onMouseEnter={() => preloadRoute('/review/:id')}
                  title={`查看方案《${reviewResultTitle}》审核详情`}
                  aria-label={`查看方案《${reviewResultTitle}》审核详情`}
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm border border-blue-300/40"
                >
                  查看详情
                </button>
              )}
              <button type="button" onClick={exportDoc} onFocus={preloadReportTools} onMouseEnter={preloadReportTools} disabled={exportingDoc} title={`${exportingDoc ? '正在导出' : '导出'}方案《${reviewResultTitle}》Word 意见书`} aria-label={`${exportingDoc ? '正在导出' : '导出'}方案《${reviewResultTitle}》Word 意见书`} className="flex items-center gap-2 px-4 py-2 rounded-lg border border-emerald-300/40 bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-50 text-sm text-emerald-100">
                <Download size={16} aria-hidden="true" />
                {exportingDoc ? '导出中...' : '导出 Word 意见书'}
              </button>
              <button type="button" onClick={exportPdf} onFocus={preloadReportTools} onMouseEnter={preloadReportTools} disabled={exportingPdf} title={`${exportingPdf ? '正在生成' : '导出'}方案《${reviewResultTitle}》PDF 意见书`} aria-label={`${exportingPdf ? '正在生成' : '导出'}方案《${reviewResultTitle}》PDF 意见书`} className="flex items-center gap-2 px-4 py-2 rounded-lg border border-cyan-300/40 bg-cyan-500/15 hover:bg-cyan-500/25 disabled:opacity-50 text-sm text-cyan-100">
                <FileText size={16} aria-hidden="true" />
                {exportingPdf ? '生成中...' : '导出 PDF'}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-3">
              <div className="text-xs text-slate-400">综合评分</div>
              <div className="text-2xl font-bold text-cyan-200">{reviewResult.summary?.avgScore == null ? '暂无评分' : reviewResult.summary.avgScore}</div>
            </div>
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-3">
              <div className="text-xs text-slate-400">最终结论</div>
              <div className="text-lg font-semibold text-blue-100">{reviewResult.summary?.result}</div>
            </div>
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-3">
              <div className="text-xs text-slate-400">高风险项</div>
              <div className="text-2xl font-bold text-red-300">{reviewResult.summary?.riskCount?.high || 0}</div>
            </div>
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-3">
              <div className="text-xs text-slate-400">命中条款</div>
              <div className="text-2xl font-bold text-emerald-300">{reviewResult.summary?.knowledgeHitCount || 0}</div>
            </div>
          </div>

          <div className="mb-4 grid grid-cols-1 xl:grid-cols-3 gap-3">
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
              <div className="text-sm font-medium text-blue-100">处理进度</div>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 xl:grid-cols-1 gap-2">
                {[
                  ['人工复核', reviewResult.manualReview?.conclusion ? '已复核' : '待复核', reviewResult.manualReview?.reviewedAt || ''],
                  ['签发', reviewResult.executionRecord?.signOff?.status || '待签发', reviewResult.executionRecord?.signOff?.signedAt || ''],
                  ['归档', reviewResult.executionRecord?.archive?.status || '待归档', reviewResult.executionRecord?.archive?.archivedAt || '']
                ].map(([label, status, at]) => (
                  <div key={label} className="rounded-md border border-blue-500/15 bg-slate-950/45 px-3 py-2">
                    <div className="text-xs text-slate-500">{label}</div>
                    <div className="mt-1 text-sm font-semibold text-blue-100">{status}</div>
                    {at && <div className="mt-1 text-xs text-slate-500">{at}</div>}
                  </div>
                ))}
              </div>
            </div>

            <div className="xl:col-span-2 rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
              <div className="text-sm font-medium text-blue-100">最近流转</div>
              {reviewResult.timeline?.length > 0 ? (
                <div className="mt-3 space-y-2">
                  {reviewResult.timeline.slice(0, 5).map(item => (
                    <div key={item.id || `${item.action}-${item.at}`} className="rounded-md border border-blue-500/15 bg-slate-950/45 px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm text-blue-100">{item.action}</div>
                        <div className="text-xs text-slate-500">{item.at}</div>
                      </div>
                      <div className="mt-1 text-xs leading-5 text-slate-400">{item.actor || '系统'} · {item.detail || '已记录流程动作'}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3 rounded-md border border-blue-500/15 bg-slate-950/45 px-3 py-6 text-sm text-slate-500">暂无流转记录</div>
              )}
            </div>
          </div>

          {reviewResult.summary?.mainRisks?.length > 0 && (
            <div className="mb-4">
              <div className="text-sm font-medium text-slate-200 mb-2">主要风险</div>
              <ul className="space-y-2 text-sm text-slate-400">
                {reviewResult.summary.mainRisks.map(item => <li key={item}>· {item}</li>)}
              </ul>
            </div>
          )}

          {reviewResult.summary?.knowledgeHits?.length > 0 && (
            <div className="mb-4">
              <div className="text-sm font-medium text-slate-200 mb-2">命中条款摘要</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {reviewResult.summary.knowledgeHits.map(hit => (
                  <div key={hit.id} className="rounded-lg border border-emerald-400/20 bg-emerald-500/5 px-3 py-2">
                    <div className="text-sm text-blue-100">{hit.clauseCode} {hit.title}</div>
                    <div className="text-xs text-slate-400 mt-1">{hit.profileName}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {reviewResult.files?.length > 0 && (
            <div className="mb-4">
              <div className="text-sm font-medium text-slate-200 mb-2">本人上传附件</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {reviewResult.files.map(file => (
                  <div key={file.id || file.name} className="flex items-center gap-3 rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-2">
                    <FileText size={16} className="shrink-0 text-blue-300" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-blue-100">{file.name}</div>
                      <div className="mt-0.5 text-xs text-slate-500">{file.extractionStatus || '未解析'}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => downloadAttachment(file)}
                      disabled={!file.storedName || downloadingFileId === file.id}
                      title={file.storedName ? `${downloadingFileId === file.id ? '正在下载' : '下载'}附件 ${file.name}` : `附件 ${file.name} 仅保留历史记录，无法下载`}
                      aria-label={file.storedName ? `${downloadingFileId === file.id ? '正在下载' : '下载'}附件 ${file.name}，解析状态 ${file.extractionStatus || '未解析'}` : `附件 ${file.name} 仅保留历史记录，无法下载`}
                      className="shrink-0 rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-100 disabled:opacity-50"
                    >
                      {downloadingFileId === file.id ? '下载中...' : file.storedName ? '下载' : '仅历史记录'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            {(reviewResult.opinions || []).map(opinion => (
              <div key={opinion.profileId} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium text-blue-100 truncate">{opinion.name}</div>
                  <span className="text-sm text-cyan-200">{opinion.score}</span>
                </div>
                <div className="text-xs text-slate-400 mt-2 line-clamp-2">{opinion.conclusion}</div>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  )
}
