import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const payload = path.join(root, 'production-overlays/cockpit-r171-daily-trend-bootstrap-fix-20260831-v1/payload')
const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')
const bootstrap = fs.readFileSync(path.join(payload, 'releases/cockpit-r171-daily-trend-bootstrap-fix-20260831-v1/aph2-r171-daily-trend-bootstrap-fix-20260831-v1.js'), 'utf8')
const assetRoot = path.join(payload, 'assets/cockpit-r171-daily-trend-20260831-v1')

test('R171实际执行入口与预加载均指向全新每日趋势模块', () => {
  assert.match(index, /modulepreload[^>]+cockpit-r171-daily-trend-20260831-v1\/app-G7HUEEER\.js/)
  assert.match(index, /type="module"[^>]+cockpit-r171-daily-trend-bootstrap-fix-20260831-v1\/aph2-r171-daily-trend-bootstrap-fix-20260831-v1\.js/)
  assert.doesNotMatch(index, /releases\/cockpit-r160-daily-only-20260830-v1/)
  assert.match(bootstrap, /import\('\/assets\/cockpit-r171-daily-trend-20260831-v1\/app-G7HUEEER\.js'\)/)
  assert.doesNotMatch(bootstrap, /cockpit-r160-daily-only-20260830-v1/)
})

test('R171执行资源包含每日趋势接口和页面', () => {
  assert.equal(fs.existsSync(path.join(assetRoot, 'app-G7HUEEER.js')), true)
  assert.match(fs.readFileSync(path.join(assetRoot, 'chunk-J2DCCBRC.js'), 'utf8'), /\/collection-trends\/daily/)
  assert.match(fs.readFileSync(path.join(assetRoot, 'chunk-D3P3MDJ2.js'), 'utf8'), /children: "\\u6BCF\\u65E5\\u6536\\u7F34\\u8D8B\\u52BF"/)
})
