import assert from 'node:assert/strict'
import test from 'node:test'
import type { CollectionPublication } from '../src/collection-publication.js'
import { buildServiceCenterAnalysis } from '../src/service-center-analysis.js'

const collectionPublication: CollectionPublication = {
  collectionRate: 0.75,
  collectionReceivable: 3500,
  collectionReceived: 2625,
  collectionOutstanding: 875,
  source: '绿仔正式收缴数据集',
  extractedAt: '2026-08-12T08:00:00+08:00',
  businessDate: '2026-08-12',
  lastValidatedAt: '2026-08-12T08:05:00+08:00',
  methodologyVersion: 'lvzai:gatheringCurrentYearRecedRate:weighted:v1',
  publicationStatus: 'published',
  sourceStatus: 'available',
  stale: false,
  fallbackReason: null,
  periodCorrection: {
    rateField: 'gatheringCurrentYearRecedRate',
    rateAggregation: '按应收加权官方项目率',
    rule: '仅使用已验证官方字段',
  },
  sourceQuality: { ready: true, status: 'available', stale: false, rowCount: 35, reasons: [] },
}

function fixture() {
  const payments = Array.from({ length: 56 }, (_, offset) => {
    const number = offset + 1
    return {
      id: number,
      area: number <= 28 ? '朝阳片区' : '河北片区',
      center: `第一服务测试·${String(number).padStart(2, '0')}服务中心`,
      annual_budget: 200,
      cumulative_budget: 100,
      cumulative_executed: number === 1 ? 90 : 110,
      same_period: number === 3 ? 0 : 100,
    }
  })
  const latestDailyRows = payments.slice(0, 55).map((payment, index) => ({
    center: payment.center,
    annual_budget: payment.annual_budget,
    cumulative_budget: payment.cumulative_budget,
    cumulative_executed: payment.cumulative_executed,
    daily_collection: index === 1 ? 0 : 2,
    source: 'FineReport三报表中心明细',
    business_date: '2026-08-12',
    last_validated_at: '2026-08-12T08:05:00+08:00',
  }))
  const formalCollectionRows = payments.slice(0, 35).map((payment, index) => ({
    // 源名与APH名称不同时，必须使用P46已确认的规范名合并。
    center: `绿仔源中心${index + 1}`,
    canonicalCenter: payment.center,
    collectionRate: index === 0 ? 0.75 : index === 2 ? 0.8 : 0.85,
    receivable: 100,
    source: '绿仔正式收缴明细',
  }))
  return { payments, latestDailyRows, formalCollectionRows }
}

test('56个APH中心每中心恰好一次，正式收缴按规范名合并且缺失不补0', () => {
  const data = fixture()
  const result = buildServiceCenterAnalysis({
    ...data,
    dailyBusinessDate: '2026-08-12',
    collectionPublication,
    paymentPublication: {
      publicationStatus: 'partial', businessDate: '2026-08-12',
      lastValidatedAt: '2026-08-12T08:05:00+08:00', source: 'aph-finereport-lvzai',
    },
    allowedAreas: null,
  })

  assert.equal(result.rows.length, 56)
  assert.equal(new Set(result.rows.map(row => row.center)).size, 56)
  assert.equal(result.summary.total, 56)
  assert.equal(result.summary.dataComplete, 35)
  assert.equal(result.summary.dataPartial, 21)
  assert.equal(result.collectionPublicationStatus, 'published')

  const first = result.rows.find(row => row.id === 1)!
  assert.equal(first.metrics.officialCollectionRate, 0.75)
  assert.equal(first.metrics.cumulativeBudgetGap, -10)
  assert.equal(first.metrics.yoyGrowth, -0.1)
  assert.deepEqual(first.signals.map(signal => signal.code).sort(), [
    'cumulative-budget-gap', 'official-collection-below-threshold', 'yoy-decline',
  ])
  assert.equal(first.operatingStatus, 'attention')
  assert.ok(first.recommendations.length >= 3)

  const withoutFormal = result.rows.find(row => row.id === 36)!
  assert.equal(withoutFormal.metrics.officialCollectionRate, null)
  assert.equal(withoutFormal.availability.officialCollection, 'missing')
  assert.equal(withoutFormal.evidence.officialCollection, null)

  const verifiedZero = result.rows.find(row => row.id === 2)!
  assert.equal(verifiedZero.metrics.dailyCollection, 0)
  assert.equal(verifiedZero.availability.daily, 'available')

  const zeroBaseline = result.rows.find(row => row.id === 3)!
  assert.equal(zeroBaseline.metrics.samePeriod, 0)
  assert.equal(zeroBaseline.metrics.yoyGrowth, null)
  assert.equal(zeroBaseline.signals.some(signal => signal.code === 'yoy-decline'), false)
  assert.equal(zeroBaseline.signals.some(signal => signal.code === 'official-collection-below-threshold'), false)
})

test('日回款缺失只改变数据状态，不制造经营预警', () => {
  const data = fixture()
  const result = buildServiceCenterAnalysis({
    ...data,
    dailyBusinessDate: '2026-08-12',
    collectionPublication,
    paymentPublication: {
      publicationStatus: 'partial', businessDate: '2026-08-12',
      lastValidatedAt: '2026-08-12T08:05:00+08:00', source: 'aph-finereport-lvzai',
    },
    allowedAreas: null,
  })
  const missingDaily = result.rows.find(row => row.id === 56)!
  assert.equal(missingDaily.metrics.dailyCollection, null)
  assert.equal(missingDaily.dataStatus, 'partial')
  assert.equal(missingDaily.operatingStatus, 'stable')
  assert.equal(missingDaily.signals.length, 0)
  assert.match(missingDaily.recommendations.join(''), /不记为0/)
})

test('未发布收缴源不泄露指标，也不用实收应收反算', () => {
  const data = fixture()
  const result = buildServiceCenterAnalysis({
    ...data,
    dailyBusinessDate: '2026-08-12',
    collectionPublication: { ...collectionPublication, publicationStatus: 'blocked', collectionRate: null },
    paymentPublication: {
      publicationStatus: 'partial', businessDate: '2026-08-12',
      lastValidatedAt: '2026-08-12T08:05:00+08:00', source: 'aph-finereport-lvzai',
    },
    allowedAreas: null,
  })
  assert.equal(result.rows.every(row => row.metrics.officialCollectionRate === null), true)
  assert.equal(result.rows.every(row => row.signals.every(signal => signal.code !== 'official-collection-below-threshold')), true)
})

test('供暖项目复用收缴页金额修正口径，普通项目仍使用官方字段', () => {
  const payments = [
    {
      id: 1, area: '朝阳片区', center: '第一服务北京万国城MOMΛ服务中心',
      annual_budget: 200, cumulative_budget: 100, cumulative_executed: 100, same_period: 100,
    },
    {
      id: 2, area: '京东片区', center: '第一服务北京通州万国城MOMΛ服务中心',
      annual_budget: 200, cumulative_budget: 100, cumulative_executed: 100, same_period: 100,
    },
  ]
  const result = buildServiceCenterAnalysis({
    payments,
    latestDailyRows: payments.map(payment => ({
      center: payment.center, annual_budget: 200, cumulative_budget: 100,
      cumulative_executed: 100, daily_collection: 0, source: 'FineReport三报表中心明细',
      business_date: '2026-08-12', last_validated_at: '2026-08-12T08:05:00+08:00',
    })),
    dailyBusinessDate: '2026-08-12',
    formalCollectionRows: [
      {
        center: '绿仔万国城', canonicalCenter: payments[0].center,
        collectionRate: 0.7478, receivable: 2236.69, received: 1635.69,
      },
      {
        center: '绿仔通州万国城', canonicalCenter: payments[1].center,
        collectionRate: 0.7502, receivable: 1, received: 0.5,
      },
    ],
    collectionPublication,
    paymentPublication: {
      publicationStatus: 'partial', businessDate: '2026-08-12',
      lastValidatedAt: '2026-08-12T08:05:00+08:00', source: 'FineReport已验证快照',
    },
    allowedAreas: null,
  })

  const heating = result.rows.find(row => row.id === 1)!
  const ordinary = result.rows.find(row => row.id === 2)!
  assert.equal(heating.metrics.officialCollectionRate, 0.7313)
  assert.equal(heating.evidence.officialCollection?.methodology, 'heating-adjusted-received-over-receivable')
  assert.match(heating.evidence.officialCollection?.rule || '', /供暖期间金额修正/)
  assert.equal(ordinary.metrics.officialCollectionRate, 0.7502)
  assert.notEqual(ordinary.evidence.officialCollection?.methodology, 'heating-adjusted-received-over-receivable')
})

test('普通项目缺少官方收缴率时保持缺失，不用实收应收反算', () => {
  const result = buildServiceCenterAnalysis({
    payments: [{
      id: 1, area: '京东片区', center: '第一服务普通测试服务中心',
      annual_budget: 200, cumulative_budget: 100, cumulative_executed: 100, same_period: 100,
    }],
    latestDailyRows: [],
    dailyBusinessDate: '2026-08-12',
    formalCollectionRows: [{
      center: '绿仔普通测试', canonicalCenter: '第一服务普通测试服务中心',
      collectionRate: null, receivable: 100, received: 75,
    }],
    collectionPublication,
    paymentPublication: {
      publicationStatus: 'partial', businessDate: '2026-08-12',
      lastValidatedAt: '2026-08-12T08:05:00+08:00', source: 'FineReport已验证快照',
    },
    allowedAreas: null,
  })

  const row = result.rows[0]
  assert.equal(row.metrics.officialCollectionRate, null)
  assert.equal(row.availability.officialCollection, 'missing')
  assert.equal(row.evidence.officialCollection, null)
})
