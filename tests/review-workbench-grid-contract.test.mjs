import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const indexPath = path.join(root, 'firstcare-cloud-local', 'index.html')

function activeThemeCss() {
  const index = fs.readFileSync(indexPath, 'utf8')
  const match = index.match(/href=["']([^"']*aph2-theme-[^"']+\.css)["']/)
  assert.ok(match, 'index.html must reference an active aph2 theme CSS asset')
  return {
    href: match[1],
    text: fs.readFileSync(path.join(root, 'firstcare-cloud-local', match[1].replace(/^\.\//, '').replace(/^\//, '')), 'utf8'),
  }
}

test('review workbench switcher spans both columns and does not displace main content', () => {
  const { href, text } = activeThemeCss()
  assert.match(href, /progressive6\.css$/, 'review layout fix must publish a new immutable CSS asset')
  const rule = text.match(/\.aph-review-workbench-switch\s*\{([^}]*)\}/)
  assert.ok(rule, 'active CSS must define the review workbench switcher')
  assert.match(rule[1], /grid-column\s*:\s*1\s*\/\s*-1\s*;/, 'direct grid child switcher must span the complete two-column workbench')
  assert.match(text, /\.review-workbench-shell\[data-review-workbench-mode=["']today["']\]\s+\.review-workbench-main\s*\{[^}]*grid-column\s*:\s*1\s*\/\s*-1\s*;/, 'today mode must use the full workbench width when the operations sidebar is hidden')
  assert.match(text, /\[data-review-workbench-section=["']operations["']\]\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/, 'operations disclosure behavior must remain intact')
})
