export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface MappingLink {
  profileId: number
  sourceSystem: string
  sourceCenter: string
  profileName?: string
}

export interface AdminQualityInput {
  projectCount: number
  demoProjectCount: number
  demoImportCount: number
  quarantinedRecordCount?: number
  samePeriodZeroCount: number
  activeSamePeriodZeroCount: number
  copiedSnapshotProjectCount: number
  paymentAnnualTotal: number | null
  aphAnnualBudget: number | null
  aphBudgetWeeklyAnnual: number | null
  detailSamePeriodTotal: number | null
  aphSamePeriod: number | null
  collectionDbRows: number
  collectionSourceRows: number | null
  collectionDbRate: number | null
  collectionOfficialRate: number | null
  links: MappingLink[]
}

export interface QualityIssue {
  code: string
  severity: Severity
  category: string
  title: string
  detail: string
  evidence: Record<string, unknown>
  recommendation: string
  status: 'open' | 'monitor'
}

export function normalizeCenterKey(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\s·•・()（）]/g, '')
    .trim()
}

export function mappingCollisions(links: MappingLink[]) {
  const grouped = new Map<string, MappingLink[]>()
  for (const link of links) {
    const key = `${link.sourceSystem}:${normalizeCenterKey(link.sourceCenter)}`
    const rows = grouped.get(key) || []
    rows.push(link)
    grouped.set(key, rows)
  }
  return [...grouped.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({
      key,
      sourceSystem: rows[0]?.sourceSystem || '',
      normalizedCenter: key.split(':').slice(1).join(':'),
      profileIds: [...new Set(rows.map(row => row.profileId))],
      conflictType: new Set(rows.map(row => row.profileId)).size > 1 ? 'multiple_profiles' : 'duplicate_aliases',
      rows,
    }))
}

// 宽松规则只生成“疑似别名”候选，绝不用于绑定、隔离或经营金额聚合。
export function mappingAliasCandidates(links: MappingLink[]) {
  const loose = (value: string) => normalizeCenterKey(value)
    .replace(/^第一(?:服务|物业|酒店)/, '')
    .replace(/(?:服务|体验)中心$/, '')
  const grouped = new Map<string, MappingLink[]>()
  for (const link of links) {
    const key = `${link.sourceSystem}:${loose(link.sourceCenter)}`
    grouped.set(key, [...(grouped.get(key) || []), link])
  }
  return [...grouped.entries()]
    .filter(([, rows]) => rows.length > 1 && new Set(rows.map(row => normalizeCenterKey(row.sourceCenter))).size > 1)
    .map(([key, rows]) => ({ key, sourceSystem: rows[0]?.sourceSystem || '', candidateKey: key.split(':').slice(1).join(':'), rows }))
}

function delta(a: number | null, b: number | null) {
  return a === null || b === null ? null : Math.round((a - b) * 100) / 100
}

export function buildAdminQualityReport(input: AdminQualityInput) {
  const issues: QualityIssue[] = []
  const collisions = mappingCollisions(input.links)
  const aliasCandidates = mappingAliasCandidates(input.links)
  const add = (issue: QualityIssue) => issues.push(issue)

  if (input.demoProjectCount > 0) add({
    code: 'DEMO_PROJECT_CHAIN', severity: 'critical', category: '演示数据', title: '生产库存在演示项目链',
    detail: `检测到${input.demoImportCount}次演示数据导入记录；当前活动项目中有${input.demoProjectCount}条命中明确演示指纹。`,
    evidence: { demoImportCount: input.demoImportCount, projectCount: input.projectCount, demoProjectCount: input.demoProjectCount },
    recommendation: '生产环境禁用演示数据入口，隔离演示项目及其衍生快照、预测和归档。', status: 'open',
  })
  if (input.activeSamePeriodZeroCount > 0) add({
    code: 'SAME_PERIOD_ZERO_REVIEW', severity: 'high', category: '空值语义', title: '在管项目同期0需要业务分类',
    detail: `${input.samePeriodZeroCount}条明细同期为来源值0，其中${input.activeSamePeriodZeroCount}条属于非撤场项目；在业务确认前不得视作缺失，也不得形成同比。`,
    evidence: { samePeriodZeroCount: input.samePeriodZeroCount, activeSamePeriodZeroCount: input.activeSamePeriodZeroCount },
    recommendation: '逐中心分类为真实0、去年未经营、范围变化或源端缺失；源为空时存储null并显示“—”。', status: 'open',
  })
  if (input.copiedSnapshotProjectCount > 0) add({
    code: 'COPIED_MONTHLY_SNAPSHOTS', severity: 'critical', category: '历史快照', title: '跨月经营快照完全相同',
    detail: `${input.copiedSnapshotProjectCount}个项目连续月份的经营指标完全一致，无法作为真实趋势使用。`,
    evidence: { copiedSnapshotProjectCount: input.copiedSnapshotProjectCount },
    recommendation: '冻结相关趋势、预测和月报；按业务日期重新导入真实历史快照。', status: 'open',
  })
  if (input.aphAnnualBudget === null) add({
    code: 'APH_SOURCE_UNAVAILABLE', severity: 'high', category: '数据源', title: 'APH汇总源不可用',
    detail: '无法取得APH华北汇总卡片，相关指标不得回退为0或估算值。', evidence: { aphAnnualBudget: null },
    recommendation: '保留上一份已校验快照，并显式显示数据源不可用和业务日期。', status: 'open',
  })
  const annualGap = delta(input.paymentAnnualTotal, input.aphAnnualBudget)
  const weeklyGap = delta(input.aphBudgetWeeklyAnnual, input.aphAnnualBudget)
  if ((annualGap !== null && Math.abs(annualGap) > 1) || (weeklyGap !== null && Math.abs(weeklyGap) > 1)) add({
    code: 'APH_ANNUAL_BUDGET_SCOPE_GAP', severity: 'high', category: '口径勾稽', title: 'APH年度预算三套来源口径不一致',
    detail: `华北卡片、预算周报和中心明细保持独立，当前卡片与周报相差${weeklyGap === null ? '—' : weeklyGap.toFixed(2)}万元、卡片与中心明细相差${annualGap === null ? '—' : annualGap.toFixed(2)}万元。`,
    evidence: { regionCardAnnualBudget: input.aphAnnualBudget, budgetWeeklyAnnualBudget: input.aphBudgetWeeklyAnnual, centerDetailAnnualBudget: input.paymentAnnualTotal, cardVsWeeklyGap: weeklyGap, cardVsCenterGap: annualGap },
    recommendation: '核对撤场项目、地区公司和中心范围，形成版本化排除清单。', status: 'open',
  })
  const sameGap = delta(input.aphSamePeriod, input.detailSamePeriodTotal)
  if (sameGap !== null && Math.abs(sameGap) > 1) add({
    code: 'SAME_PERIOD_RECONCILIATION_GAP', severity: 'high', category: '口径勾稽', title: '同期汇总与中心明细不一致',
    detail: `APH汇总与中心明细相差${sameGap.toFixed(2)}万元。`, evidence: { detailSamePeriodTotal: input.detailSamePeriodTotal, aphSamePeriod: input.aphSamePeriod, gap: sameGap },
    recommendation: '逐项目输出差异并回到FineReport卡片/钻取明细核对。', status: 'open',
  })
  const collectionGap = input.collectionDbRate === null || input.collectionOfficialRate === null ? null : Math.round((input.collectionOfficialRate - input.collectionDbRate) * 10000) / 100
  if ((input.collectionSourceRows !== null && input.collectionDbRows !== input.collectionSourceRows) || (collectionGap !== null && Math.abs(collectionGap) > 0.5)) add({
    code: 'COLLECTION_FALLBACK_SCOPE', severity: 'critical', category: '收缴口径', title: '绿仔官方范围与混合表不一致',
    detail: `官方源${input.collectionSourceRows ?? '—'}条、混合表${input.collectionDbRows}条，收缴率相差${collectionGap === null ? '—' : `${collectionGap.toFixed(2)}个百分点`}。`,
    evidence: { collectionDbRows: input.collectionDbRows, collectionSourceRows: input.collectionSourceRows, collectionDbRate: input.collectionDbRate, collectionOfficialRate: input.collectionOfficialRate, gapPercentagePoints: collectionGap },
    recommendation: '主源失败时禁止静默回退混合表；保留上一份已验证官方快照并标注降级。', status: 'open',
  })
  if (collisions.length > 0) add({
    code: 'PROJECT_MAPPING_COLLISION', severity: 'high', category: '项目映射', title: '同一源项目映射到多个项目档案',
    detail: `检测到${collisions.length}组归一化名称碰撞，可能造成金额重复计算。`, evidence: { collisions },
    recommendation: '为源中心建立唯一映射约束；冲突未解除前排除对应金额。', status: 'open',
  })
  if (aliasCandidates.length > 0) add({
    code: 'PROJECT_MAPPING_ALIAS_CANDIDATE', severity: 'medium', category: '项目映射', title: '服务中心与体验中心疑似别名待确认',
    detail: `检测到${aliasCandidates.length}组宽松名称候选；候选不会自动合并，也不会改变金额聚合。`, evidence: { aliasCandidates },
    recommendation: '由业务确认是否同一经营范围；确认前保持独立源中心和独立档案。', status: 'monitor',
  })

  const severityOrder: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.code.localeCompare(b.code))
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      total: issues.length,
      critical: issues.filter(issue => issue.severity === 'critical').length,
      high: issues.filter(issue => issue.severity === 'high').length,
      medium: issues.filter(issue => issue.severity === 'medium').length,
      low: issues.filter(issue => issue.severity === 'low').length,
    },
    facts: {
      projectCount: input.projectCount,
      demoImportCount: input.demoImportCount,
      quarantinedRecordCount: input.quarantinedRecordCount ?? 0,
      paymentAnnualTotal: input.paymentAnnualTotal,
      aphAnnualBudget: input.aphAnnualBudget,
      aphBudgetWeeklyAnnual: input.aphBudgetWeeklyAnnual,
      detailSamePeriodTotal: input.detailSamePeriodTotal,
      aphSamePeriod: input.aphSamePeriod,
      collectionDbRate: input.collectionDbRate,
      collectionOfficialRate: input.collectionOfficialRate,
    },
    collisions,
    aliasCandidates,
    issues,
  }
}
