import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const payload = path.join(root, 'production-overlays/cockpit-r136-special-unit-unranked-20260827-v2/payload')
const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')
const remediation = fs.readFileSync(path.join(payload, 'aph2-r127-audit-remediation-20260826-v3.js'), 'utf8')

// 特殊经营单元保留经营数据，但不占用地理片区名次。
test('R136 recognizes canonical and historical withdrawn labels as special operating units', () => {
  assert.match(remediation, /华北地区公司\|华北第一保洁\|撤场项目\|已撤场项目/)
  assert.match(remediation, /const isSpecial = special\.test/)
  assert.match(remediation, /data-special-operating-unit/)
})

test('R136 numbers only geographic areas and renders no rank for special units', () => {
  assert.match(remediation, /let geographicRank = 0/)
  assert.match(remediation, /isSpecial \? '—' : String\(\+\+geographicRank\)/)
  assert.doesNotMatch(remediation, /textContent = String\(index \+ 1\)/)
  assert.match(remediation, /特殊经营单元置后/)
})

test('R136 routes every ranking row to the matching payment area', () => {
  assert.match(remediation, /const area = normalize\(link\.children\[1\]\?\.textContent\)/)
  assert.match(remediation, /link\.setAttribute\('href', `\/payment\?area=\$\{encodeURIComponent\(area\)\}`\)/)
  assert.doesNotMatch(remediation, /\/projects\?area=/)
})

test('R136 refreshes the amended ranking runtime without losing R135 presentation fixes', () => {
  assert.match(index, /aph2-r127-audit-remediation-20260826-v3\.js\?v=r136-drilldown2/)
  assert.match(index, /aph2-r135-hide-data-basis-20260827-v1\.css\?v=r135-hide-basis1/)
})
