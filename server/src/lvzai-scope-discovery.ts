import { LvzaiSessionExpiredError, inspectLvzaiArrearageResponse, lvzaiArrearageRequest, type LvzaiArrearageTransport } from './lvzai-arrears-adapter.js'
import type { LvzaiArrearsScopeConfig } from './lvzai-arrears-job.js'

export interface LvzaiScopeDiscoveryTransport extends LvzaiArrearageTransport {
  regionTree(signal?: AbortSignal): Promise<unknown>
}

type RegionLeaf = { regionId: string; serviceCenter: string }
export type LvzaiScopeDiscoveryIssue = {
  serviceCenter: string
  state: 'empty' | 'conflict' | 'invalid_response'
  prefixCount: number
  reason?: 'transport_error' | 'failed_state' | 'list_missing' | 'amount_missing' | 'room_group_invalid' | 'room_sign_missing' | 'room_sign_non_five_segment' | 'nonzero_empty'
}
export type LvzaiScopeDiscoveryResult = {
  state: 'passed' | 'blocked'
  businessDate: string
  regionCount: number
  resolvedCount: number
  totalHouseCount: number
  totalAmount: number
  issues: LvzaiScopeDiscoveryIssue[]
  config: LvzaiArrearsScopeConfig | null
}

function object(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null
}
function text(value: unknown): string { return value === null || value === undefined ? '' : String(value).normalize('NFKC').trim() }
function invalidReason(error: unknown): NonNullable<LvzaiScopeDiscoveryIssue['reason']> {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('返回失败状态')) return 'failed_state'
  if (message.includes('响应缺少list')) return 'list_missing'
  if (message.includes('响应缺少欠费合计')) return 'amount_missing'
  if (message.includes('房屋分组结构无效')) return 'room_group_invalid'
  if (message.includes('roomSign为空')) return 'room_sign_missing'
  if (message.includes('roomSign不是五段式')) return 'room_sign_non_five_segment'
  if (message.includes('合计非零但没有房屋分组')) return 'nonzero_empty'
  return 'transport_error'
}

export function northRegionLeaves(response: unknown): RegionLeaf[] {
  const root = object(response)
  if (!root || !Array.isArray(root.data)) throw new Error('绿仔组织树响应缺少data')
  const northNodes: Record<string, any>[] = []
  const findNorth = (node: unknown) => {
    const item = object(node)
    if (!item) return
    const children = Array.isArray(item.children) ? item.children : []
    // 线上组织树含“华北”字样的空占位节点；只有包含下级组织的节点才是可发现范围根。
    if (text(item.text).includes('华北') && children.length) northNodes.push(item)
    else children.forEach(findNorth)
  }
  root.data.forEach(findNorth)
  if (!northNodes.length) throw new Error('绿仔组织树未找到华北节点')
  const leaves = new Map<string, RegionLeaf>()
  const collect = (node: unknown) => {
    const item = object(node)
    if (!item) return
    const children = Array.isArray(item.children) ? item.children : []
    if (children.length) return children.forEach(collect)
    const regionId = text(item.code)
    const serviceCenter = text(item.text)
    if (!regionId || !serviceCenter) throw new Error('绿仔华北组织树存在缺少编码或名称的叶子节点')
    if (leaves.has(regionId)) throw new Error('绿仔华北组织树存在重复项目编码')
    leaves.set(regionId, { regionId, serviceCenter })
  }
  northNodes.forEach(collect)
  if (!leaves.size) throw new Error('绿仔华北组织树没有项目叶子节点')
  return [...leaves.values()].sort((a, b) => a.serviceCenter.localeCompare(b.serviceCenter, 'zh-CN'))
}

async function ensureSession(transport: LvzaiScopeDiscoveryTransport, signal?: AbortSignal): Promise<void> {
  if (await transport.probe(signal)) return
  await transport.relogin(signal)
  if (!await transport.probe(signal)) throw new Error('绿仔重新登录后会话仍不可用')
}

async function discoverOnce(transport: LvzaiScopeDiscoveryTransport, businessDate: string, signal?: AbortSignal): Promise<LvzaiScopeDiscoveryResult> {
  const regions = northRegionLeaves(await transport.regionTree(signal))
  const projects: Array<{ regionId: string; housePrefix: string; serviceCenter: string }> = []
  const issues: LvzaiScopeDiscoveryIssue[] = []
  let totalHouseCount = 0
  let totalAmount = 0
  const outcomes: Array<{ region: RegionLeaf; inspected?: ReturnType<typeof inspectLvzaiArrearageResponse>; invalid?: true; reason?: NonNullable<LvzaiScopeDiscoveryIssue['reason']> }> = new Array(regions.length)
  const attemptController = new AbortController()
  const readSignal = signal ? AbortSignal.any([signal, attemptController.signal]) : attemptController.signal
  let nextRegion = 0, sessionExpired = false
  const worker = async () => {
    while (true) {
      const index = nextRegion++
      if (index >= regions.length) return
      const region = regions[index]
      try {
        outcomes[index] = { region, inspected: inspectLvzaiArrearageResponse(await transport.post('/oas/getArrearage', lvzaiArrearageRequest(region.regionId, businessDate), readSignal)) }
      } catch (error) {
        if (error instanceof LvzaiSessionExpiredError) { sessionExpired = true; attemptController.abort(); return }
        if (signal?.aborted || sessionExpired) return
        outcomes[index] = { region, invalid: true, reason: invalidReason(error) }
      }
    }
  }
  // 固定四路并发，仅缩短只读范围发现耗时；不扩大域名、接口、项目范围或响应上限。
  await Promise.all(Array.from({ length: Math.min(4, regions.length) }, worker))
  if (sessionExpired) throw new LvzaiSessionExpiredError()
  if (signal?.aborted) throw new Error('绿仔范围发现已取消')
  for (const outcome of outcomes) {
    const { region, inspected } = outcome
    if (outcome.invalid || !inspected) {
      issues.push({ serviceCenter: region.serviceCenter, state: 'invalid_response', prefixCount: 0, reason: outcome.reason || 'transport_error' })
      continue
    }
    totalHouseCount += inspected.houseCount
    totalAmount += inspected.totalAmount
    if (!inspected.prefixes.length) issues.push({ serviceCenter: region.serviceCenter, state: 'empty', prefixCount: 0 })
    else if (inspected.prefixes.length > 1) issues.push({ serviceCenter: region.serviceCenter, state: 'conflict', prefixCount: inspected.prefixes.length })
    else projects.push({ regionId: region.regionId, housePrefix: inspected.prefixes[0], serviceCenter: region.serviceCenter })
  }
  const passed = projects.length === regions.length && !issues.length
  return {
    state: passed ? 'passed' : 'blocked',
    businessDate,
    regionCount: regions.length,
    resolvedCount: projects.length,
    totalHouseCount,
    totalAmount,
    issues,
    config: passed ? {
      schemaVersion: 1,
      projects,
      minimumRows: Math.max(projects.length, Math.floor(totalHouseCount * 0.8)),
    } : null,
  }
}

export async function discoverLvzaiArrearsScope(options: {
  transport: LvzaiScopeDiscoveryTransport
  businessDate: string
  signal?: AbortSignal
}): Promise<LvzaiScopeDiscoveryResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.businessDate)) throw new Error('绿仔范围发现业务日期无效')
  await ensureSession(options.transport, options.signal)
  try {
    return await discoverOnce(options.transport, options.businessDate, options.signal)
  } catch (error) {
    if (!(error instanceof LvzaiSessionExpiredError)) throw error
    await options.transport.relogin(options.signal)
    if (!await options.transport.probe(options.signal)) throw new Error('绿仔会话恢复失败')
    return discoverOnce(options.transport, options.businessDate, options.signal)
  }
}
