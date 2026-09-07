import assert from 'node:assert/strict'
import test from 'node:test'
import { ArrearsConnectorGateError } from '../src/arrears-connectors.js'
import { QxmIncrementalEvidenceConnector, normalizeQxmEvidenceEnvelope, readAndNormalizeQxmEvidence, type QxmEvidenceTransport, type QxmMessagePage } from '../src/qxm-evidence-connector.js'

const previous = process.env.ARREARS_RESOURCE_HASH_KEY
process.env.ARREARS_RESOURCE_HASH_KEY = 'qxm-evidence-test-resource-key-at-least-32'
test.after(() => { if (previous === undefined) delete process.env.ARREARS_RESOURCE_HASH_KEY; else process.env.ARREARS_RESOURCE_HASH_KEY = previous })

function message(overrides: Record<string, unknown> = {}) {
  return { messageId: 'msg-1', external_userid: 'external-1', employeeUserId: 'employee-1', 房屋备注: '1-1-1005', 消息时间: '2026-08-27T10:20:00+08:00', 消息方向: '客户发送', 消息类型: '文本', 消息内容: '客户承诺月底缴费', __departmentId: 'dept-1', __serviceCenter: '嘉润花园', __housePrefix: 'BJ-JRHY', ...overrides }
}
function envelope(rows = [message()]) {
  return { source: 'qxm' as const, businessDate: '2026-08-28', extractedAt: '2026-08-28T01:00:00Z', rows, declaredRowCount: rows.length, nextCursors: [{ departmentId: 'dept-1', cursor: 'cursor-next' }] }
}

test('企小码短房号只能结合受控项目补全，原文及稳定ID只形成HMAC', () => {
  const result = normalizeQxmEvidenceEnvelope(envelope(), { now: new Date('2026-08-28T02:00:00Z') })
  const row = result.rows[0]
  assert.equal(row.matchState, 'matched')
  assert.equal(row.houseDisplay, 'BJ-JRHY-1-1-1005')
  assert.equal(row.signalState, 'supported')
  assert.equal(row.causeSignal, 'promised_payment')
  assert.equal(row.direction, 'inbound')
  assert.match(row.messageIdHash, /^[a-f0-9]{64}$/)
  assert.match(result.nextCursors[0].departmentIdHash, /^[a-f0-9]{64}$/)
  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /客户承诺月底缴费|external-1|employee-1|msg-1|dept-1/)
})

test('无房屋备注或越权完整房屋号自动隔离，不使用客户或员工身份强制匹配', () => {
  const result = normalizeQxmEvidenceEnvelope(envelope([
    message({ messageId: 'm1', 房屋备注: '' }),
    message({ messageId: 'm2', 房屋备注: 'BJ-OTHER-1-1-1005' }),
  ]), { now: new Date('2026-08-28T02:00:00Z') })
  assert.equal(result.quality.matchedCount, 0)
  assert.equal(result.quality.isolatedUnlinkedCount, 2)
  assert.ok(result.rows.every(row => row.houseHash === null && row.matchState === 'review_required'))
})

test('否定、多原因与非文本消息不生成未经核验的原因结论', () => {
  const result = normalizeQxmEvidenceEnvelope(envelope([
    message({ messageId: 'm1', 消息内容: '并非房屋空置，不认可账单金额' }),
    message({ messageId: 'm2', 消息内容: '房屋空置且资金周转困难' }),
    message({ messageId: 'm3', 消息类型: '图片', 消息内容: '图片中的客户姓名和电话不得解析' }),
  ]), { now: new Date('2026-08-28T02:00:00Z') })
  assert.deepEqual(result.rows.map(row => [row.signalState, row.causeSignal]), [['conflicted', 'unknown'], ['conflicted', 'unknown'], ['none', 'unknown']])
  assert.doesNotMatch(JSON.stringify(result), /图片中的客户姓名和电话不得解析/)
})

test('稳定消息ID、客户ID、员工ID、时间、声明行数及重复消息任一异常均失败关闭', () => {
  const cases: Array<[any, RegExp]> = [
    [envelope([message({ messageId: '' })]), /缺少稳定消息/],
    [envelope([message({ external_userid: '' })]), /缺少稳定消息/],
    [envelope([message({ employeeUserId: '' })]), /缺少稳定消息/],
    [envelope([message({ 消息时间: 'invalid' })]), /消息时间无效/],
    [envelope([message(), message()]), /消息ID重复/],
    [{ ...envelope(), declaredRowCount: 2 }, /声明行数与消息数不一致/],
  ]
  for (const [input, pattern] of cases) assert.throws(() => normalizeQxmEvidenceEnvelope(input, { now: new Date('2026-08-28T02:00:00Z') }), pattern)
  assert.throws(() => normalizeQxmEvidenceEnvelope({ ...envelope(), source: 'lvzai' } as any, { now: new Date('2026-08-28T02:00:00Z') }), ArrearsConnectorGateError)
})

test('增量连接器完整读取分页并为每个部门保存下一游标', async () => {
  const calls: string[] = []
  const pages: QxmMessagePage[] = [
    { rows: [message({ messageId: 'm1' })], total: 2, nextCursor: 'c1', hasMore: true },
    { rows: [message({ messageId: 'm2' })], total: 1, nextCursor: 'c2', hasMore: false },
  ]
  const transport: QxmEvidenceTransport = { async readMessages(input) { calls.push(input.cursor); return pages.shift()! } }
  const connector = new QxmIncrementalEvidenceConnector(transport, { businessDate: '2026-08-28', scopes: [{ departmentId: 'dept-1', reviewServiceCenter: '朝阳片区复核', projects: [{ serviceCenter: '嘉润花园', housePrefix: 'BJ-JRHY' }], cursor: 'c0' }], extractedAt: () => '2026-08-28T01:00:00Z' })
  const result = await readAndNormalizeQxmEvidence(connector, { now: new Date('2026-08-28T02:00:00Z') })
  assert.deepEqual(calls, ['c0', 'c1'])
  assert.equal(result.quality.rowCount, 2)
  assert.equal(result.nextCursors[0].cursor, 'c2')
})

test('同一部门多项目仅按完整前缀映射，短房号进入受控自动隔离', async () => {
  const transport: QxmEvidenceTransport = { async readMessages() { return { rows: [message({ messageId: 'm1', 房屋备注: 'BJ-JRHY-1-1-1005' }), message({ messageId: 'm2', 房屋备注: 'BJ-WGC-2-1-1008' }), message({ messageId: 'm3', 房屋备注: '3-1-1009' })], total: 3, nextCursor: 'next', hasMore: false } } }
  const connector = new QxmIncrementalEvidenceConnector(transport, { businessDate: '2026-08-28', scopes: [{ departmentId: 'dept-1', reviewServiceCenter: '朝阳片区复核', projects: [{ housePrefix: 'BJ-JRHY', serviceCenter: '嘉润花园' }, { housePrefix: 'BJ-WGC', serviceCenter: '万国城' }] }], extractedAt: () => '2026-08-28T01:00:00Z' })
  const result = await readAndNormalizeQxmEvidence(connector, { now: new Date('2026-08-28T02:00:00Z') })
  assert.deepEqual(result.rows.map(row => [row.serviceCenter, row.matchState]), [['嘉润花园', 'matched'], ['万国城', 'matched'], ['朝阳片区复核', 'review_required']])
})

test('房屋备注二次验证只接受唯一受控候选，日期与多候选自动隔离', async () => {
  const transport: QxmEvidenceTransport = { async readMessages() { return { rows: [
    message({ messageId: 'm1', 房屋备注: '房号：3-1-1009（已交房）' }),
    message({ messageId: 'm2', 房屋备注: '2号楼1单元0304室' }),
    message({ messageId: 'm3', 房屋备注: '1-1-1005和2-1-1006' }),
    message({ messageId: 'm4', 房屋备注: '跟进日期2026-08-28' }),
  ], total: 4, nextCursor: 'next', hasMore: false } } }
  const connector = new QxmIncrementalEvidenceConnector(transport, { businessDate: '2026-08-28', scopes: [{ departmentId: 'dept-1', reviewServiceCenter: '朝阳片区复核', projects: [{ housePrefix: 'BJ-JRHY', serviceCenter: '嘉润花园' }] }], extractedAt: () => '2026-08-28T01:00:00Z' })
  const result = await readAndNormalizeQxmEvidence(connector, { now: new Date('2026-08-28T02:00:00Z') })
  assert.deepEqual(result.rows.map(row => [row.houseDisplay, row.matchState]), [['BJ-JRHY-3-1-1009', 'matched'], ['BJ-JRHY-2-1-0304', 'matched'], [null, 'review_required'], [null, 'review_required']])
  assert.equal(result.quality.isolatedUnlinkedCount, 2)
})

test('分页总数变化、游标循环、页数超限及不完整读取时拒绝返回部分结果', async () => {
  const scope = [{ departmentId: 'dept-1', reviewServiceCenter: '朝阳片区复核', projects: [{ serviceCenter: '嘉润花园', housePrefix: 'BJ-JRHY' }] }]
  const changing: QxmEvidenceTransport = { async readMessages(input) { return input.cursor ? { rows: [], total: 2, nextCursor: 'c2', hasMore: false } : { rows: [message()], total: 1, nextCursor: 'c1', hasMore: true } } }
  await assert.rejects(new QxmIncrementalEvidenceConnector(changing, { businessDate: '2026-08-28', scopes: scope }).read(), /剩余总行数未按游标递减/)
  const looping: QxmEvidenceTransport = { async readMessages() { return { rows: [], total: 0, nextCursor: 'same', hasMore: true } } }
  await assert.rejects(new QxmIncrementalEvidenceConnector(looping, { businessDate: '2026-08-28', scopes: [{ ...scope[0], cursor: 'same' }] }).read(), /分页标记继续但未返回消息/)
  let endlessPage = 0
  const endless: QxmEvidenceTransport = { async readMessages(input) { endlessPage += 1; return { rows: [message({ messageId: `endless-${endlessPage}` })], total: 4 - endlessPage, nextCursor: `${input.cursor}x`, hasMore: true } } }
  await assert.rejects(new QxmIncrementalEvidenceConnector(endless, { businessDate: '2026-08-28', scopes: scope, maximumPages: 2 }).read(), /分页超过安全上限/)
  const incomplete: QxmEvidenceTransport = { async readMessages() { return { rows: [], total: 1, nextCursor: 'c1', hasMore: false } } }
  await assert.rejects(new QxmIncrementalEvidenceConnector(incomplete, { businessDate: '2026-08-28', scopes: scope }).read(), /完整读取数量不一致/)
})
