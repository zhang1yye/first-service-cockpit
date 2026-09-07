import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r45-cloud-remediation-20260812-v1.css'), 'utf8')
const js = fs.readFileSync(path.join(site, 'aph2-r45-cloud-remediation-20260812-v1.js'), 'utf8')
const bootstrap = fs.readFileSync(path.join(site, 'aph2-r52-app-bootstrap-20260812-v1.js'), 'utf8')
const server = fs.readFileSync(path.join(root, 'server/src/routes/ai.ts'), 'utf8')
const smoke = fs.readFileSync(path.join(root, 'tests/cockpit_server_authenticated_smoke.py'), 'utf8')

test('R45 在旧壳层和主应用之前接管启动顺序', () => {
  assert.match(html, /aph2-r45-cloud-remediation-20260812-v1\.js\?v=r50-admin-direct1/)
  assert.match(html, /aph2-r52-app-bootstrap-20260812-v1\.js\?v=r52-csp2/)
  assert.ok(html.indexOf('aph2-r50-system-direct-admin') < html.indexOf('aph2-r45-cloud-remediation'))
  assert.ok(html.indexOf('aph2-r45-cloud-remediation') < html.indexOf('aph2-r52-app-bootstrap'))
  assert.doesNotMatch(html, /aph2-r31-unified-shell-20260811-v1\.js/)
  assert.doesNotMatch(html, /type="importmap"/)
  assert.match(html, /modulepreload" href="\/assets\/cockpit-r51-cloud-remediation-20260812-v1\/app-G7HUEEER\.js"/)
  assert.match(bootstrap, /await import\('\/assets\/cockpit-r51-cloud-remediation-20260812-v1\/app-G7HUEEER\.js'\)/)
  assert.match(bootstrap, /replaceState\(window\.history\.state, '', '\/collection'\)/)
  assert.match(bootstrap, /mountIntegrated\(main, logicalRoute\)/)
  assert.doesNotMatch(bootstrap, /aph-system-hub|使用界面|后台管理界面/)
})

test('R45 用不可变组件映射补齐导入身份与后台主内容 landmark', () => {
  const releaseDir = path.join(site, 'assets/cockpit-r51-cloud-remediation-20260812-v1')
  for (const asset of ['chunk-4UXV2DAK.js', 'chunk-LR35IIDP.js', 'chunk-YICGYIFC.js']) {
    assert.ok(fs.existsSync(path.join(releaseDir, asset)))
  }
  const layout = fs.readFileSync(path.join(releaseDir, 'chunk-4UXV2DAK.js'), 'utf8')
  const importPage = fs.readFileSync(path.join(releaseDir, 'chunk-LR35IIDP.js'), 'utf8')
  const admin = fs.readFileSync(path.join(releaseDir, 'chunk-YICGYIFC.js'), 'utf8')
  assert.match(layout, /to: "\/import", label: "\\u6570\\u636E\\u5BFC\\u5165"/)
  assert.match(layout, /grid size-11 place-items-center/)
  assert.match(importPage, /className: "aph-r45-route-intro"/)
  assert.match(importPage, /className: "aph-r45-touch-action text-xs text-primary/)
  assert.match(admin, /\.jsxs\("main", \{ id: "main-content", role: "main", "aria-labelledby": "aph-admin-title"/)
  assert.match(admin, /className: "aph-r36-admin-heading aph-r45-admin-heading"/)
  assert.match(admin, /id: "aph-admin-title"/)
})

test('R45 恢复后台 hidden 行并逐项提升移动端触控目标', () => {
  assert.match(css, /tbody tr\[hidden\]\s*\{\s*display: none !important/)
  assert.match(css, /button\[aria-label="账号菜单"\]/)
  assert.match(css, /\.north-ai-close/)
  assert.match(css, /\.r6-sort-button/)
  assert.match(css, /button\[aria-label\^="查看方案："\]/)
  assert.match(js, /minimumHeight = box\.height \* \(44 \/ rect\.height\)/)
})

test('R45 预检与服务端门禁同源，受保护接口仍保留阻断', () => {
  assert.match(server, /router\.get\('\/api\/data-quality\/project-gate'/)
  assert.match(server, /const gate = readProjectDataGate\(db\)/)
  assert.match(server, /PROJECT_DATA_QUALITY_BLOCKED/)
  assert.match(js, /nativeFetch\('\/api\/data-quality\/project-gate'/)
  assert.match(js, /x-aph-gate-preflight/)
  assert.match(js, /status: 409/)
})

test('认证 smoke 默认使用接口一致性而非过期快照常量', () => {
  assert.doesNotMatch(smoke, /'0\.6317'/)
  assert.doesNotMatch(smoke, /'2026-08-08'/)
  assert.match(smoke, /abs\(detail_rate-summary_rate\)<1e-9/)
  assert.match(smoke, /publication\.get\('businessDate'\)==business_date/)
  assert.match(smoke, /gate\.get\('status'\) in \('ready','blocked'\)/)
})
