import assert from 'node:assert/strict'
import test from 'node:test'
import { canUseDemoData, canUseManualImport, calculateGrowth, readOptionalNumber } from '../src/production-safety.js'

test('production never permits business demo data even when flag is set', () => {
  assert.equal(canUseDemoData({ NODE_ENV: 'production', COCKPIT_ALLOW_DEMO_DATA: 'true' }), false)
})

test('non-production requires an explicit demo flag', () => {
  assert.equal(canUseDemoData({ NODE_ENV: 'development' }), false)
  assert.equal(canUseDemoData({ NODE_ENV: 'test', COCKPIT_ALLOW_DEMO_DATA: 'false' }), false)
  assert.equal(canUseDemoData({ NODE_ENV: 'development', COCKPIT_ALLOW_DEMO_DATA: 'true' }), true)
})

test('production accepts formal data only through P46, never manual Excel preview or confirm', () => {
  assert.equal(canUseManualImport({ NODE_ENV: 'production' }), false)
  assert.equal(canUseManualImport({ NODE_ENV: 'development' }), true)
  assert.equal(canUseManualImport({ NODE_ENV: 'test' }), true)
})

test('growth is null when the baseline is missing, invalid, or zero', () => {
  assert.equal(calculateGrowth(100, null), null)
  assert.equal(calculateGrowth(100, undefined), null)
  assert.equal(calculateGrowth(100, 0), null)
  assert.equal(calculateGrowth(null, 80), null)
})

test('growth uses only real current and baseline values', () => {
  assert.equal(calculateGrowth(90, 100), -0.1)
  assert.equal(calculateGrowth(0, 100), -1)
})

test('optional source numbers preserve missing values instead of coercing them to zero', () => {
  assert.equal(readOptionalNumber(undefined), null)
  assert.equal(readOptionalNumber(null), null)
  assert.equal(readOptionalNumber(''), null)
  assert.equal(readOptionalNumber('not-a-number'), null)
  assert.equal(readOptionalNumber(0), 0)
  assert.equal(readOptionalNumber('12.5'), 12.5)
})
