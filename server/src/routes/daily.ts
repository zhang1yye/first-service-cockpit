import { Router } from 'express'
import db from '../db.js'
import { serviceCenterScopeWhere } from '../auth.js'
import { applyEffectiveMasterState } from '../service-center-master.js'
import { unresolvedPublishedDailyConflict } from '../daily-reconciliation-gate.js'
import { hasCurrentPublishedDailyReconciliation } from '../daily-reconciliation.js'
import { evaluateDailyCrossFieldReview, evaluateScopedDailyCrossFieldReview } from '../data-pipeline.js'
import { loadPublishedP46Evidence } from '../published-p46-evidence.js'

const router = Router()

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

/** GET /api/daily?date=YYYY-MM-DD — 每日回款明细 */
router.get('/api/daily', (req, res) => {
  const date = (req.query.date as string) || new Date().toISOString().slice(0, 10)
  const scope = serviceCenterScopeWhere(req, 'center', 'a')
  const scopeSql = scope.clause ? ` AND ${scope.clause}` : ''

  const publishedHead = hasCurrentPublishedDailyReconciliation(db, date)
    ? db.prepare(`SELECT current.id,current.publication_mode,current.official_total,current.detail_total,current.total_difference_confirmed
        FROM daily_collection_reconciliations current
        WHERE current.business_date=? AND current.status='published'
          AND NOT EXISTS (SELECT 1 FROM daily_collection_reconciliations successor
            WHERE successor.business_date=current.business_date AND successor.status='published'
              AND successor.supersedes_id=current.id)`
      ).get(date) as { id: number; publication_mode: string; official_total: number; detail_total: number; total_difference_confirmed: number } | undefined
    : undefined
  if (publishedHead?.publication_mode === 'daily_only') {
    const sourceRows = db.prepare(`SELECT a.center,a.area,NULL AS annual_budget,NULL AS today,
        NULL AS yesterday,revision.new_daily_collection AS daily
      FROM payment_centers a
      JOIN daily_collection_revision_rows revision ON revision.center=a.center AND revision.reconciliation_id=?
      WHERE 1=1${scopeSql}
      ORDER BY a.annual_budget DESC`).all(publishedHead.id, ...scope.params) as any[]
    const rows = applyEffectiveMasterState(sourceRows, { asOf: date })
    const detailTotal = round2(rows.reduce((sum: number, row: any) => sum + row.daily, 0))
    const useConfirmedOfficialTotal = !scope.clause && Number(publishedHead.total_difference_confirmed) === 1
    res.json({
      date,
      rows,
      dailyTotal: useConfirmedOfficialTotal ? Number(publishedHead.official_total) : detailTotal,
      ...(useConfirmedOfficialTotal ? {
        officialTotal: Number(publishedHead.official_total),
        detailTotal,
        reconciliationDifference: round2(Number(publishedHead.official_total) - detailTotal),
        totalBasis: 'official_total_confirmed',
      } : {}),
      sourceStatus: 'available',
      publicationMode: 'daily_only',
    })
    return
  }

  const sourceRows = db.prepare(`
    SELECT 
      a.center,
      a.area,
      s1.cumulative_budget as annual_budget,
      s1.cumulative_executed as today,
      s2.cumulative_executed as yesterday,
      s1.daily_collection as daily
    FROM payment_centers a
    JOIN daily_snapshots s1 ON a.center = s1.center AND s1.date = ? AND s1.quality_status='verified'
    LEFT JOIN daily_snapshots s2 ON a.center = s2.center AND s2.date = date(?, '-1 day') AND s2.quality_status='verified'
    WHERE (s1.cumulative_executed > 0 OR a.cumulative_budget > 0)${scopeSql}
    ORDER BY a.annual_budget DESC
  `).all(date, date, ...scope.params) as any[]
  const rows = applyEffectiveMasterState(sourceRows, { asOf: date })

  // 指定日期没有快照时必须保留缺失语义，禁止用当前累计值冒充当日回款。
  if (rows.length === 0) {
    res.json({
      date,
      rows: [],
      dailyTotal: null,
      sourceStatus: 'missing',
      fallbackReason: '指定日期没有有效快照；未使用当前累计值替代当日回款',
      note: '暂无有效每日快照',
    })
    return
  }

  const hasPublishedReconciliationHistory = Boolean(db.prepare(`SELECT 1 FROM daily_collection_reconciliations
    WHERE business_date=? AND status='published' LIMIT 1`).get(date))
  if (hasPublishedReconciliationHistory && !publishedHead) {
    res.json({
      date,
      rows: rows.map(row => ({ ...row, daily: null })),
      dailyTotal: null,
      sourceStatus: 'partial',
      fallbackReason: '已发布复核证据与当前快照不一致；未回退原始P46，未使用累计差替代本日回款',
      note: '数据证据异常：已发布复核与当前快照不一致',
    })
    return
  }

  if (publishedHead?.publication_mode === 'snapshot_revision') {
    const dailyValues = rows.map((row: any) => row.daily).filter(finite)
    const missingDailyCount = rows.length - dailyValues.length
    const detailTotal = round2(dailyValues.reduce((sum, value) => sum + value, 0))
    const useConfirmedOfficialTotal = missingDailyCount === 0 && !scope.clause && Number(publishedHead.total_difference_confirmed) === 1
    res.json({
      date,
      rows,
      dailyTotal: missingDailyCount === 0 ? useConfirmedOfficialTotal ? Number(publishedHead.official_total) : detailTotal : null,
      ...(useConfirmedOfficialTotal ? {
        officialTotal: Number(publishedHead.official_total),
        detailTotal,
        reconciliationDifference: round2(Number(publishedHead.official_total) - detailTotal),
        totalBasis: 'official_total_confirmed',
      } : {}),
      sourceStatus: missingDailyCount === 0 ? 'available' : 'partial',
      publicationMode: 'snapshot_revision',
      ...(missingDailyCount > 0 ? {
        fallbackReason: `${missingDailyCount === rows.length ? '全部' : `有${missingDailyCount}条`}官方日报字段缺失；未使用累计差替代官方日报`,
        note: '数据待核验：官方日报字段缺失',
      } : {}),
    })
    return
  }

  let publishedEvidence
  try {
    publishedEvidence = loadPublishedP46Evidence(db, { businessDate: date })
  } catch (error: unknown) {
    const reason = `正式P46归档证据异常：${error instanceof Error ? error.message : String(error)}`
    res.json({
      date,
      rows: rows.map(row => ({ ...row, daily: null })),
      dailyTotal: null,
      sourceStatus: 'partial',
      fallbackReason: `${reason}；未回退可变快照`,
      note: `数据证据异常：${reason}`,
    })
    return
  }

  if (!publishedEvidence && db.prepare(`SELECT 1 FROM data_ingestion_batches
    WHERE business_date=? AND status='published' LIMIT 1`).get(date)) {
    res.json({
      date,
      rows: rows.map(row => ({ ...row, daily: null })),
      dailyTotal: null,
      sourceStatus: 'partial',
      fallbackReason: '存在published批次但正式发布回执或行数证据已失效；未回退可变快照',
      note: '数据证据异常：正式发布回执失效',
    })
    return
  }

  if (publishedEvidence && !publishedHead) {
    try {
      const summaryReview = (publishedEvidence.summary?.dailyReview || {}) as { status?: string; baselineBatchId?: number | null }
      const baselineEvidence = summaryReview.baselineBatchId
        ? loadPublishedP46Evidence(db, { batchId: summaryReview.baselineBatchId })
        : loadPublishedP46Evidence(db, { beforeDate: date })
      const allowedCenters = scope.clause
        ? new Set((db.prepare(`SELECT a.center FROM payment_centers a WHERE 1=1${scopeSql}`).all(...scope.params) as Array<{ center: string }>).map(row => row.center))
        : null
      const archiveReview = evaluateDailyCrossFieldReview(
        baselineEvidence?.bundle.payment_centers || [],
        publishedEvidence.bundle.daily_snapshots,
      ).review
      const review = evaluateScopedDailyCrossFieldReview(
        baselineEvidence?.bundle.payment_centers || [],
        publishedEvidence.bundle.daily_snapshots,
        allowedCenters,
      ).review
      if (summaryReview.baselineBatchId && baselineEvidence?.batchId !== summaryReview.baselineBatchId) {
        throw new Error(`发布摘要绑定的累计基线批次${summaryReview.baselineBatchId}不存在或不是正式批次`)
      }
      if (summaryReview.status && summaryReview.status !== archiveReview.status) {
        throw new Error(`发布摘要复核状态${summaryReview.status}与归档重算状态${archiveReview.status}不一致`)
      }
      if (archiveReview.status === 'blocked') throw new Error(archiveReview.reason || '归档跨字段复核被阻断')

      const paymentByCenter = new Map(publishedEvidence.bundle.payment_centers.map(row => [row.center, row]))
      const previousByCenter = new Map((baselineEvidence?.bundle.daily_snapshots || []).map(row => [row.center, row]))
      const evidenceRows = publishedEvidence.bundle.daily_snapshots
        .filter(row => !allowedCenters || allowedCenters.has(row.center))
        .map(row => ({
          center: row.center,
          area: paymentByCenter.get(row.center)?.area || '',
          annual_budget: row.cumulative_budget,
          today: row.cumulative_executed,
          yesterday: previousByCenter.get(row.center)?.cumulative_executed ?? null,
          daily: row.daily_collection,
        }))
        .filter(row => row.today > 0 || Number(paymentByCenter.get(row.center)?.cumulative_budget || 0) > 0)
      const governedRows = applyEffectiveMasterState(evidenceRows, { asOf: date })
      const dailyValues = governedRows.map((row: any) => row.daily).filter(finite)
      const missingDailyCount = governedRows.length - dailyValues.length
      const detailTotal = round2(dailyValues.reduce((sum, value) => sum + value, 0))
      const pending = review.status === 'pending_review'
      res.json({
        date,
        rows: governedRows,
        dailyTotal: missingDailyCount === 0 ? detailTotal : null,
        sourceStatus: pending ? 'pending_review' : missingDailyCount === 0 ? 'available' : 'partial',
        ...(pending ? {
          fallbackReason: `P46批次${publishedEvidence.batchId}：${review.reason}；数据来自正式P46规范化归档，未使用累计差替代本日回款`,
          note: `17:30来源数据已发布，待次日复核（P46批次${publishedEvidence.batchId}）：${review.reason}`,
        } : missingDailyCount > 0 ? {
          fallbackReason: '正式P46归档存在官方日报字段缺失；未使用累计差替代官方日报',
          note: '数据待核验：官方日报字段缺失',
        } : {}),
      })
      return
    } catch (error: unknown) {
      const reason = `正式P46归档证据异常：${error instanceof Error ? error.message : String(error)}`
      res.json({
        date,
        rows: rows.map(row => ({ ...row, daily: null })),
        dailyTotal: null,
        sourceStatus: 'partial',
        fallbackReason: `${reason}；未回退可变快照`,
        note: `数据证据异常：${reason}`,
      })
      return
    }
  }

  const conflict = unresolvedPublishedDailyConflict(db, date)
  if (conflict) {
    if (!hasPublishedReconciliationHistory) {
      const dailyValues = rows.map((row: any) => row.daily).filter(finite)
      const missingDailyCount = rows.length - dailyValues.length
      const detailTotal = round2(dailyValues.reduce((sum, value) => sum + value, 0))
      if (missingDailyCount === 0) {
        res.json({
          date,
          rows,
          dailyTotal: detailTotal,
          sourceStatus: 'pending_review',
          fallbackReason: `${conflict}；已保留官方日报原值，未使用累计差替代本日回款`,
          note: `17:30来源数据已发布，待次日复核：${conflict}`,
        })
        return
      }
    }
    res.json({
      date,
      rows: rows.map(row => ({ ...row, daily: null })),
      dailyTotal: null,
      sourceStatus: 'partial',
      fallbackReason: `${conflict}；未使用累计差替代官方日报`,
      note: `数据待核验：${conflict}`,
    })
    return
  }

  const dailyValues = rows.map((r: any) => r.daily).filter(finite)
  const missingDailyCount = rows.length - dailyValues.length
  const detailTotal = round2(dailyValues.reduce((sum, value) => sum + value, 0))
  const useConfirmedOfficialTotal = missingDailyCount === 0 && !scope.clause && Number(publishedHead?.total_difference_confirmed) === 1
  res.json({
    date,
    rows,
    dailyTotal: missingDailyCount === 0 ? useConfirmedOfficialTotal ? Number(publishedHead?.official_total) : detailTotal : null,
    ...(useConfirmedOfficialTotal ? {
      officialTotal: Number(publishedHead?.official_total),
      detailTotal,
      reconciliationDifference: round2(Number(publishedHead?.official_total) - detailTotal),
      totalBasis: 'official_total_confirmed',
    } : {}),
    sourceStatus: missingDailyCount === 0 ? 'available' : 'partial',
    ...(missingDailyCount > 0 ? {
      fallbackReason: `${missingDailyCount === rows.length ? '全部' : `有${missingDailyCount}条`}官方日报字段缺失；未使用累计差替代官方日报`,
      note: '数据待核验：官方日报字段缺失',
    } : {}),
  })
})

/** GET /api/daily/dates — 可查询的日期列表 */
router.get('/api/daily/dates', (req, res) => {
  const scope = serviceCenterScopeWhere(req, 'center')
  const snapshotDates = db.prepare(`
    SELECT DISTINCT date FROM daily_snapshots WHERE quality_status='verified'
      ${scope.clause ? `AND ${scope.clause}` : ''}
    ORDER BY date DESC
  `).all(...scope.params) as Array<{ date: string }>
  const dailyOnlyDates = db.prepare(`SELECT DISTINCT reconciliation.business_date AS date
      FROM daily_collection_reconciliations reconciliation
      WHERE reconciliation.status='published' AND reconciliation.publication_mode='daily_only'
        AND EXISTS (SELECT 1 FROM payment_centers
          ${scope.clause ? `WHERE ${scope.clause}` : ''})
      ORDER BY reconciliation.business_date DESC`).all(...scope.params) as Array<{ date: string }>
  const dates = [...new Set([
    ...snapshotDates.map(row => row.date),
    ...dailyOnlyDates.map(row => row.date).filter(date => hasCurrentPublishedDailyReconciliation(db, date)),
  ])].sort().reverse().map(date => ({ date }))
  res.json(dates)
})

export default router
