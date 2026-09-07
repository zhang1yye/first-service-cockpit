import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { publishWecomLedger, type WecomLedgerPublicationResult } from './arrears-connector-store.js'
import { northChinaBusinessDate, publicationConfirmed } from './lvzai-arrears-job.js'
import { WecomControlledLedgerConnector, readAndNormalizeWecomLedger, type NormalizedWecomLedgerEnvelope, type WecomLedgerTransport } from './wecom-ledger-connector.js'

export type WecomLedgerScopeConfig = {
  schemaVersion: 1
  documentId: string
  sheets: Array<{ sheetId: string; projects: Array<{ housePrefix: string; serviceCenter: string }> }>
  minimumRows: number
}
export type WecomLedgerJobSummary = {
  mode: 'dry-run' | 'published'
  source: 'wecom_ledger'
  businessDate: string
  extractedAt: string
  sheetScopeCount: number
  rowCount: number
  uniqueHouseCount: number
  authoritativeAmountFields: 0
  qualityState: 'passed'
  publication: WecomLedgerPublicationResult | null
}

const SENSITIVE = /(?:password|passwd|pwd|secret|token|cookie|authorization|session|credential)/i
function text(value: unknown): string { return value === null || value === undefined ? '' : String(value).normalize('NFKC').trim() }
function noSensitiveKeys(value: unknown, location = '配置'): void {
  if (Array.isArray(value)) return value.forEach((item, index) => noSensitiveKeys(item, `${location}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE.test(name)) throw new Error(`${location}不得包含凭据字段`)
    noSensitiveKeys(item, `${location}.${name}`)
  }
}
function prefix(value: unknown): string {
  const result = text(value).toUpperCase().replace(/[－—–_/\\]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (!/^[A-Z]{2,3}-[A-Z0-9]+$/.test(result)) throw new Error('企业微信房屋前缀必须是城市代码-项目代码')
  return result
}

export function validateWecomLedgerScopeConfig(value: unknown): WecomLedgerScopeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('企业微信台账范围配置必须是对象')
  const input = value as any
  if (input.schemaVersion !== 1) throw new Error('企业微信台账范围配置版本不受支持')
  noSensitiveKeys(input)
  const documentId = text(input.documentId)
  if (!documentId || documentId.length > 256) throw new Error('企业微信台账documentId无效')
  if (!Array.isArray(input.sheets) || !input.sheets.length) throw new Error('企业微信台账工作表范围为空')
  const ids = new Set<string>()
  const sheets = input.sheets.map((item: any, index: number) => {
    const sheetId = text(item?.sheetId)
    if (!sheetId || sheetId.length > 256 || ids.has(sheetId)) throw new Error(`企业微信第${index + 1}个工作表ID为空、过长或重复`)
    if (!Array.isArray(item?.projects) || !item.projects.length) throw new Error(`企业微信第${index + 1}个工作表项目映射为空`)
    const projectPrefixes = new Set<string>()
    const projects = item.projects.map((project: any, projectIndex: number) => {
      const housePrefix = prefix(project?.housePrefix), serviceCenter = text(project?.serviceCenter)
      if (projectPrefixes.has(housePrefix)) throw new Error(`企业微信第${index + 1}个工作表第${projectIndex + 1}个房屋前缀重复`)
      if (!serviceCenter || serviceCenter.length > 120) throw new Error(`企业微信第${index + 1}个工作表第${projectIndex + 1}个服务中心无效`)
      projectPrefixes.add(housePrefix)
      return { housePrefix, serviceCenter }
    })
    ids.add(sheetId)
    return { sheetId, projects }
  })
  const minimumRows = Number(input.minimumRows)
  if (!Number.isInteger(minimumRows) || minimumRows < sheets.length || minimumRows > 5_000_000) throw new Error('企业微信台账最低行数超出允许范围')
  return { schemaVersion: 1, documentId, sheets, minimumRows }
}

export function loadWecomLedgerScopeConfig(configPath: string): WecomLedgerScopeConfig {
  const resolved = path.resolve(configPath)
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('企业微信台账范围配置必须是普通文件且不得为符号链接')
  if (stat.size <= 0 || stat.size > 128 * 1024) throw new Error('企业微信台账范围配置文件大小异常')
  if ((stat.mode & 0o027) !== 0) throw new Error('企业微信台账范围配置权限不得允许组写入或其他用户访问')
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('企业微信台账范围配置不属于当前任务用户')
  return validateWecomLedgerScopeConfig(JSON.parse(fs.readFileSync(resolved, 'utf8')))
}

function summary(payload: NormalizedWecomLedgerEnvelope, config: WecomLedgerScopeConfig, mode: 'dry-run' | 'published', publication: WecomLedgerPublicationResult | null): WecomLedgerJobSummary {
  return { mode, source: 'wecom_ledger', businessDate: payload.businessDate, extractedAt: payload.extractedAt, sheetScopeCount: config.sheets.length, rowCount: payload.quality.rowCount, uniqueHouseCount: payload.quality.uniqueHouseCount, authoritativeAmountFields: 0, qualityState: payload.quality.state, publication }
}

export async function runWecomLedgerJob(options: {
  config: WecomLedgerScopeConfig
  transport: WecomLedgerTransport
  businessDate?: string
  now?: Date
  publish?: boolean
  publishConfirmation?: string
  nodeEnv?: string
  database?: Database.Database
  signal?: AbortSignal
}): Promise<WecomLedgerJobSummary> {
  const businessDate = options.businessDate || northChinaBusinessDate(options.now)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new Error('企业微信台账任务业务日期无效')
  if (options.publish && !publicationConfirmed(businessDate, options.publishConfirmation, options.nodeEnv)) throw new Error('企业微信台账正式发布缺少生产环境与业务日期双重确认')
  if (options.publish && !options.database) throw new Error('企业微信台账正式发布缺少受控数据库')
  const connector = new WecomControlledLedgerConnector(options.transport, { businessDate, documentId: options.config.documentId, sheets: options.config.sheets, extractedAt: options.now ? () => options.now!.toISOString() : undefined })
  const normalized = await readAndNormalizeWecomLedger(connector, { signal: options.signal, now: options.now, minimumRows: options.config.minimumRows })
  if (!options.publish) return summary(normalized, options.config, 'dry-run', null)
  return summary(normalized, options.config, 'published', publishWecomLedger(options.database!, normalized))
}
