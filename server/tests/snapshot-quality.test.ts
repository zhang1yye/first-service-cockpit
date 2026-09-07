import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(resolve(here, p), 'utf8')
const db = read('../src/db.ts')
const sources = read('../src/routes/data-sources.ts')
const ai = read('../src/routes/ai.ts')
const formal = read('../src/routes/formal-outputs.ts')
const scraper = read('../scripts/scrape_and_import.py')

test('historical snapshot tables default to unverified and carry lineage', () => {
  for (const table of ['daily_snapshots', 'project_monthly_snapshots', 'monthly_trends']) {
    assert.match(db, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}[\\s\\S]*?quality_status TEXT NOT NULL DEFAULT 'unverified'`))
  }
  for (const field of ['quality_reason', 'source', 'business_date', 'last_validated_at', 'field_provenance']) {
    assert.match(db, new RegExp(field))
  }
})

test('monthly snapshot creation requires the project truth gate and preserves nulls', () => {
  assert.match(sources, /readProjectDataGate\(db\)/)
  assert.match(sources, /quality_status[\s\S]*?last_validated_at/)
  assert.doesNotMatch(sources, /ins\.run\([^\n]*n\(p\./)
})

test('AI trends only use verified monthly snapshots', () => {
  const filters = ai.match(/project_monthly_snapshots WHERE[^'`\n]*quality_status\s*=\s*['"]verified['"]/g) || []
  assert.ok(filters.length >= 3, `expected at least 3 verified snapshot filters, got ${filters.length}`)
})

test('formal monthly gate treats missing quality status as unverified', () => {
  assert.match(formal, /COALESCE\(quality_status,'unverified'\)!='verified'/)
  assert.match(formal, /project_monthly_snapshots WHERE month=\?[\s\S]*?quality_status='verified'/)
})

test('daily scraper writes quality and field lineage without a zero default migration', () => {
  assert.match(scraper, /INSERT OR REPLACE INTO daily_snapshots[\s\S]*quality_status[\s\S]*field_provenance/)
  assert.doesNotMatch(scraper, /daily_collection REAL DEFAULT 0/)
})

test('daily scraper uses one shared validation timestamp for snapshots and the APH summary', () => {
  const assignments = scraper.match(/^\s*validated_at = datetime\.now\(\)\.isoformat[^\n]*$/gm) || []
  assert.equal(assignments.length, 1)
  assert.match(scraper, /daily_snapshots[\s\S]*today, validated_at, field_provenance/)
  assert.match(scraper, /'extractedAt': validated_at[\s\S]*'lastValidatedAt': validated_at/)
})

test('manual monthly trend writes are admin-only and disabled in production', () => {
  const trends = read('../src/routes/trends.ts')
  assert.match(trends, /router\.post\('\/api\/trends', requireAdmin/)
  assert.match(trends, /canUseManualBusinessWrites\(\)[\s\S]*status\(403\)/)
  assert.match(trends, /FROM monthly_trends[\s\S]*quality_status='verified'/)
})
