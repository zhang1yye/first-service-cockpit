import { readOptionalNumber } from './production-safety.js'

export const LIVE_COLLECTION_METHODOLOGY_VERSION = 'lvzai:gatheringCurrentYearRecedRate:weighted+heating-period-correction:v1'
export const P46_COLLECTION_METHODOLOGY_VERSION = 'p46:gatheringCurrentYearRecedRate:validated-publication:v1'

export type SourceQuality = {
  ready?: boolean
  status?: string
  stale?: boolean
  rowCount?: number
  reasons?: string[]
}

type PublicationMeta = {
  publicationStatus: 'published' | 'unpublished' | 'blocked'
  lastValidatedAt: string | null
  methodologyVersion?: string | null
}

export type CollectionPublication = {
  collectionRate: number | null
  collectionReceivable: number | null
  collectionReceived: number | null
  collectionOutstanding: number | null
  source: string | null
  extractedAt: string | null
  businessDate: string | null
  lastValidatedAt: string | null
  methodologyVersion: string | null
  publicationStatus: 'published' | 'unpublished' | 'blocked'
  sourceStatus: string
  stale: boolean
  fallbackReason: string | null
  periodCorrection: Record<string, unknown> | null
  sourceQuality: SourceQuality
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = readOptionalNumber(value)
    if (parsed !== null) return parsed
  }
  return null
}

function dateOnly(value: unknown): string | null {
  const text = String(value || '').trim()
  const match = text.match(/^\d{4}-\d{2}-\d{2}/)
  return match ? match[0] : null
}

/**
 * 将绿仔现场汇总或P46已发布批次规范化为唯一正式收缴摘要。
 * 这里绝不使用“实收÷应收”重算官方收缴率；仅接受已验证的修正率证据。
 */
export function buildCollectionPublication(
  raw: Record<string, any> | null | undefined,
  quality: SourceQuality,
  meta: PublicationMeta,
): CollectionPublication {
  const periodCorrection = raw?.periodCorrection && typeof raw.periodCorrection === 'object'
    ? raw.periodCorrection as Record<string, unknown>
    : null
  const rawRate = firstNumber(raw?.collectionRate)
  const correctedRate = firstNumber(periodCorrection?.correctedRate)
  const hasRateField = periodCorrection?.rateField === 'gatheringCurrentYearRecedRate'
  const hasWeightedEvidence = String(periodCorrection?.rateAggregation || '').includes('加权')
  const mismatch = rawRate !== null && correctedRate !== null && Math.abs(rawRate - correctedRate) > 0.00005
  const reasons = Array.isArray(quality?.reasons) ? quality.reasons.filter(Boolean) : []

  let publicationStatus: CollectionPublication['publicationStatus'] = meta.publicationStatus
  let fallbackReason: string | null = reasons.length ? reasons.join('；') : null

  if (meta.publicationStatus === 'published' && (!quality?.ready || quality?.stale)) {
    publicationStatus = quality?.stale ? 'unpublished' : 'blocked'
  }
  if (!periodCorrection || correctedRate === null || !hasRateField || !hasWeightedEvidence) {
    publicationStatus = 'blocked'
    fallbackReason = '缺少正式修正口径证据（官方字段、加权公式或修正率）'
  } else if (mismatch) {
    publicationStatus = 'blocked'
    fallbackReason = `原始汇总率与正式修正率不一致：raw=${rawRate}，corrected=${correctedRate}`
  }

  const published = publicationStatus === 'published'
  const extractedAt = raw?.extractedAt || raw?.collectionExtractedAt || null
  const businessDate = dateOnly(raw?.date || raw?.businessDate || extractedAt)

  return {
    collectionRate: published ? correctedRate : null,
    collectionReceivable: published ? firstNumber(raw?.receivable_万, raw?.collectionReceivable) : null,
    collectionReceived: published ? firstNumber(raw?.received_万, raw?.collectionReceived) : null,
    collectionOutstanding: published ? firstNumber(raw?.outstanding_万, raw?.collectionOutstanding) : null,
    source: raw?.source || raw?.collectionSource || null,
    extractedAt,
    businessDate,
    lastValidatedAt: meta.lastValidatedAt || null,
    methodologyVersion: meta.methodologyVersion || (String(periodCorrection?.publicationEvidence || '').startsWith('p46')
      ? P46_COLLECTION_METHODOLOGY_VERSION
      : LIVE_COLLECTION_METHODOLOGY_VERSION),
    publicationStatus,
    sourceStatus: String(quality?.status || (published ? 'available' : 'unavailable')),
    stale: Boolean(quality?.stale),
    fallbackReason: published ? null : (fallbackReason || '收缴数据尚未通过正式发布门禁'),
    periodCorrection,
    sourceQuality: quality,
  }
}
