import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { isCollectionCenterExcluded } from './collection-scope.js'
import {
  calculateLiveCollectionContentSha256,
  evaluateCollectionSource,
  evaluateCollectionTimestamp,
  evaluateLiveCollectionPublicationReceipt,
  parseStrictUtf8Json,
  type CollectionSourceQuality,
  type LiveCollectionPublicationReceipt,
  type P46PublicationBinding,
} from './collection-quality.js'
import { formalP46PublicationPredicate } from './formal-p46-publication.js'
import { evaluateBusinessDate } from './business-date.js'

export type LiveCollectionPublicationValidation = {
  detailFileExists: boolean
  summaryFileExists: boolean
  syncStatusFileExists: boolean
  anyFileExists: boolean
  filesComplete: boolean
  detailJsonValid: boolean
  summaryJsonValid: boolean
  syncStatusJsonValid: boolean
  jsonComplete: boolean
  detailStructureValid: boolean
  summaryStructureValid: boolean
  syncStatusStructureValid: boolean
  structureComplete: boolean
  summaryAvailable: boolean
  detailAvailable: boolean
  syncStatusAvailable: boolean
  evidenceComplete: boolean
  datesAligned: boolean
  businessDate: string | null
  extractedAt: string | null
  rows: Array<Record<string, unknown>>
  summary: Record<string, unknown> | null
  status: Record<string, unknown> | null
  quality: CollectionSourceQuality
  receipt: LiveCollectionPublicationReceipt
  ready: boolean
  reasons: string[]
  message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isValidTimestamp(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(new Date(value).getTime())
}

function readJsonBytes(filePath: string, label: string): { available: boolean; content: Buffer | null; parsed: unknown; error: string | null } {
  if (!fs.existsSync(filePath)) return { available: false, content: null, parsed: null, error: null }
  try {
    const content = fs.readFileSync(filePath)
    return { available: true, content, parsed: parseStrictUtf8Json(content, label), error: null }
  } catch (error: unknown) {
    return { available: true, content: null, parsed: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function readP46Binding(database: Database.Database, receipt: Record<string, unknown> | null): P46PublicationBinding | null {
  const match = String(receipt?.batchId || '').trim().match(/^p46-(\d+)$/)
  if (!match) return null
  try {
    const formalPublication = formalP46PublicationPredicate('b')
    const row = database.prepare(`SELECT b.id,b.batch_sha256,b.business_date,
      CASE WHEN b.status='published' AND length(b.batch_sha256)=64
        AND COALESCE(b.published_at,'')<>'' AND ${formalPublication} THEN 1 ELSE 0 END AS formally_published
      FROM data_ingestion_batches b WHERE b.id=?`).get(Number(match[1])) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      batchId: Number(row.id),
      batchSha256: String(row.batch_sha256 || ''),
      businessDate: String(row.business_date || ''),
      formallyPublished: Number(row.formally_published || 0) === 1,
    }
  } catch {
    return null
  }
}

export function readLiveCollectionPublication(
  database: Database.Database,
  rootPath: string,
  nowMs = Date.now(),
): LiveCollectionPublicationValidation {
  const detailFile = readJsonBytes(path.join(rootPath, '绿仔收缴明细.json'), '绿仔明细JSON')
  const summaryFile = readJsonBytes(path.join(rootPath, '绿仔收款汇总.json'), '绿仔汇总JSON')
  const statusFile = readJsonBytes(path.join(rootPath, '绿仔同步状态.json'), '绿仔同步状态JSON')
  const detail = detailFile.parsed && typeof detailFile.parsed === 'object'
    ? detailFile.parsed as Record<string, unknown>
    : null
  const summary = summaryFile.parsed && typeof summaryFile.parsed === 'object' && !Array.isArray(summaryFile.parsed)
    ? summaryFile.parsed as Record<string, unknown>
    : null
  const status = statusFile.parsed && typeof statusFile.parsed === 'object' && !Array.isArray(statusFile.parsed)
    ? statusFile.parsed as Record<string, unknown>
    : null
  const rawRows = Array.isArray(detailFile.parsed) ? detailFile.parsed : detail?.rows
  const rows = Array.isArray(rawRows)
    ? rawRows.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object') && !isCollectionCenterExcluded((row as Record<string, unknown>).center))
    : []
  const summaryBusinessDate = evaluateBusinessDate(summary?.date || summary?.businessDate, '绿仔汇总业务日期', nowMs)
  const detailBusinessDate = evaluateBusinessDate(detail?.date || detail?.businessDate, '绿仔明细业务日期', nowMs)
  const statusBusinessDate = evaluateBusinessDate(status?.date || status?.businessDate, '绿仔同步状态业务日期', nowMs)
  const summaryDate = summaryBusinessDate.date
  const detailDate = detailBusinessDate.date
  const statusDate = statusBusinessDate.date
  const businessDate = summaryDate || detailDate || statusDate
  const detailExtractedAt = evaluateCollectionTimestamp(detail?.extractedAt, '明细提取时间', nowMs)
  const summaryExtractedAt = evaluateCollectionTimestamp(summary?.extractedAt, '汇总提取时间', nowMs)
  const finishedAt = evaluateCollectionTimestamp(status?.finishedAt, '完成时间', nowMs)
  const publishedAt = evaluateCollectionTimestamp(status?.publishedAt, '发布时间', nowMs)
  const extractedAt = detailExtractedAt.stamp
  const anyFileExists = detailFile.available || summaryFile.available || statusFile.available
  const filesComplete = detailFile.available && summaryFile.available && statusFile.available
  const detailJsonValid = detailFile.available && detailFile.error === null
  const summaryJsonValid = summaryFile.available && summaryFile.error === null
  const syncStatusJsonValid = statusFile.available && statusFile.error === null
  const jsonComplete = filesComplete && detailJsonValid && summaryJsonValid && syncStatusJsonValid
  const detailStructureValid = detailJsonValid && Array.isArray(rawRows) && rawRows.length > 0
    && rawRows.every(isRecord)
  const periodCorrection = isRecord(summary?.periodCorrection) ? summary.periodCorrection : null
  const summaryStructureValid = summaryJsonValid && Boolean(summary && summaryDate && isValidTimestamp(summary.extractedAt)
    && isFiniteNumber(summary.collectionRate) && summary.collectionRate >= 0 && summary.collectionRate <= 1
    && isFiniteNumber(summary['receivable_万']) && summary['receivable_万'] >= 0
    && isFiniteNumber(summary['received_万']) && summary['received_万'] >= 0
    && isFiniteNumber(summary['outstanding_万']) && summary['outstanding_万'] >= 0
    && periodCorrection
    && isFiniteNumber(periodCorrection.correctedRate) && periodCorrection.correctedRate >= 0 && periodCorrection.correctedRate <= 1
    && periodCorrection.rateField === 'gatheringCurrentYearRecedRate'
    && String(periodCorrection.rateAggregation || '').trim())
  const syncStatusStructureValid = syncStatusJsonValid && Boolean(status && statusDate
    && status.schemaVersion === 2
    && typeof status.ok === 'boolean'
    && String(status.state || '').trim()
    && /^p46-\d+$/.test(String(status.batchId || '').trim())
    && /^[a-f0-9]{64}$/i.test(String(status.p46BatchSha256 || '').trim())
    && /^[a-f0-9]{64}$/i.test(String(status.collectionContentSha256 || '').trim())
    && String(status.publishedBy || '').trim()
    && isValidTimestamp(status.publishedAt)
    && isValidTimestamp(status.finishedAt))
  const structureComplete = jsonComplete && detailStructureValid && summaryStructureValid && syncStatusStructureValid
  const evidenceComplete = structureComplete
  const datesAligned = Boolean(detailDate && summaryDate && statusDate
    && detailDate === summaryDate && statusDate === summaryDate)
  const timestampsOrdered = Number.isFinite(detailExtractedAt.ms)
    && Number.isFinite(summaryExtractedAt.ms)
    && Number.isFinite(finishedAt.ms)
    && Number.isFinite(publishedAt.ms)
    && finishedAt.ms >= detailExtractedAt.ms
    && finishedAt.ms >= summaryExtractedAt.ms
    && publishedAt.ms >= finishedAt.ms
  const quality = evaluateCollectionSource(rows, extractedAt, nowMs)
  const contentSha256 = detailFile.content && summaryFile.content
    ? calculateLiveCollectionContentSha256(detailFile.content, summaryFile.content)
    : null
  const binding = readP46Binding(database, status)
  const receipt = evaluateLiveCollectionPublicationReceipt(status, businessDate || '', contentSha256, binding, nowMs)
  const reasons = [
    ...(!filesComplete ? ['绿仔明细、汇总或同步状态文件不完整'] : []),
    ...(filesComplete && !jsonComplete ? ['绿仔明细、汇总或同步状态不是有效UTF-8/JSON'] : []),
    ...(detailJsonValid && !detailStructureValid ? ['绿仔明细业务结构无效：必须是非空记录数组或包含非空rows记录数组的对象'] : []),
    ...(summaryJsonValid && !summaryStructureValid ? ['绿仔汇总业务结构无效：缺少日期、金额、官方率或修正口径字段'] : []),
    ...(syncStatusJsonValid && !syncStatusStructureValid ? ['绿仔同步状态回执结构无效：缺少V2批次、双SHA、日期或审计字段'] : []),
    ...detailBusinessDate.reasons,
    ...summaryBusinessDate.reasons,
    ...statusBusinessDate.reasons,
    ...(!datesAligned ? ['绿仔明细、汇总与同步状态业务日期未对齐'] : []),
    ...detailExtractedAt.reasons,
    ...summaryExtractedAt.reasons,
    ...finishedAt.reasons,
    ...publishedAt.reasons,
    ...(!timestampsOrdered ? ['绿仔完成时间不得早于明细/汇总提取时间，发布时间不得早于完成时间'] : []),
    ...(detailFile.error ? [`绿仔明细JSON无效：${detailFile.error}`] : []),
    ...(summaryFile.error ? [`绿仔汇总JSON无效：${summaryFile.error}`] : []),
    ...(statusFile.error ? [`绿仔同步状态JSON无效：${statusFile.error}`] : []),
    ...quality.reasons,
    ...receipt.reasons,
  ]
  const ready = evidenceComplete && datesAligned && timestampsOrdered
    && detailExtractedAt.reasons.length === 0 && summaryExtractedAt.reasons.length === 0
    && finishedAt.reasons.length === 0 && publishedAt.reasons.length === 0
    && quality.ready && receipt.published
  return {
    detailFileExists: detailFile.available,
    summaryFileExists: summaryFile.available,
    syncStatusFileExists: statusFile.available,
    anyFileExists,
    filesComplete,
    detailJsonValid,
    summaryJsonValid,
    syncStatusJsonValid,
    jsonComplete,
    detailStructureValid,
    summaryStructureValid,
    syncStatusStructureValid,
    structureComplete,
    summaryAvailable: summaryFile.available && Boolean(summary),
    detailAvailable: detailFile.available && Array.isArray(rawRows) && rows.length > 0,
    syncStatusAvailable: statusFile.available && Boolean(status),
    evidenceComplete,
    datesAligned,
    businessDate,
    extractedAt,
    rows,
    summary,
    status,
    quality,
    receipt,
    ready,
    reasons: [...new Set(reasons)],
    message: ready ? '收缴明细、汇总、内容域SHA与P46正式批次回执一致' : [...new Set(reasons)].join('；'),
  }
}
