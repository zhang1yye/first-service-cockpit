import db from './db.js'
import { DEMO_PROJECT_NAMES, hasCompleteOperatingFacts, missingOperatingNumericFields } from './data-quality-gate.js'
import { logOperationStrict } from './audit.js'
import { normalizeCollectionCenter, OFFICIAL_COLLECTION_CENTER_COUNT } from './collection-quality.js'
import { formalP46PublicationPredicate } from './formal-p46-publication.js'

export const DIRECTORY_VALIDATION_STATUS = 'directory_only'
const DIRECTORY_SOURCE_SYSTEM = 'project_profiles'
const UNKNOWN_OPERATING_FIELDS = [
  'staff_count', 'annual_income', 'annual_cost', 'ytd_income', 'ytd_cost',
  'quality_score', 'safety_incidents',
  'customer_satisfaction', 'complaint_count',
] as const

type DirectoryBatch = {
  id: number
  source_file: string
  source_sha256: string
  source_sheet: string
  filter_status: string
  profile_count: number
  phase_count: number
  imported_at: string
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function basename(value: unknown): string {
  return String(value || '').split(/[\\/]/).pop() || ''
}

function displayProjectName(value: unknown): string {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ')
}

function normalizedProjectName(value: unknown): string {
  return normalizeCollectionCenter(displayProjectName(value))
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function latestDirectoryBatch(database: any = db): DirectoryBatch | null {
  return database.prepare(`SELECT id,source_file,source_sha256,source_sheet,filter_status,
    profile_count,phase_count,imported_at
    FROM project_profile_import_batches ORDER BY id DESC LIMIT 1`).get() as DirectoryBatch | null
}

export function directoryTraceability(database: any = db): Record<string, unknown> | null {
  const batch = latestDirectoryBatch(database)
  if (!batch) return null
  const published = database.prepare(`SELECT MAX(updated_at) published_at
    FROM projects WHERE source_system=? AND validation_status=? AND active_status='active'`)
    .get(DIRECTORY_SOURCE_SYSTEM, DIRECTORY_VALIDATION_STATUS) as any
  return {
    sourceTable: 'project_profiles',
    batchId: batch.id,
    sourceFile: basename(batch.source_file),
    sourceSha256: batch.source_sha256,
    sourceSheet: batch.source_sheet,
    filterStatus: batch.filter_status,
    importedAt: batch.imported_at,
    publishedAt: published?.published_at || null,
  }
}

export function projectDataAvailability(row: any) {
  const isDirectoryOnly = row?.validation_status === DIRECTORY_VALIDATION_STATUS
  const verifiedStatus = row?.validation_status === 'verified'
  const operatingMissingFields = verifiedStatus ? missingOperatingNumericFields(row) : []
  const completeOperating = hasCompleteOperatingFacts(row)
  const collectionFactsAvailable = row?.receivable !== null && row?.receivable !== undefined
    && row?.received !== null && row?.received !== undefined
  return {
    state: isDirectoryOnly ? 'directory_only' : completeOperating ? 'operating_ready' : verifiedStatus ? 'operating_incomplete' : 'unverified',
    directoryAvailable: isDirectoryOnly || verifiedStatus,
    collectionFactsAvailable,
    officialCollectionRateAvailable: row?.official_collection_rate !== null && row?.official_collection_rate !== undefined,
    operatingFactsAvailable: completeOperating,
    missingFields: isDirectoryOnly ? [
      ...UNKNOWN_OPERATING_FIELDS,
      ...(row?.receivable === null || row?.receivable === undefined ? ['receivable'] : []),
      ...(row?.received === null || row?.received === undefined ? ['received'] : []),
      ...(row?.official_collection_rate === null || row?.official_collection_rate === undefined ? ['official_collection_rate'] : []),
    ] : operatingMissingFields,
    message: isDirectoryOnly
      ? '项目目录已来自权威在管主数据；成本、利润率、品质、安全、满意度等项目经营指标当前不接入，不生成健康分或风险结论。'
      : completeOperating ? '项目经营事实已通过来源验证。'
        : verifiedStatus ? '项目虽标记为已验证，但经营结论必需数值不完整，不生成健康分或风险结论。'
          : '项目数据未通过来源验证。',
  }
}

function latestOfficialCollectionFacts(database: any = db) {
  const formalPublication = formalP46PublicationPredicate('b')
  const batch = database.prepare(`SELECT id,business_date,extracted_at,published_at,batch_sha256
    FROM data_ingestion_batches b WHERE status='published'
      AND length(batch_sha256)=64 AND COALESCE(published_at,'')<>''
      AND ${formalPublication}
      AND EXISTS (SELECT 1 FROM data_ingestion_rows r WHERE r.batch_id=b.id AND r.entity_type='collection_center')
    ORDER BY business_date DESC,id DESC LIMIT 1`).get() as any
  if (!batch) return { batch: null, byCenter: new Map<string, any>() }
  const rows = (database.prepare(`SELECT source_key,canonical_key,payload FROM data_ingestion_rows
    WHERE batch_id=? AND entity_type='collection_center' ORDER BY id`).all(batch.id) as any[]).flatMap(row => {
      try { return [{ ...JSON.parse(row.payload || '{}'), sourceKey: row.source_key, canonicalKey: row.canonical_key }] }
      catch { return [] }
    })
  const normalized = rows.map(row => normalizeCollectionCenter(row.center)).filter(Boolean)
  const authoritative = rows.length === OFFICIAL_COLLECTION_CENTER_COUNT
    && normalized.length === rows.length
    && new Set(normalized).size === rows.length
    && rows.every(row => optionalNumber(row.receivable) !== null && Number(row.receivable) >= 0
      && optionalNumber(row.received) !== null && Number(row.received) >= 0
      && optionalNumber(row.collectionRate) !== null && Number(row.collectionRate) >= 0 && Number(row.collectionRate) <= 1)
  if (!authoritative) return { batch: null, byCenter: new Map<string, any>() }
  const byCenter = new Map<string, any>()
  for (const row of rows) {
    for (const candidate of [row.center, row.sourceKey, row.canonicalKey]) {
      const key = normalizeCollectionCenter(candidate)
      if (key && !byCenter.has(key)) byCenter.set(key, row)
    }
  }
  return { batch, byCenter }
}

function collectionFactsByProfile(profiles: any[]) {
  const official = latestOfficialCollectionFacts(db)
  const links = db.prepare(`SELECT profile_id,source_center FROM project_profile_center_links
    WHERE batch_id=? AND source_system='collection' ORDER BY profile_id,source_center`)
    .all(Number(profiles[0]?.batch_id || 0)) as any[]
  const profileIdsByCenter = new Map<string, Set<number>>()
  for (const link of links) {
    const key = normalizeCollectionCenter(link.source_center)
    if (!key) continue
    if (!profileIdsByCenter.has(key)) profileIdsByCenter.set(key, new Set())
    profileIdsByCenter.get(key)!.add(Number(link.profile_id))
  }
  const linksByProfile = new Map<number, string[]>()
  for (const link of links) {
    const key = normalizeCollectionCenter(link.source_center)
    if (!key || (profileIdsByCenter.get(key)?.size || 0) !== 1) continue
    if (!linksByProfile.has(Number(link.profile_id))) linksByProfile.set(Number(link.profile_id), [])
    linksByProfile.get(Number(link.profile_id))!.push(key)
  }
  const result = new Map<number, any>()
  for (const profile of profiles) {
    const exactKey = normalizeCollectionCenter(profile.service_center)
    const keys = linksByProfile.get(Number(profile.id)) || (official.byCenter.has(exactKey) ? [exactKey] : [])
    const rows = [...new Map(keys.map(key => official.byCenter.get(key)).filter(Boolean)
      .map(row => [normalizeCollectionCenter(row.center), row])).values()]
    if (!rows.length) {
      result.set(Number(profile.id), { receivable: null, received: null, officialRate: null, centers: [] })
      continue
    }
    const amountsValid = rows.every(row => Number.isFinite(Number(row.receivable)) && Number(row.receivable) >= 0
      && Number.isFinite(Number(row.received)) && Number(row.received) >= 0)
    if (!amountsValid) {
      result.set(Number(profile.id), { receivable: null, received: null, officialRate: null, centers: [] })
      continue
    }
    const receivable = rows.reduce((sum, row) => sum + Number(row.receivable), 0)
    const received = rows.reduce((sum, row) => sum + Number(row.received), 0)
    const eligible = rows.filter(row => Number(row.receivable) > 0 && Number.isFinite(Number(row.collectionRate)))
    const denominator = eligible.reduce((sum, row) => sum + Number(row.receivable), 0)
    result.set(Number(profile.id), {
      receivable,
      received,
      officialRate: denominator > 0 ? eligible.reduce((sum, row) => sum + Number(row.receivable) * Number(row.collectionRate), 0) / denominator : null,
      centers: rows.map(row => row.center),
    })
  }
  return { facts: result, batch: official.batch }
}

export function decorateProjectRow(row: any) {
  return {
    ...row,
    field_provenance: parseObject(row?.field_provenance),
    dataAvailability: projectDataAvailability(row),
  }
}

export function readProjectDirectoryStatus(database: any = db) {
  const counts = database.prepare(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN validation_status=? THEN 1 ELSE 0 END) directory_count,
      SUM(CASE WHEN validation_status='verified'
        AND annual_income IS NOT NULL AND annual_cost IS NOT NULL
        AND ytd_income IS NOT NULL AND ytd_cost IS NOT NULL
        AND receivable IS NOT NULL AND received IS NOT NULL
        AND quality_score IS NOT NULL AND safety_incidents IS NOT NULL
        AND customer_satisfaction IS NOT NULL AND complaint_count IS NOT NULL
        THEN 1 ELSE 0 END) operating_count,
      SUM(CASE WHEN validation_status='verified' AND (
        annual_income IS NULL OR annual_cost IS NULL OR ytd_income IS NULL OR ytd_cost IS NULL
        OR receivable IS NULL OR received IS NULL OR quality_score IS NULL OR safety_incidents IS NULL
        OR customer_satisfaction IS NULL OR complaint_count IS NULL) THEN 1 ELSE 0 END) incomplete_operating_count,
      SUM(CASE WHEN validation_status NOT IN (?,'verified') THEN 1 ELSE 0 END) unverified_count
    FROM projects WHERE COALESCE(active_status,'active')='active'`)
    .get(DIRECTORY_VALIDATION_STATUS, DIRECTORY_VALIDATION_STATUS) as any
  const total = Number(counts?.total || 0)
  const directoryCount = Number(counts?.directory_count || 0)
  const operatingCount = Number(counts?.operating_count || 0)
  const incompleteOperatingCount = Number(counts?.incomplete_operating_count || 0)
  const unverifiedCount = Number(counts?.unverified_count || 0) + incompleteOperatingCount
  const demoCount = Number((database.prepare(`SELECT COUNT(*) count FROM projects
    WHERE COALESCE(active_status,'active')='active' AND name IN (${DEMO_PROJECT_NAMES.map(() => '?').join(',')})`)
    .get(...DEMO_PROJECT_NAMES) as any)?.count || 0)
  const ready = total > 0 && unverifiedCount === 0 && demoCount === 0 && directoryCount + operatingCount === total
  const state = !total ? 'empty' : ready && operatingCount === total ? 'operating_ready' : ready ? 'directory_ready' : 'blocked'
  return {
    ready,
    state,
    projectCount: total,
    directoryCount,
    operatingCount,
    incompleteOperatingCount,
    unverifiedCount,
    demoCount,
    message: state === 'empty'
      ? '尚未发布项目目录。'
      : state === 'directory_ready'
        ? `已发布${directoryCount}条权威在管项目目录；项目经营指标当前不接入。`
        : state === 'operating_ready'
          ? `已发布${operatingCount}条通过验证的项目经营事实。`
          : '项目目录中存在未验证或演示数据，已阻断正式使用。',
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined || left === '') return right === null || right === undefined || right === ''
  if (right === null || right === undefined || right === '') return false
  if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right)
  return String(left) === String(right)
}

export function publishProjectDirectory(req: any) {
  const batch = latestDirectoryBatch(db)
  if (!batch) throw new Error('尚无可发布的权威项目档案批次')
  if (!/^[a-f0-9]{64}$/i.test(String(batch.source_sha256 || ''))) throw new Error('项目档案批次缺少有效SHA256')
  const profiles = db.prepare(`SELECT id,batch_id,service_center,area,management_status,property_type,
      managed_area,movedin_units,source_rows_json
    FROM project_profiles WHERE batch_id=? ORDER BY area,service_center`).all(batch.id) as any[]
  if (!profiles.length || profiles.length !== Number(batch.profile_count)) {
    throw new Error(`项目档案批次行数不一致：批次${batch.profile_count}条，实际${profiles.length}条`)
  }
  if (profiles.some(row => !displayProjectName(row.service_center) || !String(row.area || '').trim() || row.management_status !== batch.filter_status)) {
    throw new Error('项目档案存在缺少服务中心、片区或非当前在管状态记录')
  }
  const normalizedProfileNames = profiles.map(row => normalizedProjectName(row.service_center))
  if (new Set(normalizedProfileNames).size !== normalizedProfileNames.length) {
    throw new Error('项目档案批次存在NFKC或空白归一后重复的服务中心')
  }

  const sourceBatch = `project-profile:${batch.id}:${batch.source_sha256}`
  let inserted = 0
  let updated = 0
  let unchanged = 0
  let deactivated = 0
  let preservedOperating = 0
  const officialCollection = collectionFactsByProfile(profiles)

  const result = db.transaction(() => {
    const currentDirectory = db.prepare(`SELECT * FROM projects
      WHERE source_system=? ORDER BY id`).all(DIRECTORY_SOURCE_SYSTEM) as any[]
    const byStableId = new Map<string, any>()
    const byProjectCode = new Map<string, any>()
    const byNormalizedName = new Map<string, any>()
    const registerUnique = (map: Map<string, any>, key: string, row: any, label: string) => {
      if (!key) return
      if (map.has(key) && Number(map.get(key).id) !== Number(row.id)) throw new Error(`项目目录存在重复${label}：${key}`)
      map.set(key, row)
    }
    for (const row of currentDirectory) {
      registerUnique(byStableId, String(row.source_project_id || ''), row, '来源项目ID')
      registerUnique(byProjectCode, String(row.project_code || ''), row, '项目编码')
      registerUnique(byNormalizedName, normalizedProjectName(row.name), row, '归一名称')
    }
    const verifiedByName = new Map((db.prepare(`SELECT * FROM projects
      WHERE validation_status='verified' AND COALESCE(active_status,'active')='active' ORDER BY id`).all() as any[])
      .map(row => [normalizedProjectName(row.name), row]))
    const matchedDirectoryIds = new Set<number>()

    const insert = db.prepare(`INSERT INTO projects
      (area,name,area_sqm,units,property_type,staff_count,annual_income,annual_cost,
       ytd_income,ytd_cost,receivable,received,official_collection_rate,quality_score,safety_incidents,
       customer_satisfaction,complaint_count,project_code,source_system,source_project_id,
       active_status,validation_status,source_batch,field_provenance,updated_at)
      VALUES(?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?,?,NULL,NULL,NULL,NULL,?,?,?,'active',?,?,?,datetime('now','localtime'))`)
    const update = db.prepare(`UPDATE projects SET
      area=?,name=?,area_sqm=?,units=?,property_type=?,staff_count=NULL,annual_income=NULL,
      annual_cost=NULL,ytd_income=NULL,ytd_cost=NULL,receivable=?,received=?,official_collection_rate=?,
      quality_score=NULL,safety_incidents=NULL,customer_satisfaction=NULL,complaint_count=NULL,
      project_code=?,source_system=?,source_project_id=?,active_status='active',
      validation_status=?,source_batch=?,field_provenance=?,updated_at=datetime('now','localtime')
      WHERE id=?`)

    for (const profile of profiles) {
      const name = displayProjectName(profile.service_center)
      const nameKey = normalizedProjectName(name)
      const stableId = String(profile.id)
      const projectCode = `DIR-${profile.id}`
      const existing = byStableId.get(stableId) || byProjectCode.get(projectCode) || byNormalizedName.get(nameKey)
      const verified = verifiedByName.get(nameKey)
      if (verified && Number(verified.id) !== Number(existing?.id)) {
        preservedOperating += 1
        continue
      }
      if (verified && Number(verified.id) === Number(existing?.id)) {
        matchedDirectoryIds.add(Number(existing.id))
        preservedOperating += 1
        continue
      }
      const provenance = JSON.stringify({
        schemaVersion: 1,
        state: DIRECTORY_VALIDATION_STATUS,
        source: {
          table: 'project_profiles', batchId: batch.id, profileId: Number(profile.id),
          sourceFile: basename(batch.source_file), sourceSha256: batch.source_sha256,
          sourceSheet: batch.source_sheet, importedAt: batch.imported_at,
          sourceRows: parseObject(`{"rows":${profile.source_rows_json || '[]'}}`).rows || [],
        },
        fields: {
          name: 'project_profiles.service_center', area: 'project_profiles.area',
          area_sqm: 'project_profiles.managed_area', units: 'project_profiles.movedin_units',
          property_type: 'project_profiles.property_type',
          ...(officialCollection.facts.get(Number(profile.id))?.receivable !== null ? {
            receivable: 'data_ingestion_rows.collection_center.receivable',
            received: 'data_ingestion_rows.collection_center.received',
          } : {}),
          ...(officialCollection.facts.get(Number(profile.id))?.officialRate !== null ? {
            official_collection_rate: 'SUM(receivable * collectionRate) / SUM(receivable)',
          } : {}),
        },
        collection: officialCollection.batch ? {
          batchId: Number(officialCollection.batch.id),
          batchSha256: officialCollection.batch.batch_sha256,
          businessDate: officialCollection.batch.business_date,
          extractedAt: officialCollection.batch.extracted_at,
          publishedAt: officialCollection.batch.published_at,
          centers: officialCollection.facts.get(Number(profile.id))?.centers || [],
        } : null,
        unavailableFields: [
          ...UNKNOWN_OPERATING_FIELDS,
          ...(officialCollection.facts.get(Number(profile.id))?.receivable === null ? ['receivable', 'received'] : []),
          ...(officialCollection.facts.get(Number(profile.id))?.officialRate === null ? ['official_collection_rate'] : []),
        ],
      })
      const collection = officialCollection.facts.get(Number(profile.id)) || { receivable: null, received: null, officialRate: null }
      const desired = {
        area: String(profile.area), name, area_sqm: optionalNumber(profile.managed_area),
        units: optionalNumber(profile.movedin_units), property_type: profile.property_type == null ? null : String(profile.property_type),
        project_code: projectCode, source_system: DIRECTORY_SOURCE_SYSTEM,
        source_project_id: stableId, active_status: 'active',
        validation_status: DIRECTORY_VALIDATION_STATUS, source_batch: sourceBatch,
        field_provenance: provenance, receivable: collection.receivable, received: collection.received,
        official_collection_rate: collection.officialRate,
      }
      if (!existing) {
        const codeCollision = db.prepare('SELECT id,source_system FROM projects WHERE project_code=? LIMIT 1').get(projectCode) as any
        if (codeCollision) throw new Error(`项目编码${projectCode}已被其他项目占用，拒绝覆盖`)
        insert.run(desired.area, desired.name, desired.area_sqm, desired.units, desired.property_type,
          desired.receivable, desired.received, desired.official_collection_rate,
          desired.project_code, desired.source_system, desired.source_project_id,
          desired.validation_status, desired.source_batch, desired.field_provenance)
        inserted += 1
        continue
      }
      matchedDirectoryIds.add(Number(existing.id))
      const changed = Object.entries(desired).some(([key, value]) => !sameValue(existing[key], value))
      if (!changed) {
        unchanged += 1
        continue
      }
      update.run(desired.area, desired.name, desired.area_sqm, desired.units, desired.property_type,
        desired.receivable, desired.received, desired.official_collection_rate,
        desired.project_code, desired.source_system, desired.source_project_id,
        desired.validation_status, desired.source_batch, desired.field_provenance, existing.id)
      updated += 1
    }

    for (const row of currentDirectory) {
      if (matchedDirectoryIds.has(Number(row.id)) || row.active_status !== 'active') continue
      db.prepare(`UPDATE projects SET active_status='inactive',updated_at=datetime('now','localtime') WHERE id=?`).run(row.id)
      deactivated += 1
    }
    const idempotent = inserted === 0 && updated === 0 && deactivated === 0
    logOperationStrict(req, idempotent ? '确认权威项目目录状态' : '发布权威项目目录',
      `project_profile_batch:${batch.id}`, {
        sourceSha256: batch.source_sha256, profiles: profiles.length, inserted, updated,
        unchanged, deactivated, preservedOperating, idempotent,
      })
    return { idempotent }
  })()

  const status = readProjectDirectoryStatus(db)
  return {
    success: true,
    idempotent: result.idempotent,
    status,
    traceability: directoryTraceability(db),
    inserted,
    updated,
    unchanged,
    deactivated,
    preservedOperating,
  }
}
