import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r21-collection-ring-safe-type-20260811-v1.css'), 'utf8')

test('R21环内安全字号层在R20之后加载', () => {
  assert.ok(html.indexOf('aph2-r20-collection-target-polish-20260811-v1.css') < html.indexOf('aph2-r21-collection-ring-safe-type-20260811-v1.css'))
})

test('R21把环内文字限制在70px安全内径', () => {
  assert.match(css, /width:\s*70px/)
  assert.match(css, /height:\s*70px/)
  assert.match(css, /inset:\s*15px\s*!important/)
  assert.match(css, /overflow:\s*hidden/)
  assert.match(css, /max-width:\s*70px/)
})

test('R21缩小当前值和差值但不修改环图及业务数据', () => {
  assert.match(css, /font-size:\s*18px\s*!important/)
  assert.match(css, /font-size:\s*9px\s*!important/)
  assert.doesNotMatch(css, /\.r20-collection-target/)
  assert.doesNotMatch(css, /grid-template-columns/)
})
