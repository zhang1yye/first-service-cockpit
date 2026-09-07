import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const css = await readFile(new URL(
  '../firstcare-cloud-local/aph2-r71-sidebar-first-frame-latch-20260813-v1.css',
  import.meta.url,
), 'utf8')

test('R71 只在桌面首帧纯 hover 状态收起面板', () => {
  assert.match(css, /@media \(min-width: 641px\)/)
  assert.match(css, /:hover:not\(\.is-hovered\):not\(\.is-expanded\)/)
  assert.match(css, /width: 60px !important/)
})

test('R71 同步隐藏首帧文字并移除阴影', () => {
  assert.match(css, /box-shadow: none !important/)
  assert.match(css, /opacity: 0 !important/)
  assert.match(css, /visibility: hidden !important/)
})

test('R71 不推动正文、不修改路由或保护页', () => {
  assert.doesNotMatch(css, /main|aph-page-tabs|padding-left|margin-left|flex-basis/)
  assert.doesNotMatch(css, /daily|payment|collection|admin|arrears/)
  assert.doesNotMatch(css, /@media \(max-width/)
})

test('R71 不改变已建立的 hover、pin 或抑制态', () => {
  assert.doesNotMatch(css, /\.is-hovered\s+\.aph-exact-sidebar-panel/)
  assert.doesNotMatch(css, /\.is-expanded\s+\.aph-exact-sidebar-panel/)
  assert.doesNotMatch(css, /aph-r70-hover-suppressed/)
})
