import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r9-home-position-20260810-v1.css'), 'utf8')

test('R9首页位置层在R8布局层之后加载', () => {
  assert.ok(html.indexOf('aph2-r8-home-layout-20260810-v1.css') < html.indexOf('aph2-r9-home-position-20260810-v1.css'))
})

test('R9将收缴率置于指标区左上并让经营进度在右侧连续排列', () => {
  assert.match(css, /\.r8-home-collection\s*\{\s*grid-column:\s*1\s*\/\s*span\s*4\s*!important/)
  assert.match(css, /\.r8-home-budget\s*\{\s*grid-column:\s*5\s*\/\s*span\s*8\s*!important/)
})
