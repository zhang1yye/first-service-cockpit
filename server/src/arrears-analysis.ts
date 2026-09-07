import crypto from 'node:crypto'
import { ARREARS_COLUMN_ALIASES, normalizeArrearsHeader } from './arrears-columns.js'

export const ARREARS_CAUSES = ['service_dispute','charge_dispute','vacancy','financial_hardship','ownership_or_handover','contact_barrier','promised_payment','legal_dispute','unknown'] as const
export type ArrearsCause = typeof ARREARS_CAUSES[number]

export type LedgerRow = {
  sourceRow: number; ref: string; resourceCanonical: string; resourceHash: string; resourceDisplay: string; resourceMasked: string
  customerMasked: string; phoneMasked: string; arrearsAmount: number | null; feeItem: string
  periodStart: string; periodEnd: string; ageingDays: number | null; status: string; rawEvidence: Record<string, unknown>
}
export type CommunicationRow = {
  sourceRow: number; ref: string; resourceCanonical: string; resourceHash: string; resourceMasked: string
  occurredAt: string; channel: string; actor: string; contentMasked: string
}

const ALIASES = ARREARS_COLUMN_ALIASES

function text(value: unknown): string { return value === null || value === undefined ? '' : String(value).trim() }
const normalizedRowKeys = new WeakMap<Record<string, unknown>, Map<string, string>>()
function pick(row: Record<string, unknown>, aliases: readonly string[]): string {
  for (const alias of aliases) if (Object.prototype.hasOwnProperty.call(row, alias) && text(row[alias])) return text(row[alias])
  let keys = normalizedRowKeys.get(row)
  if (!keys) {
    keys = new Map<string, string>()
    for (const key of Object.keys(row)) {
      const normalized = normalizeArrearsHeader(key)
      if (normalized) keys.set(normalized, key)
    }
    normalizedRowKeys.set(row, keys)
  }
  for (const alias of aliases) {
    const key = keys.get(normalizeArrearsHeader(alias))
    if (key && text(row[key])) return text(row[key])
  }
  return ''
}
function bounded(value: string, max: number): string { return value.slice(0, max) }
function canonicalPart(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase() }

type NormalizedResourceKey = { canonical: string; display: string; rawIdentity: string }
export type ArrearsResourceResolver = {
  matches: Map<string, { canonical: string; display: string }>
  ambiguous: Set<string>
}

function normalizedHouseParts(value: string): string[] | null {
  const normalized = value.normalize('NFKC').trim().toUpperCase()
    .replace(/号楼|楼|栋/g, '-')
    .replace(/单元/g, '-')
    .replace(/室$|房$/g, '')
    .replace(/#/g, '')
    .replace(/[－—–_/\\]+/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const parts = normalized.split('-').map(part => part.trim().replace(/^(\d+)\.0$/, '$1')).filter(Boolean)
  if (parts.length === 5 && /^[A-Z]{2,3}$/.test(parts[0]) && /^[A-Z0-9]+$/.test(parts[1]) && parts.slice(2).every(part => /^[A-Z0-9\u3400-\u9FFF]+$/.test(part))) return parts
  if (parts.length === 3 && parts.every(part => /^[A-Z0-9]+$/.test(part))) return parts
  return null
}

function houseKey(parts: string[]): string {
  return `${parts.length === 5 ? 'H' : 'S'}:${JSON.stringify(parts)}`
}

function shortHouseKey(canonical: string): string | null {
  if (canonical.startsWith('S:')) return canonical
  if (!canonical.startsWith('H:')) return null
  try {
    const parts = JSON.parse(canonical.slice(2))
    return Array.isArray(parts) && parts.length === 5 ? houseKey(parts.slice(2).map(String)) : null
  } catch { return null }
}

export function normalizeResourceKey(row: Record<string, unknown>): NormalizedResourceKey | null {
  const explicit = pick(row, ALIASES.resource)
  if (explicit) {
    const houseParts = normalizedHouseParts(explicit)
    if (houseParts) {
      const canonical = houseKey(houseParts)
      return { canonical, display: houseParts.join('-'), rawIdentity: canonical }
    }
    const normalized = canonicalPart(explicit)
    return normalized ? { canonical: `E:${JSON.stringify(normalized)}`, display: explicit, rawIdentity: `E:${JSON.stringify([normalized])}` } : null
  }
  const building = pick(row, ALIASES.building), unit = pick(row, ALIASES.unit), room = pick(row, ALIASES.room)
  if (!building || !unit || !room) return null
  const parts = [building, unit, room].map(canonicalPart)
  const canonical = houseKey(parts)
  return { canonical, display: parts.join('-'), rawIdentity: canonical }
}

export function buildLedgerResourceResolver(rows: LedgerRow[]): ArrearsResourceResolver {
  const candidates = new Map<string, Map<string, string>>()
  for (const row of rows) {
    const shortKey = shortHouseKey(row.resourceCanonical)
    if (!shortKey) continue
    const values = candidates.get(shortKey) || new Map<string, string>()
    values.set(row.resourceCanonical, row.resourceMasked)
    candidates.set(shortKey, values)
  }
  const matches = new Map<string, { canonical: string; display: string }>()
  const ambiguous = new Set<string>()
  for (const [shortKey, values] of candidates) {
    if (values.size !== 1) { ambiguous.add(shortKey); continue }
    const [canonical, display] = [...values.entries()][0]
    matches.set(shortKey, { canonical, display })
  }
  return { matches, ambiguous }
}
function resourceHash(value: string): string {
  const secret = process.env.ARREARS_RESOURCE_HASH_KEY || 'local-development-only-arrears-hash-key'
  return crypto.createHmac('sha256', secret).update(value).digest('hex')
}
function maskResource(value: string): string { return !value ? '' : value.length <= 4 ? `${value.slice(0,1)}***` : `${value.slice(0,2)}***${value.slice(-2)}` }
function maskName(value: string): string { return !value ? '' : value.length === 1 ? '*' : `${value.slice(0,1)}${'*'.repeat(Math.min(2,value.length-1))}` }
function maskPhone(value: string): string { const digits=value.replace(/\D/g,''); return digits.length===11?`${digits.slice(0,3)}****${digits.slice(-4)}`:digits?'号码已脱敏':'' }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') }

export function extractSensitiveTerms(rows: Array<Record<string, unknown>>): string[] {
  const values = new Set<string>()
  for (const row of rows) {
    const key=normalizeResourceKey(row),terms=[pick(row,ALIASES.resource),pick(row,ALIASES.customer),pick(row,ALIASES.phone)]
    const parts=[pick(row,ALIASES.building),pick(row,ALIASES.unit),pick(row,ALIASES.room)].filter(Boolean);if(parts.length===3)terms.push(parts.join('-'))
    for(const value of terms)if(value.length>=2)values.add(key?`${key.canonical}\u0000${value}`:value)
  }
  return [...values].sort((a,b)=>b.length-a.length)
}
export function maskSensitiveText(value: string, sensitiveTerms: string[] = []): string {
  let output=text(value)
  for (const term of sensitiveTerms.map(text).filter(term=>term.length>=2).sort((a,b)=>b.length-a.length)) {
    const placeholder = /^1[3-9]\d{9}$/.test(term) ? '[手机号已脱敏]' : /[-—]?\d+(?:[-—]\d+){1,}/.test(term) ? '[资源已脱敏]' : '[身份已脱敏]'
    output=output.replace(new RegExp(escapeRegExp(term),'gi'),placeholder)
  }
  return output
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g,'[手机号已脱敏]')
    .replace(/(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)/g,'[座机已脱敏]')
    .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g,'[身份证已脱敏]')
    .replace(/(?<!\d)\d{16,19}(?!\d)/g,'[银行卡已脱敏]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[邮箱已脱敏]')
    .replace(/(?:微信|企微|微信号|企微号)[：:\s]*[A-Za-z][-_A-Za-z0-9]{5,19}/gi,'账号已脱敏')
    .replace(/[^，。；;\n]{2,36}(?:省|市|区|县|镇|街道|小区|大厦|楼|栋|单元|室)(?=[，。；;\s]|$)/g,'[地址已脱敏]')
    .replace(/(?:客户|业主|联系人)[：:\s]+[\u4e00-\u9fff·]{2,8}/g,'[主体]')
    .replace(/[\u4e00-\u9fff·]{2,4}(?=(?:先生|女士|表示|称|代缴|转告))/g,'[人员]')
}

// 无本地NER时，对自由文本中无法由台账/沟通人词典确定的人名语境失败关闭，避免把潜在身份信息发送到云端。
const UNSAFE_FREE_NAME_PATTERNS:RegExp[]=[
  /(?:发给|交给|转给|建议联系|通知|找|同|与)[\u4e00-\u9fff·]{2,4}(?=[，。；;、\s]|$|电话确认|核对账|沟通确认|等待回复)/,
  /(?:业主|客户|联系人)[\u4e00-\u9fff·]{2,4}(?=要求|表示|反馈|称|承诺|拒绝|申请)/,
]
function hasUnsafeFreeName(value:string):boolean{return UNSAFE_FREE_NAME_PATTERNS.some(pattern=>pattern.test(value))}
const CLOUD_SIGNAL_RULES: Array<[string,RegExp]> = [
  ['法律争议',/法律争议|诉讼|起诉|立案|仲裁|律师|法院|法律纠纷/],
  ['服务争议',/服务争议|服务(差|不到位|问题)|维修|漏水|渗水|湿度|温度不达标|新风|梯控|门岗|门禁|绿化|车位被占|报修|故障|停运|整改|投诉|不满意|卫生|秩序|品质|要求(?:物业|服务中心)赔偿/],
  ['收费争议',/收费争议|账单|金额|计费|收费标准|公共收益|减免|不应收|不认可.*(?:物业费|管理费)|费用(有误|不认可|争议)|拒(?:绝)?(?:缴费|交费)|拒缴/],
  ['房屋空置',/房屋空置|空置|未入住|无人居住|没人住|房屋无人/],
  ['支付困难',/支付困难|困难|失业|没钱|资金(?:紧张|短缺)|周转(?:困难|不开|有问题)|负债|倒闭|经营不善|经济压力|申请分期/],
  ['产权交付',/产权交付|未收房|未交付|未办入住|产权|过户|开发商|法拍|拍卖/],
  ['联系障碍',/联系障碍|联系不上|无人接听|未接通|电话不接|企微不回|拒接|拉黑|关机|空号|停机|失联/],
  ['承诺缴费',/承诺缴费|承诺.*(?:缴|付|转)|答应.*(?:缴|付|转)|(?:月底|年底|下月|近期|过段时间).*?(?:缴|交|付|结清)|\d{1,2}月\d{1,2}(?:日|号)?(?:左右)?(?:缴|交|付|结清)|尽快(?:缴|交|付|结清)|表示.*?(?:会|准备).*?(?:缴|交|付|结清)/],
]
const NEGATED_SIGNAL_RULES:RegExp[]=[/不(?:属于|存在)(?:服务|收费|法律|产权|联系|支付|空置|承诺)?(?:问题|争议|困难|障碍)?|并非(?:服务|收费|法律|产权|联系|支付|空置|承诺)|从未承诺|没有欠费原因|无(?:特殊)?原因|无(?:空置|困难|争议)/]
export function summarizeCommunicationForCloud(value: string): string {
  const labels=CLOUD_SIGNAL_RULES.filter(([,pattern])=>pattern.test(text(value))).map(([label])=>label)
  if(!labels.length&&NEGATED_SIGNAL_RULES.some(pattern=>pattern.test(text(value))))return'本地信号存在冲突或否定语境，必须人工核验'
  return labels.length?`本地规则信号：${[...new Set(labels)].join('、')}`:'本地未提取到可确认的原因信号'
}
function normalizeOccurredAt(value:string):string{
  const raw=text(value);if(!raw)return''
  const match=raw.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/)
  if(!match)return''
  const y=Number(match[1]),m=Number(match[2]),d=Number(match[3]),date=new Date(Date.UTC(y,m-1,d))
  return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d?`${match[1]}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`:''
}
function normalizeChannel(value:string):string{
  const raw=text(value)
  if(/企微|企业微信|企小码/.test(raw))return'企业微信'
  if(/微信/.test(raw))return'微信'
  if(/电话|手机|座机/.test(raw))return'电话'
  if(/上门|面访|拜访/.test(raw))return'现场沟通'
  if(/短信/.test(raw))return'短信'
  if(/邮件|邮箱/.test(raw))return'邮件'
  return raw?'其他':'未提供'
}

export function findResidualSensitivePatterns(value: string): string[] {
  const checks: Array<[string,RegExp]> = [['手机号',/(?<!\d)1[3-9]\d{9}(?!\d)/],['座机',/(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)/],['身份证',/(?<!\d)\d{17}[\dXx](?!\d)/],['银行卡',/(?<!\d)\d{16,19}(?!\d)/],['邮箱',/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],['账号',/(?:微信|企微|微信号|企微号)[：:\s]*[A-Za-z][-_A-Za-z0-9]{5,19}/i],['地址',/[^，。；;\n]{2,36}(?:省|市|区|县|镇|街道|小区|大厦|楼|栋|单元|室)(?=[，。；;\s]|$)/],['人物',/(?:客户|业主|联系人)[：:\s]+[\u4e00-\u9fff·]{2,8}|[\u4e00-\u9fff·]{2,4}(?=(?:先生|女士|表示|称|代缴|转告))/]]
  return checks.filter(([,pattern])=>pattern.test(value)).map(([label])=>label)
}

function normalizeFeeItem(value:string):string{const raw=text(value);if(/物业/.test(raw))return'物业服务费';if(/车位|停车/.test(raw))return'车位服务费';if(/能源|能耗|水费|电费|供暖/.test(raw))return'能源及代收费用';if(/装修|垃圾清运/.test(raw))return'装修相关费用';return raw?'其他收费项':'未提供'}
function normalizeLedgerStatus(value:string):string{const raw=text(value);if(/争议|异议/.test(raw))return'争议中';if(/承诺|答应/.test(raw))return'已承诺缴费';if(/欠费|未缴|逾期/.test(raw))return'欠费中';return raw?'其他状态':'未提供'}

type ParsedNumber={ missing:boolean; valid:boolean; value:number|null; reason?:string }
function parseBusinessNumber(rawValue:string, options:{ integer?:boolean; max?:number; decimals?:number }={}):ParsedNumber{
  const normalized=rawValue.replace(/[,，￥¥元\s]/g,'')
  if(!normalized)return{missing:true,valid:true,value:null}
  if(!/^-?\d+(?:\.\d+)?$/.test(normalized))return{missing:false,valid:false,value:null,reason:'不是有效数字'}
  const value=Number(normalized);if(!Number.isFinite(value))return{missing:false,valid:false,value:null,reason:'超出数字范围'}
  if(value<0)return{missing:false,valid:false,value:null,reason:'不能为负数'}
  if(options.integer&&!Number.isInteger(value))return{missing:false,valid:false,value:null,reason:'必须为整数'}
  if(options.max!==undefined&&value>options.max)return{missing:false,valid:false,value:null,reason:'超过允许上限'}
  const decimals=(normalized.split('.')[1]||'').length;if(options.decimals!==undefined&&decimals>options.decimals)return{missing:false,valid:false,value:null,reason:`最多${options.decimals}位小数`}
  return{missing:false,valid:true,value}
}
function validPeriod(value:string):boolean{return !value||/^\d{4}-(0?[1-9]|1[0-2])(?:-(0?[1-9]|[12]\d|3[01]))?$/.test(value)}

export function mapLedgerRows(input:Array<Record<string,unknown>>){
  const rows:LedgerRow[]=[];const errors:string[]=[];const warnings:string[]=[];const canonicalRaw=new Map<string,Set<string>>()
  input.forEach((raw,index)=>{
    if(/^(?:是|已回款|已缴|已结清)$/.test(pick(raw,['是否回款'])))return
    const sourceRow=Number(raw.__sourceRow)||index+2,recognizedKey=normalizeResourceKey(raw)
    const key=recognizedKey||{canonical:`ROW:${sourceRow}`,display:`第${sourceRow}行`,rawIdentity:`ROW:${sourceRow}`}
    if(!recognizedKey)warnings.push(`L-${sourceRow}：未识别资源编号，已按文件行建立临时分析项`)
    const amount=parseBusinessNumber(pick(raw,ALIASES.amount),{max:999999999.99,decimals:2})
    const ageing=parseBusinessNumber(pick(raw,ALIASES.ageing),{integer:true,max:36500})
    if(!amount.valid)errors.push(`L-${sourceRow}：欠费金额${amount.reason}`)
    if(!ageing.valid)errors.push(`L-${sourceRow}：账龄天数${ageing.reason}`)
    const periodStart=pick(raw,ALIASES.periodStart),periodEnd=pick(raw,ALIASES.periodEnd)
    if(!validPeriod(periodStart)||!validPeriod(periodEnd))errors.push(`L-${sourceRow}：欠费期间必须为YYYY-MM或YYYY-MM-DD`)
    if(periodStart&&periodEnd&&periodStart.slice(0,7)>periodEnd.slice(0,7))errors.push(`L-${sourceRow}：欠费起始月不能晚于截止月`)
    const customer=bounded(pick(raw,ALIASES.customer),80),phone=bounded(pick(raw,ALIASES.phone),40)
    const identities=canonicalRaw.get(key.canonical)||new Set<string>();identities.add(key.rawIdentity);canonicalRaw.set(key.canonical,identities)
    const feeItem=normalizeFeeItem(pick(raw,ALIASES.feeItem)),status=normalizeLedgerStatus(pick(raw,ALIASES.status))
    rows.push({sourceRow,ref:`L-${sourceRow}`,resourceCanonical:key.canonical,resourceHash:resourceHash(key.canonical),resourceDisplay:bounded(key.display,160),resourceMasked:maskResource(key.display),customerMasked:maskName(customer),phoneMasked:maskPhone(phone),arrearsAmount:amount.valid?amount.value:null,feeItem,periodStart:bounded(periodStart,20),periodEnd:bounded(periodEnd,20),ageingDays:ageing.valid?ageing.value:null,status,rawEvidence:{arrearsAmount:amount.valid?amount.value:null,feeItem,periodStart:bounded(periodStart,20),periodEnd:bounded(periodEnd,20),ageingDays:ageing.valid?ageing.value:null,status}})
  })
  for(const [canonical,identities] of canonicalRaw)if(identities.size>1)errors.push(`资源键碰撞：${maskResource(canonical)}`)
  return{rows,errors,warnings}
}

export function mapLedgerNarrativeRows(input:Array<Record<string,unknown>>){
  const signalRows=input.flatMap(raw=>{
    if(/^(?:是|已回款|已缴|已结清)$/.test(pick(raw,['是否回款'])))return[]
    const reason=pick(raw,['欠费原因'])
    if(!reason)return[]
    return[{...raw,沟通记录:summarizeCommunicationForCloud(reason),沟通方式:'欠费台账'}]
  })
  const parsed=mapCommunicationRows(signalRows)
  return{...parsed,rows:parsed.rows.map(row=>({...row,ref:`T-${row.sourceRow}`}))}
}

export function mapCommunicationRows(input:Array<Record<string,unknown>>,sensitiveTerms:string[]=[],resolver?:ArrearsResourceResolver){
  const rows:CommunicationRow[]=[];const errors:string[]=[];const warnings:string[]=[];let resolvedByShortRoom=0
  const globalSensitiveTerms:string[]=[]
  const termsByResource=new Map<string,string[]>()
  for(const encoded of sensitiveTerms.map(text).filter(Boolean)){
    const separator=encoded.indexOf('\u0000')
    if(separator<0){if(encoded.length>=2)globalSensitiveTerms.push(encoded);continue}
    const resourceKey=encoded.slice(0,separator),term=encoded.slice(separator+1)
    if(term.length>=2)termsByResource.set(resourceKey,[...(termsByResource.get(resourceKey)||[]),term])
  }
  input.forEach((raw,index)=>{
    const sourceRow=Number(raw.__sourceRow)||index+2,recognizedKey=normalizeResourceKey(raw),content=pick(raw,ALIASES.content)
    let key=recognizedKey||{canonical:`COMMUNICATION-ROW:${sourceRow}`,display:`第${sourceRow}行`,rawIdentity:`COMMUNICATION-ROW:${sourceRow}`}
    if(recognizedKey&&resolver&&recognizedKey.canonical.startsWith('S:')){
      const resolved=resolver.matches.get(recognizedKey.canonical)
      if(resolved){key={canonical:resolved.canonical,display:recognizedKey.display,rawIdentity:resolved.canonical};resolvedByShortRoom+=1}
      else if(resolver.ambiguous.has(recognizedKey.canonical))warnings.push(`C-${sourceRow}：项目内短房号对应多个完整房屋号，已保留但不自动关联`)
    }
    if(!recognizedKey)warnings.push(`C-${sourceRow}：未识别资源编号，该条记录已保留但不自动关联台账`)
    if(!content){warnings.push(`C-${sourceRow}：未识别沟通内容，已跳过该行`);return}
    if(content.length>4000){errors.push(`C-${sourceRow}：沟通记录超过4000字`);return}
    const occurredRaw=pick(raw,ALIASES.occurredAt),occurredAt=normalizeOccurredAt(occurredRaw)
    if(occurredRaw&&!occurredAt){errors.push(`C-${sourceRow}：沟通时间必须为YYYY-MM-DD或YYYY/MM/DD`);return}
    const actor=pick(raw,ALIASES.actor)
    const resourceTerms=termsByResource.get(key.canonical)||[]
    const ruleMasked=maskSensitiveText(content,[...globalSensitiveTerms,...resourceTerms,key.display,actor])
    const residual=findResidualSensitivePatterns(ruleMasked)
    if(hasUnsafeFreeName(ruleMasked)){errors.push(`C-${sourceRow}：沟通记录含无法可靠脱敏的人名语境，请先移除姓名后重试`);return}
    if(residual.length){errors.push(`C-${sourceRow}：沟通记录脱敏门禁未通过（${residual.join('、')}）`);return}
    // 当前无本地中文NER，数据库及云端仅保存结构化经营信号；自由原文始终只留在AES-GCM密文归档。
    const contentMasked=summarizeCommunicationForCloud(ruleMasked)
    rows.push({sourceRow,ref:`C-${sourceRow}`,resourceCanonical:key.canonical,resourceHash:resourceHash(key.canonical),resourceMasked:maskResource(key.display),occurredAt,channel:normalizeChannel(pick(raw,ALIASES.channel)),actor:'经办人已脱敏',contentMasked})
  })
  return{rows,errors,warnings,resolvedByShortRoom}
}

const RULES:Array<{category:ArrearsCause;pattern:RegExp}>=[
  {category:'legal_dispute',pattern:/法律争议/},
  {category:'service_dispute',pattern:/服务争议/},
  {category:'charge_dispute',pattern:/收费争议/},
  {category:'vacancy',pattern:/房屋空置/},
  {category:'financial_hardship',pattern:/支付困难/},
  {category:'ownership_or_handover',pattern:/产权交付/},
  {category:'contact_barrier',pattern:/联系障碍/},
  {category:'promised_payment',pattern:/承诺缴费/},
]
export function inferRuleCause(communications:CommunicationRow[]):{category:ArrearsCause;confidence:number;evidenceRefs:string[]}{if(communications.some(row=>/冲突|否定语境/.test(row.contentMasked)))return{category:'unknown',confidence:0,evidenceRefs:communications.filter(row=>/冲突|否定语境/.test(row.contentMasked)).map(row=>row.ref)};for(const rule of RULES){const evidenceRefs=communications.filter(row=>rule.pattern.test(row.contentMasked)).map(row=>row.ref);if(evidenceRefs.length)return{category:rule.category,confidence:.7,evidenceRefs}}return{category:'unknown',confidence:0,evidenceRefs:[]}}
export function buildResourceEvidence(ledgerRows:LedgerRow[],communicationRows:CommunicationRow[],ledgerNarrativeRows:CommunicationRow[]=[]){
  const groups=new Map<string,LedgerRow[]>();for(const row of ledgerRows)groups.set(row.resourceHash,[...(groups.get(row.resourceHash)||[]),row])
  const communicationsByResource=new Map<string,CommunicationRow[]>();for(const row of communicationRows)communicationsByResource.set(row.resourceHash,[...(communicationsByResource.get(row.resourceHash)||[]),row])
  const narrativesByResource=new Map<string,CommunicationRow[]>();for(const row of ledgerNarrativeRows)narrativesByResource.set(row.resourceHash,[...(narrativesByResource.get(row.resourceHash)||[]),row])
  return[...groups.values()].map(group=>{const row=group[0],communications=communicationsByResource.get(row.resourceHash)||[],narratives=narrativesByResource.get(row.resourceHash)||[],ruleAttribution=inferRuleCause([...communications,...narratives]);return{resourceRef:`R-${row.resourceHash.slice(0,12)}`,resourceHash:row.resourceHash,resourceMasked:row.resourceMasked,ledgerEvidence:{ref:row.ref,...row.rawEvidence},ledgerEvidenceItems:group.map(item=>({ref:item.ref,...item.rawEvidence})),communications:communications.map(item=>({ref:item.ref,occurredAt:item.occurredAt,channel:item.channel,content:item.contentMasked})),ruleAttribution,evidenceRefs:[...group.map(item=>item.ref),...communications.map(item=>item.ref),...narratives.map(item=>item.ref)],dataNotes:communications.length?[]:['未提供匹配的沟通记录，不等同于未联系']}})
}
export function validateAiAttributions(input:any[],allowedResources:Array<{resourceRef:string;evidenceRefs:string[]}>){
  const output=Array.isArray(input)?input:[],byRef=new Map<string,any[]>();for(const item of output){const ref=String(item?.resourceRef||'');byRef.set(ref,[...(byRef.get(ref)||[]),item])}
  // 外部AI响应是不可信输入。拒绝明细只保留安全的资源引用和原因，不能把原始响应写入运行摘要。
  const accepted:any[]=[],rejected:Array<{resourceRef:string;reason:string}>=[];let coverageOk=true
  for(const allowed of allowedResources){const items=byRef.get(allowed.resourceRef)||[];if(items.length!==1){coverageOk=false;rejected.push({resourceRef:allowed.resourceRef,reason:items.length?'同一资源返回重复结果':'AI漏掉当前资源'});continue}
    const item=items[0],refs=new Set(allowed.evidenceRefs),evidenceRefs:string[]=Array.isArray(item?.evidenceRefs)?item.evidenceRefs.map((value:unknown)=>String(value)):[]
    const category=String(item?.category||'')
    const evidenceSupportsCause=category==='unknown'||evidenceRefs.some(ref=>ref.startsWith('C-')||ref.startsWith('T-'))
    const confidence=Number(item?.confidence)
    const reason=text(item?.reason)
    const reasonRisks=findResidualSensitivePatterns(reason)
    const resourceHasReasonEvidence=allowed.evidenceRefs.some(ref=>ref.startsWith('C-')||ref.startsWith('T-'))
    // 只有台账证据时，AI只能明确表示“未知”且低置信，不得伪造联系结论。
    const safeWithoutCommunication=resourceHasReasonEvidence||(category==='unknown'&&confidence<=0.49)
    const valid=(ARREARS_CAUSES as readonly string[]).includes(category)&&Number.isFinite(confidence)&&confidence>=0&&confidence<=1&&evidenceRefs.length>0&&evidenceRefs.every(ref=>refs.has(ref))&&evidenceSupportsCause&&safeWithoutCommunication&&reason.length>0&&reason.length<=200&&reasonRisks.length===0
    if(!valid)rejected.push({resourceRef:allowed.resourceRef,reason:reasonRisks.length?`AI理由含敏感信息（${reasonRisks.join('、')}）`:'类别、置信度、理由或证据引用不合法'});else accepted.push({resourceRef:allowed.resourceRef,category:String(item.category),confidence:Number(item.confidence),reason,evidenceRefs})
  }
  for(const [resourceRef] of byRef)if(!allowedResources.some(item=>item.resourceRef===resourceRef)){coverageOk=false;rejected.push({resourceRef:'unexpected-resource',reason:'返回了未请求的资源'})}
  if(accepted.length+rejected.filter(item=>allowedResources.some(allowed=>allowed.resourceRef===item.resourceRef)).length!==allowedResources.length)coverageOk=false
  return{accepted,rejected,coverageOk,expected:allowedResources.length}
}
