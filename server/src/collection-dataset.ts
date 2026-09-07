import { resolve } from 'node:path'
import db from './db.js'
import {
  evaluateCollectionSource,
  shouldUseLiveCollectionSource,
} from './collection-quality.js'
import {
  LIVE_COLLECTION_METHODOLOGY_VERSION,
  P46_COLLECTION_METHODOLOGY_VERSION,
  buildCollectionPublication,
  type CollectionPublication,
  type SourceQuality,
} from './collection-publication.js'
import { readOptionalNumber } from './production-safety.js'
import { formalP46PublicationPredicate } from './formal-p46-publication.js'
import { readLiveCollectionPublication } from './live-collection-publication.js'

export type LvzaiDataset = {
  rows: any[]
  extractedAt: string | null
  summary: Record<string, unknown> | null
}

export type FormalCollectionDataset = {
  dataset: LvzaiDataset | null
  quality: SourceQuality
  publication: CollectionPublication
}

const cockpitRoot = () => process.env.COCKPIT_ROOT || resolve(process.env.HOME || '/home/ubuntu', 'cockpit')

function getPublishedBatchDataset(): LvzaiDataset | null {
  try {
    const formalPublication = formalP46PublicationPredicate('b')
    const batch = db.prepare(`SELECT b.id,b.business_date,b.summary,b.extracted_at
      FROM data_ingestion_batches b
      WHERE b.status='published' AND length(b.batch_sha256)=64 AND COALESCE(b.published_at,'')<>''
        AND ${formalPublication}
      ORDER BY b.business_date DESC,b.id DESC LIMIT 1`).get() as any
    if (!batch) return null
    const rows = (db.prepare("SELECT payload FROM data_ingestion_rows WHERE batch_id=? AND entity_type='collection_center' ORDER BY id").all(batch.id) as any[]).map(row => JSON.parse(row.payload))
    const analysis = JSON.parse(batch.summary || '{}')
    const totals = analysis?.totals?.after
    if (rows.length === 0) return null
    const collectionRate = readOptionalNumber(totals?.collection_rate)
    const collectionReceivable = readOptionalNumber(totals?.collection_receivable)
    const collectionReceived = readOptionalNumber(totals?.collection_received)
    return {
      rows,
      extractedAt: batch.extracted_at || null,
      summary: collectionRate !== null ? {
        collectionRate,
        collectionReceivable,
        collectionReceived,
        collectionOutstanding: collectionReceivable === null || collectionReceived === null ? null : collectionReceivable - collectionReceived,
        collectionSource: '已发布正式收缴批次·绿仔官方35条',
        collectionExtractedAt: batch.extracted_at || null,
        businessDate: batch.business_date || null,
        date: batch.business_date || null,
        lastValidatedAt: batch.extracted_at || null,
        publicationStatus: 'published',
        methodologyVersion: P46_COLLECTION_METHODOLOGY_VERSION,
        periodCorrection: {
          correctedRate: collectionRate,
          rateField: 'gatheringCurrentYearRecedRate',
          rateAggregation: 'P46发布门禁已校验的官方项目率加权结果',
          publicationEvidence: `p46-batch:${batch.id}`,
        },
      } : null,
    }
  } catch {
    return null
  }
}

function getLiveFileDataset(): (LvzaiDataset & { published: boolean; blocksFallback: boolean }) | null {
  try {
    const validation = readLiveCollectionPublication(db, cockpitRoot())
    if (!validation.detailFileExists && !validation.summaryFileExists && !validation.syncStatusFileExists) return null
    const rows = validation.rows
    const rawSummary = validation.summary || {}
    const syncStatus = validation.status || {}
    const extractedAt = validation.extractedAt
    const businessDate = validation.businessDate || ''
    const receipt = validation.receipt
    const published = validation.ready
    const collectionRate = readOptionalNumber(rawSummary?.collectionRate)
    const periodCorrection = rawSummary?.periodCorrection && typeof rawSummary.periodCorrection === 'object'
      ? { ...rawSummary.periodCorrection, publicationEvidence: receipt.evidence }
      : rawSummary?.periodCorrection || null
    return {
      rows,
      extractedAt,
      published,
      blocksFallback: !validation.evidenceComplete,
      summary: {
        collectionRate,
        collectionReceivable: readOptionalNumber(rawSummary['receivable_万']),
        collectionReceived: readOptionalNumber(rawSummary['received_万']),
        collectionOutstanding: readOptionalNumber(rawSummary['outstanding_万']),
        collectionSource: String(rawSummary.source || '绿仔管家'),
        collectionExtractedAt: extractedAt,
        businessDate,
        date: businessDate,
        lastValidatedAt: syncStatus?.finishedAt || null,
        publicationStatus: published ? 'published' : 'unpublished',
        methodologyVersion: LIVE_COLLECTION_METHODOLOGY_VERSION,
        periodCorrection,
      },
    }
  } catch {
    return null
  }
}

export function getLvzaiDataset(): LvzaiDataset | null {
  const batch = getPublishedBatchDataset()
  const live = getLiveFileDataset()
  // 任一固定入口文件已出现但证据不完整（含存在但解析失败）时，必须保留失败对象，
  // 不能因缺少可比较业务日期而退回旧正式批次。
  if (live?.blocksFallback) return live
  if (live && shouldUseLiveCollectionSource(
    live.rows,
    live.extractedAt,
    live.published,
    batch?.rows || [],
    batch?.extractedAt || null,
  )) {
    return live
  }
  const liveDate = String(live?.summary?.businessDate || '').slice(0, 10)
  const batchDate = String(batch?.summary?.businessDate || '').slice(0, 10)
  // 当前或更晚的固定入口证据一旦存在但失效，必须原样失败关闭；禁止静默回退旧批次冒充published。
  if (live && liveDate && (!batchDate || liveDate >= batchDate)) return live
  return batch || live
}

export function getFormalCollectionDataset(): FormalCollectionDataset {
  const dataset = getLvzaiDataset()
  const quality: SourceQuality = dataset
    ? evaluateCollectionSource(dataset.rows, dataset.extractedAt)
    : {
        ready: false,
        status: 'unavailable',
        stale: false,
        rowCount: 0,
        reasons: ['绿仔正式收缴数据集不可用'],
      }
  const summary = dataset?.summary || null
  const statusValue = summary?.publicationStatus
  const publicationStatus = statusValue === 'published' || statusValue === 'unpublished' || statusValue === 'blocked'
    ? statusValue
    : 'unpublished'
  const optionalText = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null
  const publication = buildCollectionPublication(summary, quality, {
    publicationStatus,
    lastValidatedAt: optionalText(summary?.lastValidatedAt ?? dataset?.extractedAt),
    methodologyVersion: optionalText(summary?.methodologyVersion),
  })
  return { dataset, quality, publication }
}
