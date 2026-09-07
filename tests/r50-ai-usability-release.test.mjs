import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const js = fs.readFileSync(path.join(site, 'aph2-r50-ai-usability-20260812-v2.js'), 'utf8')
const css = fs.readFileSync(path.join(site, 'aph2-r50-ai-usability-20260812-v1.css'), 'utf8')

test('R50 在基础助手之后加载，并带有独立不可变版本', () => {
  assert.match(html, /aph2-r50-ai-usability-20260812-v1\.css\?v=r50-ai1/)
  assert.match(html, /aph2-r50-ai-usability-20260812-v2\.js\?v=r50-ai2/)
  assert.ok(html.indexOf('north-ai-assistant-20260810-r6.js') < html.indexOf('aph2-r50-ai-usability-20260812-v2.js'))
})

test('R50 认证后所有驾驶舱路由都保留 AI 助手入口', () => {
  for (const route of ['/', '/command', '/projects', '/payment', '/daily', '/collection', '/arrears', '/ai-alerts', '/ai-report', '/import', '/review', '/system', '/admin', '/tasks']) {
    assert.match(js, new RegExp(`['\"]${route.replace('/', '\\/')}['\"]`))
  }
  assert.match(js, /launcher\.hidden = !visible/)
  assert.match(js, /current !== '\/login'/)
  assert.match(js, /current\.startsWith\('\/projects\/'\)/)
  assert.match(js, /overlay\.classList\.add\('is-open'\)/)
  assert.match(js, /document\.documentElement\.style\.overflow = 'hidden'/)
  assert.match(js, /event\.target instanceof Element \? event\.target\.closest\('\.north-ai-close'\)/)
  assert.match(css, /\.north-ai-launcher:not\(\[hidden\]\)/)
})

test('R50 门禁页清晰区分不可用项目 AI 与可用经营 AI', () => {
  assert.match(js, /询问已发布经营数据/)
  assert.match(js, /查看数据接入状态/)
  assert.match(js, /回款、收缴、欠费和数据质量/)
  assert.match(js, /\.aph-alerts-gate/)
  assert.match(js, /\.aph-report-gate/)
  assert.doesNotMatch(js, /\.innerHTML\s*=/)
})

test('R50 项目门禁与可重试错误都可恢复', () => {
  assert.match(js, /isProjectGate/)
  assert.match(js, /isUnavailable/)
  assert.match(js, /isRetryable/)
  assert.match(js, /重新提交/)
  assert.match(js, /QUICK_QUESTIONS/)
  assert.match(js, /form\.requestSubmit/)
  assert.match(css, /\.aph-r50-ai-recovery/)
})

test('R50 仅改前端使用性，不触发业务写入或伪造数据', () => {
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'localStorage.setItem', 'POST', 'PUT', 'PATCH', 'DELETE', 'Math.random']) {
    assert.doesNotMatch(js, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('R50 移动端 AI 入口避开底部导航，动作符合 44px 触控目标', () => {
  assert.match(css, /bottom: calc\(72px \+ env\(safe-area-inset-bottom\)\)/)
  assert.match(css, /min-height: 44px/)
  assert.match(css, /prefers-reduced-motion: reduce/)
})
