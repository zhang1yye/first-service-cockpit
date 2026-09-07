import { Router } from 'express'
import db from '../db.js'
import { canAccessServiceCenter, serviceCenterScopeWhere } from '../auth.js'
import { getFormalCollectionDataset } from '../collection-dataset.js'
import { readProjectDirectoryStatus } from '../project-directory.js'
import { buildOperatingCapabilities } from '../operating-capabilities.js'
import { buildResponseContext } from '../response-context.js'
import { COLLECTION_MAX_AGE_HOURS } from '../collection-quality.js'
import { evaluateAphCenterCoverage } from '../data-pipeline.js'
import { applyEffectiveMasterState } from '../service-center-master.js'


const router = Router()

router.get('/api/operating-capabilities', (req, res) => {
  const centerScope = serviceCenterScopeWhere(req, 'center')
  const scopedPayments = db.prepare(`SELECT center,area FROM payment_centers ${centerScope.clause ? `WHERE ${centerScope.clause}` : ''}`)
    .all(...centerScope.params) as Array<{ center: string | null; area: string | null }>
  const paymentCenters = applyEffectiveMasterState(scopedPayments) as Array<{ center: string | null; area: string | null }>
  const payment = { count: paymentCenters.length }
  const activeCenterNames = paymentCenters.map(row => String(row.center || '')).filter(Boolean)
  const activeCenterWhere = activeCenterNames.length ? `center IN (${activeCenterNames.map(() => '?').join(',')})` : '1=0'
  const latestDailyDate = db.prepare(`SELECT MAX(COALESCE(NULLIF(TRIM(business_date),''),NULLIF(TRIM(date),''))) AS businessDate
    FROM daily_snapshots WHERE ${activeCenterWhere}`)
    .get(...activeCenterNames) as { businessDate: string | null }
  const latestDaily = latestDailyDate?.businessDate
    ? db.prepare(`SELECT
        SUM(CASE WHEN quality_status='verified' AND source_status='available' THEN 1 ELSE 0 END) AS verifiedCount,
        MIN(last_validated_at) AS firstValidatedAt, MAX(last_validated_at) AS lastValidatedAt,
        SUM(CASE WHEN quality_status<>'verified' OR source_status<>'available'
          OR COALESCE(NULLIF(TRIM(business_date),''),NULLIF(TRIM(date),'')) IS NULL
          OR julianday(COALESCE(NULLIF(TRIM(business_date),''),NULLIF(TRIM(date),''))) IS NULL
          OR last_validated_at IS NULL OR TRIM(last_validated_at)=''
          OR julianday(last_validated_at) IS NULL
          THEN 1 ELSE 0 END) AS invalidCount
        FROM daily_snapshots
        WHERE COALESCE(NULLIF(TRIM(business_date),''),NULLIF(TRIM(date),''))=? AND ${activeCenterWhere}`)
      .get(latestDailyDate.businessDate, ...activeCenterNames) as { verifiedCount: number; firstValidatedAt: string | null; lastValidatedAt: string | null; invalidCount: number }
    : { verifiedCount: 0, firstValidatedAt: null, lastValidatedAt: null, invalidCount: 0 }
  const firstValidatedMs = latestDaily.firstValidatedAt ? Date.parse(latestDaily.firstValidatedAt) : Number.NaN
  const lastValidatedMs = latestDaily.lastValidatedAt ? Date.parse(latestDaily.lastValidatedAt) : Number.NaN
  const businessDateMs = latestDailyDate.businessDate ? Date.parse(latestDailyDate.businessDate) : Number.NaN
  const maximumAgeMs = COLLECTION_MAX_AGE_HOURS * 60 * 60 * 1000
  const now = Date.now()
  const aphStale = !Number.isFinite(businessDateMs) || !Number.isFinite(firstValidatedMs) || !Number.isFinite(lastValidatedMs)
    || now - businessDateMs > maximumAgeMs
    || now - firstValidatedMs > maximumAgeMs
    || businessDateMs > now + 5 * 60 * 1000
    || lastValidatedMs > now + 5 * 60 * 1000
  const verifiedDailyCenters = latestDailyDate.businessDate
    ? db.prepare(`SELECT center FROM daily_snapshots
        WHERE COALESCE(NULLIF(TRIM(business_date),''),NULLIF(TRIM(date),''))=?
          AND quality_status='verified' AND source_status='available' AND ${activeCenterWhere}`)
      .all(latestDailyDate.businessDate, ...activeCenterNames) as Array<{ center: string | null }>
    : []
  const aphCenterCoverage = evaluateAphCenterCoverage(paymentCenters, verifiedDailyCenters)
  const aphCoverageComplete = aphCenterCoverage.valid && aphCenterCoverage.paymentUniqueCount > 0

  const formal = getFormalCollectionDataset()
  const scopedCollectionRows = applyEffectiveMasterState(formal.dataset?.rows || [])
    .filter(row => canAccessServiceCenter(req, row.center))
  const directory = readProjectDirectoryStatus(db)
  const capabilities = buildOperatingCapabilities({
    aph: {
      paymentCenterCount: Number(payment?.count || 0),
      verifiedDailyCenterCount: Number(latestDaily?.verifiedCount || 0),
      coverageComplete: aphCoverageComplete,
      businessDate: latestDailyDate?.businessDate || null,
      lastValidatedAt: latestDaily?.lastValidatedAt || null,
      qualityStatus: Number(latestDaily.invalidCount || 0) === 0 ? 'verified' : 'invalid',
      sourceStatus: Number(latestDaily.invalidCount || 0) === 0 ? 'available' : 'invalid',
      stale: aphStale,
    },
    lvzai: {
      scopedCenterCount: scopedCollectionRows.length,
      publicationStatus: formal.publication.publicationStatus,
      businessDate: formal.publication.businessDate,
      lastValidatedAt: formal.publication.lastValidatedAt,
      sourceStatus: formal.publication.sourceStatus,
      stale: formal.publication.stale,
    },
    projectDirectory: {
      ready: directory.ready,
      projectCount: Number(directory.projectCount || 0),
    },
  })

  res.set('Cache-Control', 'no-store')
  res.json({
    ...capabilities,
    meta: buildResponseContext(req, {
      businessDate: latestDailyDate?.businessDate || formal.publication.businessDate,
      extractedAt: latestDaily?.lastValidatedAt || formal.publication.lastValidatedAt,
      sources: ['APH回款', '绿仔正式收缴批次', '权威项目目录'],
      publicationStatus: capabilities.status === 'ready' ? 'published' : capabilities.status === 'partial' ? 'previewed' : 'blocked',
      qualityStatus: capabilities.status,
      qualityMessage: capabilities.status === 'ready'
        ? 'APH与绿仔在当前授权范围均可用'
        : capabilities.status === 'partial' ? '当前授权范围只有部分正式来源可用' : '当前授权范围没有可用经营来源',
      canWrite: false,
      canExport: false,
    }),
  })
})

export default router
