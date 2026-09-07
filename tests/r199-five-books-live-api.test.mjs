import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const routePath = path.join(root, 'server/src/routes/five-books.ts')
const connectorSourcePath = path.join(root, 'server/src/five-books-upstream.ts')
const connectorDistPath = path.join(root, 'server/dist/five-books-upstream.js')

test('R199 maps dashboard periods to explicit upstream assessment dates', async () => {
  const connector = await import(pathToFileURL(connectorDistPath).href)
  assert.equal(connector.fiveBooksTargetCycle(2026, 'q1'), '2026-03-31')
  assert.equal(connector.fiveBooksTargetCycle(2026, 'q2'), '2026-06-30')
  assert.equal(connector.fiveBooksTargetCycle(2026, 'half'), '2026-06-30')
  assert.equal(connector.fiveBooksTargetCycle(2026, 'q3'), '2026-09-30')
  assert.equal(connector.fiveBooksTargetCycle(2026, 'q4'), '2026-12-31')
  assert.equal(connector.fiveBooksTargetCycle(2026, 'annual'), '2026-12-31')
  assert.throws(() => connector.fiveBooksTargetCycle(2026, 'month'), /周期/)
})

test('R199 pages the formal score API and keeps only north-China subjects', async () => {
  const connector = await import(pathToFileURL(connectorDistPath).href)
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) })
    const page = requests.length
    return new Response(JSON.stringify({
      code: 200,
      message: '成功',
      count: 3,
      data: page === 1
        ? [
            { fiveTargetHeadCode: 'north-region', structureCode: 'C01020134', structureName: '华北地区公司', targetCycle: '2026-06-30', targetScore: '1.0075' },
            { fiveTargetHeadCode: 'other', structureCode: 'C01020135', structureName: '其他地区公司', targetCycle: '2026-06-30', targetScore: '0.9' },
          ]
        : [{ fiveTargetHeadCode: 'north-center', structureCode: 'C0102013404', structureName: '第一服务北京万国城MOMΛ服务中心', targetCycle: '2026-06-30', targetScore: '1.0718' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = new connector.FiveBooksUpstreamClient({ baseUrl: 'https://fb.example.test', sessionId: 'top-secret', pageSize: 2, fetchImpl })
  const result = await client.listNorthChinaSubjects({ year: 2026, period: 'q2' })
  assert.deepEqual(result.subjects.map((row) => row.headCode), ['north-region', 'north-center'])
  assert.equal(result.targetCycle, '2026-06-30')
  assert.equal(requests.length, 2)
  assert.deepEqual(requests.map((request) => request.body.page), [1, 2])
  assert.ok(requests.every((request) => request.body.targetCycle === '2026-06-30'))
  assert.ok(requests.every((request) => request.url.includes('sso_sessionid=top-secret')))
  assert.doesNotMatch(JSON.stringify(result), /top-secret/)
})

test('R199 normalizes formal detail without returning session credentials or executable rules', async () => {
  const connector = await import(pathToFileURL(connectorDistPath).href)
  const fetchImpl = async () => new Response(JSON.stringify({
    code: 200,
    data: {
      fiveTargetHeadCode: 'north-center', structureCode: 'C0102013404', structureName: '第一服务北京万国城MOMΛ服务中心',
      targetCycle: '2026-06-30', targetScore: '1.0718', starLevel: '5', executeName: '执行人', liablerName: '责任人', checkName: '核算人', controllerName: '控制人',
      fiveTargetLines: [{ fbType: 'BUDGET', fbName: '计划预算书', ratio: '60', fiveTargetLineScore: '0.6718', fiveTargetTasks: [{
        targetCode: 'metric-1', targetName: '回款额-计划预算执行', targetRatio: '20', targetRatioType: 'DEFAULT', targetStandard: '正式定义',
        targetAllGoal: '16132276.66', targetExecute: '17084326.09', targetScore: '1.059', targetUnit: '元', scoreStandard: '正式得分标准',
        ruleValueView: 'return secret()', fileUrl: 'https://files.example.test/private.xlsx',
      }] }],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const client = new connector.FiveBooksUpstreamClient({ baseUrl: 'https://fb.example.test', sessionId: 'top-secret', fetchImpl })
  const result = await client.getAssessmentDetail({ headCode: 'north-center', year: 2026, period: 'q2' })
  assert.equal(result.totalScore, 1.0718)
  assert.equal(result.books[0].metrics[0].actualValue, 17084326.09)
  assert.equal(result.books[0].metrics[0].score, 1.059)
  assert.doesNotMatch(JSON.stringify(result), /top-secret|secret\(\)|private\.xlsx/)
})

test('R199 keeps the authenticated subject and detail route contract available', () => {
  const route = fs.readFileSync(routePath, 'utf8')
  const connector = fs.readFileSync(connectorSourcePath, 'utf8')
  assert.match(route, /router\.get\('\/api\/five-books\/live\/subjects'/)
  assert.match(route, /router\.get\('\/api\/five-books\/live\/detail'/)
  assert.doesNotMatch(route, /formal-excel-fallback/)
  assert.match(connector, /listNorthChinaSubjects/)
  assert.match(connector, /getAssessmentDetail/)
  assert.match(connector, /FIVE_BOOKS_SSO_SESSION_ID/)
  assert.doesNotMatch(connector, /0cb71ff37d67465b8c0670a319bde519/)
})
