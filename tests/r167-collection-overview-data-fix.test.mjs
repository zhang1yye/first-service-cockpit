import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const overlay = path.join(root, 'production-overlays/cockpit-r167-collection-overview-data-fix-20260831-v1/payload')
const apiHelper = fs.readFileSync(path.join(overlay, 'assets/cockpit-r160-daily-only-20260830-v1/chunk-J2DCCBRC.js'), 'utf8')
const bundleHead = fs.readFileSync(path.join(overlay, 'assets/cockpit-bundle-head-20260816.js'), 'utf8')
const collection = fs.readFileSync(path.join(overlay, 'assets/cockpit-r160-daily-only-20260830-v1/chunk-D3P3MDJ2.js'), 'utf8')
const trendsRoute = fs.readFileSync(path.join(root, 'server/src/routes/trends.ts'), 'utf8')

test('R167从已上线R166形成独立收缴率概览修复候选', () => {
})

test('收缴率前端兼容正式趋势接口的rows状态信封', () => {
  assert.match(trendsRoute, /res\.json\(\{ rows, status:/)
  assert.match(apiHelper, /const t = await n\(`\$\{a\}\/trends`\)/)
  assert.match(apiHelper, /Array\.isArray\(t\?\.rows\) \? t\.rows : \[\]/)
  assert.match(collection, /Promise\.allSettled\(\[u2\(\), m\(\)\]\)/)
})

test('经营概览不再被旧前端规则强制标记为历史接口未接入', () => {
  assert.doesNotMatch(bundleHead, /真实月度历史流水接口暂未接入，已停止展示演示趋势/)
  assert.match(bundleHead, /当前页使用已发布官方收缴批次；经营概览仅展示已验证月份，月份不足时不补造历史曲线/)
  assert.match(bundleHead, /data-collection-view="overview">经营概览/)
  assert.match(bundleHead, /trend\.hidden = view === 'details'/)
})

test('项目明细仍使用正式收缴接口且不被趋势兼容修复改写', () => {
  assert.match(apiHelper, /function u\(t\) \{\s*return n\(`\$\{a\}\/collections`\)/)
  assert.match(collection, /const \[e3, t2\] = hl\.useState\(\[\]\)/)
  assert.match(collection, /receivable: c3\.receivable \+ v\.receivable/)
})
