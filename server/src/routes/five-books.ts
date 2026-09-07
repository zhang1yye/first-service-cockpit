import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import { createRequire } from 'node:module'
import db from '../db.js'
import { projectScopeWhere, requireAdmin } from '../auth.js'
import { logOperation } from '../audit.js'
import {
  calculateFiveBooksRecord,
  canonicalMetricId,
  resolveFiveBooksTemplate,
  summarizeFiveBooks,
  type FiveBooksInputRecord,
} from '../five-books-standard.js'
import { type FiveBooksLiveSubject } from '../five-books-upstream.js'
import { FIVE_BOOKS_DEMO_SNAPSHOT } from '../five-books-demo-snapshot.js'

const require = createRequire(import.meta.url)
const XLSX = require('@e965/xlsx')
const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } })
const dataRoot = process.env.COCKPIT_FIVE_BOOKS_DATA_DIR
  || path.join(path.dirname(process.env.COCKPIT_DB_PATH || path.join(os.homedir(), 'cockpit-dev', 'cockpit.db')), 'five-books')
const configuredEvidenceRoot = path.join(dataRoot, 'evidence')

function verifyEvidenceRoot(): string {
  if (!path.isAbsolute(configuredEvidenceRoot)) throw new Error('五书证据目录必须使用绝对路径')
  fs.mkdirSync(configuredEvidenceRoot, { recursive: true, mode: 0o750 })
  for (const directory of [dataRoot, configuredEvidenceRoot]) {
    const stat = fs.lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('五书证据目录必须是非符号链接实体目录')
  }
  const realDataRoot = fs.realpathSync(dataRoot)
  const realEvidenceRoot = fs.realpathSync(configuredEvidenceRoot)
  if (path.dirname(realEvidenceRoot) !== realDataRoot) throw new Error('五书证据目录超出配置数据根')
  return realEvidenceRoot
}

const evidenceRoot = verifyEvidenceRoot()

function evidenceFilePath(storedName: unknown, mustExist = false): string {
  if (verifyEvidenceRoot() !== evidenceRoot) throw new Error('五书证据目录在运行期间发生漂移')
  const filename = path.basename(text(storedName, 240))
  if (!filename || filename !== String(storedName)) throw new Error('五书证据文件名无效')
  const target = path.join(evidenceRoot, filename)
  if (path.dirname(target) !== evidenceRoot) throw new Error('五书证据路径超出配置根')
  if (mustExist) {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(target)
    } catch {
      const error: any = new Error('证据文件已缺失，请联系管理员核查')
      error.statusCode = 410
      throw error
    }
    if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(target) !== target) throw new Error('五书证据文件不是受信普通文件')
  }
  return target
}

db.exec(`
  CREATE TABLE IF NOT EXISTS five_book_assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_key TEXT NOT NULL,
    subject_name TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    area TEXT NOT NULL DEFAULT '',
    period TEXT NOT NULL,
    template_key TEXT NOT NULL,
    metric_id TEXT NOT NULL,
    applicability TEXT NOT NULL DEFAULT 'pending' CHECK(applicability IN ('applicable','excluded','pending')),
    target_value REAL,
    actual_value REAL,
    manual_weight REAL,
    manual_score REAL,
    calculated_score REAL,
    effect_value REAL,
    data_source TEXT NOT NULL DEFAULT 'manual',
    evidence_note TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(subject_key, period, template_key, metric_id)
  );
  CREATE INDEX IF NOT EXISTS idx_five_book_assessment_scope
    ON five_book_assessments(subject_key, period, template_key);

  CREATE TABLE IF NOT EXISTS five_book_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_key TEXT NOT NULL,
    period TEXT NOT NULL,
    template_key TEXT NOT NULL,
    metric_id TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL DEFAULT '',
    file_size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    uploaded_by TEXT NOT NULL DEFAULT '',
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_five_book_evidence_scope
    ON five_book_evidence(subject_key, period, template_key, metric_id);

  CREATE TABLE IF NOT EXISTS five_book_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_key TEXT NOT NULL,
    period TEXT NOT NULL,
    template_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','returned')),
    note TEXT NOT NULL DEFAULT '',
    operator TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(subject_key, period, template_key)
  );

  CREATE TABLE IF NOT EXISTS five_book_headers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_key TEXT NOT NULL,
    period TEXT NOT NULL,
    template_key TEXT NOT NULL,
    principle TEXT NOT NULL DEFAULT '',
    scope_text TEXT NOT NULL DEFAULT '',
    professional TEXT NOT NULL DEFAULT '',
    executor TEXT NOT NULL DEFAULT '',
    responsible TEXT NOT NULL DEFAULT '',
    accountant TEXT NOT NULL DEFAULT '',
    controller TEXT NOT NULL DEFAULT '',
    fill_date TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(subject_key, period, template_key)
  );

  CREATE TABLE IF NOT EXISTS five_book_import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_key TEXT NOT NULL,
    period TEXT NOT NULL,
    template_key TEXT NOT NULL,
    filename TEXT NOT NULL,
    sheet_name TEXT NOT NULL DEFAULT '',
    sha256 TEXT NOT NULL,
    rows_read INTEGER NOT NULL DEFAULT 0,
    rows_imported INTEGER NOT NULL DEFAULT 0,
    warning TEXT NOT NULL DEFAULT '',
    imported_by TEXT NOT NULL DEFAULT '',
    imported_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS five_book_review_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_key TEXT NOT NULL,
    period TEXT NOT NULL,
    template_key TEXT NOT NULL,
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    action TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    operator TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_five_book_review_events_scope
    ON five_book_review_events(subject_key,period,template_key,id);
`)

const assessmentColumns = db.prepare('PRAGMA table_info(five_book_assessments)').all() as Array<{ name: string }>
if (!assessmentColumns.some(column => column.name === 'manual_weight')) db.exec('ALTER TABLE five_book_assessments ADD COLUMN manual_weight REAL')
const headerColumns = db.prepare('PRAGMA table_info(five_book_headers)').all() as Array<{ name: string }>
if (!headerColumns.some(column => column.name === 'version')) db.exec('ALTER TABLE five_book_headers ADD COLUMN version INTEGER NOT NULL DEFAULT 0')

function text(value: unknown, max = 300): string {
  return String(value ?? '').trim().slice(0, max)
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function safeKey(value: unknown, label: string): string {
  const result = text(value, 160)
  if (!result || !/^[\w:.-]+$/u.test(result)) throw new Error(`${label}格式无效`)
  return result
}

function normalizedSubjectName(value: unknown): string {
  return String(value ?? '').normalize('NFKC').replace(/^第一服务/, '').replace(/服务中心$/, '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase()
}

function scopedLiveSubjects(req: any, subjects: FiveBooksLiveSubject[]): FiveBooksLiveSubject[] {
  if (['admin', 'region_manager'].includes(req.user?.role)) return subjects
  const scope = projectScopeWhere(req)
  const projectNames = (db.prepare(`
    SELECT name FROM projects
    WHERE COALESCE(active_status,'active')='active'${scope.clause ? ` AND ${scope.clause}` : ''}
  `).all(...scope.params) as Array<{ name: string }>).map((row) => normalizedSubjectName(row.name)).filter(Boolean)
  const allowed = new Set(projectNames)
  return subjects.filter((subject) => allowed.has(normalizedSubjectName(subject.name)))
}

function subjectTemplateClass(row: any): string {
  const value = `${row?.property_type || ''} ${row?.name || ''}`
  if (/职能中心/.test(value)) return 'function-center'
  if (/亚航/.test(value)) return 'yahang'
  if (/上诚|上城/.test(value)) return 'shangcheng'
  if (/授权经营/.test(value)) return 'authorized'
  if (/酬金/.test(value)) return 'commission'
  if (/体验中心|公建|商业|办公|产业园|学校|保洁|保安|单一大业主/.test(value)) return 'single-owner'
  return 'residential'
}

function spreadsheetFile(file?: Express.Multer.File): boolean {
  if (!file || file.size <= 0) return false
  const extension = path.extname(file.originalname).toLowerCase()
  if (!['.xlsx', '.xls'].includes(extension)) return false
  return extension === '.xlsx'
    ? file.buffer.subarray(0, 2).toString() === 'PK'
    : file.buffer.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1'
}

function evidenceMime(file?: Express.Multer.File): string | null {
  if (!file || file.size <= 0) return null
  const extension = path.extname(file.originalname).toLowerCase()
  const head = file.buffer.subarray(0, 12)
  if (extension === '.pdf' && head.subarray(0, 5).toString() === '%PDF-') return 'application/pdf'
  if (extension === '.png' && head.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png'
  if (['.jpg', '.jpeg'].includes(extension) && head.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg'
  if (['.docx', '.xlsx'].includes(extension) && head.subarray(0, 2).toString() === 'PK') {
    return extension === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }
  if (['.doc', '.xls'].includes(extension) && head.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') {
    return extension === '.doc' ? 'application/msword' : 'application/vnd.ms-excel'
  }
  return null
}

function reviewFor(subjectKey: string, period: string, templateKey: string) {
  return db.prepare(`
    SELECT status,note,operator,updated_at FROM five_book_reviews
    WHERE subject_key=? AND period=? AND template_key=?
  `).get(subjectKey, period, templateKey) || { status: 'draft', note: '', operator: '', updated_at: null }
}

function headerFor(subjectKey: string, period: string, templateKey: string) {
  return db.prepare(`
    SELECT principle,scope_text,professional,executor,responsible,accountant,controller,
      fill_date,updated_by,version,updated_at
    FROM five_book_headers WHERE subject_key=? AND period=? AND template_key=?
  `).get(subjectKey, period, templateKey) || null
}

function authorizedSubject(req: any, subjectKey: string): { key: string; name: string; type: string; area: string; templateClass: string } {
  if (subjectKey === 'organization:first-service') {
    if (req.user?.role !== 'admin') throw new Error('无权访问第一服务组织总表')
    return { key: subjectKey, name: '第一服务组织总表', type: 'organization', area: '全组织', templateClass: 'overall' }
  }
  if (subjectKey === 'region:north-china') {
    if (!['admin', 'region_manager'].includes(req.user?.role)) throw new Error('无权访问地区公司总表')
    return { key: subjectKey, name: '第一服务华北地区公司', type: 'region', area: '华北', templateClass: 'region' }
  }
  const match = subjectKey.match(/^project:(\d+)$/)
  if (!match) throw new Error('评估对象无效')
  const scope = projectScopeWhere(req)
  const row = db.prepare(`
    SELECT id,name,area,property_type FROM projects
    WHERE id=? AND COALESCE(active_status,'active')='active'${scope.clause ? ` AND ${scope.clause}` : ''}
  `).get(Number(match[1]), ...scope.params) as any
  if (!row) throw new Error('评估对象不存在或超出当前权限范围')
  return { key: subjectKey, name: row.name, type: 'project', area: row.area || '', templateClass: subjectTemplateClass(row) }
}

function reviewStatus(subjectKey: string, period: string, templateKey: string): string {
  return String((reviewFor(subjectKey, period, templateKey) as any).status || 'draft')
}

function assertEditable(subjectKey: string, period: string, templateKey: string) {
  const status = reviewStatus(subjectKey, period, templateKey)
  if (!['draft', 'returned'].includes(status)) {
    const error: any = new Error(status === 'approved' ? '该评估已确认核算；退回后方可修改' : '该评估已提交复核；退回后方可修改')
    error.statusCode = 409
    throw error
  }
}

function bumpHeaderVersion(subjectKey: string, period: string, templateKey: string, expectedVersion: number, operator: string) {
  const current = headerFor(subjectKey, period, templateKey) as any
  if (Number(current?.version || 0) !== expectedVersion) {
    const error: any = new Error('评估数据已被其他会话更新，请刷新后重试'); error.statusCode = 409; throw error
  }
  if (current) {
    db.prepare(`UPDATE five_book_headers SET version=version+1,updated_by=?,updated_at=datetime('now','localtime')
      WHERE subject_key=? AND period=? AND template_key=? AND version=?`)
      .run(operator, subjectKey, period, templateKey, expectedVersion)
  } else {
    db.prepare(`INSERT INTO five_book_headers(subject_key,period,template_key,updated_by,version) VALUES(?,?,?,?,1)`)
      .run(subjectKey, period, templateKey, operator)
  }
}

function respondRouteError(res: any, error: any, fallback: string) {
  res.status(Number(error?.statusCode) || 400).json({ error: text(error?.message || fallback, 300) })
}

router.get('/api/five-books/subjects', (req: any, res) => {
  const scope = projectScopeWhere(req)
  const where = `WHERE COALESCE(active_status,'active')='active'${scope.clause ? ` AND ${scope.clause}` : ''}`
  const projects = (db.prepare(`
    SELECT id,area,name,property_type,updated_at
    FROM projects ${where} ORDER BY area,name
  `).all(...scope.params) as any[]).map((row) => ({
    key: `project:${row.id}`,
    type: 'project',
    area: row.area || '',
    name: row.name,
    projectId: row.id,
    propertyType: row.property_type || '',
    templateClass: subjectTemplateClass(row),
    updatedAt: row.updated_at || null,
  }))
  const managementSubjects = req.user?.role === 'admin'
    ? [
        { key: 'organization:first-service', type: 'organization', area: '全组织', name: '第一服务组织总表', templateClass: 'overall' },
        { key: 'region:north-china', type: 'region', area: '华北', name: '第一服务华北地区公司', templateClass: 'region' },
      ]
    : req.user?.role === 'region_manager'
      ? [{ key: 'region:north-china', type: 'region', area: '华北', name: '第一服务华北地区公司', templateClass: 'region' }]
      : []
  const subjects = [...managementSubjects, ...projects]
  res.json({
    subjects,
    areas: [...new Set(projects.map((row) => row.area).filter(Boolean))],
    totalProjects: projects.length,
  })
})

router.get('/api/five-books/records', (req: any, res) => {
  try {
    const subjectKey = safeKey(req.query.subjectKey, '评估对象')
    authorizedSubject(req, subjectKey)
    const period = safeKey(req.query.period, '评估周期')
    const templateKey = safeKey(req.query.templateKey, '指标模板')
    const records = db.prepare(`
      SELECT metric_id,applicability,target_value,actual_value,manual_weight,manual_score,calculated_score,
        effect_value,data_source,evidence_note,updated_by,updated_at
      FROM five_book_assessments
      WHERE subject_key=? AND period=? AND template_key=? ORDER BY metric_id
    `).all(subjectKey, period, templateKey)
    const evidence = db.prepare(`
      SELECT id,metric_id,original_name,mime_type,file_size,sha256,note,uploaded_by,uploaded_at
      FROM five_book_evidence
      WHERE subject_key=? AND period=? AND template_key=? ORDER BY id DESC
    `).all(subjectKey, period, templateKey)
    const imports = db.prepare(`
      SELECT id,filename,sheet_name,rows_read,rows_imported,warning,imported_by,imported_at
      FROM five_book_import_batches
      WHERE subject_key=? AND period=? AND template_key=? ORDER BY id DESC LIMIT 10
    `).all(subjectKey, period, templateKey)
    res.json({ records, evidence, imports, review: reviewFor(subjectKey, period, templateKey), header: headerFor(subjectKey, period, templateKey) })
  } catch (error: any) {
    res.status(400).json({ error: error.message })
  }
})

router.put('/api/five-books/records', requireAdmin, (req: any, res) => {
  try {
    const subjectKey = safeKey(req.body?.subjectKey, '评估对象')
    const subject = authorizedSubject(req, subjectKey)
    const subjectName = subject.name
    const subjectType = subject.type
    const area = subject.area
    const period = safeKey(req.body?.period, '评估周期')
    const templateKey = safeKey(req.body?.templateKey, '指标模板')
    const template = resolveFiveBooksTemplate(templateKey, period, subject.templateClass)
    const records = Array.isArray(req.body?.records) ? req.body.records.slice(0, 250) : []
    const header = req.body?.header && typeof req.body.header === 'object' ? req.body.header : {}
    const expectedVersion = Number(req.body?.version ?? 0)
    if (!subjectName || !records.length) return res.status(400).json({ error: '缺少评估对象或指标记录' })
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return res.status(400).json({ error: '记录版本无效' })
    assertEditable(subjectKey, period, templateKey)
    const seen = new Set<string>()
    const normalized: FiveBooksInputRecord[] = records.map((row: any): FiveBooksInputRecord => {
      const suppliedId = safeKey(row?.metricId, '指标')
      const metricId = canonicalMetricId(template, suppliedId)
      if (!metricId || seen.has(metricId)) throw new Error('指标记录与正式模板不一致或重复')
      seen.add(metricId)
      const applicability = ['applicable', 'excluded', 'pending'].includes(row?.applicability) ? row.applicability : 'pending'
      const manualWeight = optionalNumber(row?.manualWeight)
      const manualScore = optionalNumber(row?.manualScore)
      const effectValue = optionalNumber(row?.effectValue)
      const metric = template.metrics.find(item => item.id === metricId)!
      if (manualWeight !== null && (manualWeight <= 0 || manualWeight > 1)) throw new Error('人工指标权重必须大于0且不超过1')
      if (manualScore !== null && (manualScore < 0 || manualScore > 1.2)) throw new Error('指标得分必须在0至1.2之间')
      if (effectValue !== null && Math.abs(effectValue) > 1.2) throw new Error('加减分绝对值不得超过1.2')
      if (effectValue !== null && effectValue < 0 && metric.kind !== 'adjustment') throw new Error('只有加减分项允许填写负数')
      return {
        metricId, applicability,
        targetValue: optionalNumber(row?.targetValue), actualValue: optionalNumber(row?.actualValue),
        manualWeight, manualScore, effectValue,
        dataSource: text(row?.dataSource || 'manual', 80), evidenceNote: text(row?.evidenceNote, 1000),
      }
    })
    if (normalized.length !== template.metrics.length) throw new Error('必须提交正式模板的全部指标记录')
    const calculated = normalized.map(record => calculateFiveBooksRecord(template.metrics.find(metric => metric.id === record.metricId)!, record))
    const statement = db.prepare(`
      INSERT INTO five_book_assessments (
        subject_key,subject_name,subject_type,area,period,template_key,metric_id,applicability,
        target_value,actual_value,manual_weight,manual_score,calculated_score,effect_value,data_source,evidence_note,
        updated_by,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
      ON CONFLICT(subject_key,period,template_key,metric_id) DO UPDATE SET
        subject_name=excluded.subject_name,subject_type=excluded.subject_type,area=excluded.area,
        applicability=excluded.applicability,target_value=excluded.target_value,actual_value=excluded.actual_value,
        manual_weight=excluded.manual_weight,manual_score=excluded.manual_score,calculated_score=excluded.calculated_score,
        effect_value=excluded.effect_value,data_source=excluded.data_source,evidence_note=excluded.evidence_note,
        updated_by=excluded.updated_by,updated_at=datetime('now','localtime')
    `)
    const headerStatement = db.prepare(`
      INSERT INTO five_book_headers(subject_key,period,template_key,principle,scope_text,professional,
        executor,responsible,accountant,controller,fill_date,updated_by,version,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,datetime('now','localtime'))
      ON CONFLICT(subject_key,period,template_key) DO UPDATE SET
        principle=excluded.principle,scope_text=excluded.scope_text,professional=excluded.professional,
        executor=excluded.executor,responsible=excluded.responsible,accountant=excluded.accountant,
        controller=excluded.controller,fill_date=excluded.fill_date,updated_by=excluded.updated_by,
        version=five_book_headers.version+1,updated_at=datetime('now','localtime')
      WHERE five_book_headers.version=?
    `)
    const save = db.transaction((rows: typeof calculated) => {
      const current = headerFor(subjectKey, period, templateKey) as any
      if (Number(current?.version || 0) !== expectedVersion) {
        const error: any = new Error('评估数据已被其他会话更新，请刷新后重试')
        error.statusCode = 409
        throw error
      }
      for (const row of rows) {
        statement.run(
          subjectKey, subjectName, subjectType, area, period, templateKey,
          row.metricId, row.applicability, row.targetValue, row.actualValue, row.manualWeight, row.manualScore,
          row.calculatedScore, row.calculatedEffect, row.dataSource, row.evidenceNote, req.user?.username || '',
        )
      }
      const headerResult = headerStatement.run(
        subjectKey, period, templateKey,
        text(header.principle, 1000), text(header.scopeText, 500), text(header.professional, 160),
        text(header.executor, 80), text(header.responsible, 80), text(header.accountant, 80),
        text(header.controller, 80), text(header.fillDate, 30), req.user?.username || '', expectedVersion,
      )
      if (headerResult.changes !== 1) throw new Error('评估数据版本冲突')
    })
    save(calculated)
    logOperation(req, '保存五书评估', subjectName, { subjectKey, period, templateKey, rows: records.length })
    res.json({ ok: true, saved: records.length, review: reviewFor(subjectKey, period, templateKey), header: headerFor(subjectKey, period, templateKey) })
  } catch (error: any) {
    respondRouteError(res, error, '保存失败')
  }
})

router.post('/api/five-books/review', requireAdmin, (req: any, res) => {
  try {
    const subjectKey = safeKey(req.body?.subjectKey, '评估对象')
    const subject = authorizedSubject(req, subjectKey)
    const period = safeKey(req.body?.period, '评估周期')
    const templateKey = safeKey(req.body?.templateKey, '指标模板')
    const template = resolveFiveBooksTemplate(templateKey, period, subject.templateClass)
    const action = text(req.body?.action, 30)
    const statusByAction: Record<string, string> = { submit: 'submitted', approve: 'approved', return: 'returned', reopen: 'draft' }
    const status = statusByAction[action]
    if (!status) return res.status(400).json({ error: '复核动作无效' })
    const current = reviewStatus(subjectKey, period, templateKey)
    const allowed: Record<string, string[]> = {
      submit: ['draft', 'returned'], approve: ['submitted'], return: ['submitted', 'approved'], reopen: ['returned'],
    }
    if (!allowed[action].includes(current)) {
      const error: any = new Error(`复核状态不能从${current}执行${action}`)
      error.statusCode = 409
      throw error
    }
    const rows = db.prepare(`SELECT metric_id,applicability,target_value,actual_value,manual_weight,manual_score,
      calculated_score,effect_value,data_source,evidence_note FROM five_book_assessments
      WHERE subject_key=? AND period=? AND template_key=?`).all(subjectKey, period, templateKey) as any[]
    if (action === 'submit' || action === 'approve') {
      if (rows.length !== template.metrics.length) {
        const error: any = new Error('正式模板指标不完整，不能提交或确认核算'); error.statusCode = 409; throw error
      }
      if (rows.some(row => !template.metrics.some(metric => metric.id === row.metric_id))) {
        const error: any = new Error('评估包含不属于当前正式模板的指标，不能提交或确认核算'); error.statusCode = 409; throw error
      }
      const calculated = rows.map(row => calculateFiveBooksRecord(
        template.metrics.find(metric => metric.id === row.metric_id)!,
        {
          metricId: row.metric_id, applicability: row.applicability,
          targetValue: row.target_value, actualValue: row.actual_value, manualWeight: row.manual_weight,
          manualScore: row.manual_score, effectValue: row.effect_value,
          dataSource: row.data_source, evidenceNote: row.evidence_note,
        },
      ))
      if (!summarizeFiveBooks(template, calculated).complete) {
        const error: any = new Error('仍有待确认、待取数或缺少人工权重的指标，不能提交或确认核算'); error.statusCode = 409; throw error
      }
    }
    const operator = req.user?.username || ''
    if (action === 'approve') {
      const submit = db.prepare(`SELECT operator FROM five_book_review_events
        WHERE subject_key=? AND period=? AND template_key=? AND action='submit' ORDER BY id DESC LIMIT 1`)
        .get(subjectKey, period, templateKey) as any
      if (!submit || submit.operator === operator) {
        const error: any = new Error('确认核算必须由不同于提交人的管理员执行'); error.statusCode = 409; throw error
      }
    }
    const note = text(req.body?.note, 1000)
    const transition = db.transaction(() => {
      db.prepare(`
        INSERT INTO five_book_reviews(subject_key,period,template_key,status,note,operator,updated_at)
        VALUES(?,?,?,?,?,?,datetime('now','localtime'))
        ON CONFLICT(subject_key,period,template_key) DO UPDATE SET
          status=excluded.status,note=excluded.note,operator=excluded.operator,updated_at=datetime('now','localtime')
      `).run(subjectKey, period, templateKey, status, note, operator)
      db.prepare(`INSERT INTO five_book_review_events(subject_key,period,template_key,from_status,to_status,action,note,operator)
        VALUES(?,?,?,?,?,?,?,?)`).run(subjectKey, period, templateKey, current, status, action, note, operator)
    })
    transition()
    logOperation(req, '五书评估复核', `${subjectKey}:${period}`, { action, status, templateKey })
    res.json({ ok: true, review: reviewFor(subjectKey, period, templateKey) })
  } catch (error: any) {
    respondRouteError(res, error, '复核失败')
  }
})

router.post('/api/five-books/evidence', requireAdmin, upload.single('file'), async (req: any, res) => {
  let target = ''
  try {
    const mimeType = evidenceMime(req.file)
    if (!mimeType) return res.status(400).json({ error: '证据文件内容与PDF、Word、Excel或图片格式不匹配' })
    const subjectKey = safeKey(req.body?.subjectKey, '评估对象')
    const subject = authorizedSubject(req, subjectKey)
    const period = safeKey(req.body?.period, '评估周期')
    const templateKey = safeKey(req.body?.templateKey, '指标模板')
    const template = resolveFiveBooksTemplate(templateKey, period, subject.templateClass)
    assertEditable(subjectKey, period, templateKey)
    const metricId = canonicalMetricId(template, safeKey(req.body?.metricId, '指标'))
    if (!metricId) throw new Error('证据指标不在正式模板中')
    const extension = path.extname(req.file.originalname).toLowerCase()
    const storedName = `${Date.now()}-${randomUUID()}${extension}`
    target = evidenceFilePath(storedName)
    await fs.promises.writeFile(target, req.file.buffer, { flag: 'wx', mode: 0o640 })
    const sha256 = createHash('sha256').update(req.file.buffer).digest('hex')
    const result = db.prepare(`
      INSERT INTO five_book_evidence(subject_key,period,template_key,metric_id,original_name,stored_name,mime_type,file_size,sha256,note,uploaded_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).run(subjectKey, period, templateKey, metricId, text(req.file.originalname, 240), storedName,
      mimeType, req.file.size, sha256, text(req.body?.note, 1000), req.user?.username || '')
    logOperation(req, '上传五书评估证据', metricId, { subjectKey, period, templateKey, filename: req.file.originalname, sha256 })
    res.json({ ok: true, id: result.lastInsertRowid, filename: req.file.originalname, sha256 })
  } catch (error: any) {
    if (target) await fs.promises.rm(target, { force: true }).catch(() => undefined)
    respondRouteError(res, error, '证据上传失败')
  }
})

router.get('/api/five-books/evidence/:id', async (req: any, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '证据编号无效' })
    const row = db.prepare(`
      SELECT id,subject_key,original_name,stored_name,mime_type,sha256
      FROM five_book_evidence WHERE id=?
    `).get(id) as any
    if (!row) return res.status(404).json({ error: '证据附件不存在' })
    authorizedSubject(req, row.subject_key)
    const source = evidenceFilePath(row.stored_name, true)
    const evidence = await fs.promises.readFile(source)
    const actualSha256 = createHash('sha256').update(evidence).digest('hex')
    if (actualSha256 !== row.sha256) {
      const error: any = new Error('证据文件完整性校验失败，请联系管理员核查')
      error.statusCode = 409
      throw error
    }
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Content-SHA256', row.sha256)
    res.send(evidence)
  } catch (error: any) {
    respondRouteError(res, error, '证据下载失败')
  }
})

router.post('/api/five-books/import', requireAdmin, upload.single('file'), (req: any, res) => {
  try {
    if (!spreadsheetFile(req.file)) return res.status(400).json({ error: '请选择15MB以内且格式有效的xlsx/xls正式评估文件' })
    const subjectKey = safeKey(req.body?.subjectKey, '评估对象')
    const subject = authorizedSubject(req, subjectKey)
    const subjectName = subject.name
    const subjectType = subject.type
    const area = subject.area
    const period = safeKey(req.body?.period, '评估周期')
    const templateKey = safeKey(req.body?.templateKey, '指标模板')
    const template = resolveFiveBooksTemplate(templateKey, period, subject.templateClass)
    assertEditable(subjectKey, period, templateKey)
    const expectedVersion = Number(req.body?.version ?? 0)
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new Error('记录版本无效')
    const metricMap = Object.fromEntries(template.metrics.map(metric => [metric.dimension, metric.id]))
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false })
    const requestedSheet = text(req.body?.sheetName, 160)
    const sheetName = workbook.SheetNames.includes(requestedSheet) ? requestedSheet : workbook.SheetNames[0]
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' }) as any[][]
    const headerIndex = rows.slice(0, 30).findIndex((row) => row.some((cell) => /考核维度/.test(text(cell))))
    let imported = 0
    let warning = ''
    if (headerIndex >= 0) {
      const headers = rows[headerIndex].map((cell) => text(cell, 80))
      const dimensionIndex = headers.findIndex((cell) => /考核维度/.test(cell))
      const targetIndex = headers.findIndex((cell) => /目标值|目标$|计划值/.test(cell))
      const actualIndex = headers.findIndex((cell) => /实际值|完成值|实际$/.test(cell))
      const scoreIndex = headers.findIndex((cell) => /指标得分|评估得分|^得分$|^评分$/.test(cell))
      const effectIndex = headers.findIndex((cell) => /加减分/.test(cell))
      const manualWeightIndex = headers.findIndex((cell) => /人工权重/.test(cell))
      const applicabilityIndex = headers.findIndex((cell) => /是否涉及|适用状态|除权/.test(cell))
      const evidenceIndex = headers.findIndex((cell) => /证据|说明|备注/.test(cell))
      if (targetIndex < 0 && actualIndex < 0 && scoreIndex < 0 && effectIndex < 0 && manualWeightIndex < 0) {
        warning = '已识别正式指标模板，但文件未包含目标值、实际值或评估得分，未覆盖现有评估数据。'
      } else {
        const statement = db.prepare(`
          INSERT INTO five_book_assessments(subject_key,subject_name,subject_type,area,period,template_key,metric_id,applicability,
            target_value,actual_value,manual_weight,manual_score,calculated_score,effect_value,data_source,evidence_note,updated_by,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
          ON CONFLICT(subject_key,period,template_key,metric_id) DO UPDATE SET
            target_value=COALESCE(excluded.target_value,five_book_assessments.target_value),
            actual_value=COALESCE(excluded.actual_value,five_book_assessments.actual_value),
            manual_weight=COALESCE(excluded.manual_weight,five_book_assessments.manual_weight),
            manual_score=COALESCE(excluded.manual_score,five_book_assessments.manual_score),
            calculated_score=COALESCE(excluded.calculated_score,five_book_assessments.calculated_score),
            effect_value=COALESCE(excluded.effect_value,five_book_assessments.effect_value),
            applicability=excluded.applicability,data_source='formal-excel',
            evidence_note=COALESCE(NULLIF(excluded.evidence_note,''),five_book_assessments.evidence_note),
            updated_by=excluded.updated_by,updated_at=datetime('now','localtime')
        `)
        const existingStatement = db.prepare(`SELECT applicability,target_value,actual_value,manual_weight,manual_score,effect_value
          FROM five_book_assessments WHERE subject_key=? AND period=? AND template_key=? AND metric_id=?`)
        const transaction = db.transaction(() => {
          for (const row of rows.slice(headerIndex + 1)) {
            const dimension = text(row[dimensionIndex], 300)
            const metricId = metricMap[dimension]
            if (!dimension || !metricId) continue
            const score = scoreIndex >= 0 ? optionalNumber(row[scoreIndex]) : null
            if (score !== null && (score < 0 || score > 1.2)) throw new Error(`“${dimension}”得分超出0至1.2范围`)
            const effectValue = effectIndex >= 0 ? optionalNumber(row[effectIndex]) : null
            if (effectValue !== null && Math.abs(effectValue) > 1.2) throw new Error(`“${dimension}”加减分绝对值超出1.2`)
            const manualWeight = manualWeightIndex >= 0 ? optionalNumber(row[manualWeightIndex]) : null
            if (manualWeight !== null && (manualWeight <= 0 || manualWeight > 1)) throw new Error(`“${dimension}”人工权重必须大于0且不超过1`)
            const applicabilityText = applicabilityIndex >= 0 ? text(row[applicabilityIndex], 80) : ''
            const applicability = /不涉及|除权/.test(applicabilityText) ? 'excluded' : 'applicable'
            const targetValue = targetIndex >= 0 ? optionalNumber(row[targetIndex]) : null
            const actualValue = actualIndex >= 0 ? optionalNumber(row[actualIndex]) : null
            const evidenceNote = evidenceIndex >= 0 ? text(row[evidenceIndex], 1000) : ''
            if (!applicabilityText && targetValue === null && actualValue === null && score === null && effectValue === null && manualWeight === null && !evidenceNote) continue
            const metric = template.metrics.find(item => item.id === metricId)!
            const existing = existingStatement.get(subjectKey, period, templateKey, metricId) as any
            const merged = {
              applicability: applicability as FiveBooksInputRecord['applicability'],
              targetValue: targetValue ?? existing?.target_value ?? null,
              actualValue: actualValue ?? existing?.actual_value ?? null,
              manualWeight: manualWeight ?? existing?.manual_weight ?? null,
              manualScore: score ?? existing?.manual_score ?? null,
              effectValue: effectValue ?? existing?.effect_value ?? null,
            }
            if (merged.effectValue !== null && merged.effectValue < 0 && metric.kind !== 'adjustment') {
              throw new Error(`“${dimension}”只有加减分项允许填写负数`)
            }
            const calculated = calculateFiveBooksRecord(metric, {
              metricId, ...merged,
              dataSource: 'formal-excel', evidenceNote,
            })
            statement.run(subjectKey, subjectName, subjectType, area, period, templateKey, metricId, applicability,
              targetValue, actualValue, manualWeight, score, calculated.calculatedScore, calculated.calculatedEffect,
              'formal-excel', calculated.evidenceNote, req.user?.username || '')
            imported += 1
          }
        })
        db.transaction(() => {
          transaction()
          if (imported) bumpHeaderVersion(subjectKey, period, templateKey, expectedVersion, req.user?.username || '')
        })()
        if (!imported) warning = '文件包含评估字段，但考核维度未与当前PM5模板匹配，未覆盖现有评估数据。'
      }
    } else {
      warning = '未找到“考核维度”表头，未覆盖现有评估数据。'
    }
    const sha256 = createHash('sha256').update(req.file.buffer).digest('hex')
    db.prepare(`
      INSERT INTO five_book_import_batches(subject_key,period,template_key,filename,sheet_name,sha256,rows_read,rows_imported,warning,imported_by)
      VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(subjectKey, period, templateKey, text(req.file.originalname, 240), sheetName, sha256, rows.length, imported, warning, req.user?.username || '')
    logOperation(req, '导入五书评估Excel', subjectName, { subjectKey, period, templateKey, sheetName, rowsRead: rows.length, imported, warning, sha256 })
    res.json({ ok: true, sheetName, rowsRead: rows.length, imported, warning })
  } catch (error: any) {
    res.status(400).json({ error: text(error?.message || 'Excel导入失败', 300) })
  }
})

router.get('/api/five-books/export.xlsx', (req: any, res) => {
  try {
    const subjectKey = safeKey(req.query.subjectKey, '评估对象')
    authorizedSubject(req, subjectKey)
    const period = safeKey(req.query.period, '评估周期')
    const templateKey = safeKey(req.query.templateKey, '指标模板')
    const subject = authorizedSubject(req, subjectKey)
    const template = resolveFiveBooksTemplate(templateKey, period, subject.templateClass)
    const stored = db.prepare(`SELECT * FROM five_book_assessments WHERE subject_key=? AND period=? AND template_key=?`)
      .all(subjectKey, period, templateKey) as any[]
    const byId = new Map(stored.map(row => [row.metric_id, row]))
    const records = template.metrics.map(metric => {
      const row = byId.get(metric.id) || {}
      return {
        指标编码: metric.id, 考核维度: metric.dimension, 适用状态: row.applicability || 'pending',
        目标值: row.target_value ?? '', 实际值: row.actual_value ?? '', 人工权重: row.manual_weight ?? '',
        评估得分: row.manual_score ?? row.calculated_score ?? '', 加减分: row.effect_value ?? '',
        数据来源: row.data_source || '', 证据说明: row.evidence_note || '', 更新人: row.updated_by || '', 更新时间: row.updated_at || '',
      }
    })
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(records), '评估数据')
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([reviewFor(subjectKey, period, templateKey)]), '复核状态')
    const output = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })
    const filename = encodeURIComponent(`五书评估-${subjectKey}-${period}.xlsx`)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
    res.send(output)
  } catch (error: any) {
    res.status(400).json({ error: text(error?.message || '导出失败', 300) })
  }
})

function demoSnapshotFor(year: number, period: string) {
  if (year !== FIVE_BOOKS_DEMO_SNAPSHOT.year || period !== FIVE_BOOKS_DEMO_SNAPSHOT.period) {
    const error: any = new Error('汇报快照仅支持2026年二季度')
    error.statusCode = 400
    throw error
  }
  return FIVE_BOOKS_DEMO_SNAPSHOT
}

router.get('/api/five-books/live/subjects', async (req: any, res) => {
  try {
    const year = Number(req.query.year)
    const period = safeKey(req.query.period, '评估周期')
    const snapshot = demoSnapshotFor(year, period)
    const subjects = scopedLiveSubjects(req, snapshot.subjects)
    res.set('Cache-Control', 'private, no-store')
    res.json({
      source: '第一资产五书汇报快照',
      targetCycle: snapshot.targetCycle,
      capturedAt: snapshot.capturedAt,
      subjects,
      total: subjects.length,
      upstreamTotal: snapshot.subjects.length,
    })
  } catch (error: any) {
    respondRouteError(res, error, '五书汇报快照清单读取失败')
  }
})

router.get('/api/five-books/live/detail', async (req: any, res) => {
  try {
    const year = Number(req.query.year)
    const period = safeKey(req.query.period, '评估周期')
    const headCode = safeKey(req.query.headCode, '五书评估记录')
    const snapshot = demoSnapshotFor(year, period)
    const visible = scopedLiveSubjects(req, snapshot.subjects)
    if (!visible.some((subject) => subject.headCode === headCode)) {
      const error: any = new Error('五书评估记录不存在或超出当前服务中心权限范围')
      error.statusCode = 403
      throw error
    }
    const detail = snapshot.detailsByHeadCode[headCode]
    if (!detail) {
      const error: any = new Error('五书汇报快照详情不存在')
      error.statusCode = 404
      throw error
    }
    res.set('Cache-Control', 'private, no-store')
    res.json({ source: '第一资产五书汇报快照', capturedAt: snapshot.capturedAt, detail })
  } catch (error: any) {
    respondRouteError(res, error, '五书汇报快照详情读取失败')
  }
})

router.get('/api/five-books/aph-status', (_req, res) => {
  res.set('Cache-Control', 'private, no-store')
  res.json({
    configured: true,
    mode: 'demo-snapshot',
    message: '比赛汇报期间固定展示2026年二季度华北五书快照，暂不访问上游接口。',
  })
})

router.use((error: any, _req: any, res: any, next: any) => {
  if (!(error instanceof multer.MulterError)) return next(error)
  const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400
  res.status(status).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '上传文件不得超过15MB' : '上传字段或文件数量无效' })
})

export default router
