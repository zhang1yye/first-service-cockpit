import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const payload = path.join(root, 'production-overlays/cockpit-r170-daily-trend-cache-bust-20260831-v1/payload')
const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')
const assetRoot = path.join(payload, 'assets/cockpit-r170-daily-trend-20260831-v1')
const helper = fs.readFileSync(path.join(assetRoot, 'chunk-J2DCCBRC.js'), 'utf8')
const collection = fs.readFileSync(path.join(assetRoot, 'chunk-D3P3MDJ2.js'), 'utf8')
const bundle = fs.readFileSync(path.join(payload, 'assets/cockpit-bundle-head-r170-20260831.js'), 'utf8')

test('R170从当前R169生产形成全新指纹资源候选', () => {
  assert.match(index, /\/assets\/cockpit-r170-daily-trend-20260831-v1\/app-G7HUEEER\.js/)
  assert.match(index, /\/assets\/cockpit-bundle-head-r170-20260831\.js/)
  assert.doesNotMatch(index, /cockpit-r160-daily-only-20260830-v1\/app-G7HUEEER\.js/)
  assert.doesNotMatch(index, /cockpit-bundle-head-20260816\.js/)
})

test('新资源目录完整保留R169每日趋势实现', () => {
  assert.equal(fs.existsSync(path.join(assetRoot, 'app-G7HUEEER.js')), true)
  assert.match(helper, /\/collection-trends\/daily/)
  assert.match(collection, /children: "\\u6BCF\\u65E5\\u6536\\u7F34\\u8D8B\\u52BF"/)
  assert.match(collection, /children: "\\u8F83\\u4E0A\\u4E00\\u53D1\\u5E03\\u65E5"/)
  assert.match(bundle, /经营概览按已发布业务日展示，不补造缺失日期/)
})
