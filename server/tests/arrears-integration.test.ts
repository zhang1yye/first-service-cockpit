import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import * as XLSX from '@e965/xlsx'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(url: string, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { try { const r = await fetch(url); if (r.ok) return } catch {} await wait(100) }
  throw new Error(`服务未就绪：${url}`)
}
function workbook(rows: Record<string, unknown>[], sheet: string) {
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheet)
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

test('欠费分析整链路：权限上传、密文归档、脱敏AI、证据门禁、人工复核、只读边界', { timeout: 120000 }, async () => {
  process.env.ARREARS_ENCRYPTION_KEY_VERSION = 'test-v1'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arrears-integration-'))
  const port = 39000 + Math.floor(Math.random() * 1000)
  const aiPort = 40000 + Math.floor(Math.random() * 1000)
  const dbPath = path.join(root, 'cockpit.db')
  let prompt = '', systemPrompt = '', userPrompt = '', aiDelayMs = 0, aiMode = 'normal'
  const mockAi = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    systemPrompt = String(payload.messages?.[0]?.content || '')
    userPrompt = String(payload.messages?.[1]?.content || '')
    prompt = `${systemPrompt}\n${userPrompt}`
    const resourceRefs = [...new Set([...userPrompt.matchAll(/"resourceRef":"([^"]+)"/g)].map(match => match[1]))]
    const items = aiMode === 'empty' ? [] : resourceRefs.map(resourceRef => ({ resourceRef, category: 'vacancy', confidence: 0.86, reason: '沟通证据明确提及房屋空置', evidenceRefs: ['C-2'] }))
    if (aiDelayMs) await new Promise(resolve => setTimeout(resolve, aiDelayMs))
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ model: 'mock-north-cockpit', choices: [{ message: { content: JSON.stringify(items) } }] }))
  })
  await new Promise<void>(resolve => mockAi.listen(aiPort, '127.0.0.1', resolve))
  const keyPath=path.join(root, 'encryption-key'); fs.writeFileSync(keyPath, 'integration-encryption-key-material-at-least-32-characters', { mode: 0o600 }); fs.mkdirSync(path.join(root,'raw'),{recursive:true,mode:0o700})
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), COCKPIT_DB_PATH: dbPath, COCKPIT_ADMIN_PASSWORD_FILE: path.join(root, 'admin-password'), JWT_SECRET: 'integration-jwt-secret-that-is-at-least-32-characters', DAILY_RECONCILIATION_JWT_SECRET: 'integration-daily-automation-secret-at-least-32-characters', ARREARS_RAW_ROOT: path.join(root, 'raw'), ARREARS_ENCRYPTION_KEY_FILE: path.join(root, 'encryption-key'), ARREARS_ENCRYPTION_KEY_VERSION: 'test-v1', ARREARS_RESOURCE_HASH_KEY: 'integration-resource-hmac-key-at-least-32-characters', HERMES_COCKPIT_BASE_URL: `http://127.0.0.1:${aiPort}`, HERMES_COCKPIT_API_KEY: 'test-key', HERMES_COCKPIT_MODEL: 'north-cockpit-test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''; child.stdout.on('data', b => { logs += b }); child.stderr.on('data', b => { logs += b })
  try {
    try { await waitFor(`http://127.0.0.1:${port}/api/health`) } catch (error: any) { throw new Error(`${error.message}\n${logs}`) }
    const db = new Database(dbPath)
    db.pragma('foreign_keys = ON')
    const profileBatch = db.prepare("INSERT INTO project_profile_import_batches (source_file,source_sha256,source_sheet,filter_status,profile_count,phase_count) VALUES ('integration.xlsx','integration-profile-sha','项目','在管',2,0)").run()
    const project = db.prepare("INSERT INTO project_profiles (batch_id,service_center,area,management_status) VALUES (?,?,?,?)").run(profileBatch.lastInsertRowid, '集成测试服务中心', '朝阳片区', '在管')
    const otherProject = db.prepare("INSERT INTO project_profiles (batch_id,service_center,area,management_status) VALUES (?,?,?,?)").run(profileBatch.lastInsertRowid, '未授权服务中心', '海淀片区', '在管')
    db.prepare("INSERT INTO users (username,password_hash,role,area_scope,project_scope,service_center_scope) VALUES (?,?,?,?,?,?)").run('project-manager-test', bcrypt.hashSync('ManagerTest!2026', 4), 'project_manager', '', String(project.lastInsertRowid), '集成测试服务中心')
    const tasksBefore = (db.prepare('SELECT COUNT(*) c FROM management_tasks').get() as any).c
    const paymentsBefore = (db.prepare('SELECT COUNT(*) c FROM payment_centers').get() as any).c
    const password = fs.readFileSync(path.join(root, 'admin-password'), 'utf8').trim()
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) })
    assert.equal(login.status, 200, logs)
    const token = (await login.json() as any).token
    const headers = { Authorization: `Bearer ${token}` }
    const managerLogin = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'project-manager-test', password: 'ManagerTest!2026' }) })
    const managerLoginBody = await managerLogin.json() as any
    assert.equal(managerLogin.status, 200, JSON.stringify(managerLoginBody))
    const managerToken = managerLoginBody.token
    const managerProjects = await fetch(`http://127.0.0.1:${port}/api/arrears/projects`, { headers: { Authorization: `Bearer ${managerToken}` } })
    const managerProjectRows = (await managerProjects.json() as any).rows
    assert.deepEqual(managerProjectRows.map((row: any) => row.id), [Number(project.lastInsertRowid)])
    const template = await fetch(`http://127.0.0.1:${port}/api/arrears/templates/ledger`, { headers })
    assert.equal(template.status, 200); assert.equal(Buffer.from(await template.arrayBuffer()).subarray(0, 2).toString(), 'PK')
    const ledger = workbook([{ 资源编码: 'A1-1-0101', 客户姓名: '张三', 手机号: '13800138000', 欠费金额: 1250.5, 费项: '物业费', 账龄天数: 93 }], '欠费台账')
    const communications = workbook([{ 资源编码: 'A1-1-0101', 沟通时间: '2026-08-05 10:00', 沟通方式: '企小码', 沟通人: '管家王五', 沟通记录: '张三表示手机号13800138000对应房屋长期空置，要求核对账单。' }], '企小码记录')
    const deniedForm = new FormData(); deniedForm.set('projectId', String(otherProject.lastInsertRowid)); deniedForm.set('businessDate', '2026-08-05'); deniedForm.set('ledger', new Blob([ledger]), '欠费台账.xlsx'); deniedForm.set('communications', new Blob([communications]), '企小码.xlsx')
    const deniedUpload = await fetch(`http://127.0.0.1:${port}/api/arrears/batches`, { method: 'POST', headers: { Authorization: `Bearer ${managerToken}` }, body: deniedForm })
    assert.equal(deniedUpload.status, 403)
    const form = new FormData(); form.set('projectId', String(project.lastInsertRowid)); form.set('businessDate', '2026-08-05'); form.set('ledger', new Blob([ledger]), '欠费台账.xlsx'); form.set('communications', new Blob([communications]), '企小码.xlsx')
    const uploaded = await fetch(`http://127.0.0.1:${port}/api/arrears/batches`, { method: 'POST', headers, body: form })
    const uploadBody = await uploaded.json() as any; assert.equal(uploaded.status, 201, JSON.stringify(uploadBody)); assert.equal(uploadBody.matchedResources, 1)
    const batchId = uploadBody.batchId

    const stored = db.prepare('SELECT customer_masked,phone_masked,evidence_json FROM arrears_ledger_rows WHERE batch_id=?').get(batchId) as any
    assert.notEqual(stored.customer_masked, '张三'); assert.equal(stored.phone_masked, '138****8000'); assert.equal(String(stored.evidence_json).includes('13800138000'), false)
    const storedComm = db.prepare('SELECT content_masked FROM arrears_communication_rows WHERE batch_id=?').get(batchId) as any
    assert.equal(storedComm.content_masked.includes('13800138000'), false); assert.equal(storedComm.content_masked.includes('张三'), false)
    const encrypted = fs.readFileSync(path.join(root, 'raw', String(batchId), 'ledger.enc'))
    const communicationEncrypted = fs.readFileSync(path.join(root, 'raw', String(batchId), 'communications.enc'))
    assert.equal(encrypted.includes(Buffer.from('13800138000')), false); assert.equal(encrypted[0], 1)
    const outsideBatch=path.join(root,'outside',String(batchId));fs.mkdirSync(outsideBatch,{recursive:true});fs.writeFileSync(path.join(outsideBatch,'ledger.enc'),encrypted);fs.writeFileSync(path.join(outsideBatch,'communications.enc'),communicationEncrypted);fs.symlinkSync(path.join(root,'outside'),path.join(root,'raw','hop'))
    const normalArchiveDir=path.join(root,'raw',String(batchId));db.prepare('UPDATE arrears_upload_batches SET encrypted_archive_dir=? WHERE id=?').run(path.join(root,'raw','hop',String(batchId)),batchId)
    const symlinkAnalyze=await fetch(`http://127.0.0.1:${port}/api/arrears/batches/${batchId}/analyze`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });const symlinkError=await symlinkAnalyze.text();assert.equal(symlinkAnalyze.status,409);assert.equal(symlinkError.includes(root),false)
    db.prepare('UPDATE arrears_upload_batches SET encrypted_archive_dir=? WHERE id=?').run(normalArchiveDir,batchId)
    db.prepare("UPDATE arrears_upload_batches SET archive_delete_state='pending' WHERE id=?").run(batchId)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/arrears/batches/${batchId}/analyze`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })).status, 409)
    db.prepare("UPDATE arrears_upload_batches SET archive_delete_state='active' WHERE id=?").run(batchId)
    fs.rmSync(path.join(root, 'raw', String(batchId), 'communications.enc'))
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/arrears/batches/${batchId}/analyze`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })).status, 409)
    fs.writeFileSync(path.join(root, 'raw', String(batchId), 'communications.enc'), communicationEncrypted, { mode: 0o600 })
    fs.appendFileSync(path.join(root, 'raw', String(batchId), 'ledger.enc'), Buffer.from([0]))
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/arrears/batches/${batchId}/analyze`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })).status, 409)
    fs.writeFileSync(path.join(root, 'raw', String(batchId), 'ledger.enc'), encrypted, { mode: 0o600 })
    const analyzed = await fetch(`http://127.0.0.1:${port}/api/arrears/batches/${batchId}/analyze`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })
    const analyzedBody = await analyzed.json() as any; assert.equal(analyzed.status, 202, JSON.stringify(analyzedBody)); assert.equal(analyzedBody.readOnly, true); assert.equal(analyzedBody.createsTasks, false)
    for (let i = 0; i < 100 && (db.prepare('SELECT status FROM arrears_upload_batches WHERE id=?').get(batchId) as any).status === 'analyzing'; i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal((db.prepare('SELECT status FROM arrears_upload_batches WHERE id=?').get(batchId) as any).status, 'analyzed')
    assert.equal(prompt.includes('13800138000'), false); assert.equal(prompt.includes('张三'), false); assert.equal(systemPrompt.includes('企小码记录缺失不等于未联系'), true)
    assert.equal(systemPrompt.includes('"resourceRef"'), false); assert.equal(userPrompt.includes('<resources_json>'), true)
    assert.equal(systemPrompt.includes('不得在不同resourceRef之间交叉使用证据'), true)
    const result = db.prepare('SELECT * FROM arrears_analysis_results WHERE batch_id=?').get(batchId) as any
    assert.equal(result.ai_category, 'vacancy'); assert.equal(JSON.parse(result.ai_evidence_json)[0], 'C-2')
    fs.appendFileSync(path.join(root, 'raw', String(batchId), 'ledger.enc'), Buffer.from([0]))
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/arrears/results/${result.id}/review`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'confirmed', category: 'vacancy', note: '损坏密文不得复核' }) })).status, 409)
    fs.writeFileSync(path.join(root, 'raw', String(batchId), 'ledger.enc'), encrypted, { mode: 0o600 })
    const reviewed = await fetch(`http://127.0.0.1:${port}/api/arrears/results/${result.id}/review`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'confirmed', category: 'vacancy', note: '已核对原始企小码记录' }) })
    assert.equal(reviewed.status, 200)
    const preRevoke = await fetch(`http://127.0.0.1:${port}/api/arrears/batches/${batchId}/revoke`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '先验证撤回恢复链路' }) })
    assert.equal(preRevoke.status, 200)
    db.prepare("UPDATE arrears_upload_batches SET archive_delete_state='pending' WHERE id=?").run(batchId)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/arrears/batches/${batchId}/restore`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '待删除状态不得恢复' }) })).status, 409)
    db.prepare("UPDATE arrears_upload_batches SET archive_delete_state='active' WHERE id=?").run(batchId)
    fs.appendFileSync(path.join(root, 'raw', String(batchId), 'communications.enc'), Buffer.from([0]))
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/arrears/batches/${batchId}/restore`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '损坏密文不得恢复' }) })).status, 409)
    fs.writeFileSync(path.join(root, 'raw', String(batchId), 'communications.enc'), communicationEncrypted, { mode: 0o600 })
    const restored = await fetch(`http://127.0.0.1:${port}/api/arrears/batches/${batchId}/restore`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '恢复后继续分析竞态测试' }) })
    assert.equal(restored.status, 200)
    const restoredResult = db.prepare('SELECT analysis_status,ai_category,ai_reason,ai_evidence_json,human_status FROM arrears_analysis_results WHERE id=?').get(result.id) as any
    assert.equal(restoredResult.analysis_status, 'pending_ai'); assert.equal(restoredResult.ai_category, ''); assert.equal(restoredResult.human_status, 'pending')
    aiMode = 'empty'
    const incomplete = await fetch(`http://127.0.0.1:${port}/api/arrears/batches/${batchId}/analyze`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(incomplete.status, 202)
    for (let i = 0; i < 100 && (db.prepare('SELECT status FROM arrears_upload_batches WHERE id=?').get(batchId) as any).status === 'analyzing'; i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal((db.prepare('SELECT status FROM arrears_upload_batches WHERE id=?').get(batchId) as any).status, 'rule_only'); assert.equal((db.prepare('SELECT ai_category FROM arrears_analysis_results WHERE id=?').get(result.id) as any).ai_category, '')
    aiMode = 'normal'
    assert.throws(() => db.prepare('DELETE FROM project_profiles WHERE id=?').run(Number(project.lastInsertRowid)))
    aiDelayMs = 250
    const runningAnalysis = fetch(`http://127.0.0.1:${port}/api/arrears/batches/${batchId}/analyze`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })
    for (let i = 0; i < 50 && (db.prepare('SELECT status FROM arrears_upload_batches WHERE id=?').get(batchId) as any).status !== 'analyzing'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    const duplicateAnalysis = await fetch(`http://127.0.0.1:${port}/api/arrears/batches/${batchId}/analyze`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(duplicateAnalysis.status, 409)
    const revoked = await fetch(`http://127.0.0.1:${port}/api/arrears/batches/${batchId}/revoke`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '分析中撤回，验证竞态门禁' }) })
    assert.equal(revoked.status, 200)
    assert.equal((await runningAnalysis).status, 202)
    const reviewAfterRevoke = await fetch(`http://127.0.0.1:${port}/api/arrears/results/${result.id}/review`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'confirmed', category: 'vacancy', note: '撤回后不应允许复核' }) })
    assert.equal(reviewAfterRevoke.status, 409)
    const cleared = db.prepare('SELECT ai_category,ai_reason,ai_evidence_json FROM arrears_analysis_results WHERE id=?').get(result.id) as any
    assert.equal(cleared.ai_category, ''); assert.equal(cleared.ai_reason, ''); assert.deepEqual(JSON.parse(cleared.ai_evidence_json), [])
    db.prepare('UPDATE arrears_upload_batches SET encrypted_archive_dir=? WHERE id=?').run(path.join(root,'raw','hop',String(batchId)),batchId)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/arrears/batches/${batchId}/archive`, { method: 'DELETE', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({note:'符号链接越界删除必须被拒绝'}) })).status,409)
    db.prepare('UPDATE arrears_upload_batches SET encrypted_archive_dir=? WHERE id=?').run(normalArchiveDir,batchId)
    fs.chmodSync(keyPath,0o644)
    const reconcileKeyFault = spawnSync(process.execPath, ['--input-type=module', '-e', "const m=await import('./dist/arrears-retention.js'); const q=await m.reconcileArrearsArchives(new Date('2026-08-06T00:00:00Z')); if(q.failed!==1||q.missingBlocked!==0) process.exit(2)"], { cwd: process.cwd(), env: { ...process.env, COCKPIT_DB_PATH: dbPath, ARREARS_RAW_ROOT: path.join(root, 'raw'), ARREARS_ENCRYPTION_KEY_FILE: keyPath }, encoding: 'utf8' })
    assert.equal(reconcileKeyFault.status,0,reconcileKeyFault.stderr);assert.equal((db.prepare('SELECT status FROM arrears_upload_batches WHERE id=?').get(batchId) as any).status,'revoked');fs.chmodSync(keyPath,0o600)
    const offlineRoot=path.join(root,'raw-offline');fs.renameSync(path.join(root,'raw'),offlineRoot)
    const unavailableRestore=await fetch(`http://127.0.0.1:${port}/api/arrears/batches/${batchId}/restore`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({note:'根目录临时不可用时不得永久阻断'}) });const unavailableBody=await unavailableRestore.text();assert.equal(unavailableRestore.status,503);assert.equal(unavailableBody.includes(root),false)
    const reconcileRootFault=spawnSync(process.execPath,['--input-type=module','-e',"const m=await import('./dist/arrears-retention.js');const q=await m.reconcileArrearsArchives(new Date('2026-08-06T00:00:00Z'));if(q.failed!==1||q.missingBlocked!==0)process.exit(2)"],{cwd:process.cwd(),env:{...process.env,COCKPIT_DB_PATH:dbPath,ARREARS_RAW_ROOT:path.join(root,'raw'),ARREARS_ENCRYPTION_KEY_FILE:keyPath},encoding:'utf8'});assert.equal(reconcileRootFault.status,0,reconcileRootFault.stderr);assert.equal((db.prepare('SELECT status FROM arrears_upload_batches WHERE id=?').get(batchId) as any).status,'revoked');fs.renameSync(offlineRoot,path.join(root,'raw'))
    fs.appendFileSync(path.join(root, 'raw', String(batchId), 'communications.enc'), Buffer.from([0]))
    const reconcileIntegrity = spawnSync(process.execPath, ['--input-type=module', '-e', "const m=await import('./dist/arrears-retention.js'); const q=await m.reconcileArrearsArchives(new Date('2026-08-06T00:00:00Z')); if(q.missingBlocked!==1) process.exit(2)"], { cwd: process.cwd(), env: { ...process.env, COCKPIT_DB_PATH: dbPath, ARREARS_RAW_ROOT: path.join(root, 'raw'), ARREARS_ENCRYPTION_KEY_FILE: keyPath }, encoding: 'utf8' })
    assert.equal(reconcileIntegrity.status, 0, reconcileIntegrity.stderr); assert.equal((db.prepare('SELECT status FROM arrears_upload_batches WHERE id=?').get(batchId) as any).status, 'blocked')
    fs.writeFileSync(path.join(root, 'raw', String(batchId), 'communications.enc'), communicationEncrypted, { mode: 0o600 }); db.prepare("UPDATE arrears_upload_batches SET status='revoked',archive_delete_state='active' WHERE id=?").run(batchId)
    db.prepare("UPDATE arrears_upload_batches SET retention_until='2000-01-01',archive_delete_state='pending' WHERE id=?").run(batchId)
    fs.mkdirSync(path.join(root, 'raw', '.staging-crash-test'), { recursive: true }); fs.mkdirSync(path.join(root, 'raw', '999999'), { recursive: true }); for (const name of ['.staging-crash-test','999999']) fs.utimesSync(path.join(root, 'raw', name), new Date('2026-08-05T00:00:00Z'), new Date('2026-08-05T00:00:00Z'))
    const retention = spawnSync(process.execPath, ['--input-type=module', '-e', "const m=await import('./dist/arrears-retention.js'); const q=await m.reconcileArrearsArchives(new Date('2026-08-06T00:00:00Z')); const r=m.purgeExpiredArrearsArchives(new Date('2026-08-06T00:00:00Z')); if(q.orphansDeleted!==2||q.pendingCompleted!==1||r.deleted!==0) process.exit(2)"], { cwd: process.cwd(), env: { ...process.env, COCKPIT_DB_PATH: dbPath, ARREARS_RAW_ROOT: path.join(root, 'raw'), ARREARS_ENCRYPTION_KEY_FILE: keyPath }, encoding: 'utf8' })
    assert.equal(retention.status, 0, retention.stderr); assert.equal(fs.existsSync(path.join(root, 'raw', String(batchId))), false)
    assert.ok((db.prepare('SELECT archive_deleted_at FROM arrears_upload_batches WHERE id=?').get(batchId) as any).archive_deleted_at)
    assert.equal((db.prepare('SELECT COUNT(*) c FROM management_tasks').get() as any).c, tasksBefore)
    assert.equal((db.prepare('SELECT COUNT(*) c FROM payment_centers').get() as any).c, paymentsBefore)
    assert.ok((db.prepare("SELECT COUNT(*) c FROM operation_logs WHERE target LIKE 'arrears-%'").get() as any).c >= 3)
    db.close()
  } catch (error: any) {
    throw new Error(`${error?.message || String(error)}\n${error?.stack || ''}\nSERVER LOGS:\n${logs}`)
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(2000)])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    await new Promise(resolve => mockAi.close(resolve)); fs.rmSync(root, { recursive: true, force: true })
  }
})
