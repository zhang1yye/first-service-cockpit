import assert from 'node:assert/strict'
import test from 'node:test'
import type { RegionalAssistantAnswer, RegionalAssistantContext } from '../src/regional-assistant-core.js'
import { orchestrateAssistantAnswer } from '../src/assistant-orchestrator.js'

const context = {
  aph: {
    ready: true, annualBudget: 1, cumulativeBudget: 1, cumulativeExecuted: 1, samePeriod: 1,
    growth: 0, businessDate: '2026-08-05', source: 'APH', reconciliations: [],
    centerDetail: { source: 'APH', businessDate: '2026-08-05', centerCount: 0, annualBudget: null, cumulativeBudget: null, cumulativeExecuted: null, samePeriod: null, samePeriodPresentCount: null, samePeriodMissingCount: null },
  },
  paymentCenters: { ready: false, businessDate: null, source: 'APH', reason: '测试不含中心明细', rows: [] },
  collection: { ready: true, rate: 62.83, receivable: 1, received: 1, outstanding: 0, amountNote: '官方', centerCount: 35, businessDate: '2026-08-05', source: '绿仔' },
  arrears: { ready: false, activeBatchCount: 0, revokedBatchCount: 0, projectCount: 0, resourceCount: 0, totalAmount: null, pendingReviewCount: 0, confirmedReviewCount: 0, latestBusinessDate: null, topCauses: [], source: '欠费分析' },
  projects: { ready: false, count: 0, reason: '项目经营数据尚未通过真实性门禁' },
  quality: { openCaseCount: 0, status: 'verified', notes: [] },
} satisfies RegionalAssistantContext

const baseline: RegionalAssistantAnswer = {
  topic: 'collection', answer: '官方收缴率62.83%。', businessDate: '2026-08-05', qualityStatus: 'verified', sources: [], limitations: [],
}

test('orchestrator returns Hermes answer with traceable citations', async () => {
  const result = await orchestrateAssistantAnswer({ question: '收缴率低怎么办', evidence: baseline, context, history: [], sessionId: 'session-1' }, {
    search: () => [{ documentId: 'doc-1', title: '费用收缴专项方案', version: '2026', section: '催缴流程', page: '12', content: '先核对欠费事实。', sourcePath: 'doc.md', category: 'collection' }],
    refine: async () => ({ text: '官方收缴率62.83%，应先核对欠费事实。[K1]', model: 'north-cockpit' }),
    knowledgeDbPath: '/tmp/knowledge.db',
    hermes: { baseUrl: 'http://127.0.0.1:8650', apiKey: 'secret', model: 'north-cockpit' },
  })
  assert.equal(result.generatedBy, 'hermes-grounded')
  assert.equal(result.modelUsed, 'north-cockpit')
  assert.equal(result.citations.length, 1)
  assert.deepEqual(result.citations[0], { documentId: 'doc-1', title: '费用收缴专项方案', version: '2026', section: '催缴流程', page: '12' })
})

test('orchestrator returns deterministic baseline when Hermes fails', async () => {
  const result = await orchestrateAssistantAnswer({ question: '收缴率低怎么办', evidence: baseline, context, history: [] }, {
    search: () => [], refine: async () => null, knowledgeDbPath: '/tmp/knowledge.db',
    hermes: { baseUrl: 'http://127.0.0.1:8650', apiKey: 'secret', model: 'north-cockpit' },
  })
  assert.equal(result.answer, null)
  assert.equal(result.generatedBy, null)
  assert.equal(result.failure?.code, 'AI_GENERATION_UNAVAILABLE')
  assert.deepEqual(result.citations, [])
})

test('collection questions do not expose unrelated APH or project context to Hermes', async () => {
  let receivedContext: any = null
  await orchestrateAssistantAnswer({ question: '收缴率低怎么办', evidence: baseline, context, history: [] }, {
    search: () => [],
    refine: async input => { receivedContext = input.context; return null },
    knowledgeDbPath: '/tmp/knowledge.db',
    hermes: { baseUrl: 'http://127.0.0.1:8650', apiKey: 'test-key', model: 'north-cockpit' },
  })
  assert.deepEqual(Object.keys(receivedContext).sort(), ['collection', 'collectionCenter', 'facts', 'operatingSignals', 'quality'])
  assert.equal(receivedContext.aph, undefined)
  assert.equal(receivedContext.projects, undefined)
  assert.deepEqual(receivedContext.operatingSignals, [])
})

test('regional APH questions expose only official card facts, not center-detail or reconciliation values', async () => {
  let receivedContext: any = null
  const aphEvidence: RegionalAssistantAnswer = {
    topic: 'aph', answer: '', businessDate: '2026-08-05', qualityStatus: 'warning',
    sources: [{ name: 'APH华北正式卡片', businessDate: '2026-08-05', status: 'warning' }],
    limitations: ['APH卡片与中心明细存在口径差异'], facts: { annualBudget: 25069 },
  }
  await orchestrateAssistantAnswer({ question: '分析当前回款情况', evidence: aphEvidence, context, history: [] }, {
    search: () => [], refine: async input => { receivedContext = input.context; return null },
    knowledgeDbPath: '/tmp/knowledge.db',
    hermes: { baseUrl: 'http://127.0.0.1:8650', apiKey: 'test-key', model: 'north-cockpit' },
  })
  assert.deepEqual(Object.keys(receivedContext).sort(), ['facts', 'limitations', 'operatingSignals', 'qualityStatus', 'source'])
  assert.deepEqual(receivedContext.facts, { annualBudget: 25069 })
  assert.equal(receivedContext.aph, undefined)
  assert.equal(receivedContext.centerDetail, undefined)
  assert.equal(JSON.stringify(receivedContext).includes('26726.45'), false)
})

test('verified regional single-metric questions return exact values with units without calling Hermes', async () => {
  let calls = 0
  const aphEvidence: RegionalAssistantAnswer = {
    topic: 'aph', answer: '', businessDate: '2026-08-30', qualityStatus: 'warning', sources: [],
    limitations: ['存在口径差异'], facts: { annualBudget: 25069, cumulativeBudget: 14560.71 },
  }
  const annual = await orchestrateAssistantAnswer({ question: '华北地区年度预算是多少？', evidence: aphEvidence, context, history: [] }, {
    search: () => { calls += 1; return [] }, refine: async () => { calls += 1; return null },
    knowledgeDbPath: '/tmp/knowledge.db', hermes: { baseUrl: '', apiKey: '', model: '' },
  })
  const cumulative = await orchestrateAssistantAnswer({ question: '华北地区累计预算是多少？', evidence: aphEvidence, context, history: [] }, {
    search: () => { calls += 1; return [] }, refine: async () => { calls += 1; return null },
    knowledgeDbPath: '/tmp/knowledge.db', hermes: { baseUrl: '', apiKey: '', model: '' },
  })
  assert.equal(annual.answer, '华北地区年度预算为25,069.00万元。当前来源状态为warning，存在待复核的多来源口径差异。')
  assert.equal(cumulative.answer, '华北地区累计预算为14,560.71万元。当前来源状态为warning，存在待复核的多来源口径差异。')
  assert.equal(annual.generatedBy, 'verified-facts')
  assert.equal(annual.modelUsed, null)
  assert.equal(calls, 0)
})

test('blocked project questions never call retrieval or Hermes', async () => {
  let calls = 0
  const projectBaseline: RegionalAssistantAnswer = { ...baseline, topic: 'project', qualityStatus: 'unavailable', answer: '项目经营数据尚未通过真实性门禁。' }
  const result = await orchestrateAssistantAnswer({ question: '哪个项目最差', evidence: projectBaseline, context, history: [] }, {
    search: () => { calls += 1; return [] }, refine: async () => { calls += 1; return null }, knowledgeDbPath: '/tmp/knowledge.db',
    hermes: { baseUrl: 'http://127.0.0.1:8650', apiKey: 'secret', model: 'north-cockpit' },
  })
  assert.equal(calls, 0)
  assert.equal(result.generatedBy, null)
  assert.equal(result.failure?.code, 'ASSISTANT_EVIDENCE_UNAVAILABLE')
})

test('an explicit standard code without approved knowledge fails closed before Hermes', async () => {
  let refineCalls = 0
  const result = await orchestrateAssistantAnswer({ question: '根据PM4-SS-70，中水系统怎么维护？', evidence: baseline, context, history: [] }, {
    search: () => [],
    refine: async () => { refineCalls += 1; return { text: '不应生成', model: 'north-cockpit' } },
    knowledgeDbPath: '/tmp/knowledge.db',
    hermes: { baseUrl: 'http://127.0.0.1:8650', apiKey: 'test-key', model: 'north-cockpit' },
  })
  assert.equal(refineCalls, 0)
  assert.equal(result.generatedBy, null)
  assert.equal(result.failure?.code, 'APPROVED_KNOWLEDGE_UNAVAILABLE')
  assert.deepEqual(result.citations, [])
  assert.match(result.failure?.message || '', /PM4-SS-70/)
})

test('broad operating questions retrieve knowledge with evidence-backed anomaly terms', async () => {
  let query = ''
  const overview = { ...baseline, topic: 'overview' as const, signals: [{ code: 'aph-budget-gap' as const, level: 'warning' as const, title: '累计回款低于累计预算', evidence: '累计执行低于累计预算。' }] }
  await orchestrateAssistantAnswer({ question: '当前经营情况怎么样', evidence: overview, context, history: [] }, {
    search: received => { query = received; return [] },
    refine: async () => null,
    knowledgeDbPath: '/tmp/knowledge.db',
    hermes: { baseUrl: 'http://127.0.0.1:8650', apiKey: 'test-key', model: 'north-cockpit' },
  })
  assert.match(query, /当前经营情况怎么样/)
  assert.match(query, /累计回款低于累计预算/)
})

test('orchestrator excludes standards unrelated to the operating topic', async () => {
  let receivedKnowledge: any[] = []
  const overview = { ...baseline, topic: 'overview' as const, signals: [{ code: 'aph-source-mismatch' as const, level: 'warning' as const, title: 'APH多来源口径存在差异', evidence: '年度预算来源差异。' }] }
  const result = await orchestrateAssistantAnswer({ question: '当前异常有什么管理建议', evidence: overview, context, history: [] }, {
    search: () => [
      { documentId: 'quality', title: '经营指标口径规范', version: '2026', section: '数据质量', page: '2', content: '多来源口径差异必须保留原值并核对。', sourcePath: 'quality.md', category: 'quality' },
      { documentId: 'audit', title: '外部审计作业标准', version: '2026', section: '审计归档', page: '9', content: '完成审计底稿归档。', sourcePath: 'audit.md', category: 'audit' },
    ],
    refine: async input => { receivedKnowledge = input.knowledge; return { text: '依据经营指标口径规范核对差异。[K1]', model: 'north-cockpit' } },
    knowledgeDbPath: '/tmp/knowledge.db',
    hermes: { baseUrl: 'http://127.0.0.1:8650', apiKey: 'test-key', model: 'north-cockpit' },
  })
  assert.deepEqual(receivedKnowledge.map(item => item.documentId), ['quality'])
  assert.deepEqual(result.citations.map(item => item.documentId), ['quality'])
})

test('operating anomalies trigger targeted approved-standard retrieval', async () => {
  const queries: string[] = []
  let receivedKnowledge: any[] = []
  const overview = {
    ...baseline,
    topic: 'overview' as const,
    signals: [
      { code: 'aph-budget-gap' as const, level: 'warning' as const, title: '累计回款低于累计预算', evidence: '累计执行低于累计预算。' },
      { code: 'aph-source-mismatch' as const, level: 'warning' as const, title: 'APH多来源口径存在差异', evidence: '年度预算来源差异。' },
    ],
  }
  await orchestrateAssistantAnswer({ question: '当前异常有什么管理建议', evidence: overview, context, history: [] }, {
    search: query => {
      queries.push(query)
      if (query.includes('PM4-KF-01')) return [
        { documentId: 'collection-standard', title: 'PM4-KF-01 第一服务费用收缴作业标准', version: '12.0', section: '催缴流程', page: '4', content: '按欠费阶段开展催缴并留存凭证。', sourcePath: 'kf01.md', category: 'collection' },
      ]
      if (query.includes('真实性门禁')) return [
        { documentId: 'truth-gate', title: '华北经营数据真实性门禁', version: '1.0', section: '数据质量责任流', page: null, content: '跨源差异应保留原值并进入数据质量责任流。', sourcePath: 'truth.md', category: 'quality' },
      ]
      return []
    },
    refine: async input => {
      receivedKnowledge = input.knowledge
      return { text: '当前事实：存在回款缺口。\n异常判断：回款及口径差异预警。\n标准依据：按欠费阶段催缴并保留原值。[K1][K2]\n管理建议：分阶段催缴，差异进入责任流。[K1][K2]', model: 'north-cockpit' }
    },
    knowledgeDbPath: '/tmp/knowledge.db',
    hermes: { baseUrl: 'http://127.0.0.1:8650', apiKey: 'test-key', model: 'north-cockpit' },
  })
  assert.ok(queries.some(query => query.includes('PM4-KF-01')))
  assert.ok(queries.some(query => query.includes('华北经营数据真实性门禁')))
  assert.deepEqual(receivedKnowledge.map(item => item.documentId), ['collection-standard', 'truth-gate'])
})
