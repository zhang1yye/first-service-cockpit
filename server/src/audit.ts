import db from './db.js'

export function logOperation(req: any, action: string, target: string, detail: any = {}) {
  try {
    const user = req?.user || {}
    db.prepare('INSERT INTO operation_logs (user_id, username, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.userId || null, user.username || 'system', action, target || '', JSON.stringify(detail || {}), req?.ip || '')
  } catch {
    // 审计日志不能影响主流程；失败时保持业务接口可用。
  }
}

/** 关键变更使用严格审计：失败必须抛出，由同一数据库事务整体回滚。 */
export function logOperationStrict(req: any, action: string, target: string, detail: any = {}) {
  const user = req?.user || {}
  db.prepare('INSERT INTO operation_logs (user_id, username, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.userId || null, user.username || 'system', action, target || '', JSON.stringify(detail || {}), req?.ip || '')
}
