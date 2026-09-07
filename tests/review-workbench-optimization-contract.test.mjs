import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')

function activeAsset(ext) {
  const match = html.match(new RegExp(`(?:src|href)=["']\\/([^"'?]*aph2-theme-20260808-progressive6\\.${ext})(?:\\?[^"']*)?["']`))
  assert.ok(match, `index must select immutable progressive6.${ext}`)
  return fs.readFileSync(path.join(site, match[1]), 'utf8')
}

test('review home promotes actionable queues before secondary content', () => {
  const source = activeAsset('js')
  assert.match(source, /function enhanceReviewWorkbenchTaskFocus/)
  assert.match(source, /方案审核队列/)
  assert.match(source, /dataset\.reviewTaskPriority/)
  assert.match(source, /aph-review-hero-compact/)
})

test('review workbench exposes truthful AI freshness and shareable view state', () => {
  const source = activeAsset('js')
  assert.match(source, /aph-review-freshness/)
  assert.match(source, /最近调用/)
  assert.match(source, /24 \* 60 \* 60 \* 1000/)
  assert.match(source, /params\.set\('mode', mode === 'operations' \? 'ops' : 'review'\)/)
  assert.match(source, /window\.history\.replaceState/)
})

test('operations are split into four bounded groups without changing permissions', () => {
  const source = activeAsset('js')
  const css = activeAsset('css')
  for (const key of ['ai', 'execution', 'security', 'audit']) {
    assert.match(source, new RegExp(`${key}:\\s*\\{`))
  }
  for (const label of ['AI与机器人', '审核执行', '账号安全', '日志审计']) {
    assert.match(source, new RegExp(label))
  }
  assert.match(source, /headings:\s*\['意见书导出看板', '执行漏斗'/)
  assert.match(source, /dataset\.reviewWorkbenchGroup/)
  assert.match(source, /data-review-ops-group/)
  assert.match(css, /\.aph-review-ops-groups/)
  assert.match(css, /data-review-workbench-mode="operations"/)
  assert.match(css, /@media\(max-width:640px\)[^}]*[\s\S]*?\.aph-review-hero-compact\{display:none!important\}/)
  assert.match(css, /@media\(max-width:640px\)[^}]*[\s\S]*?\.aph-review-workbench-switch\{position:relative;top:auto;/)
})
