import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const site = path.join(root, 'firstcare-cloud-local')
const release = path.join(
  site,
  'assets/cockpit-r66-full-admin-20260813-v1',
)
const read = file => fs.readFileSync(file, 'utf8')

const html = read(path.join(site, 'index.html'))
const bootstrap = read(path.join(site, 'aph2-r66-app-bootstrap-20260813-v1.js'))
const scopeUi = read(path.join(site, 'aph2-r65-service-center-scope-20260813-v1.js'))
const retiredTasks = read(path.join(site, 'task-module-retired.js'))
const css = read(path.join(site, 'aph2-r66-full-admin-20260813-v1.css'))
const shell = read(path.join(release, 'chunk-7C7IT5GR.js'))
const admin = read(path.join(release, 'chunk-R65SIMPLEADMIN.js'))
const aiReport = read(path.join(release, 'chunk-5ICXUZV4.js'))

test('R66 根入口只加载当前不可变候选并保留 R65 服务中心范围脚本', () => {
  const appAsset = '/assets/cockpit-r66-full-admin-20260813-v1/app-G7HUEEER.js'
  assert.equal(html.split(appAsset).length - 1, 1)
  assert.equal(
    html.split('/aph2-r65-service-center-scope-20260813-v1.js?v=r65-center-scope1').length - 1,
    1,
  )
  assert.equal(
    html.split('/aph2-r66-full-admin-20260813-v1.css?v=r66-full-admin1').length - 1,
    1,
  )
  assert.match(bootstrap, /await Promise\.resolve\(window\.__aphR65ScopeReady\)/)
  assert.match(bootstrap, /await import\('\/assets\/cockpit-r66-full-admin-20260813-v1\/app-G7HUEEER\.js'\)/)
})

test('R65 成员路由矩阵仅允许业务只读页和本中心项目详情', () => {
  assert.match(
    shell,
    /var _d = \["\/", "\/payment", "\/daily", "\/collection", "\/projects", "\/arrears", "\/ai-alerts", "\/ai-report"\]/,
  )
  assert.match(shell, /if \(U === "\/login" \|\| zd\(\)\) return true/)
  assert.match(shell, /if \(!ri\(\)\) return false/)
  assert.match(shell, /\["\/system", "\/review-system"\]\.includes\(U\)/)
  assert.match(shell, /return _d\.includes\(U\) \|\| \/\^\\\/projects\\\/\[\^\/\]\+\$\//)
  assert.doesNotMatch(shell, /Ed\(\) \? true : Td\(\)/)

  for (const allowed of [
    '/', '/payment', '/daily', '/collection', '/projects', '/arrears', '/ai-alerts', '/ai-report',
  ]) {
    assert.ok(shell.includes(`"${allowed}"`), `成员读路由缺失：${allowed}`)
  }
  for (const denied of ['/admin', '/system', '/import', '/review', '/review-system']) {
    assert.ok(shell.includes(`"${denied}"`), `成员禁止路由未显式收口：${denied}`)
  }
})

test('R65 系统管理收口为 8 个真实功能域并有对应 API 合同', () => {
  const domains = [
    ['payments', '回款额'],
    ['collections', '收缴率'],
    ['trends', '月度趋势'],
    ['rules', '预警规则'],
    ['logs', '操作日志'],
    ['reports', '月报归档'],
    ['sources', '数据源'],
    ['users', '成员管理'],
  ]
  for (const [key, label] of domains) {
    assert.ok(admin.includes(`["${key}", "${label}"]`), `缺少后台功能：${label}`)
  }

  const apiContracts = [
    '/api/payments',
    '/api/collections',
    '/api/trends',
    '/api/governance/rules',
    '/api/governance/logs?limit=200',
    '/api/governance/report-archives',
    '/api/data-sources/status',
    '/api/data-sources/sync/',
    '/api/data-sources/repair/',
    '/api/users',
    '/api/users/service-centers',
    '/scope',
    '/password',
  ]
  for (const endpoint of apiContracts) {
    assert.ok(admin.includes(endpoint), `缺少真实 API 合同：${endpoint}`)
  }
  assert.match(admin, /function PaymentTable\(\{ rows \}\)/)
  assert.match(admin, /页面不允许手工改写，更新须走P46正式发布链/)
  assert.doesNotMatch(admin, /savePayment|`\/api\/payments\/\$\{row\.id\}`/)
  assert.doesNotMatch(admin, /\/api\/collections\/\$\{row\.id\}/)
  assert.doesNotMatch(admin, /function saveCollection/)
  assert.match(admin, /function CollectionTable\(\{ rows \}\)/)
})

test('R65 成员仅有 admin 和 viewer 两种界面角色，中心选项只来自权威端点', () => {
  assert.match(admin, /value: "viewer", children: "普通成员"/)
  assert.match(admin, /value: "admin", children: "系统管理员"/)
  assert.doesNotMatch(admin, /region_manager|area_manager|project_manager/)
  assert.match(
    admin,
    /Promise\.all\(\[api\("\/api\/users"\), api\("\/api\/users\/service-centers"\)\]\)/,
  )
  assert.doesNotMatch(admin, /paymentsPayload|api\("\/api\/payments"\)\]\)/)
  assert.match(admin, /needsScope = form\.role !== "admin"/)
  assert.match(admin, /\(needsScope && !form\.service_center_scope\)/)
  assert.match(admin, /service_center_scope: needsScope \? form\.service_center_scope : null/)
  assert.match(admin, /h\("select", \{ value: form\.service_center_scope/)
  assert.doesNotMatch(admin, /h\("input", \{[^\n]*service_center_scope/)

  // AI 月报是成员可访问路由，旧三角色必须先统一降为只读成员。
  assert.match(aiReport, /role\s*===\s*"admin"\s*\?\s*"admin"\s*:\s*"viewer"/)
  assert.doesNotMatch(aiReport, /\/api\/export\/monthly-report-doc/)
  assert.doesNotMatch(aiReport, /\/api\/tasks|href:\s*[`"']\/tasks/)
  const projectList = read(path.join(release, 'chunk-4VAYZCQG.js'))
  const projectDetail = read(path.join(release, 'chunk-YAFZUARX.js'))
  assert.doesNotMatch(projectList, /\/api\/tasks/)
  assert.doesNotMatch(projectDetail, /\/api\/tasks/)
})

test('R65 未绑定成员明确提示且前端筛选锁定不作为授权边界', () => {
  assert.match(scopeUi, /fetch\('\/api\/auth\/me'/)
  assert.match(scopeUi, /当前服务中心：\$\{scope\(\) \|\| '未配置'\}/)
  assert.match(scopeUi, /当前账号尚未配置服务中心，请联系管理员/)
  assert.match(scopeUi, /control\.disabled = true/)
  assert.match(scopeUi, /真正的数据隔离仍由后端逐接口强制/)
  assert.match(scopeUi, /if \(control\.closest\('\.r65-admin'\)\) return false/)
  assert.match(scopeUi, /localStorage\.setItem\(USER_KEY, JSON\.stringify\(currentUser\)\)/)
})

test('R66 危险写操作仍需确认，R65 范围脚本与退役 410 任务仍先于主应用', () => {
  assert.match(admin, /window\.confirm\(`确定删除成员 \$\{user\.username\}\uff1f`\)/)
  assert.match(admin, /window\.prompt\(`将使用「\$\{candidateName\}」覆盖正式固定入口/)
  assert.match(admin, /answer !== "确认修复"/)
  assert.doesNotMatch(admin, /repair-tasks|migrate-legacy-tasks/)
  assert.doesNotMatch(admin, /任务中心|自动任务|任务管理/)
  assert.ok(html.indexOf('/task-module-retired.js') < html.indexOf('/aph2-r66-app-bootstrap-20260813-v1.js'))
  assert.match(retiredTasks, /url\.pathname === retired \|\| url\.pathname\.startsWith\(`\$\{retired\}\/`\)/)
  assert.match(retiredTasks, /if \(isRetiredRead\) return Promise\.resolve\(new Response\(null, \{ status: 204/)
  assert.match(retiredTasks, /root\.querySelectorAll\('button, \[role="button"\]'\)/)
  assert.match(retiredTasks, /taskActionPattern\.test\(normalize\(control\.innerText\)\)/)
})

test('R65 请求错误不被吞掉，同时保留桌面、移动和键盘验收基础', () => {
  assert.match(admin, /payload\?\.error \|\| payload\?\.message \|\| `请求失败（\$\{response\.status\}）`/)
  assert.match(admin, /role: tone === "error" \? "alert" : "status"/)
  assert.doesNotMatch(admin, /role: "tablist"/)
  assert.doesNotMatch(admin, /role: "tab"/)
  assert.match(admin, /"aria-current": tab === key \? "page" : void 0/)
  assert.match(admin, /role: "region"/)
  assert.match(admin, /tabIndex: 0/)
  assert.match(admin, /"aria-label": label/)
  assert.match(admin, /id: "main-content"/)

  assert.match(css, /\.r65-tabs\s*\{[^}]*overflow-x:\s*auto/s)
  assert.match(css, /\.r65-table-wrap,[^}]*overflow:\s*auto/s)
  assert.match(css, /\.r65-tabs button:focus-visible/)
  assert.match(css, /@media \(max-width:\s*720px\)/)
  assert.match(css, /\.r65-member-form\s*\{\s*display:\s*grid/s)
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/)
})
