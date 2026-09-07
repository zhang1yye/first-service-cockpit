import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const js = await readFile(new URL('firstcare-cloud-local/aph2-r70-sidebar-transient-overlay-20260813-v1.js', root), 'utf8')
const css = await readFile(new URL('firstcare-cloud-local/aph2-r70-sidebar-transient-overlay-20260813-v1.css', root), 'utf8')

test('R70 保持 60/140 覆盖层模型，不推动或缩窄正文', () => {
  assert.match(css, /@media \(min-width: 641px\)/)
  assert.match(css, /aph-r70-hover-suppressed[\s\S]*?width: 60px !important/)
  assert.doesNotMatch(css, /main|aph-page-tabs|padding-left|margin-left/)
  assert.doesNotMatch(css.replaceAll(/\/\*[\s\S]*?\*\//g, ''), /140px/)
})

test('R70 在首个文档悬停和侧栏链接点击后进入抑制态', () => {
  assert.match(js, /if \(sidebar\.matches\(':hover'\)\)[\s\S]*?suppressionActive = true/)
  assert.match(js, /target\?\.closest\('\.aph-exact-sidebar a\[href\]'\)/)
  assert.match(js, /collapse\(\{ suppressHover: true \}\)/)
})

test('R70 只在指针真正离开固定面板后恢复 hover', () => {
  assert.match(js, /window\.addEventListener\('pointermove'/)
  assert.match(js, /if \(suppressionActive && !pointerInPanel\(panel\)\) releaseSuppression\(\)/)
  assert.doesNotMatch(js, /setTimeout\(releaseSuppression/)
})

test('R70 仅在桌面运行，并用 animation frame 复核首帧 hover', () => {
  assert.match(js, /matchMedia\('\(min-width: 641px\)'\)/)
  assert.match(js, /if \(!desktop\(\)\) return/)
  assert.match(js, /function detectInitialHover\(\)/)
  assert.ok((js.match(/requestAnimationFrame/g) || []).length >= 2)
})

test('R70 的 class observer 只在 token 真正变化时写入', () => {
  assert.match(js, /classList\.contains\(token\) === enabled/)
  assert.match(js, /setClass\(sidebar, 'is-expanded', false\)/)
  assert.match(js, /setClass\(sidebar, SUPPRESSED, true\)/)
  assert.doesNotMatch(js, /sidebar\.classList\.(add|remove|toggle)/)
})

test('R70 在抑制态抵消旧层对 aria-expanded 的错误回写', () => {
  assert.match(js, /attributeFilter: \['aria-expanded'\]/)
  assert.match(js, /menuObserver = new MutationObserver\(\(\) => syncAria\(\)\)/)
  assert.match(js, /menu\.getAttribute\('aria-expanded'\) !== next/)
})

test('R70 统一关闭 pin、Escape 与 aria 状态', () => {
  assert.match(js, /setClass\(sidebar, 'is-expanded', false\)/)
  assert.match(js, /setClass\(sidebar, 'is-hovered', false\)/)
  assert.match(js, /sessionStorage\.removeItem\(PIN_KEY\)/)
  assert.match(js, /event\.key !== 'Escape'/)
  assert.match(js, /const next = String\(expanded\)/)
  assert.match(js, /menu\.setAttribute\('aria-expanded', next\)/)
})

test('R70 鼠标点汉堡只做临时展开，键盘展开仍由 Escape 关闭', () => {
  assert.match(js, /addEventListener\('pointerdown'/)
  assert.match(js, /lastMenuPointerType = target\?\.closest\('\.aph-header-menu'\) \? event\.pointerType : ''/)
  assert.match(js, /const pointerActivation = event\.detail > 0 && lastMenuPointerType === 'mouse'/)
  assert.match(js, /if \(pointerActivation\)/)
  assert.match(js, /if \(pointerMenuOpen && !pointerMenuEntered\) collapse\(\)/)
  assert.match(js, /else if \(pointerMenuEntered\)[\s\S]*?collapse\(\)/)
  assert.match(js, /sidebar\.querySelector\('a\[href\]'\)\?\.focus\(\)/)
  assert.doesNotMatch(js, /sessionStorage\.setItem/)
})

test('R70 不访问业务接口或改写认证数据', () => {
  assert.doesNotMatch(js, /fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
  assert.doesNotMatch(js, /\/api\/|cockpit_token|localStorage/)
  assert.doesNotMatch(js, /history\.|location\s*=|location\.(assign|replace|reload)/)
})
