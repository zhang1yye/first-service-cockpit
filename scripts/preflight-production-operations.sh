#!/usr/bin/env bash
set -Eeuo pipefail

# R149: read-only runtime prerequisites for the released operational scripts.
SERVICE="${SERVICE:-first-service-cockpit.service}"
BACKEND_USER="${BACKEND_USER:-ubuntu}"
BACKEND_GROUP="${BACKEND_GROUP:-ubuntu}"
RUNTIME_PYTHON="${RUNTIME_PYTHON:-/home/ubuntu/scraper-venv/bin/python3}"
CHROMIUM_BIN="${CHROMIUM_BIN:-/usr/bin/chromium-browser}"
LVZAI_STATE_FILE="${LVZAI_STATE_FILE:-/home/ubuntu/.lvzai_state.json}"
HERMES_DAILY_SCRIPT="${HERMES_DAILY_SCRIPT:-/home/ubuntu/.hermes/scripts/daily-cockpit-scrape.sh}"
HERMES_ENV_FILE="${HERMES_ENV_FILE:-/home/ubuntu/.hermes/.env}"
COCKPIT_ENV_FILE="${COCKPIT_ENV_FILE:-/etc/first-service/cockpit.env}"
DAILY_RECONCILIATION_ENV_FILE="${DAILY_RECONCILIATION_ENV_FILE:-/etc/first-service/cockpit-daily-reconciliation.env}"
SQLITE_BIN="${SQLITE_BIN:-/usr/bin/sqlite3}"
FLOCK_BIN="${FLOCK_BIN:-/usr/bin/flock}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
PROC_ROOT="${PROC_ROOT:-/proc}"
ALLOW_INACTIVE_SERVICE="${ALLOW_INACTIVE_SERVICE:-0}"

fail() { printf '运维运行环境预检失败：%s\n' "$1" >&2; exit 5; }
regular_not_link() { [[ -f "$1" && ! -L "$1" ]]; }
mode_of() { stat -c '%a' "$1"; }
owner_of() { stat -c '%U:%G' "$1"; }
parse_systemd_environment() {
  "$NODE_BIN" - "$1" "$2" <<'NODE'
const fs = require('fs')
const [file, key] = process.argv.slice(2)
for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const line = raw.trim()
  if (!line || line.startsWith('#') || line.startsWith(';')) continue
  const index = line.indexOf('=')
  if (index < 1 || line.slice(0, index).trim() !== key) continue
  let value = line.slice(index + 1).trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  process.stdout.write(value)
  process.exit(0)
}
process.exit(1)
NODE
}

regular_not_link "$COCKPIT_ENV_FILE" || fail "cockpit环境文件不是普通文件"
[[ "$(owner_of "$COCKPIT_ENV_FILE")" == root:root ]] || fail "cockpit环境文件必须由 root 管理"
[[ "$(mode_of "$COCKPIT_ENV_FILE")" == 600 ]] || fail "cockpit环境文件权限必须为 600"
grep -Eq '^JWT_SECRET=.+$' "$COCKPIT_ENV_FILE" || fail "cockpit环境缺少 JWT_SECRET"

command -v "$SQLITE_BIN" >/dev/null 2>&1 || fail "缺少 sqlite3"
command -v "$FLOCK_BIN" >/dev/null 2>&1 || fail "缺少 flock"
command -v "$NODE_BIN" >/dev/null 2>&1 || fail "缺少 node"
command -v "$RUNTIME_PYTHON" >/dev/null 2>&1 || fail "缺少 python"
[[ "$("$NODE_BIN" -p "process.versions.node.split('.')[0]")" == 20 ]] || fail "Node 主版本必须为 20"

[[ -e "$RUNTIME_PYTHON" && -x "$RUNTIME_PYTHON" ]] || fail "专用 Python 不存在或不可执行"
case "$RUNTIME_PYTHON" in
  /home/"$BACKEND_USER"/*/bin/python3|/home/"$BACKEND_USER"/*/bin/python) ;;
  *) fail "Python 入口不在受控专用环境中" ;;
esac
"$RUNTIME_PYTHON" -c 'import sys; assert sys.prefix != sys.base_prefix; import ddddocr; from playwright.sync_api import sync_playwright' >/dev/null 2>&1 \
  || fail "Python 不是虚拟环境或缺少 ddddocr/Playwright"

regular_not_link "$CHROMIUM_BIN" || fail "Chromium 不是普通文件"
[[ -x "$CHROMIUM_BIN" ]] || fail "Chromium 不可执行"
[[ "$(owner_of "$CHROMIUM_BIN")" == root:root ]] || fail "Chromium 必须由 root 管理"
chromium_mode="$(mode_of "$CHROMIUM_BIN")"
(( (8#$chromium_mode & 0022) == 0 )) || fail "Chromium 不得由组或其他用户写入"
"$CHROMIUM_BIN" --version >/dev/null 2>&1 || fail "Chromium 无法启动版本检查"

regular_not_link "$LVZAI_STATE_FILE" || fail "绿仔会话文件不是普通文件"
[[ "$(owner_of "$LVZAI_STATE_FILE")" == "$BACKEND_USER:$BACKEND_GROUP" ]] || fail "绿仔会话文件属主不正确"
[[ "$(mode_of "$LVZAI_STATE_FILE")" == 600 ]] || fail "绿仔会话文件权限必须为 600"
"$RUNTIME_PYTHON" - "$LVZAI_STATE_FILE" <<'PY' >/dev/null 2>&1 || fail "绿仔会话文件不是有效 JSON"
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
if not isinstance(value, (dict, list)):
    raise SystemExit(1)
PY

regular_not_link "$HERMES_DAILY_SCRIPT" || fail "Hermes 每日同步脚本不是普通文件"
[[ -x "$HERMES_DAILY_SCRIPT" ]] || fail "Hermes 每日同步脚本不可执行"
[[ "$(owner_of "$HERMES_DAILY_SCRIPT")" == "$BACKEND_USER:$BACKEND_GROUP" ]] || fail "Hermes 每日同步脚本属主不正确"
regular_not_link "$HERMES_ENV_FILE" || fail "Hermes 环境文件不是普通文件"
[[ "$(owner_of "$HERMES_ENV_FILE")" == "$BACKEND_USER:$BACKEND_GROUP" ]] || fail "Hermes 环境文件属主不正确"
[[ "$(mode_of "$HERMES_ENV_FILE")" == 600 ]] || fail "Hermes 环境文件权限必须为 600"
grep -Eq '^APH_USER=.+$' "$HERMES_ENV_FILE" || fail "Hermes 环境缺少 APH_USER"
grep -Eq '^APH_PWD=.+$' "$HERMES_ENV_FILE" || fail "Hermes 环境缺少 APH_PWD"
grep -Eq '^LVZAI_USER=.+$' "$HERMES_ENV_FILE" || fail "Hermes 环境缺少 LVZAI_USER"
if grep -Eq '^JWT_SECRET=' "$HERMES_ENV_FILE"; then
  fail "Hermes 环境不得包含 JWT_SECRET"
fi
grep -Fq "$HERMES_ENV_FILE" "$HERMES_DAILY_SCRIPT" || fail "Hermes 每日同步未加载受控环境文件"

if [[ "$ALLOW_INACTIVE_SERVICE" != 1 ]]; then
  main_pid="$($SYSTEMCTL_BIN show --property MainPID --value "$SERVICE")"
  [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] || fail "生产服务没有运行中的主进程"
  service_environment="$PROC_ROOT/$main_pid/environ"
  [[ -r "$service_environment" ]] || fail "无法只读检查生产服务环境"
  tr '\0' '\n' < "$service_environment" | grep -Eq '^LVZAI_USER=.+$' \
    || fail "生产服务环境缺少 LVZAI_USER"
fi

if [[ "${REQUIRE_DAILY_RECONCILIATION_ENV:-0}" == 1 || -e "$DAILY_RECONCILIATION_ENV_FILE" ]]; then
  regular_not_link "$DAILY_RECONCILIATION_ENV_FILE" || fail "专项自动化环境文件不是普通文件"
  [[ "$(owner_of "$DAILY_RECONCILIATION_ENV_FILE")" == root:root ]] || fail "专项自动化环境文件必须由 root 管理"
  [[ "$(mode_of "$DAILY_RECONCILIATION_ENV_FILE")" == 600 ]] || fail "专项自动化环境文件权限必须为 600"
  daily_secret="$(parse_systemd_environment "$DAILY_RECONCILIATION_ENV_FILE" DAILY_RECONCILIATION_JWT_SECRET)" \
    || fail "专项自动化环境缺少密钥"
  human_secret="$(parse_systemd_environment "$COCKPIT_ENV_FILE" JWT_SECRET)" \
    || fail "cockpit环境缺少有效 JWT_SECRET"
  [[ ${#daily_secret} -ge 32 ]] || fail "专项自动化密钥长度必须至少为 32"
  [[ "$daily_secret" != "$human_secret" ]] || fail "专项自动化密钥不得等于人类 JWT_SECRET"
  [[ "$(grep -Ec '^[A-Za-z_][A-Za-z0-9_]*=' "$DAILY_RECONCILIATION_ENV_FILE")" == 1 ]] || fail "专项自动化环境文件只能包含一个变量"
fi

printf 'OPERATIONS_PREFLIGHT_OK=true\n'
