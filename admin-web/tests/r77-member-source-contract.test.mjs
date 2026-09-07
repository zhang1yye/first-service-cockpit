import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'src/App.jsx'), 'utf8')

test('可维护源码包含R77四类业务岗位和地区全范围', () => {
  for (const role of ['region_manager', 'area_manager', 'project_manager', 'viewer']) {
    assert.ok(source.includes(`'${role}'`), `缺少岗位：${role}`)
  }
  assert.match(source, /所有片区/)
  assert.match(source, /所有权威服务中心/)
  assert.match(source, /api\('\/api\/users\/service-centers'\)/)
})

test('片区和服务中心使用权威选项并支持多中心数组提交', () => {
  assert.match(source, /centers\.filter\(item => item\.area === value\.area_scope\)/)
  assert.match(source, /select multiple/)
  assert.match(source, /service_center_scope:\[\.\.\.event\.target\.selectedOptions\]/)
  assert.doesNotMatch(source, /项目ID范围|多个片区用英文逗号分隔/)
})

test('成员写操作有正式确认、旧令牌失效入口和统一busy保护', () => {
  assert.match(source, /confirmation:row\.username/)
  assert.match(source, /confirmation:scopeEdit\.role==='admin'\?'确认管理员权限'/)
  assert.match(source, /`\/api\/users\/\$\{scopeEdit\.id\}\/role`/)
  assert.match(source, /`\/api\/users\/\$\{row\.id\}\/password`/)
  assert.match(source, /if\(busy\)return/)
  assert.match(source, /disabled=\{Boolean\(busy\)\}/)
})
