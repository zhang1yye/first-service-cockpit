import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const source = fs.readFileSync(path.join(process.cwd(), 'src/routes/ai.ts'), 'utf8')

test('项目真实性门禁状态接口在受保护 AI 中间件之前注册', () => {
  const routeStart = source.indexOf("router.get('/api/data-quality/project-gate'")
  const protectedMiddlewareStart = source.indexOf('router.use([', routeStart)

  assert.ok(routeStart >= 0, '缺少 GET /api/data-quality/project-gate')
  assert.ok(protectedMiddlewareStart > routeStart, '门禁状态接口必须在受保护 AI 中间件之前注册')
})

test('项目真实性门禁状态使用同一判定函数并禁止缓存', () => {
  const route = source.match(
    /router\.get\('\/api\/data-quality\/project-gate'[\s\S]*?\n\}\)/,
  )?.[0] || ''

  assert.match(route, /const gate = readProjectDataGate\(db\)/)
  assert.match(route, /Cache-Control', 'no-store'/)
  assert.match(route, /code: gate\.ready \? 'PROJECT_DATA_QUALITY_READY' : 'PROJECT_DATA_QUALITY_BLOCKED'/)
  assert.doesNotMatch(route, /ready:\s*true/)
})
