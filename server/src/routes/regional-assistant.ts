import { Router } from 'express'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import db from '../db.js'
import { logOperation } from '../audit.js'
import { projectDataBlockedPayload, readProjectDataGate } from '../data-quality-gate.js'
import { readArrearsOperatingOverview } from '../arrears-operating-data.js'
import { calculateGrowth, readOptionalNumber } from '../production-safety.js'
import { answerRegionalQuestionWithTopic, ratioToPercent, type AphReconciliation, type RegionalAssistantContext } from '../regional-assistant-core.js'
import { orchestrateAssistantAnswer } from '../assistant-orchestrator.js'
import { getFormalCollectionDataset } from '../collection-dataset.js'
import { canAccessServiceCenter, getServiceCenterScope, projectScopeWhere } from '../auth.js'
import { getCollectionDisplayRate, isHeatingAdjustedCollectionCenter } from '../collection-scope.js'
import { canonicalServiceCenterForUser } from '../service-center-access.js'
import { applyEffectiveMasterState } from '../service-center-master.js'
import { unresolvedPublishedDailyConflict } from '../daily-reconciliation-gate.js'

const router = Router()
const cockpitRoot = () => process.env.COCKPIT_ROOT || resolve(process.env.HOME || '/home/ubuntu', 'cockpit')
const requestWindows = new Map<string, number[]>()


function rateLimitKey(req: any): string {
  return String(req.user?.id || req.user?.username || req.ip || 'anonymous')
}

function consumeRateLimit(req: any): boolean {
  const now = Date.now()
  const key = rateLimitKey(req)
  const recent = (requestWindows.get(key) || []).filter(time => now - time < 60_000)
  if (recent.length >= 20) return false
  recent.push(now)
  requestWindows.set(key, recent)
  return true
}

function mapReconciliations(raw: any): AphReconciliation[] {
  const labels: Record<string, string> = {
    annualBudgetCardVsWeekly: '年度预算·卡片对周报',
    annualBudgetCardVsCenterDetail: '年度预算·卡片对中心明细',
    samePeriodCardVsCenterDetail: '同期执行·卡片对中心明细',
  }
  return Object.entries(raw || {}).map(([key, item]: [string, any]) => ({
    label: labels[key] || key,
    left: readOptionalNumber(item?.leftValue),
    right: readOptionalNumber(item?.rightValue),
    difference: readOptionalNumber(item?.difference),
    status: String(item?.status || 'warning'),
  }))
}

function isFreshValidationTimestamp(value: unknown, now = Date.now()): boolean {
  const timestamp = Date.parse(String(value || ''))
  const age = now - timestamp
  // 容忍最多5分钟的服务器时钟偏差；未来快照不能被当作长期“新鲜”数据。
  return Number.isFinite(timestamp)
    && age >= -5 * 60 * 1000
    && age <= 72 * 60 * 60 * 1000
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isCollectionPublicationUsable(publication: any): boolean {
  const rate = publication?.collectionRate
  const businessDate = String(publication?.businessDate || '')
  const timestamps = [publication?.extractedAt, publication?.lastValidatedAt].filter(Boolean)
  return publication?.publicationStatus === 'published'
    && /^\d{4}-\d{2}-\d{2}$/.test(businessDate)
    && typeof publication?.source === 'string'
    && publication.source.trim().length > 0
    && timestamps.length > 0
    && timestamps.every(value => isFreshValidationTimestamp(value))
    && isNonNegativeFiniteNumber(rate)
    && rate <= 1
    && isNonNegativeFiniteNumber(publication?.collectionReceivable)
    && isNonNegativeFiniteNumber(publication?.collectionReceived)
    && isNonNegativeFiniteNumber(publication?.collectionOutstanding)
}

function readAphContext(): RegionalAssistantContext['aph'] {
  const unavailable = {
    ready: false, annualBudget: null, cumulativeBudget: null, cumulativeExecuted: null, samePeriod: null,
    growth: null, businessDate: null, source: 'FineReport回款额执行评估·华北地区卡片', reconciliations: [] as AphReconciliation[],
    centerDetail: {
      source: 'FineReport日报+预算周报+执行评估中心明细',
      businessDate: null,
      centerCount: null,
      annualBudget: null,
      cumulativeBudget: null,
      cumulativeExecuted: null,
      samePeriod: null,
      samePeriodPresentCount: null,
      samePeriodMissingCount: null,
    },
  }
  try {
    const path = resolve(cockpitRoot(), 'APH决策_每日提取.json')
    if (!existsSync(path)) return unavailable
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const layerValues = raw?.sourceLayers?.regionCard?.values
    const exactValues = raw?.['华北地区']?.回款额
    const exactFields = ['年度预算_万', '累计预算_万', '累计执行_万', '同期执行_万']
    const requiredLayers = ['regionCard', 'budgetWeekly', 'centerDetail']
    const fresh = isFreshValidationTimestamp(raw?.lastValidatedAt)
    const sameBusinessDate = requiredLayers.every(key => raw?.sourceLayers?.[key]?.businessDate === raw?.businessDate)
    const hasExactProvenance = exactFields.every(key => typeof raw?.fieldProvenance?.[key] === 'string')
    const reconciliations = mapReconciliations(raw?.reconciliations)
    if (raw?.sourceStatus !== 'available' || !fresh || !layerValues || !exactValues || !hasExactProvenance || !sameBusinessDate || reconciliations.length < 3) return unavailable
    // 与首页使用相同的精确APH卡片字段；sourceLayers仅承担来源和勾稽门禁，
    // 不使用其中可能已按报表展示精度四舍五入的数值。
    const annualBudget = readOptionalNumber(exactValues['年度预算_万'])
    const cumulativeBudget = readOptionalNumber(exactValues['累计预算_万'])
    const current = readOptionalNumber(exactValues['累计执行_万'])
    const baseline = readOptionalNumber(exactValues['同期执行_万'])
    if ([annualBudget, cumulativeBudget, current, baseline].some(value => value === null)) return unavailable
    const centerDetail = raw?.sourceLayers?.centerDetail
    const centerValues = centerDetail?.values || {}
    return {
      ready: true,
      annualBudget,
      cumulativeBudget,
      cumulativeExecuted: current,
      samePeriod: baseline,
      growth: calculateGrowth(current, baseline),
      businessDate: raw.businessDate || null,
      source: String(raw?.sourceLayers?.regionCard?.source || unavailable.source),
      reconciliations,
      centerDetail: {
        source: String(centerDetail?.source || unavailable.centerDetail.source),
        businessDate: centerDetail?.businessDate || null,
        centerCount: readOptionalNumber(centerValues.centerCount),
        annualBudget: readOptionalNumber(centerValues.annualBudget),
        cumulativeBudget: readOptionalNumber(centerValues.cumulativeBudget),
        cumulativeExecuted: readOptionalNumber(centerValues.cumulativeExecuted),
        samePeriod: readOptionalNumber(centerValues.samePeriod),
        samePeriodPresentCount: readOptionalNumber(centerValues.samePeriodPresentCount),
        samePeriodMissingCount: readOptionalNumber(centerValues.samePeriodMissingCount),
      },
    }
  } catch {
    return unavailable
  }
}

function nearlyEqual(left: number | null, right: number | null, tolerance = 0.02): boolean {
  return left !== null && right !== null && Math.abs(left - right) <= tolerance
}

function readPaymentCenterContext(req: any, aph: RegionalAssistantContext['aph']): RegionalAssistantContext['paymentCenters'] {
  const unavailable = (reason: string): RegionalAssistantContext['paymentCenters'] => ({
    ready: false,
    businessDate: aph.centerDetail.businessDate,
    source: aph.centerDetail.source,
    reason,
    rows: [],
  })
  if (!req?.user || !aph.ready || !aph.businessDate || aph.centerDetail.businessDate !== aph.businessDate) {
    return unavailable('服务中心回款来源层未通过业务日期和新鲜度校验')
  }

  const expected = aph.centerDetail
  if ([
    expected.centerCount,
    expected.annualBudget,
    expected.cumulativeBudget,
    expected.cumulativeExecuted,
    expected.samePeriod,
    expected.samePeriodPresentCount,
    expected.samePeriodMissingCount,
  ].some(value => value === null)) return unavailable('服务中心回款来源层缺少完整性指标')

  try {
    const totals = db.prepare(`
      SELECT COUNT(*) count,
             COUNT(DISTINCT center) uniqueCount,
             SUM(CASE WHEN annual_budget IS NULL
                       OR cumulative_budget IS NULL
                       OR cumulative_executed IS NULL
                       OR typeof(annual_budget) NOT IN ('integer', 'real')
                       OR typeof(cumulative_budget) NOT IN ('integer', 'real')
                       OR typeof(cumulative_executed) NOT IN ('integer', 'real')
                      THEN 1 ELSE 0 END) invalidRequiredCount,
             SUM(annual_budget) annualBudget,
             SUM(cumulative_budget) cumulativeBudget,
             SUM(cumulative_executed) cumulativeExecuted,
             SUM(same_period) samePeriod,
             SUM(CASE WHEN same_period IS NULL THEN 1 ELSE 0 END) samePeriodMissingCount
      FROM payment_centers
    `).get() as any
    const count = Number(totals?.count || 0)
    const missingCount = Number(totals?.samePeriodMissingCount || 0)
    const integrityMatches = count === expected.centerCount
      && Number(totals?.uniqueCount || 0) === count
      && Number(totals?.invalidRequiredCount || 0) === 0
      && count - missingCount === expected.samePeriodPresentCount
      && missingCount === expected.samePeriodMissingCount
      && nearlyEqual(readOptionalNumber(totals?.annualBudget), expected.annualBudget)
      && nearlyEqual(readOptionalNumber(totals?.cumulativeBudget), expected.cumulativeBudget)
      && nearlyEqual(readOptionalNumber(totals?.cumulativeExecuted), expected.cumulativeExecuted)
      && nearlyEqual(readOptionalNumber(totals?.samePeriod), expected.samePeriod)
    if (!integrityMatches) return unavailable('服务中心回款明细与已验证中心层的条数或合计不一致')

    const dailyConflict = unresolvedPublishedDailyConflict(db, aph.businessDate)
    const dailyGate = db.prepare(`
      SELECT COUNT(*) count,
             COUNT(DISTINCT d.center) uniqueCenterCount,
             SUM(CASE WHEN d.id IS NULL
                       OR d.quality_status != 'verified'
                       OR d.source_status != 'available'
                       OR d.business_date != @businessDate
                       OR d.source IS NULL OR TRIM(d.source) = ''
                       OR d.last_validated_at IS NULL OR TRIM(d.last_validated_at) = ''
                       OR d.daily_collection IS NULL
                       OR d.annual_budget IS NULL
                       OR d.cumulative_budget IS NULL
                       OR d.cumulative_executed IS NULL
                       OR typeof(d.daily_collection) NOT IN ('integer', 'real')
                       OR typeof(d.annual_budget) NOT IN ('integer', 'real')
                       OR typeof(d.cumulative_budget) NOT IN ('integer', 'real')
                       OR typeof(d.cumulative_executed) NOT IN ('integer', 'real')
                       OR ABS(d.annual_budget - p.annual_budget) > 0.02
                       OR ABS(d.cumulative_budget - p.cumulative_budget) > 0.02
                       OR ABS(d.cumulative_executed - p.cumulative_executed) > 0.02
                      THEN 1 ELSE 0 END) invalidCount,
             GROUP_CONCAT(d.last_validated_at, CHAR(10)) validationTimes
      FROM payment_centers p
      LEFT JOIN daily_snapshots d ON d.id = (
        SELECT d2.id FROM daily_snapshots d2
        WHERE d2.center = p.center AND d2.business_date = @businessDate
        ORDER BY d2.id DESC LIMIT 1
      )
    `).get({ businessDate: aph.businessDate }) as any
    const validationTimes = String(dailyGate?.validationTimes || '').split('\n').filter(Boolean)
    const fresh = validationTimes.length === count
      && validationTimes.every(value => isFreshValidationTimestamp(value))
    if (Number(dailyGate?.count || 0) !== count
      || Number(dailyGate?.uniqueCenterCount || 0) !== count
      || Number(dailyGate?.invalidCount || 0) !== 0
      || !fresh) {
      return unavailable('服务中心回款日快照未通过来源、字段或新鲜度校验')
    }

    const params: Record<string, string> = { businessDate: aph.businessDate }
    let where = ''
    if (req.user?.role !== 'admin') {
      const centers = getServiceCenterScope(req.user)
      if (!centers.length) where = 'WHERE 1 = 0'
      else {
        where = `WHERE p.center IN (${centers.map((_, index) => `@center${index}`).join(',')})`
        centers.forEach((center, index) => { params[`center${index}`] = center })
      }
    }
    const rows = applyEffectiveMasterState(db.prepare(`
      SELECT p.area,
             p.center,
             p.annual_budget annualBudget,
             p.cumulative_budget cumulativeBudget,
             p.cumulative_executed cumulativeExecuted,
             p.same_period samePeriod,
             d.daily_collection dailyCollection
      FROM payment_centers p
      JOIN daily_snapshots d ON d.id = (
        SELECT d2.id FROM daily_snapshots d2
        WHERE d2.center = p.center AND d2.business_date = @businessDate
        ORDER BY d2.id DESC LIMIT 1
      )
      ${where}
      ORDER BY p.center
    `).all(params) as any[], { asOf: aph.businessDate })

    const invalidScopedRow = rows.some(row => [
      row.annualBudget,
      row.cumulativeBudget,
      row.cumulativeExecuted,
      ...(dailyConflict ? [] : [row.dailyCollection]),
    ].some(value => readOptionalNumber(value) === null))
    if (invalidScopedRow) return unavailable('服务中心回款明细存在缺失或非数值必填字段')

    return {
      ready: true,
      businessDate: aph.businessDate,
      source: expected.source,
      reason: null,
      dailyCollectionReason: dailyConflict ? `服务中心当日回款待复核：${dailyConflict}` : null,
      rows: rows.map(row => ({
        area: String(row.area),
        center: String(row.center),
        annualBudget: readOptionalNumber(row.annualBudget)!,
        cumulativeBudget: readOptionalNumber(row.cumulativeBudget)!,
        cumulativeExecuted: readOptionalNumber(row.cumulativeExecuted)!,
        samePeriod: readOptionalNumber(row.samePeriod),
        dailyCollection: dailyConflict ? null : readOptionalNumber(row.dailyCollection)!,
        businessDate: aph.businessDate!,
        source: expected.source,
      })),
    }
  } catch {
    return unavailable('服务中心回款明细读取失败')
  }
}

function readCollectionContext(req?: any): RegionalAssistantContext['collection'] {
  const unavailable = {
    ready: false, rate: null, receivable: null, received: null, outstanding: null,
    amountNote: '正式收缴口径不可用',
    centerCount: 0, businessDate: null, source: '绿仔质量门禁活动数据集', rows: [],
  }
  try {
    const formal = getFormalCollectionDataset()
    const publication = formal.publication
    if (!formal.quality.ready || !isCollectionPublicationUsable(publication)) return unavailable
    const activeRows = applyEffectiveMasterState(formal.dataset?.rows || [])
    const isAdmin = req?.user?.role === 'admin'
    const scopedRows = isAdmin
      ? activeRows
      : activeRows.filter(row => canAccessServiceCenter(req, row.center))
    if (!scopedRows.length) return unavailable
    const invalidScopedRow = scopedRows.some(row => {
      const center = typeof row.center === 'string' ? row.center.trim() : ''
      const receivable = isNonNegativeFiniteNumber(row.receivable) ? row.receivable : null
      const received = isNonNegativeFiniteNumber(row.received) ? row.received : null
      const outstanding = isNonNegativeFiniteNumber(row.outstanding) ? row.outstanding : null
      const officialRate = isNonNegativeFiniteNumber(row.collectionRate) && row.collectionRate <= 1
        ? row.collectionRate
        : null
      const rate = isHeatingAdjustedCollectionCenter(row.center)
        ? getCollectionDisplayRate(row.center, receivable, received, officialRate)
        : officialRate
      return !center || [receivable, received, outstanding, rate].some(value => value === null)
    })
    if (invalidScopedRow) return unavailable
    const rows = scopedRows.map(row => {
      const officialRate = isNonNegativeFiniteNumber(row.collectionRate) && row.collectionRate <= 1
        ? row.collectionRate
        : null
      const rate = isHeatingAdjustedCollectionCenter(row.center)
        ? getCollectionDisplayRate(row.center, row.receivable, row.received, officialRate)!
        : officialRate!
      return {
        area: String(row.area || ''),
        center: String(row.center),
        rate: ratioToPercent(rate)!,
        receivable: Number(row.receivable),
        received: Number(row.received),
        outstanding: Number(row.outstanding),
        businessDate: publication.businessDate!,
        source: publication.source || unavailable.source,
      }
    })
    const amounts = scopedRows.reduce((sum, row) => {
      const receivable = row.receivable as number
      const received = row.received as number
      const outstanding = row.outstanding as number
      const officialRate = isNonNegativeFiniteNumber(row.collectionRate) && row.collectionRate <= 1
        ? row.collectionRate
        : null
      const rate = isHeatingAdjustedCollectionCenter(row.center)
        ? getCollectionDisplayRate(row.center, receivable, received, officialRate)!
        : officialRate!
      return {
        receivable: sum.receivable + receivable,
        received: sum.received + received,
        outstanding: sum.outstanding + outstanding,
        weighted: sum.weighted + receivable * rate,
      }
    }, { receivable: 0, received: 0, outstanding: 0, weighted: 0 })
    // 管理员看到的是正式发布的华北摘要，必须逐字段绑定publication，禁止从中心行重新加权形成第二口径。
    // 非管理员没有权限读取地区摘要，只能在自己的中心范围内聚合已发布行。
    const receivable = isAdmin ? publication.collectionReceivable : amounts.receivable
    const received = isAdmin ? publication.collectionReceived : amounts.received
    const outstanding = isAdmin ? publication.collectionOutstanding : amounts.outstanding
    const rate = isAdmin
      ? ratioToPercent(publication.collectionRate)
      : (amounts.receivable > 0 ? ratioToPercent(amounts.weighted / amounts.receivable) : null)
    if (rate === null
      || !isNonNegativeFiniteNumber(receivable)
      || !isNonNegativeFiniteNumber(received)
      || !isNonNegativeFiniteNumber(outstanding)) return unavailable

    return {
      ready: true,
      rate,
      receivable,
      received,
      outstanding,
      amountNote: isAdmin
        ? '地区汇总直接采用正式发布摘要原值；中心行仅用于范围内明细证据'
        : '金额与收缴率采用当前账号范围内的同一质量门禁活动数据集（含供暖费期间更正）',
      centerCount: scopedRows.length,
      businessDate: publication.businessDate,
      source: publication.source || unavailable.source,
      rows,
    }
  } catch {
    return unavailable
  }
}

function readArrearsContext(req?: any): RegionalAssistantContext['arrears'] {
  const empty: RegionalAssistantContext['arrears'] = {
    ready: false,
    activeBatchCount: 0,
    revokedBatchCount: 0,
    projectCount: 0,
    resourceCount: 0,
    totalAmount: null,
    pendingReviewCount: 0,
    confirmedReviewCount: 0,
    latestBusinessDate: null,
    topCauses: [],
    source: '欠费资源分析有效批次',
  }
  if (!req?.user) return empty
  try {
    const overview = readArrearsOperatingOverview(req)
    return {
      ready: overview.ready,
      activeBatchCount: overview.effectiveBatchCount,
      revokedBatchCount: overview.revokedBatchCount,
      projectCount: overview.projectCount,
      resourceCount: overview.resourceCount,
      totalAmount: overview.totalAmount,
      pendingReviewCount: overview.pendingReviewCount,
      confirmedReviewCount: overview.confirmedReviewCount,
      latestBusinessDate: overview.latestBusinessDate,
      topCauses: overview.causeBreakdown.slice(0, 5).map(row => ({ category: row.cause, count: row.resourceCount })),
      source: empty.source,
    }
  } catch {
    return empty
  }
}

export function buildRegionalAssistantContext(req?: any): RegionalAssistantContext {
  const projectGate = readProjectDataGate(db)
  let openCaseCount = 0
  let notes: string[] = []
  try {
    if (req?.user?.role !== 'admin') throw new Error('成员不读取全局治理事项')
    const rows = db.prepare("SELECT title FROM data_quality_cases WHERE workflow_status != 'resolved' ORDER BY id DESC LIMIT 8").all() as any[]
    openCaseCount = Number((db.prepare("SELECT COUNT(*) count FROM data_quality_cases WHERE workflow_status != 'resolved'").get() as any)?.count || 0)
    notes = rows.map(row => String(row.title || '')).filter(Boolean)
  } catch {}
  const regionalAph = readAphContext()
  const paymentCenters = readPaymentCenterContext(req, regionalAph)
  const scopedPaymentRows = paymentCenters.rows || []
  const scopedAnnualBudget = scopedPaymentRows.length ? scopedPaymentRows.reduce((sum, row) => sum + Number(row.annualBudget || 0), 0) : null
  const scopedCumulativeBudget = scopedPaymentRows.length ? scopedPaymentRows.reduce((sum, row) => sum + Number(row.cumulativeBudget || 0), 0) : null
  const scopedCumulativeExecuted = scopedPaymentRows.length ? scopedPaymentRows.reduce((sum, row) => sum + Number(row.cumulativeExecuted || 0), 0) : null
  const scopedSamePeriod = scopedPaymentRows.length && scopedPaymentRows.every(row => row.samePeriod !== null)
    ? scopedPaymentRows.reduce((sum, row) => sum + Number(row.samePeriod || 0), 0)
    : null
  // 管理员地区问答与首页统一使用通过门禁的APH华北正式卡片；中心明细只服务实体查询和受限账号范围。
  const useRegionalCard = req?.user?.role === 'admin' && regionalAph.ready
  const aph = {
    ready: useRegionalCard ? true : paymentCenters.ready && scopedPaymentRows.length > 0,
    annualBudget: useRegionalCard ? regionalAph.annualBudget : scopedAnnualBudget,
    cumulativeBudget: useRegionalCard ? regionalAph.cumulativeBudget : scopedCumulativeBudget,
    cumulativeExecuted: useRegionalCard ? regionalAph.cumulativeExecuted : scopedCumulativeExecuted,
    samePeriod: useRegionalCard ? regionalAph.samePeriod : scopedSamePeriod,
    growth: null as number | null,
    businessDate: useRegionalCard ? regionalAph.businessDate : paymentCenters.businessDate,
    source: useRegionalCard ? regionalAph.source : paymentCenters.source,
    reconciliations: req?.user?.role === 'admin' ? regionalAph.reconciliations : [],
    centerDetail: {
      source: paymentCenters.source,
      businessDate: paymentCenters.businessDate,
      centerCount: scopedPaymentRows.length,
      annualBudget: scopedAnnualBudget,
      cumulativeBudget: scopedCumulativeBudget,
      cumulativeExecuted: scopedCumulativeExecuted,
      samePeriod: scopedSamePeriod,
      samePeriodPresentCount: scopedPaymentRows.filter(row => row.samePeriod !== null).length,
      samePeriodMissingCount: scopedPaymentRows.filter(row => row.samePeriod === null).length,
    },
  }
  aph.growth = calculateGrowth(aph.cumulativeExecuted, aph.samePeriod)
  const collection = readCollectionContext(req)
  const arrears = readArrearsContext(req)
  const projectScope = req ? projectScopeWhere(req) : { clause: '1=0', params: [] as any[] }
  const scopedProjectCount = Number((db.prepare(`SELECT COUNT(*) count FROM projects ${projectScope.clause ? `WHERE ${projectScope.clause}` : ''}`).get(...projectScope.params) as any)?.count || 0)
  return {
    aph,
    paymentCenters,
    collection,
    arrears,
    projects: { ready: projectGate.ready && scopedProjectCount > 0, count: scopedProjectCount, reason: projectGate.ready && scopedProjectCount > 0 ? null : (req?.user?.role === 'admin' ? projectGate.reasons.join('；') : '当前服务中心项目数据未通过真实性门禁或暂无数据') },
    quality: {
      openCaseCount,
      status: !aph.ready || !collection.ready ? 'unavailable' : openCaseCount > 0 || aph.reconciliations.some(item => item.status !== 'ok') ? 'warning' : 'verified',
      notes,
    },
  }
}

router.get('/api/ai/assistant/context', (req, res) => {
  const context = buildRegionalAssistantContext(req)
  const isAdmin = (req as any).user?.role === 'admin'
  const ownCenter = canonicalServiceCenterForUser((req as any).user)
  logOperation(req, '查看华北经营助手上下文', 'ai:regional-assistant', { qualityStatus: context.quality.status })
  res.json({
    businessDate: context.aph.businessDate || context.collection.businessDate,
    qualityStatus: context.quality.status,
    capabilities: ['可信经营数据', '服务中心回款查询', '经营异常识别', '欠费批次分析', '已批准标准引用', '有依据的管理建议'],
    projectDataReady: context.projects.ready,
    suggestedQuestions: [
      isAdmin ? '上第服务中心的数据和未达标建议' : `${ownCenter || '本服务中心'}的数据和未达标建议`,
      '哪些指标没有达标？',
      '目前有哪些有效欠费批次？',
      '当前有哪些数据质量问题？',
    ],
  })
})

router.post('/api/ai/assistant/ask', async (req, res) => {
  if (!consumeRateLimit(req)) return res.status(429).json({ error: '提问过于频繁，请稍后再试' })
  const question = String(req.body?.question || '').trim()
  if (!question) return res.status(400).json({ error: '请输入问题' })
  if (question.length > 500) return res.status(400).json({ error: '问题不能超过500字' })
  const topic = String(req.body?.topic || '')
  const history = Array.isArray(req.body?.history)
    ? req.body.history.slice(-6).map((item: any) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: String(item?.content || '').slice(0, 500),
    })).filter((item: any) => item.content.trim())
    : []
  const context = buildRegionalAssistantContext(req)
  const result = answerRegionalQuestionWithTopic(question, topic, context)
  if (result.topic === 'project' && !context.projects.ready) {
    if ((req as any).user?.role !== 'admin') {
      return res.status(409).json({
        error: context.projects.reason || '当前服务中心项目经营数据不可用',
        code: 'PROJECT_DATA_QUALITY_BLOCKED',
        dataQuality: {
          ready: false,
          status: 'blocked',
          projectCount: 0,
          reasons: [context.projects.reason || '当前服务中心项目经营数据不可用'],
        },
        generatedBy: null,
        modelUsed: null,
        aiOpinion: null,
        citations: [],
        fallbackUsed: false,
        readOnly: true,
      })
    }
    return res.status(409).json(projectDataBlockedPayload(db))
  }
  if (result.centerPaymentLookup && result.centerPaymentLookup !== 'matched') {
    const unavailable = result.centerPaymentLookup === 'unavailable'
    const memberDenied = (req as any).user?.role !== 'admin'
    if (memberDenied) {
      return res.status(unavailable ? 409 : 403).json({
        error: unavailable ? '当前服务中心数据暂不可用。' : '该服务中心不在当前账号的数据范围内。',
        code: unavailable ? 'CENTER_PAYMENT_DATA_UNAVAILABLE' : 'SERVICE_CENTER_OUT_OF_SCOPE',
        generatedBy: null,
        modelUsed: null,
        aiOpinion: null,
        citations: [],
        fallbackUsed: false,
        readOnly: true,
      })
    }
    return res.status(unavailable ? 409 : 422).json({
      error: result.answer,
      code: unavailable ? 'CENTER_PAYMENT_DATA_UNAVAILABLE' : 'CENTER_PAYMENT_NOT_RESOLVED',
      question,
      ...result,
      generatedBy: null,
      modelUsed: null,
      aiOpinion: null,
      citations: [],
      fallbackUsed: false,
      readOnly: true,
    })
  }
  if (result.qualityStatus === 'unavailable' && ['aph', 'collection', 'arrears', 'quality', 'overview'].includes(result.topic)) {
    return res.status(409).json({
      error: result.answer || '当前权限范围内没有通过真实性门禁的可用事实',
      code: 'ASSISTANT_DATA_UNAVAILABLE',
      question,
      ...result,
      generatedBy: null,
      modelUsed: null,
      aiOpinion: null,
      citations: [],
      fallbackUsed: false,
      readOnly: true,
    })
  }
  // 浏览器只提交受限历史；不复用 Hermes 服务端持久会话，避免请求间泄露旧事实。
  const safeHistory = result.centerPaymentLookup ? [] : history
  const orchestrated = await orchestrateAssistantAnswer({ question, evidence: result, context, history: safeHistory }, {
    knowledgeDbPath: process.env.NORTH_KNOWLEDGE_DB || '/home/ubuntu/cockpit-knowledge/index/knowledge.db',
    hermes: {
      baseUrl: process.env.HERMES_COCKPIT_BASE_URL || '',
      apiKey: process.env.HERMES_COCKPIT_API_KEY || '',
      model: process.env.HERMES_COCKPIT_MODEL || 'north-cockpit',
      // 经营诊断和制度知识问答都可能包含长正文与引用校验，统一留足时间；
      // 其他主题保持原超时，避免整体交互被慢请求拖长。
      timeoutMs: result.centerPaymentLookup === 'matched' || result.topic === 'knowledge' ? 170_000 : 35_000,
      // 每次语义校验重试至少预留一次完整模型调用时间，余额不足时转入既有修复或受控失败。
      minRetryBudgetMs: 100_000,
    },
  })
  logOperation(req, '华北经营助手提问', 'ai:regional-assistant', {
    topic: result.topic,
    modelUsed: orchestrated.modelUsed,
    generatedBy: orchestrated.generatedBy,
    citationCount: orchestrated.citations.length,
    qualityStatus: result.qualityStatus,
    questionLength: question.length,
    failureCode: orchestrated.failure?.code || null,
  })
  if (orchestrated.failure) {
    const status = orchestrated.failure.code === 'AI_GENERATION_UNAVAILABLE' ? 503 : 409
    return res.status(status).json({
      error: orchestrated.failure.message,
      code: orchestrated.failure.code,
      knowledgeChoices: orchestrated.failure.knowledgeChoices || [],
      question,
      ...result,
      answer: null,
      generatedBy: null,
      modelUsed: null,
      aiOpinion: null,
      citations: [],
      fallbackUsed: false,
      readOnly: true,
    })
  }
  res.json({
    question,
    ...result,
    answer: orchestrated.answer,
    generatedBy: orchestrated.generatedBy,
    modelUsed: orchestrated.modelUsed,
    aiOpinion: orchestrated.aiOpinion || null,
    citations: orchestrated.citations,
    fallbackUsed: false,
    readOnly: true,
  })
})

export default router
