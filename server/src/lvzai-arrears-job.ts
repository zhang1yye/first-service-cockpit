import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { readAndNormalizeLvzaiArrears, type NormalizedLvzaiEnvelope } from './arrears-connectors.js'
import { publishLvzaiArrears, type LvzaiPublicationResult } from './arrears-connector-store.js'
import { LvzaiGetArrearageConnector, type LvzaiArrearageTransport } from './lvzai-arrears-adapter.js'

export type LvzaiArrearsScopeProject = {
  regionId: string
  housePrefix: string
  serviceCenter: string
}

export type LvzaiArrearsScopeConfig = {
  schemaVersion: 1
  projects: LvzaiArrearsScopeProject[]
  minimumRows: number
}

export type LvzaiArrearsJobSummary = {
  mode: 'dry-run' | 'published'
  source: 'lvzai'
  businessDate: string
  extractedAt: string
  projectScopeCount: number
  rowCount: number
  uniqueHouseCount: number
  totalAmount: number
  qualityState: 'passed'
  publication: LvzaiPublicationResult | null
}

const SENSITIVE_CONFIG_KEY = /(?:password|passwd|pwd|secret|token|cookie|authorization|session|credential)/i

function text(value: unknown): string { return value === null || value === undefined ? '' : String(value).normalize('NFKC').trim() }
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  const result = Number(value)
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${label}超出允许范围`)
  return result
}
function prefix(value: unknown): string {
  const result = text(value).toUpperCase().replace(/[－—–_/\\]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (!/^[A-Z]{2,3}-[A-Z0-9]+$/.test(result)) throw new Error('房屋号项目前缀必须是城市代码-项目代码')
  return result
}
function assertNoSensitiveKeys(value: unknown, location = '配置'): void {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSensitiveKeys(item, `${location}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_CONFIG_KEY.test(key)) throw new Error(`${location}不得包含凭据字段`)
    assertNoSensitiveKeys(item, `${location}.${key}`)
  }
}

export function validateLvzaiArrearsScopeConfig(value: unknown): LvzaiArrearsScopeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('绿仔欠费范围配置必须是对象')
  const input = value as any
  if (input.schemaVersion !== 1) throw new Error('绿仔欠费范围配置版本不受支持')
  assertNoSensitiveKeys(input)
  if (!Array.isArray(input.projects) || !input.projects.length) throw new Error('绿仔欠费项目范围为空')
  const regionIds = new Set<string>()
  const projects = input.projects.map((item: any, index: number) => {
    const regionId = text(item?.regionId)
    const serviceCenter = text(item?.serviceCenter)
    if (!regionId || regionId.length > 128) throw new Error(`第${index + 1}个绿仔regionId无效`)
    if (!serviceCenter || serviceCenter.length > 120) throw new Error(`第${index + 1}个服务中心名称无效`)
    if (regionIds.has(regionId)) throw new Error(`绿仔regionId重复：第${index + 1}项`)
    regionIds.add(regionId)
    return { regionId, housePrefix: prefix(item?.housePrefix), serviceCenter }
  })
  return {
    schemaVersion: 1,
    projects,
    minimumRows: integer(input.minimumRows, '最低明细行数', projects.length, 5_000_000),
  }
}

export function loadLvzaiArrearsScopeConfig(configPath: string): LvzaiArrearsScopeConfig {
  const resolved = path.resolve(configPath)
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('绿仔欠费范围配置必须是普通文件且不得为符号链接')
  if (stat.size <= 0 || stat.size > 128 * 1024) throw new Error('绿仔欠费范围配置文件大小异常')
  if ((stat.mode & 0o027) !== 0) throw new Error('绿仔欠费范围配置权限不得允许组写入或其他用户访问')
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('绿仔欠费范围配置不属于当前任务用户')
  return validateLvzaiArrearsScopeConfig(JSON.parse(fs.readFileSync(resolved, 'utf8')))
}

export function northChinaBusinessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const values = Object.fromEntries(parts.map(item => [item.type, item.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function publicationConfirmed(businessDate: string, confirmation: string | undefined, nodeEnv: string | undefined): boolean {
  return nodeEnv === 'production' && confirmation === businessDate
}

function connector(config: LvzaiArrearsScopeConfig, transport: LvzaiArrearageTransport, businessDate: string, now?: Date) {
  return new LvzaiGetArrearageConnector(transport, {
    businessDate,
    projects: config.projects.map(item => ({ regionId: item.regionId, housePrefix: item.housePrefix, serviceCenter: item.serviceCenter })),
    extractedAt: now ? () => now.toISOString() : undefined,
  })
}

function summary(payload: NormalizedLvzaiEnvelope, config: LvzaiArrearsScopeConfig, mode: 'dry-run' | 'published', publication: LvzaiPublicationResult | null): LvzaiArrearsJobSummary {
  return {
    mode,
    source: 'lvzai',
    businessDate: payload.businessDate,
    extractedAt: payload.extractedAt,
    projectScopeCount: config.projects.length,
    rowCount: payload.quality.rowCount,
    uniqueHouseCount: payload.quality.uniqueHouseCount,
    totalAmount: payload.quality.totalAmount,
    qualityState: payload.quality.state,
    publication,
  }
}

export async function runLvzaiArrearsJob(options: {
  config: LvzaiArrearsScopeConfig
  transport: LvzaiArrearageTransport
  businessDate?: string
  now?: Date
  publish?: boolean
  publishConfirmation?: string
  nodeEnv?: string
  database?: Database.Database
  signal?: AbortSignal
}): Promise<LvzaiArrearsJobSummary> {
  const businessDate = options.businessDate || northChinaBusinessDate(options.now)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new Error('绿仔欠费任务业务日期无效')
  if (options.publish && !publicationConfirmed(businessDate, options.publishConfirmation, options.nodeEnv)) throw new Error('绿仔欠费正式发布缺少生产环境与业务日期双重确认')
  if (options.publish && !options.database) throw new Error('绿仔欠费正式发布缺少受控数据库')
  const normalized = await readAndNormalizeLvzaiArrears(connector(options.config, options.transport, businessDate, options.now), {
    signal: options.signal,
    now: options.now,
    minimumRows: options.config.minimumRows,
    totalTolerance: 0.01,
  })
  if (!options.publish) return summary(normalized, options.config, 'dry-run', null)
  const publication = publishLvzaiArrears(options.database!, normalized)
  return summary(normalized, options.config, 'published', publication)
}
