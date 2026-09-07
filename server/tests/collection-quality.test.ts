import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateCollectionSource } from '../src/collection-quality.js'

const now = Date.parse('2026-08-03T12:00:00+08:00')
const validRows = Array.from({ length: 35 }, (_, index) => ({
  center: `第一服务项目${index + 1}服务中心`,
  receivable: 100 + index,
  received: 80 + index,
  collectionRate: (80 + index) / (100 + index),
}))

test('official 35-row unique fresh collection source passes', () => {
  const result = evaluateCollectionSource(validRows, '2026-08-02T17:31:00+08:00', now)
  assert.equal(result.ready, true)
  assert.equal(result.status, 'available')
})

test('non-35 official range is blocked', () => {
  const result = evaluateCollectionSource(validRows.slice(0, 34), '2026-08-02T17:31:00+08:00', now)
  assert.equal(result.ready, false)
  assert.match(result.reasons.join('；'), /应为35条/)
})

test('normalized duplicate centers are blocked', () => {
  const rows = validRows.map(row => ({ ...row }))
  rows[34].center = ' 第一服务项目1服务中心 '
  const result = evaluateCollectionSource(rows, '2026-08-02T17:31:00+08:00', now)
  assert.equal(result.ready, false)
  assert.match(result.reasons.join('；'), /重复/)
})

test('stale or invalid amounts are blocked', () => {
  const rows = validRows.map(row => ({ ...row }))
  rows[0].received = null
  const result = evaluateCollectionSource(rows, '2026-07-20T17:31:00+08:00', now)
  assert.equal(result.ready, false)
  assert.equal(result.status, 'stale')
  assert.match(result.reasons.join('；'), /关键金额/)
  assert.match(result.reasons.join('；'), /超过72小时/)
})
