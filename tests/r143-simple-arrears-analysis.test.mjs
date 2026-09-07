import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const payload = path.join(root, 'production-overlays/cockpit-r143-simple-arrears-analysis-20260828-v1/payload')
const runtime = fs.readFileSync(path.join(payload, 'aph2-r143-simple-arrears-analysis.js'), 'utf8')
const styles = fs.readFileSync(path.join(payload, 'aph2-r143-simple-arrears-analysis.css'), 'utf8')
const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')
const productionRuntime = JSON.parse(fs.readFileSync(path.join(root, 'config/production-runtime-r127.json'), 'utf8'))
const backend = fs.readFileSync(path.join(root, 'server/src/arrears-simple-operating-analysis.ts'), 'utf8')

test('R143将欠费经营分析收敛为概况、周期、原因、整改动作和逐户明细', () => {
  for (const copy of ['欠费总额', '欠费户数', '最早欠费账期', '原因明确金额占比', '欠费周期', '欠费原因', 'AI整改建议', '具体动作', '完成标准', '查看房间明细']) assert.match(runtime, new RegExp(copy))
  for (const bucket of ['3个月以内', '4—6个月', '7—12个月', '12个月以上']) assert.match(backend, new RegExp(bucket))
  assert.match(runtime, /serviceCenter=/)
  assert.match(runtime, /operating-analysis/)
})

test('R143逐户仅以房间号识别，不展示姓名、电话或聊天原文', () => {
  assert.doesNotMatch(runtime, /row\.(?:owner|ownerName|phone|mobile|content)\b/)
  assert.match(runtime, /row\.rooms/)
  assert.match(styles, /arrears-simple__room-list/)
})

test('R143保持APH工作面并以渐进展开隐藏复杂明细', () => {
  assert.match(styles, /#cf001b/)
  assert.match(styles, /background:\s*#fff/)
  assert.match(runtime, /arrears-simple__action-rooms/)
  assert.doesNotMatch(runtime, /innerHTML\s*=|insertAdjacentHTML|document\.write/)
  assert.match(index, /aph2-r143-simple-arrears-analysis\.js/)
  assert.match(index, /aph2-r143-simple-arrears-analysis\.css/)
  assert.equal(productionRuntime.frontend.overlayPayload, 'production-overlays/cockpit-r143-simple-arrears-analysis-20260828-v1/payload')
})
