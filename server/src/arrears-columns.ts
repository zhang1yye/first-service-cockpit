export const ARREARS_COLUMN_ALIASES = {
  resource: ['资源编码', '资源编号', '资源号', '资源ID', '房屋编码', '房屋编号', '房产编码', '房产编号', '房间编码', '房间编号', '房间', '收费资源编码', '客户资源编码', '房产', '客户备注', '房屋备注'],
  building: ['楼栋', '楼号', '栋号', '楼栋名称'],
  unit: ['单元', '单元号', '单元名称'],
  room: ['房号', '房间号', '室号', '房屋号', '房间名称'],
  customer: ['客户姓名', '业主姓名', '姓名', '客户名称', '业主名称', '住户姓名'],
  phone: ['手机号', '手机号码', '联系电话', '电话', '联系电话号码', '客户电话', '业主电话'],
  amount: ['欠费金额', '欠费金额元', '未收金额', '未缴金额', '应收未收', '应收欠费', '欠款金额', '欠缴金额', '欠费余额', '欠收金额', '应收余额', '欠费合计', '欠费总额', '合计'],
  feeItem: ['费项', '收费项目', '收费项目名称', '费用项目', '欠费项目', '费种', '费用类型', '应收项目'],
  periodStart: ['欠费起始月', '起始月份', '欠费开始时间', '欠费开始日期', '欠费起始日期', '欠费起始时间', '费用开始日期', '开始账期', '起始账期', '应收开始月份'],
  periodEnd: ['欠费截止月', '截止月份', '欠费截止时间', '欠费截止日期', '费用结束日期', '结束账期', '截止账期', '应收截止月份'],
  ageing: ['账龄天数', '欠费天数', '逾期天数', '欠费账龄', '账龄', '超期天数'],
  status: ['当前状态', '资源状态', '欠费状态', '缴费状态', '应收状态'],
  occurredAt: ['沟通时间', '跟进时间', '记录时间', '联系时间', '回访时间', '催缴时间', '发生时间', '沟通日期', '跟进日期', '记录日期'],
  channel: ['沟通方式', '跟进方式', '渠道', '联系方式', '联系渠道', '沟通渠道', '催缴方式'],
  actor: ['沟通人', '跟进人', '员工姓名', '经办人', '记录人', '催缴人', '沟通人员'],
  content: ['沟通记录', '跟进记录', '沟通内容', '记录内容', '跟进内容', '催缴记录', '催收记录', '回访记录', '沟通摘要', '最新跟进内容', '处理记录', '备注'],
} as const

export type ArrearsColumnKey = keyof typeof ARREARS_COLUMN_ALIASES
export type ArrearsWorkbookProfile = 'ledger' | 'communications'

const aliasSets = new Map<ArrearsColumnKey, Set<string>>()

export function normalizeArrearsHeader(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\([^)]{0,40}\)/g, '')
    .replace(/[\s\r\n\t:：/\\_\-—·,.，。]+/g, '')
}

export function normalizedAliases(key: ArrearsColumnKey): Set<string> {
  const existing = aliasSets.get(key)
  if (existing) return existing
  const created = new Set(ARREARS_COLUMN_ALIASES[key].map(normalizeArrearsHeader).filter(Boolean))
  aliasSets.set(key, created)
  return created
}

export function matchArrearsColumn(value: unknown): ArrearsColumnKey | null {
  const normalized = normalizeArrearsHeader(value)
  if (!normalized) return null
  for (const key of Object.keys(ARREARS_COLUMN_ALIASES) as ArrearsColumnKey[]) {
    if (normalizedAliases(key).has(normalized)) return key
  }
  return null
}

export const LEDGER_SIGNAL_COLUMNS: readonly ArrearsColumnKey[] = ['amount', 'feeItem', 'periodStart', 'periodEnd', 'ageing', 'status']
export const COMMUNICATION_SIGNAL_COLUMNS: readonly ArrearsColumnKey[] = ['content', 'occurredAt', 'channel', 'actor']
