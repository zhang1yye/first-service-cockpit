import { Router } from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import db from '../db.js'
import {
  canAccessServiceCenter,
  hasValidServiceCenterAssignment,
  requireAdmin,
} from '../auth.js'
import { canUseManualBusinessWrites } from '../production-safety.js'
import { logOperationStrict } from '../audit.js'
import { normalizeCollectionCenter, OFFICIAL_COLLECTION_CENTER_COUNT, parseStrictUtf8Json } from '../collection-quality.js'
import { getCollectionDisplayRate, isCollectionCenterExcluded } from '../collection-scope.js'
import { formalP46PublicationPredicate } from '../formal-p46-publication.js'
import {
  applyEffectiveMasterState,
  latestEffectiveMasterChanges,
  SERVICE_CENTER_WITHDRAWN_AREA,
} from '../service-center-master.js'
import { hasRegionWideReadAccess } from '../user-access.js'

const router = Router()
const ALLOWED_AREAS = ['华北汇总', '朝阳片区', '京东片区', '海淀片区', '顺平片区', '河北片区', '辽宁片区'] as const
const P46_TREND_SOURCE = 'p46-official-collection'

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function trendRows() {
  return (db.prepare(`SELECT month AS m,
      "华北汇总", "朝阳片区", "京东片区", "海淀片区", "顺平片区", "河北片区", "辽宁片区",
      quality_status,quality_reason,source,source_status,business_date,last_validated_at,field_provenance
    FROM monthly_trends WHERE quality_status='verified' ORDER BY month ASC LIMIT 120`).all() as any[])
    .map(row => ({ ...row, field_provenance: parseObject(row.field_provenance) }))
}

function trendStatus(rows = trendRows()) {
  const latest = rows.at(-1)
  return {
    state: rows.length ? 'ready' : 'empty',
    count: rows.length,
    verifiedCount: rows.length,
    latestMonth: latest?.m || null,
    source: rows.length ? P46_TREND_SOURCE : null,
    message: rows.length
      ? `已从已发布官方收缴批次生成${rows.length}个月度趋势。`
      : '尚无可用的已验证月度趋势。',
  }
}

function publishedMonthlyCollectionBatches() {
  const formalPublication = formalP46PublicationPredicate('b')
  const newerFormalPublication = formalP46PublicationPredicate('newer')
  return db.prepare(`SELECT b.id,b.business_date,b.extracted_at,b.published_at,b.batch_sha256
    FROM data_ingestion_batches b
    WHERE b.status='published'
      AND length(b.batch_sha256)=64 AND COALESCE(b.published_at,'')<>''
      AND ${formalPublication}
      AND EXISTS (SELECT 1 FROM data_ingestion_rows r WHERE r.batch_id=b.id AND r.entity_type='collection_center')
      AND NOT EXISTS (
        SELECT 1 FROM data_ingestion_batches newer
        WHERE newer.status='published'
          AND length(newer.batch_sha256)=64 AND COALESCE(newer.published_at,'')<>''
          AND ${newerFormalPublication}
          AND substr(newer.business_date,1,7)=substr(b.business_date,1,7)
          AND EXISTS (SELECT 1 FROM data_ingestion_rows nr WHERE nr.batch_id=newer.id AND nr.entity_type='collection_center')
          AND (newer.business_date>b.business_date OR (newer.business_date=b.business_date AND newer.id>b.id))
      )
    ORDER BY b.business_date,b.id`).all() as any[]
}

function publishedDailyCollectionBatches() {
  const formalPublication = formalP46PublicationPredicate('b')
  const newerFormalPublication = formalP46PublicationPredicate('newer')
  return db.prepare(`SELECT b.id,b.business_date,b.extracted_at,b.published_at,b.batch_sha256
    FROM data_ingestion_batches b
    WHERE b.status='published'
      AND length(b.batch_sha256)=64 AND COALESCE(b.published_at,'')<>''
      AND ${formalPublication}
      AND EXISTS (SELECT 1 FROM data_ingestion_rows r WHERE r.batch_id=b.id AND r.entity_type='collection_center')
      AND NOT EXISTS (
        SELECT 1 FROM data_ingestion_batches newer
        WHERE newer.status='published'
          AND length(newer.batch_sha256)=64 AND COALESCE(newer.published_at,'')<>''
          AND ${newerFormalPublication}
          AND newer.business_date=b.business_date
          AND EXISTS (SELECT 1 FROM data_ingestion_rows nr WHERE nr.batch_id=newer.id AND nr.entity_type='collection_center')
          AND newer.id>b.id
      )
    ORDER BY b.business_date,b.id`).all() as any[]
}

function weightedCollectionRate(rows: any[]): number | null {
  const eligible = rows.filter(row => Number(row.receivable) > 0)
  const denominator = eligible.reduce((sum, row) => sum + Number(row.receivable), 0)
  if (denominator <= 0) return null
  return eligible.reduce((sum, row) => sum + Number(row.receivable) * Number(row.applicableCollectionRate), 0) / denominator
}

function validateAndAggregateCollectionRows(rows: any[], label: string, businessDate: string) {
  if (rows.length !== OFFICIAL_COLLECTION_CENTER_COUNT) {
    throw new Error(`${label}官方收缴范围应为${OFFICIAL_COLLECTION_CENTER_COUNT}条，当前${rows.length}条`)
  }
  const normalized = rows.map(row => normalizeCollectionCenter(row.center)).filter(Boolean)
  if (normalized.length !== rows.length || new Set(normalized).size !== rows.length) {
    throw new Error(`${label}存在空服务中心或重复归一键`)
  }
  const scopedRows = applyEffectiveMasterState(rows, { asOf: businessDate })
    .filter(row => !isCollectionCenterExcluded(row.center)).map(row => ({
    ...row,
    applicableCollectionRate: getCollectionDisplayRate(
      row.center,
      optionalNumber(row.receivable),
      optionalNumber(row.received),
      optionalNumber(row.collectionRate),
    ),
  }))
  const invalid = scopedRows.filter(row => {
    const receivable = optionalNumber(row.receivable)
    const rate = optionalNumber(row.applicableCollectionRate)
    return !String(row.area || '').trim() || receivable === null || receivable < 0
      || rate === null || rate < 0 || rate > 1
  })
  if (invalid.length) throw new Error(`${label}有${invalid.length}条应收或适用收缴率非法`)

  const values: Record<string, number | null> = { '华北汇总': weightedCollectionRate(scopedRows) }
  for (const area of ALLOWED_AREAS.slice(1)) values[area] = weightedCollectionRate(scopedRows.filter(row => row.area === area))
  const withdrawnRate = weightedCollectionRate(scopedRows.filter(row => row.area === SERVICE_CENTER_WITHDRAWN_AREA))
  if (withdrawnRate !== null) values[SERVICE_CENTER_WITHDRAWN_AREA] = withdrawnRate
  const missingAreas = ALLOWED_AREAS.slice(1).filter(area => values[area] === null)
  if (values['华北汇总'] === null || missingAreas.length) {
    throw new Error(`${label}缺少可加权应收：${missingAreas.join('、') || '华北汇总'}`)
  }
  const masterChanges = [...latestEffectiveMasterChanges(db, businessDate).values()]
  const masterChangeIds = masterChanges.map(change => change.id).sort((left, right) => left - right)
  return { values, scopedRows, includedRowCount: scopedRows.length, masterChanges, masterChangeIds }
}

function scopeTrendAggregate(
  aggregate: ReturnType<typeof validateAndAggregateCollectionRows>,
  req?: any,
): ReturnType<typeof validateAndAggregateCollectionRows> {
  if (!req || hasRegionWideReadAccess(req.user?.role)) return aggregate
  const scopedRows = aggregate.scopedRows.filter(row => canAccessServiceCenter(req, row.center))
  const authorizedRate = weightedCollectionRate(scopedRows)
  const values: Record<string, number | null> = authorizedRate === null ? {} : { '授权汇总': authorizedRate }
  for (const area of [...new Set(scopedRows.map(row => String(row.area || '').trim()).filter(Boolean))]) {
    values[area] = weightedCollectionRate(scopedRows.filter(row => row.area === area))
  }
  const masterChanges = aggregate.masterChanges.filter(change => canAccessServiceCenter(req, change.service_center))
  return {
    values,
    scopedRows,
    includedRowCount: scopedRows.length,
    masterChanges,
    masterChangeIds: masterChanges.map(change => Number(change.id)).sort((left, right) => left - right),
  }
}

function requireTrendScope(req: any, res: any): boolean {
  if (hasValidServiceCenterAssignment(req.user)) return true
  res.status(403).json({ error: '当前账号没有有效的服务中心授权范围' })
  return false
}

function validateAndAggregateBatch(batch: any) {
  const rows = (db.prepare(`SELECT source_key,canonical_key,payload FROM data_ingestion_rows
    WHERE batch_id=? AND entity_type='collection_center' ORDER BY id`).all(batch.id) as any[]).map(row => {
      let payload: any
      try { payload = JSON.parse(row.payload || '{}') } catch { throw new Error(`P46批次${batch.id}存在无效收缴行JSON`) }
      return { ...payload, sourceKey: row.source_key, canonicalKey: row.canonical_key }
    })
  const aggregate = validateAndAggregateCollectionRows(rows, `P46批次${batch.id}`, String(batch.business_date))
  const provenance = {
    schemaVersion: 1,
    source: 'data_ingestion_rows.collection_center',
    batchId: Number(batch.id),
    batchSha256: batch.batch_sha256,
    businessDate: batch.business_date,
    extractedAt: batch.extracted_at,
    publishedAt: batch.published_at,
    officialRowCount: rows.length,
    includedRowCount: aggregate.includedRowCount,
    formula: 'SUM(receivable * applicableCollectionRate) / SUM(receivable), receivable > 0',
    rateField: 'gatheringCurrentYearRecedRate; heating exceptions use corrected received / receivable',
    methodology: 'official-project-rate-weighted-with-heating-adjustments',
    areaField: 'collection_center.area',
    serviceCenterMasterScope: 'effective master state as of snapshot business date',
    serviceCenterMasterChangeIds: aggregate.masterChangeIds,
  }
  return {
    month: String(batch.business_date).slice(0, 7),
    values: aggregate.values,
    scopedRows: aggregate.scopedRows,
    includedRowCount: aggregate.includedRowCount,
    masterChanges: aggregate.masterChanges,
    masterChangeIds: aggregate.masterChangeIds,
    provenance,
  }
}

const HISTORICAL_TREND_SOURCE = 'lvzai-verified-historical-archive'
const cockpitRoot = () => process.env.COCKPIT_ROOT || path.resolve(process.env.HOME || '/home/ubuntu', 'cockpit')
const sourceRoots = () => [
  ...(process.env.COCKPIT_HISTORICAL_BACKFILL_SOURCE_ROOTS
    ? process.env.COCKPIT_HISTORICAL_BACKFILL_SOURCE_ROOTS.split(path.delimiter)
    : ['/home/ubuntu/backups', path.resolve(cockpitRoot(), 'backups')]),
  path.resolve(cockpitRoot(), 'data', 'historical-collection-backfills'),
].map(root => path.resolve(root))
const actor = (req: any) => String(req.user?.username || 'admin')
const sha256 = (content: Buffer | string) => crypto.createHash('sha256').update(content).digest('hex')

function readHistoricalSource(sourcePath: string, businessDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new Error('历史补录业务日期格式无效')
  const resolved = fs.realpathSync(path.resolve(sourcePath))
  if (!sourceRoots().some(root => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error('历史补录源文件不在受控备份目录')
  }
  if (path.basename(resolved) !== '绿仔收缴明细.json') throw new Error('历史补录只接受绿仔收缴明细.json')
  const content = fs.readFileSync(resolved)
  const parsed = parseStrictUtf8Json(content, '历史绿仔收缴明细') as any
  const extractedAt = String(parsed?.extractedAt || '')
  const extractedInstant = new Date(extractedAt)
  const businessStart = new Date(`${businessDate}T00:00:00+08:00`)
  if (!Number.isFinite(extractedInstant.getTime()) || extractedInstant < businessStart || extractedInstant > new Date()) {
    throw new Error(`历史源提取时间${extractedAt || '为空'}无效或早于业务日期`)
  }
  const sourceDate = String(parsed?.date || '')
  const sourceBusinessDate = String(parsed?.businessDate || sourceDate)
  const hasExplicitSourceDate = Boolean(sourceDate || sourceBusinessDate)
  if (hasExplicitSourceDate ? sourceDate !== businessDate || sourceBusinessDate !== businessDate : !extractedAt.startsWith(businessDate)) {
    throw new Error(`历史源截止日${sourceBusinessDate || sourceDate || extractedAt.slice(0, 10) || '为空'}与业务日期${businessDate}不一致`)
  }
  if (!Array.isArray(parsed?.rows)) throw new Error('历史源缺少rows数组')
  const aggregate = validateAndAggregateCollectionRows(parsed.rows, `历史收缴归档${businessDate}`, businessDate)
  return { resolved, content, parsed, extractedAt, aggregate, sourceSha256: sha256(content) }
}

function publishedHistoricalTrendRows(req?: any) {
  const records = db.prepare(`SELECT * FROM collection_trend_backfills
    WHERE status='published' ORDER BY business_date,id`).all() as any[]
  return records.map(record => {
    const content = fs.readFileSync(record.archive_path)
    if (sha256(content) !== record.source_sha256) throw new Error(`历史收缴归档${record.business_date}哈希校验失败`)
    const parsed = parseStrictUtf8Json(content, `历史收缴归档${record.business_date}`) as any
    if (!Array.isArray(parsed?.rows) || JSON.stringify(parsed.rows) !== record.payload) {
      throw new Error(`历史收缴归档${record.business_date}内容与发布记录不一致`)
    }
    const aggregate = validateAndAggregateCollectionRows(parsed.rows, `历史收缴归档${record.business_date}`, String(record.business_date))
    const scopedAggregate = scopeTrendAggregate(aggregate, req)
    return {
      m: record.business_date,
      ...scopedAggregate.values,
      quality_status: 'verified',
      quality_reason: '',
      source: HISTORICAL_TREND_SOURCE,
      source_status: 'published',
      business_date: record.business_date,
      last_validated_at: record.published_at,
      field_provenance: {
        schemaVersion: 1,
        source: HISTORICAL_TREND_SOURCE,
        backfillId: Number(record.id),
        sourceFileName: record.source_file_name,
        sourceSha256: record.source_sha256,
        businessDate: record.business_date,
        extractedAt: record.extracted_at,
        publishedAt: record.published_at,
        publishedBy: record.published_by,
        officialRowCount: Number(record.row_count),
        includedRowCount: scopedAggregate.includedRowCount,
        formula: 'SUM(receivable * applicableCollectionRate) / SUM(receivable), receivable > 0',
        methodology: 'verified-historical-archive-with-heating-adjustments',
        serviceCenterMasterScope: 'effective master state as of snapshot business date',
        serviceCenterMasterChangeIds: scopedAggregate.masterChangeIds,
      },
    }
  })
}

function dailyCollectionTrendRows(req?: any) {
  const byDate = new Map<string, any>()
  for (const row of publishedHistoricalTrendRows(req)) byDate.set(row.business_date, row)
  for (const batch of publishedDailyCollectionBatches()) {
    const item = validateAndAggregateBatch(batch)
    const scopedAggregate = scopeTrendAggregate(item, req)
    byDate.set(String(batch.business_date), {
      m: String(batch.business_date),
      ...scopedAggregate.values,
      quality_status: 'verified',
      quality_reason: '',
      source: P46_TREND_SOURCE,
      source_status: 'published',
      business_date: String(batch.business_date),
      last_validated_at: batch.extracted_at || batch.published_at,
      field_provenance: {
        ...item.provenance,
        includedRowCount: scopedAggregate.includedRowCount,
        serviceCenterMasterChangeIds: scopedAggregate.masterChangeIds,
      },
    })
  }
  return [...byDate.values()].sort((left, right) => left.business_date.localeCompare(right.business_date))
}

function naturalWeekBounds(businessDate: string) {
  const date = new Date(`${businessDate}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || Number.isNaN(date.getTime())) {
    throw new Error(`P46批次业务日期无效：${businessDate}`)
  }
  const offsetFromMonday = (date.getUTCDay() + 6) % 7
  const start = new Date(date)
  start.setUTCDate(start.getUTCDate() - offsetFromMonday)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 6)
  return { weekStart: start.toISOString().slice(0, 10), weekEnd: end.toISOString().slice(0, 10) }
}

/** 历史收缴归档先预览后发布；只补趋势证据，不覆盖当前经营事实表。 */
router.post('/api/collection-trends/historical-backfills/preview', requireAdmin, (req, res) => {
  try {
    const businessDate = String(req.body?.businessDate || '')
    const sourcePath = String(req.body?.sourcePath || '')
    const source = readHistoricalSource(sourcePath, businessDate)
    const formal = publishedDailyCollectionBatches().find(batch => String(batch.business_date) === businessDate)
    if (formal) return res.status(409).json({ error: `${businessDate}已有P46正式收缴批次，禁止历史补录覆盖` })
    const archiveDir = path.resolve(cockpitRoot(), 'data', 'historical-collection-backfills', businessDate, source.sourceSha256.slice(0, 16))
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o750 })
    const archivePath = path.join(archiveDir, '绿仔收缴明细.json')
    if (fs.existsSync(archivePath) && sha256(fs.readFileSync(archivePath)) !== source.sourceSha256) {
      throw new Error('历史补录归档目标已存在但哈希不一致')
    }
    if (!fs.existsSync(archivePath)) fs.copyFileSync(source.resolved, archivePath, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(archivePath, 0o640)
    const existing = db.prepare('SELECT * FROM collection_trend_backfills WHERE business_date=?').get(businessDate) as any
    if (existing?.status === 'published') {
      if (existing.source_sha256 !== source.sourceSha256) return res.status(409).json({ error: `${businessDate}已有不同哈希的正式历史补录` })
      return res.json({ idempotent: true, backfill: existing, values: source.aggregate.values })
    }
    let id = 0
    db.transaction(() => {
      if (existing) {
        if (existing.source_sha256 !== source.sourceSha256) throw new Error(`${businessDate}已有不同哈希的待发布预览`)
        db.prepare(`UPDATE collection_trend_backfills SET extracted_at=?,source_file_name=?,archive_path=?,row_count=?,payload=?,
          validation_errors='[]',created_by=?,created_at=datetime('now','localtime') WHERE id=?`)
          .run(source.extractedAt, path.basename(source.resolved), archivePath, source.parsed.rows.length,
            JSON.stringify(source.parsed.rows), actor(req), existing.id)
        id = Number(existing.id)
      } else {
        const result = db.prepare(`INSERT INTO collection_trend_backfills
          (business_date,extracted_at,source_file_name,archive_path,source_sha256,row_count,payload,validation_errors,status,created_by)
          VALUES(?,?,?,?,?,?,?,'[]','previewed',?)`)
          .run(businessDate, source.extractedAt, path.basename(source.resolved), archivePath, source.sourceSha256,
            source.parsed.rows.length, JSON.stringify(source.parsed.rows), actor(req))
        id = Number(result.lastInsertRowid)
      }
      logOperationStrict(req, '生成历史收缴趋势补录预览', `collection_trend_backfill:${id}`, {
        businessDate, sourceSha256: source.sourceSha256, rowCount: source.parsed.rows.length, archivePath,
      })
    })()
    const backfill = db.prepare('SELECT * FROM collection_trend_backfills WHERE id=?').get(id) as any
    res.json({ idempotent: Boolean(existing), backfill, values: source.aggregate.values })
  } catch (error: any) {
    res.status(400).json({ error: String(error?.message || '历史收缴趋势补录预览失败').slice(0, 500) })
  }
})

router.post('/api/collection-trends/historical-backfills/:id/publish', requireAdmin, (req, res) => {
  if (String(req.body?.confirmation || '') !== '确认发布历史收缴趋势补录') {
    return res.status(400).json({ error: '请输入“确认发布历史收缴趋势补录”后再执行' })
  }
  const note = String(req.body?.confirmNote || '').trim()
  if (note.length < 10) return res.status(400).json({ error: '发布确认说明至少10个字符' })
  try {
    let backfill = db.prepare('SELECT * FROM collection_trend_backfills WHERE id=?').get(req.params.id) as any
    if (!backfill) return res.status(404).json({ error: '历史补录不存在' })
    const source = readHistoricalSource(backfill.archive_path, backfill.business_date)
    if (source.sourceSha256 !== backfill.source_sha256 || JSON.stringify(source.parsed.rows) !== backfill.payload) {
      return res.status(409).json({ error: '历史补录归档在预览后发生变化，禁止发布' })
    }
    if (backfill.status === 'published') return res.json({ idempotent: true, backfill, values: source.aggregate.values })
    db.transaction(() => {
      db.prepare(`UPDATE collection_trend_backfills SET status='published',published_by=?,
        published_at=datetime('now','localtime'),confirm_note=? WHERE id=? AND status='previewed'`)
        .run(actor(req), note, backfill.id)
      logOperationStrict(req, '发布历史收缴趋势补录', `collection_trend_backfill:${backfill.id}`, {
        businessDate: backfill.business_date, sourceSha256: backfill.source_sha256,
        rowCount: backfill.row_count, confirmNote: note,
      })
    })()
    backfill = db.prepare('SELECT * FROM collection_trend_backfills WHERE id=?').get(backfill.id) as any
    res.json({ idempotent: false, backfill, values: source.aggregate.values })
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message || '历史收缴趋势补录发布失败').slice(0, 500) })
  }
})

/** GET /api/collection-trends/daily — 收缴率明细按已有正式批次和已发布历史归档逐日展示。 */
router.get('/api/collection-trends/daily', (req, res) => {
  if (!requireTrendScope(req, res)) return
  try {
    res.json(dailyCollectionTrendRows(req))
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message || '每日收缴趋势读取失败').slice(0, 300) })
  }
})

/** GET /api/collection-trends/weekly — 每个自然周取该周最后一个已发布业务日，不累计、不补造。 */
router.get('/api/collection-trends/weekly', (req, res) => {
  if (!requireTrendScope(req, res)) return
  try {
    const latestByWeek = new Map<string, any>()
    for (const row of dailyCollectionTrendRows(req)) {
      const { weekStart, weekEnd } = naturalWeekBounds(row.business_date)
      latestByWeek.set(weekStart, {
        ...row,
        m: `${weekStart.slice(5)}~${weekEnd.slice(5)}`,
        week_start: weekStart,
        week_end: weekEnd,
        snapshot_business_date: row.business_date,
        field_provenance: {
          ...row.field_provenance,
          weeklyMethodology: 'latest-published-business-date-in-natural-week',
          weekStart,
          weekEnd,
          snapshotBusinessDate: row.business_date,
        },
      })
    }
    res.json([...latestByWeek.values()])
  } catch (error: any) {
    res.status(409).json({ error: String(error?.message || '每周收缴趋势读取失败').slice(0, 300) })
  }
})

/** GET /api/trends — 仅管理员，只返回已验证趋势和明确状态。 */
router.get('/api/trends', requireAdmin, (_req, res) => {
  const rows = trendRows()
  res.json({ rows, status: trendStatus(rows) })
})

/** 从每月最后一个已发布P46官方收缴批次重建可追溯趋势。 */
router.post('/api/trends/rebuild', requireAdmin, (req, res) => {
  if (String(req.body?.confirmation || '') !== '确认重建月度趋势') {
    return res.status(400).json({ error: '请输入“确认重建月度趋势”后再执行' })
  }
  try {
    const batches = publishedMonthlyCollectionBatches()
    if (!batches.length) return res.status(409).json({ error: '尚无包含官方收缴明细的已发布P46批次' })
    const rebuilt = batches.map(validateAndAggregateBatch)
    let inserted = 0
    let updated = 0
    let unchanged = 0
    const result = db.transaction(() => {
      const upsert = db.prepare(`INSERT INTO monthly_trends
        (month,"华北汇总","朝阳片区","京东片区","海淀片区","顺平片区","河北片区","辽宁片区",
         quality_status,quality_reason,source,source_status,business_date,last_validated_at,field_provenance)
        VALUES(?,?,?,?,?,?,?,?, 'verified','',?,'published',?,?,?)
        ON CONFLICT(month) DO UPDATE SET
          "华北汇总"=excluded."华北汇总","朝阳片区"=excluded."朝阳片区","京东片区"=excluded."京东片区",
          "海淀片区"=excluded."海淀片区","顺平片区"=excluded."顺平片区","河北片区"=excluded."河北片区","辽宁片区"=excluded."辽宁片区",
          quality_status=excluded.quality_status,quality_reason=excluded.quality_reason,
          source=excluded.source,source_status=excluded.source_status,business_date=excluded.business_date,
          last_validated_at=excluded.last_validated_at,field_provenance=excluded.field_provenance`)
      for (const item of rebuilt) {
        const existing = db.prepare('SELECT source,field_provenance FROM monthly_trends WHERE month=?').get(item.month) as any
        if (existing && existing.source !== P46_TREND_SOURCE) {
          throw new Error(`${item.month}已有其他正式来源趋势，禁止自动覆盖`)
        }
        const provenance = JSON.stringify(item.provenance)
        if (existing?.field_provenance === provenance) {
          unchanged += 1
          continue
        }
        const v = item.values
        upsert.run(item.month, v['华北汇总'], v['朝阳片区'], v['京东片区'], v['海淀片区'],
          v['顺平片区'], v['河北片区'], v['辽宁片区'], P46_TREND_SOURCE,
          item.provenance.businessDate, item.provenance.extractedAt || item.provenance.publishedAt, provenance)
        if (existing) updated += 1
        else inserted += 1
      }
      const idempotent = inserted === 0 && updated === 0
      logOperationStrict(req, idempotent ? '确认官方月度趋势状态' : '重建官方月度趋势',
        'monthly_trends:p46', { batches: rebuilt.map(item => item.provenance), inserted, updated, unchanged, idempotent })
      return { idempotent }
    })()
    const rows = trendRows()
    return res.json({ success: true, idempotent: result.idempotent, inserted, updated, unchanged, rows, status: trendStatus(rows) })
  } catch (error: any) {
    return res.status(409).json({ error: String(error?.message || '月度趋势重建失败').slice(0, 300) })
  }
})

/** 非生产兼容入口；生产仍禁止手工伪造趋势。 */
router.post('/api/trends', requireAdmin, (req, res) => {
  if (!canUseManualBusinessWrites()) return res.status(403).json({ error: '正式月度趋势禁止手工写入；请使用已发布官方收缴批次重建' })
  const { month, ...areas } = req.body || {}
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return res.status(400).json({ error: '缺少有效month字段' })
  const allowedEntries = Object.entries(areas).filter(([key]) => (ALLOWED_AREAS as readonly string[]).includes(key))
  if (!allowedEntries.length) return res.status(400).json({ error: '没有可保存的片区字段' })
  const existing = db.prepare('SELECT month FROM monthly_trends WHERE month=?').get(month)
  if (existing) {
    const sets = allowedEntries.map(([key]) => `"${key}"=?`)
    db.prepare(`UPDATE monthly_trends SET ${sets.join(',')},quality_status='unverified',
      quality_reason='非生产手工录入，禁止用于正式经营结论',source='manual-development',source_status='unverified'
      WHERE month=?`).run(...allowedEntries.map(([, value]) => value), month)
  } else {
    const keys = ['month', ...allowedEntries.map(([key]) => key), 'quality_status', 'quality_reason', 'source', 'source_status']
    db.prepare(`INSERT INTO monthly_trends (${keys.map(key => `"${key}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(month, ...allowedEntries.map(([, value]) => value), 'unverified', '非生产手工录入，禁止用于正式经营结论', 'manual-development', 'unverified')
  }
  res.json({ success: true, month })
})

export default router
