import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const source = fs.readFileSync(path.join(root, 'admin-web', 'src', 'App.jsx'), 'utf8')
const css = fs.readFileSync(path.join(root, 'admin-web', 'src', 'aph-admin.css'), 'utf8')
const main = fs.readFileSync(path.join(root, 'admin-web', 'src', 'main.jsx'), 'utf8')

test('R27后台管理使用APH品牌顶栏、页签和真实图标资产', () => {
  assert.match(main, /aph-admin\.css/)
  assert.match(source, /className="aph-admin-header"/)
  assert.match(source, /aph-brand-lockup\.jpg/)
  assert.match(source, /aph-tab-prev\.jpg/)
  assert.match(source, /\/aph-icons\/jurassic_users\.png/)
})

test('R27后台管理导航沿用APH 60到140覆盖展开规则', () => {
  assert.match(css, /--aph-topbar:\s*50px/)
  assert.match(css, /--aph-tabs:\s*46px/)
  assert.match(css, /--aph-rail:\s*60px/)
  assert.match(css, /aside\.is-expanded[^{]*\{[^}]*width:\s*140px/is)
  assert.match(css, /aside\.is-expanded\s*~\s*\.workspace\s+\.topbar[^{]*\{[^}]*left:\s*140px/is)
  assert.match(css, /\.workspace\s*\{[^}]*padding:\s*0\s+0\s+0\s+var\(--aph-rail\)/is)
})

test('R27后台内容回归驾驶舱浅色工作区和第一服务红色体系', () => {
  assert.match(css, /--bg:\s*#f4f5f8/)
  assert.match(css, /--cyan:\s*#cf001b/)
  assert.match(css, /\.card\s*\{[^}]*background:\s*#ffffff/is)
  assert.match(css, /th\s*\{[^}]*background:\s*#0e1b2c/is)
  assert.match(css, /@media\s*\(max-width:\s*850px\)/)
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
})
