import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const serverEntry = fs.readFileSync(path.join(root, 'server/src/index.ts'), 'utf8')
const fiveBooksRoute = fs.readFileSync(path.join(root, 'server/src/routes/five-books.ts'), 'utf8')
const overlay = path.join(root, 'production-overlays/cockpit-r156-known-defects-fix-20260830-v1/payload')
const index = fs.readFileSync(path.join(overlay, 'index.html'), 'utf8')

function pngSize(file: string) {
  const data = fs.readFileSync(file)
  assert.equal(data.subarray(1, 4).toString('ascii'), 'PNG')
  assert.equal(data.subarray(12, 16).toString('ascii'), 'IHDR')
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

test('five-books router is mounted behind authentication and the global member write guard', () => {
  const authentication = serverEntry.indexOf('app.use(requireAuth)')
  const memberWriteGuard = serverEntry.indexOf("const readOnlyPost = req.method === 'POST'")
  const mount = serverEntry.indexOf('app.use(fiveBooksRouter)')
  assert.match(serverEntry, /import fiveBooksRouter from '\.\/routes\/five-books\.js'/)
  assert.ok(authentication >= 0 && authentication < mount)
  assert.ok(memberWriteGuard >= 0 && memberWriteGuard < mount)
  assert.match(fiveBooksRoute, /router\.get\('\/api\/five-books\/subjects'/)
  assert.match(fiveBooksRoute, /router\.get\('\/api\/five-books\/aph-status'/)
})

test('release contains the requested review icon and explicit Apple touch icons', () => {
  const reviewIcon = path.join(overlay, 'aph-icons/hehuoren.png')
  const appleIcon = path.join(overlay, 'apple-touch-icon.png')
  const precomposedIcon = path.join(overlay, 'apple-touch-icon-precomposed.png')
  assert.ok(fs.statSync(reviewIcon).isFile())
  assert.deepEqual(pngSize(reviewIcon), { width: 32, height: 32 })
  assert.deepEqual(pngSize(appleIcon), { width: 180, height: 180 })
  assert.deepEqual(pngSize(precomposedIcon), { width: 180, height: 180 })
  assert.match(index, /rel="apple-touch-icon" href="\/apple-touch-icon\.png"/)
  assert.match(index, /rel="apple-touch-icon-precomposed" href="\/apple-touch-icon-precomposed\.png"/)
})
