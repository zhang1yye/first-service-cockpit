import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import test from 'node:test'

const root = new URL('../production-overlays/cockpit-r198-fsoc-brand-lockups-20260902-v1/payload/', import.meta.url)
const read = path => fs.readFileSync(new URL(path, root), 'utf8')

test('R198 spells the fixed cockpit brand title as 经营驾驶舱 on desktop and mobile', () => {
  const shell = read('assets/cockpit-r198-fsoc-brand-lockups-20260902-v1/chunk-4UXV2DAK.js')
  const head = read('assets/cockpit-bundle-head-r198-20260902.js')
  assert.doesNotMatch(shell, /\\u8230|经营驾驶舰/)
  assert.match(shell, /alt: "FSOC"[\s\S]*children: "\\u7ECF\\u8425\\u9A7E\\u9A76\\u8231"/)
  assert.match(head, /alt="FSOC"><span class="aph-fsoc-brand-title">经营驾驶舱<\/span>/)
})

test('R198 uses a fresh immutable namespace over the published R197 baseline', () => {
  const index = read('index.html')
  assert.equal(
    crypto.createHash('sha256').update(index).digest('hex'),
    'f1be07ed0f078bbde0f188d408431c6338d771bb1f53f4f2cf0167718f79490a'
  )
  assert.match(index, /assets\/cockpit-r198-fsoc-brand-lockups-20260902-v1\/app-G7HUEEER\.js/)
  assert.match(index, /assets\/cockpit-bundle-head-r198-20260902\.js/)
  assert.match(index, /aph2-r198-fsoc-brand-lockups-20260902-v1\.css/)
  assert.match(index, /releases\/cockpit-r198-fsoc-brand-lockups-20260902-v1\/aph2-r198-fsoc-brand-lockups-20260902-v1\.js/)
})
