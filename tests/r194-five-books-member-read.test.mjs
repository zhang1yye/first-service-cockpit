import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const root = new URL('../production-overlays/cockpit-r194-five-books-member-read-20260902-v1/payload/', import.meta.url)
const read = (path) => fs.readFileSync(new URL(path, root), 'utf8')

test('R194 gives authenticated members read access to the five-books command route', () => {
  const chunk = read('assets/cockpit-r194-five-books-member-read-20260902-v1/chunk-7C7IT5GR.js')
  assert.match(chunk, /var _d = \["\/", "\/command", "\/payment"/)
  assert.match(chunk, /var Ad = \["\/admin", "\/import", "\/review"\]/)
})

test('R194 uses a fresh immutable application namespace and keeps R193 activation assets', () => {
  const index = read('index.html')
  const bootstrap = read('releases/cockpit-r194-five-books-member-read-20260902-v1/aph2-r194-five-books-member-read-20260902-v1.js')
  assert.match(index, /assets\/cockpit-r194-five-books-member-read-20260902-v1\/app-G7HUEEER\.js/)
  assert.match(index, /releases\/cockpit-r194-five-books-member-read-20260902-v1\/aph2-r194-five-books-member-read-20260902-v1\.js/)
  assert.match(index, /aph2-r193-performance-five-books-loader-20260902-v1\.js/)
  assert.match(bootstrap, /assets\/cockpit-r194-five-books-member-read-20260902-v1\/app-G7HUEEER\.js/)
  assert.doesNotMatch(bootstrap, /assets\/cockpit-r192-authenticated-home-parity-20260902-v1\/app-G7HUEEER\.js/)
})
