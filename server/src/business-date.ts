export const BUSINESS_DATE_TIME_ZONE = 'Asia/Shanghai'
export const BUSINESS_DATE_MAX_AGE_DAYS = 3

export type BusinessDateValidation = {
  date: string | null
  calendarValid: boolean
  withinAllowedRange: boolean
  shanghaiBusinessDate: string
  latestAllowedDate: string
  reasons: string[]
}

export type BusinessDateValidationOptions = {
  futureToleranceDays?: number
}

function shanghaiDateParts(nowMs: number): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_DATE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs))
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) }
}

function isoDateFromUtcParts(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10)
}

export function shanghaiBusinessDate(nowMs = Date.now(), futureToleranceDays = 0): string {
  const { year, month, day } = shanghaiDateParts(nowMs)
  return isoDateFromUtcParts(year, month, day + futureToleranceDays)
}

export function evaluateBusinessDate(
  value: unknown,
  label = '业务日期',
  nowMs = Date.now(),
  options: BusinessDateValidationOptions = {},
): BusinessDateValidation {
  const raw = typeof value === 'string' ? value.trim() : ''
  const shanghaiToday = shanghaiBusinessDate(nowMs)
  const toleranceDays = Number.isInteger(options.futureToleranceDays) && Number(options.futureToleranceDays) >= 0
    ? Number(options.futureToleranceDays)
    : 0
  const latestAllowedDate = shanghaiBusinessDate(nowMs, toleranceDays)
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  let calendarValid = false
  if (match) {
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const parsed = new Date(Date.UTC(year, month - 1, day))
    calendarValid = parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day
  }
  const withinAllowedRange = calendarValid && raw <= latestAllowedDate
  const reasons: string[] = []
  if (!calendarValid) reasons.push(`${label}无效：必须是真实的YYYY-MM-DD日历日期`)
  else if (!withinAllowedRange) {
    const tolerance = toleranceDays > 0 ? `（允许未来${toleranceDays}天容差）` : ''
    reasons.push(`${label}晚于上海业务日${shanghaiToday}${tolerance}`)
  }
  return {
    date: calendarValid ? raw : null,
    calendarValid,
    withinAllowedRange,
    shanghaiBusinessDate: shanghaiToday,
    latestAllowedDate,
    reasons,
  }
}

export function isRecentBusinessDate(
  value: unknown,
  nowMs = Date.now(),
  maxAgeDays = BUSINESS_DATE_MAX_AGE_DAYS,
): boolean {
  const validation = evaluateBusinessDate(value, '业务日期', nowMs)
  if (!validation.date || !validation.withinAllowedRange) return false
  const ageDays = Math.max(0, Number.isInteger(maxAgeDays) ? maxAgeDays : BUSINESS_DATE_MAX_AGE_DAYS)
  const { year, month, day } = shanghaiDateParts(nowMs)
  const earliestAllowedDate = isoDateFromUtcParts(year, month, day - ageDays)
  return validation.date >= earliestAllowedDate
}
