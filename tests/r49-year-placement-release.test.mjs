import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE = path.join(
  ROOT,
  'release-candidates/cockpit-r49-year-placement-20260812-221148',
)
const INDEX = path.join(RELEASE, 'payload/index.html')
const CSS = path.join(RELEASE, 'payload/aph2-r49-year-placement-20260812-v1.css')

test('R49 候选按 R48 干净基线追加年度位置样式', () => {
  const html = fs.readFileSync(INDEX, 'utf8')
  const r48 = '/aph2-r48-home-banner-20260812-v1.css?v=r48-banner1'
  const r49 = '/aph2-r49-year-placement-20260812-v1.css?v=r49-year1'

  assert.equal(html.split(r49).length - 1, 1)
  assert.ok(html.indexOf(r48) >= 0)
  assert.ok(html.indexOf(r49) > html.indexOf(r48))
  assert.doesNotMatch(html, /aph2-r45-cloud-remediation/)
})

test('R49 仅在首页将 2026 放入副标题后的内容流', () => {
  const css = fs.readFileSync(CSS, 'utf8')

  assert.match(css, /body\[data-r42-route="home"\] \.aph-business-banner::before\s*\{[\s\S]*?content:\s*none !important;/)
  assert.match(css, /\.aph-banner-copy::after\s*\{[\s\S]*?content:\s*"2026";/)
  assert.match(css, /margin-top:\s*7px;/)
  assert.match(css, /font-size:\s*60px;/)
  assert.match(css, /min-width:\s*641px\) and \(max-width:\s*1023px/)
  assert.match(css, /min-height:\s*190px !important;/)
  assert.match(css, /max-width:\s*640px/)
  assert.match(css, /min-height:\s*150px !important;/)
  assert.doesNotMatch(css, /data-r42-route="(?:daily|payment|collection)"/)
})

test('R49 候选负载只含索引与单一新增样式资产', () => {
  assert.deepEqual(
    fs.readdirSync(path.join(RELEASE, 'payload')).sort(),
    ['aph2-r49-year-placement-20260812-v1.css', 'index.html'],
  )
})
