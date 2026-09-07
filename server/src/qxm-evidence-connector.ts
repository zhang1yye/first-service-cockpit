import crypto from 'node:crypto'
import { normalizeResourceKey, type ArrearsCause } from './arrears-analysis.js'
import { ArrearsConnectorGateError, type ArrearsSourceConnector, type ConnectorEnvelope } from './arrears-connectors.js'

export type QxmDepartmentScope = { departmentId: string; reviewServiceCenter: string; projects: Array<{ serviceCenter: string; housePrefix: string }>; cursor?: string }
export type QxmMessagePage = { rows: Record<string, unknown>[]; total: number; nextCursor: string; hasMore: boolean }
export interface QxmEvidenceTransport {
  readMessages(input: { departmentId: string; cursor: string; businessDate: string; limit: number }, signal?: AbortSignal): Promise<QxmMessagePage>
}
export type QxmEvidenceSignalState = 'supported' | 'conflicted' | 'none'
export type NormalizedQxmEvidenceRow = {
  source: 'qxm'
  businessDate: string
  serviceCenter: string
  matchState: 'matched' | 'review_required'
  houseCanonical: string | null
  houseDisplay: string | null
  houseHash: string | null
  roomReferenceHash: string
  messageIdHash: string
  externalUserIdHash: string
  employeeUserIdHash: string
  occurredAt: string
  direction: 'inbound' | 'outbound' | 'system'
  contentKind: 'text' | 'image' | 'file' | 'voice' | 'link' | 'other'
  signalState: QxmEvidenceSignalState
  causeSignal: ArrearsCause
  sourceEvidenceHash: string
}
export type NormalizedQxmEvidenceEnvelope = {
  source: 'qxm'
  businessDate: string
  extractedAt: string
  rows: NormalizedQxmEvidenceRow[]
  nextCursors: Array<{ departmentIdHash: string; cursor: string }>
  quality: {
    state: 'passed'
    source: 'qxm'
    businessDate: string
    rowCount: number
    matchedCount: number
    isolatedUnlinkedCount: number
    duplicateMessageCount: 0
    stableMessageIdCompletenessRate: 1
    supportedSignalCount: number
    conflictedSignalCount: number
  }
}
type QxmConnectorEnvelope = ConnectorEnvelope<Record<string, unknown>> & { nextCursors: Array<{ departmentId: string; cursor: string }> }

function text(value: unknown): string { return value === null || value === undefined ? '' : String(value).normalize('NFKC').trim() }
function validBusinessDate(value: unknown): boolean {
  const raw = text(value), match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3])
}
function first(row: Record<string, unknown>, keys: string[]): unknown { for (const key of keys) if (text(row[key])) return row[key] }
function secret(): string {
  const value = String(process.env.ARREARS_RESOURCE_HASH_KEY || '')
  if (value.length < 32) throw new ArrearsConnectorGateError(['ARREARS_RESOURCE_HASH_KEY未配置或长度不足32位'])
  return value
}
function hmac(value: string, key: string): string { return crypto.createHmac('sha256', key).update(value).digest('hex') }
function prefix(value: unknown): string {
  return text(value).toUpperCase().replace(/[－—–_/\\]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}
function direction(value: unknown): 'inbound' | 'outbound' | 'system' {
  const raw = text(value).toLowerCase()
  if (/inbound|receive|customer|客户|接收/.test(raw)) return 'inbound'
  if (/outbound|send|employee|员工|发送/.test(raw)) return 'outbound'
  return 'system'
}
function contentKind(value: unknown): NormalizedQxmEvidenceRow['contentKind'] {
  const raw = text(value).toLowerCase()
  if (/text|文本|文字/.test(raw)) return 'text'
  if (/image|图片/.test(raw)) return 'image'
  if (/file|文件/.test(raw)) return 'file'
  if (/voice|audio|语音/.test(raw)) return 'voice'
  if (/link|链接|网页/.test(raw)) return 'link'
  return 'other'
}
function occurredAt(value: unknown): string {
  const raw = text(value)
  const parsed = new Date(raw)
  return raw && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : ''
}
function signal(content: string): { state: QxmEvidenceSignalState; cause: ArrearsCause } {
  const negated = /不(?:是|存在|认可|同意|承诺)|并非|从未|没有|无(?:空置|困难|争议)/.test(content)
  const rules: Array<[ArrearsCause, RegExp]> = [
    ['legal_dispute', /诉讼|仲裁|律师|法院|法律纠纷/], ['service_dispute', /服务不到位|维修|故障|投诉|品质/],
    ['charge_dispute', /账单|金额有误|计费|收费标准|费用争议/], ['vacancy', /空置|未入住|无人居住/],
    ['financial_hardship', /资金紧张|周转困难|失业|申请分期/], ['ownership_or_handover', /未收房|未交付|产权|过户|开发商/],
    ['contact_barrier', /联系不上|无人接听|拒接|空号|停机|失联/], ['promised_payment', /承诺.*(?:缴|付|转)|答应.*(?:缴|付|转)|计划缴费/],
  ]
  const matches = rules.filter(([, pattern]) => pattern.test(content)).map(([cause]) => cause)
  if (negated || new Set(matches).size > 1) return { state: 'conflicted', cause: 'unknown' }
  return matches.length ? { state: 'supported', cause: matches[0] } : { state: 'none', cause: 'unknown' }
}
function matchedHouse(rawRoom: string, allowedPrefix: string) {
  const resource = normalizeResourceKey({ 房屋编码: rawRoom })
  if (!resource || !allowedPrefix) return null
  if (resource.canonical.startsWith('S:')) return normalizeResourceKey({ 房屋编码: `${allowedPrefix}-${resource.display}` })
  if (!resource.canonical.startsWith('H:') || resource.display.split('-').slice(0, 2).join('-') !== allowedPrefix) return null
  return resource
}
function roomCandidates(rawRoom: unknown): string[] {
  const raw = text(rawRoom).toUpperCase().replace(/[－—–]/g, '-')
  const candidates: string[] = []
  const whole = normalizeResourceKey({ 房屋编码: raw })
  if (whole && (whole.canonical.startsWith('H:') || whole.canonical.startsWith('S:'))) candidates.push(whole.display)
  for (const match of raw.matchAll(/(?<![A-Z0-9\u3400-\u9FFF])([A-Z]{2,3}-[A-Z0-9]+-[A-Z0-9\u3400-\u9FFF]+-[A-Z0-9\u3400-\u9FFF]+-[A-Z0-9\u3400-\u9FFF]+)(?![A-Z0-9\u3400-\u9FFF])/g)) candidates.push(match[1])
  for (const match of raw.matchAll(/([A-Z0-9]{1,8})\s*(?:号楼|栋)\s*([A-Z0-9]{1,8})\s*单元\s*([A-Z0-9]{1,12})\s*室?/g)) candidates.push(`${match[1]}-${match[2]}-${match[3]}`)
  for (const match of raw.matchAll(/(?<![A-Z0-9])([A-Z0-9]{1,8})-([A-Z0-9]{1,8})-([A-Z0-9]{1,12})(?![A-Z0-9])/g)) {
    const [, building, unit, room] = match
    if (/^(?:19|20)\d{2}$/.test(building) && /^(?:0?[1-9]|1[0-2])$/.test(unit) && /^(?:0?[1-9]|[12]\d|3[01])$/.test(room)) continue
    candidates.push(`${building}-${unit}-${room}`)
  }
  const unique = [...new Set(candidates)]
  const full = unique.filter(value => value.split('-').length === 5 && /^[A-Z]{2,3}-/.test(value))
  return full.length ? full : unique
}
function projectForRoom(rawRoom: unknown, projects: QxmDepartmentScope['projects']) {
  const candidates = roomCandidates(rawRoom)
  if (candidates.length !== 1) return null
  const resource = normalizeResourceKey({ 房屋编码: candidates[0] })
  if (resource?.canonical.startsWith('H:')) {
    const roomPrefix = resource.display.split('-').slice(0, 2).join('-')
    const project = projects.find(item => prefix(item.housePrefix) === roomPrefix)
    return project ? { project, room: resource.display } : null
  }
  if (resource?.canonical.startsWith('S:') && projects.length === 1) return { project: projects[0], room: resource.display }
  return null
}

export class QxmIncrementalEvidenceConnector implements ArrearsSourceConnector<Record<string, unknown>> {
  readonly source = 'qxm' as const
  constructor(readonly transport: QxmEvidenceTransport, readonly options: { businessDate: string; scopes: QxmDepartmentScope[]; pageSize?: number; maximumPages?: number; extractedAt?: () => string }) {
    if (!validBusinessDate(options.businessDate)) throw new Error('企小码证据业务日期无效')
    if (!options.scopes.length) throw new Error('企小码部门范围为空')
    const ids = new Set<string>()
    for (const scope of options.scopes) {
      if (!text(scope.departmentId) || ids.has(text(scope.departmentId))) throw new Error('企小码部门ID为空或重复')
      if (!text(scope.reviewServiceCenter)) throw new Error('企小码部门范围缺少复核服务中心')
      if (!Array.isArray(scope.projects) || !scope.projects.length) throw new Error('企小码部门范围缺少受控项目映射')
      const projectPrefixes = new Set<string>()
      for (const project of scope.projects) {
        const housePrefix = prefix(project.housePrefix)
        if (!/^[A-Z]{2,3}-[A-Z0-9]+$/.test(housePrefix) || projectPrefixes.has(housePrefix)) throw new Error('企小码部门项目房屋前缀无效或重复')
        if (!text(project.serviceCenter)) throw new Error('企小码部门项目缺少服务中心')
        projectPrefixes.add(housePrefix)
      }
      ids.add(text(scope.departmentId))
    }
  }
  async read(signal?: AbortSignal): Promise<QxmConnectorEnvelope> {
    const rows: Record<string, unknown>[] = [], nextCursors: Array<{ departmentId: string; cursor: string }> = []
    const maximumPages = Math.max(1, Math.min(10_000, Math.trunc(this.options.maximumPages || 500)))
    const pageSize = Math.max(10, Math.min(20_000, Math.trunc(this.options.pageSize || 1_000)))
    for (const scope of this.options.scopes) {
      let cursor = text(scope.cursor), declaredTotal: number | null = null, scopedReadCount = 0, pages = 0
      const seenCursors = new Set<string>()
      while (true) {
        if (++pages > maximumPages) throw new Error('企小码增量分页超过安全上限')
        const page = await this.transport.readMessages({ departmentId: scope.departmentId, cursor, businessDate: this.options.businessDate, limit: pageSize }, signal)
        if (!page || !Array.isArray(page.rows) || !Number.isInteger(page.total) || page.total < 0 || typeof page.hasMore !== 'boolean') throw new Error('企小码增量响应结构无效')
        if (declaredTotal === null) declaredTotal = page.total
        if (page.total !== declaredTotal - scopedReadCount || page.rows.length > page.total) throw new Error('企小码增量读取期间剩余总行数未按游标递减')
        rows.push(...page.rows.map(row => {
          const rawRoom = first(row, ['roomSign', 'roomRemark', '房屋备注', '客户备注', '房产'])
          const resolved = projectForRoom(rawRoom, scope.projects)
          return { ...row, __departmentId: scope.departmentId, __serviceCenter: resolved?.project.serviceCenter || scope.reviewServiceCenter, __housePrefix: resolved ? prefix(resolved.project.housePrefix) : '', __resolvedRoom: resolved?.room || '', __projectMappingFound: Boolean(resolved) }
        }))
        scopedReadCount += page.rows.length
        if (!page.hasMore) { nextCursors.push({ departmentId: scope.departmentId, cursor: text(page.nextCursor || cursor) }); break }
        if (!page.rows.length) throw new Error('企小码增量分页标记继续但未返回消息')
        const next = text(page.nextCursor)
        if (!next || next === cursor || seenCursors.has(next)) throw new Error('企小码增量游标未推进或发生循环')
        seenCursors.add(next); cursor = next
      }
      if (scopedReadCount !== declaredTotal) throw new Error('企小码增量声明总行数与完整读取数量不一致')
    }
    return { source: 'qxm', businessDate: this.options.businessDate, extractedAt: (this.options.extractedAt || (() => new Date().toISOString()))(), rows, declaredRowCount: rows.length, nextCursors }
  }
}

export function normalizeQxmEvidenceEnvelope(envelope: QxmConnectorEnvelope, options: { now?: Date; minimumRows?: number } = {}): NormalizedQxmEvidenceEnvelope {
  const issues: string[] = [], now = options.now || new Date()
  if (envelope.source !== 'qxm') issues.push('来源必须为qxm')
  if (!validBusinessDate(envelope.businessDate) || new Date(`${envelope.businessDate}T00:00:00+08:00`).getTime() > now.getTime()) issues.push('企小码业务日期无效或晚于当前时间')
  const extracted = new Date(envelope.extractedAt)
  if (!Number.isFinite(extracted.getTime()) || extracted.getTime() > now.getTime() + 300_000) issues.push('企小码提取时间无效')
  if (!Array.isArray(envelope.rows) || envelope.rows.length < Math.max(0, Math.trunc(options.minimumRows || 0))) issues.push('企小码消息少于门禁下限')
  if (envelope.declaredRowCount !== undefined && envelope.declaredRowCount !== envelope.rows.length) issues.push('企小码声明行数与消息数不一致')
  if (!Array.isArray(envelope.nextCursors)) issues.push('企小码响应缺少增量游标')
  if (issues.length) throw new ArrearsConnectorGateError(issues)
  const key = secret(), messageIds = new Set<string>(), rows: NormalizedQxmEvidenceRow[] = []
  envelope.rows.forEach((raw, index) => {
    const line = index + 1
    const messageId = text(first(raw, ['messageId', 'msgId', '消息ID', 'id']))
    const externalUserId = text(first(raw, ['externalUserId', 'external_userid', '客户ID']))
    const employeeUserId = text(first(raw, ['employeeUserId', 'userId', '员工ID', '发送人ID']))
    const serviceCenter = text(raw.__serviceCenter), allowedPrefix = prefix(raw.__housePrefix)
    if (!messageId || !externalUserId || !employeeUserId) issues.push(`企小码第${line}条消息缺少稳定消息、客户或员工ID`)
    if (!serviceCenter) issues.push(`企小码第${line}条消息缺少受控复核归属`)
    if (raw.__projectMappingFound !== false && !/^[A-Z]{2,3}-[A-Z0-9]+$/.test(allowedPrefix)) issues.push(`企小码第${line}条消息缺少受控项目范围`)
    if (messageId && messageIds.has(messageId)) issues.push(`企小码第${line}条消息ID重复`)
    messageIds.add(messageId)
    const timestamp = occurredAt(first(raw, ['occurredAt', 'sendTime', 'msgTime', '消息时间']))
    if (!timestamp) issues.push(`企小码第${line}条消息时间无效`)
    const rawRoom = text(first(raw, ['__resolvedRoom', 'roomSign', 'roomRemark', '房屋备注', '客户备注', '房产']))
    const house = matchedHouse(rawRoom, allowedPrefix)
    const content = text(first(raw, ['content', 'messageContent', '消息内容', '文本']))
    const kind = contentKind(first(raw, ['contentKind', 'msgType', '消息类型']))
    const extractedSignal = kind === 'text' ? signal(content) : { state: 'none' as const, cause: 'unknown' as const }
    if (!messageId || !externalUserId || !employeeUserId || !serviceCenter || !timestamp) return
    const roomReference = rawRoom ? prefix(rawRoom) : `MISSING:${externalUserId}`
    const evidence = { messageIdHash: hmac(messageId, key), externalUserIdHash: hmac(externalUserId, key), employeeUserIdHash: hmac(employeeUserId, key), contentHmac: hmac(content, key), occurredAt: timestamp, direction: direction(first(raw, ['direction', 'sendType', '消息方向'])), contentKind: kind, signalState: extractedSignal.state, causeSignal: extractedSignal.cause, houseHash: house ? hmac(house.canonical, key) : null }
    rows.push({ source: 'qxm', businessDate: envelope.businessDate, serviceCenter, matchState: house ? 'matched' : 'review_required', houseCanonical: house?.canonical || null, houseDisplay: house?.display || null, houseHash: evidence.houseHash, roomReferenceHash: hmac(`${serviceCenter}\u0000${roomReference}`, key), messageIdHash: evidence.messageIdHash, externalUserIdHash: evidence.externalUserIdHash, employeeUserIdHash: evidence.employeeUserIdHash, occurredAt: timestamp, direction: evidence.direction, contentKind: kind, signalState: extractedSignal.state, causeSignal: extractedSignal.cause, sourceEvidenceHash: crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex') })
  })
  if (rows.length !== envelope.rows.length) issues.push('企小码标准化行数与源消息数不一致')
  if (issues.length) throw new ArrearsConnectorGateError([...new Set(issues)])
  return { source: 'qxm', businessDate: envelope.businessDate, extractedAt: envelope.extractedAt, rows, nextCursors: envelope.nextCursors.map(item => ({ departmentIdHash: hmac(item.departmentId, key), cursor: item.cursor })), quality: { state: 'passed', source: 'qxm', businessDate: envelope.businessDate, rowCount: rows.length, matchedCount: rows.filter(row => row.matchState === 'matched').length, isolatedUnlinkedCount: rows.filter(row => row.matchState === 'review_required').length, duplicateMessageCount: 0, stableMessageIdCompletenessRate: 1, supportedSignalCount: rows.filter(row => row.signalState === 'supported').length, conflictedSignalCount: rows.filter(row => row.signalState === 'conflicted').length } }
}

export async function readAndNormalizeQxmEvidence(connector: QxmIncrementalEvidenceConnector, options: { signal?: AbortSignal; now?: Date; minimumRows?: number } = {}) {
  return normalizeQxmEvidenceEnvelope(await connector.read(options.signal), options)
}
