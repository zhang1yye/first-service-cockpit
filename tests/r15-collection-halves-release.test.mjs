import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r15-collection-halves-20260811-v1.css'), 'utf8')

test('R15等分层在收缴率分区层之后加载', () => {
  assert.ok(html.indexOf('aph2-r14-collection-split-20260811-v1.css') < html.indexOf('aph2-r15-collection-halves-20260811-v1.css'))
})

test('R15将收缴率正文左右区严格等分', () => {
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)\s*!important/)
  assert.match(css, /gap:\s*0\s*!important/)
  assert.match(css, /justify-self:\s*center/)
})
