import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const standalone = fs.readFileSync(path.join(site, 'admin/index.html'), 'utf8')
const css = fs.readFileSync(
  path.join(site, 'admin/aph2-r61-admin-table-continuity-20260813-v1.css'),
  'utf8',
)
const asset = 'admin/aph2-r61-admin-table-continuity-20260813-v1.css?v=r61-table-continuity1'

test('R61 在两个后台入口中最后加载表格连续性修复', () => {
  for (const entrypoint of [html, standalone]) {
    assert.equal(entrypoint.split(asset).length - 1, 1)
    assert.ok(
      entrypoint.indexOf(asset) > entrypoint.indexOf('aph2-r56-admin-workspace-20260812-v1.css'),
    )
    assert.ok(entrypoint.indexOf(asset) < entrypoint.indexOf('</head>'))
  }
})

test('R61 取消 sticky 位移和占位外边距，但保留编辑保护条', () => {
  assert.match(
    css,
    /body\[data-r56-admin-workspace\]\s+#main-content\s+\.table-scroll\s*>\s*\.aph-admin-safety-toolbar\s*\{/,
  )
  assert.match(css, /position:\s*static\s*!important/)
  assert.match(css, /top:\s*auto\s*!important/)
  assert.match(css, /z-index:\s*auto\s*!important/)
  assert.match(css, /margin:\s*0\s*!important/)
  assert.doesNotMatch(css, /display:\s*none|visibility:\s*hidden|opacity:\s*0/)
})

test('R61 仅修复布局，不访问接口、账号或业务数据', () => {
  assert.doesNotMatch(
    css,
    /fetch\(|XMLHttpRequest|\/api\/|localStorage|sessionStorage|budget|collection|payment|user/i,
  )
})
