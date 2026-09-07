import { normalizeCollectionCenter } from './collection-quality.js'
import type { CollectionPublication } from './collection-publication.js'
import { getCollectionDisplayRate, isHeatingAdjustedCollectionCenter } from './collection-scope.js'
import { calculateGrowth, readOptionalNumber } from './production-safety.js'

export const OFFICIAL_COLLECTION_ATTENTION_THRESHOLD = 0.8

export type ServiceCenterEvidence = {
  source: string
  businessDate: string | null
  lastValidatedAt: string | null
  methodology: string
  rule: string
}

export type ServiceCenterPaymentRow = {
  id: number
  area: string
  center: string
  annual_budget?: number | null
  cumulative_budget?: number | null
  cumulative_executed?: number | null
  same_period?: number | null
}

export type ServiceCenterDailyRow = {
  center: string
  annual_budget?: number | null
  cumulative_budget?: number | null
  cumulative_executed?: number | null
  daily_collection?: number | null
  source?: string | null
  business_date?: string | null
  date?: string | null
  last_validated_at?: string | null
}

export type FormalCollectionRow = {
  center?: string | null
  canonicalCenter?: string | null
  collectionRate?: number | null
  gatheringCurrentYearRecedRate?: number | null
  receivable?: number | null
  received?: number | null
  source?: string | null
  businessDate?: string | null
  business_date?: string | null
  date?: string | null
  lastValidatedAt?: string | null
  last_validated_at?: string | null
}

export type PaymentPublicationMeta = {
  publicationStatus: 'partial' | 'unpublished' | 'blocked'
  businessDate: string | null
  lastValidatedAt: string | null
  source: string
}

export type ServiceCenterSignal = {
  code: 'cumulative-budget-gap' | 'yoy-decline' | 'official-collection-below-threshold'
  severity: 'attention'
  message: string
  value: number
  threshold: number | null
  evidence: ServiceCenterEvidence
}

export type ServiceCenterAnalysisRow = {
  id: number
  center: string
  normalizedCenter: string
  area: string
  operatingStatus: 'stable' | 'attention' | 'insufficient'
  dataStatus: 'complete' | 'partial' | 'missing'
  analysis: string
  recommendations: string[]
  metrics: {
    annualBudget: number | null
    cumulativeBudget: number | null
    cumulativeExecuted: number | null
    cumulativeBudgetGap: number | null
    samePeriod: number | null
    yoyGrowth: number | null
    officialCollectionRate: number | null
    dailyCollection: number | null
  }
  availability: {
    payment: 'available' | 'partial' | 'missing'
    daily: 'available' | 'missing'
    officialCollection: 'available' | 'missing'
  }
  signals: ServiceCenterSignal[]
  evidence: {
    payment: ServiceCenterEvidence
    daily: ServiceCenterEvidence | null
    officialCollection: ServiceCenterEvidence | null
  }
}

export type ServiceCenterAnalysis = {
  businessDate: string | null
  publicationStatus: PaymentPublicationMeta['publicationStatus']
  collectionPublicationStatus: CollectionPublication['publicationStatus']
  scope: { areas: string[] | null; total: number }
  credibility: {
    status: 'partial' | 'blocked'
    payment: 'verified' | 'unavailable'
    daily: 'verified' | 'unavailable'
    officialCollection: CollectionPublication['publicationStatus']
    note: string
  }
  coverage: { paymentCenters: number; dailyCenters: number; officialCollectionCenters: number }
  thresholds: { officialCollectionRate: number }
  summary: {
    total: number
    stable: number
    attention: number
    insufficient: number
    dataComplete: number
    dataIncomplete: number
    dataPartial: number
    dataMissing: number
  }
  rows: ServiceCenterAnalysisRow[]
}

type BuildInput = {
  payments: ServiceCenterPaymentRow[]
  latestDailyRows: ServiceCenterDailyRow[]
  dailyBusinessDate: string | null
  formalCollectionRows: FormalCollectionRow[]
  collectionPublication: CollectionPublication
  paymentPublication: PaymentPublicationMeta
  allowedAreas: string[] | null
}

function normalizedRate(value: unknown): number | null {
  const parsed = readOptionalNumber(value)
  if (parsed === null || parsed < 0) return null
  if (parsed <= 1) return parsed
  return parsed <= 100 ? parsed / 100 : null
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return null
}

function paymentEvidence(meta: PaymentPublicationMeta, daily?: ServiceCenterDailyRow | null): ServiceCenterEvidence {
  const hasVerifiedDaily = Boolean(daily)
  return {
    source: firstText(daily?.source, meta.source) || 'APH回款执行数据集',
    businessDate: hasVerifiedDaily ? firstText(daily?.business_date, daily?.date, meta.businessDate) : meta.businessDate,
    lastValidatedAt: hasVerifiedDaily ? firstText(daily?.last_validated_at, meta.lastValidatedAt) : meta.lastValidatedAt,
    methodology: hasVerifiedDaily
      ? '以payment_centers授权全集为主表，合并最新quality_status=verified中心快照'
      : '以payment_centers授权全集为分析主表',
    rule: '每个服务中心仅输出一次；保留已验证0和负数；缺失值不补0',
  }
}

function dailyEvidence(row: ServiceCenterDailyRow, fallbackDate: string | null): ServiceCenterEvidence {
  return {
    source: firstText(row.source) || 'FineReport已验证每日回款快照',
    businessDate: firstText(row.business_date, row.date, fallbackDate),
    lastValidatedAt: firstText(row.last_validated_at),
    methodology: '最新quality_status=verified日快照的daily_collection官方字段',
    rule: '只使用全局最新业务日期的已验证日快照；中心缺失时不回退旧日期、不补0',
  }
}

function collectionEvidence(row: FormalCollectionRow, publication: CollectionPublication): ServiceCenterEvidence {
  const correction = publication.periodCorrection || {}
  const center = row.canonicalCenter || row.center
  const heatingAdjusted = isHeatingAdjustedCollectionCenter(center)
  return {
    source: firstText(row.source, publication.source) || '绿仔正式收缴数据集',
    businessDate: firstText(row.businessDate, row.business_date, row.date, publication.businessDate),
    lastValidatedAt: firstText(row.lastValidatedAt, row.last_validated_at, publication.lastValidatedAt),
    methodology: heatingAdjusted
      ? 'heating-adjusted-received-over-receivable'
      : publication.methodologyVersion || 'gatheringCurrentYearRecedRate官方字段',
    rule: heatingAdjusted
      ? '供暖项目按已验收缴页口径：供暖期间金额修正后实收÷应收'
      : firstText(correction.rule, correction.rateAggregation)
        || '仅使用已发布正式数据集的官方收缴率；不用实收除以应收反算',
  }
}

function collectionRate(row: FormalCollectionRow): number | null {
  const officialRate = normalizedRate(row.collectionRate ?? row.gatheringCurrentYearRecedRate)
  if (!isHeatingAdjustedCollectionCenter(row.canonicalCenter || row.center)) return officialRate
  const rate = getCollectionDisplayRate(
    row.canonicalCenter || row.center,
    readOptionalNumber(row.receivable),
    readOptionalNumber(row.received),
    officialRate,
  )
  return normalizedRate(rate)
}

function matchFormalRows(rows: FormalCollectionRow[]) {
  const map = new Map<string, FormalCollectionRow[]>()
  for (const row of rows) {
    const keys = [...new Set([row.canonicalCenter, row.center].map(normalizeCollectionCenter).filter(Boolean))]
    for (const key of keys) {
      const found = map.get(key) || []
      if (!found.includes(row)) found.push(row)
      map.set(key, found)
    }
  }
  return map
}

function selectFormalRow(rows: FormalCollectionRow[] | undefined): FormalCollectionRow | null {
  if (!rows?.length) return null
  const usable = rows.filter(row => collectionRate(row) !== null)
  if (usable.length === 1) return usable[0]
  if (usable.length > 1) {
    const firstRate = collectionRate(usable[0])
    if (usable.every(row => collectionRate(row) === firstRate)) return usable[0]
  }
  // 同一规范名下若官方率冲突，宁可保留缺失也不自行选值。
  return null
}

function recommendationForSignal(signal: ServiceCenterSignal): string {
  if (signal.code === 'cumulative-budget-gap') return '核对累计预算节点与回款明细，确认差额对应的未执行事项。'
  if (signal.code === 'yoy-decline') return '复核同期口径与当期回款节奏，定位同比下降的具体明细。'
  return '按正式收缴明细定位欠费对象和金额，优先复核低于80%阈值的原始证据。'
}

export function buildServiceCenterAnalysis(input: BuildInput): ServiceCenterAnalysis {
  const formalByName = matchFormalRows(input.formalCollectionRows)
  const dailyByName = new Map<string, ServiceCenterDailyRow>()
  for (const row of input.latestDailyRows) {
    const key = normalizeCollectionCenter(row.center)
    if (key && !dailyByName.has(key)) dailyByName.set(key, row)
  }

  const uniquePayments = new Map<string, ServiceCenterPaymentRow>()
  for (const payment of input.payments) {
    const key = normalizeCollectionCenter(payment.center)
    if (key && !uniquePayments.has(key)) uniquePayments.set(key, payment)
  }

  const rows = [...uniquePayments.entries()].map(([normalizedCenter, payment]): ServiceCenterAnalysisRow => {
    const daily = dailyByName.get(normalizedCenter) || null
    const annualBudget = readOptionalNumber(daily?.annual_budget ?? payment.annual_budget)
    const cumulativeBudget = readOptionalNumber(daily?.cumulative_budget ?? payment.cumulative_budget)
    const cumulativeExecuted = readOptionalNumber(daily?.cumulative_executed ?? payment.cumulative_executed)
    const samePeriod = readOptionalNumber(payment.same_period)
    const cumulativeBudgetGap = cumulativeBudget === null || cumulativeExecuted === null
      ? null
      : cumulativeExecuted - cumulativeBudget
    const yoyGrowth = calculateGrowth(cumulativeExecuted, samePeriod)

    const paymentSource = paymentEvidence(input.paymentPublication, daily)
    const dailyCollection = daily ? readOptionalNumber(daily.daily_collection) : null
    const dailySource = daily && dailyCollection !== null ? dailyEvidence(daily, input.dailyBusinessDate) : null

    const formal = input.collectionPublication.publicationStatus === 'published'
      ? selectFormalRow(formalByName.get(normalizedCenter))
      : null
    const officialCollectionRate = formal ? collectionRate(formal) : null
    const officialCollectionSource = formal && officialCollectionRate !== null
      ? collectionEvidence(formal, input.collectionPublication)
      : null

    const paymentValues = [annualBudget, cumulativeBudget, cumulativeExecuted]
    const paymentAvailableCount = paymentValues.filter(value => value !== null).length
    const paymentAvailability = paymentAvailableCount === paymentValues.length
      ? 'available' as const
      : paymentAvailableCount === 0 ? 'missing' as const : 'partial' as const
    const dailyAvailability = dailyCollection === null ? 'missing' as const : 'available' as const
    const officialCollectionAvailability = officialCollectionRate === null ? 'missing' as const : 'available' as const
    const dataStatus = paymentAvailability === 'missing'
      ? 'missing' as const
      : paymentAvailability === 'available' && dailyAvailability === 'available' && officialCollectionAvailability === 'available'
        ? 'complete' as const
        : 'partial' as const

    const signals: ServiceCenterSignal[] = []
    if (cumulativeBudgetGap !== null && cumulativeBudgetGap < 0) {
      signals.push({
        code: 'cumulative-budget-gap', severity: 'attention',
        message: `累计执行较累计预算落后${Math.abs(cumulativeBudgetGap).toFixed(2)}万元`,
        value: cumulativeBudgetGap, threshold: 0, evidence: paymentSource,
      })
    }
    if (yoyGrowth !== null && yoyGrowth < 0) {
      signals.push({
        code: 'yoy-decline', severity: 'attention',
        message: `累计执行同比下降${Math.abs(yoyGrowth * 100).toFixed(2)}%`,
        value: yoyGrowth, threshold: 0, evidence: paymentSource,
      })
    }
    if (officialCollectionRate !== null && officialCollectionRate < OFFICIAL_COLLECTION_ATTENTION_THRESHOLD && officialCollectionSource) {
      signals.push({
        code: 'official-collection-below-threshold', severity: 'attention',
        message: `官方收缴率${(officialCollectionRate * 100).toFixed(2)}%，低于80%关注阈值`,
        value: officialCollectionRate, threshold: OFFICIAL_COLLECTION_ATTENTION_THRESHOLD,
        evidence: officialCollectionSource,
      })
    }

    const assessedMetricCount = [cumulativeBudgetGap, yoyGrowth, officialCollectionRate].filter(value => value !== null).length
    const operatingStatus = signals.length ? 'attention' as const : assessedMetricCount ? 'stable' as const : 'insufficient' as const
    const recommendations = [...new Set(signals.map(recommendationForSignal))]
    if (dailyAvailability === 'missing') recommendations.push('补齐并验证该中心最新每日回款快照；在此之前保持为数据缺失，不记为0。')
    if (officialCollectionAvailability === 'missing') recommendations.push('补齐该中心与已发布正式收缴数据集的规范名映射；未通过发布门禁前不形成收缴结论。')

    const analysis = operatingStatus === 'attention'
      ? `${payment.center}需关注：${signals.map(signal => signal.message).join('；')}。`
      : operatingStatus === 'stable'
        ? `${payment.center}当前可用的已验证指标未触发经营关注规则${dataStatus === 'complete' ? '。' : '；仍有数据待补齐。'}`
        : `${payment.center}可用经营指标不足，暂不形成经营结论。`

    return {
      id: payment.id,
      center: payment.center,
      normalizedCenter,
      area: payment.area,
      operatingStatus,
      dataStatus,
      analysis,
      recommendations,
      metrics: {
        annualBudget, cumulativeBudget, cumulativeExecuted, cumulativeBudgetGap,
        samePeriod, yoyGrowth, officialCollectionRate, dailyCollection,
      },
      availability: {
        payment: paymentAvailability,
        daily: dailyAvailability,
        officialCollection: officialCollectionAvailability,
      },
      signals,
      evidence: { payment: paymentSource, daily: dailySource, officialCollection: officialCollectionSource },
    }
  }).sort((left, right) => {
    const statusOrder = { attention: 0, insufficient: 1, stable: 2 }
    return statusOrder[left.operatingStatus] - statusOrder[right.operatingStatus]
      || left.area.localeCompare(right.area, 'zh-CN')
      || left.center.localeCompare(right.center, 'zh-CN')
  })

  return {
    businessDate: input.dailyBusinessDate || input.paymentPublication.businessDate || input.collectionPublication.businessDate,
    publicationStatus: input.paymentPublication.publicationStatus,
    collectionPublicationStatus: input.collectionPublication.publicationStatus,
    scope: { areas: input.allowedAreas, total: rows.length },
    credibility: {
      status: rows.length ? 'partial' : 'blocked',
      payment: input.paymentPublication.businessDate ? 'verified' : 'unavailable',
      daily: input.dailyBusinessDate ? 'verified' : 'unavailable',
      officialCollection: input.collectionPublication.publicationStatus,
      note: rows.length
        ? '回款指标以最新已验证FineReport日快照作为批次证据，收缴率仅使用已发布正式数据集；两条来源链独立，整体审计状态为partial。'
        : '授权范围内无APH回款中心，无法形成经营分析。',
    },
    coverage: {
      paymentCenters: rows.length,
      dailyCenters: rows.filter(row => row.availability.daily === 'available').length,
      officialCollectionCenters: rows.filter(row => row.availability.officialCollection === 'available').length,
    },
    thresholds: { officialCollectionRate: OFFICIAL_COLLECTION_ATTENTION_THRESHOLD },
    summary: {
      total: rows.length,
      stable: rows.filter(row => row.operatingStatus === 'stable').length,
      attention: rows.filter(row => row.operatingStatus === 'attention').length,
      insufficient: rows.filter(row => row.operatingStatus === 'insufficient').length,
      dataComplete: rows.filter(row => row.dataStatus === 'complete').length,
      dataIncomplete: rows.filter(row => row.dataStatus !== 'complete').length,
      dataPartial: rows.filter(row => row.dataStatus === 'partial').length,
      dataMissing: rows.filter(row => row.dataStatus === 'missing').length,
    },
    rows,
  }
}
