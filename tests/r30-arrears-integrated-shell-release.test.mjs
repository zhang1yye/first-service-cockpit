import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const index = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const integration = fs.readFileSync(path.join(site, 'aph2-r52-app-bootstrap-20260812-v1.js'), 'utf8')
const integrationCss = fs.readFileSync(path.join(site, 'aph2-r31-unified-shell-20260811-v1.css'), 'utf8')
const navigation = fs.readFileSync(path.join(site, 'aph2-theme-20260808-progressive6.js'), 'utf8')
const routeGuard = fs.readFileSync(path.join(site, 'aph2-r26-shell-consistency-20260811-v1.js'), 'utf8')
const nginx = fs.readFileSync(path.join(root, 'deploy/r26/review-system.conf'), 'utf8')

test('R45 mounts arrears inside the cockpit content area', () => {
  assert.match(index, /aph2-r52-app-bootstrap-20260812-v1\.js/)
  assert.match(index, /aph2-r31-unified-shell-20260811-v1\.css/)
  assert.match(integration, /logicalRoute = window\.__aphR45InitialRoute/)
  assert.match(integration, /main\.replaceChildren\(\)/)
  assert.match(integration, /frame\.src = ['"]\/arrears\/index\.html\?embedded=1&v=r45-cloudfix1['"]/) 
  assert.doesNotMatch(integration, /frame\.src = ['"]\/arrears\/\?embedded=1['"]/) 
})

test('R31 gives arrears a dedicated cockpit route and keeps legacy content embed-only', () => {
  assert.match(routeGuard, /['"]\/arrears['"]/)
  assert.match(routeGuard, /\['\/arrears\/', '\/arrears'\]/)
  assert.match(nginx, /location = \/arrears\s*\{[\s\S]*?try_files \/index\.html =404;/)
  assert.match(nginx, /location = \/arrears\/\s*\{[\s\S]*?X-Frame-Options "SAMEORIGIN"/)
})

test('accepted pages remain untouched by the integrated route overlay', () => {
  assert.doesNotMatch(integration, /\/daily|\/payment/)
  assert.doesNotMatch(integration, /view=arrears/)
})

test('arrears iframe bypasses the SPA fallback to prevent recursive cockpit shells', () => {
  assert.match(index, /aph2-r52-app-bootstrap-20260812-v1\.js\?v=r52-csp2/)
  assert.match(integration, /\/arrears\/index\.html\?embedded=1&v=r45-cloudfix1/)
})

test('R45 uses a deterministic backing shell and restores the canonical route', () => {
  assert.match(integration, /replaceState\(window\.history\.state, '', '\/collection'\)/)
  assert.match(integration, /await import\('\/assets\/cockpit-r51-cloud-remediation-20260812-v1\/app-G7HUEEER\.js'\)/)
  assert.match(integration, /const main = await waitForMain\(\)/)
  assert.match(integration, /window\.history\.replaceState\(window\.history\.state, '', route\)/)
  assert.match(integration, /aph:r45-integrated-mounted/)
})

test('leaving an integrated view performs a clean document navigation', () => {
  assert.match(navigation, /document\.body\.dataset\.aphUnifiedView/)
  assert.match(navigation, /window\.location\.assign\(targetLocation\)/)
})

test('collapsed navigation links use the visible panel width as their hit area', () => {
  assert.match(integrationCss, /\.aph-exact-sidebar-panel a\s*\{[\s\S]*?width:\s*100%/)
})

test('system management no longer exists in the integrated bootstrap', () => {
  const directAdmin = fs.readFileSync(path.join(site, 'aph2-r50-system-direct-admin-20260812-v1.js'), 'utf8')
  assert.doesNotMatch(integration, /aph-system-hub|使用界面|后台管理界面/)
  assert.match(directAdmin, /const ADMIN_ROUTE = '\/admin'/)
})
