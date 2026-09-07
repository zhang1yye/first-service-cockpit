import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAdminQualityReport, mappingAliasCandidates, normalizeCenterKey } from '../src/admin-quality.js'

const emptyInput = () => ({
  projectCount: 1,
  demoProjectCount: 0,
  demoImportCount: 0,
  samePeriodZeroCount: 0,
  activeSamePeriodZeroCount: 0,
  copiedSnapshotProjectCount: 0,
  paymentAnnualTotal: null,
  aphAnnualBudget: null,
  aphBudgetWeeklyAnnual: null,
  detailSamePeriodTotal: null,
  aphSamePeriod: null,
  collectionDbRows: 0,
  collectionSourceRows: null,
  collectionDbRate: null,
  collectionOfficialRate: null,
  links: [],
})

test('normalizeCenterKey preserves business prefixes and service/experience suffixes', () => {
  assert.equal(normalizeCenterKey('第一服务 营口林昌天铂·服务中心'), '第一服务营口林昌天铂服务中心')
  assert.equal(normalizeCenterKey('第一酒店营口林昌天铂体验中心'), '第一酒店营口林昌天铂体验中心')
  assert.notEqual(normalizeCenterKey('第一服务营口林昌天铂服务中心'), normalizeCenterKey('第一服务营口林昌天铂体验中心'))
})

test('service and experience centers are candidates only and never hard collisions', () => {
  const links = [
    { profileId: 36, sourceSystem: 'collection', sourceCenter: '第一服务营口林昌天铂服务中心' },
    { profileId: 42, sourceSystem: 'collection', sourceCenter: '第一服务营口林昌天铂体验中心' },
  ]
  const report = buildAdminQualityReport({ ...emptyInput(), links })
  assert.equal(report.collisions.length, 0)
  assert.equal(mappingAliasCandidates(links).length, 1)
  assert.equal(report.issues.some(issue => issue.code === 'PROJECT_MAPPING_ALIAS_CANDIDATE'), true)
})

test('mapping collision also detects duplicate normalized aliases inside one profile', () => {
  const report = buildAdminQualityReport({
    ...emptyInput(),
    links: [
      { profileId: 36, sourceSystem: 'collection', sourceCenter: '第一服务营口林昌天铂服务中心' },
      { profileId: 36, sourceSystem: 'collection', sourceCenter: '第一服务 营口林昌天铂·服务中心' },
    ],
  })
  assert.equal(report.collisions.length, 1)
})

test('quality report identifies demo chain, source gaps, copied snapshots and mapping collision', () => {
  const report = buildAdminQualityReport({
    projectCount: 10,
    demoProjectCount: 10,
    demoImportCount: 13,
    samePeriodZeroCount: 15,
    activeSamePeriodZeroCount: 7,
    copiedSnapshotProjectCount: 10,
    paymentAnnualTotal: 26731.52,
    aphAnnualBudget: 25069,
    aphBudgetWeeklyAnnual: 25071,
    detailSamePeriodTotal: 13637,
    aphSamePeriod: 14276,
    collectionDbRows: 56,
    collectionSourceRows: 35,
    collectionDbRate: 0.543559,
    collectionOfficialRate: 0.6276,
    links: [
      { profileId: 36, sourceSystem: 'collection', sourceCenter: '第一服务营口林昌天铂服务中心' },
      { profileId: 42, sourceSystem: 'collection', sourceCenter: '第一服务 营口林昌天铂·服务中心' },
    ],
  })
  assert.equal(report.summary.critical >= 2, true)
  assert.equal(report.summary.total >= 6, true)
  assert.equal(report.collisions.length, 1)
  assert.equal(report.issues.some(issue => issue.code === 'DEMO_PROJECT_CHAIN'), true)
  assert.equal(report.issues.some(issue => issue.code === 'SAME_PERIOD_ZERO_REVIEW'), true)
  assert.equal(report.issues.some(issue => issue.code === 'APH_ANNUAL_BUDGET_SCOPE_GAP'), true)
  assert.equal(report.issues.some(issue => issue.code === 'COPIED_MONTHLY_SNAPSHOTS'), true)
  assert.equal(report.issues.some(issue => issue.code === 'COLLECTION_FALLBACK_SCOPE'), true)
})

test('quality report keeps unavailable values explicit instead of converting them to zero', () => {
  const report = buildAdminQualityReport({ ...emptyInput(), projectCount: 0 })
  assert.equal(report.facts.aphAnnualBudget, null)
  assert.equal(report.facts.aphBudgetWeeklyAnnual, null)
  assert.equal(report.facts.collectionOfficialRate, null)
  assert.equal(report.issues.some(issue => issue.code === 'APH_SOURCE_UNAVAILABLE'), true)
})
