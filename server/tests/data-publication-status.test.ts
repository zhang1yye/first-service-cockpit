import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyPublicationStatus } from '../src/data-publication-status.js'

const readySources = [
  { sourceKey: 'aph', name: 'APH回款', businessDate: '2026-08-08', status: 'ready' as const },
  { sourceKey: 'finereport', name: '中心明细', businessDate: '2026-08-08', status: 'ready' as const },
  { sourceKey: 'lvzai', name: '绿仔收缴', businessDate: '2026-08-08', status: 'ready' as const },
]

const completeInput = {
  asOfDate: '2026-08-09',
  requiredSourceKeys: ['aph', 'finereport', 'lvzai'],
  sources: readySources,
  latestBatch: { id: 8, businessDate: '2026-08-08', status: 'published' as const, publishedAt: '2026-08-08 22:00:00' },
  latestPublication: { batchId: 8, businessDate: '2026-08-08', publishedAt: '2026-08-08 22:00:00' },
  audits: readySources.map(source => ({ sourceKey: source.sourceKey, batchId: 8, businessDate: '2026-08-08', status: 'success' as const })),
}

test('only aligned required sources, publication and per-source audits are complete', () => {
  const result = classifyPublicationStatus(completeInput)
  assert.equal(result.code, 'complete')
  assert.equal(result.label, '已完整发布')
  assert.equal(result.businessDate, '2026-08-08')
  assert.equal(result.officialBusinessDate, '2026-08-08')
  assert.equal(result.isComplete, true)
  assert.deepEqual(result.missingSourceKeys, [])
})

test('sources advancing beyond the formal publication is reported as partial rather than complete', () => {
  const result = classifyPublicationStatus({
    ...completeInput,
    latestBatch: { id: 5, businessDate: '2026-08-05', status: 'published', publishedAt: '2026-08-05 22:00:00' },
    latestPublication: { batchId: 5, businessDate: '2026-08-05', publishedAt: '2026-08-05 22:00:00' },
    audits: readySources.map(source => ({ sourceKey: source.sourceKey, batchId: 5, businessDate: '2026-08-05', status: 'success' as const })),
  })
  assert.equal(result.code, 'partial')
  assert.equal(result.label, '部分更新')
  assert.equal(result.businessDate, '2026-08-08')
  assert.equal(result.officialBusinessDate, '2026-08-05')
  assert.deepEqual(result.advancedSourceKeys, ['aph', 'finereport', 'lvzai'])
  assert.match(result.summary, /正式发布.*2026-08-05/)
})

test('a blocked latest batch for the advanced business date is a failed update', () => {
  const result = classifyPublicationStatus({
    ...completeInput,
    latestBatch: { id: 9, businessDate: '2026-08-08', status: 'blocked', publishedAt: null },
    latestPublication: { batchId: 5, businessDate: '2026-08-05', publishedAt: '2026-08-05 22:00:00' },
    audits: [],
  })
  assert.equal(result.code, 'failed')
  assert.equal(result.label, '更新失败')
  assert.equal(result.isComplete, false)
  assert.match(result.summary, /门禁|失败/)
})

test('published data without complete source audits remains unknown and never claims success', () => {
  const result = classifyPublicationStatus({ ...completeInput, audits: completeInput.audits.slice(0, 2) })
  assert.equal(result.code, 'unknown')
  assert.equal(result.label, '结果未知')
  assert.equal(result.isComplete, false)
  assert.deepEqual(result.missingAuditSourceKeys, ['lvzai'])
})

test('missing source dates remain unknown instead of being converted to zero or today', () => {
  const result = classifyPublicationStatus({
    asOfDate: '2026-08-09',
    requiredSourceKeys: ['aph', 'finereport', 'lvzai'],
    sources: readySources.map(source => ({ ...source, businessDate: null, status: 'unknown' as const })),
    latestBatch: null,
    latestPublication: null,
    audits: [],
  })
  assert.equal(result.code, 'unknown')
  assert.equal(result.businessDate, null)
  assert.deepEqual(result.missingSourceKeys, ['aph', 'finereport', 'lvzai'])
})
