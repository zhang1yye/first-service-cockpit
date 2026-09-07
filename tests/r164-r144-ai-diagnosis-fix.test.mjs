import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const payload = path.join(root, 'production-overlays/cockpit-r164-r144-ai-diagnosis-fix-20260831-v1/payload')
const source = name => fs.readFileSync(path.join(payload, name), 'utf8')

test('R164从已上线R163形成独立AI诊断修复候选', () => {
  const index = source('index.html')
  assert.match(index, /aph2-r164-r144-ai-diagnosis-20260831-v1\.js/)
  assert.doesNotMatch(index, /aph2-r163-r144-arrears-diagnosis-20260831-v1\.js/)
})

test('R164上传后启动云端AI、轮询完成状态并显示模型状态', () => {
  const script = source('aph2-r164-r144-ai-diagnosis-20260831-v1.js')
  assert.match(script, /\/api\/arrears\/batches\/\$\{batchId\}\/analyze/)
  assert.match(script, /waitForAi/)
  assert.match(script, /run_progress/)
  assert.match(script, /AI分析中/)
  assert.match(script, /batch\.status === 'analyzed'/)
  assert.match(script, /batch\.status === 'rule_only'/)
  assert.match(script, /payload\.ai\?\.status === 'ok'/)
  assert.match(script, /cache: 'no-store'/)
})

test('R164相同文件复用后端返回的已有批次而不是停在409', () => {
  const script = source('aph2-r164-r144-ai-diagnosis-20260831-v1.js')
  const route = fs.readFileSync(path.join(root, 'server/src/routes/arrears-analysis.ts'), 'utf8')
  for (const field of ['ARREARS_DUPLICATE_BATCH', 'existingBatchId', 'existingStatus', 'reusable']) {
    assert.match(script, new RegExp(field))
    assert.match(route, new RegExp(field))
  }
  assert.match(script, /继续使用批次#/)
  assert.doesNotMatch(script, /match\([^)]*批次#|exec\([^)]*批次#/, '前端不得从错误文案猜测批次ID')
})

test('R164诊断接口明确返回实际AI状态与模型，不把规则结果冒充AI', () => {
  const route = fs.readFileSync(path.join(root, 'server/src/routes/arrears-analysis.ts'), 'utf8')
  assert.match(route, /status: String\(batch\.ai_status \|\| ''\)/)
  assert.match(route, /model: String\(batch\.ai_model \|\| ''\)/)
  assert.match(route, /completed: batch\.status === 'analyzed' && batch\.ai_status === 'ok'/)
})
