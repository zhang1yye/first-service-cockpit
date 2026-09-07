export type FormalMonthlyGateInput = {
  period: string
  expectedProjectCount: number
  snapshotCount: number
  invalidSnapshotCount: number
  snapshotRunStatus: string | null
  forecastCount: number
  unlockedForecastCount: number
}

export type FormalMonthlyGateResult = {
  ready: boolean
  status: 'ready' | 'blocked'
  reasons: string[]
}

const TRUSTED_RUN_STATUSES = new Set(['created', 'success', 'published'])

export function evaluateFormalMonthlyGate(input: FormalMonthlyGateInput): FormalMonthlyGateResult {
  const reasons: string[] = []
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(input.period || ''))) reasons.push('正式月报期间格式无效')
  if (input.expectedProjectCount <= 0) reasons.push('没有已验证活动项目')
  if (input.snapshotCount !== input.expectedProjectCount) reasons.push(`期间快照不完整：应有${input.expectedProjectCount}条，实际${input.snapshotCount}条`)
  if (input.invalidSnapshotCount > 0) reasons.push(`发现${input.invalidSnapshotCount}条快照来源未通过验证`)
  if (!input.snapshotRunStatus || !TRUSTED_RUN_STATUSES.has(input.snapshotRunStatus)) reasons.push('期间快照发布状态未通过验证')
  if (input.forecastCount !== input.expectedProjectCount) reasons.push(`期间预测不完整：应有${input.expectedProjectCount}条，实际${input.forecastCount}条`)
  if (input.unlockedForecastCount > 0) reasons.push(`发现${input.unlockedForecastCount}条预测尚未锁定审批`)
  return { ready: reasons.length === 0, status: reasons.length === 0 ? 'ready' : 'blocked', reasons }
}
