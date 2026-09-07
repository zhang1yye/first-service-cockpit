import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const sourcePath = path.join(root, 'server/src/routes/integrations.ts')
const distPath = path.join(root, 'server/dist/routes/integrations.js')
const nginxPath = path.join(root, 'deploy/r51-review-recovery/review-system.conf')

test('驾驶舱始终把 SSO 签发到真实审核系统入口', () => {
  for (const file of [sourcePath, distPath]) {
    const code = fs.readFileSync(file, 'utf8')
    assert.match(code, /DEFAULT_REVIEW_SYSTEM_URL\s*=\s*['"]\/review-system\/['"]/, file)
    assert.match(code, /router\.post\(['"]\/api\/integrations\/review\/sso['"][\s\S]*?reviewSystemUrl\(\)[\s\S]*?sso=/, file)
    assert.doesNotMatch(code, /DEFAULT_REVIEW_SYSTEM_URL\s*=\s*['"][^'"]*\/review\?view=workbench/, file)
  }
})

test('Nginx 直接服务 /review-system/ 和 index.html，不得跳回驾驶舱 /review', () => {
  const conf = fs.readFileSync(nginxPath, 'utf8')

  assert.match(conf, /location = \/review-system\s*\{\s*return 308 \/review-system\/\$is_args\$args;\s*\}/)
  assert.match(conf, /location = \/review-system\/\s*\{[\s\S]*?root \/var\/www\/first-service-dashboard;[\s\S]*?try_files \/index\.html =404;[\s\S]*?\}/)
  assert.match(conf, /location = \/review-system\/index\.html\s*\{[\s\S]*?root \/var\/www\/first-service-dashboard;[\s\S]*?try_files \/index\.html =404;[\s\S]*?\}/)
  assert.match(conf, /location \^~ \/review-system\/\s*\{[\s\S]*?root \/var\/www\/first-service-dashboard;[\s\S]*?try_files \/index\.html =404;[\s\S]*?\}/)

  assert.doesNotMatch(conf, /location[^\n]*\/review-system[^\n]*\{[^}]*return 30[1278] \/review(?:\?|\/|;)/)
})

test('审核系统静态资源与 API 路径同源可用', () => {
  const conf = fs.readFileSync(nginxPath, 'utf8')

  assert.match(conf, /location \^~ \/review-system\/assets\/\s*\{[\s\S]*?alias \/var\/www\/first-service-dashboard\/assets\/;/)
  assert.match(conf, /sub_filter ['"]\"\/api\/['"] ['"]\"\/review-api\/['"];/)
  assert.match(conf, /location \/review-api\/\s*\{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:3001\/api\/;/)
  assert.match(conf, /location = \/review-api\/aph\s*\{\s*return 404;\s*\}/)
  assert.match(conf, /location \^~ \/review-api\/aph\/\s*\{\s*return 404;\s*\}/)
  assert.doesNotMatch(conf, /127\.0\.0\.1:8788|127\.0\.0\.1:8789|proxy_pass[^;]*(?:8788|8789)/)
})

test('SSO 票据入口不记录 query、不发送 Referer，并启用审核前端 CSP', () => {
  const conf = fs.readFileSync(nginxPath, 'utf8')
  const indexBlock = conf.match(/location = \/review-system\/\s*\{[\s\S]*?\n    \}/)?.[0] || ''

  assert.match(indexBlock, /access_log off;/)
  assert.match(indexBlock, /Referrer-Policy "no-referrer"/)
  assert.match(indexBlock, /Content-Security-Policy "default-src 'self';[^"]*frame-ancestors 'self'/)
})

test('/review 使用独立静态桥页，/review/ 归一化时保留全部 query', () => {
  const conf = fs.readFileSync(nginxPath, 'utf8')

  assert.match(conf, /location = \/review\s*\{[\s\S]*?try_files \/review-launcher\.html =404;[\s\S]*?\}/)
  assert.match(conf, /location = \/review\/\s*\{\s*return 308 \/review\$is_args\$args;\s*\}/)
  assert.match(conf, /location = \/review-launcher\.html\s*\{[\s\S]*?try_files \/review-launcher\.html =404;[\s\S]*?\}/)
  assert.match(conf, /location = \/review-launcher-20260812-v1\.js\s*\{[\s\S]*?try_files \/review-launcher-20260812-v1\.js =404;[\s\S]*?\}/)
  assert.match(conf, /location = \/review-launcher-20260812-v1\.css\s*\{[\s\S]*?try_files \/review-launcher-20260812-v1\.css =404;[\s\S]*?\}/)
})
