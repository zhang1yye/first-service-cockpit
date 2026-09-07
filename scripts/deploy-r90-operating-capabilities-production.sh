#!/usr/bin/env bash
set -Eeuo pipefail

RELEASE="cockpit-r90-operating-capabilities-20260816-204727"
STAGE="/tmp/${RELEASE}"
FRONTEND_ROOT="/var/www/cockpit"
BACKEND_ROOT="/home/ubuntu/cockpit"
STAMP="$(date +%Y%m%d-%H%M%S)"
FRONTEND_BACKUP="/var/www/cockpit.backups/${RELEASE}-pre-${STAMP}.tar.gz"
BACKEND_BACKUP="/home/ubuntu/backups/${RELEASE}-pre-${STAMP}.tar.gz"

EXPECTED_INDEX_OLD="b7c88d6888f4eef9cefd28225199cd64c01110175cffebd650385c91c0d16c8b"
EXPECTED_INDEX_NEW="438ce60ba3b49f3d32851e7fa88b8d555d61a216600f97ddf04472fcb91b549d"
EXPECTED_FRONTEND_JS="7a0f7f3aec4d88ef3acd9c02514a93adbd3f3162e6b4ed4fbc176b0ce5916fc8"
EXPECTED_FRONTEND_CSS="b808bc10a29416d5972ae865d33f71c2ca2a38d2326827872e76f95e0cb407e5"

SOURCE_PATHS=(
  "src/index.ts"
  "src/operating-capabilities.ts"
  "src/routes/operating-capabilities.ts"
  "src/data-quality-gate.ts"
  "src/project-directory.ts"
  "src/report-archive-generator.ts"
  "src/data-source-copy.ts"
  "src/admin-quality.ts"
  "src/routes/project-profiles.ts"
)
DIST_PATHS=(
  "dist/index.js"
  "dist/operating-capabilities.js"
  "dist/routes/operating-capabilities.js"
  "dist/data-quality-gate.js"
  "dist/project-directory.js"
  "dist/report-archive-generator.js"
  "dist/data-source-copy.js"
  "dist/admin-quality.js"
  "dist/routes/project-profiles.js"
)

declare -A OLD_HASHES=(
  ["src/index.ts"]="28014702607f66c4e52054720a56657c535850ddaad12aaa483b2b58c092f3d4"
  ["src/operating-capabilities.ts"]="ABSENT"
  ["src/routes/operating-capabilities.ts"]="ABSENT"
  ["src/data-quality-gate.ts"]="11c497917b0baff54c867ae7f903422826b8afb75c36f6da81b164904274aea0"
  ["src/project-directory.ts"]="e52c83f79134cc03a6c25e013db4c564c168735493b7fe26927149b3b8df7763"
  ["src/report-archive-generator.ts"]="46d3594fea68e1422568c500a3ac99d6270309e755baba6dd6fa8fccc960cb4b"
  ["src/data-source-copy.ts"]="9ad976b3ed6939938c83455d76421bfdee429a501154cd1e3942ec0f45562013"
  ["src/admin-quality.ts"]="a29ed8759312e84b36e19ea2b95d73eca03b879c3d3f48b88289ebf8041a31b4"
  ["src/routes/project-profiles.ts"]="ce6f72986a042ba43b81ac59151efb7fb2a9527a2fee34ad1206206d406927ac"
  ["dist/index.js"]="2b196aba6590e79fc60174939001452d13a629a7fe65d5a3f8165f6f006230f8"
  ["dist/operating-capabilities.js"]="ABSENT"
  ["dist/routes/operating-capabilities.js"]="ABSENT"
  ["dist/data-quality-gate.js"]="3e3cef5b240fa46470a94f59c553279c4ce21cf546fd0d1994f7b875fb95a23e"
  ["dist/project-directory.js"]="ca690eb4239ff4919ce1d73e7042ed8a14121b683201441a3762f25e8d065095"
  ["dist/report-archive-generator.js"]="a2f92535fbd8d157c5104f11a018be6053a67a6eb9fd7cd5784cd8412a2f8998"
  ["dist/data-source-copy.js"]="96b3b55da92137c22e38fc5348e94d8e4720581222a2f4147824490cc4cc4b0b"
  ["dist/admin-quality.js"]="023d3558f411af1f2e3591614ffdcaefa37e0c0cd336ddd9ceef3b650b318480"
  ["dist/routes/project-profiles.js"]="819b5a2b13ea7fd0160c68e68e14c031b651e5a7cfb383dd6bc3246aa683af2b"
)

declare -A NEW_HASHES=(
  ["src/index.ts"]="55e3c810cf17f03a918a9a793bc3f009dc778ebd3c98b054a47f5fa5ba696869"
  ["src/operating-capabilities.ts"]="8cf31f3b6e4b56621b9089b80ed1e02bc03ef2564784ef4dd2cd3fb3ac0ae07c"
  ["src/routes/operating-capabilities.ts"]="c3ef09479c5e347002c6fb7f604730800c9224bc8d0dac71e65644804d9de0f0"
  ["src/data-quality-gate.ts"]="e50e9a32eb4fd8ad05db5145b929e8c1adf2223663874298efccbe575d51ed3a"
  ["src/project-directory.ts"]="e319cfb58e4c721ae509b915e918d02a8ed29365abc63f1d634755ea8223ff97"
  ["src/report-archive-generator.ts"]="0709db628bafc704113005b363fe6867c97b760aacdfe10208437dc5831afba3"
  ["src/data-source-copy.ts"]="1d96195a81003f0d9c74d445a3c2a50445a47227357e493ed7c0805cf7eeff32"
  ["src/admin-quality.ts"]="8b62ee35538b82c45c6c459d9cde25d5e24d2f740c1c2b274892b90f4992e155"
  ["src/routes/project-profiles.ts"]="d47c7a2305246f63b9b6a56ff12e0bbc8b564f8d1f91387b03f3fce20d2aee72"
  ["dist/index.js"]="86e75d4ca3d67c006e6bb17a4a81be2275f9248d539e6179dcd340b24c24ecf7"
  ["dist/operating-capabilities.js"]="266663d8f854ac6048ec10094ac78cd55ba1919f5f6f874955cb32f70961ae65"
  ["dist/routes/operating-capabilities.js"]="aaa87777f0f5388d9d7f72999a1f121aa455feb62b877ded11217f7f0a46a9dd"
  ["dist/data-quality-gate.js"]="560c828449bbe4b12818e3f695e72558545b2d88e7f3a31fda88a3b6b0d2f2a7"
  ["dist/project-directory.js"]="d15c2452e6750aa8b40241830b6cb20c2489ddaf6898818c2c9be55463b3920c"
  ["dist/report-archive-generator.js"]="9a6a607b7a1d9e4439c54af4b2e69968a6ed9d0f4cd90dd5a79ed12874822e14"
  ["dist/data-source-copy.js"]="c25d268197e57e6cef268f3a0ac98b9cab3e751366e9ca9e7f1db65defa73400"
  ["dist/admin-quality.js"]="b07d05124c40bceb2358beae2cb0474468ef48fad9ed288254e5c81105446cdf"
  ["dist/routes/project-profiles.js"]="bbc068e7dcdfde2f4baa0e5e543252179e10126d9fb7546713b9935d769d2882"
)

hash_of() { sha256sum "$1" | awk '{print $1}'; }

require_hash() {
  local path="$1" expected="$2" actual
  actual="$(hash_of "$path")"
  [[ "$actual" == "$expected" ]] || { echo "哈希不一致: ${path} expected=${expected} actual=${actual}" >&2; exit 1; }
}

require_old_state() {
  local relative="$1" expected="${OLD_HASHES[$1]}" target="$BACKEND_ROOT/$1"
  if [[ "$expected" == "ABSENT" ]]; then
    [[ ! -e "$target" ]] || { echo "预期文件不存在但已出现: $target" >&2; exit 1; }
  else
    require_hash "$target" "$expected"
  fi
}

rollback() {
  local code=$? relative
  trap - ERR
  echo "发布失败，开始恢复R89" >&2
  tar -C "$FRONTEND_ROOT" -xzf "$FRONTEND_BACKUP" || true
  tar -C "$BACKEND_ROOT" -xzf "$BACKEND_BACKUP" || true
  rm -f \
    "$FRONTEND_ROOT/aph2-r90-operating-capabilities-20260816-v1.js" \
    "$FRONTEND_ROOT/aph2-r90-operating-capabilities-20260816-v1.css" \
    "$BACKEND_ROOT/src/operating-capabilities.ts" \
    "$BACKEND_ROOT/src/routes/operating-capabilities.ts" \
    "$BACKEND_ROOT/dist/operating-capabilities.js" \
    "$BACKEND_ROOT/dist/routes/operating-capabilities.js"
  rm -f \
    "$FRONTEND_ROOT/index.html.r90.tmp" \
    "$FRONTEND_ROOT/aph2-r90-operating-capabilities-20260816-v1.js.r90.tmp" \
    "$FRONTEND_ROOT/aph2-r90-operating-capabilities-20260816-v1.css.r90.tmp"
  for relative in "${SOURCE_PATHS[@]}" "${DIST_PATHS[@]}"; do
    rm -f "$BACKEND_ROOT/$relative.r90.tmp"
  done
  systemctl restart first-service-cockpit.service || true
  exit "$code"
}

exec 9>/var/lock/cockpit-release.lock
flock -x 9

require_hash "$FRONTEND_ROOT/index.html" "$EXPECTED_INDEX_OLD"
[[ ! -e "$FRONTEND_ROOT/aph2-r90-operating-capabilities-20260816-v1.js" ]]
[[ ! -e "$FRONTEND_ROOT/aph2-r90-operating-capabilities-20260816-v1.css" ]]
for relative in "${SOURCE_PATHS[@]}" "${DIST_PATHS[@]}"; do require_old_state "$relative"; done

require_hash "$STAGE/frontend/index.expected.html" "$EXPECTED_INDEX_NEW"
require_hash "$STAGE/frontend/aph2-r90-operating-capabilities-20260816-v1.js" "$EXPECTED_FRONTEND_JS"
require_hash "$STAGE/frontend/aph2-r90-operating-capabilities-20260816-v1.css" "$EXPECTED_FRONTEND_CSS"
for relative in "${SOURCE_PATHS[@]}"; do require_hash "$STAGE/backend/server-src/$relative" "${NEW_HASHES[$relative]}"; done
for relative in "${DIST_PATHS[@]}"; do require_hash "$STAGE/backend/server-dist/${relative#dist/}" "${NEW_HASHES[$relative]}"; done

mkdir -p /var/www/cockpit.backups /home/ubuntu/backups
tar -C "$FRONTEND_ROOT" -czf "$FRONTEND_BACKUP" index.html
tar -C "$BACKEND_ROOT" -czf "$BACKEND_BACKUP" \
  src/index.ts src/data-quality-gate.ts src/project-directory.ts src/report-archive-generator.ts \
  src/data-source-copy.ts src/admin-quality.ts src/routes/project-profiles.ts \
  dist/index.js dist/data-quality-gate.js dist/project-directory.js dist/report-archive-generator.js \
  dist/data-source-copy.js dist/admin-quality.js dist/routes/project-profiles.js

trap rollback ERR

install -o root -g root -m 0644 "$STAGE/frontend/index.expected.html" "$FRONTEND_ROOT/index.html.r90.tmp"
install -o root -g root -m 0644 "$STAGE/frontend/aph2-r90-operating-capabilities-20260816-v1.js" "$FRONTEND_ROOT/aph2-r90-operating-capabilities-20260816-v1.js.r90.tmp"
install -o root -g root -m 0644 "$STAGE/frontend/aph2-r90-operating-capabilities-20260816-v1.css" "$FRONTEND_ROOT/aph2-r90-operating-capabilities-20260816-v1.css.r90.tmp"

for relative in "${SOURCE_PATHS[@]}"; do
  target="$BACKEND_ROOT/$relative"
  install -o ubuntu -g ubuntu -m 0644 "$STAGE/backend/server-src/$relative" "${target}.r90.tmp"
  require_hash "${target}.r90.tmp" "${NEW_HASHES[$relative]}"
done
for relative in "${DIST_PATHS[@]}"; do
  target="$BACKEND_ROOT/$relative"
  install -o ubuntu -g ubuntu -m 0644 "$STAGE/backend/server-dist/${relative#dist/}" "${target}.r90.tmp"
  require_hash "${target}.r90.tmp" "${NEW_HASHES[$relative]}"
done
require_hash "$FRONTEND_ROOT/index.html.r90.tmp" "$EXPECTED_INDEX_NEW"
require_hash "$FRONTEND_ROOT/aph2-r90-operating-capabilities-20260816-v1.js.r90.tmp" "$EXPECTED_FRONTEND_JS"
require_hash "$FRONTEND_ROOT/aph2-r90-operating-capabilities-20260816-v1.css.r90.tmp" "$EXPECTED_FRONTEND_CSS"

for relative in "${SOURCE_PATHS[@]}" "${DIST_PATHS[@]}"; do mv "$BACKEND_ROOT/$relative.r90.tmp" "$BACKEND_ROOT/$relative"; done
mv "$FRONTEND_ROOT/aph2-r90-operating-capabilities-20260816-v1.js.r90.tmp" "$FRONTEND_ROOT/aph2-r90-operating-capabilities-20260816-v1.js"
mv "$FRONTEND_ROOT/aph2-r90-operating-capabilities-20260816-v1.css.r90.tmp" "$FRONTEND_ROOT/aph2-r90-operating-capabilities-20260816-v1.css"
mv "$FRONTEND_ROOT/index.html.r90.tmp" "$FRONTEND_ROOT/index.html"

systemctl restart first-service-cockpit.service
systemctl is-active --quiet first-service-cockpit.service
HEALTH_READY=false
for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:3002/api/health >/dev/null; then HEALTH_READY=true; break; fi
  sleep 1
done
[[ "$HEALTH_READY" == "true" ]] || { echo "后端30秒内未通过健康检查" >&2; exit 1; }
[[ "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/api/operating-capabilities)" == "401" ]]

require_hash "$FRONTEND_ROOT/index.html" "$EXPECTED_INDEX_NEW"
require_hash "$FRONTEND_ROOT/aph2-r90-operating-capabilities-20260816-v1.js" "$EXPECTED_FRONTEND_JS"
require_hash "$FRONTEND_ROOT/aph2-r90-operating-capabilities-20260816-v1.css" "$EXPECTED_FRONTEND_CSS"
for relative in "${SOURCE_PATHS[@]}" "${DIST_PATHS[@]}"; do require_hash "$BACKEND_ROOT/$relative" "${NEW_HASHES[$relative]}"; done

trap - ERR
echo "release=${RELEASE}"
echo "frontend_backup=${FRONTEND_BACKUP}"
echo "backend_backup=${BACKEND_BACKUP}"
echo "service=active"
echo "health=ok"
echo "unauthenticated_capabilities=401"
