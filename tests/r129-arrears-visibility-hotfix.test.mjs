import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const overlay = path.join(root, 'production-overlays/cockpit-r129-arrears-visibility-hotfix-20260826-v1/payload')
const index = fs.readFileSync(path.join(overlay, 'index.html'), 'utf8')
const script = fs.readFileSync(path.join(overlay, 'aph2-r128-screenshot-distillation-20260826-v1.js'), 'utf8')
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'config/production-runtime-r127.json'), 'utf8'))

test('R129 replaces the cached R128 script and preserves the arrears workspace boundary', () => {
  assert.match(index, /aph2-r128-screenshot-distillation-20260826-v1\.js\?v=r129-arrears-hotfix1/)
  assert.match(runtime.release, /^cockpit-r\d+-/)
  assert.match(script, /title\.closest\('\.page-heading'\)/)
  assert.match(script, /smallestSharedContainer\(stepLabels, main\)/)
  assert.match(script, /steps === main \|\| steps\.contains\(title\)/)
  assert.match(script, /table,form,\[role="tabpanel"\],\[data-arrears-workspace\]/)
  assert.doesNotMatch(script, /markers\.every\(marker => normalizedText\(candidate\)\.includes\(marker\)\)/)
})
