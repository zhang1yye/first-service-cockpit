import crypto from 'node:crypto'
import { normalizeResourceKey } from './arrears-analysis.js'

export type ArrearsSource = 'lvzai' | 'wecom_ledger' | 'qxm'

export type ConnectorEnvelope<TRow extends Record<string, unknown>> = {
  source: ArrearsSource
  businessDate: string
  extractedAt: string
  rows: TRow[]
  declaredRowCount?: number
  declaredTotalAmount?: number
}

export type NormalizedLvzaiArrearsRow = {
  source: 'lvzai'
  businessDate: string
  houseCanonical: string
  houseDisplay: string
  houseHash: string
  serviceCenter: string
  roomIdHash: string
  personIdHash: string
  feeItem: string
  amount: number
  periodStart: string
  periodEnd: string
  paymentStatus: string
  sourceEvidenceHash: string
}

export type ArrearsConnectorQuality = {
  state: 'passed'
  source: 'lvzai'
  businessDate: string
  rowCount: number
  uniqueHouseCount: number
  totalAmount: number
  roomSignCompletenessRate: 1
  amountCompletenessRate: 1
  duplicateCount: 0
}

export type NormalizedLvzaiEnvelope = {
  source: 'lvzai'
  businessDate: string
  extractedAt: string
  rows: NormalizedLvzaiArrearsRow[]
  quality: ArrearsConnectorQuality
}

export interface ArrearsSourceConnector<TRaw extends Record<string, unknown>> {
  readonly source: ArrearsSource
  read(signal?: AbortSignal): Promise<ConnectorEnvelope<TRaw>>
}

export class ArrearsConnectorGateError extends Error {
  readonly code = 'ARREARS_CONNECTOR_QUALITY_BLOCKED'
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`欠费连接器数据质量门禁未通过：${issues.join('；')}`)
    this.name = 'ArrearsConnectorGateError'
    this.issues = [...issues]
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const PERIOD_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?$/

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).normalize('NFKC').trim()
}

function first(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (row[key] !== null && row[key] !== undefined && text(row[key])) return row[key]
  return undefined
}

function finiteAmount(value: unknown): number | null {
  const normalized = text(value).replace(/[¥￥,，\s]/g, '')
  if (!normalized) return null
  const amount = Number(normalized)
  return Number.isFinite(amount) && amount >= 0 ? amount : null
}

function period(value: unknown): string {
  const normalized = text(value).replace(/[./年]/g, '-').replace(/月|日/g, '').replace(/-+/g, '-').replace(/-$/g, '')
  return PERIOD_PATTERN.test(normalized) ? normalized : ''
}

function secret(): string {
  const value = String(process.env.ARREARS_RESOURCE_HASH_KEY || '')
  if (value.length < 32) throw new ArrearsConnectorGateError(['ARREARS_RESOURCE_HASH_KEY未配置或长度不足32位'])
  return value
}

function hmac(value: string, key: string): string {
  return crypto.createHmac('sha256', key).update(value).digest('hex')
}

function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(value).sort().reduce<Record<string, unknown>>((result, key) => {
    result[key] = value[key]
    return result
  }, {}))
}

function validateEnvelope(envelope: ConnectorEnvelope<Record<string, unknown>>, now: Date): string[] {
  const issues: string[] = []
  if (envelope.source !== 'lvzai') issues.push('来源必须为lvzai')
  if (!DATE_PATTERN.test(text(envelope.businessDate))) issues.push('业务日期格式必须为YYYY-MM-DD')
  else {
    const businessDate = new Date(`${envelope.businessDate}T00:00:00+08:00`)
    if (!Number.isFinite(businessDate.getTime())) issues.push('业务日期无效')
    else if (businessDate.getTime() > now.getTime()) issues.push('业务日期不得晚于当前时间')
  }
  const extractedAt = new Date(envelope.extractedAt)
  if (!Number.isFinite(extractedAt.getTime())) issues.push('提取时间无效')
  else if (extractedAt.getTime() > now.getTime() + 5 * 60_000) issues.push('提取时间不得晚于当前时间5分钟以上')
  if (!Array.isArray(envelope.rows) || !envelope.rows.length) issues.push('逐户欠费明细为空')
  if (envelope.declaredRowCount !== undefined && envelope.declaredRowCount !== envelope.rows.length) issues.push('声明行数与明细行数不一致')
  return issues
}

export function normalizeLvzaiArrearsEnvelope(
  envelope: ConnectorEnvelope<Record<string, unknown>>,
  options: { now?: Date; minimumRows?: number; totalTolerance?: number } = {},
): NormalizedLvzaiEnvelope {
  const now = options.now || new Date()
  const issues = validateEnvelope(envelope, now)
  const minimumRows = Math.max(1, Math.trunc(options.minimumRows ?? 1))
  if (Array.isArray(envelope.rows) && envelope.rows.length < minimumRows) issues.push(`逐户欠费明细少于门禁下限${minimumRows}行`)
  if (issues.length) throw new ArrearsConnectorGateError(issues)

  const key = secret()
  const rows: NormalizedLvzaiArrearsRow[] = []
  const identities = new Set<string>()
  let duplicateCount = 0

  envelope.rows.forEach((raw, index) => {
    const sourceRow = index + 1
    const roomSign = text(first(raw, ['roomSign', 'room_sign', '房屋编码', '房屋号']))
    const resource = normalizeResourceKey({ 房屋编码: roomSign })
    const validFullResource = Boolean(resource?.canonical.startsWith('H:'))
    if (!validFullResource) issues.push(`第${sourceRow}行缺少有效五段式roomSign`)
    const serviceCenter = text(first(raw, ['serviceCenter', 'service_center', '服务中心']))
    if (!serviceCenter) issues.push(`第${sourceRow}行缺少服务中心`)
    const roomId = text(first(raw, ['roomId', 'room_id']))
    const personId = text(first(raw, ['personId', 'person_id']))
    if (!roomId) issues.push(`第${sourceRow}行缺少roomId`)
    if (!personId) issues.push(`第${sourceRow}行缺少personId`)
    const amount = finiteAmount(first(raw, ['arrearageAmount', 'arrearsAmount', 'arrearage', 'amount', '欠费金额', '欠费合计']))
    if (amount === null) issues.push(`第${sourceRow}行欠费金额无效`)
    const feeItem = text(first(raw, ['feeItemName', 'feeName', 'costTypeName', 'feeItem', '费项']))
    if (!feeItem) issues.push(`第${sourceRow}行缺少费项`)
    const periodStart = period(first(raw, ['arrearsStartDate', 'startDate', 'periodStart', '欠费开始日期']))
    const periodEnd = period(first(raw, ['arrearsEndDate', 'endDate', 'periodEnd', '欠费结束日期']))
    if (!periodStart || !periodEnd) issues.push(`第${sourceRow}行欠费账期无效`)
    else if (periodStart > periodEnd) issues.push(`第${sourceRow}行欠费账期倒置`)
    const paymentStatus = text(first(raw, ['paymentStatus', 'arrearsStatus', 'status', '缴费状态'])) || '欠费'
    const identity = validFullResource ? `${resource!.canonical}\u0000${feeItem}\u0000${periodStart}\u0000${periodEnd}` : ''
    if (identity && identities.has(identity)) {
      duplicateCount += 1
      issues.push(`第${sourceRow}行与前序房屋费项账期重复`)
    }
    if (identity) identities.add(identity)
    if (!validFullResource || !serviceCenter || !roomId || !personId || amount === null || !feeItem || !periodStart || !periodEnd || periodStart > periodEnd) return

    const evidence = {
      roomSign: resource!.display,
      serviceCenter,
      roomIdHash: hmac(roomId, key),
      personIdHash: hmac(personId, key),
      feeItem,
      amount,
      periodStart,
      periodEnd,
      paymentStatus,
    }
    rows.push({
      source: 'lvzai',
      businessDate: envelope.businessDate,
      houseCanonical: resource!.canonical,
      houseDisplay: resource!.display,
      houseHash: hmac(resource!.canonical, key),
      serviceCenter,
      roomIdHash: evidence.roomIdHash,
      personIdHash: evidence.personIdHash,
      feeItem,
      amount,
      periodStart,
      periodEnd,
      paymentStatus,
      sourceEvidenceHash: crypto.createHash('sha256').update(canonicalJson(evidence)).digest('hex'),
    })
  })

  const totalAmount = rows.reduce((sum, row) => sum + row.amount, 0)
  if (envelope.declaredTotalAmount !== undefined) {
    const declared = finiteAmount(envelope.declaredTotalAmount)
    const tolerance = Math.max(0, options.totalTolerance ?? 0.01)
    if (declared === null || Math.abs(declared - totalAmount) > tolerance) issues.push('声明欠费合计与逐行重算结果不一致')
  }
  if (rows.length !== envelope.rows.length) issues.push('标准化行数与源明细行数不一致')
  if (duplicateCount) issues.push('存在重复房屋费项账期')
  if (issues.length) throw new ArrearsConnectorGateError([...new Set(issues)])

  return {
    source: 'lvzai',
    businessDate: envelope.businessDate,
    extractedAt: envelope.extractedAt,
    rows,
    quality: {
      state: 'passed',
      source: 'lvzai',
      businessDate: envelope.businessDate,
      rowCount: rows.length,
      uniqueHouseCount: new Set(rows.map(row => row.houseCanonical)).size,
      totalAmount,
      roomSignCompletenessRate: 1,
      amountCompletenessRate: 1,
      duplicateCount: 0,
    },
  }
}

export async function readAndNormalizeLvzaiArrears(
  connector: ArrearsSourceConnector<Record<string, unknown>>,
  options: { signal?: AbortSignal; now?: Date; minimumRows?: number; totalTolerance?: number } = {},
): Promise<NormalizedLvzaiEnvelope> {
  if (connector.source !== 'lvzai') throw new ArrearsConnectorGateError(['连接器来源与绿仔标准化器不一致'])
  const envelope = await connector.read(options.signal)
  return normalizeLvzaiArrearsEnvelope(envelope, options)
}
