#!/usr/bin/env bash
set -Eeuo pipefail

RELEASE="cockpit-r89-ai-opinion-20260816-194449"
STAGE="/tmp/${RELEASE}"
FRONTEND_ROOT="/var/www/cockpit"
BACKEND_ROOT="/home/ubuntu/cockpit"
STAMP="$(date +%Y%m%d-%H%M%S)"
FRONTEND_BACKUP="/var/www/cockpit.backups/${RELEASE}-pre-${STAMP}.tar.gz"
BACKEND_BACKUP="/home/ubuntu/backups/${RELEASE}-pre-${STAMP}.tar.gz"

EXPECTED_INDEX_OLD="c2418baddd9ad9a2a932ee06275c80bbfdb3a84d5554da6471c9b7ecdc4600d6"
EXPECTED_DEFER_OLD="12b887949afb518629fc2260f37894519190f21cca9b52df9cd579131f34cd61"
EXPECTED_CSS_OLD="60348ce8af4f2b1f73b2e88c9f3ebe34ffb5884c67218ce2ef374b852609df2b"
EXPECTED_SRC_ORCHESTRATOR_OLD="25dc20d30479882b5cef0a6abf821a2e31e3bb7e64e56f3a02031e5a2525c631"
EXPECTED_SRC_ROUTE_OLD="bbc3f5b6fe08d260d6d043ec5baa8fde4af259a876e9a8a37018a33a835ceb79"
EXPECTED_DIST_ORCHESTRATOR_OLD="e4e7371c7c01fd13f6f743cb9195720661a8b18d5c612367aa5a1af5d0d3ad1b"
EXPECTED_DIST_ROUTE_OLD="8a58e2338eb49e97a81d90d028841a65fe0dba049fdfec73dbc1944b7ff279bd"

EXPECTED_INDEX_NEW="b7c88d6888f4eef9cefd28225199cd64c01110175cffebd650385c91c0d16c8b"
EXPECTED_DEFER_NEW="f38cf80c3e824dc884bf4a14b0212eca3d2a907952e53a1e0f3359ddb846916b"
EXPECTED_CSS_NEW="7c80fdfb73d2ff7bd99932990cbe74a8e07d2c458890c0640ae41df38adec200"
EXPECTED_SRC_ORCHESTRATOR_NEW="ef0f4e5333c895826e7cca1a69701879f350b3057505f824eb6c82675219fbeb"
EXPECTED_SRC_ROUTE_NEW="1ea13322175e9f79c6b3ca582c7b099e7c3c89e01d3efe09af3d38f229ce3a03"
EXPECTED_DIST_ORCHESTRATOR_NEW="b5c7fb4e58ad6575cf9b339ea8f4d1cce8b97bd0ca7d3e06841b96a5fd8965af"
EXPECTED_DIST_ROUTE_NEW="67f83ff6012a2ef240a91ab05433c707a0d22554f939f7e8aa7f64a707be37f5"

hash_of() {
  sha256sum "$1" | awk '{print $1}'
}

require_hash() {
  local path="$1"
  local expected="$2"
  local actual
  actual="$(hash_of "$path")"
  if [[ "$actual" != "$expected" ]]; then
    echo "哈希不一致: ${path} expected=${expected} actual=${actual}" >&2
    exit 1
  fi
}

rollback() {
  local code=$?
  trap - ERR
  echo "发布失败，开始恢复备份" >&2
  if [[ -f "$FRONTEND_BACKUP" ]]; then
    tar -C /var/www -xzf "$FRONTEND_BACKUP"
  fi
  if [[ -f "$BACKEND_BACKUP" ]]; then
    tar -C "$BACKEND_ROOT" -xzf "$BACKEND_BACKUP"
  fi
  systemctl restart first-service-cockpit.service || true
  exit "$code"
}

exec 9>/var/lock/cockpit-release.lock
flock -x 9

require_hash "$STAGE/frontend/index.expected.html" "$EXPECTED_INDEX_NEW"
require_hash "$STAGE/frontend/cockpit-bundle-defer-20260816-r89-ai-opinion.js" "$EXPECTED_DEFER_NEW"
require_hash "$STAGE/frontend/cockpit-bundle-20260816-r89-ai-opinion.css" "$EXPECTED_CSS_NEW"
require_hash "$STAGE/backend/src/assistant-orchestrator.ts" "$EXPECTED_SRC_ORCHESTRATOR_NEW"
require_hash "$STAGE/backend/src/regional-assistant.ts" "$EXPECTED_SRC_ROUTE_NEW"
require_hash "$STAGE/backend/dist/assistant-orchestrator.js" "$EXPECTED_DIST_ORCHESTRATOR_NEW"
require_hash "$STAGE/backend/dist/regional-assistant.js" "$EXPECTED_DIST_ROUTE_NEW"

require_hash "$FRONTEND_ROOT/index.html" "$EXPECTED_INDEX_OLD"
require_hash "$FRONTEND_ROOT/assets/cockpit-bundle-defer-20260816.js" "$EXPECTED_DEFER_OLD"
require_hash "$FRONTEND_ROOT/assets/cockpit-bundle-20260816.css" "$EXPECTED_CSS_OLD"
require_hash "$BACKEND_ROOT/src/assistant-orchestrator.ts" "$EXPECTED_SRC_ORCHESTRATOR_OLD"
require_hash "$BACKEND_ROOT/src/routes/regional-assistant.ts" "$EXPECTED_SRC_ROUTE_OLD"
require_hash "$BACKEND_ROOT/dist/assistant-orchestrator.js" "$EXPECTED_DIST_ORCHESTRATOR_OLD"
require_hash "$BACKEND_ROOT/dist/routes/regional-assistant.js" "$EXPECTED_DIST_ROUTE_OLD"

mkdir -p /var/www/cockpit.backups /home/ubuntu/backups
tar -C /var/www -czf "$FRONTEND_BACKUP" cockpit
tar -C "$BACKEND_ROOT" -czf "$BACKEND_BACKUP" \
  src/assistant-orchestrator.ts \
  src/routes/regional-assistant.ts \
  dist/assistant-orchestrator.js \
  dist/routes/regional-assistant.js

trap rollback ERR

install -o root -g root -m 0644 "$STAGE/frontend/cockpit-bundle-defer-20260816-r89-ai-opinion.js" "$FRONTEND_ROOT/assets/.cockpit-bundle-defer-20260816-r89-ai-opinion.js.tmp"
install -o root -g root -m 0644 "$STAGE/frontend/cockpit-bundle-20260816-r89-ai-opinion.css" "$FRONTEND_ROOT/assets/.cockpit-bundle-20260816-r89-ai-opinion.css.tmp"
install -o root -g root -m 0644 "$STAGE/frontend/index.expected.html" "$FRONTEND_ROOT/.index-r89-ai-opinion.tmp"
install -o ubuntu -g ubuntu -m 0644 "$STAGE/backend/src/assistant-orchestrator.ts" "$BACKEND_ROOT/src/.assistant-orchestrator.ts.r89.tmp"
install -o ubuntu -g ubuntu -m 0644 "$STAGE/backend/src/regional-assistant.ts" "$BACKEND_ROOT/src/routes/.regional-assistant.ts.r89.tmp"
install -o ubuntu -g ubuntu -m 0644 "$STAGE/backend/dist/assistant-orchestrator.js" "$BACKEND_ROOT/dist/.assistant-orchestrator.js.r89.tmp"
install -o ubuntu -g ubuntu -m 0644 "$STAGE/backend/dist/regional-assistant.js" "$BACKEND_ROOT/dist/routes/.regional-assistant.js.r89.tmp"

require_hash "$FRONTEND_ROOT/.index-r89-ai-opinion.tmp" "$EXPECTED_INDEX_NEW"
require_hash "$FRONTEND_ROOT/assets/.cockpit-bundle-defer-20260816-r89-ai-opinion.js.tmp" "$EXPECTED_DEFER_NEW"
require_hash "$FRONTEND_ROOT/assets/.cockpit-bundle-20260816-r89-ai-opinion.css.tmp" "$EXPECTED_CSS_NEW"
require_hash "$BACKEND_ROOT/src/.assistant-orchestrator.ts.r89.tmp" "$EXPECTED_SRC_ORCHESTRATOR_NEW"
require_hash "$BACKEND_ROOT/src/routes/.regional-assistant.ts.r89.tmp" "$EXPECTED_SRC_ROUTE_NEW"
require_hash "$BACKEND_ROOT/dist/.assistant-orchestrator.js.r89.tmp" "$EXPECTED_DIST_ORCHESTRATOR_NEW"
require_hash "$BACKEND_ROOT/dist/routes/.regional-assistant.js.r89.tmp" "$EXPECTED_DIST_ROUTE_NEW"

mv "$BACKEND_ROOT/src/.assistant-orchestrator.ts.r89.tmp" "$BACKEND_ROOT/src/assistant-orchestrator.ts"
mv "$BACKEND_ROOT/src/routes/.regional-assistant.ts.r89.tmp" "$BACKEND_ROOT/src/routes/regional-assistant.ts"
mv "$BACKEND_ROOT/dist/.assistant-orchestrator.js.r89.tmp" "$BACKEND_ROOT/dist/assistant-orchestrator.js"
mv "$BACKEND_ROOT/dist/routes/.regional-assistant.js.r89.tmp" "$BACKEND_ROOT/dist/routes/regional-assistant.js"
mv "$FRONTEND_ROOT/assets/.cockpit-bundle-defer-20260816-r89-ai-opinion.js.tmp" "$FRONTEND_ROOT/assets/cockpit-bundle-defer-20260816-r89-ai-opinion.js"
mv "$FRONTEND_ROOT/assets/.cockpit-bundle-20260816-r89-ai-opinion.css.tmp" "$FRONTEND_ROOT/assets/cockpit-bundle-20260816-r89-ai-opinion.css"
mv "$FRONTEND_ROOT/.index-r89-ai-opinion.tmp" "$FRONTEND_ROOT/index.html"

systemctl restart first-service-cockpit.service
systemctl is-active --quiet first-service-cockpit.service
HEALTH_READY="false"
for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:3002/api/health >/dev/null; then
    HEALTH_READY="true"
    break
  fi
  sleep 1
done
if [[ "$HEALTH_READY" != "true" ]]; then
  echo "后端在30秒内未通过健康检查" >&2
  exit 1
fi

require_hash "$FRONTEND_ROOT/index.html" "$EXPECTED_INDEX_NEW"
require_hash "$FRONTEND_ROOT/assets/cockpit-bundle-defer-20260816-r89-ai-opinion.js" "$EXPECTED_DEFER_NEW"
require_hash "$FRONTEND_ROOT/assets/cockpit-bundle-20260816-r89-ai-opinion.css" "$EXPECTED_CSS_NEW"
require_hash "$BACKEND_ROOT/src/assistant-orchestrator.ts" "$EXPECTED_SRC_ORCHESTRATOR_NEW"
require_hash "$BACKEND_ROOT/src/routes/regional-assistant.ts" "$EXPECTED_SRC_ROUTE_NEW"
require_hash "$BACKEND_ROOT/dist/assistant-orchestrator.js" "$EXPECTED_DIST_ORCHESTRATOR_NEW"
require_hash "$BACKEND_ROOT/dist/routes/regional-assistant.js" "$EXPECTED_DIST_ROUTE_NEW"

trap - ERR
echo "release=${RELEASE}"
echo "frontend_backup=${FRONTEND_BACKUP}"
echo "backend_backup=${BACKEND_BACKUP}"
echo "service=active"
echo "health=ok"
