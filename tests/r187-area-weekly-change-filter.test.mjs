import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = 'cockpit-r187-area-weekly-change-filter-20260901-v1'
const payload = path.join(root, 'production-overlays', release, 'payload')
const assetRoot = path.join(payload, 'assets', release)
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'config/production-runtime-r127.json'), 'utf8'))
const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')
const bootstrap = fs.readFileSync(path.join(payload, 'releases', release, 'aph2-r187-area-weekly-change-filter-20260901-v1.js'), 'utf8')
const dashboard = fs.readFileSync(path.join(assetRoot, 'chunk-C5JXPXJ4.js'), 'utf8')
const payment = fs.readFileSync(path.join(assetRoot, 'chunk-5G47Z27Q.js'), 'utf8')
const collection = fs.readFileSync(path.join(assetRoot, 'chunk-D3P3MDJ2.js'), 'utf8')
const compatibility = fs.readFileSync(path.join(payload, 'assets/cockpit-bundle-head-r173-20260831.js'), 'utf8')
const mobileCss = fs.readFileSync(path.join(payload, 'aph2-r186-mobile-experience-remediation-20260901-v1.css'), 'utf8')

test('R187继续保留片区执行排名到回款额执行评估的联动', () => {
  assert.equal(runtime.release, release)
  assert.equal(runtime.frontend.overlayPayload, `production-overlays/${release}/payload`)
  assert.match(index, new RegExp(`modulepreload[^>]+assets/${release}/app-G7HUEEER\\.js`))
  assert.match(index, new RegExp(`type="module"[^>]+releases/${release}/aph2-r187-area-weekly-change-filter-20260901-v1\\.js`))
  assert.match(bootstrap, new RegExp(`import\\('/assets/${release}/app-G7HUEEER\\.js'\\)`))

  const rankingStart = dashboard.indexOf('children: "\\u7247\\u533A\\u6267\\u884C\\u6392\\u540D"')
  const rankingEnd = dashboard.indexOf('children: "\\u6682\\u65E0\\u7247\\u533A\\u6267\\u884C\\u6570\\u636E', rankingStart)
  assert.ok(rankingStart >= 0 && rankingEnd > rankingStart)
  const rankingModule = dashboard.slice(rankingStart, rankingEnd)
  assert.match(rankingModule, /href: `\/payment\?area=\$\{encodeURIComponent\(t\.area\)\}`/)
  assert.doesNotMatch(rankingModule, /\/projects\?area=/)
  assert.match(payment, /new URLSearchParams\(window\.location\.search\)\.get\("area"\)/)
})

test('R187片区筛选后按正式中心收缴率加权显示片区综合收缴率', () => {
  assert.match(collection, /m2 = hl\.useMemo\(\(\) => o2 === "\\u5168\\u90E8" \? e3 : e3\.filter\(\(c3\) => c3\.area === o2\)/)
  assert.match(collection, /weighted: c3\.weighted \+ \(Number\.isFinite\(v\.receivable\) && Number\.isFinite\(v\.rate\) \? v\.receivable \* v\.rate : 0\)/)
  assert.match(collection, /x2 = h\.receivable > 0 \? h\.weighted \/ h\.receivable : Number\.NaN/)
  assert.doesNotMatch(collection, /x2 = h\.receivable > 0 \? h\.received \/ h\.receivable/)
  assert.match(collection, /o2 === "\\u5168\\u90E8" \? "\\u534E\\u5317\\u7EFC\\u5408\\u6536\\u7F34\\u7387" : `\$\{o2\}\\u7EFC\\u5408\\u6536\\u7F34\\u7387`/)
  assert.match(collection, /o2 === "\\u5168\\u90E8" \? "\\u534E\\u5317\\u5408\\u8BA1" : `\$\{o2\}\\u5408\\u8BA1`/)

  const summaryFunctionStart = compatibility.indexOf('function applyLvzaiSummaryToDom')
  const collectionBranchStart = compatibility.indexOf("if (pathname === '/collection') {", summaryFunctionStart)
  const collectionBranchEnd = compatibility.indexOf('\n    const summary = window.__aphLvzaiSummary', collectionBranchStart)
  assert.ok(collectionBranchStart >= 0 && collectionBranchEnd > collectionBranchStart)
  const collectionBranch = compatibility.slice(collectionBranchStart, collectionBranchEnd)
  assert.match(collectionBranch, /official-center-rate-weighted-by-area/)
  assert.doesNotMatch(collectionBranch, /replaceLiveMetricValue|applyCollectionFooterSummary|__aphLvzaiSummary/)
})

test('R187片区标题变化后经营概览仍可定位明细卡片', () => {
  const disclosureStart = compatibility.indexOf('function enhanceCollectionDisclosure')
  const disclosureEnd = compatibility.indexOf('\n  function enhanceReviewWorkbenchDisclosure', disclosureStart)
  assert.ok(disclosureStart >= 0 && disclosureEnd > disclosureStart)
  const disclosure = compatibility.slice(disclosureStart, disclosureEnd)
  assert.match(disclosure, /exactTextElements\(main, '华北各片区收缴明细'\)\[0\]/)
  assert.match(disclosure, /Array\.from\(main\.querySelectorAll\('h3'\)\)\.find/)
  assert.match(disclosure, /\/收缴明细\$\/\.test/)
  assert.match(disclosure, /trend\.hidden = view === 'details'/)
  assert.match(disclosure, /details\.hidden = view !== 'details'/)
})

test('R187使用稳定属性控制收缴视图，不再依赖动态片区标题', () => {
  assert.match(collection, /"data-collection-overview": "true"/)
  assert.match(collection, /"data-collection-details": "true"/)
  assert.match(compatibility, /main\.querySelector\('\[data-collection-overview="true"\]'\)/)
  assert.match(compatibility, /main\.querySelector\('\[data-collection-details="true"\]'\)/)
})

test('R187移动端高频导航直接提供驾驶舱、回款和收缴', () => {
  assert.match(compatibility, /const primary = \[\s*\{ href: '\/', label: '驾驶舱' \},\s*\{ href: '\/payment', label: '回款' \},\s*\{ href: '\/collection', label: '收缴' \}/)
  assert.match(compatibility, /\['\/command', '五书评估'\], \['\/projects', '项目档案'\]/)
})

test('R187回款移动卡显示核心执行指标且桌面表格继续保留', () => {
  assert.match(payment, /className: "aph-mobile-payment-cards"/)
  assert.match(payment, /className: "aph-mobile-payment-card"/)
  assert.match(payment, /children: "\\u7D2F\\u8BA1\\u6267\\u884C"/)
  assert.match(payment, /children: "\\u7D2F\\u8BA1\\u5B8C\\u6210\\u7387"/)
  assert.match(payment, /children: "\\u9884\\u7B97\\u5DEE\\u989D"/)
  assert.match(payment, /aph-payment-desktop-table/)
  assert.match(mobileCss, /aph-payment-desktop-table\{display:none!important\}/)
  assert.match(mobileCss, /aph-mobile-payment-cards\{display:grid/)
})

test('R187压缩移动KPI并统一欠费上传触控标准', () => {
  assert.match(index, /viewport-fit=cover/)
  assert.match(index, /aph2-r186-mobile-experience-remediation-20260901-v1\.css/)
  assert.match(mobileCss, /\.kpi-grid-5\{display:grid!important;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)!important/)
  assert.match(mobileCss, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)!important/)
  assert.match(mobileCss, /input\[type="file"\]\{min-height:44px!important;font-size:16px!important/)
  assert.match(mobileCss, /\.arrears-command__file small,.arrears-command__file-title i\{font-size:12px!important/)
})

test('R187较上一发布周跟随当前片区且缺失数据不回退华北汇总', () => {
  assert.match(collection, /trendSeriesKey = o2 === "\\u5168\\u90E8" \? "\\u534E\\u5317\\u6C47\\u603B" : o2/)
  assert.match(collection, /i2\[i2\.length - 1\]\[trendSeriesKey\]/)
  assert.match(collection, /i2\[i2\.length - 2\]\[trendSeriesKey\]/)
  assert.match(collection, /i2\.length > 1 && r\(g\) && r\(b\) \? g - b : Number\.NaN/)
  assert.doesNotMatch(collection, /i2\[i2\.length - [12]\]\.\\u534E\\u5317\\u6C47\\u603B/)

  const previous = { 华北汇总: 0.6485356703197811, 朝阳片区: 0.6284506812923812, 河北片区: 0.5905993966352906 }
  const current = { 华北汇总: 0.6490315083944701, 朝阳片区: 0.6286494865044543, 河北片区: 0.5916711145129441 }
  const delta = key => ((current[key] - previous[key]) * 100).toFixed(2)
  assert.equal(delta('华北汇总'), '0.05')
  assert.equal(delta('朝阳片区'), '0.02')
  assert.equal(delta('河北片区'), '0.11')
})

test('片区加权口径样本不会退化为实收除以应收或华北总值', () => {
  const rows = [
    { area: '朝阳片区', receivable: 100, received: 50, rate: 0.8 },
    { area: '朝阳片区', receivable: 300, received: 240, rate: 0.9 },
    { area: '海淀片区', receivable: 600, received: 300, rate: 0.6 },
  ]
  const selected = rows.filter(row => row.area === '朝阳片区')
  const weightedRate = selected.reduce((sum, row) => sum + row.receivable * row.rate, 0)
    / selected.reduce((sum, row) => sum + row.receivable, 0)
  const receivedRate = selected.reduce((sum, row) => sum + row.received, 0)
    / selected.reduce((sum, row) => sum + row.receivable, 0)
  const regionalRate = rows.reduce((sum, row) => sum + row.receivable * row.rate, 0)
    / rows.reduce((sum, row) => sum + row.receivable, 0)

  assert.equal(weightedRate, 0.875)
  assert.equal(receivedRate, 0.725)
  assert.equal(regionalRate, 0.71)
  assert.notEqual(weightedRate, receivedRate)
  assert.notEqual(weightedRate, regionalRate)
})
