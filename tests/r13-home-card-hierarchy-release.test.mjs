import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r13-home-card-hierarchy-20260810-v1.css'), 'utf8')

test('R13层在R12经营卡节奏层之后加载', () => {
  assert.ok(html.indexOf('aph2-r12-home-card-rhythm-20260810-v1.css') < html.indexOf('aph2-r13-home-card-hierarchy-20260810-v1.css'))
})

test('R13让首行经营卡的标题与数值使用独立网格行', () => {
  assert.match(css, /display:\s*contents\s*!important/)
  assert.match(css, /grid-column:\s*1\s*\/\s*-1/)
  assert.match(css, /grid-row:\s*2/)
  assert.match(css, /min-height:\s*44px/)
})

test('R13将收缴率应收和实收改为横向并列', () => {
  assert.match(css, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(css, /width:\s*88px\s*!important/)
  assert.match(css, /> :not\(\[hidden\]\)/)
  assert.match(css, /grid-template-rows:\s*20px\s+28px/)
})
