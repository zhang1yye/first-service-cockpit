import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import { OFFICIAL_COLLECTION_CENTER_COUNT } from './collection-quality.js'

export type ReportArchiveIntegrity = {
  state: 'valid' | 'invalid'
  valid: boolean
  code: string
  reasons: string[]
  binding: {
    archived: { batchId: number | null; batchSha256: string | null; businessDate: string | null }
    current: { batchId: number | null; batchSha256: string | null; businessDate: string | null }
  }
}

function parseObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

function sha256(value: unknown): string | null {
  const normalized = String(value || '').trim().toLowerCase()
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null
}

function dateOnly(value: unknown): string | null {
  const normalized = String(value || '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null
}

function primaryCode(codes: string[]): string {
  const priority = [
    'P46_BATCH_IDENTITY_MISMATCH',
    'P46_BATCH_NOT_FOUND',
    'P46_PUBLICATION_INVALID',
    'ARCHIVE_SIGNATURE_INVALID',
    'ARCHIVE_TRACEABILITY_INVALID',
    'ARCHIVE_DATE_INVALID',
  ]
  return priority.find(code => codes.includes(code)) || codes[0] || 'ARCHIVE_INTEGRITY_VALID'
}

/** 只计算完整性，不修改不可变归档。 */
export function evaluateReportArchiveIntegrity(
  database: Database.Database,
  archive: Record<string, any>,
): ReportArchiveIntegrity {
  const payload = parseObject(archive.payload)
  const storedTraceability = parseObject(archive.traceability)
  const traceability = Object.keys(storedTraceability).length
    ? storedTraceability
    : parseObject(payload.traceability)
  const publishedFacts = parseObject(traceability.publishedFacts)
  const archivedBatchId = Number.isInteger(Number(publishedFacts.batchId)) && Number(publishedFacts.batchId) > 0
    ? Number(publishedFacts.batchId) : null
  const archivedSha = sha256(publishedFacts.batchSha256)
  const archivedBusinessDate = dateOnly(publishedFacts.businessDate)
  const reasons: string[] = []
  const codes: string[] = []
  const add = (code: string, reason: string) => {
    codes.push(code)
    reasons.push(reason)
  }

  if (!archivedBatchId || !archivedSha || !archivedBusinessDate) {
    add('ARCHIVE_TRACEABILITY_INVALID', '归档缺少有效的P46批次ID、SHA256或业务日期')
  }
  const reportDate = dateOnly(archive.report_date || payload.reportDate)
  if (!reportDate || (archivedBusinessDate && (reportDate < archivedBusinessDate
    || reportDate.slice(0, 7) !== archivedBusinessDate.slice(0, 7)))) {
    add('ARCHIVE_DATE_INVALID', '归档日期与绑定的P46业务月份不一致')
  }

  const generationSignature = sha256(traceability.generationSignature)
  if (!generationSignature) {
    add('ARCHIVE_SIGNATURE_INVALID', '归档缺少有效生成签名')
  } else {
    const { generationSignature: _signature, ...evidenceCore } = traceability
    const calculated = crypto.createHash('sha256').update(JSON.stringify({
      summary: parseObject(payload.summary),
      sections: Array.isArray(payload.sections) ? payload.sections : [],
      evidenceCore,
    })).digest('hex')
    if (calculated !== generationSignature) add('ARCHIVE_SIGNATURE_INVALID', '归档内容与生成签名不一致')
  }

  let current: any = null
  if (archivedBatchId) {
    current = database.prepare(`SELECT id,business_date,batch_sha256,status,published_at
      FROM data_ingestion_batches WHERE id=?`).get(archivedBatchId) as any || null
    if (!current) {
      add('P46_BATCH_NOT_FOUND', `归档绑定的P46批次${archivedBatchId}已不在当前正式事实链`)
    } else if (archivedSha !== sha256(current.batch_sha256)
      || archivedBusinessDate !== dateOnly(current.business_date)) {
      add('P46_BATCH_IDENTITY_MISMATCH', `P46批次${archivedBatchId}的SHA256或业务日期已与归档记录不一致`)
    }
  }

  if (current) {
    const publication = database.prepare(`SELECT business_date,backup_sha256,payment_rows,snapshot_rows,
        collection_rows,published_at
      FROM data_ingestion_publications WHERE batch_id=?`).get(current.id) as any || null
    const counts = database.prepare(`SELECT
        SUM(CASE WHEN entity_type='payment_center' THEN 1 ELSE 0 END) payment_rows,
        SUM(CASE WHEN entity_type='daily_snapshot' THEN 1 ELSE 0 END) snapshot_rows,
        SUM(CASE WHEN entity_type='collection_center' THEN 1 ELSE 0 END) collection_rows
      FROM data_ingestion_rows WHERE batch_id=?`).get(current.id) as any
    const formal = current.status === 'published'
      && Boolean(sha256(current.batch_sha256)) && Boolean(String(current.published_at || '').trim())
      && publication && publication.business_date === current.business_date
      && Boolean(sha256(publication.backup_sha256)) && Boolean(String(publication.published_at || '').trim())
      && Number(publication.payment_rows) > 0
      && Number(publication.collection_rows) === OFFICIAL_COLLECTION_CENTER_COUNT
      && Number(publication.payment_rows) === Number(counts?.payment_rows || 0)
      && Number(publication.snapshot_rows) === Number(counts?.snapshot_rows || 0)
      && Number(publication.collection_rows) === Number(counts?.collection_rows || 0)
    if (!formal) add('P46_PUBLICATION_INVALID', `P46批次${current.id}未通过正式发布回执与行数复核`)
  }

  return {
    state: reasons.length ? 'invalid' : 'valid',
    valid: reasons.length === 0,
    code: reasons.length ? primaryCode(codes) : 'ARCHIVE_INTEGRITY_VALID',
    reasons,
    binding: {
      archived: { batchId: archivedBatchId, batchSha256: archivedSha, businessDate: archivedBusinessDate },
      current: {
        batchId: current ? Number(current.id) : null,
        batchSha256: current ? sha256(current.batch_sha256) : null,
        businessDate: current ? dateOnly(current.business_date) : null,
      },
    },
  }
}

export function summarizeReportArchiveIntegrity(
  database: Database.Database,
  rows?: Array<Record<string, any>>,
) {
  const archives = rows || database.prepare(`SELECT id,report_date,payload,traceability
    FROM report_archives ORDER BY id`).all() as Array<Record<string, any>>
  const evaluations = archives.map(row => ({
    id: Number(row.id),
    reportDate: String(row.report_date || ''),
    integrity: evaluateReportArchiveIntegrity(database, row),
  }))
  const validRows = evaluations.filter(row => row.integrity.valid)
  const invalidRows = evaluations.filter(row => !row.integrity.valid)
  const latestValidReportDate = validRows.map(row => row.reportDate).sort().at(-1) || null
  const state = !evaluations.length ? 'empty' : !invalidRows.length ? 'ready' : validRows.length ? 'partial' : 'invalid'
  return {
    state,
    count: evaluations.length,
    validCount: validRows.length,
    invalidCount: invalidRows.length,
    latestReportDate: latestValidReportDate,
    latestValidReportDate,
    invalidArchiveIds: invalidRows.map(row => row.id),
    message: !evaluations.length
      ? '尚未生成经营归档。'
      : invalidRows.length
        ? `共${evaluations.length}个归档，其中${invalidRows.length}个血缘失效；失效归档仅保留审计，不得作为正式经营事实。`
        : `已生成${evaluations.length}个血缘有效、可追溯且不可变的经营归档。`,
  }
}
