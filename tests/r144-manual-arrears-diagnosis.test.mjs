import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const payload = path.join(root, 'production-overlays/cockpit-r144-manual-arrears-diagnosis-20260828-v1/payload')

function source(name) {
  return fs.readFileSync(path.join(payload, name), 'utf8')
}

test('R144页面严格保留用户原型内容且不引入旧产品模块', () => {
  const runtime = source('aph2-r144-manual-arrears-diagnosis-20260828-v1.js')
  for (const copy of [
    'AI欠费经营诊断',
    '选择服务中心，直接查看欠费原因、涉及业主和建议管理动作',
    '生成经营诊断',
    '分析依据',
    '整体判断',
    '原因汇总分析',
    '服务质量或沟通争议',
    '承诺缴费但未兑现',
    '欠费原因证据不足',
    '失联或产权信息待确认',
    '合理判断',
    '已知事实',
    '待核实',
    '完成重点户原因复核',
    '先解决服务争议，再恢复催缴',
    '集中追踪承诺未兑现户',
    '核实失联及产权信息',
    '原因结构',
    '优先调查名单',
  ]) assert.match(runtime, new RegExp(copy))
  for (const forbidden of ['绿仔', '欠费周期', 'AI整改建议', '查看房间明细', '任务派发', '评分']) assert.doesNotMatch(runtime, new RegExp(forbidden))
})

test('R144欠费台账必选聊天选填并只读取上传批次诊断', () => {
  const runtime = source('aph2-r144-manual-arrears-diagnosis-20260828-v1.js')
  assert.match(runtime, /\/api\/arrears\/projects/)
  assert.match(runtime, /\/api\/arrears\/batches/)
  assert.match(runtime, /\/diagnosis/)
  assert.match(runtime, /new FormData/)
  assert.match(runtime, /ledgerInput\.required\s*=\s*true/)
  assert.match(runtime, /communicationInput\.required\s*=\s*false/)
  assert.match(runtime, /\.accept\s*=\s*['"]\.xlsx,\.xls,\.csv['"]/, '欠费台账和聊天附件仅允许表格文件')
  assert.match(runtime, /if\s*\(communicationFile\)/)
  assert.doesNotMatch(runtime, /connectors\/operating-analysis|connectors\/status/)
  assert.doesNotMatch(runtime, /innerHTML\s*=|insertAdjacentHTML|document\.write/)
})

test('R144沿用APH原型桌面网格并提供移动端重排', () => {
  const styles = source('aph2-r144-manual-arrears-diagnosis-20260828-v1.css')
  const index = source('index.html')
  assert.match(styles, /#cf001b/)
  assert.match(styles, /grid-template-columns:\s*minmax\(0,2fr\)\s+minmax\(280px,1fr\)/)
  assert.match(styles, /@media\s*\(max-width:\s*720px\)/)
  assert.match(styles, /min-height:\s*44px/)
  assert.match(index, /aph2-r144-manual-arrears-diagnosis-20260828-v1\.js/)
  assert.match(index, /aph2-r144-manual-arrears-diagnosis-20260828-v1\.css/)
  assert.doesNotMatch(index, /aph2-r143-simple-arrears-analysis/)
})
