export function formatValue(value, unit = '', digits = 2) {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return '—'
  const numeric = Number(value)
  return `${numeric.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}${unit}`
}

export function issueTone(severity) {
  return ({ critical: 'danger', high: 'warning', medium: 'info', low: 'neutral' })[severity] || 'neutral'
}

export function roleLabel(role) {
  return ({ admin: '系统管理员', region_manager: '地区负责人', area_manager: '片区负责人', project_manager: '项目负责人', viewer: '只读用户' })[role] || role || '未知角色'
}

export function sourceFreshnessLabel(source) {
  if (!source) return '不可用'
  if (source.freshness === 'stale' || source.health === 'danger' || source.status === '异常') return '已过期'
  if (source.freshness === 'fresh' || source.health === 'ok' || ['正常', 'connected'].includes(source.status)) return '正常'
  if (source.freshness === 'warning' || source.health === 'warning') return '需关注'
  return source.status || '待检测'
}

export function dateTime(value) {
  if (!value) return '—'
  const date = new Date(String(value).replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function freshnessMeta(value, nowValue = Date.now()) {
  if (!value) return { label: '时效未知', tone: 'neutral', ageDays: null }
  const timestamp = new Date(String(value).replace(' ', 'T')).getTime()
  const now = new Date(nowValue).getTime()
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return { label: '时效未知', tone: 'neutral', ageDays: null }
  const ageDays = Math.max(0, Math.floor((now - timestamp) / 86400000))
  if (ageDays === 0) return { label: '今日更新', tone: 'success', ageDays }
  if (ageDays <= 3) return { label: `${ageDays}天前`, tone: 'warning', ageDays }
  return { label: `${ageDays}天前·已过期`, tone: 'danger', ageDays }
}

export function compactSyncRuns(rows = []) {
  const result = []
  const indexBySignature = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const finishedMinute = String(row?.finished_at || '').replace('T', ' ').slice(0, 16)
    const signature = [
      row?.source_name,
      row?.run_type,
      row?.status,
      row?.health,
      row?.message,
      row?.operator,
      finishedMinute,
    ].map(value => String(value ?? '').trim()).join('\u0001')
    const existingIndex = indexBySignature.get(signature)
    if (existingIndex !== undefined) {
      result[existingIndex].repeat_count += 1
      continue
    }
    indexBySignature.set(signature, result.length)
    result.push({ ...row, repeat_count: 1 })
  }
  return result
}

export function safeJson(value, fallback = []) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value
  try { return JSON.parse(value || '') } catch { return fallback }
}

const WORKFLOW_LABELS = { pending: '待处理', claimed: '已认领', in_progress: '处理中', review: '待复核', resolved: '已解决' }
const WORKFLOW_ACTIONS = {
  pending: { status: 'claimed', label: '认领' },
  claimed: { status: 'in_progress', label: '开始处理' },
  in_progress: { status: 'review', label: '提交复核', requiresNote: true },
  review: { status: 'resolved', label: '确认解决', requiresNote: true },
}

export function workflowLabel(status) {
  return WORKFLOW_LABELS[status] || status || '待处理'
}

export function nextWorkflowAction(status) {
  return WORKFLOW_ACTIONS[status] ? { ...WORKFLOW_ACTIONS[status] } : null
}

export function reconciliationLabel(status) {
  return ({ matched: '已勾稽', warning: '有差异', unavailable: '不可勾稽' })[status] || status || '不可勾稽'
}

export function publicationStatusLabel(code) {
  return ({
    complete: '已完整发布',
    partial: '部分更新',
    failed: '更新失败',
    running: '正在更新',
    not_started: '尚未触发',
    unknown: '结果未知',
  })[code] || '结果未知'
}

export function qualityTimingTone(timing) {
  if (timing?.isOverdue) return 'danger'
  if (timing?.isDueSoon) return 'warning'
  return 'neutral'
}
