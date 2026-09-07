import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const css = fs.readFileSync(path.join(site, 'aph2-r47-project-accessibility-20260812-v1.css'), 'utf8')
const js = fs.readFileSync(path.join(site, 'aph2-r47-project-accessibility-20260812-v1.js'), 'utf8')

test('R47 为项目抽屉补齐模态语义和名称', () => {
  assert.match(js, /setAttribute\('role', 'dialog'\)/)
  assert.match(js, /setAttribute\('aria-modal', 'true'\)/)
  assert.match(js, /setAttribute\('aria-labelledby', DIALOG_TITLE_ID\)/)
  assert.match(js, /panel\.setAttribute\('aria-label'/)
  assert.match(js, /panel\.tabIndex = -1/)
  assert.match(js, /mask\.tabIndex = -1/)
  assert.match(js, /mask\.setAttribute\('aria-hidden', 'true'\)/)
})

test('R47 抽屉打开接管焦点、Tab 闭环、Escape 关闭并恢复触发行', () => {
  assert.match(js, /firstControl \|\| panel/)
  assert.match(js, /event\.key === 'Tab'/)
  assert.match(js, /event\.shiftKey/)
  assert.match(js, /event\.key === 'Escape'/)
  assert.match(js, /closeProjectDrawer\(drawer\)/)
  assert.match(js, /restoreProjectOpener/)
  assert.match(js, /lastProjectOpener = row/)
})

test('R47 保留表格行语义并显式声明打开对话框', () => {
  assert.match(js, /setAttribute\('aria-haspopup', 'dialog'\)/)
  assert.match(js, /setAttribute\('aria-controls', DIALOG_ID\)/)
  assert.doesNotMatch(js, /row\.setAttribute\('role', 'button'\)/)
  assert.match(css, /data-project-profile-id.*aria-haspopup="dialog"/)
})

test('R47 结果数可宣读，滚动表格具有 region 语义', () => {
  assert.match(js, /data-project-visible-count/)
  assert.match(js, /setAttribute\('role', 'status'\)/)
  assert.match(js, /setAttribute\('aria-live', 'polite'\)/)
  assert.match(js, /setAttribute\('aria-atomic', 'true'\)/)
  assert.match(js, /aph-project-table-wrap/)
  assert.match(js, /setAttribute\('role', 'region'\)/)
})

test('R47 跳转链可见且将焦点交给 main，移动导航 DOM 顺序前置', () => {
  assert.match(js, /a\.skip-link\[href="#main-content"\]/)
  assert.match(js, /main\.focus\(\{ preventScroll: true \}\)/)
  assert.match(js, /main\.scrollIntoView/)
  assert.match(js, /matchMedia\('\(max-width: 640px\)'\)/)
  assert.match(js, /contentShell\.insertBefore\(nav, main\)/)
  assert.match(js, /r47DomOrder = 'before-content'/)
  assert.match(css, /skip-link:focus[\s\S]*transform:\s*translateY\(0\)/)
  assert.match(css, /skip-link[\s\S]*transition:\s*none\s*!important/)
  assert.match(css, /aph-header-menu[\s\S]*focus-visible/)
})

test('R47 项目页对比度覆盖指标说明、结果数、地址和页脚口径', () => {
  for (const selector of [
    '.aph-project-kpis article > span',
    '.aph-project-kpis article > small',
    '[data-project-visible-count]',
    '.aph-project-table-wrap tbody td:nth-child(2) > small',
    '.aph-project-footnote',
    '.aph-project-link-unmatched',
  ]) assert.ok(css.includes(selector), selector)
  assert.match(css, /color:\s*#596574\s*!important/)
})

test('R47 不触碰业务数据、接口、计算与权限', () => {
  for (const forbidden of [
    '/api/', 'fetch(', 'XMLHttpRequest', 'collectionRate', 'receivable', 'received',
    'localStorage.setItem', 'sessionStorage.setItem', 'Authorization',
  ]) {
    assert.equal(js.includes(forbidden), false, `JS 不得包含 ${forbidden}`)
    assert.equal(css.includes(forbidden), false, `CSS 不得包含 ${forbidden}`)
  }
})
