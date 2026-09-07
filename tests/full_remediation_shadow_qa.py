#!/usr/bin/env python3
from __future__ import annotations

import json
import mimetypes
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
STATIC_ROOT = ROOT / 'firstcare-cloud-local'
REVIEW_ROOT = ROOT / 'review-system/active/frontend/dist'
OUT = Path(os.environ.get('QA_OUT_DIR', str(ROOT / 'docs/qa/full-remediation-20260809')))
OUT.mkdir(parents=True, exist_ok=True)
HOST = 'ubuntu@82.157.119.78'
LOCAL_PORT = int(os.environ.get('QA_LOCAL_PORT', '4176'))
TUNNEL_PORT = int(os.environ.get('QA_TUNNEL_PORT', '13102'))
REMOTE_SHADOW_PORT = int(os.environ.get('QA_REMOTE_SHADOW_PORT', '3102'))
BASE = f'http://127.0.0.1:{LOCAL_PORT}'
CANARY = f'http://127.0.0.1:{TUNNEL_PORT}'
PRODUCTION = 'https://www.firstcare.cloud'
EXPECTED_R5_BUSINESS_DATE = os.environ.get('QA_R5_BUSINESS_DATE', '2026-08-09')
EXPECTED_R5_FORMAL_DATE = os.environ.get('QA_R5_FORMAL_DATE', '2026-08-05')
EXPECTED_R5_QUALITY_CASES = int(os.environ.get('QA_R5_QUALITY_CASES', '5'))
EXPECTED_R5_ADMIN_JS = os.environ.get('QA_R5_ADMIN_JS', 'index-DRPv4U9C.js')

REMOTE_TOKEN_SCRIPT = r'''
sudo -n python3 - <<'PY'
import os
import subprocess
from pathlib import Path
pid = subprocess.check_output(["systemctl", "show", "first-service-cockpit", "--property=MainPID", "--value"], text=True).strip()
env = os.environ.copy()
for item in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0"):
    if b"=" not in item:
        continue
    key, value = item.split(b"=", 1)
    key = key.decode("utf-8", errors="ignore")
    if key in {"JWT_SECRET", "JWT_SECRET_FILE", "COCKPIT_DB_PATH", "NODE_ENV", "HOME"}:
        env[key] = value.decode("utf-8", errors="ignore")
env.setdefault("HOME", "/home/ubuntu")
node_script = r"""import db from "./dist/db.js";
import { signToken } from "./dist/auth.js";
const user = db.prepare("SELECT id,username,role,area_scope,project_scope FROM users WHERE role = ? ORDER BY id LIMIT 1").get("admin");
if (!user) process.exit(2);
const token = signToken({userId:user.id,username:user.username,role:user.role,areaScope:user.area_scope || "",projectScope:user.project_scope || ""});
process.stdout.write("\\n__QA_TOKEN__" + token);"""
result = subprocess.run(["/usr/bin/node", "--input-type=module", "-e", node_script], cwd="/home/ubuntu/cockpit", env=env, capture_output=True, text=True)
if result.returncode != 0:
    raise SystemExit(result.returncode)
print(result.stdout, end="")
PY
'''


def ephemeral_token() -> str:
    result = subprocess.run(
        ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', HOST, REMOTE_TOKEN_SCRIPT],
        check=True,
        capture_output=True,
        text=True,
    )
    match = re.search(r'__QA_TOKEN__(\S+)', result.stdout)
    if not match:
        raise RuntimeError('未能在内存中取得临时QA令牌')
    return match.group(1)


class ShadowHandler(BaseHTTPRequestHandler):
    server_version = 'CockpitShadowQA/1.0'

    def log_message(self, _format, *_args):
        return

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def do_PUT(self):
        self.handle_request()

    def do_PATCH(self):
        self.handle_request()

    def do_DELETE(self):
        self.handle_request()

    def handle_request(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path.startswith('/api/'):
            return self.proxy(CANARY + self.path, rewrite_sso=parsed.path == '/api/integrations/review/sso')
        if parsed.path.startswith('/review-system/api/'):
            return self.proxy(PRODUCTION + self.path)
        if parsed.path.startswith('/review-system'):
            return self.serve_review(parsed.path)
        return self.serve_cockpit(parsed.path)

    def proxy(self, destination: str, rewrite_sso: bool = False):
        length = int(self.headers.get('Content-Length', '0') or 0)
        body = self.rfile.read(length) if length else None
        headers = {}
        for key in ('Authorization', 'Content-Type', 'Accept'):
            if self.headers.get(key):
                headers[key] = self.headers[key]
        request = urllib.request.Request(destination, data=body, headers=headers, method=self.command)
        try:
            response = urllib.request.urlopen(request, timeout=40)
            status = response.status
            payload = response.read()
            response_headers = response.headers
        except urllib.error.HTTPError as error:
            status = error.code
            payload = error.read()
            response_headers = error.headers
        if rewrite_sso and status < 400:
            payload = payload.replace(PRODUCTION.encode(), BASE.encode())
        self.send_response(status)
        for key in ('Content-Type', 'Content-Disposition', 'Cache-Control'):
            if response_headers.get(key):
                self.send_header(key, response_headers[key])
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(payload)

    def send_file(self, file: Path, transform_review: bool = False):
        payload = file.read_bytes()
        suffix = file.suffix.lower()
        if transform_review and suffix in {'.html', '.js'}:
            text = payload.decode('utf-8')
            if suffix == '.html':
                text = text.replace('"/assets/', '"/review-system/assets/').replace("'/assets/", "'/review-system/assets/")
            else:
                text = text.replace('"/api', '"/review-system/api').replace("'/api", "'/review-system/api")
            payload = text.encode('utf-8')
        mime = mimetypes.guess_type(file.name)[0] or 'application/octet-stream'
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(payload)))
        if suffix == '.html':
            self.send_header('Cache-Control', 'no-cache')
        elif suffix in {'.js', '.css', '.png', '.svg', '.woff2'}:
            self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
        self.end_headers()
        self.wfile.write(payload)

    def serve_review(self, request_path: str):
        relative = urllib.parse.unquote(request_path.removeprefix('/review-system')).lstrip('/')
        candidate = REVIEW_ROOT / relative
        if not relative or candidate.is_dir() or not candidate.is_file():
            candidate = REVIEW_ROOT / 'index.html'
        self.send_file(candidate, transform_review=True)

    def serve_cockpit(self, request_path: str):
        if request_path == '/arrears':
            return self.send_file(STATIC_ROOT / 'index.html')
        if request_path in {'/arrears/', '/arrears/index.html'}:
            return self.send_file(STATIC_ROOT / 'arrears/index.html')
        if request_path in {'/admin', '/admin/', '/admin/index.html'}:
            return self.send_file(STATIC_ROOT / 'admin/index.html')
        spa_routes = {'/', '/command', '/payment', '/collection', '/daily', '/projects', '/import', '/ai-report', '/ai-alerts', '/tasks', '/review', '/system', '/login'}
        if request_path.rstrip('/') in spa_routes:
            return self.send_file(STATIC_ROOT / 'index.html')
        relative = urllib.parse.unquote(request_path).lstrip('/')
        candidate = STATIC_ROOT / relative
        if candidate.is_dir():
            candidate = candidate / 'index.html'
        if not candidate.is_file():
            candidate = STATIC_ROOT / 'index.html'
        self.send_file(candidate)


def wait_port(port: int, attempts: int = 40):
    for _ in range(attempts):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health/live', timeout=.5).close()
            return
        except Exception:
            time.sleep(.25)
    raise RuntimeError(f'port {port} not ready')


def assert_page_contract(page, route: str):
    page.locator('main').first.wait_for(state='visible', timeout=20_000)
    page.wait_for_timeout(900)
    try:
        page.wait_for_function("document.querySelectorAll('main h1').length === 1", timeout=3_000)
    except Exception as error:
        h1_count = page.locator('main h1').count()
        heading_probe = page.locator('main h1').evaluate_all("els => els.map(el => ({text:el.textContent?.trim(), className:el.className, injected:el.dataset.aphBusinessHeading || null, parent:{tag:el.parentElement?.tagName,id:el.parentElement?.id,className:el.parentElement?.className}, outer:el.outerHTML.slice(0,300)}))")
        raise AssertionError(f'{route} business h1 count={h1_count} headings={heading_probe}') from error
    h1_count = page.locator('main h1').count()
    overflow = page.evaluate('Math.max(0, document.documentElement.scrollWidth - innerWidth)')
    if overflow > 1:
        raise AssertionError(f'{route} horizontal overflow={overflow}')
    return {'h1Count': h1_count, 'overflow': overflow, 'title': page.title()}


def assert_official_collection_rate_display(page, scope_selector: str):
    probe = page.evaluate("""async (scopeSelector) => {
      const token = localStorage.getItem('cockpit_token') || localStorage.getItem('token')
      const response = await fetch('/api/summary', {headers: token ? {Authorization: `Bearer ${token}`} : {}})
      const summary = await response.json()
      const rate = Number(summary.collectionRate)
      const expected = Number.isFinite(rate) ? `${(rate * 100).toFixed(2)}%` : '—'
      const duplicated = Number.isFinite(rate) && Math.abs(rate) > 1e-12 ? `${(rate * 10000).toFixed(2)}%` : ''
      const text = document.querySelector(scopeSelector)?.innerText || ''
      return {status:response.status, rate, expected, duplicated, hasExpected:text.includes(expected), hasDuplicated:duplicated ? text.includes(duplicated) : false}
    }""", scope_selector)
    if probe['status'] != 200 or not (0 <= probe['rate'] <= 1):
        raise AssertionError(f"official collection API must expose a 0-to-1 ratio: {probe}")
    if not probe['hasExpected'] or probe['hasDuplicated']:
        raise AssertionError(f"official collection rate must be formatted exactly once: {probe}")
    return probe


def run_viewport(browser, token: str, name: str, viewport: dict):
    context = browser.new_context(viewport=viewport)
    context.add_init_script(script=f"""(() => {{
      localStorage.setItem('cockpit_token', {json.dumps(token)});
      if (!window.location.pathname.startsWith('/review-system')) {{
        localStorage.setItem('token', {json.dumps(token)});
      }}
      localStorage.setItem('cockpit_user', JSON.stringify({{name:'影子验收',role:'admin'}}));
    }})()""")
    page = context.new_page()
    console_errors, page_errors, failed_requests, aborted_requests, requests, bad_module_responses = [], [], [], [], [], []
    def on_request_failed(request):
        item = {'url': request.url, 'error': request.failure}
        if request.failure == 'net::ERR_ABORTED':
            aborted_requests.append(item)
        else:
            failed_requests.append(item)
    page.on('console', lambda msg: console_errors.append(msg.text) if msg.type == 'error' else None)
    page.on('pageerror', lambda error: page_errors.append(str(error)))
    page.on('requestfailed', on_request_failed)
    page.on('request', lambda request: requests.append(request.url))
    page.on('response', lambda response: bad_module_responses.append(response.url) if response.request.resource_type == 'script' and 'text/html' in response.headers.get('content-type', '') else None)
    result: dict[str, Any] = {'viewport': viewport, 'pages': {}}

    default_routes = ['/', '/command', '/projects', '/payment', '/daily', '/collection', '/arrears', '/ai-alerts', '/ai-report']
    if os.environ.get('QA_ROUTES'):
        routes = [route.strip() for route in os.environ['QA_ROUTES'].split(',') if route.strip()]
    elif os.environ.get('QA_ONLY_ROUTE'):
        routes = [os.environ['QA_ONLY_ROUTE']]
    else:
        routes = default_routes
    for route in routes:
        page.goto(BASE + route, wait_until='domcontentloaded', timeout=30_000)
        result['pages'][route] = assert_page_contract(page, route)
        if route == '/':
            source_status = page.locator('.aph-header-status [data-r7-source-header], .aph-header-status .r7-unified-source-title').first
            source_status.wait_for(state='attached', timeout=15_000)
            if name == 'desktop':
                source_status.wait_for(state='visible', timeout=5_000)
            source_probe = page.evaluate("""() => ({
              headerText: document.querySelector('.aph-header-status')?.textContent || '',
              legacyVisible: Boolean(document.querySelector('body > .aph-source-freshness')?.getClientRects().length),
              visibleH1: [...document.querySelectorAll('h1')].filter(el => el.offsetParent).map(el => el.textContent.trim())
            })""")
            if '经营数据分源更新' not in source_probe['headerText'] or source_probe['legacyVisible']:
                raise AssertionError(f'home source status must live in the black header: {source_probe}')
            if len(source_probe['visibleH1']) != 1:
                raise AssertionError(f'home must expose one visible h1: {source_probe}')
            result['pages'][route]['sourceHeader'] = source_probe
            result['pages'][route]['collectionRateContract'] = assert_official_collection_rate_display(page, '#main-content a[href="/collection"]')
            if name == 'mobile':
                nav = page.locator('.aph-mobile-primary-nav')
                nav.wait_for(state='visible', timeout=10_000)
                sizes = nav.locator('a,button').evaluate_all('els => els.map(el => el.getBoundingClientRect().height)')
                if min(sizes) < 44:
                    raise AssertionError(f'mobile nav touch target={min(sizes)}')
                page.get_by_role('button', name='更多').click()
                page.locator('.aph-mobile-more-drawer').wait_for(state='visible')
                page.keyboard.press('Escape')
                result['pages'][route]['mobileNavMinHeight'] = min(sizes)
        elif route == '/arrears':
            page.locator('#aph-arrears-frame').wait_for(state='visible', timeout=15_000)
            page.wait_for_function("document.querySelector('#aph-arrears-frame')?.contentDocument?.querySelector('h1')?.textContent.includes('欠费经营分析')", timeout=15_000)
            if urllib.parse.urlsplit(page.url).path != '/arrears':
                raise AssertionError(f'arrears deep link lost canonical route: {page.url}')
            result['pages'][route]['frame'] = page.locator('#aph-arrears-frame').get_attribute('src')
        elif route == '/command':
            page.wait_for_timeout(800)
            probe = page.evaluate("""() => ({
              panelCount: document.querySelectorAll('[data-r6-governance]').length,
              slotCount: document.querySelectorAll('[data-r6-governance-slot]').length,
              sourceFreshnessVisible: Boolean(document.querySelector('body > .aph-source-freshness')?.getClientRects().length),
              managementLink: Boolean(document.querySelector('a[href="/admin"],a[href^="/admin/"]'))
            })""")
            if probe.get('panelCount') or probe.get('slotCount') or probe.get('sourceFreshnessVisible'):
                raise AssertionError(f'governance panel must move out of command: {probe}')
            result['pages'][route]['governanceMovedToAdmin'] = probe
        elif route == '/projects':
            area = page.locator('select[data-project-filter="area"]').first
            area.wait_for(state='visible', timeout=10_000)
            if area.locator('option').count() > 1:
                area.select_option(index=1)
                page.wait_for_timeout(250)
                if 'area=' not in page.url:
                    raise AssertionError('projects area state not in URL')
            search = page.locator('[data-project-filter="q"], input[placeholder*="搜索"]').first
            search.fill('MOMA')
            page.wait_for_timeout(250)
            if 'q=MOMA' not in urllib.parse.unquote(page.url):
                raise AssertionError('projects q state not in URL')
            result['pages'][route]['shareableUrl'] = page.url.replace(BASE, '')
        elif route == '/collection':
            if page.locator('body > .aph-source-freshness:visible').count():
                raise AssertionError('source freshness belongs to home and system management, not collection detail')
            if 'tab=details' not in page.url:
                raise AssertionError(f'collection default detail state missing: {page.url}')
            try:
                page.wait_for_function("document.querySelectorAll('tbody tr').length === 35", timeout=10_000)
            except Exception as error:
                row_count = page.locator('tbody tr').count()
                raise AssertionError(f'collection row count={row_count}') from error
            row_count = page.locator('tbody tr').count()
            result['pages'][route]['rows'] = row_count
            result['pages'][route]['shareableUrl'] = page.url.replace(BASE, '')
            result['pages'][route]['collectionRateContract'] = assert_official_collection_rate_display(page, '#main-content')
        elif route == '/ai-alerts':
            try:
                page.locator('.aph-alerts-gate').wait_for(state='visible', timeout=15_000)
            except Exception as error:
                probe = page.evaluate("""async () => {
                  const token = localStorage.getItem('cockpit_token') || localStorage.getItem('token');
                  const response = await fetch('/api/alerts', {headers: token ? {Authorization:`Bearer ${token}`} : {}});
                  let data = null;
                  try { data = await response.clone().json(); } catch {}
                  return {status:response.status, code:data?.code || null, message:data?.message || data?.error || null, blocked:window.__aphAlertsBlocked || null};
                }""")
                raise AssertionError(f'AI alerts gate missing probe={probe} pageErrors={page_errors}') from error
            if not any(copy in page.locator('#main-content').inner_text() for copy in ('预警未发布', '预警未生成')):
                raise AssertionError('alerts blocked state missing')
            unknown_cards = page.locator('#main-content [data-aph-truth-state="unavailable"]')
            unknown_text = [unknown_cards.nth(i).inner_text() for i in range(unknown_cards.count())]
            if unknown_cards.count() < 4 or any('—' not in text for text in unknown_text[:4]):
                raise AssertionError(f'alerts unknown metrics are still presented as zero: {unknown_text}')
            result['pages'][route]['gate'] = 'PROJECT_DATA_QUALITY_BLOCKED'
        elif route == '/ai-report':
            page.locator('.aph-report-gate').wait_for(state='visible', timeout=15_000)
            try:
                page.wait_for_function("""() => {
                  const text = document.querySelector('#main-content')?.innerText || ''
                  return !text.includes('数据加载失败') && !text.includes('请稍后重试')
                }""", timeout=5_000)
            except Exception as error:
                report_text = page.locator('#main-content').inner_text()
                obsolete = [line for line in report_text.splitlines() if '数据加载失败' in line or '请稍后重试' in line]
                raise AssertionError(f'monthly report retains obsolete network-failure copy while truth-gated: {obsolete}') from error
            formal_buttons = page.locator('button:has-text("归档"),button:has-text("导出Word")')
            if formal_buttons.count() and any(not formal_buttons.nth(i).is_disabled() for i in range(formal_buttons.count())):
                raise AssertionError('monthly report formal action is enabled while blocked')
            result['pages'][route]['gate'] = 'PROJECT_DATA_QUALITY_BLOCKED'

    if os.environ.get('QA_SKIP_SUBAPPS') != '1':
        page.goto(BASE + '/admin', wait_until='domcontentloaded', timeout=30_000)
        result['pages']['/admin'] = assert_page_contract(page, '/admin')
        if '管理总览' not in page.locator('body').inner_text():
            raise AssertionError('current admin overview not loaded')
        publication_card = page.locator('.publication-status').first
        publication_card.wait_for(state='visible', timeout=15_000)
        publication_text = publication_card.inner_text()
        if not re.search(r'\d{4}-\d{2}-\d{2}', publication_text):
            raise AssertionError(f'admin publication card lacks a source date: {publication_text}')
        result['pages']['/admin']['publicationCard'] = publication_text
        page.goto(BASE + '/admin#quality', wait_until='domcontentloaded', timeout=30_000)
        page.get_by_role('heading', name='数据真实性中心').wait_for(timeout=15_000)
        page.wait_for_function("document.querySelectorAll('.quality-card').length > 0", timeout=15_000)
        quality_cases = page.locator('.quality-card').count()
        admin_quality_text = page.locator('main').inner_text()
        if '截止日期' not in admin_quality_text or '待确定' not in admin_quality_text:
            raise AssertionError('admin due-date timing is missing')
        admin_overflow = page.evaluate('Math.max(0, document.documentElement.scrollWidth - innerWidth)')
        if admin_overflow > 1:
            raise AssertionError(f'admin R5 quality horizontal overflow={admin_overflow}')
        result['pages']['/admin#quality'] = {'h1Count': page.locator('main h1').count(), 'overflow': admin_overflow, 'qualityCards': quality_cases, 'dueDateTiming': True}

        page.goto(BASE + '/', wait_until='domcontentloaded', timeout=30_000)
        page.wait_for_timeout(600)
        review_url = page.evaluate("""async () => {
          const token = localStorage.getItem('cockpit_token');
          const response = await fetch('/api/integrations/review/sso', {method:'POST', headers:{Authorization:`Bearer ${token}`}});
          const data = await response.json();
          if (!response.ok || !data.url) throw new Error(data.error || 'review sso failed');
          return data.url;
        }""")
        review_target = urllib.parse.urljoin(BASE + '/', review_url)
        page.goto(review_target, wait_until='domcontentloaded', timeout=30_000)
        page.get_by_role('heading', name='让每一次方案审核，都有标准、有依据、有结论').wait_for(timeout=20_000)
        result['pages']['/review-system/'] = assert_page_contract(page, '/review-system/')
        result['reviewChartsLoadedOnDefault'] = any('ReviewCharts-' in url for url in requests)
        if result['reviewChartsLoadedOnDefault']:
            raise AssertionError('review chart bundle loaded on default today mode')

    result['remediationLoaded'] = any('aph2-theme-20260809-remediation3' in url for url in requests)
    result['r6GovernanceLoaded'] = any('aph2-r6-operations-20260810-v6' in url for url in requests)
    result['r6AdminAssetsLoaded'] = any(re.search(r'/admin/assets/index-[A-Za-z0-9_-]+\.js', url) for url in requests)
    result['googleFontsRequested'] = any('fonts.googleapis.com' in url for url in requests)
    if not result['remediationLoaded']:
        raise AssertionError('remediation asset not loaded')
    if '/command' in routes and not result['r6GovernanceLoaded']:
        raise AssertionError('R6 immutable command asset not loaded')
    if os.environ.get('QA_SKIP_SUBAPPS') != '1' and not result['r6AdminAssetsLoaded']:
        raise AssertionError('R6 immutable admin asset not loaded')
    if result['googleFontsRequested']:
        raise AssertionError('Google font dependency still active')
    unexpected_console = [item for item in console_errors if '409 (Conflict)' not in item]
    result['consoleErrors'] = unexpected_console
    result['pageErrors'] = page_errors
    result['failedRequests'] = failed_requests
    result['navigationAborts'] = aborted_requests
    result['badModuleResponses'] = bad_module_responses
    if unexpected_console or page_errors or failed_requests:
        raise AssertionError(json.dumps(result, ensure_ascii=False))

    for route in (route for route in ('/', '/command', '/ai-alerts', '/ai-report', '/admin', '/admin#quality') if route in result['pages']):
        page.goto(BASE + route, wait_until='domcontentloaded')
        page.wait_for_timeout(1800)
        label = 'home' if route == '/' else route.strip('/').replace('/', '-').replace('#', '-')
        page.screenshot(path=str(OUT / f'shadow-{name}-{label}.png'), full_page=False)
    context.close()
    return result


def main():
    token = ephemeral_token()
    tunnel = subprocess.Popen([
        'ssh', '-N', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-L', f'{TUNNEL_PORT}:127.0.0.1:{REMOTE_SHADOW_PORT}', HOST,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    server = None
    thread = None
    try:
        wait_port(TUNNEL_PORT)
        server = ThreadingHTTPServer(('127.0.0.1', LOCAL_PORT), ShadowHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            results = [
                run_viewport(browser, token, 'desktop', {'width': 1440, 'height': 1000}),
                run_viewport(browser, token, 'mobile', {'width': 390, 'height': 844}),
            ]
            browser.close()
        output = {'shadow': True, 'release': os.environ.get('QA_RELEASE_ID', '20260809-remediation3'), 'remoteShadowPort': REMOTE_SHADOW_PORT, 'results': results}
        (OUT / 'shadow-results.json').write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({
            'desktopPages': len(results[0]['pages']),
            'mobilePages': len(results[1]['pages']),
            'desktopConsoleErrors': len(results[0]['consoleErrors']),
            'mobileConsoleErrors': len(results[1]['consoleErrors']),
            'resultFile': str(OUT / 'shadow-results.json'),
        }, ensure_ascii=False))
    finally:
        token = ''
        if server:
            server.shutdown()
            server.server_close()
        if thread:
            thread.join(timeout=2)
        tunnel.terminate()
        try:
            tunnel.wait(timeout=5)
        except subprocess.TimeoutExpired:
            tunnel.kill()


if __name__ == '__main__':
    main()
