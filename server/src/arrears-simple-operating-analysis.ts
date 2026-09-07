import type Database from 'better-sqlite3'
import { readArrearsHouseholdActions, type ArrearsHouseholdAction } from './arrears-household-actions.js'
import type { ArrearsCause } from './arrears-analysis.js'

const CAUSE_LABELS: Record<ArrearsCause, string> = {
  service_dispute: '服务争议', charge_dispute: '收费争议', vacancy: '房屋空置', financial_hardship: '支付困难',
  ownership_or_handover: '产权或交付问题', contact_barrier: '联系障碍', promised_payment: '承诺缴费', legal_dispute: '法律争议', unknown: '原因待核实',
}
const EVIDENCE_LABELS = { wecom_and_qxm: '台账与沟通相互印证', wecom: '企业微信台账记录', qxm: '企小码沟通信号', conflicted: '证据冲突，待核实', none: '缺少原因证据' } as const
const ACTIONS: Record<string, { issue: string; suggestion: string; action: string; completion: string }> = {
  specialist_review_before_collection: { issue: '争议类欠费', suggestion: '先核实争议，再确定催缴方式', action: '汇总争议房间，由品质、收费或法务人员逐户形成处理结论', completion: '每户形成争议事项、责任角色和处理结果' },
  verify_lvzai_payment_status: { issue: '到账状态待核对', suggestion: '以绿仔状态完成到账闭环', action: '核对承诺缴费或人工报已缴房间的到账流水，并在源系统修正状态', completion: '绿仔缴费状态与核对结果一致' },
  verify_contact_channel: { issue: '联系障碍', suggestion: '先核验合规联系方式和跟进责任', action: '核验可用联系渠道，重新发起联系并记录结果', completion: '形成有效联系、明确拒绝或渠道失效结论' },
  verify_policy_eligibility: { issue: '政策适用待核实', suggestion: '核验分期、减免或交付政策条件', action: '按房间核对适用条件，不提前承诺处理结果', completion: '每户形成适用或不适用结论' },
  collect_missing_evidence: { issue: '欠费原因不清', suggestion: '先补齐可验证原因和沟通记录', action: '联系原因待核实房间并更新企业微信台账；可关联时补充企小码沟通证据', completion: '原因明确金额占比提升，新增记录可追溯' },
}

function rounded(value: number): number { return Math.round((value + Number.EPSILON) * 100) / 100 }
function ratio(value: number, total: number): number { return total > 0 ? Math.round(value / total * 10_000) / 10_000 : 0 }
function roomLabel(value: string): string { return value || '房间号待补齐' }

export function readArrearsSimpleOperatingAnalysis(database: Database.Database, options: { serviceCenters?: string[] } = {}) {
  const result = readArrearsHouseholdActions(database, { serviceCenters: options.serviceCenters, limit: 5_000, offset: 0 })
  if (!result.ready) return { ready: false, reason: 'lvzai_batch_missing', businessDate: null, serviceCenters: [], selectedScope: options.serviceCenters || [], summary: null, ageingBuckets: [], causes: [], actions: [], households: [], truncated: false }
  if (result.truncated) return { ready: false, reason: 'scope_exceeds_safe_limit', businessDate: result.businessDate, serviceCenters: [], selectedScope: options.serviceCenters || [], summary: null, ageingBuckets: [], causes: [], actions: [], households: [], truncated: true }
  const rows = result.rows
  const totalAmount = rounded(rows.reduce((sum, row) => sum + row.authoritativeArrearsAmount, 0))
  const earliestPeriod = rows.map(row => row.periodStart || '').filter(Boolean).sort()[0] || null
  const knownCauseRows = rows.filter(row => row.primaryCause !== 'unknown')
  const knownCauseAmount = rounded(knownCauseRows.reduce((sum, row) => sum + row.authoritativeArrearsAmount, 0))
  const serviceCenters = [...new Set(rows.map(row => row.serviceCenter).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'))

  const ageingDefinitions = [
    { key: 'within_3', label: '3个月以内', test: (months: number) => months <= 3 },
    { key: 'months_4_6', label: '4—6个月', test: (months: number) => months >= 4 && months <= 6 },
    { key: 'months_7_12', label: '7—12个月', test: (months: number) => months >= 7 && months <= 12 },
    { key: 'over_12', label: '12个月以上', test: (months: number) => months > 12 },
    { key: 'unknown', label: '账期待核实', test: (_months: number) => false },
  ]
  const ageingBuckets = ageingDefinitions.map(definition => {
    const matched = rows.filter(row => row.ageingMonths === null ? definition.key === 'unknown' : definition.test(row.ageingMonths))
    const amount = rounded(matched.reduce((sum, row) => sum + row.authoritativeArrearsAmount, 0))
    return { key: definition.key, label: definition.label, householdCount: matched.length, amount, amountShare: ratio(amount, totalAmount) }
  })

  const causes = Object.keys(CAUSE_LABELS).map(category => {
    const matched = rows.filter(row => row.primaryCause === category)
    const amount = rounded(matched.reduce((sum, row) => sum + row.authoritativeArrearsAmount, 0))
    const evidenceCounts = new Map<string, number>()
    for (const row of matched) evidenceCounts.set(row.causeEvidence, (evidenceCounts.get(row.causeEvidence) || 0) + 1)
    const evidence = [...evidenceCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] as keyof typeof EVIDENCE_LABELS | undefined
    return { category, label: CAUSE_LABELS[category as ArrearsCause], householdCount: matched.length, amount, amountShare: ratio(amount, totalAmount), evidenceLabel: EVIDENCE_LABELS[evidence || 'none'] }
  }).filter(item => item.householdCount > 0).sort((a, b) => b.amount - a.amount || b.householdCount - a.householdCount)

  const actionMap = new Map<string, { householdCount: number; amount: number; rooms: string[] }>()
  for (const row of rows) for (const code of row.recommendationCodes) {
    const item = actionMap.get(code) || { householdCount: 0, amount: 0, rooms: [] }
    item.householdCount += 1; item.amount += row.authoritativeArrearsAmount; item.rooms.push(roomLabel(row.houseMasked)); actionMap.set(code, item)
  }
  const actions = [...actionMap.entries()].map(([code, aggregate]) => ({ code, ...(ACTIONS[code] || ACTIONS.collect_missing_evidence), priority: code === 'specialist_review_before_collection' || code === 'verify_lvzai_payment_status' ? 'high' : 'standard', householdCount: aggregate.householdCount, amount: rounded(aggregate.amount), rooms: [...new Set(aggregate.rooms)].sort((a, b) => a.localeCompare(b, 'zh-CN')) })).sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'high' ? -1 : 1) || b.amount - a.amount).slice(0, 5)

  const households = [...rows].sort((a, b) => b.authoritativeArrearsAmount - a.authoritativeArrearsAmount || a.houseHash.localeCompare(b.houseHash)).map((row: ArrearsHouseholdAction) => ({
    room: roomLabel(row.houseMasked), serviceCenter: row.serviceCenter, amount: rounded(row.authoritativeArrearsAmount), periodStart: row.periodStart, periodEnd: row.periodEnd, ageingMonths: row.ageingMonths, cause: CAUSE_LABELS[row.primaryCause], evidence: EVIDENCE_LABELS[row.causeEvidence], action: row.recommendationLabels[0] || ACTIONS.collect_missing_evidence.suggestion,
  }))

  return { ready: true, businessDate: result.businessDate, serviceCenters, selectedScope: options.serviceCenters || [], summary: { totalAmount, householdCount: rows.length, earliestPeriod, knownCauseAmount, knownCauseAmountShare: ratio(knownCauseAmount, totalAmount) }, ageingBuckets, causes, actions, households, truncated: result.truncated }
}
