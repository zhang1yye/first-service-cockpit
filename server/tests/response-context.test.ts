import assert from 'node:assert/strict'
import test from 'node:test'
import { buildResponseContext } from '../src/response-context.js'

test('普通成员响应上下文保留自身范围且不获得写权限', () => {
  const meta = buildResponseContext({ user: {
    role: 'viewer', areaScope: '朝阳片区', serviceCenterScope: '甲中心',
  } } as any, {
    businessDate: '2026-08-13T00:00:00+08:00', sources: ['APH', 'APH', '绿仔'],
    publicationStatus: 'published', qualityStatus: 'partial', canWrite: true,
  })
  assert.deepEqual(meta.scope.areaScope, ['朝阳片区'])
  assert.deepEqual(meta.scope.serviceCenterScope, ['甲中心'])
  assert.equal(meta.scope.allAuthorizedServiceCenters, false)
  assert.equal(meta.permissions.write, false)
  assert.equal(meta.freshness.businessDate, '2026-08-13')
  assert.deepEqual(meta.provenance.sources, ['APH', '绿仔'])
})

test('地区职能拥有全经营读取范围但没有管理员写权限', () => {
  const meta = buildResponseContext({ user: { role: 'hq_function', serviceCenterScope: '华北地区公司本部职能' } } as any, {
    sources: ['权威项目目录'], qualityStatus: 'ready', canWrite: true,
  })
  assert.equal(meta.scope.allAuthorizedServiceCenters, true)
  assert.equal(meta.scope.areaScope, null)
  assert.equal(meta.permissions.write, false)
})

test('管理员写权限仍由具体接口显式声明', () => {
  const request = { user: { role: 'admin' } } as any
  assert.equal(buildResponseContext(request, { sources: ['项目目录'], qualityStatus: 'ready' }).permissions.write, false)
  assert.equal(buildResponseContext(request, { sources: ['项目目录'], qualityStatus: 'ready', canWrite: true }).permissions.write, true)
})
