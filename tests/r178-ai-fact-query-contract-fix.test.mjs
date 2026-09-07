import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hermes = fs.readFileSync(path.join(root, 'server/src/hermes-client.ts'), 'utf8')

test('R178纯事实问句不被强制扩写为管理建议', () => {
  assert.match(hermes, /warning信号只说明存在经营异常，不代表用户请求了处置建议/)
  assert.match(hermes, /const asksForAdvice =/)
  assert.match(hermes, /return asksForAdvice\s*\n\s*&& input\.knowledge\.length > 0/)
})
