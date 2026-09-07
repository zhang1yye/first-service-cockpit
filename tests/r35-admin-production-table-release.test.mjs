import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const index = fs.readFileSync(path.join(site, 'admin/index.html'), 'utf8')
const cockpitIndex = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const js = fs.readFileSync(path.join(site, 'admin/aph2-r56-admin-workspace-20260812-v1.js'), 'utf8')
const css = fs.readFileSync(path.join(site, 'admin/aph2-r56-admin-workspace-20260812-v1.css'), 'utf8')

test('R56 作为独立不可变后台工作区修复层取代 R36', () => {
  for (const entrypoint of [index, cockpitIndex]) {
    assert.doesNotMatch(entrypoint, /aph2-r36-production-table-20260812-v1\.(?:css|js)/)
    assert.match(entrypoint, /admin\/aph2-r56-admin-workspace-20260812-v1\.css\?v=r56-workspace1/)
    assert.match(entrypoint, /admin\/aph2-r56-admin-workspace-20260812-v1\.js\?v=r56-workspace1/)
  }
  assert.doesNotMatch(cockpitIndex, /aph2-r35-production-table/)
})

test('异步进入的生产表格行会被重复扫描并补齐字段标签', () => {
  assert.doesNotMatch(js, /dataset\.r34ResponsiveTable === '1'\) return/)
  assert.match(js, /MutationObserver/)
  assert.match(js, /data-r34-label/)
  assert.doesNotMatch(js, /ensurePageHeading|createElement\(['"]section/)
  assert.match(js, /window\.location\.pathname !== '\/admin'/)
})

test('后台身份和移动表格修复不改写接口及业务数值', () => {
  for (const forbidden of ['/api/', 'fetch(', 'XMLHttpRequest', 'collectionRate', 'receivable', 'received']) {
    assert.equal(js.includes(forbidden), false)
    assert.equal(css.includes(forbidden), false)
  }
})
