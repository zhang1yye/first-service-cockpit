type SqliteLike = {
  prepare: (sql: string) => { get: (...params: any[]) => any; all: (...params: any[]) => any[] }
}

function monthBounds(reportDate: string) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(reportDate) ? reportDate : new Date().toISOString().slice(0, 10)
  const month = date.slice(0, 7)
  const [year, monthNumber] = month.split('-').map(Number)
  const next = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 7)
  return { month, start: `${month}-01`, nextStart: `${next}-01` }
}

export function nextArchiveVersion(database: SqliteLike, _reportDate: string, area: string, edition: string): number {
  const row = database.prepare('SELECT MAX(archive_version) AS value FROM report_archives WHERE area = ? AND version = ?').get(area, edition)
  return Number(row?.value || 0) + 1
}

export function nextMonthDueDate(reportDate: string, day = 10): string {
  const { month } = monthBounds(reportDate)
  const [year, monthNumber] = month.split('-').map(Number)
  const next = new Date(Date.UTC(year, monthNumber, day))
  return next.toISOString().slice(0, 10)
}

export function buildArchiveTraceability(database: SqliteLike, reportDate: string, area: string, operator: string) {
  const { month } = monthBounds(reportDate)
  const areaClause = area && area !== '华北' && area !== '全部' ? ' AND area = ?' : ''
  const areaParams = areaClause ? [area] : []
  const snapshotMonths = database.prepare(`SELECT month, COUNT(*) AS count, MAX(created_at) AS created_at FROM project_monthly_snapshots WHERE month <= ? AND quality_status='verified'${areaClause} GROUP BY month ORDER BY month DESC LIMIT 2`).all(month, ...areaParams)
  const latestMonth = snapshotMonths[0]?.month || ''
  const latestRun = latestMonth ? database.prepare('SELECT id, month, status, inserted, skipped, message, created_at FROM snapshot_runs WHERE month = ? ORDER BY id DESC LIMIT 1').get(latestMonth) : null
  const dataSources = database.prepare('SELECT source_key, name, status, last_sync_at, updated_at FROM data_sources ORDER BY source_key').all()
  const recentSyncRuns = database.prepare('SELECT source_key, status, started_at, finished_at, rows_read, rows_written, rows_rejected, message FROM data_source_sync_runs ORDER BY id DESC LIMIT 20').all()
  return {
    reportMonth: month,
    operator,
    generatedAt: new Date().toISOString(),
    snapshots: {
      months: snapshotMonths.map(row => row.month),
      rows: snapshotMonths,
      latestMonth,
      latestCount: Number(snapshotMonths[0]?.count || 0),
      latestRun,
    },
    dataSources,
    recentSyncRuns,
  }
}
