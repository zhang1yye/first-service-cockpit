#!/usr/bin/env python3
"""Safely quarantine the known cockpit demo-data chain.

Default mode is read-only. Apply mode requires the exact source database SHA-256
and an explicit, verified backup destination. Exact fingerprint-matched rows are
moved into data_quarantine in one SQLite transaction, and retained business rows
must remain byte-for-byte identical at the logical record level.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sqlite3
from pathlib import Path
from typing import Iterable

DEMO_NAMES = (
    '朝阳万国城MOMΛ',
    '朝阳当代MOMΛ',
    '通州万国城MOMΛ',
    '亦庄创意生活广场',
    '海淀西山上品湾MOMΛ',
    '上第MOMΛ',
    '顺义MOMΛ万万树',
    '石家庄当代府MOMΛ',
    '天津海河大观',
    '沈阳当代RIVER MOMΛ',
)
DEMO_FORMAL_FILE_SHA256 = {
    '888ea0f27d5a97da83fc00324fb0c6c078b56621c02731006f66a60c0e0e1548',
    'ff65e67b25a1005bbb929d2fbf30c6e1893505b897bc40c91b340dbb0de5627e',
    '22ded4abe7688e38c601cf94e6175c368209144182fe4b2a2da213d758eb6700',
    '79374a16b87ca88794b93f0848d6bb349f3266f3072e036ad5d3c24679afe14b',
    '41a1d6a9ff3d475a125f13e9e4a825aea56ffcf4111c697a34457ad7756a9862',
    '078a89ed93061a4eeb82d5f2e15ef5d3fd26cb8e408011bd4055d6bcdf1d1c26',
}

QUARANTINE_DDL = (
    """CREATE TABLE IF NOT EXISTS data_quarantine (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_key TEXT NOT NULL,
      source_table TEXT NOT NULL,
      source_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'quarantined',
      quarantined_by TEXT NOT NULL,
      quarantined_at TEXT NOT NULL,
      restored_by TEXT DEFAULT '',
      restored_at TEXT DEFAULT '',
      UNIQUE(batch_key, source_table, source_id)
    )""",
    """CREATE INDEX IF NOT EXISTS idx_data_quarantine_status
      ON data_quarantine(status, source_table, id)""",
)
DELETE_ORDER = (
    'forecast_workflow_versions', 'project_forecasts', 'project_monthly_snapshots',
    'project_id_aliases', 'management_tasks', 'weekly_meeting_items',
    'weekly_meetings', 'report_archives', 'formal_output_archives', 'projects',
    'project_backups', 'import_previews',
)
SHA256_RE = re.compile(r'^[0-9a-fA-F]{64}$')


def rows(conn: sqlite3.Connection, sql: str, params: Iterable[object] = ()) -> list[dict]:
    return [dict(row) for row in conn.execute(sql, tuple(params)).fetchall()]


def placeholders(values: Iterable[object]) -> str:
    return ','.join('?' for _ in values)


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def logical_sha256(conn: sqlite3.Connection) -> str:
    digest = hashlib.sha256()
    for statement in conn.iterdump():
        digest.update(statement.encode('utf-8'))
        digest.update(b'\n')
    return digest.hexdigest()


def verify_database(conn: sqlite3.Connection) -> dict[str, object]:
    integrity = str(conn.execute('PRAGMA integrity_check').fetchone()[0])
    foreign_key_violations = len(conn.execute('PRAGMA foreign_key_check').fetchall())
    return {
        'ok': integrity == 'ok' and foreign_key_violations == 0,
        'integrity_check': integrity,
        'foreign_key_violations': foreign_key_violations,
    }


def collect_targets(conn: sqlite3.Connection) -> dict[str, list[dict]]:
    projects = rows(
        conn,
        f"SELECT * FROM projects WHERE name IN ({placeholders(DEMO_NAMES)}) ORDER BY id",
        DEMO_NAMES,
    )
    project_ids = tuple(row['id'] for row in projects) or (-1,)
    id_marks = placeholders(project_ids)
    name_marks = placeholders(DEMO_NAMES)
    params = (*project_ids, *DEMO_NAMES)

    targets: dict[str, list[dict]] = {}
    targets['forecast_workflow_versions'] = rows(
        conn,
        f"SELECT * FROM forecast_workflow_versions WHERE project_id IN ({id_marks}) OR project_name IN ({name_marks}) ORDER BY id",
        params,
    )
    targets['project_forecasts'] = rows(
        conn,
        f"SELECT * FROM project_forecasts WHERE project_id IN ({id_marks}) OR project_name IN ({name_marks}) ORDER BY id",
        params,
    )
    targets['project_monthly_snapshots'] = rows(
        conn,
        f"SELECT * FROM project_monthly_snapshots WHERE project_id IN ({id_marks}) OR project_name IN ({name_marks}) ORDER BY id",
        params,
    )
    targets['project_id_aliases'] = rows(
        conn,
        f"SELECT * FROM project_id_aliases WHERE current_project_id IN ({id_marks}) OR project_name IN ({name_marks}) ORDER BY id",
        params,
    )
    targets['weekly_meeting_items'] = rows(
        conn,
        f"SELECT * FROM weekly_meeting_items WHERE project_id IN ({id_marks}) OR project_name IN ({name_marks}) ORDER BY id",
        params,
    )

    demo_meeting_ids = sorted({row['meeting_id'] for row in targets['weekly_meeting_items']})
    safe_meetings = []
    if demo_meeting_ids:
        meeting_marks = placeholders(demo_meeting_ids)
        for meeting in rows(conn, f"SELECT * FROM weekly_meetings WHERE id IN ({meeting_marks}) ORDER BY id", demo_meeting_ids):
            all_items = rows(conn, 'SELECT * FROM weekly_meeting_items WHERE meeting_id=? ORDER BY id', (meeting['id'],))
            selected = sum(1 for item in targets['weekly_meeting_items'] if item['meeting_id'] == meeting['id'])
            # Keep mixed meeting shells and their non-demo items.
            if all_items and selected == len(all_items):
                safe_meetings.append(meeting)
    targets['weekly_meetings'] = safe_meetings

    management_tasks = rows(
        conn,
        f"SELECT * FROM management_tasks WHERE project_id IN ({id_marks}) OR project_name IN ({name_marks}) ORDER BY id",
        params,
    )
    selected_task_ids = {row['id'] for row in management_tasks}
    for task in rows(conn, "SELECT * FROM management_tasks WHERE source_type IN ('monthly-report','weekly-meeting') ORDER BY id"):
        text = f"{task.get('project_name', '')} {task.get('action', '')} {task.get('source_id', '')}"
        if any(name in text for name in DEMO_NAMES) and task['id'] not in selected_task_ids:
            management_tasks.append(task)
            selected_task_ids.add(task['id'])
    targets['management_tasks'] = sorted(management_tasks, key=lambda row: row['id'])

    targets['report_archives'] = [
        row for row in rows(conn, 'SELECT * FROM report_archives ORDER BY id')
        if any(name in str(row.get('payload', '')) for name in DEMO_NAMES)
    ]
    formal_outputs = []
    for row in rows(conn, 'SELECT * FROM formal_output_archives ORDER BY id'):
        try:
            files = json.loads(row.get('files_json') or '{}')
        except json.JSONDecodeError:
            files = {}
        file_hashes = {str(meta.get('sha256', '')) for meta in files.values() if isinstance(meta, dict)}
        if file_hashes & DEMO_FORMAL_FILE_SHA256:
            formal_outputs.append(row)
    targets['formal_output_archives'] = formal_outputs
    targets['project_backups'] = [
        row for row in rows(conn, 'SELECT * FROM project_backups ORDER BY id')
        if any(name in str(row.get('payload', '')) for name in DEMO_NAMES)
    ]
    targets['import_previews'] = [
        row for row in rows(conn, 'SELECT * FROM import_previews ORDER BY id')
        if any(name in str(row.get('payload', '')) for name in DEMO_NAMES)
    ]
    targets['projects'] = projects
    return targets


def target_manifest(targets: dict[str, list[dict]]) -> dict[str, dict[str, object]]:
    return {
        table: {
            'count': len(table_rows),
            'source_ids': [str(row.get('id', '')) for row in table_rows],
        }
        for table, table_rows in targets.items()
    }


def retained_manifest(conn: sqlite3.Connection, targets: dict[str, list[dict]]) -> dict[str, dict[str, object]]:
    manifest: dict[str, dict[str, object]] = {}
    for table in DELETE_ORDER:
        target_ids = {str(row.get('id', '')) for row in targets.get(table, [])}
        retained = [row for row in rows(conn, f'SELECT * FROM "{table}" ORDER BY id') if str(row.get('id', '')) not in target_ids]
        manifest[table] = {
            'count': len(retained),
            'sha256': hashlib.sha256(canonical_json(retained).encode('utf-8')).hexdigest(),
        }
    return manifest


def create_verified_backup(conn: sqlite3.Connection, source_path: Path, backup_path: Path) -> dict[str, object]:
    if backup_path == source_path:
        raise RuntimeError('backup path must differ from database path')
    if backup_path.exists():
        raise RuntimeError(f'backup already exists; refusing to overwrite: {backup_path}')
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    backup_conn = sqlite3.connect(str(backup_path))
    backup_conn.row_factory = sqlite3.Row
    try:
        conn.backup(backup_conn)
        verification = verify_database(backup_conn)
        source_logical_sha256 = logical_sha256(conn)
        backup_logical_sha256 = logical_sha256(backup_conn)
    finally:
        backup_conn.close()
    logical_match = source_logical_sha256 == backup_logical_sha256
    if not verification['ok'] or not logical_match:
        backup_path.unlink(missing_ok=True)
        raise RuntimeError('backup verification failed')
    return {
        'path': str(backup_path),
        'sha256': sha256_file(backup_path),
        'verification': verification,
        'logical_match': logical_match,
        'source_logical_sha256': source_logical_sha256,
        'backup_logical_sha256': backup_logical_sha256,
    }


def quarantine(conn: sqlite3.Connection, targets: dict[str, list[dict]], batch: str, operator: str) -> dict[str, int]:
    stamp = dt.datetime.now(dt.timezone.utc).isoformat()
    counts: dict[str, int] = {}
    for table in DELETE_ORDER:
        table_rows = targets.get(table, [])
        for row in table_rows:
            conn.execute(
                """INSERT INTO data_quarantine
                (batch_key,source_table,source_id,record_json,reason,status,quarantined_by,quarantined_at)
                VALUES(?,?,?,?,?,'quarantined',?,?)""",
                (
                    batch, table, str(row.get('id', '')),
                    json.dumps(row, ensure_ascii=False, separators=(',', ':')),
                    '已确认内置演示项目及其衍生数据链，退出生产业务接口',
                    operator, stamp,
                ),
            )
        if table_rows:
            ids = [row['id'] for row in table_rows]
            conn.execute(f'DELETE FROM "{table}" WHERE id IN ({placeholders(ids)})', ids)
        counts[table] = len(table_rows)
    return counts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--expected-db-sha256', default='')
    parser.add_argument('--backup', default='')
    parser.add_argument('--operator', default='system')
    parser.add_argument('--batch', default='')
    args = parser.parse_args()

    db_path = Path(args.db).expanduser().resolve()
    if not db_path.is_file():
        raise SystemExit(f'database not found: {db_path}')
    database_sha256 = sha256_file(db_path)

    if args.apply:
        if not args.expected_db_sha256:
            raise SystemExit('--expected-db-sha256 is required with --apply')
        if not SHA256_RE.fullmatch(args.expected_db_sha256):
            raise SystemExit('--expected-db-sha256 must be exactly 64 hexadecimal characters')
        if database_sha256 != args.expected_db_sha256.lower():
            raise SystemExit(f'database SHA-256 mismatch: expected {args.expected_db_sha256.lower()}, actual {database_sha256}')
        if not args.backup:
            raise SystemExit('--backup is required with --apply')

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    transaction_started = False
    try:
        targets = collect_targets(conn)
        targets_report = target_manifest(targets)
        retained_before = retained_manifest(conn, targets)
        dry_run_report = {
            'mode': 'apply' if args.apply else 'dry-run',
            'database': str(db_path),
            'database_sha256': database_sha256,
            'targets': targets_report,
            'retained_before': retained_before,
            'apply_requirements': {
                'production_authorization_required': True,
                'expected_db_sha256_required': True,
                'explicit_backup_required': True,
                'retained_record_verification_required': True,
            },
        }
        if not args.apply:
            print(json.dumps(dry_run_report, ensure_ascii=False, indent=2))
            return

        target_count = sum(item['count'] for item in targets_report.values())
        if target_count == 0:
            raise SystemExit('no confirmed demo-chain records found; nothing was changed')

        backup_path = Path(args.backup).expanduser().resolve()
        backup = create_verified_backup(conn, db_path, backup_path)

        # The backup API cannot run from this connection inside a write transaction.
        # Acquire the writer lock immediately afterwards, then re-check both the raw
        # fingerprint and logical target/retained manifests before any mutation.
        conn.execute('BEGIN IMMEDIATE')
        transaction_started = True
        locked_database_sha256 = sha256_file(db_path)
        if locked_database_sha256 != args.expected_db_sha256.lower():
            raise RuntimeError(
                f'database SHA-256 changed before lock: expected {args.expected_db_sha256.lower()}, '
                f'actual {locked_database_sha256}'
            )
        locked_targets = collect_targets(conn)
        locked_targets_report = target_manifest(locked_targets)
        locked_retained_before = retained_manifest(conn, locked_targets)
        if locked_targets_report != targets_report or locked_retained_before != retained_before:
            raise RuntimeError('database target or retained manifests changed before lock')
        targets = locked_targets

        batch = args.batch or f"demo-chain-{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}"
        for statement in QUARANTINE_DDL:
            conn.execute(statement)
        counts = quarantine(conn, targets, batch, args.operator)
        retained_after = retained_manifest(conn, targets)
        retained_unchanged = {
            table: retained_before[table] == retained_after[table]
            for table in retained_before
        }
        if not all(retained_unchanged.values()):
            changed = ', '.join(table for table, unchanged in retained_unchanged.items() if not unchanged)
            raise RuntimeError(f'retained records changed unexpectedly: {changed}')
        verification_after = verify_database(conn)
        if not verification_after['ok']:
            raise RuntimeError(f'database verification failed after quarantine: {verification_after}')
        conn.commit()
        transaction_started = False

        remaining = {
            'projects': conn.execute('SELECT COUNT(*) FROM projects').fetchone()[0],
            'snapshots': conn.execute('SELECT COUNT(*) FROM project_monthly_snapshots').fetchone()[0],
            'forecasts': conn.execute('SELECT COUNT(*) FROM project_forecasts').fetchone()[0],
            'quarantine': conn.execute('SELECT COUNT(*) FROM data_quarantine WHERE batch_key=?', (batch,)).fetchone()[0],
        }
        print(json.dumps({
            **dry_run_report,
            'success': True,
            'batch': batch,
            'backup': backup,
            'moved': counts,
            'retained_after': retained_after,
            'retained_unchanged': retained_unchanged,
            'verification_after': verification_after,
            'remaining': remaining,
        }, ensure_ascii=False, indent=2))
    except BaseException:
        if transaction_started:
            conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == '__main__':
    main()
