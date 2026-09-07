import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const index = fs.readFileSync(path.join(site, 'index.html'), 'utf8')

function selectedThemeAsset() {
  const match = index.match(/<script src="\/(aph2-theme[^"?]*\.js)(?:\?[^".]*)?"/)
  assert.ok(match, 'production index must select an APH theme asset')
  return { name: match[1], source: fs.readFileSync(path.join(site, match[1]), 'utf8') }
}

test('arrears is a cockpit route instead of a standalone shell route', () => {
  const { name, source } = selectedThemeAsset()
  assert.notEqual(name, 'aph2-theme.js', 'release must use a new immutable APH theme asset')
  assert.match(source, /href:\s*['"]\/arrears['"],\s*label:\s*['"]欠费经营分析['"]/)
  assert.doesNotMatch(source, /targetUrl\.pathname\.startsWith\(['"]\/arrears\/['"]\)/)
})
