import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const web = path.join(root, 'firstcare-cloud-local')

const [index, directAdmin, cloudGate, bootstrap, progressive, mobileShell] = await Promise.all([
  readFile(path.join(web, 'index.html'), 'utf8'),
  readFile(path.join(web, 'aph2-r50-system-direct-admin-20260812-v1.js'), 'utf8'),
  readFile(path.join(web, 'aph2-r45-cloud-remediation-20260812-v1.js'), 'utf8'),
  readFile(path.join(web, 'aph2-r52-app-bootstrap-20260812-v1.js'), 'utf8'),
  readFile(path.join(web, 'aph2-theme-20260808-progressive6.js'), 'utf8'),
  readFile(path.join(web, 'aph2-theme-20260809-remediation3.js'), 'utf8'),
])

test('R50 在应用和旧壳层之前收口系统管理路由', () => {
  const r50 = index.indexOf('/aph2-r50-system-direct-admin-20260812-v1.js')
  const cloud = index.indexOf('/aph2-r45-cloud-remediation-20260812-v1.js')
  const progressive = index.indexOf('/aph2-theme-20260808-progressive6.js')
  assert.ok(r50 > 0)
  assert.ok(r50 < cloud)
  assert.ok(r50 < progressive)
  assert.equal(index.includes('/aph2-r26-shell-consistency-20260811-v1.js'), false)
  assert.match(index, /aph2-theme-20260808-progressive6\.js\?v=r50-admin-direct1/)
  assert.match(index, /aph2-theme-20260809-remediation3\.js\?v=r50-admin-direct1/)
})

test('历史系统管理地址单向替换为后台管理且不显示中转页', () => {
  assert.match(directAdmin, /const ADMIN_ROUTE = '\/admin'/)
  assert.match(directAdmin, /\['\/system', ADMIN_ROUTE\]/)
  assert.match(directAdmin, /window\.history\.replaceState\(window\.history\.state, '', admin\)/)
  assert.match(directAdmin, /window\.location\.replace\(target\)/)
  assert.match(directAdmin, /document\.documentElement\.style\.visibility = 'hidden'/)
  assert.doesNotMatch(directAdmin, /使用界面|后台管理界面|aph-system-hub/)
  assert.match(cloudGate, /INTEGRATED_ROUTES = new Set\(\['\/arrears'\]\)/)
  assert.doesNotMatch(bootstrap, /使用界面|后台管理界面|aph-system-hub|systemMarkup/)
})

test('未登录进入后台时保留 /admin 登录回跳', () => {
  assert.match(directAdmin, /pathname === ADMIN_ROUTE && !hasSessionToken\(\)/)
  assert.match(directAdmin, /`\/login\?next=\$\{encodeURIComponent\(target\)\}`/)
  assert.match(directAdmin, /window\.sessionStorage\.setItem\(LOGIN_NEXT_KEY, target\)/)
  assert.match(directAdmin, /user\.role !== 'admin'/)
  assert.match(directAdmin, /window\.location\.replace\(target\)/)
})

test('侧栏、页签和会话历史都统一为 /admin', () => {
  assert.match(directAdmin, /a\[href\],a\[data-aph-tab-href\]/)
  assert.match(directAdmin, /target\.pathname = ADMIN_ROUTE/)
  assert.match(directAdmin, /data-aph-tab-href/)
  assert.match(directAdmin, /sessionStorage\.setItem\(OPEN_TABS_KEY, nextRaw\)/)
  assert.match(progressive, /\{ href: '\/admin', label: '系统管理'/)
  assert.match(progressive, /\['\/system', '\/admin'\]/)
  assert.match(mobileShell, /\['\/admin', '系统管理'\]/)
})

test('真实点击历史入口使用硬导航进入后台', () => {
  assert.match(directAdmin, /document\.addEventListener\('click'/)
  assert.match(directAdmin, /event\.stopImmediatePropagation\(\)/)
  assert.match(directAdmin, /window\.location\.assign\(targetWithSuffix\(mappedTarget, target\)\)/)
})
