import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localRoot = path.join(repoRoot, 'firstcare-cloud-local')

const read = file => fs.readFileSync(file, 'utf8')

function currentAssetRoot() {
  const index = read(path.join(localRoot, 'index.html'))
  const assetRootMatch = index.match(/assets\/(cockpit-[^/"']+)\/app-[^/"']+\.js/)
  assert.ok(assetRootMatch, 'index.html 未引用当前不可变主 SPA 资产')
  return path.join(localRoot, 'assets', assetRootMatch[1])
}

function assetSourceMatching(pattern, label) {
  const assetRoot = currentAssetRoot()
  const candidates = fs.readdirSync(assetRoot).filter(name => name.endsWith('.js'))
  const sourceName = candidates.find(name => {
    const source = read(path.join(assetRoot, name))
    return pattern.test(source)
  })
  assert.ok(sourceName, `未在 ${assetRoot} 找到${label}源码块`)
  return read(path.join(assetRoot, sourceName))
}

const source = assetSourceMatching(/function SimpleAdmin\(\)[\s\S]*系统管理功能/, '系统管理')
const server = {
  payments: read(path.join(repoRoot, 'server/src/routes/payments.ts')),
  projects: read(path.join(repoRoot, 'server/src/routes/projects.ts')),
  projectDirectory: read(path.join(repoRoot, 'server/src/project-directory.ts')),
  trends: read(path.join(repoRoot, 'server/src/routes/trends.ts')),
  governance: read(path.join(repoRoot, 'server/src/routes/governance.ts')),
  reportArchive: read(path.join(repoRoot, 'server/src/report-archive-generator.ts')),
  dataSources: read(path.join(repoRoot, 'server/src/routes/data-sources.ts')),
  users: read(path.join(repoRoot, 'server/src/routes/users.ts')),
}

test('8 个业务域只保留一个简单导航，当前项使用页面语义', () => {
  for (const [key, label] of [
    ['payments', '回款额'], ['collections', '收缴率'], ['trends', '月度趋势'],
    ['rules', '预警规则'], ['logs', '操作日志'], ['reports', '月报归档'],
    ['sources', '数据源'], ['users', '成员管理'],
  ]) {
    assert.match(source, new RegExp(`\\["${key}", "${label}"\\]`))
  }
  assert.match(source, /"aria-current": tab === key \? "page"/)
  assert.doesNotMatch(source, /role: "tab"|role: "tablist"|role: "tabpanel"/)
})

test('每个只读域都调用已注册 GET，真实空态不伪造数据', () => {
  for (const endpoint of [
    '/api/payments', '/api/collections', '/api/trends', '/api/governance/rules',
    '/api/governance/logs?limit=200', '/api/governance/report-archives',
    '/api/data-sources/status', '/api/users', '/api/users/service-centers',
  ]) assert.ok(source.includes(endpoint), `系统管理页未读取 ${endpoint}`)

  assert.match(source, /暂无回款额数据/)
  assert.match(source, /暂无收缴率数据/)
  assert.match(source, /尚无已发布收缴批次可用于趋势重建/)
  assert.match(source, /尚无服务端生成的不可变月报归档/)
  assert.match(source, /上游尚未提供该字段/)
  assert.doesNotMatch(source, /saveCollection|saveTrend/)
})

test('月度趋势将后端 0-1 正式比例一次性格式化为百分比', () => {
  assert.match(source, /function displayRatioPercent\([^)]*\)[\s\S]*?number\s*<\s*0[\s\S]*?number\s*>\s*1[\s\S]*?\*\s*100[\s\S]*?toFixed\(2\)[\s\S]*?%/)
  assert.match(source, /areas\.map\(\(area\) => h\("td", \{ className: "r65-number", children: displayRatioPercent\(row\[area\]\)/)
  assert.match(source, /areas\.map\(\(area\) => `\$\{area\}（%）`\)/)
  assert.doesNotMatch(source, /areas\.map\(\(area\) => h\("td", \{ className: "r65-number", children: displayNumber\(row\[area\]\)/)
})

test('全部可见写动作都有正式注册 API，不使用前端假成功', () => {
  const contracts = [
    [source, /`\/api\/governance\/rules\/\$\{row\.id\}`/, server.governance, /router\.put\('\/api\/governance\/rules\/:id'/],
    [source, /`\/api\/governance\/report-archives\/\$\{id\}`/, server.governance, /router\.get\('\/api\/governance\/report-archives\/:id'/],
    [source, /`\/api\/data-sources\/sync\/\$\{source\.source_key\}`/, server.dataSources, /router\.post\('\/api\/data-sources\/sync\/:source'/],
    [source, /`\/api\/data-sources\/repair\/\$\{source\.source_key\}`/, server.dataSources, /router\.post\('\/api\/data-sources\/repair\/:source'/],
    [source, /api\("\/api\/users", \{\s*method: "POST"/, server.users, /router\.post\('\/api\/users'/],
    [source, /`\/api\/users\/\$\{user\.id\}\/scope`/, server.users, /router\.put\('\/api\/users\/:id\/scope'/],
    [source, /`\/api\/users\/\$\{user\.id\}\/role`/, server.users, /router\.put\('\/api\/users\/:id\/role'/],
    [source, /`\/api\/users\/\$\{user\.id\}\/password`/, server.users, /router\.put\('\/api\/users\/:id\/password'/],
    [source, /`\/api\/users\/\$\{user\.id\}`[\s\S]*?method: "DELETE"/, server.users, /router\.delete\('\/api\/users\/:id'/],
  ]
  for (const [frontend, frontendPattern, backend, backendPattern] of contracts) {
    assert.match(frontend, frontendPattern)
    assert.match(backend, backendPattern)
  }
  assert.match(source, /if \(!response\.ok\)/)
  assert.match(source, /throw error/)
})

test('生产真实性、乐观锁、审计和失败关闭合同仍在后端', () => {
  assert.match(server.payments, /process\.env\.NODE_ENV === 'production'/)
  assert.match(server.payments, /FORMAL_PAYMENT_READ_ONLY/)
  assert.match(server.payments, /WHERE id = \? AND version = \?/)
  assert.match(server.payments, /res\.status\(409\)/)
  assert.match(server.payments, /'修改回款数据'/)
  assert.match(server.trends, /quality_status='verified'/)
  assert.match(server.trends, /正式月度趋势禁止手工写入/)
  assert.match(server.governance, /'修改预警规则'/)
  assert.match(server.reportArchive, /生成可追溯经营归档|确认经营归档幂等状态/)
  assert.match(server.dataSources, /'检测外部数据源'/)
  assert.match(server.dataSources, /'修复APH固定入口'/)
  for (const action of ['创建用户', '修改用户数据范围', '修改用户角色', '删除用户', '重置用户密码']) {
    assert.match(server.users, new RegExp(`'${action}'`))
  }
})

test('busy、确认、校验和清理前提可由浏览器验收观测', () => {
  assert.match(source, /disabled: busy \|\| disabled/)
  assert.match(source, /children: busy \? "保存中…"/)
  assert.match(source, /setSaving\(row\.id\)/)
  assert.match(source, /finally \{\s*setSaving\(null\)/)
  assert.match(source, /answer !== "确认修复"/)
  assert.match(source, /confirmation: "确认修复"/)
  assert.match(source, /window\.confirm\(`确定删除成员/)
  assert.match(source, /confirmation: user\.username/)
  assert.match(source, /至少12位，须含字母和数字/)
  assert.match(server.payments, /FORMAL_PAYMENT_READ_ONLY/)
  assert.doesNotMatch(source, /savePayment|`\/api\/payments\/\$\{row\.id\}`/)
})

test('归档详情优先展示 generator 真实嵌套血缘', () => {
  const reportDetail = source.slice(source.indexOf('function ReportDetail'), source.indexOf('function SimpleAdmin'))
  assert.match(server.reportArchive, /projectDirectory:\s*\{[\s\S]*?batchId:\s*directoryBatch\.id[\s\S]*?sourceSha256/)
  assert.match(server.reportArchive, /publishedFacts:\s*\{[\s\S]*?batchId:\s*Number\(factBatch\.id\)[\s\S]*?batchSha256[\s\S]*?businessDate/)
  assert.match(reportDetail, /const directoryEvidence = traceability\.projectDirectory \|\| \{\}/)
  assert.match(reportDetail, /const factEvidence = traceability\.publishedFacts \|\| \{\}/)
  assert.match(reportDetail, /`项目目录批次 #\$\{directoryEvidence\.batchId\}/)
  assert.match(reportDetail, /`P46 事实批次 #\$\{factEvidence\.batchId\}/)
  assert.match(reportDetail, /evidenceRows\.length[\s\S]*?h\("ul"[\s\S]*?: h\("p", \{ children: traceabilityText\(traceability\)/)
  assert.doesNotMatch(reportDetail, /数据源\s*0\s*项/)
})

test('项目目录只在ready态称已发布，正式回执四态不与连接状态混淆', () => {
  const gate = source.slice(source.indexOf('function ProjectDirectoryGate'), source.indexOf('function PasswordAction'))
  const sourceLoad = source.slice(source.indexOf('} else if (key === "sources")'), source.indexOf('} else {', source.indexOf('} else if (key === "sources")') + 10))
  assert.match(gate, /const ready = \["directory_ready", "operating_ready"\]\.includes\(directoryStatus\.state\)/)
  assert.doesNotMatch(gate, /projectCount\s*>\s*0|Boolean\(directoryStatus\.projectCount\)/)
  assert.match(gate, /children: ready \? "已发布" : "待发布"/)
  assert.match(gate, /publication\?\.code === "complete" && publication\?\.isComplete === true/)
  assert.match(gate, /publication\?\.code === "failed" \? "danger" : "warning"/)
  assert.match(gate, /publication\?\.label \|\| "正式回执未知"/)
  assert.match(gate, /不能宣称数据已发布/)
  assert.match(sourceLoad, /api\("\/api\/data-sources\/publication-status"\)/)
  assert.match(sourceLoad, /code: "unknown", label: "正式回执未知", isComplete: false/)
  assert.match(sourceLoad, /message: formalPublication\.summary/)
  assert.doesNotMatch(sourceLoad, /message:\s*`\u5df2读取 \$\{sourceRows\.length\} 个正式数据源状态/)
})

test('成员保存、删除、改密和创建共享单一 busyKey', () => {
  const members = source.slice(source.indexOf('function PasswordAction'), source.indexOf('function ReportDetail'))
  assert.match(source, /const \[saving, setSaving\] = hl\.useState\(null\)/)
  assert.match(source, /h\(MemberCreate, \{[\s\S]*?busyKey: saving, setBusyKey: setSaving/)
  assert.match(source, /h\(MemberTable, \{[\s\S]*?busyKey: saving, setBusyKey: setSaving/)
  assert.match(source, /h\(PaymentTable, \{ rows: data\.payments \}\)/)
  assert.doesNotMatch(source, /savePayment|`\/api\/payments\/\$\{row\.id\}`/)
  assert.match(source, /h\(RuleTable, \{[\s\S]*?saving, saveRow: saveRule/)
  assert.match(source, /h\(ReportTable, \{[\s\S]*?busyKey: saving/)
  assert.match(source, /h\(SourceTable, \{[\s\S]*?busyKey: saving/)
  assert.match(source, /disabled: Boolean\(saving \|\| loading\)/)
  for (const key of ['member-password-', 'member-save-', 'member-delete-', 'member-create']) {
    assert.ok(members.includes(key), `缺少 ${key} 独立busy标识`)
  }
  assert.match(members, /if \(busyKey\) return;[\s\S]*?window\.confirm\(`确定删除成员[\s\S]*?setBusyKey\(actionKey\)[\s\S]*?method: "DELETE"/)
  assert.match(members, /children: busyKey === `member-delete-\$\{user\.id\}` \? "删除中…" : "删除"/)
  assert.ok((members.match(/disabled: Boolean\(busyKey\)/g) || []).length >= 9, '成员写控件未全部共享busy禁用态')
  assert.equal((members.match(/finally \{\s*setBusyKey\(null\);?\s*\}/g) || []).length, 4, '四类成员动作必须在finally恢复busyKey')
})

test('成员管理只允许 admin/viewer 和权威单中心，不能回退旧范围模型', () => {
  assert.match(source, /api\("\/api\/users\/service-centers"\)/)
  assert.match(source, /service_center_scope/)
  assert.match(source, /普通成员必须选择一个服务中心/)
  assert.match(source, /value: "viewer"/)
  assert.match(source, /value: "admin"/)
  assert.doesNotMatch(source, /value: "region_manager"|value: "area_manager"|value: "project_manager"/)
  assert.doesNotMatch(source, /area_scope|project_scope/)
})

test('R66 正式发布动作命名锁定且不得残留 confirmed 旧路由', () => {
  const allServer = Object.values(server).join('\n')
  for (const [route, confirmation] of [
    ['/api/projects/directory/publish', '确认发布项目目录'],
    ['/api/trends/rebuild', '确认重建月度趋势'],
    ['/api/governance/report-archives/generate', '确认生成正式归档'],
  ]) {
    assert.match(allServer, new RegExp(route.replaceAll('/', '\\/')))
    assert.match(allServer, new RegExp(confirmation))
  }
  assert.doesNotMatch(allServer, /projects\/directory\/publish-confirmed|trends\/rebuild-confirmed|report-archives\/generate-confirmed/)
  assert.match(server.trends, /res\.json\(\{\s*rows,[\s\S]*?status/)
  assert.match(server.governance, /report-archives[\s\S]*?res\.json\(\{\s*rows,[\s\S]*?status/)
})

test('directory_only 未知经营字段不得补 0 或生成经营结论', () => {
  assert.match(server.projectDirectory, /DIRECTORY_VALIDATION_STATUS = 'directory_only'/)
  assert.match(server.projectDirectory, /annual_income/)
  assert.match(server.projectDirectory, /quality_score/)
  assert.match(server.projectDirectory, /customer_satisfaction/)
  assert.doesNotMatch(server.projectDirectory, /(?:annual_income|annual_cost|ytd_income|ytd_cost|quality_score|customer_satisfaction)\s*\|\|\s*0/)
  assert.match(server.projects, /if \(!availability\.operatingFactsAvailable\)[\s\S]*?profitRate: null/)
  assert.match(server.projects, /dataAvailable: false[\s\S]*?healthScore: null/)
  assert.match(server.projectDirectory, /不生成健康分或风险结论/)
})

test('项目列表和详情对 directory_only 不得在浏览器补 0 或本地生成健康分', () => {
  const projectList = assetSourceMatching(/Jd\("\/api\/projects"\)[\s\S]*?Jd\("\/api\/ai\/interpret"/, '项目列表')
  const projectDetail = assetSourceMatching(/Jd\(`\/api\/projects\/\$\{[\s\S]*?Jd\(`\/api\/ai\/project\//, '项目详情')
  for (const [label, projectSource] of [['项目列表', projectList], ['项目详情', projectDetail]]) {
    assert.match(projectSource, /directory_only/, `${label}必须识别directory_only状态`)
    assert.match(projectSource, /未接入|经营数据不可用/, `${label}必须解释unknown状态`)
    assert.doesNotMatch(projectSource, /(?:ytd_income|ytd_cost|annual_income|annual_cost|quality_score|customer_satisfaction)\s*\|\|\s*0/, `${label}不得把unknown补0`)
  }
  assert.doesNotMatch(projectList, /t2\s*\*\s*0\.55[\s\S]*quality_score[\s\S]*customer_satisfaction/, '项目列表不得本地兜底计算健康分')
  assert.doesNotMatch(projectList, /ytd_income\s*>\s*0[\s\S]{0,180}?ytd_cost[\s\S]{0,120}?:\s*0/, '项目列表不得把未知利润率改成0')
  assert.match(projectDetail, /!r66DirectoryOnly\(r\) && a\.riskProfile/, 'directory_only详情必须隐藏风险画像')
  assert.match(projectDetail, /children: r66Percent\(N\)/, '利润率必须通过null安全格式化')
})
