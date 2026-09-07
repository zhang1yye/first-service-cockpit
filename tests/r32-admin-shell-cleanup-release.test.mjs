import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const html = fs.readFileSync(path.join(root, 'firstcare-cloud-local', 'index.html'), 'utf8')
const shell = fs.readFileSync(
  path.join(root, 'firstcare-cloud-local', 'aph2-theme-20260808-progressive6.js'),
  'utf8',
)
const css = fs.readFileSync(
  path.join(root, 'firstcare-cloud-local', 'aph2-r32-admin-shell-cleanup-20260812-v1.css'),
  'utf8',
)

test('R32 后台页使用 APH 顶栏并隐藏旧返回与数据管理标题', () => {
  assert.match(shell, /classList\.toggle\('aph-admin-shell-header', path === '\/admin'\)/)
  assert.match(css, /header\.aph-admin-shell-header[\s\S]*>\s*:is\(a, span\)[\s\S]*display:\s*none\s*!important/is)
  assert.match(css, /header\.aph-admin-shell-header[\s\S]*\.aph-header-menu[\s\S]*left:\s*140px\s*!important/is)
})

test('R50 系统管理与后台管理统一使用后台页签身份', () => {
  assert.match(shell, /\['\/system',\s*'\/admin'\]/)
  assert.match(shell, /\['\/admin\/',\s*'\/admin'\]/)
  assert.match(shell, /pathname === '\/admin' \|\| pathname === '\/system'\) return '\/admin'/)
  assert.match(shell, /function dedupeOpenTabs\(items\)/)
})

test('后台壳层使用 R50 直达缓存版本并保留 R32 样式', () => {
  assert.match(html, /aph2-theme-20260808-progressive6\.js\?v=r50-admin-direct1/)
  assert.match(html, /aph2-r32-admin-shell-cleanup-20260812-v1\.css\?v=r32-admin-shell1/)
})
