import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const summary = fs.readFileSync(path.join(root, 'server/src/routes/summary.ts'), 'utf8')

test('R174管理员首页采用通过门禁的APH华北正式卡片值', () => {
  assert.match(summary, /const annualBudget = isAdmin \? aph\?\.annualBudget \?\? null/)
  assert.match(summary, /const cumulativeExecuted = isAdmin \? aph\?\.cumulativeExecuted \?\? null/)
  assert.match(summary, /const cumulativeBudget = isAdmin \? aph\?\.cumulativeBudget \?\? null/)
  assert.match(summary, /const samePeriod = isAdmin \? aph\?\.samePeriod \?\? null/)
  assert.match(summary, /服务中心明细合计只用于受限账号的授权范围/)
})
