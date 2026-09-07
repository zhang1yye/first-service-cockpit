import assert from 'node:assert/strict'
import test from 'node:test'
import { readAndNormalizeLvzaiArrears } from '../src/arrears-connectors.js'
import {
  LVZAI_ARREARAGE_ENDPOINT,
  LvzaiGetArrearageConnector,
  LvzaiSessionExpiredError,
  inspectLvzaiArrearageResponse,
  lvzaiArrearageRequest,
  parseLvzaiArrearageResponse,
  type LvzaiArrearageTransport,
} from '../src/lvzai-arrears-adapter.js'

const previousHashKey = process.env.ARREARS_RESOURCE_HASH_KEY
process.env.ARREARS_RESOURCE_HASH_KEY = 'r141-adapter-test-resource-hash-key-32-bytes'
test.after(() => {
  if (previousHashKey === undefined) delete process.env.ARREARS_RESOURCE_HASH_KEY
  else process.env.ARREARS_RESOURCE_HASH_KEY = previousHashKey
})

function group(prefix: string, room: string, amounts: number[]) {
  return {
    roomSign: `${prefix}-1-1-${room}`, roomId: `room-${room}`,
    beLongDateList: [{
      personId: `person-${room}`, belongDate: '2026-07', beginDate: '2026-07-01', endDate: '2026-07-31',
      feeList: amounts.map((amount, index) => ({ feeId: index + 1, feeName: index ? '车位费' : '物业费', amount })),
    }],
  }
}

function response(groups: Record<string, unknown>[], amount: number) {
  return { result: true, data: { list: groups, feeList: [], amount } }
}

function connector(transport: LvzaiArrearageTransport) {
  return new LvzaiGetArrearageConnector(transport, {
    businessDate: '2026-08-28',
    projects: [
      { regionId: 'region-jrhy', housePrefix: 'BJ-JRHY', serviceCenter: '嘉润花园' },
      { regionId: 'region-other', housePrefix: 'BJ-OTHER', serviceCenter: '其他服务中心' },
    ],
    extractedAt: () => '2026-08-28T07:30:00+08:00',
  })
}

test('绿仔getArrearage请求体与线上housekeeper.vue合同一致', () => {
  assert.deepEqual(lvzaiArrearageRequest('region-jrhy', '2026-08-28'), {
    type: 1, roomIds: null, regionId: 'region-jrhy', buildingTypes: null, deliveryTypes: null,
    roomSigns: null, personId: null, abortDate: '2026-08-28', dateType: 1,
    beginDate: null, endDate: null, feeIds: null, stewardName: null,
  })
})

test('真实分组响应按房屋、账期和费项展开，并以接口amount独立复核', () => {
  const parsed = parseLvzaiArrearageResponse(response([group('BJ-JRHY', '1005', [100, 20])], 120), { regionId: 'region-jrhy', housePrefix: 'BJ-JRHY' })
  assert.equal(parsed.rows.length, 2)
  assert.equal(parsed.houseCount, 1)
  assert.equal(parsed.totalAmount, 120)
  assert.deepEqual(parsed.rows.map(row => row.feeItemName), ['物业费', '车位费'])
  assert.throws(() => parseLvzaiArrearageResponse(response([group('BJ-JRHY', '1005', [100])], 101), { regionId: 'region-jrhy', housePrefix: 'BJ-JRHY' }), /合计与费项逐行重算不一致/)
  assert.throws(() => parseLvzaiArrearageResponse({ result: false }, { regionId: 'x', housePrefix: 'BJ-JRHY' }), /失败状态/)
})

test('适配器按授权项目逐个查询固定接口并交给统一质量门禁', async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const replies = [response([group('BJ-JRHY', '1005', [100])], 100), response([group('BJ-OTHER', '1006', [200])], 200)]
  const transport: LvzaiArrearageTransport = {
    async probe() { return true }, async relogin() { throw new Error('不应重登') },
    async post(path, body) { requests.push({ path, body }); return replies.shift() },
  }
  const result = await readAndNormalizeLvzaiArrears(connector(transport), {
    now: new Date('2026-08-28T08:00:00+08:00'), minimumRows: 2,
  })
  assert.equal(result.quality.rowCount, 2)
  assert.equal(result.quality.totalAmount, 300)
  assert.deepEqual(requests.map(item => item.path), [LVZAI_ARREARAGE_ENDPOINT, LVZAI_ARREARAGE_ENDPOINT])
  assert.deepEqual(requests.map(item => item.body.regionId), ['region-jrhy', 'region-other'])
})

test('会话探活失败先重登；项目查询遇到会话失效时重登并从首项目重新读取', async () => {
  let alive = false, relogins = 0, posts = 0
  const transport: LvzaiArrearageTransport = {
    async probe() { return alive },
    async relogin() { relogins += 1; alive = true },
    async post(_path, body) {
      posts += 1
      if (posts === 2) throw new LvzaiSessionExpiredError()
      return body.regionId === 'region-jrhy'
        ? response([group('BJ-JRHY', '1005', [100])], 100)
        : response([group('BJ-OTHER', '1006', [200])], 200)
    },
  }
  const output = await connector(transport).read()
  assert.equal(output.rows.length, 2)
  assert.equal(relogins, 2)
  assert.equal(posts, 4)
})

test('范围检查区分空roomSign与非五段式roomSign', () => {
  assert.throws(() => inspectLvzaiArrearageResponse(response([{ roomSign: '' }], 0)), /roomSign为空/)
  assert.throws(() => inspectLvzaiArrearageResponse(response([{ roomSign: 'BJ-JRHY-1-1005' }], 0)), /roomSign不是五段式/)
})

test('越权前缀、缺失稳定ID、账期和费项结构均失败关闭', () => {
  assert.throws(() => parseLvzaiArrearageResponse(response([group('BJ-OTHER', '1005', [100])], 100), { regionId: 'region-jrhy', housePrefix: 'BJ-JRHY' }), /超出授权项目前缀/)
  const noRoom = group('BJ-JRHY', '1005', [100]); delete (noRoom as any).roomId
  assert.throws(() => parseLvzaiArrearageResponse(response([noRoom], 100), { regionId: 'region-jrhy', housePrefix: 'BJ-JRHY' }), /缺少roomId/)
  const noPerson = group('BJ-JRHY', '1005', [100]); delete (noPerson.beLongDateList[0] as any).personId
  assert.throws(() => parseLvzaiArrearageResponse(response([noPerson], 100), { regionId: 'region-jrhy', housePrefix: 'BJ-JRHY' }), /缺少personId/)
  const noFees = group('BJ-JRHY', '1005', [100]); (noFees.beLongDateList[0] as any).feeList = []
  assert.throws(() => parseLvzaiArrearageResponse(response([noFees], 100), { regionId: 'region-jrhy', housePrefix: 'BJ-JRHY' }), /缺少费项/)
})

test('构造器拒绝空项目、重复项目ID和无效房屋前缀', () => {
  const transport: LvzaiArrearageTransport = { async probe() { return true }, async relogin() {}, async post() { return {} } }
  assert.throws(() => new LvzaiGetArrearageConnector(transport, { businessDate: '2026-08-28', projects: [] }), /项目范围为空/)
  assert.throws(() => new LvzaiGetArrearageConnector(transport, { businessDate: '2026-08-28', projects: [{ regionId: 'x', housePrefix: 'BJ-JRHY', serviceCenter: '项目一' }, { regionId: 'x', housePrefix: 'BJ-OTHER', serviceCenter: '项目二' }] }), /为空或重复/)
  assert.throws(() => new LvzaiGetArrearageConnector(transport, { businessDate: '2026-08-28', projects: [{ regionId: 'x', housePrefix: 'BJ', serviceCenter: '项目一' }] }), /项目前缀无效/)
})
