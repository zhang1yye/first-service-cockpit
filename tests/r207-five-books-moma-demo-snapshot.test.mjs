import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseName = 'cockpit-r207-five-books-moma-demo-snapshot-20260903-v1'
const release = path.join(root, 'production-overlays', releaseName, 'payload')
const read = (name) => fs.readFileSync(path.join(release, name), 'utf8')
const sha256 = (name) => crypto.createHash('sha256').update(fs.readFileSync(path.join(release, name))).digest('hex')

function readSnapshot() {
  const window = {}
  vm.runInNewContext(read('aph2-r207-five-books-moma-snapshot-20260903-v1.js'), { window })
  return window.__FIVE_BOOKS_MOMA_DEMO_SNAPSHOT__
}

test('R207 publishes an immutable MOMA snapshot without calling the slow live API', () => {
  const index = read('index.html')
  const loader = read('aph2-r207-five-books-demo-loader-20260903-v1.js')
  const module = read('aph2-r207-five-books-demo-20260903-v1.js')

  assert.equal(sha256('index.html'), 'ece2d5b3f120343f5ae441f4afbf0fb58e9456c67689b610983e3d8bd6071185')
  assert.match(index, /aph2-r207-five-books-moma-snapshot-20260903-v1\.js/)
  assert.match(index, /aph2-r207-five-books-demo-loader-20260903-v1\.js/)
  assert.match(index, /aph2-r207-five-books-demo-20260903-v1\.js/)
  assert.doesNotMatch(index, /aph2-r205-five-books-live/)
  assert.match(loader, /__FIVE_BOOKS_R207_LOADER__/)
  assert.match(module, /__FIVE_BOOKS_MOMA_DEMO_SNAPSHOT__/)
  assert.match(module, /暂不请求实时接口/)
  assert.doesNotMatch(module, /fetch\(|\/api\/five-books\/live\//)
})

test('R207 snapshot contains the verified 2026 Q2 MOMA assessment', () => {
  const snapshot = readSnapshot()
  assert.equal(snapshot.year, 2026)
  assert.equal(snapshot.period, 'q2')
  assert.equal(snapshot.subject.name, '北京万国城MOMΛ服务中心')
  assert.equal(snapshot.subject.targetCycle, '2026-06-30')
  assert.equal(snapshot.detail.totalScore, 1.0718)
  assert.equal(snapshot.detail.quarterStarLevel, 5)
  assert.equal(snapshot.detail.books.length, 5)
  assert.equal(snapshot.detail.books.flatMap((book) => book.metrics).length, 12)
  assert.equal(snapshot.detail.books[0].metrics.find((metric) => metric.name === '回款额-计划预算执行').actualValue, 17084326.09)
})

test('R207 preserves the original-resolution presentation media', () => {
  assert.equal(sha256('presentation/ai-competition/media/aph.mp4'), '0cf462dd52f032c82ba1232eb9f85cd4ec18ca72c11eed4b443d657908fdbb3f')
  assert.equal(sha256('presentation/ai-competition/media/lvzai.mp4'), 'f7c725e8369c2d376b3bb9ab9dd35ebcc5f516ec8c599a4b08ef4b8d5695888c')
})
