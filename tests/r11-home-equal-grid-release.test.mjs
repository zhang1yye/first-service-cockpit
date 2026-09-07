import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r11-home-equal-grid-20260810-v1.css'), 'utf8')

test('R11等分网格层在R10美化层之后加载', () => {
  assert.ok(html.indexOf('aph2-r10-home-polish-20260810-v1.css') < html.indexOf('aph2-r11-home-equal-grid-20260810-v1.css'))
})

test('R11将两个经营进度子卡提升为独立的等宽网格项', () => {
  assert.match(css, /\.r8-home-budget\s*\{\s*display:\s*contents\s*!important/)
  assert.match(css, /\.r8-home-budget > :nth-child\(2\)[\s\S]*?grid-column:\s*5\s*\/\s*span\s*4/)
  assert.match(css, /\.r8-home-budget > :nth-child\(3\)[\s\S]*?grid-column:\s*9\s*\/\s*span\s*4/)
})

test('R11明确覆盖宽屏美化层并让六张卡等高', () => {
  assert.match(css, /\.r8-home-collection[\s\S]*?grid-column:\s*1\s*\/\s*span\s*4/)
  assert.match(css, /\.r8-home-period[\s\S]*?grid-column:\s*1\s*\/\s*span\s*4/)
  assert.match(css, /\.r8-home-growth[\s\S]*?grid-column:\s*5\s*\/\s*span\s*4/)
  assert.match(css, /\.r8-home-scope[\s\S]*?grid-column:\s*9\s*\/\s*span\s*4/)
  assert.match(css, /height:\s*164px/)
  assert.match(css, /white-space:\s*normal/)
})
