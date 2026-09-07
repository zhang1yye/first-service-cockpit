import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const regional = fs.readFileSync(path.join(root, 'server/src/routes/regional-assistant.ts'), 'utf8')

test('R179驾驶舱AI与首页共用精确APH卡片字段', () => {
  assert.match(regional, /const exactValues = raw\?\.\['华北地区'\]\?\.回款额/)
  assert.match(regional, /const hasExactProvenance = exactFields\.every/)
  assert.match(regional, /readOptionalNumber\(exactValues\['累计预算_万'\]\)/)
  assert.match(regional, /不使用其中可能已按报表展示精度四舍五入的数值/)
})
