import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { initialQxmCursorState, loadQxmCursorState, loadQxmEvidenceScopeConfig, runQxmEvidenceJob, runQxmEvidenceShardedJob, saveQxmCursorState, validateQxmEvidenceScopeConfig } from '../src/qxm-evidence-job.js'
import type { QxmEvidenceTransport } from '../src/qxm-evidence-connector.js'

const previous = process.env.ARREARS_RESOURCE_HASH_KEY
process.env.ARREARS_RESOURCE_HASH_KEY = 'qxm-job-test-resource-key-at-least-32'
test.after(() => { if (previous === undefined) delete process.env.ARREARS_RESOURCE_HASH_KEY; else process.env.ARREARS_RESOURCE_HASH_KEY = previous })
function rawConfig() { return { schemaVersion: 1, departments: [{ departmentId: 'dept-controlled', reviewServiceCenter: '朝阳片区复核', projects: [{ housePrefix: 'BJ-JRHY', serviceCenter: '嘉润花园' }] }], pageSize: 100, maximumPages: 50 } }
function transport(): QxmEvidenceTransport { return { async readMessages(input) { return { rows: [{ messageId: 'message-1', external_userid: 'external-1', employeeUserId: 'employee-1', 房屋备注: '1-1-1005', 消息时间: '2026-08-27T10:20:00+08:00', 消息方向: '客户发送', 消息类型: '文本', 消息内容: '承诺月底缴费' }], total: 1, nextCursor: `${input.cursor}-next`, hasMore: false } } } }
function database() { const db = new Database(':memory:'); db.exec(`CREATE TABLE arrears_source_sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT,business_date TEXT,extracted_at TEXT,status TEXT,row_count INTEGER,unique_house_count INTEGER,total_amount REAL,quality_json TEXT,evidence_sha256 TEXT,UNIQUE(source,business_date,evidence_sha256)); CREATE TABLE arrears_qxm_evidence (id INTEGER PRIMARY KEY AUTOINCREMENT,run_id INTEGER,source_row INTEGER,service_center TEXT,match_state TEXT,house_hash TEXT,house_masked TEXT,room_reference_hash TEXT,message_id_hash TEXT UNIQUE,external_user_id_hash TEXT,employee_user_id_hash TEXT,occurred_at TEXT,direction TEXT,content_kind TEXT,signal_state TEXT,cause_signal TEXT,evidence_sha256 TEXT,UNIQUE(run_id,source_row)); CREATE TABLE arrears_qxm_shard_status (department_id_hash TEXT,service_center TEXT,business_date TEXT,extracted_at TEXT,state TEXT,error_code TEXT,row_count INTEGER,matched_count INTEGER,isolated_count INTEGER,cursor_advanced INTEGER,run_id INTEGER,PRIMARY KEY(department_id_hash,service_center));`); return db }

test('企小码范围配置固定部门、复核归属及多项目映射，拒绝凭据、游标及重复范围', () => {
  const config = validateQxmEvidenceScopeConfig(rawConfig())
  assert.equal(config.departments[0].projects[0].serviceCenter, '嘉润花园')
  assert.throws(() => validateQxmEvidenceScopeConfig({ ...rawConfig(), token: 'forbidden' }), /不得包含凭据或游标字段/)
  assert.throws(() => validateQxmEvidenceScopeConfig({ ...rawConfig(), cursor: 'forbidden' }), /不得包含凭据或游标字段/)
  assert.throws(() => validateQxmEvidenceScopeConfig({ ...rawConfig(), departments: [...rawConfig().departments, rawConfig().departments[0]] }), /为空、过长或重复/)
  assert.throws(() => validateQxmEvidenceScopeConfig({ ...rawConfig(), departments: [{ ...rawConfig().departments[0], projects: [...rawConfig().departments[0].projects, rawConfig().departments[0].projects[0]] }] }), /房屋前缀重复/)
  assert.throws(() => validateQxmEvidenceScopeConfig({ ...rawConfig(), pageSize: 1 }), /单页数量/)
  assert.throws(() => validateQxmEvidenceScopeConfig({ ...rawConfig(), pageSize: 20001 }), /单页数量/)
})

test('范围配置允许640；游标状态必须600、当前用户拥有且仅覆盖授权部门HMAC', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qxm-job-')), configFile = path.join(root, 'scope.json'), stateFile = path.join(root, 'cursor.json')
  try {
    fs.writeFileSync(configFile, JSON.stringify(rawConfig()), { mode: 0o640 }); fs.chmodSync(configFile, 0o640)
    const config = loadQxmEvidenceScopeConfig(configFile)
    saveQxmCursorState(stateFile, initialQxmCursorState(config, new Date('2026-08-28T00:00:00Z')), config)
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600)
    const state = loadQxmCursorState(stateFile, config)
    assert.match(state.departments[0].departmentIdHash, /^[a-f0-9]{64}$/)
    assert.doesNotMatch(fs.readFileSync(stateFile, 'utf8'), /dept-controlled/)
    fs.chmodSync(stateFile, 0o640); assert.throws(() => loadQxmCursorState(stateFile, config), /权限必须为600/)
    fs.chmodSync(stateFile, 0o600); fs.writeFileSync(stateFile, JSON.stringify({ ...state, departments: [] }), { mode: 0o600 }); assert.throws(() => loadQxmCursorState(stateFile, config), /范围不完整/)
    fs.chmodSync(configFile, 0o644); assert.throws(() => loadQxmEvidenceScopeConfig(configFile), /其他用户访问/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('默认只读试运行不发布、不推进游标且摘要不输出部门、房屋、客户或聊天原文', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qxm-dry-')), stateFile = path.join(root, 'cursor.json'), config = validateQxmEvidenceScopeConfig(rawConfig()), state = initialQxmCursorState(config, new Date('2026-08-28T00:00:00Z'))
  try {
    saveQxmCursorState(stateFile, state, config); const before = fs.readFileSync(stateFile, 'utf8')
    const result = await runQxmEvidenceJob({ config, cursorState: state, cursorStatePath: stateFile, transport: transport(), businessDate: '2026-08-28', now: new Date('2026-08-28T08:00:00+08:00') })
    assert.deepEqual(result, { mode: 'dry-run', source: 'qxm', businessDate: '2026-08-28', extractedAt: result.extractedAt, departmentScopeCount: 1, rowCount: 1, matchedCount: 1, isolatedUnlinkedCount: 0, supportedSignalCount: 1, conflictedSignalCount: 0, authoritativeAmountFields: 0, qualityState: 'passed', cursorAdvanced: false, publication: null })
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before)
    assert.doesNotMatch(JSON.stringify(result), /dept-controlled|BJ-JRHY|external-1|employee-1|message-1|承诺月底缴费/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('正式发布要求生产确认和数据库，成功后才原子推进600游标状态', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qxm-publish-')), stateFile = path.join(root, 'cursor.json'), config = validateQxmEvidenceScopeConfig(rawConfig()), state = initialQxmCursorState(config, new Date('2026-08-28T00:00:00Z'))
  try {
    saveQxmCursorState(stateFile, state, config)
    await assert.rejects(runQxmEvidenceJob({ config, cursorState: state, cursorStatePath: stateFile, transport: transport(), businessDate: '2026-08-28', publish: true, publishConfirmation: '2026-08-28', nodeEnv: 'development' }), /双重确认/)
    await assert.rejects(runQxmEvidenceJob({ config, cursorState: state, cursorStatePath: stateFile, transport: transport(), businessDate: '2026-08-28', publish: true, publishConfirmation: '2026-08-28', nodeEnv: 'production' }), /受控数据库/)
    const db = database()
    try {
      const result = await runQxmEvidenceJob({ config, cursorState: state, cursorStatePath: stateFile, transport: transport(), database: db, businessDate: '2026-08-28', now: new Date('2026-08-28T08:00:00+08:00'), publish: true, publishConfirmation: '2026-08-28', nodeEnv: 'production' })
      assert.equal(result.mode, 'published'); assert.equal(result.cursorAdvanced, true)
      assert.equal((db.prepare('SELECT COUNT(*) count FROM arrears_qxm_evidence').get() as any).count, 1)
      const next = loadQxmCursorState(stateFile, config); assert.equal(next.departments[0].cursor, '-next'); assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600)
    } finally { db.close() }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('项目级分片发布允许成功部门独立落库推进游标且失败部门保持旧游标', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qxm-sharded-')), stateFile = path.join(root, 'cursor.json')
  const config = validateQxmEvidenceScopeConfig({
    schemaVersion: 1,
    departments: [
      { departmentId: 'dept-fast', reviewServiceCenter: '中心A复核', projects: [{ housePrefix: 'BJ-FAST', serviceCenter: '中心A' }] },
      { departmentId: 'dept-slow', reviewServiceCenter: '中心B复核', projects: [{ housePrefix: 'BJ-SLOW', serviceCenter: '中心B' }] },
    ],
    pageSize: 100,
    maximumPages: 50,
  })
  const state = initialQxmCursorState(config, new Date('2026-08-28T00:00:00Z'))
  const shardedTransport: QxmEvidenceTransport = {
    async readMessages(input) {
      if (input.departmentId === 'dept-slow') throw new Error('企小码源接口读取超过受控时限')
      return {
        rows: [{ messageId: 'message-fast-1', external_userid: 'external-fast-1', employeeUserId: 'employee-fast-1', 房屋备注: '1-1-1005', 消息时间: '2026-08-27T10:20:00+08:00', 消息方向: '客户发送', 消息类型: '文本', 消息内容: '月底缴费' }],
        total: 1,
        nextCursor: 'fast-next',
        hasMore: false,
      }
    },
  }
  try {
    saveQxmCursorState(stateFile, state, config)
    const db = database()
    try {
      const result = await runQxmEvidenceShardedJob({ config, cursorState: state, cursorStatePath: stateFile, transport: shardedTransport, database: db, businessDate: '2026-08-28', now: new Date('2026-08-28T08:00:00+08:00'), publish: true, publishConfirmation: '2026-08-28', nodeEnv: 'production' })
      assert.equal(result.qualityState, 'partial')
      assert.equal(result.departmentScopeCount, 2)
      assert.equal(result.publishedDepartmentCount, 1)
      assert.equal(result.failedDepartmentCount, 1)
      assert.equal(result.cursorAdvancedCount, 1)
      assert.equal(result.failures[0].errorCode, 'source_timeout')
      assert.match(result.failures[0].departmentIdHash, /^[a-f0-9]{64}$/)
      assert.doesNotMatch(JSON.stringify(result), /dept-fast|dept-slow|BJ-FAST|BJ-SLOW|message-fast|external-fast|employee-fast/)
      assert.equal((db.prepare('SELECT COUNT(*) count FROM arrears_qxm_evidence').get() as any).count, 1)
      assert.deepEqual(db.prepare('SELECT service_center,state,error_code,cursor_advanced FROM arrears_qxm_shard_status ORDER BY service_center').all(), [
        { service_center: '中心A', state: 'passed', error_code: '', cursor_advanced: 1 },
        { service_center: '中心B', state: 'failed', error_code: 'source_timeout', cursor_advanced: 0 },
      ])
      const next = loadQxmCursorState(stateFile, config)
      const originalByHash = new Map(state.departments.map(item => [item.departmentIdHash, item.cursor]))
      const advanced = next.departments.filter(item => item.cursor !== originalByHash.get(item.departmentIdHash))
      const unchanged = next.departments.filter(item => item.cursor === originalByHash.get(item.departmentIdHash))
      assert.equal(advanced.length, 1); assert.equal(advanced[0].cursor, 'fast-next')
      assert.equal(unchanged.length, 1); assert.equal(unchanged[0].cursor, '')
    } finally { db.close() }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('企小码生产同步入口必须启用项目级分片任务而非旧全量任务', () => {
  const source = fs.readFileSync(new URL('../src/qxm-evidence-sync-cli.ts', import.meta.url), 'utf8')
  assert.match(source, /runQxmEvidenceShardedJob/)
  assert.doesNotMatch(source, /\brunQxmEvidenceJob\b/)
})
