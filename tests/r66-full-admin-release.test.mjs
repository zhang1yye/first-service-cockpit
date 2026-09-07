import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const site = path.join(repoRoot, 'firstcare-cloud-local')
const r65Asset = path.join(site, 'assets', 'cockpit-r65-simple-admin-center-scope-20260813-v1')
const r66Asset = path.join(site, 'assets', 'cockpit-r66-full-admin-20260813-v1')
const read = file => fs.readFileSync(file, 'utf8')

const index = read(path.join(site, 'index.html'))
const bootstrap = read(path.join(site, 'aph2-r66-app-bootstrap-20260813-v1.js'))
const css = read(path.join(site, 'aph2-r66-full-admin-20260813-v1.css'))
const admin = read(path.join(r66Asset, 'chunk-R65SIMPLEADMIN.js'))
const projects = read(path.join(r66Asset, 'chunk-4VAYZCQG.js'))
const projectDetail = read(path.join(r66Asset, 'chunk-YAFZUARX.js'))

test('R66 仅精确切换新不可变主资产，R65 保留可回滚', () => {
  const app = '/assets/cockpit-r66-full-admin-20260813-v1/app-G7HUEEER.js'
  const style = '/aph2-r66-full-admin-20260813-v1.css?v=r66-full-admin1'
  const loader = '/aph2-r66-app-bootstrap-20260813-v1.js?v=r66-full-admin1'
  assert.equal(index.split(app).length - 1, 1)
  assert.equal(index.split(style).length - 1, 1)
  assert.equal(index.split(loader).length - 1, 1)
  assert.doesNotMatch(index, /cockpit-r65-simple-admin-center-scope-20260813-v1\/app-G7HUEEER\.js/)
  assert.doesNotMatch(index, /aph2-r65-app-bootstrap-20260813-v1\.js/)
  assert.doesNotMatch(index, /aph2-r65-simple-admin-center-scope-20260813-v1\.css/)
  assert.ok(fs.existsSync(path.join(r65Asset, 'app-G7HUEEER.js')))
  assert.ok(fs.existsSync(path.join(r65Asset, 'chunk-R65SIMPLEADMIN.js')))
  assert.match(bootstrap, /cockpit-r66-full-admin-20260813-v1\/app-G7HUEEER\.js/)
  assert.match(bootstrap, /await Promise\.resolve\(window\.__aphR65ScopeReady\)/)
})

test('R66 八个功能域保留真实 API，只读域不暴露手工改写', () => {
  for (const [key, label] of [
    ['payments', '回款额'],
    ['collections', '收缴率'],
    ['trends', '月度趋势'],
    ['rules', '预警规则'],
    ['logs', '操作日志'],
    ['reports', '月报归档'],
    ['sources', '数据源'],
    ['users', '成员管理'],
  ]) assert.ok(admin.includes(`["${key}", "${label}"]`), `缺少${label}`)

  for (const endpoint of [
    '/api/payments',
    '/api/collections',
    '/api/trends',
    '/api/governance/rules',
    '/api/governance/logs?limit=200',
    '/api/governance/report-archives',
    '/api/data-sources/status',
    '/api/users/service-centers',
  ]) assert.ok(admin.includes(endpoint), `缺少${endpoint}`)

  assert.match(admin, /collections: "正式只读"/)
  assert.match(admin, /logs: "审计只读"/)
  assert.match(admin, /reports: "不可变归档"/)
  assert.doesNotMatch(admin, /saveCollection|\/api\/collections\/\$\{row\.id\}/)
  assert.doesNotMatch(admin, /method: "POST", body: JSON\.stringify\(\{ month/)
})

test('R66 项目目录、趋势和归档均由服务端基于权威源生成', () => {
  assert.match(admin, /\/api\/projects\/directory\/publish/)
  assert.match(admin, /confirmation: "确认发布项目目录"/)
  assert.match(admin, /\/api\/trends\/rebuild/)
  assert.match(admin, /confirmation: "确认重建月度趋势"/)
  assert.match(admin, /\/api\/governance\/report-archives\/generate/)
  assert.match(admin, /confirmation: "确认生成正式归档"/)
  assert.match(admin, /area: "华北", version: "operation"/)
  assert.match(admin, /field_provenance/)
  assert.match(admin, /traceabilityText/)
  assert.match(admin, /ProjectDirectoryGate/)
  assert.match(admin, /项目经营真实性门禁/)
  assert.match(admin, /window\.confirm\(/)
})

test('R66 请求状态不吞错，可重试且防止重复提交', () => {
  assert.match(admin, /payload\?\.error \|\| payload\?\.message/)
  assert.match(admin, /failedKey \? \(\) => load\(failedKey\) : null/)
  assert.match(admin, /children: busy \? "重试中…" : "重试"/)
  assert.match(admin, /const requestId = \+\+loadVersion\.current/)
  assert.match(admin, /if \(requestId !== loadVersion\.current\) return/)
  assert.match(admin, /if \(saving\) return/)
  assert.match(admin, /disabled: Boolean\(saving \|\| loading\)/)
  assert.match(admin, /正式只读 · 通过P46发布链更新/)
  assert.match(admin, /function PaymentTable\(\{ rows \}\)/)
  assert.doesNotMatch(admin, /savePayment|`\/api\/payments\/\$\{row\.id\}`/)
})

test('R66 成员仅从权威目录选择一个服务中心', () => {
  assert.match(admin, /Promise\.all\(\[api\("\/api\/users"\), api\("\/api\/users\/service-centers"\)\]\)/)
  assert.match(admin, /service_center_scope/)
  assert.match(admin, /普通成员必须选择一个服务中心/)
  assert.doesNotMatch(admin, /region_manager|area_manager|project_manager/)
  assert.doesNotMatch(admin, /area_scope|project_scope/)
})

test('R66 directory_only 未知经营指标不变为0或虚假风险', () => {
  assert.match(projects, /r66DirectoryOnly/)
  assert.match(projects, /operatingRows\.length === 0/)
  assert.match(projects, /Jd\("\/api\/data-quality\/project-gate"\)/)
  assert.match(projects, /if \(!gate\?\.ready\) return null/)
  assert.match(projects, /\.filter\(\(s\) => !r66DirectoryOnly\(s\)\)/)
  assert.match(projects, /r66Money\(s\.received\)/)
  assert.match(projects, /"未接入"/)
  assert.doesNotMatch(projects, /we\.toFixed/)
  assert.doesNotMatch(projects, /e\(s\.received\)/)

  assert.match(projectDetail, /if \(r66DirectoryOnly\(s\.project\)\)/)
  assert.match(projectDetail, /!r66DirectoryOnly\(r\) && a\.riskProfile/)
  assert.match(projectDetail, /r66Money\(r\.ytd_income\)/)
  assert.match(projectDetail, /r66Percent\(d\)/)
  assert.doesNotMatch(projectDetail, /N\.toFixed|d\.toFixed/)
  assert.doesNotMatch(projectDetail, /children: \[r\.complaint_count \|\| 0/)
})

test('R66 状态条和报告详情在桌面与移动端均可读', () => {
  assert.match(css, /\.r66-domain-bar\s*\{/)
  assert.match(css, /\.r66-source-gate\s*\{/)
  assert.match(css, /\.r66-report-summary\s*\{/)
  assert.match(css, /@media \(max-width: 720px\)/)
  assert.match(css, /\.r66-source-gate\s*\{\s*grid-template-columns: 1fr/s)
  assert.match(css, /\.r66-report-summary\s*\{\s*grid-template-columns: 1fr 1fr/s)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
})
