import { createHash } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { isHeatingAdjustedCollectionCenter } from './collection-scope.js'
import { evaluateBusinessDate } from './business-date.js'

export const OFFICIAL_COLLECTION_CENTER_COUNT = 35
export const COLLECTION_MAX_AGE_HOURS = 72
export const COLLECTION_FUTURE_TOLERANCE_MS = 5 * 60 * 1000

export type CollectionTimestampValidation = {
  stamp: string | null
  ms: number
  reasons: string[]
}

export function evaluateCollectionTimestamp(
  value: unknown,
  label: string,
  nowMs = Date.now(),
): CollectionTimestampValidation {
  const stamp = typeof value === 'string' && value.trim() ? value.trim() : null
  const ms = stamp ? new Date(stamp).getTime() : Number.NaN
  const reasons: string[] = []
  if (!Number.isFinite(ms)) reasons.push(`缺少有效${label}`)
  else if (ms > nowMs + COLLECTION_FUTURE_TOLERANCE_MS) reasons.push(`${label}位于未来，超过5分钟容差`)
  return { stamp, ms, reasons }
}

export function normalizeCollectionCenter(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[·•・]/g, '')
}

export type CollectionSourceQuality = {
  ready: boolean
  status: 'available' | 'invalid' | 'stale'
  rowCount: number
  duplicateCenterCount: number
  invalidAmountCount: number
  invalidOfficialRateCount: number
  stale: boolean
  extractedAt: string | null
  reasons: string[]
}

export function evaluateCollectionSource(
  rows: any[],
  extractedAt: unknown,
  nowMs = Date.now(),
): CollectionSourceQuality {
  const safeRows = Array.isArray(rows) ? rows : []
  const keys = safeRows.map(row => normalizeCollectionCenter(row?.center)).filter(Boolean)
  const duplicateCenterCount = keys.length - new Set(keys).size
  const invalidAmountCount = safeRows.filter(row => {
    const receivable = row?.receivable
    const received = row?.received
    return typeof receivable !== 'number' || !Number.isFinite(receivable) || receivable < 0
      || typeof received !== 'number' || !Number.isFinite(received) || received < 0
  }).length
  const invalidOfficialRateCount = safeRows.filter(row => {
    if (isHeatingAdjustedCollectionCenter(row?.center)) return false
    const rate = row?.collectionRate ?? row?.gatheringCurrentYearRecedRate
    return typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1
  }).length
  const timestamp = evaluateCollectionTimestamp(extractedAt, '提取时间', nowMs)
  const { stamp, ms: extractedMs } = timestamp
  const stale = Number.isFinite(extractedMs)
    ? nowMs - extractedMs > COLLECTION_MAX_AGE_HOURS * 60 * 60 * 1000
    : false
  const reasons: string[] = []
  if (safeRows.length !== OFFICIAL_COLLECTION_CENTER_COUNT) reasons.push(`官方范围应为${OFFICIAL_COLLECTION_CENTER_COUNT}条，当前为${safeRows.length}条`)
  if (duplicateCenterCount > 0) reasons.push(`发现${duplicateCenterCount}条归一化中心重复`)
  if (invalidAmountCount > 0) reasons.push(`发现${invalidAmountCount}条关键金额缺失或非法`)
  if (invalidOfficialRateCount > 0) reasons.push(`发现${invalidOfficialRateCount}条普通中心官方率缺失或非法`)
  reasons.push(...timestamp.reasons)
  if (stale) reasons.push(`官方快照超过${COLLECTION_MAX_AGE_HOURS}小时未更新`)
  return {
    ready: reasons.length === 0,
    status: stale ? 'stale' : reasons.length ? 'invalid' : 'available',
    rowCount: safeRows.length,
    duplicateCenterCount,
    invalidAmountCount,
    invalidOfficialRateCount,
    stale,
    extractedAt: stamp,
    reasons,
  }
}

export type LiveCollectionPublicationReceipt = {
  published: boolean
  evidence: string | null
  reasons: string[]
}

export type P46PublicationBinding = {
  batchId: number
  batchSha256: string
  businessDate: string
  formallyPublished: boolean
}

export function parseStrictUtf8Json(content: Uint8Array, label: string): unknown {
  if (!isUtf8(content)) throw new Error(`${label}不是有效UTF-8，禁止作为正式来源`)
  return JSON.parse(Buffer.from(content).toString('utf8'))
}

export function calculateLiveCollectionContentSha256(detailContent: string | Uint8Array, summaryContent: string | Uint8Array): string {
  return createHash('sha256')
    .update('first-service-live-collection-v1\0detail\0', 'utf8')
    .update(detailContent)
    .update('\0summary\0', 'utf8')
    .update(summaryContent)
    .digest('hex')
}

export function evaluateLiveCollectionPublicationReceipt(
  status: unknown,
  businessDate: string,
  consumedContentSha256: string | null = null,
  p46Binding: P46PublicationBinding | null = null,
  nowMs = Date.now(),
): LiveCollectionPublicationReceipt {
  const receipt = status && typeof status === 'object' ? status as Record<string, unknown> : {}
  const statusBusinessDate = evaluateBusinessDate(receipt.date, '同步状态业务日期', nowMs)
  const consumedBusinessDate = evaluateBusinessDate(businessDate, '消费业务日期', nowMs)
  const batchId = String(receipt.batchId || '').trim()
  const batchIdMatch = batchId.match(/^p46-(\d+)$/)
  const p46BatchSha256 = String(receipt.p46BatchSha256 || '').trim().toLowerCase()
  const collectionContentSha256 = String(receipt.collectionContentSha256 || '').trim().toLowerCase()
  const publishedBy = String(receipt.publishedBy || '').trim()
  const publishedAt = String(receipt.publishedAt || '').trim()
  const publishedTimestamp = evaluateCollectionTimestamp(publishedAt, '发布时间', nowMs)
  const finishedTimestamp = evaluateCollectionTimestamp(receipt.finishedAt, '完成时间', nowMs)
  const publishedMs = publishedTimestamp.ms
  const reasons: string[] = []
  if (receipt.schemaVersion !== 2) reasons.push('发布回执版本不是2')
  if (receipt.ok !== true) reasons.push('同步任务未成功')
  if (receipt.state !== 'published') reasons.push('同步状态不是published')
  reasons.push(...statusBusinessDate.reasons, ...consumedBusinessDate.reasons)
  if (!consumedBusinessDate.date || statusBusinessDate.date !== consumedBusinessDate.date) reasons.push('同步状态与业务日期不一致')
  if (!batchIdMatch) reasons.push('缺少有效P46正式发布批次ID')
  if (!/^[a-f0-9]{64}$/.test(p46BatchSha256)) reasons.push('缺少有效P46六源批次SHA256')
  if (!/^[a-f0-9]{64}$/.test(collectionContentSha256)) reasons.push('缺少有效绿仔内容域SHA256')
  if (!consumedContentSha256 || collectionContentSha256 !== consumedContentSha256) reasons.push('发布回执SHA256与实际消费明细、汇总原文字节域不一致，文件可能被篡改')
  if ('batchSha256' in receipt) reasons.push('旧batchSha256字段语义混用，禁止作为正式回执')
  if (!p46Binding) reasons.push('缺少可核验的P46正式批次绑定')
  else {
    const bindingBusinessDate = evaluateBusinessDate(p46Binding.businessDate, 'P46正式批次业务日期', nowMs)
    reasons.push(...bindingBusinessDate.reasons)
    if (Number(batchIdMatch?.[1] || 0) !== p46Binding.batchId) reasons.push('回执P46批次ID与数据库不一致')
    if (p46BatchSha256 !== p46Binding.batchSha256.toLowerCase()) reasons.push('回执P46六源批次SHA256与数据库不一致')
    if (!bindingBusinessDate.date || statusBusinessDate.date !== bindingBusinessDate.date) reasons.push('回执业务日期与P46批次不一致')
    if (!p46Binding.formallyPublished) reasons.push('绑定P46批次未完成正式发布')
  }
  if (!publishedBy) reasons.push('缺少发布人审计信息')
  reasons.push(...finishedTimestamp.reasons, ...publishedTimestamp.reasons)
  if (Number.isFinite(finishedTimestamp.ms) && Number.isFinite(publishedMs) && publishedMs < finishedTimestamp.ms) {
    reasons.push('发布时间早于完成时间')
  }
  return {
    published: reasons.length === 0,
    evidence: reasons.length ? null : `live-content:${batchId}:${collectionContentSha256}`,
    reasons,
  }
}

export function shouldUseLiveCollectionSource(
  liveRows: any[],
  liveExtractedAt: unknown,
  livePublished: boolean,
  batchRows: any[],
  batchExtractedAt: unknown,
  nowMs = Date.now(),
): boolean {
  if (!livePublished) return false
  const liveQuality = evaluateCollectionSource(liveRows, liveExtractedAt, nowMs)
  if (!liveQuality.ready) return false

  const batchQuality = evaluateCollectionSource(batchRows, batchExtractedAt, nowMs)
  if (!batchQuality.ready) return true

  const liveMs = new Date(String(liveExtractedAt || '')).getTime()
  const batchMs = new Date(String(batchExtractedAt || '')).getTime()
  return Number.isFinite(liveMs) && Number.isFinite(batchMs) && liveMs > batchMs
}
