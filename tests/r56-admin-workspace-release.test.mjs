import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const standalone = fs.readFileSync(path.join(site, 'admin/index.html'), 'utf8')
const js = fs.readFileSync(path.join(site, 'admin/aph2-r56-admin-workspace-20260812-v1.js'), 'utf8')
const css = fs.readFileSync(path.join(site, 'admin/aph2-r56-admin-workspace-20260812-v1.css'), 'utf8')

test('R56 取代会自动重建后台说明区的 R36 活动资源', () => {
  for (const entrypoint of [html, standalone]) {
    assert.match(entrypoint, /admin\/aph2-r56-admin-workspace-20260812-v1\.js\?v=r56-workspace1/)
    assert.match(entrypoint, /admin\/aph2-r56-admin-workspace-20260812-v1\.css\?v=r56-workspace1/)
    assert.doesNotMatch(entrypoint, /admin\/aph2-r36-production-table-20260812-v1\.(?:js|css)/)
  }
  assert.ok(html.indexOf('aph2-r56-admin-workspace-20260812-v1.css') > html.indexOf('aph2-r46-admin-accessibility-20260812-v1.css'))
  assert.ok(standalone.indexOf('aph2-r56-admin-workspace-20260812-v1.css') > standalone.indexOf('aph2-r46-admin-accessibility-20260812-v1.css'))
  assert.doesNotMatch(js, /ensurePageHeading|insertBefore\(section|createElement\(['"]section/)
})

test('R56 保留移动表格字段标签且不触碰接口和业务数据', () => {
  assert.match(js, /data-r34-label/)
  assert.match(js, /r34ResponsiveTable/)
  assert.match(js, /MutationObserver/)
  assert.match(js, /document\.getElementById\('aph-admin-title'\)/)
  assert.match(js, /main\.setAttribute\('aria-labelledby', existing\.id\)/)
  assert.match(js, /shellTitle\.setAttribute\('role', 'heading'\)/)
  assert.match(js, /main\.setAttribute\('aria-label', '后台数据管理'\)/)
  assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|\/api\/|localStorage|sessionStorage/)
})

test('R56 视觉移除整块说明区但保留辅助技术可读的唯一标题', () => {
  assert.match(css, /^\.aph-r36-admin-heading\s*\{/m)
  assert.match(css, /position:\s*absolute\s*!important/)
  assert.match(css, /clip-path:\s*inset\(50%\)\s*!important/)
  assert.match(css, /white-space:\s*nowrap\s*!important/)
  assert.match(css, /\.aph-r36-admin-heading p\s*\{\s*display:\s*none\s*!important/)
  assert.doesNotMatch(css, /\.aph-r36-admin-heading\s*\{[^}]*display:\s*none/s)
})
