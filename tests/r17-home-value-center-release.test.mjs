import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r17-home-value-center-20260811-v1.css'), 'utf8')

test('R17数值居中层在收缴率等分层之后加载', () => {
  assert.ok(html.indexOf('aph2-r15-collection-halves-20260811-v1.css') < html.indexOf('aph2-r17-home-value-center-20260811-v1.css'))
})

test('R17只居中其余五张卡的数值行', () => {
  assert.match(css, /\.r8-home-budget\s*>\s*:not\(\.r8-home-duplicate\)/)
  assert.match(css, /:is\(\.r8-home-period,\s*\.r8-home-growth,\s*\.r8-home-scope\)/)
  assert.match(css, /justify-content:\s*center/)
  assert.match(css, /justify-self:\s*stretch/)
})

test('R17不覆盖第一个收缴率复合卡', () => {
  assert.doesNotMatch(css, /\.r8-home-collection(?:\s|\.|>|\{|,)/)
  assert.doesNotMatch(css, /\.r8-home-rate-ring/)
  assert.doesNotMatch(css, /\.r8-home-collection-details/)
})
