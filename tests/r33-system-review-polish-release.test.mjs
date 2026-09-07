import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const index = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r33-system-review-polish-20260812-v1.css'), 'utf8')
const js = fs.readFileSync(path.join(site, 'aph2-r33-system-review-polish-20260812-v1.js'), 'utf8')

test('R33 只作用于系统、审核和登录目标路由', () => {
  assert.match(index, /aph2-r33-system-review-polish-20260812-v1\.css\?v=r33-polish2/)
  assert.match(index, /aph2-r33-system-review-polish-20260812-v1\.js\?v=r33-polish2/)
  assert.match(js, /new Set\(\['\/system', '\/admin', '\/review', '\/login'\]\)/)
  assert.doesNotMatch(js, /['"]\/(?:daily|payment|collection)['"]/)
})

test('全站壳层标题不再与正文主标题形成双H1', () => {
  assert.match(js, /document\.querySelectorAll\(['"]header h1['"]\)/)
  assert.match(js, /document\.createElement\(['"]div['"]\)/)
  assert.match(js, /aphShellTitle/)
  assert.match(css, /aph-mobile-nav-ready[\s\S]*top-\\\[72px\\\][\s\S]*display:\s*none\s*!important/)
})

test('项目密度和工作台责任入口保持可读且不触碰已验收页面', () => {
  assert.match(css, /aph-r24-projects[\s\S]*font-size:\s*12px\s*!important/)
  assert.match(css, /aph-r24-command a\[href\^="\/admin"\]/)
  assert.match(css, /查看未闭环事项、责任人与截止日期/)
  assert.doesNotMatch(css, /aph-(?:daily|payment|collection)/)
})

test('系统管理去除装饰眉题和编号并压缩入口卡', () => {
  assert.match(css, /aph-system-eyebrow[\s\S]*aph-system-entry-head[\s\S]*display:\s*none/)
  assert.match(css, /aph-system-entry\s*\{[\s\S]*min-height:\s*260px/)
  assert.match(css, /border-radius:\s*14px/)
})

test('研发审核默认隐藏运维侧栏并提供完整页签键盘操作', () => {
  assert.match(css, /data-review-workbench-mode="today"[^}]*\.review-workbench-aside[\s\S]*display:\s*none/)
  assert.match(js, /ArrowLeft/)
  assert.match(js, /ArrowRight/)
  assert.match(js, /Home/)
  assert.match(js, /End/)
})

test('登录页提供密码显隐和账号恢复提示', () => {
  assert.match(js, /aph-r33-password-toggle/)
  assert.match(js, /显示登录密码/)
  assert.match(js, /联系系统管理员/)
  assert.match(css, /text-muted-foreground[\s\S]*#606a76/)
  assert.match(css, /main img\[alt="第一服务"\]/)
  assert.match(css, /APH 2\.0  ·  第一服务华北地区经营驾驶舱/)
})

test('目标路由侧栏展开不再改变60px内容轨道', () => {
  assert.match(css, /aph-exact-sidebar\.is-expanded[\s\S]*flex:\s*0 0 60px\s*!important/)
  assert.match(css, /aph-page-tabs[\s\S]*left:\s*60px\s*!important/)
})
