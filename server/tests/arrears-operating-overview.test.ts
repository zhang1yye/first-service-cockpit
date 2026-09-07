import assert from 'node:assert/strict'
import test from 'node:test'
import { buildArrearsOperatingOverview } from '../src/arrears-operating-overview.js'

const projects = [
  { id: 1, area: '朝阳片区', service_center: '项目甲', management_status: '在管' },
  { id: 2, area: '海淀片区', service_center: '项目乙', management_status: '在管' },
]

test('overview selects only latest effective scoped batch per project', () => {
  const overview = buildArrearsOperatingOverview({
    projects,
    canAccessProject: project => project.id === 1,
    batches: [
      { id: 10, project_id: 1, project_name: '项目甲', business_date: '2026-07-31', status: 'analyzed' },
      { id: 11, project_id: 1, project_name: '项目甲', business_date: '2026-07-31', status: 'analyzed' },
      { id: 12, project_id: 1, project_name: '项目甲', business_date: '2026-08-01', status: 'revoked' },
      { id: 13, project_id: 1, project_name: '项目甲', business_date: '2026-08-02', status: 'blocked' },
      { id: 20, project_id: 2, project_name: '项目乙', business_date: '2026-07-31', status: 'analyzed' },
    ],
    ledgerRows: [
      { batch_id: 10, resource_hash: 'old', arrears_amount: 999, fee_item: '物业费', ageing_days: 500 },
      { batch_id: 11, resource_hash: 'r1', arrears_amount: 100, fee_item: '物业费', ageing_days: 100 },
      { batch_id: 11, resource_hash: 'r2', arrears_amount: -20, fee_item: '冲销', ageing_days: 400 },
      { batch_id: 11, resource_hash: 'r3', arrears_amount: null, fee_item: '物业费', ageing_days: null },
      { batch_id: 12, resource_hash: 'revoked', arrears_amount: 500, fee_item: '物业费', ageing_days: 700 },
      { batch_id: 20, resource_hash: 'hidden', arrears_amount: 800, fee_item: '物业费', ageing_days: 700 },
    ],
    communicationRows: [
      { batch_id: 11, resource_hash: 'r1' },
    ],
    results: [
      { batch_id: 11, resource_hash: 'r1', human_status: 'confirmed', human_category: 'payment_difficulty', analysis_status: 'ai_analyzed', ai_category: 'billing_dispute', rule_category: 'unknown' },
      { batch_id: 11, resource_hash: 'r2', human_status: 'pending', human_category: '', analysis_status: 'ai_analyzed', ai_category: 'billing_dispute', rule_category: 'unknown' },
      { batch_id: 11, resource_hash: 'r3', human_status: 'pending', human_category: '', analysis_status: 'pending_ai', ai_category: '', rule_category: 'service_dispute' },
    ],
  })

  assert.equal(overview.ready, true)
  assert.equal(overview.effectiveBatchCount, 1)
  assert.equal(overview.revokedBatchCount, 1)
  assert.equal(overview.projectCount, 1)
  assert.equal(overview.resourceCount, 3)
  assert.equal(overview.totalAmount, 80)
  assert.equal(overview.amountCompletenessRate, 2 / 3)
  assert.equal(overview.longAgeingAmount, -20)
  assert.equal(overview.missingCommunicationResourceCount, 2)
  assert.equal(overview.confirmedReviewCount, 1)
  assert.equal(overview.pendingReviewCount, 2)
  assert.equal(overview.latestBusinessDate, '2026-07-31')
  assert.deepEqual(overview.causeBreakdown.map(item => [item.cause, item.resourceCount]), [
    ['unknown', 2],
    ['payment_difficulty', 1],
  ])
})

test('同项目只累计最新业务日期，已删归档不进入经营汇总，人工驳回不回退AI类别', () => {
  const overview = buildArrearsOperatingOverview({
    projects,
    canAccessProject: () => true,
    batches: [
      { id: 1, project_id: 1, project_name: '项目甲', business_date: '2026-08-11', status: 'analyzed', archive_delete_state: 'active', archive_deleted_at: '' },
      { id: 2, project_id: 1, project_name: '项目甲', business_date: '2026-08-12', status: 'analyzed', archive_delete_state: 'active', archive_deleted_at: '' },
      { id: 3, project_id: 2, project_name: '项目乙', business_date: '2026-08-12', status: 'analyzed', archive_delete_state: 'deleted', archive_deleted_at: '2026-08-12' },
    ],
    ledgerRows: [
      { batch_id: 1, resource_hash: 'old', arrears_amount: 100, fee_item: '物业费', ageing_days: 10 },
      { batch_id: 2, resource_hash: 'new', arrears_amount: 200, fee_item: '物业费', ageing_days: 20 },
      { batch_id: 3, resource_hash: 'deleted', arrears_amount: 300, fee_item: '物业费', ageing_days: 30 },
    ],
    communicationRows: [],
    results: [{ batch_id: 2, resource_hash: 'new', human_status: 'rejected', human_category: '', analysis_status: 'ai_analyzed', ai_category: 'vacancy', rule_category: 'service_dispute' }],
  })
  assert.equal(overview.effectiveBatchCount, 1)
  assert.equal(overview.resourceCount, 1)
  assert.equal(overview.totalAmount, 200)
  assert.deepEqual(overview.causeBreakdown.map(item => item.cause), ['unknown'])
  assert.equal(overview.pendingReviewCount,0)
  assert.equal(overview.rejectedReviewCount,1)
})

test('overview returns explicit unavailable values when no effective batch exists', () => {
  const overview = buildArrearsOperatingOverview({
    projects,
    canAccessProject: () => true,
    batches: [{ id: 1, project_id: 1, project_name: '项目甲', business_date: '2026-07-31', status: 'revoked' }],
    ledgerRows: [],
    communicationRows: [],
    results: [],
  })
  assert.equal(overview.ready, false)
  assert.equal(overview.effectiveBatchCount, 0)
  assert.equal(overview.totalAmount, null)
  assert.equal(overview.amountCompletenessRate, null)
  assert.equal(overview.latestBusinessDate, null)
  assert.deepEqual(overview.projectBreakdown, [])
})
