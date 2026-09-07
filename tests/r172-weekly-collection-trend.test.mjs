import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const payload = path.join(root, 'production-overlays/cockpit-r172-weekly-collection-trend-20260831-v1/payload')
const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')
const bootstrap = fs.readFileSync(path.join(payload, 'releases/cockpit-r172-weekly-collection-trend-20260831-v1/aph2-r172-weekly-collection-trend-20260831-v1.js'), 'utf8')
const assetRoot = path.join(payload, 'assets/cockpit-r172-weekly-collection-trend-20260831-v1')
const helper = fs.readFileSync(path.join(assetRoot, 'chunk-J2DCCBRC.js'), 'utf8')
const page = fs.readFileSync(path.join(assetRoot, 'chunk-D3P3MDJ2.js'), 'utf8')
const bundle = fs.readFileSync(path.join(payload, 'assets/cockpit-bundle-head-r170-20260831.js'), 'utf8')
const route = fs.readFileSync(path.join(root, 'server/src/routes/trends.ts'), 'utf8')

test('R172实际执行全新周度收缴趋势资源', () => {
  assert.match(index, /modulepreload[^>]+cockpit-r172-weekly-collection-trend-20260831-v1\/app-G7HUEEER\.js/)
  assert.match(index, /type="module"[^>]+cockpit-r172-weekly-collection-trend-20260831-v1\/aph2-r172-weekly-collection-trend-20260831-v1\.js/)
  assert.match(bootstrap, /import\('\/assets\/cockpit-r172-weekly-collection-trend-20260831-v1\/app-G7HUEEER\.js'\)/)
})

test('经营概览按自然周最后发布日展示且不补造', () => {
  assert.match(route, /router\.get\('\/api\/collection-trends\/weekly', requireAdmin/)
  assert.match(route, /latest-published-business-date-in-natural-week/)
  assert.match(helper, /\/collection-trends\/weekly/)
  assert.doesNotMatch(helper, /\/collection-trends\/daily/)
  assert.match(page, /children: "\\u6BCF\\u5468\\u6536\\u7F34\\u8D8B\\u52BF"/)
  assert.match(page, /children: "\\u8F83\\u4E0A\\u4E00\\u53D1\\u5E03\\u5468"/)
  assert.match(page, /\\u6309\\u81EA\\u7136\\u5468\\u6700\\u540E\\u53D1\\u5E03\\u65E5/)
  assert.match(bundle, /经营概览按自然周最后发布日展示，不补造无正式批次的周/)
})
