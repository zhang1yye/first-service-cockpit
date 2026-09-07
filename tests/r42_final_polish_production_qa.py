#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/qa/frontend-skill-cloud-20260812/r42-production'
OUT.mkdir(parents=True, exist_ok=True)
BASE = 'https://www.firstcare.cloud'
ROUTES = [
    '/', '/command', '/projects', '/payment', '/daily', '/collection', '/arrears',
    '/ai-alerts', '/ai-report', '/tasks', '/import', '/review', '/system', '/admin',
]
AFFECTED_MOBILE = {'/projects', '/import', '/ai-alerts', '/ai-report', '/review', '/daily', '/payment'}

spec = importlib.util.spec_from_file_location('shared_qa', ROOT / 'tests/full_remediation_shadow_qa.py')
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


def route_label(route: str) -> str:
    return 'home' if route == '/' else route.strip('/').replace('/', '-')


def run_viewport(browser, token: str, name: str, viewport: dict) -> dict:
    context = browser.new_context(viewport=viewport)
    context.add_init_script(script=(
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R42生产验收',role:'admin'}));"
    ))
    page = context.new_page()
    console_errors, page_errors, failed_requests, requests = [], [], [], []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.on('pageerror', lambda error: page_errors.append(str(error)))
    page.on('request', lambda request: requests.append(request.url))
    page.on('requestfailed', lambda request: failed_requests.append({
        'url': request.url,
        'error': request.failure,
    }) if request.failure != 'net::ERR_ABORTED' else None)
    result = {'viewport': viewport, 'pages': {}}

    for route in ROUTES:
        page.goto(BASE + route, wait_until='domcontentloaded', timeout=30_000)
        page.wait_for_timeout(4_500 if route == '/admin' else 1_800)
        probe = page.evaluate("""() => {
          const headings = [...document.querySelectorAll('h1')]
            .filter(element => element.getClientRects().length > 0)
            .map(element => element.textContent.trim())
          const main = document.querySelector('main#main-content, main')
          const first = [...(main?.children || [])].find(element => element.getClientRects().length > 0)
          return {
            headings,
            overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
            firstContentTop: Math.round(first?.getBoundingClientRect().top || 0),
            release: document.body.getAttribute('data-r42-release'),
          }
        }""")
        if route != '/collection':
            assert len(probe['headings']) == 1, f'{name} {route} 可见H1异常: {probe}'
        assert probe['overflow'] <= 1, f'{name} {route} 横向溢出: {probe}'
        assert probe['release'] == 'r42-final-polish-20260812-v1', f'{name} {route} 未加载R42: {probe}'
        if name == 'mobile' and route in AFFECTED_MOBILE:
            assert probe['firstContentTop'] >= 102, f'{name} {route} 正文遮挡: {probe}'
        result['pages'][route] = probe

        if route == '/collection':
            page.wait_for_function("document.querySelectorAll('tbody tr').length === 35", timeout=10_000)
            result['pages'][route]['rows'] = page.locator('tbody tr').count()
        if route == '/arrears':
            page.locator('#aph-arrears-frame').wait_for(state='visible', timeout=15_000)
            result['pages'][route]['frame'] = page.locator('#aph-arrears-frame').get_attribute('src')

        page.evaluate('window.scrollTo({top:0,left:0,behavior:"auto"})')
        page.screenshot(path=str(OUT / f'{name}-{route_label(route)}.png'), full_page=False)

    if name == 'mobile':
        page.goto(BASE + '/projects', wait_until='domcontentloaded', timeout=30_000)
        page.wait_for_timeout(1_800)
        project_height = round(page.locator('.aph-project-kpis').bounding_box()['height'])
        assert project_height < 460, project_height
        result['pages']['/projects']['kpiHeight'] = project_height

        page.goto(BASE + '/import', wait_until='domcontentloaded', timeout=30_000)
        page.wait_for_timeout(1_800)
        batch_probe = page.evaluate("""() => {
          const cards = [...document.querySelectorAll('.aph-r42-import-batch')]
          return {total: cards.length, visible: cards.filter(card => !card.hidden).length}
        }""")
        assert batch_probe['total'] >= 4 and batch_probe['visible'] == 3, batch_probe
        page.locator('.aph-r42-import-toggle').click()
        page.wait_for_timeout(100)
        expanded = page.locator('.aph-r42-import-batch:not([hidden])').count()
        assert expanded == batch_probe['total'], (batch_probe, expanded)
        result['pages']['/import'].update({'defaultVisibleBatches': 3, 'expandedBatches': expanded})

        page.goto(BASE + '/command', wait_until='domcontentloaded', timeout=30_000)
        page.wait_for_timeout(1_800)
        action_height = round(page.locator('.aph-r24-command-actions').bounding_box()['height'])
        assert action_height < 210
        assert page.locator('.aph-r24-command-actions a').count() == 2
        result['pages']['/command'].update({'actionHeight': action_height, 'links': 2})

        page.goto(BASE + '/ai-alerts', wait_until='domcontentloaded', timeout=30_000)
        page.wait_for_timeout(1_800)
        gate = page.evaluate("""() => ({
          scopeHeight: Math.round(document.querySelector('.aph-real-data-scope')?.getBoundingClientRect().height || 0),
          badgeVisible: Boolean(document.querySelector('.aph-truth-gate > span')?.getClientRects().length),
          border: getComputedStyle(document.querySelector('.aph-truth-gate')).borderTopWidth,
        })""")
        assert gate['scopeHeight'] < 190 and gate['badgeVisible'] is False and gate['border'] == '0px', gate
        result['pages']['/ai-alerts'].update(gate)

        page.goto(BASE + '/admin', wait_until='domcontentloaded', timeout=30_000)
        page.wait_for_timeout(4_500)
        admin = page.evaluate("""() => {
          const rows = [...document.querySelectorAll('table tbody tr')]
          const tabs = [...document.querySelectorAll('.aph-r42-admin-tabs > button')]
          return {
            rows: rows.length,
            visibleRows: rows.filter(row => !row.hidden).length,
            lastLabel: rows[0]?.lastElementChild?.getAttribute('data-r34-label'),
            tabs: tabs.length,
            minTabHeight: Math.min(...tabs.map(tab => tab.getBoundingClientRect().height)),
            tablistTop: Math.round(document.querySelector('.aph-r42-admin-tabs')?.getBoundingClientRect().top || 0),
            toolbarInTable: Boolean(document.querySelector('tbody > .aph-admin-safety-toolbar')),
          }
        }""")
        assert admin['rows'] == 56 and admin['visibleRows'] == 10, admin
        assert admin['lastLabel'] == '操作', admin
        assert admin['tabs'] == 8 and admin['minTabHeight'] >= 44 and admin['tablistTop'] >= 102, admin
        assert admin['toolbarInTable'] is False, admin
        page.locator('.aph-r42-admin-toggle').click()
        page.wait_for_timeout(100)
        admin['expandedRows'] = page.locator('table tbody tr:not([hidden])').count()
        assert admin['expandedRows'] == 56, admin
        result['pages']['/admin'].update(admin)
    else:
        page.goto(BASE + '/', wait_until='domcontentloaded', timeout=30_000)
        page.wait_for_timeout(1_800)
        home = page.evaluate("""() => {
          const banner = document.querySelector('.aph-business-banner').getBoundingClientRect()
          const tabs = document.querySelector('.aph-page-tabs').getBoundingClientRect()
          return {
            bannerTop: Math.round(banner.top),
            tabsBottom: Math.round(tabs.bottom),
            gap: Math.round(banner.top - tabs.bottom),
            reflowPadding: getComputedStyle(document.querySelector('.aph-home-reflow')).paddingTop,
          }
        }""")
        assert 20 <= home['gap'] <= 50 and home['reflowPadding'] == '36px', home
        result['pages']['/'].update(home)

        page.goto(BASE + '/projects', wait_until='domcontentloaded', timeout=30_000)
        page.wait_for_timeout(1_800)
        before = page.locator('main#main-content').bounding_box()['width']
        page.locator('.aph-exact-sidebar').hover()
        page.wait_for_timeout(300)
        after = page.locator('main#main-content').bounding_box()['width']
        assert abs(before - after) <= 1, {'before': before, 'after': after}
        result['sidebarOverlay'] = {'mainWidthBefore': before, 'mainWidthAfter': after}

    unexpected_console = [message for message in console_errors if '409 (Conflict)' not in message]
    result['consoleErrors'] = unexpected_console
    result['ignoredConflictResponses'] = len(console_errors) - len(unexpected_console)
    result['pageErrors'] = page_errors
    result['failedRequests'] = failed_requests
    result['r42AssetLoaded'] = any('aph2-r42-final-polish-20260812-v1' in url for url in requests)
    assert result['r42AssetLoaded']
    assert not unexpected_console and not page_errors and not failed_requests, result
    context.close()
    return result


def main():
    token = shared.ephemeral_token()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            results = {
                'desktop': run_viewport(browser, token, 'desktop', {'width': 1440, 'height': 1000}),
                'mobile': run_viewport(browser, token, 'mobile', {'width': 390, 'height': 844}),
            }
            browser.close()
        output = {
            'production': True,
            'strictTls': True,
            'origin': BASE,
            'release': 'cockpit-r42-final-polish-20260812-2119',
            **results,
        }
        path = OUT / 'r42-production-results.json'
        path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({
            'desktopStates': len(results['desktop']['pages']),
            'mobileStates': len(results['mobile']['pages']),
            'consoleErrors': len(results['desktop']['consoleErrors']) + len(results['mobile']['consoleErrors']),
            'pageErrors': len(results['desktop']['pageErrors']) + len(results['mobile']['pageErrors']),
            'failedRequests': len(results['desktop']['failedRequests']) + len(results['mobile']['failedRequests']),
            'resultFile': str(path),
        }, ensure_ascii=False))
    finally:
        token = ''


if __name__ == '__main__':
    main()
