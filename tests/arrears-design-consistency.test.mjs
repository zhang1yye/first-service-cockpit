import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local', 'arrears')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const entryJs = fs.readFileSync(path.join(site, 'arrears-entry-20260811-v1.js'), 'utf8')
const embeddedCss = fs.readFileSync(path.join(site, 'arrears-shell-20260811-v4.css'), 'utf8')
const cockpitIndex = fs.readFileSync(path.join(root, 'firstcare-cloud-local', 'index.html'), 'utf8')
const integrationJs = fs.readFileSync(path.join(root, 'firstcare-cloud-local', 'aph2-r52-app-bootstrap-20260812-v1.js'), 'utf8')

function selectedStylesheet() {
  const match = html.match(/href="\/arrears\/(arrears-[^"?]+\.css)"/)
  assert.ok(match, '欠费页必须选择新的不可变版本CSS')
  return fs.readFileSync(path.join(site, match[1]), 'utf8')
}

test('arrears reuses the cockpit shell and only embeds the business content', () => {
  assert.match(cockpitIndex, /aph2-r52-app-bootstrap-20260812-v1\.js/)
  assert.match(integrationJs, /document\.getElementById\(['"]main-content['"]\)/)
  assert.match(integrationJs, /frame\.src\s*=\s*['"]\/arrears\/index\.html\?embedded=1&v=r45-cloudfix1['"]/) 
  assert.match(entryJs, /window\.top\s*===\s*window\.self/)
  assert.match(entryJs, /window\.location\.replace\(['"]\/arrears['"]\)/)
  assert.match(embeddedCss, /\.aph-arrears-embedded \.aph-shell-header/)
  assert.match(embeddedCss, /display:\s*none\s*!important/)
})

test('arrears surfaces use the cockpit light neutral and First Service red design tokens', () => {
  const css = selectedStylesheet()
  assert.match(css, /--aph-red:\s*#e60012/i)
  assert.match(css, /--aph-page:\s*#f4f5f8/i)
  assert.match(css, /--aph-panel:\s*#fff(?:fff)?/i)
  assert.match(css, /\.panel\s*\{[^}]*background:\s*var\(--aph-panel\)/is)
  assert.match(css, /\.primary\s*\{[^}]*background:\s*var\(--aph-red\)/is)
  assert.doesNotMatch(css, /--bg:\s*#07111c|--cyan:\s*#00ccf9/i)
})

test('arrears business content keeps a compact mobile card-based batch table', () => {
  const css = selectedStylesheet()
  assert.match(css, /@media\s*\(max-width:\s*680px\)/i)
  assert.match(css, /\.batches-panel tbody tr\s*\{[^}]*display:\s*grid/is)
  assert.match(css, /\.batches-panel td::before\s*\{[^}]*content:\s*attr\(data-label\)/is)
})
