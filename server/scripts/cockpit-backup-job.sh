#!/usr/bin/env bash
set -Eeuo pipefail
MODE="${1:-backup}"
ROOT="${COCKPIT_ROOT:-/home/ubuntu/cockpit}"
STATUS_DIR="${STATUS_DIR:-$ROOT/backups/status}"
LOG_FILE="${LOG_FILE:-/tmp/cockpit-backup-job.log}"
mkdir -p "$STATUS_DIR"; chmod 700 "$STATUS_DIR"
START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; STATUS_FILE="$STATUS_DIR/${MODE}-status.json"; TMP="$STATUS_FILE.tmp"; OUTPUT=""
write_status(){ STATUS="$1"; MESSAGE="$2"; FINISH="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; export OUTPUT_TEXT="$OUTPUT"; python3 - "$TMP" "$MODE" "$START" "$FINISH" "$STATUS" "$MESSAGE" <<'PY'
import json,os,sys
p,mode,start,finish,status,message=sys.argv[1:]
out=os.environ.get('OUTPUT_TEXT','')
data={'mode':mode,'status':status,'started_at':start,'finished_at':finish,'message':message,'evidence':out[-8000:]}
open(p,'w').write(json.dumps(data,ensure_ascii=False,indent=2))
PY
mv "$TMP" "$STATUS_FILE"; chmod 600 "$STATUS_FILE"; }
notify_failure(){ [[ -n "${WECOM_NOTIFICATION_WEBHOOK:-}" ]] || return 0; python3 - <<PY | curl -fsS --max-time 10 -H 'Content-Type: application/json' -d @- "$WECOM_NOTIFICATION_WEBHOOK" >/dev/null || true
import json
print(json.dumps({'msgtype':'text','text':{'content':'华北驾驶舱灾备作业失败：${MODE} ${1}'}},ensure_ascii=False))
PY
}
on_error(){ code=$?; msg="作业失败，退出码${code}"; write_status failed "$msg"; notify_failure "$msg"; printf '%s P38_BACKUP_JOB_FAILED mode=%s code=%s\n' "$(date -u +%FT%TZ)" "$MODE" "$code" >> "$LOG_FILE"; exit "$code"; }
trap on_error ERR
if [[ "$MODE" == backup ]]; then
  OUTPUT="$(DB_PATH="$ROOT/cockpit.db" BACKUP_DIR="$ROOT/backups/database" "$ROOT/scripts/backup-cockpit-db.sh" 2>&1)"
  path="$(sed -n 's/^BACKUP_PATH=//p' <<<"$OUTPUT" | tail -1)"; [[ -f "$path" ]]
  write_status success "每日数据库备份完成"
elif [[ "$MODE" == restore ]]; then
  latest="$(python3 - "$ROOT/backups/database" <<'PY'
import glob,os,sys
files=glob.glob(os.path.join(sys.argv[1],'cockpit-*.db'))
print(max(files,key=os.path.getmtime) if files else '')
PY
)"; [[ -n "$latest" && -f "$latest" ]]
  OUTPUT="$("$ROOT/scripts/verify-cockpit-backup.sh" "$latest" 2>&1)"
  write_status success "每周恢复抽检完成"
else
  echo "unknown mode: $MODE" >&2; exit 2
fi
printf '%s P38_BACKUP_JOB_OK mode=%s\n' "$(date -u +%FT%TZ)" "$MODE" >> "$LOG_FILE"
printf '%s\n' "$OUTPUT"
echo "P38_JOB_OK=true"
echo "MODE=$MODE"
echo "STATUS_FILE=$STATUS_FILE"
