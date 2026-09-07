import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const db = fs.readFileSync(path.join(root, 'server/src/db.ts'), 'utf8')
const route = fs.readFileSync(path.join(root, 'server/src/routes/trends.ts'), 'utf8')

test('R175历史收缴补录具有独立正式表、预览和人工确认门禁', () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS collection_trend_backfills/)
  assert.match(route, /historical-backfills\/preview/)
  assert.match(route, /historical-backfills\/:id\/publish/)
  assert.match(route, /确认发布历史收缴趋势补录/)
  assert.match(route, /历史补录只接受绿仔收缴明细\.json/)
})

test('历史补录不覆盖当前事实表并在读取时复验归档哈希', () => {
  assert.match(route, /只补趋势证据，不覆盖当前经营事实表/)
  assert.match(route, /sha256\(content\) !== record\.source_sha256/)
  assert.match(route, /内容与发布记录不一致/)
  assert.match(route, /for \(const row of publishedHistoricalTrendRows\(\)\) byDate\.set/)
  assert.match(route, /for \(const batch of publishedDailyCollectionBatches\(\)\)/)
  assert.match(route, /lvzai-verified-historical-archive/)
})
