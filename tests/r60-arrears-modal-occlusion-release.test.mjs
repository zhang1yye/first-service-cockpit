import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const html = fs.readFileSync(path.join(root, 'firstcare-cloud-local/arrears/index.html'), 'utf8')
const js = fs.readFileSync(path.join(root, 'firstcare-cloud-local/arrears/aph2-r60-arrears-modal-occlusion-20260813-v1.js'), 'utf8')

test('R60 外层遮挡修复在 R59 嵌入边界之后加载', () => {
  const r59 = '/arrears/aph2-r59-arrears-embedded-inspector-20260813-v1.js?v=r59-arrears-inspector1'
  const r60 = '/arrears/aph2-r60-arrears-modal-occlusion-20260813-v1.js?v=r60-arrears-modal1'
  assert.equal(html.match(new RegExp(r60.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length, 1)
  assert.ok(html.indexOf(r60) > html.indexOf(r59))
})

test('R60 隐藏外层移动导航和 AI 浮层并保存原显示样式', () => {
  for (const selector of ['.aph-mobile-primary-nav', '.aph-mobile-more-drawer', '#north-ai-assistant', '.aph-r57-mobile-ai-launcher']) {
    assert.ok(js.includes(selector), `缺少 ${selector}`)
  }
  assert.match(js, /node\.style\.getPropertyValue\('display'\)/)
  assert.match(js, /node\.style\.setProperty\('display', 'none', 'important'\)/)
  assert.match(js, /node\.style\.setProperty\('display', value, priority\)/)
  assert.match(js, /node\.style\.removeProperty\('display'\)/)
})

test('R60 与 Inspector 状态和父窗口滚动同步', () => {
  assert.match(js, /MutationObserver/)
  assert.match(js, /attributeFilter: \['hidden', 'role', 'aria-modal'\]/)
  assert.match(js, /window\.parent\.addEventListener\('scroll', scheduleSync/)
  assert.match(js, /inspector\.style\.setProperty\('top', '0px', 'important'\)/)
})

test('R60 只处理显示边界，不访问或修改业务数据', () => {
  for (const forbidden of ['fetch(', 'XMLHttpRequest', '/api/', 'localStorage', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(js.includes(forbidden), false, `禁止出现 ${forbidden}`)
  }
})
