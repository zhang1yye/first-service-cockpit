import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import test from 'node:test'

const root = new URL('../production-overlays/cockpit-r197-fsoc-brand-lockups-20260902-v1/payload/', import.meta.url)
const read = path => fs.readFileSync(new URL(path, root))
const text = path => read(path).toString('utf8')
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

test('R197 publishes the supplied login lockup and a bounded FSOC-only cockpit mark', () => {
  const light = read('fsoc-first-service-lockup-light-r197.png')
  const mark = read('assets/cockpit-r197-fsoc-brand-lockups-20260902-v1/fsoc-mark-dark-r197.png')
  assert.equal(sha256(light), '5c0cafdd920096c5758e9a70c62f456390467ad8694800418615e60188048c0b')
  assert.equal(light.readUInt32BE(16), 1380)
  assert.equal(light.readUInt32BE(20), 520)
  assert.equal(sha256(mark), '71e4c0601cdc2b0509c2ff4fe75fd821d08ec6ea236baf7d147b5f5aa9ddfe80')
  assert.equal(mark.readUInt32BE(16), 530)
  assert.equal(mark.readUInt32BE(20), 480)
})

test('R197 adds the combination lockup to login and uses only FSOC inside cockpit', () => {
  const login = text('login.html')
  const loginCss = text('aph2-r197-login-brand-lockup-20260902-v1.css')
  const cockpitCss = text('aph2-r197-fsoc-brand-lockups-20260902-v1.css')
  const shell = text('assets/cockpit-r197-fsoc-brand-lockups-20260902-v1/chunk-4UXV2DAK.js')
  const head = text('assets/cockpit-bundle-head-r197-20260902.js')
  const reviewCore = text('assets/cockpit-r197-fsoc-brand-lockups-20260902-v1/review-core-r126.js')
  assert.match(login, /class="login-primary-logo" src="\/fsoc-first-service-lockup-light-r197\.png"/)
  assert.match(login, /alt="FSOC经营驾驶舱与第一服务组合标" width="345" height="130"/)
  assert.match(login, /aph2-r197-login-brand-lockup-20260902-v1\.css/)
  assert.match(loginCss, /\.login-primary-logo[\s\S]*width: min\(310px, 100%\)[\s\S]*height: auto/)
  const loginShellBytes = Buffer.byteLength(login) + Buffer.byteLength(loginCss)
    + read('aph2-r153-login-shell-20260830-v1.js').length
    + read('aph2-r153-brand-lockup.jpg').length + read('fsoc-first-service-lockup-light-r197.png').length
  assert.ok(loginShellBytes < 128 * 1024, `login shell must stay below 128KiB; got ${loginShellBytes}`)
  assert.match(cockpitCss, /\.aph-top-brand[\s\S]*width: 120px[\s\S]*gap: 8px[\s\S]*justify-content: center/)
  assert.match(cockpitCss, /fsoc-mark-dark-r197\.png[\s\S]*width: 36px[\s\S]*height: 34px/)
  assert.match(cockpitCss, /\.aph-fsoc-brand-title[\s\S]*white-space: nowrap/)
  assert.match(shell, /alt: "FSOC"[\s\S]*children: "\\u7ECF\\u8425\\u9A7E\\u9A76\\u8230"/)
  assert.match(head, /alt="FSOC"><span class="aph-fsoc-brand-title">经营驾驶舱<\/span>/)
  assert.equal(shell.match(/src: "\/assets\/cockpit-r197-fsoc-brand-lockups-20260902-v1\/fsoc-mark-dark-r197\.png"/g)?.length, 2)
  assert.equal(head.match(/\/assets\/cockpit-r197-fsoc-brand-lockups-20260902-v1\/fsoc-mark-dark-r197\.png/g)?.length, 2)
  assert.equal(reviewCore.match(/\/assets\/cockpit-r197-fsoc-brand-lockups-20260902-v1\/fsoc-mark-dark-r197\.png/g)?.length, 4)
  assert.doesNotMatch(`${shell}\n${head}\n${reviewCore}`, /aph-icons\/aph-brand-lockup\.jpg|src: "\/logo\.png"/)
})

test('R197 uses an immutable app namespace over the R195 production baseline', () => {
  const index = text('index.html')
  const bootstrap = text('releases/cockpit-r197-fsoc-brand-lockups-20260902-v1/aph2-r197-fsoc-brand-lockups-20260902-v1.js')
  assert.match(index, /assets\/cockpit-r197-fsoc-brand-lockups-20260902-v1\/app-G7HUEEER\.js/)
  assert.match(index, /assets\/cockpit-bundle-head-r197-20260902\.js/)
  assert.match(index, /aph2-r197-fsoc-brand-lockups-20260902-v1\.css/)
  assert.match(index, /releases\/cockpit-r197-fsoc-brand-lockups-20260902-v1\/aph2-r197-fsoc-brand-lockups-20260902-v1\.js/)
  assert.match(bootstrap, /assets\/cockpit-r197-fsoc-brand-lockups-20260902-v1\/app-G7HUEEER\.js/)
})
