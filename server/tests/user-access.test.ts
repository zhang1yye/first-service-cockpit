import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HEADQUARTERS_FUNCTION_SCOPE,
  validateServiceCenterAssignment,
  validateUserAccess,
} from '../src/user-access.js'

test('user role validation rejects unknown roles', () => {
  assert.equal(validateUserAccess('super-admin', '', '').ok, false)
})

test('current member roles enforce their service-center assignment contracts', () => {
  assert.equal(validateServiceCenterAssignment('area_manager', '').ok, true)
  assert.equal(validateServiceCenterAssignment('area_manager', '某服务中心').ok, false)
  assert.equal(validateServiceCenterAssignment('project_manager', '').ok, false)
  assert.equal(validateServiceCenterAssignment('project_manager', '中心A,中心B').ok, true)
  assert.equal(validateServiceCenterAssignment('viewer', '').ok, false)
  assert.equal(validateServiceCenterAssignment('viewer', '中心A').ok, true)
  assert.equal(validateServiceCenterAssignment('viewer', '中心A,中心B').ok, false)
})

test('headquarters function and admin roles use their explicit scope contracts', () => {
  assert.equal(validateServiceCenterAssignment('admin', '').ok, true)
  assert.equal(validateServiceCenterAssignment('hq_function', HEADQUARTERS_FUNCTION_SCOPE).ok, true)
  assert.equal(validateServiceCenterAssignment('hq_function', '中心A').ok, false)
})
