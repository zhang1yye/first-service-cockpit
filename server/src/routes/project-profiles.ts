import { Router } from 'express'
import db from '../db.js'
import { canAccessServiceCenter, denyScopedResource, serviceCenterScopeWhere } from '../auth.js'
import { effectiveServiceCenterState, latestEffectiveMasterChanges } from '../service-center-master.js'

const router = Router()

function latestBatch(): any | null {
  return db.prepare(`
    SELECT id, source_file, source_sha256, source_sheet, filter_status,
           profile_count, phase_count, imported_at
    FROM project_profile_import_batches
    ORDER BY id DESC LIMIT 1
  `).get() as any || null
}

function parsePayload(value: string): any {
  try { return JSON.parse(value || '{}') } catch { return {} }
}

function basename(value: string): string {
  return String(value || '').split(/[\\/]/).pop() || ''
}

function normalizeCenter(value: unknown): string {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').replace(/[·•・]/g, '')
}

function sourceLinkCollisionKeys(): Set<string> {
  const links = db.prepare(`
    SELECT profile_id, source_system, source_center
    FROM project_profile_center_links
    ORDER BY source_system, source_center, profile_id
  `).all() as any[]
  const profilesByKey = new Map<string, number[]>()
  for (const link of links) {
    const key = `${link.source_system}:${normalizeCenter(link.source_center)}`
    if (!profilesByKey.has(key)) profilesByKey.set(key, [])
    profilesByKey.get(key)!.push(Number(link.profile_id))
  }
  return new Set(
    [...profilesByKey.entries()]
      .filter(([, profileIds]) => profileIds.length > 1)
      .map(([key]) => key),
  )
}

function sourceEvidenceForProfile(profileId: number, collisionKeys = sourceLinkCollisionKeys()): any {
  const links = db.prepare(`
    SELECT source_system, source_center, link_method
    FROM project_profile_center_links WHERE profile_id = ? ORDER BY source_system, source_center
  `).all(profileId) as any[]
  const conflictingLinks = links.filter(link => collisionKeys.has(`${link.source_system}:${normalizeCenter(link.source_center)}`))
  const paymentCenters = links.filter(link => link.source_system === 'payment').map(link => link.source_center)
  const collectionCenters = links.filter(link => link.source_system === 'collection').map(link => link.source_center)
  return {
    granularity: 'service_center_link_only',
    linkStatus: conflictingLinks.length ? 'conflict' : links.length ? 'linked' : 'unmatched',
    linkMethods: [...new Set(links.map(link => link.link_method))],
    paymentCenters,
    collectionCenters,
    conflictingLinks: conflictingLinks.map(link => ({ sourceSystem: link.source_system, sourceCenter: link.source_center })),
    operatingFactsAvailable: false,
    message: '目录链接只证明服务中心名称关联，不构成项目粒度经营事实。',
  }
}

function aggregateSourceEvidence(profileIds: number[]): any {
  const collisionKeys = sourceLinkCollisionKeys()
  const rows = profileIds.map(id => sourceEvidenceForProfile(id, collisionKeys))
  return {
    linkedProfiles: rows.filter(row => !['unmatched', 'conflict'].includes(row.linkStatus)).length,
    paymentLinkedProfiles: rows.filter(row => row.paymentCenters.length > 0 && row.conflictingLinks.length === 0).length,
    collectionLinkedProfiles: rows.filter(row => row.collectionCenters.length > 0 && row.conflictingLinks.length === 0).length,
    conflictedProfiles: rows.filter(row => row.linkStatus === 'conflict').length,
    unmatchedProfiles: rows.filter(row => row.linkStatus === 'unmatched').length,
    totalProfiles: rows.length,
  }
}

router.get('/api/project-profiles/summary', (req, res) => {
  const batch = latestBatch()
  if (!batch) return res.json({ batch: null, totals: { profiles: 0, phases: 0 }, areas: [], propertyTypes: [] })
  const scope = serviceCenterScopeWhere(req, 'service_center')
  const where = ['batch_id = ?']
  const params: any[] = [batch.id]
  if (scope.clause) { where.push(scope.clause); params.push(...scope.params) }
  const clause = where.join(' AND ')
  const changes = latestEffectiveMasterChanges()
  const scopedRows = (db.prepare(`SELECT * FROM project_profiles WHERE ${clause}`).all(...params) as any[])
    .map(row => {
      const effective = effectiveServiceCenterState(row.service_center, row.area, row.management_status, changes)
      return { ...row, area: effective.area, management_status: effective.status }
    })
  const totals = scopedRows.reduce((sum, row) => ({
    profiles: sum.profiles + 1,
    phases: sum.phases + Number(row.phase_count || 0),
    managed_area: sum.managed_area + Number(row.managed_area || 0),
    pending_area: sum.pending_area + Number(row.pending_area || 0),
    signed_units: sum.signed_units + Number(row.signed_units || 0),
    movedin_units: sum.movedin_units + Number(row.movedin_units || 0),
  }), { profiles: 0, phases: 0, managed_area: 0, pending_area: 0, signed_units: 0, movedin_units: 0 })
  const groupedAreas = new Map<string, any>()
  const groupedTypes = new Map<string, any>()
  for (const row of scopedRows) {
    const areaRow = groupedAreas.get(row.area) || { area: row.area, profiles: 0, phases: 0, managed_area: 0, pending_area: 0 }
    areaRow.profiles += 1; areaRow.phases += Number(row.phase_count || 0); areaRow.managed_area += Number(row.managed_area || 0); areaRow.pending_area += Number(row.pending_area || 0)
    groupedAreas.set(row.area, areaRow)
    const typeRow = groupedTypes.get(row.property_type) || { property_type: row.property_type, profiles: 0, phases: 0 }
    typeRow.profiles += 1; typeRow.phases += Number(row.phase_count || 0); groupedTypes.set(row.property_type, typeRow)
  }
  const areas = [...groupedAreas.values()].sort((a, b) => a.area.localeCompare(b.area, 'zh-CN'))
  const propertyTypes = [...groupedTypes.values()].sort((a, b) => b.profiles - a.profiles || a.property_type.localeCompare(b.property_type, 'zh-CN'))
  const profileIds = scopedRows.map(row => Number(row.id))
  const evidence = aggregateSourceEvidence(profileIds)
  res.json({
    batch: { id: batch.id, sourceFile: basename(batch.source_file), sourceSha256: batch.source_sha256, sourceSheet: batch.source_sheet, filterStatus: batch.filter_status, importedAt: batch.imported_at },
    totals: {
      ...totals,
      linked_profiles: evidence.linkedProfiles,
      payment_linked_profiles: evidence.paymentLinkedProfiles,
      collection_linked_profiles: evidence.collectionLinkedProfiles,
      conflicted_profiles: evidence.conflictedProfiles,
      unmatched_profiles: evidence.unmatchedProfiles,
    },
    summary: {
      granularity: 'project_directory',
      operatingFactsAvailable: false,
      message: '项目档案仅发布权威目录，不承载服务中心经营金额。',
    },
    areas,
    propertyTypes,
  })
})

router.get('/api/project-profiles', (req, res) => {
  const batch = latestBatch()
  if (!batch) return res.json({ batch: null, rows: [], total: 0 })
  const scope = serviceCenterScopeWhere(req, 'service_center')
  const area = String(req.query.area || '').trim()
  const propertyType = String(req.query.propertyType || '').trim()
  const q = String(req.query.q || '').trim()
  const where = ['batch_id = ?']
  const params: any[] = [batch.id]
  if (scope.clause) { where.push(scope.clause); params.push(...scope.params) }
  const rows = db.prepare(`
    SELECT id, service_center, region, area, company_entity, management_status,
           phase_count, property_type, service_type, project_source, client_type,
           province, city, address, signed_area, phase_signed_area, managed_area,
           pending_area, signed_units, movedin_units
    FROM project_profiles WHERE ${where.join(' AND ')}
    ORDER BY area, service_center
  `).all(...params) as any[]
  const changes = latestEffectiveMasterChanges()
  const collisionKeys = sourceLinkCollisionKeys()
  const enrichedRows = rows.map(row => {
    const effective = effectiveServiceCenterState(row.service_center, row.area, row.management_status, changes)
    return { ...row, area: effective.area, management_status: effective.status, sourceEvidence: sourceEvidenceForProfile(row.id, collisionKeys) }
  }).filter(row => (!area || row.area === area)
    && (!propertyType || row.property_type === propertyType)
    && (!q || [row.service_center, row.city, row.address].some(value => String(value || '').includes(q))))
    .sort((a, b) => a.area.localeCompare(b.area, 'zh-CN') || a.service_center.localeCompare(b.service_center, 'zh-CN'))
  res.json({
    batch: { id: batch.id, sourceFile: basename(batch.source_file), sourceSha256: batch.source_sha256, importedAt: batch.imported_at },
    rows: enrichedRows,
    total: enrichedRows.length,
  })
})

router.get('/api/project-profiles/:id', (req, res) => {
  const batch = latestBatch()
  if (!batch) return res.status(404).json({ error: '尚未导入项目档案' })
  const profile = db.prepare('SELECT * FROM project_profiles WHERE id = ? AND batch_id = ?').get(Number(req.params.id), batch.id) as any
  if (!profile) return res.status(404).json({ error: '项目档案不存在' })
  if (!canAccessServiceCenter(req, profile.service_center)) return denyScopedResource(req, res, '服务中心档案不存在或无权访问')
  const effective = effectiveServiceCenterState(profile.service_center, profile.area, profile.management_status)
  profile.area = effective.area
  profile.management_status = effective.status
  const phases = (db.prepare(`
    SELECT id, source_row, phase_name, management_status, payload_json
    FROM project_phase_profiles WHERE profile_id = ? AND batch_id = ? ORDER BY source_row
  `).all(profile.id, batch.id) as any[]).map(row => ({
    id: row.id, sourceRow: row.source_row, phaseName: row.phase_name,
    managementStatus: row.management_status, ...parsePayload(row.payload_json),
  }))
  let sourceRows: number[] = []
  try { sourceRows = JSON.parse(profile.source_rows_json || '[]') } catch {}
  delete profile.source_rows_json
  res.json({
    batch: { id: batch.id, sourceFile: basename(batch.source_file), sourceSha256: batch.source_sha256, importedAt: batch.imported_at },
    profile: { ...profile, sourceRows, sourceEvidence: sourceEvidenceForProfile(profile.id) },
    phases,
  })
})

export default router
