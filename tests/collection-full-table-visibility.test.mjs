import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')

function selectedOverlay() {
  const match = html.match(/<script src="\/(aph2-theme-20260808-progressive6\.js)(?:\?[^\"]*)?"><\/script>/)
  assert.ok(match, '首页必须选择收缴率修复的不可变版本脚本')
  return fs.readFileSync(path.join(site, match[1]), 'utf8')
}

test('collection detail keeps all rows reachable in a bounded table-only scroll area', () => {
  const overlay = selectedOverlay()
  assert.match(overlay, /function enhanceServiceCenterDetailScrolling/)
  assert.match(overlay, /aph-service-center-scroll/)
  assert.match(overlay, /row\.hidden = false/)
  assert.doesNotMatch(overlay, /setProperty\(['"]max-height['"],\s*['"]none['"]/)
})
