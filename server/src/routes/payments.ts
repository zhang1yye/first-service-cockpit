import { Router, type Request, type Response } from 'express'
import db from '../db.js'
import { canAccessServiceCenter, denyScopedAccess, requireManager, serviceCenterScopeWhere } from '../auth.js'
import { calculateGrowth, canUseManualBusinessWrites, readOptionalNumber } from '../production-safety.js'
import { applyEffectiveMasterState } from '../service-center-master.js'
import { hasRegionWideReadAccess } from '../user-access.js'

const router = Router()

type PaymentCenterScope = { clause: string; params: string[] }

function sendPaymentRows(req: Request, res: Response, centerScope: PaymentCenterScope) {
  const area = req.query.area as string | undefined
  let sql = `
    SELECT
      id,
      area,
      center,
      annual_budget        AS annualBudget,
      cumulative_budget    AS cumulativeBudget,
      cumulative_executed  AS cumulativeExecuted,
      same_period          AS samePeriod,
      collection_rate      AS collectionRate
      ,version
      ,updated_at          AS updatedAt
    FROM payment_centers
  `
  if (centerScope.clause) sql += ` WHERE ${centerScope.clause}`
  sql += ' ORDER BY cumulative_executed DESC'

  const rows = applyEffectiveMasterState(db.prepare(sql).all(...centerScope.params) as any[])
    .filter(row => !area || area === '全部' || row.area === area)
  res.json(rows.map((row) => {
    // 来源已验证的 0 和负数可能代表冲销/退款，必须保留；只有缺失或非法值才标为空。
    const samePeriod = readOptionalNumber(row.samePeriod)
    const growth = calculateGrowth(row.cumulativeExecuted, samePeriod)
    return {
      ...row,
      samePeriod,
      samePeriodStatus: samePeriod === null ? 'missing-or-unverified' : 'available',
      diff: row.cumulativeBudget - row.cumulativeExecuted,
      executionVariance: row.cumulativeExecuted - row.cumulativeBudget,
      annualRate: row.annualBudget > 0 ? Math.round((row.cumulativeExecuted / row.annualBudget) * 10000) / 10000 : null,
      cumulativeRate: row.cumulativeBudget > 0 ? Math.round((row.cumulativeExecuted / row.cumulativeBudget) * 10000) / 10000 : null,
      growth: growth === null ? null : Math.round(growth * 10000) / 10000,
    }
  }))
}

/** 首页是华北经营公共视图，所有已认证账号读取同一正式范围。 */
router.get('/api/home/payments', (req, res) => {
  sendPaymentRows(req, res, { clause: '', params: [] })
})

/** 回款明细保持原授权：华北全域角色读全量，其他成员按服务中心读取。 */
router.get('/api/payments', (req, res) => {
  const centerScope = hasRegionWideReadAccess((req as any).user?.role)
    ? { clause: '', params: [] as string[] }
    : serviceCenterScopeWhere(req, 'center')
  sendPaymentRows(req, res, centerScope)
})

/**
 * PUT /api/payments/:id
 * 更新单条回款额数据
 */
router.put('/api/payments/:id', requireManager, (req, res) => {
  if (!canUseManualBusinessWrites()) {
    return res.status(403).json({
      error: '正式回款事实默认只读；请通过P46受控批次更新，仅隔离环境显式开启后可手工调试。',
      code: 'FORMAL_PAYMENT_READ_ONLY',
      replacement: '/api/data-pipeline/preview',
    })
  }
  const { id } = req.params
  const {
    annualBudget, cumulativeBudget, cumulativeExecuted,
    samePeriod, collectionRate,
  } = req.body

  const existing = db.prepare('SELECT * FROM payment_centers WHERE id = ?').get(Number(id)) as any
  if (!existing) {
    res.status(404).json({ error: '记录不存在' })
    return
  }
  if (!canAccessServiceCenter(req, existing.center)) return denyScopedAccess(req, res, '无权修改该服务中心回款数据')

  const version = Number(req.body?.version)
  if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: '缺少有效版本号，请刷新后重试' })
  const numericFields: Array<[string, unknown, { min?: number; max?: number }]> = [
    ['annualBudget', annualBudget, { min: 0 }],
    ['cumulativeBudget', cumulativeBudget, { min: 0 }],
    // 已验证的负数可表示冲销或退款，只拒绝非有限数值。
    ['cumulativeExecuted', cumulativeExecuted, {}],
    ['samePeriod', samePeriod, {}],
    // payment_centers沿用APH百分数口径（例如3.46表示3.46%），不是0~1的小数比率。
    ['collectionRate', collectionRate, { min: 0, max: 100 }],
  ]
  if (!numericFields.some(([, value]) => value !== undefined && value !== null)) {
    return res.status(400).json({ error: '至少提交一个需要修改的回款字段' })
  }
  for (const [field, value, range] of numericFields) {
    if (value === undefined || value === null) continue
    const parsed = Number(value)
    if (!Number.isFinite(parsed)
      || (range.min !== undefined && parsed < range.min)
      || (range.max !== undefined && parsed > range.max)) {
      return res.status(400).json({ error: `${field}数值超出有效范围` })
    }
  }

  const current = db.transaction(() => {
    const changed = db.prepare(`
      UPDATE payment_centers SET
        annual_budget = COALESCE(?, annual_budget),
        cumulative_budget = COALESCE(?, cumulative_budget),
        cumulative_executed = COALESCE(?, cumulative_executed),
        same_period = COALESCE(?, same_period),
        collection_rate = COALESCE(?, collection_rate),
        version = version + 1,
        updated_at = datetime('now','localtime')
      WHERE id = ? AND version = ?
    `).run(annualBudget ?? null, cumulativeBudget ?? null, cumulativeExecuted ?? null, samePeriod ?? null, collectionRate ?? null, Number(id), version)
    if (changed.changes !== 1) return null
    const after = db.prepare('SELECT * FROM payment_centers WHERE id=?').get(Number(id)) as any
    const user = (req as any).user || {}
    db.prepare('INSERT INTO operation_logs (user_id,username,action,target,detail,ip) VALUES (?,?,?,?,?,?)').run(
      user.userId || null,
      user.username || 'system',
      '修改回款数据',
      `payment:${id}`,
      JSON.stringify({
        service_center: existing.center,
        before: { annualBudget: existing.annual_budget, cumulativeBudget: existing.cumulative_budget, cumulativeExecuted: existing.cumulative_executed, samePeriod: existing.same_period, collectionRate: existing.collection_rate, version: existing.version },
        after: { annualBudget: after.annual_budget, cumulativeBudget: after.cumulative_budget, cumulativeExecuted: after.cumulative_executed, samePeriod: after.same_period, collectionRate: after.collection_rate, version: after.version },
      }),
      req.ip || '',
    )
    return after
  })()

  if (!current) return res.status(409).json({ error: '数据已被其他人修改，请刷新后重试' })

  res.json({ success: true, id: Number(id), version: current.version, updatedAt: current.updated_at })
})

export default router
