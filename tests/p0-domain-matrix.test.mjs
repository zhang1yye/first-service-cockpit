import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const matrix = JSON.parse(fs.readFileSync(path.join(root, 'config/cockpit-domain-matrix.json'), 'utf8'))
const serverIndex = fs.readFileSync(path.join(root, 'server/src/index.ts'), 'utf8')
const routeSource = fs.readdirSync(path.join(root, 'server/src/routes'))
  .filter(name => name.endsWith('.ts'))
  .map(name => fs.readFileSync(path.join(root, 'server/src/routes', name), 'utf8'))
  .join('\n')

test('每个活动页面都有API、来源、写策略和状态', () => {
  const routes = new Set()
  for (const domain of matrix.domains) {
    assert.match(domain.route, /^\//)
    assert.equal(routes.has(domain.route), false, `页面重复：${domain.route}`)
    routes.add(domain.route)
    assert.ok(domain.apis.length > 0, `${domain.route}缺API`)
    assert.ok(domain.sources.length > 0, `${domain.route}缺权威来源`)
    assert.ok(domain.writePolicy, `${domain.route}缺写策略`)
    assert.ok(domain.status, `${domain.route}缺完成状态`)
  }
})

test('三个保护页面在业务矩阵中保持已验收状态', () => {
  for (const route of ['/daily', '/payment', '/collection']) {
    const domain = matrix.domains.find(item => item.route === route)
    assert.equal(domain?.status, 'accepted-protected')
  }
})

test('矩阵中的核心API均有服务端路由或显式前缀注册', () => {
  const prefixOnly = new Set(['/api/admin', '/api/data-sources', '/api/governance', '/api/users', '/api/trends', '/api/arrears'])
  for (const domain of matrix.domains.filter(item => item.route !== '/tasks')) {
    for (const endpoint of domain.apis) {
      if (endpoint.endsWith('/*') || prefixOnly.has(endpoint)) {
        const prefix = endpoint.replace(/\/\*$/, '')
        assert.ok(routeSource.includes(prefix) || serverIndex.includes(prefix), `未注册API前缀：${endpoint}`)
        continue
      }
      assert.ok(routeSource.includes(endpoint), `未注册API：${endpoint}`)
    }
  }
})

test('任务模块继续由主路由统一返回410', () => {
  assert.match(serverIndex, /req\.path\.startsWith\('\/api\/tasks'\)/)
  assert.match(serverIndex, /res\.status\(410\)/)
})
