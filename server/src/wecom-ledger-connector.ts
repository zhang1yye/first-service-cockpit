import crypto from 'node:crypto'
import { normalizeResourceKey, type ArrearsCause } from './arrears-analysis.js'
import { ArrearsConnectorGateError, type ArrearsSourceConnector, type ConnectorEnvelope } from './arrears-connectors.js'

export type WecomLedgerProgress = 'not_contacted' | 'in_progress' | 'promised_payment' | 'reported_paid_pending_lvzai' | 'legal_followup' | 'review_required'
export type NormalizedWecomLedgerRow = {
  source: 'wecom_ledger'
  businessDate: string
  houseCanonical: string
  houseDisplay: string
  houseHash: string
  serviceCenter: string
  documentIdHash: string
  sheetIdHash: string
  recordIdHash: string
  manualCause: ArrearsCause
  progress: WecomLedgerProgress
  latestFollowupDate: string
  promisedPaymentDate: string
  responsibleUserIdHash: string
  evidenceHash: string
}
export type NormalizedWecomLedgerEnvelope = {
  source: 'wecom_ledger'
  businessDate: string
  extractedAt: string
  rows: NormalizedWecomLedgerRow[]
  quality: {
    state: 'passed'
    source: 'wecom_ledger'
    businessDate: string
    rowCount: number
    uniqueHouseCount: number
    fullRoomSignCompletenessRate: 1
    stableEvidenceCompletenessRate: 1
    duplicateRecordCount: 0
    authoritativeAmountFields: 0
  }
}

export interface WecomLedgerTransport {
  readSheet(input: { documentId: string; sheetId: string; businessDate: string }, signal?: AbortSignal): Promise<{ rows: Record<string, unknown>[]; total: number }>
}
export type WecomLedgerProjectScope = { housePrefix: string; serviceCenter: string }
export type WecomLedgerSheetScope = { sheetId: string; projects: WecomLedgerProjectScope[] }

const DATE = /^\d{4}-\d{2}-\d{2}$/
function text(value: unknown): string { return value === null || value === undefined ? '' : String(value).normalize('NFKC').trim() }
function first(row: Record<string, unknown>, keys: string[]): unknown { for (const key of keys) if (text(row[key])) return row[key] }
function key(): string {
  const value = String(process.env.ARREARS_RESOURCE_HASH_KEY || '')
  if (value.length < 32) throw new ArrearsConnectorGateError(['ARREARS_RESOURCE_HASH_KEY未配置或长度不足32位'])
  return value
}
function hmac(value: string, secret: string): string { return crypto.createHmac('sha256', secret).update(value).digest('hex') }
function validDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}
function date(value: unknown): string {
  const normalized = text(value).replace(/[./年]/g, '-').replace(/月|日/g, '').replace(/-+/g, '-').replace(/-$/g, '')
  return validDate(normalized) ? normalized : ''
}
function cause(value: unknown): ArrearsCause {
  const raw = text(value)
  const rules: Array<[ArrearsCause, RegExp]> = [
    ['legal_dispute', /法律|诉讼|仲裁|律师|法院/], ['service_dispute', /服务|维修|品质|投诉/],
    ['charge_dispute', /收费|账单|金额|计费|费用争议/], ['vacancy', /空置|未入住/],
    ['financial_hardship', /困难|失业|资金|周转|分期/], ['ownership_or_handover', /产权|交付|收房|过户|开发商/],
    ['contact_barrier', /失联|联系不上|拒接|空号|停机/], ['promised_payment', /承诺|答应|计划缴费/],
  ]
  return rules.find(([, pattern]) => pattern.test(raw))?.[0] || 'unknown'
}
function progress(value: unknown): WecomLedgerProgress {
  const raw = text(value)
  if (/已缴|已支付|已转账|已付款/.test(raw)) return 'reported_paid_pending_lvzai'
  if (/诉讼|仲裁|律师|法律/.test(raw)) return 'legal_followup'
  if (/承诺|答应|计划缴费/.test(raw)) return 'promised_payment'
  if (/未联系|尚未联系/.test(raw)) return 'not_contacted'
  if (/跟进|催缴|沟通|处理中/.test(raw)) return 'in_progress'
  return 'review_required'
}
function canonical(value: Record<string, unknown>) {
  return normalizeResourceKey({ 房屋编码: first(value, ['roomSign', '房屋编号', '房屋编码', '资源编码', '标准房屋号']) })
}
function compactIssues(issues: string[]): string[] {
  const counts = new Map<string, number>(), preserved: string[] = []
  for (const issue of issues) {
    const match = issue.match(/^企业微信台账第\d+行(.+)$/)
    if (!match) { preserved.push(issue); continue }
    counts.set(match[1], (counts.get(match[1]) || 0) + 1)
  }
  return [...new Set(preserved), ...[...counts.entries()].map(([message, count]) => `企业微信台账${message}（${count}行）`)]
}

export class WecomControlledLedgerConnector implements ArrearsSourceConnector<Record<string, unknown>> {
  readonly source = 'wecom_ledger' as const
  constructor(readonly transport: WecomLedgerTransport, readonly options: {
    businessDate: string
    documentId: string
    sheets: WecomLedgerSheetScope[]
    extractedAt?: () => string
  }) {
    if (!validDate(options.businessDate)) throw new Error('企业微信台账业务日期无效')
    if (!text(options.documentId) || !options.sheets.length) throw new Error('企业微信台账文档或工作表范围为空')
    const sheets = new Set<string>()
    for (const sheet of options.sheets) {
      if (!text(sheet.sheetId) || sheets.has(text(sheet.sheetId))) throw new Error('企业微信台账工作表ID为空或重复')
      if (!Array.isArray(sheet.projects) || !sheet.projects.length) throw new Error('企业微信台账工作表缺少受控项目映射')
      const prefixes = new Set<string>()
      for (const project of sheet.projects) {
        const housePrefix = text(project.housePrefix).toUpperCase()
        if (!/^[A-Z]{2,3}-[A-Z0-9]+$/.test(housePrefix) || prefixes.has(housePrefix)) throw new Error('企业微信台账房屋前缀无效或重复')
        if (!text(project.serviceCenter)) throw new Error('企业微信台账项目映射缺少服务中心')
        prefixes.add(housePrefix)
      }
      sheets.add(text(sheet.sheetId))
    }
  }
  async read(signal?: AbortSignal): Promise<ConnectorEnvelope<Record<string, unknown>>> {
    const rows: Record<string, unknown>[] = []
    let declaredRowCount = 0
    for (const sheet of this.options.sheets) {
      const response = await this.transport.readSheet({ documentId: this.options.documentId, sheetId: sheet.sheetId, businessDate: this.options.businessDate }, signal)
      if (!response || !Array.isArray(response.rows) || !Number.isInteger(response.total) || response.total !== response.rows.length) throw new Error('企业微信台账工作表声明行数与读取行数不一致')
      declaredRowCount += response.total
      const projects = new Map(sheet.projects.map(project => [text(project.housePrefix).toUpperCase(), project]))
      rows.push(...response.rows.map(row => {
        const resource = canonical(row)
        const housePrefix = resource?.canonical.startsWith('H:') ? resource.display.split('-').slice(0, 2).join('-') : ''
        const project = projects.get(housePrefix)
        return { ...row, __documentId: this.options.documentId, __sheetId: sheet.sheetId, __housePrefix: housePrefix, __serviceCenter: project?.serviceCenter || '', __projectMappingFound: Boolean(project) }
      }))
    }
    return { source: 'wecom_ledger', businessDate: this.options.businessDate, extractedAt: (this.options.extractedAt || (() => new Date().toISOString()))(), rows, declaredRowCount }
  }
}

export function normalizeWecomLedgerEnvelope(envelope: ConnectorEnvelope<Record<string, unknown>>, options: { now?: Date; minimumRows?: number } = {}): NormalizedWecomLedgerEnvelope {
  const issues: string[] = []
  const now = options.now || new Date()
  if (envelope.source !== 'wecom_ledger') issues.push('来源必须为wecom_ledger')
  if (!validDate(text(envelope.businessDate)) || new Date(`${envelope.businessDate}T00:00:00+08:00`).getTime() > now.getTime()) issues.push('企业微信台账业务日期无效或晚于当前时间')
  const extractedAt = new Date(envelope.extractedAt)
  if (!Number.isFinite(extractedAt.getTime()) || extractedAt.getTime() > now.getTime() + 300_000) issues.push('企业微信台账提取时间无效')
  if (!Array.isArray(envelope.rows) || envelope.rows.length < Math.max(1, Math.trunc(options.minimumRows || 1))) issues.push('企业微信台账明细为空或少于门禁下限')
  if (envelope.declaredRowCount !== undefined && envelope.declaredRowCount !== envelope.rows.length) issues.push('企业微信台账声明行数与明细行数不一致')
  if (issues.length) throw new ArrearsConnectorGateError(issues)

  const secret = key(), records = new Set<string>(), rows: NormalizedWecomLedgerRow[] = []
  envelope.rows.forEach((raw, index) => {
    const line = index + 1
    const resource = canonical(raw)
    if (!resource?.canonical.startsWith('H:')) issues.push(`企业微信台账第${line}行缺少完整五段式房屋号`)
    const allowedPrefix = text(raw.__housePrefix).toUpperCase()
    if (resource?.canonical.startsWith('H:') && resource.display.split('-').slice(0, 2).join('-') !== allowedPrefix) issues.push(`企业微信台账第${line}行房屋号超出工作表授权前缀`)
    const documentId = text(raw.__documentId), sheetId = text(raw.__sheetId), serviceCenter = text(raw.__serviceCenter)
    const isFullResource = Boolean(resource?.canonical.startsWith('H:'))
    if (isFullResource && raw.__projectMappingFound === false) issues.push(`企业微信台账第${line}行房屋前缀未配置受控项目映射`)
    if (isFullResource && !serviceCenter) issues.push(`企业微信台账第${line}行缺少服务中心`)
    const recordId = text(first(raw, ['recordId', 'rowId', '记录ID', '行ID', 'record_id']))
    if (!documentId || !sheetId || !recordId) issues.push(`企业微信台账第${line}行缺少稳定证据ID`)
    const identity = `${documentId}\u0000${sheetId}\u0000${recordId}`
    if (recordId && records.has(identity)) issues.push(`企业微信台账第${line}行记录ID重复`)
    records.add(identity)
    const latestFollowupDate = date(first(raw, ['latestFollowupDate', '最新跟进日期', '催缴日期', '更新时间']))
    const promisedPaymentDate = date(first(raw, ['promisedPaymentDate', '承诺缴费日期', '计划缴费日期']))
    const latestRaw = text(first(raw, ['latestFollowupDate', '最新跟进日期', '催缴日期', '更新时间']))
    const promisedRaw = text(first(raw, ['promisedPaymentDate', '承诺缴费日期', '计划缴费日期']))
    if (latestRaw && !latestFollowupDate) issues.push(`企业微信台账第${line}行最新跟进日期无效`)
    if (promisedRaw && !promisedPaymentDate) issues.push(`企业微信台账第${line}行承诺缴费日期无效`)
    const manualCause = cause(first(raw, ['causeCategory', '欠费原因分类', '欠费原因', '未缴原因', '原因说明']))
    const progressValue = progress(first(raw, ['progress', '催缴进展', '本周进展', '当前进展', '跟进状态']))
    const responsibleUserId = text(first(raw, ['responsibleUserId', '主责人ID', '责任人ID', '经办人ID']))
    if (!resource || !documentId || !sheetId || !recordId || !serviceCenter) return
    const structured = { house: resource.canonical, serviceCenter, documentIdHash: hmac(documentId, secret), sheetIdHash: hmac(sheetId, secret), recordIdHash: hmac(recordId, secret), manualCause, progress: progressValue, latestFollowupDate, promisedPaymentDate, responsibleUserIdHash: responsibleUserId ? hmac(responsibleUserId, secret) : '' }
    rows.push({ source: 'wecom_ledger', businessDate: envelope.businessDate, houseCanonical: resource.canonical, houseDisplay: resource.display, houseHash: hmac(resource.canonical, secret), ...structured, evidenceHash: crypto.createHash('sha256').update(JSON.stringify(structured)).digest('hex') })
  })
  if (rows.length !== envelope.rows.length) issues.push('企业微信台账标准化行数与源明细行数不一致')
  if (issues.length) throw new ArrearsConnectorGateError(compactIssues(issues))
  return { source: 'wecom_ledger', businessDate: envelope.businessDate, extractedAt: envelope.extractedAt, rows, quality: { state: 'passed', source: 'wecom_ledger', businessDate: envelope.businessDate, rowCount: rows.length, uniqueHouseCount: new Set(rows.map(row => row.houseCanonical)).size, fullRoomSignCompletenessRate: 1, stableEvidenceCompletenessRate: 1, duplicateRecordCount: 0, authoritativeAmountFields: 0 } }
}

export async function readAndNormalizeWecomLedger(connector: ArrearsSourceConnector<Record<string, unknown>>, options: { signal?: AbortSignal; now?: Date; minimumRows?: number } = {}) {
  if (connector.source !== 'wecom_ledger') throw new ArrearsConnectorGateError(['连接器来源与企业微信台账标准化器不一致'])
  return normalizeWecomLedgerEnvelope(await connector.read(options.signal), options)
}
