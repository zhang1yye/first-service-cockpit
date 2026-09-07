import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const index = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const adminIndex = fs.readFileSync(path.join(site, 'admin/index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r44-sidebar-tabs-20260812-v1.css'), 'utf8')
const js = fs.readFileSync(path.join(site, 'aph2-r44-sidebar-tabs-20260812-v1.js'), 'utf8')

test('R44 使用独立不可变资源并在页签脚本前清理 reload 状态', () => {
  for (const html of [index, adminIndex]) {
    assert.match(html, /aph2-r44-sidebar-tabs-20260812-v1\.js\?v=r44-shell1/)
    assert.match(html, /aph2-r44-sidebar-tabs-20260812-v1\.css\?v=r44-shell1/)
  }
  assert.ok(index.indexOf('aph2-r44-sidebar-tabs-20260812-v1.js') < index.indexOf('aph2-theme-20260808-progressive6.js'))
})

test('只有真正刷新时清理临时页签，同一次 SPA 浏览保持多页签', () => {
  assert.match(js, /performance\.getEntriesByType\('navigation'\)/)
  assert.match(js, /navigation\?\.type === 'reload'/)
  assert.match(js, /sessionStorage\.removeItem\(OPEN_TABS_KEY\)/)
  assert.doesNotMatch(js, /localStorage\.clear|sessionStorage\.clear/)
})

test('窄桌面展开侧栏只给首页内容增加安全区', () => {
  assert.match(css, /min-width:\s*641px[\s\S]*max-width:\s*1759px/)
  assert.match(css, /data-r42-route="home"[\s\S]*aph-exact-sidebar\.is-expanded[\s\S]*main#main-content/)
  assert.match(css, /padding-left:\s*98px\s*!important/)
  assert.doesNotMatch(css, /data-r42-route="(daily|payment|collection)"/)
})

test('R44 不改业务数据、接口、公式和权限', () => {
  for (const forbidden of ['/api/', 'fetch(', 'XMLHttpRequest', 'collectionRate', 'receivable', 'received']) {
    assert.equal(js.includes(forbidden), false)
    assert.equal(css.includes(forbidden), false)
  }
})
