import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const payload = path.join(root, 'production-overlays/cockpit-r173-weekly-overview-tabs-cache-fix-20260831-v1/payload')
const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')
const bundle = fs.readFileSync(path.join(payload, 'assets/cockpit-bundle-head-r173-20260831.js'), 'utf8')

test('R173使用全新增强脚本文件名避免经营概览页签命中旧缓存', () => {
  assert.match(index, /\/assets\/cockpit-bundle-head-r173-20260831\.js/)
  assert.doesNotMatch(index, /cockpit-bundle-head-r170-20260831\.js/)
  assert.match(bundle, /exactTextElements\(main, '每周收缴趋势'\)/)
  assert.match(bundle, /经营概览按自然周最后发布日展示，不补造无正式批次的周/)
})
