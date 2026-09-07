import test from 'node:test'
import assert from 'node:assert/strict'
import { nextQualityStatus, validateQualityTransition } from '../src/quality-workflow.js'

test('quality responsibility workflow only advances one strict step', () => {
  assert.equal(nextQualityStatus('pending'), 'claimed')
  assert.equal(nextQualityStatus('claimed'), 'in_progress')
  assert.equal(nextQualityStatus('in_progress'), 'review')
  assert.equal(nextQualityStatus('review'), 'resolved')
  assert.equal(nextQualityStatus('resolved'), null)
  assert.deepEqual(validateQualityTransition('pending', 'in_progress', { owner: '张三' }), {
    ok: false,
    error: '状态只能从待处理推进到已认领',
  })
})

test('claim requires owner and review/resolution require an explanation', () => {
  assert.equal(validateQualityTransition('pending', 'claimed', {}).ok, false)
  assert.equal(validateQualityTransition('pending', 'claimed', { owner: '张三', dueDate: '2026-09-01' }).ok, true)
  assert.equal(validateQualityTransition('in_progress', 'review', { note: '' }).ok, false)
  assert.equal(validateQualityTransition('in_progress', 'review', { note: '已核对源文件差异', evidenceRef: '归档/差异清单.md' }).ok, true)
  assert.equal(validateQualityTransition('review', 'resolved', { note: '复核通过，差异清单已归档' }).ok, true)
})
