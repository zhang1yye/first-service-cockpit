import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE = path.join(ROOT, 'release-candidates/cockpit-r54-home-map-label-20260812-224959')
const INDEX = path.join(RELEASE, 'payload/index.html')
const JS = path.join(RELEASE, 'payload/aph2-r50-home-map-label-20260812-v1.js')
const CSS = path.join(RELEASE, 'payload/aph2-r50-home-map-label-20260812-v1.css')

test('R54 从当前生产 R53 入口追加地图标注资源', () => {
  const html = fs.readFileSync(INDEX, 'utf8')
  assert.equal(html.split('/aph2-r50-home-map-label-20260812-v1.js?v=r50-map1').length - 1, 1)
  assert.equal(html.split('/aph2-r50-home-map-label-20260812-v1.css?v=r50-map1').length - 1, 1)
  assert.match(html, /aph2-r50-ai-usability-20260812-v1\.js\?v=r50-ai1/)
  assert.match(html, /aph2-r49-year-placement-20260812-v1\.css\?v=r49-year1/)
  assert.doesNotMatch(html, /aph2-r52-app-bootstrap/)
})

test('R54 保留原北京交互分组并仅克隆视觉标注', () => {
  const source = fs.readFileSync(JS, 'utf8')
  assert.match(source, /directRegionName\(group\) === '北京'/)
  assert.match(source, /\['line', 'text'\]\.includes/)
  assert.match(source, /cloneNode\(true\)/)
  assert.match(source, /setAttribute\('aria-hidden', 'true'\)/)
  assert.match(source, /setAttribute\('focusable', 'false'\)/)
  assert.match(source, /setAttribute\('pointer-events', 'none'\)/)
  assert.doesNotMatch(source, /map\.append\(beijingGroup\)/)
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|\/api\//)
})

test('R54 样式仅作用于首页地图标签', () => {
  const css = fs.readFileSync(CSS, 'utf8')
  assert.match(css, /body\[data-r42-route="home"\]/)
  assert.match(css, /paint-order:\s*stroke fill !important/)
  assert.match(css, /stroke:\s*rgba\(245, 246, 250, \.96\) !important/)
  assert.doesNotMatch(css, /data-r42-route="(?:daily|payment|collection)"/)
})

test('R54 候选只包含入口与两个新增资产', () => {
  assert.deepEqual(
    fs.readdirSync(path.join(RELEASE, 'payload')).sort(),
    [
      'aph2-r50-home-map-label-20260812-v1.css',
      'aph2-r50-home-map-label-20260812-v1.js',
      'index.html',
    ],
  )
})
