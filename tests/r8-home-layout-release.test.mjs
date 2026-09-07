import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const script = fs.readFileSync(path.join(site, 'aph2-r8-home-layout-20260810-v1.js'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r8-home-layout-20260810-v1.css'), 'utf8')

test('R8首页排布层在R7修复层之后加载', () => {
  assert.ok(html.indexOf('aph2-r7-remediation-20260810-v3.js') < html.indexOf('aph2-r8-home-layout-20260810-v1.js'))
  assert.ok(html.indexOf('aph2-r7-remediation-20260810-v1.css') < html.indexOf('aph2-r8-home-layout-20260810-v1.css'))
})

test('R8首页只去除重复展示且不改数据来源', () => {
  assert.match(script, /annual-budget/)
  assert.match(script, /distance-to-target/)
  assert.match(script, /collection-rate-detail/)
  assert.match(script, /collection-progress/)
  assert.doesNotMatch(script, /\/api\//)
  assert.doesNotMatch(script, /fetch\s*\(/)
})

test('R8桌面端使用两张经营进度卡和三张辅助卡', () => {
  assert.match(css, /\.r8-home-budget\s*\{/)
  assert.match(css, /grid-template-columns:\s*repeat\(2/)
  assert.match(css, /\.r8-home-period\s*\{/)
  assert.match(css, /grid-column:\s*1\s*\/\s*span\s*4/)
  assert.match(css, /\.r8-home-growth\s*\{/)
  assert.match(css, /grid-column:\s*5\s*\/\s*span\s*4/)
  assert.match(css, /\.r8-home-scope\s*\{/)
  assert.match(css, /grid-column:\s*9\s*\/\s*span\s*4/)
})

test('R8首页在平板和手机端保持单列可读', () => {
  assert.match(css, /@media\s*\(max-width:\s*1023px\)/)
  assert.match(css, /@media\s*\(max-width:\s*640px\)/)
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)/)
})
