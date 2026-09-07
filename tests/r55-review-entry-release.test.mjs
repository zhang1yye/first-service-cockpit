import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const web = path.join(root, 'firstcare-cloud-local')
const nginx = fs.readFileSync(path.join(root, 'deploy/r51-review-recovery/review-system.conf'), 'utf8')
const rollbackSafeNginx = fs.readFileSync(path.join(root, 'deploy/r51-review-recovery/review-system.rollback-safe.conf'), 'utf8')
const entry = fs.readFileSync(path.join(web, 'aph2-r55-review-entry-20260812-v1.js'), 'utf8')
const launcher = fs.readFileSync(path.join(web, 'review-launcher.html'), 'utf8')
const launcherJs = fs.readFileSync(path.join(web, 'review-launcher-20260812-v1.js'), 'utf8')

test('R55由Nginx注入驾驶舱HTML且脚本自身防重复初始化', () => {
  for (const [name, config] of [['candidate', nginx], ['rollback-safe', rollbackSafeNginx]]) {
    assert.equal(
      (config.match(/aph2-r55-review-entry-20260812-v1\.js\?v=r55-review1/g) || []).length,
      2,
      `${name} 只允许在 /arrears 与 /index.html 两个受控 HTML 响应中注入`
    )
    assert.match(config, /location = \/arrears \{[\s\S]*?sub_filter '<link rel="icon"[^\n]+[\s\S]*?aph2-r55-review-entry-20260812-v1\.js\?v=r55-review1/)
    assert.match(config, /location = \/index\.html \{[\s\S]*?sub_filter '<link rel="icon"[^\n]+[\s\S]*?aph2-r55-review-entry-20260812-v1\.js\?v=r55-review1/)
    assert.doesNotMatch(config, /sub_filter\s+['"]<\/head>/i, `${name} 不得对宽泛 </head> 键做注入`)
  }
  assert.match(entry, /if \(window\.__APH_R55_REVIEW_ENTRY__\) return/)
  assert.match(entry, /event\.stopImmediatePropagation\(\)/)
  assert.match(entry, /window\.location\.assign\('\/review'\)/)
  assert.match(entry, /link\.href = '\/review'/)
  assert.match(entry, /target\.pathname === '\/review-system\/'/)
})

test('审核启动页仅通过外部资源执行受保护的SSO换票', () => {
  assert.match(launcher, /lang="zh-CN"/)
  assert.match(launcher, /role="status"/)
  assert.match(launcher, /review-launcher-20260812-v1\.js/)
  assert.doesNotMatch(launcher, /<script(?![^>]*src=)/)
  assert.match(launcherJs, /localStorage\.getItem\('cockpit_token'\)/)
  assert.match(launcherJs, /function reviewToken\(\)/)
  assert.doesNotMatch(launcherJs.match(/function cockpitToken\(\)[\s\S]*?\n  \}/)?.[0] || '', /getItem\('token'\)/)
  assert.match(launcherJs, /fetch\('\/api\/integrations\/review\/sso'/)
  assert.match(launcherJs, /target\.pathname\.startsWith\('\/review-system\/'\)/)
  assert.match(launcherJs, /window\.location\.replace/)
})

test('审核启动失败提供重试、重新登录和返回驾驶舱', () => {
  for (const text of ['重新连接', '重新登录', '返回驾驶舱']) assert.match(launcher, new RegExp(text))
  assert.match(launcherJs, /setFailure/)
  assert.match(launcherJs, /retry\.focus\(\)/)
})
