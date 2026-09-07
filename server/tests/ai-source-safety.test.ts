import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const aiSource = readFileSync(resolve(here, '../src/routes/ai.ts'), 'utf8')
const regionalAssistantSource = readFileSync(resolve(here, '../src/routes/regional-assistant.ts'), 'utf8')

test('AI and assistant daily facts fail closed when the published reconciliation no longer matches snapshots', () => {
  assert.match(aiSource, /unresolvedPublishedDailyConflict/)
  assert.match(aiSource, /if \(unresolvedPublishedDailyConflict\(db, businessDate\)\)/)
  assert.match(regionalAssistantSource, /unresolvedPublishedDailyConflict/)
  assert.match(regionalAssistantSource, /if \(unresolvedPublishedDailyConflict\(db, aph\.businessDate\)\)/)
})

test('AI trend does not invent a linear monthly benchmark from annual values', () => {
  assert.doesNotMatch(aiSource, /annual_income\)\s*\*\s*(?:elapsed|Math\.min\()/)
  assert.doesNotMatch(aiSource, /annual_cost\)\s*\*\s*(?:elapsed|Math\.min\()/)
  assert.match(aiSource, /expectedIncome:\s*null/)
  assert.match(aiSource, /expectedCost:\s*null/)
})
