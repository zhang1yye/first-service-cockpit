#!/usr/bin/env bash
set -euo pipefail

COCKPIT_ROOT="${COCKPIT_ROOT:-/home/ubuntu/cockpit}"
DB="${COCKPIT_DB_PATH:-$COCKPIT_ROOT/cockpit.db}"
PYTHON_BIN="${PYTHON_BIN:-/home/ubuntu/scraper-venv/bin/python3}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
FLOCK_BIN="${FLOCK_BIN:-/usr/bin/flock}"
RUNTIME_DIR="${RUNTIME_DIRECTORY:-/run/first-service-cockpit-reconciliation-daily}"
LOCK_ROOT="${STATE_DIRECTORY:-/var/lib/first-service-cockpit-reconciliation}"
LOCK_FILE="${DAILY_RECONCILIATION_LOCK:-$LOCK_ROOT/daily.lock}"
RECONCILIATION_MODE="${COCKPIT_RECONCILIATION_MODE:-daily}"
RECONCILIATION_START_DATE="${COCKPIT_RECONCILIATION_START_DATE:-2026-06-15}"
BACKFILL_BATCH_SIZE="${COCKPIT_RECONCILIATION_BACKFILL_BATCH_SIZE:-5}"
MAX_ATTEMPTS="${COCKPIT_RECONCILIATION_MAX_ATTEMPTS:-3}"
STATE_DB="${DAILY_RECONCILIATION_STATE_DB:-${STATE_DIRECTORY:-/var/lib/first-service-cockpit-reconciliation}/attempts.db}"
BACKFILL_INCOMPLETE_EXIT=76
BACKFILL_STATUS_ERROR_EXIT=77
BACKFILL_QUARANTINE_EXIT=78

[[ -n "${APH_USER:-}" ]] || { echo 'missing required environment: APH_USER' >&2; exit 2; }
[[ -n "${APH_PWD:-}" ]] || { echo 'missing required environment: APH_PWD' >&2; exit 2; }
automation_secret="${DAILY_RECONCILIATION_JWT_SECRET:-}"
[[ ${#automation_secret} -ge 32 ]] || { echo 'missing required environment: DAILY_RECONCILIATION_JWT_SECRET' >&2; exit 2; }
command -v "$FLOCK_BIN" >/dev/null || { echo 'missing required command: flock' >&2; exit 2; }
command -v "$NODE_BIN" >/dev/null || { echo 'missing required command: node' >&2; exit 2; }
command -v "$PYTHON_BIN" >/dev/null || { echo 'missing required command: python' >&2; exit 2; }
[[ "$("$NODE_BIN" -p "process.versions.node.split('.')[0]")" == 20 ]] || { echo 'node major version must be 20' >&2; exit 2; }
[[ "$RECONCILIATION_MODE" == daily || "$RECONCILIATION_MODE" == backfill ]] || { echo 'invalid reconciliation mode' >&2; exit 2; }
[[ "$RECONCILIATION_START_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo 'invalid reconciliation start date' >&2; exit 2; }
[[ "$BACKFILL_BATCH_SIZE" =~ ^[0-9]+$ ]] && (( BACKFILL_BATCH_SIZE >= 1 && BACKFILL_BATCH_SIZE <= 64 )) \
  || { echo 'backfill batch size must be between 1 and 64' >&2; exit 2; }
[[ "$MAX_ATTEMPTS" =~ ^[0-9]+$ ]] && (( MAX_ATTEMPTS >= 1 && MAX_ATTEMPTS <= 10 )) \
  || { echo 'max attempts must be between 1 and 10' >&2; exit 2; }
[[ -d "$RUNTIME_DIR" && -w "$RUNTIME_DIR" ]] || { echo "runtime directory unavailable: $RUNTIME_DIR" >&2; exit 2; }
[[ -d "$LOCK_ROOT" && -w "$LOCK_ROOT" ]] || { echo "lock directory unavailable: $LOCK_ROOT" >&2; exit 2; }

exec 9>"$LOCK_FILE"
"$FLOCK_BIN" -n 9 || { echo '{"ok":false,"error":"daily reconciliation already running"}'; exit 75; }
[[ -f "$DB" ]] || { echo "cockpit database missing: $DB" >&2; exit 1; }

finish_backfill() {
  local status parsed completed quarantined
  if ! status="$("$PYTHON_BIN" "$COCKPIT_ROOT/scripts/daily_reconciliation_candidates.py" "$DB" \
    --state-database "$STATE_DB" --start-date "$RECONCILIATION_START_DATE" --batch-size 1 --completion-status)"; then
    printf '%s\n' '{"ok":false,"mode":"backfill","completed":false,"error":"completion_status_failed"}'
    return "$BACKFILL_STATUS_ERROR_EXIT"
  fi
  printf '%s\n' "$status"
  if ! parsed="$("$PYTHON_BIN" -c 'import json,sys; value=json.loads(sys.argv[1]); print("true" if value["completed"] else "false", int(value["quarantined"]))' "$status")"; then
    printf '%s\n' '{"ok":false,"mode":"backfill","completed":false,"error":"invalid_completion_status"}'
    return "$BACKFILL_STATUS_ERROR_EXIT"
  fi
  read -r completed quarantined <<<"$parsed"
  if (( quarantined > 0 )); then return "$BACKFILL_QUARANTINE_EXIT"; fi
  [[ "$completed" == true ]] || return "$BACKFILL_INCOMPLETE_EXIT"
}

if [[ "$RECONCILIATION_MODE" == daily ]]; then
  selection_start="$($PYTHON_BIN -c 'from datetime import date; print(date.today())')"
  selection_size=1
else
  selection_start="$RECONCILIATION_START_DATE"
  selection_size="$BACKFILL_BATCH_SIZE"
fi

DATES_FILE=''
CURRENT_PAYLOAD=''
CURRENT_ERROR=''
cleanup() {
  [[ -z "$DATES_FILE" ]] || rm -f "$DATES_FILE"
  [[ -z "$CURRENT_PAYLOAD" ]] || rm -f "$CURRENT_PAYLOAD"
  [[ -z "$CURRENT_ERROR" ]] || rm -f "$CURRENT_ERROR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

DATES_FILE="$(mktemp "$RUNTIME_DIR/dates.XXXXXX")"
selection_args=(--state-database "$STATE_DB" --start-date "$selection_start" --batch-size "$selection_size" --max-attempts "$MAX_ATTEMPTS")
if [[ "$RECONCILIATION_MODE" == daily ]]; then selection_args+=(--latest-formal-before "$selection_start"); fi
if ! "$PYTHON_BIN" "$COCKPIT_ROOT/scripts/daily_reconciliation_candidates.py" "$DB" \
  "${selection_args[@]}" >"$DATES_FILE"; then
  echo 'failed to select daily reconciliation candidates' >&2
  exit 1
fi
mapfile -t DATES <"$DATES_FILE"
rm -f "$DATES_FILE"
DATES_FILE=''

if [[ ${#DATES[@]} -eq 0 ]]; then
  if [[ "$RECONCILIATION_MODE" == backfill ]]; then
    if finish_backfill; then exit 0; else exit $?; fi
  fi
  echo "{\"ok\":true,\"mode\":\"$RECONCILIATION_MODE\",\"message\":\"no unreconciled historical daily snapshot\"}"
  exit 0
fi

failures=0
for business_date in "${DATES[@]}"; do
  payload="$(mktemp "$RUNTIME_DIR/${business_date}.XXXXXX.json")"
  CURRENT_PAYLOAD="$payload"
  error_file="$(mktemp "$RUNTIME_DIR/${business_date}.error.XXXXXX")"
  CURRENT_ERROR="$error_file"
  if { "$PYTHON_BIN" "$COCKPIT_ROOT/scripts/probe-fine-report-daily-reconciliation.py" "$business_date" --output "$payload" \
    && DAILY_RECONCILIATION_FILE="$payload" "$NODE_BIN" "$COCKPIT_ROOT/scripts/publish-daily-reconciliation.mjs"; } 2> >(tee "$error_file" >&2); then
    "$PYTHON_BIN" "$COCKPIT_ROOT/scripts/daily_reconciliation_candidates.py" "$DB" --state-database "$STATE_DB" --batch-size 1 --max-attempts "$MAX_ATTEMPTS" \
      --record-result succeeded --business-date "$business_date"
    rm -f "$payload"
  else
    failures=$((failures + 1))
    failure_message="$(<"$error_file")"
    "$PYTHON_BIN" "$COCKPIT_ROOT/scripts/daily_reconciliation_candidates.py" "$DB" --state-database "$STATE_DB" --batch-size 1 --max-attempts "$MAX_ATTEMPTS" \
      --record-result failed --business-date "$business_date" --error "$failure_message"
    rm -f "$payload"
    echo "daily reconciliation failed for $business_date" >&2
  fi
  rm -f "$error_file"
  CURRENT_ERROR=''
  CURRENT_PAYLOAD=''
done

if [[ "$RECONCILIATION_MODE" == backfill ]]; then
  if finish_backfill; then exit 0; else exit $?; fi
fi

if [[ $failures -ne 0 ]]; then
  echo -n 'manual review queue: ' >&2
  "$PYTHON_BIN" "$COCKPIT_ROOT/scripts/daily_reconciliation_candidates.py" "$DB" --state-database "$STATE_DB" --batch-size 1 --manual-review >&2
  echo "daily reconciliation failures: $failures" >&2
  exit 1
fi
