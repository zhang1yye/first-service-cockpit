import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'config/production-runtime-r127.json'), 'utf8'))
const orchestrator = fs.readFileSync(path.join(root, 'server/src/assistant-orchestrator.ts'), 'utf8')

test('R180地区单指标事实直接返回并保留单位', () => {
  assert.equal(runtime.release, 'cockpit-r180-deterministic-aph-fact-answers-20260831-v1')
  assert.equal(runtime.frontend.indexSha256, '0962ea3f94a07861b3e4209f867ec4ca3220a60b95c5aa876e239733265771e7')
  assert.equal(runtime.frontend.overlayPayload, 'production-overlays/cockpit-r180-deterministic-aph-fact-answers-20260831-v1/payload')
  assert.match(orchestrator, /function directAphFactAnswer/)
  assert.match(orchestrator, /已验证的地区单指标查询直接返回事实/)
  assert.match(orchestrator, /generatedBy: 'verified-facts'/)
  assert.match(orchestrator, /万元/)
})
