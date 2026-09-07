import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const site = new URL('../firstcare-cloud-local/', import.meta.url)
const js = await readFile(new URL('aph2-r57-mobile-ai-header-20260812-v1.js', site), 'utf8')
const css = await readFile(new URL('aph2-r57-mobile-ai-header-20260812-v1.css', site), 'utf8')
const qa = await readFile(new URL('../tests/r57_mobile_ai_header_qa.py', site), 'utf8')

test('R57 在真实 DOM 中将移动 AI 动作放到账号按钮左侧', () => {
  assert.match(js, /button\[aria-label="账号菜单"\]/)
  assert.match(js, /slot\.actions\.insertBefore\(proxy, slot\.accountWrap\)/)
  assert.match(js, /header\.aph-admin-shell-header/)
  assert.match(js, /slot\.actions\.append\(proxy\)/)
  assert.match(js, /aria-haspopup', 'dialog'/)
  assert.match(js, /APP_ROUTES/)
})

test('R57 复用原助手启动事件，不移动 overlay 也不改业务请求', () => {
  assert.match(js, /launcher\?\.click\(\)/)
  assert.match(js, /root\?\.querySelector\(':scope > \.north-ai-overlay'\)/)
  assert.doesNotMatch(js, /append(?:Child)?\(overlay\)|insertBefore\(overlay/)
  for (const forbidden of ['fetch(', 'XMLHttpRequest', '/api/', 'localStorage.setItem', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.doesNotMatch(js, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('R57 移动端原浮动入口退出视觉与 Tab 序，关闭后焦点返回顶栏', () => {
  assert.match(js, /launcher\.setAttribute\('aria-hidden', 'true'\)/)
  assert.match(js, /launcher\.tabIndex = -1/)
  assert.match(js, /proxy\.focus\(\)/)
  assert.match(js, /event\.key === 'Escape' && overlay\?\.getAttribute\('aria-hidden'\) === 'false'/)
  assert.match(css, /> \.north-ai-launcher\.aph-r57-mobile-ai-source/)
  assert.match(css, /display:\s*none\s*!important/)
})

test('R57 仅在 640px 及以下生效，保证 44px 触控与桌面恢复', () => {
  assert.match(css, /@media\s*\(max-width:\s*640px\)/)
  assert.match(css, /width:\s*44px\s*!important/)
  assert.match(css, /height:\s*44px\s*!important/)
  assert.match(css, /max-height:\s*44px\s*!important/)
  assert.match(css, /:is\(header\.sticky\.top-0, header\.aph-admin-shell-header\) button\.aph-r57-mobile-ai-launcher/)
  assert.match(css, /data-r57-placement="admin"/)
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
  assert.match(js, /if \(!MOBILE\.matches\) return unmountMobileEntry\(\)/)
  assert.match(js, /launcher\?\.removeAttribute\('tabindex'\)/)
})

test('R57 QA 支持候选影子站与部署后生产直连，两种模式都保持只读', () => {
  assert.match(qa, /TARGET not in \{"candidate", "production"\}/)
  assert.match(qa, /QA_WIDTHS/)
  assert.match(qa, /if TARGET == "candidate":/)
  assert.match(qa, /"https:\/\/firstcare\.cloud"/)
  assert.match(qa, /class BrowserReadOnlyGuard/)
  assert.match(qa, /method in \{"GET", "HEAD", "OPTIONS"\}/)
  assert.match(qa, /route\.abort\("blockedbyclient"\)/)
  assert.match(qa, /assert not guard\.blocked_writes/)
  assert.doesNotMatch(qa, /add_style_tag|add_script_tag/)
})
