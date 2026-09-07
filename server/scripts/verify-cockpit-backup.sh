#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_PATH="${1:-}"
[[ -n "$BACKUP_PATH" && -f "$BACKUP_PATH" ]] || { echo "VERIFY_ERROR=backup_not_found" >&2; exit 2; }
command -v sqlite3 >/dev/null || { echo "VERIFY_ERROR=sqlite3_not_found" >&2; exit 3; }
command -v sha256sum >/dev/null || { echo "VERIFY_ERROR=sha256sum_not_found" >&2; exit 3; }
if [[ -f "$BACKUP_PATH.sha256" ]]; then
  (cd "$(dirname "$BACKUP_PATH")" && sha256sum -c "$(basename "$BACKUP_PATH.sha256")" >/dev/null)
fi
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cockpit-restore-XXXXXX")"
RESTORED="$TMP_DIR/restored.db"
trap 'rm -rf "$TMP_DIR"' EXIT

sqlite3 "$BACKUP_PATH" ".timeout 10000" ".backup '$RESTORED'"
INTEGRITY="$(sqlite3 "$RESTORED" 'PRAGMA integrity_check;')"
[[ "$INTEGRITY" == "ok" ]] || { echo "VERIFY_ERROR=integrity_check_failed result=$INTEGRITY" >&2; exit 4; }
REQUIRED_TABLES=(users projects management_tasks operation_logs)
for table in "${REQUIRED_TABLES[@]}"; do
  EXISTS="$(sqlite3 "$RESTORED" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='$table';")"
  [[ "$EXISTS" == "1" ]] || { echo "VERIFY_ERROR=missing_table table=$table" >&2; exit 5; }
done
PROJECTS="$(sqlite3 "$RESTORED" 'SELECT COUNT(*) FROM projects;')"
TASKS="$(sqlite3 "$RESTORED" 'SELECT COUNT(*) FROM management_tasks;')"
LOGS="$(sqlite3 "$RESTORED" 'SELECT COUNT(*) FROM operation_logs;')"

echo "RESTORE_VERIFY_OK=true"
echo "INTEGRITY_CHECK=ok"
echo "REQUIRED_TABLES_OK=${REQUIRED_TABLES[*]}"
echo "PROJECT_COUNT=$PROJECTS"
echo "TASK_COUNT=$TASKS"
echo "LOG_COUNT=$LOGS"
echo "TEMP_RESTORE_CLEANUP=scheduled"
