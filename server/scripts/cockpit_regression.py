#!/usr/bin/env python3
"""华北经营驾驶舱一键回归测试（无第三方依赖）。

环境变量：
  COCKPIT_BASE_URL       默认 http://82.157.119.78
  COCKPIT_API_URL        默认 <base>/api；本地可设 http://127.0.0.1:3005
  COCKPIT_TEST_USER      默认 admin
  COCKPIT_TEST_PASSWORD  必填，避免把口令写入源码
  COCKPIT_SSH_HOST       默认 ubuntu@82.157.119.78；--skip-remote 可跳过
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any

PAGES = ['/', '/payment', '/daily', '/projects', '/tasks', '/ai-report', '/import', '/admin']
FORBIDDEN = ['demo-mode','big-screen','competition-summary','比赛','演示','投屏','答辩','收束','实际经营闭环','进入项目经营','wangweiyuan','wws123','zhangye123','first-service-cockpit-secret']
REQUIRED = ['本周必须处理','项目风险画像','项目对标','风险历史趋势','项目风险历史趋势','从风险历史趋势生成任务','督办摘要','刷新逾期状态','预警规则','操作日志','月报归档','领导版','经营版','数据源接入','项目月度快照','数据源预警','数据源同步预警','同步任务中心','数据质量检查报告','从数据源预警生成任务','数据源生成任务','经营整改','数据源修复','已复核回流','数据源修复处理模板','处理步骤','验收口径','自动复检','通过，已提交待复核','数据源健康看板','月报引用关系','待复核/未闭环任务','研发小组审核系统','研发小组审核系统已作为驾驶舱板块接入']
TABLES = ['alert_rules','data_sources','data_source_sync_runs','operation_logs','project_monthly_snapshots','report_archives']

@dataclass
class Runner:
    base: str
    api_base: str
    user: str
    password: str
    root: pathlib.Path
    ssh_host: str | None
    skip_remote: bool = False
    token: str | None = None
    failed: int = 0
    temp_users: list[tuple[str, int]] = field(default_factory=list)

    def rec(self, name: str, ok: bool, detail: str = '') -> None:
        print(('✅' if ok else '❌'), name + (f': {detail}' if detail else ''))
        if not ok: self.failed += 1

    def open(self, url: str, method='GET', headers=None, body=None, raw=False):
        h = dict(headers or {})
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode()
            h.setdefault('Content-Type', 'application/json')
        req = urllib.request.Request(url, data=data, headers=h, method=method)
        with urllib.request.urlopen(req, timeout=20) as res:
            b = res.read()
            if raw: return res.status, b, dict(res.headers)
            return res.status, (json.loads(b.decode('utf-8-sig')) if b else None)

    def api(self, path: str, method='GET', body=None, token: str | None = None, raw=False):
        h = {}
        t = token if token is not None else self.token
        if t: h['Authorization'] = 'Bearer ' + t
        return self.open(self.api_base.rstrip('/') + path, method=method, headers=h, body=body, raw=raw)

    def status_api(self, path: str, token: str, method='GET', body=None) -> int:
        try:
            st, _ = self.api(path, method=method, body=body, token=token)
            return st
        except urllib.error.HTTPError as e:
            return e.code

    def login(self, username: str, password: str) -> str:
        _, d = self.api('/auth/login', method='POST', body={'username': username, 'password': password}, token='')
        return d['token']

    def pages(self):
        for p in PAGES:
            try:
                st, _, _ = self.open(self.base.rstrip() + p, raw=True)
                self.rec(f'页面 {p}', st == 200, f'HTTP {st}')
            except Exception as e:
                self.rec(f'页面 {p}', False, str(e))

    def core_api(self):
        try:
            self.token = self.login(self.user, self.password)
            self.rec('admin 登录', True)
        except Exception as e:
            self.rec('admin 登录', False, str(e)); return
        checks = [
            ('预警规则', '/governance/rules', lambda d: len(d.get('rows', [])) == 6),
            ('预警阈值接入', '/alerts', lambda d: 'thresholds' in d and 'collection_rate' in d['thresholds']),
            ('操作日志', '/governance/logs', lambda d: 'rows' in d),
            ('月报归档列表', '/governance/report-archives', lambda d: 'rows' in d),
            ('数据源状态', '/data-sources/status', lambda d: len(d.get('rows', [])) == 3 and 'summary' in d and all('remediation' in r for r in d.get('rows', []))),
            ('数据源健康看板', '/data-sources/health-board', lambda d: isinstance(d.get('score'), int) and len(d.get('cards', [])) == 3 and 'latestReport' in d and 'tasks' in d),
            ('数据源预警', '/data-sources/alerts', lambda d: 'alerts' in d and 'summary' in d),
            ('数据源同步任务', '/data-sources/sync-runs', lambda d: 'rows' in d and 'summary' in d),
            ('数据质量检查', '/data-sources/quality', lambda d: isinstance(d.get('score'), int) and 'items' in d and 'coverage' in d),
            ('研发审核系统集成', '/integrations/review', lambda d: d.get('key') == 'review-collaboration' and d.get('targetUrl') == '/review-system/' and d.get('cockpitIpUrl') == 'https://www.firstcare.cloud/'),
            ('线上入口清单', '/integrations/sites', lambda d: len(d.get('rows', [])) == 2 and any(r.get('url') == '/review-system/' for r in d.get('rows', [])) and any(r.get('url') == 'https://www.firstcare.cloud/' for r in d.get('rows', []))),
            ('本周必须处理', '/ai/week-focus', lambda d: len(d.get('rows', [])) > 0),
            ('健康分', '/ai/health', lambda d: isinstance(d.get('avgScore'), int)),
        ]
        for name, path, pred in checks:
            try:
                _, d = self.api(path)
                self.rec(f'API {name}', bool(pred(d)), json.dumps(d, ensure_ascii=False)[:100])
            except Exception as e:
                self.rec(f'API {name}', False, str(e))
        try:
            _, projects = self.api('/projects')
            pid = projects['rows'][0]['id']
            _, detail = self.api(f'/projects/{pid}')
            ok = 'riskProfile' in detail and 'benchmarks' in detail
            self.rec('项目详情风险画像/对标', ok, f'id={pid}')
        except Exception as e:
            self.rec('项目详情风险画像/对标', False, str(e))

    def permissions(self):
        if not self.token: return
        suffix = str(int(time.time()))
        viewer, manager = f'viewer_reg_{suffix}', f'manager_reg_{suffix}'
        try:
            _, u1 = self.api('/users', method='POST', body={'username': viewer, 'password': 'regression_viewer_pw', 'role': 'viewer'})
            _, u2 = self.api('/users', method='POST', body={'username': manager, 'password': 'regression_manager_pw', 'role': 'area_manager'})
            self.temp_users += [(viewer, int(u1['id'])), (manager, int(u2['id']))]
            vt = self.login(viewer, 'regression_viewer_pw')
            mt = self.login(manager, 'regression_manager_pw')
            vals = {
                'viewer_put_payment': self.status_api('/payments/1', vt, method='PUT', body={'collectionRate': 0.99}),
                'viewer_projects': self.status_api('/projects', vt),
                'manager_projects': self.status_api('/projects', mt),
                'manager_collections': self.status_api('/collections', mt),
            }
            ok = vals == {'viewer_put_payment':403, 'viewer_projects':403, 'manager_projects':200, 'manager_collections':403}
            self.rec('权限边界', ok, str(vals))
        except Exception as e:
            self.rec('权限边界', False, str(e))
        finally:
            for name, uid in self.temp_users:
                try:
                    self.api(f'/users/{uid}', method='DELETE')
                    print(f'🧹 删除临时用户 {name}')
                except Exception as e:
                    print(f'⚠️ 删除临时用户失败 {name}: {e}')

    def export_archive_snapshot(self):
        if not self.token: return
        try:
            st, b, _ = self.api('/export/monthly-report-doc?area=' + urllib.parse.quote('华北'), raw=True)
            self.rec('Word月报导出', st == 200 and len(b) > 1000, f'HTTP {st}, bytes={len(b)}')
        except Exception as e:
            self.rec('Word月报导出', False, str(e))
        try:
            _, report = self.api('/ai/monthly-report?area=' + urllib.parse.quote('华北'))
            ts = report.get('taskStats', {})
            dq = report.get('dataQuality', {})
            task_ok = all(k in ts for k in ['overdue','dueSoon','noOwner','waitingReview','closureRate','groups','completedWithReview']) and isinstance(dq.get('score'), int) and any('数据源修复任务' in s.get('content','') for s in report.get('sections', [])) and any('数据质量与数据源健康' in s.get('title','') for s in report.get('sections', []))
            self.rec('月报任务督办指标', task_ok, json.dumps({k: ts.get(k) for k in ['overdue','dueSoon','noOwner','waitingReview','closureRate','groups']}, ensure_ascii=False))
            _, a = self.api('/governance/report-archives', method='POST', body={'area':'华北','version':'leader','title':'回归测试归档','summary':'回归测试','payload':report})
            self.rec('月报归档写入', bool(a.get('success') and a.get('id')), f'id={a.get("id")}')
        except Exception as e:
            self.rec('月报归档写入', False, str(e))
        try:
            _, s1 = self.api('/data-sources/snapshot/current', method='POST', body={'month':'2026-06','source':'regression'})
            _, s2 = self.api('/data-sources/snapshot/current', method='POST', body={'month':'2026-07','source':'regression'})
            _, tr = self.api('/ai/trends')
            _, rt = self.api('/ai/risk-trends')
            _, sup = self.api('/tasks/supervision/summary')
            _, refreshed = self.api('/tasks/supervision/refresh-overdue', method='POST')
            _, ds_tasks = self.api('/tasks/generate', method='POST', body={'source':'data-sources'})
            ok = tr.get('summary', {}).get('realSnapshotCount', 0) > 0 and bool(tr.get('rows', [{}])[0].get('hasRealSnapshot'))
            self.rec('真实月度快照趋势', ok, f"{s1.get('month')}={s1.get('inserted')}, {s2.get('month')}={s2.get('inserted')}, real={tr.get('summary',{}).get('realSnapshotCount')}")
            rok = 'worsening' in rt.get('summary', {}) and rt.get('summary', {}).get('withSnapshots', 0) > 0 and 'summary' in rt.get('rows', [{}])[0]
            self.rec('项目风险历史趋势', rok, json.dumps(rt.get('summary', {}), ensure_ascii=False)[:160])
            sok = 'counts' in sup and refreshed.get('success') and 'supervision' in refreshed
            self.rec('任务督办摘要/逾期刷新', bool(sok), json.dumps(refreshed.get('supervision', {}).get('counts', {}), ensure_ascii=False)[:160])
            dok = ds_tasks.get('source') == 'data-sources' and 'created' in ds_tasks and 'skipped' in ds_tasks
            self.rec('数据源预警生成任务', bool(dok), json.dumps({k: ds_tasks.get(k) for k in ['created','skipped','alerts']}, ensure_ascii=False))
        except Exception as e:
            self.rec('真实月度快照趋势', False, str(e))

    def bundle_and_source(self):
        assets = self.root / 'dist' / 'assets'
        if assets.exists():
            text = '\n'.join(p.read_text(errors='ignore') for p in assets.glob('*.js'))
            missing = [x for x in REQUIRED if x not in text]
            bad = [x for x in FORBIDDEN if x in text]
            self.rec('前端包必需文案', not missing, 'ok' if not missing else ','.join(missing))
            self.rec('前端包禁用词/凭据', not bad, 'ok' if not bad else ','.join(bad))
        else:
            self.rec('前端包扫描', True, 'dist/assets 不存在，跳过')
        found = []
        for base in [self.root/'src', self.root/'server'/'src', self.root/'server'/'scripts']:
            if not base.exists(): continue
            for p in base.rglob('*'):
                if p.is_file() and p.suffix in {'.ts','.tsx','.js','.py','.json'}:
                    s = p.read_text(errors='ignore')
                    for term in ['wangweiyuan','wws123','zhangye123','first-service-cockpit-secret']:
                        if term in s: found.append(f'{p.relative_to(self.root)}:{term}')
        self.rec('源码明文凭据扫描', not found, 'ok' if not found else '; '.join(found[:8]))

    def remote(self):
        if self.skip_remote or not self.ssh_host:
            self.rec('远端服务器检查', True, '跳过'); return
        script = r'''
set -e
[ -d /var/www/cockpit ] && echo cockpit-dir-ok
[ -d /var/www/first-service-dashboard ] && echo review-system-untouched
printf 'front:'; curl -s -o /dev/null -w '%{http_code}' -H 'Host: 82.157.119.78' http://127.0.0.1/; echo
printf 'api-health:'; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/api/health; echo
sqlite3 ~/cockpit/cockpit.db "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('alert_rules','data_sources','data_source_sync_runs','operation_logs','project_monthly_snapshots','report_archives') ORDER BY name;"
cd /var/www/cockpit
for bad in demo-mode big-screen competition-summary 比赛 演示 投屏 答辩 收束 实际经营闭环 进入项目经营 wangweiyuan wws123 zhangye123; do
  if grep -R "$bad" -n assets >/dev/null; then echo "FORBIDDEN:$bad:FOUND"; exit 3; fi
done
echo forbidden-scan-ok
'''
        
        if self.ssh_host in ('', 'local', 'localhost', '127.0.0.1'):
            p = subprocess.run(['bash'], input=script, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)
        else:
            p = subprocess.run(['ssh', self.ssh_host, 'bash'], input=script, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)
        out = p.stdout.strip()
        ok = p.returncode == 0 and 'review-system-untouched' in out and 'front:200' in out and 'api-health:200' in out and all(t in out for t in TABLES) and 'forbidden-scan-ok' in out
        self.rec('远端服务器/目录/表/禁用词', ok, out.replace('\n', ' | ')[:500])

    def run(self):
        self.pages(); self.core_api(); self.permissions(); self.export_archive_snapshot(); self.bundle_and_source(); self.remote()
        print('\n==== 回归测试汇总 ====' )
        print(f'失败项: {self.failed}')
        return 0 if self.failed == 0 else 1

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--base-url', default=os.environ.get('COCKPIT_BASE_URL', 'http://82.157.119.78'))
    ap.add_argument('--api-url', default=os.environ.get('COCKPIT_API_URL'))
    ap.add_argument('--user', default=os.environ.get('COCKPIT_TEST_USER', 'admin'))
    ap.add_argument('--password', default=os.environ.get('COCKPIT_TEST_PASSWORD'))
    ap.add_argument('--ssh-host', default=os.environ.get('COCKPIT_SSH_HOST') or ('local' if os.path.isdir('/var/www/cockpit') else 'ubuntu@82.157.119.78'))
    ap.add_argument('--skip-remote', action='store_true')
    ap.add_argument('--project-root', default=os.environ.get('COCKPIT_PROJECT_ROOT', str(pathlib.Path(__file__).resolve().parents[1])))
    args = ap.parse_args()
    if not args.password:
        print('缺少 COCKPIT_TEST_PASSWORD 或 --password', file=sys.stderr)
        return 2
    api_url = args.api_url or args.base_url.rstrip('/') + '/api'
    return Runner(args.base_url, api_url, args.user, args.password, pathlib.Path(args.project_root), args.ssh_host, args.skip_remote).run()

if __name__ == '__main__':
    raise SystemExit(main())
