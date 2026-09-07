import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const payload = path.join(root, 'production-overlays/cockpit-r160-daily-only-20260830-v1/payload')
const asset = path.join(payload, 'assets/cockpit-r160-daily-only-20260830-v1/chunk-24D7OGMQ.js')

test('R160 daily UI preserves null cumulative semantics in cells totals and CSV', () => {
  const source = fs.readFileSync(asset, 'utf8')
  assert.match(source, /value === null \|\| value === void 0[^?]+\? "\\u2014"/)
  assert.match(source, /annualValues\.length === r\.length && annualValues\.length \? annualValues\.reduce[^:]+: null/)
  assert.match(source, /csvNumber\(n\.annual_budget\)/)
  assert.match(source, /csvNumber\(n\.today\)/)
  assert.doesNotMatch(source, /Number\(n\.(?:annual_budget|today) \|\| 0\)/)
})

test('R160 immutable frontend entry activates the R160 app tree', () => {
  const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')
  const bootstrap = fs.readFileSync(path.join(payload, 'releases/cockpit-r160-daily-only-20260830-v1/aph2-r160-daily-only-20260830-v1.js'), 'utf8')
  assert.match(index, /cockpit-r160-daily-only-20260830-v1/)
  assert.match(bootstrap, /assets\/cockpit-r160-daily-only-20260830-v1\/app-G7HUEEER\.js/)
})
