import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const index = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const routeIntegrity = fs.readFileSync(
  path.join(site, 'aph2-r25-route-integrity-20260811-v1.js'),
  'utf8',
)

test('R25路由治理产物仍被保留，当前入口由R50接续', () => {
  const integrityPosition = index.indexOf('/aph2-r25-route-integrity-20260811-v1.js')
  assert.equal(integrityPosition, -1)
  assert.ok(index.includes('/aph2-r50-system-direct-admin-20260812-v1.js'))
  assert.doesNotMatch(index, /system-management-nav-20260811-v1\.js/)
})

test('R25将独立页面强制使用整页导航，避免被SPA路由拦截', () => {
  for (const route of ['/system/', '/admin/', '/arrears/', '/review-system/']) {
    assert.ok(routeIntegrity.includes(`'${route}'`), `缺少独立页面 ${route}`)
  }
  assert.match(routeIntegrity, /document\.addEventListener\('click',[\s\S]*true\)/)
  assert.match(routeIntegrity, /event\.stopImmediatePropagation\(\)/)
  assert.match(routeIntegrity, /window\.location\.assign/)
})

test('R25兼容全部SPA尾斜杠和两个历史AI入口', () => {
  for (const route of [
    '/command', '/payment', '/collection', '/daily', '/projects', '/import',
    '/ai-report', '/ai-alerts', '/tasks', '/review', '/login',
  ]) {
    assert.ok(routeIntegrity.includes(`'${route}'`), `缺少SPA路由 ${route}`)
  }
  assert.match(routeIntegrity, /pathname\.replace\(\/\\\/\+\$\/,\s*''\)/)
  assert.match(routeIntegrity, /\['\/alerts',\s*'\/ai-alerts'\]/)
  assert.match(routeIntegrity, /\['\/report',\s*'\/ai-report'\]/)
  assert.match(routeIntegrity, /window\.location\.replace/)
})

test('R25不吞掉真正未知的地址', () => {
  assert.doesNotMatch(routeIntegrity, /location\.pathname\s*=\s*'\/'/)
  assert.match(routeIntegrity, /if \(!nextPath\) return/)
})
