import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const html = fs.readFileSync(path.join(root, 'firstcare-cloud-local/arrears/index.html'), 'utf8')
const cssName = html.match(/href="\/arrears\/(arrears-[^"?]+\.css)"/)?.[1]
const jsName = html.match(/src="\/arrears\/(arrears-overview-[^"?]+\.js)"/)?.[1]
assert.ok(cssName && jsName, '欠费页必须选择不可变CSS和JS资源')
const css = fs.readFileSync(path.join(root, 'firstcare-cloud-local/arrears', cssName), 'utf8')
const js = fs.readFileSync(path.join(root, 'firstcare-cloud-local/arrears', jsName), 'utf8')

test('arrears KPI reads the governed overview instead of deriving business totals in browser', () => {
  assert.match(html, /<small>欠费台账净额<\/small><strong id="metricAmount">/)
  assert.match(html, /<small>有效批次<\/small><strong id="metricBatches">/)
  assert.match(js, /api\(['"]\/api\/arrears\/overview['"]\)/)
  assert.doesNotMatch(js, /state\.batches\.filter\(x=>x\.status!==['"]revoked['"]\)\.length/)
  assert.doesNotMatch(js, /overview\.totalAmount\s*\|\|\s*0/)
})

test('mobile arrears batches use labeled cards instead of destructively compressed columns', () => {
  for (const label of ['批次', '项目/业务日期', '数据规模', '校验', 'AI状态', '操作']) {
    assert.match(js, new RegExp(`dataset\\.label=['"]${label.replace('/', '\\/')}['"]`))
  }
  assert.match(css, /@media\(max-width:680px\)[\s\S]*\.batches-panel table[\s\S]*\.batches-panel thead\{display:none\}/)
  assert.match(css, /\.batches-panel tbody tr\{display:grid/)
  assert.match(css, /\.batches-panel td::before\{content:attr\(data-label\)/)
})
