import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const root = new URL('../production-overlays/cockpit-r195-relaxed-password-creation-20260902-v1/payload/', import.meta.url)
const read = path => fs.readFileSync(new URL(path, root), 'utf8')

test('R195 removes password length and character-composition restrictions in member management', () => {
  const admin = read('assets/cockpit-r195-relaxed-password-creation-20260902-v1/chunk-R65SIMPLEADMIN.js')
  assert.match(admin, /function validPassword\(value\) \{\s*return typeof value === "string" && value\.length > 0;/)
  assert.match(admin, /不限制长度或字符组合；创建后不强制首次改密/)
  assert.match(admin, /不限制长度或字符组合/)
  assert.doesNotMatch(admin, /至少12位，须含字母和数字/)
  assert.doesNotMatch(admin, /minLength: 12/)
})

test('R195 uses a fresh immutable application namespace over the current R194 production baseline', () => {
  const index = read('index.html')
  const bootstrap = read('releases/cockpit-r195-relaxed-password-creation-20260902-v1/aph2-r195-relaxed-password-creation-20260902-v1.js')
  assert.match(index, /assets\/cockpit-r195-relaxed-password-creation-20260902-v1\/app-G7HUEEER\.js/)
  assert.match(index, /releases\/cockpit-r195-relaxed-password-creation-20260902-v1\/aph2-r195-relaxed-password-creation-20260902-v1\.js/)
  assert.match(bootstrap, /assets\/cockpit-r195-relaxed-password-creation-20260902-v1\/app-G7HUEEER\.js/)
  assert.doesNotMatch(index, /assets\/cockpit-r194-five-books-member-read-20260902-v1\/app-G7HUEEER\.js/)
})
