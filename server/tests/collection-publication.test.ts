import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCollectionPublication } from '../src/collection-publication.js'

const qualityReady = { ready: true, status: 'available', stale: false, reasons: [] }

const validSummary = {
  collectionRate: 0.6317,
  receivable_万: 16063.73,
  received_万: 10080.10,
  outstanding_万: 5907.25,
  source: '绿仔管家·新收费率统计',
  extractedAt: '2026-08-08T21:31:09.756266+08:00',
  date: '2026-08-08',
  periodCorrection: {
    correctedRate: 0.6317,
    rateField: 'gatheringCurrentYearRecedRate',
    rateAggregation: '按receCurrentPeriod对应收加权官方项目率',
    rule: '全年合计减去指定项目自然年度供暖费，再加供暖季账期金额',
  },
}

test('formal collection publication uses the validated corrected rate and exposes provenance', () => {
  const publication = buildCollectionPublication(validSummary, qualityReady, {
    publicationStatus: 'published',
    lastValidatedAt: '2026-08-08T21:31:09.757478+08:00',
  })
  assert.equal(publication.publicationStatus, 'published')
  assert.equal(publication.collectionRate, 0.6317)
  assert.equal(publication.collectionReceivable, 16063.73)
  assert.equal(publication.collectionReceived, 10080.10)
  assert.equal(publication.collectionOutstanding, 5907.25)
  assert.equal(publication.businessDate, '2026-08-08')
  assert.equal(publication.extractedAt, validSummary.extractedAt)
  assert.equal(publication.lastValidatedAt, '2026-08-08T21:31:09.757478+08:00')
  assert.match(publication.methodologyVersion, /gatheringCurrentYearRecedRate/)
  assert.equal(publication.sourceStatus, 'available')
})

test('a raw/corrected rate mismatch fails closed instead of selecting either value', () => {
  const publication = buildCollectionPublication(
    { ...validSummary, collectionRate: 0.9999 },
    qualityReady,
    { publicationStatus: 'published', lastValidatedAt: '2026-08-08T21:31:09.757478+08:00' },
  )
  assert.equal(publication.publicationStatus, 'blocked')
  assert.equal(publication.collectionRate, null)
  assert.match(publication.fallbackReason, /正式修正率不一致/)
})

test('missing correction evidence is blocked and never recomputed from amount totals', () => {
  const { periodCorrection: _ignored, ...withoutCorrection } = validSummary
  const publication = buildCollectionPublication(
    withoutCorrection,
    qualityReady,
    { publicationStatus: 'published', lastValidatedAt: '2026-08-08T21:31:09.757478+08:00' },
  )
  assert.equal(publication.publicationStatus, 'blocked')
  assert.equal(publication.collectionRate, null)
  assert.match(publication.fallbackReason, /缺少正式修正口径证据/)
})

test('stale or unpublished source remains visible as metadata but has no formal KPI', () => {
  const publication = buildCollectionPublication(
    validSummary,
    { ready: false, status: 'stale', stale: true, reasons: ['超过72小时'] },
    { publicationStatus: 'unpublished', lastValidatedAt: null },
  )
  assert.equal(publication.publicationStatus, 'unpublished')
  assert.equal(publication.collectionRate, null)
  assert.equal(publication.businessDate, '2026-08-08')
  assert.equal(publication.sourceStatus, 'stale')
})
