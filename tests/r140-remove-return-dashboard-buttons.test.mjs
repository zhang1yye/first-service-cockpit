import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const payload = path.join(root, 'production-overlays/cockpit-r140-remove-return-dashboard-buttons-20260827-v1/payload')
const distillation = fs.readFileSync(path.join(payload, 'aph2-r128-screenshot-distillation-20260826-v1.js'), 'utf8')
const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')

test('R140 removes return-dashboard controls across every route and dynamic state', () => {
  assert.match(distillation, /function hideReturnDashboardButtons\(root = document\)/)
  assert.match(distillation, /a,button,\[role="button"\]/)
  assert.match(distillation, /return-dashboard-button/)
  assert.match(distillation, /empty-return-dashboard-toolbar/)
  assert.match(distillation, /hideReturnDashboardButtons\(document\)/)
  assert.doesNotMatch(distillation, /window\.location\.pathname !== '\/payment'/)
})

test('R140 covers same-origin embedded interfaces without removing global navigation labels', () => {
  assert.match(distillation, /function hideIframeReturnDashboardButtons\(\)/)
  assert.match(distillation, /frame\.contentDocument/)
  assert.match(distillation, /frameObserver\.observe/)
  assert.doesNotMatch(distillation, /驾驶舱看板.*returnDashboardLabel/)
  assert.match(index, /aph2-r128-screenshot-distillation-20260826-v1\.js\?v=r140-remove-return1/)
})
