import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const index = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const adminIndex = fs.readFileSync(path.join(site, 'admin/index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r42-final-polish-20260812-v1.css'), 'utf8')
const js = fs.readFileSync(path.join(site, 'aph2-r42-final-polish-20260812-v1.js'), 'utf8')

test('R42 作为独立不可变最终修复层加载在既有修复之后', () => {
  for (const html of [index, adminIndex]) {
    assert.match(html, /aph2-r42-final-polish-20260812-v1\.css\?v=r42-final1/)
    assert.match(html, /aph2-r42-final-polish-20260812-v1\.js\?v=r42-final1/)
  }
  assert.ok(index.indexOf('aph2-r42-final-polish') > index.indexOf('aph2-r34-full-frontend-remediation'))
  assert.ok(index.indexOf('aph2-r42-final-polish') > index.indexOf('aph2-r56-admin-workspace'))
})

test('移动壳层修复覆盖全部已确认遮挡路由', () => {
  for (const route of ['projects', 'import', 'ai-alerts', 'ai-report', 'review', 'daily', 'payment']) {
    assert.match(css, new RegExp(`data-r42-route="${route}"[\\s\\S]*main#main-content`))
  }
  assert.match(css, /padding-top:\s*64px\s*!important/)
  assert.match(css, /data-r42-route="home"[\s\S]*aph-home-reflow[\s\S]*padding-top:\s*36px\s*!important/)
})

test('长页面默认聚焦但保留显式展开能力', () => {
  assert.match(js, /IMPORT_VISIBLE_COUNT = 3/)
  assert.match(js, /ADMIN_VISIBLE_COUNT = 10/)
  assert.match(js, /显示其余 \$\{hiddenCount\}/)
  assert.match(js, /aria-expanded/)
  assert.match(js, /importExpanded = !importExpanded/)
  assert.match(js, /adminExpanded = !adminExpanded/)
})

test('后台修正操作字段并把八个业务域改为明确触控区', () => {
  assert.match(js, /lastCell\.dataset\.r34Label = '操作'/)
  assert.match(js, /host\.insertBefore\(safetyToolbar, table\)/)
  assert.match(js, /aph-r42-admin-tabs/)
  assert.match(css, /aph-r42-admin-tabs[\s\S]*grid-template-columns:\s*repeat\(2/)
  assert.match(css, /aph-r42-admin-tabs > button[\s\S]*min-height:\s*44px/)
  assert.match(css, /aph-r42-admin-tabs[\s\S]*margin-top:\s*46px\s*!important/)
})

test('项目、工作台和 AI 门禁完成扁平化且不删除入口', () => {
  assert.match(css, /data-r42-route="projects"[\s\S]*aph-project-kpis[\s\S]*display:\s*block/)
  assert.match(css, /data-r42-route="command"[\s\S]*aph-r24-command-actions[\s\S]*background:\s*transparent/)
  assert.match(css, /data-r42-route="ai-alerts"[\s\S]*aph-real-data-scope[\s\S]*border-left/)
  assert.doesNotMatch(js, /\.remove\(\).*href|querySelectorAll\('a'\).*remove/)
})

test('R42 不改写业务接口、数据和公式', () => {
  for (const forbidden of [
    '/api/', 'fetch(', 'XMLHttpRequest', 'collectionRate', 'receivable', 'received',
    'localStorage.setItem', 'cockpit_token', 'innerHTML',
  ]) {
    assert.equal(js.includes(forbidden), false, `JS 不得包含 ${forbidden}`)
    assert.equal(css.includes(forbidden), false, `CSS 不得包含 ${forbidden}`)
  }
})
