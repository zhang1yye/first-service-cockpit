import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import db from '../db.js'
import { requireAdmin } from '../auth.js'
import { affectedPagesForSource, classifyFreshness, freshnessLabel } from '../data-freshness.js'
import { compareSnapshotMonths, planLegacyProjectMigration } from '../master-data.js'
import { readProjectDataGate } from '../data-quality-gate.js'
import { projectOperatingSourceCopy } from '../data-source-copy.js'
import { classifyPublicationStatus, type PublicationSourceEvidence } from '../data-publication-status.js'
import { logOperationStrict } from '../audit.js'
import { formalP46PublicationPredicate } from '../formal-p46-publication.js'
import { readLiveCollectionPublication } from '../live-collection-publication.js'
import { evaluateBusinessDate, isRecentBusinessDate } from '../business-date.js'
import { fixedEntryPath, fixedEntryRoot } from '../fixed-entry-root.js'

const router = Router()

const DEFAULT_SOURCES = [
  { key: 'aph', name: 'APH 决策/FineReport 回款数据', type: 'file+script', endpoint: '私有运行目录/APH决策_每日提取.json', note: '读取 APH/FineReport 每日提取 JSON；正式同步仍由现有抓取脚本负责。' },
  { key: 'finereport', name: 'FineReport 项目经营报表', type: 'controlled-p46', endpoint: 'P46受控批次：/api/data-pipeline/preview → /api/data-pipeline/batches/:id/publish', note: '生产只接受抓取任务写入P46中转箱，经SHA、映射、差异和真实性门禁核验后由管理员发布；禁止手工导入。' },
  { key: 'lvzai', name: '绿仔 ERP 收缴率数据', type: 'file+script', endpoint: '私有运行目录/绿仔收款汇总.json', note: '读取绿仔官方收缴率口径文件；如文件不存在则显示待接入。' },
]

type SourceHealth = 'ok' | 'warning' | 'danger'
type QualityLevel = 'success' | 'warning' | 'danger'

function monthNow() { return new Date().toISOString().slice(0, 7) }
function n(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : Number(v || 0) }
function optionalNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const value = Number(v)
  return Number.isFinite(value) ? value : null
}
function fileSizeLabel(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10}KB`
  return `${Math.round(bytes / 1024 / 102.4) / 10}MB`
}
function hoursSince(d?: Date | null) {
  if (!d || Number.isNaN(d.getTime())) return null
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 360_000) / 10)
}
function parseDate(v: unknown) {
  if (!v) return null
  const d = new Date(String(v).replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? null : d
}
function currentMonth(d = new Date()) { return d.toISOString().slice(0, 7) }

function readJsonSafe(file: string): any | null {
  try {
    const stat = fs.statSync(file)
    if (stat.size <= 0) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch { return null }
}
function validateAphJson(file: string) {
  const data = readJsonSafe(file)
  const kpi = data?.['华北地区']?.['回款额']
  const ok = Boolean(kpi && Number.isFinite(Number(kpi['累计执行_万'])) && Number.isFinite(Number(kpi['累计预算_万'])))
  return { ok, data, kpi, extractedAt: data?.extractedAt || data?.date || null }
}
function latestAphCandidate() {
  const dir = fixedEntryRoot()
  try {
    const rows = fs.readdirSync(dir)
      .filter(name => /^APH决策_每日提取_\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .map(name => {
        const file = path.join(dir, name)
        const stat = fs.statSync(file)
        const v = validateAphJson(file)
        return { file, name, size: stat.size, mtime: stat.mtime, mtimeMs: stat.mtimeMs, valid: v.ok, extractedAt: v.extractedAt, date: name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || '' }
      })
      .filter(x => x.valid && x.size > 0)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    return rows[0] || null
  } catch { return null }
}
function fileRepairInfo(sourceKey: string, currentFile: string) {
  if (sourceKey !== 'aph') return null
  const latest = latestAphCandidate()
  if (!latest) return { repairable: false, reason: '未发现可用的按日期 APH JSON 候选文件。' }
  let currentMtime = 0
  let currentValid = false
  try { const stat = fs.statSync(currentFile); currentMtime = stat.mtimeMs; currentValid = validateAphJson(currentFile).ok } catch {}
  const repairable = !currentValid || latest.mtimeMs > currentMtime + 1000
  return {
    repairable,
    reason: repairable ? `发现更新的 APH 候选文件 ${latest.name}，可安全回写固定入口。` : '固定入口已是最新可用 APH 文件。',
    candidate: { name: latest.name, size: latest.size, mtime: latest.mtime.toISOString(), extractedAt: latest.extractedAt, date: latest.date },
  }
}
function nextSnapshotDate(day = 2) {
  const d = new Date()
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day, 6, 30, 0))
  if (d.getUTCDate() > day) next.setUTCMonth(next.getUTCMonth() + 1)
  return next.toISOString().slice(0, 10)
}
function snapshotHealth(projects: any[]) {
  const issues: string[] = []
  if (projects.length < 5) issues.push(`项目数量异常：${projects.length} 条`)
  const noIncome = projects.filter(p => n(p.ytd_income) <= 0).length
  const noReceivable = projects.filter(p => n(p.receivable) <= 0).length
  const highRate = projects.filter(p => n(p.receivable) > 0 && n(p.received) / n(p.receivable) > 1.2).length
  if (noIncome > projects.length * 0.5) issues.push(`超过半数项目累计收入为空：${noIncome}/${projects.length}`)
  if (noReceivable > projects.length * 0.5) issues.push(`超过半数项目应收为空：${noReceivable}/${projects.length}`)
  if (highRate > 0) issues.push(`存在实收显著高于应收项目：${highRate} 个`)
  return { ok: issues.length === 0, issues }
}
type SnapshotResult = { success: boolean; status: string; month: string; inserted: number; skipped: number; message: string }
function createSnapshot(month: string, source: string, force = false, record: (result: SnapshotResult) => void): SnapshotResult {
  const finish = (result: SnapshotResult) => {
    db.transaction(() => record(result))()
    return result
  }
  if (month !== monthNow()) return finish({ success: false, status: 'failed', month, inserted: 0, skipped: 0, message: '禁止使用当前项目主表补造历史期间快照' })
  const truthGate = readProjectDataGate(db)
  if (!truthGate.ready) return finish({ success: false, status: 'failed', month, inserted: 0, skipped: 0, message: truthGate.reasons.join('；') })
  const projects = db.prepare('SELECT * FROM projects ORDER BY area, name').all() as any[]
  if (!projects.length) return finish({ success: false, status: 'failed', month, inserted: 0, skipped: 0, message: '当前没有项目数据，无法生成月度快照' })
  const health = snapshotHealth(projects)
  if (!health.ok && !force) return finish({ success: false, status: 'failed', month, inserted: 0, skipped: 0, message: health.issues.join('；') })
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM project_monthly_snapshots WHERE month = ?').get(month) as { cnt: number }
  if (existing.cnt > 0 && !force) return finish({ success: true, status: 'skipped', month, inserted: 0, skipped: existing.cnt, message: `${month} 快照已存在 ${existing.cnt} 条，已跳过防重复` })
  const ins = db.prepare(`INSERT INTO project_monthly_snapshots
    (month, project_id, project_name, area, property_type, ytd_income, ytd_cost, receivable, received, quality_score, safety_incidents, customer_satisfaction, complaint_count, source, quality_status, quality_reason, source_status, business_date, last_validated_at, field_provenance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(month, project_name) DO UPDATE SET
      project_id=excluded.project_id, area=excluded.area, property_type=excluded.property_type,
      ytd_income=excluded.ytd_income, ytd_cost=excluded.ytd_cost, receivable=excluded.receivable, received=excluded.received,
      quality_score=excluded.quality_score, safety_incidents=excluded.safety_incidents,
      customer_satisfaction=excluded.customer_satisfaction, complaint_count=excluded.complaint_count,
      source=excluded.source, quality_status=excluded.quality_status, quality_reason=excluded.quality_reason,
      source_status=excluded.source_status, business_date=excluded.business_date,
      last_validated_at=excluded.last_validated_at, field_provenance=excluded.field_provenance,
      created_at=datetime('now','localtime')`)
  const result: SnapshotResult = { success: true, status: 'success', month, inserted: projects.length, skipped: 0, message: '已从通过真实性门禁的当前项目生成验证快照' }
  db.transaction(() => {
    if (force) db.prepare('DELETE FROM project_monthly_snapshots WHERE month = ?').run(month)
    const validatedAt = new Date().toISOString()
    const businessDate = validatedAt.slice(0, 10)
    for (const p of projects) {
      const provenance = JSON.stringify({ sourceTable: 'projects', sourceSystem: p.source_system || '', sourceBatch: p.source_batch || '', capturedFields: ['ytd_income', 'ytd_cost', 'receivable', 'received', 'quality_score', 'safety_incidents', 'customer_satisfaction', 'complaint_count'] })
      ins.run(month, p.id, p.name, p.area, p.property_type || '', optionalNumber(p.ytd_income), optionalNumber(p.ytd_cost), optionalNumber(p.receivable), optionalNumber(p.received), optionalNumber(p.quality_score), optionalNumber(p.safety_incidents), optionalNumber(p.customer_satisfaction), optionalNumber(p.complaint_count), source, 'verified', '', 'available', businessDate, validatedAt, provenance)
    }
    record(result)
  })()
  return result
}
function ensureSources() {
  const cnt = db.prepare('SELECT COUNT(*) as cnt FROM data_sources').get() as { cnt: number }
  if (cnt.cnt === 0) {
    const ins = db.prepare('INSERT INTO data_sources (source_key, name, source_type, endpoint, status, note) VALUES (?, ?, ?, ?, ?, ?)')
    const tx = db.transaction(() => DEFAULT_SOURCES.forEach(s => ins.run(s.key, s.name, s.type, s.endpoint, '待检测', s.note)))
    tx()
  }
}
function logAction(req: any, action: string, target: string, detail: any) {
  const user = req.user || {}
  try {
    db.prepare('INSERT INTO operation_logs (user_id, username, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.userId || null, user.username || '', action, target, JSON.stringify(detail || {}), req.ip || '')
  } catch {}
}
function syncRunStatus(health: SourceHealth) {
  if (health === 'ok') return 'success'
  if (health === 'warning') return 'warning'
  return 'failed'
}
function recordSyncRun(req: any, source: any, inspected: any, startedAt: number) {
  const user = req.user || {}
  const status = syncRunStatus(inspected.health)
  const durationMs = Math.max(0, Date.now() - startedAt)
  const inserted = db.prepare(`INSERT INTO data_source_sync_runs
    (source_key, source_name, run_type, status, health, message, detail, duration_ms, operator, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch', 'localtime'), datetime('now','localtime'))`)
    .run(
      source.source_key,
      source.name,
      'manual-check',
      status,
      inspected.health,
      inspected.suggestion || inspected.detail || '',
      JSON.stringify({
        status: inspected.status,
        detail: inspected.detail,
        last_sync_at: inspected.last_sync_at,
        ageHours: inspected.ageHours,
        expectedFreshHours: inspected.expectedFreshHours,
        repair: inspected.repair || null,
      }),
      durationMs,
      user.username || '',
      Math.floor(startedAt / 1000),
    )
  return { id: Number(inserted.lastInsertRowid), status, durationMs }
}
function remediationTemplate(sourceKey: string) {
  if (sourceKey === 'aph') return {
    title: 'APH / FineReport 回款文件修复模板',
    sourceKey,
    owner: '数据管理员',
    steps: [
      '确认 APH/FineReport 每日提取任务是否执行成功。',
      '检查私有运行目录/APH决策_每日提取.json 是否存在且为最新导出文件。',
      '核对应收、实收、收款中心等关键字段是否完整。',
      '重新执行连接检测，并记录同步时间与文件大小。',
    ],
    acceptance: [
      '检测状态为已连接，健康状态为正常或关注。',
      '文件更新时间不超过 72 小时。',
      '数据质量报告不再出现 APH 文件缺失或超时导致的异常。',
    ],
    evidence: '提交 APH 文件更新时间、文件大小、检测结果和异常处理说明。',
    autoCheck: '系统会复查本地 APH JSON 文件是否存在、是否超 72 小时未更新。',
  }
  if (sourceKey === 'lvzai') return {
    title: '绿仔 ERP 收缴率文件修复模板',
    sourceKey,
    owner: '数据管理员',
    steps: [
      '确认绿仔 ERP 收缴率导出任务是否完成。',
      '检查私有运行目录/绿仔收款汇总.json 是否存在且为最新口径。',
      '核对项目名称、应收、实收、收缴率字段是否可被驾驶舱识别。',
      '重新执行连接检测，并记录检测结果。',
    ],
    acceptance: [
      '检测状态为已连接，健康状态为正常或关注。',
      '文件更新时间不超过 72 小时。',
      '收缴率数据可用于回款分析和月报复盘。',
    ],
    evidence: '提交绿仔文件更新时间、文件大小、口径确认和检测结果。',
    autoCheck: '系统会复查本地绿仔 JSON 文件是否存在、是否超 72 小时未更新。',
  }
  return {
    title: 'FineReport 项目经营报表修复模板',
    sourceKey: 'finereport',
    owner: '数据管理员',
    steps: [
      '确认APH/FineReport抓取任务已把原始文件写入P46中转箱。',
      '执行P46受控批次预览，核对源文件SHA、业务日期、中心映射和增改删差异。',
      '仅在真实性门禁全部通过后，由管理员确认发布该P46批次。',
      '核对发布批次、三数据源成功审计记录和受影响经营页面。',
    ],
    acceptance: [
      'P46批次状态为published，且源文件SHA和归档路径可追溯。',
      'APH、FineReport、绿仔三条成功同步审计与批次发布时间一致。',
      '真实性门禁无未映射中心、来源缺失或验证失败。',
    ],
    evidence: '提交P46批次ID、源文件SHA、差异预览、发布确认说明和三数据源同步审计。',
    autoCheck: '系统会复查P46发布状态、真实性门禁、源文件归档与三数据源成功审计。',
  }
}
function inspectSource(row: any) {
  const sourceDefinition = DEFAULT_SOURCES.find(source => source.key === row.source_key)
  if (sourceDefinition) {
    // 历史数据库可能仍保留 ~/cockpit 展示值；响应层统一使用私有逻辑路径，不因GET修改数据库。
    row = { ...row, endpoint: sourceDefinition.endpoint, note: sourceDefinition.note }
  }
  let status = row.status || '待检测'
  let last_sync_at = row.last_sync_at
  let detail = row.note || ''
  let health: SourceHealth = 'warning'
  let suggestion = '请执行一次连接检测，确认数据源可用性。'
  let operatorAction = ''
  let expectedFreshHours = 72
  let ageHours: number | null = null
  let stale = false
  let repair: any = null
  let state: string | null = null
  let applicability: 'applicable' | 'not_applicable' = 'applicable'
  if (row.source_key === 'aph') {
    const file = fixedEntryPath('APH决策_每日提取.json')
    repair = fileRepairInfo('aph', file)
    if (fs.existsSync(file)) {
      const stat = fs.statSync(file)
      const valid = validateAphJson(file)
      ageHours = hoursSince(stat.mtime)
      stale = ageHours !== null && ageHours > expectedFreshHours
      status = valid.ok ? '已连接' : '数据异常'
      last_sync_at = stat.mtime.toISOString()
      detail = `发现 APH JSON，大小 ${fileSizeLabel(stat.size)}${repair?.candidate ? `；最新候选 ${repair.candidate.name}（${repair.candidate.extractedAt || repair.candidate.date}）` : ''}`
      health = !valid.ok ? 'danger' : repair?.repairable ? 'warning' : stale ? 'warning' : 'ok'
      suggestion = !valid.ok
        ? 'APH 固定入口文件字段不完整，请用最新有效候选文件修复或重新执行抓取。'
        : repair?.repairable
          ? repair.reason
          : stale ? 'APH 文件超过 72 小时未更新，请检查抓取脚本或手动同步。' : 'APH 文件更新正常，继续保持每日同步。'
    } else {
      status = '待接入'
      health = repair?.repairable ? 'warning' : 'danger'
      detail = repair?.candidate ? `未发现固定入口，但发现候选 ${repair.candidate.name}` : '未发现 APH 每日提取 JSON'
      suggestion = repair?.repairable ? repair.reason : '请确认 APH/FineReport 抓取脚本是否已部署，并检查私有运行目录/APH决策_每日提取.json。'
    }
  }
  if (row.source_key === 'lvzai') {
    const file = fixedEntryPath('绿仔收款汇总.json')
    const syncStatus = readJsonSafe(fixedEntryPath('绿仔同步状态.json'))
    const syncOk = syncStatus?.ok === true
    const syncFailed = syncStatus?.ok === false
    const syncAt = syncStatus?.finishedAt || syncStatus?.sourceExtractedAt || null
    if (fs.existsSync(file)) {
      const stat = fs.statSync(file)
      ageHours = hoursSince(stat.mtime)
      stale = ageHours !== null && ageHours > expectedFreshHours
      status = '已连接'
      last_sync_at = syncAt || stat.mtime.toISOString()
      detail = `发现绿仔收缴率 JSON，大小 ${fileSizeLabel(stat.size)}${syncAt ? `；最近自动同步 ${syncAt}` : ''}`
      health = syncFailed ? 'warning' : stale ? 'warning' : 'ok'
      suggestion = syncFailed
        ? `绿仔自动同步失败：${syncStatus?.message || syncStatus?.code || '未返回失败原因'}。请检查本机 ~/lvzai-daily-sync.sh 日志并重新执行。`
        : stale
          ? '绿仔收缴率文件超过 72 小时未更新，请检查 ERP 导出或同步脚本。'
          : syncOk
            ? '绿仔自动同步成功，收缴率文件更新正常。'
            : '绿仔收缴率文件更新正常。'
    } else {
      status = '待接入'
      health = 'danger'
      detail = syncFailed ? `未发现绿仔收缴率 JSON；最近自动同步失败：${syncStatus?.message || syncStatus?.code || '未返回失败原因'}` : '未发现绿仔收缴率 JSON'
      suggestion = syncFailed ? '请先处理绿仔自动同步失败原因，再重新执行同步脚本。' : '请确认绿仔 ERP 数据导出路径，并检查私有运行目录/绿仔收款汇总.json。'
    }
  }
  if (row.source_key === 'finereport') {
    const cnt = db.prepare(`SELECT COUNT(*) as cnt,
      SUM(CASE WHEN validation_status='directory_only' THEN 1 ELSE 0 END) as directory_only_count
      FROM projects`).get() as { cnt: number; directory_only_count: number | null }
    const directoryOnly = cnt.cnt > 0 && Number(cnt.directory_only_count || 0) === cnt.cnt
    const sourceCopy = projectOperatingSourceCopy(cnt.cnt)
    const latestRun = db.prepare('SELECT * FROM snapshot_runs ORDER BY id DESC LIMIT 1').get() as any
    const latestSnapshot = db.prepare("SELECT month, COUNT(*) as count, MAX(created_at) as created_at FROM project_monthly_snapshots WHERE quality_status='verified' GROUP BY month ORDER BY month DESC LIMIT 1").get() as any
    status = directoryOnly ? '目录已接入' : cnt.cnt > 0 ? '已接入' : '待导入'
    detail = sourceCopy.detail
    suggestion = sourceCopy.suggestion
    operatorAction = sourceCopy.operatorAction
    last_sync_at = latestSnapshot?.created_at || row.last_sync_at
    ageHours = hoursSince(parseDate(last_sync_at))
    if (directoryOnly) {
      state = 'directory_only'
      applicability = 'not_applicable'
      health = 'ok'
      detail = `已发布${cnt.cnt}条权威项目目录；项目经营字段当前不接入。`
      suggestion = '项目经营质量评分不适用；保持权威目录现状，不创建项目月度快照。'
      operatorAction = '保留权威项目目录；只有重新立项接入正式经营字段后，才启用项目质量校验和月度快照。'
    } else if (cnt.cnt <= 0) {
      health = 'danger'
      suggestion = sourceCopy.suggestion
    } else if (latestRun?.status === 'failed') {
      health = 'danger'
      detail += `；最近快照失败：${latestRun.message || '未返回失败原因'}`
      suggestion = '请先处理最近一次月度快照失败原因，再重新执行快照。'
    } else if (!latestSnapshot?.month) {
      health = 'warning'
      suggestion = '项目经营表已接入，但尚未沉淀月度快照，建议立即生成当前月快照。'
    } else if (latestSnapshot.month < monthNow()) {
      health = 'warning'
      suggestion = `最新快照停留在 ${latestSnapshot.month}，建议补生成 ${monthNow()} 月快照。`
    } else {
      health = 'ok'
      suggestion = '项目经营表和月度快照状态正常。'
    }
    expectedFreshHours = 24 * 35
  }
  const freshness = classifyFreshness(ageHours, expectedFreshHours)
  return {
    ...row,
    status,
    last_sync_at,
    detail,
    health,
    stale: freshness === 'stale',
    freshness,
    freshnessLabel: freshnessLabel(freshness),
    ageHours,
    expectedFreshHours,
    affectedPages: affectedPagesForSource(row.source_key),
    suggestion,
    operatorAction,
    repair,
    state,
    applicability,
    remediation: remediationTemplate(row.source_key),
  }
}

function sourceRunHistory(sourceKey: string) {
  const success = db.prepare("SELECT finished_at, message FROM data_source_sync_runs WHERE source_key = ? AND status = 'success' ORDER BY id DESC LIMIT 1").get(sourceKey) as any
  const failure = db.prepare("SELECT finished_at, message FROM data_source_sync_runs WHERE source_key = ? AND status = 'failed' ORDER BY id DESC LIMIT 1").get(sourceKey) as any
  return {
    lastSuccessAt: success?.finished_at || null,
    lastFailureAt: failure?.finished_at || null,
    lastFailureReason: failure?.message || '',
  }
}

function enrichSource(row: any, inspectedAt: string) {
  const inspected = inspectSource(row)
  return { ...inspected, ...sourceRunHistory(row.source_key), inspectedAt }
}

function sourceSummary(rows: any[]) {
  return rows.reduce((acc, row) => {
    acc.total += 1
    acc[row.health] = (acc[row.health] || 0) + 1
    acc[row.freshness || 'unknown'] = (acc[row.freshness || 'unknown'] || 0) + 1
    return acc
  }, { total: 0, ok: 0, warning: 0, danger: 0, fresh: 0, delayed: 0, stale: 0, unknown: 0 } as Record<string, number>)
}

function sourceAlerts(rows: any[]) {
  return rows
    .filter(row => row.health !== 'ok')
    .map(row => ({
      id: `source-${row.source_key}`,
      source_key: row.source_key,
      name: row.name,
      severity: row.health === 'danger' ? 'high' : 'medium',
      status: row.status,
      detail: row.detail,
      last_sync_at: row.last_sync_at,
      ageHours: row.ageHours,
      expectedFreshHours: row.expectedFreshHours,
      freshness: row.freshness,
      freshnessLabel: row.freshnessLabel,
      affectedPages: row.affectedPages,
      lastSuccessAt: row.lastSuccessAt,
      lastFailureAt: row.lastFailureAt,
      lastFailureReason: row.lastFailureReason,
      inspectedAt: row.inspectedAt,
      suggestion: row.suggestion,
      operatorAction: row.operatorAction,
    }))
}

function qualityLevelScore(level: QualityLevel) {
  if (level === 'danger') return 12
  if (level === 'warning') return 6
  return 0
}

function buildMasterDataAudit() {
  const projects = db.prepare('SELECT id, name, area, project_code, source_system, source_project_id, active_status FROM projects ORDER BY id').all() as any[]
  const months = db.prepare("SELECT DISTINCT month FROM project_monthly_snapshots WHERE quality_status='verified' ORDER BY month DESC LIMIT 2").all() as Array<{ month: string }>
  let snapshotComparison: any = null
  if (months.length === 2) {
    const current = db.prepare('SELECT * FROM project_monthly_snapshots WHERE month = ? ORDER BY project_id').all(months[0].month) as any[]
    const previous = db.prepare('SELECT * FROM project_monthly_snapshots WHERE month = ? ORDER BY project_id').all(months[1].month) as any[]
    snapshotComparison = compareSnapshotMonths(months[1].month, previous, months[0].month, current)
  }
  const aliases = db.prepare('SELECT * FROM project_id_aliases ORDER BY id DESC').all() as any[]
  return { projects, snapshotComparison, aliases, summary: { projects: projects.length, coded: projects.filter(p => p.project_code).length, aliases: aliases.length } }
}

function buildQualityReport() {
  ensureSources()
  const projects = db.prepare('SELECT * FROM projects ORDER BY area, name').all() as any[]
  const sources = (db.prepare('SELECT * FROM data_sources ORDER BY id').all() as any[]).map(inspectSource)
  const months = db.prepare('SELECT month, COUNT(*) as count FROM project_monthly_snapshots GROUP BY month ORDER BY month DESC').all() as any[]
  const latestRun = db.prepare('SELECT * FROM snapshot_runs ORDER BY id DESC LIMIT 1').get() as any
  const items: Array<{ level: QualityLevel; title: string; detail: string; affectedMetrics: string[]; action: string }> = []

  const add = (level: QualityLevel, title: string, detail: string, affectedMetrics: string[], action: string) => {
    items.push({ level, title, detail, affectedMetrics, action })
  }

  const directoryOnlyCount = projects.filter(project => project.validation_status === 'directory_only').length
  if (projects.length > 0 && directoryOnlyCount === projects.length) {
    const sourceBad = sources.filter(source => source.health !== 'ok')
    return {
      state: 'directory_only',
      applicability: 'not_applicable',
      score: null,
      level: 'not_applicable',
      summary: { total: 1, success: 1, warning: 0, danger: 0 },
      items: [{
        level: 'success',
        status: 'not_applicable',
        title: '项目经营质量评分不适用',
        detail: `当前${directoryOnlyCount}条均为权威项目目录；成本、利润率、品质、安全、满意度等项目经营字段尚未接入。`,
        affectedMetrics: [],
        action: '无需重新导入项目经营数据，无需生成项目月度快照；待正式经营字段立项接入后再启用质量校验。',
      }],
      coverage: {
        projects: projects.length,
        directoryOnlyProjects: directoryOnlyCount,
        snapshotMonths: months.length,
        latestSnapshotMonth: months[0]?.month || null,
        sources: sources.length,
        sourceWarnings: sourceBad.length,
      },
      generatedAt: new Date().toISOString(),
    }
  }

  if (projects.length === 0) {
    add('danger', '项目主数据为空', '当前 projects 表没有项目数据，经营指标、预警和月报无法形成有效判断。', ['项目画像', 'AI预警', '经营月报'], '请从APH/FineReport受控接入任务重建P46批次，通过真实性门禁后由管理员发布；生产禁止手工导入。')
  } else if (projects.length < 5) {
    add('warning', '项目样本偏少', `当前仅 ${projects.length} 个项目，片区对标和趋势判断可能失真。`, ['片区对标', '健康分'], '请确认华北项目清单是否完整。')
  }

  const keyFields = [
    ['area', '片区', '片区对标'],
    ['name', '项目名称', '项目画像'],
    ['receivable', '应收', '收缴率'],
    ['received', '实收', '收缴率'],
    ['ytd_income', '累计收入', '利润率'],
    ['ytd_cost', '累计成本', '利润率'],
    ['quality_score', '品质评分', '品质预警'],
    ['customer_satisfaction', '客户满意度', '满意度预警'],
  ]
  const missingDetails = keyFields
    .map(([field, label, metric]) => {
      const count = projects.filter(p => p[field] === null || p[field] === undefined || p[field] === '').length
      return count > 0 ? { field, label, metric, count } : null
    })
    .filter(Boolean) as Array<{ field: string; label: string; metric: string; count: number }>
  if (missingDetails.length > 0) {
    add(
      missingDetails.some(d => ['area', 'name', 'receivable', 'received'].includes(d.field)) ? 'danger' : 'warning',
      '关键字段缺失',
      missingDetails.map(d => `${d.label}缺失 ${d.count} 条`).join('；'),
      Array.from(new Set(missingDetails.map(d => d.metric))),
      '请回到原始导入表补齐关键字段，重新预览并确认导入。',
    )
  }

  const masterAudit = buildMasterDataAudit()
  if (masterAudit.snapshotComparison?.identical) add('danger', '相邻月度快照疑似未更新', masterAudit.snapshotComparison.message, ['趋势分析', '滚动预测', '整改成效'], '请核对源系统更新时间；不得把完全相同解释为经营稳定。')

  const duplicateNames = db.prepare('SELECT name, COUNT(*) as count FROM projects GROUP BY name HAVING COUNT(*) > 1 ORDER BY count DESC LIMIT 10').all() as any[]
  if (duplicateNames.length > 0) {
    add('warning', '疑似重复项目', duplicateNames.map(r => `${r.name} ${r.count} 条`).join('；'), ['项目画像', '片区汇总'], '请核对项目名称是否重复导入或存在别名未合并。')
  }

  const logicIssues: string[] = []
  for (const p of projects) {
    if (n(p.receivable) > 0 && n(p.received) / n(p.receivable) > 1.2) logicIssues.push(`${p.name} 实收显著高于应收`)
    if (n(p.ytd_income) > 0 && n(p.ytd_cost) / n(p.ytd_income) > 1.2) logicIssues.push(`${p.name} 累计成本显著高于收入`)
    if (n(p.quality_score) > 100 || n(p.customer_satisfaction) > 100) logicIssues.push(`${p.name} 品质/满意度超过100`)
    if (n(p.quality_score) < 0 || n(p.customer_satisfaction) < 0 || n(p.safety_incidents) < 0 || n(p.complaint_count) < 0) logicIssues.push(`${p.name} 存在负数指标`)
  }
  if (logicIssues.length > 0) {
    add('danger', '经营逻辑异常', logicIssues.slice(0, 6).join('；'), ['收缴率', '利润率', '健康分'], '请按项目核对应收、实收、收入、成本和评分口径。')
  }

  const zeroReceivable = projects.filter(p => n(p.receivable) <= 0).length
  const zeroIncome = projects.filter(p => n(p.ytd_income) <= 0).length
  if (zeroReceivable > projects.length * 0.3 || zeroIncome > projects.length * 0.3) {
    add('warning', '零值占比偏高', `应收为0项目 ${zeroReceivable}/${projects.length}，累计收入为0项目 ${zeroIncome}/${projects.length}。`, ['收缴率', '利润率', '月报'], '请确认空值是否代表未填报，而不是实际为0。')
  }

  const sourceBad = sources.filter(s => s.health !== 'ok')
  if (sourceBad.length > 0) {
    add('warning', '数据源同步影响质量', sourceBad.map(s => `${s.name}：${s.status}`).join('；'), ['数据可信度', 'AI预警'], '请优先处理数据源接入页中的同步异常。')
  }

  if (months.length === 0) {
    add('warning', '缺少月度快照', '当前尚未沉淀项目月度快照，风险历史趋势无法准确判断。', ['风险历史趋势', '月报同比'], '请生成当前月项目月度快照。')
  } else if (months[0].month < monthNow()) {
    add('warning', '月度快照未更新到当月', `最新快照为 ${months[0].month}，当前月份为 ${monthNow()}。`, ['风险历史趋势', '月报同比'], '请补生成当月项目月度快照。')
  }

  if (latestRun?.status === 'failed') {
    add('danger', '最近快照运行失败', latestRun.message || '最近一次快照未成功完成。', ['风险历史趋势', '月报归档'], '请处理失败原因后重新执行月度快照。')
  }

  if (items.length === 0) {
    add('success', '数据质量良好', `当前 ${projects.length} 个项目、${months.length} 个月度快照未发现关键缺失或明显逻辑冲突。`, ['经营驾驶舱', 'AI预警', '月报'], '继续保持导入预览、月度快照和数据源巡检。')
  }

  const penalty = items.reduce((sum, item) => sum + qualityLevelScore(item.level), 0)
  const score = Math.max(0, Math.min(100, 100 - penalty))
  const summary = items.reduce((acc, item) => {
    acc.total += 1
    acc[item.level] = (acc[item.level] || 0) + 1
    return acc
  }, { total: 0, success: 0, warning: 0, danger: 0 } as Record<string, number>)

  return {
    state: 'operating_quality',
    applicability: 'applicable',
    score,
    level: score >= 90 ? 'success' : score >= 75 ? 'warning' : 'danger',
    summary,
    items,
    coverage: {
      projects: projects.length,
      snapshotMonths: months.length,
      latestSnapshotMonth: months[0]?.month || null,
      sources: sources.length,
      sourceWarnings: sourceBad.length,
    },
    generatedAt: new Date().toISOString(),
  }
}

function sourceHealthScore(health: SourceHealth) {
  if (health === 'ok') return 100
  if (health === 'warning') return 76
  return 48
}

function healthBoard() {
  ensureSources()
  const inspectedAt = new Date().toISOString()
  const inspected = (db.prepare('SELECT * FROM data_sources ORDER BY id').all() as any[]).map(row => enrichSource(row, inspectedAt))
  const quality = buildQualityReport()
  const report = db.prepare('SELECT id, report_date, title, summary, created_at, payload FROM report_archives ORDER BY id DESC LIMIT 1').get() as any
  let reportQuality: any = null
  try { reportQuality = report?.payload ? JSON.parse(report.payload || '{}')?.dataQuality || null : null } catch {}
  const cards = inspected.map(src => {
    const recentRuns = db.prepare('SELECT * FROM data_source_sync_runs WHERE source_key = ? ORDER BY id DESC LIMIT 3').all(src.source_key) as any[]
    return {
      source_key: src.source_key,
      name: src.name,
      status: src.status,
      state: src.state,
      applicability: src.applicability,
      health: src.health,
      score: src.applicability === 'not_applicable' ? null : sourceHealthScore(src.health),
      detail: src.detail,
      suggestion: src.suggestion,
      last_sync_at: src.last_sync_at,
      ageHours: src.ageHours,
      expectedFreshHours: src.expectedFreshHours,
      freshness: src.freshness,
      freshnessLabel: src.freshnessLabel,
      affectedPages: src.affectedPages,
      lastSuccessAt: src.lastSuccessAt,
      lastFailureAt: src.lastFailureAt,
      lastFailureReason: src.lastFailureReason,
      inspectedAt: src.inspectedAt,
      recentRuns,
      reportReference: report ? {
        id: report.id,
        title: report.title,
        report_date: report.report_date,
        created_at: report.created_at,
        mentioned: Boolean(reportQuality?.rows?.some((r: any) => r.source_key === src.source_key || r.name === src.name) || String(report.payload || '').includes(src.name)),
      } : null,
    }
  })
  const scoredCards = cards.filter(card => typeof card.score === 'number')
  const score = scoredCards.length ? Math.round(scoredCards.reduce((sum, card) => sum + Number(card.score), 0) / scoredCards.length) : 0
  return {
    score,
    projectState: quality.state,
    projectApplicability: quality.applicability,
    summary: sourceSummary(inspected),
    quality: {
      state: quality.state,
      applicability: quality.applicability,
      score: quality.score,
      level: quality.level,
      issues: quality.summary?.total || 0,
      latestSnapshotMonth: quality.coverage?.latestSnapshotMonth || null,
      sourceWarnings: quality.coverage?.sourceWarnings || 0,
    },

    latestReport: report ? {
      id: report.id,
      title: report.title,
      report_date: report.report_date,
      created_at: report.created_at,
      dataQualityScore: reportQuality?.score ?? null,
      dataQualitySummary: reportQuality?.summary || '',
    } : null,
    cards,
    generatedAt: new Date().toISOString(),
  }
}

export function buildSourceStatus() {
  ensureSources()
  const inspectedAt = new Date().toISOString()
  const rows = db.prepare('SELECT * FROM data_sources ORDER BY id').all() as any[]
  const inspected = rows.map(row => enrichSource(row, inspectedAt))
  return { rows: inspected, summary: sourceSummary(inspected), publication: buildPublicationStatus(), generatedAt: inspectedAt }
}

function publicationDate(value: unknown): string | null {
  const match = String(value || '').trim().match(/^\d{4}-\d{2}-\d{2}/)
  return match ? match[0] : null
}

function publicationRoot() {
  return fixedEntryRoot()
}

/**
 * R5统一发布完成态。源文件/业务表可以先于正式批次更新，但只有三源、正式发布记录和
 * 每源审计全部对齐时才返回complete。该函数只读，不触发采集、预览或发布。
 */
export function buildPublicationStatus() {
  const rootPath = publicationRoot()
  const aph = readJsonSafe(path.join(rootPath, 'APH决策_每日提取.json'))
  const aphBusinessDate = publicationDate(aph?.businessDate || aph?.business_date || aph?.date || aph?.extractedAt)
  const aphBusinessDateReady = isRecentBusinessDate(aphBusinessDate)
  const aphReady = Boolean(aphBusinessDateReady && aph?.sourceStatus === 'available')

  const daily = (() => {
    try {
      return db.prepare(`SELECT COALESCE(NULLIF(business_date,''),date) business_date,
        COUNT(*) row_count,MAX(last_validated_at) validated_at
        FROM daily_snapshots WHERE quality_status='verified'
        GROUP BY COALESCE(NULLIF(business_date,''),date)
        ORDER BY business_date DESC LIMIT 1`).get() as any
    } catch { return null }
  })()
  const dailyBusinessDate = publicationDate(daily?.business_date)
  const dailyBusinessDateReady = isRecentBusinessDate(dailyBusinessDate)

  const lvzaiValidation = readLiveCollectionPublication(db, rootPath)
  const lvzaiStatus = lvzaiValidation.status
  const lvzaiRows = lvzaiValidation.rows.length
  const lvzaiSummaryAvailable = lvzaiValidation.summaryAvailable
  const lvzaiDetailAvailable = lvzaiValidation.detailAvailable
  const lvzaiSyncStatusAvailable = lvzaiValidation.syncStatusAvailable
  const lvzaiBusinessDate = lvzaiValidation.businessDate
  const lvzaiEvidenceComplete = lvzaiValidation.evidenceComplete
  const lvzaiReady = lvzaiValidation.ready
  const missingLvzaiEvidence = [
    !lvzaiSummaryAvailable ? '汇总' : '',
    !lvzaiDetailAvailable ? '明细' : '',
    !lvzaiSyncStatusAvailable ? '同步状态' : '',
  ].filter(Boolean)
  const lvzaiMessage = lvzaiReady
    ? lvzaiValidation.message
    : !lvzaiEvidenceComplete
      ? `绿仔来源证据缺失或无效：${missingLvzaiEvidence.join('、')}；${lvzaiValidation.message}`
      : lvzaiValidation.message

  const sources: PublicationSourceEvidence[] = [
    {
      sourceKey: 'aph', name: 'APH回款', businessDate: aphBusinessDate,
      status: aphReady ? 'ready' : aphBusinessDate ? 'warning' : 'unknown',
      extractedAt: aph?.extractedAt || null, validatedAt: aph?.lastValidatedAt || null,
      rowCount: (() => { try { return Number((db.prepare('SELECT COUNT(*) value FROM payment_centers').get() as any)?.value || 0) } catch { return null } })(),
      message: aphReady ? '来源业务日期和字段血缘可用' : 'APH来源日期陈旧、未来、无效或正式可用状态不足',
    },
    {
      sourceKey: 'finereport', name: '中心明细', businessDate: dailyBusinessDate,
      status: dailyBusinessDateReady && Number(daily?.row_count || 0) > 0 ? 'ready' : dailyBusinessDate ? 'warning' : 'unknown',
      validatedAt: daily?.validated_at || null, rowCount: daily?.row_count == null ? null : Number(daily.row_count),
      message: dailyBusinessDateReady ? '已读取最新验证中心快照' : dailyBusinessDate ? '中心快照业务日期陈旧、未来或无效' : '没有已验证中心快照',
    },
    {
      sourceKey: 'lvzai', name: '绿仔收缴', businessDate: lvzaiBusinessDate,
      status: lvzaiReady ? 'ready' : lvzaiValidation.anyFileExists ? 'failed' : 'unknown',
      extractedAt: lvzaiValidation.extractedAt, validatedAt: lvzaiStatus?.finishedAt as string || null,
      rowCount: lvzaiRows,
      summaryAvailable: lvzaiSummaryAvailable,
      detailAvailable: lvzaiDetailAvailable,
      syncStatusAvailable: lvzaiSyncStatusAvailable,
      message: lvzaiMessage,
    },
  ]

  const latestBatchRow = (() => {
    try {
      const formalPublication = formalP46PublicationPredicate('b')
      return db.prepare(`SELECT b.id,b.business_date,b.status,b.published_at
        FROM data_ingestion_batches b
        WHERE b.status='published' AND length(b.batch_sha256)=64
          AND COALESCE(b.published_at,'')<>'' AND ${formalPublication}
        ORDER BY b.business_date DESC,b.id DESC LIMIT 1`).get() as any
    } catch { return null }
  })()
  const latestPublicationRow = (() => {
    try {
      const formalPublication = formalP46PublicationPredicate('b')
      return db.prepare(`SELECT p.batch_id,p.business_date,p.published_at
        FROM data_ingestion_publications p
        JOIN data_ingestion_batches b ON b.id=p.batch_id
        WHERE b.status='published' AND length(b.batch_sha256)=64
          AND COALESCE(b.published_at,'')<>'' AND ${formalPublication}
        ORDER BY b.business_date DESC,b.id DESC LIMIT 1`).get() as any
    } catch { return null }
  })()
  const latestBatch = latestBatchRow ? {
    id: Number(latestBatchRow.id), businessDate: publicationDate(latestBatchRow.business_date),
    status: String(latestBatchRow.status || ''), publishedAt: latestBatchRow.published_at || null,
  } : null
  const latestPublication = latestPublicationRow ? {
    batchId: Number(latestPublicationRow.batch_id), businessDate: publicationDate(latestPublicationRow.business_date),
    publishedAt: latestPublicationRow.published_at || null,
  } : null
  const audits = (() => {
    try {
      return (db.prepare(`SELECT source_key,status,detail FROM data_source_sync_runs
        WHERE run_type='p46-publish' ORDER BY id DESC LIMIT 100`).all() as any[]).map(row => {
          let detail: any = {}
          try { detail = JSON.parse(row.detail || '{}') } catch {}
          return {
            sourceKey: String(row.source_key || ''),
            batchId: Number(detail.batchId || 0),
            businessDate: publicationDate(detail.businessDate),
            status: String(row.status || ''),
          }
        })
    } catch { return [] }
  })()
  const asOfDate = String((db.prepare("SELECT date('now','localtime') value").get() as any)?.value || new Date().toISOString().slice(0, 10))
  const completion = classifyPublicationStatus({
    asOfDate,
    requiredSourceKeys: ['aph', 'finereport', 'lvzai'],
    sources,
    latestBatch,
    latestPublication,
    audits,
  })
  return {
    ...completion,
    sources,
    latestBatch,
    latestPublication,
    generatedAt: new Date().toISOString(),
  }
}

router.get('/api/data-sources/publication-status', (_req, res) => {
  res.json(buildPublicationStatus())
})

router.get('/api/data-sources/status', (_req, res) => {
  res.json(buildSourceStatus())
})

router.get('/api/data-sources/alerts', (_req, res) => {
  ensureSources()
  const inspectedAt = new Date().toISOString()
  const rows = (db.prepare('SELECT * FROM data_sources ORDER BY id').all() as any[]).map(row => enrichSource(row, inspectedAt))
  const alerts = sourceAlerts(rows)
  res.json({
    alerts,
    total: alerts.length,
    summary: sourceSummary(rows),
    message: alerts.length ? `发现 ${alerts.length} 个数据源需要关注` : '数据源同步健康正常',
    generatedAt: inspectedAt,
  })
})

function tailLine(file: string) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    const lines = text.split(/\r?\n/).filter(Boolean)
    return lines[lines.length - 1] || ''
  } catch { return '' }
}

function lastMatchingLine(file: string, pattern: RegExp) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    const lines = text.split(/\r?\n/).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (pattern.test(lines[i])) return lines[i]
    }
  } catch {}
  return ''
}

function fileMtimeIso(file: string) {
  try { return fs.statSync(file).mtime.toISOString() } catch { return null }
}

export function buildAutoJobs() {
  const aphFile = fixedEntryPath('APH决策_每日提取.json')
  const lvzaiFile = fixedEntryPath('绿仔收款汇总.json')
  const p46StageReceiptFile = fixedEntryPath('p46-stage-status.json')
  const monthlyLogFile = '/tmp/cockpit-monthly-snapshot.log'
  const jobs: any[] = []

  const p46StageReceipt = readJsonSafe(p46StageReceiptFile)
  const p46StageReceiptMtime = fileMtimeIso(p46StageReceiptFile)
  const p46StageFinishedAt = p46StageReceipt?.finishedAt
    || p46StageReceipt?.completedAt
    || p46StageReceipt?.updatedAt
    || p46StageReceiptMtime
  const p46StageAge = hoursSince(parseDate(p46StageFinishedAt))
  const p46StageReceiptValidation = (() => {
    const reasons: string[] = []
    const record = p46StageReceipt && typeof p46StageReceipt === 'object' && !Array.isArray(p46StageReceipt)
      ? p46StageReceipt
      : null
    if (!record) return { valid: false, reasons: ['回执不是JSON对象'] }
    const startedAt = typeof record.startedAt === 'string' ? parseDate(record.startedAt) : null
    const finishedAt = typeof record.finishedAt === 'string' ? parseDate(record.finishedAt) : null
    const businessDate = evaluateBusinessDate(record.businessDate, '任务回执业务日期')
    if (!startedAt) reasons.push('startedAt必须是有效时间')
    if (!finishedAt) reasons.push('finishedAt必须是有效时间')
    if (startedAt && finishedAt && finishedAt.getTime() < startedAt.getTime()) reasons.push('finishedAt不得早于startedAt')
    if (!businessDate.calendarValid || !businessDate.withinAllowedRange) reasons.push(...businessDate.reasons)
    if (typeof record.stage !== 'string' || !record.stage.trim()) reasons.push('stage必须是非空字符串')
    if (typeof record.ok !== 'boolean') reasons.push('ok必须是布尔值')
    if (!Number.isInteger(record.exitCode)) reasons.push('exitCode必须是整数')
    if (record.schedule !== '17:30') reasons.push('schedule必须为17:30')
    if (record.ok === true) {
      if (record.exitCode !== 0) reasons.push('成功回执的exitCode必须为0')
      if (!(record.errorCode === null || record.errorCode === '')) reasons.push('成功回执的errorCode必须为null或空字符串')
    }
    if (record.ok === false) {
      if (record.exitCode === 0) reasons.push('失败回执的exitCode不得为0')
      if (typeof record.errorCode !== 'string' || !record.errorCode.trim()) reasons.push('失败回执的errorCode必须是非空字符串')
    }
    return { valid: reasons.length === 0, reasons }
  })()
  const p46StageFailed = p46StageReceiptValidation.valid && p46StageReceipt?.ok === false
  const p46StageSucceeded = p46StageReceiptValidation.valid && p46StageReceipt?.ok === true
  const p46StageStatus = p46StageFailed ? 'failed' : p46StageSucceeded ? 'success' : 'unknown'
  const p46StageMessage = p46StageFailed
    ? `17:30数据提取任务失败：${p46StageReceipt?.message || p46StageReceipt?.errorCode || p46StageReceipt?.code || '未返回失败原因'}`
    : p46StageSucceeded
      ? String(p46StageReceipt?.message || '17:30数据提取任务回执成功。')
      : `未发现有效的 p46-stage-status.json 任务回执，不能根据固定入口文件新鲜度判定任务成功。${p46StageReceiptValidation.reasons.length ? ` ${p46StageReceiptValidation.reasons.join('；')}` : ''}`
  const p46StageHealth = (sourceHealth: SourceHealth): SourceHealth => {
    if (p46StageFailed) return 'danger'
    if (!p46StageSucceeded) return 'warning'
    if (sourceHealth === 'danger') return 'danger'
    if (sourceHealth === 'warning' || (p46StageAge !== null && p46StageAge > 36)) return 'warning'
    return 'ok'
  }
  const p46StageEvidence = fs.existsSync(p46StageReceiptFile)
    ? `任务回执 p46-stage-status.json，${fileSizeLabel(fs.statSync(p46StageReceiptFile).size)}，mtime ${p46StageReceiptMtime || '未知'}`
    : '任务回执 p46-stage-status.json 缺失'

  const aphStat = fs.existsSync(aphFile) ? fs.statSync(aphFile) : null
  const aphValid = aphStat ? validateAphJson(aphFile) : { ok: false, extractedAt: null }
  const aphAge = hoursSince(aphStat?.mtime || null)
  const aphSourceHealth: SourceHealth = !aphStat || !aphValid.ok ? 'danger' : (aphAge !== null && aphAge > 36 ? 'warning' : 'ok')
  jobs.push({
    key: 'aph-daily-sync',
    name: 'APH/FineReport 每日回款同步',
    source_key: 'aph',
    owner_host: '本机 Mac cron',
    schedule: '每天 17:30',
    next_run_hint: '下一次按本机定时任务 17:30 执行',
    command: 'bash ~/daily-sync.sh >> ~/daily-sync.log 2>&1',
    log_path: '~/daily-sync.log',
    status: p46StageStatus,
    health: p46StageHealth(aphSourceHealth),
    last_run_at: p46StageFinishedAt || null,
    ageHours: p46StageAge,
    evidence: `${p46StageEvidence}；${aphStat ? `APH固定入口 ${fileSizeLabel(aphStat.size)}，mtime ${aphStat.mtime.toISOString()}` : 'APH固定入口缺失'}`,
    message: p46StageMessage,
  })

  const lvzaiStat = fs.existsSync(lvzaiFile) ? fs.statSync(lvzaiFile) : null
  const lvzaiAge = hoursSince(lvzaiStat?.mtime || null)
  const lvzaiSourceHealth: SourceHealth = !lvzaiStat ? 'danger' : (lvzaiAge !== null && lvzaiAge > 36 ? 'warning' : 'ok')
  jobs.push({
    key: 'lvzai-daily-sync',
    name: '绿仔 ERP 收缴率每日同步',
    source_key: 'lvzai',
    owner_host: '本机 Mac cron',
    schedule: '每天 17:30',
    next_run_hint: '下一次按本机定时任务 17:30 执行',
    command: '/bin/bash ~/lvzai-daily-sync.sh',
    log_path: '~/Library/Logs/lvzai-daily-sync.log',
    status: p46StageStatus,
    health: p46StageHealth(lvzaiSourceHealth),
    last_run_at: p46StageFinishedAt || null,
    ageHours: p46StageAge,
    evidence: `${p46StageEvidence}；${lvzaiStat ? `绿仔汇总 ${fileSizeLabel(lvzaiStat.size)}，mtime ${lvzaiStat.mtime.toISOString()}` : '绿仔汇总文件缺失'}`,
    message: p46StageMessage,
  })

  const latestSnapshotRun = db.prepare('SELECT * FROM snapshot_runs ORDER BY id DESC LIMIT 1').get() as any
  const actualSnapshotCount = latestSnapshotRun
    ? Number((db.prepare('SELECT COUNT(*) count FROM project_monthly_snapshots WHERE month = ?').get(latestSnapshotRun.month) as any)?.count || 0)
    : 0
  const recordedSnapshotCount = latestSnapshotRun
    ? Math.max(Number(latestSnapshotRun.inserted || 0), Number(latestSnapshotRun.skipped || 0))
    : 0
  const projectQuality = buildQualityReport()
  const snapshotNotApplicable = projectQuality.applicability === 'not_applicable'
  const directoryOnlyProjectCount = Number(projectQuality.coverage?.directoryOnlyProjects || 0)
  const snapshotRecordMismatch = Boolean(latestSnapshotRun && recordedSnapshotCount > 0 && actualSnapshotCount === 0)
  const effectiveSnapshotStatus = snapshotNotApplicable
    ? 'not_applicable'
    : snapshotRecordMismatch
      ? 'failed'
      : (latestSnapshotRun?.status || 'warning')
  const snapshotHealth: SourceHealth = snapshotNotApplicable
    ? 'ok'
    : effectiveSnapshotStatus === 'failed'
    ? 'danger'
    : effectiveSnapshotStatus === 'warning'
      ? 'warning'
      : latestSnapshotRun
        ? 'ok'
        : 'warning'
  const snapshotMessage = snapshotNotApplicable
    ? `当前${directoryOnlyProjectCount}条均为权威项目目录，项目经营指标尚未接入；月度快照任务不适用，历史运行记录仅保留审计。`
    : snapshotRecordMismatch
    ? `${latestSnapshotRun.month} 运行记录声称 ${recordedSnapshotCount} 条，但当前项目月度快照表为 0 条；运行记录与生产数据不一致`
    : (latestSnapshotRun?.message || tailLine(monthlyLogFile) || '尚未发现自动月度快照运行记录。')
  jobs.push({
    key: 'monthly-snapshot',
    name: '项目月度快照自动沉淀',
    source_key: 'finereport',
    applicability: snapshotNotApplicable ? 'not_applicable' : 'applicable',
    owner_host: snapshotNotApplicable ? '不适用' : '云服务器 cron',
    schedule: snapshotNotApplicable ? '不适用（项目经营指标未接入）' : '每月 2 日 06:35',
    next_run_hint: snapshotNotApplicable ? '待项目经营字段正式接入后启用' : nextSnapshotDate(),
    command: snapshotNotApplicable ? '未启用' : 'python3 scripts/cockpit_monthly_snapshot.py',
    log_path: snapshotNotApplicable ? '—' : monthlyLogFile,
    status: effectiveSnapshotStatus,
    health: snapshotHealth,
    last_run_at: snapshotNotApplicable ? null : latestSnapshotRun?.created_at || fileMtimeIso(monthlyLogFile),
    ageHours: snapshotNotApplicable ? null : hoursSince(parseDate(latestSnapshotRun?.created_at) || parseDate(fileMtimeIso(monthlyLogFile) || '')),
    evidence: snapshotNotApplicable
      ? `权威项目目录 ${directoryOnlyProjectCount} 条；项目经营月度快照 ${actualSnapshotCount} 条`
      : latestSnapshotRun
      ? `${latestSnapshotRun.month}：记录新增 ${latestSnapshotRun.inserted || 0} / 跳过 ${latestSnapshotRun.skipped || 0}；当前快照 ${actualSnapshotCount}`
      : '暂无 snapshot_runs 记录',
    message: snapshotMessage,
  })


  const summary = jobs.reduce((acc, row) => {
    acc.total += 1
    acc[row.health] = (acc[row.health] || 0) + 1
    return acc
  }, { total: 0, ok: 0, warning: 0, danger: 0 } as Record<string, number>)
  return { rows: jobs, summary, generatedAt: new Date().toISOString() }
}

router.get('/api/data-sources/master-data/audit', requireAdmin, (_req, res) => {
  res.json(buildMasterDataAudit())
})


router.get('/api/data-sources/auto-jobs', requireAdmin, (_req, res) => {
  res.json(buildAutoJobs())
})


router.get('/api/data-sources/sync-runs', requireAdmin, (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)))
  const rows = db.prepare('SELECT * FROM data_source_sync_runs ORDER BY id DESC LIMIT ?').all(limit) as any[]
  const summary = rows.reduce((acc, row) => {
    acc.total += 1
    acc[row.status] = (acc[row.status] || 0) + 1
    return acc
  }, { total: 0, success: 0, warning: 0, failed: 0 } as Record<string, number>)
  res.json({ rows, summary })
})

router.get('/api/data-sources/quality', (_req, res) => {
  res.json(buildQualityReport())
})

router.get('/api/data-sources/health-board', requireAdmin, (_req, res) => {
  res.json(healthBoard())
})

router.post('/api/data-sources/snapshot/current', requireAdmin, (req, res) => {
  const month = String(req.body?.month || currentMonth()).slice(0, 7)
  const source = String(req.body?.source || 'manual_current_projects')
  const force = Boolean(req.body?.force)
  if (force && String(req.body?.confirmation || '') !== '确认覆盖当前月快照') {
    return res.status(400).json({ error: 'force覆盖需输入“确认覆盖当前月快照”', code: 'CONFIRMATION_REQUIRED' })
  }
  let result: SnapshotResult
  try {
    result = createSnapshot(month, source, force, recorded => {
      db.prepare('INSERT INTO snapshot_runs (month, source, status, inserted, skipped, message) VALUES (?, ?, ?, ?, ?, ?)')
        .run(month, source, recorded.status, recorded.inserted, recorded.skipped, recorded.message)
      logOperationStrict(req, recorded.status === 'success' ? '生成项目月度快照' : '尝试生成项目月度快照', `project_monthly_snapshots:${month}`, { ...recorded, force })
    })
  } catch {
    return res.status(503).json({ error: '快照或审计写入失败，未变更月度快照', code: 'SNAPSHOT_TRANSACTION_FAILED' })
  }
  if (!result.success) return res.status(400).json({ error: result.message, ...result })
  res.json(result)
})

router.post('/api/data-sources/snapshot/auto', requireAdmin, (req, res) => {
  const month = String(req.body?.month || currentMonth()).slice(0, 7)
  const source = String(req.body?.source || 'auto_monthly_snapshot')
  const force = Boolean(req.body?.force)
  if (force && String(req.body?.confirmation || '') !== '确认覆盖当前月快照') {
    return res.status(400).json({ error: 'force覆盖需输入“确认覆盖当前月快照”', code: 'CONFIRMATION_REQUIRED' })
  }
  let result: SnapshotResult
  try {
    result = createSnapshot(month, source, force, recorded => {
      db.prepare('INSERT INTO snapshot_runs (month, source, status, inserted, skipped, message) VALUES (?, ?, ?, ?, ?, ?)')
        .run(month, source, recorded.status, recorded.inserted, recorded.skipped, recorded.message)
      logOperationStrict(req, '自动月度快照', `project_monthly_snapshots:${month}`, { ...recorded, force })
    })
  } catch {
    return res.status(503).json({ error: '快照或审计写入失败，未变更月度快照', code: 'SNAPSHOT_TRANSACTION_FAILED' })
  }
  if (!result.success) return res.status(400).json({ error: result.message, ...result })
  res.json(result)
})

router.get('/api/data-sources/snapshot/runs', requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT * FROM snapshot_runs ORDER BY id DESC LIMIT 50').all()
  const latest = rows[0] || null
  res.json({ rows, latest, nextSnapshotDate: nextSnapshotDate() })
})

router.get('/api/data-sources/snapshots', (req, res) => {
  const month = req.query.month as string | undefined
  const months = db.prepare('SELECT month, COUNT(*) as count FROM project_monthly_snapshots GROUP BY month ORDER BY month DESC').all() as any[]
  const target = month || months[0]?.month
  const rows = target ? db.prepare('SELECT * FROM project_monthly_snapshots WHERE month = ? ORDER BY area, project_name').all(target) : []
  res.json({ month: target || null, months, rows })
})

router.get('/api/data-sources/months', (_req, res) => {
  const rows = db.prepare('SELECT month, COUNT(*) as count FROM project_monthly_snapshots GROUP BY month ORDER BY month DESC').all()
  res.json({ rows })
})

router.post('/api/data-sources/sync/:source', requireAdmin, (req, res) => {
  ensureSources()
  const startedAt = Date.now()
  const source = req.params.source
  const row = db.prepare('SELECT * FROM data_sources WHERE source_key = ?').get(source) as any
  if (!row) return res.status(404).json({ error: '数据源不存在' })
  const inspected = inspectSource(row)
  const run = db.transaction(() => {
    const recorded = recordSyncRun(req, row, inspected, startedAt)
    db.prepare('UPDATE data_sources SET status = ?, last_sync_at = ?, note = ?, updated_at = datetime(\'now\',\'localtime\') WHERE source_key = ?')
      .run(inspected.status, inspected.last_sync_at || null, inspected.detail || inspected.note || '', source)
    logOperationStrict(req, '检测外部数据源', `data_source:${source}`, { ...inspected, run: recorded })
    return recorded
  })()
  res.json({ success: true, source: inspected, run })
})

router.post('/api/data-sources/repair/:source', requireAdmin, (req, res) => {
  const source = req.params.source
  if (source !== 'aph') return res.status(400).json({ error: '当前仅支持 APH 固定入口安全修复；绿仔需重新执行 ERP 提取脚本。' })
  const target = fixedEntryPath('APH决策_每日提取.json')
  const repair = fileRepairInfo('aph', target)
  if (!repair?.repairable || !repair.candidate?.name) return res.status(400).json({ error: repair?.reason || '没有可修复的 APH 候选文件', repair })
  if (String(req.body?.confirmation || '') !== '确认修复') return res.status(400).json({ error: '请输入“确认修复”后再执行' })
  const expectedCandidate = {
    name: String(req.body?.candidateName || ''),
    mtime: String(req.body?.candidateMtime || ''),
    size: Number(req.body?.candidateSize),
  }
  const actualCandidate = {
    name: String(repair.candidate.name || ''),
    mtime: String(repair.candidate.mtime || ''),
    size: Number(repair.candidate.size),
  }
  if (expectedCandidate.name !== actualCandidate.name
    || expectedCandidate.mtime !== actualCandidate.mtime
    || !Number.isFinite(expectedCandidate.size)
    || expectedCandidate.size !== actualCandidate.size) {
    return res.status(409).json({ error: 'APH候选文件已变化，请重新检测后再确认修复', repair })
  }
  const dir = fixedEntryRoot()
  const candidate = path.join(dir, repair.candidate.name)
  const valid = validateAphJson(candidate)
  if (!valid.ok) return res.status(400).json({ error: '候选 APH 文件字段不完整，已拒绝修复', repair })
  const stat = fs.statSync(candidate)
  if (stat.size !== actualCandidate.size || stat.mtime.toISOString() !== actualCandidate.mtime) {
    return res.status(409).json({ error: 'APH候选文件在确认后发生变化，已拒绝修复', repair })
  }
  const backup = fs.existsSync(target) ? `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}` : null
  if (backup) fs.copyFileSync(target, backup)
  const temporary = `${target}.repair-${process.pid}-${Date.now()}.tmp`
  try {
    // 与正式入口处于同一目录，校验完成后用 rename 原子替换；进程或磁盘在复制
    // 阶段中断时，正式入口仍保持原文件，不会留下半文件。
    fs.copyFileSync(candidate, temporary)
    const repaired = validateAphJson(temporary)
    if (!repaired.ok) throw new Error('修复后的APH固定入口未通过字段校验')
    const candidateAfterCopy = fs.statSync(candidate)
    if (candidateAfterCopy.size !== actualCandidate.size || candidateAfterCopy.mtime.toISOString() !== actualCandidate.mtime) {
      throw new Error('APH候选文件在复制期间发生变化')
    }
    fs.renameSync(temporary, target)
    const row = db.prepare('SELECT * FROM data_sources WHERE source_key = ?').get(source) as any
    const inspected = row ? inspectSource(row) : { status: '已连接', health: 'ok' }
    db.transaction(() => {
      db.prepare('UPDATE data_sources SET status = ?, last_sync_at = ?, note = ?, updated_at = datetime(\'now\',\'localtime\') WHERE source_key = ?')
        .run(inspected.status || '已连接', inspected.last_sync_at || new Date().toISOString(), inspected.detail || `已用 ${repair.candidate.name} 修复固定入口`, source)
      logOperationStrict(req, '修复APH固定入口', 'data_source:aph', { candidate: repair.candidate, backup: backup ? path.basename(backup) : null, extractedAt: repaired.extractedAt })
    })()
    res.json({ success: true, source, candidate: repair.candidate, backup: backup ? path.basename(backup) : null, inspected })
  } catch (error: any) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary)
    if (backup && fs.existsSync(backup)) {
      const rollback = `${target}.rollback-${process.pid}-${Date.now()}.tmp`
      try {
        fs.copyFileSync(backup, rollback)
        fs.renameSync(rollback, target)
      } finally {
        if (fs.existsSync(rollback)) fs.rmSync(rollback)
      }
    } else if (fs.existsSync(target)) fs.rmSync(target)
    return res.status(500).json({ error: 'APH固定入口修复未完成，已恢复原文件', detail: String(error?.message || 'unknown').slice(0, 200) })
  }
})

export default router
