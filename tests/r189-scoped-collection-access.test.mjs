import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = 'cockpit-r189-scoped-collection-access-20260901-v1'
const assetRelease = release
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'config/production-runtime-r127.json'), 'utf8'))
const trends = fs.readFileSync(path.join(root, 'server/src/routes/trends.ts'), 'utf8')
const collections = fs.readFileSync(path.join(root, 'server/src/routes/collections.ts'), 'utf8')
const collectionPage = fs.readFileSync(path.join(root,
  'production-overlays', release, 'payload/assets', assetRelease, 'chunk-D3P3MDJ2.js'), 'utf8')

test('R189候选使用独立不可变前端并取消收缴明细管理员专属门槛', () => {
  assert.equal(runtime.release, release)
  assert.equal(runtime.frontend.overlayPayload, `production-overlays/${release}/payload`)
  assert.equal(runtime.frontend.indexSha256, '9de81bb13819c139201ffda66dee46bcc24e90dbe51b8b6df377f617d2bb7a3f')
  const index = fs.readFileSync(path.join(root, runtime.frontend.overlayPayload, 'index.html'), 'utf8')
  assert.equal(crypto.createHash('sha256').update(index).digest('hex'), '279501b43347a2b22f8812f77fb700cc40330bac7a6ae3a7c5db861597b52cbe')
  assert.match(index, new RegExp(`assets/${assetRelease}/app-G7HUEEER\\.js`))
  assert.match(index, new RegExp(`releases/${release}/aph2-r189-scoped-collection-access-20260901-v1\\.js`))
  assert.match(collectionPage, /const viewer = ri\(\), isFullRegion = zd\(\)/)
  assert.match(collectionPage, /viewer && Promise\.allSettled\(\[u2\(\), m\(\)\]\)/)
  assert.match(collectionPage, /children: \[\$\.jsx\(x, \{ errors: a4 \}\), viewer \?/)
  assert.doesNotMatch(collectionPage, /children: \[\$\.jsx\(x, \{ errors: a4 \}\), zd\(\) \?/)
})

test('R189普通成员趋势仅返回授权汇总和授权片区，总部职能保留华北全域', () => {
  assert.match(trends, /hasValidServiceCenterAssignment\(req\.user\)/)
  assert.match(trends, /aggregate\.scopedRows\.filter\(row => canAccessServiceCenter\(req, row\.center\)\)/)
  assert.match(trends, /aggregate\.masterChanges\.filter\(change => canAccessServiceCenter\(req, change\.service_center\)\)/)
  assert.match(trends, /includedRowCount: scopedAggregate\.includedRowCount/)
  assert.match(trends, /serviceCenterMasterChangeIds: scopedAggregate\.masterChangeIds/)
  assert.match(trends, /role === 'admin' \|\| role === HEADQUARTERS_FUNCTION_ROLE/)
  assert.match(collections, /hasRegionWideReadAccess = role === 'admin' \|\| role === HEADQUARTERS_FUNCTION_ROLE/)
  assert.match(collections, /hasRegionWideReadAccess \|\| canAccessServiceCenter\(req, live\.center\)/)
  assert.match(trends, /\{ '授权汇总': authorizedRate \}/)
  assert.match(trends, /router\.get\('\/api\/collection-trends\/daily', \(req, res\) =>/)
  assert.match(trends, /router\.get\('\/api\/collection-trends\/weekly', \(req, res\) =>/)
  assert.doesNotMatch(trends, /router\.get\('\/api\/collection-trends\/(?:daily|weekly)', requireAdmin/)
  assert.match(collectionPage, /summarySeriesKey = isFullRegion \? "\\u534E\\u5317\\u6C47\\u603B" : "\\u6388\\u6743\\u6C47\\u603B"/)
  assert.match(collectionPage, /trendSeriesKey = o2 === "\\u5168\\u90E8" \? summarySeriesKey : o2/)
})

test('R189历史补录治理写操作仍保持管理员门禁', () => {
  assert.match(trends, /historical-backfills\/preview', requireAdmin/)
  assert.match(trends, /historical-backfills\/:id\/publish', requireAdmin/)
})
