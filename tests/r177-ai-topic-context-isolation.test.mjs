import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const orchestrator = fs.readFileSync(path.join(root, 'server/src/assistant-orchestrator.ts'), 'utf8')
const hermes = fs.readFileSync(path.join(root, 'server/src/hermes-client.ts'), 'utf8')

test('R177地区APH问答隔离中心明细和对账数字', () => {
  assert.match(orchestrator, /地区APH问答只向模型发送正式卡片事实/)
  assert.match(orchestrator, /if \(topic === 'aph'\) return \{\s*\n\s*facts:/)
  assert.doesNotMatch(orchestrator, /if \(topic === 'aph'\) return \{ aph: context\.aph/)
})

test('单指标问答禁止单位换算和附带其他数字', () => {
  assert.match(hermes, /用户只询问一个指标时，只回答该指标/)
  assert.match(hermes, /不换算单位、不附带其他数字/)
  assert.match(hermes, /只作不含额外数字的文字提示/)
})
