import { Router } from 'express'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  COLLECTION_ANNUAL_TARGETS,
  EXCLUDED_COLLECTION_CENTERS,
} from '../collection-scope.js'
import { calculateGrowth, readOptionalNumber } from '../production-safety.js'
import { getFormalCollectionDataset } from '../collection-dataset.js'
import db from '../db.js'
import { canAccessServiceCenter, serviceCenterScopeWhere } from '../auth.js'
import { getCollectionDisplayRate } from '../collection-scope.js'
import { isRecentBusinessDate } from '../business-date.js'
import { applyEffectiveMasterState } from '../service-center-master.js'
import { hasRegionWideReadAccess } from '../user-access.js'

const router = Router()
const cockpitRoot = () => process.env.COCKPIT_ROOT || resolve(process.env.HOME || '/home/ubuntu', 'cockpit')

function getLastSync(): number | null {
  try {
    const path = resolve(cockpitRoot(), 'APH决策_每日提取.json')
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf-8'))
      const extractedAt = raw?.extractedAt ? new Date(raw.extractedAt).getTime() : Number.NaN
      return Number.isFinite(extractedAt) ? extractedAt : statSync(path).mtimeMs
    }
  } catch { }
  return null
}

/** 从 APH JSON 读取首页华北汇总（精确数字，优先后台聚合） */
function getAphKpi(): {
  annualBudget: number | null
  cumulativeExecuted: number | null
  cumulativeBudget: number | null
  samePeriod: number | null
  extractedAt: string | null
  businessDate: string | null
  lastValidatedAt: string | null
  source: string
  sourceLayers: unknown
  reconciliations: unknown
} | null {
  try {
    const path = resolve(cockpitRoot(), 'APH决策_每日提取.json')
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    const huabei = raw['华北地区']?.回款额
    const requiredProvenance = ['年度预算_万', '累计预算_万', '累计执行_万', '同期执行_万']
    const validatedMs = raw.lastValidatedAt ? new Date(raw.lastValidatedAt).getTime() : Number.NaN
    const validationAgeMs = Date.now() - validatedMs
    const isFresh = Number.isFinite(validatedMs)
      && validationAgeMs >= -5 * 60 * 1000
      && validationAgeMs <= 72 * 60 * 60 * 1000
    const businessDateIsRecent = isRecentBusinessDate(raw.businessDate)
    const hasProvenance = requiredProvenance.every(key => typeof raw.fieldProvenance?.[key] === 'string')
    const hasSourceLayers = ['regionCard', 'budgetWeekly', 'centerDetail'].every(
      key => raw.sourceLayers?.[key]?.source && raw.sourceLayers?.[key]?.businessDate === raw.businessDate,
    )
    const hasReconciliations = ['annualBudgetCardVsWeekly', 'annualBudgetCardVsCenterDetail', 'samePeriodCardVsCenterDetail'].every(
      key => raw.reconciliations?.[key]?.status,
    )
    if (!huabei || raw.sourceStatus !== 'available' || !isFresh || !businessDateIsRecent || !hasProvenance || !hasSourceLayers || !hasReconciliations) return null
    return {
      annualBudget: readOptionalNumber(huabei['年度预算_万']),
      cumulativeExecuted: readOptionalNumber(huabei['累计执行_万']),
      cumulativeBudget: readOptionalNumber(huabei['累计预算_万']),
      samePeriod: readOptionalNumber(huabei['同期执行_万']),
      extractedAt: raw.extractedAt || null,
      businessDate: raw.businessDate || null,
      lastValidatedAt: raw.lastValidatedAt || null,
      source: String(raw.source || 'FineReport回款额执行评估·华北地区卡片'),
      sourceLayers: raw.sourceLayers,
      reconciliations: raw.reconciliations,
    }
  } catch { return null }
}

router.get('/api/summary', (req, res) => {
  const role = (req as any).user?.role
  const homeRegionalRead = Boolean(role)
  const regionWideRead = hasRegionWideReadAccess(role)
  const aph = homeRegionalRead ? getAphKpi() : null
  const centerScope = homeRegionalRead
    ? { clause: '', params: [] as string[] }
    : serviceCenterScopeWhere(req, 'center')
  const paymentSourceRows = db.prepare(`SELECT center,area,annual_budget,cumulative_executed,cumulative_budget,same_period
    FROM payment_centers ${centerScope.clause ? `WHERE ${centerScope.clause}` : ''}`).all(...centerScope.params) as any[]
  const scopedPaymentRows = applyEffectiveMasterState(paymentSourceRows)
  const paymentRowCount = scopedPaymentRows.length
  const paymentTotals = scopedPaymentRows.reduce((sum, row) => ({
    annualBudget: sum.annualBudget + Number(row.annual_budget || 0),
    cumulativeExecuted: sum.cumulativeExecuted + Number(row.cumulative_executed || 0),
    cumulativeBudget: sum.cumulativeBudget + Number(row.cumulative_budget || 0),
    samePeriod: sum.samePeriod + Number(row.same_period || 0),
    samePeriodComplete: sum.samePeriodComplete && row.same_period !== null && row.same_period !== undefined,
  }), { annualBudget: 0, cumulativeExecuted: 0, cumulativeBudget: 0, samePeriod: 0, samePeriodComplete: true })
  // 首页是面向所有已认证账号的华北公共经营视图，必须统一使用通过新鲜度、血缘和
  // 多源勾稽门禁的APH正式卡片；服务中心权限仅约束明细页和实体查询。
  const annualBudget = homeRegionalRead ? aph?.annualBudget ?? null : (paymentRowCount ? paymentTotals.annualBudget : null)
  const cumulativeExecuted = homeRegionalRead ? aph?.cumulativeExecuted ?? null : (paymentRowCount ? paymentTotals.cumulativeExecuted : null)
  const cumulativeBudget = homeRegionalRead ? aph?.cumulativeBudget ?? null : (paymentRowCount ? paymentTotals.cumulativeBudget : null)
  const samePeriod = homeRegionalRead ? aph?.samePeriod ?? null : (paymentRowCount && paymentTotals.samePeriodComplete ? paymentTotals.samePeriod : null)
  const annualRate = annualBudget && cumulativeExecuted !== null ? cumulativeExecuted / annualBudget : null
  const cumulativeRate = cumulativeBudget && cumulativeExecuted !== null ? cumulativeExecuted / cumulativeBudget : null
  const growth = calculateGrowth(cumulativeExecuted, samePeriod)

  // 收缴率、明细、AI和导出统一读取同一份通过发布门禁的数据集。
  // 严禁在这里用实收/应收重新计算或覆盖官方修正率。
  const formal = getFormalCollectionDataset()
  const lvzai = formal.publication
  // 发布门禁与数据消费必须原子一致：证据失效时保留状态说明，但绝不消费旧行回填首页指标。
  const collectionPublished = formal.quality.ready === true && lvzai.publicationStatus === 'published'
  const activeCollectionRows = collectionPublished
    ? applyEffectiveMasterState(formal.dataset?.rows || [])
    : []
  const scopedCollectionRows = homeRegionalRead ? activeCollectionRows : activeCollectionRows.filter(row => canAccessServiceCenter(req, row.center))
  const scopedCollection = scopedCollectionRows.reduce((sum, row) => {
    const receivable = readOptionalNumber(row.receivable)
    const received = readOptionalNumber(row.received)
    const rate = getCollectionDisplayRate(row.center, receivable, received, readOptionalNumber(row.collectionRate))
    return {
      receivable: sum.receivable + Number(receivable || 0),
      received: sum.received + Number(received || 0),
      weighted: sum.weighted + (receivable !== null && rate !== null ? receivable * rate : 0),
    }
  }, { receivable: 0, received: 0, weighted: 0 })
  const scopedCollectionAvailable = scopedCollectionRows.length > 0
  const collectionReceivable = scopedCollectionAvailable ? scopedCollection.receivable : null
  const collectionReceived = scopedCollectionAvailable ? scopedCollection.received : null
  const collectionRate = collectionReceivable && collectionReceivable > 0 ? scopedCollection.weighted / collectionReceivable : null
  const latestCenterSnapshot = homeRegionalRead ? null : db.prepare(`SELECT business_date,last_validated_at,source
    FROM daily_snapshots WHERE quality_status='verified' AND ${centerScope.clause || '1=0'}
    ORDER BY date DESC,id DESC LIMIT 1`).get(...centerScope.params) as any
  const round4 = (value: number | null) => value === null ? null : Math.round(value * 10000) / 10000
  const round2 = (value: number | null) => value === null ? null : Math.round(value * 100) / 100

  res.json({
    annualBudget,
    cumulativeBudget,
    cumulativeExecuted,
    diff: cumulativeBudget === null || cumulativeExecuted === null ? null : round2(cumulativeBudget - cumulativeExecuted),
    executionVariance: cumulativeBudget === null || cumulativeExecuted === null ? null : round2(cumulativeExecuted - cumulativeBudget),
    annualRate: round4(annualRate),
    cumulativeRate: round4(cumulativeRate),
    samePeriod,
    growth: round4(growth),
    collectionRate,
    collectionReceivable,
    collectionReceived,
    collectionOutstanding: collectionReceivable === null || collectionReceived === null ? null : collectionReceivable - collectionReceived,
    collectionSource: lvzai.source,
    collectionExtractedAt: lvzai.extractedAt,
    collectionBusinessDate: lvzai.businessDate,
    collectionLastValidatedAt: lvzai.lastValidatedAt,
    collectionMethodologyVersion: lvzai.methodologyVersion,
    collectionPublicationStatus: lvzai.publicationStatus,
    collectionPeriodCorrection: regionWideRead ? lvzai.periodCorrection : null,
    collectionSourceQuality: regionWideRead ? lvzai.sourceQuality : { rowCount: scopedCollectionRows.length, scoped: true },
    collectionExcludedCenters: regionWideRead ? EXCLUDED_COLLECTION_CENTERS : [],
    collectionAnnualTargets: regionWideRead ? COLLECTION_ANNUAL_TARGETS : COLLECTION_ANNUAL_TARGETS.filter(target => canAccessServiceCenter(req, target.center)),
    aphSourceStatus: homeRegionalRead ? (aph ? 'available' : 'unavailable') : (paymentRowCount ? 'available' : 'unavailable'),
    aphFallbackReason: homeRegionalRead ? (aph ? null : 'APH华北汇总快照缺失、过期或没有字段血缘；未使用数据库明细替代') : (paymentRowCount ? null : '当前账号未绑定有效服务中心或该中心没有回款数据'),
    aphSource: homeRegionalRead ? aph?.source ?? null : latestCenterSnapshot?.source || 'APH服务中心回款明细',
    aphBusinessDate: homeRegionalRead ? aph?.businessDate ?? null : latestCenterSnapshot?.business_date || null,
    aphLastValidatedAt: homeRegionalRead ? aph?.lastValidatedAt ?? null : latestCenterSnapshot?.last_validated_at || null,
    aphSourceLayers: regionWideRead ? aph?.sourceLayers ?? null : null,
    aphReconciliations: regionWideRead ? aph?.reconciliations ?? null : null,
    collectionSourceStatus: lvzai.sourceStatus,
    collectionFallbackReason: homeRegionalRead
      ? lvzai.fallbackReason
      : (scopedCollectionRows.length ? null : '当前服务中心暂无通过真实性校验的收缴率数据'),
    _ts: lvzai.extractedAt || getLastSync(),
  })
})

export default router
