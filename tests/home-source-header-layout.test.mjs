import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const script = fs.readFileSync(path.join(site, 'aph2-home-source-header-20260810-v1.js'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-home-source-header-20260810-v1.css'), 'utf8')

test('首页将现有数据源状态压缩进黑色顶栏', () => {
  assert.match(html, /aph2-home-source-header-20260810-v1\.js/)
  assert.match(html, /aph2-home-source-header-20260810-v1\.css/)
  assert.match(script, /body > \.aph-source-freshness/)
  assert.match(script, /\.aph-header-status/)
  assert.match(script, /经营数据分源更新/)
  assert.match(css, /r7-header-freshness-title/)
  assert.match(script, /window\.location\.pathname !== '\/'/)
  assert.match(script, /aria-label/)
})

test('首页原状态卡和占位槽被移除，正文不再显示数据更新状态块', () => {
  assert.match(css, /aph-home-source-header > \.aph-source-freshness/)
  assert.match(css, /\.r6-source-freshness-slot/)
  assert.match(css, /aph-home-source-header\.aph-source-freshness-visible/)
  assert.match(css, /\.aph-home-region-grid \{ grid-row: 4 !important; \}/)
  assert.match(css, /\.aph-home-ranking-grid \{ grid-row: 5 !important; \}/)
})
