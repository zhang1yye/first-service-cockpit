import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const releaseJs = 'aph2-theme-20260809-remediation3.js'
const releaseCss = 'aph2-theme-20260809-remediation3.css'
const jsPath = path.join(site, releaseJs)
const cssPath = path.join(site, releaseCss)
const summaryRoute = fs.readFileSync(path.join(root, 'server/src/routes/summary.ts'), 'utf8')
const adminSource = fs.readFileSync(path.join(root, 'admin-web/src/App.jsx'), 'utf8')
const adminCss = fs.readFileSync(path.join(root, 'admin-web/src/styles.css'), 'utf8')

test('release selects new immutable remediation assets without overwriting progressive6', () => {
  assert.match(html, new RegExp(releaseJs.replaceAll('.', '\\.')))
  assert.match(html, new RegExp(releaseCss.replaceAll('.', '\\.')))
  assert.ok(fs.existsSync(jsPath))
  assert.ok(fs.existsSync(cssPath))
  assert.ok(fs.existsSync(path.join(site, 'aph2-theme-20260808-progressive6.js')))
  assert.ok(fs.existsSync(path.join(site, 'aph2-theme-20260808-progressive6.css')))
})

test('summary route consumes the shared collection publication instead of rereading raw files', () => {
  const datasetSource = fs.readFileSync(path.join(root, 'server/src/collection-dataset.ts'), 'utf8')
  assert.match(summaryRoute, /getFormalCollectionDataset/)
  assert.match(datasetSource, /buildCollectionPublication/)
  assert.doesNotMatch(summaryRoute, /function getLvzaiCollection/)
  for (const field of ['collectionBusinessDate', 'collectionLastValidatedAt', 'collectionMethodologyVersion', 'collectionPublicationStatus']) {
    assert.match(summaryRoute, new RegExp(field))
  }
})

test('blocked AI alerts render an unknown state, not four zero KPIs', () => {
  const source = fs.readFileSync(jsPath, 'utf8')
  assert.match(source, /function enhanceAiAlertsGateState/)
  assert.match(source, /function markMetricCardUnknown/)
  assert.match(source, /\.kpi-grid\.kpi-grid-5/)
  assert.match(source, /window\.__aphAlertsBlocked/)
  assert.match(source, /PROJECT_DATA_QUALITY_BLOCKED/)
  assert.match(source, /预警未生成/)
  assert.match(source, /暂不能形成经营风险判断/)
  assert.match(source, /aria-live/)
})

test('legacy source freshness layer remains available for the R6 in-flow relocation', () => {
  const source = fs.readFileSync(jsPath, 'utf8')
  assert.match(source, /panel\.className = 'aph-source-freshness'/)
  assert.match(source, /document\.body\.append\(panel\)/)
})

test('monthly report gate explains data truth and disables formal actions semantically', () => {
  const source = fs.readFileSync(jsPath, 'utf8')
  assert.match(source, /function enhanceAiReportGateState/)
  assert.match(source, /PROJECT_DATA_QUALITY_BLOCKED/)
  assert.match(source, /真实性门禁阻断/)
  assert.match(source, /button\.disabled = true/)
  assert.match(source, /aria-disabled/)
})

test('mobile navigation is bounded and secondary destinations move to an accessible drawer', () => {
  const source = fs.readFileSync(jsPath, 'utf8')
  const css = fs.readFileSync(cssPath, 'utf8')
  assert.match(source, /function enhanceMobilePrimaryNavigation/)
  assert.match(source, /经营工作台/)
  assert.match(source, /更多功能/)
  assert.match(source, /aria-expanded/)
  assert.match(source, /Escape/)
  assert.match(css, /@media\s*\(max-width:\s*640px\)/)
  assert.match(css, /\.aph-mobile-more-drawer/)
  assert.match(css, /min-height:\s*44px/)
})

test('filters publish shareable area/date/tab/q/sort state in the URL', () => {
  const source = fs.readFileSync(jsPath, 'utf8')
  assert.match(source, /function enhanceShareablePageState/)
  for (const key of ['area', 'date', 'tab', 'q', 'sort']) assert.match(source, new RegExp(`['"]${key}['"]`))
  assert.match(source, /history\.replaceState/)
})

test('every page has one business h1 and global accessibility baselines', () => {
  const source = fs.readFileSync(jsPath, 'utf8')
  const css = fs.readFileSync(cssPath, 'utf8')
  assert.match(source, /function ensureBusinessHeading/)
  assert.match(source, /data-aph-business-heading/)
  assert.match(source, /main\.querySelector\('\.aph-business-banner h1'\)/)
  assert.match(source, /target\.dataset\.aphBusinessHeading = 'true'/)
  assert.match(source, /markOnly\(preferredNative\)/)
  assert.match(css, /:focus-visible/)
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
  assert.match(css, /font-variant-numeric:\s*tabular-nums/)
})

test('source-native review keeps chart bundles out of default today mode', () => {
  const reviewHome = fs.readFileSync(path.join(root, 'review-system/active/frontend/src/views/HomeView.jsx'), 'utf8')
  const reviewVite = fs.readFileSync(path.join(root, 'review-system/active/frontend/vite.config.js'), 'utf8')
  const gatedCharts = reviewHome.match(/homeMode === 'ops' && canViewLogs/g) || []
  assert.ok(gatedCharts.length >= 2)
  assert.match(reviewVite, /base:\s*['"]\/review-system\/['"]/)
  assert.match(reviewHome, /const TrendAreaChart = lazy/)
  assert.match(reviewHome, /const ProfessionalPieChart = lazy/)
})

test('system management uses the source-built standalone admin and meets mobile/a11y rules', () => {
  assert.match(fs.readFileSync(jsPath, 'utf8'), /\/admin\//)
  assert.match(adminSource, /<h1>\{title\}<\/h1>/)
  assert.doesNotMatch(adminCss, /fonts\.googleapis\.com/)
  assert.match(adminCss, /:focus-visible/)
  assert.match(adminCss, /prefers-reduced-motion:\s*reduce/)
  assert.match(adminCss, /min-height:\s*44px/)
})
