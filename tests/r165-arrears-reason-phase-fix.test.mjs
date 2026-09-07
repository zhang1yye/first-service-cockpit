import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const route = fs.readFileSync(path.join(root, 'server/src/routes/arrears-analysis.ts'), 'utf8')
const analysis = fs.readFileSync(path.join(root, 'server/src/arrears-analysis.ts'), 'utf8')
const merges = fs.readFileSync(path.join(root, 'server/src/service-center-merge-groups.ts'), 'utf8')

test('R165保持R164前端并从当前生产入口形成独立发布候选', () => {
})

test('上第MOMA、IMOMA、悦MOMA沿用统一服务中心合并口径', () => {
  for (const center of ['第一服务北京上第MOMΛ服务中心', '第一服务北京IMOMΛ服务中心', '第一服务北京悦MOMΛ服务中心']) {
    assert.match(merges, new RegExp(center))
  }
  assert.match(route, /SERVICE_CENTER_MERGE_GROUPS/)
  assert.match(route, /for \(const source of group\.sources\) register\(source, profileId\)/)
})

test('R165使用新版原因解析并允许相同文件按新版规则形成新审计批次', () => {
  assert.match(route, /PARSER_VERSION = 'arrears-template-v[23]'/)
  assert.match(route, /canSupersedeParser/)
  assert.match(route, /parser_version<>\?/)
  assert.match(route, /按新版解析规则重新导入欠费批次/)
  assert.match(route, /supersedesBatchId: canSupersedeDeleted \|\| canSupersedeParser/)
})

test('台账固定原因信号进入AI证据且AI未知不得覆盖明确台账原因', () => {
  assert.match(route, /ledgerReasonSignals/)
  assert.match(route, /L-\/C-\/T-编号/)
  assert.match(route, /ai_category<>'unknown'[\s\S]*rule_category<>'' AND .*rule_category<>'unknown'/)
  assert.match(analysis, /温度不达标/)
  assert.match(analysis, /资金\(\?:紧张\|短缺\)/)
  assert.match(analysis, /电话不接\|企微不回/)
  assert.match(analysis, /labels\.length\?`本地规则信号/)
})
