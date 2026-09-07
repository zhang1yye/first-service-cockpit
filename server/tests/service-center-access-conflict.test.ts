import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-center-conflict-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'center-conflict-contract-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'

const [{ default: db }, access] = await Promise.all([
  import('../src/db.js'),
  import('../src/service-center-access.js'),
])

after(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('规范化后冲突的中心别名完全忽略，不能合并两个在管中心', () => {
  const centerA = '第一服务冲突测试甲服务中心'
  const centerB = '第一服务冲突测试乙服务中心'
  const aliasA = '历史冲突·别名'
  const aliasB = '历史冲突别名'
  const batch = Number(db.prepare(`INSERT INTO project_profile_import_batches
    (source_file,source_sha256,source_sheet,filter_status,profile_count,phase_count)
    VALUES('conflict.xlsx',?,'项目','在管',2,0)`).run('a'.repeat(64)).lastInsertRowid)
  const insertProfile = db.prepare(`INSERT INTO project_profiles
    (batch_id,service_center,area,management_status,property_type,source_rows_json)
    VALUES(?,?,?,'在管','住宅','[]')`)
  const profileA = Number(insertProfile.run(batch, centerA, '同片区').lastInsertRowid)
  const profileB = Number(insertProfile.run(batch, centerB, '同片区').lastInsertRowid)
  const insertLink = db.prepare(`INSERT INTO project_profile_center_links
    (batch_id,profile_id,source_system,source_center,link_method) VALUES(?,?,?,?, 'exact')`)
  insertLink.run(batch, profileA, 'legacy', aliasA)
  insertLink.run(batch, profileB, 'legacy', aliasB)

  db.prepare(`INSERT INTO payment_centers
    (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
    VALUES('同片区',?,1,1,1,1,1)`).run(aliasA)

  const ingestionBatch = Number(db.prepare(`INSERT INTO data_ingestion_batches
    (source_key,business_date,extracted_at,batch_sha256,source_files,archive_dir,status,publishable,row_count,mapped_count,unmapped_count,validation_errors,summary)
    VALUES('conflict','2026-08-13','2026-08-13T00:00:00.000Z',?,'[]','/tmp/conflict','published',1,2,2,0,'[]','{}')`)
    .run('b'.repeat(64)).lastInsertRowid)
  const insertIngestion = db.prepare(`INSERT INTO data_ingestion_rows
    (batch_id,entity_type,source_key,canonical_key,mapping_method,change_type,changed_fields,payload)
    VALUES(?,'collection_center',?,?,'mapped','snapshot','[]',?)`)
  insertIngestion.run(ingestionBatch, aliasA, centerA, JSON.stringify({ area: '同片区' }))
  insertIngestion.run(ingestionBatch, aliasB, centerB, JSON.stringify({ area: '同片区' }))

  assert.deepEqual(access.listServiceCenterOptions().map(row => row.center).sort(), [centerA, centerB].sort())
  assert.equal(access.resolveServiceCenterSelection(aliasA), null)
  assert.equal(access.resolveServiceCenterSelection(aliasB), null)

  const valuesA = access.serviceCenterValues({ userId: 1, username: 'member-a', role: 'viewer', serviceCenterScope: centerA })
  assert.ok(valuesA.includes(centerA))
  assert.equal(valuesA.includes(centerB), false)
  assert.equal(valuesA.includes(aliasA), false)
  assert.equal(valuesA.includes(aliasB), false)
})

test('同一成员可授权同片区多个权威中心且权限别名合并去重', () => {
  const options = access.listServiceCenterOptions()
  assert.ok(options.length >= 2)
  const selected = options.slice(0, 2)
  const values = access.serviceCenterValues({
    userId: 3,
    username: 'multi-center',
    role: 'project_manager',
    serviceCenterScope: selected.map(option => option.center).join(','),
  })
  assert.ok(values.some(value => value === selected[0].center))
  assert.ok(values.some(value => value === selected[1].center))
  assert.equal(new Set(values).size, values.length)
})

test('地区职能动态覆盖权威目录中的全部中心', () => {
  const options = access.listServiceCenterOptions()
  const hqUser = { userId: 4, username: 'regional', role: 'hq_function', serviceCenterScope: '华北地区公司本部职能' }
  const values = access.serviceCenterValues(hqUser)
  for (const option of options) assert.ok(values.includes(option.center))
  assert.equal(access.canonicalServiceCentersForUser(hqUser).length, options.length)
  assert.equal(access.serviceCenterAreaForUser(hqUser), '全部片区')
})

test('两个权威中心名称NFKC或空白归一冲突时权限注册失败关闭', () => {
  db.prepare('DELETE FROM project_profile_center_links').run()
  db.prepare('DELETE FROM project_profiles').run()
  db.prepare('DELETE FROM project_profile_import_batches').run()
  const batch = Number(db.prepare(`INSERT INTO project_profile_import_batches
    (source_file,source_sha256,source_sheet,filter_status,profile_count,phase_count)
    VALUES('normalized-conflict.xlsx',?,'项目','在管',2,0)`).run('c'.repeat(64)).lastInsertRowid)
  const insert = db.prepare(`INSERT INTO project_profiles
    (batch_id,service_center,area,management_status,property_type,source_rows_json)
    VALUES(?,?,?,'在管','住宅','[]')`)
  insert.run(batch, '第一服务归一冲突中心', '同片区')
  insert.run(batch, '第一服务 归一冲突中心', '同片区')

  assert.equal(access.resolveServiceCenterSelection('第一服务归一冲突中心'), null)
  assert.equal(access.serviceCenterValues({ userId: 1, username: 'conflict', role: 'viewer', serviceCenterScope: '第一服务归一冲突中心' }).length, 0)
  assert.equal(access.listServiceCenterOptions().some(row => /归一冲突中心/.test(row.center)), false)
})
