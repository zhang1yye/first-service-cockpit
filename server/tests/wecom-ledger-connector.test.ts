import assert from 'node:assert/strict'
import test from 'node:test'
import { ArrearsConnectorGateError } from '../src/arrears-connectors.js'
import { WecomControlledLedgerConnector, normalizeWecomLedgerEnvelope, readAndNormalizeWecomLedger, type WecomLedgerTransport } from '../src/wecom-ledger-connector.js'

const previous = process.env.ARREARS_RESOURCE_HASH_KEY
process.env.ARREARS_RESOURCE_HASH_KEY = 'wecom-ledger-test-resource-key-at-least-32'
test.after(() => { if (previous === undefined) delete process.env.ARREARS_RESOURCE_HASH_KEY; else process.env.ARREARS_RESOURCE_HASH_KEY = previous })

function row(overrides: Record<string, unknown> = {}) {
  return {
    recordId: 'record-1', 房屋编号: 'BJ-JRHY-1-1-1005', 欠费金额: '999999.99',
    欠费原因: '业主反馈房屋长期空置', 催缴进展: '已缴费，等待绿仔确认',
    最新跟进日期: '2026-08-27', 承诺缴费日期: '2026-08-31', 主责人ID: 'wecom-user-1',
    __documentId: 'document-1', __sheetId: 'sheet-1', __housePrefix: 'BJ-JRHY', __serviceCenter: '嘉润花园', ...overrides,
  }
}
function envelope(rows = [row()]) {
  return { source: 'wecom_ledger' as const, businessDate: '2026-08-28', extractedAt: '2026-08-28T01:00:00Z', rows, declaredRowCount: rows.length }
}

test('企业微信人工台账只形成结构化经营证据，金额不进入权威事实', () => {
  const result = normalizeWecomLedgerEnvelope(envelope(), { now: new Date('2026-08-28T02:00:00Z') })
  assert.equal(result.quality.authoritativeAmountFields, 0)
  assert.equal(result.rows[0].manualCause, 'vacancy')
  assert.equal(result.rows[0].progress, 'reported_paid_pending_lvzai')
  assert.equal(result.rows[0].houseDisplay, 'BJ-JRHY-1-1-1005')
  assert.equal(result.rows[0].latestFollowupDate, '2026-08-27')
  assert.ok(result.rows[0].documentIdHash.length === 64)
  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /999999|业主反馈|wecom-user-1|document-1|sheet-1|record-1/)
})

test('同一片区工作表按房屋前缀注入受控项目与服务中心映射', async () => {
  const calls: unknown[] = []
  const transport: WecomLedgerTransport = {
    async readSheet(input) {
      calls.push(input)
      return { rows: [{ ...row(), __housePrefix: 'BJ-WRONG', __documentId: 'forged' }, { ...row({ recordId: 'record-2', 房屋编号: 'BJ-OTHER-2-1-1008' }), __serviceCenter: 'forged-center' }], total: 2 }
    },
  }
  const connector = new WecomControlledLedgerConnector(transport, {
    businessDate: '2026-08-28', documentId: 'document-authorized', sheets: [{ sheetId: 'sheet-authorized', projects: [{ housePrefix: 'BJ-JRHY', serviceCenter: '嘉润花园' }, { housePrefix: 'BJ-OTHER', serviceCenter: '其他服务中心' }] }], extractedAt: () => '2026-08-28T01:00:00Z',
  })
  const result = await readAndNormalizeWecomLedger(connector, { now: new Date('2026-08-28T02:00:00Z') })
  assert.equal(result.rows.length, 2)
  assert.deepEqual(result.rows.map(item => item.serviceCenter), ['嘉润花园', '其他服务中心'])
  assert.deepEqual(calls, [{ documentId: 'document-authorized', sheetId: 'sheet-authorized', businessDate: '2026-08-28' }])
})

test('片区工作表出现未配置项目前缀时失败关闭', async () => {
  const transport: WecomLedgerTransport = { async readSheet() { return { rows: [row({ 房屋编号: 'BJ-UNKNOWN-1-1-1005' })], total: 1 } } }
  const connector = new WecomControlledLedgerConnector(transport, { businessDate: '2026-08-28', documentId: 'doc', sheets: [{ sheetId: 'sheet', projects: [{ housePrefix: 'BJ-JRHY', serviceCenter: '嘉润花园' }] }], extractedAt: () => '2026-08-28T01:00:00Z' })
  await assert.rejects(readAndNormalizeWecomLedger(connector, { now: new Date('2026-08-28T02:00:00Z') }), /未配置受控项目映射/)
})

test('缺失完整房屋号、稳定证据ID、越权前缀和重复记录均失败关闭', () => {
  const invalidCases: Array<[Record<string, unknown>[], RegExp]> = [
    [[row({ 房屋编号: '1-1-1005' })], /完整五段式房屋号/],
    [[row({ recordId: '' })], /稳定证据ID/],
    [[row({ __housePrefix: 'BJ-OTHER' })], /超出工作表授权前缀/],
    [[row(), row()], /记录ID重复/],
  ]
  for (const [rows, pattern] of invalidCases) assert.throws(() => normalizeWecomLedgerEnvelope(envelope(rows), { now: new Date('2026-08-28T02:00:00Z') }), pattern)
  assert.throws(() => normalizeWecomLedgerEnvelope(envelope([row({ recordId: 'bad-1', 房屋编号: '1-1-1005' }), row({ recordId: 'bad-2', 房屋编号: '2-1-1006' })]), { now: new Date('2026-08-28T02:00:00Z') }), /缺少完整五段式房屋号（2行）/)
})

test('日期、声明行数、最小行数和来源异常时质量门禁拒绝部分结果', () => {
  assert.throws(() => normalizeWecomLedgerEnvelope({ ...envelope(), businessDate: '2026-08-29' }, { now: new Date('2026-08-28T02:00:00Z') }), ArrearsConnectorGateError)
  assert.throws(() => normalizeWecomLedgerEnvelope({ ...envelope(), declaredRowCount: 2 }, { now: new Date('2026-08-28T02:00:00Z') }), /声明行数/)
  assert.throws(() => normalizeWecomLedgerEnvelope(envelope(), { now: new Date('2026-08-28T02:00:00Z'), minimumRows: 2 }), /门禁下限/)
  assert.throws(() => normalizeWecomLedgerEnvelope({ ...envelope(), source: 'lvzai' as const } as any, { now: new Date('2026-08-28T02:00:00Z') }), /来源必须/)
  assert.throws(() => normalizeWecomLedgerEnvelope(envelope([row({ 最新跟进日期: '2026-99-99' })]), { now: new Date('2026-08-28T02:00:00Z') }), /最新跟进日期无效/)
})

test('工作表读取数量不完整、范围为空或重复时连接器拒绝生成信封', async () => {
  const bad: WecomLedgerTransport = { async readSheet() { return { rows: [row()], total: 2 } } }
  const connector = new WecomControlledLedgerConnector(bad, { businessDate: '2026-08-28', documentId: 'doc', sheets: [{ sheetId: 's1', projects: [{ housePrefix: 'BJ-JRHY', serviceCenter: '嘉润花园' }] }] })
  await assert.rejects(connector.read(), /声明行数与读取行数不一致/)
  assert.throws(() => new WecomControlledLedgerConnector(bad, { businessDate: '2026-08-28', documentId: '', sheets: [] }), /范围为空/)
  assert.throws(() => new WecomControlledLedgerConnector(bad, { businessDate: '2026-08-28', documentId: 'doc', sheets: [{ sheetId: 's1', projects: [{ housePrefix: 'BJ-JRHY', serviceCenter: '嘉润花园' }] }, { sheetId: 's1', projects: [{ housePrefix: 'BJ-OTHER', serviceCenter: '其他服务中心' }] }] }), /为空或重复/)
})
