import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../firstcare-cloud-local/', import.meta.url)

test('R57 保持所有桌面路由的内容几何不受展开侧栏影响', async () => {
  const [html, css, js] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('aph2-r57-sidebar-safe-area-20260812-v1.css', root), 'utf8'),
    readFile(new URL('aph2-r57-sidebar-overlay-20260812-v1.js', root), 'utf8'),
  ])

  assert.match(html, /aph2-r57-sidebar-safe-area-20260812-v1\.css\?v=r57-sidebar1/)
  assert.match(html, /aph2-r57-sidebar-overlay-20260812-v1\.js\?v=r57-sidebar1/)
  assert.ok(
    html.indexOf('aph2-r57-sidebar-safe-area-20260812-v1.css') > html.indexOf('aph2-r44-sidebar-tabs-20260812-v1.css'),
    'R57 必须在旧侧栏和触控覆盖层之后加载',
  )
  assert.match(css, /@media\s*\(min-width:\s*641px\)/)
  assert.match(css, /\.aph-exact-sidebar\.is-expanded[\s\S]*flex:\s*0 0 60px\s*!important/)
  assert.match(css, /\.aph-page-tabs[\s\S]*left:\s*60px\s*!important/)
  assert.match(css, /data-r42-route="home"[\s\S]*padding-left:\s*18px\s*!important/)
  assert.doesNotMatch(css, /padding-left:\s*98px\s*!important/)
  assert.doesNotMatch(css, /left:\s*140px\s*!important/)
  assert.match(js, /sessionStorage\.removeItem\(PIN_KEY\)/)
  assert.match(js, /event\.stopImmediatePropagation\(\)/)
  assert.match(js, /window\.location\.pathname !== lastPath/)
  assert.match(js, /r57OverlayReady/)
  assert.match(js, /aph-exact-sidebar a\[href\]/)
  assert.match(js, /clearHover:\s*true/)
  assert.match(js, /classList\.remove\('is-hovered'\)/)
  assert.match(js, /aph-r57-hover-suppressed/)
  assert.match(js, /suppressUntilLeave:\s*true/)
  assert.match(js, /event\.key !== 'Escape'/)
})

test('R57 只调整壳层几何，不改业务数据与路由', async () => {
  const [css, js] = await Promise.all([
    readFile(new URL('aph2-r57-sidebar-safe-area-20260812-v1.css', root), 'utf8'),
    readFile(new URL('aph2-r57-sidebar-overlay-20260812-v1.js', root), 'utf8'),
  ])
  for (const source of [css, js]) {
    assert.doesNotMatch(source, /fetch\s*\(|\/api\/|received|receivable|collectionRate|businessDate/)
  }
  const blocks = [...css.matchAll(/([^{}]*main#main-content[^{}]*)\{([^}]*)\}/g)]
  blocks.forEach(([, , declarations]) => {
    assert.doesNotMatch(declarations, /^\s*(?:width|margin-left|left|transform)\s*:/m)
  })
})
