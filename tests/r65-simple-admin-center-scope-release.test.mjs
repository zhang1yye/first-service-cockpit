import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localRoot = path.join(repoRoot, 'firstcare-cloud-local')
const assetRoot = path.join(localRoot, 'assets', 'cockpit-r65-simple-admin-center-scope-20260813-v1')

const read = file => fs.readFileSync(file, 'utf8')

test('R65 使用不可变启动器和独立主 SPA 资产', () => {
  const index = read(path.join(localRoot, 'index.html'))
  const bootstrap = read(path.join(localRoot, 'aph2-r65-app-bootstrap-20260813-v1.js'))
  assert.match(index, /aph2-r65-service-center-scope-20260813-v1\.js/)
  assert.match(index, /aph2-r65-simple-admin-center-scope-20260813-v1\.css/)
  assert.match(index, /cockpit-r65-simple-admin-center-scope-20260813-v1\/app-G7HUEEER\.js/)
  assert.match(index, /aph2-r65-app-bootstrap-20260813-v1\.js/)
  assert.match(bootstrap, /await Promise\.resolve\(window\.__aphR65ScopeReady\)/)
  assert.match(bootstrap, /cockpit-r65-simple-admin-center-scope-20260813-v1\/app-G7HUEEER\.js/)
})

test('任意非 admin 仅能进入服务中心只读业务白名单', () => {
  const source = read(path.join(assetRoot, 'chunk-7C7IT5GR.js'))
  for (const route of ['/', '/payment', '/daily', '/collection', '/projects', '/arrears', '/ai-alerts', '/ai-report']) {
    assert.match(source, new RegExp(`"${route.replaceAll('/', '\\/')}"`))
  }
  assert.match(source, /if \(!ri\(\)\) return false/)
  assert.match(source, /\^\\\/projects\\\/\[\^\/\]\+\$\/\.test\(U\)/)
  assert.match(source, /\["\/system", "\/review-system"\]\.includes\(U\)/)
  assert.doesNotMatch(source, /Ed\(\) \? true/)
  assert.match(source, /function Ed\(\)[\s\S]*?z\.role\) === "admin"/)
  assert.match(source, /function Td\(\)[\s\S]*?z\.role !== "admin"/)
  assert.match(source, /import\("\.\/chunk-R65SIMPLEADMIN\.js"\)/)
  const reportSource = read(path.join(assetRoot, 'chunk-5ICXUZV4.js'))
  assert.match(reportSource, /role\s*===\s*"admin"\s*\?\s*"admin"\s*:\s*"viewer"/)
  assert.doesNotMatch(reportSource, /return JSON\.parse\(localStorage\.getItem\("cockpit_user"\).*\.role \|\| ""/)
})

test('成员管理只使用权威服务中心目录且普通成员恰好一个中心', () => {
  const source = read(path.join(assetRoot, 'chunk-R65SIMPLEADMIN.js'))
  assert.match(source, /api\("\/api\/users\/service-centers"\)/)
  assert.doesNotMatch(source, /usersPayload, paymentsPayload/)
  assert.doesNotMatch(source, /area_scope|project_scope/)
  assert.match(source, /service_center_scope/)
  assert.match(source, /\/api\/users\/\$\{user\.id\}\/scope/)
  assert.match(source, /\/api\/users\/\$\{user\.id\}\/role/)
  assert.match(source, /确认将 \$\{user\.username\} 调整为/)
  assert.match(source, /value: "viewer"/)
  assert.match(source, /value: "admin"/)
  assert.doesNotMatch(source, /value: "project_manager"|value: "area_manager"|value: "region_manager"/)
  assert.match(source, /普通成员必须选择一个服务中心/)
})

test('只读页显示真实空态，不暴露失效写动作', () => {
  const source = read(path.join(assetRoot, 'chunk-R65SIMPLEADMIN.js'))
  assert.match(source, /尚无已核验月度趋势；数据接入后自动显示。/)
  assert.match(source, /尚无月报归档；完成正式归档后显示。/)
  assert.match(source, /row\.report_date \|\| row\.month \|\| row\.snapshot_month/)
  assert.match(source, /label: "正式收缴数据"/)
  assert.match(source, /上游尚未提供该字段.*未接入/s)
  assert.doesNotMatch(source, /saveCollection|saveTrend/)
  assert.doesNotMatch(source, /\/api\/data-sources\/auto-jobs\/repair-tasks/)
  assert.doesNotMatch(source, /\/api\/data-sources\/master-data\/migrate-legacy-tasks/)
})

test('真实错误、乐观锁、强确认、密码规则和简单导航语义已落实', () => {
  const source = read(path.join(assetRoot, 'chunk-R65SIMPLEADMIN.js'))
  assert.match(source, /payload\?\.error \|\| payload\?\.message/)
  assert.match(source, /version: row\.version/)
  assert.match(source, /_dirtyKeys:/)
  assert.match(source, /disabled: !validPaymentChanges\(row\)/)
  assert.match(source, /Object\.fromEntries/)
  assert.match(source, /\(row\._dirtyKeys \|\| \[\]\)\.map/)
  assert.match(source, /\[key\]: value, _dirty: true/)
  assert.match(source, /Number\(row\.threshold_value\) < 0/)
  assert.match(source, /error\.status === 409/)
  assert.match(source, /已重新加载服务器最新值/)
  assert.match(source, /请输入“确认修复”继续/)
  assert.match(source, /answer !== "确认修复"/)
  assert.match(source, /confirmation: "确认修复"/)
  assert.match(source, /candidateMtime:/)
  assert.match(source, /candidateSize:/)
  assert.match(source, /高风险：会覆盖正式入口并写入审计/)
  assert.match(source, /至少12位，须含字母和数字/)
  assert.match(source, /value\.length >= 12/)
  assert.match(source, /"aria-current": tab === key \? "page"/)
  assert.doesNotMatch(source, /role: "tab"|role: "tablist"|role: "tabpanel"/)
  assert.match(source, /确认创建系统管理员/)
  assert.match(source, /confirmation: "确认管理员权限"/)
  assert.match(source, /confirmation: user\.username/)
  assert.match(source, /密码已更新，该成员需重新登录/)
  assert.match(source, /role: "region"/)
  assert.match(source, /tabIndex: 0/)
})

test('预警规则的阈值和启停状态均可追踪修改并保存', () => {
  const source = read(path.join(assetRoot, 'chunk-R65SIMPLEADMIN.js'))
  assert.match(source, /type: "checkbox"/)
  assert.match(source, /checked: Boolean\(row\.enabled\)/)
  assert.match(source, /`\$\{row\.label\}启用状态`/)
  assert.match(source, /update\(row\.id, "enabled", event\.target\.checked\)/)
  assert.match(source, /threshold_value: row\.threshold_value, enabled: row\.enabled/)
})

test('R65 保存文案规避生产旧安全层精确匹配', () => {
  const source = read(path.join(assetRoot, 'chunk-R65SIMPLEADMIN.js'))
  assert.match(source, /children = "保存修改"/)
  assert.doesNotMatch(source, /children = "保存"/)
})

test('普通成员范围脚本隐藏跨中心控件并显示当前中心', () => {
  const source = read(path.join(localRoot, 'aph2-r65-service-center-scope-20260813-v1.js'))
  assert.match(source, /\/api\/auth\/me/)
  assert.match(source, /currentUser\.role !== 'admin'/)
  assert.match(source, /当前服务中心：\$\{scope\(\) \|\| '未配置'\}/)
  assert.match(source, /control\.disabled = true/)
  assert.match(source, /data-r65-scope-control-hidden/)
  assert.match(source, /currentUser = normalizeUser\(readStoredUser\(\)\)/)
  assert.match(source, /originalRole === 'admin' \? 'admin' : originalRole \? 'viewer'/)
  assert.match(source, /localStorage\.setItem\(USER_KEY, JSON\.stringify\(currentUser\)\)/)
  assert.match(source, /本服务中心口径/)
})

test('移动后台为宿主导航预留位置且不隐藏全局导航', () => {
  const source = read(path.join(localRoot, 'aph2-r65-simple-admin-center-scope-20260813-v1.css'))
  assert.match(source, /body\.aph-mobile-nav-ready:has\(\.r65-admin\) \.r65-admin/)
  assert.match(source, /padding-top: 52px/)
  assert.match(source, /body\.aph-mobile-nav-ready:has\(\.r65-admin\) \.r65-tabs/)
  assert.match(source, /top: 102px/)
  assert.doesNotMatch(source, /\.aph-mobile-primary-nav\s*\{[\s\S]*?display:\s*none/)
})

test('AI 月报和项目详情对普通成员仅保留只读动作', () => {
  const reportSource = read(path.join(assetRoot, 'chunk-5ICXUZV4.js'))
  const projectSource = read(path.join(assetRoot, 'chunk-YAFZUARX.js'))
  assert.doesNotMatch(reportSource, /\/api\/export\/monthly-report-doc/)
  assert.doesNotMatch(reportSource, /\/api\/tasks|href:\s*[`"']\/tasks/)
  assert.doesNotMatch(reportSource, /导出Word正式月报/)
  assert.match(reportSource, /zd\(\)\s*&&\s*\$\.jsxs\("section",\s*\{\s*className:\s*"card-soft mb-5 p-4 border-l-4 border-emerald-400"/s)
  assert.match(reportSource, /zd\(\)\s*&&\s*\$\.jsx\("button",\s*\{\s*onClick: oe/s)
  assert.match(reportSource, /zd\(\)\s*&&\s*Jd\("\/api\/formal-outputs"\)/)
  assert.match(projectSource, /import \{ \$, Jd, hl, zd \}/)
  assert.match(projectSource, /\\u67E5\\u770B\\u672C\\u670D\\u52A1\\u4E2D\\u5FC3\\u6708\\u62A5/)
  assert.doesNotMatch(projectSource, /\/api\/tasks/)
  assert.match(projectSource, /Array\.isArray\(t2\.reasons\)/)
  assert.match(projectSource, /Array\.isArray\(u\.actions\)/)
  assert.match(projectSource, /dimensions:\s*Array\.isArray\(a\.riskProfile\.dimensions\)/)
  assert.match(projectSource, /if \(!s\.ok\) throw new Error/)
})

test('成员可达项目列表不请求退役任务接口', () => {
  const source = read(path.join(assetRoot, 'chunk-4VAYZCQG.js'))
  assert.doesNotMatch(source, /\/api\/tasks/)
  assert.doesNotMatch(source, /href: "\/tasks"/)
  assert.doesNotMatch(source, /生成任务/)
  assert.doesNotMatch(source, /overdueProjects/)
})
