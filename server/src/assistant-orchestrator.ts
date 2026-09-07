import type { RegionalAssistantAnswer, RegionalAssistantContext } from './regional-assistant-core.js'
import { searchApprovedKnowledge, standardCodesIn, type KnowledgeExcerpt, type KnowledgeSearchOptions } from './knowledge-retriever.js'
import { refineWithHermes, type HermesClientConfig, type HermesRefineInput, type HermesRefineResult } from './hermes-client.js'

export type AssistantCitation = {
  documentId: string
  title: string
  version: string
  section: string
  page: string | null
}

export type AssistantKnowledgeChoice = {
  documentId: string
  title: string
  version: string
  scope: string | null
  question: string
}

export type AssistantOpinion = {
  label: 'AI意见'
  judgement: string
  recommendations: string | null
  priorityStrategy: string | null
  tieredActions: string | null
  talkTrack: string | null
  riskPlan: string | null
  basis: {
    businessDate: string | null
    qualityStatus: RegionalAssistantAnswer['qualityStatus']
    sources: string[]
    signalCodes: string[]
  }
  limitations: string[]
  disclaimer: 'AI意见用于回款经营分析和执行参考，不替代业务确认或审批结论。'
}

export type AssistantOrchestrationInput = {
  question: string
  evidence: RegionalAssistantAnswer
  context: RegionalAssistantContext
  history: Array<{ role?: string; content?: string }>
  sessionId?: string
}

export type AssistantOrchestrationResult = {
  answer: string | null
  generatedBy: 'hermes-grounded' | 'verified-facts' | null
  modelUsed: string | null
  citations: AssistantCitation[]
  aiOpinion?: AssistantOpinion | null
  failure?: {
    code: 'AI_GENERATION_UNAVAILABLE' | 'APPROVED_KNOWLEDGE_UNAVAILABLE' | 'ASSISTANT_EVIDENCE_UNAVAILABLE' | 'KNOWLEDGE_SELECTION_REQUIRED'
    message: string
    knowledgeChoices?: AssistantKnowledgeChoice[]
  }
}

function opinionSection(text: string, labels: string[], stopLabels: string[]): string | null {
  const labelPattern = labels.join('|')
  const stopPattern = stopLabels.join('|')
  const matched = text.match(new RegExp(`(?:^|\\n)\\s*(?:${labelPattern})\\s*[:：]?\\s*([\\s\\S]*?)(?=\\n\\s*(?:${stopPattern})\\s*[:：]?|$)`, 'i'))
  return matched?.[1]?.trim() || null
}

function opinionField(section: string | null, label: string, labels: string[]): string | null {
  if (!section) return null
  const current = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const following = labels.filter(item => item !== label)
    .map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const end = following ? `(?=\\n\\s*(?:${following})\\s*[:：]|$)` : '$'
  return section.match(new RegExp(`(?:^|\\n)\\s*${current}\\s*[:：]\\s*([\\s\\S]*?)${end}`))?.[1]?.trim() || null
}

function joinedOpinionFields(section: string | null, labels: string[], allLabels: string[]): string | null {
  const fields = labels.flatMap((label, index) => {
    const value = opinionField(section, label, allLabels)
    if (!value) return []
    return [index === 0 ? value : `${label}：${value}`]
  })
  return fields.length ? fields.join('\n') : null
}

/** 将模型正文中的分析和动作拆成独立意见，避免前端把AI推断当作事实字段展示。 */
export function buildAssistantOpinion(
  modelText: string,
  evidence: RegionalAssistantAnswer,
): AssistantOpinion | null {
  if (evidence.topic === 'knowledge' || evidence.qualityStatus === 'unavailable') return null
  const visible = String(modelText || '').trim()
  if (!visible) return null
  const judgement = opinionSection(
    visible,
    ['AI判断', '异常判断', 'AI意见', '管理意见'],
    ['AI建议', '行动建议', '管理建议', '标准依据'],
  ) || visible
  const recommendations = opinionSection(
    visible,
    ['AI建议', '行动建议', '管理建议'],
    ['可信来源', '数据来源', '限制说明', '口径说明'],
  )
  const actionLabels = ['优先策略', '分层动作', '沟通话术', '谁来协同', '所需材料', '完成凭证', '风险预案', '升级条件']
  return {
    label: 'AI意见',
    judgement,
    recommendations,
    priorityStrategy: opinionField(recommendations, '优先策略', actionLabels),
    tieredActions: joinedOpinionFields(recommendations, ['分层动作', '谁来协同', '所需材料', '完成凭证'], actionLabels),
    talkTrack: opinionField(recommendations, '沟通话术', actionLabels),
    riskPlan: joinedOpinionFields(recommendations, ['风险预案', '升级条件'], actionLabels),
    basis: {
      businessDate: evidence.businessDate || null,
      qualityStatus: evidence.qualityStatus,
      sources: [...new Set((evidence.sources || []).map(source => source.name).filter(Boolean))],
      signalCodes: [...new Set((evidence.signals || []).map(signal => signal.code).filter(Boolean))],
    },
    limitations: [...new Set(evidence.limitations || [])],
    disclaimer: 'AI意见用于回款经营分析和执行参考，不替代业务确认或审批结论。',
  }
}

export type AssistantOrchestrationDependencies = {
  search?: (query: string, options: KnowledgeSearchOptions) => KnowledgeExcerpt[]
  refine?: (input: HermesRefineInput, config: HermesClientConfig) => Promise<HermesRefineResult | null>
  knowledgeDbPath: string
  hermes: HermesClientConfig
}

function topicScopedContext(topic: RegionalAssistantAnswer['topic'], context: RegionalAssistantContext, evidence: RegionalAssistantAnswer): unknown {
  const operatingSignals = evidence.signals || []
  if (topic === 'knowledge') return { readOnly: true, knowledgeOnly: true, operatingSignals: [] }
  if (topic === 'collection') {
    const { rows: _rows, ...collection } = context.collection
    return { collection, collectionCenter: evidence.collectionCenter || null, facts: evidence.facts || null, quality: context.quality, operatingSignals }
  }
  if (topic === 'arrears') return { arrears: context.arrears, quality: context.quality, operatingSignals }
  if (topic === 'aph' && evidence.centerPaymentLookup) return {
    facts: evidence.facts || null,
    paymentCenter: evidence.centerPayment || null,
    source: evidence.sources[0] || null,
    limitations: evidence.limitations,
    operatingSignals,
  }
  // 地区APH问答只向模型发送正式卡片事实。中心明细和对账差异保留在服务端，
  // 避免同名字段的其他口径干扰单指标回答；差异只通过文字限制披露。
  if (topic === 'aph') return {
    facts: evidence.facts || null,
    source: evidence.sources[0] || null,
    qualityStatus: evidence.qualityStatus,
    limitations: evidence.limitations,
    operatingSignals,
  }
  return {
    ...context,
    paymentCenters: {
      ready: context.paymentCenters.ready,
      businessDate: context.paymentCenters.businessDate,
      source: context.paymentCenters.source,
      reason: context.paymentCenters.reason,
      scopedRowCount: context.paymentCenters.rows.length,
    },
    facts: evidence.facts || null,
    operatingSignals,
  }
}

function centerAdviceContext(evidence: RegionalAssistantAnswer): unknown {
  return {
    serviceCenterName: evidence.centerPayment?.center || null,
    operatingSignals: evidence.signals || [],
    sourceStatus: evidence.qualityStatus,
    limitations: evidence.limitations,
  }
}

function centerSnapshotAnswer(evidence: RegionalAssistantAnswer, advice: string): string {
  const center = evidence.centerPayment!
  const facts = (evidence.facts || {}) as Record<string, any>
  const money = (value: number | null | undefined) => value === null || value === undefined ? '暂不可用' : `${Number(value).toFixed(2)}万`
  const rate = (value: number | null | undefined) => value === null || value === undefined ? '暂不可用' : `${Number(value).toFixed(2)}%`
  const signalLines = (evidence.signals || []).map(signal => `- ${signal.title}`).join('\n') || '- 当前已核验指标中未发现未达标项'
  return [
    '中心数据',
    `服务中心：${center.center}（${center.area}）`,
    `业务日期：${center.businessDate}`,
    `年度预算：${money(center.annualBudget)}`,
    `累计预算：${money(center.cumulativeBudget)}`,
    `累计执行：${money(center.cumulativeExecuted)}`,
    `累计预算完成率：${rate(facts.cumulativeCompletionRate)}`,
    `累计预算差额：${money(facts.cumulativeVariance)}`,
    `同期回款：${money(center.samePeriod)}`,
    `同期差额：${money(facts.samePeriodVariance)}`,
    `同比：${rate(facts.yearOverYearGrowthRate)}`,
    `年度执行率：${rate(facts.annualExecutionRate)}`,
    `当日回款：${money(center.dailyCollection)}`,
    '',
    '未达标项',
    signalLines,
    '',
    advice.trim(),
  ].join('\n')
}

type CenterResponseMode = 'snapshot' | 'metrics' | 'analysis' | 'actions'

function centerResponseMode(question: string): CenterResponseMode {
  const value = String(question || '')
  if (/三个优先动作|三项优先动作/.test(value)) return 'actions'
  if (/异常重点|分析异常|风险重点/.test(value)) return 'analysis'
  if (/哪些指标(?:没有|没|未)达标|未达标指标|看未达标/.test(value) && !/建议|动作/.test(value)) return 'metrics'
  return 'snapshot'
}

function centerMetricsAnswer(evidence: RegionalAssistantAnswer): string {
  const signals = evidence.signals || []
  return [
    '未达标指标',
    ...(signals.length
      ? signals.flatMap(signal => [`- ${signal.title}`, `  ${signal.evidence}`])
      : ['- 当前已核验指标中未发现未达标项']),
  ].join('\n')
}

function visibleCenterAdvice(advice: string): string {
  return advice.split('\n')
    .filter(line => !/^\s*(?:可信来源|数据来源|来源状态|业务日期|质量状态)\s*[:：]/.test(line))
    .filter(line => !/^\s*(?:以上|本次|本分析)[^。\n]{0,36}(?:基于|来源|数据状态|warning)/i.test(line))
    .filter(line => !/^\s*(?:说明|限制说明|口径说明)\s*[:：][^\n]{0,160}(?:sourceStatus|来源|数据状态|warning|待复核口径差异)/i.test(line))
    .join('\n')
    .trim()
}

function centerAnalysisAnswer(advice: string): string {
  const visible = visibleCenterAdvice(advice)
  const match = visible.match(/(?:^|\n)\s*AI判断\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:AI建议|行动建议)\s*[:：]|$)/)
  return ['异常重点', (match?.[1] || visible).trim()].join('\n')
}

function centerActionsAnswer(advice: string): string {
  const visible = visibleCenterAdvice(advice)
  const match = visible.match(/(?:^|\n)\s*(?:AI建议|行动建议)\s*[:：]\s*([\s\S]*)$/)
  const actionSection = (match?.[1] || visible)
    .replace(/^\s*一线执行卡\s*(?:\n|$)/, '')
    .trim()
  // 前端把该固定前缀识别为快捷追问结果，只展示结构化 AI 意见一次，
  // 避免正文和 aiOpinion.recommendations 重复渲染同一张执行卡。
  return ['三个优先动作', actionSection].join('\n')
}

function centerAnswerForMode(evidence: RegionalAssistantAnswer, advice: string, mode: CenterResponseMode): string {
  if (mode === 'metrics') return centerMetricsAnswer(evidence)
  if (mode === 'analysis') return centerAnalysisAnswer(advice)
  if (mode === 'actions') return centerActionsAnswer(advice)
  return centerSnapshotAnswer(evidence, visibleCenterAdvice(advice))
}

const TOPIC_KNOWLEDGE_TERMS: Record<RegionalAssistantAnswer['topic'], string[]> = {
  aph: ['回款', '预算', '同比', '同期', '完成率', '催缴', '欠费', '收缴'],
  collection: ['收缴', '收费', '物业费', '应收', '实收', '欠费', '催缴'],
  arrears: ['欠费', '账龄', '催缴', '企小码', '物业费', '律师函', '诉讼'],
  quality: ['数据质量', '口径', '差异', '对账', '血缘', '真实性'],
  project: ['项目经营', '项目管理', '品质', '安全', '满意度', '投诉'],
  knowledge: ['作业标准', '标准', '制度', '流程', '办法', '规范', '规定', '指引', '手册', '一级专业', '二级专业', '三级专业', '专业设置', '专业结构', '体系文件'],
  overview: ['经营', '回款', '预算', '收缴', '数据质量', '口径', '差异'],
}

function matchesRequestedStandardCode(item: KnowledgeExcerpt, requestedCode: string): boolean {
  return [item.documentId, item.title, item.sourcePath, item.category]
    .some(value => standardCodesIn(value).includes(requestedCode))
}

function knowledgeTerms(input: AssistantOrchestrationInput): string[] {
  const terms = new Set(TOPIC_KNOWLEDGE_TERMS[input.evidence.topic])
  for (const signal of input.evidence.signals || []) {
    if (signal.code === 'aph-budget-gap' || signal.code === 'aph-yoy-decline') {
      for (const term of TOPIC_KNOWLEDGE_TERMS.aph) terms.add(term)
    }
    if (signal.code === 'aph-source-mismatch' || signal.code === 'data-quality-open') {
      for (const term of TOPIC_KNOWLEDGE_TERMS.quality) terms.add(term)
    }
    if (signal.code === 'project-gate-blocked') {
      for (const term of TOPIC_KNOWLEDGE_TERMS.project) terms.add(term)
    }
  }
  return [...terms]
}

function directKnowledgeNeedles(question: string): string[] {
  const normalized = question.normalize('NFKC')
    .replace(/[\s,，。.!！?？:：;；'"“”‘’()（）[\]【】{}<>《》/_—–-]/g, '')
    .replace(/请问|请介绍|请说明|请列出|请告诉我|帮我查|帮我看|告诉我|是什么|有哪些|分别是|相关内容|相关/g, '')
  const withoutBrand = normalized.replace(/第一服务/g, '')
  return [...new Set([normalized, withoutBrand]
    .map(item => item.trim())
    .filter(item => item.length >= 4))]
}

function directKnowledgeScore(item: KnowledgeExcerpt, needles: string[]): number {
  let score = 0
  for (const needle of needles) {
    if (item.title.normalize('NFKC').replace(/\s/g, '').includes(needle)) score = Math.max(score, 300 + needle.length)
    else if (item.section.normalize('NFKC').replace(/\s/g, '').includes(needle)) score = Math.max(score, 200 + needle.length)
    else if (item.content.normalize('NFKC').replace(/\s/g, '').includes(needle)) score = Math.max(score, 100 + needle.length)
  }
  return score
}

function normalizedKnowledgeTitle(value: string): string {
  return value.normalize('NFKC')
    .replace(/^\s*[A-Z][A-Z0-9]{1,15}(?:-[A-Z][A-Z0-9]{0,15})?-\d+\s*/i, '')
    .replace(/[\s,，。.!！?？:：;；'"“”‘’()（）[\]【】{}<>《》/_—–-]/g, '')
}

/**
 * 用户未指定子公司时，完整匹配“第一服务 + 标准名称”的集团标准优先。
 * 若用户明确写出上诚、亚航等主体，完整标题仍会精确命中对应文档。
 */
function exactOrganizationTitleMatches(question: string, items: KnowledgeExcerpt[]): KnowledgeExcerpt[] {
  const needles = directKnowledgeNeedles(question)
  const exactTitles = new Set(needles.flatMap(needle => [needle, `第一服务${needle}`]))
  return items.filter(item => exactTitles.has(normalizedKnowledgeTitle(item.title)))
}

function knowledgeScope(content: string): string | null {
  const match = String(content || '').match(/适用于[^。；\n]{2,80}/)
  return match ? match[0].trim() : null
}

function knowledgeSelectionChoices(input: AssistantOrchestrationInput, items: KnowledgeExcerpt[]): AssistantKnowledgeChoice[] {
  if (input.evidence.topic !== 'knowledge' || standardCodesIn(input.question).length) return []
  const needles = directKnowledgeNeedles(input.question)
  return items
    .filter(item => directKnowledgeScore(item, needles) >= 300)
    .map(item => ({
      documentId: item.documentId,
      title: item.title,
      version: item.version,
      scope: knowledgeScope(item.content),
      // 点击后携带完整标题和标准编号，下一次检索只能命中该文档。
      question: item.title,
    }))
}

function filterTopicRelevantKnowledge(input: AssistantOrchestrationInput, knowledge: KnowledgeExcerpt[], requestedCode?: string): KnowledgeExcerpt[] {
  if (requestedCode) return knowledge
  if (input.evidence.topic === 'knowledge') {
    const needles = directKnowledgeNeedles(input.question)
    const directMatches = knowledge
      .map((item, index) => ({ item, index, score: directKnowledgeScore(item, needles) }))
      .filter(match => match.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map(match => match.item)
    if (directMatches.length) return directMatches
  }
  const terms = knowledgeTerms(input)
  return knowledge.filter(item => {
    const searchable = `${item.title}\n${item.section}\n${item.content}`
    const matchedTerms = terms.filter(term => searchable.includes(term))
    const titleMatches = terms.some(term => item.title.includes(term))
    return titleMatches || matchedTerms.length >= 3
  })
}

function knowledgeQueries(input: AssistantOrchestrationInput, requestedCode?: string): string[] {
  const broadQuery = [input.question, ...(input.evidence.signals || []).map(signal => signal.title)].join(' ')
  if (requestedCode) return [broadQuery]
  const queries: string[] = []
  const signalCodes = new Set((input.evidence.signals || []).map(signal => signal.code))
  // APH问题先找指标口径与三来源勾稽，避免通用制度文档挤占最相关知识。
  if (input.evidence.topic === 'aph') {
    queries.push('华北经营指标口径 APH累计回款执行 同期差异 同比')
    if (input.evidence.qualityStatus === 'warning' || signalCodes.has('aph-source-mismatch')) {
      queries.push('APH三来源勾稽说明 华北地区卡片 中心明细 口径差异')
    }
  }
  if (input.evidence.topic === 'collection' || input.evidence.topic === 'arrears' || signalCodes.has('aph-budget-gap') || signalCodes.has('aph-yoy-decline')) {
    queries.push('PM4-KF-01 费用收缴 催缴 欠费')
  }
  if (input.evidence.topic === 'quality' || signalCodes.has('aph-source-mismatch') || signalCodes.has('data-quality-open') || signalCodes.has('project-gate-blocked')) {
    queries.push('华北经营数据真实性门禁 数据质量责任流 口径差异')
  }
  queries.push(broadQuery)
  return queries
}

function usableKnowledgeChunks(items: KnowledgeExcerpt[]): KnowledgeExcerpt[] {
  const seen = new Set<string>()
  return items.filter(item => {
    if (item.section === '主附件索引' || item.section === '标准元数据') return false
    const key = `${item.documentId}\u0000${item.section}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function mergeCenterKnowledgeByDocument(items: KnowledgeExcerpt[]): KnowledgeExcerpt[] {
  const grouped = new Map<string, KnowledgeExcerpt[]>()
  for (const item of items) grouped.set(item.documentId, [...(grouped.get(item.documentId) || []), item])
  return [...grouped.values()].map(chunks => {
    const first = chunks[0]
    const sections = [...new Set(chunks.map(item => item.section).filter(Boolean))]
    const pages = [...new Set(chunks.map(item => item.page).filter((page): page is string => Boolean(page)))]
    return {
      ...first,
      section: sections.join('、'),
      page: pages.length === 1 ? pages[0] : null,
      // 同一标准的相关片段合并为一个K编号，避免模型把动作原文与引用编号错配。
      content: chunks.map(item => item.content).join('\n').slice(0, 6_000),
    }
  })
}

function citedKnowledgeIndexes(answer: string, knowledgeCount: number): number[] {
  const indexes: number[] = []
  const seen = new Set<number>()
  for (const match of answer.matchAll(/\[K(\d+)\]/gi)) {
    const index = Number(match[1]) - 1
    if (index < 0 || index >= knowledgeCount || seen.has(index)) continue
    seen.add(index)
    indexes.push(index)
  }
  return indexes
}

export function shanghaiPolicyDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

function directAphFactAnswer(question: string, evidence: RegionalAssistantAnswer): string | null {
  if (evidence.topic !== 'aph' || evidence.centerPaymentLookup) return null
  const facts = (evidence.facts || {}) as Record<string, unknown>
  const money = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
    ? `${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}万元`
    : null
  const percent = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(2)}%`
    : null
  const candidates: Array<{ pattern: RegExp; label: string; value: string | null }> = [
    { pattern: /累计预算[^。！？\n]*多少/, label: '华北地区累计预算', value: money(facts.cumulativeBudget) },
    { pattern: /(?:年度|全年)预算[^。！？\n]*多少/, label: '华北地区年度预算', value: money(facts.annualBudget) },
    { pattern: /累计(?:执行|回款)[^。！？\n]*多少/, label: '华北地区累计执行', value: money(facts.cumulativeExecuted) },
    { pattern: /同期(?:执行|回款)?[^。！？\n]*多少/, label: '华北地区同期执行', value: money(facts.samePeriod) },
    { pattern: /累计(?:预算)?完成率[^。！？\n]*多少/, label: '华北地区累计预算完成率', value: percent(facts.cumulativeCompletionRate) },
    { pattern: /同比[^。！？\n]*多少/, label: '华北地区同比', value: percent(facts.yearOverYearGrowthRate) },
  ]
  const matched = candidates.find(item => item.pattern.test(question))
  if (!matched?.value) return null
  const qualityNote = evidence.qualityStatus === 'warning' || evidence.limitations.length
    ? '当前来源状态为warning，存在待复核的多来源口径差异。'
    : ''
  return `${matched.label}为${matched.value}。${qualityNote}`
}

export async function orchestrateAssistantAnswer(
  input: AssistantOrchestrationInput,
  dependencies: AssistantOrchestrationDependencies,
): Promise<AssistantOrchestrationResult> {
  if (input.evidence.centerPaymentLookup && input.evidence.centerPaymentLookup !== 'matched') {
    return {
      answer: null, generatedBy: null, modelUsed: null, citations: [],
      failure: { code: 'ASSISTANT_EVIDENCE_UNAVAILABLE', message: '未找到可唯一核验的权限内业务事实' },
    }
  }
  if ((input.evidence.topic === 'project' || input.evidence.topic === 'arrears') && input.evidence.qualityStatus === 'unavailable') {
    return {
      answer: null, generatedBy: null, modelUsed: null, citations: [],
      failure: { code: 'ASSISTANT_EVIDENCE_UNAVAILABLE', message: '当前业务事实未通过真实性或权限门禁' },
    }
  }
  // 单中心收缴率是已经通过正式发布、权限与字段门禁的确定事实，直接返回，
  // 不让模型把华北汇总或其他中心数据混入简单查询。
  if (input.evidence.topic === 'collection' && input.evidence.centerPaymentLookup === 'matched' && input.evidence.collectionCenter) {
    const center = input.evidence.collectionCenter
    return {
      answer: [
        `${center.center}收缴率：${center.rate.toFixed(2)}%`,
        `应收：${center.receivable.toFixed(2)}万`,
        `实收：${center.received.toFixed(2)}万`,
        `待收：${center.outstanding.toFixed(2)}万`,
      ].join('\n'),
      generatedBy: 'verified-facts',
      modelUsed: null,
      citations: [],
    }
  }
  const centerAdviceOnly = input.evidence.centerPaymentLookup === 'matched'
  const requestedMode = centerResponseMode(input.question)
  const selectedCenterMode = centerAdviceOnly ? requestedMode : 'snapshot'
  // “看未达标指标”只复述已通过权限和真实性门禁的结构化事实。
  // 不调用模型补写分析或动作，避免无关建议校验影响纯数据查询。
  if (requestedMode === 'metrics') {
    return {
      answer: centerMetricsAnswer(input.evidence),
      generatedBy: 'verified-facts',
      modelUsed: null,
      citations: [],
    }
  }
  // 已验证的地区单指标查询直接返回事实，避免模型换算、漏单位或扩写其他数字。
  const directAphAnswer = directAphFactAnswer(input.question, input.evidence)
  if (directAphAnswer) {
    return {
      answer: directAphAnswer,
      generatedBy: 'verified-facts',
      modelUsed: null,
      citations: [],
    }
  }
  const search = dependencies.search || searchApprovedKnowledge
  const refine = dependencies.refine || refineWithHermes
  // 知识有效期按当前政策日期判断，不沿用每日快照中较早的业务日期。
  // 两类日期必须分开，确保当前已批准制度可以解释历史经营事实。
  const asOf = shanghaiPolicyDate()
  const requestedCodes = standardCodesIn(input.question)
  const requestedCode = requestedCodes[0]
  const queries = requestedCodes.length ? requestedCodes : knowledgeQueries(input)
  const searchedKnowledge = queries.flatMap(query => search(query, {
    dbPath: dependencies.knowledgeDbPath,
    domain: 'north-operations',
    asOf,
    // 自然语言制度问句需要覆盖集团标准与子公司同名标准，不能让 FTS 前5条
    // 偶然排序把子公司文件误当成唯一答案。
    limit: input.evidence.topic === 'knowledge' ? 10 : 5,
  }))
  const retrievedKnowledge = usableKnowledgeChunks(requestedCodes.length
    ? searchedKnowledge.filter(item => requestedCodes.some(code => matchesRequestedStandardCode(item, code)))
    : searchedKnowledge)
  const relevantKnowledge = filterTopicRelevantKnowledge(input, retrievedKnowledge, requestedCode)
  const mergedKnowledge = (input.evidence.centerPaymentLookup === 'matched' || input.evidence.topic === 'knowledge'
    ? mergeCenterKnowledgeByDocument(relevantKnowledge)
    : relevantKnowledge)
  const exactTitleKnowledge = input.evidence.topic === 'knowledge' && !requestedCodes.length
    ? exactOrganizationTitleMatches(input.question, mergedKnowledge)
    : []
  const selectedKnowledge = exactTitleKnowledge.length ? exactTitleKnowledge : mergedKnowledge
  const knowledgeChoices = knowledgeSelectionChoices(input, selectedKnowledge)
  if (knowledgeChoices.length > 1) {
    return {
      answer: null,
      generatedBy: null,
      modelUsed: null,
      citations: [],
      failure: {
        code: 'KNOWLEDGE_SELECTION_REQUIRED',
        message: '找到多个有效标准，请选择要查询的版本和适用范围。',
        knowledgeChoices,
      },
    }
  }
  // 服务中心经营建议只需要少量最相关知识约束动作边界。
  // 限制长文输入，避免模型把制度正文当成建议主体，也降低真实调用延迟。
  const knowledge = selectedKnowledge
    // 服务中心建议只需要一个最相关的制度边界。其余判断应由模型结合
    // 已验证经营信号完成，避免长篇制度正文挤占事实推理与响应时间。
    .slice(0, input.evidence.topic === 'knowledge' ? 1 : centerAdviceOnly ? 1 : 8)
    .map(item => centerAdviceOnly ? { ...item, content: item.content.slice(0, 1_800) } : item)
  if (input.evidence.topic === 'knowledge' && !knowledge.length) {
    return {
      answer: null,
      generatedBy: null,
      modelUsed: null,
      citations: [],
      failure: { code: 'APPROVED_KNOWLEDGE_UNAVAILABLE', message: '当前没有检索到相关的已批准有效知识' },
    }
  }
  const missingRequestedCodes = requestedCodes.filter(code => !knowledge.some(item => matchesRequestedStandardCode(item, code)))
  if (missingRequestedCodes.length) {
    return {
      answer: null,
      generatedBy: null,
      modelUsed: null,
      citations: [],
      failure: {
        code: 'APPROVED_KNOWLEDGE_UNAVAILABLE',
        message: `${missingRequestedCodes.join('、')}当前没有通过审批并进入知识库的有效正文`,
      },
    }
  }
  const threeActionInstruction = selectedCenterMode === 'actions'
    ? '本次用户明确要“三个优先动作”。在“分层动作：”后换行，依次输出“动作一：”“动作二：”“动作三：”三行：动作一负责筛选、分类；动作二负责联系、发送；动作三负责跟进、催缴。三项必须使用不同的核心动作并形成先后衔接，不得重复或同义改写同一个动作。'
    : ''
  const modelQuestion = centerAdviceOnly
    ? `请针对${input.evidence.centerPayment?.center || '该服务中心'}的这些已核验未达标项，给出能让一线直接照着做的回款建议：${(input.evidence.signals || []).map(signal => `${signal.title}（${signal.evidence}）`).join('；') || '无未达标项'}。系统提供的数据已经通过当前门禁，正文不要质疑数据准确性，不讨论口径差异、对账、核对数据或缺少明细。不要写制度摘抄和“持续关注、加强管理”一类空话。先输出“AI判断：”，逐行包含“回款重点：”“优先级理由：”“待核实原因：”；优先级理由必须结合一个已核验未达标项说明为什么先做，待核实原因只能提出带“可能、不能排除或需验证”标记的业务假设，并写明用欠费清单、沟通记录或付款承诺中的什么材料验证，不能把假设写成事实。再输出“AI建议：”，按一张“一线执行卡”逐行包含“优先策略：”“分层动作：”“沟通话术：”“谁来协同：”“所需材料：”“完成凭证：”“风险预案：”“升级条件：”。优先策略按优先层、跟进层、升级层说明催缴顺序；分层动作使用筛选、分类、联系、发送、上门、约定、跟进、催缴等直接动词；沟通话术必须是一线可直接使用的礼貌表达，可用【客户称呼】【账单】【约定时间】等占位符，不得编造金额或日期；谁来协同只写岗位，不指定个人；所需材料只列回款材料；完成凭证写到账凭证、付款承诺或催缴记录；风险预案和升级条件都用“若…则…”覆盖争议、拒付、失联或承诺未兑现。${threeActionInstruction}以上判断和策略必须由AI结合当前回款信号形成，已批准知识只约束动作边界，不要在正文解释或复述制度；整张建议末尾标注支持它的[K编号]。只能复述题面已有数字，禁止计算占比、偏差率或新增期限、次数和数值阈值。`
    : input.evidence.topic === 'knowledge'
      ? `${input.question}。请只根据最相关的已批准有效知识直接回答；若用户询问名称或清单，先完整列出答案，再作一句必要说明。正文不要展示文件名称、版本或来源；必须引用实际使用的[K编号]供系统内部校验，不得编造条款或执行结果。`
    : input.question
  const modelResult = await refine({
    question: modelQuestion,
    context: centerAdviceOnly
      ? centerAdviceContext(input.evidence)
      : topicScopedContext(input.evidence.topic, input.context, input.evidence),
    history: input.history,
    knowledge: knowledge.map(item => ({
      documentId: item.documentId,
      title: item.title,
      version: item.version,
      section: item.section,
      page: item.page,
      content: item.content,
      identifiers: [...new Set([item.documentId, item.title, item.sourcePath, item.category]
        .flatMap(value => standardCodesIn(value)))],
    })),
    sessionId: input.sessionId,
  }, dependencies.hermes)
  if (!modelResult) {
    return {
      answer: null, generatedBy: null, modelUsed: null, citations: [],
      failure: { code: 'AI_GENERATION_UNAVAILABLE', message: 'AI回答服务暂时不可用，请稍后重试' },
    }
  }
  const citedKnowledge = citedKnowledgeIndexes(modelResult.text, knowledge.length).map(index => knowledge[index])
  return {
    answer: centerAdviceOnly ? centerAnswerForMode(input.evidence, modelResult.text, selectedCenterMode) : modelResult.text,
    generatedBy: 'hermes-grounded',
    modelUsed: modelResult.model,
    aiOpinion: buildAssistantOpinion(modelResult.text, input.evidence),
    citations: citedKnowledge.map(item => ({
      documentId: item.documentId,
      title: item.title,
      version: item.version,
      section: item.section,
      page: item.page,
    })),
  }
}
