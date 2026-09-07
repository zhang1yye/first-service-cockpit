export type SourceCapabilityInput = {
  aph: {
    paymentCenterCount: number
    verifiedDailyCenterCount: number
    coverageComplete: boolean
    businessDate: string | null
    lastValidatedAt: string | null
    qualityStatus: string
    sourceStatus: string
    stale: boolean
  }
  lvzai: {
    scopedCenterCount: number
    publicationStatus: string
    businessDate: string | null
    lastValidatedAt: string | null
    sourceStatus: string
    stale: boolean
  }
  projectDirectory: {
    ready: boolean
    projectCount: number
  }
}

export type CapabilityStatus = 'ready' | 'partial' | 'unavailable'
export type SourceGateStatus = CapabilityStatus | 'stale' | 'invalid' | 'unpublished'

const APH_METRICS = [
  ['annualBudget', '年度回款预算'],
  ['cumulativeBudget', '累计回款预算'],
  ['cumulativeExecuted', '累计回款执行'],
  ['samePeriod', '同期回款执行'],
  ['dailyCollection', '本日回款'],
] as const

const LVZAI_METRICS = [
  ['collectionReceivable', '应收金额'],
  ['collectionReceived', '实收金额'],
  ['officialCollectionRate', '官方收缴率'],
] as const

const OUT_OF_SCOPE_PROJECT_METRICS = [
  ['projectAnnualIncome', '项目年度收入'],
  ['projectAnnualCost', '项目年度成本'],
  ['projectYtdIncome', '项目累计收入'],
  ['projectYtdCost', '项目累计成本'],
  ['projectProfitRate', '项目利润率'],
  ['projectQualityScore', '项目品质评分'],
  ['projectSafetyIncidents', '项目安全事故'],
  ['projectSatisfaction', '项目客户满意度'],
  ['projectComplaintCount', '项目投诉数'],
] as const

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

/**
 * 生成前端可消费的数据能力清单。能力状态只由正式来源与验证状态决定，
 * 不允许用项目目录、服务中心汇总或默认值替代缺失的项目经营事实。
 */
export function buildOperatingCapabilities(input: SourceCapabilityInput) {
  const paymentCenterCount = nonNegativeInteger(input.aph.paymentCenterCount)
  const verifiedDailyCenterCount = nonNegativeInteger(input.aph.verifiedDailyCenterCount)
  const lvzaiCenterCount = nonNegativeInteger(input.lvzai.scopedCenterCount)
  const projectCount = nonNegativeInteger(input.projectDirectory.projectCount)

  const aphStatus: SourceGateStatus = paymentCenterCount === 0
    ? 'unavailable'
    : input.aph.stale || input.aph.sourceStatus === 'stale'
      ? 'stale'
      : input.aph.qualityStatus !== 'verified' || input.aph.sourceStatus !== 'available' || !input.aph.businessDate
        ? 'invalid'
        : verifiedDailyCenterCount > 0
          && verifiedDailyCenterCount === paymentCenterCount
          && input.aph.coverageComplete ? 'ready' : 'partial'
  const lvzaiStatus: SourceGateStatus = lvzaiCenterCount === 0
    ? 'unavailable'
    : input.lvzai.stale || input.lvzai.sourceStatus === 'stale'
      ? 'stale'
      : input.lvzai.publicationStatus !== 'published'
        ? 'unpublished'
        : input.lvzai.sourceStatus !== 'available' ? 'invalid' : 'ready'
  const overallStatus: CapabilityStatus = aphStatus === 'ready' && lvzaiStatus === 'ready'
    ? 'ready'
    : aphStatus === 'unavailable' && lvzaiStatus === 'unavailable' ? 'unavailable' : 'partial'

  const supportedMetrics = [
    ...APH_METRICS.map(([key, label]) => ({
      key, label, grain: 'service-center', source: 'APH',
      status: aphStatus, available: aphStatus === 'ready',
    })),
    ...LVZAI_METRICS.map(([key, label]) => ({
      key, label, grain: 'service-center', source: '绿仔',
      status: lvzaiStatus, available: lvzaiStatus === 'ready',
    })),
  ]

  return {
    schemaVersion: 1,
    operatingModel: 'aph-lvzai-service-center',
    status: overallStatus,
    supportedGrains: ['region', 'area', 'service-center'],
    sources: {
      aph: {
        status: aphStatus,
        paymentCenterCount,
        verifiedDailyCenterCount,
        coverageComplete: input.aph.coverageComplete,
        businessDate: input.aph.businessDate,
        lastValidatedAt: input.aph.lastValidatedAt,
        rule: '只使用APH回款预算、累计执行、同期执行和已验证每日回款字段',
      },
      lvzai: {
        status: lvzaiStatus,
        publicationStatus: input.lvzai.publicationStatus,
        centerCount: lvzaiCenterCount,
        businessDate: input.lvzai.businessDate,
        lastValidatedAt: input.lvzai.lastValidatedAt,
        rule: '只使用已发布正式数据集的官方收缴率，不用实收除以应收替代官方口径',
      },
      projectDirectory: {
        status: input.projectDirectory.ready ? 'ready' : 'unavailable',
        projectCount,
        operatingFactsAvailable: false,
        rule: '项目目录只用于名称、片区和服务中心归属，不生成项目经营结论',
      },
    },
    supportedMetrics,
    excludedMetrics: OUT_OF_SCOPE_PROJECT_METRICS.map(([key, label]) => ({
      key,
      label,
      grain: 'project',
      status: 'not-connected' as const,
      reason: '当前系统范围不接入项目级经营指标',
    })),
    presentationPolicy: {
      showServiceCenterOperations: overallStatus !== 'unavailable',
      showProjectDirectory: input.projectDirectory.ready,
      showProjectOperatingMetrics: false,
      projectOperatingMetricsPolicy: 'not-connected',
      missingValue: null,
      missingValueLabel: '暂无权威来源',
      excludedValueLabel: '当前系统不接入',
    },
  }
}
