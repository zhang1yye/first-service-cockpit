export function parseBusinessTimestamp(value) {
  const text = String(value || '').trim()
  if (!text) return null

  const localMatch = text.match(/^(\d{4})[./年-](\d{1,2})[./月-](\d{1,2})(?:日)?(?:[ T]+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?$/)
  if (localMatch) {
    const [, yearText, monthText, dayText, hourText = '0', minuteText = '0', secondText = '0'] = localMatch
    const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number)
    const localDate = new Date(year, month - 1, day, hour, minute, second)
    const exact = localDate.getFullYear() === year
      && localDate.getMonth() === month - 1
      && localDate.getDate() === day
      && localDate.getHours() === hour
      && localDate.getMinutes() === minute
      && localDate.getSeconds() === second
    return exact ? localDate.getTime() : null
  }

  const timestamp = Date.parse(text)
  return Number.isFinite(timestamp) ? timestamp : null
}

export function formatBusinessTimestamp(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(timestamp).replaceAll('/', '-')
}

export function latestBusinessFreshness(proposals = [], aiTraceStats = {}, executionLogs = [], now = Date.now()) {
  const candidates = [
    ...proposals.map(item => ({ source: '方案', value: item.updatedAt || item.createdAt })),
    { source: 'AI', value: aiTraceStats.latestAt },
    ...executionLogs.map(item => ({ source: '执行动作', value: item.at }))
  ]
    .map(item => ({ ...item, timestamp: parseBusinessTimestamp(item.value) }))
    .filter(item => item.timestamp !== null)
    .sort((a, b) => b.timestamp - a.timestamp)

  if (!candidates.length) return { text: '暂无记录', stale: true }

  const latest = candidates[0]
  const stale = now - latest.timestamp > 24 * 60 * 60 * 1000
  return {
    text: `最近业务记录 ${formatBusinessTimestamp(latest.timestamp)} · ${stale ? '已超过24小时' : '24小时内'} · ${latest.source}`,
    stale
  }
}
