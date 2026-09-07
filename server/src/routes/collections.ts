import { Router } from 'express'
import db from '../db.js'
import { canAccessServiceCenter, requireAdmin } from '../auth.js'
import {
  COLLECTION_ANNUAL_TARGETS,
  EXCLUDED_COLLECTION_CENTERS,
  getCollectionAnnualTarget,
  getCollectionDisplayRate,
  isCollectionCenterExcluded,
  isHeatingAdjustedCollectionCenter,
  resolveCollectionOutstanding,
} from '../collection-scope.js'
import { readOptionalNumber } from '../production-safety.js'
import { canUseManualBusinessWrites } from '../production-safety.js'
import { getFormalCollectionDataset } from '../collection-dataset.js'
import { applyEffectiveMasterState } from '../service-center-master.js'
import { hasRegionWideReadAccess } from '../user-access.js'

const router = Router()

function normalizeServiceCenterKey(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[·•・]/g, '')
}


/**
 * GET /api/collections[?area=xxx] — 华北全域角色读全量，其他成员按服务中心授权读取
 */
router.get('/api/collections', (req, res) => {
  const area = req.query.area as string | undefined

  let sql = `
    SELECT
      id,
      area,
      center,
      receivable,
      received,
      overdue30,
      overdue90
    FROM collection_centers
  `
  sql += ' ORDER BY receivable DESC'

  const scopedRows = (db.prepare(sql).all() as any[]).filter(
    (row) => !isCollectionCenterExcluded(row.center),
  )
  const seenCenters = new Set<string>()
  const rows = scopedRows.filter((row) => {
    const key = normalizeServiceCenterKey(row.center)
    if (seenCenters.has(key)) return false
    seenCenters.add(key)
    return true
  })
  const formal = getFormalCollectionDataset()
  const lvzai = formal.dataset
  const sourceQuality = formal.quality
  const publication = formal.publication
  if (!lvzai || publication.publicationStatus !== 'published') {
    const isAdmin = (req as any).user?.role === 'admin'
    return res.status(503).json({
      rows: [],
      sourceStatus: publication.sourceStatus,
      publicationStatus: publication.publicationStatus,
      stale: publication.stale,
      fallbackReason: isAdmin
        ? publication.fallbackReason || sourceQuality.reasons?.join('；') || '绿仔官方明细缺失或解析失败；已禁止使用collection_centers混合表替代'
        : '当前服务中心的正式收缴数据暂不可用',
      businessDate: publication.businessDate,
      lastValidatedAt: publication.lastValidatedAt,
      sourceQuality: isAdmin ? sourceQuality : { rowCount: 0, scoped: true },
    })
  }
  const lvzaiByCenter = new Map(
    (lvzai?.rows || []).map((row) => [normalizeServiceCenterKey(row.center), row]),
  )
  const databaseByCenter = new Map(
    rows.map((row) => [normalizeServiceCenterKey(row.center), row]),
  )
  const regionWideRead = hasRegionWideReadAccess((req as any).user?.role)
  const displayRows = applyEffectiveMasterState(lvzai.rows).map(live => ({
    ...(databaseByCenter.get(normalizeServiceCenterKey(live.center)) || {}),
    area: live.area,
    center: live.center,
  })).filter(live => (
    (regionWideRead || canAccessServiceCenter(req, live.center))
    && (!area || area === '全部' || live.area === area)
  ))

  const displaySummary = displayRows.reduce((sum, row) => {
    const live = lvzaiByCenter.get(normalizeServiceCenterKey(row.center))
    const receivable = readOptionalNumber(live?.receivable)
    const received = readOptionalNumber(live?.received)
    const outstanding = resolveCollectionOutstanding(readOptionalNumber(live?.outstanding), receivable, received)
    const rate = getCollectionDisplayRate(row.center, receivable, received, readOptionalNumber(live?.collectionRate))
    return {
      receivable: sum.receivable + Number(receivable || 0),
      received: sum.received + Number(received || 0),
      outstanding: sum.outstanding + Number(outstanding || 0),
      weighted: sum.weighted + (receivable !== null && rate !== null ? receivable * rate : 0),
    }
  }, { receivable: 0, received: 0, outstanding: 0, weighted: 0 })
  const displayCollectionRate = displaySummary.receivable > 0 ? displaySummary.weighted / displaySummary.receivable : null

  const result = displayRows.map((r, index) => {
    const item = {
      ...r,
      ...(() => {
      const live = lvzaiByCenter.get(normalizeServiceCenterKey(r.center))
      const receivable = readOptionalNumber(live?.receivable)
      const received = readOptionalNumber(live?.received)
      const sourceOutstanding = readOptionalNumber(live?.outstanding)
      const outstanding = resolveCollectionOutstanding(sourceOutstanding, receivable, received)
      const sourceRate = readOptionalNumber(live?.collectionRate)
      const center = live?.center || r.center
      const heatingAdjusted = isHeatingAdjustedCollectionCenter(center)
      const rate = getCollectionDisplayRate(center, receivable, received, sourceRate)
      return {
        area: r.area,
        center,
        receivable,
        received,
        outstanding,
        rate,
        collectionRate: rate,
        overdue30: null,
        overdue90: null,
        overdueStatus: 'not-provided-by-source',
        source: heatingAdjusted
          ? '绿仔实时接口·供暖期间金额修正后实收÷应收'
          : '绿仔实时接口·官方字段gatheringCurrentYearRecedRate',
        rateBasis: heatingAdjusted
          ? 'heating-adjusted-received-over-receivable'
          : 'official-gatheringCurrentYearRecedRate',
        sourceStatus: 'available',
        stale: false,
        extractedAt: lvzai.extractedAt,
      }
      })(),
    }
    const annualTargetRate = getCollectionAnnualTarget(item.center)
    return {
      ...item,
      annualTargetRate,
      annualTargetYear: annualTargetRate === null ? null : 2026,
      ...(index === 0
      ? {
          _lvzaiSummary: {
            ...(req as any).user?.role === 'admin' ? publication : {
              source: publication.source,
              extractedAt: publication.extractedAt,
              businessDate: publication.businessDate,
              lastValidatedAt: publication.lastValidatedAt,
              methodologyVersion: publication.methodologyVersion,
              publicationStatus: publication.publicationStatus,
              sourceStatus: publication.sourceStatus,
              stale: publication.stale,
              fallbackReason: null,
            },
            collectionRate: displayCollectionRate,
            collectionReceivable: displaySummary.receivable,
            collectionReceived: displaySummary.received,
            collectionOutstanding: displaySummary.outstanding,
            periodCorrection: (req as any).user?.role === 'admin' ? publication.periodCorrection : null,
            sourceQuality: (req as any).user?.role === 'admin' ? sourceQuality : { rowCount: displayRows.length, scoped: true },
            excludedCenters: (req as any).user?.role === 'admin' ? EXCLUDED_COLLECTION_CENTERS : [],
            annualTargets: (req as any).user?.role === 'admin' ? COLLECTION_ANNUAL_TARGETS : COLLECTION_ANNUAL_TARGETS.filter(target => canAccessServiceCenter(req, target.center)),
          },
        }
      : {}),
    }
  })

  res.json(result)
})

/**
 * PUT /api/collections/:id
 * 更新单条收缴率数据
 */
router.put('/api/collections/:id', requireAdmin, (req, res) => {
  if (!canUseManualBusinessWrites()) return res.status(403).json({ error: '正式收缴数据禁止手工修改；请发布通过质量门禁的P46批次' })
  const { id } = req.params
  const { receivable, received, overdue30, overdue90 } = req.body

  const existing = db.prepare('SELECT id FROM collection_centers WHERE id = ?').get(Number(id))
  if (!existing) {
    res.status(404).json({ error: '记录不存在' })
    return
  }

  db.prepare(`
    UPDATE collection_centers SET
      receivable = COALESCE(?, receivable),
      received = COALESCE(?, received),
      overdue30 = COALESCE(?, overdue30),
      overdue90 = COALESCE(?, overdue90)
    WHERE id = ?
  `).run(
    receivable ?? null,
    received ?? null,
    overdue30 ?? null,
    overdue90 ?? null,
    Number(id),
  )

  res.json({ success: true, id: Number(id) })
})

export default router
