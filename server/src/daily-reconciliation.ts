import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import { SERVICE_CENTER_MERGE_GROUPS } from './service-center-merge-groups.js'

export const DAILY_REPORT_ID = '810ca5a0-b239-466b-85c2-386373244c8e'
export const DAILY_REPORT_REGION = '华北地区'
export const MAX_CONFIRMABLE_TOTAL_DIFFERENCE = 0.05
const TOTAL_MATCH_TOLERANCE = 0.011
const DAILY_MERGE_GROUPS = SERVICE_CENTER_MERGE_GROUPS

export interface DailyReconciliationPayload {
  schemaVersion: 1
  businessDate: string
  extractedAt: string
  reportId: string
  region: string
  officialTotal: number
  rows: Array<{ center: string; dailyCollection: number }>
}

export interface DailyReconciliationBatch {
  id: number
  businessDate: string
  status: 'previewed' | 'published' | 'blocked'
  publishable: boolean
  validationErrors: string[]
  officialTotal: number
  detailTotal: number
  sourceRowCount: number
  publicationMode: 'snapshot_revision' | 'daily_only'
  zeroValueAudit: 'requires_business_confirmation' | 'business_confirmed' | 'not_applicable'
  totalDifference: number
  totalDifferenceAudit: 'requires_business_confirmation' | 'business_confirmed' | 'not_applicable'
  payloadSha256: string
}

type SnapshotRow = {
  center: string
  business_date: string | null
  quality_status: string | null
  source_status: string | null
  daily_collection: number | null
  cumulative_budget: number | null
  cumulative_executed: number | null
  last_validated_at: string | null
  field_provenance: string | null
}
type DailyRow = { center: string; dailyCollection: number }

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function hasAtMostTwoDecimalPlaces(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) <= 1e-7
}

function cents(value: number): number {
  return Math.round(value * 100)
}

function shanghaiBusinessDate(value: string): string | null {
  const instant = new Date(value)
  if (!Number.isFinite(instant.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant)
  const read = (type: string) => parts.find((part) => part.type === type)?.value || ''
  return `${read('year')}-${read('month')}-${read('day')}`
}

function payloadHash(payload: DailyReconciliationPayload): string {
  const canonical = {
    schemaVersion: payload.schemaVersion,
    businessDate: payload.businessDate,
    reportId: payload.reportId,
    region: payload.region,
    officialTotal: payload.officialTotal,
    rows: [...payload.rows]
      .map((row) => ({ center: row.center.trim(), dailyCollection: row.dailyCollection }))
      .sort((a, b) => a.center.localeCompare(b.center, 'zh-CN')),
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function mergeSourceRows(rows: DailyRow[], errors: string[]): DailyRow[] {
  if (rows.length !== 61) errors.push(`原始日报中心必须为61条，实际${rows.length}条`)
  const values = new Map(rows.map((row) => [row.center, row.dailyCollection]))
  for (const group of DAILY_MERGE_GROUPS) {
    const missing = group.sources.filter((source) => !values.has(source))
    if (missing.length > 0) {
      errors.push(`合并组不完整: ${missing.join(',')}`)
      continue
    }
    const merged = round2(group.sources.reduce((sum, source) => sum + values.get(source)!, 0))
    for (const source of group.sources) values.delete(source)
    values.set(group.target, merged)
  }
  const canonicalRows = [...values].map(([center, dailyCollection]) => ({ center, dailyCollection }))
  if (canonicalRows.length !== 56) errors.push(`规范中心必须为56条，实际${canonicalRows.length}条`)
  return canonicalRows
}

function validatePayload(database: Database.Database, payload: DailyReconciliationPayload): {
  errors: string[]
  detailTotal: number
  snapshots: SnapshotRow[]
  canonicalRows: DailyRow[]
  publicationMode: 'snapshot_revision' | 'daily_only'
} {
  const errors: string[] = []
  if (payload.schemaVersion !== 1) errors.push('schemaVersion必须为1')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.businessDate)) errors.push('businessDate必须为YYYY-MM-DD')
  const extractedBusinessDate = shanghaiBusinessDate(payload.extractedAt)
  if (!extractedBusinessDate) errors.push('extractedAt不是有效时间')
  else if (/^\d{4}-\d{2}-\d{2}$/.test(payload.businessDate) && payload.businessDate >= extractedBusinessDate) errors.push('业务日必须早于提取日')
  if (payload.reportId !== DAILY_REPORT_ID) errors.push('reportId不是受控回款日报')
  if (payload.region !== DAILY_REPORT_REGION) errors.push('region必须为华北地区')
  if (!Number.isFinite(payload.officialTotal)) errors.push('officialTotal必须是有限数值')
  else if (!hasAtMostTwoDecimalPlaces(payload.officialTotal)) errors.push('officialTotal最多两位小数')
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) errors.push('rows不能为空')

  const normalized = payload.rows.map((row) => ({ center: String(row.center || '').trim(), dailyCollection: Number(row.dailyCollection) }))
  const duplicateCenters = normalized.filter((row, index) => normalized.findIndex((candidate) => candidate.center === row.center) !== index)
  if (duplicateCenters.length > 0) errors.push(`存在重复中心: ${[...new Set(duplicateCenters.map((row) => row.center))].join(',')}`)
  if (normalized.some((row) => !row.center || !Number.isFinite(row.dailyCollection))) errors.push('中心名称和日回款必须有效')
  if (normalized.some((row) => Number.isFinite(row.dailyCollection) && !hasAtMostTwoDecimalPlaces(row.dailyCollection))) errors.push('中心日回款最多两位小数')
  const canonicalRows = mergeSourceRows(normalized, errors)

  const snapshots = database.prepare(`
    SELECT center,business_date,quality_status,source_status,daily_collection,cumulative_budget,cumulative_executed,last_validated_at,field_provenance
    FROM daily_snapshots WHERE date=? ORDER BY center
  `).all(payload.businessDate) as SnapshotRow[]
  const snapshotRevision = snapshots.length === 56
    && snapshots.every((row) => row.quality_status === 'verified')
    && snapshots.every((row) => row.source_status === 'available')
    && snapshots.every((row) => row.business_date === payload.businessDate)
  // Cardinality and the coupled quality/source shape identify formal snapshots.
  // A legacy row having only business_date populated is not sufficient evidence.
  const looksLikeFormalSnapshot = snapshots.length === 57 || snapshots.some((row) =>
    row.quality_status === 'verified' || row.source_status === 'available')
  const publicationMode = snapshotRevision || looksLikeFormalSnapshot ? 'snapshot_revision' : 'daily_only'
  const expectedCenters = publicationMode === 'snapshot_revision'
    ? snapshots.map((row) => row.center).sort()
    : (database.prepare('SELECT center FROM payment_centers ORDER BY center').all() as Array<{ center: string }>).map(row => row.center).sort()
  const actualCenters = canonicalRows.map((row) => row.center).sort()
  const missing = expectedCenters.filter((center) => !actualCenters.includes(center))
  const extra = actualCenters.filter((center) => !expectedCenters.includes(center))
  if (snapshots.length === 0) errors.push('目标业务日不存在正式快照')
  if (publicationMode === 'daily_only' && ![56, 59, 61].includes(snapshots.length)) {
    errors.push(`daily_only历史快照基数必须为56、59或61，实际${snapshots.length}条`)
  }
  if (publicationMode === 'snapshot_revision' && (snapshots.length !== 56 || snapshots.some((row) => row.quality_status !== 'verified'))) {
    errors.push('正式快照必须恰好56条且全部quality_status=verified')
  }
  if (publicationMode === 'snapshot_revision' && (snapshots.length !== 56 || snapshots.some((row) => row.source_status !== 'available'))) {
    errors.push('正式快照必须恰好56条且全部source_status=available')
  }
  if (publicationMode === 'snapshot_revision' && (snapshots.length !== 56 || snapshots.some((row) => row.business_date !== payload.businessDate))) {
    errors.push('正式快照必须恰好56条且business_date等于目标业务日')
  }
  if (missing.length > 0) errors.push(`缺少快照中心: ${missing.join(',')}`)
  if (extra.length > 0) errors.push(`存在未知中心: ${extra.join(',')}`)

  const detailCents = normalized.reduce((sum, row) => sum + (Number.isFinite(row.dailyCollection) ? cents(row.dailyCollection) : 0), 0)
  const detailTotal = detailCents / 100
  const totalDifference = Number.isFinite(payload.officialTotal) ? (cents(payload.officialTotal) - detailCents) / 100 : Number.NaN
  if (Number.isFinite(payload.officialTotal) && Math.abs(totalDifference) > MAX_CONFIRMABLE_TOTAL_DIFFERENCE + 0.001) {
    errors.push(`官方汇总${round2(payload.officialTotal).toFixed(2)}与中心明细${detailTotal.toFixed(2)}差异${Math.abs(totalDifference).toFixed(2)}万元，超过可确认上限${MAX_CONFIRMABLE_TOTAL_DIFFERENCE.toFixed(2)}万元`)
  }
  return { errors, detailTotal, snapshots, canonicalRows, publicationMode }
}

export function previewDailyReconciliation(
  database: Database.Database,
  payload: DailyReconciliationPayload,
  actor: string,
): DailyReconciliationBatch {
  const { errors, detailTotal, snapshots, canonicalRows, publicationMode } = validatePayload(database, payload)
  const businessHash = payloadHash(payload)
  const currentHead = database.prepare(`
        SELECT current.* FROM daily_collection_reconciliations current
        WHERE current.business_date=? AND current.status='published'
          AND NOT EXISTS (
            SELECT 1 FROM daily_collection_reconciliations successor
            WHERE successor.business_date=current.business_date
              AND successor.status='published' AND successor.supersedes_id=current.id
          )
      `).get(payload.businessDate) as any
  if (errors.length === 0 && currentHead?.business_payload_sha256 === businessHash
      && hasCurrentPublishedDailyReconciliation(database, payload.businessDate)) return toBatch(currentHead)
  const hash = errors.length === 0
    ? currentHead
      ? crypto.createHash('sha256').update(`${businessHash}\0supersedes\0${currentHead.id}`).digest('hex')
      : businessHash
    : crypto.createHash('sha256').update(`${businessHash}\0${payload.extractedAt}\0${errors.join('\0')}`).digest('hex')
  const existing = database.prepare('SELECT * FROM daily_collection_reconciliations WHERE payload_sha256=?').get(hash) as any
  if (existing) {
    if (existing.status !== 'previewed' || errors.length > 0) return toBatch(existing)
    database.transaction(() => {
      database.prepare('DELETE FROM daily_collection_revision_rows WHERE reconciliation_id=?').run(existing.id)
      const snapshotsByCenter = new Map(snapshots.map((row) => [row.center, row]))
      const statement = database.prepare(`
        INSERT INTO daily_collection_revision_rows(
          reconciliation_id,center,old_daily_collection,new_daily_collection,old_cumulative_budget,
          old_cumulative_executed,old_last_validated_at,old_field_provenance
        ) VALUES(?,?,?,?,?,?,?,?)
      `)
      for (const row of canonicalRows) {
        const snapshot = publicationMode === 'snapshot_revision' ? snapshotsByCenter.get(row.center.trim()) : undefined
        statement.run(existing.id,row.center.trim(),snapshot?.daily_collection ?? null,row.dailyCollection,
          snapshot?.cumulative_budget ?? null,snapshot?.cumulative_executed ?? null,snapshot?.last_validated_at ?? null,snapshot?.field_provenance || '{}')
      }
      database.prepare('UPDATE daily_collection_reconciliations SET supersedes_id=? WHERE id=?').run(currentHead?.id || null, existing.id)
    })()
    return toBatch(database.prepare('SELECT * FROM daily_collection_reconciliations WHERE id=?').get(existing.id))
  }
  const status = errors.length === 0 ? 'previewed' : 'blocked'
  const insert = database.transaction(() => {
    const result = database.prepare(`
      INSERT INTO daily_collection_reconciliations(
        business_date,extracted_at,report_id,region,official_total,detail_total,source_row_count,
        publication_mode,payload_sha256,business_payload_sha256,status,validation_errors,supersedes_id,created_by
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      payload.businessDate,
      payload.extractedAt,
      payload.reportId,
      payload.region,
      payload.officialTotal,
      detailTotal,
      payload.rows.length,
      publicationMode,
      hash,
      businessHash,
      status,
      JSON.stringify(errors),
      currentHead?.id || null,
      actor,
    )
    const id = Number(result.lastInsertRowid)
    if (errors.length === 0) {
      const snapshotsByCenter = new Map(snapshots.map((row) => [row.center, row]))
      const statement = database.prepare(`
        INSERT INTO daily_collection_revision_rows(
          reconciliation_id,center,old_daily_collection,new_daily_collection,old_cumulative_budget,
          old_cumulative_executed,old_last_validated_at,old_field_provenance
        ) VALUES(?,?,?,?,?,?,?,?)
      `)
      for (const row of canonicalRows) {
        const snapshot = publicationMode === 'snapshot_revision' ? snapshotsByCenter.get(row.center.trim()) : undefined
        statement.run(
          id,
          row.center.trim(),
          snapshot?.daily_collection ?? null,
          row.dailyCollection,
          snapshot?.cumulative_budget ?? null,
          snapshot?.cumulative_executed ?? null,
          snapshot?.last_validated_at ?? null,
          snapshot?.field_provenance || '{}',
        )
      }
    }
    return id
  })()
  const created = database.prepare('SELECT * FROM daily_collection_reconciliations WHERE id=?').get(insert) as any
  return toBatch(created)
}

export function publishDailyReconciliation(
  database: Database.Database,
  batchId: number,
  actor: string,
  confirmNote: string,
  zeroValueConfirmation?: { confirmed: boolean; note: string },
  totalDifferenceConfirmation?: { confirmed: boolean; note: string },
): DailyReconciliationBatch {
  const publish = database.transaction(() => {
    const batch = database.prepare('SELECT * FROM daily_collection_reconciliations WHERE id=?').get(batchId) as any
    if (!batch) throw new Error('复核批次不存在')
    if (batch.status === 'published') return batch
    if (confirmNote.trim().length < 5) throw new Error('发布说明至少5个字符')
    if (batch.status !== 'previewed' || JSON.parse(batch.validation_errors || '[]').length > 0) throw new Error('复核批次不可发布')
    const rows = database.prepare('SELECT * FROM daily_collection_revision_rows WHERE reconciliation_id=? ORDER BY center').all(batchId) as any[]
    const snapshots = database.prepare(`
      SELECT center,business_date,quality_status,source_status,daily_collection,cumulative_budget,cumulative_executed,last_validated_at,field_provenance
      FROM daily_snapshots WHERE date=? ORDER BY center
    `).all(batch.business_date) as SnapshotRow[]
    if (Number(batch.detail_total) === 0) {
      const zeroNote = String(zeroValueConfirmation?.note || '').trim()
      if (zeroValueConfirmation?.confirmed !== true || zeroNote.length < 10) {
        throw new Error('全零官方日报必须由业务显式确认并提供至少10个字符的审计说明')
      }
    }
    if (!hasAtMostTwoDecimalPlaces(Number(batch.official_total)) || !hasAtMostTwoDecimalPlaces(Number(batch.detail_total))) {
      throw new Error('官方汇总与明细金额精度异常，禁止发布')
    }
    const totalDifference = (cents(Number(batch.official_total)) - cents(Number(batch.detail_total))) / 100
    if (Math.abs(totalDifference) > TOTAL_MATCH_TOLERANCE) {
      const differenceNote = String(totalDifferenceConfirmation?.note || '').trim()
      if (Math.abs(totalDifference) > MAX_CONFIRMABLE_TOTAL_DIFFERENCE + 0.001) {
        throw new Error(`官方汇总与明细差异${Math.abs(totalDifference).toFixed(2)}万元超过可确认上限`)
      }
      if (totalDifferenceConfirmation?.confirmed !== true || differenceNote.length < 10) {
        throw new Error('官方汇总与明细差异必须由业务显式确认并提供至少10个字符的审计说明')
      }
    }
    if (batch.publication_mode === 'daily_only') {
      const existingDate = database.prepare('SELECT COUNT(*) AS n FROM daily_snapshots WHERE date=?').get(batch.business_date) as { n: number }
      if (![56, 59, 61].includes(Number(existingDate.n))) throw new Error(`发布前daily_only历史快照基数必须为56、59或61，实际${existingDate.n}条`)
      const centers = database.prepare('SELECT center FROM payment_centers ORDER BY center').all() as Array<{ center: string }>
      if (rows.length !== 56 || centers.length !== 56 || rows.some((row, index) => row.center !== centers[index].center)) {
        throw new Error('发布前规范中心集合已变化')
      }
    } else if (rows.length !== snapshots.length) throw new Error('发布前中心集合已变化')
    const snapshotByCenter = new Map(snapshots.map((row) => [row.center, row]))
    for (const row of batch.publication_mode === 'daily_only' ? [] : rows) {
      const current = snapshotByCenter.get(row.center)
      if (!current) throw new Error(`发布前中心不存在: ${row.center}`)
      if (current.quality_status !== 'verified') throw new Error(`发布前质量状态已变化: ${row.center}`)
      if (current.source_status !== 'available') throw new Error(`发布前来源状态已变化: ${row.center}`)
      if (current.business_date !== batch.business_date) throw new Error(`发布前业务日已变化: ${row.center}`)
      if (current.cumulative_budget !== row.old_cumulative_budget || current.cumulative_executed !== row.old_cumulative_executed) {
        throw new Error(`发布前累计快照已变化: ${row.center}`)
      }
      if (current.daily_collection !== row.old_daily_collection) throw new Error(`发布前日报字段已变化: ${row.center}`)
      if (current.last_validated_at !== row.old_last_validated_at || (current.field_provenance || '{}') !== row.old_field_provenance) {
        throw new Error(`发布前验证元数据已变化: ${row.center}`)
      }
    }
    const update = database.prepare(`
      UPDATE daily_snapshots
      SET daily_collection=?,last_validated_at=?,field_provenance=?
      WHERE date=? AND center=?
    `)
    for (const row of batch.publication_mode === 'daily_only' ? [] : rows) {
      const current = snapshotByCenter.get(row.center)!
      const provenance = parseJsonObject(current.field_provenance)
      provenance.daily_collection = {
        source: 'FineReport回款日报历史专项复核',
        reportId: batch.report_id,
        businessDate: batch.business_date,
        extractedAt: batch.extracted_at,
        dailyReconciliationId: batch.id,
      }
      update.run(row.new_daily_collection, batch.extracted_at, JSON.stringify(provenance), batch.business_date, row.center)
    }
    const publishedHeads = database.prepare(`
      SELECT current.id
      FROM daily_collection_reconciliations current
      WHERE current.business_date=? AND current.status='published'
        AND NOT EXISTS (
          SELECT 1 FROM daily_collection_reconciliations successor
          WHERE successor.business_date=current.business_date
            AND successor.status='published' AND successor.supersedes_id=current.id
        )
      ORDER BY current.id DESC
    `).all(batch.business_date) as Array<{ id: number }>
    if (publishedHeads.length > 1) throw new Error('正式复核版本链存在多个链头')
    const latest = publishedHeads[0]
    if ((batch.supersedes_id || null) !== (latest?.id || null)) throw new Error('正式复核版本链头已变化，请重新预览')
    database.prepare(`
      UPDATE daily_collection_reconciliations
      SET status='published',published_by=?,published_at=datetime('now','localtime'),confirm_note=?,supersedes_id=?,
        zero_value_confirmed=?,zero_value_confirm_note=?,total_difference_confirmed=?,total_difference_confirm_note=?
      WHERE id=?
    `).run(actor, confirmNote.trim(), latest?.id || null, Number(batch.detail_total) === 0 ? 1 : 0,
      Number(batch.detail_total) === 0 ? String(zeroValueConfirmation?.note || '').trim() : '',
      Math.abs(totalDifference) > TOTAL_MATCH_TOLERANCE ? 1 : 0,
      Math.abs(totalDifference) > TOTAL_MATCH_TOLERANCE ? String(totalDifferenceConfirmation?.note || '').trim() : '', batchId)
    return database.prepare('SELECT * FROM daily_collection_reconciliations WHERE id=?').get(batchId) as any
  })()
  return toBatch(publish)
}

export function hasCurrentPublishedDailyReconciliation(database: Database.Database, businessDate: string): boolean {
  const publishedHeads = database.prepare(`
    SELECT current.id,current.source_row_count,current.report_id,current.extracted_at,current.publication_mode,
      current.official_total,current.detail_total,current.zero_value_confirmed,current.total_difference_confirmed
    FROM daily_collection_reconciliations current
    WHERE current.business_date=? AND current.status='published'
      AND NOT EXISTS (
        SELECT 1 FROM daily_collection_reconciliations successor
        WHERE successor.business_date=current.business_date
          AND successor.status='published' AND successor.supersedes_id=current.id
      )
    ORDER BY current.id DESC
  `).all(businessDate) as Array<{ id: number; source_row_count: number; report_id: string; extracted_at: string; publication_mode: string; official_total: number; detail_total: number; zero_value_confirmed: number; total_difference_confirmed: number }>
  if (publishedHeads.length !== 1) return false
  const batch = publishedHeads[0]
  if (Number(batch.source_row_count) !== 61) return false
  if (!hasAtMostTwoDecimalPlaces(Number(batch.official_total)) || !hasAtMostTwoDecimalPlaces(Number(batch.detail_total))) return false
  const totalDifference = Math.abs(cents(Number(batch.official_total)) - cents(Number(batch.detail_total))) / 100
  if (batch.report_id !== DAILY_REPORT_ID || totalDifference > MAX_CONFIRMABLE_TOTAL_DIFFERENCE + 0.001) return false
  if (totalDifference > TOTAL_MATCH_TOLERANCE && Number(batch.total_difference_confirmed) !== 1) return false
  if (Number(batch.detail_total) === 0 && Number(batch.zero_value_confirmed) !== 1) return false
  if (batch.publication_mode === 'daily_only') {
    const status = database.prepare(`SELECT COUNT(*) AS revision_count,
        COUNT(DISTINCT revision.center) AS center_count,
        SUM(revision.new_daily_collection) AS revision_total,
        SUM(CASE WHEN payment.center IS NULL THEN 1 ELSE 0 END) AS unknown_centers,
        SUM(CASE WHEN revision.old_daily_collection IS NOT NULL
          OR revision.old_cumulative_budget IS NOT NULL OR revision.old_cumulative_executed IS NOT NULL
          OR revision.old_last_validated_at IS NOT NULL OR revision.old_field_provenance IS NOT '{}'
          THEN 1 ELSE 0 END) AS invalid_lineage
      FROM daily_collection_revision_rows revision
      LEFT JOIN payment_centers payment ON payment.center=revision.center
      WHERE revision.reconciliation_id=?`).get(batch.id) as any
    return Number(status.revision_count) === 56 && Number(status.center_count) === 56
      && Number(status.unknown_centers) === 0 && Number(status.invalid_lineage) === 0
      && Math.abs(Number(status.revision_total) - Number(batch.detail_total)) <= 0.011
  }
  if (batch.publication_mode !== 'snapshot_revision') return false
  const currentSnapshots = database.prepare('SELECT COUNT(*) AS count FROM daily_snapshots WHERE date=?').get(businessDate) as { count: number }
  if (Number(currentSnapshots.count) !== 56) return false
  const status = database.prepare(`
    SELECT
      COUNT(revision.id) AS revision_count,
      COUNT(snapshot.id) AS snapshot_count,
      SUM(CASE WHEN snapshot.id IS NULL
        OR snapshot.daily_collection IS NOT revision.new_daily_collection
        OR snapshot.cumulative_budget IS NOT revision.old_cumulative_budget
        OR snapshot.cumulative_executed IS NOT revision.old_cumulative_executed
        OR snapshot.quality_status IS NOT 'verified'
        OR snapshot.source_status IS NOT 'available'
        OR snapshot.business_date IS NOT snapshot.date
        OR snapshot.last_validated_at IS NOT ?
        THEN 1
        WHEN json_valid(COALESCE(snapshot.field_provenance,'')) <> 1 THEN 1
        WHEN json_extract(snapshot.field_provenance,'$.daily_collection.reportId') IS NOT ?
          OR json_extract(snapshot.field_provenance,'$.daily_collection.businessDate') IS NOT ?
          OR json_extract(snapshot.field_provenance,'$.daily_collection.extractedAt') IS NOT ?
          OR json_extract(snapshot.field_provenance,'$.daily_collection.dailyReconciliationId') IS NOT ?
        THEN 1 ELSE 0 END) AS mismatches
    FROM daily_collection_revision_rows revision
    LEFT JOIN daily_snapshots snapshot ON snapshot.date=? AND snapshot.center=revision.center
    WHERE revision.reconciliation_id=?
  `).get(batch.extracted_at, batch.report_id, businessDate, batch.extracted_at, batch.id, businessDate, batch.id) as { revision_count: number; snapshot_count: number; mismatches: number }
  return Number(status.revision_count) === 56 && Number(status.snapshot_count) === 56 && Number(status.mismatches) === 0
}

export function hasCurrentPublishedSnapshotRevision(database: Database.Database, businessDate: string): boolean {
  const heads = database.prepare(`SELECT current.publication_mode
    FROM daily_collection_reconciliations current
    WHERE current.business_date=? AND current.status='published'
      AND NOT EXISTS (SELECT 1 FROM daily_collection_reconciliations successor
        WHERE successor.business_date=current.business_date
          AND successor.supersedes_id=current.id AND successor.status='published')`).all(businessDate) as Array<{ publication_mode: string }>
  return heads.length === 1
    && heads[0].publication_mode === 'snapshot_revision'
    && hasCurrentPublishedDailyReconciliation(database, businessDate)
}

function toBatch(row: any): DailyReconciliationBatch {
  const validationErrors = JSON.parse(row.validation_errors || '[]') as string[]
  const totalDifference = (cents(Number(row.official_total)) - cents(Number(row.detail_total))) / 100
  return {
    id: Number(row.id),
    businessDate: row.business_date,
    status: row.status,
    publishable: row.status === 'previewed' && validationErrors.length === 0,
    validationErrors,
    officialTotal: Number(row.official_total),
    detailTotal: Number(row.detail_total),
    sourceRowCount: Number(row.source_row_count),
    publicationMode: row.publication_mode || 'snapshot_revision',
    zeroValueAudit: Number(row.detail_total) === 0
      ? Number(row.zero_value_confirmed) === 1 ? 'business_confirmed' : 'requires_business_confirmation'
      : 'not_applicable',
    totalDifference,
    totalDifferenceAudit: Math.abs(totalDifference) > TOTAL_MATCH_TOLERANCE
      ? Number(row.total_difference_confirmed) === 1 ? 'business_confirmed' : 'requires_business_confirmation'
      : 'not_applicable',
    payloadSha256: row.payload_sha256,
  }
}
