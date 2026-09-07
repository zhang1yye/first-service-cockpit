import assert from 'node:assert/strict'
import test from 'node:test'
import { LvzaiSessionExpiredError } from '../src/lvzai-arrears-adapter.js'
import { discoverLvzaiArrearsScope, northRegionLeaves, type LvzaiScopeDiscoveryTransport } from '../src/lvzai-scope-discovery.js'

const tree = {
  data: [{ text: '第一服务', children: [{ text: '华北地区', children: [
    { text: '嘉润花园', code: 'region-jrhy', children: [] },
    { text: '其他服务中心', code: 'region-other', children: [] },
  ] }] }],
}

function group(prefix: string, room: string, amount: number) {
  return { roomSign: `${prefix}-1-1-${room}`, roomId: `room-${room}`, beLongDateList: [{ personId: `person-${room}`, beginDate: '2026-01', endDate: '2026-07', feeList: [{ feeName: '物业费', amount }] }] }
}
function response(groups: Record<string, unknown>[], amount: number) { return { result: true, data: { list: groups, amount } } }

function transport(replies: Record<string, unknown>): LvzaiScopeDiscoveryTransport {
  return {
    async probe() { return true }, async relogin() {}, async regionTree() { return tree },
    async post(_path, body) { return replies[String(body.regionId)] },
  }
}

test('组织树只提取华北叶子项目且拒绝缺失节点', () => {
  assert.deepEqual(northRegionLeaves(tree), [
    { regionId: 'region-jrhy', serviceCenter: '嘉润花园' },
    { regionId: 'region-other', serviceCenter: '其他服务中心' },
  ].sort((a, b) => a.serviceCenter.localeCompare(b.serviceCenter, 'zh-CN')))
  assert.throws(() => northRegionLeaves({ data: [] }), /未找到华北节点/)
  assert.deepEqual(northRegionLeaves({ data: [...tree.data, { text: '华北占位节点', children: [] }, { text: '华北空标签' }] }), northRegionLeaves(tree))
  assert.throws(() => northRegionLeaves({ data: [{ text: '华北', children: [{ text: '无编码' }] }] }), /缺少编码或名称/)
})

test('所有项目唯一房屋前缀时生成受控范围配置，不携带房屋或客户明细', async () => {
  const result = await discoverLvzaiArrearsScope({
    transport: transport({
      'region-jrhy': response([group('BJ-JRHY', '1005', 100)], 100),
      'region-other': response([group('BJ-OTHER', '1006', 200)], 200),
    }),
    businessDate: '2026-08-28',
  })
  assert.equal(result.state, 'passed')
  assert.equal(result.regionCount, 2)
  assert.equal(result.resolvedCount, 2)
  assert.equal(result.totalHouseCount, 2)
  assert.equal(result.totalAmount, 300)
  assert.equal(result.config?.minimumRows, 2)
  assert.deepEqual(result.config?.projects.map(item => item.housePrefix).sort(), ['BJ-JRHY', 'BJ-OTHER'])
  const serialized = JSON.stringify(result.config)
  assert.doesNotMatch(serialized, /1005|1006|person-|room-/)
})

test('空项目、多前缀冲突或无效响应时阻断配置生成并保留安全复核摘要', async () => {
  const empty = await discoverLvzaiArrearsScope({
    transport: transport({ 'region-jrhy': response([], 0), 'region-other': response([group('BJ-OTHER', '1006', 200)], 200) }),
    businessDate: '2026-08-28',
  })
  assert.equal(empty.state, 'blocked')
  assert.equal(empty.config, null)
  assert.deepEqual(empty.issues, [{ serviceCenter: '嘉润花园', state: 'empty', prefixCount: 0 }])

  const conflict = await discoverLvzaiArrearsScope({
    transport: transport({
      'region-jrhy': response([group('BJ-JRHY', '1005', 100), group('BJ-WRONG', '1006', 100)], 200),
      'region-other': { result: false },
    }),
    businessDate: '2026-08-28',
  })
  assert.equal(conflict.state, 'blocked')
  assert.equal(conflict.config, null)
  assert.deepEqual(conflict.issues.map(item => item.state).sort(), ['conflict', 'invalid_response'])
  assert.equal(conflict.issues.find(item => item.state === 'invalid_response')?.reason, 'failed_state')
  assert.doesNotMatch(JSON.stringify(conflict.issues), /BJ-JRHY|BJ-WRONG|region-/)
})

test('范围发现固定最多四路只读并发且仍完整覆盖全部授权项目', async () => {
  const leaves = Array.from({ length: 9 }, (_, index) => ({ text: `服务中心${index}`, code: `region-${index}`, children: [] }))
  let active = 0, maximumActive = 0, calls = 0
  const concurrentTransport: LvzaiScopeDiscoveryTransport = {
    async probe() { return true }, async relogin() {}, async regionTree() { return { data: [{ text: '华北地区', children: leaves }] } },
    async post(_path, body) {
      active += 1; calls += 1; maximumActive = Math.max(maximumActive, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active -= 1
      const index = String(body.regionId).split('-').at(-1)
      return response([group(`BJ-P${index}`, `10${index}`, 1)], 1)
    },
  }
  const result = await discoverLvzaiArrearsScope({ transport: concurrentTransport, businessDate: '2026-08-28' })
  assert.equal(result.state, 'passed')
  assert.equal(calls, 9)
  assert.equal(result.resolvedCount, 9)
  assert.equal(maximumActive, 4)
})

test('范围发现遇到会话失效时重登并从组织树和首项目重新执行', async () => {
  let treeCalls = 0, posts = 0, relogins = 0
  const discoveryTransport: LvzaiScopeDiscoveryTransport = {
    async probe() { return true }, async relogin() { relogins += 1 },
    async regionTree() { treeCalls += 1; return tree },
    async post(_path, body) {
      posts += 1
      if (posts === 2) throw new LvzaiSessionExpiredError()
      return body.regionId === 'region-jrhy' ? response([group('BJ-JRHY', '1005', 100)], 100) : response([group('BJ-OTHER', '1006', 200)], 200)
    },
  }
  const result = await discoverLvzaiArrearsScope({ transport: discoveryTransport, businessDate: '2026-08-28' })
  assert.equal(result.state, 'passed')
  assert.equal(relogins, 1)
  assert.equal(treeCalls, 2)
  assert.equal(posts, 4)
})
