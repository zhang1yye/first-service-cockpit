#!/usr/bin/env python3
"""华北经营驾驶舱线上巡检脚本。

只读检查：站点/API、远端目录、数据库关键表、数据源状态、快照、APH JSON 更新时间、daily-sync 日志。
适合 cron/no_agent 使用：正常时输出简短 OK；异常时返回非 0 并列出问题。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone

DEFAULT_BASE = 'http://82.157.119.78'


def http_status(url: str) -> int:
    try:
        with urllib.request.urlopen(url, timeout=12) as r:
            return int(r.status)
    except Exception:
        return 0


def ssh(host: str, script: str) -> tuple[int, str]:
    if host in ('', 'local', 'localhost', '127.0.0.1'):
        p = subprocess.run(['bash'], input=script, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)
    else:
        p = subprocess.run(['ssh', host, 'bash'], input=script, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)
    return p.returncode, p.stdout.strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--base-url', default=os.environ.get('COCKPIT_BASE_URL', DEFAULT_BASE))
    ap.add_argument('--ssh-host', default=os.environ.get('COCKPIT_SSH_HOST') or ('local' if os.path.isdir('/var/www/cockpit') else 'ubuntu@82.157.119.78'))
    args = ap.parse_args()
    issues: list[str] = []

    for path in ['/', '/projects', '/tasks', '/ai-report', '/import', '/admin']:
        st = http_status(args.base_url.rstrip('/') + path)
        if st != 200:
            issues.append(f'页面 {path} HTTP {st}')
    st = http_status(args.base_url.rstrip('/') + '/api/health')
    if st != 200:
        issues.append(f'API health HTTP {st}')

    script = r'''
set -e
[ -d /var/www/cockpit ] || echo ISSUE:missing-cockpit-dir
[ -d /var/www/first-service-dashboard ] || echo ISSUE:missing-review-system-dir
printf 'DB_TABLES='; sqlite3 ~/cockpit/cockpit.db "SELECT group_concat(name, ',') FROM sqlite_master WHERE type='table' AND name IN ('alert_rules','data_sources','operation_logs','project_monthly_snapshots','report_archives','users','projects');"; echo
printf 'PROJECT_COUNT='; sqlite3 ~/cockpit/cockpit.db "SELECT COUNT(*) FROM projects;"; echo
printf 'SNAP_MONTHS='; sqlite3 ~/cockpit/cockpit.db "SELECT COUNT(DISTINCT month) FROM project_monthly_snapshots;"; echo
printf 'SOURCE_COUNT='; sqlite3 ~/cockpit/cockpit.db "SELECT COUNT(*) FROM data_sources;"; echo
if [ -f ~/cockpit/APH决策_每日提取.json ]; then
  printf 'APH_JSON_MTIME='; stat -c %Y ~/cockpit/APH决策_每日提取.json; echo
else
  echo ISSUE:missing-aph-json
fi
if [ -f ~/daily-sync.log ]; then
  printf 'DAILY_SYNC_TAIL='; tail -5 ~/daily-sync.log | tr '\n' ' ' | sed 's/  */ /g'; echo
fi
cd /var/www/cockpit
for bad in demo-mode big-screen competition-summary 比赛 演示 投屏 答辩 收束 实际经营闭环 进入项目经营 wangweiyuan wws123 zhangye123; do
  if grep -R "$bad" -n assets >/dev/null; then echo ISSUE:forbidden:$bad; fi
done
'''
    code, out = ssh(args.ssh_host, script)
    if code != 0:
        issues.append(f'SSH巡检失败 exit={code}: {out[:300]}')
    for line in out.splitlines():
        if line.startswith('ISSUE:'):
            issues.append(line)
    kv = {}
    for line in out.splitlines():
        if '=' in line and not line.startswith('ISSUE:'):
            k, v = line.split('=', 1); kv[k] = v
    tables = set((kv.get('DB_TABLES') or '').split(','))
    required = {'alert_rules','data_sources','operation_logs','project_monthly_snapshots','report_archives','users','projects'}
    missing = sorted(required - tables)
    if missing:
        issues.append('缺少数据库表: ' + ','.join(missing))
    try:
        if int(kv.get('PROJECT_COUNT','0')) <= 0: issues.append('projects 表为空')
        if int(kv.get('SOURCE_COUNT','0')) < 3: issues.append('data_sources 少于3个')
    except ValueError:
        issues.append('数据库计数解析失败')
    # APH JSON 超过 3 天提醒，不阻断基本站点，但作为巡检异常输出。
    try:
        mtime = int(kv.get('APH_JSON_MTIME','0'))
        age_hours = (datetime.now(timezone.utc).timestamp() - mtime) / 3600
        if mtime and age_hours > 72:
            issues.append(f'APH JSON 超过72小时未更新（约{age_hours:.1f}小时）')
    except ValueError:
        pass

    if issues:
        print('❌ 驾驶舱巡检发现问题：')
        for i in issues:
            print('-', i)
        print('\n远端摘要：')
        print(out[:1200])
        return 1
    print('✅ 驾驶舱巡检 OK：页面/API/目录/数据库/禁用词/数据源基础状态通过')
    if kv:
        print(json.dumps(kv, ensure_ascii=False, indent=2)[:1200])
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
