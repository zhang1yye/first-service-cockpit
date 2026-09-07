import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const release = fs.readFileSync(path.join(site, 'aph2-r6-operations-20260810-v6.js'), 'utf8')
const releaseCss = fs.readFileSync(path.join(site, 'aph2-r6-operations-20260810-v2.css'), 'utf8')
const login = fs.readFileSync(path.join(site, 'assets/cockpit-r6-20260810-v1/chunk-XPGKS6ED.js'), 'utf8')
const daily = fs.readFileSync(path.join(site, 'assets/cockpit-r6-20260810-v1/chunk-24D7OGMQ.js'), 'utf8')
const assistant = fs.readFileSync(path.join(site, 'north-ai-assistant-20260810-r6.js'), 'utf8')
const nginx = fs.readFileSync(path.join(root, 'deploy/nginx/cockpit-spa-routing.conf'), 'utf8')

test('R6 immutable assets are selected and the superseded R5 layer is not loaded', () => {
  assert.match(html, /aph2-r6-operations-20260810-v6\.js/)
  assert.match(html, /assets\/cockpit-r51-cloud-remediation-20260812-v1\/app-G7HUEEER\.js/)
  assert.doesNotMatch(html, /aph2-r5-governance-20260809-v1\.js/)
})

test('login is a single accessible main and unauthenticated assistant does not mount', () => {
  assert.match(login, /\$\.jsx\("main"/)
  assert.match(login, /cockpit-login-username/)
  assert.match(login, /cockpit-login-password/)
  assert.match(login, /autoComplete: "current-password"/)
  assert.match(login, /role: "alert"/)
  assert.match(assistant, /window\.location\.pathname === '\/login'/)
  assert.match(assistant, /!authenticated/)
  assert.doesNotMatch(assistant, /<main class="north-ai-conversation"/)
  assert.match(releaseCss, /body\.aph-auth-route/)
})

test('daily missing source values stay unknown in totals, rows and CSV', () => {
  assert.match(daily, /sourceStatus/)
  assert.match(daily, /Number\.isFinite\(s\.daily\)/)
  assert.match(daily, /Number\.NaN/)
  assert.match(daily, /Number\.isFinite\(n\.daily\) \? Number\(n\.daily\)\.toFixed\(2\) : ""/)
  assert.match(daily, /value === null \|\| value === void 0 \|\| !Number\.isFinite/)
})

test('remaining UX fixes cover grouping, mobile title, mapping drilldown and long-table sorting', () => {
  for (const token of ['经营分组 / 服务中心数', '6个地理片区 + 3个特殊分组', '收缴率明细', '查看未关联映射', "['/payment', '/projects']", 'aria-sort', "searchParams.set('sort'"]) {
    assert.match(release, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('source freshness no longer occupies the home content grid', () => {
  for (const token of ['data-r6-source-freshness-slot', 'relocateSourceFreshness', 'syncSourceFreshnessGeometry']) assert.match(release, new RegExp(token))
  assert.match(release, /pathname === '\/'/)
  assert.match(release, /currentPanel\.style\.setProperty\('display', 'none', 'important'\)/)
  assert.match(releaseCss, /content:"数据更新状态"/)
  assert.match(releaseCss, /\.aph-home-reflow>\.r6-source-freshness-slot\{grid-row:4\}/)
})

test('nginx contract adds transport, framing, MIME and referrer protections', () => {
  for (const token of ['Strict-Transport-Security', 'Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options']) assert.match(nginx, new RegExp(token))
})
