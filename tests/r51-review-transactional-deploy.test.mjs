import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const scriptPath = path.join(root, 'deploy/r51-review-recovery/deploy-production.py')

test('R51 生产发布仅使用显式白名单且不执行 broad sync/delete', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')

  for (const token of [
    'firstcare-cloud-local/aph2-r55-review-entry-20260812-v1.js',
    'firstcare-cloud-local/review-launcher.html',
    'firstcare-cloud-local/review-launcher-20260812-v1.js',
    'firstcare-cloud-local/review-launcher-20260812-v1.css',
    'review-system/active/frontend/dist',
    'review-system/active/backend/server.js',
    'review-system/active/hermes/server.js',
    'deploy/r51-review-recovery/review-legacy-retired.py',
    'deploy/r51-review-recovery/review-system.conf',
    'deploy/r51-review-recovery/first-service-review-api.service',
    'deploy/r51-review-recovery/first-service-hermes-gateway.service',
    'deploy/r51-review-recovery/review-server.service',
    'deploy/r51-review-recovery/review-ws.service'
  ]) assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  assert.doesNotMatch(source, /\brsync\b|--delete|rm\s+-rf|shutil\.rmtree/)
  assert.match(source, /ALLOWED_REVIEW_DIST/)
  assert.match(source, /frontend\/src[\s\S]*?newer than review dist|review dist is stale/i)
  assert.match(source, /backend\/data/)
  assert.match(source, /FORBIDDEN_BUSINESS_TARGETS/)
})

test('R51 生产发布具备远程锁、精确备份、原子切换与失败回滚', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')

  assert.match(source, /LOCK_ROOT\s*=\s*Path\("\/run\/first-service-release"\)/)
  assert.match(source, /LOCK_PATH\s*=\s*LOCK_ROOT \/ "cockpit-release\.lock"/)
  assert.match(source, /install -d -o root -g root -m 0700 \/run\/first-service-release/)
  assert.doesNotMatch(source, /LOCK_(?:ROOT|PATH)[^\n]*\/run\/lock/)
  assert.match(source, /fcntl\.flock\([\s\S]*?LOCK_EX \| fcntl\.LOCK_NB/)
  assert.match(source, /BACKUP_ROOT\s*=\s*STATE_ROOT\s*\/\s*"backups"/)
  assert.match(source, /def backup_targets/)
  assert.match(source, /def atomic_install/)
  assert.match(source, /os\.replace/)
  assert.match(source, /os\.fsync/)
  assert.match(source, /def rollback/)
  assert.match(source, /def complete_forward_only_security_floor/)
  assert.match(source, /def finish_rollback_reopening/)
  assert.doesNotMatch(source, /restore_service_states|restore_current_link/)
  assert.match(source, /except Exception as deploy_error:[\s\S]*?rollback\(/)
})

test('R51 切换前后都有 Nginx/systemd/服务/端口门禁', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')

  assert.match(source, /systemd-analyze["'],\s*["']verify/)
  assert.match(source, /nginx["'],\s*["']-t/)
  assert.match(source, /daemon-reload/)
  assert.match(source, /first-service-review-api\.service/)
  assert.match(source, /first-service-hermes-gateway\.service/)
  assert.match(source, /def ensure_legacy_units_masked/)
  assert.match(source, /systemctl["'],\s*["']mask["'],\s*\*LEGACY_UNITS/)
  assert.match(source, /UnitFileState["']\) not in \{["']masked["'], ["']masked-runtime["']\}/)
  assert.match(source, /8788/)
  assert.match(source, /8789/)
  assert.match(source, /\/review-api\/health/)
  assert.match(source, /\/hermes\/health/)
  assert.match(source, /\/review-system\//)
  assert.equal((source.match(/"BIND_HOST":\s*"127\.0\.0\.1"/g) || []).length, 2)
  assert.match(source, /def listener_bindings/)
  assert.match(source, /def assert_modern_ports_loopback/)
  assert.match(source, /hosts - allowed/)
  assert.match(source, /assert_modern_ports_loopback\(3001, 3100\)/)
})

test('R51 legacy 双入口是 root-only 退休 stub 且不能直接启动监听', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')
  const stubPath = path.join(root, 'deploy/r51-review-recovery/review-legacy-retired.py')
  const stub = fs.readFileSync(stubPath, 'utf8')
  const result = spawnSync('python3', [stubPath], { encoding: 'utf8' })
  assert.equal(result.status, 78)
  assert.match(result.stderr, /retired/i)
  assert.doesNotMatch(stub, /\bsocket\b|ThreadingHTTPServer|aph_proxy|\bopen\s*\(/)
  for (const target of ['/opt/review-system/server.py', '/opt/review-system/ws_server.py']) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(source, new RegExp(`"target": "${escaped}"[\\s\\S]{0,180}?"mode": 0o444[\\s\\S]{0,120}?"owner": "root"`))
  }
  assert.match(source, /def ensure_legacy_units_masked[\s\S]*?systemctl["'],\s*["']mask["'],\s*\*LEGACY_UNITS/)
  assert.match(source, /start = command\(\["systemctl", "start", unit\], check=False\)[\s\S]*?start\.returncode == 0/)
})

test('R51 首次迁移仅接受精确旧监听或全 loopback，并拒绝混合与额外 PID', () => {
  const probe = String.raw`
import importlib.util
from pathlib import Path
import tempfile
import sys

spec = importlib.util.spec_from_file_location("review_deploy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

accepted = (
    {"3001": ["0.0.0.0"], "3100": ["*"]},
    {"3001": ["127.0.0.1"], "3100": ["127.0.0.1"]},
)
for value in accepted:
    module.validate_modern_binding_baseline(value)

rejected = (
    {"3001": ["0.0.0.0"], "3100": ["127.0.0.1"]},
    {"3001": ["127.0.0.1"], "3100": ["*"]},
    {"3001": ["0.0.0.0", "127.0.0.1"], "3100": ["*"]},
    {"3001": ["::"], "3100": ["*"]},
    {"3001": ["0.0.0.0"], "3100": ["*"], "9999": ["127.0.0.1"]},
)
for value in rejected:
    try:
        module.validate_modern_binding_baseline(value)
    except RuntimeError:
        pass
    else:
        raise AssertionError(f"unexpectedly accepted: {value}")

class Result:
    def __init__(self, stdout):
        self.stdout = stdout

states = {
    "first-service-review-api.service": {"MainPID": "1044"},
    "first-service-hermes-gateway.service": {"MainPID": "1043"},
}
good = "\n".join((
    'LISTEN 0 511 0.0.0.0:3001 0.0.0.0:* users:(("node",pid=1044,fd=18))',
    'LISTEN 0 511 *:3100 *:* users:(("node",pid=1043,fd=18))',
))
module.command = lambda *_args, **_kwargs: Result(good)
module.assert_modern_listener_ownership(states)

bad = good + '\nLISTEN 0 511 0.0.0.0:3001 0.0.0.0:* users:(("node",pid=9999,fd=18))'
module.command = lambda *_args, **_kwargs: Result(bad)
try:
    module.assert_modern_listener_ownership(states)
except RuntimeError:
    pass
else:
    raise AssertionError("extra listener PID was accepted")
`
  const result = spawnSync('python3', ['-c', probe, scriptPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

  const source = fs.readFileSync(scriptPath, 'utf8')
  const preflight = source.slice(source.indexOf('def remote_preflight'), source.indexOf('def verify_versioned_units'))
  assert.match(preflight, /validate_modern_binding_baseline\(modern_binding_snapshot\(\)\)/)
  assert.match(preflight, /assert_modern_listener_ownership\(service_states\)/)
  assert.doesNotMatch(preflight, /assert_modern_ports_loopback/)
  assert.match(source, /"modernBindings": modern_bindings/)
  assert.match(source, /def verify_baseline_unchanged[\s\S]*?if actual_hosts != expected_hosts/)
  assert.match(source, /def assert_forward_only_security_floor[\s\S]*?assert_modern_ports_loopback\(3001, 3100\)/)
  assert.doesNotMatch(source, /restore_service_states|restore_current_link/)
})

test('R51 18GiB data 余量在预检、构建后首次写前与 gate 后 data 扫描前分阶段重验', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')
  assert.match(source, /def assert_review_data_disk_headroom[\s\S]*?MIN_REVIEW_DATA_FREE_BYTES/)
  assert.equal((source.match(/assert_review_data_disk_headroom\(/g) || []).length, 4)

  const apply = source.slice(source.indexOf('def apply_release'), source.indexOf('def acquire_release_lock'))
  const runtimeCheck = apply.indexOf('assert_review_data_disk_headroom("runtime 构建完成且生产写入前")')
  const backup = apply.indexOf('backup_targets(')
  const gateCheck = apply.indexOf('assert_review_data_disk_headroom("维护门闩生效且 API 停止后的 data 基线前")')
  const migration = apply.indexOf('prepare_factory_store_migration(backup, baseline, data_permissions)')
  assert.ok(runtimeCheck >= 0 && backup > runtimeCheck, 'runtime 后重验必须早于生产备份/标记')
  const floor = apply.indexOf('complete_forward_only_security_floor(')
  const cleanStop = apply.indexOf('stop_review_api_cleanly()', floor)
  assert.ok(floor >= 0 && cleanStop > floor, '必须先完成 security floor，再优雅停止候选 API')
  assert.ok(gateCheck > cleanStop, 'data 重验必须在 floor + API stop 之后')
  assert.ok(migration > gateCheck, 'data 迁移必须晚于第三次余量重验')
})

test('R51 发布收紧代码、环境文件与共享密钥权限', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')

  assert.match(source, /\/etc\/first-service\/review-api\.env/)
  assert.match(source, /\/etc\/first-service\/hermes-gateway\.env/)
  assert.match(source, /\.cockpit_review_sso_secret/)
  assert.match(source, /\.deepseek_key/)
  assert.match(source, /0o600/)
  assert.match(source, /0o640/)
  assert.match(source, /os\.fchown/)
  assert.doesNotMatch(source, /sk-[A-Za-z0-9_-]{16,}/)
})

test('R51 本地入口默认只输出计划，必须显式 --execute 才连接生产', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')

  assert.match(source, /--execute/)
  assert.match(source, /if not args\.execute:[\s\S]*?return/)
  assert.match(source, /--remote-apply/)
  assert.match(source, /82\.157\.119\.78/)
})

test('R51 plan-only 精确拆分 forward-only 与 reversible 目标', () => {
  const release = 'review-r51-recovery-plan-contract-20260813'
  const result = spawnSync('python3', [scriptPath, '--release', release], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env }
  })
  if (result.status !== 0 && /review dist is stale/.test(result.stdout + result.stderr)) {
    return assert.fail('frontend src 比 dist 新；必须先完成最终 rebuild 才能验证 plan 分类')
  }
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.mode, 'plan-only')
  assert.deepEqual(plan.reversibleTargets, [])
  assert.equal(new Set(plan.forwardOnlySecurityTargets).size, plan.forwardOnlySecurityTargets.length)
  assert.deepEqual(
    new Set(plan.forwardOnlySecurityTargets),
    new Set(plan.targets),
    '当前冻结中所有发布目标均属不可逆安全 floor'
  )
  for (const target of [
    '/opt/review-system/server.py',
    '/opt/review-system/ws_server.py',
    '/etc/systemd/system/review-server.service',
    '/etc/systemd/system/review-ws.service',
    '/var/www/first-service-dashboard/index.html'
  ]) assert.ok(plan.forwardOnlySecurityTargets.includes(target), `缺少 forward-only 目标 ${target}`)
})

test('R51 不以 root 执行 ubuntu 可写脚本，候选与 helper 均由本地摘要钉住', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')

  assert.match(source, /ROOT_BOOTSTRAP/)
  assert.match(source, /\/var\/lib\/first-service-release/)
  assert.match(source, /--archive-sha256/)
  assert.match(source, /--helper-sha256/)
  assert.match(source, /helper_sha256/)
  assert.match(source, /archive_sha256/)
  assert.match(source, /install -o root -g root -m 0500/)
  assert.match(source, /install -o root -g root -m 0400/)
  assert.doesNotMatch(source, /sudo["'],\s*["']\/usr\/bin\/python3["'],\s*remote_script/)
  assert.doesNotMatch(source, /sudo\s+\/usr\/bin\/python3\s+\/home\/ubuntu/)
})

test('R51 远程归档有硬上限且要求完整、唯一候选集', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')

  for (const token of [
    'MAX_ARCHIVE_BYTES',
    'MAX_MANIFEST_BYTES',
    'MAX_MEMBER_BYTES',
    'MAX_EXPANDED_BYTES',
    'MAX_ARCHIVE_FILES'
  ]) assert.match(source, new RegExp(token))
  assert.match(source, /member\.size\s*!=\s*entry\["size"\]/)
  assert.match(source, /set\(FIXED_PAYLOAD\)[\s\S]*?fixed_archives/)
  assert.match(source, /len\(archives\)\s*!=\s*len\(set\(archives\)\)/)
  assert.match(source, /len\(targets\)\s*!=\s*len\(set\(targets\)\)/)
  assert.match(source, /review-index[\s\S]*?!=\s*1/)
  assert.match(source, /validate_review_index_assets/)
})

test('R51 备份和 journal 先持久化，失败时恢复全部精确基线', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')

  assert.match(source, /journal\.json/)
  assert.match(source, /write_transaction_journal/)
  assert.match(source, /pendingTarget/)
  assert.match(source, /fsync_directory\(files_dir\)/)
  assert.match(source, /fsync_directory\(BACKUP_ROOT\)/)
  assert.match(source, /sha256\(saved\)\s*!=\s*metadata\["sha256"\]/)
  assert.match(source, /for raw_target, record in reversed\(list\(target_records\.items\(\)\)\)/)
  assert.doesNotMatch(source, /def rollback\([^)]*installed/)
})

test('R51 切换前复核服务并发基线，回滚保持 forward-only floor 与健康', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')

  assert.match(source, /verify_service_baseline_unchanged/)
  assert.match(source, /MainPID/)
  assert.match(source, /NRestarts/)
  assert.match(source, /UnitFileState/)
  assert.match(source, /def verify_rollback/)
  assert.match(source, /security-floor-promoting/)
  assert.match(source, /security-floor-live-gated/)
  assert.match(source, /ensure_legacy_units_masked/)
  assert.doesNotMatch(source, /restore_service_states|restore_unit_file_state/)
  assert.match(source, /legacyPorts/)
  assert.match(source, /assert_json_health\("http:\/\/127\.0\.0\.1:3001\/api\/health"\)/)
  assert.match(source, /assert_json_health\("http:\/\/127\.0\.0\.1:3100\/health"\)/)
})

test('R51 使用完整现网 Nginx shadow，自定义 secret 路径失败关闭并检查全接口监听', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')

  assert.match(source, /\/etc\/nginx\/nginx\.conf/)
  assert.match(source, /\/etc\/nginx\/conf\.d\/\*\.conf/)
  assert.match(source, /shadow-main\.conf/)
  assert.match(source, /REVIEW_SSO_SECRET_FILE[\s\S]*?自定义/)
  assert.match(source, /ss["'],\s*["']-H["'],\s*["']-ltn/)
  assert.doesNotMatch(source, /connect_ex\(\("127\.0\.0\.1"/)
})

test('R51 锁、发布根与候选文件使用 nofollow 和 root owner 校验', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')

  assert.match(source, /O_NOFOLLOW/)
  assert.match(source, /O_CLOEXEC/)
  assert.match(source, /def validate_secure_root/)
  assert.match(source, /st_uid\s*!=\s*0/)
  assert.match(source, /st_nlink\s*!=\s*1/)
  assert.match(source, /validate_secure_root\(LOCK_ROOT, exact_mode=0o700\)/)
  assert.match(source, /LOCK_ROOT\s*=\s*Path\("\/run\/first-service-release"\)/)
  assert.doesNotMatch(source, /LOCK_(?:ROOT|PATH)[^\n]*\/run\/lock/)
})

test('R51 依赖安全升级的全部运行时文件进入固定候选白名单', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')

  for (const token of [
    'review-system/active/backend/package.json',
    'review-system/active/backend/package-lock.json',
    'review-system/active/backend/account-password.js',
    'review-system/active/backend/vendor/xlsx-0.20.3.tgz',
    'review-system/active/hermes/package.json',
    'review-system/active/hermes/package-lock.json',
    'review-system/active/hermes/profiles.js'
  ]) assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  assert.match(source, /backend-app/)
  assert.match(source, /hermes-app/)
})

test('R51 在首次生产切换前依 lockfile 构建和审计 Linux 依赖', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')

  assert.match(source, /def prepare_versioned_runtime/)
  assert.match(source, /npm["'],\s*["']ci["'][\s\S]*?--omit=dev[\s\S]*?--ignore-scripts/)
  assert.match(source, /npm_config_ignore_scripts/)
  assert.match(source, /"npm_config_registry":\s*"https:\/\/registry\.npmjs\.org\/"/)
  assert.match(source, /npm_config_fetch_timeout/)
  assert.match(source, /npm_config_fetch_retries/)
  assert.match(source, /npm["'],\s*["']audit["'][\s\S]*?--omit=dev/)
  assert.match(source, /npm["'],\s*["']ls["'][\s\S]*?--omit=dev/)
  assert.match(source, /prepare_versioned_runtime[\s\S]*?backup_targets/)
  assert.match(source, /verify_versioned_units\(candidate, manifest, runtime_stage\)[\s\S]*?backup_targets/)
  assert.match(source, /def ensure_security_floor_runtime[\s\S]*?promote_versioned_runtime\(stage, baseline\["release"\]\)[\s\S]*?atomic_symlink\(final\)/)
  assert.match(source, /def complete_forward_only_security_floor[\s\S]*?systemd-analyze["'],\s*["']verify/)
})

test('R51 modern runtime 使用 root-owned 版本目录与 forward-only current 原子链接', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')
  const apiUnit = fs.readFileSync(path.join(root, 'deploy/r51-review-recovery/first-service-review-api.service'), 'utf8')
  const hermesUnit = fs.readFileSync(path.join(root, 'deploy/r51-review-recovery/first-service-hermes-gateway.service'), 'utf8')

  assert.match(source, /\/opt\/first-service-review-modern\/releases/)
  assert.match(source, /APP_CURRENT/)
  assert.match(source, /def atomic_symlink/)
  assert.match(source, /currentLink/)
  assert.doesNotMatch(source, /restore_current_link|restore_service_states/)
  assert.match(source, /securityFloorState/)
  assert.match(source, /os\.replace[\s\S]*?os\.fsync/)
  assert.match(apiUnit, /^WorkingDirectory=\/opt\/first-service-review-modern\/current\/backend$/m)
  assert.match(apiUnit, /^ExecStart=\/usr\/bin\/node \/opt\/first-service-review-modern\/current\/backend\/server\.js$/m)
  assert.match(hermesUnit, /^WorkingDirectory=\/opt\/first-service-review-modern\/current\/hermes$/m)
  assert.match(hermesUnit, /^ExecStart=\/usr\/bin\/node \/opt\/first-service-review-modern\/current\/hermes\/server\.js$/m)
})

test('R51 版本化 runtime 与现有业务 data 严格隔离', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')

  assert.match(source, /"DATA_DIR":\s*str\(REVIEW_DATA_ROOT\)/)
  assert.match(source, /"STORE_FILE":\s*str\(REVIEW_DATA_ROOT\s*\/\s*"store\.json"\)/)
  assert.match(source, /"FILES_DIR":\s*str\(REVIEW_DATA_ROOT\s*\/\s*"files"\)/)
  assert.match(source, /"BACKUPS_DIR":\s*str\(REVIEW_DATA_ROOT\s*\/\s*"backups"\)/)
  assert.match(source, /def validate_runtime_tree/)
  assert.match(source, /st_uid\s*!=\s*0/)
  assert.match(source, /S_IWGRP\s*\|\s*stat\.S_IWOTH/)
  assert.match(source, /relative symlink|relative.*symlink|symlink.*relative/i)
})

test('R51 不覆盖共享 Cockpit index，只在 Nginx HTML 响应中精确注入 R55', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')
  const nginx = fs.readFileSync(path.join(root, 'deploy/r51-review-recovery/review-system.conf'), 'utf8')
  assert.doesNotMatch(source, /payload\/cockpit\/index\.html|cockpit-index\.html|kind": "cockpit-index"/)
  assert.doesNotMatch(source, /COCKPIT_INDEX_EXPECTED_CURRENT_SHA256|verify_expected_current_targets/)
  assert.match(source, /def cockpit_index_watch/)
  assert.match(source, /COCKPIT_FAVICON_MARKER/)
  assert.match(source, /text\.count\(COCKPIT_FAVICON_MARKER\) != 1/)
  assert.match(source, /Cockpit 现网 index 已内置 R55/)
  assert.match(source, /cockpit_watch_before = cockpit_index_watch\(\)[\s\S]*?candidate_nginx_test/)
  assert.match(source, /cockpit_watch = cockpit_index_watch\(\)[\s\S]*?cockpit_watch != cockpit_watch_before/)
  const faviconInjection = `sub_filter '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />'`
  assert.equal(nginx.split(faviconInjection).length - 1, 2)
  assert.match(source, /def assert_cockpit_r55_injection/)
  assert.match(source, /"\/", "\/index\.html", "\/daily", "\/projects\/1", "\/arrears"/)
  assert.doesNotMatch(source, /STORE_EXPECTED_CURRENT_SHA256/)
  assert.match(source, /validate_store_transaction_baseline\(data_permissions\)/)
  assert.match(source, /complete_forward_only_security_floor[\s\S]*?stop_review_api_cleanly/)
  assert.match(source, /commit-ready[\s\S]*?deactivate_review_maintenance/)
  assert.match(source, /已越过 commit point/)
})

test('R51 rollback-safe Nginx 与候选保持完整安全/流式功能 floor', () => {
  const candidate = fs.readFileSync(path.join(root, 'deploy/r51-review-recovery/review-system.conf'), 'utf8')
  const rollbackSafe = fs.readFileSync(path.join(root, 'deploy/r51-review-recovery/review-system.rollback-safe.conf'), 'utf8')
  const effective = value => value.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  assert.deepEqual(effective(rollbackSafe), effective(candidate))
  for (const config of [candidate, rollbackSafe]) {
    assert.match(config, /location \^~ \/review-api\/aph\/\s*\{\s*return 404;\s*\}/)
    assert.match(config, /location = \/review-api\/aph\s*\{\s*return 404;\s*\}/)
    assert.match(config, /client_max_body_size 5200m/)
    assert.match(config, /proxy_request_buffering off/)
    assert.match(config, /location = \/review-api\/system-backup\/restore/)
    assert.match(config, /location = \/review-api\/system-backup\/preview/)
    assert.match(config, /location \^~ \/hermes\/\s*\{\s*return 404;\s*\}/)
    assert.match(config, /location = \/hermes\s*\{\s*return 404;\s*\}/)
    assert.equal(config.split(`sub_filter '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />'`).length - 1, 2)
  }
})

test('R51 权威备份与发布锁均位于 root 信任边界', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')
  assert.match(source, /BACKUP_ROOT\s*=\s*STATE_ROOT\s*\/\s*"backups"/)
  assert.match(source, /validate_secure_root\(BACKUP_ROOT, exact_mode=0o700\)/)
  assert.doesNotMatch(source, /BACKUP_ROOT\s*=\s*Path\("\/home\/ubuntu/)
  assert.match(source, /attempt_receipt=.*[\s\S]*?printf[\s\S]*?sync -f "\$attempt_receipt"[\s\S]*?mkdir -- "\$stage"/)
  assert.match(source, /attempt-\$release\.lock[\s\S]*?flock -n 8/)
  assert.match(source, /--staging-dir "\$stage"/)
  assert.match(source, /def acquire_release_lock/)
  assert.match(source, /os\.open\(LOCK_PATH, flags, 0o600\)/)
  assert.match(source, /fcntl\.flock\(descriptor, fcntl\.LOCK_EX \| fcntl\.LOCK_NB\)/)
  assert.doesNotMatch(source, /exec 9>\/run\/lock/)
  assert.match(source, /release_suffix=.*[\s\S]*?\$\{#release_suffix\}/)
})

test('R51 runtime 全树持久化并在崩溃恢复时验证或回滚', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')
  assert.match(source, /def fsync_runtime_tree/)
  assert.match(source, /os\.fsync\(descriptor\)/)
  assert.match(source, /for directory in sorted\(directories[\s\S]*?fsync_directory\(directory\)/)
  assert.match(source, /runtimeIntegrity/)
  assert.match(source, /def validate_runtime_integrity/)
  assert.match(source, /def recover_committed_transaction/)
  assert.match(source, /safe_precommit[\s\S]*?rollback\(backup, baseline, journal/)
})

test('R51 lockfile 供应链与 pre-mutation orphan 重试均失败关闭', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')
  assert.match(source, /def validate_lockfile_supply_chain/)
  assert.match(source, /https:\/\/registry\.npmjs\.org\//)
  assert.match(source, /sha512-/)
  assert.match(source, /file:vendor\/xlsx-0\.20\.3\.tgz/)
  assert.match(source, /def prepare_exact_release_retry/)
  assert.match(source, /def remove_exact_orphan_tree/)
  assert.match(source, /同一 release 已存在不可变历史 runtime，拒绝复用或清理/)
  assert.match(source, /path\.parent not in \{CANDIDATE_ROOT, APP_STAGING_ROOT\}/)
  assert.doesNotMatch(
    source.slice(source.indexOf('def prepare_exact_release_retry'), source.indexOf('def validate_remote_trust')),
    /remove_exact_orphan_tree\(APP_RELEASES_ROOT/
  )
  assert.doesNotMatch(source, /shutil\.rmtree/)
})

test('R51 历史成功 release 即使已非 current 也拒绝同 ID 复用且不删除', () => {
  const probe = String.raw`
import importlib.util
from pathlib import Path
import tempfile
import sys

spec = importlib.util.spec_from_file_location("r51_deploy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

release = "review-r51-recovery-historical1"
with tempfile.TemporaryDirectory(prefix="r51-release-history-") as temporary:
    root = Path(temporary)
    module.CANDIDATE_ROOT = root / "candidates"
    module.APP_STAGING_ROOT = root / "staging"
    module.APP_RELEASES_ROOT = root / "releases"
    module.ACTIVE_TRANSACTION = root / "active-transaction.json"
    for directory in (module.CANDIDATE_ROOT, module.APP_STAGING_ROOT, module.APP_RELEASES_ROOT):
        directory.mkdir()
    historical = module.APP_RELEASES_ROOT / release
    historical.mkdir()
    sentinel = historical / "immutable-runtime.js"
    sentinel.write_text("historical-success", encoding="utf-8")
    candidate = module.CANDIDATE_ROOT / release
    runtime_stage = module.APP_STAGING_ROOT / release
    candidate.mkdir(); (candidate / "sentinel").write_text("candidate-keep", encoding="utf-8")
    runtime_stage.mkdir(); (runtime_stage / "sentinel").write_text("stage-keep", encoding="utf-8")

    try:
        module.prepare_exact_release_retry(
            release,
            root / "missing-receipt.json",
            root / "missing-root-stage",
            "0" * 64,
            "1" * 64,
        )
    except RuntimeError as error:
        assert "不可变历史 runtime" in str(error)
    else:
        raise AssertionError("historical final release ID reuse was accepted")
    assert sentinel.read_text(encoding="utf-8") == "historical-success"
    assert historical.is_dir()
    assert (candidate / "sentinel").read_text(encoding="utf-8") == "candidate-keep"
    assert (runtime_stage / "sentinel").read_text(encoding="utf-8") == "stage-keep"

    # final runtime 根不属于 orphan 清理白名单，任何直接调用也必须拒绝。
    try:
        module.remove_exact_orphan_tree(historical)
    except RuntimeError as error:
        assert "超出精确白名单" in str(error)
    else:
        raise AssertionError("final release was accepted as an orphan")

`
  const result = spawnSync('python3', ['-c', probe, scriptPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('R51 runtime 固定候选按 backend 7 + Hermes 4 精确集合验证且先验后写', () => {
  const probe = String.raw`
import copy
import importlib.util
from pathlib import Path
import tempfile
import types
import sys

spec = importlib.util.spec_from_file_location("r51_deploy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
entries = module.local_payload_entries()
runtime_entries = [item for item in entries if item["kind"] in {"backend-app", "hermes-app"}]
validated = module.validate_runtime_manifest_entries({"entries": runtime_entries})
assert len(validated) == 11
assert sum(item["kind"] == "backend-app" for item in validated) == 7
assert sum(item["kind"] == "hermes-app" for item in validated) == 4
expected_relatives = set().union(*module.EXPECTED_RUNTIME_RELATIVES.values())
assert {module.runtime_relative(item).as_posix() for item in validated} == expected_relatives

def must_reject(candidate, label):
    try:
        module.validate_runtime_manifest_entries({"entries": candidate})
    except RuntimeError:
        return
    raise AssertionError(f"runtime malformed fixture accepted: {label}")

must_reject(runtime_entries[:-1], "missing")
extra = copy.deepcopy(runtime_entries[0])
extra["archive"] = "payload/backend/extra.js"
extra["target"] = "/opt/first-service-review-modern/current/backend/extra.js"
must_reject([*runtime_entries, extra], "extra")
duplicate_relative = copy.deepcopy(runtime_entries[0])
duplicate_relative["archive"] = "payload/backend/duplicate-server.js"
must_reject([*runtime_entries, duplicate_relative], "duplicate-relative")
wrong_kind = copy.deepcopy(runtime_entries[0])
wrong_kind["kind"] = "hermes-app"
must_reject([wrong_kind, *runtime_entries[1:]], "wrong-kind")

with tempfile.TemporaryDirectory(prefix="r51-runtime-exact-") as temporary:
    root = Path(temporary)
    module.APP_STAGING_ROOT = root / "staging"
    module.APP_RELEASES_ROOT = root / "releases"
    module.APP_STAGING_ROOT.mkdir()
    module.APP_RELEASES_ROOT.mkdir()
    candidate = root / "candidate"
    candidate.mkdir()
    calls = []

    module.shutil.disk_usage = lambda _path: types.SimpleNamespace(free=10 * 1024**3)
    module.verify_service_baseline_unchanged = lambda _states: None
    module.validate_lockfile_supply_chain = lambda _value, _name: None
    module.runtime_integrity_records = lambda _stage: []
    module.harden_runtime_tree = lambda _stage: {"fileCount": 1, "bytes": 0}
    module.validate_runtime_tree = lambda _stage: {"fileCount": 1, "bytes": 0}
    module.validate_runtime_integrity = lambda _stage: None
    module.fsync_runtime_tree = lambda _stage: None
    module.durable_json = lambda path, value: path.write_text(
        module.json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    module.verify_npm_application = lambda app, _env: calls.append(("verify", app.name)) or {
        "name": app.name, "version": "fixture", "auditVulnerabilities": {"total": 0}
    }

    def install_source(_source, stage, relative, _sha):
        target = stage.joinpath(*relative.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('{"lockfileVersion":3}' if target.name == "package-lock.json" else "fixture", encoding="utf-8")
    module.install_runtime_source = install_source

    def fake_command(argv, **kwargs):
        calls.append(tuple(argv))
        if argv[:2] == ["npm", "ci"]:
            (Path(kwargs["cwd"]) / "node_modules").mkdir()
        return types.SimpleNamespace(stdout="", stderr="", returncode=0)
    module.command = fake_command

    release = "review-r51-recovery-runtimeexact1"
    stage, _evidence = module.prepare_versioned_runtime(
        candidate,
        {"entries": runtime_entries},
        release,
        {},
    )
    assert stage == module.APP_STAGING_ROOT / release
    assert all(stage.joinpath(*Path(relative).parts).is_file() for relative in expected_relatives)
    assert [(item[0], item[1]) for item in calls if item[0] == "verify"] == [
        ("verify", "backend"), ("verify", "hermes")
    ]
    assert sum(call[:2] == ("npm", "ci") for call in calls if isinstance(call, tuple)) == 2

    rejected_release = "review-r51-recovery-runtimebad01"
    try:
        module.prepare_versioned_runtime(candidate, {"entries": runtime_entries[:-1]}, rejected_release, {})
    except RuntimeError:
        pass
    else:
        raise AssertionError("prepare accepted incomplete runtime")
    assert not (module.APP_STAGING_ROOT / rejected_release).exists()
`
  const result = spawnSync('python3', ['-c', probe, scriptPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('R51 pre-marker attempt receipt 精确清理同 release 四级孤儿且拒绝篡改', () => {
  const probe = String.raw`
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import sys

spec = importlib.util.spec_from_file_location("r51_deploy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
release = "review-r51-recovery-attemptclean1"
helper_bytes = b"trusted-helper"
archive_bytes = b"trusted-archive"
helper_sha = hashlib.sha256(helper_bytes).hexdigest()
archive_sha = hashlib.sha256(archive_bytes).hexdigest()

with tempfile.TemporaryDirectory(prefix="r51-attempt-clean-") as temporary:
    root = Path(temporary)
    module.ROOT_INCOMING = root / "incoming"
    module.ATTEMPT_ROOT = root / "attempts"
    module.CANDIDATE_ROOT = root / "candidates"
    module.APP_STAGING_ROOT = root / "runtime-staging"
    module.APP_RELEASES_ROOT = root / "releases"
    module.ACTIVE_TRANSACTION = root / "active.json"
    for directory in (
        module.ROOT_INCOMING, module.ATTEMPT_ROOT, module.CANDIDATE_ROOT,
        module.APP_STAGING_ROOT, module.APP_RELEASES_ROOT,
    ):
        directory.mkdir(mode=0o700)

    def make_attempt(suffix):
        stage = module.ROOT_INCOMING / f"{release}.{suffix}"
        stage.mkdir(mode=0o700)
        helper = stage / "deploy-production.py"
        archive = stage / f"{release}.tar.gz"
        helper.write_bytes(helper_bytes); helper.chmod(0o500)
        archive.write_bytes(archive_bytes); archive.chmod(0o400)
        receipt = module.release_attempt_receipt_path(stage)
        receipt.write_text(json.dumps({
            "schema": module.RELEASE_ATTEMPT_SCHEMA,
            "release": release,
            "rootStage": str(stage),
            "candidate": str(module.CANDIDATE_ROOT / release),
            "runtimeStage": str(module.APP_STAGING_ROOT / release),
            "helperSha256": helper_sha,
            "archiveSha256": archive_sha,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        receipt.chmod(0o600)
        return stage, receipt

    stale_stage, stale_receipt = make_attempt("STALE001")
    current_stage, current_receipt = make_attempt("CURRENT1")
    candidate = module.CANDIDATE_ROOT / release
    runtime_stage = module.APP_STAGING_ROOT / release
    candidate.mkdir(); (candidate / "payload.bin").write_bytes(b"candidate")
    runtime_stage.mkdir(); (runtime_stage / "partial.bin").write_bytes(b"runtime")
    trap = module.CANDIDATE_ROOT / f"{release}-similar"
    trap.mkdir(); (trap / "sentinel").write_text("untouched", encoding="utf-8")

    module.prepare_exact_release_retry(
        release, current_receipt, current_stage, helper_sha, archive_sha
    )
    assert not stale_stage.exists() and not stale_receipt.exists()
    assert not candidate.exists() and not runtime_stage.exists()
    assert current_stage.is_dir() and current_receipt.is_file()
    assert (trap / "sentinel").read_text(encoding="utf-8") == "untouched"
    module.cleanup_release_attempt(
        current_receipt,
        release=release,
        helper_sha256=helper_sha,
        archive_sha256=archive_sha,
        include_pre_marker_orphans=True,
    )
    assert not current_stage.exists() and not current_receipt.exists()

    # receipt 已 O_EXCL 创建、但内容尚未写完且 stage 尚未 mkdir 的崩溃点可收敛。
    incomplete = module.ATTEMPT_ROOT / f"{release}.BROKEN01.json"
    incomplete.write_bytes(b'{"schema":')
    incomplete.chmod(0o600)
    current_stage, current_receipt = make_attempt("CURRENT4")
    module.prepare_exact_release_retry(
        release, current_receipt, current_stage, helper_sha, archive_sha
    )
    assert not incomplete.exists()
    module.cleanup_release_attempt(
        current_receipt,
        release=release,
        helper_sha256=helper_sha,
        archive_sha256=archive_sha,
        include_pre_marker_orphans=True,
    )

    # 可完整解析但摘要属于另一候选的 receipt 不是“部分写入”，必须拒绝复用 ID。
    stale_stage, stale_receipt = make_attempt("WRONGID1")
    for child in stale_stage.iterdir(): child.unlink()
    stale_stage.rmdir()
    wrong = json.loads(stale_receipt.read_text(encoding="utf-8"))
    wrong["archiveSha256"] = "c" * 64
    stale_receipt.write_text(json.dumps(wrong, indent=2), encoding="utf-8")
    stale_receipt.chmod(0o600)
    current_stage, current_receipt = make_attempt("CURRENT7")
    try:
        module.prepare_exact_release_retry(
            release, current_receipt, current_stage, helper_sha, archive_sha
        )
    except RuntimeError as error:
        assert "完整 attempt receipt" in str(error)
    else:
        raise AssertionError("complete receipt with different payload identity was removed")
    assert stale_receipt.is_file() and current_receipt.is_file()
    wrong["archiveSha256"] = archive_sha
    stale_receipt.write_text(json.dumps(wrong, indent=2), encoding="utf-8")
    stale_receipt.chmod(0o600)
    module.prepare_exact_release_retry(
        release, current_receipt, current_stage, helper_sha, archive_sha
    )
    module.cleanup_release_attempt(
        current_receipt,
        release=release,
        helper_sha256=helper_sha,
        archive_sha256=archive_sha,
        include_pre_marker_orphans=True,
    )

    # bootstrap 在 install/mv 前后被 SIGKILL：空 stage 或固定 tmp 子集仍可凭 receipt 收敛。
    stale_stage, stale_receipt = make_attempt("PARTIAL1")
    (stale_stage / "deploy-production.py").rename(stale_stage / "deploy-production.py.tmp")
    (stale_stage / "deploy-production.py.tmp").chmod(0o600)
    (stale_stage / "deploy-production.py.tmp").write_bytes(b"partial")
    (stale_stage / "deploy-production.py.tmp").chmod(0o500)
    (stale_stage / f"{release}.tar.gz").unlink()
    current_stage, current_receipt = make_attempt("CURRENT5")
    module.prepare_exact_release_retry(
        release, current_receipt, current_stage, helper_sha, archive_sha
    )
    assert not stale_stage.exists() and not stale_receipt.exists()
    module.cleanup_release_attempt(
        current_receipt,
        release=release,
        helper_sha256=helper_sha,
        archive_sha256=archive_sha,
        include_pre_marker_orphans=True,
    )

    stale_stage, stale_receipt = make_attempt("EMPTYST1")
    for child in stale_stage.iterdir(): child.unlink()
    current_stage, current_receipt = make_attempt("CURRENT6")
    module.prepare_exact_release_retry(
        release, current_receipt, current_stage, helper_sha, archive_sha
    )
    assert not stale_stage.exists() and not stale_receipt.exists()
    module.cleanup_release_attempt(
        current_receipt,
        release=release,
        helper_sha256=helper_sha,
        archive_sha256=archive_sha,
        include_pre_marker_orphans=True,
    )

    # active marker 的优先级同样高于 orphan receipt，所有 sentinel 保持原样。
    stale_stage, stale_receipt = make_attempt("STALE003")
    current_stage, current_receipt = make_attempt("CURRENT3")
    candidate.mkdir(); candidate_sentinel = candidate / "sentinel"; candidate_sentinel.write_text("active-keep", encoding="utf-8")
    runtime_stage.mkdir(); runtime_sentinel = runtime_stage / "sentinel"; runtime_sentinel.write_text("active-stage-keep", encoding="utf-8")
    module.ACTIVE_TRANSACTION.write_text("{}", encoding="utf-8")
    try:
        module.prepare_exact_release_retry(
            release, current_receipt, current_stage, helper_sha, archive_sha
        )
    except RuntimeError as error:
        assert "未完成事务" in str(error)
    else:
        raise AssertionError("active transaction allowed orphan cleanup")
    assert candidate_sentinel.read_text(encoding="utf-8") == "active-keep"
    assert runtime_sentinel.read_text(encoding="utf-8") == "active-stage-keep"
    assert stale_stage.is_dir() and stale_receipt.is_file()
    module.ACTIVE_TRANSACTION.unlink()
    module.prepare_exact_release_retry(
        release, current_receipt, current_stage, helper_sha, archive_sha
    )
    module.cleanup_release_attempt(
        current_receipt,
        release=release,
        helper_sha256=helper_sha,
        archive_sha256=archive_sha,
        include_pre_marker_orphans=True,
    )

    # root incoming 出现额外项时必须先失败，candidate 不得部分删除。
    stale_stage, stale_receipt = make_attempt("STALE002")
    current_stage, current_receipt = make_attempt("CURRENT2")
    (stale_stage / "unexpected").write_bytes(b"tamper")
    candidate.mkdir(); sentinel = candidate / "sentinel"; sentinel.write_text("keep", encoding="utf-8")
    try:
        module.prepare_exact_release_retry(
            release, current_receipt, current_stage, helper_sha, archive_sha
        )
    except RuntimeError as error:
        assert "文件集合不精确" in str(error)
    else:
        raise AssertionError("tampered root incoming was cleaned")
    assert sentinel.read_text(encoding="utf-8") == "keep"
    assert stale_receipt.is_file() and (stale_stage / "unexpected").is_file()
`
  const result = spawnSync('python3', ['-c', probe, scriptPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('R51 ubuntu upload receipt 可收敛部分上传并拒绝额外项且不跨 release', () => {
  const probe = String.raw`
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import sys

spec = importlib.util.spec_from_file_location("r51_deploy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
release = "review-r51-recovery-userupload1"
helper_sha = "a" * 64
archive_sha = "b" * 64
with tempfile.TemporaryDirectory(prefix="r51-user-upload-") as temporary:
    root = Path(temporary) / "release-candidates"
    helper = module.USER_UPLOAD_STAGE_HELPER.replace(
        '/home/ubuntu/release-candidates', str(root)
    )
    def run(action, check=True):
        result = subprocess.run(
            [sys.executable, "-c", helper, action, str(root), release, helper_sha, archive_sha],
            text=True, capture_output=True,
        )
        if check and result.returncode != 0:
            raise AssertionError(result.stderr or result.stdout)
        return result
    run("prepare")
    stage = root / f".incoming-{release}"
    (stage / "deploy-production.py").write_bytes(b"partial-scp")
    trap = root / f".incoming-{release}-similar"
    trap.mkdir(); (trap / "sentinel").write_text("untouched", encoding="utf-8")
    run("prepare")
    assert stage.is_dir() and {item.name for item in stage.iterdir()} == {".attempt"}
    assert (trap / "sentinel").read_text(encoding="utf-8") == "untouched"
    (stage / "unexpected").write_text("tamper", encoding="utf-8")
    failed = run("cleanup", check=False)
    assert failed.returncode != 0
    assert (stage / "unexpected").is_file() and (stage / ".attempt").is_file()
    (stage / "unexpected").unlink()
    run("cleanup")
    assert not stage.exists()
`
  const result = spawnSync('python3', ['-c', probe, scriptPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('R51 data 权限精确回滚且遗留 key 仅做不可逆退休', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')
  assert.match(source, /MAX_DATA_TREE_FILES/)
  assert.match(source, /def scan_data_permission_tree/)
  assert.match(source, /def open_data_root_fd/)
  assert.match(source, /def open_data_record_fd/)
  assert.match(source, /os\.stat\(name, dir_fd=descriptor, follow_symlinks=False\)[\s\S]*?O_NONBLOCK/)
  assert.match(source, /data 树不得包含 symlink/)
  assert.match(source, /persist_data_permission_baseline/)
  assert.match(source, /assert_review_api_stopped\(\)[\s\S]*?persist_data_permission_baseline/)
  assert.match(source, /"mtimeNs":\s*info\.st_mtime_ns/)
  assert.match(source, /store\.json rolePermissions 角色集合或类型不匹配/)
  assert.match(source, /harden_data_permissions/)
  assert.match(source, /0o700[\s\S]*?0o600/)
  assert.match(source, /restore_data_permissions/)
  assert.match(source, /verify_data_permissions_restored/)
  assert.match(source, /require_inode=True/)
  assert.match(source, /"type", "device", "inode", "mtimeNs", "size", "sha256"/)
  assert.match(source, /def set_data_record_permissions[\s\S]*?os\.fchown\(descriptor, uid, gid\)[\s\S]*?os\.fchmod\(descriptor, mode\)/)
  assert.match(source, /all_targets\s*=\s*\[\*targets, API_ENV, HERMES_ENV, MAINTENANCE_GATE\]/)
  assert.doesNotMatch(source, /all_targets\s*=\s*\[[^\]]*LEGACY_AI_SECRET/)
  assert.match(source, /def backup_targets[\s\S]*?遗留供应商密钥不得进入备份、基线或回滚目标/)
  assert.match(source, /def assert_legacy_ai_secret_retirement_source[\s\S]*?O_NOFOLLOW[\s\S]*?st_nlink != 1[\s\S]*?allowed_owners = \{\(0, 0\), \(ubuntu\.pw_uid, ubuntu\.pw_gid\)\}[\s\S]*?os\.listxattr/)
  assert.match(source, /assert_legacy_ai_secret_retirement_source\(LEGACY_AI_SECRET\)[\s\S]*?durable_unlink\(LEGACY_AI_SECRET\)/)
  assert.match(source, /遗留供应商密钥仍存在原路径/)
  assert.match(source, /def assert_sso_security_floor[\s\S]*?read_sso_secret\(SSO_SECRET\)/)
  assert.match(source, /def read_sso_secret[\s\S]*?expected_uid=ubuntu_uid[\s\S]*?info\.st_gid != ubuntu_gid[\s\S]*?0o600[\s\S]*?os\.listxattr\(handle\.fileno\(\)\)/)
  assert.match(source, /def assert_forward_only_security_floor[\s\S]*?assert_sso_security_floor\(\)/)
  const runtimeEnv = source.slice(source.indexOf('def prepare_runtime_env'), source.indexOf('def candidate_nginx_test'))
  assert.match(runtimeEnv, /"AI_REVIEW_AGENT_CONFIGURED": "false"/)
  assert.match(runtimeEnv, /"HERMES_AGENT_ENABLED": "false"/)
  assert.match(runtimeEnv, /if "REVIEW_SSO_SECRET" in api_current:[\s\S]*?拒绝复制入候选\/备份/)
  assert.match(runtimeEnv, /api_values\["REVIEW_SSO_SECRET_FILE"\] = str\(SSO_SECRET\)/)
  assert.doesNotMatch(runtimeEnv, /(?:api_current|hermes_current)\.get\("DEEPSEEK_API_KEY"/)
  assert.doesNotMatch(runtimeEnv, /"DEEPSEEK_API_KEY"\s*:/)
  assert.match(source, /def assert_initial_ai_inference_disabled[\s\S]*?submissionMode["']\) != "draft-only"[\s\S]*?\/v1\/chat\/completions[\s\S]*?error\.code != 503/)
  assert.match(source, /write_environment_candidate\(hermes_candidate, hermes_values\)/)
  assert.doesNotMatch(source, /journal[^\n]*(?:DEEPSEEK_API_KEY|deepseek_key)/i)
  assert.doesNotMatch(source, /baseline[^\n]*(?:DEEPSEEK_API_KEY|deepseek_key)/i)
  assert.doesNotMatch(source, /permission_only\s*=\s*\[path for path in \(SSO_SECRET/)
})

test('R51 遗留供应商 key 只做无内容身份校验且永不进入事务备份', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')
  const identityCheck = source.slice(
    source.indexOf('def assert_legacy_ai_secret_retirement_source'),
    source.indexOf('def read_json_secure')
  )
  const backupFlow = source.slice(
    source.indexOf('def backup_targets'),
    source.indexOf('def write_transaction_journal')
  )
  assert.doesNotMatch(identityCheck, /sha256|\.read\s*\(/)
  assert.doesNotMatch(backupFlow, /(?:file_metadata|sha256|secure_open_regular)\(LEGACY_AI_SECRET/)
  assert.match(backupFlow, /LEGACY_AI_SECRET in normalized_targets[\s\S]*?LEGACY_AI_SECRET in normalized_permission_only/)

  const probe = String.raw`
import hashlib
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import sys

spec = importlib.util.spec_from_file_location("r51_deploy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

canary = b"R51-LEGACY-VENDOR-KEY-CANARY-DO-NOT-PERSIST"
digest = hashlib.sha256(canary).hexdigest().encode("ascii")
with tempfile.TemporaryDirectory(prefix="r51-legacy-secret-") as temporary:
    root = Path(temporary)
    secret = root / ".deepseek_key"
    secret.write_bytes(canary)
    secret.chmod(0o644)
    module.LEGACY_AI_SECRET = secret
    module.pwd.getpwnam = lambda _name: SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
    module.os.listxattr = lambda _descriptor: []
    module.sha256 = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("secret was hashed"))
    module.sha256_handle = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("secret was hashed"))
    module.secure_sha256 = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("secret was hashed"))

    assert module.assert_legacy_ai_secret_retirement_source(secret) is True

    # UID/GID 必须作为精确二元组命中，拒绝 root:ubuntu 与 ubuntu:root 混配。
    original_fstat = module.os.fstat
    stable_descriptor = os.open(secret, os.O_RDONLY)
    try:
        stable_info = original_fstat(stable_descriptor)
    finally:
        os.close(stable_descriptor)
    class MixedOwner:
        def __init__(self, source, uid, gid):
            for name in ("st_mode", "st_nlink", "st_dev", "st_ino", "st_size"):
                setattr(self, name, getattr(source, name))
            self.st_uid = uid
            self.st_gid = gid
    module.pwd.getpwnam = lambda _name: SimpleNamespace(pw_uid=1001, pw_gid=1002)
    for uid, gid in ((0, 1002), (1001, 0)):
        module.os.fstat = lambda _descriptor, uid=uid, gid=gid: MixedOwner(stable_info, uid, gid)
        try:
            module.assert_legacy_ai_secret_retirement_source(secret)
        except RuntimeError as error:
            assert "所有者不在精确白名单" in str(error)
        else:
            raise AssertionError("mixed legacy secret owner was accepted")
    module.os.fstat = original_fstat

    # backup_targets 的排除门必须早于监听、目录、复制等任何副作用。
    module.modern_binding_snapshot = lambda: (_ for _ in ()).throw(AssertionError("backup guard ran too late"))
    for targets, permission_only in (([secret], []), ([], [secret])):
        try:
            module.backup_targets(Path("/invalid"), {}, {}, "review-r51-recovery-canary", targets, {}, permission_only)
        except RuntimeError as error:
            assert "不得进入备份" in str(error)
        else:
            raise AssertionError("legacy secret entered backup targets")

    # 模拟事务文档/计划的允许信息：可记录退休路径，绝不记录 key 原文或摘要。
    backup = root / "backup"
    backup.mkdir()
    artifacts = {
        "baseline.json": {"targets": {}, "permissionOnly": {}},
        "journal.json": {"phase": "backup-durable"},
        "plan.json": {"forwardOnlyRuntimeTargets": [str(secret)]},
        "candidate.env": {"HERMES_AGENT_ENABLED": "false"},
        "unit.json": {"legacy": "masked"},
        "code.json": {"legacy": "retirement-stub"},
        "log.json": {"event": "legacy-secret-retired"},
    }
    for name, payload in artifacts.items():
        (backup / name).write_text(json.dumps(payload), encoding="utf-8")

    module.durable_unlink(secret)
    assert not secret.exists()
    assert module.assert_legacy_ai_secret_retirement_source(secret) is False
    module.durable_unlink(secret)
    for item in backup.rglob("*"):
        if item.is_file():
            payload = item.read_bytes()
            assert canary not in payload
            assert digest not in payload
`
  const result = spawnSync('python3', ['-c', probe, scriptPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('R51 候选首次启动与三代 recovery data 都使用显式持久 provenance', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')
  const resolver = source.slice(
    source.indexOf('def resolve_security_floor_data_snapshot'),
    source.indexOf('def complete_forward_only_security_floor')
  )
  const floor = source.slice(
    source.indexOf('def complete_forward_only_security_floor'),
    source.indexOf('def verify_rollback')
  )

  for (const mode of [
    'initialize-pre-migration',
    'pre-migration',
    'deployed',
    'rollback-known',
    'rollback-restored',
    'current-committed'
  ]) assert.match(resolver + floor, new RegExp(`"${mode}"`))

  const stop = floor.indexOf('stop_review_services_for_security_floor(baseline)')
  const resolve = floor.indexOf('resolve_security_floor_data_snapshot(', stop)
  const pending = floor.indexOf('journal["securityFloorPhase"] = "pre-migration-data-baseline-pending"')
  const pendingDurable = floor.indexOf('write_transaction_journal(backup, journal)', pending)
  assert.ok(pending >= 0 && pendingDurable > pending && stop > pendingDurable,
    '首次 data baseline pending provenance 必须先持久化，再停止旧服务')
  assert.ok(resolve > stop, '首次 data baseline 只能在旧 API 停止后钉住')
  const recovery = source.slice(source.indexOf('def recover_interrupted_transaction'), source.indexOf('def acquire_release_lock'))
  assert.match(recovery, /recoverable_initial_phases = \{[\s\S]*?"pre-migration-data-baseline-pending"/)
  assert.match(recovery, /complete_forward_only_security_floor\([\s\S]*?data_snapshot_mode="initialize-pre-migration"[\s\S]*?errors = rollback\(/)
  const schema = floor.indexOf('validate_store_transaction_baseline(startup_data_records)', resolve)
  const apiStart = floor.indexOf('command(["systemctl", "restart", "first-service-review-api.service"])', schema)
  const postStartCompare = floor.indexOf('assert_data_tree_snapshot_unchanged(startup_data_records)', apiStart)
  assert.ok(stop >= 0 && resolve > stop, '旧 API stop 后、候选首次启动前才可解析/固化完整 data 基线')
  assert.ok(schema > resolve && apiStart > schema, 'schema/data 基线必须早于候选首次启动')
  assert.ok(postStartCompare > apiStart, '候选首次启动后必须再次逐字段比较同一权威基线')

  assert.match(resolver, /if baseline\.get\("dataPermissions"\):[\s\S]*?records = baseline\["dataPermissions"\][\s\S]*?assert_data_tree_snapshot_unchanged\(records\)/)
  assert.doesNotMatch(resolver, /if baseline\.get\("dataPermissions"\):[\s\S]{0,180}?records = scan_data_permission_tree\(\)/)
  assert.match(source, /baseline\["rollbackDataPermissions"\] = rollback_data_records[\s\S]*?durable_json\(backup \/ "baseline\.json", baseline\)[\s\S]*?"dataRollbackComplete": True/)
  assert.match(source, /nginx_key="rollbackSafeNginx",[\s\S]*?data_snapshot_mode="current-committed" if post_ungate else "rollback-restored"/)
  assert.match(source, /nginx_key="rollbackSafeNginx",[\s\S]*?data_snapshot_mode="rollback-known"/)
  assert.match(source, /assert_local_review_maintenance\(True\)[\s\S]*?stop_review_api_cleanly\(\)[\s\S]*?current_committed_data_snapshot\(\)[\s\S]*?"current-data-snapshot-pinned-api-stopped"[\s\S]*?data_snapshot_mode=\("deployed" if safe_precommit else "current-committed"\)/)
  assert.match(source, /explicit_data_records=current_data_records/)
  assert.match(source, /def rollback_post_reopen_required[\s\S]*?state in POST_REOPEN_RECOVERY_STATES[\s\S]*?journal\.get\("phase"\) == "ungate-committed"[\s\S]*?or not gate_active/)
  assert.match(source, /rollback_post_reopen_required\([\s\S]*?gate_active=maintenance_gate_active\(\)[\s\S]*?"postReopenRecoveryState": "detected"[\s\S]*?durable_write\(MAINTENANCE_GATE[\s\S]*?"postReopenRecoveryState": "gate-active"[\s\S]*?stop_review_api_cleanly\(\)[\s\S]*?"postReopenRecoveryState": "api-stopped"[\s\S]*?current_committed_data_snapshot\(\)[\s\S]*?"postReopenRecoveryState": "current-data-pinned"[\s\S]*?data_snapshot_mode="current-committed" if post_ungate else "rollback-restored"/)
})

test('R51 rollback post-reopen 二次崩溃永久保留当前数据代 provenance', () => {
  const probe = String.raw`
import importlib.util
from pathlib import Path
import tempfile
import sys

spec = importlib.util.spec_from_file_location("r51_deploy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

states = [
    "detected",
    "gate-active",
    "api-stopped",
    "current-data-pinned",
    "floor-live-gated",
    "ungate-committed",
]
for state in states:
    journal = {
        "status": "recovering-rollback-postreopen",
        "phase": "secondary-crash",
        "postReopenRecoveryState": state,
    }
    assert module.rollback_post_reopen_required(journal, gate_active=True) is True

assert module.rollback_post_reopen_required(
    {"status": "rollback-reopening", "phase": "ungate-committed", "postReopenRecoveryState": "not-required"},
    gate_active=True,
) is True
assert module.rollback_post_reopen_required(
    {"status": "rollback-reopening", "phase": "baseline-restored-api-stopped", "postReopenRecoveryState": "not-required"},
    gate_active=True,
) is False
assert module.rollback_post_reopen_required(
    {"status": "rollback-reopening", "phase": "baseline-restored-api-stopped", "postReopenRecoveryState": "not-required"},
    gate_active=False,
) is True

try:
    module.rollback_post_reopen_required(
        {"status": "recovering-rollback-postreopen", "postReopenRecoveryState": "corrupt"},
        gate_active=True,
    )
except RuntimeError:
    pass
else:
    raise AssertionError("corrupt post-reopen provenance must fail closed")

# factoryStoreRollbackState 在终态仍保留用于审计。ungate 后若已有正常
# 业务写，恢复入口必须先走 dataRollbackComplete/post-reopen，绝不能
# 再调用首迁 source hash helper。
with tempfile.TemporaryDirectory(prefix="r51-postreopen-") as temporary:
    root = Path(temporary)
    backup_root = root / "backups"
    backup_root.mkdir()
    backup = backup_root / "pre-review-r51-recovery-fixture2-20260813-071500"
    backup.mkdir()
    active = root / "active-transaction.json"
    active.write_text("{}", encoding="utf-8")
    release = "review-r51-recovery-fixture2"
    marker = {"release": release, "backup": str(backup), "mutationStarted": True}
    baseline = {"release": release, "dataPermissions": [{"path": "store.json"}]}
    journal = {
        "release": release,
        "status": "rollback-reopening",
        "phase": "ungate-committed",
        "dataRollbackComplete": True,
        "factoryStoreRollbackState": "authority-removed",
        "postReopenRecoveryState": "ungate-committed",
    }
    module.ACTIVE_TRANSACTION = active
    module.BACKUP_ROOT = backup_root
    module.read_json_secure = lambda path, **_kwargs: (
        marker if path == active else
        baseline if path == backup / "baseline.json" else
        journal
    )
    module.validate_backup_transaction_dir = lambda *_args, **_kwargs: None
    module.validate_security_floor_backup = lambda *_args, **_kwargs: None
    module.recover_factory_store_rollback_provenance = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("post-reopen must not validate old factory store hash")
    )
    calls = []
    module.finish_rollback_reopening = lambda *_args, **_kwargs: calls.append("finish-current-generation")
    module.clear_active_transaction = lambda: calls.append("clear")
    module.recover_interrupted_transaction()
    assert calls == ["finish-current-generation", "clear"]
`
  const result = spawnSync('python3', ['-c', probe, scriptPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('R51 持久维护门闩在候选 Nginx 生效后冻结写入并覆盖 commit 崩溃窗口', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')
  const nginx = fs.readFileSync(path.join(root, 'deploy/r51-review-recovery/review-system.conf'), 'utf8')

  assert.match(source, /MAINTENANCE_GATE_ROOT\s*=\s*Path\("\/var\/lib\/first-service-review-gate"\)/)
  assert.match(source, /install -d -o root -g root -m 0711 \/var\/lib\/first-service-review-gate/)
  assert.match(source, /validate_secure_root\(MAINTENANCE_GATE_ROOT, exact_mode=0o711\)/)
  assert.match(nginx, /location = \/review-api\/health/)
  assert.match(nginx, /if \(-f \/var\/lib\/first-service-review-gate\/maintenance\) \{ return 503; \}/)
  assert.match(source, /securityFloorState["']:\s*["']security-floor-promoting/)
  assert.match(source, /write_transaction_journal\(backup, journal\)[\s\S]*?durable_write\(MAINTENANCE_GATE[\s\S]*?install_security_floor_nginx/)
  assert.match(source, /def complete_forward_only_security_floor[\s\S]*?stop_review_services_for_security_floor/)
  assert.match(source, /\("commit-ready", "postflight-verified-gated"\)/)
  assert.match(source, /\("deployed", "postflight-verified-ungated"\)/)
  assert.match(source, /if not gate_was_active:[\s\S]*?current_committed_data_snapshot/)
  assert.match(source, /status": "recovering-postcommit"[\s\S]*?write_transaction_journal\(backup, journal\)[\s\S]*?durable_write\(MAINTENANCE_GATE/)
  assert.match(source, /\("recovering-postcommit", "recreate-maintenance-gate"\)/)
  assert.match(source, /\("recovering-postcommit", "postcommit-gate-restored"\)/)
  assert.match(source, /for raw_target, record in reversed[\s\S]*?if target == MAINTENANCE_GATE or target in floor_targets:[\s\S]*?continue/)
  assert.match(source, /def persist_security_floor_manual[\s\S]*?stop_all_review_services_fail_closed/)
  assert.match(source, /dataRollbackComplete/)
  assert.match(source, /phase["']:\s*["']ungate-committed/)
  assert.match(source, /def finish_rollback_reopening[\s\S]*?restore_file_from_backup\(backup, MAINTENANCE_GATE/)
  assert.match(source, /def remote_preflight[\s\S]*?validate_modern_binding_baseline\(modern_binding_snapshot\(\)\)[\s\S]*?assert_modern_listener_ownership\(service_states\)/)
  assert.match(source, /def verify_baseline_unchanged[\s\S]*?modernBindings/)
  assert.match(source, /def verify_rollback[\s\S]*?assert_forward_only_security_floor[\s\S]*?def verify_installed_release_targets/)
})

test('R51 工厂数据首迁精确隔离，后续发布只接受权威 receipt', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')

  assert.match(source, /FACTORY_STORE_EXPECTED_SHA256\s*=\s*"97c48992a0073900938f2cc006b104ad32ac1a6b9dbb558fd8590da8bc350e4b"/)
  for (const [field, count] of Object.entries({
    users: 4,
    proposals: 3,
    logs: 971,
    rules: 4,
    knowledgeEntries: 16,
    botProfiles: 8
  })) {
    assert.match(source, new RegExp(`"${field}":\\s*${count}`))
  }
  assert.match(source, /P17802394601045efec7/)
  assert.match(source, /P17802394601087df9c0/)
  assert.match(source, /REAL_PROPOSAL_ID\s*=\s*"P1780283430572986873"/)
  assert.match(source, /REAL_ATTACHMENT_ID\s*=\s*"F1780283430170fe2a186c"/)
  assert.match(source, /REAL_ATTACHMENT_STORED_NAME\s*=\s*"F1780283430170fe2a186c-九江满庭春物业费降价五个方案5月7日\.docx"/)
  assert.match(source, /REAL_ATTACHMENT_SIZE\s*=\s*3_136_315/)
  assert.match(source, /REAL_ATTACHMENT_SHA256\s*=\s*"dca329760d95a9963e18dd91c56df992ff18f4be0534947151058271857161e4"/)
  assert.match(source, /len\(protected_real_logs\) != 6/)
  assert.match(source, /first-service-review-factory-quarantine-v1/)
  assert.match(source, /durable_write\(quarantine_path, quarantine_bytes, 0o600\)/)
  assert.match(source, /durable_write\(quarantine_sha,/)
  assert.match(source, /def install_factory_store_migration/)
  assert.match(source, /def restore_factory_store_migration/)
  assert.match(source, /factory-store-migration-installed/)
  assert.match(source, /atomic_replace_review_store\(backup \/ migration\["original"\]/)
  assert.match(source, /FACTORY_MIGRATION_ROOT\s*=\s*STATE_ROOT \/ "factory-migration-v1"/)
  assert.match(source, /def factory_migration_authority/)
  assert.match(source, /def validate_already_applied_factory_store/)
  assert.match(source, /"mode": "already-applied"/)
  assert.match(source, /publish_factory_migration_authority\(backup, migration\)/)
  assert.match(source, /remove_factory_migration_authority\(migration\)/)
  assert.match(source, /"businessDataContentTouched": "first-exact-baseline-only"/)
  assert.match(source, /"businessDataMigration": "exact-first-migration-or-verified-already-applied"/)
  assert.match(source, /"businessDataMigrationModes": \["migrate", "already-applied"\]/)
  assert.match(source, /"businessDataRollbackPrepared": True/)
  assert.match(source, /"businessDataContentTouched": baseline\["factoryStoreMigration"\]\["mode"\] == "migrate"/)
  assert.match(source, /receipt_log\.get\("metadata"\) != receipt/)
  assert.match(source, /definitionVerifiedHash[\s\S]*?profile_definition_hash_for_migration/)
})

test('R51 后续发布接受精确 legacy mask 且不把 symlink 当普通备份目标', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')
  assert.match(source, /def validate_legacy_unit_generation[\s\S]*?"type": "mask"[\s\S]*?"target": "\/dev\/null"[\s\S]*?"masked-runtime"/)
  assert.match(source, /def legacy_unit_path_record[\s\S]*?os\.readlink\(path\) != "\/dev\/null"/)
  assert.match(source, /"legacyUnitPaths": legacy_unit_baseline_snapshot\(\)/)
  assert.match(source, /legacy_unit_baseline_snapshot\(\) != baseline\.get\("legacyUnitPaths"\)/)
  assert.match(source, /legacy_unit_targets = set\(LEGACY_UNIT_PATHS\.values\(\)\)[\s\S]*?Path\(entry\["target"\]\) not in legacy_unit_targets/)
})

test('R51 factory rollback 三态 authority、新 inode 与首次 data baseline 崩溃均可验证恢复', () => {
  const probe = String.raw`
import copy
import importlib.util
from pathlib import Path
import tempfile
import sys

spec = importlib.util.spec_from_file_location("r51_deploy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

source_sha = "a" * 64
migrated_sha = "b" * 64
quarantine_sha = "c" * 64
receipt = {"schema": "fixture-receipt"}
migration = {
    "mode": "migrate",
    "sourceSha256": source_sha,
    "migratedSha256": migrated_sha,
    "quarantineSha256": quarantine_sha,
    "receipt": receipt,
}
original = [{
    "path": "store.json", "type": "file", "device": 1, "inode": 10,
    "mtimeNs": 100, "size": 10, "sha256": source_sha,
    "mode": 0o640, "uid": 1000, "gid": 1001,
}]
current = [{
    "path": "store.json", "type": "file", "device": 1, "inode": 20,
    "mtimeNs": 200, "size": 10, "sha256": source_sha,
    "mode": 0o600, "uid": 1000, "gid": 1001,
}]

with tempfile.TemporaryDirectory(prefix="r51-factory-crash-") as temporary:
    root = Path(temporary)
    module.FACTORY_MIGRATION_RECEIPT = root / "receipt.json"
    module.FACTORY_MIGRATION_QUARANTINE = root / "quarantine.json"
    module.read_json_secure = lambda path, **_kwargs: receipt
    module.secure_sha256 = lambda path, **_kwargs: quarantine_sha
    module.scan_data_permission_tree = lambda: copy.deepcopy(current)
    module.durable_json = lambda *_args, **_kwargs: None
    module.fsync_directory = lambda *_args, **_kwargs: None
    module.write_transaction_journal = lambda *_args, **_kwargs: None

    presence_states = (
        (False, False),
        (False, True),
        (True, True),
    )
    for receipt_present, quarantine_present in presence_states:
        module.FACTORY_MIGRATION_RECEIPT.unlink(missing_ok=True)
        module.FACTORY_MIGRATION_QUARANTINE.unlink(missing_ok=True)
        if quarantine_present:
            module.FACTORY_MIGRATION_QUARANTINE.write_bytes(b"quarantine")
        if receipt_present:
            module.FACTORY_MIGRATION_RECEIPT.write_text("{}", encoding="utf-8")
        authority_before = module.factory_rollback_authority_state(migration, allow_partial=True)
        assert authority_before["receiptPresent"] is receipt_present
        assert authority_before["quarantinePresent"] is quarantine_present

        baseline = {
            "factoryStoreMigration": copy.deepcopy(migration),
            "dataPermissions": copy.deepcopy(original),
        }
        journal = {
            "factoryStoreRollbackState": "replace-intent",
            "factoryStoreRollbackIntent": {
                "sourceSha256": source_sha,
                "migratedSha256": migrated_sha,
                "quarantineSha256": quarantine_sha,
            },
            "factoryStoreRollbackAuthorityBefore": copy.deepcopy(authority_before),
        }
        module.recover_factory_store_rollback_provenance(root, baseline, journal)
        assert journal["factoryStoreRollbackState"] == "store-restored-pinned"
        assert baseline["rollbackDataPermissions"][0]["inode"] == 20

        # provenance 已持久后再次崩溃，应幂等接受同一代；任一 stable
        # metadata 漂移则必须失败关闭，不能重新吸收。
        module.recover_factory_store_rollback_provenance(root, baseline, journal)
        current[0]["inode"] = 21
        try:
            module.recover_factory_store_rollback_provenance(root, baseline, journal)
        except RuntimeError:
            pass
        else:
            raise AssertionError("persisted rollback inode drift was accepted")
        current[0]["inode"] = 20

    # replace-intent 尚未钉 store 代时，authority presence 也属于 intent；
    # 在两者之间漂移必须拒绝，不能用宽松 exists 判断。
    module.FACTORY_MIGRATION_QUARANTINE.write_bytes(b"quarantine")
    module.FACTORY_MIGRATION_RECEIPT.write_text("{}", encoding="utf-8")
    before = module.factory_rollback_authority_state(migration, allow_partial=True)
    module.FACTORY_MIGRATION_RECEIPT.unlink()
    baseline = {"factoryStoreMigration": migration, "dataPermissions": original}
    journal = {
        "factoryStoreRollbackState": "replace-intent",
        "factoryStoreRollbackIntent": {
            "sourceSha256": source_sha,
            "migratedSha256": migrated_sha,
            "quarantineSha256": quarantine_sha,
        },
        "factoryStoreRollbackAuthorityBefore": before,
    }
    try:
        module.recover_factory_store_rollback_provenance(root, baseline, journal)
    except RuntimeError:
        pass
    else:
        raise AssertionError("authority presence drift after replace intent was accepted")

    # 真实调用 recovery dispatcher：服务已停但首个 data baseline 尚未
    # durable 的精确 phase，只能继续 initialize 路径后进入 rollback。
    release = "review-r51-recovery-fixture1"
    backup_root = root / "backups"
    backup_root.mkdir()
    backup = backup_root / "pre-review-r51-recovery-fixture1-20260813-070000"
    backup.mkdir()
    active = root / "active-transaction.json"
    active.write_text("{}", encoding="utf-8")
    marker = {"release": release, "backup": str(backup), "mutationStarted": True}
    recovery_baseline = {"release": release}
    recovery_journal = {
        "release": release,
        "status": "deploying",
        "phase": "security-floor-promoting",
        "securityFloorState": "security-floor-promoting",
        "securityFloorPhase": "pre-migration-data-baseline-pending",
        "securityFloorNginx": "candidateNginx",
    }
    module.ACTIVE_TRANSACTION = active
    module.BACKUP_ROOT = backup_root
    module.read_json_secure = lambda path, **_kwargs: (
        marker if path == active else
        recovery_baseline if path == backup / "baseline.json" else
        recovery_journal
    )
    module.validate_backup_transaction_dir = lambda *_args, **_kwargs: None
    module.validate_security_floor_backup = lambda *_args, **_kwargs: None
    module.recover_factory_store_rollback_provenance = lambda *_args, **_kwargs: None
    calls = []
    def complete(_backup, baseline, _journal, **kwargs):
        calls.append(("complete", kwargs["data_snapshot_mode"]))
        baseline["dataPermissions"] = copy.deepcopy(original)
    module.complete_forward_only_security_floor = complete
    module.rollback = lambda *_args, **_kwargs: calls.append(("rollback", "known")) or []
    module.clear_active_transaction = lambda: calls.append(("clear", "done"))
    module.recover_interrupted_transaction()
    assert calls == [
        ("complete", "initialize-pre-migration"),
        ("rollback", "known"),
        ("clear", "done"),
    ]
`
  const result = spawnSync('python3', ['-c', probe, scriptPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('R51 二次 release fixture 保留正常业务 store 且跳过工厂内容替换', () => {
  const probe = String.raw`
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("r51_deploy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

module.validate_legacy_unit_generation(
    "review-server.service",
    {"LoadState": "loaded", "ActiveState": "active", "UnitFileState": "enabled"},
    {"type": "regular"},
)
module.validate_legacy_unit_generation(
    "review-server.service",
    {"LoadState": "masked", "ActiveState": "inactive", "UnitFileState": "masked"},
    {"type": "mask", "uid": 0, "gid": 0, "nlink": 1, "target": "/dev/null"},
)
try:
    module.validate_legacy_unit_generation(
        "review-server.service",
        {"LoadState": "masked", "ActiveState": "inactive", "UnitFileState": "masked"},
        {"type": "mask", "uid": 1000, "gid": 1000, "nlink": 1, "target": "/dev/null"},
    )
except RuntimeError:
    pass
else:
    raise AssertionError("non-root mask must fail closed")

profile_ids = [f"BP{i}" for i in range(8)]
created_at = "2026-08-13T06:00:00+0800"
protected = module.factory_protected_real_anchor()
factory_proposals = []
for proposal_id, expected in sorted(module.FACTORY_PROPOSALS.items()):
    factory_proposals.append({
        "id": proposal_id,
        "title": expected["title"],
        "type": expected["type"],
        "submitter": expected["submitter"],
        "submitterUsername": expected["submitterUsername"],
        "description": expected["description"],
        "createdAt": module.FACTORY_TIMESTAMP,
        "files": [
            {"name": name, "size": size, "type": media_type, "storedName": ""}
            for name, size, media_type in expected["files"]
        ],
    })
quarantine = {
    "schema": module.FACTORY_QUARANTINE_SCHEMA,
    "sourceStoreSha256": module.FACTORY_STORE_EXPECTED_SHA256,
    "createdAt": created_at,
    "factoryProposals": factory_proposals,
    "factoryProposalLogs": [{"id": "FL1"}, {"id": "FL2"}],
    "factoryInitializationLogs": [
        {"id": "L001", "actor": "系统", "action": "初始化审核机器人 Profile", "at": module.FACTORY_TIMESTAMP},
        {"id": "L002", "actor": "投资发展总监", "action": "完成市场拓展立项报告模板配置", "at": module.FACTORY_TIMESTAMP},
    ],
    "disabledRulesBefore": [
        {"id": item, "status": "启用", "updatedAt": module.FACTORY_TIMESTAMP, "basisVerifiedBy": "", "basisVerifiedAt": ""}
        for item in sorted(module.FACTORY_RULE_IDS)
    ],
    "disabledKnowledgeBefore": [
        {"id": item, "status": "启用", "updatedAt": module.FACTORY_TIMESTAMP, "sourceVerifiedBy": "", "sourceVerifiedAt": ""}
        for item in sorted(module.FACTORY_KNOWLEDGE_IDS)
    ],
    "disabledProfilesBefore": [
        {"id": item, "status": "启用", "definitionVerifiedBy": "", "definitionVerifiedAt": "", "definitionVerifiedHash": ""}
        for item in profile_ids
    ],
    "protectedRealProposal": {**protected, "linkedLogCount": 6},
}
quarantine_bytes = json.dumps(quarantine, ensure_ascii=False, indent=2).encode("utf-8")
quarantine_sha = hashlib.sha256(quarantine_bytes).hexdigest()
receipt = {
    "schema": module.FACTORY_MIGRATION_SCHEMA,
    "sourceStoreSha256": module.FACTORY_STORE_EXPECTED_SHA256,
    "quarantineSha256": quarantine_sha,
    "createdAt": created_at,
    "quarantinedProposalIds": sorted(module.FACTORY_PROPOSALS),
    "quarantinedProposalLogCount": 2,
    "quarantinedInitializationLogIds": ["L001", "L002"],
    "disabledRuleIds": sorted(module.FACTORY_RULE_IDS),
    "disabledKnowledgeIds": sorted(module.FACTORY_KNOWLEDGE_IDS),
    "disabledProfileIds": profile_ids,
    "protectedRealProposal": protected,
}
module.validate_factory_migration_receipt(receipt, quarantine, quarantine_sha)
tampered_quarantine = copy.deepcopy(quarantine)
tampered_quarantine["protectedRealProposal"]["attachmentId"] = "tampered"
tampered_bytes = json.dumps(tampered_quarantine, ensure_ascii=False, indent=2).encode("utf-8")
try:
    module.validate_factory_migration_receipt(
        {**receipt, "quarantineSha256": hashlib.sha256(tampered_bytes).hexdigest()},
        tampered_quarantine,
        hashlib.sha256(tampered_bytes).hexdigest(),
    )
except RuntimeError:
    pass
else:
    raise AssertionError("tampered real attachmentId must fail closed")
tampered_link_count = copy.deepcopy(quarantine)
tampered_link_count["protectedRealProposal"]["linkedLogCount"] = 5
tampered_link_bytes = json.dumps(tampered_link_count, ensure_ascii=False, indent=2).encode("utf-8")
try:
    module.validate_factory_migration_receipt(
        {**receipt, "quarantineSha256": hashlib.sha256(tampered_link_bytes).hexdigest()},
        tampered_link_count,
        hashlib.sha256(tampered_link_bytes).hexdigest(),
    )
except RuntimeError:
    pass
else:
    raise AssertionError("tampered linkedLogCount must fail closed")

real_file = {
    "id": module.REAL_ATTACHMENT_ID,
    "storedName": module.REAL_ATTACHMENT_STORED_NAME,
    "size": module.REAL_ATTACHMENT_SIZE,
}
receipt_log = {
    "id": module.FACTORY_MIGRATION_LOG_ID,
    "actor": "系统发布事务",
    "action": "隔离工厂示例并停用无来源规则、知识与 Profile",
    "category": "系统配置",
    "result": "成功",
    "at": created_at,
    "metadata": receipt,
}
store = {
    "proposals": [{"id": module.REAL_PROPOSAL_ID, "files": [real_file]}],
    "logs": [receipt_log, *[{"id": f"RL{i}", "proposalId": module.REAL_PROPOSAL_ID} for i in range(6)]],
    "rules": [{"id": "R001", "status": "停用", "basisVerifiedBy": "", "basisVerifiedAt": ""}],
    "knowledgeEntries": [{"id": "K001", "status": "停用", "source": "", "sourceVerifiedBy": "", "sourceVerifiedAt": ""}],
    "botProfiles": [{"id": "BP0", "status": "停用", "standards": []}],
}
records = [
    {"path": "store.json", "sha256": "a" * 64},
    {
        "path": f"files/{module.REAL_ATTACHMENT_STORED_NAME}",
        "type": "file",
        "size": module.REAL_ATTACHMENT_SIZE,
        "sha256": module.REAL_ATTACHMENT_SHA256,
    },
]
module.validate_already_applied_factory_store(store, records, receipt)

invalid = copy.deepcopy(store)
invalid["botProfiles"][0]["status"] = "启用"
try:
    module.validate_already_applied_factory_store(invalid, records, receipt)
except RuntimeError:
    pass
else:
    raise AssertionError("unverified active profile must fail closed")

module.read_store_from_data_records = lambda _records: (copy.deepcopy(store), b"{}", {"sha256": "a" * 64})
module.factory_migration_authority = lambda: (receipt, quarantine)
module.durable_json = lambda *_args, **_kwargs: None
module.fsync_directory = lambda *_args, **_kwargs: None
baseline = {}
fake_backup = Path("/tmp/r51-repeat-release-fixture")
migration = module.prepare_factory_store_migration(fake_backup, baseline, records)
assert migration["mode"] == "already-applied"
assert migration["sourceSha256"] == "a" * 64

module.scan_data_permission_tree = lambda: records
module.validate_store_transaction_baseline = lambda _records: None
module.write_transaction_journal = lambda *_args, **_kwargs: None
module.atomic_replace_review_store = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not replace store"))
journal = {}
installed = module.install_factory_store_migration(fake_backup, baseline, journal, records)
assert installed is records
assert baseline["factoryStoreMigration"]["status"] == "already-applied"
assert journal["phase"] == "factory-store-migration-already-applied"
`
  const result = spawnSync('python3', ['-c', probe, scriptPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
