#!/usr/bin/env python3
"""Monthly project snapshot job for 华北智能驾驶舱.

No third-party dependencies. Intended for server cron/no-agent usage.
- Creates a project_monthly_snapshots row set for the target month.
- Skips when the month already has snapshots unless --force is passed.
- Writes snapshot_runs with success/skipped/failed status.
- Prints one short OK line on success/skipped; exits non-zero on failed data checks.
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sqlite3
import sys
from pathlib import Path


def default_db() -> Path:
    here = Path(__file__).resolve()
    candidates = [
        here.parents[1] / "server" / "cockpit.db",  # local repo
        Path.home() / "cockpit" / "cockpit.db",       # server
    ]
    for p in candidates:
        if p.exists():
            return p
    return candidates[0]


def month_now() -> str:
    return dt.date.today().isoformat()[:7]


def n(v) -> float:
    try:
        return float(v or 0)
    except Exception:
        return 0.0


def ensure_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS snapshot_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          month TEXT NOT NULL,
          source TEXT DEFAULT 'auto',
          status TEXT NOT NULL,
          inserted INTEGER DEFAULT 0,
          skipped INTEGER DEFAULT 0,
          message TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now','localtime'))
        )
        """
    )


def health(projects: list[sqlite3.Row]) -> list[str]:
    issues: list[str] = []
    total = len(projects)
    if total < 5:
        issues.append(f"项目数量异常：{total}条")
    no_income = sum(1 for p in projects if n(p["ytd_income"]) <= 0)
    no_receivable = sum(1 for p in projects if n(p["receivable"]) <= 0)
    high_rate = sum(1 for p in projects if n(p["receivable"]) > 0 and n(p["received"]) / n(p["receivable"]) > 1.2)
    if total and no_income > total * 0.5:
        issues.append(f"超过半数项目累计收入为空：{no_income}/{total}")
    if total and no_receivable > total * 0.5:
        issues.append(f"超过半数项目应收为空：{no_receivable}/{total}")
    if high_rate:
        issues.append(f"存在实收显著高于应收项目：{high_rate}个")
    return issues


def record(conn: sqlite3.Connection, month: str, source: str, status: str, inserted: int, skipped: int, message: str) -> None:
    conn.execute(
        "INSERT INTO snapshot_runs (month, source, status, inserted, skipped, message) VALUES (?, ?, ?, ?, ?, ?)",
        (month, source, status, inserted, skipped, message),
    )
    try:
        conn.execute(
            "INSERT INTO operation_logs (username, action, target, detail, ip) VALUES (?, ?, ?, ?, ?)",
            ("snapshot-cron", "自动月度快照", f"project_monthly_snapshots:{month}", message, "local"),
        )
    except sqlite3.Error:
        pass
    conn.commit()


def identical_to_previous(conn: sqlite3.Connection, month: str, projects: list[sqlite3.Row]) -> tuple[bool, str]:
    row = conn.execute("SELECT MAX(month) FROM project_monthly_snapshots WHERE month < ?", (month,)).fetchone()
    previous_month = row[0] if row else None
    if not previous_month:
        return False, ""
    previous = conn.execute("SELECT * FROM project_monthly_snapshots WHERE month = ? ORDER BY project_id", (previous_month,)).fetchall()
    if len(previous) != len(projects) or not previous:
        return False, previous_month
    keys = ("ytd_income", "ytd_cost", "receivable", "received", "quality_score", "safety_incidents", "customer_satisfaction", "complaint_count")
    old = {int(item["project_id"]): item for item in previous if item["project_id"] is not None}
    identical = all(int(project["id"]) in old and all(abs(n(project[key]) - n(old[int(project["id"])][key])) < 1e-9 for key in keys) for project in projects)
    return identical, previous_month


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(default_db()))
    ap.add_argument("--month", default=month_now())
    ap.add_argument("--source", default="auto_monthly_snapshot")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    db_path = Path(args.db).expanduser()
    if not db_path.exists():
        print(f"ERROR: DB not found: {db_path}", file=sys.stderr)
        return 2

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    ensure_tables(conn)

    month = str(args.month)[:7]
    projects = conn.execute("SELECT * FROM projects ORDER BY area, name").fetchall()
    if not projects:
        msg = "当前没有项目数据，无法生成月度快照"
        record(conn, month, args.source, "failed", 0, 0, msg)
        print(f"ERROR: {msg}", file=sys.stderr)
        return 1

    issues = health(projects)
    if issues and not args.force:
        msg = "；".join(issues)
        record(conn, month, args.source, "failed", 0, 0, msg)
        print(f"ERROR: {msg}", file=sys.stderr)
        return 1

    existing = conn.execute("SELECT COUNT(*) FROM project_monthly_snapshots WHERE month = ?", (month,)).fetchone()[0]
    if existing and not args.force:
        msg = f"{month} 快照已存在 {existing} 条，已跳过防重复"
        record(conn, month, args.source, "skipped", 0, int(existing), msg)
        print(f"OK skipped: {msg}")
        return 0

    with conn:
        if args.force:
            conn.execute("DELETE FROM project_monthly_snapshots WHERE month = ?", (month,))
        for p in projects:
            conn.execute(
                """
                INSERT INTO project_monthly_snapshots
                (month, project_id, project_name, area, property_type, ytd_income, ytd_cost, receivable, received, quality_score, safety_incidents, customer_satisfaction, complaint_count, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(month, project_name) DO UPDATE SET
                  project_id=excluded.project_id, area=excluded.area, property_type=excluded.property_type,
                  ytd_income=excluded.ytd_income, ytd_cost=excluded.ytd_cost, receivable=excluded.receivable, received=excluded.received,
                  quality_score=excluded.quality_score, safety_incidents=excluded.safety_incidents,
                  customer_satisfaction=excluded.customer_satisfaction, complaint_count=excluded.complaint_count,
                  source=excluded.source, created_at=datetime('now','localtime')
                """,
                (
                    month, p["id"], p["name"], p["area"], p["property_type"] or "",
                    n(p["ytd_income"]), n(p["ytd_cost"]), n(p["receivable"]), n(p["received"]),
                    n(p["quality_score"]), n(p["safety_incidents"]), n(p["customer_satisfaction"]), n(p["complaint_count"]), args.source,
                ),
            )
    identical, previous_month = identical_to_previous(conn, month, projects)
    if identical:
        msg = f"{month} 快照已生成 {len(projects)} 条，但与 {previous_month} 全部经营指标完全相同，疑似源数据未更新"
        record(conn, month, args.source, "warning", len(projects), 0, msg)
        print(f"WARNING: {msg}")
    else:
        msg = f"{month} 快照生成成功 {len(projects)} 条" + (f"；注意：{'；'.join(issues)}" if issues else "")
        record(conn, month, args.source, "success", len(projects), 0, msg)
        print(f"OK success: {msg}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
