import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = 'cockpit-r183-area-ranking-payment-navigation-20260901-v1'
const payload = path.join(root, 'production-overlays', release, 'payload')
const assetRoot = path.join(payload, 'assets', release)
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'config/production-runtime-r127.json'), 'utf8'))
const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')
const bootstrap = fs.readFileSync(path.join(payload, 'releases', release, `aph2-${release.slice('cockpit-'.length)}.js`), 'utf8')
const dashboard = fs.readFileSync(path.join(assetRoot, 'chunk-C5JXPXJ4.js'), 'utf8')
const payment = fs.readFileSync(path.join(assetRoot, 'chunk-5G47Z27Q.js'), 'utf8')

test('R183片区执行排名进入回款额执行评估并保留对应片区筛选', () => {
  assert.equal(runtime.release, release)
  assert.equal(runtime.frontend.overlayPayload, `production-overlays/${release}/payload`)
  assert.match(index, new RegExp(`modulepreload[^>]+assets/${release}/app-G7HUEEER\\.js`))
  assert.match(index, new RegExp(`type="module"[^>]+releases/${release}/aph2-r183-area-ranking-payment-navigation-20260901-v1\\.js`))
  assert.match(bootstrap, new RegExp(`import\\('/assets/${release}/app-G7HUEEER\\.js'\\)`))

  const rankingStart = dashboard.indexOf('children: "\\u7247\\u533A\\u6267\\u884C\\u6392\\u540D"')
  const rankingEnd = dashboard.indexOf('children: "\\u6682\\u65E0\\u7247\\u533A\\u6267\\u884C\\u6570\\u636E', rankingStart)
  assert.ok(rankingStart >= 0 && rankingEnd > rankingStart, '应定位到片区执行排名模块')
  const rankingModule = dashboard.slice(rankingStart, rankingEnd)
  assert.match(rankingModule, /href: `\/payment\?area=\$\{encodeURIComponent\(t\.area\)\}`/)
  assert.doesNotMatch(rankingModule, /\/projects\?area=/)
  assert.match(rankingModule, /return \$\.jsxs\("a"/)

  assert.match(payment, /new URLSearchParams\(window\.location\.search\)\.get\("area"\)/)
  assert.match(payment, /h\.filter\(\(c3\) => c3\.area === d\)/)
})
