import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = 'cockpit-r192-authenticated-home-parity-20260902-v1'
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'config/production-runtime-r127.json'), 'utf8'))
const payload = path.join(root, runtime.frontend.overlayPayload)
const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')
const dashboard = fs.readFileSync(path.join(payload,
  'assets/cockpit-r192-authenticated-home-parity-20260902-v1/chunk-C5JXPXJ4.js'), 'utf8')
const scopeUi = fs.readFileSync(path.join(payload, 'assets/cockpit-bundle-head-r190-20260901.js'), 'utf8')
const summary = fs.readFileSync(path.join(root, 'server/src/routes/summary.ts'), 'utf8')
const payments = fs.readFileSync(path.join(root, 'server/src/routes/payments.ts'), 'utf8')
const collections = fs.readFileSync(path.join(root, 'server/src/routes/collections.ts'), 'utf8')
const trends = fs.readFileSync(path.join(root, 'server/src/routes/trends.ts'), 'utf8')

test('R192使用独立前端并绑定当前R190生产入口', () => {
  assert.equal(runtime.release, release)
  assert.equal(runtime.frontend.overlayPayload, `production-overlays/${release}/payload`)
  assert.equal(runtime.frontend.indexSha256, '6cb4d49715fd94251f67c5dd31f20cee9095ec300d681e5aac5dfdf1a98f4955')
  assert.equal(crypto.createHash('sha256').update(index).digest('hex'), 'd5a957c4871fe3ab5204cba95610d2704b403c12abc3fa35cbbbdcbcb9407eda')
  assert.match(index, /assets\/cockpit-r192-authenticated-home-parity-20260902-v1\/app-G7HUEEER\.js/)
  assert.match(index, /releases\/cockpit-r192-authenticated-home-parity-20260902-v1\/aph2-r192-authenticated-home-parity-20260902-v1\.js/)
  assert.match(scopeUi, /function removeLegacyScopeBadge\(\)/)
  assert.match(scopeUi, /function restoreAuthorizedScopeControls\(\)/)
})

test('R192所有已认证账号首页读取同一华北正式汇总和公共回款视图', () => {
  assert.match(summary, /const homeRegionalRead = Boolean\(role\)/)
  assert.match(summary, /const aph = homeRegionalRead \? getAphKpi\(\) : null/)
  assert.match(summary, /const annualBudget = homeRegionalRead \? aph\?\.annualBudget/)
  assert.match(summary, /const scopedCollectionRows = homeRegionalRead \? activeCollectionRows/)
  assert.match(payments, /router\.get\('\/api\/home\/payments',[\s\S]*sendPaymentRows\(req, res, \{ clause: '', params: \[\] \}\)/)
  assert.match(dashboard, /Jd\("\/api\/home\/payments"\)/)
  assert.doesNotMatch(dashboard, /Promise\.allSettled\(\[o3\(\), f3\(\)/)
})

test('R192明细页和写操作继续按授权隔离', () => {
  assert.match(payments, /const centerScope = hasRegionWideReadAccess[\s\S]*sendPaymentRows\(req, res, centerScope\)/)
  assert.match(collections, /regionWideRead \|\| canAccessServiceCenter\(req, live\.center\)/)
  assert.match(trends, /aggregate\.scopedRows\.filter\(row => canAccessServiceCenter\(req, row\.center\)\)/)
  assert.match(collections, /router\.put\('\/api\/collections\/:id', requireAdmin/)
  assert.match(trends, /historical-backfills\/:id\/publish', requireAdmin/)
})
