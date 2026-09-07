import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { loadWecomLedgerScopeConfig, runWecomLedgerJob, validateWecomLedgerScopeConfig } from '../src/wecom-ledger-job.js'
import type { WecomLedgerTransport } from '../src/wecom-ledger-connector.js'

const previous = process.env.ARREARS_RESOURCE_HASH_KEY
process.env.ARREARS_RESOURCE_HASH_KEY = 'wecom-job-test-resource-key-at-least-32'
test.after(() => { if (previous === undefined) delete process.env.ARREARS_RESOURCE_HASH_KEY; else process.env.ARREARS_RESOURCE_HASH_KEY = previous })

function rawConfig() {
  return { schemaVersion: 1, documentId: 'document-controlled', sheets: [{ sheetId: 'sheet-jrhy', projects: [{ housePrefix: 'BJ-JRHY', serviceCenter: '嘉润花园' }] }], minimumRows: 1 }
}
function transport(): WecomLedgerTransport {
  return { async readSheet() { return { rows: [{ recordId: 'record-1', 房屋编号: 'BJ-JRHY-1-1-1005', 欠费原因: '房屋空置', 催缴进展: '持续跟进', 最新跟进日期: '2026-08-27' }], total: 1 } } }
}
function database() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE arrears_source_sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT,business_date TEXT,extracted_at TEXT,status TEXT,row_count INTEGER,unique_house_count INTEGER,total_amount REAL,quality_json TEXT,evidence_sha256 TEXT,UNIQUE(source,business_date,evidence_sha256));
    CREATE TABLE arrears_wecom_ledger_facts (id INTEGER PRIMARY KEY AUTOINCREMENT,run_id INTEGER,source_row INTEGER,house_hash TEXT,house_masked TEXT,service_center TEXT,document_id_hash TEXT,sheet_id_hash TEXT,record_id_hash TEXT,manual_cause TEXT,progress TEXT,latest_followup_date TEXT,promised_payment_date TEXT,responsible_user_id_hash TEXT,evidence_sha256 TEXT,UNIQUE(run_id,source_row),UNIQUE(run_id,record_id_hash),UNIQUE(run_id,evidence_sha256));
  `)
  return db
}

test('企业微信范围配置固定文档、工作表、房屋前缀和服务中心并拒绝凭据', () => {
  const config = validateWecomLedgerScopeConfig(rawConfig())
  assert.equal(config.sheets[0].projects[0].serviceCenter, '嘉润花园')
  assert.throws(() => validateWecomLedgerScopeConfig({ ...rawConfig(), token: 'forbidden' }), /不得包含凭据字段/)
  assert.throws(() => validateWecomLedgerScopeConfig({ ...rawConfig(), sheets: [...rawConfig().sheets, rawConfig().sheets[0]] }), /为空、过长或重复/)
  assert.throws(() => validateWecomLedgerScopeConfig({ ...rawConfig(), sheets: [{ ...rawConfig().sheets[0], projects: [{ housePrefix: 'JRHY', serviceCenter: '嘉润花园' }] }] }), /城市代码-项目代码/)
})

test('企业微信范围配置文件允许640但拒绝644、符号链接和越权字段', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-scope-'))
  const file = path.join(root, 'scope.json'), link = path.join(root, 'link.json')
  try {
    fs.writeFileSync(file, JSON.stringify(rawConfig()), { mode: 0o640 }); fs.chmodSync(file, 0o640)
    assert.equal(loadWecomLedgerScopeConfig(file).documentId, 'document-controlled')
    fs.chmodSync(file, 0o644)
    assert.throws(() => loadWecomLedgerScopeConfig(file), /其他用户访问/)
    fs.chmodSync(file, 0o640); fs.symlinkSync(file, link)
    assert.throws(() => loadWecomLedgerScopeConfig(link), /不得为符号链接/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('企业微信任务默认只读试运行，摘要不输出文档、工作表、房屋及人工原因', async () => {
  const result = await runWecomLedgerJob({ config: validateWecomLedgerScopeConfig(rawConfig()), transport: transport(), businessDate: '2026-08-28', now: new Date('2026-08-28T08:00:00+08:00') })
  assert.deepEqual(result, { mode: 'dry-run', source: 'wecom_ledger', businessDate: '2026-08-28', extractedAt: result.extractedAt, sheetScopeCount: 1, rowCount: 1, uniqueHouseCount: 1, authoritativeAmountFields: 0, qualityState: 'passed', publication: null })
  assert.doesNotMatch(JSON.stringify(result), /document-controlled|sheet-jrhy|BJ-JRHY|record-1|房屋空置/)
})

test('企业微信正式发布要求生产环境、业务日期确认和受控数据库', async () => {
  const config = validateWecomLedgerScopeConfig(rawConfig())
  await assert.rejects(runWecomLedgerJob({ config, transport: transport(), businessDate: '2026-08-28', now: new Date('2026-08-28T08:00:00+08:00'), publish: true, publishConfirmation: '2026-08-28', nodeEnv: 'development' }), /双重确认/)
  await assert.rejects(runWecomLedgerJob({ config, transport: transport(), businessDate: '2026-08-28', now: new Date('2026-08-28T08:00:00+08:00'), publish: true, publishConfirmation: '2026-08-28', nodeEnv: 'production' }), /缺少受控数据库/)
  const db = database()
  try {
    const result = await runWecomLedgerJob({ config, transport: transport(), database: db, businessDate: '2026-08-28', now: new Date('2026-08-28T08:00:00+08:00'), publish: true, publishConfirmation: '2026-08-28', nodeEnv: 'production' })
    assert.equal(result.mode, 'published')
    assert.equal((db.prepare('SELECT COUNT(*) count FROM arrears_wecom_ledger_facts').get() as any).count, 1)
    assert.equal(db.prepare('SELECT total_amount FROM arrears_source_sync_runs').pluck().get(), null)
  } finally { db.close() }
})
