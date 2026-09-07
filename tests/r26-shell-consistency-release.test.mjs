import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const index = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const script = fs.readFileSync(path.join(site, 'aph2-r26-shell-consistency-20260811-v1.js'), 'utf8')
const system = fs.readFileSync(path.join(site, 'system', 'index.html'), 'utf8')
const arrears = fs.readFileSync(path.join(site, 'arrears', 'index.html'), 'utf8')
const nginx = fs.readFileSync(path.join(root, 'deploy', 'r26', 'review-system.conf'), 'utf8')

test('R26在应用启动前接管壳层与历史入口', () => {
  const shellPosition = index.indexOf('/aph2-r50-system-direct-admin-20260812-v1.js')
  const appPosition = index.indexOf('/assets/cockpit-r51-cloud-remediation-20260812-v1/app-G7HUEEER.js')
  assert.ok(shellPosition >= 0)
  assert.ok(appPosition > shellPosition)
})

test('旧研发审核地址统一进入内置APH审核页', () => {
  assert.match(script, /\['\/review-system',\s*'\/review\?view=workbench'\]/)
  assert.match(script, /\['\/review-system\/',\s*'\/review\?view=workbench'\]/)
  assert.doesNotMatch(script, /\['\/review-system\/?',\s*'\/review-system\/'\]/)
  assert.match(nginx, /location = \/review-system\/ \{ return 302 \/review\?view=workbench; \}/)
  assert.match(nginx, /location = \/review-system\/index\.html \{ return 302 \/review\?view=workbench; \}/)
})

test('系统管理直达后台，欠费分析由R52确定性复用驾驶舱主壳层', () => {
  const unified = fs.readFileSync(path.join(site, 'aph2-r52-app-bootstrap-20260812-v1.js'), 'utf8')
  const directAdmin = fs.readFileSync(path.join(site, 'aph2-r50-system-direct-admin-20260812-v1.js'), 'utf8')
  assert.match(unified, /logicalRoute = window\.__aphR45InitialRoute/)
  assert.match(directAdmin, /const ADMIN_ROUTE = '\/admin'/)
  assert.match(directAdmin, /\['\/system', ADMIN_ROUTE\]/)
  assert.match(arrears, /arrears-entry-20260811-v1\.js/)
  assert.match(arrears, /arrears-shell-20260811-v4\.css/)
  assert.match(index, /aph2-r52-app-bootstrap-20260812-v1\.js/)
})

test('系统管理链接治理不改写正文后台管理入口', () => {
  assert.match(script, /link\.closest\(['"]\.aph-exact-sidebar, \.aph-page-tabs, header['"]\)/)
})
