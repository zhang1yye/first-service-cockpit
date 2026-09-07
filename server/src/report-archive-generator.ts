import crypto from 'node:crypto'
import db from './db.js'
import { logOperationStrict } from './audit.js'
import { latestDirectoryBatch } from './project-directory.js'
import { OFFICIAL_COLLECTION_CENTER_COUNT, normalizeCollectionCenter } from './collection-quality.js'
import { nextArchiveVersion } from './report-closure.js'
import { formalP46PublicationPredicate } from './formal-p46-publication.js'
import { summarizeReportArchiveIntegrity } from './report-archive-integrity.js'

const KNOWN_AREAS = ['朝阳片区', '京东片区', '海淀片区', '顺平片区', '河北片区', '辽宁片区']
const UNKNOWN_PROJECT_OPERATING_FIELDS = [
  'annual_income', 'annual_cost', 'ytd_income', 'ytd_cost', 'quality_score',
  'safety_incidents', 'customer_satisfaction', 'complaint_count',
]

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function sumKnown(rows: any[], field: string): number | null {
  const values = rows.map(row => optionalNumber(row[field])).filter((value): value is number => value !== null)
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null
}

function parseRows(batchId: number, entityType: string): any[] {
  return (db.prepare(`SELECT source_key,canonical_key,payload FROM data_ingestion_rows
    WHERE batch_id=? AND entity_type=? ORDER BY id`).all(batchId, entityType) as any[]).map(row => {
      try { return { ...JSON.parse(row.payload || '{}'), sourceKey: row.source_key, canonicalKey: row.canonical_key } }
      catch { throw new Error(`P46批次${batchId}的${entityType}行JSON无效`) }
    })
}

function weightedOfficialCollectionRate(rows: any[]): number | null {
  const eligible = rows.filter(row => Number(row.receivable) > 0)
  if (!eligible.length || eligible.some(row => optionalNumber(row.collectionRate) === null)) return null
  const denominator = eligible.reduce((sum, row) => sum + Number(row.receivable), 0)
  return denominator > 0
    ? eligible.reduce((sum, row) => sum + Number(row.receivable) * Number(row.collectionRate), 0) / denominator
    : null
}

function latestPublishedFactBatch(reportDate: string): any | null {
  const formalPublication = formalP46PublicationPredicate('b')
  return db.prepare(`SELECT b.id,b.business_date,b.extracted_at,b.published_at,b.batch_sha256,b.source_files
    FROM data_ingestion_batches b
    WHERE b.status='published' AND b.business_date<=?
      AND length(b.batch_sha256)=64 AND COALESCE(b.published_at,'')<>''
      AND ${formalPublication}
      AND EXISTS (SELECT 1 FROM data_ingestion_rows p WHERE p.batch_id=b.id AND p.entity_type='payment_center')
      AND EXISTS (SELECT 1 FROM data_ingestion_rows c WHERE c.batch_id=b.id AND c.entity_type='collection_center')
    ORDER BY b.business_date DESC,b.id DESC LIMIT 1`).get(reportDate) as any || null
}

function archiveStatus() {
  return summarizeReportArchiveIntegrity(db)
}

export function reportArchiveStatus() { return archiveStatus() }

export function generateVerifiedReportArchive(req: any, input: {
  area: string
  version: 'leader' | 'operation'
  reportDate: string
}) {
  const area = input.area === '全部' ? '华北' : input.area
  if (!['华北', ...KNOWN_AREAS].includes(area)) throw new Error('归档范围不是有效的华北片区')
  if (!['leader', 'operation'].includes(input.version)) throw new Error('version仅支持leader或operation')
  if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(input.reportDate)
    || Number.isNaN(new Date(`${input.reportDate}T00:00:00Z`).getTime())
    || new Date(`${input.reportDate}T00:00:00Z`).toISOString().slice(0, 10) !== input.reportDate) {
    throw new Error('reportDate必须为有效的YYYY-MM-DD日期')
  }

  const directoryBatch = latestDirectoryBatch(db)
  if (!directoryBatch) throw new Error('尚无权威在管项目档案批次')
  const profiles = db.prepare(`SELECT id,service_center,area,managed_area,movedin_units,property_type
    FROM project_profiles WHERE batch_id=?${area === '华北' ? '' : ' AND area=?'} ORDER BY area,service_center`)
    .all(directoryBatch.id, ...(area === '华北' ? [] : [area])) as any[]
  if (!profiles.length) throw new Error(`${area}尚无权威在管项目档案`)

  const factBatch = latestPublishedFactBatch(input.reportDate)
  if (!factBatch) throw new Error(`${input.reportDate}及之前尚无同时包含正式回款和官方收缴明细的已发布P46批次`)
  if (String(factBatch.business_date).slice(0, 7) !== input.reportDate.slice(0, 7)) {
    throw new Error(`${input.reportDate.slice(0, 7)}尚无同月正式回款和官方收缴事实，禁止用${factBatch.business_date}旧事实生成新月归档`)
  }
  const allPayments = parseRows(factBatch.id, 'payment_center')
  const allCollections = parseRows(factBatch.id, 'collection_center')
  if (allCollections.length !== OFFICIAL_COLLECTION_CENTER_COUNT) {
    throw new Error(`P46批次${factBatch.id}官方收缴范围应为${OFFICIAL_COLLECTION_CENTER_COUNT}条，当前${allCollections.length}条`)
  }
  const collectionKeys = allCollections.map(row => normalizeCollectionCenter(row.center)).filter(Boolean)
  if (collectionKeys.length !== allCollections.length || new Set(collectionKeys).size !== allCollections.length) {
    throw new Error(`P46批次${factBatch.id}官方收缴中心存在空值或重复`)
  }
  if (allCollections.some(row => optionalNumber(row.receivable) === null || Number(row.receivable) < 0
    || optionalNumber(row.received) === null || Number(row.received) < 0
    || optionalNumber(row.collectionRate) === null || Number(row.collectionRate) < 0 || Number(row.collectionRate) > 1)) {
    throw new Error(`P46批次${factBatch.id}官方收缴金额或收缴率非法`)
  }
  if (allPayments.some(row => !String(row.center || '').trim()
    || optionalNumber(row.annual_budget) === null || optionalNumber(row.cumulative_budget) === null
    || optionalNumber(row.cumulative_executed) === null)) {
    throw new Error(`P46批次${factBatch.id}回款明细存在关键字段缺失`)
  }

  const payments = area === '华北' ? allPayments : allPayments.filter(row => row.area === area)
  const collections = area === '华北' ? allCollections : allCollections.filter(row => row.area === area)
  const annualBudget = sumKnown(payments, 'annual_budget')
  const cumulativeBudget = sumKnown(payments, 'cumulative_budget')
  const cumulativeExecuted = sumKnown(payments, 'cumulative_executed')
  const samePeriod = payments.length && payments.every(row => optionalNumber(row.same_period) !== null)
    ? sumKnown(payments, 'same_period') : null
  const collectionReceivable = sumKnown(collections, 'receivable')
  const collectionReceived = sumKnown(collections, 'received')
  const collectionRate = weightedOfficialCollectionRate(collections)
  const managedArea = sumKnown(profiles, 'managed_area')
  const movedinUnits = sumKnown(profiles, 'movedin_units')

  const summary = {
    project_count: profiles.length,
    managed_area: managedArea,
    movedin_units: movedinUnits,
    annual_budget: annualBudget,
    cumulative_budget: cumulativeBudget,
    cumulative_executed: cumulativeExecuted,
    same_period: samePeriod,
    annual_execution_rate: annualBudget && cumulativeExecuted !== null ? cumulativeExecuted / annualBudget : null,
    budget_execution_rate: cumulativeBudget && cumulativeExecuted !== null ? cumulativeExecuted / cumulativeBudget : null,
    total_receivable: collectionReceivable,
    total_received: collectionReceived,
    collection_outstanding: collectionReceivable !== null && collectionReceived !== null ? collectionReceivable - collectionReceived : null,
    official_collection_rate: collectionRate,
    collectionRate: collectionRate === null ? null : collectionRate * 100,
    ytd_income: null,
    ytd_cost: null,
    profitRate: null,
    avg_quality: null,
    avg_satisfaction: null,
    total_complaints: null,
    total_incidents: null,
  }
  const editionLabel = input.version === 'leader' ? '领导版' : '经营版'
  const month = input.reportDate.slice(0, 7)
  const title = `${area}${month}${editionLabel}经营数据归档`
  const sections = [
    { title: '在管项目目录', content: `权威在管项目${profiles.length}个，在管面积${managedArea ?? '—'}平方米，已入住户数${movedinUnits ?? '—'}。` },
    { title: '回款执行', content: `年度预算${annualBudget ?? '—'}万元，累计预算${cumulativeBudget ?? '—'}万元，累计执行${cumulativeExecuted ?? '—'}万元，同期执行${samePeriod ?? '—'}万元。` },
    { title: '官方收缴', content: `官方口径应收${collectionReceivable ?? '—'}万元，实收${collectionReceived ?? '—'}万元，按项目应收加权收缴率${collectionRate === null ? '—' : `${(collectionRate * 100).toFixed(2)}%`}。` },
    { title: '数据范围', content: '当前系统不接入项目收入、成本、利润率、品质、安全、满意度和投诉等经营指标；本归档不以0补位，不生成相应经营结论。' },
  ]
  const evidenceCore = {
    reportDate: input.reportDate,
    reportMonth: month,
    area,
    edition: input.version,
    projectDirectory: {
      batchId: directoryBatch.id,
      sourceFile: String(directoryBatch.source_file || '').split(/[\\/]/).pop() || '',
      sourceSha256: directoryBatch.source_sha256,
      sourceSheet: directoryBatch.source_sheet,
      importedAt: directoryBatch.imported_at,
      profileCount: profiles.length,
    },
    publishedFacts: {
      batchId: Number(factBatch.id),
      batchSha256: factBatch.batch_sha256,
      businessDate: factBatch.business_date,
      extractedAt: factBatch.extracted_at,
      publishedAt: factBatch.published_at,
      paymentRows: payments.length,
      officialCollectionRows: collections.length,
    },
    formulas: {
      official_collection_rate: 'SUM(receivable * collectionRate) / SUM(receivable), receivable > 0',
      collectionRate: 'official_collection_rate * 100',
      collectionRateField: 'gatheringCurrentYearRecedRate',
      paymentTotals: 'SUM(P46 payment_center fields)',
    },
    metricUnits: { official_collection_rate: 'ratio_0_to_1', collectionRate: 'percent_0_to_100', amounts: '万元' },
    knownFields: Object.entries(summary).filter(([, value]) => value !== null).map(([key]) => key),
    unavailableFields: UNKNOWN_PROJECT_OPERATING_FIELDS,
  }
  const generationSignature = crypto.createHash('sha256').update(JSON.stringify({ summary, sections, evidenceCore })).digest('hex')
  const traceability = { ...evidenceCore, generationSignature }
  const payload = {
    reportDate: input.reportDate,
    area,
    selectedVersion: input.version,
    title,
    summary,
    sections,
    completeness: {
      state: 'partial_verified',
      knownFields: evidenceCore.knownFields,
      unavailableFields: evidenceCore.unavailableFields,
      message: '已归档权威项目目录、正式回款与官方收缴事实；未接入指标保持未知。',
    },
    traceability,
  }

  const existing = db.prepare(`SELECT * FROM report_archives
    WHERE report_date=? AND area=? AND version=? ORDER BY archive_version DESC,id DESC LIMIT 1`)
    .get(input.reportDate, area, input.version) as any
  if (existing) {
    let existingTrace: any = {}
    try { existingTrace = JSON.parse(existing.traceability || '{}') } catch {}
    if (existingTrace.generationSignature === generationSignature) {
      db.transaction(() => logOperationStrict(req, '确认经营归档幂等状态', `report_archive:${existing.id}`, {
        area, version: input.version, reportDate: input.reportDate, generationSignature,
      }))()
      return {
        success: true, idempotent: true, id: Number(existing.id), archiveVersion: Number(existing.archive_version),
        status: archiveStatus(), traceability, payload: JSON.parse(existing.payload || '{}'),
      }
    }
  }

  const createdAt = new Date().toISOString()
  const result = db.transaction(() => {
    const archiveVersion = nextArchiveVersion(db as any, input.reportDate, area, input.version)
    const immutablePayload = { ...payload, archive: { archiveVersion, archivedBy: req.user?.username || '', archivedAt: createdAt } }
    const insert = db.prepare(`INSERT INTO report_archives
      (report_date,area,version,archive_version,snapshot_month,title,summary,payload,traceability,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.reportDate, area, input.version, archiveVersion, month, title,
        `权威项目${profiles.length}个；回款与收缴事实日期${factBatch.business_date}；未接入指标保持未知。`,
        JSON.stringify(immutablePayload), JSON.stringify(traceability), req.user?.username || '', createdAt,
      )
    const id = Number(insert.lastInsertRowid)
    logOperationStrict(req, '生成可追溯经营归档', `report_archive:${id}`, {
      area, version: input.version, reportDate: input.reportDate, archiveVersion,
      generationSignature, projectDirectoryBatchId: directoryBatch.id, factBatchId: factBatch.id,
      unavailableFields: UNKNOWN_PROJECT_OPERATING_FIELDS,
    })
    return { id, archiveVersion, immutablePayload }
  })()
  return {
    success: true, idempotent: false, id: result.id, archiveVersion: result.archiveVersion,
    status: archiveStatus(), traceability, payload: result.immutablePayload,
  }
}
