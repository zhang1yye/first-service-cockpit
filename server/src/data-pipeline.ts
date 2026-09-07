import {
  COLLECTION_MAX_AGE_HOURS,
  evaluateCollectionTimestamp,
  OFFICIAL_COLLECTION_CENTER_COUNT,
  normalizeCollectionCenter,
} from './collection-quality.js'
import { evaluateBusinessDate } from './business-date.js'
import { isDeepStrictEqual } from 'node:util'

type NullableNumber = number | null

type PaymentRow = {
  area: string
  center: string
  annual_budget: number
  cumulative_budget: number
  cumulative_executed: number
  same_period: NullableNumber
  collection_rate: NullableNumber
}

export function evaluatePaymentSamePeriodCompleteness(
  rows: Array<Pick<PaymentRow, 'center' | 'same_period'>>,
): string[] {
  if (!Array.isArray(rows) || rows.length === 0) return ['未找到服务中心同期证据，禁止正式发布']
  const missing = rows.filter(row => !finite(row?.same_period))
  if (!missing.length) return []
  const names = missing.map(row => row?.center).filter(Boolean).slice(0, 8).join('、')
  return [`有${missing.length}个服务中心同期缺失或非数值，禁止正式发布${names ? `：${names}` : ''}`]
}

type DailyRow = {
  date: string
  center: string
  annual_budget: number
  cumulative_budget: number
  cumulative_executed: number
  daily_collection: NullableNumber
  quality_status?: string
  quality_reason?: string
  source?: string
  source_status?: string
  business_date?: string
  last_validated_at?: string
  field_provenance?: string | Record<string, unknown>
}

type SourceLayer = {
  source?: string
  businessDate?: string
  values?: Record<string, unknown>
}

export type CollectionRow = {
  area: string
  center: string
  receivable: number
  received: number
  outstanding?: NullableNumber
  collectionRate?: NullableNumber
}

export type NormalizedBundle = {
  schema_version: number
  business_date: string
  extracted_at: string
  source_status?: string
  last_validated_at?: string
  field_provenance?: Record<string, unknown>
  source_layers?: Record<string, SourceLayer>
  reconciliations?: Record<string, unknown>
  sources?: Array<{ key: string; name: string; size: number; sha256: string }>
  payment_centers: PaymentRow[]
  daily_snapshots: DailyRow[]
  collection_centers: CollectionRow[]
  collection_summary: Record<string, unknown>
  lvzai?: {
    raw_rows: number
    source_regions: number
    mapped_regions: number
    canonical_centers: number
    unmapped_centers: string[]
    outside_current_scope?: Array<{ region_id: string; community: string; green_center: string; reason: string }>
  }
}

const fields = ['area', 'annual_budget', 'cumulative_budget', 'cumulative_executed', 'same_period', 'collection_rate'] as const
const requiredProvenance = ['年度预算_万', '累计预算_万', '累计执行_万', '同期执行_万', '增幅']
// 六源采集是串行完成的：允许同一批次内最多5分钟的真实采集时间差；
// FineReport落库到秒，而APH保留微秒，因此只对这类精度差允许1秒。
export const P46_SOURCE_CAPTURE_WINDOW_MS = 5 * 60 * 1000
export const P46_TIMESTAMP_PRECISION_TOLERANCE_MS = 1000
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nullableFinite = (value: unknown) => value === null || finite(value)
const round = (value: number) => Math.round(value * 100) / 100
const same = (left: unknown, right: unknown) => {
  if (left === null || left === undefined || right === null || right === undefined) return left == null && right == null
  return finite(left) && finite(right) ? Math.abs(left - right) < 0.005 : String(left) === String(right)
}
const object = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function collectionFactValue(row: Record<string, unknown>, field: 'receivable' | 'received' | 'outstanding' | 'collectionRate') {
  const value = row[field]
  return finite(value) ? value : null
}

export function deriveCollectionRowsFromArchive(detailPayload: unknown): CollectionRow[] {
  const detail = object(detailPayload) ? detailPayload : null
  const rows = Array.isArray(detailPayload) ? detailPayload : detail?.rows
  if (!Array.isArray(rows) || !rows.every(object)) throw new Error('归档绿仔明细必须包含记录数组')
  return rows as CollectionRow[]
}

export function evaluateCollectionArchiveConsistency(
  bundle: Pick<NormalizedBundle, 'business_date' | 'extracted_at' | 'collection_centers' | 'collection_summary'>,
  detailPayload: unknown,
  summaryPayload: unknown,
): string[] {
  const errors: string[] = []
  const detail = object(detailPayload) ? detailPayload : null
  const summary = object(summaryPayload) ? summaryPayload : null
  let detailRows: CollectionRow[] = []
  try { detailRows = deriveCollectionRowsFromArchive(detailPayload) } catch { errors.push('归档绿仔明细必须包含记录数组') }
  if (!summary) errors.push('归档绿仔汇总必须是对象')
  if (errors.length) return errors

  const normalizedRows = Array.isArray(bundle.collection_centers) ? bundle.collection_centers : []
  const actualRows = detailRows as Record<string, unknown>[]
  const normalizedByKey = new Map<string, Record<string, unknown>>()
  const actualByKey = new Map<string, Record<string, unknown>>()
  const addRows = (rows: Record<string, unknown>[], target: Map<string, Record<string, unknown>>, label: string) => {
    for (const row of rows) {
      const key = normalizeCollectionCenter(row.center)
      if (!key) { errors.push(`${label}存在空服务中心规范键`); continue }
      if (target.has(key)) { errors.push(`${label}存在重复服务中心规范键：${key}`); continue }
      target.set(key, row)
    }
  }
  addRows(normalizedRows as unknown as Record<string, unknown>[], normalizedByKey, '规范化包绿仔明细')
  addRows(actualRows, actualByKey, '归档绿仔明细')
  if (normalizedByKey.size !== actualByKey.size || [...normalizedByKey.keys()].some(key => !actualByKey.has(key))) {
    errors.push('归档绿仔明细服务中心规范键集合与规范化包不一致')
  }
  for (const [key, normalized] of normalizedByKey) {
    const actual = actualByKey.get(key)
    if (!actual) continue
    if (typeof normalized.area !== 'string' || typeof actual.area !== 'string' || normalized.area !== actual.area) {
      errors.push(`归档绿仔明细${key}.area与规范化包不一致`)
    }
    for (const field of ['receivable', 'received', 'outstanding', 'collectionRate'] as const) {
      const normalizedValue = collectionFactValue(normalized, field)
      const actualValue = collectionFactValue(actual, field)
      if (normalizedValue === null || actualValue === null || Math.abs(normalizedValue - actualValue) > 0.000001) {
        errors.push(`归档绿仔明细${key}.${field}与规范化包不一致`)
      }
    }
  }

  const detailDate = String(detail?.date || detail?.businessDate || '').slice(0, 10)
  const summaryDate = String(summary?.date || summary?.businessDate || '').slice(0, 10)
  if (detailDate !== bundle.business_date) errors.push('归档绿仔明细业务日期与规范化包不一致')
  if (summaryDate !== bundle.business_date) errors.push('归档绿仔汇总业务日期与规范化包不一致')
  const batchExtracted = evaluateCollectionTimestamp(bundle.extracted_at, '规范化包提取时间')
  const detailExtracted = evaluateCollectionTimestamp(detail?.extractedAt, '归档绿仔明细提取时间')
  const summaryExtracted = evaluateCollectionTimestamp(summary?.extractedAt, '归档绿仔汇总提取时间')
  errors.push(...batchExtracted.reasons, ...detailExtracted.reasons, ...summaryExtracted.reasons)
  if (Number.isFinite(detailExtracted.ms) && Number.isFinite(summaryExtracted.ms)
    && detailExtracted.ms !== summaryExtracted.ms) {
    errors.push('归档绿仔明细与汇总提取时间不一致')
  }
  for (const [label, timestamp] of [
    ['归档绿仔明细', detailExtracted],
    ['归档绿仔汇总', summaryExtracted],
  ] as const) {
    if (Number.isFinite(batchExtracted.ms) && Number.isFinite(timestamp.ms)
      && Math.abs(timestamp.ms - batchExtracted.ms) > P46_SOURCE_CAPTURE_WINDOW_MS) {
      errors.push(`${label}提取时间与规范化包超过5分钟同批采集窗口`)
    }
  }

  const normalizedSummary = object(bundle.collection_summary) ? bundle.collection_summary : {}
  for (const field of ['collectionRate', 'receivable_万', 'received_万', 'outstanding_万'] as const) {
    const normalizedValue = normalizedSummary[field]
    const actualValue = summary![field]
    if (normalizedValue === undefined && actualValue === undefined) continue
    if (!finite(normalizedValue) || !finite(actualValue) || Math.abs(normalizedValue - actualValue) > 0.000001) {
      errors.push(`归档绿仔汇总${field}与规范化包不一致`)
    }
  }
  if (!isDeepStrictEqual(normalizedSummary.periodCorrection, summary!.periodCorrection)) {
    errors.push('归档绿仔汇总修正证据与规范化包不一致')
  }
  if (detail?.periodCorrection !== undefined && !isDeepStrictEqual(detail.periodCorrection, normalizedSummary.periodCorrection)) {
    errors.push('归档绿仔明细修正证据与规范化包不一致')
  }
  return [...new Set(errors)]
}

type CenterRow = { center?: unknown }

function groupedCenters(rows: CenterRow[]) {
  const byKey = new Map<string, string[]>()
  const emptyValues: string[] = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const raw = String(row?.center ?? '')
    const key = normalizeCollectionCenter(raw)
    if (!key) {
      emptyValues.push(raw)
      continue
    }
    const values = byKey.get(key) || []
    values.push(raw)
    byKey.set(key, values)
  }
  return { byKey, emptyValues }
}

function originalValues(groups: Map<string, string[]>, keys: string[]) {
  return keys.flatMap(key => groups.get(key) || []).map(value => JSON.stringify(value)).join('、')
}

/**
 * APH payment 与 FineReport daily 共用的中心身份门禁。
 * 规范键只用于暴露重复和核对集合，不会自动合并或改写任何来源行。
 */
export function evaluateAphCenterCoverage(paymentRows: CenterRow[], dailyRows: CenterRow[]) {
  const payment = groupedCenters(paymentRows)
  const daily = groupedCenters(dailyRows)
  const errors: string[] = []
  const paymentDuplicateKeys = [...payment.byKey].filter(([, values]) => values.length > 1).map(([key]) => key)
  const dailyDuplicateKeys = [...daily.byKey].filter(([, values]) => values.length > 1).map(([key]) => key)
  if (!paymentRows.length) errors.push('服务中心规范集合为空')
  if (!dailyRows.length) errors.push('日快照中心规范集合为空')
  if (payment.emptyValues.length) errors.push(`服务中心存在${payment.emptyValues.length}条空规范键，原值：${payment.emptyValues.map(value => JSON.stringify(value)).join('、')}`)
  if (daily.emptyValues.length) errors.push(`日快照中心存在${daily.emptyValues.length}条空规范键，原值：${daily.emptyValues.map(value => JSON.stringify(value)).join('、')}`)
  if (paymentDuplicateKeys.length) errors.push(`服务中心规范键重复，冲突原值：${originalValues(payment.byKey, paymentDuplicateKeys)}`)
  if (dailyDuplicateKeys.length) errors.push(`日快照中心规范键重复，冲突原值：${originalValues(daily.byKey, dailyDuplicateKeys)}`)
  const onlyPayment = [...payment.byKey.keys()].filter(key => !daily.byKey.has(key))
  const onlyDaily = [...daily.byKey.keys()].filter(key => !payment.byKey.has(key))
  if (onlyPayment.length || onlyDaily.length) {
    errors.push(`服务中心与日快照规范中心集合不一致：仅服务中心=${originalValues(payment.byKey, onlyPayment) || '无'}；仅日快照=${originalValues(daily.byKey, onlyDaily) || '无'}`)
  }
  const paymentRowCount = Array.isArray(paymentRows) ? paymentRows.length : 0
  const dailyRowCount = Array.isArray(dailyRows) ? dailyRows.length : 0
  const paymentUniqueCount = payment.byKey.size
  const dailyUniqueCount = daily.byKey.size
  return {
    valid: errors.length === 0
      && paymentRowCount === paymentUniqueCount
      && dailyRowCount === dailyUniqueCount
      && paymentUniqueCount === dailyUniqueCount,
    errors,
    paymentRowCount,
    paymentUniqueCount,
    dailyRowCount,
    dailyUniqueCount,
  }
}

export function evaluateDailyCrossFieldReview(
  current: Array<Pick<PaymentRow, 'center' | 'cumulative_executed'>>,
  dailyRows: Array<Pick<DailyRow, 'center' | 'cumulative_executed' | 'daily_collection'>>,
): {
  errors: string[]
  warnings: string[]
  review: {
    status: 'not_applicable' | 'available' | 'pending_review' | 'blocked'
    reason: string | null
    cumulativeChange: number | null
    officialDailyTotal: number | null
    baselineBatchId: number | null
  }
} {
  const previousByCenter = new Map((Array.isArray(current) ? current : [])
    .filter(row => row?.center && finite(row.cumulative_executed))
    .map(row => [row.center, row.cumulative_executed]))
  if (!previousByCenter.size) return {
    errors: [], warnings: [],
    review: { status: 'not_applicable', reason: null, cumulativeChange: null, officialDailyTotal: null, baselineBatchId: null },
  }

  const validDailyRows = (Array.isArray(dailyRows) ? dailyRows : []).filter(row =>
    row?.center && finite(row.cumulative_executed))
  const dailyCenters = new Set(validDailyRows.map(row => row.center))
  const onlyPrevious = [...previousByCenter.keys()].filter(center => !dailyCenters.has(center))
  const onlyDaily = [...dailyCenters].filter(center => !previousByCenter.has(center))
  const coverageErrors = onlyPrevious.length || onlyDaily.length
    ? [`日回款跨字段矛盾：上一可信日与当前日快照中心集合不一致，禁止正式发布（仅上一日=${onlyPrevious.slice(0, 5).join('、') || '无'}；仅当前=${onlyDaily.slice(0, 5).join('、') || '无'}）`]
    : []

  const comparable = validDailyRows.filter(row => previousByCenter.has(row.center))
  const centerMovements = comparable.map(row => round(row.cumulative_executed - previousByCenter.get(row.center)!))
    .filter(change => Math.abs(change) >= 0.005)
  const cumulativeChange = coverageErrors.length
    ? round(validDailyRows.reduce((total, row) => total + row.cumulative_executed, 0)
      - [...previousByCenter.values()].reduce((total, value) => total + value, 0))
    : round(centerMovements.reduce((total, change) => total + change, 0))
  if (Math.abs(cumulativeChange) < 0.005 && !centerMovements.length) return {
    errors: coverageErrors,
    warnings: [],
    review: {
      status: coverageErrors.length ? 'blocked' : 'available', reason: coverageErrors[0] || null,
      cumulativeChange, officialDailyTotal: 0, baselineBatchId: null,
    },
  }

  const movementDescription = Math.abs(cumulativeChange) >= 0.005
    ? `累计执行变动${cumulativeChange}万元`
    : `${centerMovements.length}个中心累计执行发生对冲变动`

  const dailyValues = dailyRows.map(row => row.daily_collection)
  const finiteDailyValues = dailyValues.filter(finite)
  if (!finiteDailyValues.length) {
    const reason = `日回款待次日复核：${movementDescription}，但官方日回款全缺失；保留两源原值，未用累计差替代本日回款`
    return {
      errors: coverageErrors,
      warnings: [reason],
      review: { status: coverageErrors.length ? 'blocked' : 'pending_review', reason, cumulativeChange, officialDailyTotal: null, baselineBatchId: null },
    }
  }
  if (finiteDailyValues.length !== dailyValues.length) {
    const reason = `日回款待次日复核：${movementDescription}，但官方日回款存在缺失；保留两源原值，未用累计差替代本日回款`
    return {
      errors: coverageErrors,
      warnings: [reason],
      review: { status: coverageErrors.length ? 'blocked' : 'pending_review', reason, cumulativeChange, officialDailyTotal: null, baselineBatchId: null },
    }
  }

  const dailyTotal = round(finiteDailyValues.reduce((total, value) => total + value, 0))
  if (Math.abs(dailyTotal) < 0.005) {
    const reason = `日回款待次日复核：${movementDescription}，但官方日回款全为0；保留两源原值，未用累计差替代本日回款`
    return {
      errors: coverageErrors,
      warnings: [reason],
      review: { status: coverageErrors.length ? 'blocked' : 'pending_review', reason, cumulativeChange, officialDailyTotal: dailyTotal, baselineBatchId: null },
    }
  }
  if (Math.abs(dailyTotal - cumulativeChange) > 0.01) {
    const reason = `日回款待次日复核：${movementDescription}与官方日回款${dailyTotal}万元不勾稽；保留两源原值，未用累计差替代本日回款`
    return {
      errors: coverageErrors,
      warnings: [reason],
      review: { status: coverageErrors.length ? 'blocked' : 'pending_review', reason, cumulativeChange, officialDailyTotal: dailyTotal, baselineBatchId: null },
    }
  }
  return {
    errors: coverageErrors,
    warnings: [],
    review: {
      status: coverageErrors.length ? 'blocked' : 'available', reason: coverageErrors[0] || null,
      cumulativeChange, officialDailyTotal: dailyTotal, baselineBatchId: null,
    },
  }
}
export function evaluateScopedDailyCrossFieldReview(
  current: Array<Pick<PaymentRow, 'center' | 'cumulative_executed'>>,
  daily: DailyRow[],
  allowedCenters: ReadonlySet<string> | null,
) {
  if (!allowedCenters) return evaluateDailyCrossFieldReview(current, daily)
  return evaluateDailyCrossFieldReview(
    current.filter(row => allowedCenters.has(row.center)),
    daily.filter(row => allowedCenters.has(row.center)),
  )
}

export function evaluateDailyCrossFieldConsistency(
  current: Array<Pick<PaymentRow, 'center' | 'cumulative_executed'>>,
  dailyRows: Array<Pick<DailyRow, 'center' | 'cumulative_executed' | 'daily_collection'>>,
): string[] {
  const review = evaluateDailyCrossFieldReview(current, dailyRows)
  return [...review.errors, ...review.warnings]
}

function parsedProvenance(value: DailyRow['field_provenance']) {
  if (object(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return object(parsed) ? parsed : null
  } catch {
    return null
  }
}

function reconciliation(leftSource: string, leftValue: unknown, rightSource: string, rightValue: unknown) {
  if (!finite(leftValue) || !finite(rightValue)) {
    return { leftSource, leftValue: finite(leftValue) ? leftValue : null, rightSource, rightValue: finite(rightValue) ? rightValue : null, difference: null, differenceRate: null, status: 'unavailable' }
  }
  const difference = round(rightValue - leftValue)
  const differenceRate = leftValue === 0 ? null : Math.round(Math.abs(difference / leftValue) * 1_000_000) / 1_000_000
  return { leftSource, leftValue, rightSource, rightValue, difference, differenceRate, status: differenceRate !== null && differenceRate <= 0.01 ? 'matched' : 'warning' }
}

export function evaluateP46Timestamps(
  bundle: Pick<NormalizedBundle, 'extracted_at' | 'last_validated_at'>,
  dailyRows: Array<Pick<DailyRow, 'center' | 'last_validated_at'>>,
  nowMs = Date.now(),
): string[] {
  const evaluateP46Timestamp = (value: unknown, label: string) => {
    const result = evaluateCollectionTimestamp(value, label, nowMs)
    if (Number.isFinite(result.ms) && nowMs - result.ms > COLLECTION_MAX_AGE_HOURS * 60 * 60 * 1000) {
      result.reasons.push(`${label}超过${COLLECTION_MAX_AGE_HOURS}小时`)
    }
    return result
  }
  const extracted = evaluateP46Timestamp(bundle?.extracted_at, 'APH提取时间')
  const validated = evaluateP46Timestamp(bundle?.last_validated_at, 'APH验证时间')
  const reasons = [...extracted.reasons, ...validated.reasons]
  if (Number.isFinite(extracted.ms) && Number.isFinite(validated.ms) && validated.ms < extracted.ms) {
    reasons.push('APH验证时间早于提取时间')
  }
  for (const row of Array.isArray(dailyRows) ? dailyRows : []) {
    const label = `日快照${row?.center ? `(${row.center})` : ''}验证时间`
    const dailyValidated = evaluateP46Timestamp(row?.last_validated_at, label)
    reasons.push(...dailyValidated.reasons)
    if (Number.isFinite(extracted.ms) && Number.isFinite(dailyValidated.ms)
      && dailyValidated.ms + P46_TIMESTAMP_PRECISION_TOLERANCE_MS < extracted.ms) {
      reasons.push(`${label}早于APH提取时间`)
    }
  }
  return reasons
}

export function analyzeNormalizedBundle(
  bundle: NormalizedBundle,
  current: PaymentRow[],
  options: {
    minimumCenters?: number
    nowMs?: number
    businessDateFutureToleranceDays?: number
    dailyComparisonBaseline?: Array<Pick<PaymentRow, 'center' | 'cumulative_executed'>>
  } = {},
) {
  const minimumCenters = options.minimumCenters ?? 40
  const errors: string[] = []
  const warnings: string[] = []
  const rows = Array.isArray(bundle?.payment_centers) ? bundle.payment_centers : []
  const daily = Array.isArray(bundle?.daily_snapshots) ? bundle.daily_snapshots : []
  const collectionRows = Array.isArray(bundle?.collection_centers) ? bundle.collection_centers : []

  if (bundle?.schema_version !== 2) errors.push('不支持的规范化数据版本')
  const businessDate = evaluateBusinessDate(bundle?.business_date, '业务日期', options.nowMs, {
    futureToleranceDays: options.businessDateFutureToleranceDays,
  })
  errors.push(...businessDate.reasons)
  if (bundle?.source_status !== 'available') errors.push('APH/FineReport来源状态不可用')
  errors.push(...evaluateP46Timestamps(bundle, daily, options.nowMs))
  if (!object(bundle?.field_provenance) || requiredProvenance.some(key => typeof bundle.field_provenance?.[key] !== 'string')) errors.push('APH汇总字段血缘不完整')

  const layers = bundle?.source_layers || {}
  for (const key of ['regionCard', 'budgetWeekly', 'centerDetail']) {
    const layer = layers[key]
    if (!object(layer) || !layer.source || layer.businessDate !== bundle.business_date || !object(layer.values)) errors.push(`来源层${key}缺失或业务日期不一致`)
  }

  if (rows.length < minimumCenters) errors.push(`服务中心只有${rows.length}条，低于安全阈值${minimumCenters}`)
  const centerCoverage = evaluateAphCenterCoverage(rows, daily)
  errors.push(...centerCoverage.errors)
  if (daily.length !== rows.length) errors.push(`日快照${daily.length}条与服务中心${rows.length}条不一致`)
  if (collectionRows.length !== OFFICIAL_COLLECTION_CENTER_COUNT) errors.push(`绿仔官方范围应为${OFFICIAL_COLLECTION_CENTER_COUNT}条，当前为${collectionRows.length}条`)
  if (daily.some(row => row.date !== bundle.business_date || row.business_date !== bundle.business_date)) errors.push('日快照业务日期不一致')
  if (rows.some(row => !row.center || !row.area || !finite(row.annual_budget) || !finite(row.cumulative_budget) || !finite(row.cumulative_executed) || !nullableFinite(row.same_period) || !nullableFinite(row.collection_rate))) errors.push('服务中心存在关键字段缺失或非数值')
  if (rows.some(row => row.annual_budget < 0 || row.cumulative_budget < 0)) errors.push('服务中心预算字段存在负数')
  const negativeOperatingRows = rows.filter(row => row.cumulative_executed < 0 || (row.same_period !== null && row.same_period < 0))
  if (negativeOperatingRows.length) warnings.push(`有${negativeOperatingRows.length}个服务中心存在来源已验证的负执行/同期值，原值保留并待业务复核`)
  const zeroSamePeriodRows = rows.filter(row => row.same_period === 0)
  if (zeroSamePeriodRows.length) warnings.push(`有${zeroSamePeriodRows.length}个服务中心同期为来源已验证的0；同比保持不可计算`)
  const missingSamePeriodRows = rows.filter(row => row.same_period === null)
  if (missingSamePeriodRows.length) warnings.push(`有${missingSamePeriodRows.length}个服务中心同期缺失，汇总时未转为0且项目同比保持“—”`)
  errors.push(...evaluatePaymentSamePeriodCompleteness(rows))

  if (daily.some(row => !finite(row.annual_budget) || !finite(row.cumulative_budget) || !finite(row.cumulative_executed) || !finite(row.daily_collection))) errors.push('日快照存在缺失或非数值字段')
  if (daily.some(row => row.annual_budget < 0 || row.cumulative_budget < 0)) errors.push('日快照预算字段存在负数')
  const negativeDailyRows = daily.filter(row => row.cumulative_executed < 0 || (finite(row.daily_collection) && row.daily_collection < 0))
  if (negativeDailyRows.length) warnings.push(`有${negativeDailyRows.length}条日快照存在来源已验证的负执行/日回款，原值保留并待业务复核`)
  if (daily.some(row => row.quality_status !== 'verified' || row.source_status !== 'available' || !row.source)) errors.push('日快照存在未验证记录或来源时间缺失')
  if (daily.some(row => {
    const provenance = parsedProvenance(row.field_provenance)
    return !provenance || ['annual_budget', 'cumulative_budget', 'cumulative_executed', 'daily_collection'].some(key => !object(provenance[key]))
  })) errors.push('日快照字段血缘不完整')
  const dailyCrossFieldReview = evaluateDailyCrossFieldReview(options.dailyComparisonBaseline ?? current, daily)
  errors.push(...dailyCrossFieldReview.errors)
  warnings.push(...dailyCrossFieldReview.warnings)

  const collectionKeys = collectionRows.map(row => normalizeCollectionCenter(row.center)).filter(Boolean)
  const duplicateCollectionCount = collectionKeys.length - new Set(collectionKeys).size
  if (duplicateCollectionCount) errors.push(`绿仔官方中心存在${duplicateCollectionCount}条重复归一键`)
  const invalidCollectionRows = collectionRows.filter(row => !row.area || !row.center || !finite(row.receivable) || !finite(row.received) || row.receivable < 0 || row.received < 0)
  if (invalidCollectionRows.length) errors.push(`绿仔官方明细有${invalidCollectionRows.length}条关键金额或名称非法`)

  const unmapped = bundle?.lvzai?.unmapped_centers || []
  if (unmapped.length) errors.push(`绿仔有${unmapped.length}个服务中心待人工映射：${unmapped.slice(0, 8).join('、')}`)

  const before = new Map(current.map(row => [row.center, row]))
  const after = new Map(rows.map(row => [row.center, row]))
  const changes: any[] = []
  let added = 0, changed = 0, unchanged = 0, removed = 0
  for (const row of rows) {
    const old = before.get(row.center)
    if (!old) {
      added++
      changes.push({ center: row.center, type: 'added', changed_fields: fields as any })
      continue
    }
    const changedFields = fields.filter(field => !same((old as any)[field], (row as any)[field]))
    if (changedFields.length) {
      changed++
      changes.push({ center: row.center, type: 'changed', changed_fields: changedFields })
    } else unchanged++
  }
  for (const row of current) if (!after.has(row.center)) {
    removed++
    changes.push({ center: row.center, type: 'removed', changed_fields: [] })
  }

  const sum = (values: unknown[]) => round(values.reduce<number>((total, value) => total + (finite(value) ? value : 0), 0))
  const nullableSum = (values: unknown[]) => values.length > 0 && values.every(finite) ? sum(values) : null
  const totals = (paymentRows: PaymentRow[], dailyRows: DailyRow[] = []) => ({
    annual_budget: sum(paymentRows.map(row => row.annual_budget)),
    cumulative_budget: sum(paymentRows.map(row => row.cumulative_budget)),
    cumulative_executed: sum(paymentRows.map(row => row.cumulative_executed)),
    same_period: nullableSum(paymentRows.map(row => row.same_period)),
    daily_collection: nullableSum(dailyRows.map(row => row.daily_collection)),
  })
  const afterTotals = totals(rows, daily)
  const collectionReceivable = sum(collectionRows.map(row => row.receivable))
  const collectionReceived = sum(collectionRows.map(row => row.received))
  const collectionAmountRate = collectionReceivable > 0 ? collectionReceived / collectionReceivable : null
  const officialRateNumerator = collectionRows.reduce((total, row) => total + (finite(row.collectionRate) && finite(row.receivable) ? row.collectionRate * row.receivable : 0), 0)
  const calculatedOfficialRate = collectionReceivable > 0 && collectionRows.every(row => finite(row.collectionRate)) ? officialRateNumerator / collectionReceivable : null
  const sourceCollectionRate = bundle.collection_summary && finite((bundle.collection_summary as any).collectionRate) ? Number((bundle.collection_summary as any).collectionRate) : null
  const rateEvidence = (bundle.collection_summary as any)?.periodCorrection
  if (rateEvidence?.rateField !== 'gatheringCurrentYearRecedRate' || !String(rateEvidence?.rateAggregation || '').includes('加权')) errors.push('绿仔官方收缴率缺少字段和加权公式证据')
  if (sourceCollectionRate === null || calculatedOfficialRate === null) errors.push('绿仔官方汇总缺少可勾稽收缴率')
  else if (Math.abs(sourceCollectionRate - calculatedOfficialRate) > 0.0005) errors.push(`绿仔官方收缴率与35条中心官方率加权结果不一致：源=${sourceCollectionRate}，重算=${calculatedOfficialRate}`)
  if (sourceCollectionRate !== null && collectionAmountRate !== null && Math.abs(sourceCollectionRate - collectionAmountRate) > 0.0005) warnings.push(`绿仔官方加权收缴率${round(sourceCollectionRate * 100)}%与实收/应收金额比${round(collectionAmountRate * 100)}%不同，已按两个口径独立展示`)
  const card = layers.regionCard?.values || {}
  const weekly = layers.budgetWeekly?.values || {}
  const reconciliations = {
    annualBudgetCardVsWeekly: reconciliation('regionCard', card.annualBudget, 'budgetWeekly', weekly.annualBudget),
    annualBudgetCardVsCenterDetail: reconciliation('regionCard', card.annualBudget, 'centerDetail', afterTotals.annual_budget),
    samePeriodCardVsCenterDetail: reconciliation('regionCard', card.samePeriod, 'centerDetail', afterTotals.same_period),
  }
  for (const [key, item] of Object.entries(reconciliations)) {
    if (item.status === 'unavailable') errors.push(`跨源勾稽${key}缺少数值`)
    else if (item.status === 'warning') warnings.push(`跨源勾稽${key}存在差异，已保留各来源原值`)
  }
  if (finite(card.cumulativeExecuted) && finite(card.samePeriod) && finite(card.growthPercent) && card.samePeriod !== 0) {
    const calculatedGrowth = (card.cumulativeExecuted - card.samePeriod) / card.samePeriod * 100
    if (Math.abs(calculatedGrowth - card.growthPercent) > 0.6) errors.push('华北卡片同比增幅与累计执行/同期执行不勾稽')
  } else errors.push('华北卡片同比勾稽字段不完整')

  return {
    publishable: errors.length === 0,
    errors,
    warnings,
    dailyReview: dailyCrossFieldReview.review,
    reconciliations,
    diff: { added, changed, unchanged, removed, changes },
    totals: { before: totals(current), after: { ...afterTotals, collection_receivable: collectionReceivable, collection_received: collectionReceived, collection_rate: sourceCollectionRate, collection_recalculated_official_rate: calculatedOfficialRate, collection_amount_rate: collectionAmountRate } },
    coverage: {
      payment_centers: rows.length,
      daily_snapshots: daily.length,
      lvzai_raw_rows: bundle?.lvzai?.raw_rows || 0,
      lvzai_source_regions: bundle?.lvzai?.source_regions || 0,
      lvzai_mapped_regions: bundle?.lvzai?.mapped_regions || 0,
      lvzai_canonical_centers: bundle?.lvzai?.canonical_centers || 0,
      lvzai_outside_current_scope: Array.isArray(bundle?.lvzai?.outside_current_scope) ? bundle.lvzai.outside_current_scope : [],
      collection_centers: collectionRows.length,
      lvzai_unmapped_centers: unmapped,
    },
  }
}
