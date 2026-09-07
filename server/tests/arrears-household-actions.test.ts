import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { readArrearsHouseholdActions } from '../src/arrears-household-actions.js'

function database() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE arrears_source_sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT,business_date TEXT,extracted_at TEXT,status TEXT,row_count INTEGER,unique_house_count INTEGER,total_amount REAL,quality_json TEXT,evidence_sha256 TEXT);
    CREATE TABLE arrears_lvzai_facts (run_id INTEGER,house_hash TEXT,house_masked TEXT,service_center TEXT,amount REAL,period_start TEXT,period_end TEXT,fee_item TEXT,evidence_sha256 TEXT);
    CREATE TABLE arrears_wecom_ledger_facts (run_id INTEGER,house_hash TEXT,service_center TEXT,latest_followup_date TEXT,progress TEXT,manual_cause TEXT,evidence_sha256 TEXT);
    CREATE TABLE arrears_qxm_evidence (id INTEGER PRIMARY KEY AUTOINCREMENT,run_id INTEGER,house_hash TEXT,house_masked TEXT,service_center TEXT,match_state TEXT,occurred_at TEXT,direction TEXT,signal_state TEXT,cause_signal TEXT,evidence_sha256 TEXT);
  `)
  return db
}
function run(db: Database.Database, source: string, date = '2026-08-28') { return Number(db.prepare("INSERT INTO arrears_source_sync_runs(source,business_date,status) VALUES (?,?,'published')").run(source, date).lastInsertRowid) }
function authority(db: Database.Database, runId: number, house: string, center: string, amount: number, start = '2025-01-01', evidence = `lz-${house}`) {
  db.prepare('INSERT INTO arrears_lvzai_facts VALUES (?,?,?,?,?,?,?,?,?)').run(runId, house, `${house.slice(0, 2)}***${house.slice(-2)}`, center, amount, start, '2026-08-28', '物业服务费', evidence)
}

test('没有绿仔正式批次时逐户建议明确未就绪且不生成模拟结论', () => {
  const db = database()
  try { assert.deepEqual(readArrearsHouseholdActions(db), { ready: false, businessDate: null, total: 0, rows: [], truncated: false }) } finally { db.close() }
})

test('逐户建议严格区分事实、规则判断和待核实事项，人工已缴不得覆盖绿仔状态', () => {
  const db = database()
  try {
    const lz = run(db, 'lvzai'), wx = run(db, 'wecom_ledger'), qx = run(db, 'qxm')
    authority(db, lz, 'house-a', '嘉润花园', 8000)
    db.prepare('INSERT INTO arrears_wecom_ledger_facts VALUES (?,?,?,?,?,?,?)').run(wx, 'house-a', '嘉润花园', '2026-08-27', 'reported_paid_pending_lvzai', 'promised_payment', 'wx-evidence')
    db.prepare('INSERT INTO arrears_qxm_evidence(run_id,house_hash,house_masked,service_center,match_state,occurred_at,direction,signal_state,cause_signal,evidence_sha256) VALUES (?,?,?,?,?,?,?,?,?,?)').run(qx, 'house-a', 'ho***-a', '嘉润花园', 'matched', '2026-08-27T10:00:00Z', 'inbound', 'supported', 'promised_payment', 'qx-evidence')
    const result = readArrearsHouseholdActions(db)
    assert.equal(result.ready, true); assert.equal(result.total, 1)
    const row = result.rows[0]
    assert.equal(row.authoritativeArrearsAmount, 8000)
    assert.ok(row.knownFacts.some(item => item.includes('绿仔2026-08-28权威欠费金额')))
    assert.ok(row.knownFacts.some(item => item.includes('企小码最近结构化沟通信号日期')))
    assert.ok(row.reasonableJudgments.some(item => item.includes('可能存在“承诺缴费”')))
    assert.ok(row.pendingVerification.some(item => item.includes('人工报告已缴，但绿仔仍显示欠费')))
    assert.ok(row.pendingVerification.some(item => item.includes('尚未由权威来源确认')))
    assert.ok(row.recommendationCodes.includes('verify_lvzai_payment_status'))
    assert.equal(row.priority, 'priority_review')
    assert.deepEqual(row.evidenceRefs, ['LZ-lz-house-a', 'WX-wx-evidence', 'QX-qx-evidence'])
  } finally { db.close() }
})

test('企小码多原因或否定冲突只进入待核实，不生成针对具体原因的催缴建议', () => {
  const db = database()
  try {
    const lz = run(db, 'lvzai'), qx = run(db, 'qxm')
    authority(db, lz, 'house-a', '中心A', 1000, '2026-07-01')
    for (const [state, cause, evidence] of [['supported', 'legal_dispute', 'q1'], ['supported', 'contact_barrier', 'q2'], ['conflicted', 'unknown', 'q3']] as const) db.prepare('INSERT INTO arrears_qxm_evidence(run_id,house_hash,house_masked,service_center,match_state,occurred_at,direction,signal_state,cause_signal,evidence_sha256) VALUES (?,?,?,?,?,?,?,?,?,?)').run(qx, 'house-a', 'ho***-a', '中心A', 'matched', '2026-08-27T10:00:00Z', 'system', state, cause, evidence)
    const row = readArrearsHouseholdActions(db).rows[0]
    assert.ok(row.pendingVerification.some(item => item.includes('多原因冲突')))
    assert.deepEqual(row.recommendationCodes, ['collect_missing_evidence'])
    assert.ok(row.recommendationLabels.every(item => !item.includes('必须缴费') && !item.includes('已确认原因')))
  } finally { db.close() }
})

test('服务中心权限、分页和金额排序均在服务端执行', () => {
  const db = database()
  try {
    const lz = run(db, 'lvzai')
    authority(db, lz, 'house-a', '中心A', 100)
    authority(db, lz, 'house-b', '中心A', 200)
    authority(db, lz, 'house-c', '中心B', 999)
    const scoped = readArrearsHouseholdActions(db, { serviceCenters: ['中心A'], limit: 1 })
    assert.equal(scoped.total, 2); assert.equal(scoped.rows.length, 1); assert.equal(scoped.truncated, true); assert.equal(scoped.rows[0].houseHash, 'house-b')
    const second = readArrearsHouseholdActions(db, { serviceCenters: ['中心A'], limit: 1, offset: 1 })
    assert.equal(second.rows[0].houseHash, 'house-a')
  } finally { db.close() }
})

test('逐户建议输出企小码确定性沟通指标且企业微信日期只作为历史人工记录', () => {
  const db = database()
  try {
    const lz = run(db, 'lvzai'), wx = run(db, 'wecom_ledger'), qx = run(db, 'qxm')
    authority(db, lz, 'house-a', '中心A', 1200)
    db.prepare('INSERT INTO arrears_wecom_ledger_facts VALUES (?,?,?,?,?,?,?)').run(wx, 'house-a', '中心A', '2026-08-20', 'contacted', 'unknown', 'wx-history')
    const insert = db.prepare('INSERT INTO arrears_qxm_evidence(run_id,house_hash,house_masked,service_center,match_state,occurred_at,direction,signal_state,cause_signal,evidence_sha256) VALUES (?,?,?,?,?,?,?,?,?,?)')
    insert.run(qx, 'house-a', 'ho***-a', '中心A', 'matched', '2026-08-27T02:00:00Z', 'outbound', 'none', 'unknown', 'qx-outbound')
    insert.run(qx, 'house-a', 'ho***-a', '中心A', 'matched', '2026-08-27T03:00:00Z', 'inbound', 'none', 'unknown', 'qx-inbound')
    const row = readArrearsHouseholdActions(db).rows[0]
    assert.deepEqual(row.communicationFacts, {
      messageCount: 2,
      outboundCount: 1,
      inboundCount: 1,
      latestCommunicationAt: '2026-08-27T03:00:00Z',
      latestOutboundAt: '2026-08-27T02:00:00Z',
      latestInboundAt: '2026-08-27T03:00:00Z',
      hasTwoWayCommunication: true,
    })
    assert.ok(row.knownFacts.some(item => item.includes('企小码已匹配沟通消息2条')))
    assert.ok(row.knownFacts.some(item => item.includes('存在双向沟通证据')))
    assert.ok(row.knownFacts.some(item => item.includes('企业微信历史人工记录日期2026-08-20')))
    assert.ok(row.knownFacts.every(item => !item.includes('企业微信人工台账最近跟进日期')))
  } finally { db.close() }
})
