import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r18-home-value-type-20260811-v1.css'), 'utf8')

test('R18字号层在R17数值居中层之后加载', () => {
  assert.ok(html.indexOf('aph2-r17-home-value-center-20260811-v1.css') < html.indexOf('aph2-r18-home-value-type-20260811-v1.css'))
})

test('R18统一五张居中卡的主数字与状态符号尺寸', () => {
  assert.match(css, /\.aph-home-reflow\[data-r8-home-layout\]\s+\.aph-home-kpi-grid/)
  assert.match(css, /font-size:\s*34px\s*!important/)
  assert.match(css, /line-height:\s*42px\s*!important/)
  assert.match(css, /font-size:\s*22px\s*!important/)
  assert.match(css, /width:\s*15px\s*!important/)
})

test('R18不覆盖收缴率复合卡字号', () => {
  assert.doesNotMatch(css, /\.r8-home-collection(?:\s|\.|>|\{|,)/)
  assert.doesNotMatch(css, /\.r8-home-rate-ring/)
  assert.doesNotMatch(css, /\.r8-home-collection-details/)
})
