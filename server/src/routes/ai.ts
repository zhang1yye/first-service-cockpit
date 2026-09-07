import { Router } from 'express'
import fs from 'node:fs'
import db from '../db.js'
import { canAccessProjectRow, getServiceCenterScope, projectScopeWhere, serviceCenterScopeWhere } from '../auth.js'
import { buildAutoJobs, buildPublicationStatus, buildSourceStatus } from './data-sources.js'
import { qualityCaseTiming } from '../quality-workflow.js'
import { calculateGrowth } from '../production-safety.js'
import { projectDataBlockedPayload, readProjectDataGate } from '../data-quality-gate.js'
import { aggregateAreaScopeForUser } from '../permissions.js'
import { getFormalCollectionDataset } from '../collection-dataset.js'
import { normalizeCollectionCenter } from '../collection-quality.js'
import {
  buildServiceCenterAnalysis,
  type PaymentPublicationMeta,
  type ServiceCenterDailyRow,
  type ServiceCenterPaymentRow,
} from '../service-center-analysis.js'
import { formalP46PublicationPredicate } from '../formal-p46-publication.js'
import {
  attachServiceCenterAiSnapshot,
  getServiceCenterAiRun,
  queueServiceCenterAiRun,
} from '../service-center-ai.js'
import { fixedEntryPath } from '../fixed-entry-root.js'
import { applyEffectiveMasterState } from '../service-center-master.js'
import { unresolvedPublishedDailyConflict } from '../daily-reconciliation-gate.js'


const router = Router()

type ProjectRow = {
  id: number; area: string; name: string; area_sqm: number | null; units: number | null
  property_type: string | null; staff_count: number | null; annual_income: number | null; annual_cost: number | null
  ytd_income: number | null; ytd_cost: number | null; receivable: number | null; received: number | null
  quality_score: number | null; safety_incidents: number | null; customer_satisfaction: number | null; complaint_count: number | null
}

function effectiveProjects(rows: ProjectRow[]): ProjectRow[] {
  return applyEffectiveMasterState(rows, { centerField: 'name' }) as ProjectRow[]
}

function effectiveProject(row: ProjectRow | undefined): ProjectRow | undefined {
  return row ? effectiveProjects([row])[0] : undefined
}

function n(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : Number(v || 0) }
function pct(v: number): string { return `${v.toFixed(1)}%` }
function money(v: number): string { return `${v.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}万` }
function collectionRate(p: ProjectRow): number { return n(p.receivable) > 0 ? n(p.received) / n(p.receivable) * 100 : 0 }
function profitRate(p: ProjectRow): number { return n(p.ytd_income) > 0 ? (n(p.ytd_income) - n(p.ytd_cost)) / n(p.ytd_income) * 100 : 0 }
function hoursSince(d?: Date | null) {
  if (!d || Number.isNaN(d.getTime())) return null
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 360_000) / 10)
}
function dataQualitySummary() {
  const currentMonth = new Date().toISOString().slice(0, 7)
  const sources = db.prepare('SELECT * FROM data_sources ORDER BY id').all() as any[]
  const latestRun = db.prepare('SELECT * FROM snapshot_runs ORDER BY id DESC LIMIT 1').get() as any
  const latestSnapshot = db.prepare("SELECT month, COUNT(*) as count, MAX(created_at) as created_at FROM project_monthly_snapshots WHERE quality_status='verified' GROUP BY month ORDER BY month DESC LIMIT 1").get() as any
  const projectCount = (db.prepare('SELECT COUNT(*) as cnt FROM projects').get() as { cnt: number }).cnt
  const rows = sources.map(row => {
    let health: 'ok' | 'warning' | 'danger' = 'warning'
    let status = row.status || '待检测'
    let detail = row.note || ''
    let last_sync_at = row.last_sync_at || null
    const filePath = row.source_key === 'aph'
      ? fixedEntryPath('APH决策_每日提取.json')
      : row.source_key === 'lvzai'
        ? fixedEntryPath('绿仔收款汇总.json')
        : ''
    if (filePath) {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath)
        const age = hoursSince(stat.mtime)
        health = age !== null && age > 72 ? 'warning' : 'ok'
        status = '已连接'
        last_sync_at = stat.mtime.toISOString()
        detail = `${row.name}文件${health === 'ok' ? '更新正常' : '超过72小时未更新'}`
      } else {
        health = 'danger'
        status = '待接入'
        detail = `${row.name}源文件缺失`
      }
    } else {
      status = projectCount > 0 ? '已接入' : '待导入'
      if (projectCount <= 0) {
        health = 'danger'
        detail = '项目经营表为空'
      } else if (latestRun?.status === 'failed') {
        health = 'danger'
        detail = `最近快照失败：${latestRun.message || '未返回失败原因'}`
      } else if (!latestSnapshot?.month || latestSnapshot.month < currentMonth) {
        health = 'warning'
        detail = latestSnapshot?.month ? `最新快照停留在${latestSnapshot.month}` : '尚未沉淀月度快照'
      } else {
        health = 'ok'
        detail = '项目经营表和月度快照状态正常'
      }
      last_sync_at = latestSnapshot?.created_at || last_sync_at
    }
    return { source_key: row.source_key, name: row.name, status, health, detail, last_sync_at }
  })
  const counts = rows.reduce((acc, row) => {
    acc[row.health] = (acc[row.health] || 0) + 1
    return acc
  }, { ok: 0, warning: 0, danger: 0 } as Record<string, number>)
  const qualityScore = Math.max(0, 100 - counts.warning * 8 - counts.danger * 18)
  const risky = rows.filter(r => r.health !== 'ok')
  return {
    score: qualityScore,
    counts: { total: rows.length, ...counts },
    latestSnapshotMonth: latestSnapshot?.month || null,
    projectCount,
    rows,
    summary: risky.length
      ? `数据源健康分${qualityScore}分，${risky.length}个数据源需关注：${risky.map(r => `${r.name}（${r.detail}）`).join('、')}。`
      : `数据源健康分${qualityScore}分，${rows.length}个数据源状态正常，最新月度快照${latestSnapshot?.month || '暂无'}。`,
  }
}

function alertRules() {
  const defaults: Record<string, number> = { collection_rate: 80, profit_rate: 10, safety_incidents: 0, quality_score: 75, satisfaction: 75, complaint_count: 20 }
  try {
    const rows = db.prepare('SELECT rule_key, threshold_value, enabled FROM alert_rules').all() as any[]
    for (const r of rows) if (r.enabled) defaults[r.rule_key] = n(r.threshold_value)
  } catch {}
  return defaults
}

function buildProjectAnalysis(p: any, areaAvg?: any) {
  const rate = n(p.collectionRate ?? collectionRate(p))
  const profit = n(p.profitRate ?? profitRate(p))
  const quality = n(p.quality_score)
  const sat = n(p.customer_satisfaction)
  const complaints = n(p.complaint_count)
  const incidents = n(p.safety_incidents)
  const reasons: string[] = []
  const actions: string[] = []
  let level: '优秀' | '稳健' | '关注' | '预警' = '稳健'

  if (rate < 80) { level = '预警'; reasons.push(`收费率仅${pct(rate)}，低于80%预警线`); actions.push('梳理90天以上欠费户，按楼栋/客户类型拆分催缴清单') }
  else if (rate < 90) { level = '关注'; reasons.push(`收费率${pct(rate)}，仍有提升空间`); actions.push('针对未缴户开展分层沟通，重点跟进高金额欠费') }
  else reasons.push(`收费率${pct(rate)}，回款表现较好`)

  if (profit < 10) { level = level === '预警' ? '预警' : '关注'; reasons.push(`利润率${pct(profit)}偏低`); actions.push('复盘人工、外包、能耗等成本项，明确可控压降动作') }
  else if (profit >= 20) reasons.push(`利润率${pct(profit)}，经营效率较好`)

  if (quality > 0 && quality < 80) { level = '预警'; reasons.push(`品质评分${quality}分偏低`); actions.push('由项目经理牵头整改低分检查项，并形成闭环照片/记录') }
  if (sat > 0 && sat < 80) { level = level === '预警' ? '预警' : '关注'; reasons.push(`客户满意度${sat}分偏低`); actions.push('客服岗对高频不满意业主做回访，沉淀共性诉求') }
  if (incidents > 0) { level = '预警'; reasons.push(`发生${incidents}起安全事故`); actions.push('立即复盘事故原因，补强日管控和责任人记录') }
  if (complaints > 20) { level = level === '预警' ? '预警' : '关注'; reasons.push(`投诉量${complaints}件偏高`); actions.push('对投诉按工程/客服/秩序/环境分类，优先处理重复投诉') }

  const vsArea = areaAvg?.avg_collection_rate ? `，较片区均值${n(areaAvg.avg_collection_rate).toFixed(1)}%${rate >= n(areaAvg.avg_collection_rate) ? '略好' : '偏低'}` : ''
  const text = `${p.name}当前经营状态为“${level}”：${reasons.slice(0, 3).join('；')}${vsArea}。建议${actions.length ? actions.slice(0, 3).join('；') : '保持当前收费节奏，持续关注品质与客户感知'}。`
  return { level, reasons, actions, text }
}

function getAlerts(req?: any) {
  const rules = alertRules()
  const scope = req ? projectScopeWhere(req) : { clause: '', params: [] as any[] }
  const projects = effectiveProjects(db.prepare(`SELECT * FROM projects ${scope.clause ? `WHERE ${scope.clause}` : ''}`).all(...scope.params) as ProjectRow[])
  const alerts: any[] = []
  for (const p of projects) {
    const rate = collectionRate(p)
    const profit = profitRate(p)
    const items: string[] = []
    const causes: string[] = []
    const actions: string[] = []
    if (rate < rules.collection_rate) { items.push(`收费率 ${rate.toFixed(1)}%（低于${rules.collection_rate}%）`); causes.push('应收规模较高但实收滞后'); actions.push('输出欠费户清单，优先处理90天以上欠费') }
    if (profit < rules.profit_rate) { items.push(`利润率 ${profit.toFixed(1)}%（低于${rules.profit_rate}%）`); causes.push('成本消耗相对收入偏高'); actions.push('复核人工、外包、能耗三类成本') }
    if (n(p.safety_incidents) > rules.safety_incidents) { items.push(`安全事故 ${p.safety_incidents} 起`); causes.push('安全日管控或隐患闭环可能不足'); actions.push('补做事故复盘和一机一责任人检查') }
    if (n(p.quality_score) > 0 && n(p.quality_score) < rules.quality_score) { items.push(`品质评分 ${p.quality_score}（低于${rules.quality_score}）`); causes.push('现场品质检查项失分较多'); actions.push('建立低分项整改台账') }
    if (n(p.customer_satisfaction) > 0 && n(p.customer_satisfaction) < rules.satisfaction) { items.push(`客户满意度 ${p.customer_satisfaction}（低于${rules.satisfaction}）`); causes.push('客户感知与服务响应存在短板'); actions.push('对不满意样本开展回访') }
    if (n(p.complaint_count) > rules.complaint_count) { items.push(`投诉量 ${p.complaint_count}（超过${rules.complaint_count}件）`); causes.push('高频诉求未形成闭环'); actions.push('按投诉类型做周度销项') }
    if (items.length > 0) alerts.push({ id: p.id, area: p.area, name: p.name, items, causes, actions, severity: items.some(i => i.includes('安全') || i.includes('收费率')) ? 'high' : 'medium' })
  }
  return alerts
}



function trendForProject(p: ProjectRow) {
  const month = new Date().getMonth() + 1
  const incomeProgress = n(p.annual_income) > 0 ? n(p.ytd_income) / n(p.annual_income) * 100 : null
  const costProgress = n(p.annual_cost) > 0 ? n(p.ytd_cost) / n(p.annual_cost) * 100 : null
  return {
    projectId: p.id,
    name: p.name,
    area: p.area,
    month,
    elapsedRate: null,
    incomeProgress,
    costProgress,
    expectedIncome: null,
    expectedCost: null,
    incomeGap: null,
    costGap: null,
    momIncomeGrowth: null,
    yoyIncomeGrowth: null,
    hasRealSnapshot: false,
    hasYoySnapshot: false,
    status: '数据不足',
    advice: '需接入至少两个连续期间的已验证月度快照后，才能形成经营趋势判断。',
    note: '没有足够的已验证月度快照；不按年度金额线性摊分，不估算时序目标、同比或环比。'
  }
}

function trendForProjectWithSnapshots(p: ProjectRow) {
  const snaps = db.prepare("SELECT * FROM project_monthly_snapshots WHERE project_name = ? AND quality_status='verified' ORDER BY month DESC LIMIT 14").all(p.name) as any[]
  if (snaps.length < 2) return trendForProject(p)
  const cur = snaps[0]
  const prev = snaps[1]
  const [y, m] = String(cur.month).split('-').map(Number)
  const yoyMonth = `${y - 1}-${String(m).padStart(2, '0')}`
  const yoy = snaps.find(s => s.month === yoyMonth)
  const incomeProgress = n(p.annual_income) > 0 ? n(cur.ytd_income) / n(p.annual_income) * 100 : null
  const costProgress = n(p.annual_cost) > 0 ? n(cur.ytd_cost) / n(p.annual_cost) * 100 : null
  const momRatio = calculateGrowth(cur.ytd_income, prev.ytd_income)
  const yoyRatio = yoy ? calculateGrowth(cur.ytd_income, yoy.ytd_income) : null
  const mom = momRatio === null ? null : momRatio * 100
  const realYoy = yoyRatio === null ? null : yoyRatio * 100
  const status = mom === null ? '真实快照不足' : mom >= 0 ? '环比增长' : '环比下降'
  const advice = mom === null
    ? '当前快照缺少有效上期基准，暂不形成趋势判断。'
    : `当前累计收入较上期${mom >= 0 ? '增长' : '下降'}${Math.abs(mom).toFixed(1)}%，请结合合同节点和回款明细核实变化原因。`
  return {
    projectId: p.id, name: p.name, area: p.area, month: m, snapshotMonth: cur.month, elapsedRate: null,
    incomeProgress, costProgress, expectedIncome: null, expectedCost: null, incomeGap: null, costGap: null,
    momIncomeGrowth: mom, yoyIncomeGrowth: realYoy, hasRealSnapshot: true, hasYoySnapshot: Boolean(yoy), status, advice,
    note: yoy ? `已使用真实月度快照：当前${cur.month}、上月${prev.month}、同期${yoy.month}。未使用年度金额线性摊分。` : `已使用真实月度快照：当前${cur.month}、上月${prev.month}；暂无${yoyMonth}同期快照，同比显示“—”。未使用年度金额线性摊分。`
  }
}


function snapshotCollectionRate(s: any): number { return n(s.receivable) > 0 ? n(s.received) / n(s.receivable) * 100 : 0 }
function snapshotProfitRate(s: any): number { return n(s.ytd_income) > 0 ? (n(s.ytd_income) - n(s.ytd_cost)) / n(s.ytd_income) * 100 : 0 }
function snapshotHealthScore(s: any) {
  const rate = snapshotCollectionRate(s)
  const profit = snapshotProfitRate(s)
  const deductions: Array<{ dimension: string; points: number; reason: string }> = []
  if (rate < 95) deductions.push({ dimension: '收费', points: Math.min(25, Math.round((95 - rate) * 0.8)), reason: `收费率${pct(rate)}低于95%目标` })
  if (profit < 18) deductions.push({ dimension: '利润', points: Math.min(18, Math.round((18 - profit) * 0.9)), reason: `利润率${pct(profit)}低于18%目标` })
  if (n(s.quality_score) > 0 && n(s.quality_score) < 90) deductions.push({ dimension: '品质', points: Math.min(12, Math.round((90 - n(s.quality_score)) * 0.7)), reason: `品质评分${n(s.quality_score)}分` })
  if (n(s.customer_satisfaction) > 0 && n(s.customer_satisfaction) < 88) deductions.push({ dimension: '满意度', points: Math.min(12, Math.round((88 - n(s.customer_satisfaction)) * 0.7)), reason: `满意度${n(s.customer_satisfaction)}分` })
  if (n(s.safety_incidents) > 0) deductions.push({ dimension: '安全', points: Math.min(20, n(s.safety_incidents) * 10), reason: `安全事故${n(s.safety_incidents)}起` })
  if (n(s.complaint_count) > 15) deductions.push({ dimension: '投诉', points: Math.min(12, Math.round((n(s.complaint_count) - 15) * 0.6)), reason: `投诉${n(s.complaint_count)}件` })
  const score = Math.max(0, 100 - deductions.reduce((sum, d) => sum + d.points, 0))
  const level = score >= 90 ? '优秀' : score >= 80 ? '稳健' : score >= 70 ? '关注' : '预警'
  return { score, level, deductions: deductions.filter(d => d.points > 0) }
}

function riskTrendForProject(p: ProjectRow) {
  const snaps = db.prepare("SELECT * FROM project_monthly_snapshots WHERE project_name = ? AND quality_status='verified' ORDER BY month ASC").all(p.name) as any[]
  const rows = snaps.map((s, idx) => {
    const prev = idx > 0 ? snaps[idx - 1] : null
    const health = snapshotHealthScore(s)
    const prevHealth = prev ? snapshotHealthScore(prev) : null
    const collectionRate = snapshotCollectionRate(s)
    const profitRate = snapshotProfitRate(s)
    const prevCollection = prev ? snapshotCollectionRate(prev) : collectionRate
    const prevProfit = prev ? snapshotProfitRate(prev) : profitRate
    return {
      month: s.month,
      projectId: p.id,
      name: p.name,
      area: s.area,
      collectionRate,
      profitRate,
      healthScore: health.score,
      level: health.level,
      qualityScore: n(s.quality_score),
      satisfaction: n(s.customer_satisfaction),
      complaintCount: n(s.complaint_count),
      safetyIncidents: n(s.safety_incidents),
      ytdIncome: n(s.ytd_income),
      ytdCost: n(s.ytd_cost),
      received: n(s.received),
      receivable: n(s.receivable),
      deltas: {
        health: prevHealth ? health.score - prevHealth.score : 0,
        collectionRate: collectionRate - prevCollection,
        profitRate: profitRate - prevProfit,
        complaints: prev ? n(s.complaint_count) - n(prev.complaint_count) : 0,
        incidents: prev ? n(s.safety_incidents) - n(prev.safety_incidents) : 0,
      },
      deductions: health.deductions,
    }
  })
  const latest = rows[rows.length - 1] || null
  const previous = rows.length > 1 ? rows[rows.length - 2] : null
  let consecutiveWorsening = 0
  for (let i = rows.length - 1; i > 0; i--) {
    const r = rows[i]
    const worsened = r.deltas.health < 0 || r.deltas.collectionRate < -1 || r.deltas.profitRate < -1 || r.deltas.complaints > 3 || r.deltas.incidents > 0
    if (!worsened) break
    consecutiveWorsening += 1
  }
  const warningSignals: string[] = []
  const improvementSignals: string[] = []
  if (latest && previous) {
    if (latest.deltas.health < 0) warningSignals.push(`健康分较上月下降${Math.abs(latest.deltas.health).toFixed(0)}分`)
    if (latest.deltas.collectionRate < -1) warningSignals.push(`收费率较上月下降${Math.abs(latest.deltas.collectionRate).toFixed(1)}个百分点`)
    if (latest.deltas.profitRate < -1) warningSignals.push(`利润率较上月下降${Math.abs(latest.deltas.profitRate).toFixed(1)}个百分点`)
    if (latest.deltas.complaints > 3) warningSignals.push(`投诉较上月增加${latest.deltas.complaints}件`)
    if (latest.deltas.incidents > 0) warningSignals.push(`安全事故较上月增加${latest.deltas.incidents}起`)
    if (latest.deltas.health > 0) improvementSignals.push(`健康分较上月提升${latest.deltas.health.toFixed(0)}分`)
    if (latest.deltas.collectionRate > 1) improvementSignals.push(`收费率较上月提升${latest.deltas.collectionRate.toFixed(1)}个百分点`)
    if (latest.deltas.profitRate > 1) improvementSignals.push(`利润率较上月提升${latest.deltas.profitRate.toFixed(1)}个百分点`)
    if (latest.deltas.complaints < -3) improvementSignals.push(`投诉较上月减少${Math.abs(latest.deltas.complaints)}件`)
  }
  const direction = !latest || !previous ? '样本不足' : warningSignals.length ? (consecutiveWorsening >= 2 ? '连续恶化' : '本月转弱') : improvementSignals.length ? '改善' : '稳定'
  const advice = direction === '连续恶化'
    ? '已出现连续恶化信号，建议纳入本周督办，明确责任人、截止时间和复盘口径。'
    : direction === '本月转弱'
      ? '本月指标转弱，建议在项目例会中拆解收费、成本、投诉或安全原因，防止形成连续预警。'
      : direction === '改善'
        ? '核心指标较上月改善，建议固化有效动作，并继续观察是否能连续两个月保持。'
        : rows.length < 2 ? '当前快照样本不足，建议至少保留两个月后再判断趋势。' : '历史趋势整体稳定，继续保持月度复盘和异常阈值监控。'
  return {
    projectId: p.id,
    name: p.name,
    area: p.area,
    rows,
    latest,
    previous,
    summary: {
      snapshotCount: rows.length,
      direction,
      consecutiveWorsening,
      warningSignals,
      improvementSignals,
      advice,
    },
  }
}

function answerBusinessQuestion(question: string, req?: any) {
  const q = question.trim()
  const scope = req ? projectScopeWhere(req) : { clause: '', params: [] as any[] }
  const projects = effectiveProjects(db.prepare(`SELECT * FROM projects ${scope.clause ? `WHERE ${scope.clause}` : ''}`).all(...scope.params) as ProjectRow[])
  if (!projects.length) return { answer: '当前没有通过真实性校验的项目数据，请先完成正式数据导入与发布。', evidence: [] }
  const enriched = projects.map(p => ({ ...p, collectionRate: collectionRate(p), profitRate: profitRate(p), trend: trendForProjectWithSnapshots(p) }))
  if (/收费率|收缴率|回款/.test(q) && /最低|最差|低/.test(q)) {
    const p = [...enriched].sort((a, b) => a.collectionRate - b.collectionRate)[0]
    return { answer: `当前收费率最低的是${p.name}，收费率${pct(p.collectionRate)}。建议优先输出欠费清单，重点跟进90天以上欠费和高金额欠费户。`, evidence: [{ name: p.name, area: p.area, collectionRate: p.collectionRate }] }
  }
  if (/收入进度|进度滞后|滞后|同比|环比/.test(q)) {
    const declining = [...enriched]
      .filter(p => p.trend.hasRealSnapshot && p.trend.momIncomeGrowth !== null && p.trend.momIncomeGrowth < 0)
      .sort((a, b) => Number(a.trend.momIncomeGrowth) - Number(b.trend.momIncomeGrowth))
      .slice(0, 5)
    return { answer: declining.length ? `基于已验证月度快照，累计收入环比下降的项目有${declining.map(p => `${p.name}（${Number(p.trend.momIncomeGrowth).toFixed(1)}%）`).join('、')}。请结合合同节点和回款明细核实变化原因。` : '当前没有足够证据识别收入环比下降项目；系统未使用年度金额线性摊分。', evidence: declining.map(p => ({ name: p.name, area: p.area, momIncomeGrowth: p.trend.momIncomeGrowth, status: p.trend.status, snapshotMonth: (p.trend as any).snapshotMonth || null })) }
  }
  if (/风险|预警|异常/.test(q) || /重点关注/.test(q)) {
    const alerts = getAlerts(req)
    return { answer: alerts.length ? `当前有${alerts.length}个预警项目，高风险${alerts.filter(a => a.severity === 'high').length}个。优先关注${alerts.slice(0, 3).map(a => a.name).join('、')}。` : '当前未发现重大经营异常项目。', evidence: alerts.slice(0, 5) }
  }
  if (/投诉/.test(q)) {
    const p = [...enriched].sort((a, b) => n(b.complaint_count) - n(a.complaint_count))[0]
    return { answer: `投诉量最高的是${p.name}，当前${n(p.complaint_count)}件。建议按工程、客服、秩序、环境分类，优先处理重复投诉。`, evidence: [{ name: p.name, area: p.area, complaint_count: p.complaint_count }] }
  }
  if (/利润|毛利|成本/.test(q) && /低|最低|差/.test(q)) {
    const p = [...enriched].sort((a, b) => a.profitRate - b.profitRate)[0]
    return { answer: `利润率最低的是${p.name}，利润率${pct(p.profitRate)}。建议复核人工、外包、能耗成本，并与收费进度联动分析。`, evidence: [{ name: p.name, area: p.area, profitRate: p.profitRate }] }
  }
  if (/片区|区域/.test(q) && /最好|最高|排名/.test(q)) {
    const areas = [...new Set(projects.map(project => project.area))].map(area => {
      const scoped = projects.filter(project => project.area === area)
      const receivable = scoped.reduce((sum, project) => sum + n(project.receivable), 0)
      const received = scoped.reduce((sum, project) => sum + n(project.received), 0)
      return { area, receivable, received, collectionRate: receivable > 0 ? received / receivable * 100 : 0 }
    })
      .sort((a, b) => b.collectionRate - a.collectionRate)
    return { answer: `按收费率看，排名前三片区为${areas.slice(0, 3).map(a => `${a.area}${pct(a.collectionRate)}`).join('、')}。`, evidence: areas.slice(0, 5) }
  }
  const alerts = getAlerts(req)
  return { answer: `当前纳入${projects.length}个项目，预警项目${alerts.length}个。建议重点查看AI预警中心，并优先关注收费率、利润率、投诉量和安全事故四类指标。你也可以问：哪个项目收费率最低、哪个项目投诉最高、哪些项目风险最高。`, evidence: alerts.slice(0, 3) }
}

async function callLLM(prompt: string, maxTokens = 500): Promise<string | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY || ''
  if (!apiKey) return null
  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0.6 }),
    })
    if (!response.ok) { console.error('[AI] API error:', await response.text()); return null }
    const result: any = await response.json()
    return result.choices?.[0]?.message?.content || null
  } catch (e: any) {
    console.error('[AI] Error:', e.message)
    return null
  }
}

// 前端先读取同源门禁状态，再决定是否请求受保护的 AI 结果。
// 该接口只返回判定事实；受保护接口仍保留 409，不能用前端预检绕过真实性门禁。
router.get('/api/data-quality/project-gate', (req, res) => {
  const gate = readProjectDataGate(db)
  res.set('Cache-Control', 'no-store')
  if ((req as any).user?.role !== 'admin') {
    const scope = projectScopeWhere(req)
    const projectCount = Number((db.prepare(`SELECT COUNT(*) count FROM projects ${scope.clause ? `WHERE ${scope.clause}` : ''}`).get(...scope.params) as any)?.count || 0)
    return res.json({
      ready: gate.ready && projectCount > 0,
      status: gate.ready && projectCount > 0 ? 'ready' : 'blocked',
      scoped: true,
      projectCount,
      code: gate.ready && projectCount > 0 ? 'PROJECT_DATA_QUALITY_READY' : 'PROJECT_DATA_QUALITY_BLOCKED',
    })
  }
  res.json({
    ...gate,
    code: gate.ready ? 'PROJECT_DATA_QUALITY_READY' : 'PROJECT_DATA_QUALITY_BLOCKED',
  })
})

function latestVerifiedDailyRows(): { businessDate: string | null; rows: ServiceCenterDailyRow[] } {
  const latest = db.prepare(`
    SELECT MAX(COALESCE(NULLIF(business_date, ''), date)) AS business_date
    FROM daily_snapshots
    WHERE quality_status = 'verified'
  `).get() as any
  const businessDate = String(latest?.business_date || '').trim() || null
  if (!businessDate) return { businessDate: null, rows: [] }
  if (unresolvedPublishedDailyConflict(db, businessDate)) return { businessDate, rows: [] }
  const rows = db.prepare(`
    SELECT center, annual_budget, cumulative_budget, cumulative_executed,
      daily_collection, source, business_date, date, last_validated_at
    FROM daily_snapshots
    WHERE quality_status = 'verified'
      AND COALESCE(NULLIF(business_date, ''), date) = ?
    ORDER BY id DESC
  `).all(businessDate) as ServiceCenterDailyRow[]
  return { businessDate, rows }
}

function latestPaymentEvidence(daily: { businessDate: string | null; rows: ServiceCenterDailyRow[] }): PaymentPublicationMeta {
  const lastValidatedAt = daily.rows
    .map(row => String(row.last_validated_at || '').trim())
    .filter(Boolean)
    .sort()
    .at(-1) || null
  const sources = [...new Set(daily.rows.map(row => String(row.source || '').trim()).filter(Boolean))]
  return {
    // 回款快照已验证，但与正式收缴数据集不是同一发布链，禁止冒充全链已发布。
    publicationStatus: daily.businessDate && daily.rows.length ? 'partial' : 'unpublished',
    businessDate: daily.businessDate,
    lastValidatedAt,
    source: sources.join(' + ') || 'FineReport已验证每日回款快照',
  }
}

function formalRowsWithCanonicalNames(rows: any[]): any[] {
  try {
    const formalPublication = formalP46PublicationPredicate('b')
    const mappings = db.prepare(`
      WITH latest_formal_batch AS (
        SELECT b.id FROM data_ingestion_batches b
        WHERE b.status='published' AND length(b.batch_sha256)=64 AND COALESCE(b.published_at,'')<>''
          AND ${formalPublication}
        ORDER BY b.business_date DESC,b.id DESC LIMIT 1
      )
      SELECT r.source_key, r.canonical_key
      FROM data_ingestion_rows r
      JOIN latest_formal_batch latest ON latest.id = r.batch_id
      WHERE r.entity_type = 'collection_center'
    `).all() as Array<{ source_key: string; canonical_key: string }>
    const canonicalBySource = new Map(mappings.map(row => [normalizeCollectionCenter(row.source_key), row.canonical_key]))
    return rows.map(row => ({
      ...row,
      // 规范名只用于本端点的跨源读取合并，不改写收缴数据或已验收缴API。
      canonicalCenter: row.canonicalCenter
        || canonicalBySource.get(normalizeCollectionCenter(row.center))
        || null,
    }))
  } catch {
    return rows
  }
}

// 56个APH回款中心独立于旧projects真实性门禁。
// 规则分析是每次请求的可验证底座；Hermes 只能在其上附加意见。
function serviceCenterAnalysisForRequest(req: any) {
  const user = (req as any).user
  const allowedAreas = user?.role === 'admin' ? null : []
  const centerScope = serviceCenterScopeWhere(req, 'center')
  let sql = `SELECT id, area, center, annual_budget, cumulative_budget, cumulative_executed, same_period
    FROM payment_centers`
  const params: string[] = []
  if (centerScope.clause) { sql += ` WHERE ${centerScope.clause}`; params.push(...centerScope.params) }
  sql += ' ORDER BY area, center, id'

  const payments = applyEffectiveMasterState(
    db.prepare(sql).all(...params) as ServiceCenterPaymentRow[],
  ) as ServiceCenterPaymentRow[]
  const daily = latestVerifiedDailyRows()
  const formal = getFormalCollectionDataset()
  return buildServiceCenterAnalysis({
    payments,
    latestDailyRows: daily.rows,
    dailyBusinessDate: daily.businessDate,
    formalCollectionRows: formalRowsWithCanonicalNames(formal.dataset?.rows || []),
    collectionPublication: formal.publication,
    paymentPublication: latestPaymentEvidence(daily),
    allowedAreas,
  })
}

router.get('/api/ai/service-centers', (req, res) => {
  const analysis = serviceCenterAnalysisForRequest(req)
  res.set('Cache-Control', 'no-store')
  res.json(attachServiceCenterAiSnapshot(analysis))
})

router.post('/api/ai/service-centers/analysis-runs', (req: any, res) => {
  // 兼容尚未在认证层校验服务中心绑定的私有环境基线：
  // 非管理员没有有效授权范围时必须在创建run和调用Hermes前失败关闭。
  // 不用analysis.rows作权限判断，避免把“合法绑定但当无回款事实”误判为未授权。
  if (req.user?.role !== 'admin' && getServiceCenterScope(req.user).length === 0) {
    return res.status(401).json({ error: '当前账号未绑定有效服务中心' })
  }
  const analysis = serviceCenterAnalysisForRequest(req)
  const requestContext = {
    user: {
      userId: req.user?.userId || null,
      username: req.user?.username || 'system',
      role: req.user?.role || '',
    },
    ip: req.ip || '',
  }
  const queued = queueServiceCenterAiRun(analysis, requestContext)
  res.set('Cache-Control', 'no-store')
  const status = String(queued.run.status || '')
  if (status === 'unavailable') {
    const knowledgeUnavailable = queued.run.errorCode === 'approved_knowledge_unavailable'
    return res.status(503).json({
      ...queued.run,
      error: knowledgeUnavailable
        ? '当前没有可用的已批准收缴知识，已保留规则分析结果'
        : 'Hermes模型未配置，已保留规则分析结果',
      generatedBy: 'verified-rules',
    })
  }
  res.status(status === 'running' ? 202 : 200).json({ ...queued.run, reused: queued.reused })
})

router.get('/api/ai/service-centers/analysis-runs/:id', (req: any, res) => {
  const runId = Number(req.params.id)
  if (!Number.isInteger(runId) || runId < 1) return res.status(400).json({ error: '分析运行编号无效' })
  const analysis = serviceCenterAnalysisForRequest(req)
  const run = getServiceCenterAiRun(runId, req.user, {}, analysis)
  if (!run) return res.status(404).json({ error: '分析运行不存在或无权查看' })
  res.set('Cache-Control', 'no-store')
  res.json(run)
})

// 经营分析、预警、月报与周重点必须先通过项目数据真实性门禁。
router.use([
  '/api/ai/trends', '/api/ai/risk-trends', '/api/ai/ask', '/api/ai/interpret', '/api/ai/health',
  '/api/ai/project', '/api/alerts', '/api/ai/monthly-report', '/api/ai/brief', '/api/ai/week-focus',
], (_req, res, next) => {
  const gate = readProjectDataGate(db)
  if (!gate.ready) {
    const blocked = projectDataBlockedPayload(db)
    // directory_only 只证明目录及已标注来源的收缴事实可用，不能生成健康分、利润或品质结论。
    if (gate.directoryOnlyProjectCount > 0) {
      return res.status(409).json({ ...blocked, dataAvailable: false, state: 'directory_only', conclusionStatus: 'insufficient' })
    }
    return res.status(409).json(blocked)
  }
  next()
})

// ─── 同比/环比与预算时序进度试算 ─────────────────────
router.get('/api/ai/trends', (req, res) => {
  const projectId = req.query.projectId as string | undefined
  if (projectId) {
    const sourceProject = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined
    if (!sourceProject || !canAccessProjectRow(req, sourceProject)) return res.status(404).json({ error: '项目不存在或无权访问' })
    const project = effectiveProject(sourceProject)
    if (!project) return res.status(404).json({ error: '项目不存在或无权访问' })
    return res.json({ rows: [trendForProjectWithSnapshots(project)] })
  }
  const scope = projectScopeWhere(req)
  const rows = effectiveProjects(db.prepare(`SELECT * FROM projects ${scope.clause ? `WHERE ${scope.clause}` : ''}`).all(...scope.params) as ProjectRow[]).map(trendForProjectWithSnapshots)
  const declining = rows.filter(r => r.hasRealSnapshot && r.momIncomeGrowth !== null && r.momIncomeGrowth < 0)
    .sort((a, b) => Number(a.momIncomeGrowth) - Number(b.momIncomeGrowth))
  res.json({ rows, summary: { total: rows.length, lagging: declining.length, topLagging: declining.slice(0, 5), realSnapshotCount: rows.filter((r: any) => r.hasRealSnapshot).length, note: rows[0]?.note || '' } })
})

// ─── 项目风险历史趋势：基于真实月度快照识别连续恶化/改善 ─────
router.get('/api/ai/risk-trends', (req, res) => {
  const projectId = req.query.projectId as string | undefined
  if (projectId) {
    const sourceProject = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined
    if (!sourceProject || !canAccessProjectRow(req, sourceProject)) return res.status(404).json({ error: '项目不存在或无权访问' })
    const project = effectiveProject(sourceProject)
    if (!project) return res.status(404).json({ error: '项目不存在或无权访问' })
    return res.json({ rows: [riskTrendForProject(project)] })
  }
  const scope = projectScopeWhere(req)
  const projects = effectiveProjects(db.prepare(`SELECT * FROM projects ${scope.clause ? `WHERE ${scope.clause}` : ''}`).all(...scope.params) as ProjectRow[])
  const rows = projects.map(riskTrendForProject)
  const worsening = rows.filter(r => r.summary.direction === '连续恶化' || r.summary.direction === '本月转弱')
    .sort((a, b) => (b.summary.consecutiveWorsening - a.summary.consecutiveWorsening) || ((a.latest?.healthScore || 100) - (b.latest?.healthScore || 100)))
  const improving = rows.filter(r => r.summary.direction === '改善').sort((a, b) => (b.latest?.deltas.health || 0) - (a.latest?.deltas.health || 0))
  res.json({
    rows,
    summary: {
      total: rows.length,
      withSnapshots: rows.filter(r => r.summary.snapshotCount > 0).length,
      worsening: worsening.length,
      improving: improving.length,
      consecutiveWorsening: rows.filter(r => r.summary.consecutiveWorsening >= 2).length,
      topWorsening: worsening.slice(0, 5).map(r => ({ projectId: r.projectId, name: r.name, area: r.area, latest: r.latest, summary: r.summary })),
      topImproving: improving.slice(0, 5).map(r => ({ projectId: r.projectId, name: r.name, area: r.area, latest: r.latest, summary: r.summary })),
    }
  })
})

// ─── 自然语言问数：固定经营问题稳定回答 ────────────────
router.post('/api/ai/ask', (req, res) => {
  const question = String(req.body?.question || '')
  if (!question.trim()) return res.status(400).json({ error: '请输入问题' })
  res.json({ question, ...answerBusinessQuestion(question, req) })
})

// ─── AI 数据解读 ────────────────────────────────────
router.post('/api/ai/interpret', async (req, res) => {
  const { type, data } = req.body
  if (!['project', 'region', 'alert'].includes(String(type || ''))) return res.status(400).json({ error: '不支持的解读类型' })
  let interpretationData = data
  if ((req as any).user?.role !== 'admin') {
    if (type === 'region') {
      const suppliedRows = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : []
      const suppliedIds = suppliedRows
        .map((row: any) => Number(row?.id ?? row?.projectId))
        .filter((id: number) => Number.isInteger(id) && id > 0)
      for (const id of suppliedIds) {
        const suppliedProject = db.prepare('SELECT id,name,area FROM projects WHERE id=?').get(id)
        if (!suppliedProject || !canAccessProjectRow(req, suppliedProject)) {
          return res.status(403).json({ error: '解读数据超出当前服务中心范围' })
        }
      }
      const scope = projectScopeWhere(req)
      const scopedRows = effectiveProjects(db.prepare(`SELECT * FROM projects WHERE ${scope.clause || '1=0'} ORDER BY area,name`).all(...scope.params) as ProjectRow[])
      if (!scopedRows.length) return res.status(403).json({ error: '当前账号未绑定有效服务中心或该中心暂无项目数据' })
      // 普通成员不使用客户端上传的业务字段，统一从数据库重取本中心项目。
      interpretationData = scopedRows
    } else {
      const row = data?.project || data
      const projectId = Number(row?.id ?? row?.projectId)
      if (!Number.isInteger(projectId) || projectId < 1) return res.status(400).json({ error: '缺少有效项目编号' })
      const sourceProject = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as ProjectRow | undefined
      if (!sourceProject || !canAccessProjectRow(req, sourceProject)) return res.status(403).json({ error: '解读数据超出当前服务中心范围' })
      const project = effectiveProject(sourceProject)
      if (!project) return res.status(403).json({ error: '解读数据超出当前服务中心范围' })
      if (type === 'alert') {
        const alert = getAlerts(req).find(item => Number(item.id) === projectId)
        if (!alert) return res.status(404).json({ error: '当前项目没有可解读的有效预警' })
        interpretationData = alert
      } else {
        interpretationData = { project, collectionRate: collectionRate(project), profitRate: profitRate(project) }
      }
    }
  }
  const fallback = generateFallbackInterpretation(type, interpretationData)
  let prompt = ''
  if (type === 'project') {
    const p = interpretationData?.project
      ? { ...interpretationData.project, collectionRate: interpretationData.collectionRate, profitRate: interpretationData.profitRate, areaAvg: interpretationData.areaAvg }
      : interpretationData
    prompt = `你是第一服务控股华北地区物业管理数据分析师。请根据项目数据，用150字以内输出经营解读，包含整体判断、异常原因、管理动作。数据：${JSON.stringify(p)}`
  } else if (type === 'region') {
    prompt = `你是第一服务控股华北地区物业管理数据分析师。请根据地区汇总数据，用200字以内输出经营解读和管理建议。数据：${JSON.stringify(interpretationData)}`
  } else {
    prompt = `你是第一服务控股华北地区物业管理数据分析师。请根据异常预警，用120字以内总结最值得关注的问题和动作。数据：${JSON.stringify(interpretationData)}`
  }
  const text = await callLLM(prompt, 350)
  res.json({ text: text || fallback })
})

// ─── AI 项目归因：为什么红、下一步怎么办 ─────────────
router.get('/api/ai/project/:id/diagnosis', (req, res) => {
  const sourceProject = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as ProjectRow | undefined
  if (!sourceProject || !canAccessProjectRow(req, sourceProject)) return res.status(404).json({ error: '项目不存在或无权访问' })
  const project = effectiveProject(sourceProject)
  if (!project) return res.status(404).json({ error: '项目不存在或无权访问' })
  const scope = projectScopeWhere(req)
  const peers = effectiveProjects(db.prepare(`SELECT * FROM projects ${scope.clause ? `WHERE ${scope.clause}` : ''}`).all(...scope.params) as ProjectRow[])
    .filter(row => row.area === project.area)
  const areaAvg = {
    avg_collection_rate: peers.length ? peers.reduce((sum, row) => sum + collectionRate(row), 0) / peers.length : null,
    avg_quality: peers.length ? peers.reduce((sum, row) => sum + n(row.quality_score), 0) / peers.length : null,
    avg_satisfaction: peers.length ? peers.reduce((sum, row) => sum + n(row.customer_satisfaction), 0) / peers.length : null,
  }
  res.json({ projectId: project.id, ...buildProjectAnalysis(project, areaAvg) })
})

// ─── 异常预警查询 ──────────────────────────────────
router.get('/api/alerts', (req, res) => {
  const alerts = getAlerts(req)
  const summary = alerts.length === 0
    ? '当前未发现重大经营异常。'
    : `当前共有${alerts.length}个项目触发预警，其中高风险${alerts.filter(a => a.severity === 'high').length}个。重点关注${alerts.slice(0, 3).map(a => a.name).join('、')}。`
  res.json({ alerts, total: alerts.length, summary, thresholds: alertRules() })
})

// ─── AI 月度经营报告 ────────────────────────────────
router.get('/api/ai/monthly-report', async (req, res) => {
  const area = (req.query.area as string) || '华北'
  const scope = projectScopeWhere(req)
  const clauses: string[] = []
  const params: any[] = []
  if (area !== '华北' && area !== '全部') { clauses.push('area = ?'); params.push(area) }
  if (scope.clause) { clauses.push(scope.clause); params.push(...scope.params) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const summary = db.prepare(`
    SELECT COUNT(*) as project_count, SUM(area_sqm) as total_area, SUM(units) as total_units,
      SUM(ytd_income) as ytd_income, SUM(ytd_cost) as ytd_cost, SUM(receivable) as total_receivable,
      SUM(received) as total_received, ROUND(AVG(quality_score), 1) as avg_quality,
      SUM(safety_incidents) as total_incidents, ROUND(AVG(customer_satisfaction), 1) as avg_satisfaction,
      SUM(complaint_count) as total_complaints
    FROM projects ${where}
  `).get(...params) as any
  const projects = db.prepare(`SELECT * FROM projects ${where} ORDER BY area, name`).all(...params) as ProjectRow[]
  const alerts = getAlerts(req).filter(a => area === '华北' || area === '全部' || a.area === area)
  const collection = n(summary?.total_receivable) > 0 ? n(summary.total_received) / n(summary.total_receivable) * 100 : 0
  const profit = n(summary?.ytd_income) > 0 ? (n(summary.ytd_income) - n(summary.ytd_cost)) / n(summary.ytd_income) * 100 : 0
  const rankWhere = scope.clause ? `WHERE ${scope.clause}` : ''
  const areaRank = (db.prepare(`
    SELECT area, COUNT(*) as project_count, SUM(receivable) as receivable, SUM(received) as received, ROUND(AVG(quality_score),1) as quality, ROUND(AVG(customer_satisfaction),1) as satisfaction
    FROM projects ${rankWhere} GROUP BY area ORDER BY area
  `).all(...scope.params) as any[]).map(r => ({ ...r, collectionRate: n(r.receivable) > 0 ? n(r.received) / n(r.receivable) * 100 : 0 }))
    .sort((a, b) => b.collectionRate - a.collectionRate)
  const weakest = [...projects].sort((a, b) => collectionRate(a) - collectionRate(b)).slice(0, 5)
  const strongest = [...projects].sort((a, b) => collectionRate(b) - collectionRate(a)).slice(0, 3)
  const reportDate = new Date().toISOString().slice(0, 10)
  const isAdmin = (req as any).user?.role === 'admin'
  const latestScopedSnapshot = db.prepare(`SELECT MAX(s.month) month
    FROM project_monthly_snapshots s
    JOIN projects p ON p.name=s.project_name
    ${scope.clause ? `WHERE ${scope.clause.replace(/\bname\b/g, 'p.name')}` : ''}`).get(...scope.params) as any
  const dataQuality = isAdmin ? dataQualitySummary() : {
    score: projects.length ? 100 : 0,
    counts: { total: projects.length },
    latestSnapshotMonth: latestScopedSnapshot?.month || null,
    projectCount: projects.length,
    rows: [],
    summary: projects.length ? '当前服务中心项目数据已按授权范围加载。' : '当前服务中心暂无已验证项目数据。',
  }
  const autoJobs = isAdmin ? buildAutoJobs() : null
  const abnormalAutoJobs = autoJobs?.rows.filter((j: any) => j.health !== 'ok' || j.status === 'failed') || []
  const autoTaskReview = isAdmin && autoJobs ? {
    summary: autoJobs.summary,
    generatedAt: autoJobs.generatedAt,
    rows: autoJobs.rows.map((j: any) => ({ key: j.key, name: j.name, health: j.health, status: j.status, schedule: j.schedule, last_run_at: j.last_run_at, next_run_hint: j.next_run_hint, message: j.message, log_path: j.log_path })),
    abnormal: abnormalAutoJobs.map((j: any) => ({ key: j.key, name: j.name, health: j.health, status: j.status, message: j.message, log_path: j.log_path })),
    text: abnormalAutoJobs.length
      ? `本月数据流水线发现${abnormalAutoJobs.length}项需关注：${abnormalAutoJobs.map((j: any) => `${j.name}（${j.message}）`).join('；')}。`
      : `数据流水线共${autoJobs.summary.total}项，正常${autoJobs.summary.ok}项，关注${autoJobs.summary.warning}项，异常${autoJobs.summary.danger}项。`,
  } : null
  const riskTrends = projects.map(riskTrendForProject)
  const worseningTrends = riskTrends.filter(r => r.summary.direction === '连续恶化' || r.summary.direction === '本月转弱')
    .sort((a, b) => (b.summary.consecutiveWorsening - a.summary.consecutiveWorsening) || ((a.latest?.healthScore || 100) - (b.latest?.healthScore || 100)))
  const improvingTrends = riskTrends.filter(r => r.summary.direction === '改善')
    .sort((a, b) => (b.latest?.deltas.health || 0) - (a.latest?.deltas.health || 0))
  const localSections = [
    { title: '一、区域经营总览', content: `${area}本月纳入${n(summary?.project_count)}个项目，累计收入${money(n(summary?.ytd_income))}，累计成本${money(n(summary?.ytd_cost))}，综合利润率${pct(profit)}，综合收费率${pct(collection)}。` },
    { title: '二、核心指标表现', content: `平均品质评分${n(summary?.avg_quality).toFixed(1)}分，客户满意度${n(summary?.avg_satisfaction).toFixed(1)}分，投诉${n(summary?.total_complaints)}件，安全事故${n(summary?.total_incidents)}起。` },
    { title: '三、片区对比分析', content: areaRank.length ? `片区收费率排名前三：${areaRank.slice(0, 3).map(r => `${r.area}${pct(r.collectionRate)}`).join('、')}；后两位：${areaRank.slice(-2).map(r => `${r.area}${pct(r.collectionRate)}`).join('、')}。` : '暂无片区对比数据。' },
    { title: '四、重点异常项目', content: alerts.length ? alerts.slice(0, 6).map(a => `${a.name}：${a.items.join('，')}`).join('；') : '本月未发现重大异常项目。' },
    { title: '五、AI管理建议', content: `${weakest.length ? `优先关注${weakest.map(p => p.name).join('、')}等低收费率项目，核对欠费结构和收费计划。` : ''} 对投诉和满意度偏低项目开展回访，安全事故项目应补齐日管控记录。` },
    { title: '六、下月重点关注事项', content: `巩固${strongest.map(p => p.name).join('、') || '高表现项目'}经验，推动低收费率项目专项提升；同步复核成本高于收入、实收大于应收等数据口径异常。` },
    { title: '七、项目风险历史趋势', content: worseningTrends.length ? `基于真实月度快照，${worseningTrends.length}个项目出现风险转弱，其中连续恶化${worseningTrends.filter(r => r.summary.consecutiveWorsening >= 2).length}个。重点关注：${worseningTrends.slice(0, 5).map(r => `${r.name}（${r.summary.warningSignals[0] || r.summary.direction}）`).join('、')}。${improvingTrends.length ? `改善项目：${improvingTrends.slice(0, 3).map(r => r.name).join('、')}。` : ''}` : `本月项目风险历史趋势整体稳定。${improvingTrends.length ? `改善项目：${improvingTrends.slice(0, 3).map(r => r.name).join('、')}。` : ''}` },
    { title: '八、数据质量与数据源健康', content: `${dataQuality.summary} 当前项目主数据${dataQuality.projectCount}条，最新快照月份${dataQuality.latestSnapshotMonth || '暂无'}；APH、FineReport、绿仔的数据质量状态作为月报可信度依据。` },
    { title: '九、数据流水线运行情况', content: isAdmin
      ? `${autoTaskReview?.text || ''}如APH、绿仔或月度快照出现异常，应在数据源管理页查看运行日志和最近同步状态。`
      : '数据流水线由系统管理员统一维护，普通成员仅查看本服务中心经营结果。' },
  ]
  const prompt = `请基于以下物业地区公司经营数据生成正式月报，按“一、区域经营总览”到“九、数据流水线运行情况”九段输出，每段80字以内，不得生成任务、催办或责任人安排。数据：${JSON.stringify({ area, summary, collection, profit, alerts: alerts.slice(0, 10), areaRank, weakest: weakest.slice(0, 5), dataQuality, autoTaskReview, riskTrendSummary: { worsening: worseningTrends.slice(0,5), improving: improvingTrends.slice(0,3) } })}`
  const aiText = await callLLM(prompt, 1000)
  res.json({ reportDate, area, summary: { ...summary, collectionRate: collection, profitRate: profit }, areaRank, alerts, dataQuality, autoTaskReview, riskTrendSummary: { worsening: worseningTrends.slice(0, 5), improving: improvingTrends.slice(0, 3), total: riskTrends.length }, weakestProjects: weakest.map(p => ({ id: p.id, name: p.name, area: p.area, collectionRate: collectionRate(p) })), sections: localSections, aiText })
})

function generateFallbackInterpretation(type: string, data: any): string {
  if (type === 'project' && data) {
    const p = data.project ? { ...data.project, collectionRate: data.collectionRate, profitRate: data.profitRate } : data
    return buildProjectAnalysis(p, p.areaAvg).text
  }
  if (type === 'region' && data) {
    const rows = Array.isArray(data) ? data : (Array.isArray(data.rows) ? data.rows : [])
    if (rows.length) {
      const lowCollection = rows.filter((p: any) => collectionRate(p) < 90).sort((a: any, b: any) => collectionRate(a) - collectionRate(b))
      const safetyOrComplaint = rows.filter((p: any) => n(p.safety_incidents) > 0 || n(p.complaint_count) >= 20)
      const avgCollection = rows.reduce((s: number, p: any) => s + collectionRate(p), 0) / rows.length
      const focus = Array.from(new Map([...safetyOrComplaint, ...lowCollection].map((p: any) => [p.id || p.name, p])).values()).slice(0, 3).map((p: any) => p.name).filter(Boolean)
      return `当前区域项目规模${rows.length}个，综合收费率${pct(avgCollection)}；其中低于90%的项目${lowCollection.length}个，安全或投诉需关注项目${safetyOrComplaint.length}个。建议重点分析${focus.join('、') || '暂无突出异常项目'}的收费、投诉和安全指标。`
    }
    return `当前区域项目规模${data.count ?? data.project_count ?? 0}个，建议重点关注收费率、投诉和满意度低于均值的项目。`
  }
  return 'AI 已完成异常扫描，请优先关注收费率低、安全事故、投诉量高的项目，并按项目形成管理动作。'
}


function healthScore(p: ProjectRow) {
  const rate = collectionRate(p)
  const profit = profitRate(p)
  const quality = n(p.quality_score)
  const sat = n(p.customer_satisfaction)
  const incidents = n(p.safety_incidents)
  const complaints = n(p.complaint_count)
  const deductions: Array<{ item: string; points: number; reason: string }> = []
  if (rate < 95) deductions.push({ item: '收费率', points: Math.min(25, Math.round((95 - rate) * 0.8)), reason: `收费率${pct(rate)}，低于95%经营目标` })
  if (profit < 18) deductions.push({ item: '利润率', points: Math.min(18, Math.round((18 - profit) * 0.9)), reason: `利润率${pct(profit)}，成本效率需关注` })
  if (quality > 0 && quality < 90) deductions.push({ item: '品质', points: Math.min(12, Math.round((90 - quality) * 0.7)), reason: `品质评分${quality}分` })
  if (sat > 0 && sat < 88) deductions.push({ item: '满意度', points: Math.min(12, Math.round((88 - sat) * 0.7)), reason: `满意度${sat}分` })
  if (incidents > 0) deductions.push({ item: '安全', points: Math.min(20, incidents * 10), reason: `发生${incidents}起安全事故` })
  if (complaints > 15) deductions.push({ item: '投诉', points: Math.min(12, Math.round((complaints - 15) * 0.6)), reason: `投诉${complaints}件` })
  const score = Math.max(0, 100 - deductions.reduce((s, d) => s + d.points, 0))
  const level = score >= 90 ? '优秀' : score >= 80 ? '稳健' : score >= 70 ? '关注' : '预警'
  return { score, level, deductions: deductions.filter(d => d.points > 0) }
}

router.get('/api/ai/health', (req, res) => {
  const projectId = req.query.projectId as string | undefined
  const area = req.query.area as string | undefined
  let rows: ProjectRow[]
  const scope = projectScopeWhere(req)
  const clauses: string[] = []
  const params: any[] = []
  if (projectId) { clauses.push('id = ?'); params.push(projectId) }
  else if (area && area !== '全部' && area !== '华北') { clauses.push('area = ?'); params.push(area) }
  if (scope.clause) { clauses.push(scope.clause); params.push(...scope.params) }
  rows = db.prepare(`SELECT * FROM projects ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}`).all(...params) as ProjectRow[]
  const projects = rows.map(p => ({ id: p.id, name: p.name, area: p.area, ...healthScore(p) }))
  const avgScore = projects.length ? Math.round(projects.reduce((s, p) => s + p.score, 0) / projects.length) : 0
  const risky = projects.filter(p => p.score < 80).sort((a, b) => a.score - b.score)
  res.json({ avgScore, projects, risky, summary: `当前项目平均健康分${avgScore}分，${risky.length}个项目低于80分。` })
})

router.get('/api/ai/brief', (req, res) => {
  const scope = projectScopeWhere(req)
  const projects = db.prepare(`SELECT * FROM projects ${scope.clause ? `WHERE ${scope.clause}` : ''}`).all(...scope.params) as ProjectRow[]
  const alerts = getAlerts(req)
  const health = projects.map(p => ({ ...p, h: healthScore(p) })).sort((a, b) => a.h.score - b.h.score)
  const totalReceivable = projects.reduce((s, p) => s + n(p.receivable), 0)
  const totalReceived = projects.reduce((s, p) => s + n(p.received), 0)
  const collection = totalReceivable > 0 ? totalReceived / totalReceivable * 100 : 0
  const status = alerts.some(a => a.severity === 'high') || health.some(p => p.h.score < 70) ? '预警' : alerts.length ? '关注' : '稳健'
  const topRisk = health.slice(0, 3).map(p => p.name)
  const text = `今日华北地区整体经营处于“${status}”状态。综合收费率${pct(collection)}，平均健康分${projects.length ? Math.round(health.reduce((s,p)=>s+p.h.score,0)/projects.length) : 0}分；重点关注${topRisk.join('、') || '暂无'}。建议重点分析低收费率、利润率偏低、安全事故和投诉高发项目。`
  res.json({ status, text, collectionRate: collection, alerts: alerts.length, keyProjects: topRisk })
})

router.get('/api/command/data-reliability', (req, res) => {
  const autoJobs = buildAutoJobs()
  const jobs = autoJobs.rows || []
  const abnormalJobs = jobs.filter((j: any) => j.health !== 'ok' || j.status === 'failed')
  const sourceStatus = buildSourceStatus()
  const sources = sourceStatus.rows || []
  const criticalSources = sources.filter((source: any) => source.health === 'danger' || source.freshness === 'stale' || source.freshness === 'unknown')
  const attentionSources = sources.filter((source: any) => source.health === 'warning' || source.freshness === 'delayed')
  const oldestSource = [...sources].filter((source: any) => Number.isFinite(source.ageHours)).sort((a: any, b: any) => b.ageHours - a.ageHours)[0] || null

  const dq = dataQualitySummary()
  const dqCounts: any = dq.counts || {}
  const latestSnapshotMonth = dq.latestSnapshotMonth || null
  const okJobs = jobs.filter((j: any) => j.health === 'ok' && j.status !== 'failed').length
  const publication = buildPublicationStatus()
  const today = String((db.prepare("SELECT date('now','localtime') value").get() as any)?.value || new Date().toISOString().slice(0, 10))
  const qualityRows = (() => {
    try {
      return (db.prepare(`SELECT code,title,severity,workflow_status,owner,due_date,updated_at
        FROM data_quality_cases WHERE workflow_status!='resolved'
        ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
          CASE WHEN COALESCE(due_date,'')='' THEN 1 ELSE 0 END,due_date,updated_at DESC LIMIT 20`).all() as any[])
        .map(row => ({ ...row, timing: qualityCaseTiming(row, today) }))
    } catch { return [] }
  })()
  const qualityCases = {
    total: qualityRows.length,
    unassigned: qualityRows.filter(row => !row.owner).length,
    overdue: qualityRows.filter(row => row.timing.isOverdue).length,
    dueSoon: qualityRows.filter(row => row.timing.isDueSoon).length,
    review: qualityRows.filter(row => row.workflow_status === 'review').length,
    rows: qualityRows.slice(0, 5),
  }
  const publicationBlocked = publication.code === 'failed' || publication.code === 'unknown' || publication.code === 'partial'
  const credibility = publicationBlocked || abnormalJobs.length || criticalSources.length || dqCounts.danger > 0
    ? '需谨慎'
    : attentionSources.length || dqCounts.warning > 0
      ? '基本可信'
      : '可信'
  const tone = credibility === '可信' ? 'success' : credibility === '基本可信' ? 'warning' : 'danger'
  const summary = publication.code !== 'complete'
    ? `${publication.label}：${publication.summary}`
    : credibility === '可信'
      ? `当前正式发布已完整，数据流水线${jobs.length}项全部正常，经营数据可用于分析判断。`
      : credibility === '基本可信'
        ? `当前正式发布已完整，数据流水线正常${okJobs}/${jobs.length}项；经营判断可用但需关注数据质量。`
        : `当前正式发布已完整，但仍有${abnormalJobs.length}项流水线异常或${criticalSources.length}个过期/未知数据源。`
  res.json({
    generatedAt: sourceStatus.generatedAt,
    credibility,
    tone,
    summary,
    publication,
    qualityCases,
    autoJobs: {
      total: jobs.length,
      ok: okJobs,
      warning: jobs.filter((j: any) => j.health === 'warning').length,
      danger: jobs.filter((j: any) => j.health === 'danger' || j.status === 'failed').length,
      abnormal: abnormalJobs.map((j: any) => ({ key: j.key, name: j.name, health: j.health, status: j.status, message: j.message, log_path: j.log_path })),
      rows: jobs.map((j: any) => ({ key: j.key, name: j.name, health: j.health, status: j.status, schedule: j.schedule, last_run_at: j.last_run_at })),
    },
    sources: {
      summary: sourceStatus.summary,
      critical: criticalSources.length,
      attention: attentionSources.length,
      oldest: oldestSource ? { source_key: oldestSource.source_key, name: oldestSource.name, ageHours: oldestSource.ageHours, freshness: oldestSource.freshness, freshnessLabel: oldestSource.freshnessLabel } : null,
      rows: sources.map((source: any) => ({
        source_key: source.source_key,
        name: source.name,
        health: source.health,
        freshness: source.freshness,
        freshnessLabel: source.freshnessLabel,
        last_sync_at: source.last_sync_at,
        ageHours: source.ageHours,
        expectedFreshHours: source.expectedFreshHours,
        lastSuccessAt: source.lastSuccessAt,
        lastFailureAt: source.lastFailureAt,
        lastFailureReason: source.lastFailureReason,
        affectedPages: source.affectedPages,
      })),
    },

    dataQuality: {
      score: dq.score,
      latestSnapshotMonth,
      counts: dq.counts,
      risky: (dq.rows || []).filter((r: any) => r.health !== 'ok').slice(0, 4),
    },
    links: {
      dataSources: '/admin',
      monthlyReport: '/ai-report',
    },
  })
})

router.get('/api/ai/week-focus', (req, res) => {
  const scope = projectScopeWhere(req)
  const projects = db.prepare(`SELECT * FROM projects ${scope.clause ? `WHERE ${scope.clause}` : ''}`).all(...scope.params) as ProjectRow[]
  const today = new Date().toISOString().slice(0, 10)
  const focus = projects.map(p => {
    const h = healthScore(p)
    const rate = collectionRate(p)
    const profit = profitRate(p)

    let priority = 100 - h.score
    if (rate < 80) priority += 20
    if (profit < 10) priority += 12
    if (n(p.safety_incidents) > 0) priority += 18
    if (n(p.complaint_count) > 20) priority += 10

    const reasons = [
      rate < 90 ? `收费率${pct(rate)}` : '',
      profit < 12 ? `利润率${pct(profit)}` : '',
      n(p.safety_incidents) > 0 ? `安全事故${n(p.safety_incidents)}起` : '',
      n(p.complaint_count) > 20 ? `投诉${n(p.complaint_count)}件` : '',
    ].filter(Boolean)
    const riskType = rate < 90 ? '收费率' : profit < 12 ? '利润率' : n(p.safety_incidents) > 0 ? '安全' : n(p.complaint_count) > 20 ? '投诉' : '经营观察'
    return {
      id: p.id,
      name: p.name,
      area: p.area,
      healthScore: h.score,
      level: h.level,
      collectionRate: rate,
      profitRate: profit,
      priority,
      reasons: reasons.length ? reasons : ['经营指标相对平稳，保持跟踪'],
      observation: rate < 90 ? '建议核对欠费结构与收费进度' : profit < 12 ? '建议复核人工、外包、能耗三类成本' : n(p.safety_incidents) > 0 ? '建议查看安全事故复盘和日管控记录' : '建议持续观察经营趋势',
      riskType,
    }
  }).sort((a, b) => b.priority - a.priority).slice(0, 5)
  res.json({ date: today, rows: focus, summary: focus.length ? `本周建议优先处理${focus.map(f => f.name).join('、')}。` : '暂无必须处理项目。' })
})

export default router
