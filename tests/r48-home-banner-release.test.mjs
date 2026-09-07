import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const index = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r48-home-banner-20260812-v1.css'), 'utf8')

test('R48 使用独立不可变资源并在 R44 之后加载', () => {
  assert.match(index, /aph2-r48-home-banner-20260812-v1\.css\?v=r48-banner1/)
  assert.ok(index.indexOf('aph2-r48-home-banner-20260812-v1.css') > index.indexOf('aph2-r44-sidebar-tabs-20260812-v1.css'))
})

test('首页横幅恢复第一服务红底并填满 218px 桌面首行', () => {
  assert.match(css, /data-r42-route="home"[\s\S]*aph-business-banner[\s\S]*background:\s*#d71920\s*!important/)
  assert.match(css, /@media \(min-width:\s*1024px\)[\s\S]*aph-home-reflow > \.aph-home-visual[\s\S]*height:\s*218px\s*!important/)
  assert.match(css, /min-height:\s*218px\s*!important/)
})

test('2026 与驾驶舱标题共用几何中心', () => {
  assert.match(css, /aph-home-visual \.aph-banner-copy[\s\S]*left:\s*156px\s*!important[\s\S]*right:\s*156px\s*!important/)
  assert.match(css, /aph-business-banner::before[\s\S]*left:\s*50%\s*!important[\s\S]*translateX\(-50%\)/)
  assert.match(css, /top:\s*62px\s*!important/)
})

test('R48 仅调整首页表现，不修改数据、接口和已验收路由', () => {
  for (const forbidden of ['/api/', 'fetch(', 'XMLHttpRequest', 'collectionRate', 'receivable', 'received']) {
    assert.equal(css.includes(forbidden), false)
  }
  assert.doesNotMatch(css, /data-r42-route="(daily|payment|collection)"/)
})
