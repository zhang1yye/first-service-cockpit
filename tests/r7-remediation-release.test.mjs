import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const script = fs.readFileSync(path.join(site, 'aph2-r7-remediation-20260810-v3.js'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r7-remediation-20260810-v1.css'), 'utf8')

test('R7保留已退役任务边界并修复悬空入口', () => {
  assert.match(html, /task-module-retired\.js/)
  assert.match(html, /aph2-r7-remediation-20260810-v3\.js/)
  assert.match(script, /fixRetiredTaskEntrypoints/)
  assert.match(script, /today-top5/)
  assert.match(script, /\/admin\/#quality/)
})

test('R7顶栏统一展示APH和绿仔分源日期', () => {
  assert.match(script, /\/api\/summary/)
  assert.match(script, /APH回款/)
  assert.match(script, /绿仔收缴/)
  assert.match(script, /经营数据分源更新/)
  assert.match(css, /r7-unified-source-status/)
})

test('R7在历史数据未接入时不显示假环比并将已撤场行置底', () => {
  assert.match(script, /historyUnavailable/)
  assert.match(script, /combinedMatch/)
  assert.match(script, /zeroValueMatch/)
  assert.match(script, /node\.children\.length && !zeroValueMatch/)
  assert.match(script, /node\.textContent = combinedMatch \? `\$\{comparisonLabel\} —` : '—'/)
  assert.match(script, /moveWithdrawnRowsLast/)
  assert.match(script, /已撤场/)
})

test('R7将过期AI数字标记为最近快照而非今日实时', () => {
  assert.match(script, /markReviewSnapshotStale/)
  assert.match(script, /AI最近快照/)
  assert.match(script, /最近快照总调用/)
  assert.match(script, /不代表今日实时状态/)
})
