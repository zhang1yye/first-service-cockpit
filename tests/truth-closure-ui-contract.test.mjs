import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const source = fs.readFileSync(path.join(process.cwd(), 'firstcare-cloud-local/aph2-theme.js'), 'utf8')

function functionBody(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} must exist`)
  const next = source.indexOf('\n  function ', start + 1)
  return source.slice(start, next >= 0 ? next : source.length)
}

test('unmatched project operating nulls render as em dash rather than zero', () => {
  const wan = functionBody('projectFormatWan')
  const rate = functionBody('projectFormatRate')
  assert.match(wan, /value === null[\s\S]*return '—'/)
  assert.match(rate, /value !== null[\s\S]*: '—'/)
  assert.match(source, /projectFormatWan\(row\.operating\?\.payment\?\.cumulativeExecuted\)/)
  assert.match(source, /projectFormatRate\(row\.operating\?\.collection\?\.collectionRate\)/)
})

test('unmatched profile remains visibly unmatched and does not imply an operating conclusion', () => {
  const badge = functionBody('projectLinkBadge')
  assert.match(badge, /status = operating\?\.linkStatus \|\| 'unmatched'/)
  assert.match(badge, /: '未匹配'/)
  assert.match(source, /易水名苑暂未匹配/)
  assert.match(source, /暂无对应经营中心/)
})
