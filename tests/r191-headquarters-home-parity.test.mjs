import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'config/production-runtime-r127.json'), 'utf8'))
const userAccess = fs.readFileSync(path.join(root, 'server/src/user-access.ts'), 'utf8')
const summary = fs.readFileSync(path.join(root, 'server/src/routes/summary.ts'), 'utf8')
const payments = fs.readFileSync(path.join(root, 'server/src/routes/payments.ts'), 'utf8')
const collections = fs.readFileSync(path.join(root, 'server/src/routes/collections.ts'), 'utf8')
const trends = fs.readFileSync(path.join(root, 'server/src/routes/trends.ts'), 'utf8')
const index = fs.readFileSync(path.join(root, runtime.frontend.overlayPayload, 'index.html'), 'utf8')
const scopeUi = fs.readFileSync(path.join(root, runtime.frontend.overlayPayload,
  'assets/cockpit-bundle-head-r190-20260901.js'), 'utf8')

test('R191复用已验证R190前端并绑定当前生产入口', () => {
  assert.equal(runtime.release, 'cockpit-r191-headquarters-home-parity-20260902-v1')
  assert.equal(runtime.frontend.overlayPayload, 'production-overlays/cockpit-r190-member-scope-filter-ui-20260901-v1/payload')
  assert.equal(runtime.frontend.indexSha256, '6cb4d49715fd94251f67c5dd31f20cee9095ec300d681e5aac5dfdf1a98f4955')
  assert.match(index, /assets\/cockpit-bundle-head-r190-20260901\.js/)
  assert.match(scopeUi, /function removeLegacyScopeBadge\(\)/)
  assert.match(scopeUi, /function restoreAuthorizedScopeControls\(\)/)
})

test('R191统一定义华北全域读取角色并用于首页、回款、收缴和趋势', () => {
  assert.match(userAccess, /export function hasRegionWideReadAccess\(role: unknown\): boolean/)
  assert.match(userAccess, /role === 'admin' \|\| role === HEADQUARTERS_FUNCTION_ROLE/)
  assert.match(summary, /const regionWideRead = hasRegionWideReadAccess/)
  assert.match(summary, /const aph = regionWideRead \? getAphKpi\(\) : null/)
  assert.match(summary, /const annualBudget = regionWideRead \? aph\?\.annualBudget/)
  assert.match(summary, /const scopedCollectionRows = regionWideRead \? activeCollectionRows/)
  assert.match(payments, /hasRegionWideReadAccess\(\(req as any\)\.user\?\.role\)/)
  assert.match(collections, /const regionWideRead = hasRegionWideReadAccess/)
  assert.match(trends, /hasRegionWideReadAccess\(req\.user\?\.role\)/)
})

test('R191受限成员和写操作门禁保持不变', () => {
  assert.match(summary, /: serviceCenterScopeWhere\(req, 'center'\)/)
  assert.match(payments, /: serviceCenterScopeWhere\(req, 'center'\)/)
  assert.match(collections, /regionWideRead \|\| canAccessServiceCenter\(req, live\.center\)/)
  assert.match(trends, /aggregate\.scopedRows\.filter\(row => canAccessServiceCenter\(req, row\.center\)\)/)
  assert.match(collections, /router\.put\('\/api\/collections\/:id', requireAdmin/)
  assert.match(trends, /historical-backfills\/:id\/publish', requireAdmin/)
})
