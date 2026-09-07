import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  loadLvzaiArrearsScopeConfig,
  northChinaBusinessDate,
  publicationConfirmed,
  runLvzaiArrearsJob,
  validateLvzaiArrearsScopeConfig,
} from '../src/lvzai-arrears-job.js'
import type { LvzaiArrearageTransport } from '../src/lvzai-arrears-adapter.js'

const previousHashKey = process.env.ARREARS_RESOURCE_HASH_KEY
process.env.ARREARS_RESOURCE_HASH_KEY = 'r141-job-test-resource-hash-key-32-bytes'
test.after(() => {
  if (previousHashKey === undefined) delete process.env.ARREARS_RESOURCE_HASH_KEY
  else process.env.ARREARS_RESOURCE_HASH_KEY = previousHashKey
})

function rawConfig() {
  return {
    schemaVersion: 1,
    projects: [{ regionId: 'region-jrhy', housePrefix: 'BJ-JRHY', serviceCenter: '嘉润花园' }],
    minimumRows: 1,
  }
}

function transport(requests: Record<string, unknown>[] = []): LvzaiArrearageTransport {
  return {
    async probe() { return true }, async relogin() {},
    async post(_path, body) {
      requests.push(body)
      return { result: true, data: { list: [{
        roomSign: 'BJ-JRHY-1-1-1005', roomId: 'room-1005', personName: '不得输出', phone: '13800138000',
        beLongDateList: [{ personId: 'person-a', beginDate: '2026-01', endDate: '2026-07', feeList: [{ feeId: 1, feeName: '物业费', amount: 1250.5 }] }],
      }], amount: 1250.5 } }
    },
  }
}

function database() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE arrears_source_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, business_date TEXT, extracted_at TEXT, status TEXT,
      row_count INTEGER, unique_house_count INTEGER, total_amount REAL, quality_json TEXT, evidence_sha256 TEXT,
      UNIQUE(source,business_date,evidence_sha256)
    );
    CREATE TABLE arrears_lvzai_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, source_row INTEGER, house_hash TEXT, house_masked TEXT,
      service_center TEXT, room_id_hash TEXT, person_id_hash TEXT, fee_item TEXT, amount REAL, period_start TEXT, period_end TEXT,
      payment_status TEXT, evidence_sha256 TEXT, UNIQUE(run_id,source_row), UNIQUE(run_id,evidence_sha256)
    );
  `)
  return db
}

test('范围配置固定项目ID、房屋前缀和请求字段，拒绝凭据及重复项目', () => {
  const config = validateLvzaiArrearsScopeConfig(rawConfig())
  assert.equal(config.projects[0].housePrefix, 'BJ-JRHY')
  assert.throws(() => validateLvzaiArrearsScopeConfig({ ...rawConfig(), token: 'forbidden' }), /不得包含凭据字段/)
  assert.throws(() => validateLvzaiArrearsScopeConfig({ ...rawConfig(), projects: [...rawConfig().projects, rawConfig().projects[0]] }), /regionId重复/)
  assert.throws(() => validateLvzaiArrearsScopeConfig({ ...rawConfig(), projects: [{ ...rawConfig().projects[0], housePrefix: 'JRHY' }] }), /城市代码-项目代码/)
})

test('范围配置文件必须受当前用户控制，允许640但拒绝644及符号链接', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvzai-scope-'))
  const file = path.join(root, 'scope.json')
  const link = path.join(root, 'scope-link.json')
  try {
    fs.writeFileSync(file, JSON.stringify(rawConfig()), { mode: 0o640 })
    assert.equal(loadLvzaiArrearsScopeConfig(file).projects.length, 1)
    fs.chmodSync(file, 0o644)
    assert.throws(() => loadLvzaiArrearsScopeConfig(file), /其他用户访问/)
    fs.chmodSync(file, 0o640)
    fs.symlinkSync(file, link)
    assert.throws(() => loadLvzaiArrearsScopeConfig(link), /不得为符号链接/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('任务默认只试运行，仅返回质量摘要且不创建数据库发布记录', async () => {
  const requests: Record<string, unknown>[] = []
  const result = await runLvzaiArrearsJob({
    config: validateLvzaiArrearsScopeConfig(rawConfig()), transport: transport(requests),
    businessDate: '2026-08-28', now: new Date('2026-08-28T08:00:00+08:00'),
  })
  assert.deepEqual(result, {
    mode: 'dry-run', source: 'lvzai', businessDate: '2026-08-28', extractedAt: result.extractedAt,
    projectScopeCount: 1, rowCount: 1, uniqueHouseCount: 1, totalAmount: 1250.5, qualityState: 'passed', publication: null,
  })
  assert.deepEqual(requests, [{
    type: 1, roomIds: null, regionId: 'region-jrhy', buildingTypes: null, deliveryTypes: null,
    roomSigns: null, personId: null, abortDate: '2026-08-28', dateType: 1,
    beginDate: null, endDate: null, feeIds: null, stewardName: null,
  }])
  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /BJ-JRHY-1-1-1005|room-1005|person-a|不得输出|13800138000/)
})

test('正式发布同时要求production、业务日期确认和受控数据库', async () => {
  const config = validateLvzaiArrearsScopeConfig(rawConfig())
  await assert.rejects(() => runLvzaiArrearsJob({ config, transport: transport(), businessDate: '2026-08-28', publish: true, publishConfirmation: '2026-08-28', nodeEnv: 'test' }), /双重确认/)
  await assert.rejects(() => runLvzaiArrearsJob({ config, transport: transport(), businessDate: '2026-08-28', publish: true, publishConfirmation: '2026-08-28', nodeEnv: 'production' }), /缺少受控数据库/)
  const db = database()
  try {
    const result = await runLvzaiArrearsJob({
      config, transport: transport(), businessDate: '2026-08-28', now: new Date('2026-08-28T08:00:00+08:00'),
      publish: true, publishConfirmation: '2026-08-28', nodeEnv: 'production', database: db,
    })
    assert.equal(result.mode, 'published')
    assert.equal(result.publication?.idempotent, false)
    assert.equal((db.prepare('SELECT COUNT(*) count FROM arrears_source_sync_runs').get() as any).count, 1)
  } finally { db.close() }
})

test('华北业务日期固定使用Asia/Shanghai且发布确认必须精确匹配', () => {
  assert.equal(northChinaBusinessDate(new Date('2026-08-27T16:30:00Z')), '2026-08-28')
  assert.equal(publicationConfirmed('2026-08-28', '2026-08-28', 'production'), true)
  assert.equal(publicationConfirmed('2026-08-28', '2026-08-27', 'production'), false)
  assert.equal(publicationConfirmed('2026-08-28', '2026-08-28', 'test'), false)
})
