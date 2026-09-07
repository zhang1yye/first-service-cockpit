export type TaskState = {
  status: string
  owner?: string | null
  result?: string | null
}

export type TaskPatch = {
  status?: string
  owner?: string | null
  result?: string | null
}

const ALLOWED_GENERIC_TRANSITIONS: Record<string, string[]> = {
  待处理: ['已分派', '处理中'],
  已分派: ['处理中'],
  处理中: ['待复核'],
  已逾期: ['处理中', '待复核'],
  待复核: [],
  已完成: [],
}

function compact(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '')
}

export function buildSourceSignature(sourceType: unknown, sourceId: unknown, action: unknown): string {
  return `${compact(sourceType)}|${compact(sourceId)}|${compact(action)}`
}

export function validateTaskUpdate(existing: TaskState, patch: TaskPatch): { error: string | null; nextStatus: string } {
  const nextStatus = patch.status || existing.status
  if (nextStatus === existing.status) return { error: null, nextStatus }
  if (existing.status === '待复核') return { error: '待复核任务必须通过复核操作流转', nextStatus: existing.status }
  if (existing.status === '已完成') return { error: '已完成任务不能再次流转', nextStatus: existing.status }
  const allowed = ALLOWED_GENERIC_TRANSITIONS[existing.status] || []
  if (!allowed.includes(nextStatus)) return { error: `不允许从${existing.status}流转到${nextStatus}`, nextStatus: existing.status }
  const effectiveResult = String(patch.result ?? existing.result ?? '').trim()
  if (nextStatus === '待复核' && !effectiveResult) return { error: '提交复核前必须填写处理结果', nextStatus: existing.status }
  return { error: null, nextStatus }
}

export function validateReview(task: TaskState, approved: boolean, note: unknown, result: unknown): { error: string | null } {
  if (task.status !== '待复核') return { error: '只有待复核任务可以执行复核' }
  const effectiveResult = String(result || task.result || '').trim()
  if (approved && !effectiveResult) return { error: '复核通过前必须有处理结果' }
  if (!approved && !String(note || '').trim()) return { error: '复核退回必须填写原因' }
  return { error: null }
}

export type FocusTaskInput = {
  project_id?: number | null
  project_name: string
  area?: string
  risk_type: string
  action: string
  owner?: string
  due_date?: string | null
  source_type: string
  source_id: string
}

export function createTaskFromFocus(database: any, input: FocusTaskInput): { id: number; created: boolean; task: any } {
  const signature = buildSourceSignature(input.source_type, input.source_id, input.action)
  const existing = database.prepare("SELECT * FROM management_tasks WHERE COALESCE(archived_at,'')='' AND source_signature = ? AND status != '已完成' LIMIT 1").get(signature)
  if (existing) return { id: Number(existing.id), created: false, task: existing }

  const owner = String(input.owner || '待指定').trim() || '待指定'
  const status = owner === '待指定' ? '待处理' : '已分派'
  try {
    const result = database.prepare(`INSERT INTO management_tasks (
      project_id, project_name, area, risk_type, action, owner, due_date, status,
      source, source_type, source_id, source_signature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.project_id || null,
        String(input.project_name).trim(),
        String(input.area || '').trim(),
        String(input.risk_type).trim(),
        String(input.action).trim(),
        owner,
        input.due_date || null,
        status,
        '经营指挥台TOP5',
        String(input.source_type).trim(),
        String(input.source_id).trim(),
        signature,
      )
    const id = Number(result.lastInsertRowid)
    const task = database.prepare('SELECT * FROM management_tasks WHERE id = ?').get(id)
    return { id, created: true, task }
  } catch (error) {
    const raced = database.prepare("SELECT * FROM management_tasks WHERE COALESCE(archived_at,'')='' AND source_signature = ? AND status != '已完成' LIMIT 1").get(signature)
    if (raced) return { id: Number(raced.id), created: false, task: raced }
    throw error
  }
}
