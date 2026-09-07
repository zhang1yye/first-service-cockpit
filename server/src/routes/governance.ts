import { Router } from 'express'
import db from '../db.js'
import { requireAdmin } from '../auth.js'
import { logOperation } from '../audit.js'
import { PERMISSION_MATRIX } from '../permissions.js'
import fs from 'node:fs'
import path from 'node:path'
import { generateVerifiedReportArchive, reportArchiveStatus } from '../report-archive-generator.js'
import { evaluateReportArchiveIntegrity } from '../report-archive-integrity.js'

const router = Router()

const DEFAULT_RULES = [
  { key: 'collection_rate', label: '收费率预警线', value: 80, unit: '%', description: '项目收费率低于该值触发预警' },
  { key: 'profit_rate', label: '利润率预警线', value: 10, unit: '%', description: '项目利润率低于该值触发预警' },
  { key: 'quality_score', label: '品质评分预警线', value: 75, unit: '分', description: '品质评分低于该值触发预警' },
  { key: 'satisfaction', label: '满意度预警线', value: 75, unit: '分', description: '客户满意度低于该值触发预警' },
  { key: 'complaint_count', label: '投诉量预警线', value: 20, unit: '件', description: '投诉量高于该值触发预警' },
  { key: 'safety_incidents', label: '安全事故预警线', value: 0, unit: '起', description: '安全事故高于该值触发预警' },
]

function ensureRules() {
  const cnt = db.prepare('SELECT COUNT(*) as cnt FROM alert_rules').get() as { cnt: number }
  if (cnt.cnt === 0) {
    const ins = db.prepare('INSERT INTO alert_rules (rule_key, label, threshold_value, unit, description) VALUES (?, ?, ?, ?, ?)')
    const tx = db.transaction(() => DEFAULT_RULES.forEach(r => ins.run(r.key, r.label, r.value, r.unit, r.description)))
    tx()
  }
}

function logAction(req: any, action: string, target: string, detail: any) {
  logOperation(req, action, target, detail)
}


function optionalNum(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const value = Number(v)
  return Number.isFinite(value) ? value : null
}
function knownDelta(current: any, previous: any): number | null {
  const cur = optionalNum(current)
  const prev = optionalNum(previous)
  return cur !== null && prev !== null ? cur - prev : null
}
function knownCollectionRate(received: any, receivable: any): number | null {
  const knownReceived = optionalNum(received)
  const knownReceivable = optionalNum(receivable)
  return knownReceived !== null && knownReceivable !== null && knownReceivable > 0
    ? knownReceived / knownReceivable * 100
    : null
}
function pctDelta(cur: number | null, prev: number | null): number | null {
  return cur !== null && prev !== null && prev !== 0 ? (cur - prev) / prev * 100 : null
}
function pickSummary(payload: any) { return payload?.summary || {} }
function metricComparison(currentPayload: any, previousPayload: any) {
  const cur = pickSummary(currentPayload)
  const prev = pickSummary(previousPayload)
  const metrics = [
    ['project_count', '项目数', '个'],
    ['ytd_income', '累计收入', '万元'],
    ['ytd_cost', '累计成本', '万元'],
    ['total_receivable', '应收金额', '万元'],
    ['total_received', '实收金额', '万元'],
    ['collectionRate', '综合收费率', '%'],
    ['profitRate', '利润率', '%'],
    ['avg_quality', '平均品质评分', '分'],
    ['avg_satisfaction', '平均满意度', '分'],
    ['total_complaints', '投诉量', '件'],
    ['total_incidents', '安全事故', '起'],
  ]
  return metrics.map(([key, label, unit]) => {
    const current = optionalNum(cur[key])
    const previous = optionalNum(prev[key])
    const delta = current !== null && previous !== null ? current - previous : null
    return { key, label, unit, current, previous, delta, deltaRate: pctDelta(current, previous) }
  })
}
function sectionMap(payload: any) {
  const sections = Array.isArray(payload?.sections) ? payload.sections : []
  return Object.fromEntries(sections.map((s: any) => [s.title, s.content]))
}
function reportComparison(row: any) {
  const payload = JSON.parse(row.payload || '{}')
  // 归档允许回填历史日期，不能用自增 id 判断业务先后；只比较同范围、同版本且
  // report_date 严格早于当前归档的最近一份事实。
  const previous = db.prepare(`SELECT * FROM report_archives
    WHERE area = ? AND version = ? AND report_date < ?
    ORDER BY report_date DESC, archive_version DESC, id DESC LIMIT 1`)
    .get(row.area, row.version, row.report_date) as any
  const previousPayload = previous ? JSON.parse(previous.payload || '{}') : null
  const metricChanges = previousPayload ? metricComparison(payload, previousPayload) : []
  const curSections = sectionMap(payload)
  const prevSections = previousPayload ? sectionMap(previousPayload) : {}
  const sectionChanges = Object.keys(curSections).map(title => ({ title, current: curSections[title], previous: prevSections[title] || '' }))
  return {
    previous: previous ? { id: previous.id, report_date: previous.report_date, area: previous.area, version: previous.version, title: previous.title, created_at: previous.created_at } : null,
    metricChanges,
    sectionChanges,
    judgement: metricChanges.length ? {
      improved: metricChanges.filter((m: any) => m.delta !== null && ['ytd_income','total_received','collectionRate','profitRate','avg_quality','avg_satisfaction'].includes(m.key) && m.delta > 0).slice(0, 5),
      worsened: metricChanges.filter((m: any) => m.delta !== null && ((['total_complaints','total_incidents','ytd_cost'].includes(m.key) && m.delta > 0) || (['collectionRate','profitRate','avg_quality','avg_satisfaction'].includes(m.key) && m.delta < 0))).slice(0, 5),
    } : { improved: [], worsened: [] },
  }
}
function snapshotComparison(area: string) {
  const months = db.prepare("SELECT month, COUNT(*) as count FROM project_monthly_snapshots WHERE quality_status='verified' GROUP BY month ORDER BY month DESC LIMIT 2").all() as any[]
  if (months.length < 2) return { months, rows: [], summary: { improved: 0, worsened: 0, stable: 0, insufficient: 0, continuousRisk: 0 } }
  const [curM, prevM] = months.map(m => m.month)
  const areaWhere = area && area !== '华北' && area !== '全部' ? 'AND cur.area = ?' : ''
  const rows = db.prepare(`
    SELECT cur.project_name, cur.area,
      cur.ytd_income as cur_income, prev.ytd_income as prev_income,
      cur.ytd_cost as cur_cost, prev.ytd_cost as prev_cost,
      cur.receivable as cur_receivable, cur.received as cur_received,
      prev.receivable as prev_receivable, prev.received as prev_received,
      cur.quality_score as cur_quality, prev.quality_score as prev_quality,
      cur.complaint_count as cur_complaints, prev.complaint_count as prev_complaints,
      cur.safety_incidents as cur_incidents, prev.safety_incidents as prev_incidents
    FROM project_monthly_snapshots cur
    JOIN project_monthly_snapshots prev ON prev.project_name = cur.project_name AND prev.month = ?
    WHERE cur.month = ? AND cur.quality_status='verified' AND prev.quality_status='verified' ${areaWhere}
    ORDER BY cur.area, cur.project_name
  `).all(prevM, curM, ...(areaWhere ? [area] : [])) as any[]
  const enriched = rows.map(r => {
    const curRate = knownCollectionRate(r.cur_received, r.cur_receivable)
    const prevRate = knownCollectionRate(r.prev_received, r.prev_receivable)
    const incomeDelta = knownDelta(r.cur_income, r.prev_income)
    const costDelta = knownDelta(r.cur_cost, r.prev_cost)
    const rateDelta = knownDelta(curRate, prevRate)
    const qualityDelta = knownDelta(r.cur_quality, r.prev_quality)
    const complaintDelta = knownDelta(r.cur_complaints, r.prev_complaints)
    const incidentDelta = knownDelta(r.cur_incidents, r.prev_incidents)
    const curQuality = optionalNum(r.cur_quality)
    const curComplaints = optionalNum(r.cur_complaints)
    const curIncidents = optionalNum(r.cur_incidents)
    const riskFlags = [
      curRate !== null && curRate < 90 ? '收费率低' : '',
      curQuality !== null && curQuality < 85 ? '品质低' : '',
      curComplaints !== null && curComplaints > 20 ? '投诉高' : '',
      curIncidents !== null && curIncidents > 0 ? '安全事故' : '',
    ].filter(Boolean)
    const movements = [incomeDelta, costDelta, rateDelta, qualityDelta, complaintDelta, incidentDelta]
    const hasKnownMovement = movements.some(value => value !== null)
    const adverse = (rateDelta !== null && rateDelta < 0)
      || (qualityDelta !== null && qualityDelta < 0)
      || (complaintDelta !== null && complaintDelta > 0)
      || (incidentDelta !== null && incidentDelta > 0)
      || (incomeDelta !== null && incomeDelta < 0)
      || (costDelta !== null && costDelta > 0)
    const positive = (rateDelta !== null && rateDelta > 0)
      || (qualityDelta !== null && qualityDelta > 0)
      || (complaintDelta !== null && complaintDelta < 0)
      || (incidentDelta !== null && incidentDelta < 0)
      || (incomeDelta !== null && incomeDelta > 0)
      || (costDelta !== null && costDelta < 0)
    const status = !hasKnownMovement ? '数据不足' : adverse ? '需关注' : positive ? '改善' : '稳定'
    return { project_name: r.project_name, area: r.area, currentMonth: curM, previousMonth: prevM, curRate, prevRate, incomeDelta, costDelta, rateDelta, qualityDelta, complaintDelta, incidentDelta, riskFlags, status }
  })
  return { months, rows: enriched, summary: {
    improved: enriched.filter(r => r.status === '改善').length,
    worsened: enriched.filter(r => r.status === '需关注').length,
    stable: enriched.filter(r => r.status === '稳定').length,
    insufficient: enriched.filter(r => r.status === '数据不足').length,
    continuousRisk: enriched.filter(r => r.riskFlags.length > 0).length,
  } }
}

router.get('/api/governance/rules', (_req, res) => {
  ensureRules()
  const rows = db.prepare('SELECT id, rule_key, label, threshold_value, unit, enabled, description, updated_at FROM alert_rules ORDER BY id').all()
  res.json({ rows })
})

router.put('/api/governance/rules/:id', requireAdmin, (req, res) => {
  const { threshold_value, enabled } = req.body || {}
  const existing = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(req.params.id) as any
  if (!existing) return res.status(404).json({ error: '预警规则不存在' })
  if (threshold_value !== undefined) {
    if (typeof threshold_value !== 'number') return res.status(400).json({ error: '阈值必须是大于或等于0的有限数值' })
    const value = threshold_value
    if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: '阈值必须是大于或等于0的有限数值' })
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') return res.status(400).json({ error: '启用状态必须是布尔值' })
  if (threshold_value === undefined && enabled === undefined) return res.status(400).json({ error: '没有可保存的规则字段' })
  const row = db.transaction(() => {
    db.prepare('UPDATE alert_rules SET threshold_value = COALESCE(?, threshold_value), enabled = COALESCE(?, enabled), updated_at = datetime(\'now\',\'localtime\') WHERE id = ?')
      .run(threshold_value === undefined ? null : Number(threshold_value), enabled === undefined ? null : (enabled ? 1 : 0), req.params.id)
    const updated = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(req.params.id)
    const user = (req as any).user || {}
    db.prepare('INSERT INTO operation_logs (user_id,username,action,target,detail,ip) VALUES (?,?,?,?,?,?)')
      .run(user.userId || null, user.username || 'system', '修改预警规则', `alert_rule:${req.params.id}`, JSON.stringify({ before: existing, after: updated }), req.ip || '')
    return updated
  })()
  res.json({ success: true, row })
})

router.get('/api/governance/logs', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 300)
  const rows = db.prepare('SELECT * FROM operation_logs ORDER BY id DESC LIMIT ?').all(limit)
  res.json({ rows })
})

router.get('/api/governance/audit-summary', requireAdmin, (_req, res) => {
  const totalLogs = (db.prepare('SELECT COUNT(*) as cnt FROM operation_logs').get() as { cnt: number }).cnt
  const last7Days = (db.prepare("SELECT COUNT(*) as cnt FROM operation_logs WHERE created_at >= datetime('now','-7 days','localtime')").get() as { cnt: number }).cnt
  const today = (db.prepare("SELECT COUNT(*) as cnt FROM operation_logs WHERE date(created_at) = date('now','localtime')").get() as { cnt: number }).cnt
  const actionCounts = db.prepare("SELECT action, COUNT(*) as count FROM operation_logs WHERE created_at >= datetime('now','-30 days','localtime') GROUP BY action ORDER BY count DESC, action LIMIT 12").all()
  const userCounts = db.prepare("SELECT COALESCE(NULLIF(username,''),'system') as username, COUNT(*) as count FROM operation_logs WHERE created_at >= datetime('now','-30 days','localtime') GROUP BY COALESCE(NULLIF(username,''),'system') ORDER BY count DESC LIMIT 10").all()
  const highRiskActions = db.prepare(`
    SELECT * FROM operation_logs
    WHERE action LIKE '%导入%' OR action LIKE '%恢复%' OR action LIKE '%删除%' OR action LIKE '%密码%' OR action LIKE '%用户%' OR action LIKE '%导出%' OR action LIKE '%归档%'
    ORDER BY id DESC LIMIT 20
  `).all()
  const roleSummary = db.prepare("SELECT role, COUNT(*) as count FROM users GROUP BY role ORDER BY count DESC").all()
  const scopedUsers = db.prepare("SELECT id, username, role, area_scope, project_scope FROM users WHERE COALESCE(area_scope,'') != '' OR COALESCE(project_scope,'') != '' ORDER BY id").all()
  const unscopedManagers = db.prepare("SELECT id, username, role FROM users WHERE role IN ('area_manager','project_manager') AND COALESCE(area_scope,'') = '' AND COALESCE(project_scope,'') = '' ORDER BY id").all()
  const exportCount30 = (db.prepare("SELECT COUNT(*) as cnt FROM operation_logs WHERE action LIKE '%导出%' AND created_at >= datetime('now','-30 days','localtime')").get() as { cnt: number }).cnt
  const importCount30 = (db.prepare("SELECT COUNT(*) as cnt FROM operation_logs WHERE (action LIKE '%导入%' OR action LIKE '%恢复%') AND created_at >= datetime('now','-30 days','localtime')").get() as { cnt: number }).cnt
  const taskChangeCount30 = (db.prepare("SELECT COUNT(*) as cnt FROM operation_logs WHERE target LIKE 'management_task%' AND created_at >= datetime('now','-30 days','localtime')").get() as { cnt: number }).cnt
  res.json({
    totalLogs,
    today,
    last7Days,
    actionCounts,
    userCounts,
    highRiskActions,
    roleSummary,
    scopedUsers,
    unscopedManagers,
    metrics: { exportCount30, importCount30, taskChangeCount30 },
    summary: `近7天记录${last7Days}条操作日志，今日${today}条；近30天导出${exportCount30}次、导入/恢复${importCount30}次、任务变更${taskChangeCount30}次。`,
  })
})

router.get('/api/governance/permissions', requireAdmin, (_req, res) => {
  res.json({ rows: PERMISSION_MATRIX, notes: [
    '系统管理员可查看和维护全部数据、成员与治理配置。',
    '非管理员只读本人绑定的一个权威服务中心，可使用该中心的项目、AI和导出；空、无效或多中心范围失败关闭，且禁止治理、成员管理及业务写入。',
    '成员类型用于明确岗位职责；数据访问仍以所选片区和服务中心白名单为准，未绑定有效服务中心时默认拒绝。',
  ] })
})

router.get('/api/governance/disaster-recovery', requireAdmin, (_req, res) => {
  const root = process.env.COCKPIT_ROOT || '/home/ubuntu/cockpit'
  const readJson = (file: string) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
  const dir = path.join(root, 'backups/database')
  const backups = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^cockpit-.*\.db$/.test(name)).map(name => {
    const file = path.join(dir, name), stat = fs.statSync(file)
    return { name, path: file, size: stat.size, createdAt: stat.mtime.toISOString(), checksum: fs.existsSync(`${file}.sha256`) }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30) : []
  const backupStatus = readJson(path.join(root, 'backups/status/backup-status.json'))
  const restoreStatus = readJson(path.join(root, 'backups/status/restore-status.json'))
  const productionMonitor = readJson(path.join(root, 'runtime/production-monitor-status.json'))
  const offsiteBackupStatus = readJson(path.join(root, 'runtime/offsite-backup-status.json'))
  const offsiteRestoreStatus = readJson(path.join(root, 'runtime/offsite-restore-status.json'))
  const ageHours = (value?: string) => value ? Math.max(0, (Date.now() - new Date(value).getTime()) / 3600000) : null
  const backupAgeHours = ageHours(backupStatus?.finished_at), restoreAgeHours = ageHours(restoreStatus?.finished_at)
  const monitorAgeHours = ageHours(productionMonitor?.checked_at), offsiteBackupAgeHours = ageHours(offsiteBackupStatus?.finished_at), offsiteRestoreAgeHours = ageHours(offsiteRestoreStatus?.finished_at)
  res.json({ backupStatus, restoreStatus, productionMonitor, offsiteBackupStatus, offsiteRestoreStatus, backups, summary: { count: backups.length, latest: backups[0] || null, backupHealthy: backupStatus?.status === 'success' && backupAgeHours !== null && backupAgeHours <= 26, restoreHealthy: restoreStatus?.status === 'success' && restoreAgeHours !== null && restoreAgeHours <= 192, monitorHealthy: productionMonitor?.status === 'success' && monitorAgeHours !== null && monitorAgeHours <= 0.25, offsiteBackupHealthy: offsiteBackupStatus?.status === 'success' && offsiteBackupAgeHours !== null && offsiteBackupAgeHours <= 30, offsiteRestoreHealthy: offsiteRestoreStatus?.status === 'success' && offsiteRestoreAgeHours !== null && offsiteRestoreAgeHours <= 2400, backupAgeHours, restoreAgeHours, monitorAgeHours, offsiteBackupAgeHours, offsiteRestoreAgeHours, backupSlaHours: 26, restoreSlaHours: 192, monitorSlaHours: 0.25, offsiteBackupSlaHours: 30, offsiteRestoreSlaHours: 2400, retentionDays: 30, offsiteRetentionDays: 90 } })
})

router.get('/api/governance/report-archives', requireAdmin, (_req, res) => {
  const records = db.prepare(`SELECT id,report_date,area,version,archive_version,snapshot_month,title,summary,
    created_by,created_at,payload,traceability FROM report_archives ORDER BY id DESC LIMIT 50`).all() as any[]
  const rows = records.map(record => {
    const integrity = evaluateReportArchiveIntegrity(db, record)
    const { payload: _payload, traceability: _traceability, ...row } = record
    return { ...row, status: integrity.valid ? '已归档' : '血缘失效', integrity }
  })
  res.json({ rows, status: reportArchiveStatus() })
})

router.post('/api/governance/report-archives/generate', requireAdmin, (req, res) => {
  if (String(req.body?.confirmation || '') !== '确认生成正式归档') {
    return res.status(400).json({ error: '请输入“确认生成正式归档”后再执行', code: 'CONFIRMATION_REQUIRED' })
  }
  const area = String(req.body?.area || '华北').trim()
  const version = String(req.body?.version || '')
  const reportDate = String(req.body?.reportDate || (db.prepare("SELECT date('now','localtime') value").get() as any)?.value || '')
  if (!['leader', 'operation'].includes(version)) return res.status(400).json({ error: 'version仅支持leader或operation', code: 'INVALID_VERSION' })
  try {
    const result = generateVerifiedReportArchive(req, { area, version: version as 'leader' | 'operation', reportDate })
    res.status(result.idempotent ? 200 : 201).json(result)
  } catch (error: any) {
    const message = String(error?.message || '生成经营归档失败')
    const invalid = /必须为|不是有效|仅支持/.test(message)
    res.status(invalid ? 400 : 409).json({ error: message, code: invalid ? 'INVALID_ARCHIVE_REQUEST' : 'AUTHORITATIVE_SOURCE_UNAVAILABLE' })
  }
})

router.post('/api/governance/report-archives', requireAdmin, (_req, res) => {
  res.status(410).json({
    error: '已停用客户端自带payload归档，请使用服务端正式生成接口。',
    code: 'CLIENT_REPORT_ARCHIVE_DISABLED',
    replacement: '/api/governance/report-archives/generate',
  })
})

router.get('/api/governance/report-archives/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM report_archives WHERE id = ?').get(req.params.id) as any
  if (!row) return res.status(404).json({ error: '归档不存在' })
  let payload: any = {}
  try { payload = JSON.parse(row.payload || '{}') } catch {}
  let traceability: any = {}
  try { traceability = JSON.parse(row.traceability || '{}') } catch {}
  const integrity = evaluateReportArchiveIntegrity(db, row)
  res.json({ ...row, status: integrity.valid ? '已归档' : '血缘失效', payload,
    traceability: Object.keys(traceability).length ? traceability : payload.traceability || {},
    integrity, comparison: reportComparison(row), snapshotComparison: snapshotComparison(row.area), immutable: true })
})

router.get('/api/governance/report-archives/:id/comparison', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM report_archives WHERE id = ?').get(req.params.id) as any
  if (!row) return res.status(404).json({ error: '归档不存在' })
  const integrity = evaluateReportArchiveIntegrity(db, row)
  res.json({ id: row.id, area: row.area, version: row.version,
    status: integrity.valid ? '已归档' : '血缘失效', integrity,
    comparison: reportComparison(row), snapshotComparison: snapshotComparison(row.area) })
})

export default router
