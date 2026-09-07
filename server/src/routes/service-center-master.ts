import { Router } from 'express'
import db from '../db.js'
import { requireAdmin } from '../auth.js'
import { logOperationStrict } from '../audit.js'
import {
  actionType,
  businessDate,
  currentMasterVersion,
  effectiveServiceCenterState,
  latestEffectiveMasterChanges,
  latestScheduledMasterChanges,
  masterCenterKey,
  SERVICE_CENTER_ACTIVE,
  SERVICE_CENTER_STATUSES,
  SERVICE_CENTER_WITHDRAWN,
  SERVICE_CENTER_WITHDRAWN_AREA,
} from '../service-center-master.js'

const router = Router()
const SPECIAL_AREAS = new Set(['华北汇总', '已撤场项目', SERVICE_CENTER_WITHDRAWN_AREA, '华北第一保洁', '华北地区公司'])
const datePattern = /^\d{4}-\d{2}-\d{2}$/

function latestBatchId(): number {
  return Number((db.prepare('SELECT id FROM project_profile_import_batches ORDER BY id DESC LIMIT 1').get() as any)?.id || 0)
}

function normalizeDate(value: unknown): string | null {
  const raw = String(value || '').trim()
  if (!datePattern.test(raw)) return null
  const [year, month, day] = raw.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? raw : null
}

function centerRecord(centerKey: string) {
  const batchId = latestBatchId()
  const profiles = db.prepare(`SELECT id,service_center,area,management_status,phase_count
    FROM project_profiles WHERE batch_id=? ORDER BY id`).all(batchId) as any[]
  const profile = profiles.find(row => masterCenterKey(row.service_center) === centerKey)
  if (!profile) return null
  const links = db.prepare(`SELECT source_system,source_center,link_method FROM project_profile_center_links
    WHERE batch_id=? AND profile_id=? ORDER BY source_system,source_center`).all(batchId, profile.id) as any[]
  const names = [...new Set([profile.service_center, ...links.map(row => row.source_center)].map(String))]
  const keys = [...new Set(names.map(masterCenterKey).filter(Boolean))]
  const keySet = new Set(keys)
  const payment = (db.prepare('SELECT center,area FROM payment_centers ORDER BY id DESC').all() as any[])
    .filter(row => keySet.has(masterCenterKey(row.center)))
  const collection = (db.prepare('SELECT center,area FROM collection_centers ORDER BY id DESC').all() as any[])
    .filter(row => keySet.has(masterCenterKey(row.center)))
  const changes = latestEffectiveMasterChanges()
  const scheduled = latestScheduledMasterChanges().get(centerKey) || null
  const effective = effectiveServiceCenterState(profile.service_center, profile.area, profile.management_status, changes)
  return { batchId, profile, links, names, keys, payment, collection, effective, scheduled }
}

function geographicAreas(): string[] {
  const values = new Set<string>()
  for (const table of ['project_profiles', 'payment_centers', 'collection_centers']) {
    try {
      for (const row of db.prepare(`SELECT DISTINCT area FROM ${table} WHERE COALESCE(area,'')<>'' ORDER BY area`).all() as any[]) {
        const area = String(row.area || '').trim()
        if (area && !SPECIAL_AREAS.has(area)) values.add(area)
      }
    } catch {}
  }
  for (const row of db.prepare(`SELECT DISTINCT new_area area FROM service_center_master_changes
    WHERE rolled_back_at IS NULL AND new_status='在管'`).all() as any[]) {
    const area = String(row.area || '').trim()
    if (area && !SPECIAL_AREAS.has(area)) values.add(area)
  }
  return [...values].sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

function userImpact(record: any, nextArea: string, nextStatus: string) {
  const aliasKeys = new Set(record.keys)
  const direct: any[] = []
  const areaManagers: any[] = []
  for (const user of db.prepare(`SELECT id,username,role,area_scope,service_center_scope FROM users ORDER BY id`).all() as any[]) {
    const selected = String(user.service_center_scope || '').split(',').map(masterCenterKey).filter(Boolean)
    if (selected.some(key => aliasKeys.has(key))) direct.push({ id: user.id, username: user.username, role: user.role })
    if (user.role === 'area_manager' && [record.effective.area, nextArea].includes(String(user.area_scope || ''))) {
      areaManagers.push({ id: user.id, username: user.username, area: user.area_scope })
    }
  }
  return {
    directlyBound: direct,
    affectedAreaManagers: areaManagers,
    tokenRefreshRequired: direct.length > 0 || areaManagers.length > 0,
    message: nextStatus === SERVICE_CENTER_WITHDRAWN
      ? '撤场生效后，该中心保留在系统中并统一归入“撤场项目”片区。'
      : record.effective.area !== nextArea
        ? '转片区生效后，旧片区权限不再覆盖该中心，新片区权限开始覆盖。'
        : '本次状态恢复不会自动给账号新增权限，现有绑定按有效主数据重新校验。',
  }
}

function reconciliation(record: any, nextArea = record.effective.area, nextStatus = record.effective.status) {
  const sources = [
    { source: '项目档案', area: record.profile.area, status: record.profile.management_status },
    ...record.payment.map((row: any) => ({ source: '回款数据', area: row.area, status: row.area === '已撤场项目' ? SERVICE_CENTER_WITHDRAWN : SERVICE_CENTER_ACTIVE })),
    ...record.collection.map((row: any) => ({ source: '收缴数据', area: row.area, status: SERVICE_CENTER_ACTIVE })),
  ]
  const differences = sources.filter(row => row.status !== nextStatus || (nextStatus === SERVICE_CENTER_ACTIVE && row.area && row.area !== nextArea))
  return {
    checkedAt: new Date().toISOString(),
    effective: { area: nextArea, status: nextStatus },
    sources,
    aligned: differences.length === 0,
    differences,
    message: differences.length
      ? `发现${differences.length}项源数据与拟定主数据不一致；主数据变更保留，但需在下一次源表维护时同步。`
      : '项目档案、回款及收缴来源与主数据一致。',
  }
}

function parseProposal(req: any, record: any) {
  const newStatus = String(req.body?.newStatus || '').trim()
  const newArea = String(req.body?.newArea || '').trim()
  const effectiveDate = normalizeDate(req.body?.effectiveDate)
  const reason = String(req.body?.reason || '').trim() || '管理员直接调整服务中心主数据'
  const evidence = String(req.body?.evidence || '').trim()
  if (!SERVICE_CENTER_STATUSES.includes(newStatus as any)) return { error: '管理状态必须选择“在管”或“已撤场”' }
  if (!effectiveDate) return { error: '请选择有效的生效日期' }
  const today = businessDate()
  const limit = new Date(`${today}T00:00:00Z`); limit.setUTCDate(limit.getUTCDate() + 366)
  if (new Date(`${effectiveDate}T00:00:00Z`) > limit) return { error: '生效日期不能超过一年后的日期' }
  if (newStatus === SERVICE_CENTER_ACTIVE && (!newArea || !geographicAreas().includes(newArea))) return { error: '在管服务中心必须选择有效地理片区' }
  if (newStatus === SERVICE_CENTER_WITHDRAWN && newArea && SPECIAL_AREAS.has(newArea)) return { error: '撤场状态保留原所属片区，不要把“已撤场项目”作为片区' }
  if (reason.length > 500) return { error: '变更说明不能超过500字' }
  if (evidence.length > 500) return { error: '变更依据不能超过500字' }
  const area = newStatus === SERVICE_CENTER_WITHDRAWN ? SERVICE_CENTER_WITHDRAWN_AREA : newArea
  if (newStatus === record.effective.status && area === record.effective.area && effectiveDate <= today) return { error: '拟变更状态和片区与当前有效主数据相同' }
  return { newStatus, newArea: area, effectiveDate, reason, evidence }
}

function preview(centerKey: string, req: any) {
  const record = centerRecord(centerKey)
  if (!record) return { error: '服务中心不存在', status: 404 }
  const proposal = parseProposal(req, record)
  if ('error' in proposal) return { error: proposal.error, status: 400 }
  const impact = userImpact(record, proposal.newArea!, proposal.newStatus!)
  const check = reconciliation(record, proposal.newArea, proposal.newStatus)
  return {
    centerKey,
    serviceCenter: record.profile.service_center,
    version: currentMasterVersion(centerKey),
    current: { area: record.effective.area, status: record.effective.status, sourceArea: record.profile.area, sourceStatus: record.profile.management_status },
    proposed: proposal,
    actionType: actionType(record.effective.status, record.effective.area, proposal.newStatus!, proposal.newArea!),
    impact: {
      projectProfiles: 1,
      phases: Number(record.profile.phase_count || 0),
      mappings: record.links.length,
      paymentRows: record.payment.length,
      collectionRows: record.collection.length,
      users: impact,
      currentAggregation: proposal.newStatus === SERVICE_CENTER_WITHDRAWN ? '生效后服务中心及经营数据统一进入“撤场项目”片区，历史源表不改写。' : '生效后进入新片区的当前汇总，历史期间不改写。',
    },
    reconciliation: check,
    scheduled: record.scheduled,
  }
}

router.get('/api/service-center-master', requireAdmin, (req, res) => {
  const batchId = latestBatchId()
  const changes = latestEffectiveMasterChanges()
  const scheduled = latestScheduledMasterChanges()
  const q = String(req.query.q || '').trim().toLocaleLowerCase('zh-CN')
  const status = String(req.query.status || '').trim()
  const area = String(req.query.area || '').trim()
  const profiles = db.prepare(`SELECT id,service_center,area,management_status,phase_count FROM project_profiles
    WHERE batch_id=? ORDER BY area,service_center`).all(batchId) as any[]
  const rows = profiles.map(profile => {
    const key = masterCenterKey(profile.service_center)
    const effective = effectiveServiceCenterState(profile.service_center, profile.area, profile.management_status, changes)
    const record = centerRecord(key)!
    const check = reconciliation(record)
    return {
      centerKey: key,
      serviceCenter: profile.service_center,
      source: { area: profile.area, status: profile.management_status },
      effective: { area: effective.area, status: effective.status, effectiveDate: effective.override?.effective_date || null },
      scheduled: scheduled.get(key) ? { id: scheduled.get(key)!.id, area: scheduled.get(key)!.new_area, status: scheduled.get(key)!.new_status, effectiveDate: scheduled.get(key)!.effective_date } : null,
      phaseCount: Number(profile.phase_count || 0),
      mappingCount: record.links.length,
      reconciliation: { aligned: check.aligned, differenceCount: check.differences.length },
      version: currentMasterVersion(key),
    }
  }).filter(row => (!q || row.serviceCenter.toLocaleLowerCase('zh-CN').includes(q))
      && (!status || row.effective.status === status)
      && (!area || row.effective.area === area))
  const allRows = profiles.map(profile => effectiveServiceCenterState(profile.service_center, profile.area, profile.management_status, changes))
  res.json({
    businessDate: businessDate(),
    areas: geographicAreas(),
    totals: {
      centers: allRows.length,
      active: allRows.filter(row => row.status === SERVICE_CENTER_ACTIVE).length,
      withdrawn: allRows.filter(row => row.status === SERVICE_CENTER_WITHDRAWN).length,
      scheduled: scheduled.size,
      discrepancies: rows.filter(row => !row.reconciliation.aligned).length,
    },
    rows,
  })
})

router.get('/api/service-center-master/:centerKey/history', requireAdmin, (req, res) => {
  const key = masterCenterKey(req.params.centerKey)
  const record = centerRecord(key)
  if (!record) return res.status(404).json({ error: '服务中心不存在' })
  const rows = db.prepare(`SELECT * FROM service_center_master_changes WHERE center_key=? ORDER BY id DESC`).all(key)
  res.json({ serviceCenter: record.profile.service_center, rows })
})

router.post('/api/service-center-master/:centerKey/preview', requireAdmin, (req, res) => {
  const result = preview(masterCenterKey(req.params.centerKey), req)
  if ('error' in result) return res.status(Number(result.status || 400)).json({ error: result.error })
  res.json(result)
})

router.post('/api/service-center-master/:centerKey/changes', requireAdmin, (req: any, res) => {
  const key = masterCenterKey(req.params.centerKey)
  const result: any = preview(key, req)
  if (result.error) return res.status(Number(result.status || 400)).json({ error: result.error })
  const expectedVersion = Number(req.body?.expectedVersion)
  if (!Number.isInteger(expectedVersion) || expectedVersion !== result.version) return res.status(409).json({ error: '主数据已发生变化，请刷新后重新预览' })
  const proposed = result.proposed
  const inserted = db.transaction(() => {
    if (currentMasterVersion(key) !== expectedVersion) throw Object.assign(new Error('主数据已发生变化，请刷新后重新预览'), { statusCode: 409 })
    const row = db.prepare(`INSERT INTO service_center_master_changes
      (center_key,service_center,action_type,previous_area,new_area,previous_status,new_status,effective_date,
       reason,evidence,reconciliation_json,created_by,created_by_name)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      key, result.serviceCenter, result.actionType, result.current.area, proposed.newArea,
      result.current.status, proposed.newStatus, proposed.effectiveDate, proposed.reason, proposed.evidence,
      JSON.stringify(result.reconciliation), req.user?.userId || null, req.user?.username || 'system',
    )
    logOperationStrict(req, '变更服务中心主数据', `service-center:${key}`, {
      changeId: Number(row.lastInsertRowid), actionType: result.actionType,
      previous: result.current, proposed, impact: result.impact, reconciliation: result.reconciliation,
    })
    return Number(row.lastInsertRowid)
  })()
  res.status(201).json({ success: true, changeId: inserted, effectiveImmediately: proposed.effectiveDate <= businessDate() })
})

router.post('/api/service-center-master/changes/:id/rollback', requireAdmin, (req: any, res) => {
  const id = Number(req.params.id)
  const reason = String(req.body?.reason || '').trim()
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '变更编号无效' })
  if (reason.length < 4 || reason.length > 500) return res.status(400).json({ error: '请填写4至500字的回滚原因' })
  const change = db.prepare('SELECT * FROM service_center_master_changes WHERE id=?').get(id) as any
  if (!change) return res.status(404).json({ error: '变更记录不存在' })
  if (change.rolled_back_at) return res.status(409).json({ error: '该变更已经回滚' })
  const latest = db.prepare(`SELECT id FROM service_center_master_changes WHERE center_key=? AND rolled_back_at IS NULL ORDER BY id DESC LIMIT 1`).get(change.center_key) as any
  if (Number(latest?.id) !== id) return res.status(409).json({ error: '只能回滚该服务中心最新一条有效变更' })
  if (req.body?.confirmation !== change.service_center) return res.status(400).json({ error: '请输入完整服务中心名称确认回滚' })
  db.transaction(() => {
    db.prepare(`UPDATE service_center_master_changes SET rolled_back_at=datetime('now','localtime'),
      rolled_back_by=?,rolled_back_by_name=?,rollback_reason=? WHERE id=? AND rolled_back_at IS NULL`)
      .run(req.user?.userId || null, req.user?.username || 'system', reason, id)
    logOperationStrict(req, '回滚服务中心主数据变更', `service-center:${change.center_key}`, { changeId: id, reason })
  })()
  res.json({ success: true, changeId: id })
})

export default router
