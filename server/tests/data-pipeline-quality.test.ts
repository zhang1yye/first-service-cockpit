import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeNormalizedBundle, evaluateScopedDailyCrossFieldReview, type NormalizedBundle } from '../src/data-pipeline.js'

const provenance = JSON.stringify({
  annual_budget: { report: '预算周报', label: '全年预算' },
  cumulative_budget: { report: '回款日报', label: '累计预算' },
  cumulative_executed: { report: '回款日报', label: '累计执行' },
  daily_collection: { report: '回款日报', label: '本日回款' },
})

function validBundle(): NormalizedBundle {
  const now = new Date()
  const extractedAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
  const validatedAt = now.toISOString()
  const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now)
  return {
    schema_version: 2,
    business_date: businessDate,
    extracted_at: extractedAt,
    source_status: 'available',
    last_validated_at: validatedAt,
    field_provenance: {
      年度预算_万: '华北地区卡片/年度预算',
      累计预算_万: '华北地区卡片/累计预算',
      累计执行_万: '华北地区卡片/累计执行',
      同期执行_万: '华北地区卡片/同期执行',
      增幅: '华北地区卡片/增幅并经公式勾稽',
    },
    source_layers: {
      regionCard: { source: '执行评估华北卡片', businessDate, values: { annualBudget: 100, cumulativeBudget: 95, cumulativeExecuted: 100, samePeriod: 90, growthPercent: 11.11 } },
      budgetWeekly: { source: '预算周报', businessDate, values: { annualBudget: 103, cumulativeBudget: 96, centerCount: 1 } },
      centerDetail: { source: '中心明细', businessDate, values: { annualBudget: 110, cumulativeBudget: 95, cumulativeExecuted: 100, samePeriod: 90, centerCount: 1 } },
    },
    reconciliations: {},
    payment_centers: [{ area: '河北片区', center: '第一服务测试中心', annual_budget: 110, cumulative_budget: 95, cumulative_executed: 100, same_period: 90, collection_rate: null }],
    daily_snapshots: [{
      date: businessDate, center: '第一服务测试中心', annual_budget: 110, cumulative_budget: 95,
      cumulative_executed: 100, daily_collection: 2, quality_status: 'verified', quality_reason: '',
      source: 'FineReport三报表中心明细', source_status: 'available', business_date: businessDate,
      last_validated_at: validatedAt, field_provenance: provenance,
    }],
    collection_centers: Array.from({ length: 35 }, (_, index) => ({ area: '测试片区', center: `第一服务绿仔测试中心${index + 1}`, receivable: 100, received: 60, outstanding: 40, collectionRate: 0.6 })),
    collection_summary: { collectionRate: 0.6, receivable_万: 3500, received_万: 2100, periodCorrection: { rateField: 'gatheringCurrentYearRecedRate', rateAggregation: '按receCurrentPeriod对应收加权官方项目率' } },
    lvzai: { raw_rows: 100, source_regions: 35, mapped_regions: 35, canonical_centers: 35, unmapped_centers: [] },
  }
}

test('P46 v2 preserves source layers and reports material reconciliation differences without fabricating a unified value', () => {
  const result = analyzeNormalizedBundle(validBundle(), [], { minimumCenters: 1 })
  assert.equal(result.publishable, true)
  assert.equal(result.errors.length, 0)
  assert.equal(result.warnings.length, 2)
  assert.deepEqual(result.reconciliations.annualBudgetCardVsCenterDetail, {
    leftSource: 'regionCard', leftValue: 100, rightSource: 'centerDetail', rightValue: 110,
    difference: 10, differenceRate: 0.1, status: 'warning',
  })
})

test('P46 v2 preserves source-verified zero and negative operating values as warnings while still rejecting unverified lineage', () => {
  const bundle = validBundle()
  bundle.payment_centers[0].same_period = 0
  bundle.daily_snapshots[0].daily_collection = -1
  bundle.daily_snapshots[0].quality_status = 'unverified'
  const result = analyzeNormalizedBundle(bundle, [], { minimumCenters: 1 })
  assert.equal(result.publishable, false)
  assert.equal(result.errors.some(error => error.includes('未验证')), true)
  assert.equal(result.errors.some(error => error.includes('负数') || error.includes('伪0')), false)
  assert.equal(result.warnings.some(warning => warning.includes('同期为来源已验证的0')), true)
  assert.equal(result.warnings.some(warning => warning.includes('负执行/日回款')), true)
})

test('P46 v2 keeps source-verified negative adjustments publishable with a review warning', () => {
  const bundle = validBundle()
  bundle.payment_centers[0].cumulative_executed = -0.1
  bundle.daily_snapshots[0].cumulative_executed = -0.1
  bundle.daily_snapshots[0].quality_reason = '来源已验证；负数业务异常待复核：cumulative_executed'
  const result = analyzeNormalizedBundle(bundle, [], { minimumCenters: 1 })
  assert.equal(result.publishable, true)
  assert.equal(result.errors.length, 0)
  assert.equal(result.warnings.some(warning => warning.includes('负执行/同期值')), true)
  assert.equal(result.warnings.some(warning => warning.includes('负执行/日回款')), true)
})

test('P46 v2 rejects legacy bundles and null core amounts instead of coercing null to zero', () => {
  const bundle = validBundle()
  bundle.schema_version = 1
  ;(bundle.payment_centers[0] as any).annual_budget = null
  const result = analyzeNormalizedBundle(bundle, [], { minimumCenters: 1 })
  assert.equal(result.publishable, false)
  assert.equal(result.errors.some(error => error.includes('版本')), true)
  assert.equal(result.errors.some(error => error.includes('关键字段缺失')), true)
})

test('P46 v2 accepts an official zero daily collection when cumulative execution is unchanged', () => {
  const bundle = validBundle()
  bundle.daily_snapshots[0].daily_collection = 0
  const current = [{ ...bundle.payment_centers[0] }]
  const result = analyzeNormalizedBundle(bundle, current, { minimumCenters: 1 })
  assert.equal(result.publishable, true)
  assert.equal(result.errors.some(error => error.includes('日回款跨字段')), false)
  assert.equal(result.totals.after.daily_collection, 0)
})

test('P46 v2 publishes verified source values for later reconciliation when cumulative execution changes but official daily collection is zero', () => {
  const bundle = validBundle()
  bundle.daily_snapshots[0].daily_collection = 0
  const current = [{ ...bundle.payment_centers[0], cumulative_executed: 71.82 }]
  const result = analyzeNormalizedBundle(bundle, current, { minimumCenters: 1 })
  assert.equal(result.publishable, true)
  assert.equal(result.errors.some(error => error.includes('日回款跨字段')), false)
  assert.equal(result.warnings.some(warning => warning.includes('日回款待次日复核') && warning.includes('28.18') && warning.includes('全为0')), true)
  assert.equal(result.dailyReview.status, 'pending_review')
  assert.equal(result.dailyReview.cumulativeChange, 28.18)
  assert.equal(result.dailyReview.officialDailyTotal, 0)
  assert.equal(result.totals.after.daily_collection, 0)
})

test('P46 v2 compares a same-date re-preview with the prior trusted daily baseline', () => {
  const bundle = validBundle()
  bundle.daily_snapshots[0].cumulative_executed = 128.18
  bundle.daily_snapshots[0].daily_collection = 0
  const current = [{ ...bundle.payment_centers[0], cumulative_executed: 128.18 }]
  const dailyComparisonBaseline = [{ ...bundle.payment_centers[0], cumulative_executed: 100 }]

  const result = analyzeNormalizedBundle(bundle, current, { minimumCenters: 1, dailyComparisonBaseline })

  assert.equal(result.publishable, true)
  assert.equal(result.warnings.some(warning => warning.includes('日回款待次日复核') && warning.includes('28.18') && warning.includes('全为0')), true)
})

test('P46 v2 fails closed when the prior trusted baseline and current center sets do not overlap', () => {
  const bundle = validBundle()
  bundle.payment_centers[0].center = '第一服务重命名后测试中心'
  bundle.payment_centers[0].cumulative_executed = 128.18
  bundle.daily_snapshots[0].center = '第一服务重命名后测试中心'
  bundle.daily_snapshots[0].cumulative_executed = 128.18
  bundle.daily_snapshots[0].daily_collection = 0
  const dailyComparisonBaseline = [{ ...bundle.payment_centers[0], center: '第一服务重命名前测试中心', cumulative_executed: 100 }]

  const result = analyzeNormalizedBundle(bundle, bundle.payment_centers, { minimumCenters: 1, dailyComparisonBaseline })

  assert.equal(result.publishable, false)
  assert.equal(result.errors.some(error => error.includes('上一可信日') && error.includes('中心集合不一致')), true)
})

test('P46 v2 fails closed when movement occurs only in a center absent from the prior baseline', () => {
  const bundle = validBundle()
  bundle.payment_centers.push({ ...bundle.payment_centers[0], center: '第一服务新增测试中心', cumulative_executed: 128.18 })
  bundle.daily_snapshots = [
    { ...bundle.daily_snapshots[0], daily_collection: 0 },
    { ...bundle.daily_snapshots[0], center: '第一服务新增测试中心', cumulative_executed: 128.18, daily_collection: 0 },
  ]
  const dailyComparisonBaseline = [
    { ...bundle.payment_centers[0], cumulative_executed: 100 },
    { ...bundle.payment_centers[0], center: '第一服务已退出测试中心', cumulative_executed: 100 },
  ]

  const result = analyzeNormalizedBundle(bundle, bundle.payment_centers, { minimumCenters: 1, dailyComparisonBaseline })

  assert.equal(result.publishable, false)
  assert.equal(result.errors.some(error => error.includes('上一可信日') && error.includes('中心集合不一致')), true)
})

test('P46 v2 publishes verified offsetting center movements for later reconciliation', () => {
  const bundle = validBundle()
  bundle.payment_centers.push({ ...bundle.payment_centers[0], center: '第一服务测试中心二', cumulative_executed: 100 })
  bundle.daily_snapshots = [
    { ...bundle.daily_snapshots[0], cumulative_executed: 110, daily_collection: 0 },
    { ...bundle.daily_snapshots[0], center: '第一服务测试中心二', cumulative_executed: 90, daily_collection: 0 },
  ]
  const current = bundle.payment_centers.map(row => ({ ...row, cumulative_executed: 100 }))

  const result = analyzeNormalizedBundle(bundle, current, { minimumCenters: 1 })

  assert.equal(result.publishable, true)
  assert.equal(result.warnings.some(warning => warning.includes('日回款待次日复核') && warning.includes('中心') && warning.includes('全为0')), true)
})

test('P46 v2 keeps a material monetary mismatch explicit and pending reconciliation', () => {
  const bundle = validBundle()
  bundle.daily_snapshots[0].cumulative_executed = 1100
  bundle.daily_snapshots[0].daily_collection = 991
  const current = [{ ...bundle.payment_centers[0], cumulative_executed: 100 }]

  const result = analyzeNormalizedBundle(bundle, current, { minimumCenters: 1 })

  assert.equal(result.publishable, true)
  assert.equal(result.errors.some(error => error.includes('日回款跨字段')), false)
  assert.equal(result.warnings.some(warning => warning.includes('日回款待次日复核') && warning.includes('不勾稽')), true)
})

test('P46 v2 preserves an all-missing official daily collection as null and blocks publication', () => {
  const bundle = validBundle()
  bundle.daily_snapshots[0].daily_collection = null
  const current = [{ ...bundle.payment_centers[0], cumulative_executed: 90 }]
  const result = analyzeNormalizedBundle(bundle, current, { minimumCenters: 1 })
  assert.equal(result.publishable, false)
  assert.equal(result.errors.some(error => error.includes('日快照存在缺失或非数值字段')), true)
  assert.equal(result.warnings.some(warning => warning.includes('日回款待次日复核') && warning.includes('全缺失')), true)
  assert.equal(result.totals.after.daily_collection, null)
})

test('scoped daily review never exposes amounts from centers outside the caller scope', () => {
  const current = [
    { center: 'A中心', cumulative_executed: 100 },
    { center: 'B中心', cumulative_executed: 200 },
  ]
  const daily = [
    { center: 'A中心', cumulative_executed: 110, daily_collection: 5 },
    { center: 'B中心', cumulative_executed: 220, daily_collection: 0 },
  ]
  const review = evaluateScopedDailyCrossFieldReview(current, daily, new Set(['A中心'])).review
  assert.equal(review.status, 'pending_review')
  assert.equal(review.cumulativeChange, 10)
  assert.equal(review.officialDailyTotal, 5)
  assert.doesNotMatch(review.reason || '', /30/)
})
