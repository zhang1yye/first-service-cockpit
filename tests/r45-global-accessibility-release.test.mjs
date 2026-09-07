import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const css = fs.readFileSync(path.join(site, 'aph2-r45-global-accessibility-20260812-v1.css'), 'utf8')
const js = fs.readFileSync(path.join(site, 'aph2-r45-global-accessibility-20260812-v1.js'), 'utf8')

test('R45 让隐藏 AI 层同时退出视觉和键盘序列', () => {
  assert.match(css, /north-ai-overlay\[aria-hidden="true"\][\s\S]*display:\s*none\s*!important/)
  assert.match(js, /overlay\.inert = concealed/)
  assert.match(js, /toggleAttribute\('inert', concealed\)/)
  assert.match(js, /attributeFilter:\s*\['aria-hidden', 'aria-selected'\]/)
})

test('R45 把浏览历史页签还原为导航语义', () => {
  assert.match(js, /querySelectorAll\('\.aph-tab-list'\)/)
  assert.match(js, /setAttribute\('role', 'navigation'\)/)
  assert.match(js, /a\[data-aph-tab-href\]/)
  assert.match(js, /removeAttribute\('aria-selected'\)/)
  assert.match(js, /setAttribute\('aria-current', 'page'\)/)
})

test('R45 修正 review 视图组和首页 SVG 地图角色', () => {
  assert.match(js, /aph-review-workbench-switch\[data-review-workbench-mode\]/)
  assert.match(js, /switcher\.setAttribute\('role', 'group'\)/)
  assert.match(js, /setAttribute\('aria-pressed'/)
  assert.match(js, /svg\[aria-label="辽宁、河北、天津、北京区域地图"\]/)
  assert.match(js, /map\.setAttribute\('role', 'group'\)/)
})

test('R45 只为确认的滚动路由增加可聚焦区域和现有标题名称', () => {
  assert.match(js, /new Set\(\['\/ai-alerts', '\/import', '\/review'\]\)/)
  assert.match(js, /region\.tabIndex = 0/)
  assert.match(js, /region\.setAttribute\('role', 'region'\)/)
  assert.match(js, /nearestHeadingText\(region, main\)/)
  assert.match(js, /setAttribute\('aria-label', label\)/)
})

test('R45 公共色值在浅色工作区达到 AA 并保留黑色顶栏', () => {
  assert.match(css, /--muted-foreground:\s*#596574/)
  assert.match(css, /--success:\s*#1a6b43/)
  assert.match(css, /--warning:\s*#805300/)
  assert.match(css, /--danger:\s*#a81d18/)
  assert.match(css, /header \.text-slate-500[\s\S]*#aeb7c2/)
  assert.match(css, /aph-route-tab:not\(\.is-active\)[\s\S]*#596574/)
  assert.match(css, /data-r42-route="import"[\s\S]*\.card-soft[\s\S]*#35404d/)
  assert.match(css, /aph-business-banner :where\(p, h2, time\)[\s\S]*#ffffff[\s\S]*opacity:\s*1/)
  assert.match(css, /main \.animate-in[\s\S]*opacity:\s*1\s*!important/)
})

test('R45 不改业务接口、数据、计算和权限', () => {
  for (const forbidden of [
    '/api/', 'fetch(', 'XMLHttpRequest', 'collectionRate', 'receivable', 'received',
    'localStorage', 'cockpit_token', 'Authorization',
  ]) {
    assert.equal(js.includes(forbidden), false, `JS 不得包含 ${forbidden}`)
    assert.equal(css.includes(forbidden), false, `CSS 不得包含 ${forbidden}`)
  }
})
