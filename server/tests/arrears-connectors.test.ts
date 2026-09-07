import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ArrearsConnectorGateError,
  normalizeLvzaiArrearsEnvelope,
  readAndNormalizeLvzaiArrears,
  type ArrearsSourceConnector,
} from '../src/arrears-connectors.js'

const previousHashKey = process.env.ARREARS_RESOURCE_HASH_KEY
process.env.ARREARS_RESOURCE_HASH_KEY = 'r141-test-only-resource-hash-key-32-bytes-minimum'

test.after(() => {
  if (previousHashKey === undefined) delete process.env.ARREARS_RESOURCE_HASH_KEY
  else process.env.ARREARS_RESOURCE_HASH_KEY = previousHashKey
})

const now = new Date('2026-08-28T08:00:00+08:00')
const validRows = [
  {
    roomSign: 'BJ-JRHY-1-1-1005', serviceCenter: '嘉润花园', roomId: 'room-1005', personId: 'person-a',
    arrearageAmount: '1,250.50', feeItemName: '物业费',
    arrearsStartDate: '2026-01-01', arrearsEndDate: '2026-07-31', paymentStatus: '欠费',
    customerName: '不应进入标准输出', phone: '13800138000',
  },
  {
    roomSign: 'BJ-JRHY-1-1-1006', serviceCenter: '嘉润花园', roomId: 'room-1006', personId: 'person-b',
    arrearageAmount: 320, feeItemName: '车位费',
    arrearsStartDate: '2026-06', arrearsEndDate: '2026-07', paymentStatus: '欠费',
  },
]

function envelope(rows = validRows) {
  return {
    source: 'lvzai' as const,
    businessDate: '2026-08-28',
    extractedAt: '2026-08-28T07:30:00+08:00',
    rows,
    declaredRowCount: rows.length,
    declaredTotalAmount: 1570.5,
  }
}

test('绿仔逐户欠费通过完整房屋号、稳定ID、金额和账期门禁后标准化', () => {
  const result = normalizeLvzaiArrearsEnvelope(envelope(), { now, minimumRows: 2 })
  assert.equal(result.quality.state, 'passed')
  assert.equal(result.quality.rowCount, 2)
  assert.equal(result.quality.uniqueHouseCount, 2)
  assert.equal(result.quality.totalAmount, 1570.5)
  assert.equal(result.rows[0].houseDisplay, 'BJ-JRHY-1-1-1005')
  assert.match(result.rows[0].houseCanonical, /^H:/)
  assert.match(result.rows[0].houseHash, /^[a-f0-9]{64}$/)
  assert.match(result.rows[0].roomIdHash, /^[a-f0-9]{64}$/)
  assert.match(result.rows[0].personIdHash, /^[a-f0-9]{64}$/)
  assert.match(result.rows[0].sourceEvidenceHash, /^[a-f0-9]{64}$/)
  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /不应进入标准输出|13800138000|room-1005|person-a/)
})

test('绿仔门禁拒绝短房号、缺失稳定ID、非法金额和倒置账期，且不返回部分结果', () => {
  const rows = [{
    roomSign: '1-1-1005', serviceCenter: '嘉润花园', roomId: '', personId: '', arrearageAmount: '-1', feeItemName: '物业费',
    arrearsStartDate: '2026-08', arrearsEndDate: '2026-01',
  }]
  assert.throws(
    () => normalizeLvzaiArrearsEnvelope({ ...envelope(rows), declaredTotalAmount: 0 }, { now }),
    (error: unknown) => {
      assert.ok(error instanceof ArrearsConnectorGateError)
      assert.match(error.message, /五段式roomSign/)
      assert.match(error.message, /缺少roomId/)
      assert.match(error.message, /缺少personId/)
      assert.match(error.message, /欠费金额无效/)
      assert.match(error.message, /欠费账期倒置/)
      return true
    },
  )
})

test('绿仔门禁拒绝重复明细、总额不一致、未来业务日期和异常少量数据', () => {
  const duplicate = [validRows[0], { ...validRows[0] }]
  assert.throws(() => normalizeLvzaiArrearsEnvelope(envelope(), { now, minimumRows: 3 }), /少于门禁下限3行/)
  assert.throws(
    () => normalizeLvzaiArrearsEnvelope({ ...envelope(duplicate), declaredTotalAmount: 2501 }, { now }),
    /房屋费项账期重复|存在重复/,
  )
  assert.throws(
    () => normalizeLvzaiArrearsEnvelope({ ...envelope(), declaredTotalAmount: 1 }, { now }),
    /声明欠费合计与逐行重算结果不一致/,
  )
  assert.throws(
    () => normalizeLvzaiArrearsEnvelope({ ...envelope(), businessDate: '2026-08-29' }, { now }),
    /业务日期不得晚于当前时间/,
  )
})

test('可替换连接器只依赖统一read合同，来源不一致时失败关闭', async () => {
  const connector: ArrearsSourceConnector<Record<string, unknown>> = {
    source: 'lvzai',
    async read() { return envelope() },
  }
  const result = await readAndNormalizeLvzaiArrears(connector, { now, minimumRows: 2 })
  assert.equal(result.rows.length, 2)

  const wrongConnector: ArrearsSourceConnector<Record<string, unknown>> = {
    source: 'qxm',
    async read() { return { ...envelope(), source: 'qxm' } },
  }
  await assert.rejects(() => readAndNormalizeLvzaiArrears(wrongConnector, { now }), /来源与绿仔标准化器不一致/)
})

test('缺少至少32位HMAC密钥时拒绝处理稳定ID', () => {
  process.env.ARREARS_RESOURCE_HASH_KEY = 'short'
  try {
    assert.throws(() => normalizeLvzaiArrearsEnvelope(envelope(), { now }), /长度不足32位/)
  } finally {
    process.env.ARREARS_RESOURCE_HASH_KEY = 'r141-test-only-resource-hash-key-32-bytes-minimum'
  }
})
