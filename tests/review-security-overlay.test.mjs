import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const formerSharedSecret = [70,105,114,115,116,49,50,51,52,53,54].map(code => String.fromCharCode(code)).join('')
const activeReviewChunk = fs.readFileSync(path.join(root, 'firstcare-cloud-local/assets/sortfix-20260806-sitefix1/chunk-X37Z5P5X.js'), 'utf8')
const reviewServer = fs.readFileSync(path.join(root, 'review-system/active/backend/server.js'), 'utf8')

test('active cockpit review bundle contains no shared credential and uses one-time server credentials', () => {
  const activeBundleDirectory = path.join(root, 'firstcare-cloud-local/assets/sortfix-20260806-sitefix1')
  const exposedHits = fs.readdirSync(activeBundleDirectory)
    .filter(name => name.endsWith('.js'))
    .filter(name => fs.readFileSync(path.join(activeBundleDirectory, name)).includes(formerSharedSecret))
  assert.deepEqual(exposedHits, [])
  assert.match(activeReviewChunk, /temporaryPassword/)
  assert.match(activeReviewChunk, /confirmText: "\\u91CD\\u7F6E\\u8D26\\u53F7\\u5BC6\\u7801"/)
  assert.match(activeReviewChunk, /disabled: p\.role !==/)
})

test('the complete public cockpit static tree contains no former shared credential', () => {
  const publicRoot = path.join(root, 'firstcare-cloud-local')
  const pending = [publicRoot]
  const exposedHits = []
  while (pending.length) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(target)
      else if (entry.isFile() && fs.readFileSync(target).includes(formerSharedSecret)) exposedHits.push(path.relative(publicRoot, target))
    }
  }
  assert.deepEqual(exposedHits, [])
})

test('review API generates credentials, prevents caching, and fails closed for missing hashes', () => {
  assert.match(reviewServer, /generateTemporaryPassword\(\)/)
  assert.match(reviewServer, /Cache-Control', 'no-store'/)
  assert.match(reviewServer, /credentialRecoveryRequired = true/)
  assert.match(reviewServer, /nextUser\.status = '停用'/)
  assert.match(reviewServer, /temporaryCredentialConsumedAt/)
  assert.match(reviewServer, /mustChangePassword: normalizedRole !== '管理员'/)
  assert.equal(reviewServer.includes(`password = '${formerSharedSecret}'`), false)
})

test('fresh standalone review frontend build contains no former shared credential', () => {
  const dist = path.join(root, 'review-system/active/frontend/dist')
  const files = fs.readdirSync(path.join(dist, 'assets')).map(name => path.join(dist, 'assets', name))
  const hits = files.filter(file => fs.statSync(file).isFile() && fs.readFileSync(file).includes(formerSharedSecret))
  assert.deepEqual(hits, [])
})
