import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../firstcare-cloud-local/', import.meta.url)

test('R59 在所有桌面页面展开侧栏时同步移动工作区', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('aph2-r59-sidebar-content-safe-area-20260813-v1.css', root), 'utf8'),
  ])

  const r57Index = html.indexOf('aph2-r57-sidebar-safe-area-20260812-v1.css')
  const r59Index = html.indexOf('aph2-r59-sidebar-content-safe-area-20260813-v1.css')
  assert.ok(r57Index >= 0 && r59Index > r57Index, 'R59 必须在旧 overlay 规则之后加载')
  assert.match(css, /@media\s*\(min-width:\s*641px\)/)
  assert.match(css, /aph-exact-sidebar:not\(\.aph-r57-hover-suppressed\)\.is-expanded[\s\S]*flex:\s*0 0 140px\s*!important/)
  assert.match(css, /\.aph-page-tabs\s*\{\s*left:\s*140px\s*!important/)
  assert.match(css, /aph-admin-page[\s\S]*padding-left:\s*140px\s*!important/)
  assert.doesNotMatch(css, /padding-left:\s*98px/)
})

test('R59 只修改壳层几何，不触碰业务路由、数据和接口', async () => {
  const css = await readFile(
    new URL('aph2-r59-sidebar-content-safe-area-20260813-v1.css', root),
    'utf8',
  )
  assert.doesNotMatch(css, /fetch\s*\(|\/api\/|received|receivable|collectionRate|businessDate/)
  assert.doesNotMatch(css, /data-r42-route=(?:"|')(?:daily|payment|collection)/)
  assert.doesNotMatch(css, /@media\s*\(max-width:\s*640px\)/)
})
