import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { prepareP46FixedEntryPublication } from '../src/p46-fixed-entry-publication.js'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('未取得P46崩溃恢复测试端口')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(2_000)])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

async function startServer(root: string, port: number, crashAfterEntries?: number, crashAfterCommit = false) {
  let logs = ''
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      COCKPIT_DB_PATH: path.join(root, 'cockpit.db'),
      COCKPIT_ROOT: path.join(root, 'cockpit'),
      COCKPIT_RAW_ARCHIVE_DIR: path.join(root, 'raw'),
      COCKPIT_ADMIN_PASSWORD: 'P46-Crash-Recovery-Admin-2026!',
      JWT_SECRET: 'p46-crash-recovery-jwt-secret-at-least-32-characters',
      COCKPIT_ALLOW_DEMO_DATA: 'false',
      ...(crashAfterEntries ? { COCKPIT_TEST_CRASH_AFTER_FIXED_ENTRY_COUNT: String(crashAfterEntries) } : {}),
      ...(crashAfterCommit ? { COCKPIT_TEST_CRASH_AFTER_SQLITE_COMMIT: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', chunk => { logs += chunk })
  child.stderr?.on('data', chunk => { logs += chunk })
  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`P46影子服务启动失败：${child.exitCode || child.signalCode}\n${logs}`)
    try {
      const response = await fetch(`${baseUrl}/api/health/ready`)
      if (response.ok) return { child, baseUrl, logs: () => logs }
    } catch {}
    await wait(100)
  }
  await stop(child)
  throw new Error(`P46影子服务启动超时\n${logs}`)
}

async function login(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'P46-Crash-Recovery-Admin-2026!' }),
  })
  const body = await response.json() as { token?: string }
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(typeof body.token, 'string')
  return body.token!
}

const sha = (content: Buffer) => crypto.createHash('sha256').update(content).digest('hex')

async function preview(baseUrl: string, token: string) {
  const businessDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const extractedAt = new Date(Date.now() - 60_000).toISOString()
  const validatedAt = new Date(Date.now() - 30_000).toISOString()
  const paymentCenters = Array.from({ length: 40 }, (_, index) => ({
    area: '崩溃恢复测试片区', center: `P46崩溃恢复测试中心${index + 1}`,
    annual_budget: 100, cumulative_budget: 80, cumulative_executed: 70,
    same_period: 60, collection_rate: null,
  }))
  const collectionCenters = Array.from({ length: 35 }, (_, index) => ({
    area: '崩溃恢复测试片区', center: `P46崩溃恢复绿仔中心${index + 1}`,
    receivable: 100, received: 60, outstanding: 40, collectionRate: 0.6,
  }))
  const sourceLayers = {
    regionCard: { source: 'P46崩溃恢复地区卡片', businessDate, values: { annualBudget: 4000, cumulativeBudget: 3200, cumulativeExecuted: 2800, samePeriod: 2400, growthPercent: 16.67 } },
    budgetWeekly: { source: 'P46崩溃恢复预算周报', businessDate, values: { annualBudget: 4000, cumulativeBudget: 3200 } },
    centerDetail: { source: 'P46崩溃恢复中心明细', businessDate, values: { annualBudget: 4000, cumulativeBudget: 3200, cumulativeExecuted: 2800, samePeriod: 2400 } },
  }
  const reconciliations = {}
  const sourceContents: Record<string, Buffer> = {
    aph: Buffer.from(JSON.stringify({ businessDate, sourceLayers, reconciliations })),
    paymentDetail: Buffer.from(JSON.stringify({ businessDate, rows: paymentCenters })),
    lvzai: Buffer.from(JSON.stringify({ businessDate, rows: collectionCenters })),
    collectionDetail: Buffer.from(JSON.stringify({ businessDate, date: businessDate, extractedAt, rows: collectionCenters })),
    collectionSummary: Buffer.from(JSON.stringify({
      date: businessDate, extractedAt, collectionRate: 0.6, receivable_万: 3500, received_万: 2100,
      periodCorrection: { correctedRate: 0.6, rateField: 'gatheringCurrentYearRecedRate', rateAggregation: '按receCurrentPeriod对应收加权官方项目率' },
    })),
  }
  const sources = Object.entries(sourceContents).map(([key, content]) => ({ key, name: `${key}.json`, size: content.length, sha256: sha(content) }))
  const normalized = Buffer.from(JSON.stringify({
    schema_version: 2, business_date: businessDate, extracted_at: extractedAt,
    source_status: 'available', last_validated_at: validatedAt,
    field_provenance: {
      年度预算_万: '地区卡片/年度预算', 累计预算_万: '地区卡片/累计预算',
      累计执行_万: '地区卡片/累计执行', 同期执行_万: '地区卡片/同期执行', 增幅: '地区卡片/公式勾稽',
    },
    source_layers: sourceLayers, reconciliations, sources,
    payment_centers: paymentCenters,
    daily_snapshots: paymentCenters.map(row => ({
      date: businessDate, center: row.center, annual_budget: row.annual_budget,
      cumulative_budget: row.cumulative_budget, cumulative_executed: row.cumulative_executed,
      daily_collection: 2, quality_status: 'verified', quality_reason: '', source: 'P46崩溃恢复日报',
      source_status: 'available', business_date: businessDate, last_validated_at: validatedAt,
      field_provenance: {
        annual_budget: { report: '预算周报' }, cumulative_budget: { report: '回款日报' },
        cumulative_executed: { report: '回款日报' }, daily_collection: { report: '回款日报' },
      },
    })),
    collection_centers: collectionCenters,
    collection_summary: JSON.parse(sourceContents.collectionSummary.toString('utf8')),
    lvzai: { raw_rows: 35, source_regions: 35, mapped_regions: 35, canonical_centers: 35, unmapped_centers: [] },
  }))
  const form = new FormData()
  form.set('normalized', new Blob([new Uint8Array(normalized)], { type: 'application/json' }), 'normalized.json')
  for (const [key, content] of Object.entries(sourceContents)) form.set(key, new Blob([new Uint8Array(content)], { type: 'application/json' }), `${key}.json`)
  const response = await fetch(`${baseUrl}/api/data-pipeline/preview`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  })
  const body = await response.json() as { batch?: { id: number; status: string } }
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.batch?.status, 'previewed', JSON.stringify(body))
  return body.batch!.id
}

const fixedNames = ['APH决策_每日提取.json', '绿仔收缴明细.json', '绿仔收款汇总.json', '绿仔同步状态.json']

function assertNoPublicationArtifacts(cockpitRoot: string) {
  const names = fs.readdirSync(cockpitRoot)
  assert.equal(names.includes('.p46-publication-pending'), false, '不得残留pending恢复目录')
  assert.deepEqual(names.filter(name => name.endsWith('.new') || name.endsWith('.bak')), [], '不得残留.new/.bak文件')
}

test('P46进程在固定入口替换中崩溃后，启动对账恢复四文件与SQLite一致状态', { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-p46-crash-recovery-'))
  const cockpitRoot = path.join(root, 'cockpit')
  fs.mkdirSync(cockpitRoot, { recursive: true })
  const oldBytes = new Map(fixedNames.map((name, index) => [name, Buffer.from(JSON.stringify({ old: true, index }))]))
  let first: Awaited<ReturnType<typeof startServer>> | null = null
  let second: Awaited<ReturnType<typeof startServer>> | null = null
  try {
    const firstPort = await freePort()
    first = await startServer(root, firstPort, 2)
    const token = await login(first.baseUrl)
    const batchId = await preview(first.baseUrl, token)
    for (const [name, content] of oldBytes) fs.writeFileSync(path.join(cockpitRoot, name), content)

    const publish = fetch(`${first.baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmNote: '故障注入验证进程崩溃恢复' }),
    }).then(async response => ({ response, text: await response.text() })).catch(() => new Promise<never>(() => {}))
    const outcome = await Promise.race([
      publish.then(result => ({ kind: 'response' as const, result })),
      new Promise<{ kind: 'exit'; signal: string | null }>(resolve => first!.child.once('exit', (_code, signal) => resolve({ kind: 'exit', signal }))),
    ])
    assert.equal(outcome.kind, 'exit', outcome.kind === 'response' ? `故障注入未终止进程：${outcome.result.response.status} ${outcome.result.text}` : '')
    assert.equal(first.child.signalCode, 'SIGKILL')

    const crashedDb = new Database(path.join(root, 'cockpit.db'))
    assert.equal((crashedDb.prepare('SELECT status FROM data_ingestion_batches WHERE id=?').get(batchId) as { status: string }).status, 'previewed')
    assert.equal((crashedDb.prepare('SELECT COUNT(*) count FROM data_ingestion_publications WHERE batch_id=?').get(batchId) as { count: number }).count, 0)
    crashedDb.close()
    assert.equal(fs.existsSync(path.join(cockpitRoot, '.p46-publication-pending')), true, '崩溃后必须留下可恢复日志')
    assert.notDeepEqual(fs.readFileSync(path.join(cockpitRoot, fixedNames[0])), oldBytes.get(fixedNames[0]))
    assert.notDeepEqual(fs.readFileSync(path.join(cockpitRoot, fixedNames[1])), oldBytes.get(fixedNames[1]))
    assert.deepEqual(fs.readFileSync(path.join(cockpitRoot, fixedNames[2])), oldBytes.get(fixedNames[2]))
    assert.deepEqual(fs.readFileSync(path.join(cockpitRoot, fixedNames[3])), oldBytes.get(fixedNames[3]))

    const secondPort = await freePort()
    second = await startServer(root, secondPort)
    for (const [name, content] of oldBytes) assert.deepEqual(fs.readFileSync(path.join(cockpitRoot, name)), content, `${name}启动对账未恢复`)
    assertNoPublicationArtifacts(cockpitRoot)

    const retryToken = await login(second.baseUrl)
    const response = await fetch(`${second.baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${retryToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmNote: '崩溃恢复后重新发布真实批次' }),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    const recoveredDb = new Database(path.join(root, 'cockpit.db'))
    assert.equal((recoveredDb.prepare('SELECT status FROM data_ingestion_batches WHERE id=?').get(batchId) as { status: string }).status, 'published')
    assert.equal((recoveredDb.prepare('SELECT COUNT(*) count FROM data_ingestion_publications WHERE batch_id=?').get(batchId) as { count: number }).count, 1)
    recoveredDb.close()
    assertNoPublicationArtifacts(cockpitRoot)
    for (const [name, content] of oldBytes) assert.notDeepEqual(fs.readFileSync(path.join(cockpitRoot, name)), content, `${name}重试发布未生效`)
  } finally {
    if (first) await stop(first.child)
    if (second) await stop(second.child)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P46在第1、3、4个固定入口rename后SIGKILL，逐次重启均恢复完整旧组', { timeout: 240_000 }, async () => {
  for (const crashAfterEntries of [1, 3, 4]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `cockpit-p46-crash-${crashAfterEntries}-`))
    const cockpitRoot = path.join(root, 'cockpit')
    fs.mkdirSync(cockpitRoot, { recursive: true })
    const oldBytes = new Map(fixedNames.map((name, index) => [name, Buffer.from(JSON.stringify({ old: true, crashAfterEntries, index }))]))
    let first: Awaited<ReturnType<typeof startServer>> | null = null
    let second: Awaited<ReturnType<typeof startServer>> | null = null
    try {
      first = await startServer(root, await freePort(), crashAfterEntries)
      const token = await login(first.baseUrl)
      const batchId = await preview(first.baseUrl, token)
      for (const [name, content] of oldBytes) fs.writeFileSync(path.join(cockpitRoot, name), content)
      const publish = fetch(`${first.baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
        method: 'POST',
        headers: { Authorization: ['Bea', 'rer ', token].join(''), 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmNote: `第${crashAfterEntries}个入口崩溃恢复验证` }),
      }).then(async response => ({ response, text: await response.text() })).catch(() => new Promise<never>(() => {}))
      const outcome = await Promise.race([
        publish.then(result => ({ kind: 'response' as const, result })),
        new Promise<{ kind: 'exit'; signal: string | null }>(resolve => first!.child.once('exit', (_code, signal) => resolve({ kind: 'exit', signal }))),
      ])
      assert.equal(outcome.kind, 'exit', outcome.kind === 'response' ? `第${crashAfterEntries}个入口故障注入未终止进程` : '')
      assert.equal(first.child.signalCode, 'SIGKILL')

      const crashedDb = new Database(path.join(root, 'cockpit.db'))
      assert.equal((crashedDb.prepare('SELECT status FROM data_ingestion_batches WHERE id=?').get(batchId) as { status: string }).status, 'previewed')
      assert.equal((crashedDb.prepare('SELECT COUNT(*) count FROM data_ingestion_publications WHERE batch_id=?').get(batchId) as { count: number }).count, 0)
      crashedDb.close()
      second = await startServer(root, await freePort())
      for (const [name, content] of oldBytes) assert.deepEqual(fs.readFileSync(path.join(cockpitRoot, name)), content, `第${crashAfterEntries}个入口崩溃后${name}未恢复`)
      assertNoPublicationArtifacts(cockpitRoot)
    } finally {
      if (first) await stop(first.child)
      if (second) await stop(second.child)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('P46进程在SQLite提交后清理恢复日志前崩溃，启动对账完成已发布状态', { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-p46-post-commit-recovery-'))
  const cockpitRoot = path.join(root, 'cockpit')
  fs.mkdirSync(cockpitRoot, { recursive: true })
  let first: Awaited<ReturnType<typeof startServer>> | null = null
  let second: Awaited<ReturnType<typeof startServer>> | null = null
  try {
    first = await startServer(root, await freePort(), undefined, true)
    const token = await login(first.baseUrl)
    const batchId = await preview(first.baseUrl, token)
    for (const [index, name] of fixedNames.entries()) fs.writeFileSync(path.join(cockpitRoot, name), JSON.stringify({ old: true, index }))

    const publish = fetch(`${first.baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmNote: '故障注入验证提交后崩溃恢复' }),
    }).then(async response => ({ response, text: await response.text() })).catch(() => new Promise<never>(() => {}))
    const outcome = await Promise.race([
      publish.then(result => ({ kind: 'response' as const, result })),
      new Promise<{ kind: 'exit'; signal: string | null }>(resolve => first!.child.once('exit', (_code, signal) => resolve({ kind: 'exit', signal }))),
    ])
    assert.equal(outcome.kind, 'exit', outcome.kind === 'response' ? `提交后故障注入未终止进程：${outcome.result.response.status} ${outcome.result.text}` : '')
    assert.equal(first.child.signalCode, 'SIGKILL')

    const crashedDb = new Database(path.join(root, 'cockpit.db'))
    assert.equal((crashedDb.prepare('SELECT status FROM data_ingestion_batches WHERE id=?').get(batchId) as { status: string }).status, 'published')
    assert.equal((crashedDb.prepare('SELECT COUNT(*) count FROM data_ingestion_publications WHERE batch_id=?').get(batchId) as { count: number }).count, 1)
    crashedDb.close()
    assert.equal(fs.existsSync(path.join(cockpitRoot, '.p46-publication-pending')), true)
    const publishedBytes = new Map(fixedNames.map(name => [name, fs.readFileSync(path.join(cockpitRoot, name))]))

    second = await startServer(root, await freePort())
    assertNoPublicationArtifacts(cockpitRoot)
    for (const [name, content] of publishedBytes) assert.deepEqual(fs.readFileSync(path.join(cockpitRoot, name)), content, `${name}已提交发布不应被回滚`)
    const retryToken = await login(second.baseUrl)
    const response = await fetch(`${second.baseUrl}/api/data-pipeline/batches/${batchId}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${retryToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmNote: '启动对账后幂等确认发布状态' }),
    })
    const body = await response.json() as { idempotent?: boolean }
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.idempotent, true)
  } finally {
    if (first) await stop(first.child)
    if (second) await stop(second.child)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P46启动恢复逐项尝试并聚合多个损坏备份错误', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-p46-aggregate-recovery-'))
  const database = {
    prepare: () => ({ get: () => ({ status: 'previewed', publication_count: 0 }) }),
  }
  try {
    fs.writeFileSync(path.join(root, 'first.json'), 'old-first')
    fs.writeFileSync(path.join(root, 'second.json'), 'old-second')
    const publication = prepareP46FixedEntryPublication(database, root, 77, [
      { targetName: 'first.json', content: Buffer.from('new-first') },
      { targetName: 'second.json', content: Buffer.from('new-second') },
    ])
    publication.install()
    const pending = path.join(root, '.p46-publication-pending')
    fs.writeFileSync(path.join(pending, 'backup-0.bin'), 'broken-first')
    fs.writeFileSync(path.join(pending, 'backup-1.bin'), 'broken-second')

    assert.throws(
      () => publication.settle(),
      error => error instanceof Error
        && /first\.json.*回滚备份损坏/.test(error.message)
        && /second\.json.*回滚备份损坏/.test(error.message),
    )
    assert.equal(fs.existsSync(pending), true, '恢复失败时必须保留journal供受控重试')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('P46固定入口根缺失时临时失败且不得递归创建伪挂载', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-p46-missing-root-'))
  const missingRoot = path.join(parent, 'missing-cockpit-root')
  const database = {
    prepare: () => ({ get: () => ({ status: 'previewed', publication_count: 0 }) }),
  }
  try {
    assert.throws(
      () => prepareP46FixedEntryPublication(database, missingRoot, 88, [
        { targetName: 'first.json', content: Buffer.from('new-first') },
      ]),
      /P46固定入口根目录不存在.*禁止递归创建/,
    )
    assert.equal(fs.existsSync(missingRoot), false, '固定入口根缺失时不得创建目录或恢复日志')
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
})
