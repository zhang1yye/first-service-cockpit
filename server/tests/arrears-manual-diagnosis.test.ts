import assert from 'node:assert/strict'
import test from 'node:test'
import { buildManualArrearsDiagnosis } from '../src/arrears-manual-diagnosis.js'

test('手动上传批次严格汇总为原型四类原因且未知事实不被补写', () => {
  const result = buildManualArrearsDiagnosis([
    { resourceDisplay: 'BJ-SD-1-1-101', resourceMasked: 'BJ***01', amount: 1000, periodStart: '2025-01-01', periodEnd: '2025-12-31', feeItems: '物业服务费', aiReason: '台账固定信号指向服务争议', category: 'service_dispute' },
    { resourceDisplay: 'BJ-SD-1-1-102', resourceMasked: 'BJ***02', amount: 800, periodStart: '', periodEnd: '', feeItems: '', aiReason: '', category: 'promised_payment' },
    { resourceDisplay: 'BJ-SD-1-1-103', resourceMasked: 'BJ***03', amount: 600, periodStart: '', periodEnd: '', feeItems: '', aiReason: '', category: 'unknown' },
    { resourceDisplay: 'BJ-SD-1-1-104', resourceMasked: 'BJ***04', amount: 400, periodStart: '', periodEnd: '', feeItems: '', aiReason: '', category: 'contact_barrier' },
    { resourceDisplay: 'BJ-SD-1-1-105', resourceMasked: 'BJ***05', amount: 200, periodStart: '', periodEnd: '', feeItems: '', aiReason: '', category: 'vacancy' },
  ], { serviceCenter: '测试服务中心', businessDate: '2026-08-28', communicationFilePresent: false })

  assert.equal(result.ready, true)
  assert.equal(result.analysisBasis, '欠费金额、账龄和房间信息以本次上传的欠费台账为准。本次未提供聊天记录，仅依据欠费台账进行分析。')
  assert.equal(result.summary.householdCount, 5)
  assert.equal(result.summary.totalAmount, 3000)
  assert.deepEqual(result.reasons.map(item => [item.key, item.householdCount, item.amount]), [
    ['dispute', 1, 1000],
    ['promised', 1, 800],
    ['insufficient', 2, 800],
    ['information', 1, 400],
  ])
  assert.deepEqual(result.reasons.map(item => item.label), [
    '服务质量或沟通争议',
    '承诺缴费但未兑现',
    '欠费原因证据不足',
    '失联或产权信息待确认',
  ])
  assert.equal(result.actions.length, 4)
  assert.deepEqual(result.priorityHouseholds.map(item => item.room), ['BJ-SD-1-1-101', 'BJ-SD-1-1-102', 'BJ-SD-1-1-103', 'BJ-SD-1-1-104', 'BJ-SD-1-1-105'])
  assert.equal(result.reasons[0].households[0].room, 'BJ-SD-1-1-101')
  assert.equal(result.reasons[0].households[0].actionPlan.steps.length >= 6, true)
  assert.equal(result.reasons[0].households[0].actionPlan.completionStandards.length >= 3, true)
  assert.equal(result.reasons[0].households[0].actionPlan.escalationTriggers.length >= 2, true)
  assert.equal(result.reasons[0].households[0].actionPlan.owner, '项目经理＋客服经理')
  assert.equal(JSON.stringify(result).includes('未联系'), false)
  assert.equal(JSON.stringify(result).includes('绿仔'), false)
})

test('聊天文件存在时仅作为辅助证据，不改变上传台账事实口径', () => {
  const result = buildManualArrearsDiagnosis([
    { resourceDisplay: 'BJ-SD-1-1-101', resourceMasked: 'BJ***01', amount: 1000, periodStart: '', periodEnd: '', feeItems: '', aiReason: '', category: 'unknown' },
  ], { serviceCenter: '测试服务中心', businessDate: '2026-08-28', communicationFilePresent: true })
  assert.match(result.analysisBasis, /聊天记录仅作为辅助证据/)
  assert.match(result.analysisBasis, /上传的欠费台账为准/)
})
