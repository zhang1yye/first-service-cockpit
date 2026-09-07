export type RuntimeEnvironment = Record<string, string | undefined>

export function canUseDemoData(env: RuntimeEnvironment = process.env): boolean {
  return env.NODE_ENV !== 'production' && env.COCKPIT_ALLOW_DEMO_DATA === 'true'
}

export function canUseManualImport(env: RuntimeEnvironment = process.env): boolean {
  return env.NODE_ENV !== 'production'
}

/** 正式经营表的手工写入默认关闭，仅本地隔离环境显式开启后才允许。 */
export function canUseManualBusinessWrites(env: RuntimeEnvironment = process.env): boolean {
  return env.NODE_ENV !== 'production' && env.COCKPIT_ALLOW_MANUAL_BUSINESS_WRITES === 'true'
}

export function readOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function calculateGrowth(current: unknown, baseline: unknown): number | null {
  const currentValue = readOptionalNumber(current)
  const baselineValue = readOptionalNumber(baseline)
  if (currentValue === null || baselineValue === null || baselineValue === 0) return null
  return (currentValue - baselineValue) / baselineValue
}
