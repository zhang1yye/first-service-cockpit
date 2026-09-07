import { Router } from 'express'
import db from '../db.js'
import { projectScopeWhere, canAccessProjectRow, denyScopedAccess, serviceCenterScopeWhere } from '../auth.js'
import { calculateRollingForecast } from '../rolling-forecast.js'
import { logOperation } from '../audit.js'
import { canWorkflowAction, transitionForecast, workflowLabel, validateForecastDiscipline } from '../forecast-workflow.js'
import { projectDataBlockedPayload, readProjectDataGate } from '../data-quality-gate.js'

const router = Router()
router.use('/api/forecasts', (_req, res, next) => {
  if (!readProjectDataGate(db).ready) return res.status(409).json(projectDataBlockedPayload(db))
  next()
})
const now = () => new Date().toISOString()
const actor = (req: any) => req.user?.username || 'system'

function scopedProjects(req: any, area: string) {
  const scope = projectScopeWhere(req), clauses: string[] = [], params: any[] = []
  if (area && area !== '全部' && area !== '华北') { clauses.push('area=?'); params.push(area) }
  if (scope.clause) { clauses.push(scope.clause); params.push(...scope.params) }
  return db.prepare(`SELECT * FROM projects ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY area,name`).all(...params) as any[]
}

function list(req: any, month: string, area: string) {
  const scope = serviceCenterScopeWhere(req, 'project_name', 'f'), clauses = ['f.month=?'], params: any[] = [month]
  if (area && area !== '全部' && area !== '华北') { clauses.push('f.area=?'); params.push(area) }
  if (scope.clause) { clauses.push(scope.clause); params.push(...scope.params) }
  const rows = db.prepare(`SELECT f.*,ROUND(f.forecast_income-f.annual_income,2) income_variance,ROUND(f.forecast_cost-f.annual_cost,2) cost_variance,ROUND(f.forecast_income-f.forecast_cost,2) forecast_profit,CASE WHEN f.forecast_income>0 THEN ROUND((f.forecast_income-f.forecast_cost)*100/f.forecast_income,2) END forecast_profit_rate FROM project_forecasts f WHERE ${clauses.join(' AND ')} ORDER BY income_variance ASC,f.area,f.project_name`).all(...params) as any[]
  const sum = (k: string) => rows.reduce((s, r) => s + Number(r[k] || 0), 0)
  const summary: any = { projects: rows.length, annualIncome: sum('annual_income'), annualCost: sum('annual_cost'), ytdIncome: sum('ytd_income'), ytdCost: sum('ytd_cost'), forecastIncome: sum('forecast_income'), forecastCost: sum('forecast_cost'), manual: rows.filter(r => r.method === 'manual-override').length, unknown: rows.filter(r => r.method === 'unknown').length }
  const workflow = rows.reduce((acc: any, row) => { const key = row.workflow_status || 'draft'; acc[key] = (acc[key] || 0) + 1; return acc }, { draft: 0, submitted: 0, area_approved: 0, region_approved: 0, rejected: 0, locked: 0 })
  const isAdmin=req.user?.role==='admin'
  const roleRows=isAdmin?db.prepare(`SELECT role,COUNT(*) count FROM users WHERE role IN ('project_manager','area_manager','region_manager','admin') GROUP BY role`).all() as any[]:[]
  const roles=isAdmin?Object.fromEntries(roleRows.map(x=>[x.role,Number(x.count)])):{}
  const required=['project_manager','area_manager','region_manager','admin'],missingRoles=isAdmin?required.filter(x=>!roles[x]):[]
  const unready=rows.filter(r=>!String(r.owner||'').trim()||r.owner==='待指定'||r.method==='unknown'||!String(r.data_source||'').trim()).length
  return { month, area, rows: rows.map(row => ({ ...row, workflow_label: workflowLabel[row.workflow_status || 'draft'] })), workflow, discipline:{strictSeparation:true,roles,missingRoles,roleReady:isAdmin&&missingRoles.length===0,unready,readyToSubmit:rows.length-unready}, summary: { ...summary, incomeVariance: summary.forecastIncome - summary.annualIncome, costVariance: summary.forecastCost - summary.annualCost, forecastProfit: summary.forecastIncome - summary.forecastCost, forecastProfitRate: summary.forecastIncome > 0 ? (summary.forecastIncome - summary.forecastCost) * 100 / summary.forecastIncome : 0 } }
}

function insertVersion(row: any, version: number, previous: string, status: string, action: string, note: string, req: any) {
  db.prepare(`INSERT INTO forecast_workflow_versions(forecast_id,month,project_id,project_name,version,previous_status,status,action,forecast_income,forecast_cost,explanation,owner,note,actor,actor_role,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.month, row.project_id, row.project_name, version, previous, status, action, row.forecast_income, row.forecast_cost, row.explanation || '', row.owner || '', note, actor(req), req.user?.role || '', now())
}
function ensureBaseline(row: any, req: any) {
  const found = db.prepare('SELECT 1 FROM forecast_workflow_versions WHERE forecast_id=? AND version=?').get(row.id, row.workflow_version || 1)
  if (!found) insertVersion(row, row.workflow_version || 1, '', row.workflow_status || 'draft', 'baseline', '审批启用时的预测基线', req)
}

router.get('/api/forecasts', (req, res) => {
  const month = String(req.query.month || new Date().toISOString().slice(0, 7))
  res.json(list(req, month, String(req.query.area || '华北')))
})

router.get('/api/forecasts/:id/versions', (req, res) => {
  const row = db.prepare('SELECT * FROM project_forecasts WHERE id=?').get(req.params.id) as any
  if (!row) return res.status(404).json({ error: '预测记录不存在' })
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(row.project_id)
  if (!project || !canAccessProjectRow(req, project)) return denyScopedAccess(req, res, '无权查看该项目预测版本')
  res.json({ forecastId: row.id, rows: db.prepare('SELECT * FROM forecast_workflow_versions WHERE forecast_id=? ORDER BY version DESC').all(row.id) })
})

router.post('/api/forecasts/refresh', (req, res) => {
  const month = String(req.body?.month || new Date().toISOString().slice(0, 7)), area = String(req.body?.area || '华北')
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: '月份格式必须为YYYY-MM' })
  const projects = scopedProjects(req, area), stamp = now(); let protectedRows = 0
  const upsert = db.prepare(`INSERT INTO project_forecasts(month,project_id,project_name,area,annual_income,annual_cost,ytd_income,ytd_cost,calculated_income,calculated_cost,forecast_income,forecast_cost,method,explanation,owner,data_source,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(month,project_id) DO UPDATE SET project_name=excluded.project_name,area=excluded.area,annual_income=excluded.annual_income,annual_cost=excluded.annual_cost,ytd_income=excluded.ytd_income,ytd_cost=excluded.ytd_cost,calculated_income=excluded.calculated_income,calculated_cost=excluded.calculated_cost,forecast_income=CASE WHEN project_forecasts.method='manual-override' THEN project_forecasts.forecast_income ELSE excluded.forecast_income END,forecast_cost=CASE WHEN project_forecasts.method='manual-override' THEN project_forecasts.forecast_cost ELSE excluded.forecast_cost END,method=CASE WHEN project_forecasts.method='manual-override' THEN project_forecasts.method ELSE excluded.method END,data_source=excluded.data_source,updated_at=excluded.updated_at`)
  db.transaction(() => projects.forEach(p => {
    const existing = db.prepare('SELECT * FROM project_forecasts WHERE month=? AND project_id=?').get(month, p.id) as any
    if (existing && !['draft', 'rejected'].includes(existing.workflow_status || 'draft')) { protectedRows++; return }
    const snap = db.prepare('SELECT * FROM project_monthly_snapshots WHERE month=? AND project_id=? ORDER BY id DESC LIMIT 1').get(month, p.id) as any
    const ytdIncome = snap ? snap.ytd_income : p.ytd_income, ytdCost = snap ? snap.ytd_cost : p.ytd_cost, source = snap ? `project_monthly_snapshots:${month}` : `projects.updated_at:${p.updated_at}`
    const f = calculateRollingForecast({ annualIncome: p.annual_income, annualCost: p.annual_cost, ytdIncome: ytdIncome ?? null, ytdCost: ytdCost ?? null, month })
    upsert.run(month, p.id, p.name, p.area, p.annual_income, p.annual_cost, ytdIncome, ytdCost, f.calculatedIncome, f.calculatedCost, f.forecastIncome, f.forecastCost, f.method, existing?.explanation || '', existing?.owner || '', source, actor(req), existing?.created_at || stamp, stamp)
  }))()
  logOperation(req, '刷新滚动预测基线', `forecast:${month}`, { area, projects: projects.length, protectedRows })
  res.json({ ...list(req, month, area), refresh: { projects: projects.length, protectedRows } })
})

router.put('/api/forecasts/:id', (req, res) => {
  if(String((req as any).user?.role||'')!=='project_manager')return res.status(403).json({error:'仅项目经理可调整预测草稿'})
  const row = db.prepare('SELECT * FROM project_forecasts WHERE id=?').get(req.params.id) as any
  if (!row) return res.status(404).json({ error: '预测记录不存在' })
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(row.project_id)
  if (!project || !canAccessProjectRow(req, project)) return denyScopedAccess(req, res, '无权修改该项目预测')
  if (!['draft', 'rejected'].includes(row.workflow_status || 'draft')) return res.status(409).json({ error: `当前状态${workflowLabel[row.workflow_status]}，禁止修改；请先完成审批或退回。` })
  try {
    const f = calculateRollingForecast({ annualIncome: row.annual_income, annualCost: row.annual_cost, ytdIncome: row.ytd_income, ytdCost: row.ytd_cost, month: row.month, manualIncome: req.body?.forecast_income, manualCost: req.body?.forecast_cost, explanation: req.body?.explanation })
    const owner = String(req.body?.owner || '').trim(); if (!owner) return res.status(400).json({ error: '责任人不能为空' })
    const version = Number(row.workflow_version || 1) + 1
    db.transaction(() => {
      ensureBaseline(row, req)
      db.prepare("UPDATE project_forecasts SET forecast_income=?,forecast_cost=?,method='manual-override',explanation=?,owner=?,workflow_status='draft',workflow_version=?,last_action_note='',updated_at=? WHERE id=?").run(f.forecastIncome, f.forecastCost, f.explanation, owner, version, now(), row.id)
      insertVersion({ ...row, forecast_income: f.forecastIncome, forecast_cost: f.forecastCost, explanation: f.explanation, owner }, version, row.workflow_status || 'draft', 'draft', 'edit', '人工调整预测', req)
    })()
    logOperation(req, '人工调整滚动预测', `forecast:${row.id}`, { month: row.month, projectId: row.project_id, owner, explanation: f.explanation, version })
    res.json(list(req, row.month, '华北'))
  } catch (e: any) { res.status(400).json({ error: e.message }) }
})

router.post('/api/forecasts/:id/workflow', (req, res) => {
  const row = db.prepare('SELECT * FROM project_forecasts WHERE id=?').get(req.params.id) as any
  if (!row) return res.status(404).json({ error: '预测记录不存在' })
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(row.project_id)
  if (!project || !canAccessProjectRow(req, project)) return denyScopedAccess(req, res, '无权处理该项目预测')
  const action = String(req.body?.action || ''), role = String((req as any).user?.role || ''), note = String(req.body?.note || '').trim()
  if (!canWorkflowAction(role, action)) return res.status(403).json({ error: '当前角色无权执行该审批动作' })
  const disciplineError=validateForecastDiscipline(row,action,{username:actor(req),role},note)
  if(disciplineError)return res.status(400).json({error:disciplineError})
  try {
    const transition = transitionForecast(row.workflow_status || 'draft', action), version = Number(row.workflow_version || 1) + 1, stamp = now()
    db.transaction(() => {
      ensureBaseline(row, req)
      const fields: string[] = ['workflow_status=?', 'workflow_version=?', 'last_action_note=?', 'updated_at=?'], values: any[] = [transition.next, version, note, stamp]
      if (action === 'submit') { fields.push('submitted_by=?', 'submitted_at=?',"area_reviewed_by=''","area_reviewed_at=''","region_reviewed_by=''","region_reviewed_at=''","locked_by=''","locked_at=''"); values.push(actor(req), stamp) }
      if (action.startsWith('area_')) { fields.push('area_reviewed_by=?', 'area_reviewed_at=?'); values.push(actor(req), stamp) }
      if (action.startsWith('region_')) { fields.push('region_reviewed_by=?', 'region_reviewed_at=?'); values.push(actor(req), stamp) }
      if (action === 'lock') { fields.push('locked_by=?', 'locked_at=?'); values.push(actor(req), stamp) }
      values.push(row.id); db.prepare(`UPDATE project_forecasts SET ${fields.join(',')} WHERE id=?`).run(...values)
      insertVersion(row, version, transition.previous, transition.next, action, note, req)
    })()
    logOperation(req, '滚动预测审批', `forecast:${row.id}`, { action, previous: transition.previous, next: transition.next, note, version })
    res.json(list(req, row.month, '华北'))
  } catch (e: any) { res.status(409).json({ error: e.message }) }
})

export default router
