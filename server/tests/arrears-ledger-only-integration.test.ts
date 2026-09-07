import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import * as XLSX from '@e965/xlsx'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(url: string, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await wait(100)
  }
  throw new Error(`服务未就绪：${url}`)
}

function workbook(rows: Record<string, unknown>[]) {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), '海淀片区')
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

test('仅上传周会台账时保留ledger_only口径并使用台账原因归因', { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arrears-ledger-only-'))
  const port = 41_000 + Math.floor(Math.random() * 1_000)
  const dbPath = path.join(root, 'cockpit.db')
  const keyPath = path.join(root, 'encryption-key')
  fs.writeFileSync(keyPath, 'integration-encryption-key-material-at-least-32-characters', { mode: 0o600 })
  fs.mkdirSync(path.join(root, 'raw'), { recursive: true, mode: 0o700 })
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      COCKPIT_DB_PATH: dbPath,
      COCKPIT_ADMIN_PASSWORD_FILE: path.join(root, 'admin-password'),
      JWT_SECRET: 'integration-jwt-secret-that-is-at-least-32-characters',
      DAILY_RECONCILIATION_JWT_SECRET: 'ledger-only-daily-automation-secret-at-least-32-characters',
      ARREARS_RAW_ROOT: path.join(root, 'raw'),
      ARREARS_ENCRYPTION_KEY_FILE: keyPath,
      ARREARS_ENCRYPTION_KEY_VERSION: 'test-v1',
      ARREARS_RESOURCE_HASH_KEY: 'integration-resource-hmac-key-at-least-32-characters',
      HERMES_COCKPIT_BASE_URL: 'http://127.0.0.1:9',
      HERMES_COCKPIT_API_KEY: 'test-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', chunk => { logs += chunk })
  child.stderr.on('data', chunk => { logs += chunk })
  let db: Database.Database | null = null
  try {
    try {
      await waitFor(`http://127.0.0.1:${port}/api/health`)
    } catch (error: any) {
      throw new Error(`${error.message}\n${logs}`)
    }
    db = new Database(dbPath)
    db.pragma('foreign_keys = ON')
    const profileBatch = db.prepare("INSERT INTO project_profile_import_batches (source_file,source_sha256,source_sheet,filter_status,profile_count,phase_count) VALUES ('integration.xlsx','ledger-only-profile-sha','项目','在管',1,3)").run()
    const project = db.prepare('INSERT INTO project_profiles (batch_id,service_center,area,management_status) VALUES (?,?,?,?)').run(profileBatch.lastInsertRowid, '第一服务北京上第MOMΛ服务中心', '海淀片区', '在管')
    const insertPhase = db.prepare("INSERT INTO project_phase_profiles(batch_id,profile_id,source_row,phase_name,management_status,payload_json) VALUES (?,?,?,?,?,'{}')")
    insertPhase.run(profileBatch.lastInsertRowid, project.lastInsertRowid, 1, '北京上第MOMΛ一期（上第）', '在管')
    insertPhase.run(profileBatch.lastInsertRowid, project.lastInsertRowid, 2, '北京上第MOMΛ二期（I）', '在管')
    insertPhase.run(profileBatch.lastInsertRowid, project.lastInsertRowid, 3, '北京上第MOMΛ三期（悦）', '在管')
    const password = fs.readFileSync(path.join(root, 'admin-password'), 'utf8').trim()
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
    })
    assert.equal(login.status, 200, logs)
    const token = (await login.json() as any).token
    const ledger = workbook([
      { 房间: 'BJ-HD-1-1-101', 合计: 2_280, 费用开始日期: '2025-01-01', 费用结束日期: '2025-12-31', 欠费原因: '室内漏水维修响应不及时', 是否回款: '' },
      { 房间: 'BJ-HD-1-1-102', 合计: 1_500, 费用开始日期: '2025-01-01', 费用结束日期: '2025-12-31', 欠费原因: '承诺月底缴费', 是否回款: '是' },
    ])
    const form = new FormData()
    form.set('projectId', String(project.lastInsertRowid))
    form.set('businessDate', '2026-08-28')
    form.set('ledger', new Blob([new Uint8Array(ledger)]), '华北欠费周会材料.xlsx')
    const uploaded = await fetch(`http://127.0.0.1:${port}/api/arrears/batches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    const body = await uploaded.json() as any
    assert.equal(uploaded.status, 201, JSON.stringify(body))
    assert.equal(body.evidenceMode, 'ledger_only')
    assert.equal(body.communicationFilePresent, false)
    assert.equal(body.ledgerRows, 1)
    assert.equal(body.communicationRows, 0)
    const result = db.prepare('SELECT rule_category,rule_evidence_json FROM arrears_analysis_results WHERE batch_id=?').get(body.batchId) as any
    assert.equal(result.rule_category, 'service_dispute')
    assert.deepEqual(JSON.parse(result.rule_evidence_json), ['T-2'])
    assert.equal((db.prepare('SELECT COUNT(*) count FROM arrears_communication_rows WHERE batch_id=?').get(body.batchId) as any).count, 0)
    const diagnosisResponse = await fetch(`http://127.0.0.1:${port}/api/arrears/batches/${body.batchId}/diagnosis`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const diagnosisText = await diagnosisResponse.text()
    assert.match(diagnosisResponse.headers.get('content-type') || '', /application\/json/, diagnosisText)
    const diagnosis = JSON.parse(diagnosisText) as any
    assert.equal(diagnosisResponse.status, 200, diagnosisText)
    assert.equal(diagnosis.analysisBasis, '欠费金额、账龄和房屋信息以本次上传的欠费台账为准。本次未提供聊天记录，仅依据欠费台账进行分析。')
    assert.deepEqual(diagnosis.reasons.map((item: any) => item.label), ['服务质量或沟通争议', '承诺缴费但未兑现', '欠费原因证据不足', '失联或产权信息待确认'])
    assert.equal(diagnosis.summary.householdCount, 1)
    assert.equal(diagnosis.summary.totalAmount, 2280)
    assert.equal(diagnosis.reasons[0].households[0].room, 'BJ-HD-1-1-101')
    assert.equal(diagnosis.reasons[0].households[0].periodStart, '2025-01-01')
    assert.equal(diagnosis.reasons[0].households[0].periodEnd, '2025-12-31')
    assert.equal(diagnosis.reasons[0].households[0].actionPlan.steps.length >= 6, true)
    assert.equal(diagnosis.reasons[0].households[0].actionPlan.completionStandards.length >= 3, true)
    assert.equal(diagnosis.reasons[0].households[0].actionPlan.escalationTriggers.length >= 2, true)

    const mixedLedger = workbook([
      { 小区: '北京上第MOMΛ一期（上第）', 房间: 'BJ-TEST-1-1-103', 合计: '500', 欠费原因: '承诺缴费', 是否回款: '' },
      { 小区: '其他服务中心', 房间: 'BJ-OTHER-1-1-101', 合计: '900', 欠费原因: '服务争议', 是否回款: '' },
    ])
    const scopedForm = new FormData()
    scopedForm.set('projectId', String(project.lastInsertRowid))
    scopedForm.set('businessDate', '2026-08-28')
    scopedForm.set('ledger', new Blob([new Uint8Array(mixedLedger)]), '混合服务中心欠费台账.xlsx')
    const scopedResponse = await fetch(`http://127.0.0.1:${port}/api/arrears/batches`, {
      method: 'POST',
      headers: { Authorization: ['Bearer', token].join(' ') },
      body: scopedForm,
    })
    const scopedBody = await scopedResponse.json() as any
    assert.equal(scopedResponse.status, 201, JSON.stringify(scopedBody))
    assert.equal(scopedBody.ledgerRows, 1, '混合台账只能导入与所选服务中心精确匹配的行')
    const leaked = db.prepare("SELECT COUNT(*) AS count FROM arrears_ledger_rows WHERE resource_masked LIKE '%OTHER%'").get() as { count: number }
    assert.equal(leaked.count, 0)

    const mergedLedger = workbook([
      { 小区: '北京上第MOMΛ', 房间: 'BJ-SD-1-1-101', 合计: '100', 欠费原因: '室内漏水未维修，拒绝缴费', 是否回款: '' },
      { 小区: '北京IMOMΛ', 房间: 'BJ-SD-IMOMA-1-102', 合计: '200', 欠费原因: '资金周转不开，年底结清', 是否回款: '' },
      { 小区: '北京悦MOMΛ', 房间: 'BJ-SD-YUE-1-103', 合计: '300', 欠费原因: '电话不接，企微不回', 是否回款: '' },
      { 小区: '其他服务中心', 房间: 'BJ-OTHER-1-1-104', 合计: '400', 欠费原因: '服务争议', 是否回款: '' },
    ])
    const mergedForm = new FormData()
    mergedForm.set('projectId', String(project.lastInsertRowid))
    mergedForm.set('businessDate', '2026-08-31')
    mergedForm.set('ledger', new Blob([new Uint8Array(mergedLedger)]), '上第MOMA三期合并.xlsx')
    const mergedResponse = await fetch(`http://127.0.0.1:${port}/api/arrears/batches`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: mergedForm,
    })
    const mergedBody = await mergedResponse.json() as any
    assert.equal(mergedResponse.status, 201, JSON.stringify(mergedBody))
    assert.equal(mergedBody.ledgerRows, 3, '上第MOMA、IMOMA、悦MOMA必须统一归入上第MOMA服务中心')
    const mergedRules = db.prepare('SELECT rule_category FROM arrears_analysis_results WHERE batch_id=? ORDER BY id').all(mergedBody.batchId) as Array<{ rule_category: string }>
    assert.deepEqual(mergedRules.map(row => row.rule_category), ['service_dispute', 'financial_hardship', 'contact_barrier'])

    db.prepare("UPDATE arrears_upload_batches SET parser_version='arrears-template-v1' WHERE id=?").run(mergedBody.batchId)
    const reprocessForm = new FormData()
    reprocessForm.set('projectId', String(project.lastInsertRowid))
    reprocessForm.set('businessDate', '2026-08-31')
    reprocessForm.set('ledger', new Blob([new Uint8Array(mergedLedger)]), '上第MOMA三期合并.xlsx')
    const reprocessedResponse = await fetch(`http://127.0.0.1:${port}/api/arrears/batches`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: reprocessForm,
    })
    const reprocessed = await reprocessedResponse.json() as any
    assert.equal(reprocessedResponse.status, 201, JSON.stringify(reprocessed))
    assert.equal(reprocessed.supersedesBatchId, mergedBody.batchId)
    assert.notEqual(reprocessed.batchId, mergedBody.batchId)
    assert.equal((db.prepare('SELECT parser_version FROM arrears_upload_batches WHERE id=?').get(reprocessed.batchId) as any).parser_version, 'arrears-template-v3')
    assert.equal((db.prepare('SELECT resource_display FROM arrears_ledger_rows WHERE batch_id=? ORDER BY source_row LIMIT 1').get(reprocessed.batchId) as any).resource_display, 'BJ-SD-1-1-101')
  } finally {
    db?.close()
    child.kill('SIGTERM')
    await wait(100)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
