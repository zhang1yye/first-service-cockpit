export type Freshness = 'fresh' | 'delayed' | 'stale' | 'unknown'

export function classifyFreshness(ageHours: number | null | undefined, expectedFreshHours: number): Freshness {
  if (ageHours === null || ageHours === undefined || !Number.isFinite(ageHours) || !Number.isFinite(expectedFreshHours) || expectedFreshHours <= 0) return 'unknown'
  if (ageHours <= expectedFreshHours) return 'fresh'
  if (ageHours <= expectedFreshHours * 1.5) return 'delayed'
  return 'stale'
}

export function freshnessLabel(value: Freshness): string {
  if (value === 'fresh') return '正常'
  if (value === 'delayed') return '延迟'
  if (value === 'stale') return '过期'
  return '未知'
}

const SOURCE_IMPACTS: Record<string, string[]> = {
  aph: ['经营指挥台', '经营看板', '回款执行', '每日回款', '经营月报'],
  finereport: ['经营指挥台', '项目管理', '经营月报'],
  lvzai: ['经营看板', '收缴管理', '经营月报'],
}

export function affectedPagesForSource(sourceKey: string): string[] {
  return SOURCE_IMPACTS[sourceKey] || ['数据源接入']
}
