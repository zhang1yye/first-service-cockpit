import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const payloadRoot = new URL('../production-overlays/cockpit-r202-presentation-hard-navigation-20260902-v1/payload/', import.meta.url)
const read = file => fs.readFileSync(new URL(file, payloadRoot), 'utf8')

test('R202 selects the immutable routing correction overlay', () => {
  const index = read('index.html')
  const login = read('login.html')
  assert.match(index, /aph2-r202-presentation-entry-20260902-v1\.js/)
  assert.doesNotMatch(index, /aph2-r201-presentation-entry-20260902-v1\.js/)
  assert.match(login, /aph2-r202-login-shell-presentation-20260902-v1\.js/)
})

test('R202 forces the separate report document to load before SPA interception', () => {
  const script = read('aph2-r202-presentation-entry-20260902-v1.js')
  assert.match(script, /bindHardNavigation/)
  assert.match(script, /addEventListener\('click',[\s\S]*true\)/)
  assert.match(script, /normalizedPath !== '\/presentation\/ai-competition'/)
  assert.match(script, /event\.preventDefault\(\)/)
  assert.match(script, /event\.stopImmediatePropagation\(\)/)
  assert.match(script, /window\.location\.assign/)
})

test('R202 preserves the report return target after an unauthenticated login', () => {
  const loginShell = read('aph2-r202-login-shell-presentation-20260902-v1.js')
  assert.match(loginShell, /allowedRoutes = new Set\(\[[\s\S]*'\/presentation\/ai-competition'/)
  assert.match(loginShell, /location\.replace\(requestedTarget\(payload\.user\)\)/)
})

test('R202 keeps the R200 report and media payload intact', () => {
  for (const file of [
    'presentation/ai-competition/index.html',
    'presentation/ai-competition/presentation.js',
    'presentation/ai-competition/presentation.css',
    'presentation/ai-competition/media/aph.mp4',
    'presentation/ai-competition/media/lvzai.mp4',
  ]) assert.ok(fs.existsSync(new URL(file, payloadRoot)), `missing ${file}`)
})
