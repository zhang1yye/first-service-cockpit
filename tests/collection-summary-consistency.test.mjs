import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const activeOverlay = html.match(/<script src="\/(aph2-theme-[^"?]+\.js)(?:\?[^\"]*)?"><\/script>/)?.[1]
assert.ok(activeOverlay, 'index.html must reference a versioned APH theme overlay')
const overlay = fs.readFileSync(path.join(site, activeOverlay), 'utf8')
const collectionBundle = fs.readFileSync(path.join(site, 'assets', 'collection-gD0rrqx7.js'), 'utf8')
const importer = fs.readFileSync(path.join(root, 'server', 'scripts', 'import-lvzai-api.py'), 'utf8')

test('all uses heating-corrected summary while selected areas use amount ratio', () => {
  assert.match(collectionBundle, /o==="全部"\?e:e\.filter\(c=>c\.area===o\)/)
  assert.match(collectionBundle, /x=h\.receivable>0\?h\.received\/h\.receivable:Number\.NaN/)
  assert.match(overlay, /aphCollectionRateBasis\s*=\s*['"]all-heating-corrected-area-amount['"]/)
  assert.match(overlay, /areaFilter\.value\s*!==\s*['"]全部['"]/)
  assert.match(overlay, /summary\.collectionRate/)
  assert.match(overlay, /applyCollectionFooterSummary\(root, summary\)/)
  assert.match(overlay, /['"]华北综合收缴率['"]/)
  assert.match(overlay, /['"]综合收缴率['"]/)
})

test('special heating projects are corrected at amount level before aggregation', () => {
  assert.match(importer, /HEATING_REGION_IDS\s*=\s*\{/)
  assert.match(importer, /"北京万国城MOMΛ"/)
  assert.match(importer, /"北京满庭芳园"/)
  assert.match(importer, /"北京青云大厦"/)
  assert.match(importer, /HEATING_FEE_IDS\s*=\s*\[138, 139\]/)
  assert.match(importer, /received\s*-\s*old_received\s*\+\s*new_received/)
  assert.match(importer, /receivable\s*-\s*old_receivable\s*\+\s*new_receivable/)
})
