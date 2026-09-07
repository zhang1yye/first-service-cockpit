import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assetRoot = path.join(root, 'firstcare-cloud-local', 'assets', 'sortfix-20260806-percentcap1')
const readAsset = (name) => fs.readFileSync(path.join(assetRoot, name), 'utf8')

test('经营数据 CSV 导出统一保留两位小数', () => {
  const daily = readAsset('chunk-24D7OGMQ.js')
  const payment = readAsset('chunk-5G47Z27Q.js')
  const collection = readAsset('chunk-D3P3MDJ2.js')

  assert.match(daily, /Number\(n\.annual_budget \|\| 0\)\.toFixed\(2\)/)
  assert.match(daily, /Number\(n\.daily \|\| 0\)\.toFixed\(2\)/)
  assert.match(payment, /Number\(r2\.annualBudget \|\| 0\)\.toFixed\(2\)/)
  assert.match(payment, /Number\(r2\.samePeriod \|\| 0\)\.toFixed\(2\)/)
  assert.match(collection, /Number\(j\.receivable \|\| 0\)\.toFixed\(2\)/)
  assert.match(collection, /Number\(j\.overdue90 \|\| 0\)\.toFixed\(2\)/)
})
