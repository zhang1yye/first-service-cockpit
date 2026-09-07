#!/usr/bin/env bash
set -euo pipefail

RUN_USER="${DEPLOY_USER:-${SUDO_USER:-$(id -un)}}"
RUN_GROUP="$(id -gn "$RUN_USER")"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
if [ -z "$RUN_HOME" ]; then
  echo "错误：无法确定部署用户 $RUN_USER 的主目录。"
  exit 1
fi

APP_DIR="${1:-$RUN_HOME/first-service-review-system}"
PUBLIC_ORIGIN="${2:-https://firstcare.cloud}"
HERMES_KEY="${HERMES_API_KEY:-${AI_REVIEW_API_KEY:-}}"
CORS_ALLOWED_ORIGINS="${CORS_ORIGIN:-$PUBLIC_ORIGIN}"
WEB_DIR="${WEB_DIR:-/var/www/first-service-dashboard}"
SERVICE_FILE="/etc/systemd/system/first-service-review-api.service"
HERMES_SERVICE_FILE="/etc/systemd/system/first-service-hermes-gateway.service"
NGINX_FILE="/etc/nginx/sites-available/first-service-review-system"
ENV_DIR="/etc/first-service"
API_ENV_FILE="$ENV_DIR/review-api.env"
HERMES_ENV_FILE="$ENV_DIR/hermes-gateway.env"
HERMES_RUNTIME_DIR="$RUN_HOME/.first-service-hermes-runtime"
STORE_FILE="$APP_DIR/backend/data/store.json"
BOOTSTRAP_PASSWORD="${BOOTSTRAP_ADMIN_PASSWORD:-}"
NEEDS_BOOTSTRAP=0
SSO_SECRET_VALUE="${REVIEW_SSO_SECRET:-}"
SSO_SECRET_PATH="${REVIEW_SSO_SECRET_FILE:-$RUN_HOME/.cockpit_review_sso_secret}"

escape_env_file_value() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

write_api_env_file() {
  local target_file="$1"
  local include_bootstrap="${2:-0}"
  {
    printf 'NODE_ENV=production\nPORT=3001\n'
    printf 'AI_REVIEW_PROVIDER=hermes\nAI_REVIEW_MODEL=hermes-eight-profile-v1\n'
    printf 'AI_REVIEW_BASE_URL=http://127.0.0.1:3100/v1\n'
    printf 'CORS_ORIGIN='
    escape_env_file_value "$CORS_ALLOWED_ORIGINS"
    printf '\nAI_REVIEW_API_KEY='
    escape_env_file_value "$HERMES_KEY"
    if [ -n "$SSO_SECRET_VALUE" ]; then
      printf '\nREVIEW_SSO_SECRET='
      escape_env_file_value "$SSO_SECRET_VALUE"
    else
      printf '\nREVIEW_SSO_SECRET_FILE='
      escape_env_file_value "$SSO_SECRET_PATH"
    fi
    if [ "$include_bootstrap" = "1" ]; then
      printf '\nBOOTSTRAP_ADMIN_PASSWORD='
      escape_env_file_value "$BOOTSTRAP_PASSWORD"
    fi
    printf '\n'
  } > "$target_file"
}

if [ -z "$HERMES_KEY" ]; then
  echo "错误：未配置正式 Hermes 密钥。请先 export HERMES_API_KEY='正式强密钥' 后再部署。"
  exit 1
fi

if [[ "$HERMES_KEY" == *$'\n'* || "$HERMES_KEY" == *$'\r'* ]]; then
  echo "错误：Hermes 密钥不能包含换行符。"
  exit 1
fi

if [[ "$CORS_ALLOWED_ORIGINS" == *$'\n'* || "$CORS_ALLOWED_ORIGINS" == *$'\r'* ]]; then
  echo "错误：CORS_ORIGIN 不能包含换行符。"
  exit 1
fi

if [[ "$SSO_SECRET_VALUE" == *$'\n'* || "$SSO_SECRET_VALUE" == *$'\r'* || "$SSO_SECRET_PATH" == *$'\n'* || "$SSO_SECRET_PATH" == *$'\r'* ]]; then
  echo "错误：单点登录密钥或密钥路径不能包含换行符。"
  exit 1
fi

if [ -n "$SSO_SECRET_VALUE" ] && [ "${#SSO_SECRET_VALUE}" -lt 32 ]; then
  echo "错误：REVIEW_SSO_SECRET 至少需要 32 个字符。"
  exit 1
fi

if [ ! -s "$STORE_FILE" ]; then
  NEEDS_BOOTSTRAP=1
  if [ -z "$BOOTSTRAP_PASSWORD" ]; then
    echo "错误：首次部署需要通过 BOOTSTRAP_ADMIN_PASSWORD 提供非默认强密码。"
    exit 1
  fi
  if [[ "$BOOTSTRAP_PASSWORD" == *$'\n'* || "$BOOTSTRAP_PASSWORD" == *$'\r'* ]]; then
    echo "错误：初始管理员密码不能包含换行符。"
    exit 1
  fi
fi

TEMP_ENV_DIR="$(mktemp -d)"
trap 'rm -f "$TEMP_ENV_DIR/review-api.env" "$TEMP_ENV_DIR/hermes-gateway.env" "$TEMP_ENV_DIR/review-sso.secret"; rmdir "$TEMP_ENV_DIR"' EXIT
umask 077

if [ -z "$SSO_SECRET_VALUE" ] && [ ! -s "$SSO_SECRET_PATH" ]; then
  /usr/bin/node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))" > "$TEMP_ENV_DIR/review-sso.secret"
  sudo install -m 0600 -o "$RUN_USER" -g "$RUN_GROUP" "$TEMP_ENV_DIR/review-sso.secret" "$SSO_SECRET_PATH"
fi

if [ -z "$SSO_SECRET_VALUE" ] && ! sudo -u "$RUN_USER" test -r "$SSO_SECRET_PATH"; then
  echo "错误：部署用户无法读取单点登录密钥文件 $SSO_SECRET_PATH。"
  exit 1
fi

write_api_env_file "$TEMP_ENV_DIR/review-api.env" "$NEEDS_BOOTSTRAP"

{
  printf 'NODE_ENV=production\nPORT=3100\nHERMES_MODEL=hermes-eight-profile-v1\n'
  printf 'HERMES_AGENT_HOME='
  escape_env_file_value "$HERMES_RUNTIME_DIR"
  printf '\nCORS_ORIGIN='
  escape_env_file_value "$CORS_ALLOWED_ORIGINS"
  printf '\nHERMES_API_KEY='
  escape_env_file_value "$HERMES_KEY"
  printf '\n'
} > "$TEMP_ENV_DIR/hermes-gateway.env"

echo "=== 构建前端 ==="
cd "$APP_DIR/frontend"
npm install
npm run build

echo "=== 部署静态文件 ==="
sudo mkdir -p "$WEB_DIR"
sudo rsync -a --delete dist/ "$WEB_DIR/"

echo "=== 安装后端依赖 ==="
cd "$APP_DIR/backend"
npm install --omit=dev

echo "=== 安装 Hermes 依赖 ==="
cd "$APP_DIR/hermes"
npm install --omit=dev

echo "=== 配置 systemd 服务 ==="
sudo install -d -m 0750 -o root -g root "$ENV_DIR"
sudo install -m 0600 -o root -g root "$TEMP_ENV_DIR/review-api.env" "$API_ENV_FILE"
sudo install -m 0600 -o root -g root "$TEMP_ENV_DIR/hermes-gateway.env" "$HERMES_ENV_FILE"
sudo install -d -m 0700 -o "$RUN_USER" -g "$RUN_GROUP" "$APP_DIR/backend/data" "$HERMES_RUNTIME_DIR"

sudo tee "$SERVICE_FILE" >/dev/null <<SERVICE
[Unit]
Description=First Service Review System API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/backend
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
EnvironmentFile=/etc/first-service/review-api.env
User=$RUN_USER
Group=$RUN_GROUP
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$APP_DIR/backend/data
ProtectClock=true
ProtectControlGroups=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectHostname=true
LockPersonality=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
SERVICE

sudo tee "$HERMES_SERVICE_FILE" >/dev/null <<SERVICE
[Unit]
Description=First Service Hermes Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/hermes
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
EnvironmentFile=/etc/first-service/hermes-gateway.env
User=$RUN_USER
Group=$RUN_GROUP
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$HERMES_RUNTIME_DIR
ProtectClock=true
ProtectControlGroups=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectHostname=true
LockPersonality=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
SERVICE

echo "=== 配置 Nginx ==="
sudo tee "$NGINX_FILE" >/dev/null < "$APP_DIR/nginx.conf"
sudo ln -sf "$NGINX_FILE" /etc/nginx/sites-enabled/first-service-review-system

echo "=== 重载服务 ==="
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now first-service-review-api
sudo systemctl enable --now first-service-hermes-gateway
sudo systemctl restart first-service-review-api
sudo systemctl restart first-service-hermes-gateway
sudo systemctl reload nginx

if [ "$NEEDS_BOOTSTRAP" = "1" ]; then
  for _attempt in $(seq 1 30); do
    [ -s "$STORE_FILE" ] && break
    sleep 1
  done
  if [ ! -s "$STORE_FILE" ]; then
    echo "错误：审核 API 未能在 30 秒内完成首次数据初始化。"
    sudo systemctl --no-pager --full status first-service-review-api || true
    exit 1
  fi

  write_api_env_file "$TEMP_ENV_DIR/review-api.env" 0
  sudo install -m 0600 -o root -g root "$TEMP_ENV_DIR/review-api.env" "$API_ENV_FILE"
  unset BOOTSTRAP_ADMIN_PASSWORD BOOTSTRAP_PASSWORD
  sudo systemctl restart first-service-review-api
fi

echo "=== 部署完成 ==="
echo "请访问 $PUBLIC_ORIGIN"
echo "API Health: $PUBLIC_ORIGIN/api/health"
echo "Hermes Base URL: $PUBLIC_ORIGIN/hermes/v1"
echo "Hermes Health: $PUBLIC_ORIGIN/hermes/health"
echo "Hermes Profile 检查需要 Authorization: Bearer <HERMES_API_KEY>"
echo "上线后请在系统设置页执行“测试 AI 连接”和“检查 Profile 接入”。"
