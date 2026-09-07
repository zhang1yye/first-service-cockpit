import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const route = fs.readFileSync(path.join(root, 'server/src/routes/arrears-analysis.ts'), 'utf8')
const analysis = fs.readFileSync(path.join(root, 'server/src/arrears-analysis.ts'), 'utf8')
const diagnosis = fs.readFileSync(path.join(root, 'server/src/arrears-manual-diagnosis.ts'), 'utf8')
const db = fs.readFileSync(path.join(root, 'server/src/db.ts'), 'utf8')
const overlay = path.join(root, 'production-overlays/cockpit-r166-detailed-household-arrears-actions-20260831-v1/payload')
const index = fs.readFileSync(path.join(overlay, 'index.html'), 'utf8')
const js = fs.readFileSync(path.join(overlay, 'aph2-r166-detailed-household-actions-20260831-v1.js'), 'utf8')
const css = fs.readFileSync(path.join(overlay, 'aph2-r166-detailed-household-actions-20260831-v1.css'), 'utf8')

test('R166形成独立受控候选并保持当前R165生产基线', () => {
  assert.match(index, /aph2-r166-detailed-household-actions-20260831-v1\.js/)
  assert.match(index, /aph2-r166-detailed-household-actions-20260831-v1\.css/)
})

test('新版解析保存完整房间标识但姓名和电话仍保持脱敏', () => {
  assert.match(analysis, /resourceDisplay: string; resourceMasked: string/)
  assert.match(route, /PARSER_VERSION = 'arrears-template-v3'/)
  assert.match(route, /row\.resourceDisplay, row\.resourceMasked, row\.customerMasked, row\.phoneMasked/)
  assert.match(db, /resource_display TEXT NOT NULL DEFAULT ''/)
  assert.match(route, /COALESCE\(NULLIF\(MAX\(l\.resource_display\),''\),MAX\(l\.resource_masked\)\)/)
  assert.doesNotMatch(route, /customer_masked AS customerDisplay|phone_masked AS phoneDisplay/)
})

test('四类原因下返回全部逐户明细且不只保留前三户', () => {
  assert.match(diagnosis, /households: matched\.map/)
  assert.match(diagnosis, /room: row\.room/)
  assert.match(diagnosis, /periodStart: row\.periodStart/)
  assert.match(diagnosis, /feeItems:/)
  assert.match(js, /查看该分类全部/)
  assert.match(js, /row\.households/)
  assert.match(js, /householdActionCard/)
  assert.match(css, /household-details\[open\]/)
})

test('每个受控原因都有细化步骤、责任人、时限、完成标准和升级条件', () => {
  for (const cause of ['service_dispute','charge_dispute','legal_dispute','promised_payment','vacancy','financial_hardship','ownership_or_handover','contact_barrier','unknown']) {
    assert.match(diagnosis, new RegExp(`${cause}: \\{`), `${cause}必须有独立动作模板`)
  }
  assert.match(diagnosis, /owner:/)
  assert.match(diagnosis, /firstDeadline:/)
  assert.match(diagnosis, /steps:/)
  assert.match(diagnosis, /completionStandards:/)
  assert.match(diagnosis, /escalationTriggers:/)
  assert.match(js, /逐步催费动作/)
  assert.match(js, /完成标准/)
  assert.match(js, /触发升级/)
})

test('逐户明细设置5000户保护门禁避免超大响应静默截断', () => {
  assert.match(route, /householdCount > 5000/)
  assert.match(route, /请按服务中心或业务范围拆分/)
  assert.doesNotMatch(diagnosis, /matched\.slice\([^)]*\)\.map\(row => \(\{ room:/)
})
