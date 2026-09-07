type NotificationDb = {
  prepare: (sql: string) => { get: (...params: any[]) => any; run: (...params: any[]) => any }
}

type NotificationInput = {
  taskId: number
  recipient: string
  channel: 'in_app' | 'wecom'
  content: string
  createdBy: string
  now?: Date
  channelConfigured?: boolean
}

export function initialDelivery(channel: 'in_app' | 'wecom', channelConfigured: boolean) {
  if (channel === 'in_app') return { status: 'sent', attempts: 1, lastError: '' }
  if (!channelConfigured) return { status: 'pending', attempts: 0, lastError: '企微发送通道未配置' }
  return { status: 'pending', attempts: 0, lastError: '' }
}

function tenMinuteBucket(now: Date) {
  return Math.floor(now.getTime() / 600_000)
}

export function notificationDedupeKey(input: Pick<NotificationInput, 'taskId' | 'recipient' | 'channel'>, now: Date) {
  return `${input.taskId}:${input.recipient.trim()}:${input.channel}:${tenMinuteBucket(now)}`
}

export function createTaskNotification(db: NotificationDb, input: NotificationInput) {
  const now = input.now || new Date()
  const timestamp = now.toISOString()
  const dedupeKey = notificationDedupeKey(input, now)
  const existing = db.prepare('SELECT * FROM task_notifications WHERE dedupe_key = ?').get(dedupeKey)
  if (existing) return { id: Number(existing.id), created: false, notification: existing }
  const delivery = initialDelivery(input.channel, Boolean(input.channelConfigured))
  const sentAt = delivery.status === 'sent' ? timestamp : null
  const result = db.prepare(`INSERT INTO task_notifications
    (task_id,recipient,channel,content,status,attempts,last_error,dedupe_key,sent_at,read_at,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.taskId, input.recipient.trim(), input.channel, input.content.trim(), delivery.status,
      delivery.attempts, delivery.lastError, dedupeKey, sentAt, null, input.createdBy, timestamp, timestamp,
    )
  const notification = db.prepare('SELECT * FROM task_notifications WHERE id = ?').get(result.lastInsertRowid)
  return { id: Number(result.lastInsertRowid), created: true, notification }
}

export async function deliverWecomNotification(db: NotificationDb, id: number, webhook: string) {
  const row = db.prepare('SELECT * FROM task_notifications WHERE id = ?').get(id)
  if (!row) return { ok: false, error: '通知不存在' }
  const now = new Date().toISOString()
  try {
    const response = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content: row.content } }) })
    const payload = await response.json().catch(() => ({})) as any
    if (!response.ok || Number(payload?.errcode || 0) !== 0) throw new Error(`企微返回${response.status}/${payload?.errcode ?? 'unknown'}`)
    db.prepare("UPDATE task_notifications SET status='sent', attempts=attempts+1, last_error='', sent_at=?, updated_at=? WHERE id=?").run(now, now, id)
    return { ok: true }
  } catch (error: any) {
    const message = String(error?.message || '发送失败').slice(0, 300)
    db.prepare("UPDATE task_notifications SET status='failed', attempts=attempts+1, last_error=?, updated_at=? WHERE id=?").run(message, now, id)
    return { ok: false, error: message }
  }
}
