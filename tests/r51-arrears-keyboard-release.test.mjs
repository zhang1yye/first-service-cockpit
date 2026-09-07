import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const site = path.join(root, 'firstcare-cloud-local', 'arrears')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const js = fs.readFileSync(path.join(site, 'aph2-r51-arrears-keyboard-20260812-v1.js'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r51-arrears-keyboard-20260812-v1.css'), 'utf8')

test('R51 欠费键盘修复在原有业务脚本后加载', () => {
  const overview = html.indexOf('/arrears/arrears-overview-20260808.js')
  const r51 = html.indexOf('/arrears/aph2-r51-arrears-keyboard-20260812-v1.js?v=r51-arrears-keyboard1')
  assert.ok(overview >= 0 && r51 > overview)
  assert.match(html, /aph2-r51-arrears-keyboard-20260812-v1\.css\?v=r51-arrears-keyboard1/)
})

test('R51 实现完整页签键盘模式', () => {
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.match(js, new RegExp(`event\\.key === '${key}'`))
  }
  assert.match(js, /event\.preventDefault\(\)/)
  assert.match(js, /tab\.focus\(\)/)
  assert.match(js, /tab\.click\(\)/)
})

test('R51 为横向滚动的批次表提供键盘入口和名称', () => {
  assert.match(js, /querySelectorAll\('\.table-wrap'\)/)
  assert.match(js, /region\.tabIndex = 0/)
  assert.match(js, /setAttribute\('role', 'region'\)/)
  assert.match(js, /欠费上传批次表，可横向滚动/)
})

test('R51 为动态生成的人工复核控件补齐可访问名称', () => {
  assert.match(js, /querySelectorAll\('\.result-card \.review-box'\)/)
  assert.match(js, /人工归因类别/)
  assert.match(js, /人工核验说明/)
  assert.match(js, /new MutationObserver\(nameReviewControls\)/)
})

test('R51 防止移动端结果关闭按钮断行', () => {
  assert.match(css, /#closeResults[\s\S]*white-space:\s*nowrap/)
  assert.match(css, /#closeResults[\s\S]*min-width:\s*64px/)
  assert.match(css, /\.table-wrap\[tabindex\]:focus-visible/)
})

test('R51 只修复交互语义，不访问或改写业务数据', () => {
  assert.doesNotMatch(js, /fetch\s*\(/)
  assert.doesNotMatch(js, /XMLHttpRequest|\/api\//)
  assert.doesNotMatch(js, /localStorage|sessionStorage/)
})
