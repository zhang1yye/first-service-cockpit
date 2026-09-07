import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r22-core-card-balance-20260811-v1.css'), 'utf8')

test('R22核心指标卡平衡层在R21之后加载', () => {
  assert.ok(html.indexOf('aph2-r21-collection-ring-safe-type-20260811-v1.css') < html.indexOf('aph2-r22-core-card-balance-20260811-v1.css'))
})

test('R22将标题独占首行并让主数值与完成率同排', () => {
  assert.match(css, /grid-template-columns:\s*auto auto/)
  assert.match(css, /grid-template-rows:\s*auto auto/)
  assert.match(css, /grid-column:\s*1\s*\/\s*-1/)
  assert.match(css, /:nth-child\(2\)[\s\S]*grid-row:\s*2/)
  assert.match(css, /:nth-child\(3\)[\s\S]*grid-row:\s*2/)
})

test('R22只触及核心指标卡展示层，不修改收缴率卡或业务数据', () => {
  assert.match(css, /\.r8-home-core/)
  assert.doesNotMatch(css, /\.r8-home-collection/)
  assert.doesNotMatch(css, /fetch\(|\/api\//)
})
