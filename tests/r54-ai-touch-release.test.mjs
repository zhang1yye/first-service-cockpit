import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../firstcare-cloud-local/', import.meta.url)

test('R54 在移动端将 AI 关闭按钮提升到 44px 触控基线', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('aph2-r54-ai-touch-20260812-v1.css', root), 'utf8')
  ])

  assert.match(html, /aph2-r54-ai-touch-20260812-v1\.css\?v=r54-ai-touch1/)
  assert.ok(
    html.indexOf('aph2-r54-ai-touch-20260812-v1.css') > html.indexOf('aph2-r50-ai-usability-20260812-v1.css'),
    'R54 规则必须在 AI 旧样式之后加载'
  )
  assert.match(css, /@media\s*\(max-width:\s*640px\)/)
  assert.match(css, /#north-ai-assistant button\.north-ai-close/)
  assert.match(css, /width:\s*44px\s*!important/)
  assert.match(css, /min-width:\s*44px\s*!important/)
  assert.match(css, /height:\s*44px\s*!important/)
  assert.match(css, /min-height:\s*44px\s*!important/)
})
