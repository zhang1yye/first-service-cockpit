import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE = path.join(ROOT, 'release-candidates/cockpit-r52-home-map-label-20260812-224307')
const INDEX = path.join(RELEASE, 'payload/index.html')
const JS = path.join(RELEASE, 'payload/aph2-r50-home-map-label-20260812-v1.js')
const CSS = path.join(RELEASE, 'payload/aph2-r50-home-map-label-20260812-v1.css')

test('R52 从当前 R51 云端入口追加地图标注资源', () => {
  const html = fs.readFileSync(INDEX, 'utf8')
  const script = '/aph2-r50-home-map-label-20260812-v1.js?v=r50-map1'
  const style = '/aph2-r50-home-map-label-20260812-v1.css?v=r50-map1'

  assert.equal(html.split(script).length - 1, 1)
  assert.equal(html.split(style).length - 1, 1)
  assert.match(html, /aph2-r45-cloud-remediation-20260812-v1\.js\?v=r45-cloudfix1/)
  assert.match(html, /aph2-r47-project-accessibility-20260812-v1\.css\?v=r47-project-a11y1/)
  assert.match(html, /aph2-r49-year-placement-20260812-v1\.css\?v=r49-year1/)
})

test('R52 仅克隆北京标注，不搬动原交互分组', () => {
  const source = fs.readFileSync(JS, 'utf8')

  assert.match(source, /directRegionName\(group\) === '北京'/)
  assert.match(source, /\['line', 'text'\]\.includes/)
  assert.match(source, /cloneNode\(true\)/)
  assert.match(source, /data-r50-map-label-overlay/)
  assert.match(source, /setAttribute\('aria-hidden', 'true'\)/)
  assert.match(source, /setAttribute\('focusable', 'false'\)/)
  assert.match(source, /setAttribute\('pointer-events', 'none'\)/)
  assert.doesNotMatch(source, /map\.append\(beijingGroup\)/)
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|\/api\//)
})

test('R52 样式只增强首页地图标签可读性', () => {
  const css = fs.readFileSync(CSS, 'utf8')

  assert.match(css, /body\[data-r42-route="home"\]/)
  assert.match(css, /paint-order:\s*stroke fill !important/)
  assert.match(css, /stroke:\s*rgba\(245, 246, 250, \.96\) !important/)
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
  assert.doesNotMatch(css, /data-r42-route="(?:daily|payment|collection)"/)
})

test('R52 候选负载只有入口和两个新增资产', () => {
  assert.deepEqual(
    fs.readdirSync(path.join(RELEASE, 'payload')).sort(),
    [
      'aph2-r50-home-map-label-20260812-v1.css',
      'aph2-r50-home-map-label-20260812-v1.js',
      'index.html',
    ],
  )
})
