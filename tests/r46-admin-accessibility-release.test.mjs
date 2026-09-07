import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const css = fs.readFileSync(path.join(site, 'admin/aph2-r46-admin-accessibility-20260812-v1.css'), 'utf8')
const js = fs.readFileSync(path.join(site, 'admin/aph2-r46-admin-accessibility-20260812-v1.js'), 'utf8')

test('R46 为后台提供唯一 main 和完整 tabs 键盘模型', () => {
  assert.match(js, /contentHost\.setAttribute\('role', 'main'\)/)
  assert.match(js, /panel\.setAttribute\('role', 'tabpanel'\)/)
  assert.match(js, /aria-controls', 'aph-r46-admin-tabpanel'/)
  assert.match(js, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/)
  assert.match(js, /button\.tabIndex = selected \? 0 : -1/)
  assert.match(js, /pageList\.setAttribute\('role', 'navigation'\)/)
})

test('R46 可编辑数值支持 Enter 与 Space，输入框使用现有字段名称', () => {
  assert.match(js, /title="点击编辑"/)
  assert.match(js, /element\.setAttribute\('role', 'button'\)/)
  assert.match(js, /element\.tabIndex = 0/)
  assert.match(js, /\['Enter', ' '\]/)
  assert.match(js, /control\.setAttribute\('aria-label', `编辑\$\{label\}`\)/)
})

test('R46 把 dirty 同步到 tr 与保存 td，兼容旧保护层的节点定位差异', () => {
  assert.match(js, /row\.dataset\.aphAdminDirty = dirty \? '1' : '0'/)
  assert.match(js, /saveCell\.dataset\.aphAdminDirty = dirty \? '1' : '0'/)
  assert.match(js, /button\.disabled = !dirty/)
  assert.match(js, /window\.queueMicrotask/)
  assert.match(js, /React 在 document 上委托 click/)
  assert.match(js, /data-r46-pending="1"/)
})

test('R46 关联用户表单 label，为滚动区和空表提供语义', () => {
  assert.match(js, /label\.htmlFor = id/)
  assert.match(js, /region\.setAttribute\('role', 'region'\)/)
  assert.match(js, /region\.setAttribute\('aria-label'/)
  assert.match(js, /region\.matches\('\[role="tablist"\], \.aph-r42-admin-tabs, \.aph-r46-admin-tabs'\)/)
  assert.match(js, /empty\.setAttribute\('role', 'status'\)/)
  assert.match(js, /empty\.textContent = '暂无数据'/)
  assert.match(js, /externalEmptyText/)
})

test('R46 长表默认渐进展示并克服 R34 的 hidden 样式覆盖', () => {
  assert.match(js, /LONG_TABLE_LIMIT = 20/)
  assert.match(js, /MOBILE_ROW_LIMIT = 10/)
  assert.match(js, /显示其余 \$\{hiddenCount\} 行/)
  assert.match(js, /aria-expanded/)
  assert.match(js, /scheduleVisibilityReconcile/)
  assert.match(css, /tr\[hidden\][\s\S]*display:\s*none\s*!important/)
  assert.match(css, /tr\[data-r46-collapsed="false"\][\s\S]*display:\s*table-row\s*!important/)
  assert.match(css, /thead[\s\S]*clip-path:\s*inset\(50%\)/)
})

test('R46 使用达标的后台文字和焦点颜色', () => {
  assert.match(css, /--r46-admin-muted:\s*#596574/)
  assert.match(css, /outline:\s*3px solid var\(--r46-admin-focus\)/)
  assert.match(css, /\.text-yellow-300[\s\S]*#704800/)
  assert.match(css, /\.card-soft[\s\S]*background:\s*#fff\s*!important/)
})

test('R46 只修复前端行为，不改业务接口和数据口径', () => {
  for (const forbidden of [
    '/api/', 'fetch(', 'XMLHttpRequest', 'receivable', 'received', 'collectionRate',
    'localStorage.setItem', 'sessionStorage.setItem',
  ]) {
    assert.equal(js.includes(forbidden), false, `JS 不得包含 ${forbidden}`)
    assert.equal(css.includes(forbidden), false, `CSS 不得包含 ${forbidden}`)
  }
})
