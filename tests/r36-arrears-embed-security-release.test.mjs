import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const productionNginx = fs.readFileSync(path.join(root, 'deploy/r26/review-system.conf'), 'utf8')
const routingSnippet = fs.readFileSync(path.join(root, 'deploy/nginx/cockpit-spa-routing.conf'), 'utf8')

function assertSameOriginArrearsDocument(config) {
  const exactDocument = config.match(/location = \/arrears\/index\.html\s*\{([\s\S]*?)\n\s*\}/)
  assert.ok(exactDocument, '必须为 iframe 实际加载的欠费页面配置精确 location')
  assert.match(exactDocument[1], /try_files \/arrears\/index\.html =404;/)
  assert.match(exactDocument[1], /X-Frame-Options "SAMEORIGIN"/)
  assert.match(exactDocument[1], /frame-ancestors 'self'/)
  assert.doesNotMatch(exactDocument[1], /X-Frame-Options "DENY"/)
  assert.doesNotMatch(exactDocument[1], /frame-ancestors 'none'/)
}

test('正式 Nginx 只允许欠费经营业务文档被同源驾驶舱嵌入', () => {
  assertSameOriginArrearsDocument(productionNginx)
})

test('可复用路由片段与正式配置保持相同的嵌入安全边界', () => {
  assertSameOriginArrearsDocument(routingSnippet)
})

test('驾驶舱入口页面继续禁止被其他页面嵌入', () => {
  const cockpitEntry = productionNginx.match(/location = \/arrears\s*\{([\s\S]*?)\n\s*\}/)
  assert.ok(cockpitEntry)
  assert.match(cockpitEntry[1], /cockpit-security-headers\.conf/)
  assert.doesNotMatch(cockpitEntry[1], /SAMEORIGIN/)
})
