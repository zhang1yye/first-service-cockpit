import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'arrears/index.html'), 'utf8')
const js = fs.readFileSync(path.join(site, 'arrears/aph2-r62-arrears-direct-ai-20260813-v1.js'), 'utf8')
const css = fs.readFileSync(path.join(site, 'arrears/aph2-r62-arrears-direct-ai-20260813-v1.css'), 'utf8')

test('R62 在欠费入口最后加载直接 AI 操作层', () => {
  const cssAsset = '/arrears/aph2-r62-arrears-direct-ai-20260813-v1.css?v=r62-arrears-direct-ai1'
  const jsAsset = '/arrears/aph2-r62-arrears-direct-ai-20260813-v1.js?v=r62-arrears-direct-ai1'
  assert.equal(html.match(new RegExp(cssAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length, 1)
  assert.equal(html.match(new RegExp(jsAsset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length, 1)
  assert.ok(html.indexOf(jsAsset) > html.indexOf('aph2-r60-arrears-modal-occlusion-20260813-v1.js'))
})

test('R62 进入即展示项目、日期、双文件与开始分析', () => {
  for (const token of [
    "heading.textContent = 'AI欠费分析'",
    "panel.hidden = false",
    "const directLabel = '开始AI分析'",
    "details.id = 'r62History'",
    "label.textContent = '历史分析'",
    "details.id = 'r62Views'",
    "summary.textContent = '经营数据'",
  ]) assert.ok(js.includes(token), `缺少直接分析语义：${token}`)
})

test('R62 尊重 AI 门禁降级并仅在异常时显示恢复入口', () => {
  assert.ok(js.includes("button.textContent.trim() === '上传校验并开始AI分析'"))
  assert.ok(js.includes("classList.contains('is-bad')"))
  assert.ok(js.includes("dataset.r62ReadinessIssue"))
  assert.ok(css.includes('[data-r62-readiness-issue="true"] .r55-workbench-header'))
  assert.ok(css.includes('#r55NewBatch'))
})

test('R62 保留经营视图可达并修复折叠历史后的焦点返回', () => {
  assert.ok(js.includes("tasks.textContent = 'AI分析'"))
  assert.ok(js.includes("details.open = mode !== 'tasks'"))
  assert.ok(js.includes("active.getClientRects().length"))
  assert.ok(js.includes("document.querySelector('#r62History > summary')?.focus"))
  assert.ok(css.includes('.r62-views .r55-view-nav'))
})

test('R62 隐藏说明型区域并保留唯一主操作', () => {
  for (const selector of [
    '.guardrail',
    '.r55-view-nav',
    '.r55-workbench-header',
    '.r55-pipeline',
    '.r55-create-panel > .r55-section-heading',
    '#r55CancelCreate',
  ]) assert.ok(css.includes(selector), `缺少精简选择器：${selector}`)
  assert.ok(css.includes('.r62-history'))
  assert.ok(css.includes('grid-template-columns: minmax(220px, 1fr)'))
})

test('R62 不访问接口、不写业务数据、不改已验收页面', () => {
  for (const forbidden of ['fetch(', 'XMLHttpRequest', '/api/', 'localStorage', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(js.includes(forbidden), false, `发现越界能力：${forbidden}`)
  }
  for (const protectedPath of ['/daily', '/payment', '/collection']) {
    assert.equal(js.includes(protectedPath), false)
    assert.equal(css.includes(protectedPath), false)
  }
})
