import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const overlay = path.join(root, 'production-overlays/cockpit-r132-direct-service-center-master-20260827-v1/payload')
const index = fs.readFileSync(path.join(overlay, 'index.html'), 'utf8')
const script = fs.readFileSync(path.join(overlay, 'aph2-r132-direct-service-center-master-20260827-v1.js'), 'utf8')
const route = fs.readFileSync(path.join(root, 'server/src/routes/service-center-master.ts'), 'utf8')
const masterState = fs.readFileSync(path.join(root, 'server/src/service-center-master.ts'), 'utf8')
const payments = fs.readFileSync(path.join(root, 'server/src/routes/payments.ts'), 'utf8')
const daily = fs.readFileSync(path.join(root, 'server/src/routes/daily.ts'), 'utf8')
const collections = fs.readFileSync(path.join(root, 'server/src/routes/collections.ts'), 'utf8')
const summary = fs.readFileSync(path.join(root, 'server/src/routes/summary.ts'), 'utf8')
const ai = fs.readFileSync(path.join(root, 'server/src/routes/ai.ts'), 'utf8')
const assistant = fs.readFileSync(path.join(root, 'server/src/routes/regional-assistant.ts'), 'utf8')
const capabilities = fs.readFileSync(path.join(root, 'server/src/routes/operating-capabilities.ts'), 'utf8')

test('R132 removes the marked master-data heading and summary region', () => {
  assert.match(index, /aph2-r132-direct-service-center-master-20260827-v1\.js\?v=r132-direct3/)
  assert.doesNotMatch(script, /r131-page-head/)
  assert.doesNotMatch(script, /r131-summary/)
  assert.doesNotMatch(script, /刷新勾稽/)
})

test('R132 directly edits status, area, and effective date without reason, evidence, preview, or name confirmation fields', () => {
  assert.match(script, /<span>管理状态<\/span><select name="newStatus"/)
  assert.match(script, /<option value="已撤场"/)
  assert.match(script, /name="newArea"/)
  assert.match(script, /name="effectiveDate"/)
  assert.match(script, /保存并联动/)
  assert.match(script, /syncAreaField/)
  assert.match(script, /type="hidden" name="reason" value="管理员直接调整服务中心主数据"/)
  assert.match(script, /type="hidden" name="confirmation"/)
  assert.doesNotMatch(script, /<span>变更原因<\/span>/)
  assert.doesNotMatch(script, /变更依据（选填）/)
  assert.doesNotMatch(script, /预览影响/)
  assert.doesNotMatch(script, /data-r131-confirmation/)
})

test('R132 posts the direct change while preserving concurrency, audit, and history', () => {
  assert.match(script, /submitDirectChange/)
  assert.match(script, /body\.expectedVersion = Number\(form\.dataset\.version\)/)
  assert.match(script, /\/changes`/)
  assert.match(script, /state\.busy = false\s+closeDialog\(\); state\.payload = null; await load\(\)/)
  assert.match(script, /cockpit:master-data-changed/)
  assert.match(script, /setTimeout\(\(\) => location\.reload\(\), 120\)/)
  assert.doesNotMatch(route, /confirmation !== result\.serviceCenter/)
  assert.match(route, /管理员直接调整服务中心主数据/)
  assert.match(route, /logOperationStrict\(req, '变更服务中心主数据'/)
  assert.match(route, /currentMasterVersion\(key\) !== expectedVersion/)
})

test('R132 keeps withdrawn centers and projects them into the withdrawn-project area systemwide', () => {
  assert.match(masterState, /SERVICE_CENTER_WITHDRAWN_AREA = '撤场项目'/)
  assert.match(masterState, /status === SERVICE_CENTER_WITHDRAWN[\s\S]*?SERVICE_CENTER_WITHDRAWN_AREA/)
  assert.doesNotMatch(masterState, /effective\.status !== SERVICE_CENTER_ACTIVE/)

  assert.match(payments, /applyEffectiveMasterState/)
  assert.match(payments, /filter\(row => !area \|\| area === '全部' \|\| row\.area === area\)/)
  assert.match(daily, /applyEffectiveMasterState\(sourceRows, \{ asOf: date \}\)/)
  assert.match(collections, /applyEffectiveMasterState\(lvzai\.rows\)/)
  assert.match(collections, /area: r\.area/)
  assert.match(summary, /applyEffectiveMasterState\(paymentSourceRows\)/)
  assert.match(summary, /applyEffectiveMasterState\(formal\.dataset\?\.rows \|\| \[\]\)/)
  assert.match(ai, /applyEffectiveMasterState/)
  assert.match(assistant, /applyEffectiveMasterState/)
  assert.match(capabilities, /applyEffectiveMasterState/)
})
