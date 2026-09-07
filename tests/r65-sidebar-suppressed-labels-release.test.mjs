import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../firstcare-cloud-local/', import.meta.url)

test('R65 在 60px 抑制态隐藏文字残片并同步展开语义', async () => {
  const [html, css, js] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('aph2-r65-sidebar-suppressed-labels-20260813-v1.css', root), 'utf8'),
    readFile(new URL('aph2-r65-sidebar-suppressed-labels-20260813-v1.js', root), 'utf8'),
  ])

  assert.ok(
    html.indexOf('aph2-r65-sidebar-suppressed-labels-20260813-v1.js')
      > html.indexOf('aph2-r57-sidebar-overlay-20260812-v1.js'),
    'R65 JS 必须在 R57 状态机之后加载',
  )
  assert.ok(
    html.indexOf('aph2-r65-sidebar-suppressed-labels-20260813-v1.css')
      > html.indexOf('aph2-r59-sidebar-content-safe-area-20260813-v1.css'),
    'R65 CSS 必须在旧侧栏规则之后加载',
  )
  assert.match(css, /aph-r57-hover-suppressed[\s\S]*a span[\s\S]*opacity:\s*0\s*!important/)
  assert.match(css, /visibility:\s*hidden\s*!important/)
  assert.match(js, /const expanded = !suppressed/)
  assert.match(js, /const nextExpanded = String\(expanded\)/)
  assert.match(js, /menu\?\.setAttribute\('aria-expanded', nextExpanded\)/)
  assert.match(js, /data-r65-collapsed-suppressed/)
})

test('R65 只修复侧栏状态，不触碰路由、数据和业务组件', async () => {
  const [css, js] = await Promise.all([
    readFile(new URL('aph2-r65-sidebar-suppressed-labels-20260813-v1.css', root), 'utf8'),
    readFile(new URL('aph2-r65-sidebar-suppressed-labels-20260813-v1.js', root), 'utf8'),
  ])
  const source = `${css}\n${js}`
  assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|\/api\/|businessDate|collectionRate/)
  assert.doesNotMatch(source, /\/daily|\/payment|\/collection|\/ai-alerts/)
  assert.doesNotMatch(css, /main#main-content|\.aph-page-tabs|padding-left|margin-left/)
})

test('R65 只在 641–767px 把 AI 预警行改为两列响应式', async () => {
  const css = await readFile(
    new URL('aph2-r65-sidebar-suppressed-labels-20260813-v1.css', root),
    'utf8',
  )
  assert.match(css, /@media\s*\(min-width:\s*641px\)\s*and\s*\(max-width:\s*767px\)/)
  assert.match(css, /data-r42-route="ai-alerts"[\s\S]*r56-center-toggle[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto/)
  assert.match(css, /r56-center-conclusion[\s\S]*r56-center-disclosure[\s\S]*grid-column:\s*1\s*\/\s*-1/)
  assert.doesNotMatch(css, /data-r42-route="(?:daily|payment|collection)"/)
})
