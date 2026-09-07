import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const overlay = path.join(root, 'production-overlays/cockpit-r128-screenshot-distillation-20260826-v1/payload')
const index = fs.readFileSync(path.join(overlay, 'index.html'), 'utf8')
const script = fs.readFileSync(path.join(overlay, 'aph2-r128-screenshot-distillation-20260826-v1.js'), 'utf8')
const css = fs.readFileSync(path.join(overlay, 'aph2-r128-screenshot-distillation-20260826-v1.css'), 'utf8')
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'config/production-runtime-r127.json'), 'utf8'))
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'config/production-baseline.json'), 'utf8'))

const requestedCuts = [
  ['欠费台账AI分析', 'arrears-workflow-hero'],
  ['.aph-project-page-head', 'project-page-hero'],
  ['返回总驾驶舱', 'payment-back-link'],
  ['华北各片区收缴明细', 'collection-table-heading'],
]

test('R128 frozen production snapshot loads the distillation patch', () => {
  assert.match(index, /aph2-r128-screenshot-distillation-20260826-v1\.js/)
  assert.match(index, /aph2-r128-screenshot-distillation-20260826-v1\.css/)
  assert.ok(index.indexOf('aph2-r128-screenshot-distillation-20260826-v1.js') < index.indexOf('cockpit-bundle-head-20260816.js'))
  assert.equal(baseline.release, 'cockpit-r128-screenshot-distillation-20260826-v1')
  assert.equal(baseline.mirrorIndex, 'production-overlays/cockpit-r128-screenshot-distillation-20260826-v1/payload/index.html')
  assert.match(runtime.release, /^cockpit-r\d+-/)
})

test('all four screenshot-directed removals are route-scoped and layout-compacted', () => {
  for (const [selector, reason] of requestedCuts) {
    assert.ok(script.includes(selector), `missing target ${selector}`)
    assert.ok(script.includes(reason), `missing removal reason ${reason}`)
  }
  for (const pathname of ['/arrears', '/projects', '/payment', '/collection']) assert.ok(script.includes(pathname))
  assert.match(script, /MutationObserver/)
  assert.match(css, /\[data-aph-r128-hidden\]/)
  assert.match(css, /collection-details/)
  assert.match(css, /data-aph-r128-payment-toolbar/)
})

test('R128 removes presentation only and retains source business modules', () => {
  assert.doesNotMatch(script, /fetch\(|XMLHttpRequest|localStorage|sessionStorage/)
  assert.doesNotMatch(css, /outline\s*:\s*none/)
  assert.doesNotMatch(css, /transition\s*:\s*all/)
})
