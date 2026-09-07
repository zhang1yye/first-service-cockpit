import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const overlay = path.join(root, 'production-overlays/cockpit-r168-collection-single-month-comparison-fix-20260831-v1/payload')
const collection = fs.readFileSync(path.join(overlay, 'assets/cockpit-r160-daily-only-20260830-v1/chunk-D3P3MDJ2.js'), 'utf8')
const apiHelper = fs.readFileSync(path.join(overlay, 'assets/cockpit-r160-daily-only-20260830-v1/chunk-J2DCCBRC.js'), 'utf8')

test('R168从已上线R167形成单月环比真实性修复候选', () => {
})

test('只有一个已验证月份时不得把0当上月计算虚假环比', () => {
  assert.match(collection, /b = i2\.length > 1 \? i2\[i2\.length - 2\]\.\\u534E\\u5317\\u6C47\\u603B : Number\.NaN/)
  assert.match(collection, /A = i2\.length > 1 \? g - b : Number\.NaN/)
  assert.match(collection, /r\(A\) \? `\$\{\(A \* 100\)\.toFixed\(2\)\}pp` : "--"/)
})

test('R168继续保留R167正式趋势状态信封兼容', () => {
  assert.match(apiHelper, /Array\.isArray\(t\?\.rows\) \? t\.rows : \[\]/)
})
