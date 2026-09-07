import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const css = fs.readFileSync(path.join(root, 'admin-web', 'src', 'aph-admin.css'), 'utf8')

test('R29后台导航展开时只移动页面标题文字并保留主内容宽度', () => {
  assert.match(css, /aside\.is-expanded\s*~\s*\.workspace\s+\.page-title\s*>\s*div:first-child\s*\{[^}]*transform:\s*translateX\(12px\)/is)
  assert.doesNotMatch(css, /aside\.is-expanded\s*~\s*\.workspace\s+\.content\s*\{[^}]*(?:margin-left|padding-left|width):/is)
})

test('R29标题安全间距仅在桌面展开态启用并支持减少动效', () => {
  assert.match(css, /@media\s*\(min-width:\s*851px\)/)
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*\.page-title\s*>\s*div:first-child/is)
})
