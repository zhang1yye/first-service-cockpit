import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const route = readFileSync(resolve(here, '../src/routes/operating-capabilities.ts'), 'utf8')
const index = readFileSync(resolve(here, '../src/index.ts'), 'utf8')

test('能力清单按服务中心授权范围过滤两套来源', () => {
  assert.match(route, /serviceCenterScopeWhere\(req, 'center'\)/)
  assert.match(route, /canAccessServiceCenter\(req, row\.center\)/)
  assert.match(route, /quality_status='verified'/)
})

test('能力清单只读且注册在认证后路由中', () => {
  assert.match(index, /app\.use\(operatingCapabilitiesRouter\)/)
  assert.match(route, /router\.get\('\/api\/operating-capabilities'/)
  assert.doesNotMatch(route, /INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|\.run\(/i)
})
