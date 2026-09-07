const OFFICIAL_COLLECTION_CENTER_COUNT = 35
const P46_TREND_SOURCE = 'p46-official-collection'
const AREAS = ['华北汇总', '朝阳片区', '京东片区', '海淀片区', '顺平片区', '河北片区', '辽宁片区']

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeCollectionCenter(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[·•・]/g, '')
}

function latestFormalMonthlyCollectionBatches(database) {
  return database.prepare(`WITH formal_batches AS (
      SELECT b.id,b.business_date,b.extracted_at,b.published_at,b.batch_sha256
      FROM data_ingestion_batches b
      JOIN data_ingestion_publications publication ON publication.batch_id=b.id
      WHERE b.status='published'
        AND length(b.batch_sha256)=64 AND COALESCE(b.published_at,'')<>''
        AND publication.business_date=b.business_date
        AND length(publication.backup_sha256)=64
        AND COALESCE(publication.published_at,'')<>''
        AND publication.payment_rows>0
        AND publication.collection_rows=?
        AND publication.payment_rows=(SELECT COUNT(*) FROM data_ingestion_rows payment_rows
          WHERE payment_rows.batch_id=b.id AND payment_rows.entity_type='payment_center')
        AND publication.snapshot_rows=(SELECT COUNT(*) FROM data_ingestion_rows snapshot_rows
          WHERE snapshot_rows.batch_id=b.id AND snapshot_rows.entity_type='daily_snapshot')
        AND publication.collection_rows=(SELECT COUNT(*) FROM data_ingestion_rows collection_rows
          WHERE collection_rows.batch_id=b.id AND collection_rows.entity_type='collection_center')
    )
    SELECT b.* FROM formal_batches b
    WHERE EXISTS (SELECT 1 FROM data_ingestion_rows row
      WHERE row.batch_id=b.id AND row.entity_type='collection_center')
      AND NOT EXISTS (
        SELECT 1 FROM formal_batches newer
        WHERE substr(newer.business_date,1,7)=substr(b.business_date,1,7)
          AND EXISTS (SELECT 1 FROM data_ingestion_rows row
            WHERE row.batch_id=newer.id AND row.entity_type='collection_center')
          AND (newer.business_date>b.business_date OR (newer.business_date=b.business_date AND newer.id>b.id))
      )
    ORDER BY b.business_date,b.id`).all(OFFICIAL_COLLECTION_CENTER_COUNT)
}

function aggregateBatch(database, batch) {
  const rows = database.prepare(`SELECT source_key,canonical_key,payload FROM data_ingestion_rows
    WHERE batch_id=? AND entity_type='collection_center' ORDER BY id`).all(batch.id).map(row => {
    let payload
    try { payload = JSON.parse(row.payload || '{}') }
    catch { throw new Error(`P46批次${batch.id}存在无效收缴行JSON`) }
    return { ...payload, sourceKey: row.source_key, canonicalKey: row.canonical_key }
  })
  if (rows.length !== OFFICIAL_COLLECTION_CENTER_COUNT) {
    throw new Error(`P46批次${batch.id}官方收缴范围应为${OFFICIAL_COLLECTION_CENTER_COUNT}条，当前${rows.length}条`)
  }
  const normalized = rows.map(row => normalizeCollectionCenter(row.center)).filter(Boolean)
  if (normalized.length !== rows.length || new Set(normalized).size !== rows.length) {
    throw new Error(`P46批次${batch.id}存在空服务中心或重复归一键`)
  }
  const invalid = rows.filter(row => {
    const receivable = optionalNumber(row.receivable)
    const rate = optionalNumber(row.collectionRate)
    return !String(row.area || '').trim() || receivable === null || receivable < 0
      || rate === null || rate < 0 || rate > 1
  })
  if (invalid.length) throw new Error(`P46批次${batch.id}有${invalid.length}条官方应收或收缴率非法`)

  const weighted = scope => {
    const eligible = scope.filter(row => Number(row.receivable) > 0)
    const denominator = eligible.reduce((sum, row) => sum + Number(row.receivable), 0)
    if (denominator <= 0) return null
    return eligible.reduce((sum, row) => sum + Number(row.receivable) * Number(row.collectionRate), 0) / denominator
  }
  const values = { '华北汇总': weighted(rows) }
  for (const area of AREAS.slice(1)) values[area] = weighted(rows.filter(row => row.area === area))
  const missingAreas = AREAS.slice(1).filter(area => values[area] === null)
  if (values['华北汇总'] === null || missingAreas.length) {
    throw new Error(`P46批次${batch.id}缺少可加权应收：${missingAreas.join('、') || '华北汇总'}`)
  }
  const provenance = {
    schemaVersion: 1,
    source: 'data_ingestion_rows.collection_center',
    batchId: Number(batch.id),
    batchSha256: batch.batch_sha256,
    businessDate: batch.business_date,
    extractedAt: batch.extracted_at,
    publishedAt: batch.published_at,
    officialRowCount: rows.length,
    formula: 'SUM(receivable * collectionRate) / SUM(receivable), receivable > 0',
    rateField: 'gatheringCurrentYearRecedRate',
    areaField: 'collection_center.area',
  }
  return { month: String(batch.business_date).slice(0, 7), values, provenance }
}

function sameTrend(existing, item, provenance) {
  if (!existing || existing.source !== P46_TREND_SOURCE
    || existing.quality_status !== 'verified' || existing.source_status !== 'published'
    || existing.business_date !== item.provenance.businessDate
    || existing.field_provenance !== provenance) return false
  return AREAS.every(area => Number(existing[area]) === Number(item.values[area]))
}

/**
 * 私有同步后的派生趋势只认正式发布回执，并固定绑定每月最新批次。
 * 该函数不自行开启事务，调用者必须把它放在镜像事实的同一事务内。
 */
export function rebuildPublishedMonthlyTrends(database) {
  const batches = latestFormalMonthlyCollectionBatches(database)
  if (!batches.length) throw new Error('同步来源中没有包含官方收缴明细的正式P46批次')
  const rebuilt = batches.map(batch => aggregateBatch(database, batch))
  const expectedMonths = new Set(rebuilt.map(item => item.month))
  let inserted = 0
  let updated = 0
  let unchanged = 0
  let invalidated = 0
  const upsert = database.prepare(`INSERT INTO monthly_trends
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
    const existing = database.prepare(`SELECT * FROM monthly_trends WHERE month=?`).get(item.month)
    if (existing && existing.source !== P46_TREND_SOURCE) {
      throw new Error(`${item.month}已有其他正式来源趋势，禁止同步自动覆盖`)
    }
    const provenance = JSON.stringify(item.provenance)
    if (sameTrend(existing, item, provenance)) {
      unchanged += 1
      continue
    }
    const values = item.values
    upsert.run(item.month, values['华北汇总'], values['朝阳片区'], values['京东片区'], values['海淀片区'],
      values['顺平片区'], values['河北片区'], values['辽宁片区'], P46_TREND_SOURCE,
      item.provenance.businessDate, item.provenance.extractedAt || item.provenance.publishedAt, provenance)
    if (existing) updated += 1
    else inserted += 1
  }

  const orphaned = database.prepare(`SELECT month FROM monthly_trends
    WHERE source=? AND quality_status='verified'`).all(P46_TREND_SOURCE)
    .filter(row => !expectedMonths.has(String(row.month)))
  const invalidate = database.prepare(`UPDATE monthly_trends SET quality_status='unverified',
    quality_reason='原正式P46批次已不在当前镜像血缘中',source_status='invalid'
    WHERE month=? AND source=? AND quality_status='verified'`)
  for (const row of orphaned) invalidated += Number(invalidate.run(row.month, P46_TREND_SOURCE).changes || 0)

  return {
    inserted,
    updated,
    unchanged,
    invalidated,
    idempotent: inserted === 0 && updated === 0 && invalidated === 0,
    batches: rebuilt.map(item => item.provenance),
  }
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value || '{}'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

function validSha(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null
}

/** 同步只标记旧归档的当前血缘状态，不删除、不重写历史归档。 */
export function inspectReportArchiveBindings(database) {
  const archives = database.prepare('SELECT id,report_date,payload,traceability FROM report_archives ORDER BY id').all()
  const rows = archives.map(archive => {
    const payload = parseObject(archive.payload)
    const storedTraceability = parseObject(archive.traceability)
    const traceability = Object.keys(storedTraceability).length ? storedTraceability : parseObject(payload.traceability)
    const facts = parseObject(traceability.publishedFacts)
    const batchId = Number.isInteger(Number(facts.batchId)) && Number(facts.batchId) > 0 ? Number(facts.batchId) : null
    const archivedSha = validSha(facts.batchSha256)
    const archivedBusinessDate = String(facts.businessDate || '')
    const reasons = []
    if (!batchId || !archivedSha || !/^\d{4}-\d{2}-\d{2}$/.test(archivedBusinessDate)) {
      reasons.push('ARCHIVE_TRACEABILITY_INVALID')
    }
    const current = batchId ? database.prepare(`SELECT id,business_date,batch_sha256,status,published_at
      FROM data_ingestion_batches WHERE id=?`).get(batchId) : null
    if (batchId && !current) reasons.push('P46_BATCH_NOT_FOUND')
    if (current && (archivedSha !== validSha(current.batch_sha256) || archivedBusinessDate !== current.business_date)) {
      reasons.push('P46_BATCH_IDENTITY_MISMATCH')
    }
    if (current) {
      const publication = database.prepare(`SELECT business_date,backup_sha256,payment_rows,snapshot_rows,
        collection_rows,published_at FROM data_ingestion_publications WHERE batch_id=?`).get(current.id)
      const counts = database.prepare(`SELECT
          SUM(CASE WHEN entity_type='payment_center' THEN 1 ELSE 0 END) payment_rows,
          SUM(CASE WHEN entity_type='daily_snapshot' THEN 1 ELSE 0 END) snapshot_rows,
          SUM(CASE WHEN entity_type='collection_center' THEN 1 ELSE 0 END) collection_rows
        FROM data_ingestion_rows WHERE batch_id=?`).get(current.id)
      const formal = current.status === 'published' && validSha(current.batch_sha256)
        && String(current.published_at || '').trim() && publication
        && publication.business_date === current.business_date && validSha(publication.backup_sha256)
        && String(publication.published_at || '').trim()
        && Number(publication.payment_rows) > 0
        && Number(publication.collection_rows) === OFFICIAL_COLLECTION_CENTER_COUNT
        && Number(publication.payment_rows) === Number(counts?.payment_rows || 0)
        && Number(publication.snapshot_rows) === Number(counts?.snapshot_rows || 0)
        && Number(publication.collection_rows) === Number(counts?.collection_rows || 0)
      if (!formal) reasons.push('P46_PUBLICATION_INVALID')
    }
    return { id: Number(archive.id), reportDate: archive.report_date, state: reasons.length ? 'invalid' : 'valid', reasons }
  })
  const invalid = rows.filter(row => row.state === 'invalid')
  const validCount = rows.length - invalid.length
  return {
    state: !rows.length ? 'empty' : !invalid.length ? 'ready' : validCount ? 'partial' : 'invalid',
    count: rows.length,
    validCount,
    invalidCount: invalid.length,
    invalidArchiveIds: invalid.map(row => row.id),
    rows,
  }
}

export { OFFICIAL_COLLECTION_CENTER_COUNT, P46_TREND_SOURCE }
