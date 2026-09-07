import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const js = await readFile(
  new URL('firstcare-cloud-local/aph2-r75-refresh-home-clean-header-20260813-v1.js', root),
  'utf8',
)

test('R75 只在浏览器刷新时执行', () => {
  assert.match(js, /navigation\?\.type !== 'reload'/)
  assert.doesNotMatch(js, /popstate|pushState/)
})

test('R75 刷新时清空工作页签并回首页', () => {
  assert.match(js, /sessionStorage\.removeItem\(OPEN_TABS_KEY\)/)
  assert.match(js, /window\.location\.replace\('\/'\)/)
  assert.match(js, /window\.location\.pathname !== '\/login'/)
})

test('R75 只取消指定顶部提示条', () => {
  assert.match(js, /style\.textContent = '\.aph-r45-project-gate\{display:none!important\}'/)
  assert.match(js, /document\.head\.append\(style\)/)
})

test('R75 不访问接口、认证数据或业务存储', () => {
  assert.doesNotMatch(js, /fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\/api\//)
  assert.doesNotMatch(js, /localStorage|cockpit_token|authToken/)
  assert.doesNotMatch(js, /querySelector|main|sidebar|daily|payment|collection|admin/i)
})
