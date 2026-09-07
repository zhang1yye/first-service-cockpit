import assert from 'node:assert/strict'
import test from 'node:test'
import { latestBusinessFreshness, parseBusinessTimestamp } from '../review-system/active/frontend/src/lib/businessTime.js'

test('业务时间兼容真实存量的单数字月日格式', () => {
  const timestamp = parseBusinessTimestamp('2026/6/2 15:20:35')
  assert.ok(Number.isFinite(timestamp))
  const parsed = new Date(timestamp)
  assert.deepEqual(
    [parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate(), parsed.getHours(), parsed.getMinutes(), parsed.getSeconds()],
    [2026, 6, 2, 15, 20, 35]
  )
  assert.equal(parseBusinessTimestamp('2026/2/30 15:20:35'), null)
})

test('有真实方案时不得误显示暂无记录', () => {
  const now = parseBusinessTimestamp('2026/6/4 16:00:00')
  const result = latestBusinessFreshness(
    [{ updatedAt: '2026/6/2 15:20:35' }],
    { latestAt: '2026/6/1 11:34:34' },
    [{ at: '2026/6/1 15:20:35' }],
    now
  )
  assert.match(result.text, /^\u6700近业务记录 /)
  assert.match(result.text, /\u5df2超过24小时 · 方案$/)
  assert.doesNotMatch(result.text, /暂无记录/)
  assert.equal(result.stale, true)
})
