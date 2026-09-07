type PublishedBatchSummary = {
  id: number
  summary: unknown
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function parseSummary(value: unknown): Record<string, unknown> | null {
  if (object(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return object(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function publishedBatchDailyConflict(batch: PublishedBatchSummary | null | undefined): string | null {
  if (!batch) return null
  const summary = parseSummary(batch.summary)
  const totals = object(summary?.totals) ? summary.totals : null
  const beforeTotals = object(totals?.before) ? totals.before : null
  const afterTotals = object(totals?.after) ? totals.after : null
  const before = beforeTotals?.cumulative_executed
  const after = afterTotals?.cumulative_executed
  const daily = afterTotals?.daily_collection
  if (!finite(before) || !finite(after)) return null
  const cumulativeChange = Math.round((after - before) * 100) / 100
  if (Math.abs(cumulativeChange) < 0.005) return null
  if (!finite(daily)) {
    return `已发布批次${batch.id}累计执行变动${cumulativeChange}万元，但官方日回款汇总缺失`
  }
  const dailyTotal = Math.round(daily * 100) / 100
  if (Math.abs(dailyTotal) < 0.005) {
    return `已发布批次${batch.id}累计执行变动${cumulativeChange}万元，但官方日回款汇总为0`
  }
  if (Math.abs(dailyTotal - cumulativeChange) > 0.01) {
    return `已发布批次${batch.id}累计执行变动${cumulativeChange}万元与官方日回款${dailyTotal}万元不勾稽`
  }
  return null
}
