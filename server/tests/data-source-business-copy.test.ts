import test from 'node:test'
import assert from 'node:assert/strict'
import { projectOperatingSourceCopy } from '../src/data-source-copy.js'

test('数据源文案明确项目经营指标当前不接入', () => {
  const copy = projectOperatingSourceCopy(0)
  assert.equal(copy.detail, '项目经营数据源当前不接入')
  assert.match(copy.suggestion, /APH回款、绿仔正式收缴和权威项目目录/)
  assert.doesNotMatch(`${copy.detail}${copy.suggestion}`, /P46|中转箱|SHA/)
  assert.match(copy.operatorAction, /无需补录成本、利润率、品质、安全、满意度/)
  assert.match(copy.operatorAction, /不得恢复演示项目/)
})

test('发现历史项目经营记录时仍不启用', () => {
  const copy = projectOperatingSourceCopy(42)
  assert.match(copy.detail, /42条/)
  assert.match(copy.detail, /当前系统不启用/)
  assert.match(copy.operatorAction, /不得将历史项目经营记录用于页面、AI、月报、归档或导出/)
  assert.doesNotMatch(`${copy.detail}${copy.suggestion}`, /P46|中转箱|SHA/)
})
