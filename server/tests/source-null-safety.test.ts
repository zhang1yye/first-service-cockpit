import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dbSource = readFileSync(resolve(here, '../src/db.ts'), 'utf8')
const importSource = readFileSync(resolve(here, '../src/routes/import.ts'), 'utf8')

test('project and monthly snapshot schemas do not default missing operating facts to zero', () => {
  assert.doesNotMatch(dbSource, /safety_incidents INTEGER DEFAULT 0/)
  assert.doesNotMatch(dbSource, /complaint_count INTEGER DEFAULT 0/)
  for (const field of ['ytd_income', 'ytd_cost', 'receivable', 'received', 'quality_score', 'customer_satisfaction']) {
    assert.doesNotMatch(dbSource, new RegExp(`${field} REAL DEFAULT 0`))
  }
})

test('project imports preserve missing incidents and complaints as null', () => {
  assert.doesNotMatch(importSource, /p\.safety_incidents \|\| 0/)
  assert.doesNotMatch(importSource, /p\.complaint_count \|\| 0/)
  assert.doesNotMatch(importSource, /mapped\.safety_incidents \|\| 0/)
  assert.doesNotMatch(importSource, /mapped\.complaint_count \|\| 0/)
})
