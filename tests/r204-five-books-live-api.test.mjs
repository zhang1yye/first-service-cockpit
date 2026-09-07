import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseName = 'cockpit-r204-five-books-live-api-20260902-v1'
const release = path.join(root, 'production-overlays', releaseName, 'payload')
const read = (name) => fs.readFileSync(path.join(release, name), 'utf8')
const sha256 = (name) => crypto.createHash('sha256').update(fs.readFileSync(path.join(release, name))).digest('hex')
test('R204 immutable release publishes the live five-books module over the R203 baseline', () => {
  const index = read('index.html')
  const loader = read('aph2-r204-five-books-live-loader-20260902-v1.js')

  assert.equal(sha256('index.html'), 'de0d6eb29c735ae6227ce049095d49be79d676324cd340499cc362463c92c472')
  assert.match(index, /aph2-r204-five-books-live-loader-20260902-v1\.js/)
  assert.match(index, /aph2-r204-five-books-live-20260902-v1\.js/)
  assert.match(index, /aph2-r202-presentation-entry-20260902-v1\.js/)
  assert.match(index, /aph2-r201-presentation-entry-20260902-v1\.css/)
  assert.match(loader, /__FIVE_BOOKS_R204_LOADER__/)
  assert.match(loader, /__FIVE_BOOKS_R204__/)
})

test('R204 preserves the deployed R203 original-resolution presentation media', () => {
  assert.equal(sha256('presentation/ai-competition/media/aph.mp4'), '0cf462dd52f032c82ba1232eb9f85cd4ec18ca72c11eed4b443d657908fdbb3f')
  assert.equal(sha256('presentation/ai-competition/media/lvzai.mp4'), 'f7c725e8369c2d376b3bb9ab9dd35ebcc5f516ec8c599a4b08ef4b8d5695888c')
})

test('R204 avoids a MutationObserver feedback loop when the navigation label is already correct', () => {
  const live = read('aph2-r204-five-books-live-20260902-v1.js')
  assert.match(live, /if \(leaf && leaf\.textContent !== '五书评估'\) leaf\.textContent = '五书评估'/)
  assert.doesNotMatch(live, /if \(leaf\) leaf\.textContent = '五书评估'/)
})
