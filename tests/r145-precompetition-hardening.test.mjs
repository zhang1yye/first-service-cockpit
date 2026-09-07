import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const payload = path.join(root, 'production-overlays/cockpit-r145-precompetition-hardening-20260829-v1/payload')
const source = name => fs.readFileSync(path.join(payload, name), 'utf8')
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'config/production-runtime-r127.json'), 'utf8'))

test('R145 removes the hidden authenticated shell from the login accessibility tree', () => {
  const script = source('aph2-r145-precompetition-hardening-20260829-v1.js')
  assert.match(script, /location\.pathname === '\/login'/)
  assert.match(script, /node\.inert = true/)
  assert.match(script, /setAttribute\('aria-hidden', 'true'\)/)
  assert.match(script, /\.aph-mobile-more-drawer/)
  assert.match(script, /managed\.clear\(\)/)
  assert.doesNotMatch(script, /setInterval|innerHTML|localStorage|fetch\(/)
})

test('R145 repairs the login brand strip, balanced title, and 44px controls', () => {
  const styles = source('aph2-r145-precompetition-hardening-20260829-v1.css')
  assert.match(styles, /max-width: none/)
  assert.match(styles, /text-wrap: balance/)
  assert.match(styles, /word-break: keep-all/)
  assert.match(styles, /min-height: 44px/)
  assert.match(styles, /min-width: 44px/)
  assert.doesNotMatch(styles, /!important|border-(?:left|right):\s*[2-9]px/)
})

test('R145 production gate starts from deployed R144 and references immutable hardening assets', () => {
  const index = source('index.html')
  assert.equal(runtime.release, 'cockpit-r145-precompetition-hardening-20260829-v1')
  assert.equal(runtime.frontend.indexSha256, 'c97f1fe43a26539f92593ed7558766734754ec298cd5a98f034de892909c3703')
  assert.equal(runtime.frontend.overlayPayload, 'production-overlays/cockpit-r145-precompetition-hardening-20260829-v1/payload')
  assert.match(index, /aph2-r145-precompetition-hardening-20260829-v1\.css\?v=r145-hardening1/)
  assert.match(index, /aph2-r145-precompetition-hardening-20260829-v1\.js\?v=r145-hardening1/)
  assert.match(index, /<link rel="preload" href="\/logo\.png" as="image" \/>/)
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(payload, 'logo.png'))).digest('hex'), '9e8b1bf298809cce48e66a4dd96d74f5a8ec3d793279fe771c7334c3e0997f1b')
})

test('R145 trusts only the loopback proxy and overwrites forwarded client IP for cockpit API traffic', () => {
  const server = fs.readFileSync(path.join(root, 'server/src/index.ts'), 'utf8')
  const limiter = fs.readFileSync(path.join(root, 'server/src/login-rate-limit.ts'), 'utf8')
  const nginx = fs.readFileSync(path.join(root, 'deploy/production/r127/review-system.conf'), 'utf8')
  assert.match(server, /process\.env\.HOST \|\| '127\.0\.0\.1'/)
  assert.match(server, /app\.set\('trust proxy', 'loopback'\)/)
  assert.doesNotMatch(limiter, /req\.headers\[['"]x-forwarded-for['"]\]/)
  for (const block of nginx.matchAll(/location (?:= )?\/api[^\{]*\{[\s\S]*?\n    \}/g)) {
    if (block[0].includes('127.0.0.1:3002')) assert.match(block[0], /proxy_set_header X-Forwarded-For \$remote_addr;/)
  }
})
