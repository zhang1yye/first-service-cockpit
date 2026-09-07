import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'firstcare-cloud-local/assets/cockpit-r77-region-wide-scope-20260813-v1/chunk-R65SIMPLEADMIN.js'), 'utf8')
const css = fs.readFileSync(path.join(root, 'firstcare-cloud-local/aph2-r77-region-wide-scope-20260813-v1.css'), 'utf8')
const bootstrap = fs.readFileSync(path.join(root, 'firstcare-cloud-local/aph2-r77-app-bootstrap-20260813-v1.js'), 'utf8')
const users = fs.readFileSync(path.join(root, 'server/src/routes/users.ts'), 'utf8')
const access = fs.readFileSync(path.join(root, 'server/src/service-center-access.ts'), 'utf8')

test('地区职能在新建和成员表中均显示全部范围', () => {
  assert.match(source, /regionWide = form\.role === "region_manager"/)
  assert.match(source, /children: "所有片区"/)
  assert.match(source, /children: "所有服务中心"/)
  assert.match(source, /\["admin", "region_manager"\]\.includes\(currentRole\)/)
  assert.match(css, /\.r76-all-scope/)
})

test('地区职能不要求选择范围，其他三类仍必须选择', () => {
  assert.match(source, /!regionWide && \(!form\.area_scope \|\| form\.service_center_scope\.length === 0\)/)
  assert.match(source, /!\["admin", "region_manager"\]\.includes\(nextRole\)/)
  assert.match(source, /value === "region_manager"/)
})

test('后端动态使用权威目录覆盖地区职能全部中心', () => {
  assert.match(users, /userRole === 'region_manager' \? listServiceCenterOptions\(\)/)
  assert.match(users, /user\.role === 'region_manager' \? listServiceCenterOptions\(\)/)
  assert.match(users, /role === 'region_manager' \? listServiceCenterOptions\(\)/)
  assert.match(access, /user\.role === 'region_manager'\) return \[\.\.\.new Set\(centerRegistry\(\)\.flatMap/)
})

test('R77使用新不可变主应用且不增加说明横幅', () => {
  assert.match(bootstrap, /cockpit-r77-region-wide-scope-20260813-v1\/app-G7HUEEER\.js/)
  assert.doesNotMatch(source, /banner|hero|营销|说明横幅/)
})
