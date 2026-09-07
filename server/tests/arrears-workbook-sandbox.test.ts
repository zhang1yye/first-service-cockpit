import assert from 'node:assert/strict'
import test from 'node:test'
import * as XLSX from '@e965/xlsx'
import { parseWorkbookRowsSandboxed } from '../dist/arrears-workbook-parser.js'

function workbook(rows: Record<string, unknown>[]) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '台账')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

function weeklyWorkbook() {
  const wb = XLSX.utils.book_new()
  const headers = ['片区', '小区', '房间', '费用开始日期', '费用结束日期', '合计', '年限', '欠费原因', '催缴措施', '提升计划', '是否回款']
  const sheet = (area: string, room: string, amount: number) => XLSX.utils.aoa_to_sheet([
    headers,
    [area, `${area}项目`, room, '2025-01-01', '2025-12-31', amount, 1, '业主承诺月底缴费', '电话跟进', '月底前持续跟进', ''],
    ['', '8月执行：', '', '', '', 999999, '', '', '', '', ''],
    ['', '汇总', '已收回户数', '欠费金额', '已回款', '户数完成率', '', '问题项', '', '', ''],
    ['', '汇总', '0', '376379.89', '0.00', '0.00%', '', '', '', '', ''],
    ['', '汇总', '1', '4055568.11', '0', '0.09%', '', '', '', '', ''],
  ])
  XLSX.utils.book_append_sheet(wb, sheet('海淀片区', 'BJ-HD-1-1-101', 1000), '海淀片区')
  XLSX.utils.book_append_sheet(wb, sheet('辽宁片区', 'LN-YK-2-1-202', 2000), '辽宁片区')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

test('不可信工作簿在隔离Worker中解析并返回纯净行对象', async () => {
  const rows = await parseWorkbookRowsSandboxed(workbook([{ 资源编码: 'A1-0101', 欠费金额: 100 }]), '台账.xlsx', 100)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].资源编码, 'A1-0101')
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0], '__proto__'), false)
})

test('工作簿Worker超时后失败关闭', async () => {
  await assert.rejects(
    parseWorkbookRowsSandboxed(workbook([{ 资源编码: 'A1-0101' }]), '台账.xlsx', 100, { timeoutMs: 0 }),
    /工作簿解析超时/,
  )
})

test('华北周会多片区欠费台账合并兼容工作表并排除无房间汇总行', async () => {
  const rows = await parseWorkbookRowsSandboxed(weeklyWorkbook(), '华北地区公司【欠费控标周会】材料.xlsx', 100, { profile: 'ledger' })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((row: Record<string, unknown>) => row.房间), ['BJ-HD-1-1-101', 'LN-YK-2-1-202'])
  assert.deepEqual(rows.map((row: Record<string, unknown>) => row.合计), ['1000', '2000'])
  assert.deepEqual(rows.map((row: Record<string, unknown>) => row.__sourceSheet), ['海淀片区', '辽宁片区'])
})
