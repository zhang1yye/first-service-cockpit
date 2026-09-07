import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r12-home-card-rhythm-20260810-v1.css'), 'utf8')

test('R12卡片节奏层在等分网格之后加载', () => {
  assert.ok(html.indexOf('aph2-r11-home-equal-grid-20260810-v1.css') < html.indexOf('aph2-r12-home-card-rhythm-20260810-v1.css'))
})

test('R12统一经营卡的标题、数值与尾注行高', () => {
  assert.match(css, /grid-template-rows:\s*36px\s+44px\s+20px/)
  assert.match(css, /font-size:\s*14px\s*!important/)
  assert.match(css, /font-size:\s*36px\s*!important/)
  assert.match(css, /line-height:\s*44px\s*!important/)
  assert.match(css, /font-size:\s*12px\s*!important/)
  assert.match(css, /line-height:\s*20px\s*!important/)
})

test('R12统一图标框和状态符号尺寸', () => {
  assert.match(css, /width:\s*36px\s*!important/)
  assert.match(css, /height:\s*36px\s*!important/)
  assert.match(css, /width:\s*16px\s*!important/)
  assert.match(css, /transform:\s*translateY\(1px\)/)
})
