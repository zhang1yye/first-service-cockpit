import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r20-collection-target-polish-20260811-v1.css'), 'utf8')
const js = fs.readFileSync(path.join(site, 'aph2-r20-collection-target-polish-20260811-v1.js'), 'utf8')

test('R20目标与视觉层在R19之后加载', () => {
  assert.ok(html.indexOf('aph2-r19-collection-ring-scale-20260811-v1.css') < html.indexOf('aph2-r20-collection-target-polish-20260811-v1.css'))
  assert.match(html, /aph2-r20-collection-target-polish-20260811-v1\.js/)
})

test('R20展示华北地区当期收缴率考核目标88.39%', () => {
  assert.match(js, /const TARGET_RATE = 88\.39/)
  assert.match(js, /当期考核目标/)
  assert.match(js, /距目标/)
  assert.match(js, /华北地区当期收缴率考核目标/)
})

test('R20统一环图、目标徽标与金额字号', () => {
  assert.match(css, /\.r20-collection-target/)
  assert.match(css, /stroke-linecap:\s*round/)
  assert.match(css, /width:\s*100px\s*!important/)
  assert.match(css, /font-size:\s*23px\s*!important/)
  assert.match(css, /font-size:\s*20px\s*!important/)
  assert.match(css, /height:\s*100%\s*!important/)
  assert.match(css, /grid-template-rows:\s*minmax\(0,\s*1fr\)\s*!important/)
})

test('R20不改收缴率接口、计算口径和左右等分结构', () => {
  assert.doesNotMatch(js, /fetch\s*\(/)
  assert.doesNotMatch(js, /gatheringCurrentYearRecedRate/)
  assert.doesNotMatch(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/)
})
