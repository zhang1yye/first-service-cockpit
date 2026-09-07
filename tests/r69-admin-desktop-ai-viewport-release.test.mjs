import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const site = new URL('../firstcare-cloud-local/', import.meta.url)
const r69Url = new URL('aph2-r69-admin-desktop-ai-viewport-20260813-v1.css', site)
const r64Url = new URL('aph2-r64-ai-header-all-viewports-20260813-v1.css', site)

test('R69 逐行锁定桌面后台顶栏的 fixed/inset 几何', async () => {
  const css = await readFile(r69Url, 'utf8')

  assert.deepEqual(css.split('\n'), [
    '/* R69：恢复后台桌面顶栏的固定几何，避免 AI 入口被相对定位推出视口。 */',
    '@media (min-width: 641px) {',
    '  body[data-r64-ai-header].aph2-theme.aph-admin-page',
    '    #root header.aph-admin-shell-header.aph-r64-ai-host {',
    '    position: fixed !important;',
    '    inset: 0 0 auto 60px !important;',
    '  }',
    '}',
    '',
  ])
})

test('R69 保留 R64 的右侧安全区与 AI 按钮位置', async () => {
  const [r69, r64] = await Promise.all([
    readFile(r69Url, 'utf8'),
    readFile(r64Url, 'utf8'),
  ])

  assert.match(
    r64,
    /header\.aph-admin-shell-header\.aph-r64-ai-host\s*\{[\s\S]*?padding-right:\s*72px\s*!important/,
  )
  assert.match(
    r64,
    /button\.aph-r64-ai-launcher\[data-r64-placement="admin"\]\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*3px;[\s\S]*?right:\s*16px;/,
  )
  assert.doesNotMatch(r69, /padding-right|aph-r64-ai-launcher|\bright\s*:|\btop\s*:/)
})

test('R69 只修复 >=641px admin shell 显示几何', async () => {
  const css = await readFile(r69Url, 'utf8')

  assert.equal((css.match(/@media/g) || []).length, 1)
  assert.match(css, /@media\s*\(min-width:\s*641px\)/)
  assert.doesNotMatch(css, /max-width|@media\s*\(max-width/)
  assert.doesNotMatch(
    css,
    /main#main-content|aph-exact-sidebar|aph-page-tabs|aph-mobile|\/daily|\/payment|\/collection/,
  )
  assert.doesNotMatch(css, /fetch\s*\(|XMLHttpRequest|\/api\/|businessDate|collectionRate/)
})
