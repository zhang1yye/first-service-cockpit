#!/usr/bin/env bash
# 云端绿仔数据安全发布器：仅更新收缴率金额列与三份绿仔JSON。
set -Eeuo pipefail

ROOT=/home/ubuntu/cockpit
REL="${1:-}"
DATE="${2:-}"

case "$REL" in
  /tmp/lvzai-auto-*) ;;
  *) echo "非法发布目录: $REL" >&2; exit 2 ;;
esac
[[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "非法日期: $DATE" >&2; exit 2; }
for file in collection-centers.sql 绿仔收款汇总.json 绿仔收缴明细.json; do
  [ -s "$REL/$file" ] || { echo "缺少发布文件: $REL/$file" >&2; exit 2; }
done

python3 - "$REL/绿仔收款汇总.json" "$REL/绿仔收缴明细.json" "$DATE" <<'PY'
import json,sys
summary=json.load(open(sys.argv[1])); detail=json.load(open(sys.argv[2])); date=sys.argv[3]
assert summary.get('date') == date, (summary.get('date'), date)
assert summary.get('periodCorrection',{}).get('rateField') == 'gatheringCurrentYearRecedRate'
assert '官方字段gatheringCurrentYearRecedRate' in summary.get('source','')
assert 0 < float(summary.get('collectionRate',0)) <= 1
assert len(detail.get('rows') or []) >= 30
assert all('rateNumerator' not in x for x in summary.get('periodCorrection',{}).get('excludedProjects',[]))
PY

TS=$(date +%Y%m%d-%H%M%S)
BACKUP="/home/ubuntu/backups/cockpit-lvzai-auto-$TS"
mkdir -p "$BACKUP"
sqlite3 "$ROOT/cockpit.db" ".backup '$BACKUP/cockpit.db'"
cp -a "$ROOT/绿仔收款汇总.json" "$ROOT/绿仔收缴明细.json" "$ROOT/绿仔同步状态.json" "$BACKUP/"
systemctl status first-service-cockpit --no-pager > "$BACKUP/service-before.txt" || true
TASK_HASH_BEFORE=$(sqlite3 "$ROOT/cockpit.db" "SELECT * FROM management_tasks ORDER BY id; SELECT * FROM task_events ORDER BY id; SELECT * FROM task_notifications ORDER BY id;" | sha256sum | cut -d' ' -f1)
printf '%s\n' "$TASK_HASH_BEFORE" > "$BACKUP/task-history.sha256"
sha256sum "$BACKUP/cockpit.db" "$BACKUP/绿仔收款汇总.json" "$BACKUP/绿仔收缴明细.json" "$BACKUP/绿仔同步状态.json" > "$BACKUP/SHA256SUMS"

rollback() {
  rc=$?
  echo "AUTO_PUBLISH_ROLLBACK rc=$rc" >&2
  sudo -n systemctl stop first-service-cockpit || true
  cp "$BACKUP/cockpit.db" "$ROOT/cockpit.db"
  cp "$BACKUP/绿仔收款汇总.json" "$BACKUP/绿仔收缴明细.json" "$BACKUP/绿仔同步状态.json" "$ROOT/"
  chown ubuntu:ubuntu "$ROOT/cockpit.db" "$ROOT/绿仔收款汇总.json" "$ROOT/绿仔收缴明细.json" "$ROOT/绿仔同步状态.json"
  sudo -n systemctl start first-service-cockpit || true
  exit "$rc"
}
trap rollback ERR

sudo -n systemctl stop first-service-cockpit
sqlite3 "$ROOT/cockpit.db" < "$REL/collection-centers.sql"
install -m 0640 -o ubuntu -g ubuntu "$REL/绿仔收款汇总.json" "$ROOT/.绿仔收款汇总.$$.new"
install -m 0640 -o ubuntu -g ubuntu "$REL/绿仔收缴明细.json" "$ROOT/.绿仔收缴明细.$$.new"
mv "$ROOT/.绿仔收款汇总.$$.new" "$ROOT/绿仔收款汇总.json"
mv "$ROOT/.绿仔收缴明细.$$.new" "$ROOT/绿仔收缴明细.json"

[ "$(sqlite3 "$ROOT/cockpit.db" 'PRAGMA integrity_check;')" = ok ]
[ "$(sqlite3 "$ROOT/cockpit.db" 'SELECT COUNT(*) FROM collection_centers;')" = 56 ]
[ "$(sqlite3 "$ROOT/cockpit.db" 'SELECT COUNT(*) FROM management_tasks;')" = 29 ]
TASK_HASH_AFTER=$(sqlite3 "$ROOT/cockpit.db" "SELECT * FROM management_tasks ORDER BY id; SELECT * FROM task_events ORDER BY id; SELECT * FROM task_notifications ORDER BY id;" | sha256sum | cut -d' ' -f1)
[ "$TASK_HASH_BEFORE" = "$TASK_HASH_AFTER" ]

python3 - "$ROOT/绿仔同步状态.json" "$DATE" "$ROOT/绿仔收款汇总.json" <<'PY'
import datetime,json,os,sys,tempfile
path,date,summary_path=sys.argv[1:]
summary=json.load(open(summary_path))
data={'ok':True,'date':date,'state':'published','message':'每日17:30绿仔官方收缴率已自动发布生产','finishedAt':datetime.datetime.now().isoformat(),'collectionRate':summary['collectionRate'],'extractedAt':summary.get('extractedAt')}
fd,tmp=tempfile.mkstemp(prefix='.lvzai-status-',dir=os.path.dirname(path)); os.close(fd)
with open(tmp,'w') as f: json.dump(data,f,ensure_ascii=False,indent=2)
os.chmod(tmp,0o640); os.replace(tmp,path)
PY
chown ubuntu:ubuntu "$ROOT/绿仔同步状态.json"

sudo -n systemctl start first-service-cockpit
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:3002/api/health/ready > /tmp/lvzai-auto-ready.json 2>/dev/null && break
  sleep 0.5
done
python3 - /tmp/lvzai-auto-ready.json <<'PY'
import json,sys
assert json.load(open(sys.argv[1])).get('ready') is True
PY
[ "$(systemctl is-active first-service-cockpit)" = active ]
[ "$(systemctl show first-service-cockpit -p NRestarts --value)" = 0 ]
[ "$(pgrep -af '^/usr/bin/node /home/ubuntu/cockpit/dist/index.js$' | wc -l | tr -d ' ')" = 1 ]

PID=$(pgrep -f '^/usr/bin/node /home/ubuntu/cockpit/dist/index.js$')
while IFS= read -r -d '' entry; do export "$entry"; done < "/proc/$PID/environ"
TOKEN=$(cd "$ROOT" && node --input-type=module - <<'NODE' | tail -n1
import { signToken } from './dist/auth.js'
process.stdout.write(signToken({userId:1,username:'lvzai-auto-verifier',role:'admin'}))
NODE
)
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3002/api/summary > /tmp/lvzai-auto-summary.json
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3002/api/collections > /tmp/lvzai-auto-collections.json
python3 - /tmp/lvzai-auto-summary.json /tmp/lvzai-auto-collections.json "$DATE" <<'PY'
import json,sys
summary=json.load(open(sys.argv[1])); rows=json.load(open(sys.argv[2])); date=sys.argv[3]
assert summary.get('collectionRate') > 0
assert str(summary.get('collectionExtractedAt','')).startswith(date)
assert len(rows) >= 30
assert all('官方字段gatheringCurrentYearRecedRate' in str(x.get('source','')) for x in rows)
PY
unset TOKEN
trap - ERR
printf 'AUTO_PUBLISH_OK date=%s backup=%s task_hash=%s\n' "$DATE" "$BACKUP" "$TASK_HASH_AFTER"
