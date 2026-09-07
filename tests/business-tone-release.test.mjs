import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
test('用户否定的业务化视觉层保持回滚状态', () => {
  assert.match(html, /north-ai-assistant-20260806-sitefix1\.css/)
  assert.doesNotMatch(html, /aph2-business-tone-20260810-v1\.css/)
})
