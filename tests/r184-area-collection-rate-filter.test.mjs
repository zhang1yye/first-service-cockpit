import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = 'cockpit-r184-area-collection-rate-filter-20260901-v1'
const payload = path.join(root, 'production-overlays', release, 'payload')
const assetRoot = path.join(payload, 'assets', release)
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'config/production-runtime-r127.json'), 'utf8'))
const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')
const bootstrap = fs.readFileSync(path.join(payload, 'releases', release, 'aph2-r184-area-collection-rate-filter-20260901-v1.js'), 'utf8')
const dashboard = fs.readFileSync(path.join(assetRoot, 'chunk-C5JXPXJ4.js'), 'utf8')
const payment = fs.readFileSync(path.join(assetRoot, 'chunk-5G47Z27Q.js'), 'utf8')
const collection = fs.readFileSync(path.join(assetRoot, 'chunk-D3P3MDJ2.js'), 'utf8')
const compatibility = fs.readFileSync(path.join(payload, 'assets/cockpit-bundle-head-r173-20260831.js'), 'utf8')

test('R184继续保留片区执行排名到回款额执行评估的联动', () => {
  assert.equal(runtime.release, release)
  assert.equal(runtime.frontend.overlayPayload, `production-overlays/${release}/payload`)
  assert.match(index, new RegExp(`modulepreload[^>]+assets/${release}/app-G7HUEEER\\.js`))
  assert.match(index, new RegExp(`type="module"[^>]+releases/${release}/aph2-r184-area-collection-rate-filter-20260901-v1\\.js`))
  assert.match(bootstrap, new RegExp(`import\\('/assets/${release}/app-G7HUEEER\\.js'\\)`))

  const rankingStart = dashboard.indexOf('children: "\\u7247\\u533A\\u6267\\u884C\\u6392\\u540D"')
  const rankingEnd = dashboard.indexOf('children: "\\u6682\\u65E0\\u7247\\u533A\\u6267\\u884C\\u6570\\u636E', rankingStart)
  assert.ok(rankingStart >= 0 && rankingEnd > rankingStart)
  const rankingModule = dashboard.slice(rankingStart, rankingEnd)
  assert.match(rankingModule, /href: `\/payment\?area=\$\{encodeURIComponent\(t\.area\)\}`/)
  assert.doesNotMatch(rankingModule, /\/projects\?area=/)
  assert.match(payment, /new URLSearchParams\(window\.location\.search\)\.get\("area"\)/)
})

test('R184片区筛选后按正式中心收缴率加权显示片区综合收缴率', () => {
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
