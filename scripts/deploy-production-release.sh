#!/usr/bin/env bash
set -Eeuo pipefail

CANDIDATE="${1:-}"
FRONTEND_ROOT="${FRONTEND_ROOT:-/var/www/cockpit}"
BACKEND_ROOT="${BACKEND_ROOT:-/home/ubuntu/cockpit}"
BACKEND_USER="${BACKEND_USER:-ubuntu}"
BACKEND_GROUP="${BACKEND_GROUP:-ubuntu}"
NGINX_CONFIG="${NGINX_CONFIG:-/etc/nginx/conf.d/review-system.conf}"
SERVICE="${SERVICE:-first-service-cockpit.service}"
RUNTIME_OPERATIONS=(lvzai-login.py wecom-ledger-extractor.py qxm-evidence-extractor.py daily_reconciliation_probe.py daily_reconciliation_candidates.py rollback_r160_publication_mode.py probe-fine-report-daily-reconciliation.py publish-daily-reconciliation.mjs run-daily-reconciliation.sh recover_historical_gap.py scrape_and_import.py)
ROOT_OPERATIONS=(quarantine_demo_chain.py)
OPERATIONS=("${RUNTIME_OPERATIONS[@]}" "${ROOT_OPERATIONS[@]}")
SYSTEMD_UNITS=(first-service-cockpit.service cockpit-daily-reconciliation.service cockpit-daily-reconciliation.timer cockpit-daily-reconciliation-backfill.service)
COCKPIT_ENV_FILE="${COCKPIT_ENV_FILE:-/etc/first-service/cockpit.env}"
DAILY_RECONCILIATION_ENV_FILE="${DAILY_RECONCILIATION_ENV_FILE:-/etc/first-service/cockpit-daily-reconciliation.env}"
ALLOW_DAILY_RECONCILIATION_SECRET_ROTATION="${ALLOW_DAILY_RECONCILIATION_SECRET_ROTATION:-0}"
SQLITE_BIN="${SQLITE_BIN:-/usr/bin/sqlite3}"
COCKPIT_DB_PATH="${COCKPIT_DB_PATH:-$BACKEND_ROOT/cockpit.db}"
unset ALLOW_INACTIVE_SERVICE

[[ -n "$CANDIDATE" && -f "$CANDIDATE/manifest.json" ]] || { echo "用法：sudo $0 <候选目录>" >&2; exit 2; }
for operation in "${OPERATIONS[@]}"; do
  [[ -f "$CANDIDATE/backend/operations/$operation" ]] || { echo "候选缺少运维脚本：$operation" >&2; exit 2; }
done
for unit in "${SYSTEMD_UNITS[@]}"; do
  [[ -f "$CANDIDATE/backend/systemd/$unit" ]] || { echo "候选缺少systemd单元：$unit" >&2; exit 2; }
done
[[ -f "$CANDIDATE/deploy/operations-runtime-preflight.sh" && ! -L "$CANDIDATE/deploy/operations-runtime-preflight.sh" ]] \
  || { echo "候选缺少运维运行环境预检" >&2; exit 2; }
[[ "$(id -u)" == 0 ]] || { echo "必须使用 sudo 执行" >&2; exit 2; }
[[ -x "$SQLITE_BIN" ]] || { echo "缺少sqlite3: $SQLITE_BIN" >&2; exit 2; }
[[ -f "$COCKPIT_DB_PATH" && ! -L "$COCKPIT_DB_PATH" ]] || { echo "生产SQLite数据库不存在或不是普通文件" >&2; exit 2; }
exec 9>/var/lock/first-service-cockpit-deploy.lock
flock -n 9 || { echo "已有发布任务运行中" >&2; exit 4; }

install_operation() {
  local source="$1" operation="$2" target="$BACKEND_ROOT/scripts/$2"
  local owner="$BACKEND_USER" group="$BACKEND_GROUP"
  if [[ "$operation" == "quarantine_demo_chain.py" ]]; then owner=root; group=root; fi
  rm -f "$target.next"
  install -D -o "$owner" -g "$group" -m 0750 "$source" "$target.next"
  mv -Tf "$target.next" "$target"
}

if ! META_OUTPUT="$(node - "$CANDIDATE" "$(readlink -f "$0")" <<'NODE'
const fs=require('fs'),path=require('path'),crypto=require('crypto')
const root=process.argv[2],activeDeployer=process.argv[3],manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')))
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{const target=path.join(dir,entry.name);if(entry.isSymbolicLink())throw new Error(`候选禁止符号链接：${path.relative(root,target)}`);return entry.isDirectory()?walk(target):entry.isFile()?[path.relative(root,target)]:(()=>{throw new Error(`候选包含非普通文件：${path.relative(root,target)}`)})()})
const actual=walk(root).filter(file=>file!=='manifest.json').sort(),declared=manifest.files.map(file=>file.path).sort()
if(JSON.stringify(actual)!==JSON.stringify(declared))throw new Error('候选文件集合与manifest不一致')
for(const file of manifest.files){const target=path.join(root,file.path),data=fs.readFileSync(target),sha=crypto.createHash('sha256').update(data).digest('hex');if(data.length!==file.bytes||sha!==file.sha256)throw new Error(`候选哈希校验失败：${file.path}`)}
if(manifest.deployer?.protocol !== 2)throw new Error('候选缺少部署器协议2')
const signedDeployer=path.join(root,manifest.deployer.path||'')
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
if(digest(signedDeployer)!==manifest.deployer.sha256||digest(activeDeployer)!==manifest.deployer.sha256)throw new Error('当前部署器与候选签名部署器不一致')
const index=manifest.expectedProduction?.indexSha256,backend=manifest.expectedProduction?.backendDistIndexSha256
if(!/^[a-f0-9]{64}$/.test(index||'')||!/^[a-f0-9]{64}$/.test(backend||''))throw new Error('生产基线摘要必须是纯64位小写SHA-256')
console.log(manifest.release);console.log(index);console.log(backend)
NODE
)"; then
  echo "候选manifest验证失败" >&2
  exit 2
fi
readarray -t META <<< "$META_OUTPUT"
[[ "${#META[@]}" == 3 ]] || { echo "候选manifest元数据不完整" >&2; exit 2; }
RELEASE="${META[0]}"; EXPECTED_INDEX="${META[1]}"; EXPECTED_BACKEND="${META[2]}"
ACTUAL_INDEX="$(sha256sum "$FRONTEND_ROOT/index.html" | awk '{print $1}')"
ACTUAL_BACKEND="$(sha256sum "$BACKEND_ROOT/dist/index.js" | awk '{print $1}')"
[[ "$ACTUAL_INDEX" == "$EXPECTED_INDEX" ]] || { echo "生产入口发生漂移，拒绝发布：$ACTUAL_INDEX" >&2; exit 3; }
[[ "$ACTUAL_BACKEND" == "$EXPECTED_BACKEND" ]] || { echo "后端产物发生漂移，拒绝发布：$ACTUAL_BACKEND" >&2; exit 3; }

# Signed, read-only and fail-closed. This must finish before backup creation or any production write.
ALLOW_INACTIVE_SERVICE=0 SERVICE="$SERVICE" BACKEND_USER="$BACKEND_USER" BACKEND_GROUP="$BACKEND_GROUP" \
  bash "$CANDIDATE/deploy/operations-runtime-preflight.sh"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/home/ubuntu/backups/releases/${RELEASE}-${STAMP}"
install -d -o root -g root -m 0750 "$BACKUP/frontend" "$BACKUP/backend" "$BACKUP/nginx" "$BACKUP/scripts" "$BACKUP/systemd" "$BACKUP/secrets" "$BACKUP/database"
cp -a "$FRONTEND_ROOT/index.html" "$BACKUP/frontend/index.html"
cp -a "$BACKEND_ROOT/dist" "$BACKUP/backend/dist"
cp -a "$NGINX_CONFIG" "$BACKUP/nginx/review-system.conf"
DAILY_ENV_EXISTED=0
if [[ -f "$DAILY_RECONCILIATION_ENV_FILE" ]]; then
  DAILY_ENV_EXISTED=1
  cp -a "$DAILY_RECONCILIATION_ENV_FILE" "$BACKUP/secrets/cockpit-daily-reconciliation.env"
fi
declare -A OP_EXISTED=()
: > "$BACKUP/operations-state.tsv"
for operation in "${OPERATIONS[@]}"; do
  target="$BACKEND_ROOT/scripts/$operation"
  if [[ -f "$target" ]]; then
    OP_EXISTED["$operation"]=1
    cp -a "$target" "$BACKUP/scripts/$operation"
    printf '%s\tpresent\n' "$operation" >> "$BACKUP/operations-state.tsv"
  else
    OP_EXISTED["$operation"]=0
    printf '%s\tabsent\n' "$operation" >> "$BACKUP/operations-state.tsv"
  fi
done
declare -A UNIT_EXISTED=() UNIT_ENABLED=() UNIT_ACTIVE=()
: > "$BACKUP/systemd-state.tsv"
for unit in "${SYSTEMD_UNITS[@]}"; do
  target="/etc/systemd/system/$unit"
  if [[ -f "$target" ]]; then
    UNIT_EXISTED["$unit"]=1
    cp -a "$target" "$BACKUP/systemd/$unit"
  else
    UNIT_EXISTED["$unit"]=0
  fi
  UNIT_ENABLED["$unit"]="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
  UNIT_ACTIVE["$unit"]="$(systemctl is-active "$unit" 2>/dev/null || true)"
  case "${UNIT_ENABLED[$unit]}" in enabled|disabled|static|indirect|generated|not-found) ;; *) echo "不支持的原始systemd启用状态：$unit=${UNIT_ENABLED[$unit]}" >&2; exit 5 ;; esac
  case "${UNIT_ACTIVE[$unit]}" in active|inactive) ;; *) echo "不支持的原始systemd运行状态：$unit=${UNIT_ACTIVE[$unit]}" >&2; exit 5 ;; esac
  printf '%s\t%s\t%s\t%s\n' "$unit" "${UNIT_EXISTED[$unit]}" "${UNIT_ENABLED[$unit]}" "${UNIT_ACTIVE[$unit]}" >> "$BACKUP/systemd-state.tsv"
done
sha256sum "$BACKUP/frontend/index.html" "$BACKUP/backend/dist/index.js" "$BACKUP/nginx/review-system.conf" "$BACKUP/operations-state.tsv" "$BACKUP/systemd-state.tsv" > "$BACKUP/SHA256SUMS"
for operation in "${OPERATIONS[@]}"; do
  if [[ "${OP_EXISTED[$operation]}" == 1 ]]; then sha256sum "$BACKUP/scripts/$operation" >> "$BACKUP/SHA256SUMS"; fi
done
for unit in "${SYSTEMD_UNITS[@]}"; do
  if [[ "${UNIT_EXISTED[$unit]}" == 1 ]]; then sha256sum "$BACKUP/systemd/$unit" >> "$BACKUP/SHA256SUMS"; fi
done

CHANGED=0
ROLLBACK_FAILED=0
DB_BACKUP_READY=0
DB_BACKUP_SHA256=''
DB_SCHEMA_SHA256=''
stop_if_loaded(){
  local unit="$1" load_state
  load_state="$(systemctl show -p LoadState --value "$unit" 2>/dev/null || true)"
  [[ "$load_state" == not-found || -z "$load_state" ]] && return 0
  systemctl stop "$unit"
}
stop_and_confirm_inactive(){
  local unit="$1" load_state active_state sub_state main_pid
  load_state="$(systemctl show -p LoadState --value "$unit" 2>/dev/null || true)"
  [[ "$load_state" == not-found || -z "$load_state" ]] && return 0
  systemctl stop "$unit"
  active_state="$(systemctl show -p ActiveState --value "$unit")"
  sub_state="$(systemctl show -p SubState --value "$unit")"
  main_pid="$(systemctl show -p MainPID --value "$unit")"
  [[ "$active_state" == inactive && "$sub_state" =~ ^(dead|exited)$ && "$main_pid" == 0 ]]
}
verify_service_process(){
  local unit="$1" pid control_group cgroup_path
  pid="$(systemctl show -p MainPID --value "$unit" 2>/dev/null || true)"
  control_group="$(systemctl show -p ControlGroup --value "$unit" 2>/dev/null || true)"
  [[ "$pid" =~ ^[1-9][0-9]*$ && -n "$control_group" && -r "/proc/$pid/cgroup" ]] || return 1
  while IFS=: read -r _ _ cgroup_path; do
    [[ "$cgroup_path" == "$control_group" || "$cgroup_path" == "$control_group/"* ]] && return 0
  done < "/proc/$pid/cgroup"
  return 1
}
wait_for_ready(){
  local attempt
  for attempt in $(seq 1 30); do
    curl -fsS --max-time 5 http://127.0.0.1:3002/api/health/ready >/dev/null && return 0
    sleep 1
  done
  return 1
}
verify_database(){
  [[ "$("$SQLITE_BIN" "$1" 'PRAGMA quick_check;')" == ok ]]
}
database_schema_sha256(){
  "$SQLITE_BIN" "$1" ".schema --nosys" | sha256sum | awk '{print $1}'
}
restore_database_backup(){
  [[ "$DB_BACKUP_READY" == 1 ]] || return 1
  [[ "$(sha256sum "$BACKUP/database/cockpit.db" | awk '{print $1}')" == "$DB_BACKUP_SHA256" ]] || return 1
  rm -f -- "$COCKPIT_DB_PATH.rollback-next" "$COCKPIT_DB_PATH.rollback-next-wal" "$COCKPIT_DB_PATH.rollback-next-shm" || return 1
  install -o "$BACKEND_USER" -g "$BACKEND_GROUP" -m 0640 "$BACKUP/database/cockpit.db" "$COCKPIT_DB_PATH.rollback-next" || return 1
  [[ ! -e "$COCKPIT_DB_PATH.rollback-next-wal" && ! -e "$COCKPIT_DB_PATH.rollback-next-shm" ]] || return 1
  verify_database "$COCKPIT_DB_PATH.rollback-next" || return 1
  [[ "$(database_schema_sha256 "$COCKPIT_DB_PATH.rollback-next")" == "$DB_SCHEMA_SHA256" ]] || return 1
  [[ "$(sha256sum "$COCKPIT_DB_PATH.rollback-next" | awk '{print $1}')" == "$DB_BACKUP_SHA256" ]] || return 1
  rm -f -- "$COCKPIT_DB_PATH-wal" "$COCKPIT_DB_PATH-shm" || return 1
  [[ ! -e "$COCKPIT_DB_PATH-wal" && ! -e "$COCKPIT_DB_PATH-shm" ]] || return 1
  mv -Tf "$COCKPIT_DB_PATH.rollback-next" "$COCKPIT_DB_PATH" || return 1
  [[ ! -e "$COCKPIT_DB_PATH-wal" && ! -e "$COCKPIT_DB_PATH-shm" ]] || return 1
  verify_database "$COCKPIT_DB_PATH" || return 1
  [[ "$(database_schema_sha256 "$COCKPIT_DB_PATH")" == "$DB_SCHEMA_SHA256" ]] || return 1
  [[ "$(sha256sum "$COCKPIT_DB_PATH" | awk '{print $1}')" == "$DB_BACKUP_SHA256" ]] || return 1
}
rollback_step(){
  "$@"
  local step_code=$?
  if [[ "$step_code" -ne 0 ]]; then
    echo "回滚步骤失败($step_code)：$*" >&2
    ROLLBACK_FAILED=1
  fi
  return 0
}
rollback(){
  code=$?
  trap - ERR INT TERM
  set +e
  if [[ "$CHANGED" == 1 ]]; then
    rollback_step stop_if_loaded cockpit-daily-reconciliation.timer
    rollback_step stop_and_confirm_inactive cockpit-daily-reconciliation.service
    rollback_step stop_and_confirm_inactive cockpit-daily-reconciliation-backfill.service
    rollback_step stop_and_confirm_inactive "$SERVICE"
    if [[ "$ROLLBACK_FAILED" -ne 0 ]]; then
      echo "writer未全部退出，禁止恢复数据库与旧代码；备份：$BACKUP" >&2
      exit 70
    fi
    if [[ "$DB_BACKUP_READY" == 1 ]]; then
      if ! restore_database_backup; then
        echo "SQLite安全恢复失败；备份：$BACKUP" >&2
        exit 70
      fi
    fi
    rollback_step rm -rf "$BACKEND_ROOT/dist.rollback-next"
    rollback_step cp -a "$BACKUP/backend/dist" "$BACKEND_ROOT/dist.rollback-next"
    rollback_step rm -rf "$BACKEND_ROOT/dist"
    rollback_step mv "$BACKEND_ROOT/dist.rollback-next" "$BACKEND_ROOT/dist"
    rollback_step cp -a "$BACKUP/frontend/index.html" "$FRONTEND_ROOT/index.html"
    rollback_step cp -a "$BACKUP/nginx/review-system.conf" "$NGINX_CONFIG"
    if [[ "$DAILY_ENV_EXISTED" == 1 ]]; then
      rollback_step install -o root -g root -m 0600 "$BACKUP/secrets/cockpit-daily-reconciliation.env" "$DAILY_RECONCILIATION_ENV_FILE.rollback-next"
      rollback_step mv -Tf "$DAILY_RECONCILIATION_ENV_FILE.rollback-next" "$DAILY_RECONCILIATION_ENV_FILE"
    else
      rollback_step rm -f "$DAILY_RECONCILIATION_ENV_FILE"
    fi
    for operation in "${OPERATIONS[@]}"; do
      if [[ "${OP_EXISTED[$operation]}" == 1 ]]; then
        rollback_step cp -a "$BACKUP/scripts/$operation" "$BACKEND_ROOT/scripts/$operation.rollback-next"
        rollback_step mv -f "$BACKEND_ROOT/scripts/$operation.rollback-next" "$BACKEND_ROOT/scripts/$operation"
      else
        rollback_step rm -f "$BACKEND_ROOT/scripts/$operation"
      fi
    done
    for unit in "${SYSTEMD_UNITS[@]}"; do
      target="/etc/systemd/system/$unit"
      if [[ "${UNIT_EXISTED[$unit]}" == 1 ]]; then
        rollback_step cp -a "$BACKUP/systemd/$unit" "$target.rollback-next"
        rollback_step mv -f "$target.rollback-next" "$target"
      else
        rollback_step rm -f "$target"
      fi
    done
    rollback_step systemctl daemon-reload
    for unit in "${SYSTEMD_UNITS[@]}"; do
      case "${UNIT_ENABLED[$unit]}" in
        enabled) rollback_step systemctl enable "$unit" ;;
        disabled) rollback_step systemctl disable "$unit" ;;
        static|indirect|generated|not-found) ;;
      esac
      if [[ "${UNIT_ACTIVE[$unit]}" == active ]]; then
        if [[ "$unit" == "$SERVICE" ]]; then rollback_step systemctl restart "$unit"; else rollback_step systemctl start "$unit"; fi
      else
        rollback_step stop_if_loaded "$unit"
      fi
    done
    rollback_step nginx -t
    rollback_step nginx -s reload

    rollback_step cmp -s "$BACKUP/backend/dist/index.js" "$BACKEND_ROOT/dist/index.js"
    rollback_step cmp -s "$BACKUP/frontend/index.html" "$FRONTEND_ROOT/index.html"
    rollback_step cmp -s "$BACKUP/nginx/review-system.conf" "$NGINX_CONFIG"
    if [[ "$DAILY_ENV_EXISTED" == 1 ]]; then rollback_step cmp -s "$BACKUP/secrets/cockpit-daily-reconciliation.env" "$DAILY_RECONCILIATION_ENV_FILE"; elif [[ -e "$DAILY_RECONCILIATION_ENV_FILE" ]]; then ROLLBACK_FAILED=1; fi
    for operation in "${OPERATIONS[@]}"; do
      if [[ "${OP_EXISTED[$operation]}" == 1 ]]; then rollback_step cmp -s "$BACKUP/scripts/$operation" "$BACKEND_ROOT/scripts/$operation"; elif [[ -e "$BACKEND_ROOT/scripts/$operation" ]]; then ROLLBACK_FAILED=1; fi
    done
    for unit in "${SYSTEMD_UNITS[@]}"; do
      target="/etc/systemd/system/$unit"
      if [[ "${UNIT_EXISTED[$unit]}" == 1 ]]; then rollback_step cmp -s "$BACKUP/systemd/$unit" "$target"; elif [[ -e "$target" ]]; then ROLLBACK_FAILED=1; fi
      actual_enabled="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
      actual_active="$(systemctl is-active "$unit" 2>/dev/null || true)"
      [[ "$actual_enabled" == "${UNIT_ENABLED[$unit]}" ]] || ROLLBACK_FAILED=1
      [[ "$actual_active" == "${UNIT_ACTIVE[$unit]}" ]] || ROLLBACK_FAILED=1
    done
    if [[ "${UNIT_ACTIVE[$SERVICE]}" == active ]]; then
      rollback_step verify_service_process "$SERVICE"
      rollback_step wait_for_ready
    fi
  fi
  if [[ "$ROLLBACK_FAILED" -ne 0 ]]; then echo "回滚验证失败；备份：$BACKUP" >&2; exit 70; fi
  echo "发布失败，已执行回滚；备份：$BACKUP" >&2
  exit "$code"
}
trap rollback ERR INT TERM

CHANGED=1
stop_if_loaded cockpit-daily-reconciliation.timer
stop_and_confirm_inactive cockpit-daily-reconciliation.service || { echo "日报复核writer未退出，拒绝发布" >&2; false; }
stop_and_confirm_inactive cockpit-daily-reconciliation-backfill.service || { echo "全历史回填writer未退出，拒绝发布" >&2; false; }
stop_and_confirm_inactive "$SERVICE" || { echo "API writer未退出，拒绝发布" >&2; false; }
"$SQLITE_BIN" "$COCKPIT_DB_PATH" ".timeout 30000" ".backup '$BACKUP/database/cockpit.db'"
[[ "$("$SQLITE_BIN" "$BACKUP/database/cockpit.db" 'PRAGMA quick_check;')" == ok ]] || { echo "SQLite一致备份校验失败" >&2; false; }
DB_BACKUP_SHA256="$(sha256sum "$BACKUP/database/cockpit.db" | awk '{print $1}')"
DB_SCHEMA_SHA256="$(database_schema_sha256 "$BACKUP/database/cockpit.db")"
[[ "$DB_BACKUP_SHA256" =~ ^[a-f0-9]{64}$ && "$DB_SCHEMA_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "SQLite备份摘要生成失败" >&2; false; }
DB_BACKUP_READY=1
chown root:root "$BACKUP/database/cockpit.db"
chmod 0640 "$BACKUP/database/cockpit.db"
sha256sum "$BACKUP/database/cockpit.db" >> "$BACKUP/SHA256SUMS"
DAILY_RECONCILIATION_ENV_NEXT="$DAILY_RECONCILIATION_ENV_FILE.next"
if [[ -f "$DAILY_RECONCILIATION_ENV_FILE" && "$ALLOW_DAILY_RECONCILIATION_SECRET_ROTATION" != 1 ]]; then
  echo "已有专项自动化密钥，默认保留原值"
  cp -a "$DAILY_RECONCILIATION_ENV_FILE" "$DAILY_RECONCILIATION_ENV_NEXT"
else
  node - "$DAILY_RECONCILIATION_ENV_NEXT" <<'NODE'
const fs=require('fs'),crypto=require('crypto')
const secret=crypto.randomBytes(48).toString('base64url')
fs.writeFileSync(process.argv[2],`DAILY_RECONCILIATION_JWT_SECRET=${secret}\n`,{mode:0o600})
NODE
fi
install -o root -g root -m 0600 "$DAILY_RECONCILIATION_ENV_NEXT" "$DAILY_RECONCILIATION_ENV_FILE"
rm -f "$DAILY_RECONCILIATION_ENV_NEXT"
ALLOW_INACTIVE_SERVICE=1 REQUIRE_DAILY_RECONCILIATION_ENV=1 SERVICE="$SERVICE" BACKEND_USER="$BACKEND_USER" BACKEND_GROUP="$BACKEND_GROUP" \
  bash "$CANDIDATE/deploy/operations-runtime-preflight.sh"
install -o root -g root -m 0644 "$CANDIDATE/deploy/review-system.conf" "$NGINX_CONFIG.next"
cp -a "$NGINX_CONFIG.next" "$NGINX_CONFIG"
rm -f "$NGINX_CONFIG.next"
nginx -t

rm -rf "$BACKEND_ROOT/dist.release-next"
cp -a "$CANDIDATE/backend/dist" "$BACKEND_ROOT/dist.release-next"
rm -rf "$BACKEND_ROOT/dist"
mv "$BACKEND_ROOT/dist.release-next" "$BACKEND_ROOT/dist"
for operation in "${OPERATIONS[@]}"; do
  install_operation "$CANDIDATE/backend/operations/$operation" "$operation"
  cmp -s "$CANDIDATE/backend/operations/$operation" "$BACKEND_ROOT/scripts/$operation"
done
for unit in "${SYSTEMD_UNITS[@]}"; do
  target="/etc/systemd/system/$unit"
  install -o root -g root -m 0644 "$CANDIDATE/backend/systemd/$unit" "$target.next"
  mv -Tf "$target.next" "$target"
  cmp -s "$CANDIDATE/backend/systemd/$unit" "$target"
done
systemctl daemon-reload

while IFS= read -r -d '' source; do
  relative="${source#"$CANDIDATE/frontend/"}"
  [[ "$relative" == "index.html" ]] && continue
  target="$FRONTEND_ROOT/$relative"
  install -D -o root -g root -m 0644 "$source" "$target.next"
  mv "$target.next" "$target"
done < <(find "$CANDIDATE/frontend" -type f -print0)
install -o root -g root -m 0644 "$CANDIDATE/frontend/index.html" "$FRONTEND_ROOT/index.html.next"
mv "$FRONTEND_ROOT/index.html.next" "$FRONTEND_ROOT/index.html"

systemctl restart "$SERVICE"
wait_for_ready
verify_database "$COCKPIT_DB_PATH"
systemctl enable --now cockpit-daily-reconciliation.timer
systemctl is-enabled --quiet cockpit-daily-reconciliation.timer
systemctl is-active --quiet cockpit-daily-reconciliation.timer
nginx -s reload
curl -fsS --max-time 15 https://www.firstcare.cloud/api/health/ready >/dev/null
install -D -o root -g root -m 0644 "$CANDIDATE/manifest.json" "$FRONTEND_ROOT/releases/$RELEASE/manifest.json"
trap - ERR INT TERM
printf 'DEPLOY_OK=true\nRELEASE=%s\nBACKUP=%s\n' "$RELEASE" "$BACKUP"
