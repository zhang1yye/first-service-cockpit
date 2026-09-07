import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { publishQxmEvidence, type QxmPublicationResult } from './arrears-connector-store.js'
import { northChinaBusinessDate, publicationConfirmed } from './lvzai-arrears-job.js'
import { QxmIncrementalEvidenceConnector, readAndNormalizeQxmEvidence, type NormalizedQxmEvidenceEnvelope, type QxmEvidenceTransport } from './qxm-evidence-connector.js'

export type QxmEvidenceScopeConfig = {
  schemaVersion: 1
  departments: Array<{ departmentId: string; reviewServiceCenter: string; projects: Array<{ housePrefix: string; serviceCenter: string }> }>
  pageSize: number
  maximumPages: number
}
export type QxmCursorState = { schemaVersion: 1; updatedAt: string; departments: Array<{ departmentIdHash: string; cursor: string }> }
export type QxmEvidenceJobSummary = {
  mode: 'dry-run' | 'published'
  source: 'qxm'
  businessDate: string
  extractedAt: string
  departmentScopeCount: number
  rowCount: number
  matchedCount: number
  isolatedUnlinkedCount: number
  supportedSignalCount: number
  conflictedSignalCount: number
  authoritativeAmountFields: 0
  qualityState: 'passed'
  cursorAdvanced: boolean
  publication: QxmPublicationResult | null
}

export type QxmEvidenceShardedJobSummary = {
  mode: 'dry-run' | 'published'
  source: 'qxm'
  businessDate: string
  extractedAt: string
  departmentScopeCount: number
  successfulDepartmentCount: number
  publishedDepartmentCount: number
  failedDepartmentCount: number
  cursorAdvancedCount: number
  rowCount: number
  matchedCount: number
  isolatedUnlinkedCount: number
  supportedSignalCount: number
  conflictedSignalCount: number
  authoritativeAmountFields: 0
  qualityState: 'passed' | 'partial' | 'failed'
  failures: Array<{ departmentIdHash: string; errorCode: 'source_timeout' | 'session_expired' | 'aborted' | 'source_error' }>
}

const SENSITIVE = /(?:password|passwd|pwd|secret|token|cookie|authorization|session|credential|cursor)/i
function text(value: unknown): string { return value === null || value === undefined ? '' : String(value).normalize('NFKC').trim() }
function validBusinessDate(value: unknown): boolean {
  const raw = text(value), match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3])
}
function noSensitiveKeys(value: unknown, location = '配置'): void {
  if (Array.isArray(value)) return value.forEach((item, index) => noSensitiveKeys(item, `${location}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) { if (SENSITIVE.test(name)) throw new Error(`${location}不得包含凭据或游标字段`); noSensitiveKeys(item, `${location}.${name}`) }
}
function prefix(value: unknown): string {
  const result = text(value).toUpperCase().replace(/[－—–_/\\]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (!/^[A-Z]{2,3}-[A-Z0-9]+$/.test(result)) throw new Error('企小码房屋前缀必须是城市代码-项目代码')
  return result
}
function hashKey(): Buffer {
  const value = String(process.env.ARREARS_RESOURCE_HASH_KEY || '')
  if (value.length < 32) throw new Error('缺少至少32位ARREARS_RESOURCE_HASH_KEY')
  return Buffer.from(value, 'utf8')
}
function departmentHash(departmentId: string): string { return crypto.createHmac('sha256', hashKey()).update(departmentId).digest('hex') }

export function validateQxmEvidenceScopeConfig(value: unknown): QxmEvidenceScopeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('企小码证据范围配置必须是对象')
  const input = value as any
  if (input.schemaVersion !== 1) throw new Error('企小码证据范围配置版本不受支持')
  noSensitiveKeys(input)
  if (!Array.isArray(input.departments) || !input.departments.length) throw new Error('企小码部门范围为空')
  const ids = new Set<string>()
  const departments = input.departments.map((item: any, index: number) => {
    const departmentId = text(item?.departmentId), reviewServiceCenter = text(item?.reviewServiceCenter)
    if (!departmentId || departmentId.length > 256 || ids.has(departmentId)) throw new Error(`企小码第${index + 1}个部门ID为空、过长或重复`)
    if (!reviewServiceCenter || reviewServiceCenter.length > 120) throw new Error(`企小码第${index + 1}个复核服务中心无效`)
    if (!Array.isArray(item?.projects) || !item.projects.length) throw new Error(`企小码第${index + 1}个部门缺少受控项目映射`)
    const prefixes = new Set<string>()
    const projects = item.projects.map((project: any, projectIndex: number) => {
      const housePrefix = prefix(project?.housePrefix), serviceCenter = text(project?.serviceCenter)
      if (prefixes.has(housePrefix)) throw new Error(`企小码第${index + 1}个部门第${projectIndex + 1}个房屋前缀重复`)
      if (!serviceCenter || serviceCenter.length > 120) throw new Error(`企小码第${index + 1}个部门第${projectIndex + 1}个服务中心无效`)
      prefixes.add(housePrefix)
      return { housePrefix, serviceCenter }
    })
    ids.add(departmentId)
    return { departmentId, reviewServiceCenter, projects }
  })
  const pageSize = Number(input.pageSize), maximumPages = Number(input.maximumPages)
  if (!Number.isInteger(pageSize) || pageSize < 10 || pageSize > 20000) throw new Error('企小码单页数量超出允许范围')
  if (!Number.isInteger(maximumPages) || maximumPages < 1 || maximumPages > 10000) throw new Error('企小码最大页数超出允许范围')
  return { schemaVersion: 1, departments, pageSize, maximumPages }
}
function assertControlledFile(filePath: string, label: string, maximumBytes: number, exactMode?: number): fs.Stats {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}必须是普通文件且不得为符号链接`)
  if (stat.size <= 0 || stat.size > maximumBytes) throw new Error(`${label}大小异常`)
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${label}不属于当前任务用户`)
  if (exactMode !== undefined ? (stat.mode & 0o777) !== exactMode : (stat.mode & 0o027) !== 0) throw new Error(exactMode === 0o600 ? `${label}权限必须为600` : `${label}权限不得允许组写入或其他用户访问`)
  return stat
}
export function loadQxmEvidenceScopeConfig(configPath: string): QxmEvidenceScopeConfig {
  const resolved = path.resolve(configPath); assertControlledFile(resolved, '企小码证据范围配置', 128 * 1024)
  return validateQxmEvidenceScopeConfig(JSON.parse(fs.readFileSync(resolved, 'utf8')))
}
function validateCursorState(value: unknown, config: QxmEvidenceScopeConfig): QxmCursorState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('企小码游标状态必须是对象')
  const input = value as any
  if (input.schemaVersion !== 1 || !Array.isArray(input.departments)) throw new Error('企小码游标状态版本或结构无效')
  const expected = new Set(config.departments.map(item => departmentHash(item.departmentId))), seen = new Set<string>()
  const departments = input.departments.map((item: any) => {
    const departmentIdHash = text(item?.departmentIdHash), cursor = typeof item?.cursor === 'string' ? item.cursor : ''
    if (!/^[a-f0-9]{64}$/.test(departmentIdHash) || !expected.has(departmentIdHash) || seen.has(departmentIdHash)) throw new Error('企小码游标部门范围不完整、越权或重复')
    if (cursor.length > 4096) throw new Error('企小码增量游标过长')
    seen.add(departmentIdHash); return { departmentIdHash, cursor }
  })
  if (seen.size !== expected.size) throw new Error('企小码游标部门范围不完整、越权或重复')
  const updatedAt = text(input.updatedAt)
  if (!updatedAt || !Number.isFinite(new Date(updatedAt).getTime())) throw new Error('企小码游标更新时间无效')
  return { schemaVersion: 1, updatedAt, departments }
}
export function loadQxmCursorState(statePath: string, config: QxmEvidenceScopeConfig): QxmCursorState {
  const resolved = path.resolve(statePath); assertControlledFile(resolved, '企小码游标状态文件', 256 * 1024, 0o600)
  return validateCursorState(JSON.parse(fs.readFileSync(resolved, 'utf8')), config)
}
export function initialQxmCursorState(config: QxmEvidenceScopeConfig, now = new Date()): QxmCursorState {
  return { schemaVersion: 1, updatedAt: now.toISOString(), departments: config.departments.map(item => ({ departmentIdHash: departmentHash(item.departmentId), cursor: '' })) }
}
export function saveQxmCursorState(statePath: string, state: QxmCursorState, config: QxmEvidenceScopeConfig): void {
  const resolved = path.resolve(statePath), directory = path.dirname(resolved)
  const dirStat = fs.lstatSync(directory)
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('企小码游标状态目录无效')
  if (typeof process.getuid === 'function' && dirStat.uid !== process.getuid()) throw new Error('企小码游标状态目录不属于当前任务用户')
  if ((dirStat.mode & 0o022) !== 0) throw new Error('企小码游标状态目录不得允许组或其他用户写入')
  if (fs.existsSync(resolved)) assertControlledFile(resolved, '企小码游标状态文件', 256 * 1024, 0o600)
  const checked = validateCursorState(state, config)
  const temporary = path.join(directory, `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
  try { fs.writeFileSync(temporary, `${JSON.stringify(checked)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.chmodSync(temporary, 0o600); fs.renameSync(temporary, resolved) } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }) }
}
function summary(payload: NormalizedQxmEvidenceEnvelope, config: QxmEvidenceScopeConfig, mode: 'dry-run' | 'published', publication: QxmPublicationResult | null, cursorAdvanced: boolean): QxmEvidenceJobSummary {
  return { mode, source: 'qxm', businessDate: payload.businessDate, extractedAt: payload.extractedAt, departmentScopeCount: config.departments.length, rowCount: payload.quality.rowCount, matchedCount: payload.quality.matchedCount, isolatedUnlinkedCount: payload.quality.isolatedUnlinkedCount, supportedSignalCount: payload.quality.supportedSignalCount, conflictedSignalCount: payload.quality.conflictedSignalCount, authoritativeAmountFields: 0, qualityState: payload.quality.state, cursorAdvanced, publication }
}
function shardErrorCode(error: unknown): QxmEvidenceShardedJobSummary['failures'][number]['errorCode'] {
  const message = error instanceof Error ? error.message : String(error || '')
  if (/超过受控时限|timeout|timed out/i.test(message)) return 'source_timeout'
  if (/会话失效|session expired/i.test(message)) return 'session_expired'
  if (/abort|取消|终止/i.test(message)) return 'aborted'
  return 'source_error'
}

function persistShardStatus(database: Database.Database, input: {
  departmentIdHash: string
  serviceCenters: string[]
  businessDate: string
  extractedAt: string
  state: 'passed' | 'failed'
  errorCode: string
  rows?: NormalizedQxmEvidenceEnvelope['rows']
  cursorAdvanced: boolean
  runId: number | null
}): void {
  const statement = database.prepare(`INSERT INTO arrears_qxm_shard_status
    (department_id_hash,service_center,business_date,extracted_at,state,error_code,row_count,matched_count,isolated_count,cursor_advanced,run_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(department_id_hash,service_center) DO UPDATE SET business_date=excluded.business_date,extracted_at=excluded.extracted_at,state=excluded.state,error_code=excluded.error_code,row_count=excluded.row_count,matched_count=excluded.matched_count,isolated_count=excluded.isolated_count,cursor_advanced=excluded.cursor_advanced,run_id=excluded.run_id`)
  for (const serviceCenter of [...new Set(input.serviceCenters)]) {
    const rows = (input.rows || []).filter(row => row.serviceCenter === serviceCenter)
    statement.run(input.departmentIdHash, serviceCenter, input.businessDate, input.extractedAt, input.state, input.errorCode, rows.length, rows.filter(row => row.matchState === 'matched').length, rows.filter(row => row.matchState === 'review_required').length, input.cursorAdvanced ? 1 : 0, input.runId)
  }
}

export async function runQxmEvidenceShardedJob(options: { config: QxmEvidenceScopeConfig; cursorState: QxmCursorState; cursorStatePath?: string; transport: QxmEvidenceTransport; businessDate?: string; now?: Date; publish?: boolean; publishConfirmation?: string; nodeEnv?: string; database?: Database.Database; signal?: AbortSignal }): Promise<QxmEvidenceShardedJobSummary> {
  const businessDate = options.businessDate || northChinaBusinessDate(options.now)
  if (!validBusinessDate(businessDate)) throw new Error('企小码证据任务业务日期无效')
  if (options.publish && !publicationConfirmed(businessDate, options.publishConfirmation, options.nodeEnv)) throw new Error('企小码证据正式发布缺少生产环境与业务日期双重确认')
  if (options.publish && (!options.database || !options.cursorStatePath)) throw new Error('企小码证据正式发布缺少受控数据库或游标状态路径')
  const checkedState = validateCursorState(options.cursorState, options.config)
  const cursors = new Map(checkedState.departments.map(item => [item.departmentIdHash, item.cursor]))
  const nextCursors = new Map(cursors)
  const failures: QxmEvidenceShardedJobSummary['failures'] = []
  let successfulDepartmentCount = 0, publishedDepartmentCount = 0, cursorAdvancedCount = 0
  let rowCount = 0, matchedCount = 0, isolatedUnlinkedCount = 0, supportedSignalCount = 0, conflictedSignalCount = 0
  for (const scope of options.config.departments) {
    const scopeHash = departmentHash(scope.departmentId)
    const connector = new QxmIncrementalEvidenceConnector(options.transport, {
      businessDate,
      pageSize: options.config.pageSize,
      maximumPages: options.config.maximumPages,
      scopes: [{ ...scope, cursor: cursors.get(scopeHash) || '' }],
      extractedAt: options.now ? () => options.now!.toISOString() : undefined,
    })
    try {
      const normalized = await readAndNormalizeQxmEvidence(connector, { signal: options.signal, now: options.now })
      if (options.publish) {
        const publication = publishQxmEvidence(options.database!, normalized)
        publishedDepartmentCount += 1
        const next = normalized.nextCursors.find(item => item.departmentIdHash === scopeHash)
        if (!next) throw new Error('企小码成功分片缺少对应增量游标')
        nextCursors.set(scopeHash, next.cursor)
        cursorAdvancedCount += 1
        persistShardStatus(options.database!, { departmentIdHash: scopeHash, serviceCenters: scope.projects.map(project => project.serviceCenter), businessDate, extractedAt: normalized.extractedAt, state: 'passed', errorCode: '', rows: normalized.rows, cursorAdvanced: true, runId: publication.runId })
      }
      successfulDepartmentCount += 1
      rowCount += normalized.quality.rowCount
      matchedCount += normalized.quality.matchedCount
      isolatedUnlinkedCount += normalized.quality.isolatedUnlinkedCount
      supportedSignalCount += normalized.quality.supportedSignalCount
      conflictedSignalCount += normalized.quality.conflictedSignalCount
    } catch (error) {
      const errorCode = shardErrorCode(error)
      failures.push({ departmentIdHash: scopeHash, errorCode })
      if (options.publish) persistShardStatus(options.database!, { departmentIdHash: scopeHash, serviceCenters: scope.projects.map(project => project.serviceCenter), businessDate, extractedAt: (options.now || new Date()).toISOString(), state: 'failed', errorCode, cursorAdvanced: false, runId: null })
    }
  }
  if (options.publish && cursorAdvancedCount > 0) {
    saveQxmCursorState(options.cursorStatePath!, {
      schemaVersion: 1,
      updatedAt: (options.now || new Date()).toISOString(),
      departments: checkedState.departments.map(item => ({ departmentIdHash: item.departmentIdHash, cursor: nextCursors.get(item.departmentIdHash) ?? item.cursor })),
    }, options.config)
  }
  const qualityState = failures.length === 0 ? 'passed' : successfulDepartmentCount > 0 ? 'partial' : 'failed'
  return {
    mode: options.publish ? 'published' : 'dry-run',
    source: 'qxm',
    businessDate,
    extractedAt: (options.now || new Date()).toISOString(),
    departmentScopeCount: options.config.departments.length,
    successfulDepartmentCount,
    publishedDepartmentCount,
    failedDepartmentCount: failures.length,
    cursorAdvancedCount,
    rowCount,
    matchedCount,
    isolatedUnlinkedCount,
    supportedSignalCount,
    conflictedSignalCount,
    authoritativeAmountFields: 0,
    qualityState,
    failures,
  }
}

export async function runQxmEvidenceJob(options: { config: QxmEvidenceScopeConfig; cursorState: QxmCursorState; cursorStatePath?: string; transport: QxmEvidenceTransport; businessDate?: string; now?: Date; publish?: boolean; publishConfirmation?: string; nodeEnv?: string; database?: Database.Database; signal?: AbortSignal }): Promise<QxmEvidenceJobSummary> {
  const businessDate = options.businessDate || northChinaBusinessDate(options.now)
  if (!validBusinessDate(businessDate)) throw new Error('企小码证据任务业务日期无效')
  if (options.publish && !publicationConfirmed(businessDate, options.publishConfirmation, options.nodeEnv)) throw new Error('企小码证据正式发布缺少生产环境与业务日期双重确认')
  if (options.publish && (!options.database || !options.cursorStatePath)) throw new Error('企小码证据正式发布缺少受控数据库或游标状态路径')
  const checkedState = validateCursorState(options.cursorState, options.config)
  const cursors = new Map(checkedState.departments.map(item => [item.departmentIdHash, item.cursor]))
  const connector = new QxmIncrementalEvidenceConnector(options.transport, { businessDate, pageSize: options.config.pageSize, maximumPages: options.config.maximumPages, scopes: options.config.departments.map(item => ({ ...item, cursor: cursors.get(departmentHash(item.departmentId)) || '' })), extractedAt: options.now ? () => options.now!.toISOString() : undefined })
  const normalized = await readAndNormalizeQxmEvidence(connector, { signal: options.signal, now: options.now })
  if (!options.publish) return summary(normalized, options.config, 'dry-run', null, false)
  const publication = publishQxmEvidence(options.database!, normalized)
  const nextState: QxmCursorState = { schemaVersion: 1, updatedAt: (options.now || new Date()).toISOString(), departments: normalized.nextCursors.map(item => ({ departmentIdHash: item.departmentIdHash, cursor: item.cursor })) }
  saveQxmCursorState(options.cursorStatePath!, nextState, options.config)
  return summary(normalized, options.config, 'published', publication, true)
}
