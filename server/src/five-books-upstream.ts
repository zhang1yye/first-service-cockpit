export type FiveBooksPeriod = 'q1' | 'q2' | 'half' | 'q3' | 'q4' | 'annual'

type FetchLike = typeof fetch

export interface FiveBooksUpstreamConfig {
  baseUrl?: string
  sessionId?: string
  pageSize?: number
  timeoutMs?: number
  fetchImpl?: FetchLike
}

export interface FiveBooksLiveSubject {
  headCode: string
  structureCode: string
  name: string
  targetCycle: string
  totalScore: number | null
  budgetScore: number | null
  rulesScore: number | null
  taskScore: number | null
  dutyScore: number | null
  hrScore: number | null
  otherScore: number | null
  rankCode: string
}

export interface FiveBooksLiveMetric {
  code: string
  name: string
  weight: number | null
  weightType: string
  definition: string
  scoreStandard: string
  targetValue: number | null
  annualTargetValue: number | null
  actualValue: number | null
  score: number | null
  unit: string
  applicability: 'applicable' | 'excluded' | 'pending'
  remark: string
}

export interface FiveBooksLiveDetail {
  headCode: string
  structureCode: string
  name: string
  targetCycle: string
  totalScore: number | null
  quarterScore: number | null
  starLevel: number | null
  quarterStarLevel: number | null
  executor: string
  responsible: string
  accountant: string
  controller: string
  books: Array<{
    type: string
    name: string
    weight: number | null
    score: number | null
    metrics: FiveBooksLiveMetric[]
  }>
}

const NORTH_CHINA_STRUCTURE_PREFIX = 'C01020134'
const FIRST_SERVICE_BUSINESS_CODE = 'C010201'
const ALLOWED_PERIODS = new Set<FiveBooksPeriod>(['q1', 'q2', 'half', 'q3', 'q4', 'annual'])

function cleanText(value: unknown, max = 1000): string {
  return String(value ?? '').trim().slice(0, max)
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function assertYear(year: number): number {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new Error('五书年度无效')
  return year
}

function assertPeriod(period: string): FiveBooksPeriod {
  if (!ALLOWED_PERIODS.has(period as FiveBooksPeriod)) throw new Error('五书评估周期无效')
  return period as FiveBooksPeriod
}

export function fiveBooksTargetCycle(year: number, period: string): string {
  const validYear = assertYear(year)
  const validPeriod = assertPeriod(period)
  const monthDay: Record<FiveBooksPeriod, string> = {
    q1: '03-31',
    q2: '06-30',
    half: '06-30',
    q3: '09-30',
    q4: '12-31',
    annual: '12-31',
  }
  return `${validYear}-${monthDay[validPeriod]}`
}

function normalizedApplicability(value: unknown): FiveBooksLiveMetric['applicability'] {
  const text = cleanText(value, 40).toLowerCase()
  if (!text) return 'applicable'
  if (/^(n|no|false|0)$|不涉及|除权/.test(text)) return 'excluded'
  if (/^(y|yes|true|1)$|涉及/.test(text)) return 'applicable'
  return 'pending'
}

function apiError(message: string, statusCode = 502): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number }
  error.statusCode = statusCode
  return error
}

export class FiveBooksUpstreamClient {
  private readonly baseUrl: string
  private readonly sessionId: string
  private readonly pageSize: number
  private readonly timeoutMs: number
  private readonly fetchImpl: FetchLike

  constructor(config: FiveBooksUpstreamConfig = {}) {
    this.baseUrl = cleanText(config.baseUrl || process.env.FIVE_BOOKS_UPSTREAM_BASE_URL || 'https://fb.firstcare.com.cn', 300).replace(/\/+$/, '')
    this.sessionId = cleanText(config.sessionId || process.env.FIVE_BOOKS_SSO_SESSION_ID, 500)
    this.pageSize = Math.min(200, Math.max(1, Number(config.pageSize || 200)))
    this.timeoutMs = Math.min(30_000, Math.max(1_000, Number(config.timeoutMs || 10_000)))
    this.fetchImpl = config.fetchImpl || fetch
    if (!this.sessionId) throw apiError('五书正式接口登录态未配置', 503)
    if (!/^https:\/\//i.test(this.baseUrl)) throw apiError('五书正式接口地址必须使用HTTPS', 503)
  }

  private async post(pathname: string, body: Record<string, unknown>): Promise<any> {
    const url = new URL(pathname, `${this.baseUrl}/`)
    url.searchParams.set('sso_sessionid', this.sessionId)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error: any) {
      throw apiError(error?.name === 'TimeoutError' ? '五书正式接口请求超时' : '五书正式接口网络不可用')
    }
    if (!response.ok) throw apiError(`五书正式接口返回HTTP ${response.status}`, response.status === 401 || response.status === 403 ? 503 : 502)
    const payload = await response.json().catch(() => null)
    if (!payload || Number(payload.code) !== 200) {
      const message = cleanText(payload?.message, 120)
      throw apiError(/登录|认证|session|sso/i.test(message) ? '五书正式接口登录态已失效' : `五书正式接口返回异常${message ? `：${message}` : ''}`, 503)
    }
    return payload
  }

  async listNorthChinaSubjects(input: { year: number; period: string }): Promise<{ targetCycle: string; subjects: FiveBooksLiveSubject[] }> {
    const year = assertYear(input.year)
    const targetCycle = fiveBooksTargetCycle(year, input.period)
    const subjects: FiveBooksLiveSubject[] = []
    let page = 1
    let total = Number.POSITIVE_INFINITY
    while (subjects.length < total && page <= 100) {
      const payload = await this.post('/fiveTarget/score', {
        page,
        size: this.pageSize,
        year: String(year),
        targetCycle,
        companyCode: NORTH_CHINA_STRUCTURE_PREFIX,
        businessCode: FIRST_SERVICE_BUSINESS_CODE,
        structureCode: '',
      })
      const rows = Array.isArray(payload.data) ? payload.data : []
      total = Number.isFinite(Number(payload.count)) ? Number(payload.count) : page * this.pageSize
      for (const row of rows) {
        const structureCode = cleanText(row?.structureCode, 80)
        if (!structureCode.startsWith(NORTH_CHINA_STRUCTURE_PREFIX)) continue
        const headCode = cleanText(row?.fiveTargetHeadCode, 160)
        if (!headCode) continue
        subjects.push({
          headCode,
          structureCode,
          name: cleanText(row?.structureName, 200).replace(/^第一服务/, '') || structureCode,
          targetCycle: cleanText(row?.targetCycle, 20) || targetCycle,
          totalScore: finiteNumber(row?.targetScore),
          budgetScore: finiteNumber(row?.budgetScore),
          rulesScore: finiteNumber(row?.rulesScore),
          taskScore: finiteNumber(row?.taskScore),
          dutyScore: finiteNumber(row?.dutyScore),
          hrScore: finiteNumber(row?.hrScore),
          otherScore: finiteNumber(row?.otherScore),
          rankCode: cleanText(row?.rankCode, 80),
        })
      }
      if (!rows.length || rows.length < this.pageSize) break
      page += 1
    }
    const deduplicated = [...new Map(subjects.map((subject) => [subject.headCode, subject])).values()]
    return { targetCycle, subjects: deduplicated.sort((a, b) => a.structureCode.localeCompare(b.structureCode, 'zh-CN')) }
  }

  async getAssessmentDetail(input: { headCode: string; year: number; period: string }): Promise<FiveBooksLiveDetail> {
    assertYear(input.year)
    const targetCycle = fiveBooksTargetCycle(input.year, input.period)
    const headCode = cleanText(input.headCode, 160)
    if (!headCode || !/^[\w-]+$/u.test(headCode)) throw apiError('五书评估记录编码无效', 400)
    const payload = await this.post('/fiveTarget/view', { fiveTargetHeadCode: headCode, status: 'PASS', targetCycle })
    const data = payload.data
    if (!data || cleanText(data.fiveTargetHeadCode, 160) !== headCode) throw apiError('五书正式接口未返回对应评估记录', 404)
    const structureCode = cleanText(data.structureCode, 80)
    if (!structureCode.startsWith(NORTH_CHINA_STRUCTURE_PREFIX)) throw apiError('五书评估记录不属于华北组织范围', 403)
    const books = (Array.isArray(data.fiveTargetLines) ? data.fiveTargetLines : []).map((line: any) => ({
      type: cleanText(line?.fbType, 40),
      name: cleanText(line?.fbName, 100),
      weight: finiteNumber(line?.ratio),
      score: finiteNumber(line?.fiveTargetLineScore),
      metrics: (Array.isArray(line?.fiveTargetTasks) ? line.fiveTargetTasks : []).map((task: any): FiveBooksLiveMetric => ({
        code: cleanText(task?.targetCode || task?.fiveTargetTaskCode, 160),
        name: cleanText(task?.targetName, 240),
        weight: finiteNumber(task?.targetRatio),
        weightType: cleanText(task?.targetRatioType, 40),
        definition: cleanText(task?.targetStandard, 3000),
        scoreStandard: cleanText(task?.scoreStandard, 3000),
        targetValue: finiteNumber(task?.targetAllGoal),
        annualTargetValue: finiteNumber(task?.targetGoal),
        actualValue: finiteNumber(task?.targetExecute),
        score: finiteNumber(task?.targetScore),
        unit: cleanText(task?.targetUnit, 40),
        applicability: normalizedApplicability(task?.isInvolve),
        remark: cleanText(task?.remark, 1000),
      })),
    }))
    return {
      headCode,
      structureCode,
      name: cleanText(data.structureName, 200).replace(/^第一服务/, ''),
      targetCycle: cleanText(data.targetCycle, 20) || targetCycle,
      totalScore: finiteNumber(data.targetScore),
      quarterScore: finiteNumber(data.targetQuarterScore),
      starLevel: finiteNumber(data.starLevel),
      quarterStarLevel: finiteNumber(data.starQuarterLevel),
      executor: cleanText(data.executeName, 100),
      responsible: cleanText(data.liablerName, 100),
      accountant: cleanText(data.checkName, 100),
      controller: cleanText(data.controllerName, 100),
      books,
    }
  }
}

export function fiveBooksUpstreamConfigured(): boolean {
  return Boolean(cleanText(process.env.FIVE_BOOKS_SSO_SESSION_ID, 500))
}
