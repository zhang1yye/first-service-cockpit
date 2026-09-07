import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r19-collection-ring-scale-20260811-v1.css'), 'utf8')

test('R19环图尺寸层在R18字号层之后加载', () => {
  assert.ok(html.indexOf('aph2-r18-home-value-type-20260811-v1.css') < html.indexOf('aph2-r19-collection-ring-scale-20260811-v1.css'))
})

test('R19放大环图并同步环内文字比例', () => {
  assert.match(css, /width:\s*100px\s*!important/)
  assert.match(css, /height:\s*100px\s*!important/)
  assert.match(css, /font-size:\s*24px\s*!important/)
  assert.match(css, /font-size:\s*13px\s*!important/)
})

test('R19不改变收缴率左右等分和右侧金额区', () => {
  assert.doesNotMatch(css, /grid-template-columns/)
  assert.doesNotMatch(css, /\.r8-home-collection-details/)
  assert.doesNotMatch(css, /\.r8-home-budget/)
})
