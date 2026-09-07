import crypto from 'node:crypto'
import db from './db.js'
import { logOperationStrict } from './audit.js'
import { buildAssistantOpinion, shanghaiPolicyDate, type AssistantOpinion } from './assistant-orchestrator.js'
import { refineWithHermes, type HermesClientConfig, type HermesKnowledgeExcerpt, type HermesRefineInput } from './hermes-client.js'
import { searchApprovedKnowledge, standardCodesIn, type KnowledgeExcerpt, type KnowledgeSearchOptions } from './knowledge-retriever.js'
import type { ServiceCenterAnalysis, ServiceCenterAnalysisRow } from './service-center-analysis.js'

export const SERVICE_CENTER_AI_PROMPT_VERSION = 'service-center-hermes-v7-compact-retry-advice'
// 模型失败结果保留6小时，避免余额或供应商故障期间每次打开页面都重跑56次。
const NEGATIVE_CACHE_MS = 6 * 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 65_000
const STABLE_CENTER_ADVICE = /(?:AI建议|行动建议|先做什么|谁来协同|所需材料|完成凭证|升级条件)\s*[:：]?/
const MODEL_UNGROUNDED_CAUSAL = /(?:原因|因为|由于|得益于|归功于|源于|受益于|导致|驱动|团队|执行有力|管理到位|协同有力|工作到位|措施有效|天气|气温|变冷|跟进不足|执行不足)/
const MODEL_DANGEROUS_CONTENT = /(?:银行卡|银行账户|卡号|密码|口令|验证码|身份证|证件|复印件|口头说明|隐私|公开|公示|曝光|泄露|停水|停电|断水|断电|断供|罚款|限制门禁|威胁|恐吓|骚扰|施压|围堵|堵门)/
const CONTROLLED_COORDINATION_ROLES = [
  '服务中心收费岗位', '收费经办岗位', '项目负责人', '运营负责人', '片区负责人', '区域负责人',
  '部门负责人', '项目经理', '收费岗位', '客服管家', '物业管家', '财务岗位', '财务人员', '法务岗位',
  '法务人员', '客服岗位', '客户服务部责任人', '客户服务催收岗', '客服主管', '项目责任人',
  '财务收款岗', '财务专员', '财务负责人', '中心负责人', '客户服务部', '财务部',
  '收费岗', '收费员', '客服', '财务', '法务',
] as const
const COLLECTION_ACTIONS = /(?:确认付款|促成到账|推进到账|筛选|分类|分层|联系|发送|上门|约定|跟进|催缴|沟通|收款|回款|记录|留存|形成)/
const ACTION_ALLOWED_PHRASES = [
  '确认付款安排', '确认付款', '促成到账', '推进到账', '付款承诺', '沟通记录', '未到账对象', '可转化欠费对象',
  '欠费对象', '可转化欠费款项', '欠费款项', '欠费户', '缴费意愿', '欠费金额', '付款安排', '付款时间',
  '高金额', '联系人', '账单', '到账', '款项', '清单', '名单', '状态', '筛选', '分类', '分层', '联系', '发送', '上门',
  '约定', '跟进', '催缴', '沟通', '收款', '回款', '记录', '留存', '形成', '确认',
] as const
const APPROVED_MATERIALS = ['欠费户清单', '联系方式', '联系人', '账单', '合同', '沟通记录', '付款承诺'] as const
const APPROVED_COMPLETION_EVIDENCE = ['到账凭证', '付款承诺', '催缴记录'] as const
const APPROVED_ESCALATION_TRIGGERS = ['付款承诺未兑现', '承诺未兑现', '发生争议', '拒绝付款', '拒付', '争议'] as const
const APPROVED_ESCALATION_ACTIONS = ['提交升级处理', '提交升级单', '转交', '上报', '升级', '启动'] as const
const APPROVED_ESCALATION_PROCESSES = [
  '第一服务费用收缴作业标准中的历史欠费收缴方法与法律追缴流程',
  '费用收缴作业标准流程', '法律追缴流程', '法律追缴处理', '法务追缴流程', '法务催缴流程', '争议处理流程',
  '催缴升级流程', '法务处理流程', '法务流程', '收缴流程', '审批流程', '升级流程',
  '分类处理',
] as const
const SIGNAL_FOCUS_LABELS: Record<ServiceCenterAnalysisRow['signals'][number]['code'], string> = {
  'cumulative-budget-gap': '累计预算差额未达标项',
  'yoy-decline': '累计执行同比下降未达标项',
  'official-collection-below-threshold': '官方收缴率低于关注阈值未达标项',
}

export type ServiceCenterAiModelStatus =
  | 'generated'
  | 'cached'
  | 'pending'
  | 'unavailable'
  | 'rejected'
  | 'insufficient_evidence'

export type ServiceCenterAiRowFields = {
  aiOpinion: AssistantOpinion | null
  generatedBy: 'hermes-grounded' | 'verified-rules'
  modelUsed: string | null
  modelStatus: ServiceCenterAiModelStatus
  aiGeneratedAt: string | null
  readOnly: true
}

export type ServiceCenterAiEnvelope = {
  configured: boolean
  status: 'complete' | 'partial' | 'pending' | 'unavailable'
  model: string | null
  promptVersion: string
  total: number
  generated: number
  cached: number
  pending: number
  failed: number
  insufficient: number
  runId: number | null
  readOnly: true
}

type AiResultRow = {
  normalized_center: string
  input_sha256: string
  business_date: string
  status: 'generated' | 'rejected' | 'unavailable' | 'insufficient_evidence'
  generated_by: 'hermes-grounded' | 'verified-rules'
  model: string
  prompt_version: string
  knowledge_sha256: string
  ai_opinion_json: string
  error_code: string
  generated_at: string
  created_at_ms: number
}

type AiRunRow = {
  id: number
  scope_sha256: string
  input_hashes_json: string
  status: 'running' | 'completed' | 'partial' | 'failed' | 'discarded'
  model: string
  prompt_version: string
  total_count: number
  completed_count: number
  generated_count: number
  cached_count: number
  rejected_count: number
  unavailable_count: number
  insufficient_count: number
  error_summary_json: string
  started_by_user_id: number | null
  started_by: string
  started_at: string
  completed_at: string
}

export type KnowledgeBundle = {
  excerpts: HermesKnowledgeExcerpt[]
  sha256: string
}

export type ServiceCenterAiOptions = {
  database?: typeof db
  hermes?: HermesClientConfig
  knowledgeDbPath?: string
  search?: (query: string, options: KnowledgeSearchOptions) => KnowledgeExcerpt[]
  refine?: typeof refineWithHermes
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  concurrency?: number
  analysisMode?: 'structured' | 'legacy'
}

export type ServiceCenterAiAnalyzeOptions = ServiceCenterAiOptions & {
  businessDate: string | null
  inputSha256: string
  knowledge: KnowledgeBundle
}

export type ServiceCenterAiGeneratedResult = {
  inputSha256: string
  normalizedCenter: string
  businessDate: string | null
  status: 'generated' | 'rejected' | 'unavailable' | 'insufficient_evidence'
  generatedBy: 'hermes-grounded' | 'verified-rules'
  modelUsed: string | null
  aiOpinion: AssistantOpinion | null
  errorCode: string | null
  generatedAt: string | null
}

type PreparedCenter = { row: ServiceCenterAnalysisRow; inputSha256: string }

function configuredHermes(options: ServiceCenterAiOptions): HermesClientConfig {
  return options.hermes || {
    baseUrl: String(process.env.HERMES_COCKPIT_BASE_URL || ''),
    apiKey: String(process.env.HERMES_COCKPIT_API_KEY || ''),
    model: String(process.env.HERMES_COCKPIT_MODEL || 'north-cockpit'),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }
}

function isConfigured(config: HermesClientConfig): boolean {
  return Boolean(config.baseUrl.trim() && config.apiKey.trim() && config.model.trim())
}

function boundedConcurrency(options: ServiceCenterAiOptions): number {
  // Codex订阅网关对同一profile的并发请求会排队；默认单路换取完整率，
  // 有独立容量证明时仍可通过环境变量提升，但上限继续锁在4。
  const raw = options.concurrency ?? Number(process.env.SERVICE_CENTER_AI_CONCURRENCY || 1)
  return Math.max(1, Math.min(4, Number.isFinite(raw) ? Math.trunc(raw) : 1))
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, stableValue(nested)]))
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex')
}

function safeJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T } catch { return fallback }
}

type ExecutionCardFields = {
  action: string
  coordination: string
  materials: string
  completionEvidence: string
  escalation: string
}

const FRONTLINE_ACTION_STAGES = [
  /^(?:按[^，,；;]{0,24})?(?:筛选|分类|分层)/,
  /^(?:联系|发送|沟通)/,
  /^(?:上门|约定|跟进|催缴|促成到账|推进到账)/,
] as const

function stripKnowledgeCitations(value: string): string {
  return String(value || '').replace(/\[K\d+\]/gi, '').trim()
}

function removeApprovedPhrases(value: string, phrases: readonly string[]): { remaining: string; matched: number } {
  let remaining = stripKnowledgeCitations(value)
  let matched = 0
  for (const phrase of [...phrases].sort((left, right) => right.length - left.length)) {
    if (!remaining.includes(phrase)) continue
    matched += 1
    remaining = remaining.replaceAll(phrase, '')
  }
  return { remaining, matched }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasExactStableJudgement(modelText: string): boolean {
  return /^\s*AI判断\s*[:：]\s*当前可用指标未触发关注规则\s*[。.]?\s*$/.test(String(modelText || ''))
}

function attentionFocusLabel(row: ServiceCenterAnalysisRow): string | null {
  const firstSignal = row.signals[0]
  return firstSignal ? SIGNAL_FOCUS_LABELS[firstSignal.code] : null
}

function hasOnlyDeclaredSignals(row: ServiceCenterAnalysisRow, line: string): boolean {
  const signalMessages = row.signals.map(signal => signal.message.replace(/[。.]$/, ''))
  const declared = line.replace(/^未达标项\s*[:：]\s*/, '').split(/[\r\n；;]+/)
    .map(item => item.trim().replace(/[。.]$/, ''))
    .filter(Boolean)
  return declared.length > 0 && declared.every(item => signalMessages.includes(item))
}

function hasExactAttentionJudgement(row: ServiceCenterAnalysisRow, modelText: string): boolean {
  const focusLabel = attentionFocusLabel(row)
  if (!focusLabel) return false
  const matched = String(modelText || '').match(
    /^\s*(?:(未达标项\s*[:：][^\r\n]+)\r?\n\s*)?AI判断\s*[:：]\s*([\s\S]*?)回款重点\s*[:：]\s*([\s\S]*?)(?=\r?\n\s*(?:AI建议|行动建议)\s*[:：])/
  )
  if (!matched) return false
  if (matched[1] && !hasOnlyDeclaredSignals(row, matched[1])) return false
  const declaredInside = matched[2].trim()
  if (declaredInside && !hasOnlyDeclaredSignals(row, declaredInside)) return false
  if (matched[1] && declaredInside) return false
  const focusLine = matched[3].trim()
  const base = `围绕${focusLabel}推进可转化欠费款项`
  const normalizedFocus = focusLine.replace(/[“”\"]/g, '')
  if (new RegExp(`^${escapeRegExp(focusLabel)}\\s*[。.]?$`).test(normalizedFocus)) return true
  if (new RegExp(`^${escapeRegExp(base)}(?:尽快)?到账\\s*[。.]?$`).test(normalizedFocus)) return true
  // 允许模型用自然语言复述本中心关注项，但必须仍指向该精确关注项和回款动作；
  // 数字只能来自该中心已验证信号，不能扩写原因或引入新事实。
  if (normalizedFocus.length > 180
    || !normalizedFocus.includes(focusLabel)
    || !/(?:欠费|回款)/.test(normalizedFocus)
    || !/(?:到账|清收|催缴|付款)/.test(normalizedFocus)) return false
  const allowedNumbers = new Set(row.signals.flatMap(signal => signal.message.match(/-?\d+(?:\.\d+)?/g) || []))
  const usedNumbers = normalizedFocus.match(/-?\d+(?:\.\d+)?/g) || []
  return usedNumbers.every(value => allowedNumbers.has(value))
}

function parseExecutionCard(modelText: string): ExecutionCardFields | null {
  const text = String(modelText || '')
  const adviceMarkers = [...text.matchAll(/(?:^|\r?\n)\s*(?:AI建议|行动建议)\s*[:：]\s*/g)]
  if (adviceMarkers.length !== 1) return null
  const marker = adviceMarkers[0]
  let body = text.slice((marker.index || 0) + marker[0].length).trim()
  if (/^一线执行卡\s*(?:\r?\n|$)/.test(body)) body = body.replace(/^一线执行卡\s*(?:\r?\n|$)/, '')
  const labels = ['先做什么', '谁来协同', '所需材料', '完成凭证', '升级条件'] as const
  const fieldMatches = [...body.matchAll(/(?:^|\r?\n)\s*(先做什么|谁来协同|所需材料|完成凭证|升级条件)\s*[:：]\s*/g)]
  if (fieldMatches.length !== labels.length || fieldMatches.some((item, index) => item[1] !== labels[index])) return null
  if (body.slice(0, fieldMatches[0].index || 0).trim()) return null
  const blocks = fieldMatches.map((item, index) => {
    const start = (item.index || 0) + item[0].length
    const end = index + 1 < fieldMatches.length ? fieldMatches[index + 1].index : body.length
    return body.slice(start, end).trim()
  })
  if (blocks.some(block => !block)) return null
  const normalizeList = (value: string) => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean).join('、')
  const escalation = stripKnowledgeCitations(blocks[4]).trim()
  if (!escalation || /\r?\n/.test(escalation)) return null
  return {
    action: blocks[0],
    coordination: normalizeList(blocks[1]),
    materials: normalizeList(blocks[2]),
    completionEvidence: normalizeList(blocks[3]),
    escalation,
  }
}

function compactAiRecommendations(opinion: AssistantOpinion, modelText: string): AssistantOpinion {
  const fields = parseExecutionCard(modelText)
  if (!fields) return opinion
  return {
    ...opinion,
    recommendations: [
      fields.action,
      `协同岗位：${stripKnowledgeCitations(fields.coordination).replace(/[。.]$/, '')}`,
      `完成凭证：${stripKnowledgeCitations(fields.completionEvidence).replace(/[。.]$/, '')}`,
    ].join('\n'),
  }
}

function hasThreeCenterSpecificActions(value: string): boolean {
  const lines = stripKnowledgeCitations(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length !== 3) return false
  return lines.every((line, index) => {
    const match = line.match(new RegExp(`^动作${['一', '二', '三'][index]}\\s*[:：]\\s*(.+)$`))
    if (!match) return false
    const action = match[1].trim()
    // 阶段由每一步逗号前的主动作决定。后半句可以描述该动作的目的，
    // 例如“筛选高金额欠费户，形成首批集中跟进名单”，不能因此被误判为第三阶段。
    const stageText = action.split(/[，,；;]/, 1)[0]
      .replace(/(?:催缴清单|催缴沟通|催缴记录|催缴信息)/g, '回款材料')
    const stageMatches = FRONTLINE_ACTION_STAGES.map(pattern => pattern.test(stageText))
    const futureTarget = action
      .replace(/已达成付款承诺的欠费户/g, '形成付款承诺的欠费户')
      .replace(/已形成付款安排的对象/g, '形成付款安排的对象')
      .replace(/已确认付款安排的户/g, '形成付款安排的户')
      .replace(/已承诺款项/g, '承诺款项')
      .replace(/(?:未兑现承诺|承诺未兑现|未结清欠费户|未按承诺到款的户|未落实到账的欠费户|未到账金额|未回款户)/g, '待跟进对象')
      .replace(/(?:已联络后仍未处理|未回复|未达成支付安排|未达成缴费安排|未形成付款安排|仍未缴|未缴|未处理)/g, '待跟进对象')
      .replace(/尚未到账/g, '待到账')
      .replace(/未及时回应/g, '待回应')
      .replace(/已分层/g, '分层后')
      .replace(/(?:完成首次反馈确认|未完成确认|未完成回款|未支付)/g, '待确认')
      .replace(/未完成项/g, '待处理项')
      .replace(/(?:未收齐对象|未形成支付动作)/g, '待回款对象')
      .replace(/未(?:确认|恢复缴费|响应|回复|回款|缴费|支付|到款|结清)/g, '待跟进')
      .replace(/未在[^，,；;。]{0,24}(?:形成|完成|回传|支付|缴费)/g, '待跟进')
      .replace(/完成催缴说明/g, '发送催缴说明')
      .replace(/完成(?=催缴记录|沟通记录|清单|反馈|确认)/g, '形成')
      .replace(/未达标/g, '指标异常')
      .replace(/未按[^，,；;。]{0,16}(?:执行|付款|到账)/g, '条件异常')
    const hasFalseCompletion = /(?:已经完成|已完成|已办结|已经落实|落实到位|尚未完成|已经到位|全部完成|全部办结)/.test(futureTarget)
    return !hasFalseCompletion
      && COLLECTION_ACTIONS.test(action)
      && stageMatches[index]
      && stageMatches.filter(Boolean).length === 1
  })
}

function hasOnlyCollectionActions(value: string): boolean {
  const clean = stripKnowledgeCitations(value)
  // 模型不能在动作字段补造“已做/未做”状态；这里显式失败关闭，
  // 不能再依靠后续字符清理把时态词吞掉。
  if (/(?:已经|尚未|已|未|完成|完毕|办结|落实到位)/.test(clean)) return false
  const clauses = clean.split(/[\n，,；;。]+/)
    .map(item => item.replace(/^\s*动作(?:[一二三四五六七八九十]|\d+)\s*[:：]\s*/, '').trim())
    .filter(Boolean)
  if (!clauses.length || clauses.some(clause => !COLLECTION_ACTIONS.test(clause))) return false
  const stripped = removeApprovedPhrases(
    clean.replace(/(?:^|\n)\s*动作(?:[一二三四五六七八九十]|\d+)\s*[:：]\s*/g, '\n'),
    ACTION_ALLOWED_PHRASES,
  )
  const remaining = stripped.remaining.replace(/[、，,。；;:：\s的了并和与或按对向将把再先后持续继续直至逐户每户优先尽快明确可在为其进行予以根据围绕（）()]/g, '')
  return stripped.matched > 0 && remaining.length === 0
}

function hasOnlyControlledCoordinationRoles(value: string): boolean {
  const stripped = removeApprovedPhrases(value, CONTROLLED_COORDINATION_ROLES)
  const remaining = stripped.remaining
    .replace(/(?:共同)?(?:协同|配合)/g, '')
    .replace(/[、，,。；;和与及/\s]/g, '')
  return stripped.matched > 0 && stripped.matched <= 2 && remaining.length === 0
}

function hasOnlyApprovedMaterials(value: string): boolean {
  const stripped = removeApprovedPhrases(value, APPROVED_MATERIALS)
  const remaining = stripped.remaining.replace(/[、，,。；;和与及或/\s]/g, '')
  return stripped.matched >= 2 && stripped.matched <= 3 && remaining.length === 0
}

function hasOnlyApprovedCompletionEvidence(value: string): boolean {
  const stripped = removeApprovedPhrases(value, APPROVED_COMPLETION_EVIDENCE)
  const remaining = stripped.remaining
    .replace(/(?:留存|保存|形成|提供|以|作为|完成|证据|中的|一种)/g, '')
    .replace(/[、，,。；;和与及或/\s]/g, '')
  return stripped.matched === 1 && remaining.length === 0
}

function hasOnlyApprovedEscalation(value: string): boolean {
  const clean = stripKnowledgeCitations(value)
  const triggerPattern = [...APPROVED_ESCALATION_TRIGGERS]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|')
  const rolePattern = [...CONTROLLED_COORDINATION_ROLES]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|')
  const processPattern = [...APPROVED_ESCALATION_PROCESSES]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|')
  const actionPattern = APPROVED_ESCALATION_ACTIONS.map(escapeRegExp).join('|')
  const triggerMatches = removeApprovedPhrases(clean, APPROVED_ESCALATION_TRIGGERS).matched
  if (triggerMatches < 1 || triggerMatches > 3) return false
  // 条件必须先出现，再写岗位、升级动作和批准流程；自然语言可变，安全边界不变。
  const triggerList = `(?:${triggerPattern})(?:\\s*(?:、|，|,|或|和|与)\\s*(?:${triggerPattern}))*`
  const prefix = new RegExp(`^(?:若|如)\\s*(?:出现|发生|存在)?\\s*${triggerList}\\s*(?:，|,)?\\s*(?:则|就)`).test(clean)
  if (!prefix || !new RegExp(`(?:${rolePattern})`).test(clean) || !new RegExp(`(?:${processPattern})`).test(clean)) return false
  const hasEscalationAction = new RegExp(`(?:${actionPattern})|提交|提交[^。；！？\\n]{0,20}(?:升级|申请)|(?:审核|审批|批准|会签)[^。；！？\\n]{0,12}(?:提交|处理|申请|通道)`).test(clean)
  if (!hasEscalationAction) return false
  const withoutRoles = removeApprovedPhrases(clean, CONTROLLED_COORDINATION_ROLES).remaining
  // 明确阻断“交给张三/由李四”等个人姓名；这里只允许岗位名称。
  if (/(?:由|交给|转交|上报)\s*(?!提交|其|该|相关|负责|审批|审核)[\p{Script=Han}]{2,3}(?:、|，|,|。|\s|提交|处理|负责)/u.test(withoutRoles)) return false
  return true
}

function executionCardViolation(modelText: string): string | null {
  const fields = parseExecutionCard(modelText)
  if (!fields) return 'execution_card_rejected'
  if (!hasThreeCenterSpecificActions(fields.action)) return 'collection_action_rejected'
  if (!hasOnlyControlledCoordinationRoles(fields.coordination)) return 'coordination_role_rejected'
  if (!hasOnlyApprovedMaterials(fields.materials)) return 'materials_field_rejected'
  if (!hasOnlyApprovedCompletionEvidence(fields.completionEvidence)) return 'completion_evidence_rejected'
  if (!hasOnlyApprovedEscalation(fields.escalation)) return 'escalation_field_rejected'
  return null
}

function loadKnowledge(options: ServiceCenterAiOptions): KnowledgeBundle {
  const search = options.search || searchApprovedKnowledge
  const knowledgeDbPath = options.knowledgeDbPath
    || process.env.NORTH_KNOWLEDGE_DB
    || '/home/ubuntu/cockpit-knowledge/index/knowledge.db'
  let found: KnowledgeExcerpt[] = []
  try {
    found = search('PM4-KF-01 费用收缴 催缴 欠费', {
      dbPath: knowledgeDbPath,
      domain: 'north-operations',
      asOf: shanghaiPolicyDate(),
      limit: 5,
    })
  } catch {
    // 知识库是只读依赖；缺失或损坏时关闭失败，不让整个56中心GET变成500。
    return { excerpts: [], sha256: sha256([]) }
  }
  const first = found[0]
  if (!first) return { excerpts: [], sha256: sha256([]) }
  const sameDocument = found.filter(item => item.documentId === first.documentId)
  const excerpt: HermesKnowledgeExcerpt = {
    documentId: first.documentId,
    title: first.title,
    version: first.version,
    section: [...new Set(sameDocument.map(item => item.section).filter(Boolean))].join('、'),
    page: sameDocument.length === 1 ? first.page : null,
    content: sameDocument.map(item => item.content).join('\n').slice(0, 700),
    identifiers: [...new Set([first.documentId, first.title, first.sourcePath, first.category]
      .flatMap(value => standardCodesIn(value)))],
  }
  return { excerpts: [excerpt], sha256: sha256(excerpt) }
}

export function buildServiceCenterAiFingerprint(
  row: ServiceCenterAnalysisRow,
  analysis: Pick<ServiceCenterAnalysis, 'businessDate' | 'publicationStatus' | 'collectionPublicationStatus' | 'credibility' | 'thresholds'>,
  options: { model: string; knowledgeSha256: string; promptVersion?: string },
): string {
  // JSON.stringify 将 null 作为值保留；不在指纹前使用 Number(value || 0)。
  return sha256({
    promptVersion: options.promptVersion || SERVICE_CENTER_AI_PROMPT_VERSION,
    model: options.model,
    knowledgeSha256: options.knowledgeSha256,
    publication: {
      businessDate: analysis.businessDate,
      payment: analysis.publicationStatus,
      officialCollection: analysis.collectionPublicationStatus,
      credibility: analysis.credibility,
      thresholds: analysis.thresholds,
    },
    center: {
      normalizedCenter: row.normalizedCenter,
      area: row.area,
      operatingStatus: row.operatingStatus,
      dataStatus: row.dataStatus,
      metrics: row.metrics,
      availability: row.availability,
      signals: row.signals,
      evidence: row.evidence,
    },
  })
}

function preparedCenters(analysis: ServiceCenterAnalysis, options: ServiceCenterAiOptions, knowledge: KnowledgeBundle): PreparedCenter[] {
  const model = configuredHermes(options).model
  return analysis.rows.map(row => ({
    row,
    inputSha256: buildServiceCenterAiFingerprint(row, analysis, { model, knowledgeSha256: knowledge.sha256 }),
  }))
}

function uniqueSources(row: ServiceCenterAnalysisRow): string[] {
  return [...new Set([row.evidence.payment, row.evidence.daily, row.evidence.officialCollection]
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map(item => item.source)
    .filter(Boolean))]
}

export function buildServiceCenterHermesInput(
  row: ServiceCenterAnalysisRow,
  knowledge: KnowledgeBundle,
): HermesRefineInput {
  const roundPercent = (value: number | null) => value === null ? null : Math.round(value * 10_000) / 100
  const operatingSignals = row.signals.map(signal => ({
    code: signal.code,
    level: 'warning',
    title: signal.message,
    evidence: signal.message,
  }))
  const hasGroundedAdvice = operatingSignals.length > 0 && knowledge.excerpts.length > 0
  const focusLabel = attentionFocusLabel(row) || ''
  const actionDirection = row.signals[0]?.code === 'cumulative-budget-gap'
    ? '动作一围绕欠费金额筛选优先对象，动作二联系并沟通付款安排，动作三跟进承诺款项到账。'
    : row.signals[0]?.code === 'yoy-decline'
      ? '动作一筛选同期已缴但本期未缴对象，动作二联系确认变化，动作三跟进可转化款项。'
      : '动作一按缴费意愿给欠费户分层，动作二联系并发送账单，动作三跟进付款承诺或安排上门沟通。'
  const question = hasGroundedAdvice
    ? `为${row.center}生成中心化AI建议，不复制作业标准。严格按以下模板：AI判断：回款重点必须原样包含focusLabel；AI建议：一线执行卡；先做什么：仅动作一、动作二、动作三，依次为筛选分类、联系沟通、跟进催缴。${actionDirection}每步只选一个具体动作。谁来协同1至2个岗位；所需材料2至3项；完成凭证1项；升级条件只选拒付、争议或承诺未兑现，并含升级动作、批准岗位、批准流程。只用本中心facts、operatingSignals和批准知识，不补数字、原因、完成状态、人名或期限；末尾标最相关[K编号]。`
    : `请只输出“AI判断：当前可用指标未触发关注规则。”，不得输出任何其他文字。`
  return {
    question,
    context: {
      serviceCenterName: row.center,
      focusLabel: hasGroundedAdvice ? focusLabel : null,
      facts: {
        annualBudget: row.metrics.annualBudget,
        cumulativeBudget: row.metrics.cumulativeBudget,
        cumulativeExecuted: row.metrics.cumulativeExecuted,
        cumulativeVariance: row.metrics.cumulativeBudgetGap,
        samePeriod: row.metrics.samePeriod,
        yearOverYearGrowthRate: roundPercent(row.metrics.yoyGrowth),
        dailyCollection: row.metrics.dailyCollection,
        collection: { rate: roundPercent(row.metrics.officialCollectionRate) },
      },
      operatingSignals,
      dataStatus: row.dataStatus,
      businessDate: row.evidence.daily?.businessDate
        || row.evidence.payment.businessDate
        || row.evidence.officialCollection?.businessDate
        || null,
      readOnly: true,
    },
    history: [],
    knowledge: knowledge.excerpts,
  }
}

function serviceCenterEvidence(row: ServiceCenterAnalysisRow, businessDate: string | null): any {
  return {
    topic: 'aph',
    answer: '',
    businessDate,
    qualityStatus: row.dataStatus === 'complete' ? 'verified' : 'warning',
    sources: uniqueSources(row).map(name => ({
      name,
      businessDate,
      status: row.dataStatus === 'complete' ? 'verified' : 'warning',
    })),
    limitations: row.dataStatus === 'complete' ? [] : ['部分经营字段缺失，AI只使用已提供原值'],
    signals: row.signals.map(signal => ({
      code: signal.code,
      level: 'warning',
      title: signal.message,
      evidence: signal.message,
    })),
  }
}

type FetchObservation = { kind: 'none' | 'ok' | 'http' | 'request_error'; status?: number }

type StructuredDecision = {
  primarySignal: ServiceCenterAnalysisRow['signals'][number]['code'] | 'stable'
  plan: 'budget-gap-recovery-v1' | 'yoy-recovery-v1' | 'collection-rate-recovery-v1' | 'stable-monitor-v1'
  actionCodes: StructuredActionCode[]
  coordinationRole: StructuredRoleCode
  materialCodes: StructuredMaterialCode[]
  completionEvidence: StructuredEvidenceCode
  escalationTrigger: StructuredTriggerCode
  cadence: StructuredCadenceCode
  knowledgeId: string
}

type StructuredActionCode =
  | 'rank-arrears-by-amount'
  | 'contact-high-value-arrears'
  | 'confirm-payment-date'
  | 'track-payment-arrival'
  | 'compare-unpaid-cohort'
  | 'revisit-broken-promises'
  | 'contact-churned-payers'
  | 'segment-by-payment-intent'
  | 'send-account-statement'
  | 'schedule-doorstep-follow-up'
  | 'follow-payment-promise'
  | 'review-key-metrics-next-day'
  | 'retain-current-collection-rhythm'
type StructuredRoleCode = 'charging-role' | 'project-owner' | 'customer-service' | 'finance-role' | 'legal-role'
type StructuredMaterialCode = 'arrears-list' | 'contacts' | 'bills' | 'contracts' | 'communication-records' | 'payment-promises'
type StructuredEvidenceCode = 'arrival-proof' | 'payment-promise' | 'collection-record'
type StructuredTriggerCode = 'refusal' | 'dispute' | 'broken-promise' | 'metric-rule-triggered'
type StructuredCadenceCode = 'same-day-first-contact' | 'next-business-day-review' | 'track-until-arrival'

const PLAN_BY_SIGNAL: Record<StructuredDecision['primarySignal'], StructuredDecision['plan']> = {
  'cumulative-budget-gap': 'budget-gap-recovery-v1',
  'yoy-decline': 'yoy-recovery-v1',
  'official-collection-below-threshold': 'collection-rate-recovery-v1',
  stable: 'stable-monitor-v1',
}

const ACTIONS_BY_SIGNAL: Record<StructuredDecision['primarySignal'], StructuredActionCode[]> = {
  'cumulative-budget-gap': ['rank-arrears-by-amount', 'contact-high-value-arrears', 'confirm-payment-date', 'track-payment-arrival'],
  'yoy-decline': ['compare-unpaid-cohort', 'revisit-broken-promises', 'contact-churned-payers', 'track-payment-arrival'],
  'official-collection-below-threshold': ['segment-by-payment-intent', 'send-account-statement', 'schedule-doorstep-follow-up', 'follow-payment-promise'],
  stable: ['review-key-metrics-next-day', 'retain-current-collection-rhythm'],
}

const ACTION_TEXT: Record<StructuredActionCode, string> = {
  'rank-arrears-by-amount': '按欠费金额排出优先顺序',
  'contact-high-value-arrears': '先联系高金额欠费对象',
  'confirm-payment-date': '逐户确认可兑现的付款日期',
  'track-payment-arrival': '跟踪承诺款项直至到账',
  'compare-unpaid-cohort': '对比同期未缴对象并找出本期新增缺口',
  'revisit-broken-promises': '优先回访付款承诺未兑现对象',
  'contact-churned-payers': '联系同期已缴但本期未缴对象',
  'segment-by-payment-intent': '按缴费意愿给欠费对象分层',
  'send-account-statement': '向可联系对象发送账单并确认收悉',
  'schedule-doorstep-follow-up': '对多次联系未果对象安排上门沟通',
  'follow-payment-promise': '按付款承诺节点逐笔跟进',
  'review-key-metrics-next-day': '下一业务日复核累计执行、同比和收缴率',
  'retain-current-collection-rhythm': '维持当前收款节奏并记录指标变化',
}

const ROLE_TEXT: Record<StructuredRoleCode, string> = {
  'charging-role': '收费岗位',
  'project-owner': '项目负责人',
  'customer-service': '客服管家',
  'finance-role': '财务岗位',
  'legal-role': '法务岗位',
}

const MATERIAL_TEXT: Record<StructuredMaterialCode, string> = {
  'arrears-list': '欠费户清单',
  contacts: '联系人及联系方式',
  bills: '账单',
  contracts: '合同',
  'communication-records': '沟通记录',
  'payment-promises': '付款承诺',
}

const EVIDENCE_TEXT: Record<StructuredEvidenceCode, string> = {
  'arrival-proof': '到账凭证',
  'payment-promise': '付款承诺',
  'collection-record': '催缴记录',
}

const TRIGGER_TEXT: Record<StructuredTriggerCode, string> = {
  refusal: '拒付',
  dispute: '发生争议',
  'broken-promise': '付款承诺未兑现',
  'metric-rule-triggered': '任一经营指标触发关注规则',
}

const CADENCE_TEXT: Record<StructuredCadenceCode, string> = {
  'same-day-first-contact': '当日完成首轮联系',
  'next-business-day-review': '下一业务日复核结果',
  'track-until-arrival': '持续跟踪至到账或触发升级',
}

const ROLE_CODES = Object.keys(ROLE_TEXT) as StructuredRoleCode[]
const MATERIAL_CODES = Object.keys(MATERIAL_TEXT) as StructuredMaterialCode[]
const EVIDENCE_CODES = Object.keys(EVIDENCE_TEXT) as StructuredEvidenceCode[]
const TRIGGER_CODES = Object.keys(TRIGGER_TEXT) as StructuredTriggerCode[]
const CADENCE_CODES = Object.keys(CADENCE_TEXT) as StructuredCadenceCode[]

function uniqueAllowed<T extends string>(value: unknown, allowed: readonly T[], minimum: number, maximum: number): T[] | null {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return null
  if (!value.every(item => typeof item === 'string' && allowed.includes(item as T))) return null
  if (new Set(value).size !== value.length) return null
  return value as T[]
}

function extractSingleJsonObject(source: string): unknown {
  try { return JSON.parse(source) } catch { /* 继续兼容仅包裹一层说明的网关 */ }
  const objects: string[] = []
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) objects.push(source.slice(start, index + 1))
    }
  }
  if (objects.length !== 1) return null
  try { return JSON.parse(objects[0]) } catch { return null }
}

function parseStructuredDecision(
  content: unknown,
  row: ServiceCenterAnalysisRow,
  knowledge: KnowledgeBundle,
): StructuredDecision | null {
  if (typeof content !== 'string') return null
  const trimmed = content.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const source = fenced ? fenced[1].trim() : trimmed
  const parsed = extractSingleJsonObject(source)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (JSON.stringify(keys) !== JSON.stringify([
    'actionCodes', 'cadence', 'completionEvidence', 'coordinationRole', 'escalationTrigger',
    'knowledgeId', 'materialCodes', 'plan', 'primarySignal',
  ])) return null
  if (typeof record.primarySignal !== 'string' || typeof record.plan !== 'string' || typeof record.knowledgeId !== 'string') return null

  // 首要信号由已验证规则顺序确定，Hermes负责为该信号选择最合适的执行组合。
  // 这样既不让模型改写经营事实，也避免多信号时把A信号的动作套到B信号。
  const allowedSignals: StructuredDecision['primarySignal'][] = row.signals.length
    ? [row.signals[0].code]
    : ['stable']
  const primarySignal = record.primarySignal as StructuredDecision['primarySignal']
  if (!allowedSignals.includes(primarySignal)) return null
  if (PLAN_BY_SIGNAL[primarySignal] !== record.plan) return null
  if (!knowledge.excerpts.some(excerpt => excerpt.documentId === record.knowledgeId)) return null
  const actionCodes = uniqueAllowed(record.actionCodes, ACTIONS_BY_SIGNAL[primarySignal], 2, 4)
  const materialCodes = uniqueAllowed(record.materialCodes, MATERIAL_CODES, 2, 4)
  if (!actionCodes || !materialCodes) return null
  if (!ROLE_CODES.includes(record.coordinationRole as StructuredRoleCode)) return null
  if (!EVIDENCE_CODES.includes(record.completionEvidence as StructuredEvidenceCode)) return null
  if (!TRIGGER_CODES.includes(record.escalationTrigger as StructuredTriggerCode)) return null
  if (!CADENCE_CODES.includes(record.cadence as StructuredCadenceCode)) return null
  if (primarySignal === 'stable' && record.escalationTrigger !== 'metric-rule-triggered') return null
  if (primarySignal !== 'stable' && record.escalationTrigger === 'metric-rule-triggered') return null
  return {
    primarySignal,
    plan: record.plan as StructuredDecision['plan'],
    actionCodes,
    coordinationRole: record.coordinationRole as StructuredRoleCode,
    materialCodes,
    completionEvidence: record.completionEvidence as StructuredEvidenceCode,
    escalationTrigger: record.escalationTrigger as StructuredTriggerCode,
    cadence: record.cadence as StructuredCadenceCode,
    knowledgeId: record.knowledgeId,
  }
}

function canonicalStructuredText(decision: StructuredDecision): string {
  const judgement = decision.primarySignal === 'stable'
    ? '当前可用指标未触发关注规则。'
    : `回款重点：围绕${SIGNAL_FOCUS_LABELS[decision.primarySignal]}推进可转化欠费款项到账。`
  const actions = decision.actionCodes.map(code => ACTION_TEXT[code]).join('；')
  const escalation = decision.primarySignal === 'stable'
    ? `若${TRIGGER_TEXT[decision.escalationTrigger]}，则由${ROLE_TEXT[decision.coordinationRole]}复核并转入催缴升级流程。`
    : `若${TRIGGER_TEXT[decision.escalationTrigger]}，则升级${ROLE_TEXT[decision.coordinationRole]}按催缴升级流程处理。`
  return [
    `AI判断：${judgement}`,
    'AI建议：',
    `先做什么：${actions}；${CADENCE_TEXT[decision.cadence]}。`,
    `谁来协同：${ROLE_TEXT[decision.coordinationRole]}。`,
    `所需材料：${decision.materialCodes.map(code => MATERIAL_TEXT[code]).join('、')}。`,
    `完成凭证：${EVIDENCE_TEXT[decision.completionEvidence]}。`,
    `升级条件：${escalation}[${decision.knowledgeId}]`,
  ].join('\n')
}

async function oneStructuredDecision(
  row: ServiceCenterAnalysisRow,
  knowledge: KnowledgeBundle,
  config: HermesClientConfig,
  timeoutMs: number,
): Promise<{ result: { decision: StructuredDecision; model: string } | null; observation: FetchObservation }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const fetchImpl = config.fetchImpl || fetch
  const allowedSignals = row.signals.length
    ? [{ code: row.signals[0].code, message: row.signals[0].message }]
    : [{ code: 'stable', message: '当前可用指标未触发关注规则' }]
  const allowedPlans = allowedSignals.map(signal => ({
    primarySignal: signal.code,
    plan: PLAN_BY_SIGNAL[signal.code as StructuredDecision['primarySignal']],
    allowedActionCodes: ACTIONS_BY_SIGNAL[signal.code as StructuredDecision['primarySignal']],
  }))
  const allowedActionCodes = allowedPlans[0].allowedActionCodes
  const allowedTriggerCodes: StructuredTriggerCode[] = allowedSignals[0].code === 'stable'
    ? ['metric-rule-triggered']
    : ['refusal', 'dispute', 'broken-promise']
  const input = buildServiceCenterHermesInput(row, knowledge) as HermesRefineInput & {
    context: { businessDate?: string | null; facts?: unknown }
  }
  try {
    const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 360,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'service_center_decision',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: [
                'primarySignal', 'plan', 'actionCodes', 'coordinationRole', 'materialCodes',
                'completionEvidence', 'escalationTrigger', 'cadence', 'knowledgeId',
              ],
              properties: {
                primarySignal: { type: 'string', enum: allowedPlans.map(item => item.primarySignal) },
                plan: { type: 'string', enum: allowedPlans.map(item => item.plan) },
                actionCodes: {
                  type: 'array', minItems: 2, maxItems: 4, uniqueItems: true,
                  items: { type: 'string', enum: allowedActionCodes },
                },
                coordinationRole: { type: 'string', enum: ROLE_CODES },
                materialCodes: {
                  type: 'array', minItems: 2, maxItems: 4, uniqueItems: true,
                  items: { type: 'string', enum: MATERIAL_CODES },
                },
                completionEvidence: { type: 'string', enum: EVIDENCE_CODES },
                escalationTrigger: { type: 'string', enum: allowedTriggerCodes },
                cadence: { type: 'string', enum: CADENCE_CODES },
                knowledgeId: { type: 'string', enum: knowledge.excerpts.map(excerpt => excerpt.documentId) },
              },
            },
          },
        },
        messages: [
          {
            role: 'system',
            content: '你是华北经营助手。必须根据当前服务中心事实选择最适合一线执行的动作组合、协同岗位、材料、节奏和升级条件。只能逐字使用给定代码，不得输出解释、数字、人名或额外字段；作业标准仅是安全边界，不能机械复制同一组合。',
          },
          {
            role: 'user',
            content: JSON.stringify({
              task: '首要经营信号已经由已验证规则确定。根据该中心事实，从对应动作中选择并排列可执行建议；不得改选其他信号。不同事实应优先选择不同动作顺序。只返回JSON。',
              requiredShape: {
                primarySignal: '从allowedDecisions.primarySignal中选择',
                plan: '使用同一条allowedDecisions.plan',
                actionCodes: '从同一条allowedDecisions.allowedActionCodes选择2至4项并按执行顺序排列',
                coordinationRole: ROLE_CODES,
                materialCodes: '从allowedMaterialCodes选择2至4项',
                completionEvidence: EVIDENCE_CODES,
                escalationTrigger: '稳定中心必须metric-rule-triggered；其他中心从refusal、dispute、broken-promise选择',
                cadence: CADENCE_CODES,
                knowledgeId: knowledge.excerpts[0]?.documentId || '',
              },
              serviceCenter: row.center,
              businessDate: input.context.businessDate,
              facts: input.context.facts,
              signals: allowedSignals,
              allowedDecisions: allowedPlans,
              allowedMaterialCodes: MATERIAL_CODES,
              allowedKnowledgeIds: knowledge.excerpts.map(excerpt => excerpt.documentId),
              approvedKnowledge: knowledge.excerpts.map(excerpt => ({
                knowledgeId: excerpt.documentId,
                title: excerpt.title,
                version: excerpt.version,
                content: excerpt.content,
              })),
            }),
          },
        ],
      }),
      signal: controller.signal,
    })
    if (!response.ok) return { result: null, observation: { kind: 'http', status: response.status } }
    const body = await response.json() as any
    const content = body?.choices?.[0]?.message?.content
    const providerError = typeof content === 'string'
      && /(?:insufficient balance|billing or credits exhausted|credits? exhausted|account entitlement is exhausted)/i.test(content)
    if (providerError) return { result: null, observation: { kind: 'http', status: 402 } }
    const decision = parseStructuredDecision(content, row, knowledge)
    return {
      result: decision ? { decision, model: String(body?.model || config.model) } : null,
      observation: { kind: 'ok' },
    }
  } catch {
    return { result: null, observation: { kind: 'request_error' } }
  } finally {
    clearTimeout(timer)
  }
}

async function oneRefinement(
  input: HermesRefineInput,
  config: HermesClientConfig,
  refine: typeof refineWithHermes,
  timeoutMs: number,
): Promise<{ result: Awaited<ReturnType<typeof refineWithHermes>>; observation: FetchObservation }> {
  let observation: FetchObservation = { kind: 'none' }
  const baseFetch = config.fetchImpl || fetch
  const observedFetch: typeof fetch = async (request, init) => {
    try {
      const response = await baseFetch(request, init)
      observation = response.ok ? { kind: 'ok' } : { kind: 'http', status: response.status }
      return response
    } catch (error) {
      observation = { kind: 'request_error' }
      throw error
    }
  }
  try {
    const result = await refine(input, { ...config, timeoutMs, fetchImpl: observedFetch })
    return { result, observation }
  } catch {
    return { result: null, observation: { kind: 'request_error' } }
  }
}

async function oneNaturalAdvice(
  input: HermesRefineInput,
  config: HermesClientConfig,
  timeoutMs: number,
): Promise<{ result: { text: string; model: string } | null; observation: FetchObservation }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const fetchImpl = config.fetchImpl || fetch
  const focusLabel = String((input.context as any)?.focusLabel || '')
  const knowledgeIds = input.knowledge.map(item => item.documentId).filter(Boolean)
  const knowledgeReferences = [...new Set(input.knowledge.flatMap(item => [item.documentId, ...(item.identifiers || [])]).filter(Boolean))]
  try {
    const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 420,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'service_center_action_advice',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: [
                'actions', 'coordinationRoles', 'materials', 'completionEvidence',
                'escalationTrigger', 'escalationRole', 'escalationProcess', 'knowledgeId',
              ],
              properties: {
                actions: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' } },
                coordinationRoles: {
                  type: 'array', minItems: 1, maxItems: 2, uniqueItems: true,
                  items: { type: 'string', enum: CONTROLLED_COORDINATION_ROLES },
                },
                materials: {
                  type: 'array', minItems: 2, maxItems: 3, uniqueItems: true,
                  items: { type: 'string', enum: APPROVED_MATERIALS },
                },
                completionEvidence: { type: 'string', enum: APPROVED_COMPLETION_EVIDENCE },
                escalationTrigger: { type: 'string', enum: APPROVED_ESCALATION_TRIGGERS },
                escalationRole: { type: 'string', enum: CONTROLLED_COORDINATION_ROLES },
                escalationProcess: { type: 'string', enum: APPROVED_ESCALATION_PROCESSES },
                knowledgeId: { type: 'string', enum: knowledgeIds },
              },
            },
          },
        },
        messages: [
          {
            role: 'system',
            content: '你是华北经营助手。只为当前服务中心生成三个不同阶段的一线动作。动作必须具体但不得补造数字、原因、完成状态、人名、期限或危险动作；不得照抄作业标准。只返回符合JSON Schema的对象。',
          },
          {
            role: 'user',
            content: JSON.stringify({
              task: 'actions按顺序填写：第一项以筛选/分类/分层开头；第二项以联系/发送/沟通开头；第三项以跟进/催缴/上门/约定开头。每项只描述下一步要做的事，不写已完成状态。其余字段从枚举中选择最适合本中心事实的一项或数组。',
              focusLabel,
              serviceCenterFacts: input.context,
              approvedKnowledge: input.knowledge,
            }),
          },
        ],
      }),
      signal: controller.signal,
    })
    if (!response.ok) return { result: null, observation: { kind: 'http', status: response.status } }
    const body = await response.json() as any
    const content = body?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) return { result: null, observation: { kind: 'ok' } }
    if (/(?:insufficient balance|billing or credits exhausted|credits? exhausted|account entitlement is exhausted)/i.test(content)) {
      return { result: null, observation: { kind: 'http', status: 402 } }
    }
    const parsed = extractSingleJsonObject(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { result: null, observation: { kind: 'ok' } }
    }
    const value = parsed as Record<string, any>
    const keys = Object.keys(value).sort()
    const expected = [
      'actions', 'completionEvidence', 'coordinationRoles', 'escalationProcess',
      'escalationRole', 'escalationTrigger', 'knowledgeId', 'materials',
    ].sort()
    const exactShape = JSON.stringify(keys) === JSON.stringify(expected)
    const profileShape = keys.includes('actions') && keys.includes('focusLabel') && keys.includes('serviceCenterName')
    let actionTexts: string[] = []
    let coordinationRoles: string[] = []
    let materials: string[] = []
    let completionEvidence = ''
    let escalationTrigger = ''
    let escalationRole = ''
    let escalationProcess = ''
    if (exactShape) {
      actionTexts = value.actions
      coordinationRoles = value.coordinationRoles
      materials = value.materials
      completionEvidence = value.completionEvidence
      escalationTrigger = value.escalationTrigger
      escalationRole = value.escalationRole
      escalationProcess = value.escalationProcess
      if (!knowledgeIds.includes(value.knowledgeId)) return { result: null, observation: { kind: 'ok' } }
    } else if (profileShape) {
      const topLevelSignals = Object.entries(value)
        .filter(([key, nested]) => /signal/i.test(key) && Array.isArray(nested))
        .flatMap(([, nested]) => nested as unknown[])
      const profileSignals = topLevelSignals.length
        ? topLevelSignals
        : value.actions.flatMap((item: any) => Object.entries(item)
          .filter(([key, nested]) => /signal|evidence/i.test(key) && Array.isArray(nested))
          .flatMap(([, nested]) => nested as unknown[]))
      const topLevelKnowledge = Object.entries(value)
        .filter(([key, nested]) => /knowledge|referenceStandard|standard/i.test(key) && Array.isArray(nested))
        .flatMap(([, nested]) => nested as unknown[])
      const profileKnowledge = topLevelKnowledge.length
        ? topLevelKnowledge
        : value.actions.flatMap((item: any) => Object.entries(item)
          .filter(([key, nested]) => /knowledge/i.test(key) && Array.isArray(nested))
          .flatMap(([, nested]) => nested as unknown[]))
      const profileActionText = (item: any): unknown => item.action ?? item.content ?? item.description ?? item.nextStep
      const profileValid = value.serviceCenterName === (input.context as any)?.serviceCenterName
        && value.focusLabel === focusLabel
        && Array.isArray(value.actions) && value.actions.length === 3
        && value.actions.every((item: any, index: number) => item
          && Number(item.step ?? item.order ?? item.actionOrder ?? item.sequence ?? (String(item.actionType || '').startsWith(['筛选', '联系', '跟进'][index]) ? index + 1 : 0)) === index + 1
          && typeof profileActionText(item) === 'string')
        && profileSignals.every((code: unknown) =>
          (input.context as any)?.operatingSignals?.some((signal: any) => signal.code === code))
        && profileKnowledge.length > 0
        && profileKnowledge.every((id: unknown) => {
          const referenceText = typeof id === 'object' && id ? JSON.stringify(id) : String(id)
          return knowledgeReferences.some(allowed => referenceText.includes(allowed))
        })
      if (!profileValid) return { result: null, observation: { kind: 'ok' } }
      // Codex profile会把当前中心事实外壳一并返回。只采纳它生成的三步动作；
      // 岗位、材料、凭证和升级条件仍由批准枚举收口，避免模型扩写个人或越权流程。
      actionTexts = value.actions.map((item: any) => String(profileActionText(item))
        .replace(/^筛选\s*\/\s*分类\s*\/\s*分层\s*[:：]?\s*/, '筛选并分类')
        .replace(/^联系\s*\/\s*发送\s*\/\s*沟通\s*[:：]?\s*/, '联系并沟通')
        .replace(/^跟进\s*\/\s*催缴\s*\/\s*上门\s*\/\s*约定\s*[:：]?\s*/, '跟进并催缴'))
      coordinationRoles = ['收费岗位', '项目负责人']
      materials = ['欠费户清单', '联系人', '账单']
      completionEvidence = '催缴记录'
      escalationTrigger = '承诺未兑现'
      escalationRole = '项目负责人'
      escalationProcess = '催缴升级流程'
    } else {
      return { result: null, observation: { kind: 'ok' } }
    }
    if (!Array.isArray(actionTexts) || actionTexts.length !== 3
      || actionTexts.some((item: unknown) => typeof item !== 'string' || !item.trim())
      || !Array.isArray(coordinationRoles) || coordinationRoles.length < 1 || coordinationRoles.length > 2
      || !coordinationRoles.every(item => CONTROLLED_COORDINATION_ROLES.includes(item as any))
      || !Array.isArray(materials) || materials.length < 2 || materials.length > 3
      || !materials.every(item => APPROVED_MATERIALS.includes(item as any))
      || !APPROVED_COMPLETION_EVIDENCE.includes(completionEvidence as any)
      || !APPROVED_ESCALATION_TRIGGERS.includes(escalationTrigger as any)
      || !CONTROLLED_COORDINATION_ROLES.includes(escalationRole as any)
      || !APPROVED_ESCALATION_PROCESSES.includes(escalationProcess as any)) {
      return { result: null, observation: { kind: 'ok' } }
    }
    const actions = actionTexts.map((item: string, index: number) => `动作${['一', '二', '三'][index]}：${item.trim().replace(/^动作[一二三]\s*[:：]\s*/, '')}`)
    const text = [
      'AI判断：',
      `回款重点：${focusLabel}`,
      'AI建议：',
      '一线执行卡',
      '先做什么：',
      ...actions,
      `谁来协同：${coordinationRoles.join('、')}`,
      `所需材料：${materials.join('、')}`,
      `完成凭证：${completionEvidence}`,
      `升级条件：若${escalationTrigger}，则由${escalationRole}提交升级处理并按${escalationProcess}执行。[K1]`,
    ].join('\n')
    return { result: { text, model: String(body?.model || config.model) }, observation: { kind: 'ok' } }
  } catch {
    return { result: null, observation: { kind: 'request_error' } }
  } finally {
    clearTimeout(timer)
  }
}

export async function analyzeServiceCenterRow(
  row: ServiceCenterAnalysisRow,
  options: ServiceCenterAiAnalyzeOptions,
): Promise<ServiceCenterAiGeneratedResult> {
  const now = options.now || Date.now
  const generatedAt = () => new Date(now()).toISOString()
  const fallback = (
    status: ServiceCenterAiGeneratedResult['status'],
    errorCode: string,
  ): ServiceCenterAiGeneratedResult => ({
    inputSha256: options.inputSha256,
    normalizedCenter: row.normalizedCenter,
    businessDate: options.businessDate,
    status,
    generatedBy: 'verified-rules',
    modelUsed: null,
    aiOpinion: null,
    errorCode,
    generatedAt: null,
  })
  const assessedMetricCount = [
    row.metrics.cumulativeBudgetGap,
    row.metrics.yoyGrowth,
    row.metrics.officialCollectionRate,
  ].filter(value => value !== null).length
  if (!assessedMetricCount) return fallback('insufficient_evidence', 'insufficient_evidence')

  const hermes = configuredHermes(options)
  if (!isConfigured(hermes)) return fallback('unavailable', 'not_configured')
  if (!options.knowledge.excerpts.length) return fallback('unavailable', 'approved_knowledge_unavailable')
  const useStructured = options.analysisMode === 'structured'
    || (!options.refine && options.analysisMode !== 'legacy')
  if (useStructured) {
    const sleep = options.sleep || ((milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds)))
    const deadline = now() + Math.max(1_000, hermes.timeoutMs || DEFAULT_TIMEOUT_MS)
    let response = await oneStructuredDecision(row, options.knowledge, hermes, Math.max(1_000, deadline - now()))
    const retryableHttp = response.observation.kind === 'http'
      && [429, 502, 503, 504].includes(Number(response.observation.status))
    const retryableInvalidStructure = response.observation.kind === 'ok'
    if (!response.result && (retryableHttp || retryableInvalidStructure) && deadline - now() > 1_500) {
      await sleep(500)
      response = await oneStructuredDecision(row, options.knowledge, hermes, Math.max(1_000, deadline - now()))
    }
    if (!response.result) {
      const rejected = response.observation.kind === 'ok'
      const errorCode = response.observation.kind === 'http'
        ? `http_${response.observation.status}`
        : response.observation.kind === 'request_error' ? 'request_error' : rejected ? 'structured_output_rejected' : 'unavailable'
      return fallback(rejected ? 'rejected' : 'unavailable', errorCode)
    }
    const canonical = canonicalStructuredText(response.result.decision)
    const aiOpinion = buildAssistantOpinion(canonical, serviceCenterEvidence(row, options.businessDate))
    if (!aiOpinion) return fallback('rejected', 'opinion_parse_rejected')
    return {
      inputSha256: options.inputSha256,
      normalizedCenter: row.normalizedCenter,
      businessDate: options.businessDate,
      status: 'generated',
      generatedBy: 'hermes-grounded',
      modelUsed: response.result.model,
      aiOpinion: response.result.decision.primarySignal === 'stable'
        ? { ...aiOpinion, recommendations: null }
        : aiOpinion,
      errorCode: null,
      generatedAt: generatedAt(),
    }
  }
  const input = buildServiceCenterHermesInput(row, options.knowledge)
  const sleep = options.sleep || ((milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const deadline = now() + Math.max(1_000, hermes.timeoutMs || DEFAULT_TIMEOUT_MS)
  const requestAdvice = (remaining: number) => options.refine
    ? oneRefinement(input, hermes, options.refine, remaining)
    : oneNaturalAdvice(input, hermes, Math.min(30_000, remaining))
  let response = await requestAdvice(Math.max(1_000, deadline - now()))
  const retryableHttp = response.observation.kind === 'http'
    && [429, 502, 503, 504].includes(Number(response.observation.status))
  const retryableDirectRequest = !options.refine && response.observation.kind === 'request_error'
  if (!response.result && (retryableHttp || retryableDirectRequest) && deadline - now() > 1_500) {
    await sleep(500)
    response = await requestAdvice(Math.max(1_000, deadline - now()))
  }
  if (!response.result) {
    const rejected = response.observation.kind === 'ok'
    const errorCode = response.observation.kind === 'http'
      ? `http_${response.observation.status}`
      : response.observation.kind === 'request_error' ? 'request_error' : rejected ? 'validation_rejected' : 'unavailable'
    return fallback(rejected ? 'rejected' : 'unavailable', errorCode)
  }

  if (MODEL_DANGEROUS_CONTENT.test(response.result.text)) {
    return fallback('rejected', 'dangerous_content_rejected')
  }
  if (MODEL_UNGROUNDED_CAUSAL.test(response.result.text)) {
    return fallback('rejected', row.signals.length
      ? 'ungrounded_causal_rejected'
      : 'stable_center_ungrounded_causal_rejected')
  }
  const allowedModelNumbers = new Set(row.signals.flatMap(signal => signal.message.match(/-?\d+(?:\.\d+)?/g) || []))
  const usedModelNumbers = stripKnowledgeCitations(response.result.text).match(/-?\d+(?:\.\d+)?/g) || []
  if (usedModelNumbers.some(value => !allowedModelNumbers.has(value))) {
    return fallback('rejected', 'ungrounded_numbers_rejected')
  }
  if (!row.signals.length) {
    // 旧版Hermes仅校验数字和格式，可能放过稳定中心的泛化建议或无证据归因。
    // 稳定中心只允许复述“未触发关注规则”，违反时必须回退到本地规则。
    if (STABLE_CENTER_ADVICE.test(response.result.text)) {
      return fallback('rejected', 'stable_center_advice_rejected')
    }
    if (!hasExactStableJudgement(response.result.text)) {
      return fallback('rejected', 'stable_center_judgement_rejected')
    }
  } else {
    if (!hasExactAttentionJudgement(row, response.result.text)) {
      return fallback('rejected', 'attention_judgement_rejected')
    }
    const violation = executionCardViolation(response.result.text)
    if (violation) return fallback('rejected', violation)
  }

  const aiOpinion = buildAssistantOpinion(response.result.text, serviceCenterEvidence(row, options.businessDate))
  if (!aiOpinion) return fallback('rejected', 'opinion_parse_rejected')
  // 稳定中心没有warning信号，只保留经门禁校验的AI判断。
  // 即使模型违反格式额外生成泛化动作，也不展示。
  const safeOpinion = row.signals.length
    ? compactAiRecommendations(aiOpinion, response.result.text)
    : { ...aiOpinion, recommendations: null }
  return {
    inputSha256: options.inputSha256,
    normalizedCenter: row.normalizedCenter,
    businessDate: options.businessDate,
    status: 'generated',
    generatedBy: 'hermes-grounded',
    modelUsed: response.result.model,
    aiOpinion: safeOpinion,
    errorCode: null,
    generatedAt: generatedAt(),
  }
}

function resultRows(database: typeof db, hashes: string[]): Map<string, AiResultRow> {
  if (!hashes.length) return new Map()
  const placeholders = hashes.map(() => '?').join(',')
  const rows = database.prepare(`SELECT * FROM service_center_ai_results WHERE input_sha256 IN (${placeholders})`)
    .all(...hashes) as AiResultRow[]
  return new Map(rows.map(row => [row.input_sha256, row]))
}

function validatedCachedOpinion(row: AiResultRow): AssistantOpinion | null {
  if (row.status !== 'generated' || !row.model.trim() || !row.generated_at.trim()) return null
  const parsed = safeJson<unknown>(row.ai_opinion_json, null)
  if (!parsed || typeof parsed !== 'object') return null
  const opinion = parsed as Partial<AssistantOpinion>
  if (typeof opinion.judgement !== 'string' || !opinion.judgement.trim()) return null
  if (opinion.recommendations !== null && typeof opinion.recommendations !== 'string') return null
  return opinion as AssistantOpinion
}

function effectiveCacheStatus(row: AiResultRow): AiResultRow['status'] {
  return row.status === 'generated' && !validatedCachedOpinion(row) ? 'rejected' : row.status
}

function reusableCache(row: AiResultRow | undefined, now: number): boolean {
  if (!row) return false
  if (row.status === 'generated' && validatedCachedOpinion(row)) return true
  if (row.status === 'insufficient_evidence') return true
  return now - Number(row.created_at_ms || 0) <= NEGATIVE_CACHE_MS
}

function scopeHash(prepared: PreparedCenter[]): string {
  return sha256(prepared.map(item => item.inputSha256).sort())
}

function activeRun(database: typeof db, hash: string): AiRunRow | null {
  return (database.prepare(`SELECT * FROM service_center_ai_runs
    WHERE scope_sha256=? AND status='running' ORDER BY id DESC LIMIT 1`).get(hash) as AiRunRow | undefined) || null
}

function rowFields(
  row: ServiceCenterAnalysisRow,
  cached: AiResultRow | undefined,
  configured: boolean,
  now: number,
): ServiceCenterAiRowFields {
  if (cached && reusableCache(cached, now)) {
    const cacheStatus = effectiveCacheStatus(cached)
    const opinion = validatedCachedOpinion(cached)
    const generated = cacheStatus === 'generated' && Boolean(opinion)
    return {
      aiOpinion: generated ? opinion : null,
      generatedBy: generated ? 'hermes-grounded' : 'verified-rules',
      modelUsed: generated ? cached.model || null : null,
      modelStatus: generated ? 'cached' : cacheStatus,
      aiGeneratedAt: generated ? cached.generated_at || null : null,
      readOnly: true,
    }
  }
  const assessed = [row.metrics.cumulativeBudgetGap, row.metrics.yoyGrowth, row.metrics.officialCollectionRate]
    .some(value => value !== null)
  return {
    aiOpinion: null,
    generatedBy: 'verified-rules',
    modelUsed: null,
    modelStatus: !assessed ? 'insufficient_evidence' : configured ? 'pending' : 'unavailable',
    aiGeneratedAt: null,
    readOnly: true,
  }
}

export function attachServiceCenterAiSnapshot(
  analysis: ServiceCenterAnalysis,
  options: ServiceCenterAiOptions = {},
): ServiceCenterAnalysis & { ai: ServiceCenterAiEnvelope; rows: Array<ServiceCenterAnalysisRow & ServiceCenterAiRowFields> } {
  const database = options.database || db
  const hermes = configuredHermes(options)
  const configured = isConfigured(hermes)
  const knowledge = loadKnowledge(options)
  const ready = configured && knowledge.excerpts.length > 0
  const prepared = preparedCenters(analysis, options, knowledge)
  const cache = resultRows(database, prepared.map(item => item.inputSha256))
  const running = activeRun(database, scopeHash(prepared))
  const timestamp = (options.now || Date.now)()
  const rows = prepared.map(item => ({
    ...item.row,
    ...rowFields(item.row, cache.get(item.inputSha256), ready, timestamp),
  }))
  // GET中所有Hermes意见均来自持久化缓存；generated专指当前run新生成数，
  // 因此这里不与cached重复计数。
  const generated = 0
  const cached = rows.filter(row => row.generatedBy === 'hermes-grounded').length
  const pending = rows.filter(row => row.modelStatus === 'pending').length
  const insufficient = rows.filter(row => row.modelStatus === 'insufficient_evidence').length
  const failed = rows.filter(row => ['unavailable', 'rejected'].includes(row.modelStatus)).length
  const status: ServiceCenterAiEnvelope['status'] = !ready
    ? 'unavailable'
    : pending ? 'pending'
      : failed ? 'partial'
        : generated + cached + insufficient === rows.length ? 'complete' : 'partial'
  return {
    ...analysis,
    ai: {
      configured,
      status,
      model: configured ? hermes.model : null,
      promptVersion: SERVICE_CENTER_AI_PROMPT_VERSION,
      total: rows.length,
      generated,
      cached,
      pending,
      failed,
      insufficient,
      runId: running?.id || null,
      readOnly: true,
    },
    rows,
  }
}

function persistResult(database: typeof db, result: ServiceCenterAiGeneratedResult, knowledge: KnowledgeBundle, now: number): void {
  database.prepare(`INSERT INTO service_center_ai_results
    (normalized_center,input_sha256,business_date,status,generated_by,model,prompt_version,knowledge_sha256,ai_opinion_json,error_code,generated_at,created_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(input_sha256) DO UPDATE SET
      status=excluded.status, generated_by=excluded.generated_by, model=excluded.model,
      prompt_version=excluded.prompt_version, knowledge_sha256=excluded.knowledge_sha256,
      ai_opinion_json=excluded.ai_opinion_json, error_code=excluded.error_code,
      generated_at=excluded.generated_at, created_at_ms=excluded.created_at_ms`)
    .run(
      result.normalizedCenter,
      result.inputSha256,
      result.businessDate || '',
      result.status,
      result.generatedBy,
      result.modelUsed || '',
      SERVICE_CENTER_AI_PROMPT_VERSION,
      knowledge.sha256,
      JSON.stringify(result.aiOpinion),
      result.errorCode || '',
      result.generatedAt || '',
      now,
    )
}

function updateRunProgress(database: typeof db, runId: number, result: ServiceCenterAiGeneratedResult): void {
  const counters = {
    generated: result.status === 'generated' ? 1 : 0,
    rejected: result.status === 'rejected' ? 1 : 0,
    unavailable: result.status === 'unavailable' ? 1 : 0,
    insufficient: result.status === 'insufficient_evidence' ? 1 : 0,
  }
  database.prepare(`UPDATE service_center_ai_runs SET
    completed_count=completed_count+1,
    generated_count=generated_count+?, rejected_count=rejected_count+?,
    unavailable_count=unavailable_count+?, insufficient_count=insufficient_count+?
    WHERE id=? AND status='running'`)
    .run(counters.generated, counters.rejected, counters.unavailable, counters.insufficient, runId)
}

function runDto(row: AiRunRow): Record<string, unknown> {
  return {
    runId: row.id,
    status: row.status,
    model: row.model || null,
    promptVersion: row.prompt_version,
    progress: {
      total: row.total_count,
      completed: row.completed_count,
      generated: row.generated_count,
      cached: row.cached_count,
      rejected: row.rejected_count,
      unavailable: row.unavailable_count,
      insufficient: row.insufficient_count,
    },
    errorSummary: safeJson<Record<string, unknown>>(row.error_summary_json, {}),
    startedAt: row.started_at,
    completedAt: row.completed_at || null,
    readOnly: true,
  }
}

async function executeRun(
  runId: number,
  analysis: ServiceCenterAnalysis,
  candidates: PreparedCenter[],
  requestContext: any,
  knowledge: KnowledgeBundle,
  options: ServiceCenterAiOptions,
): Promise<void> {
  const database = options.database || db
  const now = options.now || Date.now
  let cursor = 0
  try {
    const worker = async () => {
      while (true) {
        const index = cursor++
        const task = candidates[index]
        if (!task) return
        const active = database.prepare("SELECT id FROM service_center_ai_runs WHERE id=? AND status='running'").get(runId)
        if (!active) return
        const result = await analyzeServiceCenterRow(task.row, {
          ...options,
          analysisMode: options.analysisMode || 'legacy',
          businessDate: analysis.businessDate,
          inputSha256: task.inputSha256,
          knowledge,
        })
        database.transaction(() => {
          persistResult(database, result, knowledge, now())
          updateRunProgress(database, runId, result)
        })()
      }
    }
    await Promise.all(Array.from({ length: Math.min(boundedConcurrency(options), Math.max(1, candidates.length)) }, worker))
    database.transaction(() => {
      const row = database.prepare('SELECT * FROM service_center_ai_runs WHERE id=?').get(runId) as AiRunRow
      if (!row || row.status !== 'running') return
      const hasFailures = row.rejected_count > 0 || row.unavailable_count > 0
      const status = hasFailures ? 'partial' : 'completed'
      database.prepare(`UPDATE service_center_ai_runs SET status=?,completed_at=datetime('now','localtime'),
        error_summary_json=? WHERE id=? AND status='running'`)
        .run(status, JSON.stringify({
          rejected: row.rejected_count,
          unavailable: row.unavailable_count,
          ruleFallbackAvailable: hasFailures,
        }), runId)
      logOperationStrict(requestContext, '完成服务中心Hermes分析', `ai:service-centers-run:${runId}`, {
        model: row.model,
        promptVersion: row.prompt_version,
        total: row.total_count,
        generated: row.generated_count,
        cached: row.cached_count,
        rejected: row.rejected_count,
        unavailable: row.unavailable_count,
        insufficient: row.insufficient_count,
        status,
      })
    })()
  } catch (error: any) {
    database.transaction(() => {
      database.prepare(`UPDATE service_center_ai_runs SET status='failed',completed_at=datetime('now','localtime'),
        error_summary_json=? WHERE id=? AND status='running'`)
        .run(JSON.stringify({ code: 'run_failed', message: String(error?.message || 'AI分析运行失败').slice(0, 200) }), runId)
      logOperationStrict(requestContext, '服务中心Hermes分析失败', `ai:service-centers-run:${runId}`, {
        promptVersion: SERVICE_CENTER_AI_PROMPT_VERSION,
        errorCode: 'run_failed',
      })
    })()
  }
}

export function queueServiceCenterAiRun(
  analysis: ServiceCenterAnalysis,
  requestContext: any,
  options: ServiceCenterAiOptions = {},
): { run: Record<string, unknown>; reused: boolean; completion: Promise<void> } {
  const database = options.database || db
  const hermes = configuredHermes(options)
  if (!isConfigured(hermes)) {
    return {
      run: { runId: null, status: 'unavailable', ruleResultsAvailable: true, readOnly: true },
      reused: false,
      completion: Promise.resolve(),
    }
  }
  const knowledge = loadKnowledge(options)
  if (!knowledge.excerpts.length) {
    return {
      run: { runId: null, status: 'unavailable', errorCode: 'approved_knowledge_unavailable', ruleResultsAvailable: true, readOnly: true },
      reused: false,
      completion: Promise.resolve(),
    }
  }
  const prepared = preparedCenters(analysis, options, knowledge)
  const hash = scopeHash(prepared)
  const existing = activeRun(database, hash)
  if (existing) return { run: runDto(existing), reused: true, completion: Promise.resolve() }
  const timestamp = (options.now || Date.now)()
  const cache = resultRows(database, prepared.map(item => item.inputSha256))
  const candidates = prepared.filter(item => !reusableCache(cache.get(item.inputSha256), timestamp))
  const reusableRows = prepared
    .map(item => cache.get(item.inputSha256))
    .filter((item): item is AiResultRow => Boolean(item && reusableCache(item, timestamp)))
  // run进度的分类必须互斥：cached只表示复用的有效Hermes意见；
  // 复用的负缓存和证据不足仍归入各自状态。
  const cachedCounts = {
    cached: reusableRows.filter(item => effectiveCacheStatus(item) === 'generated').length,
    rejected: reusableRows.filter(item => effectiveCacheStatus(item) === 'rejected').length,
    unavailable: reusableRows.filter(item => effectiveCacheStatus(item) === 'unavailable').length,
    insufficient: reusableRows.filter(item => effectiveCacheStatus(item) === 'insufficient_evidence').length,
  }
  const completedFromCache = reusableRows.length
  if (!candidates.length) {
    const counts = {
      generated: 0,
      ...cachedCounts,
    }
    const status = counts.rejected || counts.unavailable ? 'partial' : 'completed'
    return {
      run: {
        runId: null,
        status,
        progress: { total: prepared.length, completed: prepared.length, ...counts },
        readOnly: true,
      },
      reused: true,
      completion: Promise.resolve(),
    }
  }
  const runId = database.transaction(() => {
    const inserted = database.prepare(`INSERT INTO service_center_ai_runs
      (scope_sha256,input_hashes_json,status,model,prompt_version,total_count,completed_count,cached_count,
       rejected_count,unavailable_count,insufficient_count,started_by_user_id,started_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      hash,
      JSON.stringify(prepared.map(item => item.inputSha256)),
      'running',
      hermes.model,
      SERVICE_CENTER_AI_PROMPT_VERSION,
      prepared.length,
      completedFromCache,
      cachedCounts.cached,
      cachedCounts.rejected,
      cachedCounts.unavailable,
      cachedCounts.insufficient,
      requestContext?.user?.userId || null,
      requestContext?.user?.username || 'system',
    )
    const id = Number(inserted.lastInsertRowid)
    logOperationStrict(requestContext, '启动服务中心Hermes分析', `ai:service-centers-run:${id}`, {
      scopeCount: prepared.length,
      pendingCount: candidates.length,
      cachedCount: cachedCounts.cached,
      reusedCount: completedFromCache,
      scopeSha256: hash.slice(0, 16),
      model: hermes.model,
      promptVersion: SERVICE_CENTER_AI_PROMPT_VERSION,
      concurrency: boundedConcurrency(options),
    })
    return id
  })()
  const row = database.prepare('SELECT * FROM service_center_ai_runs WHERE id=?').get(runId) as AiRunRow
  const completion = executeRun(runId, analysis, candidates, requestContext, knowledge, options)
  return { run: runDto(row), reused: false, completion }
}

export function getServiceCenterAiRun(
  runId: number,
  user: any,
  options: ServiceCenterAiOptions = {},
  analysis?: ServiceCenterAnalysis,
): Record<string, unknown> | null {
  const database = options.database || db
  const row = database.prepare('SELECT * FROM service_center_ai_runs WHERE id=?').get(runId) as AiRunRow | undefined
  if (!row) return null
  if (!user) return null
  const owner = row.started_by_user_id !== null && user.userId !== null && user.userId !== undefined
    && Number(row.started_by_user_id) === Number(user.userId)
  if (user.role !== 'admin' && !owner) {
    if (!analysis) return null
    // 只有当前账号重建出的完整证据范围与run完全相同时才共享进度。
    // 不同scope即使只有聚合计数也不可枚举。
    const knowledge = loadKnowledge(options)
    const currentScopeHash = scopeHash(preparedCenters(analysis, options, knowledge))
    if (currentScopeHash !== row.scope_sha256) return null
  }
  return runDto(row)
}
