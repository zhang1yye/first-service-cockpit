import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const trends = fs.readFileSync(path.join(root, 'server/src/routes/trends.ts'), 'utf8')
const readme = fs.readFileSync(path.join(root, 'production-overlays/cockpit-r139-weighted-daily-collection-trend-20260827-v1/README.md'), 'utf8')

test('R139 applies the established project-weighted collection methodology everywhere trends are aggregated', () => {
  assert.match(trends, /getCollectionDisplayRate/)
  assert.match(trends, /isCollectionCenterExcluded/)
  assert.match(trends, /applicableCollectionRate/)
  assert.match(trends, /SUM\(receivable \* applicableCollectionRate\) \/ SUM\(receivable\)/)
  assert.match(trends, /official-project-rate-weighted-with-heating-adjustments/)
  assert.match(readme, /普通项目采用绿仔官方项目率/)
  assert.match(readme, /供暖特例采用修正后实收÷应收/)
})

test('R139 rejects simple averages and total-received-over-total-receivable substitutions', () => {
  assert.match(readme, /禁止项目率简单平均/)
  assert.match(readme, /不使用总实收÷总应收替代项目加权/)
  assert.doesNotMatch(trends, /sum \+ Number\(row\.applicableCollectionRate\)[,)]/)
})
