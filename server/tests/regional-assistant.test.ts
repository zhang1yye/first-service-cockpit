import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { answerRegionalQuestion, detectOperatingSignals, ratioToPercent, type RegionalAssistantContext } from '../src/regional-assistant-core.js'
import { orchestrateAssistantAnswer } from '../src/assistant-orchestrator.js'

const assistantRoute = readFileSync(new URL('../src/routes/regional-assistant.ts', import.meta.url), 'utf8')
const nginx = readFileSync(new URL('../../deploy/production/r127/review-system.conf', import.meta.url), 'utf8')

const context: RegionalAssistantContext = {
  aph: {
    ready: true,
    annualBudget: 25069,
    cumulativeBudget: 14575,
    cumulativeExecuted: 12776,
    samePeriod: 14276,
    growth: -0.1050714486,
    businessDate: '2026-08-03',
    source: 'FineReport回款额执行评估·华北地区卡片',
    reconciliations: [
      { label: '年度预算·卡片对周报', left: 25069, right: 25884.52, difference: -815.52, status: 'warning' },
    ],
    centerDetail: {
      source: 'FineReport中心明细', businessDate: '2026-08-03', centerCount: 0,
      annualBudget: null, cumulativeBudget: null, cumulativeExecuted: null, samePeriod: null,
      samePeriodPresentCount: null, samePeriodMissingCount: null,
    },
  },
  paymentCenters: {
    ready: true, businessDate: '2026-08-03', source: 'APH中心明细', reason: null,
    rows: [{
      area: '测试片区', center: '第一服务测试服务中心', annualBudget: 200,
      cumulativeBudget: 100, cumulativeExecuted: 80, samePeriod: 90, dailyCollection: 1,
      businessDate: '2026-08-03', source: 'APH中心明细',
    }],
  },
  collection: {
    ready: true,
    rate: 62.83,
    receivable: 16061.59,
    received: 10020.71,
    outstanding: 5964.52,
    amountNote: '金额采用官方汇总口径（含供暖费期间更正）',
    centerCount: 35,
    businessDate: '2026-08-03',
    source: 'P46已发布批次·绿仔官方35条',
    rows: [{
      area: '测试片区', center: '第一服务测试服务中心', rate: 62.83,
      receivable: 16061.59, received: 10020.71, outstanding: 5964.52,
      businessDate: '2026-08-03', source: 'P46已发布批次·绿仔官方35条',
    }],
  },
  arrears: {
    ready: false, activeBatchCount: 0, revokedBatchCount: 0, projectCount: 0, resourceCount: 0,
    totalAmount: null, pendingReviewCount: 0, confirmedReviewCount: 0, latestBusinessDate: null,
    topCauses: [], source: '欠费分析',
  },
  projects: { ready: false, count: 0, reason: '项目经营数据尚未通过真实性门禁' },
  quality: { openCaseCount: 5, status: 'warning', notes: ['APH三来源存在差异'] },
}

test('converts P46 ratio to display percentage exactly once', () => {
  assert.equal(ratioToPercent(0.6283), 62.83)
  assert.equal(ratioToPercent(0), 0)
  assert.equal(ratioToPercent(null), null)
})

test('answers APH execution with real current, budget and baseline values', () => {
  const result = answerRegionalQuestion('华北累计回款完成情况怎么样？', context)
  assert.equal(result.topic, 'aph')
  assert.equal(result.answer, '')
  assert.equal(result.facts?.cumulativeExecuted, 12776)
  assert.equal(result.facts?.cumulativeBudget, 14575)
  assert.equal(result.facts?.yearOverYearGrowthRateDisplay, '-10.51%')
  assert.equal(result.businessDate, '2026-08-03')
  assert.equal(result.sources[0].status, 'warning')
})

test('answers verified center cumulative facts while withholding conflicted daily collection', () => {
  const conflicted = structuredClone(context)
  conflicted.paymentCenters.dailyCollectionReason = '已发布批次26累计执行变动72.42万元与官方日回款37.96万元不勾稽'
  conflicted.paymentCenters.rows[0].dailyCollection = null

  const result = answerRegionalQuestion('第一服务测试服务中心的回款情况', conflicted)
  assert.equal(result.centerPaymentLookup, 'matched')
  assert.equal(result.centerPayment?.cumulativeExecuted, 80)
  assert.equal(result.centerPayment?.dailyCollection, null)
  assert.equal(result.qualityStatus, 'warning')
  assert.match(result.limitations.join('；'), /当日回款待复核/)
  assert.match(result.sources[0].note || '', /不勾稽/)

  const unknown = answerRegionalQuestion('满庭芳园的回款情况', conflicted)
  assert.equal(unknown.centerPaymentLookup, 'not-found', '日报冲突不得先把中心名称解析封锁成数据不可用')
  assert.match(unknown.answer, /完整服务中心名称/)
})

test('answers official collection rate without replacing it with amount ratio', () => {
  const result = answerRegionalQuestion('绿仔官方收缴率是多少？', context)
  assert.equal(result.topic, 'collection')
  assert.equal(result.answer, '')
  assert.equal(result.facts?.rateDisplay, '62.83%')
  assert.equal(result.facts?.centerCount, 35)
  assert.equal(result.facts?.outstanding, 5964.52)
  assert.match(String(result.facts?.amountNote), /供暖费期间更正/)
  assert.equal(result.sources[0].name, 'P46已发布批次·绿仔官方35条')
})

test('resolves MOMA query qualifiers and returns verified center facts without Hermes', async () => {
  const scoped = structuredClone(context)
  scoped.collection.rows.push({
    area: '华北',
    center: '第一服务北京上第MOMΛ服务中心',
    rate: 65.91,
    receivable: 1559.72,
    received: 1029.34,
    outstanding: 531.71,
    businessDate: '2026-09-02',
    source: 'P46已发布批次·绿仔官方35条',
  })
  const question = '上第MOMA收缴率多少，只返回已核验数据'
  const evidence = answerRegionalQuestion(question, scoped)
  assert.equal(evidence.centerPaymentLookup, 'matched')
  assert.equal(evidence.collectionCenter?.center, '第一服务北京上第MOMΛ服务中心')

  const result = await orchestrateAssistantAnswer({ question, evidence }, {
    search: () => { throw new Error('verified fact query must not search knowledge') },
    refine: async () => { throw new Error('verified fact query must not call Hermes') },
    knowledgeDbPath: '/tmp/regional-assistant-test.db',
    hermes: { baseUrl: '', apiKey: '', model: '' },
  })
  assert.equal(result.generatedBy, 'verified-facts')
  assert.equal(result.modelUsed, null)
  assert.equal(result.answer, [
    '第一服务北京上第MOMΛ服务中心收缴率：65.91%',
    '应收：1559.72万',
    '实收：1029.34万',
    '待收：531.71万',
  ].join('\n'))
})

test('nginx assistant timeout exceeds the longest backend Hermes budget', () => {
  const backendBudget = assistantRoute.match(/timeoutMs:[\s\S]*?\?\s*([\d_]+)\s*:\s*([\d_]+)/)
  assert.ok(backendBudget, '必须能读取助手后端的Hermes超时预算')
  const longestBackendMs = Math.max(...backendBudget.slice(1).map(value => Number(value.replaceAll('_', ''))))

  const assistantLocation = nginx.match(/location = \/api\/ai\/assistant\/ask \{([\s\S]*?)\n    \}/)
  assert.ok(assistantLocation, 'Nginx必须为助手接口保留精确location')
  const readTimeout = assistantLocation[1].match(/proxy_read_timeout\s+(\d+)s;/)
  const sendTimeout = assistantLocation[1].match(/proxy_send_timeout\s+(\d+)s;/)
  assert.ok(readTimeout && sendTimeout, '助手接口必须显式配置读写超时')
  const gatewayMs = Math.min(Number(readTimeout[1]), Number(sendTimeout[1])) * 1000
  assert.ok(gatewayMs >= longestBackendMs + 10_000,
    `网关超时${gatewayMs}ms必须至少比后端最长预算${longestBackendMs}ms多10秒`)
})

test('missing baseline remains unavailable instead of becoming zero growth', () => {
  const missing = structuredClone(context)
  missing.aph.samePeriod = null
  missing.aph.growth = null
  const result = answerRegionalQuestion('同比怎么样？', missing)
  assert.equal(result.answer, '')
  assert.equal(result.facts?.samePeriod, null)
  assert.equal(result.facts?.yearOverYearGrowthRate, null)
})

test('project questions are blocked when project truth gate is not ready', () => {
  const result = answerRegionalQuestion('哪个项目经营最差？', context)
  assert.equal(result.topic, 'project')
  assert.equal(result.qualityStatus, 'unavailable')
  assert.match(result.answer, /不形成项目经营结论/)
})

test('quality differences are disclosed instead of normalized away', () => {
  const result = answerRegionalQuestion('APH三套预算为什么不一致？', context)
  assert.equal(result.topic, 'quality')
  assert.equal(result.answer, '')
  assert.equal((result.facts?.reconciliations as any[])[0].difference, -815.52)
  assert.match(result.limitations.join('；'), /APH三来源存在差异/)
})

test('detects only evidence-backed operating signals from trusted context', () => {
  const signals = detectOperatingSignals(context)
  assert.deepEqual(signals.map(signal => signal.code), [
    'aph-budget-gap',
    'aph-yoy-decline',
    'aph-source-mismatch',
    'data-quality-open',
    'project-gate-blocked',
  ])
  assert.match(signals[0].evidence, /累计执行.*累计预算/)
  assert.doesNotMatch(signals.map(signal => signal.evidence).join('\n'), /估算|预计/)
})

test('overview exposes anomaly judgement while preserving data limitations', () => {
  const result = answerRegionalQuestion('当前经营情况怎么样？', context)
  assert.equal(result.topic, 'overview')
  assert.equal(result.answer, '')
  assert.equal((result.facts?.operatingSignals as any[])[0].title, '累计回款低于累计预算')
  assert.deepEqual(result.signals?.map(signal => signal.code), detectOperatingSignals(context).map(signal => signal.code))
})
