import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const site = path.join(root, 'firstcare-cloud-local')
const asset = path.join(site, 'assets', 'cockpit-r76-member-scope-20260813-v1', 'chunk-R65SIMPLEADMIN.js')
const source = fs.readFileSync(asset, 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r76-member-scope-20260813-v1.css'), 'utf8')
const bootstrap = fs.readFileSync(path.join(site, 'aph2-r76-app-bootstrap-20260813-v1.js'), 'utf8')

test('成员类型严格提供四个业务岗位', () => {
  for (const [role, label] of [
    ['region_manager', '地区职能'],
    ['area_manager', '片区经理'],
    ['project_manager', '项目经理'],
    ['viewer', '项目职员'],
  ]) {
    assert.match(source, new RegExp(`\\["${role}", "${label}"\\]`))
  }
  assert.match(source, /currentRole === "admin" \? h\("span", \{ className: "r65-scope-all", children: "系统管理员"/)
  assert.doesNotMatch(source, /value: "admin", children: "系统管理员"/)
})

test('片区来自权威服务中心目录并过滤中心', () => {
  assert.match(source, /item\.area \|\| item\.area_name \|\| item\.areaName/)
  assert.match(source, /centers\.filter\(\(item\) => item\.area === area\)/)
  assert.match(source, /children: "请选择片区"/)
  assert.match(source, /area_scope: form\.area_scope/)
  assert.match(source, /setDraftScopes\(\(current\) => \(\{ \.\.\.current, \[id\]: \[\] \}\)\)/)
})

test('服务中心为可访问的多选下拉且提交数组', () => {
  assert.match(source, /function MultiCenterSelect/)
  assert.match(source, /type: "checkbox"/)
  assert.match(source, /role: "group"/)
  assert.match(source, /已选择 \$\{selected\.length\} 个服务中心/)
  assert.match(source, /service_center_scope: form\.service_center_scope/)
  assert.match(source, /service_center_scope\.length === 0/)
  assert.match(css, /\.r76-center-options\s*\{[^}]*max-height:\s*260px/s)
  assert.match(css, /@media \(max-width: 720px\)/)
})

test('新不可变启动器只加载R76主应用', () => {
  assert.match(bootstrap, /await Promise\.resolve\(window\.__aphR65ScopeReady\)/)
  assert.match(bootstrap, /cockpit-r76-member-scope-20260813-v1\/app-G7HUEEER\.js/)
  assert.doesNotMatch(bootstrap, /cockpit-r66-full-admin/)
})

test('成员管理不添加横幅、营销说明或页面外网络请求', () => {
  assert.doesNotMatch(css, /body(?!\.aph)|main\s*\{|\.aph-exact-sidebar/)
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|WebSocket|EventSource/)
})
