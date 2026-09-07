#!/usr/bin/env python3
"""任务督办巡检脚本（标准库）。

用途：服务器 cron 或人工运行，自动把已过截止日期的未完成任务标记为“已逾期”，并输出督办摘要。
不依赖 Node/第三方包，不需要登录态。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import date, datetime, timedelta


def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def mark_overdue(conn: sqlite3.Connection) -> int:
    today = date.today().isoformat()
    rows = conn.execute(
        """
        SELECT * FROM management_tasks
        WHERE status != '已完成'
          AND status != '已逾期'
          AND due_date IS NOT NULL
          AND due_date != ''
          AND due_date < ?
        """,
        (today,),
    ).fetchall()
    for r in rows:
        conn.execute(
            "UPDATE management_tasks SET status='已逾期', updated_at=datetime('now','localtime') WHERE id=?",
            (r['id'],),
        )
        conn.execute(
            """
            INSERT INTO task_events(task_id,event_type,from_status,to_status,note,operator)
            VALUES(?,?,?,?,?,?)
            """,
            (r['id'], '逾期标记', r['status'], '已逾期', f"任务截止日期{r['due_date']}早于{today}，巡检脚本标记为已逾期", 'task-watchdog'),
        )
    if rows:
        conn.execute(
            "INSERT INTO operation_logs(username,action,target,detail,ip) VALUES(?,?,?,?,?)",
            ('task-watchdog', '任务督办巡检', 'management_tasks', json.dumps({'marked_overdue': len(rows)}, ensure_ascii=False), ''),
        )
    conn.commit()
    return len(rows)


def summary(conn: sqlite3.Connection) -> dict:
    today = date.today().isoformat()
    soon = (date.today() + timedelta(days=3)).isoformat()
    def count(sql: str, args=()) -> int:
        return int(conn.execute(sql, args).fetchone()[0])
    def sample(sql: str, args=()) -> list[dict]:
        return [dict(x) for x in conn.execute(sql, args).fetchall()]
    total = count('SELECT COUNT(*) FROM management_tasks')
    done = count("SELECT COUNT(*) FROM management_tasks WHERE status='已完成'")
    overdue = sample("SELECT id,project_name,area,risk_type,owner,due_date,status FROM management_tasks WHERE status!='已完成' AND due_date IS NOT NULL AND due_date!='' AND due_date < ? ORDER BY due_date ASC LIMIT 8", (today,))
    due_soon = sample("SELECT id,project_name,area,risk_type,owner,due_date,status FROM management_tasks WHERE status!='已完成' AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ? ORDER BY due_date ASC LIMIT 8", (today, soon))
    no_owner = sample("SELECT id,project_name,area,risk_type,owner,due_date,status FROM management_tasks WHERE status!='已完成' AND (owner IS NULL OR owner='' OR owner='待指定') ORDER BY due_date ASC LIMIT 8")
    waiting_review = sample("SELECT id,project_name,area,risk_type,owner,due_date,status FROM management_tasks WHERE status='待复核' ORDER BY due_date ASC LIMIT 8")
    return {
        'checkedAt': datetime.now().isoformat(timespec='seconds'),
        'counts': {
            'total': total,
            'open': total - done,
            'done': done,
            'overdue': len(overdue),
            'dueSoon': len(due_soon),
            'noOwner': len(no_owner),
            'waitingReview': len(waiting_review),
            'closureRate': round((done / total * 100) if total else 0, 1),
        },
        'overdue': overdue,
        'dueSoon': due_soon,
        'noOwner': no_owner,
        'waitingReview': waiting_review,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default=os.environ.get('COCKPIT_DB', os.path.expanduser('~/cockpit/cockpit.db')))
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    conn = connect(args.db)
    marked = mark_overdue(conn)
    data = summary(conn)
    data['markedOverdue'] = marked
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        c = data['counts']
        print(f"OK task-watchdog marked={marked} open={c['open']} overdue={c['overdue']} dueSoon={c['dueSoon']} noOwner={c['noOwner']} waitingReview={c['waitingReview']} closureRate={c['closureRate']}%")
        for r in data['overdue'][:5]:
            print(f"OVERDUE #{r['id']} {r['project_name']} / {r['risk_type']} / {r['owner'] or '待指定'} / {r['due_date']}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
