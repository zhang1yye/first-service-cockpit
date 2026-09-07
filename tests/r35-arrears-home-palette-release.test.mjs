import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local', 'arrears')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'arrears-home-palette-20260812-v1.css'), 'utf8')
const shell = fs.readFileSync(path.join(root, 'firstcare-cloud-local', 'aph2-r52-app-bootstrap-20260812-v1.js'), 'utf8')

test('欠费经营页加载独立的首页同色主题层', () => {
  assert.match(html, /arrears-home-palette-20260812-v1\.css\?v=r35-home-palette1/)
  assert.match(shell, /\/arrears\/index\.html\?embedded=1&v=r45-cloudfix1/)
})

test('欠费经营页复用首页品牌红、浅灰画布、深灰文字和白色面板', () => {
  assert.match(css, /--arrears-home-brand:\s*#e60012/)
  assert.match(css, /--arrears-home-accent:\s*#d14f5a/)
  assert.match(css, /--arrears-home-canvas:\s*#f3f4f7/)
  assert.match(css, /--arrears-home-panel:\s*#ffffff/)
  assert.match(css, /--arrears-home-ink:\s*#303743/)
})

test('选中态、状态卡和空状态遵循首页用色逻辑', () => {
  assert.match(css, /button\[aria-selected="true"\][\s\S]*background:\s*var\(--arrears-home-brand\)/)
  assert.match(css, /\.overview-empty[\s\S]*background:\s*var\(--arrears-home-panel\)/)
  assert.match(css, /\.metrics article\.metric-primary[\s\S]*#fffafb/)
  assert.doesNotMatch(css, /repeating-linear-gradient/)
})

test('颜色主题不修改欠费业务脚本或驾驶舱已验收页面', () => {
  assert.doesNotMatch(css, /daily|payment|collection/)
  assert.doesNotMatch(css, /api\/arrears|metricAmount\s*=/)
})
