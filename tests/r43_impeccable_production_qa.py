#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/qa/frontend-skill-cloud-20260812/r43-production'
OUT.mkdir(parents=True, exist_ok=True)
ORIGIN = 'https://www.firstcare.cloud'
ROUTES = [
    '/', '/command', '/projects', '/payment', '/daily', '/collection', '/arrears',
    '/ai-alerts', '/ai-report', '/import', '/review', '/system', '/tasks', '/admin',
]

spec = importlib.util.spec_from_file_location('qa', ROOT / 'tests/full_remediation_shadow_qa.py')
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


def label(route: str) -> str:
    return 'home' if route == '/' else route.strip('/').replace('/', '-')


def main():
    token = qa.ephemeral_token()
    output = {'origin': ORIGIN, 'release': 'cockpit-r43-impeccable-20260812-212546', 'viewports': []}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for viewport_name, viewport in [
                ('desktop', {'width': 1440, 'height': 1000}),
                ('mobile', {'width': 390, 'height': 844}),
            ]:
                context = browser.new_context(viewport=viewport)
                context.add_init_script(script=(
                    f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
                    f"localStorage.setItem('token',{json.dumps(token)});"
                    "localStorage.setItem('cockpit_user',JSON.stringify({name:'R43生产验收',role:'admin'}));"
                ))
                page = context.new_page()
                console_errors, page_errors, failed_requests, r43_requests = [], [], [], []
                page.on('console', lambda message: console_errors.append(message.text)
                        if message.type == 'error' and '409 (Conflict)' not in message.text else None)
                page.on('pageerror', lambda error: page_errors.append(str(error)))
                page.on('requestfailed', lambda request: failed_requests.append({
                    'url': request.url,
                    'error': request.failure,
                }) if request.failure != 'net::ERR_ABORTED' else None)
                page.on('request', lambda request: r43_requests.append(request.url)
                        if 'aph2-r43-impeccable-polish-20260812-v2.css' in request.url else None)
                viewport_result = {'name': viewport_name, 'viewport': viewport, 'routes': {}}

                for route in ROUTES:
                    response = page.goto(ORIGIN + route, wait_until='domcontentloaded', timeout=30_000)
                    page.wait_for_timeout(4_500 if route == '/admin' else 1_800)
                    assert response and response.status < 400, f'{route} HTTP {response.status if response else None}'
                    overflow = page.evaluate('Math.max(0, document.documentElement.scrollWidth - innerWidth)')
                    visible_h1 = page.locator('h1:visible').count()
                    assert overflow <= 1, f'{viewport_name} {route} 横向溢出 {overflow}'
                    assert visible_h1 >= 1, f'{viewport_name} {route} 缺少可见 H1'
                    probe = {
                        'status': response.status,
                        'overflow': overflow,
                        'visibleH1': visible_h1,
                        'title': page.title(),
                    }

                    if viewport_name == 'mobile' and route in {
                        '/projects', '/import', '/ai-alerts', '/ai-report', '/review', '/daily', '/payment',
                    }:
                        top = page.evaluate("""() => {
                          const main = document.querySelector('main#main-content')
                          const visible = [...(main?.children || [])].find(element => element.getClientRects().length > 0)
                          return Math.round(visible?.getBoundingClientRect().top || 0)
                        }""")
                        assert top >= 102, f'{route} 首屏仍被导航遮挡: {top}'
                        probe['firstContentTop'] = top

                    if route == '/':
                        home = page.evaluate("""() => {
                          const banner = document.querySelector('.aph-business-banner')
                          const body = getComputedStyle(document.body)
                          const bannerStyle = getComputedStyle(banner)
                          return {
                            bodyColor: body.color,
                            bodyBackground: body.backgroundColor,
                            bodyFont: body.fontFamily,
                            bannerTop: Math.round(banner.getBoundingClientRect().top),
                            bannerBackground: bannerStyle.backgroundColor,
                          }
                        }""")
                        assert home['bodyColor'] == 'rgb(47, 55, 66)', home
                        assert home['bodyBackground'] == 'rgb(243, 245, 247)', home
                        assert home['bannerBackground'] == 'rgb(19, 23, 28)', home
                        if viewport_name == 'desktop':
                            assert 104 <= home['bannerTop'] <= 145, home
                        probe['visualSystem'] = home

                    if route == '/collection':
                        page.wait_for_function("document.querySelectorAll('tbody tr').length === 35", timeout=12_000)
                        probe['rows'] = page.locator('tbody tr').count()
                        probe['officialRate'] = qa.assert_official_collection_rate_display(page, '#main-content')

                    if route == '/import' and viewport_name == 'mobile':
                        page.wait_for_function("document.querySelectorAll('.aph-r42-import-batch').length >= 4")
                        default_visible = page.locator('.aph-r42-import-batch:not([hidden])').count()
                        total = page.locator('.aph-r42-import-batch').count()
                        assert default_visible == 3, (default_visible, total)
                        page.locator('.aph-r42-import-toggle').click()
                        page.wait_for_timeout(100)
                        expanded = page.locator('.aph-r42-import-batch:not([hidden])').count()
                        assert expanded == total, (expanded, total)
                        probe['batches'] = {'default': default_visible, 'expanded': expanded}

                    if route == '/admin' and viewport_name == 'mobile':
                        admin = page.evaluate("""() => {
                          const rows = [...document.querySelectorAll('table tbody tr')]
                          const tabs = [...document.querySelectorAll('.aph-r42-admin-tabs > button')]
                          return {
                            rows: rows.length,
                            visibleRows: rows.filter(row => !row.hidden).length,
                            lastLabel: rows[0]?.lastElementChild?.getAttribute('data-r34-label'),
                            tabs: tabs.length,
                            minTabHeight: Math.min(...tabs.map(tab => tab.getBoundingClientRect().height)),
                            toolbarInTable: Boolean(document.querySelector('tbody > .aph-admin-safety-toolbar')),
                          }
                        }""")
                        assert admin == {
                            'rows': 56,
                            'visibleRows': 10,
                            'lastLabel': '操作',
                            'tabs': 8,
                            'minTabHeight': 44,
                            'toolbarInTable': False,
                        }, admin
                        page.locator('.aph-r42-admin-toggle').click()
                        page.wait_for_timeout(100)
                        admin['expandedRows'] = page.locator('table tbody tr:not([hidden])').count()
                        assert admin['expandedRows'] == 56, admin
                        probe['admin'] = admin

                    viewport_result['routes'][route] = probe
                    page.screenshot(path=str(OUT / f'{viewport_name}-{label(route)}.png'), full_page=False)

                assert r43_requests, f'{viewport_name} 未加载 R43 资源'
                assert not console_errors, console_errors
                assert not page_errors, page_errors
                assert not failed_requests, failed_requests
                viewport_result['r43Requests'] = sorted(set(r43_requests))
                viewport_result['consoleErrors'] = console_errors
                viewport_result['pageErrors'] = page_errors
                viewport_result['failedRequests'] = failed_requests
                output['viewports'].append(viewport_result)
                context.close()
            browser.close()

        result_file = OUT / 'r43-production-results.json'
        result_file.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({
            'desktopRoutes': len(output['viewports'][0]['routes']),
            'mobileRoutes': len(output['viewports'][1]['routes']),
            'resultFile': str(result_file),
        }, ensure_ascii=False))
    finally:
        token = ''


if __name__ == '__main__':
    main()
