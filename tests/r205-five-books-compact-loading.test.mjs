import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseName = 'cockpit-r205-five-books-compact-loading-20260902-v1'
const release = path.join(root, 'production-overlays', releaseName, 'payload')
const read = (name) => fs.readFileSync(path.join(release, name), 'utf8')
const sha256 = (name) => crypto.createHash('sha256').update(fs.readFileSync(path.join(release, name))).digest('hex')

test('R205 removes the oversized five-books document header during slow API loading', () => {
  const index = read('index.html')
  const live = read('aph2-r205-five-books-live-20260902-v1.js')

  assert.equal(sha256('index.html'), '94098489befdbcc89b0ffa0a3160c0b3fa26b661b43f610fb9270bd5debc3583')
  assert.match(index, /aph2-r205-five-books-live-loader-20260902-v1\.js/)
  assert.match(index, /aph2-r205-five-books-live-20260902-v1\.js/)
  assert.doesNotMatch(index, /aph2-r204-five-books-live-loader-20260902-v1\.js/)
  assert.doesNotMatch(live, /fb-document-header/)
  assert.doesNotMatch(live, /<dt>执行人<\/dt>|<dt>责任人<\/dt>|<dt>核算人<\/dt>|<dt>控制人<\/dt>/)
  assert.match(live, /正在从第一资产五书正式接口读取/)
  assert.match(live, /\/api\/five-books\/live\/subjects/)
  assert.match(live, /\/api\/five-books\/live\/detail/)
})

test('R205 preserves the R203 original-resolution presentation media', () => {
  assert.equal(sha256('presentation/ai-competition/media/aph.mp4'), '0cf462dd52f032c82ba1232eb9f85cd4ec18ca72c11eed4b443d657908fdbb3f')
  assert.equal(sha256('presentation/ai-competition/media/lvzai.mp4'), 'f7c725e8369c2d376b3bb9ab9dd35ebcc5f516ec8c599a4b08ef4b8d5695888c')
})
