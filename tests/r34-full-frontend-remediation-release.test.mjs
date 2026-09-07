import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const index = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const adminIndex = fs.readFileSync(path.join(site, 'admin/index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r34-full-frontend-remediation-20260812-v1.css'), 'utf8')
const js = fs.readFileSync(path.join(site, 'aph2-r34-full-frontend-remediation-20260812-v1.js'), 'utf8')

test('R34 使用独立不可变资源并建立全路由作用域', () => {
  assert.match(index, /aph2-r34-full-frontend-remediation-20260812-v1\.css\?v=r34-full1/)
  assert.match(index, /aph2-r34-full-frontend-remediation-20260812-v1\.js\?v=r34-full1/)
  assert.match(index, /aph2-r33-system-review-polish-20260812-v1\.css\?v=r33-polish2/)
  assert.match(index, /aph2-r33-system-review-polish-20260812-v1\.js\?v=r33-polish2/)
  assert.match(js, /document\.body\?\.setAttribute\('data-r34-route'/)
  assert.match(adminIndex, /aph2-r34-full-frontend-remediation-20260812-v1\.css\?v=r34-full1/)
  assert.match(adminIndex, /aph2-r34-full-frontend-remediation-20260812-v1\.js\?v=r34-full1/)
})

test('桌面侧栏只覆盖展开，不再推动或缩窄正文', () => {
  assert.match(css, /aph-exact-sidebar[\s\S]*flex:\s*0 0 60px\s*!important/)
  assert.match(css, /aph-exact-sidebar[\s\S]*max-width:\s*60px\s*!important/)
  assert.match(css, /aph-exact-sidebar-panel[\s\S]*width:\s*140px/)
  assert.doesNotMatch(css, /aph-exact-sidebar(?:[^}]|\n)*flex-basis:\s*140px/)
  assert.match(css, /aph-page-tabs[\s\S]*left:\s*60px\s*!important/)
})

test('移动壳层只有一个业务 H1，并在路由切换后回到顶部', () => {
  assert.match(js, /document\.querySelectorAll\('header h1'\)/)
  assert.match(js, /replacement\.dataset\.aphShellTitle/)
  assert.match(js, /window\.scrollTo\(\{ top:\s*0, left:\s*0, behavior:\s*'auto' \}\)/)
  assert.match(js, /COLLECTION_RESET_DELAYS/)
  assert.match(js, /data-r34-promoted-heading|r34PromotedHeading/)
  assert.match(css, /aph-mobile-nav-ready[\s\S]*sticky\.top-\\\[72px\\\][\s\S]*display:\s*none\s*!important/)
})

test('后台表格在移动端转换为带字段名的摘要行', () => {
  assert.match(js, /data-r34-label/)
  assert.match(js, /data-r34-responsive-table/)
  assert.match(css, /data-r34-route="admin"[\s\S]*data-r34-responsive-table[\s\S]*thead[\s\S]*display:\s*none/)
  assert.match(css, /td::before[\s\S]*content:\s*attr\(data-r34-label\)/)
})

test('首页改为 utility-first 首屏且空状态不再堆叠未知指标卡', () => {
  assert.match(css, /data-r34-route="home"[\s\S]*aph-business-banner[\s\S]*min-height:\s*150px/)
  assert.match(css, /data-r34-route="home"[\s\S]*main#main-content \.aph-home-reflow[\s\S]*padding-top:\s*108px/)
  assert.match(js, /aph-r34-truth-summary/)
  assert.match(js, /data-r34-collapsed-truth-card/)
  assert.match(js, /任务入口已合并至经营工作台/)
})

test('动效只保留页面进入、侧栏和抽屉，并尊重减少动态效果', () => {
  assert.match(css, /@keyframes aph-r34-enter/)
  assert.match(css, /aph-r34-route-enter/)
  assert.match(css, /aph-mobile-more-drawer/)
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/)
})

test('修复层不包含业务数据、接口和计算改写', () => {
  for (const forbidden of [
    '/api/', 'collectionRate', 'receivable', 'received', 'fetch(', 'XMLHttpRequest',
    'localStorage.setItem', 'cockpit_token',
  ]) {
    assert.equal(js.includes(forbidden), false, `JS 不得包含 ${forbidden}`)
    assert.equal(css.includes(forbidden), false, `CSS 不得包含 ${forbidden}`)
  }
})
