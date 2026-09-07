export const DEMO_PROJECT_NAMES = Object.freeze([
  '朝阳万国城MOMΛ',
  '朝阳当代MOMΛ',
  '通州万国城MOMΛ',
  '亦庄创意生活广场',
  '海淀西山上品湾MOMΛ',
  '上第MOMΛ',
  '顺义MOMΛ万万树',
  '石家庄当代府MOMΛ',
  '天津海河大观',
  '沈阳当代RIVER MOMΛ',
])

const DEMO_NAME_SET = new Set<string>(DEMO_PROJECT_NAMES)

export function demoProjectNames(rows: Array<{ name?: unknown }>): string[] {
  return rows.map(row => String(row?.name || '').trim()).filter(name => DEMO_NAME_SET.has(name))
}

export type ProjectDataGateInput = {
  projectNames: string[]
  copiedSnapshotProjectCount: number
  unverifiedProjectCount?: number
  directoryOnlyProjectCount?: number
  inactiveProjectCount?: number
  missingSourceBatchCount?: number
  incompleteVerifiedProjectCount?: number
}

export type ProjectDataGateResult = {
  ready: boolean
  status: 'ready' | 'blocked'
  projectCount: number
  demoProjectCount: number
  copiedSnapshotProjectCount: number
  unverifiedProjectCount: number
  directoryOnlyProjectCount: number
  inactiveProjectCount: number
  missingSourceBatchCount: number
  incompleteVerifiedProjectCount: number
  reasons: string[]
}

export const REQUIRED_OPERATING_NUMERIC_FIELDS = Object.freeze([
  'annual_income', 'annual_cost', 'ytd_income', 'ytd_cost',
  'receivable', 'received', 'quality_score', 'safety_incidents',
  'customer_satisfaction', 'complaint_count',
] as const)

export function missingOperatingNumericFields(row: any): string[] {
  return REQUIRED_OPERATING_NUMERIC_FIELDS.filter(field => {
    const value = row?.[field]
    return value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
  })
}

export function hasCompleteOperatingFacts(row: any): boolean {
  return row?.validation_status === 'verified' && missingOperatingNumericFields(row).length === 0
}

export function evaluateProjectDataGate(input: ProjectDataGateInput): ProjectDataGateResult {
  const projectNames = input.projectNames.map(name => String(name || '').trim()).filter(Boolean)
  const demoProjectCount = projectNames.filter(name => DEMO_NAME_SET.has(name)).length
  const copiedSnapshotProjectCount = Math.max(0, Number(input.copiedSnapshotProjectCount) || 0)
  const unverifiedProjectCount = Math.max(0, Number(input.unverifiedProjectCount) || 0)
  const directoryOnlyProjectCount = Math.max(0, Number(input.directoryOnlyProjectCount) || 0)
  const inactiveProjectCount = Math.max(0, Number(input.inactiveProjectCount) || 0)
  const missingSourceBatchCount = Math.max(0, Number(input.missingSourceBatchCount) || 0)
  const incompleteVerifiedProjectCount = Math.max(0, Number(input.incompleteVerifiedProjectCount) || 0)
  const reasons: string[] = []

  if (projectNames.length === 0) reasons.push('当前系统范围不接入项目经营事实')
  if (demoProjectCount > 0) reasons.push(`发现${demoProjectCount}个内置演示项目`)
  if (copiedSnapshotProjectCount > 0) reasons.push(`发现${copiedSnapshotProjectCount}个项目存在疑似复制月快照`)
  if (directoryOnlyProjectCount > 0) reasons.push(`已发布${directoryOnlyProjectCount}个权威项目目录；成本、利润率、品质、安全、满意度等项目经营指标当前不接入`)
  if (unverifiedProjectCount > 0) reasons.push(`发现${unverifiedProjectCount}个项目未通过来源验证`)
  if (inactiveProjectCount > 0) reasons.push(`发现${inactiveProjectCount}个非活动项目仍混入经营表`)
  if (missingSourceBatchCount > 0) reasons.push(`发现${missingSourceBatchCount}个项目缺少来源批次`)
  if (incompleteVerifiedProjectCount > 0) reasons.push(`发现${incompleteVerifiedProjectCount}个已标记验证的项目缺少经营结论必需数值`)

  return {
    ready: reasons.length === 0,
    status: reasons.length === 0 ? 'ready' : 'blocked',
    projectCount: projectNames.length,
    demoProjectCount,
    copiedSnapshotProjectCount,
    unverifiedProjectCount,
    directoryOnlyProjectCount,
    inactiveProjectCount,
    missingSourceBatchCount,
    incompleteVerifiedProjectCount,
    reasons,
  }
}

export function readProjectDataGate(db: any): ProjectDataGateResult {
  const projects = db.prepare(`SELECT name,validation_status,active_status,source_batch,
    annual_income,annual_cost,ytd_income,ytd_cost,receivable,received,quality_score,
    safety_incidents,customer_satisfaction,complaint_count
    FROM projects ORDER BY id`).all() as Array<{
    name: string
    validation_status: string
    active_status: string
    source_batch: string
    [key: string]: unknown
  }>
  let copiedSnapshotProjectCount = 0
  let snapshotGateCheckFailed = false
  try {
    copiedSnapshotProjectCount = Number((db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT project_name FROM project_monthly_snapshots
        GROUP BY project_name
        HAVING COUNT(DISTINCT month) >= 3
          AND COUNT(DISTINCT printf(
            '%.6f|%.6f|%.6f|%.6f|%.6f|%d|%.6f|%d',
            ytd_income, ytd_cost, receivable, received, quality_score,
            safety_incidents, customer_satisfaction, complaint_count
          )) = 1
      )
    `).get() as { count: number }).count || 0)
  } catch {
    snapshotGateCheckFailed = true
  }
  const gate = evaluateProjectDataGate({
    projectNames: projects.map(row => row.name),
    copiedSnapshotProjectCount,
    unverifiedProjectCount: projects.filter(row => !['verified', 'directory_only'].includes(row.validation_status)).length,
    directoryOnlyProjectCount: projects.filter(row => row.validation_status === 'directory_only').length,
    inactiveProjectCount: projects.filter(row => row.active_status !== 'active').length,
    missingSourceBatchCount: projects.filter(row => !String(row.source_batch || '').trim()).length,
    incompleteVerifiedProjectCount: projects.filter(row => row.validation_status === 'verified' && !hasCompleteOperatingFacts(row)).length,
  })
  if (!snapshotGateCheckFailed) return gate
  return {
    ...gate,
    ready: false,
    status: 'blocked',
    reasons: [...gate.reasons, '项目快照真实性门禁检测失败'],
  }
}

export function projectDataBlockedPayload(db: any) {
  const gate = readProjectDataGate(db)
  return {
    error: '项目经营数据尚未通过真实性门禁',
    code: 'PROJECT_DATA_QUALITY_BLOCKED',
    dataQuality: gate,
  }
}
