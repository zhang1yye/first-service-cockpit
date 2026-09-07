import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const overlayName = 'aph2-theme-20260808-progressive6.js'
const cssName = 'aph2-theme-20260808-progressive6.css'
const overlayPath = path.join(site, overlayName)
const cssPath = path.join(site, cssName)
const adminHtml = fs.readFileSync(path.join(site, 'admin', 'index.html'), 'utf8')
const adminBundleName = adminHtml.match(/src="\/admin\/assets\/([^"]+\.js)"/)?.[1]
const adminBundle = fs.readFileSync(path.join(site, 'admin', 'assets', adminBundleName), 'utf8')

test('active cockpit selects immutable progressive disclosure assets', () => {
  assert.match(html, new RegExp(overlayName.replaceAll('.', '\\.')))
  assert.match(html, new RegExp(cssName.replaceAll('.', '\\.')))
  assert.ok(fs.existsSync(overlayPath))
  assert.ok(fs.existsSync(cssPath))
})

test('collection separates operating overview and project details and collapses unavailable history', () => {
  const source = fs.readFileSync(overlayPath, 'utf8')
  assert.match(source, /function enhanceCollectionDisclosure/)
  assert.match(source, /经营概览/)
  assert.match(source, /项目明细/)
  assert.match(source, /真实月度历史流水尚未接入/)
  assert.match(source, /function enhanceServiceCenterDetailScrolling/)
})

test('all service-center detail pages use full-row scrolling and preserve drill-down', () => {
  const source = fs.readFileSync(overlayPath, 'utf8')
  for (const route of ['/projects', '/payment', '/daily', '/collection']) {
    assert.match(source, new RegExp(route.replace('/', '\\/')))
  }
  assert.match(source, /aph-service-center-scroll/)
  assert.match(source, /row\.hidden = false/)
  assert.doesNotMatch(source, /const projectPageSize = 15/)
  assert.doesNotMatch(source, /const collectionPageSize = 15/)
  assert.doesNotMatch(source, /setProperty\('max-height', 'none'/)
  assert.match(source, /openProjectProfileDetail/)
})

test('admin defaults to an isolated overview and separates high-risk domains', () => {
  assert.match(adminHtml, /管理后台/)
  for (const label of ['管理总览', '真实性中心', '数据源与同步', '项目映射', '规则与口径', '用户与权限', '操作审计', '灾备与恢复', '归档与输出']) {
    assert.match(adminBundle, new RegExp(label))
  }
})

test('blocked monthly report renders truthful unavailable state and disables formal actions', () => {
  const source = fs.readFileSync(overlayPath, 'utf8')
  assert.match(source, /function enhanceAiReportGateState/)
  assert.match(source, /暂无可生成经营月报的有效项目事实/)
  assert.match(source, /window\.__aphMonthlyReportBlocked/)
  assert.match(source, /归档当前月报/)
  assert.match(source, /导出Word正式月报/)
  assert.match(source, /errorElement\.textContent = '暂无可生成经营月报的有效项目事实'/)
  assert.match(source, /textNode\.nodeValue\.replaceAll/)
})

test('business-facing overlay replaces the legacy internal batch term', () => {
  const source = fs.readFileSync(overlayPath, 'utf8')
  assert.match(source, /function replaceLegacyBatchTerminology/)
  assert.match(source, /正式数据发布门禁/)
})

test('production review workbench progressively discloses operations without removing permissions', () => {
  const source = fs.readFileSync(overlayPath, 'utf8')
  const css = fs.readFileSync(cssPath, 'utf8')
  assert.match(source, /function enhanceReviewWorkbenchDisclosure/)
  assert.match(source, /\.review-workbench-shell/)
  assert.match(source, /今日审核/)
  assert.match(source, /运行与安全/)
  assert.match(source, /data-review-workbench-mode/)
  assert.match(source, /exactTextElements\(main, label\)/)
  assert.match(css, /\[data-review-workbench-section="operations"\]\[hidden\]\{display:none!important\}/)
  assert.doesNotMatch(source, /review-workbench-main\s*>\s*:nth-child/)
})
