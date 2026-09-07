import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-service-center-master-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'service-center-master-contract-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'

const [{ default: db }, master, access] = await Promise.all([
  import('../src/db.js'),
  import('../src/service-center-master.js'),
  import('../src/service-center-access.js'),
])

after(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

const center = '第一服务测试产业园服务中心'
const batch = Number(db.prepare(`INSERT INTO project_profile_import_batches
  (source_file,source_sha256,source_sheet,filter_status,profile_count,phase_count)
  VALUES('master.xlsx',?,'项目','在管',1,2)`).run('d'.repeat(64)).lastInsertRowid)
const profile = Number(db.prepare(`INSERT INTO project_profiles
  (batch_id,service_center,area,management_status,phase_count,property_type,source_rows_json)
  VALUES(?,?,'京东片区','在管',2,'产业园','[]')`).run(batch, center).lastInsertRowid)
db.prepare(`INSERT INTO project_profile_center_links
  (batch_id,profile_id,source_system,source_center,link_method) VALUES(?,?,'payment',?,'normalized_exact')`).run(batch, profile, center)
db.prepare(`INSERT INTO payment_centers
  (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
  VALUES('已撤场项目',?,1,1,1,1,1)`).run(center)

function insertChange(values: { status: '在管' | '已撤场'; area: string; date: string }) {
  return Number(db.prepare(`INSERT INTO service_center_master_changes
    (center_key,service_center,action_type,previous_area,new_area,previous_status,new_status,effective_date,reason,evidence,reconciliation_json,created_by_name)
    VALUES(?,?,?,? ,?,?,?,?,'测试变更原因','','{}','tester')`).run(
    master.masterCenterKey(center), center, values.status === '已撤场' ? 'withdraw' : 'restore',
    '京东片区', values.area, values.status === '已撤场' ? '在管' : '已撤场', values.status, values.date,
  ).lastInsertRowid)
}

test('撤场项目历史别名统一为一个片区分组', () => {
  assert.equal(master.canonicalServiceCenterArea('撤场项目'), '撤场项目')
  assert.equal(master.canonicalServiceCenterArea('已撤场项目'), '撤场项目')

  const rows = master.applyEffectiveMasterState([
    { center: '第一服务历史撤场甲服务中心', area: '撤场项目', cumulativeExecuted: 125.78 },
    { center: '第一服务历史撤场乙服务中心', area: '已撤场项目', cumulativeExecuted: 2.05 },
  ])
  const totals = rows.reduce((result: Map<string, number>, row: any) => {
    result.set(row.area, (result.get(row.area) || 0) + row.cumulativeExecuted)
    return result
  }, new Map<string, number>())

  assert.deepEqual([...totals.keys()], ['撤场项目'])
  assert.equal(totals.get('撤场项目'), 127.83)
})

test('服务中心主数据变更使用生效日期覆盖源档案且不改写源记录', () => {
  const before = master.effectiveServiceCenterState(center, '京东片区', '在管')
  assert.equal(before.status, '在管')
  insertChange({ status: '已撤场', area: '京东片区', date: '2026-08-26' })
  const after = master.effectiveServiceCenterState(center, '京东片区', '在管')
  assert.equal(after.status, '已撤场')
  assert.equal(after.area, '撤场项目')
  assert.equal((db.prepare('SELECT management_status FROM project_profiles WHERE id=?').get(profile) as any).management_status, '在管')
})

test('撤场中心保留在授权清单并归入撤场项目片区，历史源档案和名称映射仍保留', () => {
  assert.equal(access.listServiceCenterOptions().find(row => row.center === center)?.area, '撤场项目')
  assert.equal((db.prepare('SELECT COUNT(*) count FROM project_profile_center_links WHERE profile_id=?').get(profile) as any).count, 1)
})

test('未来恢复变更在生效日前不进入当前状态', () => {
  insertChange({ status: '在管', area: '朝阳片区', date: '2099-01-01' })
  const current = master.effectiveServiceCenterState(center, '京东片区', '在管')
  assert.equal(current.status, '已撤场')
  const scheduled = master.latestScheduledMasterChanges().get(master.masterCenterKey(center))
  assert.equal(scheduled?.new_area, '朝阳片区')
})

test('版本号包含待生效记录并支持乐观并发控制', () => {
  const version = master.currentMasterVersion(master.masterCenterKey(center))
  assert.equal(version, 2)
})
