import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const overlay = path.join(root, 'production-overlays/cockpit-r130-frontend-performance-20260826-v1/payload')
const index = fs.readFileSync(path.join(overlay, 'index.html'), 'utf8')
const controller = fs.readFileSync(path.join(overlay, 'aph2-r130-performance-controller-20260826-v1.js'), 'utf8')
const styles = fs.readFileSync(path.join(overlay, 'aph2-r130-runtime-optimized-20260826-v1.css'), 'utf8')
const distillation = fs.readFileSync(path.join(overlay, 'aph2-r128-screenshot-distillation-20260826-v1.js'), 'utf8')
const capabilities = fs.readFileSync(path.join(overlay, 'aph2-r90-operating-capabilities-20260816-v1.js'), 'utf8')
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'config/production-runtime-r127.json'), 'utf8'))
const builder = fs.readFileSync(path.join(root, 'scripts/build-production-release.mjs'), 'utf8')

test('R130 reduces global stylesheet requests without changing cascade order after the main bundle', () => {
  const stylesheets = [...index.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(match => match[1])
  assert.equal(stylesheets.length, 6)
  assert.ok(stylesheets.includes('/aph2-r130-runtime-optimized-20260826-v1.css?v=r130-perf1'))
  assert.ok(index.indexOf('/assets/cockpit-bundle-20260816-r89-ai-opinion.css') < index.indexOf('/aph2-r130-runtime-optimized-20260826-v1.css'))
  assert.equal((styles.match(/\/\* source:/g) || []).length, 14)
})

test('R130 reserves async capability space and primes the final home grid before first paint', () => {
  assert.match(controller, /CAPABILITY_HOST_ID/)
  assert.match(index, /<section id="aph-r90-operating-capabilities-host"/)
  assert.match(controller, /insertAdjacentElement\('afterend', host\)/)
  assert.match(controller, /function primeHomeLayout\(\)/)
  assert.match(controller, /root\.classList\.add\('aph-home-reflow'\)/)
  assert.match(controller, /loading\?\.classList\.add\('aph-r130-home-loading-slot'\)/)
  assert.match(controller, /following\[1\]\?\.classList\.add\('aph-home-ranking-grid'\)/)
  assert.match(controller, /r130HomePrimed/)
  assert.match(styles, /data-r130-capability-route/)
  assert.match(styles, /aph-r130-home-loading-slot/)
  assert.match(styles, /min-height: 628px/)
  assert.match(styles, /min-height: 64px/)
  assert.doesNotMatch(styles, /data-r130-home-pending/)
  assert.doesNotMatch(capabilities, /document\.getElementById\(FALLBACK_HOST_ID\)\?\.remove\(\)/)
  assert.match(capabilities, /existingHost\.replaceChildren\(\)/)
})

test('R130 lazy-loads five-books resources only for command and bounds repeated DOM scans', () => {
  assert.doesNotMatch(index, /<script src="\/five-books-standard-pm5-xx-68-v1\.js/)
  assert.doesNotMatch(index, /<script src="\/aph2-r114-five-books-evaluation-20260824-v1\.js/)
  assert.match(controller, /route\(\) !== FIVE_BOOKS_ROUTE/)
  assert.match(controller, /five-books-standard-pm5-xx-68-v1\.js\?v=r130-lazy1/)
  assert.match(controller, /aph2-r114-five-books-evaluation-20260824-v1\.js\?v=r130-lazy1/)
  assert.match(distillation, /data-aph-r128-hidden="payment-back-link"/)
  assert.match(distillation, /data-aph-r128-hidden="collection-table-heading"/)
})

test('R142 release gate expects the currently deployed R141 hashes', () => {
  assert.equal(runtime.release, 'cockpit-r142-qxm-sharded-evidence-20260828-v1')
  assert.equal(runtime.frontend.indexSha256, 'dbf13c07d27a17c997819d02801b4aefc5716c37e1b652c8f44bc0798ab2ebba')
  assert.equal(runtime.backend.distIndexSha256, '7cc0fd245756e70eb1664dbd8de5bcd0f0dcd0a15d7a23fe08e825b70d76c9bb')
  assert.equal(runtime.frontend.overlayPayload, 'production-overlays/cockpit-r142-qxm-sharded-evidence-20260828-v1/payload')
  assert.match(builder, /runtime\.frontend\?\.indexSha256 \|\| baseline\.indexSha256/)
})
