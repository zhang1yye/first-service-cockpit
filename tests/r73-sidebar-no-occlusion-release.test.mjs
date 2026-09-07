import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const css = await readFile(
  new URL('firstcare-cloud-local/aph2-r73-sidebar-no-occlusion-20260813-v1.css', root),
  'utf8',
)
const active = css.replaceAll(/\/\*[\s\S]*?\*\//g, '')

test('R73 仅在桌面断点生效', () => {
  assert.match(active, /@media \(min-width: 641px\)/)
  assert.doesNotMatch(active, /@media\s*\(max-width|@media[^}]*640px/)
})

test('R73 在 hover、脚本 hover 与 pin 三种状态都锁定 60px', () => {
  for (const state of [':hover', '.is-hovered', '.is-expanded']) {
    assert.match(active, new RegExp(`\\.aph-exact-sidebar${state.replace('.', '\\.')}[\\s\\S]*?60px !important`))
  }
  assert.match(active, /flex: 0 0 60px !important/)
  assert.match(active, /\.aph-exact-sidebar-panel[\s\S]*?width: 60px !important/)
  assert.match(active, /\.aph-exact-sidebar-panel a[\s\S]*?width: 60px !important/)
})

test('R73 永久隐藏文字并移除展开入口', () => {
  assert.match(active, /a span[\s\S]*?opacity: 0 !important/)
  assert.match(active, /a span[\s\S]*?visibility: hidden !important/)
  assert.match(active, /header\.sticky\.top-0 \.aph-header-menu[\s\S]*?display: none !important/)
  assert.match(active, /header\.aph-admin-shell-header\s+\.aph-header-menu/)
})

test('R73 不推动正文、不碰业务页面与移动壳层', () => {
  assert.doesNotMatch(active, /\bmain\b|#main-content|aph-page-tabs|padding-left|margin-left|left\s*:/)
  assert.doesNotMatch(active, /daily|payment|collection|arrears|api|fetch|url\(/i)
  assert.doesNotMatch(active, /140px/)
})
