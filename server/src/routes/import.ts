import { Router } from 'express'
import multer from 'multer'
import { readFileSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import db from '../db.js'
import { logOperation } from '../audit.js'
import { canUseDemoData, canUseManualImport } from '../production-safety.js'
import { demoProjectNames } from '../data-quality-gate.js'

const require = createRequire(import.meta.url)
const XLSX = require('@e965/xlsx')

const router = Router()
const upload = multer({ dest: '/tmp/cockpit-uploads/', limits: { fileSize: 10 * 1024 * 1024, files: 1 } })

type HealthItem = { level: 'info' | 'warning' | 'danger' | 'success'; title: string; detail: string }
type ColumnMapping = { source: string; target: string; label: string }


const demoProjects = [
  { area: '朝阳片区', name: '朝阳万国城MOMΛ', area_sqm: 182000, units: 1680, property_type: '住宅', staff_count: 85, annual_income: 3200, annual_cost: 2480, ytd_income: 1850, ytd_cost: 1420, receivable: 1650, received: 1520, quality_score: 92, safety_incidents: 0, customer_satisfaction: 88, complaint_count: 12 },
  { area: '朝阳片区', name: '朝阳当代MOMΛ', area_sqm: 145000, units: 1320, property_type: '住宅', staff_count: 68, annual_income: 2650, annual_cost: 2050, ytd_income: 1530, ytd_cost: 1180, receivable: 1380, received: 1250, quality_score: 89, safety_incidents: 0, customer_satisfaction: 85, complaint_count: 18 },
  { area: '京东片区', name: '通州万国城MOMΛ', area_sqm: 210000, units: 1950, property_type: '住宅', staff_count: 92, annual_income: 3800, annual_cost: 2950, ytd_income: 2200, ytd_cost: 1700, receivable: 1950, received: 1780, quality_score: 91, safety_incidents: 1, customer_satisfaction: 86, complaint_count: 22 },
  { area: '京东片区', name: '亦庄创意生活广场', area_sqm: 68000, units: 0, property_type: '商业', staff_count: 45, annual_income: 1800, annual_cost: 1420, ytd_income: 1050, ytd_cost: 820, receivable: 920, received: 780, quality_score: 85, safety_incidents: 0, customer_satisfaction: 82, complaint_count: 8 },
  { area: '海淀片区', name: '海淀西山上品湾MOMΛ', area_sqm: 165000, units: 1520, property_type: '住宅', staff_count: 78, annual_income: 2950, annual_cost: 2280, ytd_income: 1700, ytd_cost: 1310, receivable: 1520, received: 1400, quality_score: 93, safety_incidents: 0, customer_satisfaction: 90, complaint_count: 6 },
  { area: '海淀片区', name: '上第MOMΛ', area_sqm: 135000, units: 1280, property_type: '住宅', staff_count: 62, annual_income: 2480, annual_cost: 1920, ytd_income: 1430, ytd_cost: 1100, receivable: 1280, received: 1160, quality_score: 88, safety_incidents: 0, customer_satisfaction: 84, complaint_count: 15 },
  { area: '顺平片区', name: '顺义MOMΛ万万树', area_sqm: 95000, units: 520, property_type: '别墅', staff_count: 48, annual_income: 2200, annual_cost: 1750, ytd_income: 1280, ytd_cost: 1010, receivable: 1150, received: 1020, quality_score: 90, safety_incidents: 0, customer_satisfaction: 89, complaint_count: 5 },
  { area: '河北片区', name: '石家庄当代府MOMΛ', area_sqm: 128000, units: 1180, property_type: '住宅', staff_count: 58, annual_income: 2350, annual_cost: 1820, ytd_income: 1360, ytd_cost: 1050, receivable: 1220, received: 1080, quality_score: 86, safety_incidents: 0, customer_satisfaction: 83, complaint_count: 20 },
  { area: '河北片区', name: '天津海河大观', area_sqm: 156000, units: 1420, property_type: '住宅', staff_count: 72, annual_income: 2780, annual_cost: 2150, ytd_income: 1610, ytd_cost: 1240, receivable: 1450, received: 1320, quality_score: 87, safety_incidents: 1, customer_satisfaction: 84, complaint_count: 16 },
  { area: '辽宁片区', name: '沈阳当代RIVER MOMΛ', area_sqm: 112000, units: 1050, property_type: '住宅', staff_count: 52, annual_income: 2050, annual_cost: 1620, ytd_income: 1190, ytd_cost: 930, receivable: 1080, received: 950, quality_score: 84, safety_incidents: 0, customer_satisfaction: 81, complaint_count: 24 },
]

function getCurrentProjects(): any[] {
  return db.prepare(`
    SELECT area, name, area_sqm, units, property_type, staff_count,
      annual_income, annual_cost, ytd_income, ytd_cost, receivable, received,
      quality_score, safety_incidents, customer_satisfaction, complaint_count,
      source_system, active_status, validation_status, source_batch
    FROM projects ORDER BY id
  `).all() as any[]
}

function createProjectBackup(source: string): { id: number | null; rowCount: number } {
  const rows = getCurrentProjects()
  if (rows.length === 0) return { id: null, rowCount: 0 }
  const result = db.prepare('INSERT INTO project_backups (source, row_count, payload) VALUES (?, ?, ?)')
    .run(source, rows.length, JSON.stringify(rows))
  return { id: Number(result.lastInsertRowid), rowCount: rows.length }
}

type InsertProjectOptions = {
  backupSource?: string
  sourceSystem?: string
  validationStatus?: 'verified' | 'unverified'
  sourceBatch?: string
  preserveTrust?: boolean
}

function insertProjects(projects: any[], options: InsertProjectOptions = {}) {
  if (!Array.isArray(projects) || projects.length === 0) throw new Error('没有可导入的项目数据')
  const backup = options.backupSource ? createProjectBackup(options.backupSource) : { id: null, rowCount: 0 }
  const insert = db.prepare(`
    INSERT INTO projects (area, name, area_sqm, units, property_type, staff_count,
      annual_income, annual_cost, ytd_income, ytd_cost, receivable, received,
      quality_score, safety_incidents, customer_satisfaction, complaint_count,
      project_code, source_system, active_status, validation_status, source_batch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `)
  const tx = db.transaction((rows: any[]) => {
    db.prepare('DELETE FROM projects').run()
    for (const p of rows) insert.run(
      p.area || '', p.name || '', p.area_sqm, p.units,
      p.property_type || '住宅', p.staff_count,
      p.annual_income, p.annual_cost, p.ytd_income, p.ytd_cost,
      p.receivable, p.received,
      p.quality_score, p.safety_incidents ?? null,
      p.customer_satisfaction, p.complaint_count ?? null,
      options.preserveTrust ? (p.source_system || 'cockpit-import') : (options.sourceSystem || 'cockpit-import'),
      options.preserveTrust ? (p.active_status || 'active') : 'active',
      options.preserveTrust ? (p.validation_status || 'unverified') : (options.validationStatus || 'unverified'),
      options.preserveTrust ? (p.source_batch || '') : (options.sourceBatch || '')
    )
    db.prepare("UPDATE projects SET project_code='HB-' || printf('%04d',id) WHERE COALESCE(project_code,'')=''").run()
  })
  tx(projects)
  return backup
}

function projectTrustError(rows: any[]): string | null {
  const demos = demoProjectNames(rows)
  if (demos.length) return `检测到内置演示项目指纹：${demos.join('、')}`
  const unverified = rows.filter(row => row.validation_status !== 'verified' || !String(row.source_batch || '').trim())
  if (unverified.length) return `备份中有${unverified.length}条项目缺少已验证来源或来源批次`
  return null
}

const fieldMap: Record<string, string> = {
  '片区': 'area', '地区': 'area', '所属片区': 'area',
  '项目名称': 'name', '项目': 'name', '名称': 'name',
  '面积': 'area_sqm', '建筑面积': 'area_sqm', '总面积': 'area_sqm', '管理面积': 'area_sqm',
  '户数': 'units', '总户数': 'units', '在管户数': 'units',
  '业态': 'property_type', '物业类型': 'property_type',
  '在管人数': 'staff_count', '员工数': 'staff_count', '人员': 'staff_count',
  '年度收入': 'annual_income', '年收入': 'annual_income',
  '年度成本': 'annual_cost', '年成本': 'annual_cost',
  '累计收入': 'ytd_income', 'YTD收入': 'ytd_income',
  '累计成本': 'ytd_cost', 'YTD成本': 'ytd_cost',
  '应收': 'receivable', '应收账款': 'receivable',
  '实收': 'received', '已收': 'received', '实收金额': 'received',
  '品质评分': 'quality_score', '品质': 'quality_score',
  '安全事故': 'safety_incidents', '事故数': 'safety_incidents',
  '客户满意度': 'customer_satisfaction', '满意度': 'customer_satisfaction',
  '投诉数': 'complaint_count', '投诉': 'complaint_count', '投诉量': 'complaint_count',
}

const fieldLabels: Record<string, string> = {
  area: '片区', name: '项目名称', area_sqm: '管理面积', units: '户数', property_type: '物业类型',
  staff_count: '在管人数', annual_income: '年度收入', annual_cost: '年度成本', ytd_income: '累计收入',
  ytd_cost: '累计成本', receivable: '应收', received: '实收', quality_score: '品质评分',
  safety_incidents: '安全事故', customer_satisfaction: '客户满意度', complaint_count: '投诉数',
}

function parseCsv(text: string): any[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []
  const parseLine = (line: string) => {
    const out: string[] = []
    let cur = '', inQuote = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue }
      if (ch === '"') { inQuote = !inQuote; continue }
      if (ch === ',' && !inQuote) { out.push(cur.trim()); cur = ''; continue }
      cur += ch
    }
    out.push(cur.trim())
    return out
  }
  const headers = parseLine(lines[0]).map(h => h.replace(/"/g, '').trim())
  return lines.slice(1).map(line => {
    const vals = parseLine(line)
    const obj: any = {}
    headers.forEach((h, i) => { obj[h] = vals[i] || '' })
    return obj
  })
}

function parseExcel(path: string): any[] {
  const workbook = XLSX.readFile(path, { cellDates: false })
  const firstSheet = workbook.SheetNames[0]
  if (!firstSheet) return []
  return XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: '', raw: false }) as any[]
}

function parseNumber(value: any): number | null {
  if (value === undefined || value === null || value === '') return null
  let text = String(value).trim().replace(/,/g, '').replace(/，/g, '')
  if (!text) return null
  if (text.endsWith('%')) {
    const n = Number(text.slice(0, -1))
    return Number.isFinite(n) ? n : null
  }
  const n = Number(text)
  if (!Number.isFinite(n)) return null
  return n
}

function buildMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {}
  for (const [cnKey, enKey] of Object.entries(fieldMap)) {
    for (const header of headers) {
      if (mapping[enKey]) continue
      if (header.includes(cnKey)) mapping[enKey] = header
    }
  }
  return mapping
}

function duplicateHints(names: string[]): string[] {
  const normalize = (s: string) => s.replace(/[\s\-—_（）()\.·]/g, '').replace(/Λ/g, 'A').replace(/MOM[AΑΛ]/gi, 'MOMA').toLowerCase()
  const seen = new Map<string, string>()
  const hints: string[] = []
  for (const n of names.filter(Boolean)) {
    const key = normalize(n)
    if (seen.has(key) && seen.get(key) !== n) hints.push(`“${seen.get(key)}”与“${n}”疑似同一项目，建议核对是否重复`)
    else seen.set(key, n)
  }
  return hints.slice(0, 5)
}

function analyzeRows(filename: string, rows: any[]) {
  const headers = Object.keys(rows[0] || {})
  const mapping = buildMapping(headers)
  const mappings: ColumnMapping[] = Object.entries(mapping).map(([target, source]) => ({ target, source, label: fieldLabels[target] || target }))
  const errors: string[] = []
  const healthItems: HealthItem[] = []
  const missingFields = ['area', 'name', 'receivable', 'received', 'quality_score', 'customer_satisfaction'].filter(f => !mapping[f])
  if (missingFields.length > 0) healthItems.push({ level: 'warning', title: '字段完整性', detail: `未识别到 ${missingFields.map(f => fieldLabels[f]).join('、')} 等字段，相关指标将为空或无法计算。` })

  let imported = 0
  let skipped = 0
  const names: string[] = []
  const numericIssues: string[] = []
  const logicIssues: string[] = []
  const extremeIssues: string[] = []
  const unitIssues: string[] = []
  const validatedProjects: any[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const mapped: any = {}
    for (const [enKey, header] of Object.entries(mapping)) mapped[enKey] = row[header]

    if (!mapped.name) { skipped++; errors.push(`第${i + 2}行：缺少项目名称`); continue }
    if (!mapped.area) { skipped++; errors.push(`第${i + 2}行(${mapped.name})：缺少片区`); continue }
    names.push(mapped.name)

    const numFields = ['area_sqm', 'units', 'staff_count', 'annual_income', 'annual_cost',
      'ytd_income', 'ytd_cost', 'receivable', 'received', 'quality_score',
      'safety_incidents', 'customer_satisfaction', 'complaint_count']
    for (const f of numFields) {
      const raw = mapped[f]
      mapped[f] = parseNumber(raw)
      if (raw !== undefined && raw !== '' && mapped[f] === null) numericIssues.push(`第${i + 2}行(${mapped.name})：${fieldLabels[f]}“${raw}”无法识别为数字`)
    }

    if ((mapped.ytd_cost ?? 0) > 0 && (mapped.ytd_income ?? 0) > 0 && mapped.ytd_cost > mapped.ytd_income) logicIssues.push(`${mapped.name} 累计成本大于累计收入`)
    if ((mapped.received ?? 0) > (mapped.receivable ?? 0) && (mapped.receivable ?? 0) > 0) logicIssues.push(`${mapped.name} 实收大于应收`)
    if ((mapped.quality_score ?? 0) > 100 || (mapped.customer_satisfaction ?? 0) > 100) logicIssues.push(`${mapped.name} 品质/满意度超过100`)
    if ((mapped.safety_incidents ?? 0) < 0 || (mapped.complaint_count ?? 0) < 0) logicIssues.push(`${mapped.name} 安全事故或投诉量为负数`)
    if ((mapped.area_sqm ?? 0) > 1000000) extremeIssues.push(`${mapped.name} 建筑面积超过100万㎡，建议确认单位`)
    if ((mapped.annual_income ?? 0) > 100000 || (mapped.receivable ?? 0) > 100000) unitIssues.push(`${mapped.name} 金额超过10亿元口径，建议确认是否为“元”而非“万元”`)
    if ((mapped.staff_count ?? 0) > 0 && (mapped.area_sqm ?? 0) > 0 && mapped.area_sqm / mapped.staff_count < 200) extremeIssues.push(`${mapped.name} 人均管理面积偏低，建议核对在管人数或面积`)

    validatedProjects.push({
      area: mapped.area || '', name: mapped.name || '', area_sqm: mapped.area_sqm, units: mapped.units,
      property_type: mapped.property_type || '住宅', staff_count: mapped.staff_count,
      annual_income: mapped.annual_income, annual_cost: mapped.annual_cost, ytd_income: mapped.ytd_income, ytd_cost: mapped.ytd_cost,
      receivable: mapped.receivable, received: mapped.received,
      quality_score: mapped.quality_score, safety_incidents: mapped.safety_incidents ?? null,
      customer_satisfaction: mapped.customer_satisfaction, complaint_count: mapped.complaint_count ?? null
    })
    imported++
  }

  const dupHints = duplicateHints(names)
  if (mappings.length > 0) healthItems.unshift({ level: 'success', title: 'AI列名识别', detail: `已自动识别 ${mappings.length} 个字段：${mappings.slice(0, 8).map(m => `${m.source}→${m.label}`).join('，')}${mappings.length > 8 ? '等' : ''}。` })
  if (numericIssues.length > 0) healthItems.push({ level: 'warning', title: '数值格式异常', detail: `${numericIssues.length} 处数值无法识别，已置为空值；示例：${numericIssues.slice(0, 3).join('；')}` })
  if (logicIssues.length > 0) healthItems.push({ level: 'danger', title: '经营逻辑异常', detail: logicIssues.slice(0, 5).join('；') })
  if (dupHints.length > 0) healthItems.push({ level: 'warning', title: '疑似重复项目', detail: dupHints.join('；') })
  if (extremeIssues.length > 0) healthItems.push({ level: 'warning', title: '极端值提醒', detail: extremeIssues.slice(0, 5).join('；') })
  if (unitIssues.length > 0) healthItems.push({ level: 'danger', title: '单位疑似错误', detail: unitIssues.slice(0, 5).join('；') })
  if (skipped === 0 && numericIssues.length === 0 && logicIssues.length === 0 && dupHints.length === 0 && extremeIssues.length === 0 && unitIssues.length === 0) healthItems.push({ level: 'success', title: '数据质量良好', detail: '本次导入未发现关键缺失、格式异常、极端值或明显经营逻辑冲突。' })

  const issueCount = skipped + numericIssues.length + logicIssues.length + dupHints.length + missingFields.length + extremeIssues.length + unitIssues.length
  const score = Math.max(40, Math.round(100 - issueCount * 5))
  const previewRows = validatedProjects.slice(0, 20).map(p => ({
    ...p,
    collectionRate: p.receivable !== null && p.receivable > 0 && p.received !== null
      ? p.received / p.receivable * 100
      : null,
  }))
  return { filename, imported, skipped, total: rows.length, errors: errors.slice(0, 10), validatedProjects, previewRows, healthReport: { score, items: healthItems, mappings, issueCount } }
}

function parseUploadedFile(file: Express.Multer.File) {
  const filename = file.originalname
  const ext = filename.split('.').pop()?.toLowerCase()
  let rows: any[] = []
  if (ext === 'csv') rows = parseCsv(readFileSync(file.path, 'utf-8'))
  else if (ext === 'xlsx' || ext === 'xls') rows = parseExcel(file.path)
  else throw new Error('仅支持 CSV / Excel 文件')
  if (rows.length === 0) throw new Error(`${ext === 'csv' ? 'CSV' : 'Excel'} 文件为空或无表头`)
  return { filename, rows }
}

// ─── 导入预览：只解析和体检，不替换正式数据 ─────────────
router.post('/api/import/preview', (req, res, next) => {
  if (!canUseManualImport()) return res.status(403).json({ error: '生产环境已禁用Excel预览；正式数据只能通过P46受控批次发布' })
  next()
}, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' })
  try {
    const { filename, rows } = parseUploadedFile(req.file)
    const analyzed = analyzeRows(filename, rows)
    const result = db.prepare('INSERT INTO import_previews (filename, row_count, payload, health_report, errors) VALUES (?, ?, ?, ?, ?)')
      .run(filename, analyzed.validatedProjects.length, JSON.stringify(analyzed.validatedProjects), JSON.stringify(analyzed.healthReport), JSON.stringify(analyzed.errors))
    logOperation(req, '生成导入预览', `import_preview:${result.lastInsertRowid}`, { filename, rows: analyzed.validatedProjects.length, skipped: analyzed.skipped, score: analyzed.healthReport.score })
    res.json({ previewId: Number(result.lastInsertRowid), imported: analyzed.imported, skipped: analyzed.skipped, total: analyzed.total, errors: analyzed.errors, previewRows: analyzed.previewRows, healthReport: analyzed.healthReport })
  } catch (e: any) {
    return res.status(400).json({ error: `解析失败: ${e.message}` })
  } finally {
    try { if (req.file) unlinkSync(req.file.path) } catch {}
  }
})

// ─── 确认导入：根据预览版本正式替换项目数据 ───────────────
router.post('/api/import/confirm', (req, res) => {
  if (!canUseManualImport()) return res.status(403).json({ error: '生产环境已禁用Excel确认导入；正式数据只能通过P46受控批次发布' })
  const previewId = Number(req.body?.previewId)
  if (!previewId) return res.status(400).json({ error: '缺少预览版本ID' })
  const preview = db.prepare('SELECT * FROM import_previews WHERE id = ?').get(previewId) as any
  if (!preview) return res.status(404).json({ error: '预览版本不存在或已过期' })
  let projects: any[] = []
  try { projects = JSON.parse(preview.payload || '[]') } catch { return res.status(500).json({ error: '预览数据损坏，无法导入' }) }
  const errors = JSON.parse(preview.errors || '[]')
  const healthReport = JSON.parse(preview.health_report || '{}')
  const demoNames = demoProjectNames(projects)
  if (demoNames.length) return res.status(409).json({ error: `生产导入已拒绝演示项目指纹：${demoNames.join('、')}` })
  if (process.env.NODE_ENV === 'production' && String(req.body?.confirmNote || '').trim().length < 8) {
    return res.status(400).json({ error: '生产导入必须填写至少8个字的确认说明' })
  }
  if ((healthReport.items || []).some((item: any) => item.level === 'danger')) {
    return res.status(409).json({ error: '数据体检仍有危险项，禁止发布', healthReport })
  }
  const backup = insertProjects(projects, {
    backupSource: `确认导入前自动备份：${preview.filename}`,
    sourceSystem: 'admin-confirmed-import',
    validationStatus: 'verified',
    sourceBatch: `preview:${preview.id}`,
  })
  db.prepare('INSERT INTO import_logs (filename, rows_imported, rows_skipped, errors) VALUES (?, ?, ?, ?)')
    .run(preview.filename, projects.length, errors.length, JSON.stringify([...errors.slice(0, 10), `确认预览#${preview.id}后导入`]))
  logOperation(req, '确认导入项目数据', `import_preview:${preview.id}`, { filename: preview.filename, rows: projects.length, backup })
  res.json({ imported: projects.length, skipped: errors.length, total: projects.length + errors.length, errors, healthReport, backup })
})

// ─── 兼容旧入口：仍支持直接导入，但内部先分析再写入 ───────
router.post('/api/import/excel', (req, res, next) => {
  if (!canUseManualImport()) return res.status(403).json({ error: '生产环境已禁用Excel导入；正式数据只能通过P46受控批次发布' })
  next()
}, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' })
  try {
    const { filename, rows } = parseUploadedFile(req.file)
    const analyzed = analyzeRows(filename, rows)
    const demoNames = demoProjectNames(analyzed.validatedProjects)
    if (demoNames.length) return res.status(409).json({ error: `导入已拒绝演示项目指纹：${demoNames.join('、')}` })
    const backup = insertProjects(analyzed.validatedProjects, { backupSource: `导入前自动备份：${filename}` })
    db.prepare('INSERT INTO import_logs (filename, rows_imported, rows_skipped, errors) VALUES (?, ?, ?, ?)')
      .run(filename, analyzed.imported, analyzed.skipped, JSON.stringify(analyzed.errors))
    logOperation(req, '直接导入项目数据', `import:${filename}`, { filename, imported: analyzed.imported, skipped: analyzed.skipped, backup, score: analyzed.healthReport.score })
    res.json({ imported: analyzed.imported, skipped: analyzed.skipped, total: analyzed.total, errors: analyzed.errors, healthReport: analyzed.healthReport, backup })
  } catch (e: any) {
    return res.status(400).json({ error: `解析失败: ${e.message}` })
  } finally {
    try { if (req.file) unlinkSync(req.file.path) } catch {}
  }
})

// ─── 恢复演示数据 ────────────────────────────────────
router.post('/api/import/reset-demo', (req, res) => {
  if (!canUseDemoData()) {
    logOperation(req, '拒绝生产演示数据重置', 'projects:demo', { reason: 'demo-data-disabled' })
    return res.status(403).json({ error: '生产环境已永久禁用演示数据重置' })
  }
  const backup = insertProjects(demoProjects, { backupSource: '恢复演示数据前自动备份' })
  db.prepare('INSERT INTO import_logs (filename, rows_imported, rows_skipped, errors) VALUES (?, ?, ?, ?)')
    .run('系统内置演示数据', demoProjects.length, 0, JSON.stringify(['已恢复10条脱敏演示项目数据，恢复前已自动备份原项目数据']))
  logOperation(req, '恢复演示项目数据', 'projects:demo', { imported: demoProjects.length, backup })
  res.json({ success: true, imported: demoProjects.length, message: '演示数据已恢复，原项目数据已自动备份', backup })
})

// ─── 项目数据备份状态 ────────────────────────────────
router.get('/api/import/backups/latest', (_req, res) => {
  const row = db.prepare('SELECT id, source, row_count, created_at FROM project_backups ORDER BY id DESC LIMIT 1').get() as any
  res.json({ backup: row || null })
})

// ─── 恢复最近一次项目数据备份 ─────────────────────────
router.post('/api/import/backups/restore-latest', (req, res) => {
  const backup = db.prepare('SELECT * FROM project_backups ORDER BY id DESC LIMIT 1').get() as any
  if (!backup) return res.status(404).json({ error: '暂无可恢复的项目数据备份' })
  let rows: any[] = []
  try {
    rows = JSON.parse(backup.payload || '[]')
  } catch {
    return res.status(500).json({ error: '备份内容损坏，无法恢复' })
  }
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: '备份为空，无法恢复' })
  const trustError = projectTrustError(rows)
  if (trustError) return res.status(409).json({ error: `备份不符合真实性要求：${trustError}` })
  if (process.env.NODE_ENV === 'production' && String(req.body?.confirmNote || '').trim().length < 8) {
    return res.status(400).json({ error: '生产恢复必须填写至少8个字的确认说明' })
  }
  insertProjects(rows, { backupSource: `恢复备份#${backup.id}前自动备份`, preserveTrust: true })
  db.prepare('INSERT INTO import_logs (filename, rows_imported, rows_skipped, errors) VALUES (?, ?, ?, ?)')
    .run(`恢复项目备份#${backup.id}`, rows.length, 0, JSON.stringify([`已恢复 ${backup.created_at} 的项目数据备份`]))
  logOperation(req, '恢复最近项目备份', `project_backup:${backup.id}`, { rows: rows.length, source: backup.source })
  res.json({ success: true, restored: rows.length, backup: { id: backup.id, source: backup.source, created_at: backup.created_at } })
})

// ─── 项目数据备份列表 ────────────────────────────────
router.get('/api/import/backups', (_req, res) => {
  const rows = db.prepare('SELECT id, source, row_count, created_at FROM project_backups ORDER BY id DESC LIMIT 20').all()
  res.json({ rows })
})

// ─── 按指定备份版本恢复 ───────────────────────────────
router.post('/api/import/backups/:id/restore', (req, res) => {
  const backup = db.prepare('SELECT * FROM project_backups WHERE id = ?').get(req.params.id) as any
  if (!backup) return res.status(404).json({ error: '指定备份不存在' })
  let rows: any[] = []
  try { rows = JSON.parse(backup.payload || '[]') } catch { return res.status(500).json({ error: '备份内容损坏，无法恢复' }) }
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: '备份为空，无法恢复' })
  const trustError = projectTrustError(rows)
  if (trustError) return res.status(409).json({ error: `备份不符合真实性要求：${trustError}` })
  if (process.env.NODE_ENV === 'production' && String(req.body?.confirmNote || '').trim().length < 8) {
    return res.status(400).json({ error: '生产恢复必须填写至少8个字的确认说明' })
  }
  insertProjects(rows, { backupSource: `恢复备份#${backup.id}前自动备份`, preserveTrust: true })
  db.prepare('INSERT INTO import_logs (filename, rows_imported, rows_skipped, errors) VALUES (?, ?, ?, ?)')
    .run(`恢复项目备份#${backup.id}`, rows.length, 0, JSON.stringify([`已恢复 ${backup.created_at} 的项目数据备份`]))
  logOperation(req, '恢复指定项目备份', `project_backup:${backup.id}`, { rows: rows.length, source: backup.source })
  res.json({ success: true, restored: rows.length, backup: { id: backup.id, source: backup.source, created_at: backup.created_at } })
})

// ─── 导入日志 ──────────────────────────────────────
router.get('/api/import/logs', (_req, res) => {
  const production = process.env.NODE_ENV === 'production'
  const rows = production
    ? db.prepare("SELECT * FROM import_logs WHERE filename <> '系统内置演示数据' ORDER BY id DESC LIMIT 20").all()
    : db.prepare('SELECT * FROM import_logs ORDER BY id DESC LIMIT 20').all()
  const quarantinedDemoCount = production
    ? Number((db.prepare("SELECT COUNT(*) count FROM import_logs WHERE filename = '系统内置演示数据'").get() as any)?.count || 0)
    : 0
  res.json({ rows, quarantinedDemoCount, productionFiltered: production })
})

export default router
