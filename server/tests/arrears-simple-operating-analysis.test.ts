import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { readArrearsSimpleOperatingAnalysis } from '../src/arrears-simple-operating-analysis.js'

function fixture() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE arrears_source_sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT,business_date TEXT,status TEXT);
    CREATE TABLE arrears_lvzai_facts (run_id INTEGER,house_hash TEXT,house_masked TEXT,service_center TEXT,amount REAL,period_start TEXT,period_end TEXT,fee_item TEXT,evidence_sha256 TEXT);
    CREATE TABLE arrears_wecom_ledger_facts (run_id INTEGER,house_hash TEXT,service_center TEXT,latest_followup_date TEXT,progress TEXT,manual_cause TEXT,evidence_sha256 TEXT);
    CREATE TABLE arrears_qxm_evidence (run_id INTEGER,house_hash TEXT,service_center TEXT,match_state TEXT,occurred_at TEXT,direction TEXT,signal_state TEXT,cause_signal TEXT,evidence_sha256 TEXT);
  `)
  return db
}
function run(db: Database.Database, source: string) { return Number(db.prepare("INSERT INTO arrears_source_sync_runs(source,business_date,status) VALUES (?,'2026-08-28','published')").run(source).lastInsertRowid) }
function house(db: Database.Database, runId: number, hash: string, room: string, center: string, amount: number, start: string) {
  db.prepare('INSERT INTO arrears_lvzai_facts VALUES (?,?,?,?,?,?,?,?,?)').run(runId, hash, room, center, amount, start, '2026-08-28', '物业服务费', `lz-${hash}`)
}

test('简版经营分析按绿仔金额汇总账龄、原因和动作，逐户仅使用房间号标识', () => {
  const db = fixture()
  try {
    const lz = run(db, 'lvzai'), wx = run(db, 'wecom_ledger'), qx = run(db, 'qxm')
    house(db, lz, 'h1', '1-1-101', '中心A', 1000, '2026-07-01')
    house(db, lz, 'h2', '2-1-202', '中心A', 3000, '2025-07-01')
    house(db, lz, 'h3', '3-1-303', '中心B', 9000, '2026-08-01')
    db.prepare('INSERT INTO arrears_wecom_ledger_facts VALUES (?,?,?,?,?,?,?)').run(wx, 'h1', '中心A', '2026-08-20', 'contacted', 'charge_dispute', 'wx-1')
    db.prepare('INSERT INTO arrears_qxm_evidence VALUES (?,?,?,?,?,?,?,?,?)').run(qx, 'h1', '中心A', 'matched', '2026-08-21T10:00:00Z', 'inbound', 'supported', 'charge_dispute', 'qx-1')
    const result = readArrearsSimpleOperatingAnalysis(db, { serviceCenters: ['中心A'] })
    assert.equal(result.ready, true)
    assert.deepEqual(result.summary, { totalAmount: 4000, householdCount: 2, earliestPeriod: '2025-07-01', knownCauseAmount: 1000, knownCauseAmountShare: 0.25 })
    assert.equal(result.ageingBuckets.find(item => item.key === 'within_3')?.amount, 1000)
    assert.equal(result.ageingBuckets.find(item => item.key === 'over_12')?.amount, 3000)
    assert.deepEqual(result.causes.map(item => [item.label, item.amount, item.evidenceLabel]), [['原因待核实', 3000, '缺少原因证据'], ['收费争议', 1000, '台账与沟通相互印证']])
    assert.deepEqual(result.households.map(item => item.room), ['2-1-202', '1-1-101'])
    assert.ok(result.actions.some(item => item.code === 'specialist_review_before_collection'))
    assert.ok(result.actions.some(item => item.code === 'collect_missing_evidence'))
    assert.deepEqual(result.actions.find(item => item.code === 'specialist_review_before_collection')?.rooms, ['1-1-101'])
    assert.deepEqual(result.actions.find(item => item.code === 'collect_missing_evidence')?.rooms, ['2-1-202'])
  } finally { db.close() }
})

test('没有绿仔正式批次时简版经营分析不生成模拟数据', () => {
  const db = fixture()
  try {
    const result = readArrearsSimpleOperatingAnalysis(db)
    assert.equal(result.ready, false); assert.equal(result.summary, null); assert.deepEqual(result.households, [])
  } finally { db.close() }
})
