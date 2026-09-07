import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const overlay = path.join(root, 'production-overlays/cockpit-r169-daily-collection-trend-20260831-v1/payload')
const helper = fs.readFileSync(path.join(overlay, 'assets/cockpit-r160-daily-only-20260830-v1/chunk-J2DCCBRC.js'), 'utf8')
const collection = fs.readFileSync(path.join(overlay, 'assets/cockpit-r160-daily-only-20260830-v1/chunk-D3P3MDJ2.js'), 'utf8')
const bundle = fs.readFileSync(path.join(overlay, 'assets/cockpit-bundle-head-20260816.js'), 'utf8')
const route = fs.readFileSync(path.join(root, 'server/src/routes/trends.ts'), 'utf8')

test('R169按当前R167生产基线形成每日收缴趋势发布候选', () => {
})

test('经营概览直接读取已发布官方收缴批次的每日趋势接口', () => {
  assert.match(route, /router\.get\('\/api\/collection-trends\/daily'/)
  assert.match(route, /publishedDailyCollectionBatches\(\)\.map/)
  assert.match(route, /m: String\(batch\.business_date\)/)
  assert.match(helper, /return n\(`\$\{a\}\/collection-trends\/daily`\)/)
  assert.doesNotMatch(helper, /\$\{a\}\/trends/)
})

test('页面明确使用每日口径并以相邻发布日计算变化', () => {
  assert.match(collection, /children: "\\u6BCF\\u65E5\\u6536\\u7F34\\u8D8B\\u52BF"/)
  assert.match(collection, /children: "\\u8F83\\u4E0A\\u4E00\\u53D1\\u5E03\\u65E5"/)
  assert.match(collection, /\\u6309\\u5DF2\\u53D1\\u5E03\\u4E1A\\u52A1\\u65E5/)
  assert.match(collection, /dataKey: "m"/)
  assert.match(collection, /A = i2\.length > 1 \? g - b : Number\.NaN/)
  assert.match(bundle, /经营概览按已发布业务日展示，不补造缺失日期/)
  assert.match(bundle, /exactTextElements\(main, '每日收缴趋势'\)/)
})
