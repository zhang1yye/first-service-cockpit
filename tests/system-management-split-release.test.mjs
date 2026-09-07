import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const hub = fs.readFileSync(path.join(site, 'system', 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'system', 'system-management-20260811-v2.css'), 'utf8')
const nav = fs.readFileSync(path.join(site, 'aph2-r26-shell-consistency-20260811-v1.js'), 'utf8')
const index = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const admin = fs.readFileSync(path.join(site, 'admin', 'index.html'), 'utf8')

test('系统管理提供使用界面和后台管理的独立入口', () => {
  assert.match(hub, /使用界面/)
  assert.match(hub, /后台管理界面/)
  assert.match(hub, /href="\/"/)
  assert.match(hub, /href="\/admin"/)
  assert.match(hub, /href="\/ai-alerts"/)
  assert.match(hub, /href="\/ai-report"/)
  assert.doesNotMatch(hub, /href="\/(?:alerts|report)"/)
})

test('系统管理两张入口卡整体可点击并在标题区显示进入提示', () => {
  assert.match(hub, /<a class="entry-card usage-card" href="\/"/)
  assert.match(hub, /<a class="entry-card admin-card" href="\/admin"/)
  assert.match(hub, /class="entry-inline-action">进入/)
  assert.match(hub, /system-management-20260811-v4\.css/)
  assert.doesNotMatch(hub, /<a class="entry-action/)
})

test('系统管理中心沿用APH黑色顶栏、左侧导航和红色激活态', () => {
  assert.match(css, /background:\s*#050505/)
  assert.match(css, /position:\s*fixed/)
  assert.match(css, /background:\s*var\(--aph-red\)/)
  assert.match(css, /--aph-topbar:\s*50px/)
  assert.match(css, /--aph-tabs:\s*46px/)
  assert.match(css, /--aph-rail:\s*60px/)
  assert.match(css, /\.system-nav:hover[^}]*width:\s*140px/is)
})

test('驾驶舱系统管理入口收口到主壳层内的分流页，后台保留返回入口', () => {
  const unified = fs.readFileSync(path.join(site, 'aph2-r50-system-direct-admin-20260812-v1.js'), 'utf8')
  assert.ok(index.includes('/aph2-r50-system-direct-admin-20260812-v1.js'))
  assert.match(index, /aph2-r52-app-bootstrap-20260812-v1\.js/)
  assert.match(unified, /const ADMIN_ROUTE = '\/admin'/)
  assert.match(unified, /\['\/system', ADMIN_ROUTE\]/)
  assert.match(unified, /event\.stopImmediatePropagation\(\)/)
  assert.match(unified, /window\.location\.assign/)
  assert.doesNotMatch(unified, /aph-system-hub/)
  assert.ok(admin.includes('/admin/aph2-admin-system-link-20260811-v1.js'))
})
