import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const overlay = path.join(root, 'production-overlays/cockpit-r131-service-center-master-data-20260826-v1/payload')
const index = fs.readFileSync(path.join(overlay, 'index.html'), 'utf8')
const script = fs.readFileSync(path.join(overlay, 'aph2-r131-service-center-master-20260826-v1.js'), 'utf8')
const styles = fs.readFileSync(path.join(overlay, 'aph2-r131-service-center-master-20260826-v1.css'), 'utf8')
const route = fs.readFileSync(path.join(root, 'server/src/routes/service-center-master.ts'), 'utf8')
const schema = fs.readFileSync(path.join(root, 'server/src/db.ts'), 'utf8')
const projectProfiles = fs.readFileSync(path.join(root, 'server/src/routes/project-profiles.ts'), 'utf8')

 test('R131 registers the master-data workspace without replacing the existing admin data surface', () => {
  assert.match(index, /aph2-r131-service-center-master-20260826-v1\.js\?v=r131-master1/)
  assert.match(index, /aph2-r131-service-center-master-20260826-v1\.css\?v=r131-master1/)
  assert.match(script, /data-r131-portal/)
  assert.match(script, /data-r131-master-tab/)
  assert.match(script, /root\.before\(masterTab, portal\)/)
  assert.match(script, /document\.querySelector\('\.r65-tabs'\)/)
  assert.doesNotMatch(script, /root\.hidden\s*=\s*master/)
  assert.doesNotMatch(script, /r131-admin-switcher/)
  assert.match(script, /document\.body\.classList\.toggle\('r131-master-active', master\)/)
  assert.match(styles, /body\.r131-master-active #main-content\.r65-admin-main/)
  assert.match(styles, /\.r131-master-tab\{position:fixed/)
  assert.match(script, /服务中心主数据/)
  assert.match(script, /history\.replaceState/)
})

test('R131 keeps preview, optimistic version, strict audit, and latest-only rollback contracts', () => {
  assert.match(route, /\/api\/service-center-master\/:centerKey\/preview/)
  assert.match(route, /expectedVersion/)
  assert.match(route, /logOperationStrict\(req, '变更服务中心主数据'/)
  assert.match(route, /只能回滚该服务中心最新一条有效变更/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS service_center_master_changes/)
  assert.match(schema, /rolled_back_at TEXT/)
})

test('R132 withdrawal semantics retain centers under the withdrawn-project area and expose reconciliation impact', () => {
  assert.match(route, /SERVICE_CENTER_WITHDRAWN_AREA/)
  assert.match(route, /统一归入“撤场项目”片区/)
  assert.match(route, /affectedAreaManagers/)
  assert.match(route, /reconciliation/)
  assert.match(route, /下一次源表维护时同步/)
  assert.match(projectProfiles, /latestEffectiveMasterChanges/)
  assert.match(projectProfiles, /management_status: effective\.status/)
})

test('R131 hardens mobile, keyboard, loading, empty, error, and reduced-motion states', () => {
  assert.match(script, /aria-modal="true"/)
  assert.match(script, /dialog\.addEventListener\('click', onClick\)/)
  assert.match(script, /dialog\.addEventListener\('input', onInput\)/)
  assert.match(script, /dialog\.addEventListener\('change', onChange\)/)
  assert.match(script, /event\.key === 'Escape'/)
  assert.match(script, /r131-loading/)
  assert.match(script, /r131-empty/)
  assert.match(script, /r131-error/)
  assert.match(styles, /@media\(max-width:640px\)/)
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\)/)
  assert.match(styles, /outline:2px solid #60a5fa/)
})
