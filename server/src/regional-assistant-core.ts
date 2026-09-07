export type SourceEvidence = {
  name: string
  businessDate: string | null
  status: 'verified' | 'warning' | 'unavailable'
  note?: string
}

export type AphReconciliation = {
  label: string
  left: number | null
  right: number | null
  difference: number | null
  status: string
}

export type PaymentCenterFact = {
  area: string
  center: string
  annualBudget: number
  cumulativeBudget: number
  cumulativeExecuted: number
  samePeriod: number | null
  dailyCollection: number | null
  businessDate: string
  source: string
}

export type PaymentCenterContext = {
  ready: boolean
  businessDate: string | null
  source: string
  reason: string | null
  dailyCollectionReason?: string | null
  rows: PaymentCenterFact[]
}

export type CollectionCenterFact = {
  area: string
  center: string
  rate: number
  receivable: number
  received: number
  outstanding: number
  businessDate: string
  source: string
}

export type RegionalAssistantContext = {
  aph: {
    ready: boolean
    annualBudget: number | null
    cumulativeBudget: number | null
    cumulativeExecuted: number | null
    samePeriod: number | null
    growth: number | null
    businessDate: string | null
    source: string
    reconciliations: AphReconciliation[]
    centerDetail: {
      source: string
      businessDate: string | null
      centerCount: number | null
      annualBudget: number | null
      cumulativeBudget: number | null
      cumulativeExecuted: number | null
      samePeriod: number | null
      samePeriodPresentCount: number | null
      samePeriodMissingCount: number | null
    }
  }
  paymentCenters: PaymentCenterContext
  collection: {
    ready: boolean
    rate: number | null
    receivable: number | null
    received: number | null
    outstanding: number | null
    amountNote: string
    centerCount: number
    businessDate: string | null
    source: string
    rows?: CollectionCenterFact[]
  }
  arrears: {
    ready: boolean
    activeBatchCount: number
    revokedBatchCount: number
    projectCount: number
    resourceCount: number
    totalAmount: number | null
    pendingReviewCount: number
    confirmedReviewCount: number
    latestBusinessDate: string | null
    topCauses: Array<{ category: string; count: number }>
    source: string
  }
  projects: { ready: boolean; count: number; reason: string | null }
  quality: { openCaseCount: number; status: 'verified' | 'warning' | 'unavailable'; notes: string[] }
}

export type RegionalAssistantAnswer = {
  topic: 'aph' | 'collection' | 'arrears' | 'quality' | 'project' | 'knowledge' | 'overview'
  answer: string
  businessDate: string | null
  qualityStatus: 'verified' | 'warning' | 'unavailable'
  sources: SourceEvidence[]
  limitations: string[]
  signals?: OperatingSignal[]
  centerPayment?: PaymentCenterFact
  centerPaymentLookup?: 'matched' | 'ambiguous' | 'not-found' | 'unavailable'
  centerPaymentCandidates?: string[]
  collectionCenter?: CollectionCenterFact
  /** 仅供检索与模型生成使用的结构化事实，不是预制业务答案。 */
  facts?: Record<string, unknown>
}

export type OperatingSignal = {
  code: 'aph-budget-gap' | 'aph-yoy-decline' | 'aph-source-mismatch' | 'data-quality-open' | 'project-gate-blocked'
  level: 'warning' | 'blocked'
  title: string
  evidence: string
}

const money = (value: number | null) => value === null
  ? '—'
  : `${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}万`

const percent = (value: number | null) => value === null ? '—' : `${value.toFixed(2)}%`
/** 正式收缴批次中的收缴率使用0-1比例；界面统一显示0-100百分数。 */
export function ratioToPercent(value: number | null): number | null {
  return value === null ? null : value * 100
}

const EXPLICIT_PAYMENT_INTENT = /回款|回款额|累计执行|累计预算|年度预算|年度进度|预算完成率|回款完成率/
const PAYMENT_COMPARISON_INTENT = /同比|同期/
const PROJECT_INTENT = /项目|小区|写字楼|公建|利润|成本|毛利|收入|投诉|安全事故|品质评分|品质|满意度/
const PROJECT_OPERATING_INTENT = /利润|成本|毛利|收入|投诉|安全事故|品质评分|品质|满意度/
const CENTER_SNAPSHOT_INTENT = /数据|指标|经营|表现|达标|未达标|异常|重点|建议|动作|优先|分析|情况|怎么样|如何|看看|看一下/
const DATA_QUALITY_INTENT = /差异|不一致|口径|数据质量|真实性|责任单|异常数据|三套预算|三层来源/
const EXPLICIT_DATA_QUALITY_INTENT = /不一致|口径|数据质量|真实性|责任单|异常数据|三套预算|三层来源/
const KNOWLEDGE_INTENT = /作业标准|标准|制度|流程|办法|规范|规定|指引|操作手册|工作手册|知识库|一级专业|二级专业|三级专业|专业设置|专业结构|体系文件/
const REGIONAL_REFERENCE = /^(华北|全华北|全地区|整体|全部|公司)/

function normalizeCenterText(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s·•・,，。.!！?？:：;；'"“”‘’()（）[\]【】{}<>《》/_—–-]/g, '')
    .replace(/mom[Λλa]/giu, '')
}

const CENTER_PREFIXES = ['北京', '天津', '保定', '营口', '石家庄', '张家口', '葫芦岛', '廊坊', '青岛', '东戴河']
const CENTER_LOCALITY_PREFIXES = ['龙港区', '新基业', '东戴河', '当代', '通州', '西山', '朝阳', '顺义', '采育', '亦庄', '易县']
const CENTER_REFERENCE_NOISE = /只返回已核验数据|可信来源|请引用|引用|来源|官方|绿仔|项目经营|服务中心|体验中心|项目部|回款完成率|预算完成率|累计回款|累计执行|累计预算|累计|年度预算|年度进度|回款额|回款|收缴率|收费率|物业费|应收|实收|未收|待收|数据质量问题|质量问题|问题|差异|同比|同期|完成率|执行率|完成|数据|指标|经营|表现|达标|未达标|异常|重点|优先动作|动作|优先|建议|分析|有没有|是否有|有哪些|有什么|有哪项|有无|有啥|是否|哪些|哪项|哪一个|哪个|最好|最差|排名|排行|没有|没|给我|项目|小区|写字楼|公建|中心|片区|今年|本年|去年|今天|今日|本日|昨天|昨日|当前|现在|截至|截止|请问|请|帮我|看一下|看看|怎么样|如何|多少|是多少|什么|情况|较|比|少|多|和|与|的|呢|吗/g
const GENERIC_CENTER_REFERENCES = new Set([...CENTER_PREFIXES, '华北', '全华北', '全地区', '整体', '全部', '公司', '服务', '中心', '项目'])

function stripKnownPrefix(value: string, prefixes: string[]): string {
  const prefix = [...prefixes].sort((left, right) => right.length - left.length).find(item => value.startsWith(item))
  return prefix ? value.slice(prefix.length) : value
}

function localityAliases(value: string): string[] {
  const aliases = new Set<string>()
  let current = value
  while (current.length >= 2 && !aliases.has(current)) {
    aliases.add(current)
    const withoutZoneSuffix = current.replace(/(?:东|西|南|北)区$/, '')
    if (withoutZoneSuffix.length >= 2) aliases.add(withoutZoneSuffix)
    const withoutLocality = stripKnownPrefix(current, CENTER_LOCALITY_PREFIXES)
    if (withoutLocality === current || withoutLocality.length < 2) break
    current = withoutLocality
  }
  return [...aliases]
}

function centerAliases(center: string): string[] {
  const full = normalizeCenterText(center)
  const withoutBrand = full.replace(/^(第一服务|第一酒店)/, '')
  const fullWithoutSuffix = full.replace(/(项目部服务中心|服务中心|体验中心|项目部|中心)$/, '')
  const withoutSuffix = withoutBrand.replace(/(项目部服务中心|服务中心|体验中心|项目部|中心)$/, '')
  const withoutCity = stripKnownPrefix(withoutSuffix, CENTER_PREFIXES)
  return [...new Set([
    full,
    fullWithoutSuffix,
    withoutBrand,
    withoutSuffix,
    ...localityAliases(withoutCity),
  ].filter(value => value.length >= 2))]
}

/** 仅提取用户明确写出的中心名片段；不再从每个中心名称生成任意二字子串。 */
function centerReferenceCandidate(question: string): string {
  return normalizeCenterText(question).replace(CENTER_REFERENCE_NOISE, '')
}

function explicitCenterReference(question: string): string | null {
  const reference = centerReferenceCandidate(question)
  if (reference.length < 2 || REGIONAL_REFERENCE.test(reference) || GENERIC_CENTER_REFERENCES.has(reference)) return null
  return reference
}

function centerMatchScore(question: string, center: string): number {
  const normalizedQuestion = normalizeCenterText(question)
  // 完整中心名或足够长的规范别名直接出现在问题中时优先匹配。这样既支持名称中
  // 自带“片区/服务中心”的正式名称，也不会退回任意二字子串猜测。
  const direct = centerAliases(center)
    .filter(alias => alias.length >= 4 && normalizedQuestion.includes(alias))
    .sort((left, right) => right.length - left.length)[0]
  if (direct) return 1000 + direct.length
  const explicitReference = explicitCenterReference(question)
  if (!explicitReference) return 0
  return new Set(centerAliases(center)).has(explicitReference) ? explicitReference.length : 0
}

function hasKnownCenterReference(question: string, context: RegionalAssistantContext): boolean {
  return context.paymentCenters.rows.some(row => centerMatchScore(question, row.center) >= 2)
}

function hasUnknownCenterReference(question: string): boolean {
  const reference = centerReferenceCandidate(question)
  return reference.length > 0 && !REGIONAL_REFERENCE.test(reference) && !GENERIC_CENTER_REFERENCES.has(reference)
}

function paymentSource(context: RegionalAssistantContext): SourceEvidence {
  const hasMismatch = context.aph.reconciliations.some(item => !['ok', 'matched'].includes(item.status))
  const dailyCollectionReason = context.paymentCenters.dailyCollectionReason
  const readyNotes = [
    '服务中心累计明细原值已验证',
    ...(hasMismatch ? ['华北卡片、周报和中心明细合计仍有待复核口径差异'] : []),
    ...(dailyCollectionReason ? [dailyCollectionReason] : []),
  ]
  return {
    name: context.paymentCenters.source,
    businessDate: context.paymentCenters.businessDate,
    status: context.paymentCenters.ready ? (hasMismatch || dailyCollectionReason ? 'warning' : 'verified') : 'unavailable',
    note: context.paymentCenters.ready
      ? readyNotes.join('；')
      : context.paymentCenters.reason || '服务中心回款明细不可用',
  }
}

type CenterResolution =
  | { kind: 'aggregate' }
  | { kind: 'matched'; row: PaymentCenterFact }
  | { kind: 'ambiguous'; candidates: PaymentCenterFact[] }
  | { kind: 'not-found' }
  | { kind: 'unavailable' }

function resolvePaymentCenter(question: string, context: RegionalAssistantContext): CenterResolution {
  if (!context.paymentCenters.ready) return { kind: 'unavailable' }
  const scored = context.paymentCenters.rows
    .map(row => ({ row, score: centerMatchScore(question, row.center) }))
    .filter(item => item.score >= 2)
  const bestScore = Math.max(0, ...scored.map(item => item.score))
  const candidates = scored.filter(item => item.score === bestScore).map(item => item.row)
  if (candidates.length === 1) return { kind: 'matched', row: candidates[0] }
  if (candidates.length > 1) return { kind: 'ambiguous', candidates }
  if (REGIONAL_REFERENCE.test(normalizeCenterText(question)) || !hasUnknownCenterReference(question)) return { kind: 'aggregate' }
  return { kind: 'not-found' }
}

function centerPaymentSignals(row: PaymentCenterFact): OperatingSignal[] {
  const signals: OperatingSignal[] = []
  if (row.cumulativeBudget > 0 && row.cumulativeExecuted < row.cumulativeBudget) {
    signals.push({
      code: 'aph-budget-gap',
      level: 'warning',
      title: `${row.center}累计回款低于累计预算`,
      evidence: `累计执行${money(row.cumulativeExecuted)}低于累计预算${money(row.cumulativeBudget)}，差额${money(row.cumulativeBudget - row.cumulativeExecuted)}。`,
    })
  }
  const growth = row.samePeriod === null || row.samePeriod === 0
    ? null
    : (row.cumulativeExecuted - row.samePeriod) / row.samePeriod
  if (growth !== null && growth < 0) {
    signals.push({
      code: 'aph-yoy-decline',
      level: 'warning',
      title: `${row.center}累计回款同比下降`,
      evidence: `累计执行同比下降${percent(Math.abs(growth * 100))}。`,
    })
  }
  return signals
}

function answerCenterPayment(question: string, context: RegionalAssistantContext): RegionalAssistantAnswer | null {
  const resolution = resolvePaymentCenter(question, context)
  if (resolution.kind === 'aggregate') return null
  const source = paymentSource(context)
  if (resolution.kind === 'unavailable') {
    return {
      topic: 'aph',
      answer: '服务中心回款明细未通过完整性、业务日期或来源质量校验，当前不使用华北汇总替代单一中心数据。',
      businessDate: context.paymentCenters.businessDate,
      qualityStatus: 'unavailable',
      sources: [source],
      limitations: ['服务中心回款明细不可用'],
      signals: [],
      centerPaymentLookup: 'unavailable',
    }
  }
  if (resolution.kind === 'not-found') {
    return {
      topic: 'aph',
      answer: '当前权限范围内未找到可唯一核验的服务中心回款明细。请使用回款页显示的完整服务中心名称后再问；系统不会跨权限查找或猜测中心。',
      businessDate: context.paymentCenters.businessDate,
      qualityStatus: 'unavailable',
      sources: [source],
      limitations: ['当前权限范围内没有唯一匹配'],
      signals: [],
      centerPaymentLookup: 'not-found',
    }
  }
  if (resolution.kind === 'ambiguous') {
    const candidates = resolution.candidates.map(row => row.center)
    return {
      topic: 'aph',
      answer: `当前权限范围内匹配到${candidates.length}个服务中心：${candidates.join('、')}。请补充完整名称；系统不会任选一条给出金额。`,
      businessDate: context.paymentCenters.businessDate,
      qualityStatus: source.status,
      sources: [source],
      limitations: ['服务中心名称存在多个匹配'],
      signals: [],
      centerPaymentLookup: 'ambiguous',
      centerPaymentCandidates: candidates,
    }
  }

  const row = resolution.row
  const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100
  // SQLite 浮点值可能出现0.069999...这类存储尾差；进入检索与模型上下文前恢复业务字段的两位精度。
  const normalizedRow: PaymentCenterFact = {
    ...row,
    annualBudget: round2(row.annualBudget),
    cumulativeBudget: round2(row.cumulativeBudget),
    cumulativeExecuted: round2(row.cumulativeExecuted),
    samePeriod: row.samePeriod === null ? null : round2(row.samePeriod),
    dailyCollection: row.dailyCollection === null ? null : round2(row.dailyCollection),
  }
  const variance = round2(normalizedRow.cumulativeExecuted - normalizedRow.cumulativeBudget)
  const samePeriodVariance = normalizedRow.samePeriod === null ? null : round2(normalizedRow.cumulativeExecuted - normalizedRow.samePeriod)
  const cumulativeRate = normalizedRow.cumulativeBudget > 0 ? round2(normalizedRow.cumulativeExecuted / normalizedRow.cumulativeBudget * 100) : null
  const annualRate = normalizedRow.annualBudget > 0 ? round2(normalizedRow.cumulativeExecuted / normalizedRow.annualBudget * 100) : null
  const growth = normalizedRow.samePeriod === null || normalizedRow.samePeriod === 0
    ? null
    : round2((normalizedRow.cumulativeExecuted - normalizedRow.samePeriod) / normalizedRow.samePeriod * 100)
  const mixedProjectIntent = PROJECT_INTENT.test(question)
  return {
    topic: 'aph',
    answer: '',
    businessDate: normalizedRow.businessDate,
    qualityStatus: source.status,
    sources: [source],
    limitations: [
      '仅回答APH服务中心回款，不包含项目利润、品质等综合经营指标',
      ...(context.paymentCenters.dailyCollectionReason ? ['当日回款待复核，未作为可用事实输出'] : []),
      ...(context.aph.reconciliations.some(item => !['ok', 'matched'].includes(item.status))
        ? ['华北卡片、周报和中心明细合计存在待复核口径差异']
        : []),
    ],
    signals: centerPaymentSignals(normalizedRow),
    centerPayment: normalizedRow,
    centerPaymentLookup: 'matched',
    facts: {
      paymentCenter: normalizedRow,
      cumulativeVariance: variance,
      cumulativeVarianceAbsolute: Math.abs(variance),
      samePeriodVariance,
      samePeriodVarianceAbsolute: samePeriodVariance === null ? null : Math.abs(samePeriodVariance),
      cumulativeCompletionRate: cumulativeRate,
      cumulativeCompletionRateDisplay: cumulativeRate === null ? null : percent(cumulativeRate),
      yearOverYearGrowthRate: growth,
      yearOverYearGrowthRateDisplay: growth === null ? null : `${growth.toFixed(2)}%`,
      yearOverYearDeclineRate: growth !== null && growth < 0 ? Math.abs(growth) : null,
      yearOverYearDeclineRateDisplay: growth !== null && growth < 0 ? `${Math.abs(growth).toFixed(2)}%` : null,
      annualExecutionRate: annualRate,
      annualExecutionRateDisplay: annualRate === null ? null : percent(annualRate),
      scopeNote: mixedProjectIntent ? '仅包含APH服务中心回款，不包含项目综合经营指标' : '仅包含APH服务中心回款',
    },
  }
}

type CollectionCenterResolution =
  | { kind: 'aggregate' }
  | { kind: 'matched'; row: CollectionCenterFact }
  | { kind: 'ambiguous'; candidates: CollectionCenterFact[] }
  | { kind: 'not-found' }
  | { kind: 'unavailable' }

function resolveCollectionCenter(question: string, context: RegionalAssistantContext): CollectionCenterResolution {
  const rows = context.collection.rows || []
  if (!context.collection.ready || !rows.length) return { kind: 'unavailable' }
  const scored = rows
    .map(row => ({ row, score: centerMatchScore(question, row.center) }))
    .filter(item => item.score >= 2)
  const bestScore = Math.max(0, ...scored.map(item => item.score))
  const candidates = scored.filter(item => item.score === bestScore).map(item => item.row)
  if (candidates.length === 1) return { kind: 'matched', row: candidates[0] }
  if (candidates.length > 1) return { kind: 'ambiguous', candidates }
  if (REGIONAL_REFERENCE.test(normalizeCenterText(question)) || !hasUnknownCenterReference(question)) return { kind: 'aggregate' }
  return { kind: 'not-found' }
}

function answerCollectionCenter(question: string, context: RegionalAssistantContext): RegionalAssistantAnswer | null {
  const resolution = resolveCollectionCenter(question, context)
  if (resolution.kind === 'aggregate') return null
  const source = collectionSource(context)
  if (resolution.kind === 'unavailable') {
    return {
      topic: 'collection',
      answer: '服务中心收缴明细未通过正式发布、字段或时效校验，当前不使用华北汇总替代单一中心数据。',
      businessDate: context.collection.businessDate,
      qualityStatus: 'unavailable',
      sources: [source],
      limitations: ['服务中心收缴明细不可用'],
      signals: [],
      centerPaymentLookup: 'unavailable',
    }
  }
  if (resolution.kind === 'not-found') {
    return {
      topic: 'collection',
      answer: '当前权限范围内未找到可唯一核验的服务中心收缴明细。请使用收缴率页面显示的完整服务中心名称后再问；系统不会跨权限查找或猜测中心。',
      businessDate: context.collection.businessDate,
      qualityStatus: 'unavailable',
      sources: [source],
      limitations: ['当前权限范围内没有唯一匹配'],
      signals: [],
      centerPaymentLookup: 'not-found',
    }
  }
  if (resolution.kind === 'ambiguous') {
    const candidates = resolution.candidates.map(row => row.center)
    return {
      topic: 'collection',
      answer: `当前权限范围内匹配到${candidates.length}个有正式收缴数据的服务中心：${candidates.join('、')}。请选择具体中心；系统不会返回华北汇总冒充单中心结果。`,
      businessDate: context.collection.businessDate,
      qualityStatus: source.status,
      sources: [source],
      limitations: ['服务中心名称存在多个匹配'],
      signals: [],
      centerPaymentLookup: 'ambiguous',
      centerPaymentCandidates: candidates,
    }
  }

  const row = resolution.row
  return {
    topic: 'collection',
    answer: '',
    businessDate: row.businessDate,
    qualityStatus: source.status,
    sources: [source],
    limitations: [],
    signals: [],
    centerPaymentLookup: 'matched',
    collectionCenter: row,
    facts: {
      collectionCenter: row,
      collectionRate: row.rate,
      collectionRateDisplay: percent(row.rate),
      collectionReceivable: row.receivable,
      collectionReceived: row.received,
      collectionOutstanding: row.outstanding,
    },
  }
}

export function detectOperatingSignals(context: RegionalAssistantContext): OperatingSignal[] {
  const signals: OperatingSignal[] = []
  const { aph } = context
  if (aph.ready && aph.cumulativeBudget !== null && aph.cumulativeExecuted !== null && aph.cumulativeExecuted < aph.cumulativeBudget) {
    const gap = aph.cumulativeBudget - aph.cumulativeExecuted
    const completionRate = aph.cumulativeBudget > 0 ? aph.cumulativeExecuted / aph.cumulativeBudget * 100 : null
    signals.push({
      code: 'aph-budget-gap',
      level: 'warning',
      title: '累计回款低于累计预算',
      evidence: `累计执行${money(aph.cumulativeExecuted)}低于累计预算${money(aph.cumulativeBudget)}，差额${money(gap)}，完成率${percent(completionRate)}。`,
    })
  }
  if (aph.ready && aph.growth !== null && aph.growth < 0) {
    signals.push({
      code: 'aph-yoy-decline',
      level: 'warning',
      title: '累计回款同比下降',
      evidence: `累计执行同比下降${percent(Math.abs(aph.growth * 100))}。`,
    })
  }
  const sourceDifferences = aph.reconciliations.filter(item => item.status !== 'ok')
  if (sourceDifferences.length) {
    signals.push({
      code: 'aph-source-mismatch',
      level: 'warning',
      title: 'APH多来源口径存在差异',
      evidence: sourceDifferences.map(item => `${item.label}差异${money(item.difference === null ? null : Math.abs(item.difference))}`).join('；'),
    })
  }
  if (context.quality.openCaseCount > 0) {
    signals.push({
      code: 'data-quality-open',
      level: 'warning',
      title: '数据质量问题尚未闭环',
      evidence: `当前有${context.quality.openCaseCount}项未闭环数据质量责任单。`,
    })
  }
  if (!context.projects.ready) {
    signals.push({
      code: 'project-gate-blocked',
      level: 'blocked',
      title: '项目经营分析受真实性门禁限制',
      evidence: context.projects.reason || '项目经营数据尚未通过真实性门禁。',
    })
  }
  return signals
}

function aphSource(context: RegionalAssistantContext): SourceEvidence {
  return {
    name: context.aph.source,
    businessDate: context.aph.businessDate,
    status: context.aph.ready ? (context.aph.reconciliations.some(item => item.status !== 'ok') ? 'warning' : 'verified') : 'unavailable',
    note: context.aph.reconciliations.some(item => item.status !== 'ok') ? 'APH三层来源存在待复核差异' : undefined,
  }
}

function collectionSource(context: RegionalAssistantContext): SourceEvidence {
  return {
    name: context.collection.source,
    businessDate: context.collection.businessDate,
    status: context.collection.ready ? 'verified' : 'unavailable',
    note: context.collection.ready ? `正式口径${context.collection.centerCount}个服务中心；${context.collection.amountNote}` : '绿仔官方口径暂不可用',
  }
}

function answerProject(context: RegionalAssistantContext): RegionalAssistantAnswer {
  if (!context.projects.ready) {
    return {
      topic: 'project',
      answer: `${context.projects.reason || '项目经营数据尚未通过真实性门禁'}，因此当前不形成项目经营结论，也不会把缺失项目指标补成0。`,
      businessDate: null,
      qualityStatus: 'unavailable',
      sources: [],
      limitations: ['项目主数据不可用'],
    }
  }
  return {
    topic: 'project',
    answer: '',
    businessDate: null,
    qualityStatus: 'verified',
    sources: [],
    limitations: [],
    facts: { projectCount: context.projects.count },
  }
}

function answerAph(context: RegionalAssistantContext): RegionalAssistantAnswer {
  if (!context.aph.ready) {
    return {
      topic: 'aph', answer: 'APH华北汇总快照缺失、过期或没有完整字段血缘，当前不形成回款执行结论。',
      businessDate: null, qualityStatus: 'unavailable', sources: [aphSource(context)], limitations: ['APH汇总不可用'],
    }
  }
  const variance = context.aph.cumulativeBudget === null || context.aph.cumulativeExecuted === null
    ? null
    : context.aph.cumulativeExecuted - context.aph.cumulativeBudget
  return {
    topic: 'aph',
    answer: '',
    businessDate: context.aph.businessDate,
    qualityStatus: aphSource(context).status,
    sources: [aphSource(context)],
    limitations: context.aph.reconciliations.some(item => item.status !== 'ok') ? ['APH卡片、周报和中心明细存在口径差异'] : [],
    facts: {
      annualBudget: context.aph.annualBudget,
      cumulativeBudget: context.aph.cumulativeBudget,
      cumulativeExecuted: context.aph.cumulativeExecuted,
      samePeriod: context.aph.samePeriod,
      cumulativeVariance: variance,
      cumulativeCompletionRate: context.aph.cumulativeBudget && context.aph.cumulativeExecuted !== null
        ? context.aph.cumulativeExecuted / context.aph.cumulativeBudget * 100
        : null,
      yearOverYearGrowthRate: context.aph.growth === null ? null : context.aph.growth * 100,
      cumulativeCompletionRateDisplay: context.aph.cumulativeBudget && context.aph.cumulativeExecuted !== null
        ? percent(context.aph.cumulativeExecuted / context.aph.cumulativeBudget * 100)
        : null,
      yearOverYearGrowthRateDisplay: context.aph.growth === null ? null : `${(context.aph.growth * 100).toFixed(2)}%`,
    },
  }
}

function answerCollection(context: RegionalAssistantContext): RegionalAssistantAnswer {
  if (!context.collection.ready) {
    return {
      topic: 'collection', answer: '绿仔官方收缴数据未通过质量门禁，当前不使用历史混合表替代。',
      businessDate: null, qualityStatus: 'unavailable', sources: [collectionSource(context)], limitations: ['权限范围内绿仔正式收缴数据不可用'],
    }
  }
  // 中心明细只供服务端实体解析；华北汇总问法不得把全部中心行送入模型或响应事实。
  const { rows: _rows, ...collectionFacts } = context.collection
  return {
    topic: 'collection',
    answer: '',
    businessDate: context.collection.businessDate,
    qualityStatus: 'verified',
    sources: [collectionSource(context)],
    limitations: [],
    facts: { ...collectionFacts, rateDisplay: context.collection.rate === null ? null : percent(context.collection.rate) },
  }
}

function answerArrears(context: RegionalAssistantContext): RegionalAssistantAnswer {
  const source: SourceEvidence = {
    name: context.arrears.source,
    businessDate: context.arrears.latestBusinessDate,
    status: context.arrears.ready ? 'verified' : 'unavailable',
    note: context.arrears.ready ? '仅统计权限范围内未撤回、未阻断的最新有效批次' : '当前没有可用于经营判断的有效逐户欠费批次',
  }
  if (!context.arrears.ready) {
    return {
      topic: 'arrears',
      answer: `当前权限范围内有效欠费分析批次为0个${context.arrears.revokedBatchCount > 0 ? `，已撤回${context.arrears.revokedBatchCount}个` : ''}。目前没有真实逐户欠费台账可用于账龄、费项和原因分析；系统不使用收缴待收金额推断逐户欠费原因。`,
      businessDate: null,
      qualityStatus: 'unavailable',
      sources: [source],
      limitations: ['缺少有效逐户欠费分析批次'],
    }
  }
  return {
    topic: 'arrears',
    answer: '',
    businessDate: context.arrears.latestBusinessDate,
    qualityStatus: 'verified',
    sources: [source],
    limitations: context.arrears.pendingReviewCount > 0 ? ['仍有欠费原因待人工复核'] : [],
    facts: { ...context.arrears },
  }
}

function answerQuality(context: RegionalAssistantContext): RegionalAssistantAnswer {
  const differences = context.aph.reconciliations.filter(item => item.status !== 'ok')
  return {
    topic: 'quality',
    answer: '',
    businessDate: context.aph.businessDate || context.collection.businessDate,
    qualityStatus: context.quality.status,
    sources: [aphSource(context), collectionSource(context)],
    limitations: context.quality.notes,
    facts: {
      reconciliations: context.aph.reconciliations,
      openCaseCount: context.quality.openCaseCount,
      qualityStatus: context.quality.status,
    },
  }
}

function answerOverview(context: RegionalAssistantContext): RegionalAssistantAnswer {
  const aph = answerAph(context)
  const collection = answerCollection(context)
  const quality = answerQuality(context)
  const signals = detectOperatingSignals(context)
  return {
    topic: 'overview',
    answer: '',
    businessDate: context.aph.businessDate || context.collection.businessDate,
    qualityStatus: [aph.qualityStatus, collection.qualityStatus, quality.qualityStatus].includes('unavailable') ? 'unavailable' : [aph.qualityStatus, collection.qualityStatus, quality.qualityStatus].includes('warning') ? 'warning' : 'verified',
    sources: [aphSource(context), collectionSource(context)],
    limitations: [...new Set([...aph.limitations, ...collection.limitations, ...quality.limitations])],
    signals,
    facts: {
      aph: aph.facts || null,
      collection: collection.facts || null,
      quality: quality.facts || null,
      operatingSignals: signals,
    },
  }
}

export function answerRegionalQuestion(question: string, context: RegionalAssistantContext): RegionalAssistantAnswer {
  const q = String(question || '').trim()
  const signals = detectOperatingSignals(context)
  // 明确的制度/标准问题只走知识检索，不受上一轮回款话题影响，
  // 也不把“第一服务”误当成服务中心名称。
  if (KNOWLEDGE_INTENT.test(q)) return {
    topic: 'knowledge',
    answer: '',
    businessDate: null,
    qualityStatus: 'verified',
    sources: [],
    limitations: [],
    signals: [],
    facts: {},
  }
  if (/欠费|企小码|账龄|催缴批次|逐户台账/.test(q)) return { ...answerArrears(context), signals: [] }
  // 数据质量是独立业务域，不能把“当前有哪些数据质量问题”中的“质量问题”
  // 误提取成服务中心名称。
  if (EXPLICIT_DATA_QUALITY_INTENT.test(q)) return { ...answerQuality(context), signals: signals.filter(signal => signal.code === 'aph-source-mismatch' || signal.code === 'data-quality-open') }
  // “中心名 + 收缴率/应收/实收”必须先解析正式收缴明细，不能被后面的华北汇总分支吞掉。
  if (/收缴率|收费率|绿仔|物业费|应收|实收|未收|待收/.test(q) && !EXPLICIT_PAYMENT_INTENT.test(q)) {
    const centerAnswer = answerCollectionCenter(q, context)
    if (centerAnswer) return centerAnswer
    return { ...answerCollection(context), signals: [] }
  }
  // 用户只输入一个真实中心简称时也直接解析。若同名中心超过一个，返回候选
  // 让前端给用户选择，不调用模型猜测，也不误走经营概览。
  if (!PROJECT_OPERATING_INTENT.test(q) && hasKnownCenterReference(q, context)) {
    const centerAnswer = answerCenterPayment(q, context)
    if (centerAnswer) return centerAnswer
  }
  // 用户只需说“上第数据”或“上第哪些指标没达标”就直接进入服务中心快照。
  // 利润、品质等项目综合经营问题仍优先走项目真实性门禁。
  if (CENTER_SNAPSHOT_INTENT.test(q) && !PROJECT_OPERATING_INTENT.test(q) && explicitCenterReference(q)) {
    const centerAnswer = answerCenterPayment(q, context)
    if (centerAnswer) return centerAnswer
  }
  if (EXPLICIT_PAYMENT_INTENT.test(q)) {
    const centerAnswer = answerCenterPayment(q, context)
    if (centerAnswer) return centerAnswer
    return { ...answerAph(context), signals: signals.filter(signal => signal.code.startsWith('aph-')) }
  }
  if (DATA_QUALITY_INTENT.test(q)) return { ...answerQuality(context), signals: signals.filter(signal => signal.code === 'aph-source-mismatch' || signal.code === 'data-quality-open') }
  if (PROJECT_INTENT.test(q)) return { ...answerProject(context), signals: signals.filter(signal => signal.code === 'project-gate-blocked') }
  if (PAYMENT_COMPARISON_INTENT.test(q)) {
    const centerAnswer = answerCenterPayment(q, context)
    if (centerAnswer) return centerAnswer
    return { ...answerAph(context), signals: signals.filter(signal => signal.code.startsWith('aph-')) }
  }
  return answerOverview(context)
}

const TOPIC_HINTS: Record<string, string> = {
  aph: '回款预算同比',
  collection: '绿仔官方收缴率',
  arrears: '欠费批次账龄原因',
  quality: '数据质量口径差异',
  project: '项目经营',
  overview: '经营概览',
}

/** 当前问题有明确意图时覆盖历史话题；只有代词式追问才继承上一轮 topic。 */
export function answerRegionalQuestionWithTopic(question: string, topic: string, context: RegionalAssistantContext): RegionalAssistantAnswer {
  const explicit = answerRegionalQuestion(question, context)
  const hint = TOPIC_HINTS[String(topic || '')]
  return explicit.topic === 'overview' && hint
    ? answerRegionalQuestion(`${hint} ${question}`, context)
    : explicit
}
