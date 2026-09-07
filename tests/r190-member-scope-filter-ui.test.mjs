import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = 'cockpit-r190-member-scope-filter-ui-20260901-v1'
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'config/production-runtime-r127.json'), 'utf8'))
const payload = path.join(root, 'production-overlays', release, 'payload')
const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')
const scopeUi = fs.readFileSync(path.join(payload, 'assets/cockpit-bundle-head-r190-20260901.js'), 'utf8')
const collectionPage = fs.readFileSync(path.join(payload,
  'assets/cockpit-r189-scoped-collection-access-20260901-v1/chunk-D3P3MDJ2.js'), 'utf8')
const trends = fs.readFileSync(path.join(root, 'server/src/routes/trends.ts'), 'utf8')
const collections = fs.readFileSync(path.join(root, 'server/src/routes/collections.ts'), 'utf8')

test('R190使用独立头部资源并绑定当前R189生产入口基线', () => {
  assert.equal(runtime.release, release)
  assert.equal(runtime.frontend.overlayPayload, `production-overlays/${release}/payload`)
  assert.equal(runtime.frontend.indexSha256, '279501b43347a2b22f8812f77fb700cc40330bac7a6ae3a7c5db861597b52cbe')
  assert.equal(crypto.createHash('sha256').update(index).digest('hex'), '6cb4d49715fd94251f67c5dd31f20cee9095ec300d681e5aac5dfdf1a98f4955')
  assert.match(index, /assets\/cockpit-bundle-head-r190-20260901\.js/)
  assert.match(index, /assets\/cockpit-r189-scoped-collection-access-20260901-v1\/app-G7HUEEER\.js/)
  assert.doesNotMatch(index, /assets\/cockpit-bundle-head-r173-20260831\.js/)
})

test('R190移除成员范围红框并恢复已授权筛选控件', () => {
  assert.match(scopeUi, /function removeLegacyScopeBadge\(\)/)
  assert.match(scopeUi, /getElementById\('aph-r65-service-center-scope'\)\?\.remove\(\)/)
  assert.match(scopeUi, /function restoreAuthorizedScopeControls\(\)/)
  assert.match(scopeUi, /removeAttribute\('data-r65-scope-control-hidden'\)/)
  assert.match(scopeUi, /select\.disabled = false/)
  assert.doesNotMatch(scopeUi, /badge\.id = 'aph-r65-service-center-scope'/)
  assert.doesNotMatch(scopeUi, /control\.disabled = true/)
  assert.doesNotMatch(scopeUi, /setAttribute\('data-r65-scope-control-hidden'/)
})

test('R190只恢复前端筛选，R189页面开放和后端授权隔离继续生效', () => {
  assert.match(collectionPage, /children: \[\$\.jsx\(x, \{ errors: a4 \}\), viewer \?/)
  assert.match(collectionPage, /summarySeriesKey = isFullRegion \? "\\u534E\\u5317\\u6C47\\u603B" : "\\u6388\\u6743\\u6C47\\u603B"/)
  assert.match(trends, /hasValidServiceCenterAssignment\(req\.user\)/)
  assert.match(trends, /canAccessServiceCenter\(req, row\.center\)/)
  assert.match(collections, /regionWideRead \|\| canAccessServiceCenter\(req, live\.center\)/)
  assert.match(trends, /historical-backfills\/preview', requireAdmin/)
  assert.match(trends, /historical-backfills\/:id\/publish', requireAdmin/)
})
