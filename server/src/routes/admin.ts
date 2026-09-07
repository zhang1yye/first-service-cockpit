import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import db from '../db.js'
import { requireAdmin } from '../auth.js'
import { buildAdminQualityReport, normalizeCenterKey, type MappingLink } from '../admin-quality.js'
import { DEMO_PROJECT_NAMES } from '../data-quality-gate.js'
import { logOperation } from '../audit.js'
import {
  defaultQualitySlaDays,
  isQualityWorkflowStatus,
  qualityCaseTiming,
  validateQualityTransition,
  type QualityWorkflowStatus,
} from '../quality-workflow.js'

const router = Router()
const root = () => process.env.COCKPIT_ROOT || path.join(process.env.HOME || '', 'cockpit')

function scalar(sql: string, ...params: unknown[]): number {
  try { return Number((db.prepare(sql).get(...params) as any)?.value || 0) } catch { return 0 }
}
function nullableScalar(sql: string, ...params: unknown[]): number | null {
  try {
    const value = (db.prepare(sql).get(...params) as any)?.value
    return value === null || value === undefined ? null : Number(value)
  } catch { return null }
}
function readJson(name: string): any | null {
  try { return JSON.parse(fs.readFileSync(path.join(root(), name), 'utf8')) } catch { return null }
}
function findArray(value: any): any[] | null {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return null
  for (const key of ['rows', 'data', 'details', 'projects', 'centers', '明细', '项目明细', '收缴明细']) {
    if (Array.isArray(value[key])) return value[key]
  }
  for (const nested of Object.values(value)) {
    const found = findArray(nested)
    if (found) return found
  }
  return null
}
function findRate(value: any): number | null {
  if (!value || typeof value !== 'object') return null
  for (const [key, candidate] of Object.entries(value)) {
    if (/收缴率|collection.?rate/i.test(key)) {
      const raw = typeof candidate === 'string' ? candidate.replace('%', '') : candidate
      const n = Number(raw)
      if (Number.isFinite(n)) return n > 1 ? n / 100 : n
    }
  }
  for (const nested of Object.values(value)) {
    const found = findRate(nested)
    if (found !== null) return found
  }
  return null
}
function aphFacts() {
  const aph = readJson('APH决策_每日提取.json')
  const kpi = aph?.['华北地区']?.['回款额'] || aph?.regions?.['华北地区']?.payment || null
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = kpi?.[key]
      if (value !== null && value !== undefined && Number.isFinite(Number(value))) return Number(value)
    }
    return null
  }
  return {
    annualBudget: pick('年度预算_万', '年度预算', 'annualBudget'),
    cumulativeBudget: pick('累计预算_万', '累计预算', 'cumulativeBudget'),
    cumulativeExecuted: pick('累计执行_万', '累计执行', 'cumulativeExecuted'),
    samePeriod: pick('同期执行_万', '同期执行', 'samePeriod'),
    budgetWeeklyAnnual: (() => {
      const value = aph?.sourceLayers?.budgetWeekly?.values?.annualBudget ?? aph?.source_layers?.budgetWeekly?.values?.annualBudget
      return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value)
    })(),
    extractedAt: aph?.extractedAt || aph?.date || null,
    businessDate: aph?.businessDate || aph?.business_date || aph?.date || null,
    sourceLayers: aph?.sourceLayers || aph?.source_layers || {},
    reconciliations: aph?.reconciliations || {},
  }
}

function parseJson(value: unknown, fallback: any) {
  try { return typeof value === 'string' ? JSON.parse(value) : (value ?? fallback) } catch { return fallback }
}

function latestP46Batch() {
  try {
    const row = db.prepare(`SELECT id,source_key,business_date,extracted_at,batch_sha256,source_files,status,publishable,
      row_count,mapped_count,unmapped_count,validation_errors,summary,created_by,created_at,published_by,published_at,confirm_note
      FROM data_ingestion_batches ORDER BY id DESC LIMIT 1`).get() as any
    if (!row) return null
    return {
      ...row,
      publishable: Boolean(row.publishable),
      sourceFiles: (parseJson(row.source_files, []) as any[]).map(({ path: _path, ...file }) => file),
      validationErrors: parseJson(row.validation_errors, []),
      analysis: parseJson(row.summary, {}),
      source_files: undefined,
      validation_errors: undefined,
      summary: undefined,
    }
  } catch { return null }
}

function localBusinessDate() {
  try { return String((db.prepare("SELECT date('now','localtime') value").get() as any)?.value || new Date().toISOString().slice(0, 10)) }
  catch { return new Date().toISOString().slice(0, 10) }
}

function caseView(row: any, today = localBusinessDate()) {
  return row ? { ...row, evidence: parseJson(row.evidence_json, {}), evidence_json: undefined, timing: qualityCaseTiming(row, today) } : null
}

function syncQualityCases(issues: ReturnType<typeof buildAdminQualityReport>['issues']) {
  const upsert = db.prepare(`INSERT INTO data_quality_cases
    (code,severity,category,title,detail,evidence_json,recommendation)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET severity=excluded.severity,category=excluded.category,title=excluded.title,
      detail=excluded.detail,evidence_json=excluded.evidence_json,recommendation=excluded.recommendation`)
  db.transaction(() => {
    for (const issue of issues) upsert.run(issue.code, issue.severity, issue.category, issue.title, issue.detail, JSON.stringify(issue.evidence || {}), issue.recommendation)
  })()
}

function workflowByCode(codes: string[]) {
  if (!codes.length) return new Map<string, any>()
  const rows = db.prepare(`SELECT code,workflow_status,owner,due_date,sla_days,claimed_at,
    handling_note,evidence_ref,review_note,reviewed_by,resolution_note,updated_at,review_submitted_at,resolved_at
    FROM data_quality_cases WHERE code IN (${codes.map(() => '?').join(',')})`).all(...codes) as any[]
  const today = localBusinessDate()
  return new Map(rows.map(row => [row.code, caseView(row, today)]))
}
function currentLinks(): MappingLink[] {
  try {
    return (db.prepare(`SELECT l.profile_id profileId,l.source_system sourceSystem,l.source_center sourceCenter,p.service_center profileName
      FROM project_profile_center_links l JOIN project_profiles p ON p.id=l.profile_id
      WHERE l.batch_id=(SELECT MAX(id) FROM project_profile_import_batches)
      ORDER BY l.source_system,l.source_center,p.service_center`).all() as any[])
  } catch { return [] }
}
function copiedSnapshotCount(): number {
  try {
    return scalar(`SELECT COUNT(*) value FROM (
      SELECT project_name FROM project_monthly_snapshots
      GROUP BY project_name HAVING COUNT(DISTINCT month)>=3 AND COUNT(DISTINCT printf('%.6f|%.6f|%.6f|%.6f|%.6f|%d|%.6f|%d',ytd_income,ytd_cost,receivable,received,quality_score,safety_incidents,customer_satisfaction,complaint_count))=1
    )`)
  } catch { return 0 }
}
function qualityInput() {
  const aph = aphFacts()
  const collectionDetail = readJson('绿仔收缴明细.json')
  const collectionSummary = readJson('绿仔收款汇总.json')
  const detailRows = findArray(collectionDetail)
  const links = currentLinks()
  const collectionReceivable = nullableScalar('SELECT SUM(receivable) value FROM collection_centers')
  const collectionReceived = nullableScalar('SELECT SUM(received) value FROM collection_centers')
  const dbRate = collectionReceivable && collectionReceived !== null ? collectionReceived / collectionReceivable : null
  return {
    projectCount: scalar('SELECT COUNT(*) value FROM projects'),
    demoProjectCount: scalar(
      `SELECT COUNT(*) value FROM projects WHERE name IN (${DEMO_PROJECT_NAMES.map(() => '?').join(',')})`,
      ...DEMO_PROJECT_NAMES,
    ),
    demoImportCount: scalar("SELECT COUNT(*) value FROM import_logs WHERE filename='系统内置演示数据'"),
    quarantinedRecordCount: scalar("SELECT COUNT(*) value FROM data_quarantine WHERE status='quarantined'"),
    samePeriodZeroCount: scalar('SELECT COUNT(*) value FROM payment_centers WHERE same_period=0'),
    activeSamePeriodZeroCount: scalar("SELECT COUNT(*) value FROM payment_centers WHERE same_period=0 AND center NOT LIKE '%撤场%'"),
    copiedSnapshotProjectCount: copiedSnapshotCount(),
    paymentAnnualTotal: nullableScalar('SELECT SUM(annual_budget) value FROM payment_centers'),
    aphAnnualBudget: aph.annualBudget,
    aphBudgetWeeklyAnnual: aph.budgetWeeklyAnnual,
    detailSamePeriodTotal: nullableScalar('SELECT SUM(same_period) value FROM payment_centers'),
    aphSamePeriod: aph.samePeriod,
    collectionDbRows: scalar('SELECT COUNT(*) value FROM collection_centers'),
    collectionSourceRows: detailRows ? detailRows.length : null,
    collectionDbRate: dbRate,
    collectionOfficialRate: findRate(collectionSummary) ?? findRate(collectionDetail),
    links,
  }
}

router.get('/api/admin/quality', requireAdmin, (_req, res) => {
  const report = buildAdminQualityReport(qualityInput())
  syncQualityCases(report.issues)
  const workflows = workflowByCode(report.issues.map(issue => issue.code))
  const issues = report.issues.map(issue => ({ ...issue, workflow: workflows.get(issue.code) || null }))
  res.json({ ...report, issues, sources: { aph: aphFacts(), rootConfigured: Boolean(process.env.COCKPIT_ROOT) }, latestP46: latestP46Batch() })
})

router.get('/api/admin/quality-cases', requireAdmin, (req, res) => {
  const requested = Number(req.query.limit || 200)
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 1000) : 200
  const status = String(req.query.status || '').trim()
  if (status && !isQualityWorkflowStatus(status)) return res.status(400).json({ error: '责任状态无效' })
  const rows = (status
    ? db.prepare('SELECT * FROM data_quality_cases WHERE workflow_status=? ORDER BY updated_at DESC,code LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM data_quality_cases ORDER BY updated_at DESC,code LIMIT ?').all(limit)) as any[]
  const today = localBusinessDate()
  const views = rows.map(row => caseView(row, today))
  const summary = views.reduce((acc: Record<string, number>, row: any) => {
    acc.total += 1
    acc[row.workflow_status] = (acc[row.workflow_status] || 0) + 1
    if (row.workflow_status !== 'resolved') acc.active += 1
    if (!row.owner) acc.unassigned += 1
    if (row.timing?.isOverdue) acc.overdue += 1
    if (row.timing?.isDueSoon) acc.dueSoon += 1
    return acc
  }, { total: 0, active: 0, pending: 0, claimed: 0, in_progress: 0, review: 0, resolved: 0, unassigned: 0, overdue: 0, dueSoon: 0 })
  res.json({ generatedAt: new Date().toISOString(), summary, rows: views })
})

router.put('/api/admin/quality-cases/:code/status', requireAdmin, (req, res) => {
  const code = String(req.params.code || '').trim()
  const target = req.body?.status
  if (!isQualityWorkflowStatus(target)) return res.status(400).json({ error: '责任状态无效' })
  const current = db.prepare('SELECT * FROM data_quality_cases WHERE code=?').get(code) as any
  if (!current) return res.status(404).json({ error: '异常责任单不存在，请先重新检测' })
  const owner = String(req.body?.owner || '').trim()
  const note = String(req.body?.note || '').trim()
  const dueDate = String(req.body?.dueDate || '').trim()
  const evidenceRef = String(req.body?.evidenceRef || '').trim()
  const checked = validateQualityTransition(current.workflow_status as QualityWorkflowStatus, target, { owner, note, dueDate, evidenceRef })
  if (!checked.ok) return res.status(409).json({ error: checked.error })
  const reviewer = String((req as any).user?.username || '')
  const slaDays = defaultQualitySlaDays(current.severity)
  const result = db.prepare(`UPDATE data_quality_cases SET workflow_status=?,
    owner=CASE WHEN ?='claimed' THEN ? ELSE owner END,
    due_date=CASE WHEN ?='claimed' THEN ? ELSE due_date END,
    sla_days=CASE WHEN ?='claimed' THEN ? ELSE sla_days END,
    claimed_at=CASE WHEN ?='claimed' THEN datetime('now','localtime') ELSE claimed_at END,
    handling_note=CASE WHEN ?='review' THEN ? ELSE handling_note END,
    evidence_ref=CASE WHEN ?='review' THEN ? ELSE evidence_ref END,
    review_note=CASE WHEN ?='resolved' THEN ? ELSE review_note END,
    reviewed_by=CASE WHEN ?='resolved' THEN ? ELSE reviewed_by END,
    resolution_note=CASE WHEN ?='resolved' THEN ? ELSE resolution_note END,
    review_submitted_at=CASE WHEN ?='review' THEN datetime('now','localtime') ELSE review_submitted_at END,
    resolved_at=CASE WHEN ?='resolved' THEN datetime('now','localtime') ELSE resolved_at END,
    updated_at=datetime('now','localtime') WHERE code=? AND workflow_status=?`)
    .run(
      target,
      target, owner,
      target, dueDate,
      target, slaDays,
      target,
      target, note,
      target, evidenceRef,
      target, note,
      target, reviewer,
      target, note,
      target,
      target,
      code, current.workflow_status,
    )
  if (!result.changes) return res.status(409).json({ error: '责任状态已变化，请刷新后重试' })
  const updated = db.prepare('SELECT * FROM data_quality_cases WHERE code=?').get(code) as any
  logOperation(req, '推进数据质量异常责任流', `data_quality_case:${code}`, {
    fromStatus: current.workflow_status,
    toStatus: target,
    owner: owner || current.owner,
    dueDate: dueDate || current.due_date,
    evidenceRef,
    note,
  })
  res.json({ row: caseView(updated) })
})

router.get('/api/admin/mappings', requireAdmin, (_req, res) => {
  const links = currentLinks()
  const report = buildAdminQualityReport({ ...qualityInput(), links })
  const batch = (() => { try { return db.prepare('SELECT id,source_file,source_sha256,profile_count,phase_count,imported_at FROM project_profile_import_batches ORDER BY id DESC LIMIT 1').get() || null } catch { return null } })()
  const profiles = (() => { try { return db.prepare(`SELECT p.id,p.service_center,p.area,p.management_status,p.company_entity,p.client_type,p.signed_area,p.managed_area,COUNT(l.id) linkCount
    FROM project_profiles p LEFT JOIN project_profile_center_links l ON l.profile_id=p.id AND l.batch_id=p.batch_id
    WHERE p.batch_id=(SELECT MAX(id) FROM project_profile_import_batches)
    GROUP BY p.id ORDER BY p.area,p.service_center`).all() } catch { return [] } })()
  const linkedProfiles = new Set(links.map(link => link.profileId))
  res.json({ batch, summary: { profiles: (profiles as any[]).length, links: links.length, linkedProfiles: linkedProfiles.size, unlinkedProfiles: (profiles as any[]).length - linkedProfiles.size, collisions: report.collisions.length }, profiles, links, collisions: report.collisions })
})

router.get('/api/admin/overview', requireAdmin, (_req, res) => {
  const report = buildAdminQualityReport(qualityInput())
  const sources = (() => { try { return db.prepare('SELECT source_key,name,source_type,status,last_sync_at,note,updated_at FROM data_sources ORDER BY id').all() } catch { return [] } })()
  const latestRuns = (() => { try { return db.prepare('SELECT id,source_key,source_name,run_type,status,health,message,duration_ms,operator,started_at,finished_at FROM data_source_sync_runs ORDER BY id DESC LIMIT 12').all() } catch { return [] } })()
  const latestBatch = (() => { try { return db.prepare('SELECT id,source_key,business_date,status,publishable,row_count,mapped_count,unmapped_count,created_at,published_at FROM data_ingestion_batches ORDER BY id DESC LIMIT 1').get() || null } catch { return null } })()
  const latestArchive = (() => { try { return db.prepare('SELECT id,report_date,area,version,archive_version,title,created_by,created_at FROM report_archives ORDER BY id DESC LIMIT 1').get() || null } catch { return null } })()
  res.json({
    generatedAt: new Date().toISOString(),
    quality: report.summary,
    sources,
    latestRuns,
    latestBatch,
    latestArchive,
    counts: {
      users: scalar('SELECT COUNT(*) value FROM users'),
      admins: scalar("SELECT COUNT(*) value FROM users WHERE role='admin'"),
      profiles: scalar('SELECT COUNT(*) value FROM project_profiles WHERE batch_id=(SELECT MAX(id) FROM project_profile_import_batches)'),
      operationLogs: scalar('SELECT COUNT(*) value FROM operation_logs'),
      reportArchives: scalar('SELECT COUNT(*) value FROM report_archives'),
      quarantinedRecords: scalar("SELECT COUNT(*) value FROM data_quarantine WHERE status='quarantined'"),
      databaseBackups: (() => { try { return fs.readdirSync(path.join(root(), 'backups/database')).filter(name => /^cockpit-.*\.db$/.test(name)).length } catch { return 0 } })(),
    },
    topIssues: report.issues.slice(0, 6),
  })
})

router.get('/api/admin/quarantine', requireAdmin, (req, res) => {
  const requested = Number(req.query.limit || 200)
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 1000) : 200
  const rows = (() => {
    try {
      return db.prepare(`SELECT id,batch_key,source_table,source_id,reason,status,quarantined_by,quarantined_at,restored_by,restored_at
        FROM data_quarantine ORDER BY id DESC LIMIT ?`).all(limit)
    } catch { return [] }
  })()
  const batches = (() => {
    try {
      return db.prepare(`SELECT batch_key,status,COUNT(*) record_count,COUNT(DISTINCT source_table) table_count,
        MIN(quarantined_at) quarantined_at,MAX(quarantined_by) quarantined_by
        FROM data_quarantine GROUP BY batch_key,status ORDER BY quarantined_at DESC`).all()
    } catch { return [] }
  })()
  res.json({
    summary: {
      total: scalar('SELECT COUNT(*) value FROM data_quarantine'),
      quarantined: scalar("SELECT COUNT(*) value FROM data_quarantine WHERE status='quarantined'"),
      restored: scalar("SELECT COUNT(*) value FROM data_quarantine WHERE status='restored'"),
    },
    batches,
    rows,
  })
})

router.get('/api/admin/system', requireAdmin, (_req, res) => {
  let integrity = 'unknown'
  try { integrity = String((db.pragma('integrity_check') as any[])?.[0]?.integrity_check || 'unknown') } catch {}
  res.json({ database: { integrity, wal: String(db.pragma('journal_mode', { simple: true }) || ''), pathExposed: false }, process: { uptimeSeconds: Math.round(process.uptime()), node: process.version }, security: { authentication: 'JWT', adminRequired: true, tokenTtl: '24h', dangerousResetEnabled: false } })
})

export default router
