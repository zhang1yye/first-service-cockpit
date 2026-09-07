import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const payload = path.join(root, 'production-overlays/cockpit-r142-qxm-sharded-evidence-20260828-v1/payload')
const runtime = fs.readFileSync(path.join(payload, 'aph2-r142-qxm-sharded-evidence.js'), 'utf8')
const styles = fs.readFileSync(path.join(payload, 'aph2-r142-qxm-sharded-evidence.css'), 'utf8')
const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')

test('R142欠费页展示按服务中心授权的企小码分片覆盖状态', () => {
  assert.match(runtime, /payload\?\.qxmCoverage/)
  assert.match(runtime, /serviceCenter/)
  assert.match(runtime, /自动关联率/)
  assert.match(runtime, /自动隔离/)
  assert.match(runtime, /同步超时/)
  assert.match(styles, /arrears-qxm-coverage/)
})

test('R142逐户建议展示确定性双向沟通指标且不把人工台账当实时状态', () => {
  assert.match(runtime, /row\.communicationFacts/)
  assert.match(runtime, /最近员工发出/)
  assert.match(runtime, /最近客户回复/)
  assert.match(runtime, /双向沟通/)
  assert.match(runtime, /历史人工记录，不代表最新沟通/)
})

test('R142入口使用新的不可变JS和CSS资源', () => {
  assert.match(index, /aph2-r142-qxm-sharded-evidence\.js/)
  assert.match(index, /aph2-r142-qxm-sharded-evidence\.css/)
  assert.doesNotMatch(index, /aph2-r141-arrears-evidence-v1\.(?:js|css)/)
})
