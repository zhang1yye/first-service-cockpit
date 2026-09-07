import { Router } from 'express'
import db from '../db.js'
import { getAreaScope, getProjectScope, projectScopeWhere } from '../auth.js'
import { logOperationStrict } from '../audit.js'
import { projectDataBlockedPayload, readProjectDataGate } from '../data-quality-gate.js'

const router = Router()

function exportAuditDetail(req: any, page: string, area: string, rowCount: number, format: string, fileName = '') {
  return {
    page,
    requestedArea: area || '全部',
    areaScope: getAreaScope(req.user),
    projectScope: getProjectScope(req.user),
    rowCount,
    format,
    fileName,
    result: 'success',
  }
}

// ─── CSV 导出（项目管理页）───────────────────────────
router.get('/api/export/projects-csv', (req, res) => {
  const operatingGate = readProjectDataGate(db)
  if (!operatingGate.ready) return res.status(409).json(projectDataBlockedPayload(db))
  const area = req.query.area as string | undefined
  const scope = projectScopeWhere(req)
  const clauses: string[] = ["COALESCE(active_status,'active')='active'"]
  const params: any[] = []
  if (area && area !== '全部') { clauses.push('area = ?'); params.push(area) }
  if (scope.clause) { clauses.push(scope.clause); params.push(...scope.params) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM projects ${where} ORDER BY area, name`).all(...params)

  const headers = ['片区', '项目名称', '面积(m²)', '户数', '物业类型', '在管人数',
    '年度收入(万)', '年度成本(万)', '累计收入(万)', '累计成本(万)',
    '应收(万)', '实收(万)', '收费率', '品质评分', '安全事故', '客户满意度', '投诉数', '数据状态', '来源批次']

  const optional = (value: unknown) => value === null || value === undefined ? '' : value
  const csvCell = (value: unknown) => {
    const text = String(optional(value))
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }

  const csvRows = (rows as any[]).map((r: any) => {
    const rate = Number.isFinite(r.official_collection_rate)
      ? (Number(r.official_collection_rate) * 100).toFixed(2)
      : ''
    return [
      r.area, r.name, optional(r.area_sqm), optional(r.units), r.property_type, optional(r.staff_count),
      optional(r.annual_income), optional(r.annual_cost), optional(r.ytd_income), optional(r.ytd_cost),
      optional(r.receivable), optional(r.received), rate,
      optional(r.quality_score), optional(r.safety_incidents), optional(r.customer_satisfaction), optional(r.complaint_count),
      r.validation_status === 'directory_only' ? '仅项目目录' : '经营事实已验证', r.source_batch || '',
    ]
  })

  const bom = '\uFEFF'
  const csv = bom + [headers, ...csvRows].map((row: any[]) => row.map(csvCell).join(',')).join('\n')

  const fileName = `项目管理_${new Date().toISOString().slice(0, 10)}.csv`
  try {
    // 敏感导出必须先取得审计回执，再开始写响应头和CSV正文。
    logOperationStrict(req, '导出项目CSV', 'export:projects-csv', exportAuditDetail(req, '项目管理', area || '全部', (rows as any[]).length, 'csv', fileName))
  } catch {
    return res.status(503).json({ error: '导出审计写入失败，未生成CSV', code: 'AUDIT_WRITE_FAILED' })
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename=projects_${new Date().toISOString().slice(0, 10)}.csv; filename*=UTF-8''${encodeURIComponent(fileName)}`)
  res.send(csv)
})

// 旧月报导出直接读取当前 projects，无法证明指定期间、快照来源和预测审批状态。
// 为避免绕过正式输出门禁，统一退役并引导到 /api/formal-outputs/generate。
router.use(['/api/export/report', '/api/export/monthly-report-doc'], (_req, res) => {
  res.status(410).json({
    error: '旧月报导出已停用，请使用正式输出中心生成经过期间快照和预测审批校验的月报',
    code: 'LEGACY_MONTHLY_EXPORT_DISABLED',
    replacement: '/api/formal-outputs/generate',
  })
})

export default router
