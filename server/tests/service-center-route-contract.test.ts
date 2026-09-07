import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ai = readFileSync(resolve(here, '../src/routes/ai.ts'), 'utf8')
const index = readFileSync(resolve(here, '../src/index.ts'), 'utf8')
const start = ai.indexOf("router.get('/api/ai/service-centers'")
const analysisStart = ai.indexOf('function latestVerifiedDailyRows')
const gate = ai.indexOf('// 经营分析、预警、月报与周重点必须先通过项目数据真实性门禁')
const endpoint = ai.slice(analysisStart, gate)

test('服务中心端点位于旧projects门禁之前，并按单中心范围读取', () => {
  assert.ok(start >= 0)
  assert.ok(gate > start)
  assert.doesNotMatch(index, /guard\(\[[^\]]*'\/api\/ai'/)
  assert.ok(analysisStart >= 0 && analysisStart < start)
  assert.match(endpoint, /serviceCenterScopeWhere\(req, 'center'\)/)
  assert.doesNotMatch(endpoint, /readProjectDataGate|projectScopeWhere|canAccessProjectRow/)
})

test('端点只读合并最新verified日快照与正式收缴数据，不调LLM不写表', () => {
  assert.match(ai, /quality_status = 'verified'/)
  assert.match(endpoint, /getFormalCollectionDataset\(\)/)
  assert.match(endpoint, /buildServiceCenterAnalysis/)
  assert.doesNotMatch(endpoint, /callLLM|DEEPSEEK|INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|\.run\(/i)
})

test('P46正式收缴数据保留canonical_key供规范名合并', () => {
  assert.match(ai, /SELECT r\.source_key, r\.canonical_key/)
  assert.match(ai, /formalRowsWithCanonicalNames/)
  assert.match(endpoint, /formalRowsWithCanonicalNames\(formal\.dataset\?\.rows \|\| \[\]\)/)
})
