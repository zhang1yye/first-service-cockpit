import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const payload = path.join(root, 'production-overlays/cockpit-r137-region-map-height-20260827-v1/payload')
const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')
const styles = fs.readFileSync(path.join(payload, 'aph2-r137-region-map-height-20260827-v1.css'), 'utf8')

test('R137 loads the map-height correction after prior production styles', () => {
  const href = '/aph2-r137-region-map-height-20260827-v1.css?v=r137-map-height1'
  assert.match(index, /aph2-r137-region-map-height-20260827-v1\.css\?v=r137-map-height1/)
  assert.ok(index.indexOf(href) > index.indexOf('/aph2-r135-hide-data-basis-20260827-v1.css'))
})

test('R137 makes desktop province cards share the map height', () => {
  assert.match(styles, /@media \(min-width: 1024px\)/)
  assert.match(styles, /> \.col-span-4\.flex\.flex-col\.gap-2 > a\.card-soft/)
  assert.match(styles, /flex: 1 1 0%/)
  assert.match(styles, /min-height: 0/)
  assert.match(styles, /justify-content: center/)
})

test('R137 does not force equal-height cards on narrow viewports', () => {
  const outsideDesktopRule = styles.replace(/@media \(min-width: 1024px\) \{[\s\S]*\n\}/, '')
  assert.doesNotMatch(outsideDesktopRule, /flex: 1 1 0%/)
})
