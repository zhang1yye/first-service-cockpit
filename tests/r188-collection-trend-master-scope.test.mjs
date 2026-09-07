import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = 'cockpit-r188-collection-trend-master-scope-20260901-v1'
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'config/production-runtime-r127.json'), 'utf8'))
const trends = fs.readFileSync(path.join(root, 'server/src/routes/trends.ts'), 'utf8')
const collectionRoute = fs.readFileSync(path.join(root, 'server/src/routes/collections.ts'), 'utf8')
const collectionPage = fs.readFileSync(path.join(root,
  'production-overlays', release, 'payload/assets/cockpit-r187-area-weekly-change-filter-20260901-v1/chunk-D3P3MDJ2.js'), 'utf8')

test('R188候选继续复用已验证R187前端并绑定当前生产基线', () => {
  assert.equal(runtime.release, release)
  assert.equal(runtime.frontend.overlayPayload, `production-overlays/${release}/payload`)
  assert.equal(runtime.frontend.indexSha256, '9de81bb13819c139201ffda66dee46bcc24e90dbe51b8b6df377f617d2bb7a3f')
  const index = fs.readFileSync(path.join(root, runtime.frontend.overlayPayload, 'index.html'), 'utf8')
  assert.match(index, /assets\/cockpit-r187-area-weekly-change-filter-20260901-v1\/app-G7HUEEER\.js/)
  assert.match(index, /releases\/cockpit-r187-area-weekly-change-filter-20260901-v1\/aph2-r187-area-weekly-change-filter-20260901-v1\.js/)
  assert.match(collectionPage, /trendSeriesKey = o2 === "\\u5168\\u90E8" \? "\\u534E\\u5317\\u6C47\\u603B" : o2/)
  assert.match(collectionPage, /i2\[i2\.length - 1\]\[trendSeriesKey\]/)
})

test('R188趋势按快照业务日应用服务中心主数据并单列撤场项目', () => {
  assert.match(trends, /applyEffectiveMasterState,/)
  assert.match(trends, /latestEffectiveMasterChanges,/)
  assert.match(trends, /SERVICE_CENTER_WITHDRAWN_AREA,/)
  assert.match(trends, /validateAndAggregateCollectionRows\(rows: any\[\], label: string, businessDate: string\)/)
  assert.match(trends, /applyEffectiveMasterState\(rows, \{ asOf: businessDate \}\)/)
  assert.match(trends, /values\[SERVICE_CENTER_WITHDRAWN_AREA\] = withdrawnRate/)
  assert.match(trends, /validateAndAggregateCollectionRows\(rows, `P46批次\$\{batch\.id\}`, String\(batch\.business_date\)\)/)
  assert.match(trends, /validateAndAggregateCollectionRows\(parsed\.rows, `历史收缴归档\$\{businessDate\}`, businessDate\)/)
  assert.match(trends, /serviceCenterMasterScope: 'effective master state as of snapshot business date'/)
  assert.match(trends, /serviceCenterMasterChangeIds: aggregate\.masterChangeIds/)
})

test('R188当前卡片与趋势继续使用同一正式中心收缴率算法', () => {
  assert.match(collectionRoute, /getCollectionDisplayRate\(row\.center, receivable, received, readOptionalNumber\(live\?\.collectionRate\)\)/)
  assert.match(trends, /applicableCollectionRate: getCollectionDisplayRate\(/)
  assert.match(trends, /SUM\(receivable \* applicableCollectionRate\) \/ SUM\(receivable\), receivable > 0/)
})
