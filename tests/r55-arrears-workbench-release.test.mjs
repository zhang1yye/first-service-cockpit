import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const site = path.join(root, 'firstcare-cloud-local', 'arrears')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const js = fs.readFileSync(path.join(site, 'aph2-r55-arrears-workbench-20260812-v1.js'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r55-arrears-workbench-20260812-v1.css'), 'utf8')

test('R55在原业务与键盘脚本后增量加载不可变工作区资源', () => {
  const overview = html.indexOf('/arrears/arrears-overview-20260808.js')
  const r51 = html.indexOf('/arrears/aph2-r51-arrears-keyboard-20260812-v1.js?v=r51-arrears-keyboard1')
  const r55 = html.indexOf('/arrears/aph2-r55-arrears-workbench-20260812-v1.js?v=r55-arrears-workbench1')
  assert.ok(overview >= 0 && r51 > overview && r55 > r51)
  assert.match(html, /aph2-r55-arrears-workbench-20260812-v1\.css\?v=r55-arrears-workbench1/)
  assert.match(js, /document\.body\.dataset\.r55Ready = 'true'/)
  assert.match(js, /setMode\('tasks'\)/)
  assert.match(css, /body\[data-r55-mode="tasks"\] \[data-arrears-view\]/)
})

test('R55默认分析任务覆盖完整上传校验链路且保留持续错误明细', () => {
  for (const id of ['r55Workbench', 'r55CreateForm', 'r55Project', 'r55BusinessDate', 'r55LedgerFile', 'r55CommunicationFile', 'r55UploadFeedback', 'r55ErrorPanel']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(js, /request\('\/api\/arrears\/readiness'\)/)
  assert.match(js, /readiness\.uploadReady/)
  assert.match(js, /readiness\.analysisReady/)
  assert.match(js, /readiness\.hash\?\.ready/)
  assert.match(js, /request\('\/api\/arrears\/projects'\)/)
  assert.match(js, /request\('\/api\/arrears\/batches', \{ method: 'POST', body: payload \}\)/)
  assert.match(html, /沟通原文仅作AES密文归档，不进入数据库或云端AI/)
  assert.match(js, /结构化沟通信号/)
  assert.doesNotMatch(js, /脱敏沟通证据/)
  assert.match(js, /normalizeDetails\(payload\.details\)/)
  assert.match(js, /showUploadError\(error\)/)
  assert.doesNotMatch(js, /r55ErrorPanel[\s\S]{0,200}setTimeout[\s\S]{0,100}hidden/)
})

test('R55按后端任务合同显示AI进度并轮询异步运行', () => {
  assert.match(js, /result_count/)
  assert.match(js, /pending_review_count/)
  assert.match(js, /confirmed_review_count/)
  assert.match(js, /active_run_id/)
  assert.match(js, /run_progress/)
  assert.match(js, /request\(`\/api\/arrears\/batches\/\$\{batch\.id\}\/analyze`/)
  assert.match(js, /request\(`\/api\/arrears\/runs\/\$\{runId\}`\)/)
  assert.match(js, /window\.setTimeout\(poll, 2000\)/)
  assert.match(js, /terminalRunStatuses/)
  assert.match(js, /可离开页面后再返回查看进度/)
})

test('R55资源队列使用服务端筛选分页并展示真实欠费和沟通证据', () => {
  for (const id of ['r55ResultSearch', 'r55ReviewStatus', 'r55Cause', 'r55PrevPage', 'r55NextPage', 'r55InspectorBody']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(js, /params\.set\('reviewStatus', reviewStatus\)/)
  assert.match(js, /params\.set\('cause', cause\)/)
  assert.match(js, /params\.set\('q', query\)/)
  assert.match(js, /\/results\?\$\{resultQuery\(page\)\}/)
  assert.match(js, /row\.facts \|\| \{\}/)
  assert.match(js, /facts\.ledgerEvidenceItems/)
  assert.match(js, /row\.communications/)
  assert.match(js, /item\.content \|\| '沟通内容为空'/)
  assert.match(js, /highlightEvidence\(reference\)/)
})

test('R55人工确认和驳回均要求说明并保存后推进下一条', () => {
  assert.match(js, /确认并下一条/)
  assert.match(js, /驳回并下一条/)
  assert.match(js, /if \(!note\)/)
  assert.match(js, /\/api\/arrears\/results\/\$\{row\.id\}\/review/)
  assert.match(js, /method: 'PUT'/)
  assert.match(js, /JSON\.stringify\(\{ status, category, note \}\)/)
  assert.match(js, /selectIndex: currentIndex/)
  assert.match(js, /AI结论只作线索/)
})

test('R55只导出人工确认结果并提供AI运行和审计入口', () => {
  assert.match(html, /id="r55ExportConfirmed"[^>]*>导出已确认结果/)
  assert.match(html, /id="r55RunHistory"[^>]*>AI运行记录/)
  assert.match(html, /id="r55AuditTrail"[^>]*>审计记录/)
  assert.match(js, /\/api\/arrears\/batches\/\$\{batch\.id\}\/export/)
  assert.match(js, /\/api\/arrears\/batches\/\$\{batch\.id\}\/runs\?limit=20/)
  assert.match(js, /\/api\/arrears\/batches\/\$\{batch\.id\}\/audit/)
  assert.match(js, /未确认AI结论未进入文件/)
  assert.match(js, /URL\.revokeObjectURL/)
})

test('R55关键状态、弹窗和移动端Inspector具备可访问交互', () => {
  assert.match(html, /id="r55ErrorPanel" role="alert" tabindex="-1" hidden/)
  assert.match(html, /id="r55Readiness" role="status" aria-live="polite"/)
  assert.match(html, /id="r55Announcer" role="status" aria-live="polite"/)
  assert.match(html, /role="region" aria-label="欠费AI分析结果表，可横向滚动"/)
  assert.match(js, /setAttribute\('aria-modal', 'true'\)/)
  assert.match(js, /trapInspectorFocus/)
  assert.match(js, /event\.key === 'Escape'/)
  assert.match(js, /modal\.showModal\(\)/)
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*\.r55-inspector:not\(\[hidden\]\)[\s\S]*position: fixed/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
})

test('R55保持数据真实性和安全渲染边界', () => {
  assert.doesNotMatch(js, /\.innerHTML\s*=|insertAdjacentHTML|document\.write|eval\s*\(|new Function/)
  assert.doesNotMatch(js, /北京万国城|满庭芳园|青云大厦|16063\.60|5913\.66/)
  assert.doesNotMatch(js, /writesToBillingSystem\s*:\s*true|createsTasks\s*:\s*true/)
  assert.match(html, /不回写收费系统，也不创建催缴任务/)
  assert.match(html, /记录缺失不等于未联系/)
  assert.match(html, /确认结果导出/)
})
