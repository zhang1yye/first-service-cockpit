import { Router } from 'express'
import fs from 'node:fs'
import db from '../db.js'
import { canAccessProjectRow, denyScopedAccess, projectScopeWhere, taskScopeWhere, requireAdmin } from '../auth.js'
import { logOperation } from '../audit.js'
import { buildAutoJobs } from './data-sources.js'
import { createTaskFromFocus, validateReview, validateTaskUpdate } from '../task-workflow.js'
import { createTaskNotification, deliverWecomNotification } from '../task-notifications.js'
import { buildTaskCleanupPreview } from '../task-cleanup.js'
import { fixedEntryPath } from '../fixed-entry-root.js'

const router = Router()

function n(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : Number(v || 0) }
function collectionRate(p: any): number { return n(p.receivable) > 0 ? n(p.received) / n(p.receivable) * 100 : 0 }
function profitRate(p: any): number { return n(p.ytd_income) > 0 ? (n(p.ytd_income) - n(p.ytd_cost)) / n(p.ytd_income) * 100 : 0 }
function due(days: number): string { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10) }
function ownerForRisk(risk: string): string {
  if (risk === '数据源') return '数据管理员'
  if (risk === '收费率') return '客服负责人'
  if (risk === '利润率') return '项目经理/财务'
  if (risk === '安全') return '安全/工程负责人'
  if (risk === '品质') return '品质负责人'
  if (risk === '满意度' || risk === '投诉') return '客服负责人'
  return '项目经理'
}


const VALID_STATUSES = ['待处理', '已分派', '处理中', '待复核', '已完成', '已逾期']
function actor(req: any): string { return req.user?.username || 'system' }
function logTaskEvent(taskId: number, req: any, eventType: string, fromStatus = '', toStatus = '', note = '') {
  db.prepare('INSERT INTO task_events (task_id, event_type, from_status, to_status, note, operator) VALUES (?, ?, ?, ?, ?, ?)')
    .run(taskId, eventType, fromStatus || '', toStatus || '', note || '', actor(req))
}
function canAccessTask(req: any, task: any): boolean {
  if (!task) return false
  return canAccessProjectRow(req, { id: task.project_id, area: task.area })
}
function autoStatus(owner: string, status: string): string {
  if (status !== '待处理') return status
  return owner && owner !== '待指定' ? '已分派' : status
}
function isDataSourceTask(t: any): boolean {
  return t?.risk_type === '数据源' || t?.source === '数据源预警生成' || t?.source === '自动任务失败生成' || t?.area === '数据治理'
}
function autoJobKeyForTask(t: any): string {
  const text = `${t?.project_name || ''} ${t?.action || ''} ${t?.source || ''}`.toLowerCase()
  const bracket = text.match(/\[(aph-daily-sync|lvzai-daily-sync|monthly-snapshot|task-watchdog)\]/)
  if (bracket) return bracket[1]
  if (text.includes('绿仔') || text.includes('lvzai')) return 'lvzai-daily-sync'
  if (text.includes('watchdog') || text.includes('任务督办')) return 'task-watchdog'
  if (text.includes('月度快照') || text.includes('snapshot')) return 'monthly-snapshot'
  if (text.includes('aph') || text.includes('finereport') || text.includes('回款')) return 'aph-daily-sync'
  return ''
}
function dataSourceRunbook(job: any) {
  const commonEvidence = ['提交最近运行时间、日志路径、复检结果和处理说明。', '如已提交复核，应在任务处理结果中写明数据是否恢复可用。']
  if (job?.key === 'lvzai-daily-sync') return {
    title: '绿仔 ERP 收缴率同步处理单',
    steps: ['查看本机 ~/Library/Logs/lvzai-daily-sync.log 和绿仔同步状态文件。', '确认 ERP 登录态、接口返回和原始 JSON 是否生成并写入P46中转箱。', '必要时重新执行 /bin/bash ~/lvzai-daily-sync.sh，再执行 ~/cockpit-p46-stage.sh 生成差异预览。', '管理员在P46受控批次页核对SHA、映射、差异和真实性门禁后确认发布，再提交待复核；生产禁止手工导入。'],
    acceptance: ['绿仔原始文件进入P46批次且SHA校验通过。', '不存在未映射中心，范围外项目有明确标记。', '管理员确认发布后，收缴率数据可进入经营页面。'],
    evidence: commonEvidence,
  }
  if (job?.key === 'monthly-snapshot') return {
    title: '项目月度快照自动沉淀处理单',
    steps: ['查看 /tmp/cockpit-monthly-snapshot.log 和 snapshot_runs 最近记录。', '确认项目经营表有有效项目数据。', '处理 failed/skipped 原因，必要时执行 python3 scripts/cockpit_monthly_snapshot.py。', '确认当前月快照已存在或 skipped 属于防重复。'],
    acceptance: ['最近 snapshot_runs 不为 failed。', '当前月已有项目月度快照，或明确 skipped 为已存在防重复。', '风险历史趋势和月报可读取最新快照。'],
    evidence: commonEvidence,
  }
  if (job?.key === 'task-watchdog') return {
    title: '任务督办 watchdog 处理单',
    steps: ['查看 /tmp/cockpit-task-watchdog.log 最近 OK task-watchdog 行。', '确认 cron 每天 08:10 执行，脚本能刷新逾期状态。', '如日志缺失或超时，手工运行 python3 scripts/cockpit_task_watchdog.py。', '确认 /api/tasks/supervision/summary 的逾期/到期/待复核统计正常。'],
    acceptance: ['日志存在最近 OK task-watchdog 行。', '任务督办摘要可正常返回。', '逾期任务刷新结果写入 task_events。'],
    evidence: commonEvidence,
  }
  return {
    title: 'APH/FineReport 每日回款同步处理单',
    steps: ['查看本机 ~/daily-sync.log 和P46中转箱。', '确认 APH/FineReport 登录、抓取、业务日期和56中心快照无异常。', '必要时重新执行 bash ~/daily-sync.sh，再执行 ~/cockpit-p46-stage.sh 生成差异预览。', '管理员核对源文件SHA、中心数和增改删后确认发布，再提交待复核。'],
    acceptance: ['APH/FineReport原始文件进入P46批次且SHA校验通过。', '56中心与同日56快照校验通过。', '管理员确认发布后，首页回款、每日回款和月报读取最新业务日期。'],
    evidence: commonEvidence,
  }
}
function summarizeTaskGroup(rows: any[]) {
  const open = rows.filter(t => t.status !== '已完成')
  const done = rows.filter(t => t.status === '已完成')
  const waitingReview = open.filter(t => t.status === '待复核')
  return { total: rows.length, open: open.length, done: done.length, waitingReview: waitingReview.length, closureRate: rows.length ? done.length / rows.length * 100 : 0 }
}


function taskBaseWhere(req: any, extraClauses: string[] = [], extraParams: any[] = []) {
  const scope = taskScopeWhere(req)
  const clauses = ["COALESCE(archived_at,'') = ''", ...extraClauses]
  const params = [...extraParams]
  if (scope.clause) { clauses.push(scope.clause); params.push(...scope.params) }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}
function refreshOverdueTasks(req: any) {
  const today = new Date().toISOString().slice(0, 10)
  const scope = taskScopeWhere(req)
  const clauses = ["COALESCE(archived_at,'') = ''", 'status != ?', 'status != ?', 'due_date IS NOT NULL', 'due_date != ?', 'due_date < ?']
  const params: any[] = ['已完成', '待复核', '', today]
  if (scope.clause) { clauses.push(scope.clause); params.push(...scope.params) }
  const candidates = db.prepare(`SELECT * FROM management_tasks WHERE ${clauses.join(' AND ')}`).all(...params) as any[]
  let updated = 0
  const tx = db.transaction(() => {
    for (const t of candidates) {
      if (t.status === '已逾期') continue
      db.prepare("UPDATE management_tasks SET status = '已逾期', updated_at = datetime('now','localtime') WHERE id = ?").run(t.id)
      logTaskEvent(Number(t.id), req, '逾期标记', t.status, '已逾期', `任务截止日期${t.due_date}早于${today}，系统刷新为已逾期`)
      updated += 1
    }
  })
  tx()
  return { updated, today }
}
function taskSupervisionSummary(req: any) {
  const today = new Date().toISOString().slice(0, 10)
  const d = new Date(); d.setDate(d.getDate() + 3)
  const soon = d.toISOString().slice(0, 10)
  const scoped = (clauses: string[], params: any[] = []) => taskBaseWhere(req, clauses, params)
  const q = (clauses: string[], params: any[] = []) => {
    const w = scoped(clauses, params)
    return db.prepare(`SELECT * FROM management_tasks ${w.where} ORDER BY due_date ASC, id DESC LIMIT 20`).all(...w.params) as any[]
  }
  const count = (clauses: string[], params: any[] = []) => {
    const w = scoped(clauses, params)
    return (db.prepare(`SELECT COUNT(*) as cnt FROM management_tasks ${w.where}`).get(...w.params) as { cnt: number }).cnt
  }
  const overdue = q(['status != ?', 'status != ?', 'due_date IS NOT NULL', 'due_date != ?', 'due_date < ?'], ['已完成', '待复核', '', today])
  const dueSoon = q(['status != ?', 'status != ?', 'due_date IS NOT NULL', 'due_date >= ?', 'due_date <= ?'], ['已完成', '待复核', today, soon])
  const noOwner = q(['status != ?', '(owner IS NULL OR owner = ? OR owner = ?)'], ['已完成', '', '待指定'])
  const waitingReview = q(['status = ?'], ['待复核'])
  const total = count([])
  const done = count(['status = ?'], ['已完成'])
  const open = total - done
  const allWhere = scoped([])
  const allRows = db.prepare(`SELECT * FROM management_tasks ${allWhere.where}`).all(...allWhere.params) as any[]
  const dataSourceRows = allRows.filter(isDataSourceTask)
  const operationRows = allRows.filter(t => !isDataSourceTask(t))
  return {
    today,
    dueSoonDate: soon,
    counts: {
      total,
      open,
      done,
      overdue: overdue.length,
      dueSoon: dueSoon.length,
      noOwner: noOwner.length,
      waitingReview: waitingReview.length,
      closureRate: total ? done / total * 100 : 0,
    },
    overdue: overdue.slice(0, 8),
    dueSoon: dueSoon.slice(0, 8),
    noOwner: noOwner.slice(0, 8),
    waitingReview: waitingReview.slice(0, 8),
    groups: {
      operation: summarizeTaskGroup(operationRows),
      dataSource: summarizeTaskGroup(dataSourceRows),
    },
    summary: overdue.length
      ? `当前${overdue.length}项任务已逾期，需优先催办；${waitingReview.length}项待复核，${noOwner.length}项未明确责任人。`
      : dueSoon.length
        ? `未来3天有${dueSoon.length}项任务到期，建议提前催办；${waitingReview.length}项待复核。`
        : `当前无逾期任务，闭环率${(total ? done / total * 100 : 0).toFixed(1)}%。`,
  }
}

function actionsForProject(p: any) {
  const actions: Array<{ risk_type: string; action: string; due_date: string }> = []
  const rate = collectionRate(p)
  const profit = profitRate(p)
  if (rate < 90) actions.push({ risk_type: '收费率', action: `输出${p.name}欠费清单，按90天以上/高金额/可协商三类分层催缴，每周销项。`, due_date: due(rate < 80 ? 7 : 14) })
  if (profit < 12) actions.push({ risk_type: '利润率', action: `复核${p.name}人工、外包、能耗三类成本，形成可控成本压降清单。`, due_date: due(10) })
  if (n(p.safety_incidents) > 0) actions.push({ risk_type: '安全', action: `完成${p.name}安全事故复盘，补齐日管控记录和责任人闭环。`, due_date: due(3) })
  if (n(p.quality_score) > 0 && n(p.quality_score) < 85) actions.push({ risk_type: '品质', action: `梳理${p.name}品质低分项，上传整改前后照片并复查。`, due_date: due(7) })
  if (n(p.customer_satisfaction) > 0 && n(p.customer_satisfaction) < 85) actions.push({ risk_type: '满意度', action: `对${p.name}不满意样本开展客服回访，沉淀共性诉求。`, due_date: due(10) })
  if (n(p.complaint_count) > 20) actions.push({ risk_type: '投诉', action: `将${p.name}投诉按工程/客服/秩序/环境分类，周度销项高频问题。`, due_date: due(7) })
  return actions
}


function snapshotCollectionRate(s: any): number { return n(s.receivable) > 0 ? n(s.received) / n(s.receivable) * 100 : 0 }
function snapshotProfitRate(s: any): number { return n(s.ytd_income) > 0 ? (n(s.ytd_income) - n(s.ytd_cost)) / n(s.ytd_income) * 100 : 0 }
function riskTrendActionsForProject(p: any) {
  const snaps = db.prepare("SELECT * FROM project_monthly_snapshots WHERE project_name = ? AND quality_status='verified' ORDER BY month DESC LIMIT 2").all(p.name) as any[]
  if (snaps.length < 2) return [] as Array<{ risk_type: string; action: string; due_date: string }>
  const cur = snaps[0]
  const prev = snaps[1]
  const collectionDelta = snapshotCollectionRate(cur) - snapshotCollectionRate(prev)
  const profitDelta = snapshotProfitRate(cur) - snapshotProfitRate(prev)
  const complaintDelta = n(cur.complaint_count) - n(prev.complaint_count)
  const incidentDelta = n(cur.safety_incidents) - n(prev.safety_incidents)
  const signals: string[] = []
  if (collectionDelta < -1) signals.push(`收费率下降${Math.abs(collectionDelta).toFixed(1)}个百分点`)
  if (profitDelta < -1) signals.push(`利润率下降${Math.abs(profitDelta).toFixed(1)}个百分点`)
  if (complaintDelta > 3) signals.push(`投诉增加${complaintDelta}件`)
  if (incidentDelta > 0) signals.push(`安全事故增加${incidentDelta}起`)
  if (!signals.length) return []
  return [{
    risk_type: '趋势复盘',
    action: `${p.name}${cur.month}较${prev.month}出现风险转弱：${signals.join('、')}。请项目经理组织月度复盘，拆解收费、成本、投诉或安全原因，形成整改动作并在下月快照复查。`,
    due_date: due(7),
  }]
}

function seedTasksFromProjects() {
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM management_tasks').get() as { cnt: number }
  if (existing.cnt > 0) return existing.cnt
  const projects = db.prepare('SELECT * FROM projects').all() as any[]
  const insert = db.prepare(`INSERT INTO management_tasks (project_id, project_name, area, risk_type, action, owner, due_date, status, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const tx = db.transaction(() => {
    for (const p of projects) {
      for (const a of actionsForProject(p).slice(0, 2)) insert.run(p.id, p.name, p.area, a.risk_type, a.action, ownerForRisk(a.risk_type), a.due_date, '待处理', 'AI预警自动生成')
    }
  })
  tx()
  return (db.prepare('SELECT COUNT(*) as cnt FROM management_tasks').get() as { cnt: number }).cnt
}

function sourceHealthTaskStatus(health: string) {
  if (health === 'ok') return 'success'
  if (health === 'warning') return 'warning'
  return 'failed'
}

function dataSourceAlertsForTasks() {
  const rows = db.prepare('SELECT * FROM data_sources ORDER BY id').all() as any[]
  const currentMonth = new Date().toISOString().slice(0, 7)
  return rows.flatMap((row) => {
    let status = row.status || '待检测'
    let detail = row.note || ''
    let health = 'warning'
    let suggestion = '请执行一次连接检测，确认数据源可用性。'
    let expectedFreshHours = 72
    let ageHours: number | null = null

    const filePath = row.source_key === 'aph'
      ? fixedEntryPath('APH决策_每日提取.json')
      : row.source_key === 'lvzai'
        ? fixedEntryPath('绿仔收款汇总.json')
        : ''
    if (filePath) {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath)
        ageHours = Math.max(0, Math.round((Date.now() - stat.mtime.getTime()) / 360_000) / 10)
        status = '已连接'
        health = ageHours > expectedFreshHours ? 'warning' : 'ok'
        detail = row.source_key === 'aph' ? '发现 APH JSON' : '发现绿仔收缴率 JSON'
        suggestion = health === 'warning'
          ? `${row.name}超过72小时未更新，请检查同步脚本或源系统导出。`
          : `${row.name}同步正常。`
      } else {
        status = '待接入'
        health = 'danger'
        detail = row.source_key === 'aph' ? '未发现 APH 每日提取 JSON' : '未发现绿仔收缴率 JSON'
        suggestion = `请确认${row.name}接入路径和同步脚本。`
      }
    }

    if (row.source_key === 'finereport') {
      expectedFreshHours = 24 * 35
      const cnt = db.prepare('SELECT COUNT(*) as cnt FROM projects').get() as { cnt: number }
      const latestRun = db.prepare('SELECT * FROM snapshot_runs ORDER BY id DESC LIMIT 1').get() as any
      const latestSnapshot = db.prepare("SELECT month FROM project_monthly_snapshots WHERE quality_status='verified' GROUP BY month ORDER BY month DESC LIMIT 1").get() as any
      status = cnt.cnt > 0 ? '已接入' : '待导入'
      if (cnt.cnt <= 0) {
        health = 'danger'
        detail = '当前项目经营表为空'
        suggestion = '请从APH/FineReport受控接入任务重建P46批次，通过SHA、映射、差异和真实性门禁后由管理员发布；生产禁止手工导入。'
      } else if (latestRun?.status === 'failed') {
        health = 'danger'
        detail = `最近快照失败：${latestRun.message || '未返回失败原因'}`
        suggestion = '请处理最近一次月度快照失败原因，并重新执行快照。'
      } else if (!latestSnapshot?.month || latestSnapshot.month < currentMonth) {
        health = 'warning'
        detail = latestSnapshot?.month ? `最新快照停留在 ${latestSnapshot.month}` : '尚未沉淀月度快照'
        suggestion = `请补生成 ${currentMonth} 月项目月度快照。`
      } else {
        health = 'ok'
        detail = '项目经营表和月度快照状态正常'
        suggestion = '继续保持月度快照。'
      }
    }

    if (health === 'ok') return []
    return [{
      source_key: row.source_key,
      name: row.name,
      status,
      health,
      severity: health === 'danger' ? 'high' : 'medium',
      detail,
      suggestion,
      expectedFreshHours,
      ageHours,
      taskStatus: sourceHealthTaskStatus(health),
    }]
  })
}

function generateDataSourceTasks(req: any) {
  const alerts = dataSourceAlertsForTasks()
  const insert = db.prepare(`INSERT INTO management_tasks (project_id, project_name, area, risk_type, action, owner, due_date, status, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  let created = 0
  let skipped = 0
  const tx = db.transaction(() => {
    for (const a of alerts) {
      const dup = db.prepare("SELECT id FROM management_tasks WHERE COALESCE(archived_at,'')='' AND project_id IS NULL AND risk_type = ? AND project_name = ? AND status != ? LIMIT 1")
        .get('数据源', a.name, '已完成')
      if (dup) { skipped += 1; continue }
      const action = `${a.name}出现${a.severity === 'high' ? '高风险' : '中风险'}数据源预警：${a.detail}。${a.suggestion}`
      const r = insert.run(null, a.name, '数据治理', '数据源', action, ownerForRisk('数据源'), due(a.severity === 'high' ? 2 : 5), '已分派', '数据源预警生成')
      logTaskEvent(Number(r.lastInsertRowid), req, '数据源生成任务', '', '已分派', '数据源预警转数据修复任务')
      created += 1
    }
  })
  tx()
  return { alerts, created, skipped }
}

function loadActiveTasksForCleanup() {
  return db.prepare(`SELECT t.*,
    (SELECT COUNT(*) FROM task_events e WHERE e.task_id=t.id) event_count,
    (SELECT COUNT(*) FROM task_notifications n WHERE n.task_id=t.id) notification_count
    FROM management_tasks t WHERE COALESCE(t.archived_at,'')='' AND t.status!='已完成' ORDER BY t.id`).all() as any[]
}
function cleanupPreview() {
  const today = new Date().toISOString().slice(0,10)
  const preview = buildTaskCleanupPreview(loadActiveTasksForCleanup(), today)
  const history = db.prepare(`SELECT g.*,COUNT(m.id) members FROM task_merge_groups g LEFT JOIN task_merge_members m ON m.group_id=g.id GROUP BY g.id ORDER BY g.id DESC LIMIT 50`).all()
  return {...preview,today,history}
}
function rewireMergedTaskReferences(){
  const weekly=db.prepare(`SELECT i.id,t.merged_into_task_id FROM weekly_meeting_items i JOIN management_tasks t ON t.id=i.linked_task_id WHERE COALESCE(t.archived_at,'')!='' AND t.merged_into_task_id IS NOT NULL`).all() as any[]
  const notifications=db.prepare(`SELECT n.id,t.merged_into_task_id FROM task_notifications n JOIN management_tasks t ON t.id=n.task_id WHERE COALESCE(t.archived_at,'')!='' AND t.merged_into_task_id IS NOT NULL`).all() as any[]
  for(const x of weekly)db.prepare("UPDATE weekly_meeting_items SET linked_task_id=?,updated_at=datetime('now','localtime') WHERE id=?").run(x.merged_into_task_id,x.id)
  for(const x of notifications)db.prepare("UPDATE task_notifications SET task_id=?,updated_at=datetime('now','localtime') WHERE id=?").run(x.merged_into_task_id,x.id)
  return{weeklyItems:weekly.length,notifications:notifications.length}
}

router.get('/api/tasks/cleanup/preview', requireAdmin, (_req,res)=>res.json(cleanupPreview()))
router.post('/api/tasks/cleanup/apply', requireAdmin, (req,res)=>{
  const note=String(req.body?.confirmNote||'').trim(),expected=Number(req.body?.expectedGroupCount)
  if(note.length<5)return res.status(400).json({error:'确认说明至少5个字'})
  const preview=cleanupPreview()
  if(Number.isFinite(expected)&&expected!==preview.groups.length)return res.status(409).json({error:'重复组数量已变化，请重新预览',expected,actual:preview.groups.length})
  if(!preview.groups.length){const rewired=db.transaction(rewireMergedTaskReferences)();if(rewired.weeklyItems||rewired.notifications)logOperation(req,'P47修复合并任务引用','management_tasks',rewired);return res.json({success:true,idempotent:true,rewired,...cleanupPreview()})}
  const tx=db.transaction(()=>{
    for(const group of preview.groups){
      const r=db.prepare(`INSERT INTO task_merge_groups(primary_task_id,merge_key,reason,member_count,merged_by,confirm_note) VALUES(?,?,?,?,?,?)`).run(group.primary.id,group.key,group.reason,group.duplicates.length+1,actor(req),note)
      const gid=Number(r.lastInsertRowid),members=[group.primary,...group.duplicates]
      for(const member of members)db.prepare(`INSERT INTO task_merge_members(group_id,task_id,member_role,task_snapshot) VALUES(?,?,?,?)`).run(gid,member.id,member.id===group.primary.id?'primary':'duplicate',JSON.stringify(member))
      for(const duplicate of group.duplicates)db.prepare(`UPDATE management_tasks SET archived_at=datetime('now','localtime'),archived_reason=?,merged_into_task_id=?,updated_at=datetime('now','localtime') WHERE id=? AND COALESCE(archived_at,'')=''`).run(`P47重复任务归档；主任务#${group.primary.id}`,group.primary.id,duplicate.id)
      logTaskEvent(group.primary.id,req,'合并重复任务',group.primary.status,group.primary.status,`归档重复任务：${group.duplicates.map((x:any)=>'#'+x.id).join('、')}；${note}`)
    }
    rewireMergedTaskReferences()
  });tx();logOperation(req,'P47任务去重','management_tasks',{groups:preview.groups.length,duplicates:preview.summary.duplicateRecords,note})
  res.json({success:true,idempotent:false,applied:{groups:preview.groups.length,duplicates:preview.summary.duplicateRecords},preview:cleanupPreview()})
})

router.get('/api/tasks', (req, res) => {
  seedTasksFromProjects()
  const status = req.query.status as string | undefined
  const area = req.query.area as string | undefined
  const clauses: string[] = ["COALESCE(archived_at,'') = ''"]
  const params: any[] = []
  if (status && status !== '全部') { clauses.push('status = ?'); params.push(status) }
  if (area && area !== '全部') { clauses.push('area = ?'); params.push(area) }
  const scope = taskScopeWhere(req)
  if (scope.clause) { clauses.push(scope.clause); params.push(...scope.params) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM management_tasks ${where} ORDER BY CASE status WHEN '已逾期' THEN 0 WHEN '待处理' THEN 1 WHEN '处理中' THEN 2 ELSE 3 END, due_date ASC, id DESC`).all(...params)
  const summaryWhere = scope.clause ? `WHERE COALESCE(archived_at,'')='' AND ${scope.clause}` : "WHERE COALESCE(archived_at,'')=''"
  const summary = db.prepare(`SELECT status, COUNT(*) as count FROM management_tasks ${summaryWhere} GROUP BY status`).all(...scope.params)
  res.json({ rows, summary })
})


router.get('/api/tasks/supervision/summary', (req, res) => {
  res.json(taskSupervisionSummary(req))
})

router.post('/api/tasks/supervision/refresh-overdue', (req, res) => {
  const result = refreshOverdueTasks(req)
  logOperation(req, '刷新逾期任务', 'management_tasks', result)
  res.json({ success: true, ...result, supervision: taskSupervisionSummary(req) })
})

router.post('/api/tasks/generate', (req, res) => {
  const before = (db.prepare('SELECT COUNT(*) as cnt FROM management_tasks').get() as { cnt: number }).cnt
  const sourceMode = String(req.body?.source || '')
  const fromRiskTrends = sourceMode === 'risk-trends' || Boolean(req.body?.riskTrends)
  const fromDataSources = sourceMode === 'data-sources' || Boolean(req.body?.dataSources)
  if (fromDataSources) {
    const result = generateDataSourceTasks(req)
    const total = (db.prepare('SELECT COUNT(*) as cnt FROM management_tasks').get() as { cnt: number }).cnt
    logOperation(req, '生成数据源修复任务', 'management_tasks', { before, created: result.created, skipped: result.skipped, total, source: 'data-sources' })
    return res.json({ before, created: result.created, skipped: result.skipped, total, source: 'data-sources', alerts: result.alerts.length })
  }
  const projectIds = Array.isArray(req.body?.projectIds) ? req.body.projectIds.map((x: any) => Number(x)).filter(Number.isFinite) : []
  const scope = projectScopeWhere(req)
  const clauses: string[] = []
  const params: any[] = []
  if (projectIds.length) { clauses.push(`id IN (${projectIds.map(() => '?').join(',')})`); params.push(...projectIds) }
  if (scope.clause) { clauses.push(scope.clause); params.push(...scope.params) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const projects = db.prepare(`SELECT * FROM projects ${where}`).all(...params) as any[]
  const insert = db.prepare(`INSERT INTO management_tasks (project_id, project_name, area, risk_type, action, owner, due_date, status, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  let created = 0
  let skipped = 0
  const tx = db.transaction(() => {
    for (const p of projects) {
      const actions = fromRiskTrends ? riskTrendActionsForProject(p) : actionsForProject(p)
      for (const a of actions) {
        const dup = db.prepare("SELECT id FROM management_tasks WHERE COALESCE(archived_at,'')='' AND project_id = ? AND risk_type = ? AND status != ? LIMIT 1").get(p.id, a.risk_type, '已完成')
        if (!dup) { const r = insert.run(p.id, p.name, p.area, a.risk_type, a.action, ownerForRisk(a.risk_type), a.due_date, '已分派', fromRiskTrends ? '风险历史趋势生成' : (projectIds.length ? 'AI预警中心生成' : 'AI预警自动生成')); logTaskEvent(Number(r.lastInsertRowid), req, fromRiskTrends ? '趋势生成任务' : '生成任务', '', '已分派', fromRiskTrends ? '风险历史趋势转管理动作' : 'AI预警生成并自动分派责任人'); created++ }
        else skipped++
      }
    }
  })
  tx()
  const total = (db.prepare('SELECT COUNT(*) as cnt FROM management_tasks').get() as { cnt: number }).cnt
  logOperation(req, '生成管理任务', 'management_tasks', { before, created, skipped, total, projectIds, source: fromRiskTrends ? 'risk-trends' : 'alerts' })
  res.json({ before, created, skipped, total, projectIds, source: fromRiskTrends ? 'risk-trends' : 'alerts' })
})

router.post('/api/tasks/from-focus', (req, res) => {
  const input = req.body || {}
  if (!input.project_name || !input.risk_type || !input.action || !input.source_type || !input.source_id) {
    return res.status(400).json({ error: '项目、风险类型、动作和来源标识不能为空' })
  }
  if (!['command-top5', 'monthly-report'].includes(String(input.source_type || ''))) return res.status(400).json({ error: 'source_type仅支持command-top5或monthly-report' })
  if (input.project_id) {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(input.project_id) as any
    if (!project || !canAccessProjectRow(req, project)) return res.status(403).json({ error: '无权为该项目创建任务' })
  }
  const result = createTaskFromFocus(db, input)
  if (result.created) logTaskEvent(result.id, req, 'TOP5生成任务', '', result.task.status, `来源：${input.source_id}`)
  logOperation(req, result.created ? 'TOP5生成管理任务' : 'TOP5复用已有任务', `management_task:${result.id}`, {
    taskId: result.id,
    created: result.created,
    sourceType: input.source_type,
    sourceId: input.source_id,
  })
  res.status(result.created ? 201 : 200).json(result)
})

router.post('/api/tasks', (req, res) => {
  const { project_id, project_name, area, risk_type, action, owner, due_date, status } = req.body || {}
  if (!project_name || !risk_type || !action) return res.status(400).json({ error: '项目、风险类型、动作不能为空' })
  if (project_id) {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id) as any
    if (!project || !canAccessProjectRow(req, project)) return res.status(403).json({ error: '无权为该项目创建任务' })
  }
  const finalOwner = owner || '待指定'
  const finalStatus = VALID_STATUSES.includes(status) ? autoStatus(finalOwner, status) : autoStatus(finalOwner, '待处理')
  const r = db.prepare(`INSERT INTO management_tasks (project_id, project_name, area, risk_type, action, owner, due_date, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(project_id || null, project_name, area || '', risk_type, action, finalOwner, due_date || null, finalStatus, '手工新增')
  logTaskEvent(Number(r.lastInsertRowid), req, '新增任务', '', finalStatus, '手工补充管理动作')
  logOperation(req, '新增管理任务', `management_task:${r.lastInsertRowid}`, req.body || {})
  res.json({ id: r.lastInsertRowid })
})

router.put('/api/tasks/:id', (req, res) => {
  const { owner, due_date, status, result, review_note } = req.body || {}
  const existing = db.prepare('SELECT * FROM management_tasks WHERE id = ?').get(req.params.id) as any
  if (!existing) return res.status(404).json({ error: '任务不存在' })
  if (!canAccessTask(req, existing)) return denyScopedAccess(req, res, '无权操作该任务')
  const nextStatus = status && VALID_STATUSES.includes(status) ? status : undefined
  const validation = validateTaskUpdate(existing, { status: nextStatus, owner, result })
  if (validation.error) return res.status(400).json({ error: validation.error })
  db.prepare(`UPDATE management_tasks SET owner = COALESCE(?, owner), due_date = COALESCE(?, due_date), status = COALESCE(?, status), result = COALESCE(?, result), review_note = COALESCE(?, review_note), updated_at = datetime('now','localtime') WHERE id = ?`)
    .run(owner ?? null, due_date ?? null, nextStatus ?? null, result ?? null, review_note ?? null, req.params.id)
  const note = JSON.stringify(req.body || {})
  logTaskEvent(Number(req.params.id), req, nextStatus && nextStatus !== existing.status ? '状态流转' : '修改任务', existing.status, nextStatus || existing.status, note)
  logOperation(req, '修改管理任务', `management_task:${req.params.id}`, req.body || {})
  res.json({ success: true })
})

router.get('/api/tasks/:id/data-source-context', (req, res) => {
  const task = db.prepare('SELECT * FROM management_tasks WHERE id = ?').get(req.params.id) as any
  if (!task) return res.status(404).json({ error: '任务不存在' })
  if (!canAccessTask(req, task)) return denyScopedAccess(req, res, '无权操作该任务')
  if (!isDataSourceTask(task)) return res.status(400).json({ error: '该任务不是数据源修复任务' })
  const autoJobs = buildAutoJobs().rows
  const key = autoJobKeyForTask(task)
  const job = autoJobs.find((j: any) => j.key === key) || autoJobs.find((j: any) => task.project_name === j.name || String(task.action || '').includes(j.name)) || null
  const events = db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 20').all(req.params.id) as any[]
  const latestEvent = events[0] || null
  const runbook = dataSourceRunbook(job)
  res.json({
    task: { id: task.id, project_name: task.project_name, source: task.source, status: task.status, result: task.result, review_note: task.review_note },
    autoJobKey: job?.key || key || '',
    autoJob: job ? {
      key: job.key,
      name: job.name,
      source_key: job.source_key,
      owner_host: job.owner_host,
      schedule: job.schedule,
      next_run_hint: job.next_run_hint,
      command: job.command,
      log_path: job.log_path,
      status: job.status,
      health: job.health,
      last_run_at: job.last_run_at,
      ageHours: job.ageHours,
      evidence: job.evidence,
      message: job.message,
      openRepairTasks: job.openRepairTasks,
    } : null,
    currentHealth: job?.health || 'warning',
    failureReason: job?.message || task.action,
    acceptance: runbook.acceptance,
    steps: runbook.steps,
    evidenceRequired: runbook.evidence,
    title: runbook.title,
    latestEvent,
    recentEvents: events,
    links: {
      dataSources: '/admin',
      governanceTasks: '/tasks?area=数据治理',
    },
  })
})

router.get('/api/tasks/:id/events', (req, res) => {
  const task = db.prepare('SELECT * FROM management_tasks WHERE id = ?').get(req.params.id) as any
  if (!task) return res.status(404).json({ error: '任务不存在' })
  if (!canAccessTask(req, task)) return denyScopedAccess(req, res, '无权操作该任务')
  const primaryId=Number(task.merged_into_task_id||task.id)
  const group=db.prepare('SELECT id FROM task_merge_groups WHERE primary_task_id=? ORDER BY id DESC LIMIT 1').get(primaryId) as any
  const ids=group?(db.prepare('SELECT task_id FROM task_merge_members WHERE group_id=? ORDER BY task_id').all(group.id) as any[]).map(x=>Number(x.task_id)):[Number(task.id)]
  const rows=db.prepare(`SELECT e.*,e.task_id source_task_id FROM task_events e WHERE e.task_id IN (${ids.map(()=>'?').join(',')}) ORDER BY e.id DESC LIMIT 100`).all(...ids)
  res.json({ rows,primaryTaskId:primaryId,mergedTaskIds:ids })
})

router.post('/api/tasks/:id/remind', async (req, res) => {
  const task = db.prepare('SELECT * FROM management_tasks WHERE id = ?').get(req.params.id) as any
  if (!task) return res.status(404).json({ error: '任务不存在' })
  if (!canAccessTask(req, task)) return denyScopedAccess(req, res, '无权操作该任务')
  const note = String(req.body?.note || `请${task.owner || '责任人'}在${task.due_date || '截止日前'}前反馈处理进展。`).trim()
  const recipient = String(req.body?.recipient || task.owner || '待指定').trim()
  const channel = req.body?.channel === 'wecom' ? 'wecom' : 'in_app'
  const webhook = String(process.env.WECOM_NOTIFICATION_WEBHOOK || '').trim()
  const result = createTaskNotification(db, {
    taskId: Number(req.params.id), recipient, channel, content: note,
    createdBy: actor(req), channelConfigured: channel === 'wecom' && Boolean(webhook),
  })
  if (result.created && channel === 'wecom' && webhook) await deliverWecomNotification(db, result.id, webhook)
  const notification = db.prepare('SELECT * FROM task_notifications WHERE id = ?').get(result.id) as any
  if (result.created) logTaskEvent(Number(req.params.id), req, '催办', task.status, task.status, `${note}\n通知#${result.id} · ${channel} · ${notification.status}`)
  logOperation(req, result.created ? '催办管理任务' : '复用催办通知', `management_task:${req.params.id}`, { notificationId: result.id, recipient, channel, status: notification.status, created: result.created })
  res.status(result.created ? 201 : 200).json({ success: true, created: result.created, notification })
})

router.get('/api/notifications', (req, res) => {
  const scope = taskScopeWhere(req, 't')
  const clauses: string[] = []
  const params: any[] = []
  if (scope.clause) { clauses.push(scope.clause); params.push(...scope.params) }
  if (req.query.status && req.query.status !== '全部') { clauses.push('n.status = ?'); params.push(String(req.query.status)) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT n.*, t.project_name, t.area, t.risk_type, t.owner, t.due_date, t.status AS task_status FROM task_notifications n JOIN management_tasks t ON t.id=n.task_id ${where} ORDER BY n.id DESC LIMIT 200`).all(...params)
  const summary = db.prepare(`SELECT n.status, COUNT(*) count FROM task_notifications n JOIN management_tasks t ON t.id=n.task_id ${scope.clause ? `WHERE ${scope.clause}` : ''} GROUP BY n.status`).all(...scope.params)
  res.json({ rows, summary })
})

router.post('/api/notifications/:id/read', (req, res) => {
  const notification = db.prepare('SELECT n.*, t.project_id, t.area FROM task_notifications n JOIN management_tasks t ON t.id=n.task_id WHERE n.id=?').get(req.params.id) as any
  if (!notification) return res.status(404).json({ error: '通知不存在' })
  if (!canAccessTask(req, notification)) return denyScopedAccess(req, res, '无权操作该通知')
  const now = new Date().toISOString()
  db.prepare("UPDATE task_notifications SET status='read', read_at=?, updated_at=? WHERE id=?").run(now, now, notification.id)
  logOperation(req, '读取任务通知', `task_notification:${notification.id}`, { taskId: notification.task_id })
  res.json({ success: true, id: notification.id, status: 'read' })
})

router.post('/api/notifications/:id/retry', async (req, res) => {
  const notification = db.prepare('SELECT n.*, t.project_id, t.area FROM task_notifications n JOIN management_tasks t ON t.id=n.task_id WHERE n.id=?').get(req.params.id) as any
  if (!notification) return res.status(404).json({ error: '通知不存在' })
  if (!canAccessTask(req, notification)) return denyScopedAccess(req, res, '无权操作该通知')
  if (!['pending', 'failed'].includes(notification.status)) return res.status(400).json({ error: '只有待发送或失败通知可以重试' })
  if (notification.channel !== 'wecom') return res.status(400).json({ error: '站内通知无需重试' })
  const webhook = String(process.env.WECOM_NOTIFICATION_WEBHOOK || '').trim()
  if (!webhook) {
    const now = new Date().toISOString()
    db.prepare("UPDATE task_notifications SET attempts=attempts+1,last_error='企微发送通道未配置',updated_at=? WHERE id=?").run(now, notification.id)
    logOperation(req, '重试任务通知失败', `task_notification:${notification.id}`, { reason: '企微发送通道未配置' })
    return res.status(409).json({ error: '企微发送通道未配置', id: notification.id, status: 'pending' })
  }
  const delivery = await deliverWecomNotification(db, notification.id, webhook)
  logOperation(req, delivery.ok ? '重试任务通知成功' : '重试任务通知失败', `task_notification:${notification.id}`, { result: delivery.ok ? 'sent' : 'failed' })
  res.status(delivery.ok ? 200 : 502).json({ success: delivery.ok, id: notification.id, status: delivery.ok ? 'sent' : 'failed', error: delivery.error })
})

router.post('/api/tasks/:id/extension', (req, res) => {
  const task = db.prepare('SELECT * FROM management_tasks WHERE id = ?').get(req.params.id) as any
  if (!task) return res.status(404).json({ error: '任务不存在' })
  if (!canAccessTask(req, task)) return denyScopedAccess(req, res, '无权操作该任务')
  const dueDate = String(req.body?.due_date || '')
  const reason = String(req.body?.reason || '申请延期')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: '延期日期格式应为YYYY-MM-DD' })
  db.prepare(`UPDATE management_tasks SET due_date = ?, review_note = COALESCE(NULLIF(review_note, ''), '') || ?, updated_at = datetime('now','localtime') WHERE id = ?`).run(dueDate, `\n延期至${dueDate}：${reason}`, req.params.id)
  logTaskEvent(Number(req.params.id), req, '延期申请', task.status, task.status, `延期至${dueDate}：${reason}`)
  logOperation(req, '延期管理任务', `management_task:${req.params.id}`, { due_date: dueDate, reason })
  res.json({ success: true, due_date: dueDate })
})

router.post('/api/tasks/:id/review', (req, res) => {
  const task = db.prepare('SELECT * FROM management_tasks WHERE id = ?').get(req.params.id) as any
  if (!task) return res.status(404).json({ error: '任务不存在' })
  if (!canAccessTask(req, task)) return denyScopedAccess(req, res, '无权操作该任务')
  const approved = Boolean(req.body?.approved)
  const note = String(req.body?.note || '')
  const result = String(req.body?.result || '')
  const validation = validateReview(task, approved, note, result)
  if (validation.error) return res.status(400).json({ error: validation.error })
  const nextStatus = approved ? '已完成' : '处理中'
  db.prepare(`UPDATE management_tasks SET status = ?, result = COALESCE(NULLIF(?, ''), result), review_note = COALESCE(NULLIF(review_note, ''), '') || ?, updated_at = datetime('now','localtime') WHERE id = ?`).run(nextStatus, result, `\n${note}`, req.params.id)
  logTaskEvent(Number(req.params.id), req, approved ? '复核通过' : '复核退回', task.status, nextStatus, note)
  logOperation(req, approved ? '复核通过管理任务' : '复核退回管理任务', `management_task:${req.params.id}`, { approved, status: nextStatus, note, result })
  res.json({ success: true, status: nextStatus })
})

export default router
