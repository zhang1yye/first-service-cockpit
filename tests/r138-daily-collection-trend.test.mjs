import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const payload = path.join(root, 'production-overlays/cockpit-r138-daily-collection-trend-20260827-v1/payload')
const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')
const remediation = fs.readFileSync(path.join(payload, 'aph2-r127-audit-remediation-20260826-v3.js'), 'utf8')
const trends = fs.readFileSync(path.join(root, 'server/src/routes/trends.ts'), 'utf8')

test('R138 exposes daily collection trends from formally published P46 batches', () => {
  assert.match(trends, /function publishedDailyCollectionBatches\(\)/)
  assert.match(trends, /formalP46PublicationPredicate\('b'\)/)
  assert.match(trends, /newer\.business_date=b\.business_date/)
  assert.match(trends, /router\.get\('\/api\/collection-trends\/daily', requireAdmin/)
  assert.match(trends, /m: String\(batch\.business_date\)/)
  assert.match(trends, /validateAndAggregateBatch\(batch\)/)
})

test('R138 keeps the monthly governance trend contract unchanged', () => {
  assert.match(trends, /router\.get\('\/api\/trends', requireAdmin/)
  assert.match(trends, /router\.post\('\/api\/trends\/rebuild', requireAdmin/)
  assert.match(trends, /publishedMonthlyCollectionBatches\(\)/)
})

test('R138 sends only the collection detail trend request to the daily endpoint', () => {
  assert.match(remediation, /requestPath\(input\) === '\/api\/trends' && window\.location\.pathname === '\/collection'/)
  assert.match(remediation, /nativeFetch\('\/api\/collection-trends\/daily', init\)/)
  assert.match(remediation, /已有正式发布数据 · 按业务日期每日展示/)
  assert.match(remediation, /classList\.remove\('aph-history-unavailable'\)/)
  assert.match(remediation, /\.aph-history-status, \.aph-trend-unavailable/)
  assert.match(index, /aph2-r127-audit-remediation-20260826-v3\.js\?v=r138-daily-trend1/)
})
