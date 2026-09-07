import fs from 'node:fs'
import path from 'node:path'

export type FiveBooksMetric = {
  id: string
  legacyIds?: string[]
  kind: 'base' | 'addition' | 'deduction' | 'adjustment' | 'manual' | 'none'
  weight: number | null
  dimension: string
  scoreRule: string
}

export type FiveBooksTemplate = {
  key: string
  subjectClass: string
  periodClass: 'early' | 'late' | 'all'
  metrics: FiveBooksMetric[]
}

export type FiveBooksStandard = {
  standardCode: string
  sourceSha256?: string
  periods: Array<{ key: string; templatePeriod: 'early' | 'late' }>
  templates: FiveBooksTemplate[]
}

export type FiveBooksInputRecord = {
  metricId: string
  applicability: 'applicable' | 'excluded' | 'pending'
  targetValue: number | null
  actualValue: number | null
  manualWeight: number | null
  manualScore: number | null
  effectValue: number | null
  dataSource: string
  evidenceNote: string
}

export type FiveBooksCalculatedRecord = FiveBooksInputRecord & {
  calculatedScore: number | null
  calculatedEffect: number | null
}

const round = (value: number, digits = 3) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function candidatePaths(): string[] {
  return [
    process.env.COCKPIT_FIVE_BOOKS_STANDARD_PATH || '',
    path.resolve(process.cwd(), 'firstcare-cloud-local/five-books-standard-pm5-xx-68-v1.js'),
    path.resolve(process.cwd(), '../firstcare-cloud-local/five-books-standard-pm5-xx-68-v1.js'),
    path.resolve(process.cwd(), '../static/five-books-standard-pm5-xx-68-v1.js'),
    '/var/www/cockpit/assets/r193-five-books/five-books-standard-pm5-xx-68-r193-20260902-v1.js',
    '/var/www/cockpit/five-books-standard-pm5-xx-68-v1.js',
  ].filter(Boolean)
}

let cached: { path: string; mtimeMs: number; standard: FiveBooksStandard } | null = null

export function loadFiveBooksStandard(): FiveBooksStandard {
  const file = candidatePaths().find(item => fs.existsSync(item))
  if (!file) throw new Error('五书正式标准文件未部署，禁止读写评估数据')
  const stat = fs.statSync(file)
  if (cached?.path === file && cached.mtimeMs === stat.mtimeMs) return cached.standard
  const source = fs.readFileSync(file, 'utf8')
  const match = source.match(/window\.__FIVE_BOOKS_STANDARD__\s*=\s*([\s\S]+);\s*$/)
  if (!match) throw new Error('五书正式标准文件格式无效')
  const standard = JSON.parse(match[1]) as FiveBooksStandard
  if (!standard.standardCode || !Array.isArray(standard.periods) || !Array.isArray(standard.templates)) {
    throw new Error('五书正式标准文件结构无效')
  }
  cached = { path: file, mtimeMs: stat.mtimeMs, standard }
  return standard
}

export function resolveFiveBooksTemplate(templateKey: string, period: string, subjectClass: string): FiveBooksTemplate {
  const standard = loadFiveBooksStandard()
  const periodDefinition = standard.periods.find(item => item.key === period)
  if (!periodDefinition) throw new Error('评估周期不在正式标准中')
  const template = standard.templates.find(item => item.key === templateKey)
  if (!template) throw new Error('指标模板不在正式标准中')
  if (template.subjectClass !== subjectClass) throw new Error('指标模板与评估对象类型不匹配')
  if (template.periodClass !== 'all' && template.periodClass !== periodDefinition.templatePeriod) {
    throw new Error('指标模板与评估周期不匹配')
  }
  return template
}

export function canonicalMetricId(template: FiveBooksTemplate, suppliedId: string): string | null {
  const metric = template.metrics.find(item => item.id === suppliedId || item.legacyIds?.includes(suppliedId))
  return metric?.id || null
}

function automaticBaseScore(metric: FiveBooksMetric, target: number | null, actual: number | null): number | null {
  if (target === null || actual === null) return null
  if (target === 0 && /除权/.test(metric.scoreRule)) return null
  const rule = `${metric.dimension} ${metric.scoreRule}`
  const ratio = target === 0 ? null : actual / target
  let score: number | null = null
  if (/转化率目标|两项指标|以及|并且/.test(rule) && !/收缴率/.test(metric.dimension)) return null
  if (/收缴率/.test(rule) && /105%/.test(rule) && ratio !== null) {
    score = ratio >= 1.05 ? 1.2 : ratio >= 1 ? 1 : ratio >= (/85%/.test(rule) ? 0.85 : 0.8) ? ratio : 0
  } else if (/客户满意度|满意度目标/.test(rule)) {
    score = /1\.1分/.test(rule) && actual >= target * 1.1
      ? 1.1
      : actual >= target ? 1 : actual >= target - 2 ? 0.7 : actual >= target - 5 ? 0.3 : 0
  } else if (/服务监约得分/.test(rule)) {
    score = /目标值-2分/.test(rule)
      ? actual >= target ? 1 : actual >= target - 2 ? 0.7 : actual >= target - 5 ? 0.3 : 0
      : actual >= target ? 1 : actual >= target - 5 ? 0.8 : actual >= target - 10 ? 0.4 : 0
  } else if (/人事费用率|预算内|实际.*≤目标/.test(rule)) {
    score = actual <= target ? 1 : 0
  } else if (/被动离职率/.test(rule)) {
    score = actual >= target ? 1 : 0
  } else if (/工作完成：得1分|工作未完成：得0分/.test(rule)) {
    score = actual >= target ? 1 : 0
  } else if (ratio !== null) {
    const threshold = /＜75%|≥75%/.test(rule) ? 0.75 : /＜85%|≥85%/.test(rule) ? 0.85 : /＜80%|≥80%/.test(rule) ? 0.8 : 0
    score = ratio >= threshold ? ratio : 0
    score = Math.min(score, /取1\.0|取1分|大于1，取1/.test(rule) ? 1 : 1.2)
  }
  return score === null ? null : round(Math.max(0, Math.min(1.2, score)))
}

function automaticEffect(metric: FiveBooksMetric, target: number | null, actual: number | null): number | null {
  if (metric.kind === 'adjustment') return null
  if (actual === null) return null
  const rule = metric.scoreRule
  const fixedConditional = rule.match(/超目标值.*?(?:加|扣)(0\.\d+)分/)
  if (fixedConditional) {
    if (target === null) return null
    return actual > target ? Number(fixedConditional[1]) : 0
  }
  const perMatch = rule.match(/(?:每|一项|一起|任意事故).*?(?:加|\+|扣)(0\.\d+)分/)
    || rule.match(/(?:加|\+|扣)(0\.\d+)分/)
  if (!perMatch) return null
  const capMatch = rule.match(/上限(0\.\d+)分/)
  return round(Math.min(actual * Number(perMatch[1]), capMatch ? Number(capMatch[1]) : Number.POSITIVE_INFINITY))
}

export function calculateFiveBooksRecord(metric: FiveBooksMetric, record: FiveBooksInputRecord): FiveBooksCalculatedRecord {
  if (record.applicability !== 'applicable' || metric.kind === 'none') {
    return { ...record, calculatedScore: null, calculatedEffect: metric.kind === 'none' ? 0 : null }
  }
  if (metric.kind === 'base') {
    const automatic = automaticBaseScore(metric, record.targetValue, record.actualValue)
    const score = automatic ?? record.manualScore
    return { ...record, calculatedScore: score === null ? null : round(score), calculatedEffect: null }
  }
  if (metric.kind === 'manual') {
    return { ...record, calculatedScore: record.manualScore, calculatedEffect: null }
  }
  const automatic = automaticEffect(metric, record.targetValue, record.actualValue)
  const effect = automatic ?? record.effectValue
  if (effect !== null && metric.kind !== 'adjustment' && effect < 0) {
    throw new Error(metric.kind === 'addition' ? '加分项不得使用负数' : '扣分项不得使用负数')
  }
  return { ...record, calculatedScore: null, calculatedEffect: effect === null ? null : round(effect) }
}

export function summarizeFiveBooks(template: FiveBooksTemplate, records: FiveBooksCalculatedRecord[]) {
  const byId = new Map(records.map(item => [item.metricId, item]))
  let weighted = 0, validWeight = 0, addition = 0, deduction = 0, pending = 0
  for (const metric of template.metrics) {
    const record = byId.get(metric.id)
    if (!record || record.applicability === 'pending') { if (metric.kind !== 'none') pending += 1; continue }
    if (record.applicability === 'excluded' || metric.kind === 'none') continue
    if (metric.kind === 'base' || metric.kind === 'manual') {
      const weight = metric.kind === 'base' ? metric.weight : record.manualWeight
      if (record.calculatedScore === null || weight === null || weight <= 0) { pending += 1; continue }
      weighted += record.calculatedScore * weight
      validWeight += weight
    } else if (metric.kind === 'adjustment') {
      if (record.calculatedEffect === null) pending += 1
      else if (record.calculatedEffect >= 0) addition += record.calculatedEffect
      else deduction += Math.abs(record.calculatedEffect)
    } else if (metric.kind === 'addition') {
      if (record.calculatedEffect === null) pending += 1; else addition += record.calculatedEffect
    } else if (metric.kind === 'deduction') {
      if (record.calculatedEffect === null) pending += 1; else deduction += record.calculatedEffect
    }
  }
  const base = validWeight > 0 ? weighted / validWeight : null
  return { complete: pending === 0 && base !== null, pending, base, total: base === null ? null : round(Math.min(1.2, base + addition - deduction)) }
}
