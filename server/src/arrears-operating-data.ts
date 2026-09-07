import db from './db.js'
import { canAccessProjectRow } from './auth.js'
import { effectiveServiceCenterState } from './service-center-master.js'
import {
  buildArrearsOperatingOverview,
  selectEffectiveArrearsBatches,
  type ArrearsBatchRow,
  type ArrearsCommunicationRow,
  type ArrearsLedgerRow,
  type ArrearsOperatingOverview,
  type ArrearsProjectRow,
  type ArrearsResultRow,
} from './arrears-operating-overview.js'

function rowsForBatchIds<T>(sql: string, batchIds: number[]): T[] {
  if (!batchIds.length) return []
  const placeholders = batchIds.map(() => '?').join(',')
  return db.prepare(sql.replace('__BATCH_IDS__', placeholders)).all(...batchIds) as T[]
}

export function readArrearsOperatingOverview(req: any): ArrearsOperatingOverview {
  const projects = (db.prepare(`
    SELECT id,area,service_center,management_status
    FROM project_profiles
  `).all() as ArrearsProjectRow[]).map(project => {
    const effective = effectiveServiceCenterState(project.service_center, project.area, project.management_status)
    return { ...project, area: effective.area, management_status: effective.status }
  })
  const batches = db.prepare(`
    SELECT id,project_id,project_name,business_date,status,archive_delete_state,archive_deleted_at
    FROM arrears_upload_batches
    ORDER BY id DESC
  `).all() as ArrearsBatchRow[]
  const canAccessProject = (project: ArrearsProjectRow) => canAccessProjectRow(req, project)
  const selection = selectEffectiveArrearsBatches({ projects, batches, canAccessProject })
  const batchIds = selection.effectiveBatches.map(batch => batch.id)
  const ledgerRows = rowsForBatchIds<ArrearsLedgerRow>(`
    SELECT batch_id,resource_hash,arrears_amount,fee_item,ageing_days
    FROM arrears_ledger_rows
    WHERE batch_id IN (__BATCH_IDS__)
  `, batchIds)
  const communicationRows = rowsForBatchIds<ArrearsCommunicationRow>(`
    SELECT DISTINCT batch_id,resource_hash
    FROM arrears_communication_rows
    WHERE batch_id IN (__BATCH_IDS__)
  `, batchIds)
  const results = rowsForBatchIds<ArrearsResultRow>(`
    SELECT batch_id,resource_hash,human_status,human_category,analysis_status,ai_category,rule_category
    FROM arrears_analysis_results
    WHERE batch_id IN (__BATCH_IDS__)
  `, batchIds)
  return buildArrearsOperatingOverview({ projects, batches, ledgerRows, communicationRows, results, canAccessProject })
}
