import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLedgerResourceResolver, buildResourceEvidence, extractSensitiveTerms, findResidualSensitivePatterns, inferRuleCause, mapCommunicationRows, mapLedgerNarrativeRows, mapLedgerRows, maskSensitiveText, normalizeResourceKey, validateAiAttributions } from '../src/arrears-analysis.js'

test('标准欠费台账保留缺失而不补0，并只用资源编码关联', () => {
  const result = mapLedgerRows([
    { 资源编码: 'A-1-101', 客户姓名: '张三', 手机号: '13800138000', 欠费金额: '1250.50', 账龄天数: '93', 费项: '物业费' },
    { 资源编码: 'A-1-102', 客户姓名: '李四', 手机号: '', 欠费金额: '', 账龄天数: '' },
  ])
  assert.equal(result.rows.length, 2); assert.equal(result.rows[0].resourceDisplay, 'A-1-101'); assert.equal(result.rows[0].arrearsAmount, 1250.5); assert.equal(result.rows[1].arrearsAmount, null); assert.equal(result.rows[1].ageingDays, null); assert.match(result.rows[0].customerMasked, /^张/); assert.equal(result.rows[0].phoneMasked, '138****8000')
})

test('周会台账识别房间合计和账期，并排除明确已回款记录', () => {
  const result = mapLedgerRows([
    { 房间: 'BJ-HD-1-1-101', 合计: '1,250.50', 费用开始日期: '2025-01-01', 费用结束日期: '2025-12-31', 是否回款: '' },
    { 房间: 'BJ-HD-1-1-102', 合计: '2,000.00', 费用开始日期: '2025-01-01', 费用结束日期: '2025-12-31', 是否回款: '是' },
  ])
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].resourceDisplay, 'BJ-HD-1-1-101')
  assert.equal(result.rows[0].resourceMasked, 'BJ***01')
  assert.equal(result.rows[0].arrearsAmount, 1250.5)
  assert.equal(result.rows[0].periodStart, '2025-01-01')
  assert.equal(result.rows[0].periodEnd, '2025-12-31')
})

test('周会台账欠费原因只生成本地受控信号，已回款和空原因不生成证据', () => {
  const result = mapLedgerNarrativeRows([
    { __sourceRow: 2, 房间: 'BJ-HD-1-1-101', 欠费原因: '室内漏水维修响应不及时', 是否回款: '' },
    { __sourceRow: 3, 房间: 'BJ-HD-1-1-102', 欠费原因: '承诺月底缴费', 是否回款: '是' },
    { __sourceRow: 4, 房间: 'BJ-HD-1-1-103', 欠费原因: '', 是否回款: '' },
  ])
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].contentMasked, '本地规则信号：服务争议')
  assert.equal(inferRuleCause(result.rows).category, 'service_dispute')
  assert.equal(result.rows[0].contentMasked.includes('室内漏水'), false)
})

test('周会台账可同时提取多个受控原因信号，没钱不被误判为否定语境', () => {
  const result = mapLedgerNarrativeRows([
    { __sourceRow: 2, 房间: 'BJ-HD-1-1-101', 欠费原因: '室内漏水未维修，要求减免物业费' },
    { __sourceRow: 3, 房间: 'BJ-HD-1-1-102', 欠费原因: '家人生病住院，暂时没钱，年底结清' },
    { __sourceRow: 4, 房间: 'BJ-HD-1-1-103', 欠费原因: '没有欠费原因，就让再等等' },
  ])
  assert.equal(result.rows[0].contentMasked, '本地规则信号：服务争议、收费争议')
  assert.equal(inferRuleCause([result.rows[0]]).category, 'service_dispute')
  assert.equal(result.rows[1].contentMasked, '本地规则信号：支付困难、承诺缴费')
  assert.equal(inferRuleCause([result.rows[1]]).category, 'financial_hardship')
  assert.equal(result.rows[2].contentMasked, '本地未提取到可确认的原因信号')
  assert.equal(inferRuleCause([result.rows[2]]).category, 'unknown')
})

test('企小码缺少记录不推断为未联系，只有原文命中才归为联系障碍', () => {
  assert.equal(inferRuleCause([]).category, 'unknown')
  const contact = mapCommunicationRows([{ 资源编码: 'A-1-101', 沟通时间: '2026-08-01 10:00', 沟通记录: '多次拨打为空号，暂时联系不上业主' }])
  const inferred = inferRuleCause(contact.rows); assert.equal(inferred.category, 'contact_barrier'); assert.ok(inferred.evidenceRefs.includes('C-2'))
})

test('发送云端AI前脱敏手机号、身份证、邮箱和姓名', () => {
  const masked = maskSensitiveText('张三手机号13800138000，身份证110101199001011234，邮箱zhangsan@example.com', ['张三'])
  for (const raw of ['13800138000','110101199001011234','zhangsan@example.com','张三']) assert.equal(masked.includes(raw), false)
})

test('证据包区分台账事实、沟通证据和规则归类', () => {
  const ledger = mapLedgerRows([{ 资源编码: 'A-1-101', 欠费金额: '1250.50', 账龄天数: '93' }]).rows
  const communications = mapCommunicationRows([{ 资源编码: 'A-1-101', 沟通记录: '客户表示房屋一直空置，要求核对费用' }]).rows
  const evidence = buildResourceEvidence(ledger, communications)
  assert.equal(evidence.length, 1); assert.equal(evidence[0].ledgerEvidence.ref, 'L-2'); assert.equal(evidence[0].communications[0].ref, 'C-2'); assert.equal(evidence[0].ruleAttribution.category, 'vacancy')
})

test('台账内原因信号参与归因但不计入聊天记录', () => {
  const source = [{ __sourceRow: 2, 房间: 'BJ-HD-1-1-101', 合计: '1250.50', 欠费原因: '室内漏水维修响应不及时' }]
  const ledger = mapLedgerRows(source).rows
  const narrativeSignals = mapLedgerNarrativeRows(source).rows
  const evidence = buildResourceEvidence(ledger, [], narrativeSignals)
  assert.equal(evidence[0].communications.length, 0)
  assert.equal(evidence[0].ruleAttribution.category, 'service_dispute')
  assert.ok(evidence[0].ruleAttribution.evidenceRefs.includes('T-2'))
})

test('AI归因只能引用当前资源现有证据，非法类别和伪造引用被拒绝', () => {
  const allowed = [{ resourceRef: 'R-abc', evidenceRefs: ['L-2', 'C-2'] }]
  const ok = validateAiAttributions([{ resourceRef: 'R-abc', category: 'vacancy', confidence: 0.82, reason: '沟通记录明确提及空置', evidenceRefs: ['C-2'] }], allowed)
  assert.equal(ok.accepted.length, 1); assert.equal(ok.coverageOk, true)
  const bad = validateAiAttributions([{ resourceRef: 'R-abc', category: 'invented', confidence: 1.2, reason: '猜测', evidenceRefs: ['C-99'] }], allowed)
  assert.equal(bad.accepted.length, 0); assert.equal(bad.rejected.length, 1)
  const ledgerReason = validateAiAttributions([{ resourceRef: 'R-ledger', category: 'service_dispute', confidence: 0.7, reason: '台账固定信号指向服务争议', evidenceRefs: ['T-2'] }], [{ resourceRef: 'R-ledger', evidenceRefs: ['L-2', 'T-2'] }])
  assert.equal(ledgerReason.accepted.length, 1); assert.equal(ledgerReason.coverageOk, true)
})

test('非法金额与账龄、倒置账期必须显式报错，不得伪装成缺失值', () => {
  const result = mapLedgerRows([{ 资源编码: 'A-1-101', 欠费金额: 'abc', 账龄天数: '-2.5', 欠费起始月: '2026-08', 欠费截止月: '2026-01' }])
  assert.equal(result.rows[0].arrearsAmount, null); assert.ok(result.errors.some(item => item.includes('欠费金额'))); assert.ok(result.errors.some(item => item.includes('账龄天数'))); assert.ok(result.errors.some(item => item.includes('起始月')))
})

test('项目内短房号与楼栋单元房间三字段归一为同一资源键', () => {
  const a = mapLedgerRows([{ 资源编码: 'A-1-101' }]).rows[0], b = mapLedgerRows([{ 资源编码: 'A1-101' }]).rows[0], parts = mapLedgerRows([{ 楼栋: 'A', 单元: '1', 房号: '101' }]).rows[0]
  assert.notEqual(a.resourceHash, b.resourceHash); assert.equal(a.resourceHash, parts.resourceHash)
})

test('三字母组织代码及楼栋单元房间标签仍归一为完整五段式房屋号', () => {
  const resource = normalizeResourceKey({ 房屋编码: 'ZJL-JYGC-10号楼-3单元-1002室' })
  assert.equal(resource?.display, 'ZJL-JYGC-10-3-1002')
  assert.equal(resource?.canonical.startsWith('H:'), true)
  assert.equal(normalizeResourceKey({ 房屋编码: 'YK-DWJ-高层10-2-商铺1503' })?.display, 'YK-DWJ-高层10-2-商铺1503')
})

test('完整房屋号可在项目批次内与企小码短房号稳定匹配', () => {
  const ledger = mapLedgerRows([{ 房屋编号: 'BJ-JRHY-1-1-1005', 欠费金额: '1000' }]).rows
  const resolver = buildLedgerResourceResolver(ledger)
  const communications = mapCommunicationRows([
    { 客户备注: '1-1-1005', 沟通记录: '业主表示月底缴费' },
    { 房屋备注: '1号楼1单元1005室', 沟通记录: '业主表示月底缴费' },
  ], [], resolver)
  assert.equal(communications.resolvedByShortRoom, 2)
  assert.equal(communications.rows[0].resourceHash, ledger[0].resourceHash)
  assert.equal(communications.rows[1].resourceHash, ledger[0].resourceHash)
})

test('跨项目同短房号存在多个完整编码时拒绝自动关联', () => {
  const ledger = mapLedgerRows([{ 房屋编号: 'BJ-JRHY-1-1-1005' }, { 房屋编号: 'BJ-OTHER-1-1-1005' }]).rows
  const communications = mapCommunicationRows([{ 客户备注: '1-1-1005', 沟通记录: '已沟通' }], [], buildLedgerResourceResolver(ledger))
  assert.equal(communications.resolvedByShortRoom, 0)
  assert.notEqual(communications.rows[0].resourceHash, ledger[0].resourceHash)
  assert.ok(communications.warnings.some(item => item.includes('多个完整房屋号')))
})

test('三字段资源键使用结构化编码，不因字段内分隔符发生碰撞', () => {
  const result = mapLedgerRows([{ 楼栋: 'A|1', 单元: '2', 房号: '3' }, { 楼栋: 'A', 单元: '1', 房号: '2|3' }])
  assert.equal(result.errors.length, 0); assert.notEqual(result.rows[0].resourceHash, result.rows[1].resourceHash)
})

test('姓名别名、资源号、座机、银行卡和地址在云端前被脱敏', () => {
  const source = [{ 资源编码: 'A-1-101', 姓名: '张三', 电话: '13800138000' }]
  const communication = mapCommunicationRows([{ 资源编码: 'A-1-101', 员工姓名: '王五', 沟通记录: '张三住A-1-101，座机010-12345678，卡号6222021234567890，北京市朝阳区某小区1栋101室' }], extractSensitiveTerms(source))
  assert.equal(communication.errors.length, 0)
  const masked = communication.rows[0].contentMasked
  for (const raw of ['张三','A-1-101','010-12345678','6222021234567890','北京市朝阳区某小区1栋101室']) assert.equal(masked.includes(raw), false)
  assert.equal(findResidualSensitivePatterns(masked).length, 0); assert.notEqual(communication.rows[0].actor, '王五')
})

test('云端证据不携带任何自由文本姓名，时间和渠道必须结构化', () => {
  const result = mapCommunicationRows([{ 资源编码: 'A-1-101', 沟通时间: '2026-08-01', 沟通方式: '联系张三', 沟通记录: '王五表示将让李四代缴，近期缴费' }])
  assert.equal(result.errors.length, 0); assert.equal(result.rows[0].occurredAt, '2026-08-01'); assert.equal(result.rows[0].channel, '其他')
  for (const raw of ['王五','李四','张三']) assert.equal(JSON.stringify(result.rows[0]).includes(raw), false)
  assert.equal(result.rows[0].contentMasked, '本地规则信号：承诺缴费')
  const invalid = mapCommunicationRows([{ 资源编码: 'A-1-101', 沟通时间: '王五 2026-08-01', 沟通记录: '正常沟通' }])
  assert.ok(invalid.errors.some(item => item.includes('沟通时间')))
})

test('AI空数组、漏项、重复项和额外资源均不能通过完整性门禁', () => {
  const allowed = [{ resourceRef: 'R-a', evidenceRefs: ['L-2'] }, { resourceRef: 'R-b', evidenceRefs: ['L-3'] }]
  const one = { resourceRef: 'R-a', category: 'unknown', confidence: 0.2, reason: '证据不足', evidenceRefs: ['L-2'] }
  const second = { resourceRef: 'R-b', category: 'unknown', confidence: 0.2, reason: '证据不足', evidenceRefs: ['L-3'] }
  assert.equal(validateAiAttributions([], allowed).coverageOk, false); assert.equal(validateAiAttributions([one], allowed).coverageOk, false); assert.equal(validateAiAttributions([one, one, second], allowed).coverageOk, false); assert.equal(validateAiAttributions([one, second, { ...one, resourceRef: 'R-x' }], allowed).coverageOk, false)
})
