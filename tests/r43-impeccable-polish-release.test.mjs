import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const index = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const adminIndex = fs.readFileSync(path.join(site, 'admin/index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r43-impeccable-polish-20260812-v2.css'), 'utf8')

test('R43 以独立不可变资源加载在 R42 之后', () => {
  for (const html of [index, adminIndex]) {
    assert.match(html, /aph2-r43-impeccable-polish-20260812-v2\.css\?v=r43-polish2/)
    assert.ok(html.indexOf('aph2-r43-impeccable-polish') > html.indexOf('aph2-r42-final-polish'))
  }
})

test('字体系统使用本地系统栈、等宽数字特性和可读层级', () => {
  assert.match(css, /SF Pro Text[\s\S]*PingFang SC[\s\S]*Microsoft YaHei/)
  assert.match(css, /font-variant-numeric:\s*tabular-nums lining-nums/)
  assert.match(css, /main h1[\s\S]*clamp\(/)
  assert.match(css, /--muted-foreground:\s*#66717e/)
  assert.doesNotMatch(css, /fonts\.googleapis|@import|https?:\/\//)
})

test('配色回到 APH 黑白红并保留语义色', () => {
  assert.match(css, /--primary:\s*#d71920/)
  assert.match(css, /aph-business-banner[\s\S]*background:\s*#13171c\s*!important/)
  assert.match(css, /--success:\s*#1f7a4d/)
  assert.match(css, /--danger:\s*#b42318/)
  assert.match(css, /--warning:\s*#9a6700/)
  assert.doesNotMatch(css, /linear-gradient|radial-gradient|gradient-text/)
})

test('布局与交互减少卡片噪音并保留明确状态', () => {
  assert.match(css, /main#main-content > div[\s\S]*max-width:\s*1600px/)
  assert.match(css, /data-r42-route="home"[\s\S]*aph-home-reflow[\s\S]*padding-top:\s*18px\s*!important/)
  assert.match(css, /not\(a\):not\(button\):hover[\s\S]*transform:\s*none/)
  assert.match(css, /focus-visible[\s\S]*outline:\s*2px solid var\(--ring\)/)
  assert.match(css, /:disabled[\s\S]*cursor:\s*not-allowed/)
  assert.match(css, /tbody tr:hover[\s\S]*background:\s*#f8f9fb/)
  assert.match(css, /data-r42-route="admin"[\s\S]*> #root > div > header[\s\S]*background:\s*#050505/)
  assert.match(css, /aph-r42-admin-tabs > button:not[\s\S]*color:\s*#596574/)
})

test('动效只保留路由、抽屉与导航反馈并支持 reduced motion', () => {
  assert.match(css, /@keyframes aph-r43-route-enter/)
  assert.match(css, /aph-mobile-more-drawer:not\(\[hidden\]\)/)
  assert.match(css, /aph-exact-sidebar-panel[\s\S]*transition:\s*box-shadow/)
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/)
  assert.doesNotMatch(css, /animation:\s*[^;]*infinite/)
})

test('R43 不含业务数据、接口和计算改写', () => {
  for (const forbidden of ['/api/', 'fetch(', 'XMLHttpRequest', 'collectionRate', 'receivable', 'received']) {
    assert.equal(css.includes(forbidden), false)
  }
})
