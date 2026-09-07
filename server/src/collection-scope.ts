const EXCLUDED_COLLECTION_CENTER_KEYWORDS = [
  '葫芦岛龙港区公共行政',
  '葫芦岛龙港区政府行政管理',
  '中信珺台',
  '葫芦岛首创象墅',
] as const

export const EXCLUDED_COLLECTION_CENTERS = [
  '葫芦岛龙港区公共行政服务中心',
  '葫芦岛龙港区政府行政管理服务中心',
  '天津中信珺台服务中心',
  '葫芦岛首创·象墅服务中心',
] as const

const HEATING_ADJUSTED_COLLECTION_CENTER_KEYWORDS = [
  '北京万国城MOMΛ服务中心',
  '北京满庭芳园服务中心',
  '北京青云大厦服务中心',
  '满庭青云服务中心',
] as const

export const COLLECTION_ANNUAL_TARGETS = [
  {
    center: '张家口垣郡MOMΛ服务中心',
    year: 2026,
    rate: 0.8839,
  },
] as const

function normalizeCollectionCenter(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\s·•・]/g, '')
}

export function isCollectionCenterExcluded(value: unknown): boolean {
  const normalized = normalizeCollectionCenter(value)
  return EXCLUDED_COLLECTION_CENTER_KEYWORDS.some((keyword) =>
    normalized.includes(keyword),
  )
}

export function isHeatingAdjustedCollectionCenter(value: unknown): boolean {
  const normalized = normalizeCollectionCenter(value)
  return HEATING_ADJUSTED_COLLECTION_CENTER_KEYWORDS.some((keyword) =>
    normalized.includes(normalizeCollectionCenter(keyword)),
  )
}

export function getCollectionDisplayRate(
  center: unknown,
  receivable: number | null,
  received: number | null,
  officialRate: number | null,
): number | null {
  const canCalculateAmountRate = (
    Number.isFinite(receivable)
    && Number(receivable) > 0
    && Number.isFinite(received)
  )
  if (isHeatingAdjustedCollectionCenter(center) && canCalculateAmountRate) {
    return Math.round((Number(received) / Number(receivable)) * 10000) / 10000
  }
  if (Number.isFinite(officialRate)) return Number(officialRate)
  return null
}

export function resolveCollectionOutstanding(
  sourceOutstanding: number | null,
  receivable: number | null,
  received: number | null,
): number | null {
  if (sourceOutstanding !== null) return sourceOutstanding
  return receivable === null || received === null ? null : receivable - received
}

export function getCollectionAnnualTarget(
  value: unknown,
  year = 2026,
): number | null {
  const normalized = normalizeCollectionCenter(value)
  const matched = COLLECTION_ANNUAL_TARGETS.find(
    (item) =>
      item.year === year
      && normalized.includes(normalizeCollectionCenter(item.center)),
  )
  return matched?.rate ?? null
}
