import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import test from 'node:test'

const builder = fs.readFileSync(new URL('../../scripts/build-production-release.mjs', import.meta.url), 'utf8')
const deployer = fs.readFileSync(new URL('../../scripts/deploy-production-release.sh', import.meta.url), 'utf8')
const preflight = fs.readFileSync(new URL('../../scripts/preflight-production-operations.sh', import.meta.url), 'utf8')
const waitForReadyFunction = deployer.match(/wait_for_ready\(\)\{[\s\S]*?\n\}/)?.[0] ?? ''
const reconciliationRunner = fs.readFileSync(new URL('../scripts/run-daily-reconciliation.sh', import.meta.url), 'utf8')
const reconciliationPublisher = fs.readFileSync(new URL('../scripts/publish-daily-reconciliation.mjs', import.meta.url), 'utf8')
const authSource = fs.readFileSync(new URL('../src/auth.ts', import.meta.url), 'utf8')
const apiService = fs.readFileSync(new URL('../../deploy/production/r127/first-service-cockpit.service', import.meta.url), 'utf8')
const reconciliationService = fs.readFileSync(new URL('../systemd/cockpit-daily-reconciliation.service', import.meta.url), 'utf8')
const backfillService = fs.readFileSync(new URL('../systemd/cockpit-daily-reconciliation-backfill.service', import.meta.url), 'utf8')
const operations = [
  'lvzai-login.py',
  'wecom-ledger-extractor.py',
  'qxm-evidence-extractor.py',
  'quarantine_demo_chain.py',
  'daily_reconciliation_probe.py',
  'daily_reconciliation_candidates.py',
  'rollback_r160_publication_mode.py',
  'probe-fine-report-daily-reconciliation.py',
  'publish-daily-reconciliation.mjs',
  'run-daily-reconciliation.sh',
  'recover_historical_gap.py',
  'scrape_and_import.py',
]

test('production candidate includes every declared operational script in its signed manifest tree', () => {
  for (const operation of operations) {
    assert.match(`${builder}\n${deployer}`, new RegExp(operation.replaceAll('.', '\\.')), operation)
  }
  assert.match(builder, /quarantineDemoChain[\s\S]*sourceFiles/)
  assert.match(builder, /operationsRuntimePreflight[\s\S]*operations-runtime-preflight\.sh/)
})

test('production candidate hydrates every active root-relative frontend dependency and fails closed on ambiguity', () => {
  assert.match(builder, /hydrateFrontendDependencies/)
  assert.match(builder, /非法前端入口依赖路径/)
  assert.match(builder, /前端入口依赖缺少本地来源/)
  assert.match(builder, /前端入口依赖存在内容冲突/)
  assert.match(builder, /await hydrateFrontendDependencies\(path\.join\(output, 'frontend'\)\)/)
})

test('production candidate binds the exact protocol-2 deployer and makes older deployers fail closed', () => {
  assert.match(builder, /deployProductionRelease[\s\S]*deploy-production-release\.sh/)
  assert.match(builder, /copyFile\(deployProductionRelease[\s\S]*deploy\/deploy-production-release\.sh/)
  assert.match(builder, /sourceFiles[\s\S]*deployProductionRelease/)
  assert.doesNotMatch(builder, /requires-deployer-protocol-2:/)
  assert.match(builder, /deployer:\s*\{\s*protocol:\s*2/)
  assert.match(deployer, /manifest\.deployer\?\.protocol !== 2/)
  assert.match(deployer, /当前部署器与候选签名部署器不一致/)
  assert.doesNotMatch(deployer, /requires-deployer-protocol-2:/)
})

test('generated candidate keeps raw production hashes and candidate index hash in files', () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'r160-release-manifest-'))
  const sourceCommit = 'a'.repeat(40)
  try {
    execFileSync(process.execPath, [path.join(repositoryRoot, 'scripts/build-production-release.mjs'), '--output', output], {
      cwd: repositoryRoot,
      env: { ...process.env, COCKPIT_SOURCE_COMMIT: sourceCommit },
    })
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'))
    const baseline = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'config/production-baseline.json'), 'utf8'))
    const runtime = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'config/production-runtime-r127.json'), 'utf8'))
    assert.equal(manifest.expectedProduction.indexSha256, runtime.frontend.indexSha256)
    assert.notEqual(manifest.expectedProduction.indexSha256, baseline.indexSha256)
    assert.equal(manifest.expectedProduction.backendDistIndexSha256, runtime.backend.distIndexSha256)
    assert.match(manifest.expectedProduction.indexSha256, /^[a-f0-9]{64}$/)
    assert.equal(manifest.deployer.protocol, 2)
    assert.equal(manifest.source.commit, sourceCommit)
    assert.equal(manifest.release, `cockpit-candidate-${manifest.source.treeSha256.slice(0, 12)}`)
    assert.notEqual(manifest.release, runtime.release)
    const indexFile = manifest.files.find((file: any) => file.path === 'frontend/index.html')
    assert.ok(indexFile)
    const candidateIndex = fs.readFileSync(path.join(output, 'frontend/index.html'))
    assert.equal(indexFile.sha256, crypto.createHash('sha256').update(candidateIndex).digest('hex'))
  } finally {
    fs.rmSync(output, { recursive: true, force: true })
  }
})

test('production deploy preflights, backs up, atomically installs and rolls back every operation', () => {
  assert.match(deployer, /RUNTIME_OPERATIONS=\(lvzai-login\.py wecom-ledger-extractor\.py qxm-evidence-extractor\.py daily_reconciliation_probe\.py daily_reconciliation_candidates\.py rollback_r160_publication_mode\.py probe-fine-report-daily-reconciliation\.py publish-daily-reconciliation\.mjs run-daily-reconciliation\.sh recover_historical_gap\.py scrape_and_import\.py\)/)
  assert.match(deployer, /ROOT_OPERATIONS=\(quarantine_demo_chain\.py\)/)
  assert.match(deployer, /for operation in "\$\{OPERATIONS\[@\]\}"; do[\s\S]*候选缺少运维脚本/)
  assert.match(deployer, /候选文件集合与manifest不一致/)
  assert.match(deployer, /候选禁止符号链接/)
  assert.match(deployer, /候选manifest验证失败/)
  assert.match(deployer, /rm -f "\$target\.next"[\s\S]*mv -Tf/)
  assert.match(deployer, /operations-state\.tsv[\s\S]*OP_EXISTED/)
  assert.match(deployer, /rollback\(\)[\s\S]*for operation in "\$\{OPERATIONS\[@\]\}"[\s\S]*cp -a[\s\S]*rollback-next[\s\S]*rm -f/)
  assert.match(deployer, /for operation in "\$\{OPERATIONS\[@\]\}"; do[\s\S]*install_operation "\$CANDIDATE\/backend\/operations\/\$operation"[\s\S]*cmp -s/)
  assert.match(deployer, /quarantine_demo_chain\.py[\s\S]*owner=root; group=root/)
  assert.match(deployer, /BACKEND_USER[\s\S]*BACKEND_GROUP/)
  assert.match(deployer, /operations-runtime-preflight\.sh/)
  assert.ok(
    deployer.indexOf('bash "$CANDIDATE/deploy/operations-runtime-preflight.sh"') < deployer.indexOf('STAMP="$(date'),
    'runtime preflight must run before backup creation or production writes',
  )
})

test('operations runtime preflight is read-only, explicit and fail closed without external login', () => {
  assert.match(preflight, /set -Eeuo pipefail/)
  assert.match(preflight, /sys\.prefix != sys\.base_prefix/)
  assert.match(preflight, /import ddddocr/)
  assert.match(preflight, /playwright\.sync_api/)
  assert.match(preflight, /CHROMIUM_BIN[\s\S]*--version/)
  assert.match(preflight, /LVZAI_STATE_FILE[\s\S]*权限必须为 600/)
  assert.match(preflight, /HERMES_ENV_FILE[\s\S]*Hermes 环境缺少 LVZAI_USER/)
  assert.match(preflight, /PROC_ROOT[\s\S]*生产服务环境缺少 LVZAI_USER/)
  assert.doesNotMatch(preflight, /lvzai-login\.py|login\.lvzai|page\.goto|curl/)
  assert.doesNotMatch(preflight, /\brm\b|\bmv\b|\bcp\b|\binstall\b|systemctl restart/)
})

test('daily reconciliation publisher consumes systemd environment without reading the protected env file and fails closed', () => {
  assert.doesNotMatch(reconciliationPublisher, /envFile\(|\/etc\/first-service\/cockpit\.env/)
  assert.match(reconciliationPublisher, /DAILY_RECONCILIATION_JWT_SECRET missing from process environment/)
  assert.doesNotMatch(reconciliationPublisher, /process\.env\.JWT_SECRET/)
  assert.match(reconciliationPublisher, /daily-reconciliation-automation[\s\S]*purpose: 'daily-reconciliation'[\s\S]*expiresIn: '5m'/)
  assert.doesNotMatch(reconciliationPublisher, /FROM users WHERE role='admin'/)
})

test('daily reconciliation worker is isolated from the API service process identity', () => {
  assert.match(apiService, /^User=ubuntu$/m)
  assert.match(reconciliationService, /^User=cockpit-reconciliation$/m)
  assert.match(reconciliationService, /^DynamicUser=yes$/m)
  assert.match(reconciliationService, /^ProtectProc=invisible$/m)
  assert.doesNotMatch(reconciliationService, /^User=ubuntu$/m)
})

test('production deploy freezes the reconciliation scheduler before replacing runtime files', () => {
  const freeze = deployer.lastIndexOf('stop_if_loaded cockpit-daily-reconciliation.timer')
  const replaceSecret = deployer.indexOf('DAILY_RECONCILIATION_ENV_NEXT=')
  const replaceBackend = deployer.indexOf('dist.release-next')
  assert.ok(freeze > deployer.indexOf('trap rollback ERR INT TERM'))
  assert.ok(freeze < replaceSecret)
  assert.ok(freeze < replaceBackend)
  assert.match(deployer, /stop_if_loaded cockpit-daily-reconciliation\.timer[\s\S]*stop_and_confirm_inactive cockpit-daily-reconciliation\.service[\s\S]*日报复核writer未退出，拒绝发布/)
  assert.match(deployer, /LoadState --value "\$unit"/)
  assert.match(deployer, /\[\[ "\$load_state" == not-found \|\| -z "\$load_state" \]\] && return 0/)
  assert.match(deployer, /rollback_step stop_if_loaded "\$unit"/)
})

test('late failure after the new API starts stops every writer before SQLite and code rollback', () => {
  const newApiStart = deployer.lastIndexOf('systemctl restart "$SERVICE"')
  const postStartFailure = deployer.lastIndexOf('verify_database "$COCKPIT_DB_PATH"')
  assert.ok(newApiStart >= 0 && postStartFailure > newApiStart, 'fixture needs a failure point after the new API starts')

  const rollbackStart = deployer.indexOf('rollback(){')
  const stopTimer = deployer.indexOf('rollback_step stop_if_loaded cockpit-daily-reconciliation.timer', rollbackStart)
  const stopDaily = deployer.indexOf('rollback_step stop_and_confirm_inactive cockpit-daily-reconciliation.service', rollbackStart)
  const stopBackfill = deployer.indexOf('rollback_step stop_and_confirm_inactive cockpit-daily-reconciliation-backfill.service', rollbackStart)
  const stopApi = deployer.indexOf('rollback_step stop_and_confirm_inactive "$SERVICE"', rollbackStart)
  const restoreDatabase = deployer.indexOf('if ! restore_database_backup', rollbackStart)
  const restoreDist = deployer.indexOf('"$BACKEND_ROOT/dist.rollback-next"', rollbackStart)
  const restartOldApi = deployer.indexOf('rollback_step systemctl restart "$unit"', rollbackStart)
  assert.ok(rollbackStart >= 0 && stopTimer > rollbackStart)
  assert.ok(stopTimer < stopDaily && stopDaily < stopBackfill && stopBackfill < stopApi)
  assert.ok(stopApi < restoreDatabase && restoreDatabase < restoreDist)
  assert.ok(restoreDist < restartOldApi)
  assert.match(deployer, /stop_and_confirm_inactive\(\)[\s\S]*ActiveState --value[\s\S]*SubState --value/)
  assert.match(deployer, /rm -f -- "\$COCKPIT_DB_PATH-wal" "\$COCKPIT_DB_PATH-shm"/)
  assert.match(deployer, /\[\[ ! -e "\$COCKPIT_DB_PATH-wal" && ! -e "\$COCKPIT_DB_PATH-shm" \]\]/)
  assert.match(deployer, /PRAGMA quick_check/)
  assert.match(deployer, /DB_BACKUP_SHA256[\s\S]*DB_SCHEMA_SHA256/)
  const restoreFunction = deployer.slice(deployer.indexOf('restore_database_backup(){'), deployer.indexOf('\nrollback_step(){'))
  for (const command of [
    '[[ "$DB_BACKUP_READY" == 1 ]]',
    '[[ "$(sha256sum "$BACKUP/database/cockpit.db"',
    'install -o "$BACKEND_USER"',
    'verify_database "$COCKPIT_DB_PATH.rollback-next"',
    'database_schema_sha256 "$COCKPIT_DB_PATH.rollback-next"',
    'rm -f -- "$COCKPIT_DB_PATH-wal"',
    'mv -Tf "$COCKPIT_DB_PATH.rollback-next"',
    'verify_database "$COCKPIT_DB_PATH"',
  ]) {
    const line = restoreFunction.split('\n').find(candidate => candidate.includes(command))
    assert.ok(line?.includes('|| return 1'), `rollback prerequisite must fail closed: ${command}`)
  }
})

test('late-failure rollback restarts and waits for the restored API process to become ready', () => {
  assert.match(deployer, /if \[\[ "\$unit" == "\$SERVICE" \]\]; then rollback_step systemctl restart "\$unit"; else rollback_step systemctl start "\$unit"; fi/)
  assert.match(deployer, /verify_service_process\(\)[\s\S]*MainPID[\s\S]*ControlGroup[\s\S]*while IFS=: read -r _ _ cgroup_path[\s\S]*"\$cgroup_path" == "\$control_group" \|\| "\$cgroup_path" == "\$control_group\/"\*[\s\S]*done < "\/proc\/\$pid\/cgroup"/)
  assert.doesNotMatch(deployer, /grep -Fq "\$control_group" "\/proc\/\$pid\/cgroup"/)
  const belongsToControlGroup = (expected: string, actual: string) => actual === expected || actual.startsWith(`${expected}/`)
  assert.equal(belongsToControlGroup('/system.slice/foo.service', '/system.slice/foo.service'), true)
  assert.equal(belongsToControlGroup('/system.slice/foo.service', '/system.slice/foo.service/worker'), true)
  assert.equal(belongsToControlGroup('/system.slice/foo.service', '/system.slice/foo.service-extra'), false)
  assert.match(deployer, /wait_for_ready\(\)[\s\S]*seq 1 30[\s\S]*curl -fsS --max-time 5/)
  assert.match(deployer, /rollback_step wait_for_ready/)
  const restoredDist = deployer.indexOf('cmp -s "$BACKUP/backend/dist/index.js" "$BACKEND_ROOT/dist/index.js"')
  const restoredProcess = deployer.indexOf('rollback_step verify_service_process "$SERVICE"')
  const restoredHealth = deployer.indexOf('rollback_step wait_for_ready')
  assert.ok(restoredDist >= 0 && restoredDist < restoredProcess)
  assert.ok(restoredProcess < restoredHealth)
})

test('post-stop runtime preflight explicitly permits only the controlled inactive-service check', () => {
  assert.match(preflight, /ALLOW_INACTIVE_SERVICE="\$\{ALLOW_INACTIVE_SERVICE:-0\}"/)
  assert.match(preflight, /if \[\[ "\$ALLOW_INACTIVE_SERVICE" != 1 \]\]; then[\s\S]*生产服务没有运行中的主进程[\s\S]*fi/)
  assert.match(deployer, /unset ALLOW_INACTIVE_SERVICE/)
  assert.match(deployer, /ALLOW_INACTIVE_SERVICE=0[\s\S]*operations-runtime-preflight\.sh/)
  assert.match(deployer, /ALLOW_INACTIVE_SERVICE=1 REQUIRE_DAILY_RECONCILIATION_ENV=1[\s\S]*operations-runtime-preflight\.sh/)
  const firstPreflight = deployer.indexOf('bash "$CANDIDATE/deploy/operations-runtime-preflight.sh"')
  const writersStopped = deployer.lastIndexOf('stop_and_confirm_inactive "$SERVICE"')
  const inactivePreflight = deployer.indexOf('ALLOW_INACTIVE_SERVICE=1 REQUIRE_DAILY_RECONCILIATION_ENV=1')
  assert.ok(firstPreflight >= 0 && firstPreflight < writersStopped)
  assert.ok(inactivePreflight > writersStopped)
})

test('readiness wait retries transient startup failures and then succeeds', () => {
  assert.notEqual(waitForReadyFunction, '')
  const output = execFileSync('bash', ['-c', `${waitForReadyFunction}\ncount=0\ncurl(){ count=$((count+1)); [[ "$count" -ge 3 ]]; }\nsleep(){ :; }\nwait_for_ready\nprintf 'attempts=%s' "$count"`], { encoding: 'utf8' })
  assert.equal(output, 'attempts=3')
})

test('readiness wait fails after the bounded retry limit', () => {
  assert.notEqual(waitForReadyFunction, '')
  const output = execFileSync('bash', ['-c', `${waitForReadyFunction}\ncount=0\ncurl(){ count=$((count+1)); return 1; }\nsleep(){ :; }\nif wait_for_ready; then printf success; else printf 'failed:%s' "$count"; fi`], { encoding: 'utf8' })
  assert.equal(output, 'failed:30')
})

test('publisher final zero-value audit reads the persisted confirmation', () => {
  assert.match(reconciliationPublisher, /SELECT[\s\S]*zero_value_confirmed[\s\S]*zero_value_confirm_note[\s\S]*FROM daily_collection_reconciliations WHERE id=\?/)
  assert.match(reconciliationPublisher, /Number\(published\.zero_value_confirmed\) === 1 \? 'business_confirmed' : 'requires_business_confirmation'/)
  assert.match(reconciliationPublisher, /zeroValueConfirmNote: published\.zero_value_confirm_note/)
})

test('daily reconciliation publisher treats NULL daily readback as a mismatch', () => {
  assert.match(reconciliationPublisher, /snapshot\.daily_collection IS NOT revision\.new_daily_collection/)
  assert.doesNotMatch(reconciliationPublisher, /snapshot\.daily_collection<>revision\.new_daily_collection/)
  const sql = reconciliationPublisher.match(/const mismatch = verification\.prepare\(`([\s\S]*?)`\)\.get\(batch\.id\)/)?.[1]
  assert.ok(sql, 'publisher mismatch readback SQL must be extractable')
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE daily_collection_reconciliations(id INTEGER PRIMARY KEY,business_date TEXT,report_id TEXT,extracted_at TEXT);
    CREATE TABLE daily_collection_revision_rows(reconciliation_id INTEGER,center TEXT,new_daily_collection REAL,old_cumulative_budget REAL,old_cumulative_executed REAL);
    CREATE TABLE daily_snapshots(id INTEGER PRIMARY KEY,date TEXT,center TEXT,business_date TEXT,quality_status TEXT,source_status TEXT,daily_collection REAL,cumulative_budget REAL,cumulative_executed REAL,last_validated_at TEXT,field_provenance TEXT);
    INSERT INTO daily_collection_reconciliations VALUES(1,'2026-08-28','report-1','2026-08-29T09:00:00+08:00');
    INSERT INTO daily_collection_revision_rows VALUES(1,'测试中心',5,10,20);
    INSERT INTO daily_snapshots(date,center,business_date,quality_status,source_status,daily_collection,cumulative_budget,cumulative_executed) VALUES('2026-08-28','测试中心','2026-08-28','verified','available',NULL,10,20);
  `)
  assert.equal((database.prepare(sql).get(1) as any).n, 1)
  database.close()
})

test('daily-only publisher readback validates revision facts without requiring legacy snapshot joins', () => {
  assert.match(reconciliationPublisher, /publication_mode/)
  assert.match(reconciliationPublisher, /published\.publication_mode === 'daily_only'/)
  assert.match(reconciliationPublisher, /COUNT\(DISTINCT revision\.center\)[\s\S]*payment_centers/)
  assert.match(reconciliationPublisher, /revision_total/)
})

test('daily reconciliation publisher counts an absent joined snapshot as a mismatch and requires exact joined cardinality', () => {
  const sql = reconciliationPublisher.match(/const mismatch = verification\.prepare\(`([\s\S]*?)`\)\.get\(batch\.id\)/)?.[1]
  assert.ok(sql, 'publisher mismatch readback SQL must be extractable')
  assert.match(sql, /LEFT JOIN daily_snapshots snapshot/)
  assert.match(sql, /snapshot\.id IS NULL/)
  assert.match(reconciliationPublisher, /COUNT\(snapshot\.id\)[\s\S]*joinedSnapshotCount/)
  assert.match(reconciliationPublisher, /Number\(joinedSnapshotCount\.n\) !== 56/)
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE daily_collection_reconciliations(id INTEGER PRIMARY KEY,business_date TEXT,report_id TEXT,extracted_at TEXT);
    CREATE TABLE daily_collection_revision_rows(reconciliation_id INTEGER,center TEXT,new_daily_collection REAL,old_cumulative_budget REAL,old_cumulative_executed REAL);
    CREATE TABLE daily_snapshots(id INTEGER PRIMARY KEY,date TEXT,center TEXT,business_date TEXT,quality_status TEXT,source_status TEXT,daily_collection REAL,cumulative_budget REAL,cumulative_executed REAL,last_validated_at TEXT,field_provenance TEXT);
    INSERT INTO daily_collection_reconciliations VALUES(1,'2026-08-28','report-1','2026-08-29T09:00:00+08:00');
    INSERT INTO daily_collection_revision_rows VALUES(1,'缺失中心',5,10,20);
  `)
  assert.equal((database.prepare(sql).get(1) as any).n, 1)
  database.close()
})

test('daily reconciliation separates conservative timer work from bounded resumable backfill', () => {
  assert.match(reconciliationRunner, /RECONCILIATION_MODE="\$\{COCKPIT_RECONCILIATION_MODE:-daily\}"/)
  assert.match(reconciliationRunner, /BACKFILL_BATCH_SIZE="\$\{COCKPIT_RECONCILIATION_BACKFILL_BATCH_SIZE:-5\}"/)
  assert.match(reconciliationRunner, /daily_reconciliation_candidates\.py[\s\S]*--batch-size "\$selection_size"/)
  assert.doesNotMatch(reconciliationRunner, /recent AS|LIMIT 3/)
  assert.match(reconciliationRunner, /cleanup\(\)[\s\S]*CURRENT_PAYLOAD[\s\S]*trap cleanup EXIT/)
  assert.match(reconciliationRunner, /trap 'exit 130' INT/)
  assert.match(reconciliationRunner, /trap 'exit 143' TERM/)
  assert.match(reconciliationPublisher, /batch\?\.status === 'published'/)
  assert.match(reconciliationPublisher, /idempotent/)
})


test('daily reconciliation timer loads protected credentials and fails closed on every runtime dependency', () => {
  const service = fs.readFileSync(new URL('../systemd/cockpit-daily-reconciliation.service', import.meta.url), 'utf8')
  assert.match(service, /^EnvironmentFile=\/home\/ubuntu\/\.hermes\/\.env$/m)
  assert.match(service, /^EnvironmentFile=\/etc\/first-service\/cockpit-daily-reconciliation\.env$/m)
  assert.doesNotMatch(service, /^EnvironmentFile=\/etc\/first-service\/cockpit\.env$/m)
  assert.match(preflight, /COCKPIT_ENV_FILE="\$\{COCKPIT_ENV_FILE:-\/etc\/first-service\/cockpit\.env\}"/)
  assert.match(preflight, /cockpit环境文件权限必须为 600/)
  for (const credential of ['APH_USER', 'APH_PWD']) {
    assert.match(preflight, new RegExp(`Hermes 环境缺少 ${credential}`))
    assert.match(reconciliationRunner, new RegExp(`missing required environment: ${credential}`))
  }
  assert.match(reconciliationRunner, /missing required environment: DAILY_RECONCILIATION_JWT_SECRET/)
  assert.doesNotMatch(reconciliationRunner, /missing required environment: JWT_SECRET/)
  assert.match(preflight, /cockpit-daily-reconciliation\.env/)
  assert.match(preflight, /专项自动化环境文件必须由 root 管理/)
  assert.match(preflight, /专项自动化环境文件权限必须为 600/)
  assert.match(preflight, /专项自动化密钥长度必须至少为 32/)
  assert.match(preflight, /专项自动化密钥不得等于人类 JWT_SECRET/)
  assert.doesNotMatch(service, /JWT_SECRET=/)
  assert.match(service, /^UnsetEnvironment=JWT_SECRET$/m)
  assert.match(service, /^Environment=NO_PROXY=127\.0\.0\.1,localhost$/m)
  assert.match(service, /^Environment=no_proxy=127\.0\.0\.1,localhost$/m)
  assert.match(preflight, /Hermes 环境不得包含 JWT_SECRET/)
  for (const [variable, command] of [['SQLITE_BIN', 'sqlite3'], ['FLOCK_BIN', 'flock'], ['NODE_BIN', 'node'], ['RUNTIME_PYTHON', 'python']]) {
    assert.match(preflight, new RegExp(`${variable}=.*${command}[\\s\\S]*command -v "\\$${variable}"`, 'i'))
  }
  assert.match(preflight, /process\.versions\.node[\s\S]*20/)
})

test('deploy provisions and rollback-restores a cryptographically independent automation secret', () => {
  assert.match(deployer, /cockpit-daily-reconciliation\.env/)
  assert.match(deployer, /crypto\.randomBytes\(48\)\.toString\('base64url'\)/)
  assert.doesNotMatch(deployer, /createHmac|daily-reconciliation\/jwt\/v1/)
  assert.match(deployer, /DAILY_ENV_EXISTED/)
  assert.match(deployer, /ALLOW_DAILY_RECONCILIATION_SECRET_ROTATION/)
  assert.match(deployer, /已有专项自动化密钥，默认保留原值/)
  assert.match(deployer, /install[^\n]*-o root[^\n]*-g root[^\n]*-m 0600/)
  assert.match(deployer, /REQUIRE_DAILY_RECONCILIATION_ENV=1[\s\S]*operations-runtime-preflight\.sh/)
  assert.match(apiService, /^EnvironmentFile=\/etc\/first-service\/cockpit-daily-reconciliation\.env$/m)
  assert.match(authSource, /生产环境缺少独立的 DAILY_RECONCILIATION_JWT_SECRET/)
  assert.doesNotMatch(authSource, /createHmac|DAILY_RECONCILIATION_SECRET_DOMAIN/)
  assert.match(preflight, /parse_systemd_environment/)
  assert.match(builder, /apiService[\s\S]*first-service-cockpit\.service/)
  assert.match(builder, /apiService[\s\S]*backend\/systemd\/first-service-cockpit\.service/)
  assert.match(deployer, /SYSTEMD_UNITS=\([\s\S]*first-service-cockpit\.service[\s\S]*cockpit-daily-reconciliation\.service/)
})

test('idempotent reconciliation read-back rejects degraded snapshot metadata', () => {
  assert.match(reconciliationPublisher, /snapshot\.quality_status IS NOT 'verified'/)
  assert.match(reconciliationPublisher, /snapshot\.source_status IS NOT 'available'/)
  assert.match(reconciliationPublisher, /snapshot\.business_date IS NOT snapshot\.date/)
  assert.match(reconciliationPublisher, /snapshot\.last_validated_at IS NOT reconciliation\.extracted_at/)
  for (const path of ['reportId', 'businessDate', 'extractedAt', 'dailyReconciliationId']) {
    assert.match(reconciliationPublisher, new RegExp(`json_extract\\(snapshot\\.field_provenance,'\\$\\.daily_collection\\.${path}'\\)`))
  }
})

test('production candidate installs a state-exact fail-closed rollback and starts timer after API readiness', () => {
  assert.doesNotMatch(deployer, /systemctl restart "\$SERVICE" \|\| true/)
  assert.match(deployer, /ROLLBACK_FAILED=0/)
  assert.match(deployer, /rollback_step\(\)/)
  assert.match(deployer, /cmp -s "\$BACKUP\/systemd\/\$unit" "\$target"/)
  assert.match(deployer, /systemctl is-enabled "\$unit"/)
  assert.match(deployer, /systemctl is-active "\$unit"/)
  assert.match(deployer, /回滚验证失败/)
  const readiness = deployer.lastIndexOf('wait_for_ready')
  const timerStart = deployer.indexOf('systemctl enable --now cockpit-daily-reconciliation.timer')
  assert.ok(readiness >= 0 && timerStart > readiness, 'timer must start only after the new API is ready')
})

test('production candidate installs a rollback-safe 00:00 prior-day reconciliation timer', () => {
  const servicePath = new URL('../systemd/cockpit-daily-reconciliation.service', import.meta.url)
  const timerPath = new URL('../systemd/cockpit-daily-reconciliation.timer', import.meta.url)
  assert.ok(fs.existsSync(servicePath), 'missing systemd service')
  assert.ok(fs.existsSync(timerPath), 'missing systemd timer')
  const service = fs.readFileSync(servicePath, 'utf8')
  const timer = fs.readFileSync(timerPath, 'utf8')
  assert.match(service, /Type=oneshot/)
  assert.match(service, /Environment=TZ=Asia\/Shanghai/)
  assert.match(service, /run-daily-reconciliation\.sh/)
  assert.match(timer, /OnCalendar=\*-\*-\* 00:00:00 Asia\/Shanghai/)
  assert.match(timer, /Persistent=false/)
  assert.match(reconciliationRunner, /from datetime import date; print\(date\.today\(\)\)/)
  assert.match(reconciliationRunner, /--latest-formal-before "\$selection_start"/)
  assert.doesNotMatch(reconciliationRunner, /timedelta\(days=1\)/)
  assert.match(builder, /cockpit-daily-reconciliation\.service[\s\S]*cockpit-daily-reconciliation\.timer/)
  assert.match(deployer, /SYSTEMD_UNITS[\s\S]*cockpit-daily-reconciliation\.timer/)
  assert.match(deployer, /systemd-state\.tsv[\s\S]*rollback[\s\S]*daemon-reload[\s\S]*enable --now/)
})

test('daily reconciliation service timeout safely exceeds six worst-case probes', () => {
  const service = fs.readFileSync(new URL('../systemd/cockpit-daily-reconciliation.service', import.meta.url), 'utf8')
  assert.match(service, /# Six candidates x \(70s navigation \+ 120s report wait\) plus startup and publish overhead/)
  assert.match(service, /^TimeoutStartSec=30min$/m)
})

test('R161 release binds the verified current R160 production entry rather than the stale R157 mirror hash', () => {
  assert.match(builder, /runtime\.frontend\?\.indexSha256/)
  assert.doesNotMatch(builder, /indexSha256:\s*baseline\.indexSha256/)
})

test('full-history backfill is installed but never auto-started', () => {
  assert.match(backfillService, /Type=oneshot/)
  assert.match(backfillService, /COCKPIT_RECONCILIATION_MODE=backfill/)
  assert.match(backfillService, /COCKPIT_RECONCILIATION_BACKFILL_BATCH_SIZE=/)
  assert.doesNotMatch(backfillService, /\[Install\]/)
  assert.match(deployer, /cockpit-daily-reconciliation-backfill\.service/)
  assert.doesNotMatch(deployer, /enable --now cockpit-daily-reconciliation-backfill/)
})

test('reconciliation workers use isolated temporary directories and one persistent global lock', () => {
  assert.match(reconciliationService, /^RuntimeDirectory=first-service-cockpit-reconciliation-daily$/m)
  assert.match(backfillService, /^RuntimeDirectory=first-service-cockpit-reconciliation-backfill$/m)
  assert.doesNotMatch(reconciliationService, /^RuntimeDirectory=first-service-cockpit-reconciliation$/m)
  assert.doesNotMatch(backfillService, /^RuntimeDirectory=first-service-cockpit-reconciliation$/m)
  assert.match(reconciliationService, /^StateDirectory=first-service-cockpit-reconciliation$/m)
  assert.match(backfillService, /^StateDirectory=first-service-cockpit-reconciliation$/m)
  assert.match(reconciliationRunner, /RUNTIME_DIR="\$\{RUNTIME_DIRECTORY:-\/run\/first-service-cockpit-reconciliation-daily\}"/)
  assert.match(reconciliationRunner, /LOCK_ROOT="\$\{STATE_DIRECTORY:-\/var\/lib\/first-service-cockpit-reconciliation\}"/)
  assert.match(reconciliationRunner, /LOCK_FILE="\$\{DAILY_RECONCILIATION_LOCK:-\$LOCK_ROOT\/daily\.lock\}"/)
  assert.match(reconciliationRunner, /mktemp "\$RUNTIME_DIR\/dates\.XXXXXX"/)
  assert.doesNotMatch(reconciliationRunner, /LOCK_FILE=.*\$RUNTIME_DIR/)
  assert.doesNotMatch(reconciliationRunner, /\/tmp\/cockpit-daily-reconciliation\.lock/)
})

test('deployment freezes writers and rolls back a consistent SQLite backup with code', () => {
  assert.match(deployer, /SQLITE_BIN=.*sqlite3/)
  assert.match(deployer, /stop_and_confirm_inactive "\$SERVICE"[\s\S]*\.backup/)
  assert.match(deployer, /BACKUP\/database/)
  assert.match(deployer, /rollback[\s\S]*database[\s\S]*cockpit\.db/)
  assert.match(deployer, /PRAGMA quick_check/)
})
