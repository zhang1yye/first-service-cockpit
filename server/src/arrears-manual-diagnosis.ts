import type { ArrearsCause } from './arrears-analysis.js'

export interface ManualArrearsDiagnosisRow {
  resourceDisplay: string
  resourceMasked: string
  amount: number | null
  periodStart: string
  periodEnd: string
  feeItems: string
  aiReason: string
  category: ArrearsCause
}

export interface ManualArrearsDiagnosisContext {
  serviceCenter: string
  businessDate: string
  communicationFilePresent: boolean
}

type DiagnosisGroupKey = 'dispute' | 'promised' | 'insufficient' | 'information'
type ActionPlan = {
  label: string
  owner: string
  firstDeadline: string
  steps: string[]
  completionStandards: string[]
  escalationTriggers: string[]
}

const GROUPS: Array<{ key: DiagnosisGroupKey; label: string; categories: ArrearsCause[]; description: string }> = [
  { key: 'dispute', label: '服务质量或沟通争议', categories: ['service_dispute', 'charge_dispute', 'legal_dispute'], description: '先分清服务、收费或法律争议，再处理无争议金额及后续催缴。' },
  { key: 'promised', label: '承诺缴费但未兑现', categories: ['promised_payment'], description: '逐户补齐承诺日期、金额和履行状态，按到期节点追踪。' },
  { key: 'insufficient', label: '欠费原因证据不足', categories: ['unknown', 'vacancy', 'financial_hardship'], description: '先完成原因访谈、空置或支付能力核验，再确定催缴节奏。' },
  { key: 'information', label: '失联或产权信息待确认', categories: ['contact_barrier', 'ownership_or_handover'], description: '先核实合法联系渠道、产权、交付或法拍状态，再进入对应催缴路径。' },
]

const ACTION_PLANS: Record<ArrearsCause, ActionPlan> = {
  service_dispute: {
    label: '服务争议闭环后催缴', owner: '项目经理＋客服经理', firstDeadline: '24小时内建档',
    steps: ['核对台账、报修单、投诉单和现场记录，列出争议事项、发生时间、责任部门和当前状态。', '24小时内由客服经理联系欠费户，只确认争议事实、诉求和可接受的复核方式，不先承诺减免。', '48小时内形成逐项处理清单，明确维修、复核、回访责任人及完成日期。', '争议事项处理后取得可追溯的回访结果；未解决项说明原因和下一节点。', '将欠费拆分为争议金额与无争议金额，先推动无争议部分缴纳；争议部分按审批结果处理。', '回访确认后约定具体缴费日期和金额，并在到期前1个工作日提醒、到期日核验、逾期次日升级。'],
    completionStandards: ['争议事项有证据、有责任人、有完成日期', '回访结果可追溯', '形成明确缴费日期与金额或正式升级记录'],
    escalationTriggers: ['争议超过7天未闭环', '涉及人身安全、重大质量、诉讼或减免审批'],
  },
  charge_dispute: {
    label: '账单核对与无争议金额催缴', owner: '收费主管＋项目经理', firstDeadline: '1个工作日内核账',
    steps: ['逐项核对应收期间、收费标准、费项、已缴金额、冲抵记录及票据状态。', '形成一页式账单说明，列明计算过程、合同或政策依据和待核实差异。', '与欠费户逐项确认争议费项；无争议部分单独列出，不等待全部争议结束。', '差异属系统或录入问题时走正式更正流程；涉及减免、折扣或分期必须进入审批，不口头承诺。', '账单说明发送后约定回复时点；48小时未回复进行一次提醒，5个工作日仍无结论升级项目经理。', '确认后锁定缴费金额、日期和支付路径，到期核验到账状态。'],
    completionStandards: ['账单勾稽一致或差异已进入正式更正', '争议与无争议金额分开确认', '缴费节点或审批节点明确'],
    escalationTriggers: ['同一账单两次核对仍不一致', '涉及大额减免、历史冲抵或合同解释争议'],
  },
  legal_dispute: {
    label: '法律路径与回款路径并行', owner: '项目经理＋法务接口人', firstDeadline: '2个工作日内核案',
    steps: ['核实是否已发律师函、立案、调解、判决或执行，并记录案号、当前节点和下一法定节点。', '整理合同、账单、催缴、服务履约和送达证据目录，只记录缺口，不补造证据。', '由法务接口人判断继续协商、调解、诉讼或执行路径，项目人员不得自行作法律结论。', '即使进入法律程序，也同步确认可协商的无争议金额、分期意愿和付款节点。', '每周更新案件进展、证据缺口和回款可能性；节点逾期立即追踪责任接口人。', '任何和解、减免或分期方案必须书面审批并形成可执行付款计划。'],
    completionStandards: ['法律状态和下一节点明确', '证据目录完整或缺口责任到人', '存在可执行回款方案或正式法律推进记录'],
    escalationTriggers: ['法定节点临近或已逾期', '金额重大、证据缺失、对方提出和解或减免'],
  },
  promised_payment: {
    label: '承诺到期追踪', owner: '责任管家＋项目经理', firstDeadline: '当天补齐承诺信息',
    steps: ['补齐承诺日期、承诺金额、支付方式、承诺来源和责任管家；缺一项即标记待核实。', '承诺日前1个工作日发送提醒，确认金额和支付路径，不重复询问已确认事项。', '承诺日当天在约定时点核验到账；未到账先确认支付障碍，不直接标记恶意拖欠。', '逾期1天再次联系并要求给出新的明确节点；只接受具体日期和金额。', '二次承诺仍未履行时，由项目经理介入，评估书面催告、分期审批或法律路径。', '每次联系只记录时间、渠道、承诺变化和下一节点，不保存与催缴无关的信息。'],
    completionStandards: ['日期、金额、责任人完整', '到账已核验或逾期原因已核实', '二次逾期已升级而非无限顺延'],
    escalationTriggers: ['承诺逾期超过1个工作日', '连续两次承诺未履行'],
  },
  vacancy: {
    label: '空置事实核验与费用说明', owner: '责任管家＋收费主管', firstDeadline: '3个工作日内核验',
    steps: ['核实空置是否仅为口头描述，并检查合法范围内的入住、装修、能耗或租售协同记录。', '说明空置与物业费义务的适用口径；如存在地方政策或合同特殊条款，交收费主管核验。', '确认当前联系人、房屋出租或出售计划及可接受的联系频率。', '如有租售需求，只提供合规协同入口，不把租售服务作为缴费交换条件。', '形成一次性账单说明和可选的正式分期申请入口，约定下次回复日期。', '到期未回复按联系障碍路径升级，不直接推断拒缴。'],
    completionStandards: ['空置状态及政策适用条件已核验', '账单义务解释已送达', '下一联系或缴费节点明确'],
    escalationTriggers: ['空置状态与现场记录冲突', '提出减免但缺少政策依据'],
  },
  financial_hardship: {
    label: '支付能力核验与受控分期', owner: '项目经理＋收费主管', firstDeadline: '2个工作日内沟通',
    steps: ['确认困难属于临时周转、长期支付能力不足或其他情况，只记录业务所需结论。', '先确认可立即缴纳的最低金额和最晚日期，不自行设定或承诺减免。', '如需分期，按公司制度收集必要材料并提交审批，明确期数、每期金额和到期日。', '审批前不得把口头方案写成已生效；审批未通过时及时告知并重新协商。', '每期到期前提醒、到期核验、逾期次日跟进；任何调整均重新审批。', '连续逾期时停止无限展期，升级项目经理评估书面催告或法律路径。'],
    completionStandards: ['支付能力类型已核实', '首付款或分期方案有正式节点', '审批及每期履行状态可追踪'],
    escalationTriggers: ['拒绝给出任何具体付款节点', '分期连续两期逾期'],
  },
  ownership_or_handover: {
    label: '产权、交付或法拍责任核清', owner: '项目经理＋法务/开发接口人', firstDeadline: '3个工作日内核验',
    steps: ['核实产权人、交付、过户、法拍或开发商责任状态及对应有效日期。', '把欠费按责任期间拆分，避免将不同主体或不同期间混为一笔。', '核对可用的合法送达地址和联系人；无权获取的信息不得通过个人关系补取。', '涉及法拍或诉讼时确认申报债权、材料提交和法院节点。', '责任边界确认后，分别向对应主体发送账单和依据，约定回复及付款节点。', '信息仍不完整时列出缺口、责任人和补齐日期，不以猜测结果继续催缴。'],
    completionStandards: ['责任主体和责任期间明确', '送达或法院节点有记录', '账单已按责任边界拆分'],
    escalationTriggers: ['产权主体冲突', '法拍、执行或债权申报期限临近'],
  },
  contact_barrier: {
    label: '合法联系渠道恢复', owner: '责任管家＋项目经理', firstDeadline: '2个工作日内完成首轮',
    steps: ['核对现有电话、企微、书面地址等渠道的最近有效记录，区分未接、拒接、空号和明确失联。', '在合理时段分渠道完成首轮联系，控制频次并记录时间、渠道和结果。', '通过已有合法业务关系核验备用联系方式；不得使用未经授权的个人数据或跨项目查询。', '电子渠道无效时按制度采用书面通知或现场送达，并保留送达证据。', '恢复联系后先核实欠费原因，再转入争议、承诺、困难或普通催缴路径。', '多渠道仍无结果时由项目经理决定是否进入律师函或法律评估。'],
    completionStandards: ['每个合法渠道的状态已区分', '送达证据完整', '恢复联系后已转入明确原因路径'],
    escalationTriggers: ['连续两个联系周期均无有效回应', '联系方式疑似错误或主体已变更'],
  },
  unknown: {
    label: '原因补证后再催缴', owner: '责任管家＋项目经理', firstDeadline: '3个工作日内补证',
    steps: ['核对房间、金额、费项和欠费期间，先排除台账缺列、错行或已回款未更新。', '使用统一访谈提纲确认：是否有服务争议、收费争议、支付困难、空置、产权问题、联系障碍或付款承诺。', '每个判断必须对应台账、工单、账单或沟通证据；无法确认的继续标记待核实。', '原因确认后立即转入对应动作模板，并补齐责任人、首次动作和完成日期。', '原因未确认前只做事实核对和合规提醒，不承诺减免、不贴恶意欠费标签。', '超过补证时限仍无结论，由项目经理复核数据质量和联系渠道。'],
    completionStandards: ['原因已确认或明确记录为无法确认', '证据引用完整', '已转入对应催缴路径或形成升级记录'],
    escalationTriggers: ['3个工作日仍无可用原因证据', '台账与到账、工单或项目归属冲突'],
  },
}

const ACTIONS = [
  { priority: 'P0', title: '逐户建立催费作战卡', detail: '每户必须具备房间、金额、账期、原因类别、责任人、首次动作、完成时间和升级条件。', role: '项目经理', due: '24小时内' },
  { priority: 'P0', title: '先处理争议与数据冲突', detail: '争议事项逐项闭环；账单、到账或产权冲突未核清前不得用统一话术强催。', role: '客服/收费', due: '3个工作日' },
  { priority: 'P1', title: '按承诺节点日清日结', detail: '承诺日前提醒、到期核验、逾期次日升级，禁止没有日期和金额的无限顺延。', role: '管家团队', due: '每日复核' },
  { priority: 'P1', title: '按升级条件转管理路径', detail: '服务、收费、分期、产权和法律事项分别进入对应审批或专业路径。', role: '项目经理', due: '触发即升级' },
]

function rounded(value: number): number { return Math.round((value + Number.EPSILON) * 100) / 100 }
function groupFor(category: ArrearsCause): DiagnosisGroupKey { return GROUPS.find(group => group.categories.includes(category))?.key || 'insufficient' }

export function buildManualArrearsDiagnosis(rows: ManualArrearsDiagnosisRow[], context: ManualArrearsDiagnosisContext): any {
  const normalized = rows.map(row => ({ ...row, room: row.resourceDisplay || row.resourceMasked, amount: Number.isFinite(Number(row.amount)) ? Math.max(0, Number(row.amount)) : 0, group: groupFor(row.category), actionPlan: ACTION_PLANS[row.category] || ACTION_PLANS.unknown }))
  const totalAmount = rounded(normalized.reduce((sum, row) => sum + row.amount, 0))
  const reasons = GROUPS.map(definition => {
    const matched = normalized.filter(row => row.group === definition.key).sort((left, right) => right.amount - left.amount || left.room.localeCompare(right.room, 'zh-CN'))
    return {
      key: definition.key, label: definition.label, householdCount: matched.length,
      amount: rounded(matched.reduce((sum, row) => sum + row.amount, 0)), description: definition.description,
      owners: matched.slice(0, 3).map(row => row.room), remainingCount: Math.max(0, matched.length - 3),
      households: matched.map(row => ({ room: row.room, amount: rounded(row.amount), category: row.category, periodStart: row.periodStart || '', periodEnd: row.periodEnd || '', feeItems: row.feeItems ? row.feeItems.split(',').filter(Boolean) : [], aiReason: row.aiReason || '', actionPlan: row.actionPlan })),
    }
  })
  const rankedGroups = [...reasons].sort((left, right) => right.amount - left.amount || right.householdCount - left.householdCount)
  const leading = rankedGroups.filter(item => item.householdCount > 0).slice(0, 2).map(item => item.label)
  const overallJudgment = leading.length ? `${context.serviceCenter}当前欠费金额主要集中在${leading.join('、')}。应按房间建立作战卡，先核清原因和争议，再按承诺节点、完成标准和升级条件推进。` : `${context.serviceCenter}当前上传台账没有可用于原因归类的有效欠费记录。`
  const priorityHouseholds = normalized.slice().sort((left, right) => right.amount - left.amount || left.room.localeCompare(right.room, 'zh-CN')).slice(0, 10).map(row => ({ room: row.room, amount: rounded(row.amount), reason: row.actionPlan.label, tags: [GROUPS.find(group => group.key === row.group)?.label || '待核实', row.actionPlan.firstDeadline] }))
  const analysisBasis = context.communicationFilePresent ? '欠费金额、账龄和房间信息以本次上传的欠费台账为准。聊天记录仅作为辅助证据，不覆盖台账事实。' : '欠费金额、账龄和房间信息以本次上传的欠费台账为准。本次未提供聊天记录，仅依据欠费台账进行分析。'
  return {
    ready: true, serviceCenter: context.serviceCenter, businessDate: context.businessDate, generatedAt: new Date().toISOString(), analysisBasis,
    summary: { householdCount: normalized.length, totalAmount }, overallJudgment, reasons,
    reasonableJudgment: '每户催费必须形成“事实核对—原因确认—首次动作—节点追踪—完成验收—触发升级”的闭环；系统建议不替代减免、分期或法律审批。',
    truthLayers: [
      { key: 'facts', label: '已知事实', detail: '上传台账中的房间、金额、账期和费项' },
      { key: 'judgement', label: '合理判断', detail: '基于受控原因信号匹配的逐户催费路径，仍需责任人确认' },
      { key: 'verify', label: '待核实', detail: '争议、承诺、产权、联系方式和审批状态不得自行补造' },
    ],
    actions: ACTIONS, causeStructure: reasons.map(item => ({ key: item.key, label: item.label, householdCount: item.householdCount })), priorityHouseholds,
  }
}
