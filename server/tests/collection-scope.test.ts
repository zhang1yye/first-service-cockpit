import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getCollectionDisplayRate,
  isHeatingAdjustedCollectionCenter,
  resolveCollectionOutstanding,
} from '../src/collection-scope.js'

test('special heating centers use corrected received divided by corrected receivable', () => {
  assert.equal(isHeatingAdjustedCollectionCenter('第一服务北京万国城MOMΛ服务中心'), true)
  assert.equal(isHeatingAdjustedCollectionCenter('第一服务满庭青云服务中心'), true)
  assert.equal(isHeatingAdjustedCollectionCenter('第一服务北京满庭芳园服务中心'), true)

  assert.equal(
    getCollectionDisplayRate('第一服务北京万国城MOMΛ服务中心', 2236.69, 1635.69, 0.7478),
    0.7313,
  )
  assert.equal(
    getCollectionDisplayRate('第一服务满庭青云服务中心', 640.91, 502.35, 0.7911),
    0.7838,
  )
})

test('ordinary centers keep official row rate and zero receivable remains safe', () => {
  assert.equal(isHeatingAdjustedCollectionCenter('第一服务北京通州万国城MOMΛ服务中心'), false)
  assert.equal(
    getCollectionDisplayRate('第一服务北京通州万国城MOMΛ服务中心', 1, 0.5, 0.7502),
    0.7502,
  )
  assert.equal(getCollectionDisplayRate('第一服务满庭青云服务中心', 0, 0, 0.7911), 0.7911)
  assert.equal(
    getCollectionDisplayRate('第一服务普通测试服务中心', 100, 75, null),
    null,
    '普通中心缺官方率时不得静默改用金额率',
  )
})

test('outstanding keeps source values and never clamps a derived negative balance to zero', () => {
  assert.equal(resolveCollectionOutstanding(-7, 100, 110), -7)
  assert.equal(resolveCollectionOutstanding(null, 100, 110), -10)
  assert.equal(resolveCollectionOutstanding(null, null, 110), null)
})
