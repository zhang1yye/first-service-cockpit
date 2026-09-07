import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const overlay = path.join(root, 'production-overlays/cockpit-r156-known-defects-fix-20260830-v1/payload')
const index = fs.readFileSync(path.join(overlay, 'index.html'), 'utf8')
const distillation = fs.readFileSync(path.join(overlay, 'aph2-r155-screenshot-distillation-arrears-scope-20260830-v1.js'), 'utf8')
const html = fs.readFileSync(path.join(overlay, 'login.html'), 'utf8')
const css = fs.readFileSync(path.join(overlay, 'aph2-r153-login-aph2-alignment-20260830-v1.css'), 'utf8')
const js = fs.readFileSync(path.join(overlay, 'aph2-r153-login-shell-20260830-v1.js'), 'utf8')
const nginx = fs.readFileSync(path.join(root, 'deploy/production/r127/review-system.conf'), 'utf8')
const builder = fs.readFileSync(path.join(root, 'scripts/build-production-release.mjs'), 'utf8')

const resourceReferences = [...new Set([...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(match => match[1]))]

test('login route has a bounded standalone shell without business bundles', () => {
  assert.deepEqual(resourceReferences.sort(), [
    '/aph2-r153-login-aph2-alignment-20260830-v1.css',
    '/aph2-r153-login-shell-20260830-v1.js',
    '/aph2-r153-brand-lockup.jpg',
    '/favicon.svg',
  ].sort())
  assert.doesNotMatch(html, /cockpit-r126|cockpit-bundle|operating-capabilities|north-ai-assistant|modulepreload/)
  assert.doesNotMatch(html, /<script[^>]*>\s*[^<]/)
  assert.doesNotMatch(html, /style=|on(?:click|submit|load)=/i)
  const shellBytes = Buffer.byteLength(html) + Buffer.byteLength(css) + Buffer.byteLength(js)
    + fs.statSync(path.join(overlay, 'aph2-r153-brand-lockup.jpg')).size
  assert.ok(shellBytes < 32_000, `login shell must stay below 32KB before favicon; got ${shellBytes}`)
})

test('login shell follows the incumbent APH2 light visual contract', () => {
  assert.match(html, /name="theme-color" content="#f5f6fa"/)
  assert.match(css, /color-scheme: light/)
  assert.match(css, /--aph-red: #e60012/)
  assert.match(css, /--aph-canvas: #f5f6fa/)
  assert.match(css, /background: var\(--aph-surface\)/)
  assert.match(css, /\.login-brandbar[\s\S]*height: 52px[\s\S]*background: #050505/)
  assert.doesNotMatch(css, /color-scheme: dark/)
})

test('arrears route keeps the native R126 workspace and scopes screenshot distillation below its root', () => {
  assert.match(index, /cockpit-r126-arrears-ai-workflow-20260826-v2/)
  assert.match(index, /aph2-r155-screenshot-distillation-arrears-scope-20260830-v1\.js/)
  assert.doesNotMatch(index, /aph2-r128-screenshot-distillation-20260826-v1\.js/)
  assert.doesNotMatch(index, /aph2-r144-manual-arrears-diagnosis/)
  assert.doesNotMatch(index, /aph2-r153-arrears-blank-guard/)
  assert.match(distillation, /steps\.contains\(title\)/)
  assert.match(distillation, /if \(!unsafe\)/)
  assert.doesNotMatch(distillation, /hide\(candidate, 'arrears-workflow-hero'\)/)
})

test('login shell preserves the authenticated SPA contract and fails safely', () => {
  assert.match(js, /fetch\('\/api\/auth\/login'/)
  assert.match(js, /localStorage\.setItem\('cockpit_token', payload\.token\)/)
  assert.match(js, /localStorage\.setItem\('cockpit_user', JSON\.stringify\(payload\.user\)\)/)
  assert.match(js, /target\.origin !== location\.origin/)
  assert.match(js, /user\?\.role !== 'admin'/)
  assert.match(js, /location\.replace\(requestedTarget\(payload\.user\)\)/)
  assert.doesNotMatch(js, /https?:\/\//)
  assert.doesNotMatch(js, /innerHTML|eval\(|document\.write/)
})

test('login shell keeps labels, error announcement, keyboard focus and touch sizing', () => {
  assert.match(html, /<label for="username">用户名<\/label>/)
  assert.match(html, /<label for="password">密码<\/label>/)
  assert.match(html, /role="alert" aria-live="polite"/)
  assert.match(html, /aria-label="显示登录密码"/)
  assert.match(css, /min-height: 46px/)
  assert.match(css, /\.password-toggle[\s\S]*width: 44px[\s\S]*min-height: 44px/)
  assert.match(css, /:focus-visible/)
  assert.match(css, /prefers-reduced-motion: reduce/)
})

test('nginx serves login.html only on exact login routes before the SPA fallback', () => {
  const exactLogin = nginx.indexOf('location = /login {')
  const spaRoutes = nginx.indexOf('location ~ ^/(?:command|payment|collection')
  assert.ok(exactLogin >= 0 && exactLogin < spaRoutes)
  assert.match(nginx, /location = \/login \{[\s\S]*try_files \/login\.html =404;/)
  assert.match(nginx, /location = \/login\/ \{ return 302 \/login\$is_args\$args; \}/)
  assert.match(nginx, /location = \/login\.html \{ return 302 \/login\$is_args\$args; \}/)
  assert.match(builder, /const htmlFiles = overlayFiles\.filter/)
  assert.match(builder, /前端增量未被HTML入口引用/)
})
