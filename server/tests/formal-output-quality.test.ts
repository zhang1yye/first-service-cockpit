import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateFormalMonthlyGate } from '../src/formal-output-quality.js'

test('formal monthly output blocks missing or untrusted period evidence', () => {
  const gate = evaluateFormalMonthlyGate({
    period: '2026-07', expectedProjectCount: 10, snapshotCount: 10,
    invalidSnapshotCount: 10, snapshotRunStatus: 'skipped',
    forecastCount: 10, unlockedForecastCount: 10,
  })
  assert.equal(gate.ready, false)
  assert.equal(gate.reasons.some(reason => reason.includes('快照来源')), true)
  assert.equal(gate.reasons.some(reason => reason.includes('预测')), true)
})

test('formal monthly output requires a complete trusted snapshot and locked forecasts', () => {
  const gate = evaluateFormalMonthlyGate({
    period: '2026-07', expectedProjectCount: 10, snapshotCount: 10,
    invalidSnapshotCount: 0, snapshotRunStatus: 'created',
    forecastCount: 10, unlockedForecastCount: 0,
  })
  assert.deepEqual(gate, { ready: true, status: 'ready', reasons: [] })
})

test('formal monthly output rejects malformed periods', () => {
  const gate = evaluateFormalMonthlyGate({
    period: 'latest', expectedProjectCount: 1, snapshotCount: 1,
    invalidSnapshotCount: 0, snapshotRunStatus: 'created',
    forecastCount: 1, unlockedForecastCount: 0,
  })
  assert.equal(gate.ready, false)
  assert.equal(gate.reasons.some(reason => reason.includes('期间')), true)
})
