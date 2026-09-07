import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r23-scope-count-type-20260811-v1.css'), 'utf8')

test('R23经营分组数字字号层在R22之后加载', () => {
  assert.ok(html.indexOf('aph2-r22-core-card-balance-20260811-v1.css') < html.indexOf('aph2-r23-scope-count-type-20260811-v1.css'))
})

test('R23让经营分组卡的两个数字使用相同字号和行高', () => {
  assert.match(css, /\.r8-home-scope \.num > span/)
  assert.match(css, /font-size:\s*34px\s*!important/)
  assert.match(css, /line-height:\s*42px\s*!important/)
  assert.match(css, /font-weight:\s*600\s*!important/)
})

test('R23仅调整经营分组字号，不修改业务数据或其它卡片', () => {
  assert.doesNotMatch(css, /\.r8-home-collection|\.r8-home-core|fetch\(|\/api\//)
  assert.doesNotMatch(css, /grid-template|(?:^|[\s{;])(?:width|height)\s*:/m)
})
