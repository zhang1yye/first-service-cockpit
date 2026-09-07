import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { orchestrateAssistantAnswer } from '../src/assistant-orchestrator.js'
import {
  answerRegionalQuestionWithTopic,
  type RegionalAssistantContext,
} from '../src/regional-assistant-core.js'

const USER_QUESTION = '上第累计回款和同期差异是多少？请引用可信来源。'
const BUSINESS_DATE = '2026-08-12'
const SHANGDI_CENTER = '第一服务北京上第MOMΛ服务中心'
const ROUTE_SOURCE = readFileSync(new URL('../src/routes/regional-assistant.ts', import.meta.url), 'utf8')

const context: RegionalAssistantContext = {
  aph: {
    ready: true,
    annualBudget: 25069,
    cumulativeBudget: 14575,
    cumulativeExecuted: 12776,
    samePeriod: 14276,
    growth: -0.1050714486,
    businessDate: BUSINESS_DATE,
    source: 'FineReport回款额执行评估·华北地区卡片',
    reconciliations: [
      { label: '年度预算·卡片对周报', left: 25069, right: 25884.52, difference: -815.52, status: 'warning' },
    ],
    centerDetail: {
      source: 'FineReport日报+预算周报+执行评估中心明细',
      businessDate: BUSINESS_DATE,
      centerCount: 3,
      annualBudget: 4259.63,
      cumulativeBudget: 2632.03,
      cumulativeExecuted: 2451.03,
      samePeriod: 2787,
      samePeriodPresentCount: 3,
      samePeriodMissingCount: 0,
    },
  },
  paymentCenters: {
    ready: true,
    businessDate: BUSINESS_DATE,
    source: 'FineReport日报+预算周报+执行评估中心明细',
    reason: null,
    rows: [
      {
        area: '海淀片区',
        center: SHANGDI_CENTER,
        annualBudget: 2238.93,
        cumulativeBudget: 1312.04,
        cumulativeExecuted: 1300.17,
        samePeriod: 1505,
        dailyCollection: 0.07,
        businessDate: BUSINESS_DATE,
        source: 'FineReport日报+预算周报+执行评估中心明细',
      },
      {
        area: '通州片区',
        center: '第一服务北京通州万国城MOMΛ服务中心',
        annualBudget: 1020.7,
        cumulativeBudget: 659.99,
        cumulativeExecuted: 575.43,
        samePeriod: 641,
        dailyCollection: 1.1,
        businessDate: BUSINESS_DATE,
        source: 'FineReport日报+预算周报+执行评估中心明细',
      },
      {
        area: '通州片区',
        center: '第一服务北京万国城北区服务中心',
        annualBudget: 1000,
        cumulativeBudget: 660,
        cumulativeExecuted: 575.43,
        samePeriod: 641,
        dailyCollection: 0.5,
        businessDate: BUSINESS_DATE,
        source: 'FineReport日报+预算周报+执行评估中心明细',
      },
    ],
  },
  collection: {
    ready: true,
    rate: 62.83,
    receivable: 16061.59,
    received: 10020.71,
    outstanding: 5964.52,
    amountNote: '官方汇总口径',
    centerCount: 35,
    businessDate: BUSINESS_DATE,
    source: 'P46已发布批次·绿仔官方35条',
  },
  arrears: {
    ready: false,
    activeBatchCount: 0,
    revokedBatchCount: 1,
    projectCount: 0,
    resourceCount: 0,
    totalAmount: null,
    pendingReviewCount: 0,
    confirmedReviewCount: 0,
    latestBusinessDate: null,
    topCauses: [],
    source: '欠费资源分析有效批次',
  },
  projects: { ready: false, count: 0, reason: '项目经营数据尚未通过真实性门禁' },
  quality: { openCaseCount: 1, status: 'warning', notes: ['APH三来源存在差异'] },
}

function routeBranch(start: string, end: string): string {
  const startAt = ROUTE_SOURCE.indexOf(start)
  const endAt = ROUTE_SOURCE.indexOf(end, startAt + start.length)
  assert.ok(startAt >= 0 && endAt > startAt, { start, end })
  return ROUTE_SOURCE.slice(startAt, endAt)
}

test('R55 HTTP success contract sends the original wording through scoped facts, knowledge, and Hermes', async () => {
  const evidence = answerRegionalQuestionWithTopic(USER_QUESTION, 'project', context)
  assert.equal(evidence.topic, 'aph')
  assert.equal(evidence.centerPaymentLookup, 'matched')
  assert.equal(evidence.centerPayment?.center, SHANGDI_CENTER)
  assert.equal(evidence.centerPayment?.cumulativeExecuted, 1300.17)
  assert.equal(evidence.centerPayment?.samePeriod, 1505)
  assert.equal(evidence.facts?.samePeriodVariance, -204.83)
  assert.equal(evidence.facts?.yearOverYearGrowthRateDisplay, '-13.61%')
  assert.equal(evidence.businessDate, BUSINESS_DATE)
  assert.equal(evidence.sources[0]?.name, 'FineReport日报+预算周报+执行评估中心明细')
  assert.equal(evidence.sources[0]?.businessDate, BUSINESS_DATE)

  const orchestrated = await orchestrateAssistantAnswer({
    question: USER_QUESTION,
    evidence,
    context,
    history: [],
  }, {
    search: () => [{
      documentId: 'north-metric-definition',
      title: '华北经营指标口径',
      version: '1.0',
      section: 'APH累计回款执行',
      page: '3',
      content: '累计回款、同期差异和同比均应引用已验证中心明细，并保留业务日期与来源。',
      sourcePath: '华北经营指标口径.md',
      category: 'aph',
    }],
    refine: async input => {
      assert.equal(input.knowledge.length, 1)
      assert.equal((input.context as any).serviceCenterName, SHANGDI_CENTER)
      assert.equal((input.context as any).paymentCenter, undefined)
      assert.ok(Array.isArray((input.context as any).operatingSignals))
      return {
        text: 'AI判断：当前预算缺口和同比下降应作为优先关注事项。\n行动建议：建议先核对回款差异并形成跟进记录。[K1]',
        model: 'north-cockpit',
      }
    },
    knowledgeDbPath: '/tmp/r55-knowledge.db',
    hermes: { baseUrl: 'http://127.0.0.1:8650', apiKey: 'test-key', model: 'north-cockpit' },
  })
  assert.equal(orchestrated.generatedBy, 'hermes-grounded')
  assert.equal(orchestrated.modelUsed, 'north-cockpit')
  assert.match(String(orchestrated.answer), /1300\.17万/)
  assert.match(String(orchestrated.answer), /1505\.00万/)
  assert.match(String(orchestrated.answer), /204\.83万/)
  assert.match(String(orchestrated.answer), /13\.61%/)
  assert.equal(orchestrated.citations.length, 1)
  assert.equal(orchestrated.citations[0].documentId, 'north-metric-definition')
  assert.equal(orchestrated.citations[0].title, '华北经营指标口径')

  const success = routeBranch('res.json({\n    question,\n    ...result,', '\n})\n\nexport default router')
  assert.match(success, /answer: orchestrated\.answer/)
  assert.match(success, /generatedBy: orchestrated\.generatedBy/)
  assert.match(success, /aiOpinion: orchestrated\.aiOpinion \|\| null/)
  assert.match(success, /citations: orchestrated\.citations/)
  assert.match(success, /fallbackUsed: false/)
  assert.match(success, /readOnly: true/)
})

test('R55 service-center scope lets the authorized center resolve the original wording and closes another center', () => {
  const authorized = answerRegionalQuestionWithTopic(USER_QUESTION, '', {
    ...context,
    paymentCenters: { ...context.paymentCenters, rows: [context.paymentCenters.rows[0]] },
  })
  assert.equal(authorized.centerPaymentLookup, 'matched')
  assert.equal(authorized.centerPayment?.center, SHANGDI_CENTER)
  assert.equal(authorized.facts?.samePeriodVariance, -204.83)

  const outOfScope = answerRegionalQuestionWithTopic(USER_QUESTION, '', {
    ...context,
    paymentCenters: { ...context.paymentCenters, rows: [context.paymentCenters.rows[1]] },
  })
  assert.equal(outOfScope.centerPaymentLookup, 'not-found')
  assert.equal(outOfScope.centerPayment, undefined)

  const memberFailure = routeBranch(
    'if (memberDenied)',
    'return res.status(unavailable ? 409 : 422).json({',
  )
  assert.match(memberFailure, /res\.status\(unavailable \? 409 : 403\)/)
  assert.match(memberFailure, /code: unavailable \? 'CENTER_PAYMENT_DATA_UNAVAILABLE' : 'SERVICE_CENTER_OUT_OF_SCOPE'/)
  assert.match(memberFailure, /该服务中心不在当前账号的数据范围内/)
  assert.match(memberFailure, /generatedBy: null/)
  assert.match(memberFailure, /modelUsed: null/)
  assert.match(memberFailure, /citations: \[\]/)
  assert.match(memberFailure, /fallbackUsed: false/)
  assert.match(memberFailure, /readOnly: true/)
  assert.doesNotMatch(memberFailure, /\.\.\.result|question,|centerPayment|centerPaymentCandidates|facts|sources|businessDate/)
})

test('R55 admin HTTP 422 contract preserves closed lookup metadata for ambiguous and false-positive names', () => {
  const ambiguous = answerRegionalQuestionWithTopic('万国城的回款情况', '', context)
  assert.equal(ambiguous.centerPaymentLookup, 'ambiguous')
  assert.equal(ambiguous.centerPaymentCandidates?.length, 2)
  for (const question of ['不存在中心的回款情况', '北京地区的回款情况', '管理的回款情况']) {
    const missing = answerRegionalQuestionWithTopic(question, '', context)
    assert.equal(missing.centerPaymentLookup, 'not-found', question)
    assert.equal(missing.centerPayment, undefined, question)
  }

  const lookupFailure = routeBranch(
    'return res.status(unavailable ? 409 : 422).json({',
    "if (result.qualityStatus === 'unavailable'",
  )
  assert.match(lookupFailure, /res\.status\(unavailable \? 409 : 422\)/)
  assert.match(lookupFailure, /code: unavailable \? 'CENTER_PAYMENT_DATA_UNAVAILABLE' : 'CENTER_PAYMENT_NOT_RESOLVED'/)
  assert.match(lookupFailure, /generatedBy: null/)
  assert.match(lookupFailure, /modelUsed: null/)
  assert.match(lookupFailure, /citations: \[\]/)
  assert.match(lookupFailure, /fallbackUsed: false/)
  assert.match(lookupFailure, /readOnly: true/)
})

test('R55 HTTP 503 contract does not turn an unavailable model into a rule answer', async () => {
  const evidence = answerRegionalQuestionWithTopic(USER_QUESTION, '', context)
  const orchestrated = await orchestrateAssistantAnswer({
    question: USER_QUESTION,
    evidence,
    context,
    history: [],
  }, {
    search: () => [],
    refine: async () => null,
    knowledgeDbPath: '/tmp/r55-knowledge.db',
    hermes: { baseUrl: 'http://127.0.0.1:8650', apiKey: 'test-key', model: 'north-cockpit' },
  })
  assert.equal(orchestrated.answer, null)
  assert.equal(orchestrated.generatedBy, null)
  assert.deepEqual(orchestrated.citations, [])
  assert.equal(orchestrated.failure?.code, 'AI_GENERATION_UNAVAILABLE')

  const aiFailure = routeBranch('if (orchestrated.failure)', '\n  res.json({')
  assert.match(aiFailure, /orchestrated\.failure\.code === 'AI_GENERATION_UNAVAILABLE' \? 503 : 409/)
  assert.match(aiFailure, /answer: null/)
  assert.match(aiFailure, /generatedBy: null/)
  assert.match(aiFailure, /modelUsed: null/)
  assert.match(aiFailure, /citations: \[\]/)
  assert.match(aiFailure, /fallbackUsed: false/)
  assert.match(aiFailure, /readOnly: true/)
  assert.doesNotMatch(aiFailure, /generatedBy:\s*['"]rules['"]/)
})

test('R55 HTTP project truth gate remains 409 before retrieval', () => {
  const project = answerRegionalQuestionWithTopic('上第项目的利润和品质情况', 'aph', context)
  assert.equal(project.topic, 'project')
  assert.equal(project.qualityStatus, 'unavailable')
  const projectGate = routeBranch(
    "if (result.topic === 'project' && !context.projects.ready)",
    "if (result.centerPaymentLookup && result.centerPaymentLookup !== 'matched')",
  )
  assert.match(projectGate, /if \(\(req as any\)\.user\?\.role !== 'admin'\)/)
  assert.match(projectGate, /code: 'PROJECT_DATA_QUALITY_BLOCKED'/)
  assert.match(projectGate, /projectCount: 0/)
  assert.match(projectGate, /generatedBy: null/)
  assert.match(projectGate, /citations: \[\]/)
  assert.match(projectGate, /fallbackUsed: false/)
  assert.match(projectGate, /res\.status\(409\)\.json\(projectDataBlockedPayload\(db\)\)/)
})

test('R55 current route scopes all assistant facts by service_center_scope before Hermes', () => {
  assert.match(ROUTE_SOURCE, /canAccessServiceCenter, getServiceCenterScope, projectScopeWhere/)
  assert.match(ROUTE_SOURCE, /canonicalServiceCenterForUser/)
  assert.match(ROUTE_SOURCE, /if \(req\.user\?\.role !== 'admin'\)[\s\S]*const centers = getServiceCenterScope\(req\.user\)/)
  assert.match(ROUTE_SOURCE, /if \(!centers\.length\) where = 'WHERE 1 = 0'/)
  assert.match(ROUTE_SOURCE, /WHERE p\.center IN \(\$\{centers\.map/)
  assert.match(ROUTE_SOURCE, /const isAdmin = req\?\.user\?\.role === 'admin'[\s\S]*const scopedRows = isAdmin[\s\S]*filter\(row => canAccessServiceCenter\(req, row\.center\)\)/)
  assert.match(ROUTE_SOURCE, /const paymentCenters = readPaymentCenterContext\(req, regionalAph\)/)
  assert.match(ROUTE_SOURCE, /const aph = \{[\s\S]*ready: paymentCenters\.ready/)
  assert.match(ROUTE_SOURCE, /reconciliations: req\?\.user\?\.role === 'admin' \? regionalAph\.reconciliations : \[\]/)
  assert.match(ROUTE_SOURCE, /const projectScope = req \? projectScopeWhere\(req\)/)
  assert.match(ROUTE_SOURCE, /if \(req\?\.user\?\.role !== 'admin'\) throw new Error\('成员不读取全局治理事项'\)/)
  assert.match(ROUTE_SOURCE, /const safeHistory = result\.centerPaymentLookup \? \[\] : history/)
})
