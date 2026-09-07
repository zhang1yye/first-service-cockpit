import { Router } from 'express'
import db from '../db.js'
import { canAccessProjectRow, denyScopedResource, projectScopeWhere, requireAdmin } from '../auth.js'
import {
  decorateProjectRow,
  directoryTraceability,
  projectDataAvailability,
  publishProjectDirectory,
  readProjectDirectoryStatus,
} from '../project-directory.js'
import { hasCompleteOperatingFacts } from '../data-quality-gate.js'
import { buildResponseContext, type DataState } from '../response-context.js'
import { applyEffectiveMasterState } from '../service-center-master.js'

const router = Router()

function projectResponseContext(req: any, status = readProjectDirectoryStatus(db), traceability = directoryTraceability(db)) {
  const qualityStatus: DataState = status.state === 'operating_ready' ? 'ready'
    : status.state === 'directory_ready' ? 'partial'
      : status.state === 'blocked' ? 'blocked' : 'unavailable'
  return buildResponseContext(req, {
    sources: ['权威在管项目目录', '正式回款与收缴事实'],
    extractedAt: (traceability as any)?.importedAt || null,
    batchId: Number((traceability as any)?.batchId) || null,
    batchSha256: String((traceability as any)?.sourceSha256 || '') || null,
    publicationStatus: status.ready ? 'published' : status.state === 'blocked' ? 'blocked' : 'unknown',
    qualityStatus,
    qualityMessage: status.message,
    canWrite: true,
  })
}

function optionalNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const value = Number(v)
  return Number.isFinite(value) ? value : null
}
function pct(v: number): number { return Math.round(v * 10) / 10 }
function collectionRateOf(p: any): number | null {
  const receivable = optionalNumber(p?.receivable)
  const received = optionalNumber(p?.received)
  return receivable !== null && received !== null && receivable > 0 ? received / receivable * 100 : null
}
function profitRateOf(p: any): number | null {
  const income = optionalNumber(p?.ytd_income)
  const cost = optionalNumber(p?.ytd_cost)
  return income !== null && cost !== null && income > 0 ? (income - cost) / income * 100 : null
}
function healthOf(p: any) {
  const rate = collectionRateOf(p)
  const profit = profitRateOf(p)
  const quality = optionalNumber(p?.quality_score)
  const satisfaction = optionalNumber(p?.customer_satisfaction)
  const incidents = optionalNumber(p?.safety_incidents)
  const complaints = optionalNumber(p?.complaint_count)
  if (rate === null || profit === null || quality === null || satisfaction === null || incidents === null || complaints === null) return null
  const deductions: Array<{ dimension: string; score: number; reason: string; action: string }> = []
  if (rate < 95) deductions.push({ dimension: '收费', score: Math.min(25, Math.round((95 - rate) * 0.8)), reason: `收费率${pct(rate)}%，低于95%管理目标`, action: '输出欠费清单，按90天以上/高金额/可协商分层催缴' })
  if (profit < 18) deductions.push({ dimension: '利润', score: Math.min(18, Math.round((18 - profit) * 0.9)), reason: `利润率${pct(profit)}%，成本效率需关注`, action: '复核人工、外包、能耗三类成本并形成压降清单' })
  if (quality < 90) deductions.push({ dimension: '品质', score: Math.min(12, Math.round((90 - quality) * 0.7)), reason: `品质评分${quality}分`, action: '梳理低分项并上传整改前后照片' })
  if (satisfaction < 88) deductions.push({ dimension: '满意度', score: Math.min(12, Math.round((88 - satisfaction) * 0.7)), reason: `满意度${satisfaction}分`, action: '对不满意样本开展客服回访并沉淀共性诉求' })
  if (incidents > 0) deductions.push({ dimension: '安全', score: Math.min(20, incidents * 10), reason: `安全事故${incidents}起`, action: '立即复盘事故原因，补齐日管控和责任人记录' })
  if (complaints > 15) deductions.push({ dimension: '客诉', score: Math.min(12, Math.round((complaints - 15) * 0.6)), reason: `投诉${complaints}件`, action: '按工程/客服/秩序/环境分类做周度销项' })
  const score = Math.max(0, 100 - deductions.reduce((sum, d) => sum + d.score, 0))
  const level = score >= 90 ? '优秀' : score >= 80 ? '稳健' : score >= 70 ? '关注' : '预警'
  return { score, level, deductions: deductions.filter(d => d.score > 0) }
}
function avgMetrics(rows: any[]) {
  const complete = rows.filter(hasCompleteOperatingFacts)
  if (!complete.length) return { count: 0, collectionRate: null, profitRate: null, quality: null, satisfaction: null, complaints: null, healthScore: null }
  const receivable = complete.reduce((s, r) => s + Number(r.receivable), 0)
  const received = complete.reduce((s, r) => s + Number(r.received), 0)
  const income = complete.reduce((s, r) => s + Number(r.ytd_income), 0)
  const cost = complete.reduce((s, r) => s + Number(r.ytd_cost), 0)
  const healthScores = complete.map(healthOf).filter((value): value is NonNullable<ReturnType<typeof healthOf>> => value !== null)
  return {
    count: complete.length,
    collectionRate: receivable > 0 ? received / receivable * 100 : null,
    profitRate: income > 0 ? (income - cost) / income * 100 : null,
    quality: complete.reduce((s, r) => s + Number(r.quality_score), 0) / complete.length,
    satisfaction: complete.reduce((s, r) => s + Number(r.customer_satisfaction), 0) / complete.length,
    complaints: complete.reduce((s, r) => s + Number(r.complaint_count), 0) / complete.length,
    healthScore: healthScores.length ? Math.round(healthScores.reduce((s, r) => s + r.score, 0) / healthScores.length) : null,
  }
}
function rankOf(project: any, rows: any[], metric: 'collection' | 'profit' | 'health') {
  const ranked = rows.map(r => ({ id: r.id, value: metric === 'collection' ? collectionRateOf(r) : metric === 'profit' ? profitRateOf(r) : healthOf(r)?.score ?? null }))
    .filter((row): row is { id: any; value: number } => row.value !== null)
    .sort((a, b) => b.value - a.value)
  const index = ranked.findIndex(r => r.id === project.id)
  return index >= 0 ? index + 1 : null
}

router.post('/api/projects/directory/publish', requireAdmin, (req, res) => {
  if (String(req.body?.confirmation || '') !== '确认发布项目目录') {
    return res.status(400).json({ error: '请输入“确认发布项目目录”后再执行' })
  }
  try {
    return res.json(publishProjectDirectory(req))
  } catch (error: any) {
    return res.status(409).json({ error: String(error?.message || '项目目录发布失败').slice(0, 300) })
  }
})

// ─── 项目列表（支持片区筛选）─────────────────────────
router.get('/api/projects', (req, res) => {
  const area = req.query.area as string | undefined
  const scope = projectScopeWhere(req)
  const clauses: string[] = ["COALESCE(active_status,'active')='active'"]
  const params: any[] = []
  if (scope.clause) { clauses.push(scope.clause); params.push(...scope.params) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = applyEffectiveMasterState(
    db.prepare(`SELECT * FROM projects ${where} ORDER BY area, name`).all(...params) as any[],
    { centerField: 'name' },
  ).filter(row => !area || area === '全部' || row.area === area).map(decorateProjectRow)
  const status = readProjectDirectoryStatus(db)
  const traceability = directoryTraceability(db)
  res.json({ rows, total: rows.length, status, traceability, meta: projectResponseContext(req, status, traceability) })
})

// ─── 项目汇总（按片区聚合）─────────────────────────
router.get('/api/projects/summary', (req, res) => {
  const scope = projectScopeWhere(req)
  const where = `WHERE COALESCE(active_status,'active')='active'${scope.clause ? ` AND ${scope.clause}` : ''}`
  const projects = applyEffectiveMasterState(
    db.prepare(`SELECT * FROM projects ${where}`).all(...scope.params) as any[],
    { centerField: 'name' },
  )
  const grouped = new Map<string, any[]>()
  for (const project of projects) grouped.set(project.area, [...(grouped.get(project.area) || []), project])
  const sum = (items: any[], field: string) => {
    const values = items.map(item => optionalNumber(item[field])).filter((value): value is number => value !== null)
    return values.length ? values.reduce((total, value) => total + value, 0) : null
  }
  const average = (items: any[], field: string) => {
    const values = items.map(item => optionalNumber(item[field])).filter((value): value is number => value !== null)
    return values.length ? Math.round(values.reduce((total, value) => total + value, 0) / values.length * 10) / 10 : null
  }
  const rows = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right, 'zh-CN')).map(([area, items]) => {
    const collectionFactProjectCount = items.filter(item => item.receivable !== null && item.received !== null).length
    const operatingFactProjectCount = items.filter(hasCompleteOperatingFacts).length
    return {
      area,
      project_count: items.length,
      total_area: sum(items, 'area_sqm'),
      total_units: sum(items, 'units'),
      avg_quality: average(items, 'quality_score'),
      total_incidents: sum(items, 'safety_incidents'),
      avg_satisfaction: average(items, 'customer_satisfaction'),
      total_income: sum(items, 'annual_income'),
      total_cost: sum(items, 'annual_cost'),
      total_receivable: sum(items, 'receivable'),
      total_received: sum(items, 'received'),
      collection_fact_project_count: collectionFactProjectCount,
      operating_fact_project_count: operatingFactProjectCount,
      dataAvailability: {
        state: operatingFactProjectCount === items.length ? 'operating_ready' : 'directory_only',
        collectionFactsAvailable: collectionFactProjectCount > 0,
        collectionFactProjectCount,
        operatingFactsAvailable: operatingFactProjectCount === items.length,
        operatingFactProjectCount,
      },
    }
  })
  const status = readProjectDirectoryStatus(db)
  const traceability = directoryTraceability(db)
  res.json({ rows, status, traceability, meta: projectResponseContext(req, status, traceability) })
})

// ─── 片区列表（必须先于数字ID详情路由）──────────────────
router.get('/api/projects/areas', (req, res) => {
  const scope = projectScopeWhere(req)
  const rows = applyEffectiveMasterState(
    db.prepare(`SELECT name,area FROM projects WHERE COALESCE(active_status,'active')='active'${scope.clause ? ` AND ${scope.clause}` : ''}`).all(...scope.params) as any[],
    { centerField: 'name' },
  )
  const areas = [...new Set(rows.map(row => String(row.area || '')).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  res.json({ areas, meta: projectResponseContext(req) })
})

// ─── 项目详情（含同比环比）─────────────────────────
router.get('/api/projects/:id(\\d+)', (req: any, res) => {
  const sourceProject = db.prepare("SELECT * FROM projects WHERE id = ? AND COALESCE(active_status,'active')='active'").get(req.params.id) as any
  if (!sourceProject) return res.status(404).json({ error: '项目不存在' })
  if (!canAccessProjectRow(req, sourceProject)) return denyScopedResource(req, res, '项目不存在或无权访问')
  const project = applyEffectiveMasterState([sourceProject], { centerField: 'name' })[0]
  if (!project) return res.status(404).json({ error: '项目不存在' })

  const availability = projectDataAvailability(project)
  if (!availability.operatingFactsAvailable) {
    const officialCollectionRate = project.official_collection_rate !== null
      && project.official_collection_rate !== undefined
      && Number.isFinite(Number(project.official_collection_rate))
      ? Number(project.official_collection_rate) * 100 : collectionRateOf(project)
    return res.json({
      project: decorateProjectRow(project),
      collectionRate: officialCollectionRate,
      profitRate: null,
      areaAvg: { avg_collection_rate: null, avg_quality: null, avg_satisfaction: null },
      riskProfile: {
        dataAvailable: false,
        status: 'insufficient',
        healthScore: null,
        level: '未知',
        dimensions: [],
        deductions: [],
        knownFacts: {
          receivable: project.receivable ?? null,
          received: project.received ?? null,
          officialCollectionRate,
          source: officialCollectionRate === null ? null : '已发布P46绿仔官方收缴字段按项目应收加权',
        },
        message: availability.message,
      },
      benchmarks: null,
      traceability: directoryTraceability(db),
      meta: projectResponseContext(req),
    })
  }

  // 计算收费率
  const rawCollectionRate = collectionRateOf(project)
  const collectionRate = rawCollectionRate === null ? null : Math.round(rawCollectionRate * 100) / 100

  // 计算利润率
  const rawProfitRate = profitRateOf(project)
  const profitRate = rawProfitRate === null ? null : Math.round(rawProfitRate * 100) / 100

  // 片区平均（用于对比）
  const scope = projectScopeWhere(req)
  const allProjects = applyEffectiveMasterState(
    db.prepare(`SELECT * FROM projects WHERE validation_status='verified' AND COALESCE(active_status,'active')='active'${scope.clause ? ` AND ${scope.clause}` : ''}`).all(...scope.params) as any[],
    { centerField: 'name' },
  ).filter(hasCompleteOperatingFacts)
  const areaProjects = allProjects.filter(p => p.area === project.area)
  const areaAvg = {
    avg_collection_rate: areaProjects.length ? pct(areaProjects.reduce((sum, row) => sum + Number(collectionRateOf(row)), 0) / areaProjects.length) : null,
    avg_quality: areaProjects.length ? pct(areaProjects.reduce((sum, row) => sum + Number(row.quality_score), 0) / areaProjects.length) : null,
    avg_satisfaction: areaProjects.length ? pct(areaProjects.reduce((sum, row) => sum + Number(row.customer_satisfaction), 0) / areaProjects.length) : null,
  }
  const typeProjects = allProjects.filter(p => p.property_type === project.property_type)
  const h = healthOf(project)
  if (collectionRate === null || profitRate === null || !h) {
    return res.status(409).json({ error: '项目经营事实字段不完整，不能生成经营结论', code: 'PROJECT_DATA_QUALITY_BLOCKED' })
  }
  const riskProfile = {
    healthScore: h.score,
    level: h.level,
    dimensions: [
      { name: '收费', value: pct(collectionRate), target: 95, status: collectionRate >= 90 ? '稳健' : collectionRate >= 80 ? '关注' : '预警' },
      { name: '利润', value: pct(profitRate), target: 18, status: profitRate >= 18 ? '稳健' : profitRate >= 10 ? '关注' : '预警' },
      { name: '品质', value: Number(project.quality_score), target: 90, status: Number(project.quality_score) >= 90 ? '稳健' : Number(project.quality_score) >= 80 ? '关注' : '预警' },
      { name: '安全', value: Number(project.safety_incidents), target: 0, status: Number(project.safety_incidents) === 0 ? '稳健' : '预警' },
      { name: '客诉', value: Number(project.complaint_count), target: 15, status: Number(project.complaint_count) <= 15 ? '稳健' : Number(project.complaint_count) <= 25 ? '关注' : '预警' },
    ],
    deductions: h.deductions,
  }
  const benchmarks = {
    area: avgMetrics(areaProjects),
    northChina: avgMetrics(allProjects),
    propertyType: avgMetrics(typeProjects),
    ranks: {
      areaCollectionRank: rankOf(project, areaProjects, 'collection'), areaTotal: areaProjects.length,
      northCollectionRank: rankOf(project, allProjects, 'collection'), northTotal: allProjects.length,
      typeCollectionRank: rankOf(project, typeProjects, 'collection'), typeTotal: typeProjects.length,
      areaHealthRank: rankOf(project, areaProjects, 'health'),
      northHealthRank: rankOf(project, allProjects, 'health'),
    }
  }
  res.json({
    project: decorateProjectRow(project),
    collectionRate,
    profitRate,
    areaAvg: areaAvg || {},
    riskProfile,
    benchmarks,
    meta: projectResponseContext(req),
  })
})

export default router
