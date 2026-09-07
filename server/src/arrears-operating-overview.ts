export type ArrearsProjectRow = {
  id: number
  area: string
  service_center: string
  management_status: string
}

export type ArrearsBatchRow = {
  id: number
  project_id: number
  project_name: string
  business_date: string
  status: string
  archive_delete_state?: string
  archive_deleted_at?: string
}

export type ArrearsLedgerRow = {
  batch_id: number
  resource_hash: string
  arrears_amount: number | null
  fee_item: string
  ageing_days: number | null
}

export type ArrearsCommunicationRow = {
  batch_id: number
  resource_hash: string
}

export type ArrearsResultRow = {
  batch_id: number
  resource_hash: string
  human_status: string
  human_category: string
  analysis_status: string
  ai_category: string
  rule_category: string
}

export type ArrearsBreakdown = {
  key: string
  label: string
  resourceCount: number
  amount: number | null
}

export type ArrearsCauseBreakdown = {
  cause: string
  resourceCount: number
  amount: number | null
}

export type ArrearsOperatingOverview = {
  ready: boolean
  effectiveBatchCount: number
  revokedBatchCount: number
  projectCount: number
  resourceCount: number
  totalAmount: number | null
  amountCompletenessRate: number | null
  longAgeingAmount: number | null
  missingCommunicationResourceCount: number
  confirmedReviewCount: number
  pendingReviewCount: number
  rejectedReviewCount: number
  latestBusinessDate: string | null
  projectBreakdown: ArrearsBreakdown[]
  areaBreakdown: ArrearsBreakdown[]
  ageingBreakdown: ArrearsBreakdown[]
  feeBreakdown: ArrearsBreakdown[]
  causeBreakdown: ArrearsCauseBreakdown[]
}

type Input = {
  projects: ArrearsProjectRow[]
  batches: ArrearsBatchRow[]
  ledgerRows: ArrearsLedgerRow[]
  communicationRows: ArrearsCommunicationRow[]
  results: ArrearsResultRow[]
  canAccessProject: (project: ArrearsProjectRow) => boolean
}

const EFFECTIVE_STATUSES = new Set(['parsed', 'analyzing', 'analyzed', 'rule_only'])
const AGEING_BUCKETS = [
  { key: '0-90', label: '0—90天', match: (days: number) => days <= 90 },
  { key: '91-180', label: '91—180天', match: (days: number) => days >= 91 && days <= 180 },
  { key: '181-365', label: '181—365天', match: (days: number) => days >= 181 && days <= 365 },
  { key: '366-730', label: '366—730天', match: (days: number) => days >= 366 && days <= 730 },
  { key: '731+', label: '730天以上', match: (days: number) => days >= 731 },
]

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function amountOrNull(values: Array<number | null>): number | null {
  const valid = values.filter(finite)
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) : null
}

function groupBreakdown(
  rows: ArrearsLedgerRow[],
  keyFor: (row: ArrearsLedgerRow) => { key: string; label: string },
): ArrearsBreakdown[] {
  const groups = new Map<string, { label: string; resources: Set<string>; amounts: Array<number | null> }>()
  for (const row of rows) {
    const item = keyFor(row)
    const group = groups.get(item.key) || { label: item.label, resources: new Set<string>(), amounts: [] }
    group.resources.add(`${row.batch_id}:${row.resource_hash}`)
    group.amounts.push(row.arrears_amount)
    groups.set(item.key, group)
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    label: group.label,
    resourceCount: group.resources.size,
    amount: amountOrNull(group.amounts),
  })).sort((a, b) => (b.amount ?? Number.NEGATIVE_INFINITY) - (a.amount ?? Number.NEGATIVE_INFINITY) || a.label.localeCompare(b.label, 'zh-CN'))
}

function finalCause(row: ArrearsResultRow): string {
  // 经营汇总只把人工确认原因当作事实；AI/规则输出只是待复核线索。
  if (row.human_status === 'confirmed' && row.human_category) return row.human_category
  return 'unknown'
}

export function selectEffectiveArrearsBatches(input: Pick<Input, 'projects' | 'batches' | 'canAccessProject'>): {
  accessibleProjects: Map<number, ArrearsProjectRow>
  scopedBatches: ArrearsBatchRow[]
  effectiveBatches: ArrearsBatchRow[]
} {
  const accessibleProjects = new Map(input.projects
    .filter(project => project.management_status === '在管' && input.canAccessProject(project))
    .map(project => [project.id, project]))
  const scopedBatches = input.batches.filter(batch => accessibleProjects.has(batch.project_id))
  const latestByProject = new Map<number, ArrearsBatchRow>()
  for (const batch of scopedBatches.filter(batch => EFFECTIVE_STATUSES.has(batch.status) && (batch.archive_delete_state === undefined || batch.archive_delete_state === 'active') && !batch.archive_deleted_at)) {
    const previous = latestByProject.get(batch.project_id)
    if (!previous || batch.business_date > previous.business_date || (batch.business_date === previous.business_date && batch.id > previous.id)) latestByProject.set(batch.project_id, batch)
  }
  return { accessibleProjects, scopedBatches, effectiveBatches: [...latestByProject.values()] }
}

export function buildArrearsOperatingOverview(input: Input): ArrearsOperatingOverview {
  const { accessibleProjects, scopedBatches, effectiveBatches } = selectEffectiveArrearsBatches(input)
  const activeIds = new Set(effectiveBatches.map(batch => batch.id))
  const activeLedger = input.ledgerRows.filter(row => activeIds.has(row.batch_id))
  const activeResults = input.results.filter(row => activeIds.has(row.batch_id))
  const resourceKeys = new Set(activeLedger.map(row => `${row.batch_id}:${row.resource_hash}`))
  const communicated = new Set(input.communicationRows
    .filter(row => activeIds.has(row.batch_id))
    .map(row => `${row.batch_id}:${row.resource_hash}`))
  const confirmed = new Set(activeResults
    .filter(row => row.human_status === 'confirmed')
    .map(row => `${row.batch_id}:${row.resource_hash}`))
  const pending = new Set(activeResults.filter(row=>row.human_status==='pending').map(row=>`${row.batch_id}:${row.resource_hash}`))
  const rejected = new Set(activeResults.filter(row=>row.human_status==='rejected').map(row=>`${row.batch_id}:${row.resource_hash}`))
  const amountValues = activeLedger.map(row => row.arrears_amount)
  const amountCount = amountValues.filter(finite).length
  const ageingRows = activeLedger.filter(row => row.ageing_days !== null && finite(row.arrears_amount))
  const longAgeingAmount = ageingRows.length
    ? ageingRows.filter(row => Number(row.ageing_days) >= 366).reduce((sum, row) => sum + Number(row.arrears_amount), 0)
    : null
  const batchById = new Map(effectiveBatches.map(batch => [batch.id, batch]))
  const projectBreakdown = groupBreakdown(activeLedger, row => {
    const batch = batchById.get(row.batch_id)!
    const project = accessibleProjects.get(batch.project_id)!
    return { key: String(project.id), label: project.service_center || batch.project_name }
  })
  const areaBreakdown = groupBreakdown(activeLedger, row => {
    const batch = batchById.get(row.batch_id)!
    const project = accessibleProjects.get(batch.project_id)!
    return { key: project.area || '未分片区', label: project.area || '未分片区' }
  })
  const ageingBreakdown = groupBreakdown(activeLedger, row => {
    if (row.ageing_days === null) return { key: 'unknown', label: '账龄未知' }
    const bucket = AGEING_BUCKETS.find(item => item.match(Number(row.ageing_days)))
    return bucket ? { key: bucket.key, label: bucket.label } : { key: 'unknown', label: '账龄未知' }
  })
  const feeBreakdown = groupBreakdown(activeLedger, row => ({ key: row.fee_item || 'unknown', label: row.fee_item || '费项未知' }))
  const amountByResource = new Map<string, Array<number | null>>()
  for (const row of activeLedger) {
    const key = `${row.batch_id}:${row.resource_hash}`
    const values = amountByResource.get(key) || []
    values.push(row.arrears_amount)
    amountByResource.set(key, values)
  }
  const causeGroups = new Map<string, { resources: Set<string>; amounts: Array<number | null> }>()
  for (const row of activeResults) {
    const key = `${row.batch_id}:${row.resource_hash}`
    if (!resourceKeys.has(key)) continue
    const cause = finalCause(row)
    const group = causeGroups.get(cause) || { resources: new Set<string>(), amounts: [] }
    if (!group.resources.has(key)) {
      group.resources.add(key)
      group.amounts.push(amountOrNull(amountByResource.get(key) || []))
    }
    causeGroups.set(cause, group)
  }
  const causeBreakdown = [...causeGroups.entries()].map(([cause, group]) => ({
    cause,
    resourceCount: group.resources.size,
    amount: amountOrNull(group.amounts),
  })).sort((a, b) => b.resourceCount - a.resourceCount || a.cause.localeCompare(b.cause, 'en'))

  return {
    ready: effectiveBatches.length > 0,
    effectiveBatchCount: effectiveBatches.length,
    revokedBatchCount: scopedBatches.filter(batch => batch.status === 'revoked').length,
    projectCount: new Set(effectiveBatches.map(batch => batch.project_id)).size,
    resourceCount: resourceKeys.size,
    totalAmount: amountOrNull(amountValues),
    amountCompletenessRate: activeLedger.length ? amountCount / activeLedger.length : null,
    longAgeingAmount,
    missingCommunicationResourceCount: [...resourceKeys].filter(key => !communicated.has(key)).length,
    confirmedReviewCount: [...resourceKeys].filter(key => confirmed.has(key)).length,
    pendingReviewCount: [...resourceKeys].filter(key => pending.has(key)).length,
    rejectedReviewCount: [...resourceKeys].filter(key => rejected.has(key)).length,
    latestBusinessDate: effectiveBatches.length ? effectiveBatches.map(batch => batch.business_date).sort().at(-1)! : null,
    projectBreakdown,
    areaBreakdown,
    ageingBreakdown,
    feeBreakdown,
    causeBreakdown,
  }
}
