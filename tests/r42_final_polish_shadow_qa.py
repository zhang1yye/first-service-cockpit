#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

os.environ.setdefault('QA_LOCAL_PORT', '4178')
os.environ.setdefault('QA_TUNNEL_PORT', '13104')
os.environ.setdefault('QA_REMOTE_SHADOW_PORT', '3102')

import full_remediation_shadow_qa as base

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get(
    'QA_OUT_DIR',
    ROOT / 'docs/qa/frontend-skill-cloud-20260812/r42-shadow-behavior',
))
OUT.mkdir(parents=True, exist_ok=True)


class ProductionRouteHandler(base.ShadowHandler):
    """镜像生产 Nginx：/admin 由主驾驶舱 SPA 接管。"""

    def serve_cockpit(self, request_path: str):
        if request_path in {'/admin', '/admin/'}:
            return self.send_file(base.STATIC_ROOT / 'index.html')
        return super().serve_cockpit(request_path)


def visible_top(page) -> int:
    return page.evaluate("""() => {
      const main = document.querySelector('main#main-content')
      const visible = [...(main?.children || [])].find(element => element.getClientRects().length > 0)
      return Math.round(visible?.getBoundingClientRect().top || 0)
    }""")


def main():
    token = base.ephemeral_token()
    tunnel = subprocess.Popen([
        'ssh', '-N', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-L', f'{base.TUNNEL_PORT}:127.0.0.1:{base.REMOTE_SHADOW_PORT}', base.HOST,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    server = None
    thread = None
    try:
        base.wait_port(base.TUNNEL_PORT)
        server = base.ThreadingHTTPServer(('127.0.0.1', base.LOCAL_PORT), ProductionRouteHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={'width': 390, 'height': 844})
            context.add_init_script(script=(
                f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
                f"localStorage.setItem('token',{json.dumps(token)});"
                "localStorage.setItem('cockpit_user',JSON.stringify({name:'R42影子验收',role:'admin'}));"
            ))
            page = context.new_page()
            console_errors, page_errors, failed_requests = [], [], []
            page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
            page.on('pageerror', lambda error: page_errors.append(str(error)))
            page.on('requestfailed', lambda request: failed_requests.append({
                'url': request.url,
                'error': request.failure,
            }) if request.failure != 'net::ERR_ABORTED' else None)
            result = {'mobile': {}}

            for route in ['/projects', '/import', '/ai-alerts', '/ai-report', '/review', '/daily', '/payment']:
                page.goto(base.BASE + route, wait_until='domcontentloaded', timeout=30_000)
                page.wait_for_timeout(1_500)
                top = visible_top(page)
                overflow = page.evaluate('Math.max(0, document.documentElement.scrollWidth - innerWidth)')
                debug = page.evaluate("""() => ({
                  route: document.body.getAttribute('data-r42-route'),
                  release: document.body.getAttribute('data-r42-release'),
                  paddingTop: getComputedStyle(document.querySelector('main#main-content')).paddingTop,
                  r42Sheets: [...document.styleSheets].map(sheet => sheet.href).filter(href => href?.includes('r42')),
                })""")
                assert top >= 102, f'{route} 首个可见正文仍被导航遮挡: top={top}, debug={debug}'
                assert overflow <= 1, f'{route} 横向溢出: {overflow}'
                result['mobile'][route] = {'firstContentTop': top, 'overflow': overflow}

            page.goto(base.BASE + '/projects', wait_until='domcontentloaded', timeout=30_000)
            page.wait_for_timeout(1_500)
            project_height = round(page.locator('.aph-project-kpis').bounding_box()['height'])
            assert project_height < 460, f'项目指标仍过高: {project_height}'
            result['mobile']['/projects']['kpiHeight'] = project_height

            page.goto(base.BASE + '/import', wait_until='domcontentloaded', timeout=30_000)
            page.wait_for_timeout(1_500)
            import_probe = page.evaluate("""() => {
              const cards = [...document.querySelectorAll('.aph-r42-import-batch')]
              return {total: cards.length, visible: cards.filter(card => !card.hidden).length}
            }""")
            assert import_probe['total'] >= 4 and import_probe['visible'] == 3, import_probe
            page.locator('.aph-r42-import-toggle').click()
            page.wait_for_timeout(100)
            import_expanded = page.locator('.aph-r42-import-batch:not([hidden])').count()
            assert import_expanded == import_probe['total'], (import_probe, import_expanded)
            result['mobile']['/import'].update({
                'defaultVisibleBatches': import_probe['visible'],
                'expandedBatches': import_expanded,
            })

            page.goto(base.BASE + '/command', wait_until='domcontentloaded', timeout=30_000)
            page.wait_for_timeout(1_500)
            actions = page.locator('.aph-r24-command-actions')
            command_height = round(actions.bounding_box()['height'])
            assert command_height < 210, f'下一步操作仍为高卡片: {command_height}'
            assert actions.locator('a').count() == 2
            result['mobile']['/command'] = {'actionHeight': command_height, 'links': 2}

            page.goto(base.BASE + '/ai-alerts', wait_until='domcontentloaded', timeout=30_000)
            page.wait_for_timeout(1_500)
            gate_probe = page.evaluate("""() => ({
              scopeHeight: Math.round(document.querySelector('.aph-real-data-scope')?.getBoundingClientRect().height || 0),
              badgeVisible: Boolean(document.querySelector('.aph-truth-gate > span')?.getClientRects().length),
              gateBorder: getComputedStyle(document.querySelector('.aph-truth-gate')).borderTopWidth,
            })""")
            assert gate_probe['scopeHeight'] < 190, gate_probe
            assert gate_probe['badgeVisible'] is False, gate_probe
            assert gate_probe['gateBorder'] == '0px', gate_probe
            result['mobile']['/ai-alerts'].update(gate_probe)

            page.goto(base.BASE + '/admin', wait_until='domcontentloaded', timeout=30_000)
            page.wait_for_timeout(4_000)
            admin_probe = page.evaluate("""() => {
              const rows = [...document.querySelectorAll('table tbody tr')]
              const tabs = [...document.querySelectorAll('.aph-r42-admin-tabs > button')]
              const last = rows[0]?.lastElementChild
              return {
                rows: rows.length,
                visibleRows: rows.filter(row => !row.hidden).length,
                lastLabel: last?.getAttribute('data-r34-label'),
                tabs: tabs.length,
                minTabHeight: Math.min(...tabs.map(tab => tab.getBoundingClientRect().height)),
                tablistTop: Math.round(document.querySelector('.aph-r42-admin-tabs')?.getBoundingClientRect().top || 0),
                toolbarInTable: Boolean(document.querySelector('tbody > .aph-admin-safety-toolbar')),
                overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
              }
            }""")
            assert admin_probe['rows'] == 56, admin_probe
            assert admin_probe['visibleRows'] == 10, admin_probe
            assert admin_probe['lastLabel'] == '操作', admin_probe
            assert admin_probe['tabs'] == 8 and admin_probe['minTabHeight'] >= 44, admin_probe
            assert admin_probe['tablistTop'] >= 102, admin_probe
            assert admin_probe['toolbarInTable'] is False, admin_probe
            assert admin_probe['overflow'] <= 1, admin_probe
            page.locator('.aph-r42-admin-toggle').click()
            page.wait_for_timeout(100)
            expanded_rows = page.locator('table tbody tr:not([hidden])').count()
            assert expanded_rows == 56, expanded_rows
            admin_probe['expandedRows'] = expanded_rows
            result['mobile']['/admin'] = admin_probe

            visual_system = page.evaluate("""() => {
              const body = getComputedStyle(document.body)
              const muted = document.querySelector('.text-muted-foreground')
              const mutedStyle = muted ? getComputedStyle(muted) : null
              return {
                bodyFont: body.fontFamily,
                bodyColor: body.color,
                bodyBackground: body.backgroundColor,
                mutedColor: mutedStyle?.color || null,
              }
            }""")
            assert 'PingFang SC' in visual_system['bodyFont'], visual_system
            assert visual_system['bodyColor'] == 'rgb(47, 55, 66)', visual_system
            assert visual_system['bodyBackground'] == 'rgb(243, 245, 247)', visual_system
            result['visualSystem'] = visual_system

            for route, label in [
                ('/projects', 'projects'), ('/import', 'import'), ('/command', 'command'),
                ('/ai-alerts', 'ai-alerts'), ('/admin', 'admin'),
            ]:
                page.goto(base.BASE + route, wait_until='domcontentloaded', timeout=30_000)
                page.wait_for_timeout(1_500 if route != '/admin' else 4_000)
                page.evaluate('window.scrollTo({top:0,left:0,behavior:"auto"})')
                page.screenshot(path=str(OUT / f'mobile-{label}.png'), full_page=False)

            context.close()
            desktop = browser.new_context(viewport={'width': 1440, 'height': 1000})
            desktop.add_init_script(script=(
                f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
                f"localStorage.setItem('token',{json.dumps(token)});"
            ))
            page = desktop.new_page()
            page.goto(base.BASE + '/', wait_until='domcontentloaded', timeout=30_000)
            page.wait_for_timeout(1_500)
            banner_top = round(page.locator('.aph-business-banner').bounding_box()['y'])
            reflow_padding = page.locator('.aph-home-reflow').evaluate(
                "element => getComputedStyle(element).paddingTop",
            )
            assert 104 <= banner_top <= 145, f'首页经营横幅位置异常: {banner_top}'
            assert reflow_padding == '90px', f'首页紧凑间距未生效: {reflow_padding}'
            result['desktop'] = {
                'homeBannerTop': banner_top,
                'homeReflowPaddingTop': reflow_padding,
                'homeBannerBackground': page.locator('.aph-business-banner').evaluate(
                    "element => getComputedStyle(element).backgroundColor",
                ),
            }
            assert result['desktop']['homeBannerBackground'] == 'rgb(19, 23, 28)', result['desktop']
            page.screenshot(path=str(OUT / 'desktop-home.png'), full_page=False)
            desktop.close()
            browser.close()

            unexpected_console = [message for message in console_errors if '409 (Conflict)' not in message]
            result['consoleErrors'] = unexpected_console
            result['ignoredConflictResponses'] = len(console_errors) - len(unexpected_console)
            result['pageErrors'] = page_errors
            result['failedRequests'] = failed_requests
            assert not unexpected_console and not page_errors and not failed_requests, result
            (OUT / 'r42-shadow-results.json').write_text(
                json.dumps(result, ensure_ascii=False, indent=2),
                encoding='utf-8',
            )
            print(json.dumps(result, ensure_ascii=False))
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
