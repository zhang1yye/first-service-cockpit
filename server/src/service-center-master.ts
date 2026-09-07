import db from './db.js'
import { normalizeCollectionCenter } from './collection-quality.js'

export const SERVICE_CENTER_ACTIVE = '在管'
export const SERVICE_CENTER_WITHDRAWN = '已撤场'
export const SERVICE_CENTER_WITHDRAWN_AREA = '撤场项目'
export const SERVICE_CENTER_STATUSES = [SERVICE_CENTER_ACTIVE, SERVICE_CENTER_WITHDRAWN] as const
export type ServiceCenterStatus = typeof SERVICE_CENTER_STATUSES[number]

export type ServiceCenterMasterChange = {
  id: number
  center_key: string
  service_center: string
  action_type: string
  previous_area: string
  new_area: string
  previous_status: string
  new_status: ServiceCenterStatus
  effective_date: string
  reason: string
  evidence: string
  reconciliation_json: string
  created_by: number | null
  created_by_name: string
  created_at: string
  rolled_back_at: string | null
  rolled_back_by: number | null
  rolled_back_by_name: string | null
  rollback_reason: string | null
}

export function masterCenterKey(value: unknown): string {
  return normalizeCollectionCenter(value)
}

export function businessDate(): string {
  return String((db.prepare("SELECT date('now','localtime') value").get() as any)?.value || '')
}

export function canonicalServiceCenterArea(value: unknown): string {
  const area = String(value || '').trim()
  return area === '已撤场项目' || area === SERVICE_CENTER_WITHDRAWN_AREA
    ? SERVICE_CENTER_WITHDRAWN_AREA
    : area
}

export function latestEffectiveMasterChanges(database: any = db, asOf = businessDate()): Map<string, ServiceCenterMasterChange> {
  const rows = database.prepare(`SELECT * FROM service_center_master_changes
    WHERE rolled_back_at IS NULL AND effective_date<=?
    ORDER BY effective_date DESC,id DESC`).all(asOf) as ServiceCenterMasterChange[]
  const result = new Map<string, ServiceCenterMasterChange>()
  for (const row of rows) if (!result.has(row.center_key)) result.set(row.center_key, row)
  return result
}

export function latestScheduledMasterChanges(database: any = db, asOf = businessDate()): Map<string, ServiceCenterMasterChange> {
  const rows = database.prepare(`SELECT * FROM service_center_master_changes
    WHERE rolled_back_at IS NULL AND effective_date>?
    ORDER BY effective_date ASC,id ASC`).all(asOf) as ServiceCenterMasterChange[]
  const result = new Map<string, ServiceCenterMasterChange>()
  for (const row of rows) if (!result.has(row.center_key)) result.set(row.center_key, row)
  return result
}

export function effectiveServiceCenterState(
  serviceCenter: unknown,
  sourceArea: unknown,
  sourceStatus: unknown = SERVICE_CENTER_ACTIVE,
  changes = latestEffectiveMasterChanges(),
) {
  const key = masterCenterKey(serviceCenter)
  const change = changes.get(key)
  const status = (change?.new_status || String(sourceStatus || SERVICE_CENTER_ACTIVE)) as ServiceCenterStatus
  return {
    centerKey: key,
    serviceCenter: String(serviceCenter || '').trim(),
    area: status === SERVICE_CENTER_WITHDRAWN
      ? SERVICE_CENTER_WITHDRAWN_AREA
      : canonicalServiceCenterArea(change?.new_area || sourceArea),
    status,
    override: change || null,
  }
}

export function applyEffectiveMasterState(
  rows: any[],
  options: {
    centerField?: string
    areaField?: string
    statusField?: string | null
    asOf?: string
    database?: any
  } = {},
): any[] {
  const centerField = options.centerField || 'center'
  const areaField = options.areaField || 'area'
  const statusField = options.statusField === undefined ? null : options.statusField
  const changes = latestEffectiveMasterChanges(options.database || db, options.asOf || businessDate())
  return rows.flatMap(row => {
    const effective = effectiveServiceCenterState(
      row?.[centerField],
      row?.[areaField],
      statusField ? row?.[statusField] : SERVICE_CENTER_ACTIVE,
      changes,
    )
    return [{
      ...row,
      [areaField]: effective.area,
      ...(statusField ? { [statusField]: effective.status } : {}),
    }]
  })
}

export function currentMasterVersion(centerKey: string, database: any = db): number {
  const row = database.prepare(`SELECT COALESCE(MAX(id),0) version FROM service_center_master_changes
    WHERE center_key=?`).get(centerKey) as any
  return Number(row?.version || 0)
}

export function actionType(previousStatus: string, previousArea: string, nextStatus: string, nextArea: string): string {
  if (previousStatus === SERVICE_CENTER_ACTIVE && nextStatus === SERVICE_CENTER_WITHDRAWN) return 'withdraw'
  if (previousStatus === SERVICE_CENTER_WITHDRAWN && nextStatus === SERVICE_CENTER_ACTIVE) return 'restore'
  if (previousArea !== nextArea) return 'transfer'
  return 'correct'
}
