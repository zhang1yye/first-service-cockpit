import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const source = fs.readFileSync(path.join(root, 'review-system/active/frontend/src/views/HomeView.jsx'), 'utf8')

test('review home defaults to today review and exposes operations as a secondary mode', () => {
  assert.match(source, /const homeMode = canAccessOps && searchParams\.get\('mode'\) === 'ops' \? 'ops' : 'review'/)
  assert.match(source, />今日审核</)
  assert.match(source, />运行与安全</)
  assert.match(source, /homeMode === 'ops'/)
})

test('operations-only content is progressively disclosed while review queues stay on the default home', () => {
  const operationsStart = source.indexOf("{homeMode === 'ops' && (")
  const operationsEnd = source.indexOf('<h2 className="font-semibold mb-3">执行漏斗</h2>')
  assert.ok(operationsStart > 0, 'operations mode wrapper should exist')
  assert.ok(operationsEnd > operationsStart, 'today review content should follow operations wrapper')
  const operationsBlock = source.slice(operationsStart, operationsEnd)
  for (const label of ['AI 审核健康', '审核机器人', '系统运行面板', '意见书导出']) {
    assert.ok(operationsBlock.includes(label), `${label} should be in operations mode`)
  }
  assert.ok(source.slice(operationsEnd).includes('执行驾驶舱'))
  assert.ok(source.slice(operationsEnd).includes('方案审核队列'))
})
