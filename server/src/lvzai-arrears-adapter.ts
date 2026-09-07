import type { ArrearsSourceConnector, ConnectorEnvelope } from './arrears-connectors.js'

export const LVZAI_ARREARAGE_ENDPOINT = '/oas/getArrearage'

export class LvzaiSessionExpiredError extends Error {
  constructor() {
    super('绿仔会话已失效')
    this.name = 'LvzaiSessionExpiredError'
  }
}

export interface LvzaiArrearageTransport {
  probe(signal?: AbortSignal): Promise<boolean>
  relogin(signal?: AbortSignal): Promise<void>
  post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}

export type LvzaiArrearageProjectScope = {
  regionId: string
  housePrefix: string
  serviceCenter?: string
}

export type LvzaiArrearageConnectorOptions = {
  businessDate: string
  projects: LvzaiArrearageProjectScope[]
  extractedAt?: () => string
}

type ParsedProjectResponse = {
  rows: Record<string, unknown>[]
  totalAmount: number
  houseCount: number
}

function object(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).normalize('NFKC').trim()
}

function finiteNonNegative(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = Number(String(value).replace(/[¥￥,，\s]/g, ''))
  return Number.isFinite(number) && number >= 0 ? number : null
}

function normalizedPrefix(value: string): string {
  return value.normalize('NFKC').trim().toUpperCase().replace(/[－—–_/\\]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function normalizedDate(value: unknown): string {
  return text(value).replace(/[./年]/g, '-').replace(/月|日/g, '').replace(/-+/g, '-').replace(/-$/g, '')
}

function periodDates(detail: Record<string, any>): { start: string; end: string } {
  const belongDate = normalizedDate(detail.belongDate)
  return {
    start: normalizedDate(detail.beginDate || detail.deditSartDate || belongDate),
    end: normalizedDate(detail.endDate || detail.deditSartDate || belongDate),
  }
}

export function lvzaiArrearageRequest(regionId: string, businessDate: string): Record<string, unknown> {
  return {
    type: 1,
    roomIds: null,
    regionId,
    buildingTypes: null,
    deliveryTypes: null,
    roomSigns: null,
    personId: null,
    abortDate: businessDate,
    dateType: 1,
    beginDate: null,
    endDate: null,
    feeIds: null,
    stewardName: null,
  }
}

export function inspectLvzaiArrearageResponse(response: unknown): {
  prefixes: string[]
  houseCount: number
  totalAmount: number
} {
  const root = object(response)
  const data = object(root?.data)
  if (!root || root.result !== true || !data) throw new Error('绿仔逐户欠费接口返回失败状态')
  if (!Array.isArray(data.list)) throw new Error('绿仔逐户欠费接口响应缺少list')
  const totalAmount = finiteNonNegative(data.amount)
  if (totalAmount === null) throw new Error('绿仔逐户欠费接口响应缺少欠费合计')
  const prefixes = new Set<string>()
  data.list.forEach((rawGroup: unknown, index: number) => {
    const group = object(rawGroup)
    if (!group) throw new Error(`绿仔逐户欠费第${index + 1}个房屋分组结构无效`)
    const sign = normalizedPrefix(text(group.roomSign))
    if (!sign) throw new Error(`绿仔逐户欠费第${index + 1}个房屋roomSign为空`)
    const parts = sign.split('-')
    if (parts.length !== 5) throw new Error(`绿仔逐户欠费第${index + 1}个房屋roomSign不是五段式`)
    prefixes.add(parts.slice(0, 2).join('-'))
  })
  if (totalAmount > 0 && !data.list.length) throw new Error('绿仔逐户欠费合计非零但没有房屋分组')
  return { prefixes: [...prefixes].sort(), houseCount: data.list.length, totalAmount }
}

export function parseLvzaiArrearageResponse(response: unknown, scope: LvzaiArrearageProjectScope): ParsedProjectResponse {
  const inspected = inspectLvzaiArrearageResponse(response)
  const root = object(response)!
  const data = object(root.data)!
  const declaredTotal = inspected.totalAmount
  const allowedPrefix = normalizedPrefix(scope.housePrefix)
  const rows: Record<string, unknown>[] = []
  let houseCount = 0

  data.list.forEach((rawGroup: unknown, groupIndex: number) => {
    const group = object(rawGroup)
    if (!group) throw new Error(`绿仔逐户欠费第${groupIndex + 1}个房屋分组无效`)
    const roomSign = normalizedPrefix(text(group.roomSign))
    const roomId = text(group.roomId)
    const parts = roomSign.split('-')
    if (parts.length !== 5 || parts.slice(0, 2).join('-') !== allowedPrefix) throw new Error(`绿仔逐户欠费第${groupIndex + 1}个房屋超出授权项目前缀`)
    if (!roomId) throw new Error(`绿仔逐户欠费第${groupIndex + 1}个房屋缺少roomId`)
    if (!Array.isArray(group.beLongDateList) || !group.beLongDateList.length) throw new Error(`绿仔逐户欠费第${groupIndex + 1}个房屋缺少账期明细`)
    houseCount += 1

    group.beLongDateList.forEach((rawDetail: unknown, detailIndex: number) => {
      const detail = object(rawDetail)
      if (!detail) throw new Error(`绿仔逐户欠费第${groupIndex + 1}个房屋第${detailIndex + 1}条账期无效`)
      const personId = text(detail.personId || group.personId)
      if (!personId) throw new Error(`绿仔逐户欠费第${groupIndex + 1}个房屋第${detailIndex + 1}条账期缺少personId`)
      if (!Array.isArray(detail.feeList) || !detail.feeList.length) throw new Error(`绿仔逐户欠费第${groupIndex + 1}个房屋第${detailIndex + 1}条账期缺少费项`)
      const dates = periodDates(detail)
      detail.feeList.forEach((rawFee: unknown, feeIndex: number) => {
        const fee = object(rawFee)
        if (!fee) throw new Error(`绿仔逐户欠费费项结构无效`)
        const amount = finiteNonNegative(fee.amount)
        const feeName = text(fee.feeName || fee.costTypeName || fee.name)
        if (amount === null || !feeName) throw new Error(`绿仔逐户欠费第${groupIndex + 1}个房屋第${detailIndex + 1}条账期第${feeIndex + 1}个费项无效`)
        rows.push({
          roomSign,
          serviceCenter: text(scope.serviceCenter),
          roomId,
          personId,
          arrearageAmount: amount,
          feeItemName: feeName,
          arrearsStartDate: dates.start,
          arrearsEndDate: dates.end,
          paymentStatus: '欠费',
        })
      })
    })
  })

  const calculatedTotal = rows.reduce((sum, row) => sum + Number(row.arrearageAmount), 0)
  if (Math.abs(calculatedTotal - declaredTotal) > 0.01) throw new Error('绿仔逐户欠费接口合计与费项逐行重算不一致')
  if (declaredTotal > 0 && !rows.length) throw new Error('绿仔逐户欠费合计非零但没有可用明细')
  return { rows, totalAmount: declaredTotal, houseCount }
}

export class LvzaiGetArrearageConnector implements ArrearsSourceConnector<Record<string, unknown>> {
  readonly source = 'lvzai' as const
  readonly transport: LvzaiArrearageTransport
  readonly options: LvzaiArrearageConnectorOptions

  constructor(transport: LvzaiArrearageTransport, options: LvzaiArrearageConnectorOptions) {
    this.transport = transport
    this.options = options
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.businessDate)) throw new Error('绿仔逐户欠费业务日期格式无效')
    if (!options.projects.length) throw new Error('绿仔逐户欠费项目范围为空')
    const regionIds = new Set<string>()
    for (const project of options.projects) {
      if (!text(project.regionId) || regionIds.has(text(project.regionId))) throw new Error('绿仔逐户欠费项目ID为空或重复')
      if (!text(project.serviceCenter)) throw new Error('绿仔逐户欠费项目缺少服务中心')
      if (!/^[A-Z]{2,3}-[A-Z0-9]+$/.test(normalizedPrefix(project.housePrefix))) throw new Error('绿仔房屋号项目前缀无效')
      regionIds.add(text(project.regionId))
    }
  }

  private async ensureSession(signal?: AbortSignal): Promise<void> {
    if (await this.transport.probe(signal)) return
    await this.transport.relogin(signal)
    if (!await this.transport.probe(signal)) throw new Error('绿仔重新登录后会话仍不可用')
  }

  private async readProjects(signal?: AbortSignal): Promise<ConnectorEnvelope<Record<string, unknown>>> {
    const rows: Record<string, unknown>[] = []
    let declaredTotalAmount = 0
    for (const project of this.options.projects) {
      const response = await this.transport.post(
        LVZAI_ARREARAGE_ENDPOINT,
        lvzaiArrearageRequest(project.regionId, this.options.businessDate),
        signal,
      )
      const parsed = parseLvzaiArrearageResponse(response, project)
      rows.push(...parsed.rows)
      declaredTotalAmount += parsed.totalAmount
    }
    return {
      source: 'lvzai',
      businessDate: this.options.businessDate,
      extractedAt: (this.options.extractedAt || (() => new Date().toISOString()))(),
      rows,
      declaredRowCount: rows.length,
      declaredTotalAmount,
    }
  }

  async read(signal?: AbortSignal): Promise<ConnectorEnvelope<Record<string, unknown>>> {
    await this.ensureSession(signal)
    try {
      return await this.readProjects(signal)
    } catch (error) {
      if (!(error instanceof LvzaiSessionExpiredError)) throw error
      await this.transport.relogin(signal)
      if (!await this.transport.probe(signal)) throw new Error('绿仔会话恢复失败')
      return this.readProjects(signal)
    }
  }
}
