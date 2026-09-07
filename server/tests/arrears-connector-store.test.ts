import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import Database from 'better-sqlite3'
import { normalizeLvzaiArrearsEnvelope } from '../src/arrears-connectors.js'
import { normalizeWecomLedgerEnvelope } from '../src/wecom-ledger-connector.js'
import { normalizeQxmEvidenceEnvelope } from '../src/qxm-evidence-connector.js'
import { publishLvzaiArrears, publishWecomLedger, publishQxmEvidence, readArrearsConnectorStatus, readArrearsEvidenceConflicts, readQxmShardCoverage, reviewArrearsEvidenceConflict } from '../src/arrears-connector-store.js'

const previousHashKey = process.env.ARREARS_RESOURCE_HASH_KEY
process.env.ARREARS_RESOURCE_HASH_KEY = 'r141-store-test-resource-hash-key-32-bytes'
test.after(() => {
  if (previousHashKey === undefined) delete process.env.ARREARS_RESOURCE_HASH_KEY
  else process.env.ARREARS_RESOURCE_HASH_KEY = previousHashKey
})

function database() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE arrears_source_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, business_date TEXT NOT NULL,
      extracted_at TEXT NOT NULL, status TEXT NOT NULL, row_count INTEGER NOT NULL,
      unique_house_count INTEGER NOT NULL, total_amount REAL, quality_json TEXT NOT NULL,
      evidence_sha256 TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source,business_date,evidence_sha256)
    );
    CREATE TABLE arrears_lvzai_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, source_row INTEGER NOT NULL,
      house_hash TEXT NOT NULL, house_masked TEXT NOT NULL, service_center TEXT NOT NULL, room_id_hash TEXT NOT NULL,
      person_id_hash TEXT NOT NULL, fee_item TEXT NOT NULL, amount REAL NOT NULL,
      period_start TEXT NOT NULL, period_end TEXT NOT NULL, payment_status TEXT NOT NULL,
      evidence_sha256 TEXT NOT NULL, UNIQUE(run_id,source_row), UNIQUE(run_id,evidence_sha256),
      FOREIGN KEY(run_id) REFERENCES arrears_source_sync_runs(id)
    );
    CREATE TABLE arrears_wecom_ledger_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, source_row INTEGER NOT NULL,
      house_hash TEXT NOT NULL, house_masked TEXT NOT NULL, service_center TEXT NOT NULL, document_id_hash TEXT NOT NULL,
      sheet_id_hash TEXT NOT NULL, record_id_hash TEXT NOT NULL, manual_cause TEXT NOT NULL,
      progress TEXT NOT NULL, latest_followup_date TEXT NOT NULL, promised_payment_date TEXT NOT NULL,
      responsible_user_id_hash TEXT NOT NULL, evidence_sha256 TEXT NOT NULL,
      UNIQUE(run_id,source_row), UNIQUE(run_id,record_id_hash), UNIQUE(run_id,evidence_sha256),
      FOREIGN KEY(run_id) REFERENCES arrears_source_sync_runs(id)
    );
    CREATE TABLE arrears_qxm_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,run_id INTEGER,source_row INTEGER,service_center TEXT,match_state TEXT,
      house_hash TEXT,house_masked TEXT,room_reference_hash TEXT,message_id_hash TEXT UNIQUE,external_user_id_hash TEXT,
      employee_user_id_hash TEXT,occurred_at TEXT,direction TEXT,content_kind TEXT,signal_state TEXT,cause_signal TEXT,evidence_sha256 TEXT,
      UNIQUE(run_id,source_row)
    );
    CREATE TABLE arrears_qxm_shard_status (
      department_id_hash TEXT NOT NULL,service_center TEXT NOT NULL,business_date TEXT NOT NULL,extracted_at TEXT NOT NULL,
      state TEXT NOT NULL,error_code TEXT NOT NULL DEFAULT '',row_count INTEGER NOT NULL DEFAULT 0,matched_count INTEGER NOT NULL DEFAULT 0,
      isolated_count INTEGER NOT NULL DEFAULT 0,cursor_advanced INTEGER NOT NULL DEFAULT 0,run_id INTEGER,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(department_id_hash,service_center)
    );
    CREATE TABLE arrears_evidence_conflict_reviews (
      conflict_key TEXT PRIMARY KEY, conflict_type TEXT, house_hash TEXT, service_center TEXT,
      lvzai_run_id INTEGER, wecom_run_id INTEGER, qxm_run_id INTEGER, decision TEXT, reason_code TEXT,
      reviewed_by_user_id INTEGER, reviewed_at TEXT DEFAULT CURRENT_TIMESTAMP, version INTEGER DEFAULT 1
    );
  `)
  return db
}

function lvzaiRows(rows: Array<{ room: string; amount: number; center?: string }> = [{ room: '1005', amount: 1250.5 }]) {
  return normalizeLvzaiArrearsEnvelope({
    source: 'lvzai', businessDate: '2026-08-28', extractedAt: '2026-08-28T07:30:00+08:00',
    declaredRowCount: rows.length, declaredTotalAmount: rows.reduce((sum, row) => sum + row.amount, 0),
    rows: rows.map((row, index) => ({ roomSign: `BJ-JRHY-1-1-${row.room}`, serviceCenter: row.center || '嘉润花园', roomId: `room-${row.room}`, personId: `person-${index}`, arrearageAmount: row.amount, feeItemName: '物业费', arrearsStartDate: '2026-01', arrearsEndDate: '2026-07', paymentStatus: '欠费' })),
  }, { now: new Date('2026-08-28T08:00:00+08:00') })
}
function payload(amount = 1250.5) { return lvzaiRows([{ room: '1005', amount }]) }
function wecomPayload(rows: Array<{ room: string; record: string; progress: string; center?: string }> = [{ room: '1005', record: 'record-1', progress: '已缴费' }]) {
  return normalizeWecomLedgerEnvelope({
    source: 'wecom_ledger', businessDate: '2026-08-28', extractedAt: '2026-08-28T07:35:00+08:00', declaredRowCount: rows.length,
    rows: rows.map(row => ({ recordId: row.record, 房屋编号: `BJ-JRHY-1-1-${row.room}`, 欠费原因: '房屋空置', 催缴进展: row.progress, 最新跟进日期: '2026-08-27', __documentId: 'document-1', __sheetId: 'sheet-1', __housePrefix: 'BJ-JRHY', __serviceCenter: row.center || '嘉润花园' })),
  }, { now: new Date('2026-08-28T08:00:00+08:00') })
}
function qxmPayload(rows: Array<{ room?: string; message: string; content?: string }> = [{ room: '1-1-1005', message: 'message-1', content: '承诺月底缴费' }]) {
  return normalizeQxmEvidenceEnvelope({
    source: 'qxm', businessDate: '2026-08-28', extractedAt: '2026-08-28T07:40:00+08:00', declaredRowCount: rows.length,
    rows: rows.map(row => ({ messageId: row.message, external_userid: `external-${row.message}`, employeeUserId: 'employee-1', 房屋备注: row.room || '', 消息时间: '2026-08-27T10:20:00+08:00', 消息方向: '客户发送', 消息类型: '文本', 消息内容: row.content || '', __departmentId: 'dept-1', __serviceCenter: '嘉润花园', __housePrefix: 'BJ-JRHY' })),
    nextCursors: [{ departmentId: 'dept-1', cursor: 'cursor-next' }],
  }, { now: new Date('2026-08-28T08:00:00+08:00') })
}

test('通过门禁的绿仔数据原子发布，数据库只保存脱敏房号和稳定ID哈希', () => {
  const db = database()
  try {
    const result = publishLvzaiArrears(db, payload())
    assert.equal(result.idempotent, false)
    const run = db.prepare('SELECT * FROM arrears_source_sync_runs').get() as any
    const fact = db.prepare('SELECT * FROM arrears_lvzai_facts').get() as any
    assert.equal(run.status, 'published')
    assert.equal(run.row_count, 1)
    assert.equal(fact.house_masked, 'BJ-JRHY-1-1-1**5')
    assert.match(fact.house_hash, /^[a-f0-9]{64}$/)
    assert.match(fact.room_id_hash, /^[a-f0-9]{64}$/)
    assert.match(fact.person_id_hash, /^[a-f0-9]{64}$/)
    const serialized = JSON.stringify({ run, fact })
    assert.doesNotMatch(serialized, /BJ-JRHY-1-1-1005|room-1005|person-a/)
    assert.deepEqual(readArrearsConnectorStatus(db), {
      source: 'lvzai', state: 'published', businessDate: '2026-08-28', extractedAt: '2026-08-28T07:30:00+08:00',
      rowCount: 1, uniqueHouseCount: 1, totalAmount: 1250.5,
      quality: { state: 'passed', source: 'lvzai', businessDate: '2026-08-28', rowCount: 1, uniqueHouseCount: 1, totalAmount: 1250.5, roomSignCompletenessRate: 1, amountCompletenessRate: 1, duplicateCount: 0 },
    })
  } finally { db.close() }
})

test('相同证据幂等，新证据原子替代同日旧批次，旧证据不得回放', () => {
  const db = database()
  try {
    const first = publishLvzaiArrears(db, payload())
    const repeated = publishLvzaiArrears(db, payload())
    assert.equal(repeated.runId, first.runId)
    assert.equal(repeated.idempotent, true)
    const second = publishLvzaiArrears(db, payload(1300))
    assert.notEqual(second.runId, first.runId)
    assert.deepEqual(db.prepare('SELECT status FROM arrears_source_sync_runs ORDER BY id').all().map((row: any) => row.status), ['superseded', 'published'])
    assert.throws(() => publishLvzaiArrears(db, payload()), /拒绝重新发布已被更新批次替代/)
    assert.equal((db.prepare('SELECT COUNT(*) count FROM arrears_source_sync_runs').get() as any).count, 2)
  } finally { db.close() }
})

test('未连接时状态明确不可用，不补造业务日期和金额', () => {
  const db = database()
  try {
    assert.deepEqual(readArrearsConnectorStatus(db), {
      source: 'lvzai', state: 'not_connected', businessDate: null, extractedAt: null,
      rowCount: 0, uniqueHouseCount: 0, totalAmount: null, quality: null,
    })
    assert.equal(readArrearsConnectorStatus(db, 'wecom_ledger').state, 'not_connected')
  } finally { db.close() }
})

test('企业微信台账原子幂等发布，只保存结构化状态和稳定ID哈希', () => {
  const db = database()
  try {
    const first = publishWecomLedger(db, wecomPayload())
    assert.equal(first.idempotent, false)
    const repeated = publishWecomLedger(db, wecomPayload())
    assert.equal(repeated.runId, first.runId)
    assert.equal(repeated.idempotent, true)
    const fact = db.prepare('SELECT * FROM arrears_wecom_ledger_facts').get() as any
    assert.equal(fact.progress, 'reported_paid_pending_lvzai')
    assert.equal(fact.manual_cause, 'vacancy')
    assert.equal(fact.house_masked, 'BJ-JRHY-1-1-1**5')
    assert.equal(db.prepare("SELECT total_amount FROM arrears_source_sync_runs WHERE source='wecom_ledger'").pluck().get(), null)
    assert.match(fact.document_id_hash, /^[a-f0-9]{64}$/)
    assert.match(fact.record_id_hash, /^[a-f0-9]{64}$/)
    assert.doesNotMatch(JSON.stringify(fact), /document-1|record-1|BJ-JRHY-1-1-1005|房屋空置|已缴费/)
    assert.deepEqual(readArrearsConnectorStatus(db, 'wecom_ledger'), {
      source: 'wecom_ledger', state: 'published', businessDate: '2026-08-28', extractedAt: '2026-08-28T07:35:00+08:00', rowCount: 1, uniqueHouseCount: 1, totalAmount: null,
      quality: { state: 'passed', source: 'wecom_ledger', businessDate: '2026-08-28', rowCount: 1, uniqueHouseCount: 1, fullRoomSignCompletenessRate: 1, stableEvidenceCompletenessRate: 1, duplicateRecordCount: 0, authoritativeAmountFields: 0 },
    })
    const replacement = publishWecomLedger(db, wecomPayload([{ room: '1005', record: 'record-2', progress: '持续跟进' }]))
    assert.notEqual(replacement.runId, first.runId)
    assert.throws(() => publishWecomLedger(db, wecomPayload()), /拒绝重新发布已被更新批次替代/)
  } finally { db.close() }
})

test('企小码增量证据按消息ID幂等追加，原文、客户及员工稳定ID不入库', () => {
  const db = database()
  try {
    const firstPayload = qxmPayload([{ room: '1-1-1005', message: 'm1', content: '承诺月底缴费' }, { message: 'm2', content: '联系不上' }])
    const first = publishQxmEvidence(db, firstPayload)
    assert.equal(first.insertedCount, 2)
    assert.equal(first.existingCount, 0)
    const repeated = publishQxmEvidence(db, firstPayload)
    assert.equal(repeated.idempotent, true)
    const incremental = publishQxmEvidence(db, qxmPayload([{ room: '1-1-1005', message: 'm1', content: '承诺月底缴费' }, { room: '1-1-1006', message: 'm3', content: '房屋空置' }]))
    assert.equal(incremental.insertedCount, 1)
    assert.equal(incremental.existingCount, 1)
    assert.equal((db.prepare('SELECT COUNT(*) count FROM arrears_qxm_evidence').get() as any).count, 3)
    const facts = db.prepare('SELECT * FROM arrears_qxm_evidence ORDER BY id').all() as any[]
    assert.equal(facts[1].match_state, 'review_required')
    assert.equal(facts[1].house_masked, '房屋号未关联')
    assert.equal(db.prepare("SELECT total_amount FROM arrears_source_sync_runs WHERE source='qxm' ORDER BY id DESC LIMIT 1").pluck().get(), null)
    assert.doesNotMatch(JSON.stringify(facts), /承诺月底缴费|联系不上|房屋空置|external-|employee-1|\"m[123]\"/)
    assert.equal(readArrearsConnectorStatus(db, 'qxm').state, 'published')
    assert.throws(() => publishQxmEvidence(db, qxmPayload([{ room: '1-1-1005', message: 'm1', content: '内容发生变化' }])), /证据内容发生冲突/)
  } finally { db.close() }
})

test('企小码分片覆盖率按服务中心授权返回且不泄露部门标识', () => {
  const db = database()
  try {
    const insert = db.prepare(`INSERT INTO arrears_qxm_shard_status
      (department_id_hash,service_center,business_date,extracted_at,state,error_code,row_count,matched_count,isolated_count,cursor_advanced,run_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`)
    insert.run('a'.repeat(64), '嘉润花园', '2026-08-28', '2026-08-28T08:00:00+08:00', 'passed', '', 2, 1, 1, 1)
    insert.run('b'.repeat(64), '其他服务中心', '2026-08-28', '2026-08-28T08:01:00+08:00', 'failed', 'source_timeout', 0, 0, 0, 0)
    const scoped = readQxmShardCoverage(db, { serviceCenters: ['嘉润花园'] })
    assert.deepEqual(scoped, {
      summary: { total: 1, passed: 1, failed: 0 },
      rows: [{ serviceCenter: '嘉润花园', state: 'passed', businessDate: '2026-08-28', extractedAt: '2026-08-28T08:00:00+08:00', errorCode: null, rowCount: 2, matchedCount: 1, isolatedCount: 1, matchRate: 0.5, cursorAdvanced: true }],
    })
    assert.doesNotMatch(JSON.stringify(scoped), /aaaaaaaa|department/i)
  } finally { db.close() }
})

test('欠费连接器状态接口携带按账号范围过滤的企小码项目覆盖率', () => {
  const routeSource = fs.readFileSync(new URL('../src/routes/arrears-analysis.ts', import.meta.url), 'utf8')
  assert.match(routeSource, /readQxmShardCoverage/)
  assert.match(routeSource, /qxmCoverage:\s*readQxmShardCoverage\(db,\s*\{\s*serviceCenters:\s*authorizedCenters\s*\}\)/)
})

test('企小码未关联及不在当前绿仔的证据自动隔离；已关联证据仍识别缺证和冲突信号', () => {
  const db = database()
  try {
    publishLvzaiArrears(db, lvzaiRows([{ room: '1005', amount: 100 }, { room: '1006', amount: 200 }]))
    publishQxmEvidence(db, qxmPayload([
      { room: '1-1-1005', message: 'q1', content: '承诺月底缴费' },
      { room: '1-1-1005', message: 'q2', content: '房屋空置且资金周转困难' },
      { room: '1-1-1007', message: 'q3', content: '持续沟通' },
      { message: 'q4', content: '联系不上' },
    ]))
    const result = readArrearsEvidenceConflicts(db)
    assert.equal(result.counts.lvzai_without_qxm_evidence, 1)
    assert.equal(result.counts.qxm_without_current_lvzai, 0)
    assert.equal(result.counts.qxm_room_review_required, 0)
    assert.equal(result.counts.qxm_signal_conflicted, 1)
    const qxmRows = result.rows.filter(row => row.type.startsWith('qxm_') || row.type === 'lvzai_without_qxm_evidence')
    assert.equal(qxmRows.length, 2)
    assert.ok(qxmRows.some(row => row.evidenceRefs.some(ref => ref.startsWith('QX-'))))
    assert.ok(qxmRows.every(row => row.qxmBusinessDate === '2026-08-28'))
    assert.doesNotMatch(JSON.stringify(qxmRows), /承诺月底缴费|资金周转困难|持续沟通|联系不上|external-|employee-/)
  } finally { db.close() }
})

test('绿仔与企业微信仅按房屋HMAC关联并生成三类安全冲突队列', () => {
  const db = database()
  try {
    publishLvzaiArrears(db, lvzaiRows([{ room: '1005', amount: 1250.5 }, { room: '1006', amount: 300 }]))
    publishWecomLedger(db, wecomPayload([
      { room: '1005', record: 'record-paid', progress: '已缴费' },
      { room: '1007', record: 'record-unmatched', progress: '持续跟进' },
    ]))
    const result = readArrearsEvidenceConflicts(db)
    assert.deepEqual(result.counts, { service_center_mismatch: 0, reported_paid_but_lvzai_arrears: 1, wecom_without_current_lvzai: 1, lvzai_without_wecom_ledger: 1, lvzai_without_qxm_evidence: 0, qxm_without_current_lvzai: 0, qxm_room_review_required: 0, qxm_signal_conflicted: 0 })
    assert.equal(result.total, 3)
    assert.equal(result.rows.length, 3)
    const paid = result.rows.find(row => row.type === 'reported_paid_but_lvzai_arrears')!
    assert.equal(paid.authoritativeArrearsAmount, 1250.5)
    assert.equal(paid.lvzaiBusinessDate, '2026-08-28')
    assert.equal(paid.wecomBusinessDate, '2026-08-28')
    assert.ok(paid.evidenceRefs.some(ref => ref.startsWith('LZ-')))
    assert.ok(paid.evidenceRefs.some(ref => ref.startsWith('WX-')))
    assert.doesNotMatch(JSON.stringify(result), /BJ-JRHY-1-1-100[567]|record-|room-|person-/)
  } finally { db.close() }
})

test('冲突队列按服务中心授权、类型和分页过滤，并优先暴露服务中心配置冲突', () => {
  const db = database()
  try {
    publishLvzaiArrears(db, lvzaiRows([
      { room: '1005', amount: 100, center: '嘉润花园' },
      { room: '1006', amount: 200, center: '其他服务中心' },
      { room: '1007', amount: 300, center: '嘉润花园' },
    ]))
    publishWecomLedger(db, wecomPayload([
      { room: '1005', record: 'r1', progress: '已缴费', center: '嘉润花园' },
      { room: '1006', record: 'r2', progress: '已缴费', center: '嘉润花园' },
      { room: '1008', record: 'r3', progress: '持续跟进', center: '其他服务中心' },
    ]))
    const scoped = readArrearsEvidenceConflicts(db, { serviceCenters: ['其他服务中心'], limit: 1 })
    assert.equal(scoped.total, 2)
    assert.equal(scoped.rows.length, 1)
    assert.equal(scoped.truncated, true)
    assert.equal(scoped.counts.service_center_mismatch, 1)
    assert.equal(scoped.counts.reported_paid_but_lvzai_arrears, 0)
    assert.equal(scoped.counts.wecom_without_current_lvzai, 1)
    const typed = readArrearsEvidenceConflicts(db, { serviceCenters: ['其他服务中心'], type: 'wecom_without_current_lvzai', offset: 0, limit: 10 })
    assert.equal(typed.total, 1)
    assert.equal(typed.rows[0].serviceCenter, '其他服务中心')
    assert.equal(typed.rows[0].type, 'wecom_without_current_lvzai')
  } finally { db.close() }
})

test('冲突人工复核使用结构化原因和乐观版本，不保存自由备注', () => {
  const db = database()
  try {
    const lvzai = publishLvzaiArrears(db, lvzaiRows([{ room: '1005', amount: 100 }]))
    const wecom = publishWecomLedger(db, wecomPayload([{ room: '1005', record: 'r1', progress: '已缴费' }]))
    const conflict = readArrearsEvidenceConflicts(db).rows[0]
    const first = reviewArrearsEvidenceConflict(db, { conflict, decision: 'confirmed', reasonCode: 'source_lag', expectedVersion: 0, reviewedByUserId: 7, lvzaiRunId: lvzai.runId, wecomRunId: wecom.runId, qxmRunId: null })
    assert.equal(first.version, 1)
    const reviewed = readArrearsEvidenceConflicts(db, { conflictKey: conflict.conflictKey }).rows[0]
    assert.deepEqual(reviewed.review && { decision: reviewed.review.decision, reasonCode: reviewed.review.reasonCode, version: reviewed.review.version }, { decision: 'confirmed', reasonCode: 'source_lag', version: 1 })
    assert.throws(() => reviewArrearsEvidenceConflict(db, { conflict, decision: 'rejected', reasonCode: 'not_a_conflict', expectedVersion: 0, reviewedByUserId: 7, lvzaiRunId: lvzai.runId, wecomRunId: wecom.runId, qxmRunId: null }), /版本冲突/)
    const second = reviewArrearsEvidenceConflict(db, { conflict, decision: 'rejected', reasonCode: 'not_a_conflict', expectedVersion: 1, reviewedByUserId: 8, lvzaiRunId: lvzai.runId, wecomRunId: wecom.runId, qxmRunId: null })
    assert.equal(second.version, 2)
    const stored = db.prepare('SELECT * FROM arrears_evidence_conflict_reviews').get() as any
    assert.equal(stored.reviewed_by_user_id, 8)
    assert.equal(stored.version, 2)
    assert.equal(Object.prototype.hasOwnProperty.call(stored, 'note'), false)
    assert.throws(() => reviewArrearsEvidenceConflict(db, { conflict, decision: 'confirmed', reasonCode: 'free text' as any, expectedVersion: 2, reviewedByUserId: 8, lvzaiRunId: lvzai.runId, wecomRunId: wecom.runId, qxmRunId: null }), /原因代码无效/)
  } finally { db.close() }
})
