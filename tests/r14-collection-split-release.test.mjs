import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r14-collection-split-20260811-v1.css'), 'utf8')

test('R14收缴率分区层在R13层之后加载', () => {
  assert.ok(html.indexOf('aph2-r13-home-card-hierarchy-20260810-v1.css') < html.indexOf('aph2-r14-collection-split-20260811-v1.css'))
})

test('R14将环图与金额明细分为左右两区', () => {
  assert.match(css, /grid-template-columns:\s*88px\s+minmax\(0,\s*1fr\)/)
  assert.match(css, /border-left:\s*1px\s+solid\s+rgba\(226,\s*35,\s*35,\s*0\.16\)/)
  assert.match(css, /padding-left:\s*18px/)
})

test('R14将应收和实收在右侧呈现为两条对齐明细', () => {
  assert.match(css, /grid-template-rows:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(css, /justify-content:\s*space-between/)
  assert.match(css, /text-align:\s*right/)
})
