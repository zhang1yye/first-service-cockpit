import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseName = 'cockpit-r208-five-books-north-china-snapshot-20260903-v1'
const release = path.join(root, 'production-overlays', releaseName, 'payload')
const read = (name) => fs.readFileSync(path.join(release, name), 'utf8')
const sha256 = (name) => crypto.createHash('sha256').update(fs.readFileSync(path.join(release, name))).digest('hex')
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'config/production-runtime-r127.json'), 'utf8'))
const route = fs.readFileSync(path.join(root, 'server/src/routes/five-books.ts'), 'utf8')

async function readSnapshot() {
  return (await import(pathToFileURL(path.join(root, 'server/dist/five-books-demo-snapshot.js')).href)).FIVE_BOOKS_DEMO_SNAPSHOT
}

test('R208 publishes the authenticated north-China snapshot without calling the slow upstream API', () => {
  const index = read('index.html')
  const loader = read('aph2-r208-five-books-demo-loader-20260903-v1.js')
  const module = read('aph2-r208-five-books-demo-20260903-v1.js')

  assert.equal(runtime.release, releaseName)
  assert.equal(runtime.frontend.indexSha256, 'd84921d01cf10689d36e03078e93099385d6392892ddec262977eef79793df7c')
  assert.equal(runtime.frontend.overlayPayload, `production-overlays/${releaseName}/payload`)
  assert.equal(sha256('index.html'), runtime.frontend.indexSha256)
  assert.match(index, /aph2-r208-five-books-demo-loader-20260903-v1\.js/)
  assert.match(index, /aph2-r208-five-books-demo-20260903-v1\.js/)
  assert.doesNotMatch(index, /north-china-snapshot.*\.js|aph2-r207-five-books/)
  assert.match(loader, /__FIVE_BOOKS_R208_LOADER__/)
  assert.match(module, /华北地区五书汇报快照/)
  assert.match(module, /\/api\/five-books\/live\/subjects/)
  assert.match(module, /\/api\/five-books\/live\/detail/)
  assert.match(route, /FIVE_BOOKS_DEMO_SNAPSHOT/)
  assert.doesNotMatch(route, /new FiveBooksUpstreamClient/)
})

test('R208 server snapshot contains every verified 2026 Q2 north-China subject and detail', async () => {
  const snapshot = await readSnapshot()
  const headCodes = snapshot.subjects.map((subject) => subject.headCode)
  const metrics = Object.values(snapshot.detailsByHeadCode).flatMap((detail) => detail.books.flatMap((book) => book.metrics))
  assert.equal(snapshot.year, 2026)
  assert.equal(snapshot.period, 'q2')
  assert.equal(snapshot.targetCycle, '2026-06-30')
  assert.equal(snapshot.subjects.length, 46)
  assert.equal(new Set(headCodes).size, 46)
  assert.equal(Object.keys(snapshot.detailsByHeadCode).length, 46)
  assert.ok(snapshot.subjects.every((subject) => subject.structureCode.startsWith('C01020134')))
  assert.ok(snapshot.subjects.every((subject) => snapshot.detailsByHeadCode[subject.headCode]?.name === subject.name))
  assert.ok(Object.values(snapshot.detailsByHeadCode).every((detail) => detail.targetCycle === snapshot.targetCycle))
  assert.equal(metrics.length, 499)

  const moma = snapshot.subjects.find((subject) => /北京万国城MOM/.test(subject.name) && !/通州/.test(subject.name))
  assert.equal(moma.name, '北京万国城MOMΛ服务中心')
  assert.equal(snapshot.detailsByHeadCode[moma.headCode].totalScore, 1.0718)
  assert.equal(snapshot.detailsByHeadCode[moma.headCode].quarterStarLevel, 5)
  assert.ok(Object.values(snapshot.detailsByHeadCode).every((detail) => !detail.executor && !detail.responsible && !detail.accountant && !detail.controller))
})

test('R208 keeps snapshot data behind existing authenticated and scoped routes', () => {
  assert.match(route, /router\.get\('\/api\/five-books\/live\/subjects'/)
  assert.match(route, /router\.get\('\/api\/five-books\/live\/detail'/)
  assert.match(route, /scopedLiveSubjects\(req, snapshot\.subjects\)/)
  assert.match(route, /visible\.some\(\(subject\) => subject\.headCode === headCode\)/)
  assert.match(route, /Cache-Control', 'private, no-store/)
})

test('R208 preserves the original-resolution presentation media', () => {
  assert.equal(sha256('presentation/ai-competition/media/aph.mp4'), '0cf462dd52f032c82ba1232eb9f85cd4ec18ca72c11eed4b443d657908fdbb3f')
  assert.equal(sha256('presentation/ai-competition/media/lvzai.mp4'), 'f7c725e8369c2d376b3bb9ab9dd35ebcc5f516ec8c599a4b08ef4b8d5695888c')
})
