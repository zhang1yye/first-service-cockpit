export type PublicationCompletionCode = 'complete' | 'partial' | 'failed' | 'running' | 'not_started' | 'unknown'
export type PublicationTone = 'success' | 'warning' | 'danger' | 'neutral'

export type PublicationSourceEvidence = {
  sourceKey: string
  name?: string
  businessDate: string | null
  status: 'ready' | 'warning' | 'failed' | 'unknown'
  extractedAt?: string | null
  validatedAt?: string | null
  rowCount?: number | null
  message?: string | null
  summaryAvailable?: boolean
  detailAvailable?: boolean
  syncStatusAvailable?: boolean
}

export type PublicationBatchEvidence = {
  id: number
  businessDate: string | null
  status: 'blocked' | 'previewed' | 'published' | 'rejected' | string
  publishedAt?: string | null
}

export type PublicationRecordEvidence = {
  batchId: number
  businessDate: string | null
  publishedAt?: string | null
}

export type PublicationAuditEvidence = {
  sourceKey: string
  batchId: number
  businessDate: string | null
  status: string
}

export type PublicationStatusInput = {
  asOfDate: string
  requiredSourceKeys: string[]
  sources: PublicationSourceEvidence[]
  latestBatch: PublicationBatchEvidence | null
  latestPublication: PublicationRecordEvidence | null
  audits: PublicationAuditEvidence[]
}

export type PublicationStatus = {
  code: PublicationCompletionCode
  label: string
  tone: PublicationTone
  summary: string
  businessDate: string | null
  officialBusinessDate: string | null
  isComplete: boolean
  missingSourceKeys: string[]
  advancedSourceKeys: string[]
  laggingSourceKeys: string[]
  missingAuditSourceKeys: string[]
  asOfDate: string
}

const LABELS: Record<PublicationCompletionCode, string> = {
  complete: '已完整发布',
  partial: '部分更新',
  failed: '更新失败',
  running: '正在更新',
  not_started: '尚未触发',
  unknown: '结果未知',
}

function dateOnly(value: unknown): string | null {
  const match = String(value || '').trim().match(/^\d{4}-\d{2}-\d{2}/)
  return match ? match[0] : null
}

function maxDate(values: Array<string | null>): string | null {
  const dates = values.filter((value): value is string => Boolean(dateOnly(value))).map(value => dateOnly(value) as string)
  return dates.length ? [...dates].sort().at(-1) || null : null
}

function result(
  input: PublicationStatusInput,
  code: PublicationCompletionCode,
  summary: string,
  facts: Omit<PublicationStatus, 'code' | 'label' | 'tone' | 'summary' | 'isComplete' | 'asOfDate'>,
): PublicationStatus {
  const tone: PublicationTone = code === 'complete' ? 'success' : code === 'failed' ? 'danger' : code === 'partial' || code === 'running' ? 'warning' : 'neutral'
  return {
    ...facts,
    code,
    label: LABELS[code],
    tone,
    summary,
    isComplete: code === 'complete',
    asOfDate: dateOnly(input.asOfDate) || input.asOfDate,
  }
}

/**
 * 只有三类证据同时对齐才允许宣称“已完整发布”：
 * 1. 所有必需源均有同一业务日期且状态可用；
 * 2. 该日期已有正式 published 批次与 publication 记录；
 * 3. 每个必需源都有该批次的成功发布审计。
 * 任何缺失都不得降级成0或“成功”。
 */
export function classifyPublicationStatus(input: PublicationStatusInput): PublicationStatus {
  const required = [...new Set(input.requiredSourceKeys)]
  const sourceMap = new Map(input.sources.map(source => [source.sourceKey, source]))
  const sourceDates = required.map(key => dateOnly(sourceMap.get(key)?.businessDate))
  const businessDate = maxDate(sourceDates)
  const officialBusinessDate = dateOnly(input.latestPublication?.businessDate)
  const missingSourceKeys = required.filter(key => {
    const source = sourceMap.get(key)
    return !dateOnly(source?.businessDate) || source?.status === 'unknown' || source?.status === 'failed'
  })
  const advancedSourceKeys = officialBusinessDate
    ? required.filter(key => {
        const sourceDate = dateOnly(sourceMap.get(key)?.businessDate)
        return Boolean(sourceDate && sourceDate > officialBusinessDate)
      })
    : required.filter(key => dateOnly(sourceMap.get(key)?.businessDate) === businessDate)
  const laggingSourceKeys = businessDate
    ? required.filter(key => {
        const sourceDate = dateOnly(sourceMap.get(key)?.businessDate)
        return Boolean(sourceDate && sourceDate < businessDate)
      })
    : []
  const batchId = input.latestBatch?.id ?? input.latestPublication?.batchId ?? null
  const successfulAudits = new Set(input.audits
    .filter(audit => audit.status === 'success' && batchId !== null && audit.batchId === batchId && dateOnly(audit.businessDate) === officialBusinessDate)
    .map(audit => audit.sourceKey))
  const missingAuditSourceKeys = required.filter(key => !successfulAudits.has(key))
  const facts = { businessDate, officialBusinessDate, missingSourceKeys, advancedSourceKeys, laggingSourceKeys, missingAuditSourceKeys }

  if (!businessDate) {
    return result(input, 'unknown', '必需数据源没有可核验的业务日期，不能判断是否完成更新。', facts)
  }

  const batchDate = dateOnly(input.latestBatch?.businessDate)
  if (input.latestBatch && batchDate === businessDate && ['blocked', 'rejected'].includes(input.latestBatch.status)) {
    return result(input, 'failed', `${businessDate}批次未通过真实性门禁或已被拒绝，正式数据未推进。`, facts)
  }
  if (input.latestBatch && batchDate === businessDate && input.latestBatch.status === 'previewed') {
    return result(input, 'partial', `${businessDate}数据已形成预览但尚未完成管理员发布，继续使用上一可信批次。`, facts)
  }

  const sourcesAligned = missingSourceKeys.length === 0 && laggingSourceKeys.length === 0 && required.every(key => dateOnly(sourceMap.get(key)?.businessDate) === businessDate)
  const publicationAligned = Boolean(
    input.latestBatch
    && input.latestPublication
    && input.latestBatch.status === 'published'
    && input.latestBatch.id === input.latestPublication.batchId
    && batchDate === businessDate
    && officialBusinessDate === businessDate,
  )

  if (sourcesAligned && publicationAligned && missingAuditSourceKeys.length === 0) {
    return result(input, 'complete', `${businessDate}三项必需数据源、正式批次和发布审计全部一致。`, facts)
  }

  if (sourcesAligned && publicationAligned && missingAuditSourceKeys.length > 0) {
    return result(input, 'unknown', `${businessDate}正式批次已发布，但缺少${missingAuditSourceKeys.join('、')}发布审计，不能确认完整完成。`, facts)
  }

  if (advancedSourceKeys.length > 0 || laggingSourceKeys.length > 0 || missingSourceKeys.length > 0 || officialBusinessDate !== businessDate) {
    const official = officialBusinessDate || '尚无正式批次'
    return result(input, 'partial', `业务数据已到${businessDate}，正式发布停留在${official}；各来源尚未形成同一可信批次。`, facts)
  }

  return result(input, 'unknown', '现有证据不足以判断更新是否完整完成。', facts)
}
