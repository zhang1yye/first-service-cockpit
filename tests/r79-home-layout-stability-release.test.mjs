import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const scriptPath = path.join(root, 'firstcare-cloud-local/aph2-r79-home-layout-stability-20260814-v1.js')
const script = fs.readFileSync(scriptPath, 'utf8')

test('R79不再依赖main首节点，能跳过提示条定位真实首页容器', () => {
  assert.match(script, /const roots = \[main, \.\.\.main\.children\]/)
  assert.match(script, /node\.classList\.contains\('aph-business-banner'\)/)
  assert.match(script, /text\.includes\('核心指标'\).*text\.includes\('累计执行'\)/s)
  assert.doesNotMatch(script, /main\.firstElementChild/)
})

test('R79一次性恢复首页基础布局类和全部经营卡角色', () => {
  for (const token of [
    'aph-home-reflow', 'aph-home-visual', 'aph-home-kpi-grid',
    'aph-home-region-grid', 'aph-home-ranking-grid',
    'r8-home-core', 'r8-home-budget', 'r8-home-collection',
    'r8-home-period', 'r8-home-growth', 'r8-home-scope', 'r8-home-target',
  ]) assert.match(script, new RegExp(token))
})

test('R79对节点替换和刷新提供有界重试且DOM写入幂等', () => {
  assert.match(script, /RETRY_DELAYS = \[0, 16, 50, 100, 250, 500, 1000, 2000\]/)
  assert.match(script, /new MutationObserver\(schedule\)/)
  assert.match(script, /\{ childList: true, subtree: true \}/)
  assert.match(script, /classList\.contains\(role\)/)
  assert.doesNotMatch(script, /attributes:\s*true/)
})

test('R79只修展示状态，不访问接口、不改路由和存储', () => {
  assert.doesNotMatch(script, /fetch\s*\(/)
  assert.doesNotMatch(script, /XMLHttpRequest|WebSocket|sendBeacon/)
  assert.doesNotMatch(script, /\/api\//)
  assert.doesNotMatch(script, /localStorage|sessionStorage/)
  assert.doesNotMatch(script, /location\.(assign|replace|reload)|history\.(pushState|replaceState)/)
  assert.doesNotMatch(script, /项目经营分析未生成|查看数据接入状态/)
})
