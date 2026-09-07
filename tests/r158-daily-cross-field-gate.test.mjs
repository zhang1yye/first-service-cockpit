import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const activeDailyChunk = fs.readFileSync(path.join(
  root,
  'production-overlays/cockpit-r128-screenshot-distillation-20260826-v1/payload/assets/cockpit-r126-arrears-ai-workflow-20260826-v2/chunk-24D7OGMQ.js',
), 'utf8')
const dailyRoute = fs.readFileSync(path.join(root, 'server/src/routes/daily.ts'), 'utf8')

test('R158 daily page preserves null as an em dash and surfaces the API verification note', () => {
  assert.match(activeDailyChunk, /value === null .*? "\\u2014"/)
  assert.match(activeDailyChunk, /daily: Number\.isFinite\(s\.daily\) \? s\.daily : Number\.NaN/)
  assert.match(activeDailyChunk, /e3\.note && p2\(e3\.note\)/)
  assert.match(dailyRoute, /数据待核验/)
  assert.doesNotMatch(dailyRoute, /WHEN s1\.daily_collection IS NULL THEN s1\.cumulative_executed - s2\.cumulative_executed/)
})
