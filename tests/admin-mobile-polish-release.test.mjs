import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'admin/index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'admin/aph2-admin-mobile-polish-20260812-v1.css'), 'utf8')

test('独立后台加载移动端可读性修复', () => {
  assert.match(html, /aph2-admin-mobile-polish-20260812-v1\.css\?v=mobile-readable1/)
  assert.match(css, /@media \(max-width: 580px\)/)
})

test('后台窄屏指标改为单列并防止日期断行', () => {
  assert.match(css, /metric-grid\.six[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/)
  assert.match(css, /white-space:\s*nowrap/)
  assert.match(css, /font-size:\s*12px/)
})
