import assert from 'node:assert/strict'
import test from 'node:test'
import * as XLSX from 'xlsx'
import { parseWorkbookRowsSandboxed } from '../dist/arrears-workbook-parser.js'

function workbook(rows: Record<string, unknown>[]) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '台账')
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
