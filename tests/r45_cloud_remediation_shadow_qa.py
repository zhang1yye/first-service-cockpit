#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import threading
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault('QA_LOCAL_PORT', '4183')
os.environ.setdefault('QA_TUNNEL_PORT', '13109')
os.environ.setdefault('QA_REMOTE_SHADOW_PORT', '3102')
spec = importlib.util.spec_from_file_location('base_qa', ROOT / 'tests/full_remediation_shadow_qa.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
OUT = ROOT / 'docs/qa/frontend-skill-cloud-20260812/r45-cloud-remediation-shadow'
OUT.mkdir(parents=True, exist_ok=True)


class R45Handler(base.ShadowHandler):
    """镜像生产静态站；新门禁接口在服务发布前按同源 blocked 合同返回。"""

    def handle_request(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == '/api/data-quality/project-gate':
            payload = json.dumps({
                'ready': False,
                'status': 'blocked',
                'code': 'PROJECT_DATA_QUALITY_BLOCKED',
                'projectCount': 0,
                'demoProjectCount': 0,
                'copiedSnapshotProjectCount': 0,
                'unverifiedProjectCount': 0,
                'inactiveProjectCount': 0,
                'missingSourceBatchCount': 0,
                'reasons': ['真实项目经营数据尚未接入'],
            }, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        return super().handle_request()

    def serve_cockpit(self, request_path: str):
        if request_path in {'/admin', '/admin/'}:
            return self.send_file(base.STATIC_ROOT / 'index.html')
        return super().serve_cockpit(request_path)


def init_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R45影子验收',role:'admin'}));"
    )


def rendered_rows(page) -> int:
    return page.locator('table tbody tr').evaluate_all(
        "rows => rows.filter(row => getComputedStyle(row).display !== 'none' && row.getClientRects().length > 0).length",
    )


def main():
    token = base.ephemeral_token()
    tunnel = subprocess.Popen([
        'ssh', '-N', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-L', f'{base.TUNNEL_PORT}:127.0.0.1:{base.REMOTE_SHADOW_PORT}', base.HOST,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    server = None
    thread = None
    result = {'coldArrears': [], 'mobile': {}, 'runtime': {}}
    try:
        base.wait_port(base.TUNNEL_PORT)
        server = base.ThreadingHTTPServer(('127.0.0.1', base.LOCAL_PORT), R45Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)

            for cycle in range(3):
                context = browser.new_context(viewport={'width': 390, 'height': 844})
                context.add_init_script(script=init_script(token))
                page = context.new_page()
                page.goto(base.BASE + '/arrears', wait_until='domcontentloaded', timeout=30_000)
                page.wait_for_load_state('networkidle')
                frame = page.locator('#aph-arrears-frame')
                frame.wait_for(state='visible', timeout=15_000)
                content = frame.content_frame
                content.locator('h1').first.wait_for(state='visible', timeout=15_000)
                probe = {
                    'cycle': cycle + 1,
                    'url': page.url,
                    'title': page.title(),
                    'frameTitle': content.locator('h1').first.inner_text(),
                    'release': page.locator('html').get_attribute('data-r45-app-bootstrap'),
                }
                assert urllib.parse.urlsplit(page.url).path == '/arrears', probe
                assert probe['title'] == '欠费经营分析 · 第一服务华北地区', probe
                assert probe['frameTitle'] == '欠费经营分析', probe
                assert probe['release'] == 'r52-app-bootstrap-20260812-v1', probe
                result['coldArrears'].append(probe)
                context.close()

            context = browser.new_context(viewport={'width': 390, 'height': 844})
            context.add_init_script(script=init_script(token))
            page = context.new_page()
            console_errors, page_errors, failed_requests, error_responses = [], [], [], []
            page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
            page.on('pageerror', lambda error: page_errors.append(str(error)))
            page.on('requestfailed', lambda request: failed_requests.append({'url': request.url, 'error': request.failure}))
            page.on('response', lambda response: error_responses.append({'url': response.url, 'status': response.status}) if response.status >= 400 else None)

            for route in ['/projects', '/payment', '/daily', '/collection', '/ai-alerts', '/ai-report', '/import', '/review']:
                page.goto(base.BASE + route, wait_until='domcontentloaded', timeout=30_000)
                page.wait_for_load_state('networkidle')
                page.wait_for_timeout(500)
                overflow = page.evaluate('Math.max(0, document.documentElement.scrollWidth - innerWidth)')
                assert overflow <= 1, (route, overflow)
                account = page.locator('button[aria-label="账号菜单"]')
                account_box = account.bounding_box()
                assert account_box and account_box['width'] >= 44 and account_box['height'] >= 44, (route, account_box)
                result['mobile'][route] = {'overflow': overflow, 'account': account_box}

            page.goto(base.BASE + '/import', wait_until='domcontentloaded', timeout=30_000)
            page.wait_for_load_state('networkidle')
            page.wait_for_timeout(500)
            import_probe = page.evaluate("""() => ({
              title: document.title,
              h1: [...document.querySelectorAll('main h1')].map(e => e.textContent.trim()),
              intro: document.querySelector('.aph-r45-route-intro')?.outerHTML || null,
              mappedAsset: [...document.scripts].some(s => s.src.includes('r52-app-bootstrap')),
              componentAssets: performance.getEntriesByType('resource').map(e => e.name).filter(name => name.includes('LR35IIDP') || name.includes('4UXV2DAK')),
            })""")
            assert import_probe['title'] == '数据导入 · 第一服务华北地区', import_probe
            assert import_probe['h1'] == ['数据导入'], import_probe
            assert import_probe['intro'].startswith('<section'), import_probe
            refresh_box = page.get_by_role('button', name='刷新', exact=True).bounding_box()
            assert refresh_box and refresh_box['width'] >= 44 and refresh_box['height'] >= 44, refresh_box
            import_probe['refresh'] = refresh_box
            result['mobile']['/import'].update(import_probe)

            page.goto(base.BASE + '/admin', wait_until='domcontentloaded', timeout=30_000)
            page.wait_for_load_state('networkidle')
            page.wait_for_timeout(900)
            landmark = page.locator('[role="main"][aria-labelledby="aph-admin-title"]')
            admin_identity = page.evaluate("""() => ({
              resources: performance.getEntriesByType('resource').map(e => e.name).filter(name => name.includes('YICGYIFC')),
              landmarks: [...document.querySelectorAll('[role="main"]')].map(e => ({labelledby:e.getAttribute('aria-labelledby'),className:e.className,html:e.outerHTML.slice(0,700)})),
              headings: [...document.querySelectorAll('h1')].map(e => ({id:e.id,text:e.textContent.trim(),parent:e.parentElement?.className || '',insideMain:Boolean(e.closest('[role="main"]'))})),
            })""")
            assert landmark.count() == 1, admin_identity
            assert landmark.locator('#aph-admin-title').count() == 1, admin_identity
            assert landmark.locator('#aph-admin-title').inner_text() == '后台数据管理', admin_identity
            rows = page.locator('table tbody tr')
            assert rows.count() == 56
            assert rendered_rows(page) == 10
            row11 = rows.nth(10).evaluate("row => ({hidden:row.hidden,display:getComputedStyle(row).display,rects:row.getClientRects().length})")
            assert row11 == {'hidden': True, 'display': 'none', 'rects': 0}, row11
            toggle = page.locator('.aph-r46-table-toggle')
            toggle_probe = toggle.evaluate("""button => {
              const style = getComputedStyle(button)
              const rect = button.getBoundingClientRect()
              const host = button.parentElement
              const hostStyle = getComputedStyle(host)
              return {display:style.display,visibility:style.visibility,opacity:style.opacity,width:rect.width,height:rect.height,top:rect.top,
                hostTag:host.tagName,hostClass:host.className,hostDisplay:hostStyle.display,hostOverflow:hostStyle.overflow,hostHeight:host.getBoundingClientRect().height}
            }""")
            assert toggle.is_visible(), toggle_probe
            toggle.click()
            page.wait_for_timeout(150)
            assert rendered_rows(page) == 56
            result['mobile']['/admin'] = {'landmark': True, 'defaultRenderedRows': 10, 'expandedRows': 56, 'row11': row11, 'toggle': toggle_probe}

            for route in ['/projects', '/payment', '/daily', '/collection', '/ai-alerts', '/ai-report', '/review', '/']:
                page.goto(base.BASE + route, wait_until='domcontentloaded', timeout=30_000)
                page.wait_for_load_state('networkidle')
                page.wait_for_timeout(500)
                undersized = page.evaluate("""() => [...document.querySelectorAll('main button,main a[href],main select,main input,button[aria-label="账号菜单"],.north-ai-close,svg [role="button"][aria-label]')]
                  .filter(e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && (r.width<44 || r.height<44) })
                  .map(e => ({tag:e.tagName,label:(e.getAttribute('aria-label')||e.textContent||'').trim().slice(0,80),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))""")
                relevant = [item for item in undersized if item['label'] in {
                    '账号菜单', '刷新', '按#排序', '按分期排序', '查看未关联映射 →', '片区筛选', '关闭华北经营助手'
                } or item['label'].startswith('查看方案：') or item['tag'] in {'SELECT', 'INPUT'}]
                assert not relevant, (route, relevant)

            result['runtime'] = {
                'consoleErrors': console_errors,
                'pageErrors': page_errors,
                'failedRequests': failed_requests,
                'errorResponses': error_responses,
            }
            assert not page_errors and not failed_requests, result['runtime']
            assert not [item for item in console_errors if 'favicon' not in item.lower()], console_errors
            assert not error_responses, error_responses
            context.close()
            browser.close()
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

    (OUT / 'r45-shadow-results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
