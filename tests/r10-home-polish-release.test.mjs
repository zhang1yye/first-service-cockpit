import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const cssPath = path.join(site, 'aph2-r10-home-polish-20260810-v1.css')

test('R10首页卡片美化层在R9位置层之后加载', () => {
  assert.ok(fs.existsSync(cssPath))
  assert.ok(html.indexOf('aph2-r9-home-position-20260810-v1.css') < html.indexOf('aph2-r10-home-polish-20260810-v1.css'))
})

test('R10卡片使用统一层级、数字排版和克制的交互反馈', () => {
  const css = fs.readFileSync(cssPath, 'utf8')
  assert.match(css, /\.aph-home-reflow\[data-r8-home-layout\]/)
  assert.match(css, /--r10-card-radius:/)
  assert.match(css, /font-variant-numeric:\s*tabular-nums/)
  assert.match(css, /box-shadow:/)
  assert.match(css, /:hover/)
  assert.match(css, /:focus-within/)
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/)
})

test('R10卡片在平板和手机保持单列可读', () => {
  const css = fs.readFileSync(cssPath, 'utf8')
  assert.match(css, /@media\s*\(max-width:\s*1023px\)/)
  assert.match(css, /@media\s*\(max-width:\s*640px\)/)
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)/)
})
