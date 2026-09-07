#!/usr/bin/env bash
set -Eeuo pipefail

DB_PATH="${DB_PATH:-${1:-/home/ubuntu/cockpit/cockpit.db}}"
BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/cockpit/backups/database}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "BACKUP_ERROR=database_not_found path=$DB_PATH" >&2
  exit 2
fi
command -v sqlite3 >/dev/null || { echo "BACKUP_ERROR=sqlite3_not_found" >&2; exit 3; }
command -v sha256sum >/dev/null || { echo "BACKUP_ERROR=sha256sum_not_found" >&2; exit 3; }
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASENAME="cockpit-${STAMP}.db"
BACKUP_PATH="$BACKUP_DIR/$BASENAME"
TMP_PATH="$BACKUP_PATH.partial"
trap 'rm -f "$TMP_PATH"' EXIT

sqlite3 "$DB_PATH" ".timeout 10000" ".backup '$TMP_PATH'"
INTEGRITY="$(sqlite3 "$TMP_PATH" 'PRAGMA integrity_check;')"
[[ "$INTEGRITY" == "ok" ]] || { echo "BACKUP_ERROR=integrity_check_failed result=$INTEGRITY" >&2; exit 4; }
mv "$TMP_PATH" "$BACKUP_PATH"
chmod 600 "$BACKUP_PATH"
sha256sum "$BACKUP_PATH" > "$BACKUP_PATH.sha256"
chmod 600 "$BACKUP_PATH.sha256"
find "$BACKUP_DIR" -type f \( -name 'cockpit-*.db' -o -name 'cockpit-*.db.sha256' \) -mtime "+$RETENTION_DAYS" -delete

SIZE="$(wc -c < "$BACKUP_PATH" | tr -d ' ')"
echo "BACKUP_OK=true"
echo "BACKUP_PATH=$BACKUP_PATH"
echo "BACKUP_SIZE=$SIZE"
echo "INTEGRITY_CHECK=ok"
echo "CHECKSUM_FILE=$BACKUP_PATH.sha256"
