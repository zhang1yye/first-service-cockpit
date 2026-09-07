import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = 'cockpit-r193-five-books-formal-activation-20260902-v1'
const payload = path.join(root, 'production-overlays', release, 'payload')
const index = fs.readFileSync(path.join(payload, 'index.html'), 'utf8')
const loader = fs.readFileSync(path.join(payload, 'aph2-r193-performance-five-books-loader-20260902-v1.js'), 'utf8')
const evaluation = fs.readFileSync(path.join(payload, 'assets/r193-five-books/aph2-r193-five-books-evaluation-20260902-v1.js'), 'utf8')
const standard = fs.readFileSync(path.join(payload, 'assets/r193-five-books/five-books-standard-pm5-xx-68-r193-20260902-v1.js'), 'utf8')
const css = fs.readFileSync(path.join(payload, 'aph2-r193-five-books-evaluation-20260902-v1.css'), 'utf8')
const route = fs.readFileSync(path.join(root, 'server/src/routes/five-books.ts'), 'utf8')
const sha = value => crypto.createHash('sha256').update(value).digest('hex')

test('R193将五书标准、界面、样式和按需加载器纳入不可变候选', () => {
  assert.equal(sha(index), '416461b3f8858fbc2a771dcbd799d8a7ce9112d39bdfcda201ea49cd60e0d5df')
  assert.match(index, /aph2-r193-performance-five-books-loader-20260902-v1\.js/)
  assert.match(index, /aph2-r193-five-books-evaluation-20260902-v1\.css/)
  assert.doesNotMatch(index, /aph2-r130-performance-controller/)
  assert.match(loader, /route\(\) !== FIVE_BOOKS_ROUTE/)
  assert.match(loader, /assets\/r193-five-books\/five-books-standard-pm5-xx-68-r193-20260902-v1\.js/)
  assert.match(loader, /assets\/r193-five-books\/aph2-r193-five-books-evaluation-20260902-v1\.js/)
  assert.equal(sha(standard), '36f06e28aad47a88019354e729532950e91c0489a78d4a227046708eb289f0ff')
  assert.match(standard, /"standardCode": "PM5-XX-68"/)
  assert.match(standard, /"managementStandardCode": "PM4-XX-48"/)
  assert.match(evaluation, /window\.__FIVE_BOOKS_R193__/)
  assert.match(evaluation, /const canWrite = \(\) => currentUser\(\)\.role === 'admin'/)
  assert.match(css, /#five-books-evaluation-r114/)
  assert.match(css, /@media print/)
})

test('R193五书写接口显式管理员门禁，证据目录和下载完整性失败关闭', () => {
  assert.match(route, /router\.put\('\/api\/five-books\/records', requireAdmin/)
  assert.match(route, /router\.post\('\/api\/five-books\/review', requireAdmin/)
  assert.match(route, /router\.post\('\/api\/five-books\/evidence', requireAdmin, upload\.single/)
  assert.match(route, /router\.post\('\/api\/five-books\/import', requireAdmin, upload\.single/)
  assert.match(route, /stat\.isSymbolicLink\(\) \|\| !stat\.isDirectory\(\)/)
  assert.match(route, /五书证据目录在运行期间发生漂移/)
  assert.match(route, /flag: 'wx'/)
  assert.match(route, /actualSha256 !== row\.sha256/)
  assert.match(route, /证据文件完整性校验失败/)
})
