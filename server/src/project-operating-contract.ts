import { createHash } from 'node:crypto'

export const PROJECT_OPERATING_SCHEMA_VERSION = 1

export const REQUIRED_PROJECT_FACT_FIELDS = Object.freeze([
  'annual_income', 'annual_cost', 'ytd_income', 'ytd_cost',
  'receivable', 'received', 'quality_score', 'safety_incidents',
  'customer_satisfaction', 'complaint_count',
] as const)

export type ProjectFactField = typeof REQUIRED_PROJECT_FACT_FIELDS[number]

export type ProjectOperatingRow = {
  projectCode: string
  projectName: string
  serviceCenter: string
  area: string
  businessPeriod: string
  activeStatus: 'active' | 'inactive'
  facts: Record<ProjectFactField, unknown>
  fieldProvenance: Record<ProjectFactField, {
    sourceSystem: string
    sourceFile: string
    sourceField: string
  }>
}

export type ProjectOperatingBundle = {
  schemaVersion: number
  businessDate: string
  extractedAt: string
  sourceBatch: string
  sourceSha256: string
  amountUnit: '万元'
  rows: ProjectOperatingRow[]
}

export type ProjectOperatingValidation = {
  valid: boolean
  status: 'ready' | 'blocked'
  rowCount: number
  batchSha256: string | null
  errors: string[]
  warnings: string[]
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

function isDate(value: unknown): boolean {
  const raw = text(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false
  return !Number.isNaN(Date.parse(`${raw}T00:00:00Z`))
}

function isTimestamp(value: unknown): boolean {
  return Boolean(text(value)) && !Number.isNaN(Date.parse(text(value)))
}

function isSha256(value: unknown): boolean {
  return /^[a-f0-9]{64}$/i.test(text(value))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function calculateProjectOperatingBundleSha256(bundle: unknown): string {
  const copy = { ...(bundle as Record<string, unknown>), sourceSha256: '' }
  return createHash('sha256').update(stableJson(copy)).digest('hex')
}

/**
 * 校验项目经营事实导入包。这里仅判断能否进入受控预览，不能据此直接发布正式数据。
 * 空值、字符串数字、比例分摊结果和缺失字段级血缘都会被拒绝，避免把未知值伪装成零。
 */
export function validateProjectOperatingBundle(input: unknown): ProjectOperatingValidation {
  const bundle = input as Partial<ProjectOperatingBundle> | null
  const errors: string[] = []
  const warnings: string[] = []
  const rows = Array.isArray(bundle?.rows) ? bundle.rows : []

  if (bundle?.schemaVersion !== PROJECT_OPERATING_SCHEMA_VERSION) errors.push(`schemaVersion必须为${PROJECT_OPERATING_SCHEMA_VERSION}`)
  if (!isDate(bundle?.businessDate)) errors.push('businessDate必须为有效的YYYY-MM-DD日期')
  if (!isTimestamp(bundle?.extractedAt)) errors.push('extractedAt必须为有效时间戳')
  if (!text(bundle?.sourceBatch)) errors.push('sourceBatch不能为空')
  if (bundle?.amountUnit !== '万元') errors.push('amountUnit必须明确为万元')
  if (!isSha256(bundle?.sourceSha256)) errors.push('sourceSha256必须为64位SHA-256')
  if (!rows.length) errors.push('rows不能为空')

  const computedSha = bundle && typeof bundle === 'object' ? calculateProjectOperatingBundleSha256(bundle) : null
  if (computedSha && isSha256(bundle?.sourceSha256) && computedSha !== text(bundle?.sourceSha256).toLowerCase()) {
    errors.push('sourceSha256与导入包内容不一致')
  }

  const uniqueKeys = new Set<string>()
  rows.forEach((row: any, index) => {
    const label = `第${index + 1}行`
    const projectCode = text(row?.projectCode)
    const businessPeriod = text(row?.businessPeriod)
    if (!projectCode) errors.push(`${label}缺少projectCode`)
    if (!text(row?.projectName)) errors.push(`${label}缺少projectName`)
    if (!text(row?.serviceCenter)) errors.push(`${label}缺少serviceCenter`)
    if (!text(row?.area)) errors.push(`${label}缺少area`)
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(businessPeriod)) errors.push(`${label}businessPeriod必须为YYYY-MM`)
    if (row?.activeStatus !== 'active') errors.push(`${label}不是活动项目`)

    const uniqueKey = `${projectCode}:${businessPeriod}`
    if (projectCode && businessPeriod && uniqueKeys.has(uniqueKey)) errors.push(`${label}项目期间键重复：${uniqueKey}`)
    uniqueKeys.add(uniqueKey)

    for (const field of REQUIRED_PROJECT_FACT_FIELDS) {
      const value = row?.facts?.[field]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${label}.${field}必须是直接来源的有限数值，不允许空值或字符串数字`)
        continue
      }
      if (value < 0) errors.push(`${label}.${field}不能为负数`)
      const provenance = row?.fieldProvenance?.[field]
      if (!text(provenance?.sourceSystem) || !text(provenance?.sourceFile) || !text(provenance?.sourceField)) {
        errors.push(`${label}.${field}缺少完整字段级血缘`)
      }
    }

    if (Number(row?.facts?.quality_score) > 100) errors.push(`${label}.quality_score不能超过100`)
    if (Number(row?.facts?.customer_satisfaction) > 100) errors.push(`${label}.customer_satisfaction不能超过100`)
    if (!Number.isInteger(row?.facts?.safety_incidents)) errors.push(`${label}.safety_incidents必须为整数`)
    if (!Number.isInteger(row?.facts?.complaint_count)) errors.push(`${label}.complaint_count必须为整数`)
    if (Number(row?.facts?.received) > Number(row?.facts?.receivable)) warnings.push(`${label}实收大于应收，需业务复核`)
    if (Number(row?.facts?.ytd_cost) > Number(row?.facts?.ytd_income)) warnings.push(`${label}累计成本大于累计收入，需业务复核`)
  })

  return {
    valid: errors.length === 0,
    status: errors.length === 0 ? 'ready' : 'blocked',
    rowCount: rows.length,
    batchSha256: computedSha,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
  }
}
