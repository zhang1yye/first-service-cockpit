import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const script = fs.readFileSync(path.join(site, 'aph2-payment-layout-20260810-v1.js'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-payment-layout-20260810-v1.css'), 'utf8')

test('回款额明细使用独立的视口高度规则', () => {
  assert.match(html, /aph2-payment-layout-20260810-v1\.js/)
  assert.match(html, /aph2-payment-layout-20260810-v1\.css/)
  assert.match(script, /window\.location\.pathname === '\/payment'/)
  assert.match(script, /aph-payment-route/)
  assert.match(css, /body\.aph2-theme\.aph-payment-route \.aph-service-center-scroll/)
  assert.match(css, /clamp\(520px, calc\(100dvh - 220px\), 820px\)/)
})

test('移动端仍使用原有长表格高度规则', () => {
  assert.match(css, /@media \(min-width: 641px\)/)
  assert.doesNotMatch(css, /max-width:\s*640px/)
})
