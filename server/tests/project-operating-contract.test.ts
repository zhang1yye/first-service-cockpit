import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateProjectOperatingBundleSha256,
  REQUIRED_PROJECT_FACT_FIELDS,
  validateProjectOperatingBundle,
} from '../src/project-operating-contract.js'

function validBundle() {
  const facts = Object.fromEntries(REQUIRED_PROJECT_FACT_FIELDS.map(field => [field, 1]))
  const fieldProvenance = Object.fromEntries(REQUIRED_PROJECT_FACT_FIELDS.map(field => [field, {
    sourceSystem: 'APH', sourceFile: '项目经营台账.xlsx', sourceField: field,
  }]))
  const bundle: any = {
    schemaVersion: 1,
    businessDate: '2026-08-13',
    extractedAt: '2026-08-13T10:00:00+08:00',
    sourceBatch: 'APH-PROJECT-20260813',
    sourceSha256: '',
    amountUnit: '万元',
    rows: [{
      projectCode: 'HB-REAL-001', projectName: '真实项目', serviceCenter: '真实服务中心',
      area: '北京片区', businessPeriod: '2026-08', activeStatus: 'active', facts, fieldProvenance,
    }],
  }
  bundle.sourceSha256 = calculateProjectOperatingBundleSha256(bundle)
  return bundle
}

test('完整事实和字段血缘可进入受控预览，但不代表已发布', () => {
  const result = validateProjectOperatingBundle(validBundle())
  assert.equal(result.valid, true)
  assert.equal(result.status, 'ready')
  assert.equal(result.errors.length, 0)
})

test('缺失经营事实不能用空值或字符串数字绕过', () => {
  const bundle = validBundle()
  bundle.rows[0].facts.annual_income = null
  bundle.rows[0].facts.annual_cost = '100'
  bundle.sourceSha256 = calculateProjectOperatingBundleSha256(bundle)
  const result = validateProjectOperatingBundle(bundle)
  assert.equal(result.valid, false)
  assert.match(result.errors.join('；'), /annual_income.*有限数值/)
  assert.match(result.errors.join('；'), /annual_cost.*有限数值/)
})

test('缺少字段血缘、重复项目期间或内容哈希不一致均阻断', () => {
  const bundle = validBundle()
  delete bundle.rows[0].fieldProvenance.quality_score
  bundle.rows.push(structuredClone(bundle.rows[0]))
  const result = validateProjectOperatingBundle(bundle)
  assert.equal(result.valid, false)
  assert.match(result.errors.join('；'), /quality_score缺少完整字段级血缘/)
  assert.match(result.errors.join('；'), /项目期间键重复/)
  assert.match(result.errors.join('；'), /sourceSha256与导入包内容不一致/)
})
