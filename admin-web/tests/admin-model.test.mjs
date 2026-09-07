import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compactSyncRuns,
  freshnessMeta,
  formatValue,
  issueTone,
  nextWorkflowAction,
  publicationStatusLabel,
  qualityTimingTone,
  reconciliationLabel,
  roleLabel,
  sourceFreshnessLabel,
  workflowLabel,
} from '../src/lib/admin-model.mjs'

test('formatValue renders unavailable facts as dash rather than zero', () => {
  assert.equal(formatValue(null, '万元'), '—')
  assert.equal(formatValue(undefined, '%'), '—')
  assert.equal(formatValue(0, '万元'), '0.00万元')
})

test('issue severity has stable visual semantics', () => {
  assert.equal(issueTone('critical'), 'danger')
  assert.equal(issueTone('high'), 'warning')
  assert.equal(issueTone('medium'), 'info')
})

test('role labels are business readable', () => {
  assert.equal(roleLabel('admin'), '系统管理员')
  assert.equal(roleLabel('area_manager'), '片区负责人')
  assert.equal(roleLabel('viewer'), '只读用户')
})

test('stale source is never labelled healthy', () => {
  assert.equal(sourceFreshnessLabel({ status: 'connected', freshness: 'stale' }), '已过期')
  assert.equal(sourceFreshnessLabel({ status: 'connected', freshness: 'fresh' }), '正常')
  assert.equal(sourceFreshnessLabel(null), '不可用')
})

test('quality workflow actions and labels follow the strict responsibility chain', () => {
  assert.equal(workflowLabel('pending'), '待处理')
  assert.deepEqual(nextWorkflowAction('pending'), { status: 'claimed', label: '认领' })
  assert.deepEqual(nextWorkflowAction('in_progress'), { status: 'review', label: '提交复核', requiresNote: true })
  assert.deepEqual(nextWorkflowAction('review'), { status: 'resolved', label: '确认解决', requiresNote: true })
  assert.equal(nextWorkflowAction('resolved'), null)
})

test('reconciliation state remains explicit', () => {
  assert.equal(reconciliationLabel('matched'), '已勾稽')
  assert.equal(reconciliationLabel('warning'), '有差异')
  assert.equal(reconciliationLabel('unavailable'), '不可勾稽')
})

test('publication completion and responsibility timing have stable business labels', () => {
  assert.equal(publicationStatusLabel('complete'), '已完整发布')
  assert.equal(publicationStatusLabel('partial'), '部分更新')
  assert.equal(publicationStatusLabel('failed'), '更新失败')
  assert.equal(publicationStatusLabel('unknown'), '结果未知')
  assert.equal(qualityTimingTone({ isOverdue: true }), 'danger')
  assert.equal(qualityTimingTone({ isOverdue: false, isDueSoon: true }), 'warning')
  assert.equal(qualityTimingTone({ isOverdue: false, isDueSoon: false }), 'neutral')
})

test('freshnessMeta exposes source age instead of treating an old connected source as current', () => {
  const now = '2026-08-10T12:00:00+08:00'
  assert.deepEqual(freshnessMeta('2026-08-10T08:00:00+08:00', now), { label: '今日更新', tone: 'success', ageDays: 0 })
  assert.deepEqual(freshnessMeta('2026-08-08T08:00:00+08:00', now), { label: '2天前', tone: 'warning', ageDays: 2 })
  assert.deepEqual(freshnessMeta('2026-08-05T08:00:00+08:00', now), { label: '5天前·已过期', tone: 'danger', ageDays: 5 })
})

test('compactSyncRuns merges exact repeated warnings but preserves distinct executions', () => {
  const rows = [
    { id: 1, source_name: 'APH回款', run_type: 'manual-check', status: 'warning', health: 'warning', message: '连接超时', operator: 'system', finished_at: '2026-07-12 08:00:05' },
    { id: 2, source_name: 'APH回款', run_type: 'manual-check', status: 'warning', health: 'warning', message: '连接超时', operator: 'system', finished_at: '2026-07-12 08:00:31' },
    { id: 3, source_name: 'APH回款', run_type: 'manual-check', status: 'success', health: 'ok', message: '恢复', operator: 'system', finished_at: '2026-07-12 08:05:00' },
  ]
  const compacted = compactSyncRuns(rows)
  assert.equal(compacted.length, 2)
  assert.equal(compacted[0].repeat_count, 2)
  assert.equal(compacted[1].repeat_count, 1)
})
