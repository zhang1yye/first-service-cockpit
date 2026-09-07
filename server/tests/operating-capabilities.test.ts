import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOperatingCapabilities } from '../src/operating-capabilities.js'

function input() {
  return {
    aph: {
      paymentCenterCount: 56, verifiedDailyCenterCount: 56, coverageComplete: true,
      businessDate: '2026-08-15', lastValidatedAt: '2026-08-15T09:00:00+08:00',
      qualityStatus: 'verified', sourceStatus: 'available', stale: false,
    },
    lvzai: {
      scopedCenterCount: 35, publicationStatus: 'published',
      businessDate: '2026-08-15', lastValidatedAt: '2026-08-15T09:05:00+08:00',
      sourceStatus: 'available', stale: false,
    },
    projectDirectory: { ready: true, projectCount: 42 },
  }
}

test('APH和绿仔可用时只开放服务中心经营指标', () => {
  const result = buildOperatingCapabilities(input())
  assert.equal(result.status, 'ready')
  assert.deepEqual(result.supportedGrains, ['region', 'area', 'service-center'])
  assert.equal(result.supportedMetrics.every(metric => metric.available), true)
  assert.equal(result.presentationPolicy.showServiceCenterOperations, true)
  assert.equal(result.presentationPolicy.showProjectOperatingMetrics, false)
  assert.equal(result.sources.projectDirectory.operatingFactsAvailable, false)
})

test('绿仔未发布时收缴指标不可展示但APH能力仍保留', () => {
  const changed = input()
  changed.lvzai.publicationStatus = 'blocked'
  const result = buildOperatingCapabilities(changed)
  assert.equal(result.status, 'partial')
  assert.equal(result.supportedMetrics.filter(metric => metric.source === 'APH').every(metric => metric.available), true)
  assert.equal(result.supportedMetrics.filter(metric => metric.source === '绿仔').every(metric => !metric.available), true)
})

test('项目目录不能解锁当前系统明确不接入的项目经营指标', () => {
  const result = buildOperatingCapabilities(input())
  assert.equal(result.excludedMetrics.length, 9)
  assert.equal(result.excludedMetrics.every(metric => metric.status === 'not-connected'), true)
  assert.match(result.excludedMetrics[0].reason, /当前系统范围不接入/)
  assert.equal(result.presentationPolicy.projectOperatingMetricsPolicy, 'not-connected')
  assert.equal(result.presentationPolicy.excludedValueLabel, '当前系统不接入')
})

test('APH陈旧或无效时不得因旧业务日期和非零计数标记为ready', () => {
  const stale = input()
  stale.aph.businessDate = '2026-01-01'
  stale.aph.lastValidatedAt = '2026-01-01T09:00:00+08:00'
  stale.aph.stale = true
  const staleResult = buildOperatingCapabilities(stale)
  assert.equal(staleResult.sources.aph.status, 'stale')
  assert.equal(staleResult.supportedMetrics.filter(metric => metric.source === 'APH').every(metric => !metric.available), true)

  const invalid = input()
  invalid.aph.qualityStatus = 'invalid'
  const invalidResult = buildOperatingCapabilities(invalid)
  assert.equal(invalidResult.sources.aph.status, 'invalid')
  assert.equal(invalidResult.status, 'partial')

  const incomplete = input()
  incomplete.aph.verifiedDailyCenterCount = 55
  incomplete.aph.coverageComplete = false
  const incompleteResult = buildOperatingCapabilities(incomplete)
  assert.equal(incompleteResult.sources.aph.status, 'partial')
  assert.equal(incompleteResult.supportedMetrics.filter(metric => metric.source === 'APH').every(metric => !metric.available), true)
})

test('APH原始payment与已验证daily行数不相等时即使coverage标记为真也不能ready', () => {
  const mismatched = input()
  mismatched.aph.paymentCenterCount = 40
  mismatched.aph.verifiedDailyCenterCount = 39
  mismatched.aph.coverageComplete = true
  const result = buildOperatingCapabilities(mismatched)
  assert.equal(result.sources.aph.status, 'partial')
  assert.equal(result.supportedMetrics.filter(metric => metric.source === 'APH').every(metric => !metric.available), true)
})

test('绿仔质量陈旧或发布被阻断时传播正式门禁状态', () => {
  const stale = input()
  stale.lvzai.stale = true
  stale.lvzai.sourceStatus = 'stale'
  assert.equal(buildOperatingCapabilities(stale).sources.lvzai.status, 'stale')

  const unpublished = input()
  unpublished.lvzai.publicationStatus = 'unpublished'
  assert.equal(buildOperatingCapabilities(unpublished).sources.lvzai.status, 'unpublished')
})
