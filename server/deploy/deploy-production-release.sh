#!/usr/bin/env bash
set -Eeuo pipefail

CANDIDATE="${1:-}"
FRONTEND_ROOT="${FRONTEND_ROOT:-/var/www/cockpit}"
BACKEND_ROOT="${BACKEND_ROOT:-/home/ubuntu/cockpit}"
NGINX_CONFIG="${NGINX_CONFIG:-/etc/nginx/conf.d/review-system.conf}"
SERVICE="${SERVICE:-first-service-cockpit.service}"
[[ -n "$CANDIDATE" && -f "$CANDIDATE/manifest.json" ]] || { echo "用法：sudo $0 <候选目录>" >&2; exit 2; }
[[ "$(id -u)" == 0 ]] || { echo "必须使用 sudo 执行" >&2; exit 2; }
exec 9>/var/lock/first-service-cockpit-deploy.lock
flock -n 9 || { echo "已有发布任务运行中" >&2; exit 4; }

readarray -t META < <(node - "$CANDIDATE" <<'NODE'
const fs=require('fs'),path=require('path'),crypto=require('crypto')
const root=process.argv[2],manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')))
for(const file of manifest.files){const target=path.join(root,file.path),data=fs.readFileSync(target),sha=crypto.createHash('sha256').update(data).digest('hex');if(data.length!==file.bytes||sha!==file.sha256)throw new Error(`候选哈希校验失败：${file.path}`)}
console.log(manifest.release);console.log(manifest.expectedProduction.indexSha256);console.log(manifest.expectedProduction.backendDistIndexSha256)
NODE
)
RELEASE="${META[0]}"; EXPECTED_INDEX="${META[1]}"; EXPECTED_BACKEND="${META[2]}"
ACTUAL_INDEX="$(sha256sum "$FRONTEND_ROOT/index.html" | awk '{print $1}')"
ACTUAL_BACKEND="$(sha256sum "$BACKEND_ROOT/dist/index.js" | awk '{print $1}')"
[[ "$ACTUAL_INDEX" == "$EXPECTED_INDEX" ]] || { echo "生产入口发生漂移，拒绝发布：$ACTUAL_INDEX" >&2; exit 3; }
[[ "$ACTUAL_BACKEND" == "$EXPECTED_BACKEND" ]] || { echo "后端产物发生漂移，拒绝发布：$ACTUAL_BACKEND" >&2; exit 3; }

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/home/ubuntu/backups/releases/${RELEASE}-${STAMP}"
install -d -o root -g root -m 0750 "$BACKUP/frontend" "$BACKUP/backend" "$BACKUP/nginx"
cp -a "$FRONTEND_ROOT/index.html" "$BACKUP/frontend/index.html"
cp -a "$BACKEND_ROOT/dist" "$BACKUP/backend/dist"
cp -a "$NGINX_CONFIG" "$BACKUP/nginx/review-system.conf"
sha256sum "$BACKUP/frontend/index.html" "$BACKUP/backend/dist/index.js" "$BACKUP/nginx/review-system.conf" > "$BACKUP/SHA256SUMS"

CHANGED=0
rollback(){
  code=$?
  trap - ERR INT TERM
  if [[ "$CHANGED" == 1 ]]; then
    rm -rf "$BACKEND_ROOT/dist.rollback-next"
    cp -a "$BACKUP/backend/dist" "$BACKEND_ROOT/dist.rollback-next"
    rm -rf "$BACKEND_ROOT/dist"
    mv "$BACKEND_ROOT/dist.rollback-next" "$BACKEND_ROOT/dist"
    cp -a "$BACKUP/frontend/index.html" "$FRONTEND_ROOT/index.html"
    cp -a "$BACKUP/nginx/review-system.conf" "$NGINX_CONFIG"
    nginx -t && nginx -s reload || true
    systemctl restart "$SERVICE" || true
  fi
  echo "发布失败，已执行回滚；备份：$BACKUP" >&2
  exit "$code"
}
trap rollback ERR INT TERM

CHANGED=1
install -o root -g root -m 0644 "$CANDIDATE/deploy/review-system.conf" "$NGINX_CONFIG.next"
cp -a "$NGINX_CONFIG.next" "$NGINX_CONFIG"
rm -f "$NGINX_CONFIG.next"
nginx -t

rm -rf "$BACKEND_ROOT/dist.release-next"
cp -a "$CANDIDATE/backend/dist" "$BACKEND_ROOT/dist.release-next"
rm -rf "$BACKEND_ROOT/dist"
mv "$BACKEND_ROOT/dist.release-next" "$BACKEND_ROOT/dist"

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
for _ in $(seq 1 30); do curl -fsS --max-time 5 http://127.0.0.1:3002/api/health/ready >/dev/null && break; sleep 1; done
curl -fsS --max-time 10 http://127.0.0.1:3002/api/health/ready >/dev/null
nginx -s reload
curl -fsS --max-time 15 https://www.firstcare.cloud/api/health/ready >/dev/null
install -D -o root -g root -m 0644 "$CANDIDATE/manifest.json" "$FRONTEND_ROOT/releases/$RELEASE/manifest.json"
trap - ERR INT TERM
printf 'DEPLOY_OK=true\nRELEASE=%s\nBACKUP=%s\n' "$RELEASE" "$BACKUP"
