import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r24-secondary-pages-20260811-v2.css'), 'utf8')
const script = fs.readFileSync(path.join(site, 'aph2-r24-secondary-pages-20260811-v2.js'), 'utf8')

test('R24在R23之后加载独立的次级页面补丁', () => {
  assert.ok(html.indexOf('aph2-r23-scope-count-type-20260811-v1.css') < html.indexOf('aph2-r24-secondary-pages-20260811-v2.css'))
  assert.match(html, /aph2-r24-secondary-pages-20260811-v2\.js/)
})

test('R24仅为未验收页面添加路由作用域', () => {
  assert.match(script, /aph-r24-command/)
  assert.match(script, /aph-r24-projects/)
  assert.match(script, /aph-r24-ai-alerts/)
  assert.match(script, /aph-r24-ai-report/)
  assert.match(script, /aph-r24-review/)
  assert.doesNotMatch(script, /path === '\/(?:daily|payment|collection)'/)
})

test('R24修复项目密度、工作台等高和AI重复空状态', () => {
  assert.match(css, /aph-r24-command-actions/)
  assert.match(css, /aph-r24-projects \.aph-project-kpis/)
  assert.match(css, /aph-r24-redundant-empty/)
  assert.match(css, /aph-r24-single-source/)
  assert.match(css, /aph-r24-report-layout/)
  assert.match(css, /aph-r24-redundant-alert/)
  assert.match(script, /modeActions\.append\(exportActions\)/)
})

test('R24样式全部有页面级作用域且不触碰三张已验收页面', () => {
  const selectors = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('{')
    .slice(0, -1)
    .map(part => part.split('}').pop().trim())
    .filter(Boolean)
  assert.ok(selectors.every(selector => selector.startsWith('body.aph-r24-') || selector.startsWith('@media')))
  assert.doesNotMatch(css, /aph-(?:daily|payment|collection)|r8-home-/)
  assert.doesNotMatch(script, /fetch\(|\/api\//)
})
