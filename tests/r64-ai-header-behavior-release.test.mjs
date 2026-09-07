import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const site = new URL('../firstcare-cloud-local/', import.meta.url)
const js = await readFile(new URL('aph2-r64-ai-header-all-viewports-20260813-v1.js', site), 'utf8')
const css = await readFile(new URL('aph2-r64-ai-header-all-viewports-20260813-v1.css', site), 'utf8')

test('R64 优先匹配后台顶栏，其他路由将 AI 放到账号左侧', () => {
  assert.ok(
    js.indexOf("route() === '/admin'") < js.indexOf("document.querySelector('header.sticky.top-0')"),
    '后台顶栏必须先于普通 sticky 顶栏匹配',
  )
  assert.match(js, /button\[aria-label="账号菜单"\]/)
  assert.match(js, /slot\.actions\.insertBefore\(proxy, slot\.accountWrap\)/)
  assert.match(js, /header\.aph-admin-shell-header/)
  assert.match(js, /slot\.actions\.append\(proxy\)/)
  assert.match(js, /aria-haspopup', 'dialog'/)
  assert.match(css, /button\.aph-r64-ai-launcher/)
  assert.match(css, /width:\s*44px\s*!important/)
  assert.match(css, /height:\s*44px\s*!important/)
})

test('R64 在所有断点隐藏原固定浮标，并将助手置于导航和抽屉之上', () => {
  const sourceRule = css.indexOf('north-ai-launcher.aph-r64-ai-source')
  const desktopRule = css.indexOf('@media (min-width: 641px)')
  assert.ok(sourceRule >= 0 && sourceRule < desktopRule, '原浮标隐藏规则必须覆盖所有断点')
  assert.match(css, /north-ai-launcher\.aph-r64-ai-source\s*\{[\s\S]*display:\s*none\s*!important/)
  assert.match(css, /\.aph-r57-mobile-ai-launcher\s*\{[\s\S]*display:\s*none\s*!important/)
  assert.match(css, /north-ai-overlay\[aria-hidden="false"\]\.is-open\s*\{[\s\S]*z-index:\s*10050\s*!important/)
  assert.doesNotMatch(css, /right:\s*18px|bottom:\s*18px/)
})

test('R64 移动端固定完整壳层，隐藏重复汉堡菜单', () => {
  assert.match(js, /classList\.toggle\('aph-r64-mobile-shell', mobileShell\)/)
  assert.match(css, /@media\s*\(max-width:\s*640px\)/)
  assert.match(css, /header\.sticky\.top-0[\s\S]*position:\s*fixed\s*!important/)
  assert.match(css, /\.aph-mobile-primary-nav\s*\{[\s\S]*top:\s*50px\s*!important/)
  assert.match(css, /header\.sticky\.top-0 \.aph-header-menu\s*\{[\s\S]*display:\s*none\s*!important/)
  assert.match(css, /padding-top:\s*50px\s*!important/)
})

test('R64 后台移动顶栏拥有真实品牌、标题和账号菜单 DOM', () => {
  assert.match(js, /aph-r64-admin-mobile-identity/)
  assert.match(js, /logo\.src = '\/logo\.png'/)
  assert.match(js, /title\.textContent = '数据管理'/)
  assert.match(js, /brand\.setAttribute\('aria-label', '返回驾驶舱'\)/)
  assert.match(js, /account\.setAttribute\('aria-label', '账号菜单'\)/)
  assert.match(js, /account\.setAttribute\('aria-haspopup', 'menu'\)/)
  assert.match(js, /home\.textContent = '返回驾驶舱'/)
  assert.match(css, /aph-r64-admin-mobile-title/)
  assert.match(css, /aph-r64-admin-account\s*\{[\s\S]*width:\s*44px\s*!important[\s\S]*height:\s*44px\s*!important/)
  assert.match(css, /header\.aph-admin-shell-header\s*\{[\s\S]*overflow:\s*visible\s*!important/)
  assert.match(css, /aph-r64-admin-account-menu\s*\{[\s\S]*top:\s*48px[\s\S]*z-index:\s*100/)
  assert.match(css, /text-overflow:\s*ellipsis/)
})

test('R64 与移动 R57 使用稳定锚点，不争抢账号前的末位', () => {
  assert.match(js, /const r57Anchor = !DESKTOP\.matches/)
  assert.match(js, /proxy\.nextElementSibling !== r57Anchor/)
  assert.match(js, /slot\.actions\.insertBefore\(proxy, r57Anchor\)/)
})

test('R64 可在 CSP 影子环境于 documentElement 建立前安全注入', () => {
  assert.match(js, /if \(document\.documentElement\) observeDocument\(\)/)
  assert.match(js, /document\.addEventListener\('readystatechange', observeDocument, \{ once: true \}\)/)
  assert.doesNotMatch(js, /new MutationObserver\(schedule\)\.observe/)
})

test('R64 任何移动主导航切换都先关闭更多抽屉', () => {
  assert.match(js, /\.aph-mobile-more-drawer:not\(\[hidden\]\)/)
  assert.match(js, /button\[aria-label="关闭更多功能"\]/)
  assert.match(js, /\.aph-mobile-primary-nav a/)
  assert.match(js, /function handleNavigation\(\)\s*\{[\s\S]*closeMobileDrawer\(\)[\s\S]*schedule\(\)/)
  assert.match(js, /closeMobileDrawer\(\)[\s\S]*assistantElements\(\)\.launcher\?\.click\(\)/)
})

test('R64 关闭助手后把焦点还给当前顶栏入口', () => {
  assert.match(js, /activeEntry\(\)\?\.focus\(\)/)
  assert.match(js, /event\.key === 'Escape' && overlay\?\.getAttribute\('aria-hidden'\) === 'false'/)
  assert.match(js, /close \|\| \(overlay && target === overlay\)/)
})

test('R64 只修复显示与焦点，不访问接口或业务数据', () => {
  for (const forbidden of [
    'fetch(', 'XMLHttpRequest', '/api/', 'localStorage', 'sessionStorage',
    'POST', 'PUT', 'PATCH', 'DELETE', 'received', 'receivable', 'collectionRate',
  ]) {
    assert.doesNotMatch(js, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.doesNotMatch(css, /\/api\/|received|receivable|collectionRate/)
})

test('R64 不修改已保护业务页的页面级选择器', () => {
  for (const routeClass of ['aph-payment-route', 'aph-daily', 'aph-collection']) {
    assert.doesNotMatch(css, new RegExp(routeClass))
    assert.doesNotMatch(js, new RegExp(routeClass))
  }
  assert.doesNotMatch(css, /data-collection-view|data-project-filter|payment-card/)
})
