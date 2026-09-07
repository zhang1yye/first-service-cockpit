import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'

const collections = readFileSync(new URL('../src/routes/collections.ts', import.meta.url), 'utf8')
const summary = readFileSync(new URL('../src/routes/summary.ts', import.meta.url), 'utf8')
const assistant = readFileSync(new URL('../src/routes/regional-assistant.ts', import.meta.url), 'utf8')
const sharedUrl = new URL('../src/collection-dataset.ts', import.meta.url)
const shared = existsSync(sharedUrl) ? readFileSync(sharedUrl, 'utf8') : ''

test('collection page and regional assistant share one quality-gated formal publication selector', () => {
  assert.match(shared, /export function getFormalCollectionDataset/)
  assert.match(shared, /buildCollectionPublication/)
  assert.match(collections, /import \{ getFormalCollectionDataset \} from '\.\.\/collection-dataset\.js'/)
  assert.match(assistant, /import \{ getFormalCollectionDataset \} from '\.\.\/collection-dataset\.js'/)
  assert.doesNotMatch(collections, /import \{ getLvzaiDataset \}/)
  assert.doesNotMatch(assistant, /import \{ getLvzaiDataset \}/)
})

test('regional assistant no longer implements an independent published-batch selector', () => {
  assert.doesNotMatch(assistant, /FROM data_ingestion_batches/)
  assert.doesNotMatch(assistant, /绿仔收款汇总\.json/)
})

test('regional assistant gates center payment detail against APH lineage and request scope', () => {
  assert.match(assistant, /getServiceCenterScope\(req\.user\)/)
  assert.match(assistant, /p\.center IN/)
  assert.match(assistant, /FROM payment_centers/)
  assert.match(assistant, /quality_status != 'verified'/)
  assert.match(assistant, /source_status != 'available'/)
  assert.match(assistant, /d\.business_date != @businessDate/)
  assert.match(assistant, /COUNT\(DISTINCT center\)/)
  assert.match(assistant, /COUNT\(DISTINCT d\.center\) uniqueCenterCount/)
  assert.match(assistant, /invalidRequiredCount/)
  assert.match(assistant, /d\.daily_collection IS NULL/)
  assert.match(assistant, /d\.annual_budget IS NULL/)
  assert.match(assistant, /typeof\(d\.cumulative_executed\) NOT IN \('integer', 'real'\)/)
  assert.match(assistant, /GROUP_CONCAT\(d\.last_validated_at, CHAR\(10\)\) validationTimes/)
  assert.match(assistant, /validationTimes\.length === count/)
  assert.match(assistant, /validationTimes\.every\(value => isFreshValidationTimestamp\(value\)\)/)
  assert.match(assistant, /ABS\(d\.cumulative_executed - p\.cumulative_executed\) > 0\.02/)
  assert.match(assistant, /const invalidScopedRow = rows\.some/)
  assert.match(assistant, /服务中心回款明细存在缺失或非数值必填字段/)
  assert.doesNotMatch(assistant, /annualBudget:\s*Number\(row\.annualBudget\)/)
  assert.match(assistant, /answerRegionalQuestionWithTopic\(question, topic, context\)/)
  assert.match(assistant, /const safeHistory = result\.centerPaymentLookup \? \[\] : history/)
})

test('regional assistant fails closed when the APH region card omits required numeric facts', () => {
  assert.match(assistant, /age >= -5 \* 60 \* 1000/)
  assert.match(assistant, /age <= 72 \* 60 \* 60 \* 1000/)
  assert.match(assistant, /const annualBudget = readOptionalNumber\(values\.annualBudget\)/)
  assert.match(assistant, /const cumulativeBudget = readOptionalNumber\(values\.cumulativeBudget\)/)
  assert.match(assistant, /const current = readOptionalNumber\(values\.cumulativeExecuted\)/)
  assert.match(assistant, /const baseline = readOptionalNumber\(values\.samePeriod\)/)
  assert.match(assistant, /\[annualBudget, cumulativeBudget, current, baseline\]\.some\(value => value === null\)/)
})

test('regional assistant uses the formal collection publication for admin and official scoped row fields for members', () => {
  assert.match(assistant, /!formal\.quality\.ready \|\| !isCollectionPublicationUsable\(publication\)/)
  assert.match(assistant, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(businessDate\)/)
  assert.match(assistant, /timestamps\.every\(value => isFreshValidationTimestamp\(value\)\)/)
  assert.match(assistant, /rate <= 1/)
  assert.match(assistant, /isNonNegativeFiniteNumber\(publication\?\.collectionOutstanding\)/)
  assert.match(assistant, /const isAdmin = req\?\.user\?\.role === 'admin'/)
  assert.match(assistant, /const scopedRows = isAdmin[\s\S]*activeRows\.filter\(row => canAccessServiceCenter\(req, row\.center\)\)/)
  assert.match(assistant, /const receivable = isAdmin \? publication\.collectionReceivable : amounts\.receivable/)
  assert.match(assistant, /const received = isAdmin \? publication\.collectionReceived : amounts\.received/)
  assert.match(assistant, /const outstanding = isAdmin \? publication\.collectionOutstanding : amounts\.outstanding/)
  assert.match(assistant, /isAdmin[\s\S]*ratioToPercent\(publication\.collectionRate\)/)
  assert.match(assistant, /必须逐字段绑定publication，禁止从中心行重新加权形成第二口径/)
  assert.match(assistant, /isNonNegativeFiniteNumber\(row\.outstanding\)/)
  assert.match(assistant, /isHeatingAdjustedCollectionCenter\(row\.center\)/)
  assert.match(assistant, /:\s*officialRate/)
  assert.match(assistant, /outstanding:\s*sum\.outstanding \+ outstanding/)
  assert.doesNotMatch(assistant, /Math\.max\(receivable - received,\s*0\)/)
})

test('regional assistant exposes only Hermes-grounded success and maps generation failure to 503', () => {
  assert.match(assistant, /orchestrated\.failure\.code === 'AI_GENERATION_UNAVAILABLE' \? 503 : 409/)
  assert.match(assistant, /fallbackUsed: false/)
  assert.doesNotMatch(assistant, /generatedBy:\s*['"]rules['"]/)
})

test('public summary and collection detail preserve the shared official 0-to-1 rate contract', () => {
  assert.doesNotMatch(summary, /toPublicCollectionPublication/)
  assert.match(summary, /const formal = getFormalCollectionDataset\(\)/)
  assert.match(summary, /const lvzai = formal\.publication/)
  assert.doesNotMatch(collections, /publicPublication/)
  assert.match(collections, /const publication = formal\.publication/)
  assert.match(collections, /_lvzaiSummary/)
})
