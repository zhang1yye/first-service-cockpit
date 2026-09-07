import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../firstcare-cloud-local/', import.meta.url)

test('R67 在 641–1023px 隐藏无法完整容纳的分源状态', async () => {
  const css = await readFile(
    new URL('aph2-r67-responsive-clipping-safe-area-20260813-v1.css', root),
    'utf8',
  )

  assert.match(css, /@media\s*\(min-width:\s*641px\)\s*and\s*\(max-width:\s*1023px\)/)
  assert.match(css, /body\.aph2-theme[\s\S]*header\.sticky\.top-0[\s\S]*\.aph-header-status\.r7-unified-source-host/)
  assert.match(css, /display:\s*none\s*!important/)
})

test('R67 在精确 640px 对齐 AI 页面 gutter', async () => {
  const css = await readFile(
    new URL('aph2-r67-responsive-clipping-safe-area-20260813-v1.css', root),
    'utf8',
  )

  assert.match(css, /@media\s*\(min-width:\s*640px\)\s*and\s*\(max-width:\s*640px\)/)
  assert.match(css, /data-r42-route="ai-alerts"[\s\S]*data-r56-ai-center-app/)
  assert.match(css, /margin-inline:\s*-12px\s*!important/)
  assert.match(css, /padding-inline:\s*12px\s*!important/)
})

test('R67 只改响应式裁切，不触碰导航、数据和受保护业务页', async () => {
  const css = await readFile(
    new URL('aph2-r67-responsive-clipping-safe-area-20260813-v1.css', root),
    'utf8',
  )

  assert.doesNotMatch(css, /main#main-content|aph-exact-sidebar|aph-page-tabs/)
  assert.doesNotMatch(css, /fetch|XMLHttpRequest|\/api\/|businessDate|collectionRate/)
  assert.doesNotMatch(css, /\/daily|\/payment|\/collection/)
})
