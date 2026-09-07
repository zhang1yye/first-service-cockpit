export type QualityWorkflowStatus = 'pending' | 'claimed' | 'in_progress' | 'review' | 'resolved'
export type QualitySeverity = 'critical' | 'high' | 'medium' | 'low' | string

const NEXT: Record<QualityWorkflowStatus, QualityWorkflowStatus | null> = {
  pending: 'claimed',
  claimed: 'in_progress',
  in_progress: 'review',
  review: 'resolved',
  resolved: null,
}

const LABELS: Record<QualityWorkflowStatus, string> = {
  pending: '待处理',
  claimed: '已认领',
  in_progress: '处理中',
  review: '待复核',
  resolved: '已解决',
}

const SLA_DAYS: Record<string, number> = {
  critical: 1,
  high: 3,
  medium: 7,
  low: 10,
}

function dateOnly(value: unknown): string | null {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const parsed = new Date(`${text}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? null : text
}

export function isQualityWorkflowStatus(value: unknown): value is QualityWorkflowStatus {
  return typeof value === 'string' && value in NEXT
}

export function nextQualityStatus(status: QualityWorkflowStatus): QualityWorkflowStatus | null {
  return NEXT[status]
}

export function defaultQualitySlaDays(severity: QualitySeverity): number {
  return SLA_DAYS[String(severity || '').toLowerCase()] ?? SLA_DAYS.medium
}

export function suggestQualityDueDate(startDate: string, severity: QualitySeverity): string {
  const normalized = dateOnly(startDate)
  if (!normalized) throw new Error('起始日期必须为YYYY-MM-DD')
  const value = new Date(`${normalized}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + defaultQualitySlaDays(severity))
  return value.toISOString().slice(0, 10)
}

export function qualityCaseTiming(
  row: { workflow_status?: unknown; due_date?: unknown },
  today = new Date().toISOString().slice(0, 10),
): { dueDate: string | null; daysRemaining: number | null; isOverdue: boolean; isDueSoon: boolean; timingLabel: string } {
  const dueDate = dateOnly(row?.due_date)
  const currentDate = dateOnly(today)
  if (!dueDate || !currentDate) return { dueDate, daysRemaining: null, isOverdue: false, isDueSoon: false, timingLabel: '待确定' }
  const daysRemaining = Math.round((Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${currentDate}T00:00:00Z`)) / 86_400_000)
  const resolved = row?.workflow_status === 'resolved'
  const isOverdue = !resolved && daysRemaining < 0
  const isDueSoon = !resolved && daysRemaining >= 0 && daysRemaining <= 2
  const timingLabel = resolved
    ? '已解决'
    : isOverdue
      ? `已超期${Math.abs(daysRemaining)}天`
      : daysRemaining === 0
        ? '今日到期'
        : `剩余${daysRemaining}天`
  return { dueDate, daysRemaining, isOverdue, isDueSoon, timingLabel }
}

export function validateQualityTransition(
  current: QualityWorkflowStatus,
  target: QualityWorkflowStatus,
  input: { owner?: unknown; note?: unknown; dueDate?: unknown; evidenceRef?: unknown },
): { ok: true } | { ok: false; error: string } {
  const expected = NEXT[current]
  if (expected !== target) {
    return { ok: false, error: expected ? `状态只能从${LABELS[current]}推进到${LABELS[expected]}` : '已解决异常不能继续变更状态' }
  }
  if (target === 'claimed') {
    if (!String(input.owner || '').trim()) return { ok: false, error: '认领异常必须指定负责人' }
    if (!dateOnly(input.dueDate)) return { ok: false, error: '认领异常必须填写YYYY-MM-DD格式的截止日期' }
  }
  if (target === 'review') {
    if (!String(input.note || '').trim()) return { ok: false, error: '提交复核必须填写处理说明' }
    if (!String(input.evidenceRef || '').trim()) return { ok: false, error: '提交复核必须填写证据位置' }
  }
  if (target === 'resolved' && !String(input.note || '').trim()) {
    return { ok: false, error: '确认解决必须填写复核说明' }
  }
  return { ok: true }
}
