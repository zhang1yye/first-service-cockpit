import assert from 'node:assert/strict'
import test from 'node:test'
import { DEMO_PROJECT_NAMES, evaluateProjectDataGate } from '../src/data-quality-gate.js'

test('known demo-only projects block AI, forecast and formal output generation', () => {
  const result = evaluateProjectDataGate({
    projectNames: [...DEMO_PROJECT_NAMES],
    copiedSnapshotProjectCount: 10,
  })
  assert.equal(result.ready, false)
  assert.equal(result.demoProjectCount, 10)
  assert.ok(result.reasons.some(reason => reason.includes('演示项目')))
})

test('an empty operating project table remains unavailable rather than healthy', () => {
  const result = evaluateProjectDataGate({ projectNames: [], copiedSnapshotProjectCount: 0 })
  assert.equal(result.ready, false)
  assert.ok(result.reasons.some(reason => reason.includes('不接入')))
})

test('verified projects without copied snapshots pass the gate', () => {
  const result = evaluateProjectDataGate({
    projectNames: ['第一服务北京真实项目A', '第一服务天津真实项目B'],
    copiedSnapshotProjectCount: 0,
    unverifiedProjectCount: 0,
    inactiveProjectCount: 0,
    missingSourceBatchCount: 0,
  })
  assert.equal(result.ready, true)
  assert.equal(result.demoProjectCount, 0)
  assert.deepEqual(result.reasons, [])
})

test('an arbitrary non-demo name does not bypass source validation', () => {
  const result = evaluateProjectDataGate({
    projectNames: ['任意手工项目'],
    copiedSnapshotProjectCount: 0,
    unverifiedProjectCount: 1,
    missingSourceBatchCount: 1,
  })
  assert.equal(result.ready, false)
  assert.match(result.reasons.join('；'), /未通过来源验证/)
  assert.match(result.reasons.join('；'), /缺少来源批次/)
})

test('copied snapshots block trend-dependent outputs even with non-demo projects', () => {
  const result = evaluateProjectDataGate({
    projectNames: ['第一服务北京真实项目A'],
    copiedSnapshotProjectCount: 1,
  })
  assert.equal(result.ready, false)
  assert.ok(result.reasons.some(reason => reason.includes('复制')))
})
