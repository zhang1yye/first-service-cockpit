import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local', 'arrears')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const cssName = html.match(/href="\/arrears\/(arrears-[^"?]+\.css)"/)?.[1]
const jsName = html.match(/src="\/arrears\/(arrears-overview-[^"?]+\.js)"/)?.[1]
assert.ok(cssName && jsName)
const css = fs.readFileSync(path.join(site, cssName), 'utf8')
const js = fs.readFileSync(path.join(site, jsName), 'utf8')

test('overview ships immutable assets and a complete operating structure', () => {
  assert.match(cssName, /overview-\d{8}(?:-[a-z0-9]+)?\.css$/)
  assert.match(jsName, /overview-\d{8}\.js$/)
  for (const id of ['metricAmount','metricResources','metricProjects','metricBatches','metricReview','metricDate','overviewEmpty','overviewPanels','projectBreakdown','areaBreakdown','ageingBreakdown','feeBreakdown','causeBreakdown']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
})

test('overview renders API text safely and preserves missing-value semantics', () => {
  assert.match(js, /api\(['"]\/api\/arrears\/overview['"]\)/)
  assert.match(js, /暂无可用于经营分析的有效批次/)
  assert.match(js, /缺失金额不按0处理|无有效金额事实/)
  assert.match(js, /不等于未联系/)
  assert.doesNotMatch(js, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/)
  assert.doesNotMatch(js, /北京万国城|满庭芳园|青云大厦/)
})

test('overview translates backend cause keys and distinguishes negative amounts', () => {
  assert.match(js, /billing_dispute:['"]账单争议['"]/)
  assert.match(js, /payment_difficulty:['"]支付困难['"]/)
  assert.match(js, /amount!==null&&amount<0\?['"] negative['"]/)
  assert.match(css, /\.breakdown-item\.negative \.breakdown-bar\{background:var\(--aph-warn\)\}/)
})

test('overview uses an asymmetric desktop grid and collapses safely on mobile', () => {
  assert.match(css, /\.overview-grid\{display:grid;grid-template-columns:/)
  assert.match(css, /\.portfolio-panel\{grid-column:1\/3\}/)
  assert.match(css, /@media\(max-width:800px\)[\s\S]*\.overview-grid\{grid-template-columns:1fr\}/)
  assert.match(css, /@media\(max-width:680px\)[\s\S]*\.operating-metrics\{grid-template-columns:1fr 1fr\}/)
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/)
})

test('arrears separates overview, resource details, and batch operations', () => {
  for (const label of ['经营总览', '项目与资源明细', '批次工作台']) {
    assert.match(html, new RegExp(label))
  }
  assert.match(html, /data-arrears-view="overview"/)
  assert.match(html, /data-arrears-view="details"/)
  assert.match(html, /data-arrears-view="workbench"/)
  assert.match(js, /function setArrearsView/)
  assert.match(js, /sessionStorage\.getItem\('arrears-active-view'\)/)
})

test('revoked batches with deleted source archives never expose a restore action', () => {
  assert.match(js, /else if\(!batch\.archive_deleted_at\)/)
  assert.match(js, /原始密文已删除/)
  assert.doesNotMatch(js, /创建或恢复具备有效原始证据/)
})
