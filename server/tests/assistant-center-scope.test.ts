import assert from 'node:assert/strict'
import test from 'node:test'
import { aggregateAreaScopeForUser } from '../src/permissions.js'

test('服务中心合同仅允许管理员使用全量片区范围，所有非管理员均失败关闭', () => {
  assert.equal(aggregateAreaScopeForUser({ userId: 1, username: 'admin', role: 'admin' }), null)
  assert.deepEqual(aggregateAreaScopeForUser({ userId: 2, username: 'region', role: 'region_manager' }), [])
  assert.deepEqual(aggregateAreaScopeForUser({ userId: 3, username: 'viewer', role: 'viewer' }), [])
  assert.deepEqual(aggregateAreaScopeForUser({
    userId: 4, username: 'area', role: 'area_manager', areaScope: '海淀片区,河北片区',
  }), [])
  assert.deepEqual(aggregateAreaScopeForUser({
    userId: 5, username: 'project', role: 'project_manager', projectScope: '7',
  }), [])
})

test('empty area scope fails closed instead of becoming unrestricted', () => {
  assert.deepEqual(aggregateAreaScopeForUser({
    userId: 6, username: 'area-empty', role: 'area_manager', areaScope: '',
  }), [])
  assert.deepEqual(aggregateAreaScopeForUser(undefined), [])
})
