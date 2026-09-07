import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ArrearsCause } from './arrears-analysis.js'

export type ArrearsHouseholdAction = {
  actionKey: string
  houseHash: string
  houseMasked: string
  serviceCenter: string
  authoritativeArrearsAmount: number
  lvzaiBusinessDate: string
  periodStart: string | null
  periodEnd: string | null
  ageingMonths: number | null
  primaryCause: ArrearsCause
  causeEvidence: 'wecom_and_qxm' | 'wecom' | 'qxm' | 'conflicted' | 'none'
  evidenceRefs: string[]
  knownFacts: string[]
  reasonableJudgments: string[]
  pendingVerification: string[]
  priority: 'priority_review' | 'standard_followup'
  recommendationCodes: string[]
  recommendationLabels: string[]
  communicationFacts: {
    messageCount: number
    outboundCount: number
    inboundCount: number
    latestCommunicationAt: string | null
    latestOutboundAt: string | null
    latestInboundAt: string | null
    hasTwoWayCommunication: boolean
  } | null
}

const CAUSE_LABELS: Record<ArrearsCause, string> = {
  service_dispute: '服务争议', charge_dispute: '收费争议', vacancy: '房屋空置', financial_hardship: '支付困难',
  ownership_or_handover: '产权或交付问题', contact_barrier: '联系障碍', promised_payment: '承诺缴费', legal_dispute: '法律争议', unknown: '原因未知',
}
function split(value: unknown): string[] { return String(value || '').split(',').map(item => item.trim()).filter(Boolean) }
function money(value: number): string { return `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))] }
function ageingMonths(periodStart: unknown, businessDate: string): number | null {
  const start = String(periodStart || '').match(/^(\d{4})-(\d{2})/)
  const end = String(businessDate || '').match(/^(\d{4})-(\d{2})/)
  if (!start || !end) return null
  const months = (Number(end[1]) - Number(start[1])) * 12 + Number(end[2]) - Number(start[2]) + 1
  return months > 0 ? months : null
}

export function readArrearsHouseholdActions(database: Database.Database, options: { serviceCenters?: string[]; limit?: number; offset?: number } = {}): { ready: boolean; businessDate: string | null; total: number; rows: ArrearsHouseholdAction[]; truncated: boolean } {
  const lvzaiRun = database.prepare("SELECT id,business_date FROM arrears_source_sync_runs WHERE source='lvzai' AND status='published' ORDER BY business_date DESC,id DESC LIMIT 1").get() as any
  if (!lvzaiRun) return { ready: false, businessDate: null, total: 0, rows: [], truncated: false }
  const wecomRun = database.prepare("SELECT id FROM arrears_source_sync_runs WHERE source='wecom_ledger' AND status='published' ORDER BY business_date DESC,id DESC LIMIT 1").get() as any
  const qxmRun = database.prepare("SELECT id FROM arrears_source_sync_runs WHERE source='qxm' AND status='published' ORDER BY business_date DESC,id DESC LIMIT 1").get() as any
  const authorityRows = database.prepare(`SELECT house_hash,MAX(house_masked) house_masked,MAX(service_center) service_center,SUM(amount) amount,MIN(period_start) period_start,MAX(period_end) period_end,COUNT(DISTINCT fee_item) fee_count,GROUP_CONCAT(evidence_sha256) evidence FROM arrears_lvzai_facts WHERE run_id=? GROUP BY house_hash`).all(lvzaiRun.id) as any[]
  const ledgerRows = wecomRun ? database.prepare(`SELECT house_hash,MAX(service_center) service_center,MAX(latest_followup_date) latest_followup_date,MAX(progress) progress,GROUP_CONCAT(DISTINCT manual_cause) causes,GROUP_CONCAT(evidence_sha256) evidence FROM arrears_wecom_ledger_facts WHERE run_id=? GROUP BY house_hash`).all(wecomRun.id) as any[] : []
  const communicationRows = qxmRun ? database.prepare(`SELECT house_hash,MAX(service_center) service_center,MAX(occurred_at) occurred_at,COUNT(*) message_count,SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) outbound_count,SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END) inbound_count,MAX(CASE WHEN direction='outbound' THEN occurred_at END) latest_outbound_at,MAX(CASE WHEN direction='inbound' THEN occurred_at END) latest_inbound_at,MAX(CASE WHEN signal_state='conflicted' THEN 1 ELSE 0 END) conflicted,GROUP_CONCAT(DISTINCT CASE WHEN signal_state='supported' THEN cause_signal END) causes,GROUP_CONCAT(evidence_sha256) evidence FROM arrears_qxm_evidence WHERE run_id=? AND match_state='matched' GROUP BY house_hash`).all(qxmRun.id) as any[] : []
  const ledger = new Map(ledgerRows.map(row => [String(row.house_hash), row])), communication = new Map(communicationRows.map(row => [String(row.house_hash), row]))
  const allowed = options.serviceCenters?.length ? new Set(options.serviceCenters) : null
  const rows = authorityRows.filter(row => !allowed || allowed.has(String(row.service_center))).map(authority => {
    const houseHash = String(authority.house_hash), manual = ledger.get(houseHash), chat = communication.get(houseHash)
    const amount = Number(authority.amount), knownFacts = [`绿仔${lvzaiRun.business_date}权威欠费金额${money(amount)}`]
    const communicationFacts = chat ? {
      messageCount: Number(chat.message_count || 0),
      outboundCount: Number(chat.outbound_count || 0),
      inboundCount: Number(chat.inbound_count || 0),
      latestCommunicationAt: chat.occurred_at ? String(chat.occurred_at) : null,
      latestOutboundAt: chat.latest_outbound_at ? String(chat.latest_outbound_at) : null,
      latestInboundAt: chat.latest_inbound_at ? String(chat.latest_inbound_at) : null,
      hasTwoWayCommunication: Number(chat.outbound_count || 0) > 0 && Number(chat.inbound_count || 0) > 0,
    } : null
    if (authority.period_start || authority.period_end) knownFacts.push(`绿仔欠费账期${authority.period_start || '未知'}至${authority.period_end || '未知'}`)
    knownFacts.push(`绿仔欠费费项${Number(authority.fee_count || 0)}类`)
    const reasonableJudgments: string[] = [], pendingVerification: string[] = [], recommendationCodes: string[] = [], recommendationLabels: string[] = []
    const manualCauses = split(manual?.causes).filter(cause => cause !== 'unknown') as ArrearsCause[]
    const chatCauses = split(chat?.causes).filter(cause => cause !== 'unknown') as ArrearsCause[]
    if (manual) {
      knownFacts.push(`企业微信历史人工记录日期${manual.latest_followup_date || '未提供'}（不代表最新沟通）`)
      if (manual.progress === 'reported_paid_pending_lvzai') pendingVerification.push('人工报告已缴，但绿仔仍显示欠费；不得改写缴费状态，需等待绿仔确认')
      if (manualCauses.length) pendingVerification.push(`企业微信人工原因“${unique(manualCauses.map(cause => CAUSE_LABELS[cause] || '原因未知')).join('、')}”尚未由权威来源确认`)
      if (String(manual.service_center) !== String(authority.service_center)) pendingVerification.push('企业微信与绿仔服务中心归属不一致')
    } else pendingVerification.push('当前没有可关联的企业微信历史人工记录；不据此推断未催缴')
    if (chat) {
      knownFacts.push(`企小码最近结构化沟通信号日期${String(chat.occurred_at || '').slice(0, 10) || '未提供'}`)
      knownFacts.push(`企小码已匹配沟通消息${communicationFacts!.messageCount}条（员工发出${communicationFacts!.outboundCount}条、客户回复${communicationFacts!.inboundCount}条）`)
      if (communicationFacts!.latestOutboundAt) knownFacts.push(`企小码最近员工发出时间${communicationFacts!.latestOutboundAt}`)
      if (communicationFacts!.latestInboundAt) knownFacts.push(`企小码最近客户回复时间${communicationFacts!.latestInboundAt}`)
      if (communicationFacts!.hasTwoWayCommunication) knownFacts.push('企小码存在双向沟通证据')
      if (Number(chat.conflicted) === 1 || unique(chatCauses).length > 1) pendingVerification.push('企小码沟通信号存在否定语境或多原因冲突')
      else if (chatCauses.length === 1) reasonableJudgments.push(`企小码结构化信号提示可能存在“${CAUSE_LABELS[chatCauses[0]] || '原因未知'}”，需人工核验原始证据`)
      if (String(chat.service_center) !== String(authority.service_center)) pendingVerification.push('企小码与绿仔服务中心归属不一致')
    } else pendingVerification.push('缺少企小码沟通证据')
    const candidateCauses = unique([...manualCauses, ...(Number(chat?.conflicted) ? [] : chatCauses)]) as ArrearsCause[]
    const hasCauseConflict = Number(chat?.conflicted) === 1 || candidateCauses.length > 1
    const primaryCause: ArrearsCause = !hasCauseConflict && candidateCauses.length === 1 ? candidateCauses[0] : 'unknown'
    const causeEvidence = hasCauseConflict ? 'conflicted' as const : manualCauses.length && chatCauses.length ? 'wecom_and_qxm' as const : manualCauses.length ? 'wecom' as const : chatCauses.length ? 'qxm' as const : 'none' as const
    if (candidateCauses.includes('legal_dispute') || candidateCauses.includes('service_dispute') || candidateCauses.includes('charge_dispute')) {
      recommendationCodes.push('specialist_review_before_collection'); recommendationLabels.push('先由法务、品质或收费专业人员核验争议，再确定催缴方式')
    }
    if (candidateCauses.includes('promised_payment') || manual?.progress === 'reported_paid_pending_lvzai') {
      recommendationCodes.push('verify_lvzai_payment_status'); recommendationLabels.push('按绿仔状态复核到账，不以人工报告替代权威缴费状态')
    }
    if (candidateCauses.includes('contact_barrier')) { recommendationCodes.push('verify_contact_channel'); recommendationLabels.push('核验合规联系方式和责任人，不使用未经授权的身份信息') }
    if (candidateCauses.includes('vacancy') || candidateCauses.includes('financial_hardship') || candidateCauses.includes('ownership_or_handover')) { recommendationCodes.push('verify_policy_eligibility'); recommendationLabels.push('核验减免、分期或交付政策适用条件，不预先承诺结果') }
    if (!recommendationCodes.length) { recommendationCodes.push('collect_missing_evidence'); recommendationLabels.push('补充可验证的历史记录或自动沟通证据后再判断欠费原因') }
    const priority = pendingVerification.some(item => item.includes('仍显示欠费') || item.includes('归属不一致') || item.includes('信号存在')) ? 'priority_review' as const : 'standard_followup' as const
    if (priority === 'priority_review') reasonableJudgments.push('当前存在状态、归属或信号冲突，建议优先人工复核；该优先级不是欠费原因结论')
    const evidenceRefs = unique([...split(authority.evidence).map(hash => `LZ-${hash.slice(0, 12)}`), ...split(manual?.evidence).map(hash => `WX-${hash.slice(0, 12)}`), ...split(chat?.evidence).map(hash => `QX-${hash.slice(0, 12)}`)])
    return { actionKey: crypto.createHash('sha256').update(JSON.stringify({ houseHash, lvzaiRunId: lvzaiRun.id, wecomRunId: wecomRun?.id || null, qxmRunId: qxmRun?.id || null })).digest('hex'), houseHash, houseMasked: String(authority.house_masked), serviceCenter: String(authority.service_center), authoritativeArrearsAmount: amount, lvzaiBusinessDate: String(lvzaiRun.business_date), periodStart: authority.period_start ? String(authority.period_start) : null, periodEnd: authority.period_end ? String(authority.period_end) : null, ageingMonths: ageingMonths(authority.period_start, String(lvzaiRun.business_date)), primaryCause, causeEvidence, evidenceRefs, knownFacts: unique(knownFacts), reasonableJudgments: unique(reasonableJudgments), pendingVerification: unique(pendingVerification), priority, recommendationCodes: unique(recommendationCodes), recommendationLabels: unique(recommendationLabels), communicationFacts }
  })
  rows.sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'priority_review' ? -1 : 1) || b.authoritativeArrearsAmount - a.authoritativeArrearsAmount || a.houseHash.localeCompare(b.houseHash))
  const limit = Math.max(1, Math.min(5_000, Math.trunc(options.limit || 100))), offset = Math.max(0, Math.trunc(options.offset || 0))
  return { ready: true, businessDate: String(lvzaiRun.business_date), total: rows.length, rows: rows.slice(offset, offset + limit), truncated: rows.length > offset + limit }
}
