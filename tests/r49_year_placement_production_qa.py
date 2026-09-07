#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright

import full_remediation_shadow_qa as qa
from r49_year_placement_shadow_qa import probe

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/qa/frontend-skill-cloud-20260812/r49-production'
OUT.mkdir(parents=True, exist_ok=True)
BASE = 'https://www.firstcare.cloud'
ASSET = 'aph2-r49-year-placement-20260812-v1.css'


def attach_error_capture(page):
    console_errors, page_errors, failed_requests = [], [], []
    page.on('console', lambda message: console_errors.append(message.text)
            if message.type == 'error' and '409 (Conflict)' not in message.text else None)
    page.on('pageerror', lambda error: page_errors.append(str(error)))
    page.on('requestfailed', lambda request: failed_requests.append(request.url)
            if request.failure != 'net::ERR_ABORTED' else None)
    return console_errors, page_errors, failed_requests


def main():
    token = qa.ephemeral_token()
    results = {'home': {}, 'protectedRoutes': {}}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in [(390, 844), (640, 844), (932, 700), (1024, 900), (1517, 900), (1864, 900)]:
                context = browser.new_context(viewport={'width': width, 'height': height})
                context.add_init_script(script=(
                    f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
                    f"localStorage.setItem('token',{json.dumps(token)});"
                    "localStorage.setItem('cockpit_user',JSON.stringify({name:'R49生产验收',role:'admin'}));"
                ))
                page = context.new_page()
                console_errors, page_errors, failed_requests = attach_error_capture(page)
                response = page.goto(BASE + '/', wait_until='domcontentloaded', timeout=30_000)
                page.wait_for_timeout(1_600)
                result = probe(page)
                resources = page.evaluate("""asset => performance.getEntriesByType('resource')
                  .map(item => item.name).filter(name => name.includes(asset))""", ASSET)
                assert response and response.status == 200, result
                assert resources, result
                assert result['legacyYearContent'] == 'none', result
                assert result['year']['content'] == '"2026"', result
                assert result['year']['display'] == 'block', result
                assert result['year']['topAfterSubtitle'] >= 5, result
                assert result['year']['bottom'] <= result['banner']['height'] - 5, result
                assert abs(result['titleCenterDelta']) <= 1, result
                assert result['overflow'] <= 1, result
                if width <= 640:
                    assert result['banner']['height'] == 150, result
                    assert result['year']['fontSize'] == 42, result
                elif width < 1024:
                    assert result['banner']['height'] == 190, result
                    assert result['year']['fontSize'] == 50, result
                else:
                    assert result['banner']['height'] == 218, result
                    assert result['year']['fontSize'] == 60, result
                    assert result['gapToNextKpi'] == 10, result
                assert not console_errors and not page_errors and not failed_requests, {
                    'consoleErrors': console_errors,
                    'pageErrors': page_errors,
                    'failedRequests': failed_requests,
                }
                result['status'] = response.status
                result['resources'] = resources
                page.screenshot(path=str(OUT / f'{width}-home.png'), full_page=False)
                results['home'][str(width)] = result
                context.close()

            for route in ('daily', 'payment', 'collection'):
                context = browser.new_context(viewport={'width': 1517, 'height': 900})
                context.add_init_script(script=(
                    f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
                    f"localStorage.setItem('token',{json.dumps(token)});"
                    "localStorage.setItem('cockpit_user',JSON.stringify({name:'R49生产验收',role:'admin'}));"
                ))
                page = context.new_page()
                console_errors, page_errors, failed_requests = attach_error_capture(page)
                response = page.goto(f'{BASE}/{route}', wait_until='domcontentloaded', timeout=30_000)
                page.wait_for_timeout(1_200)
                route_state = page.evaluate("""expected => ({
                  bodyRoute: document.body.dataset.r42Route,
                  path: location.pathname,
                  overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
                  r49Loaded: performance.getEntriesByType('resource')
                    .some(item => item.name.includes('aph2-r49-year-placement-20260812-v1.css')),
                  homeBannerCount: document.querySelectorAll('.aph-business-banner').length,
                  expected,
                })""", route)
                assert response and response.status == 200, route_state
                assert route_state['bodyRoute'] == route, route_state
                assert route_state['path'].rstrip('/') == f'/{route}', route_state
                assert route_state['r49Loaded'], route_state
                assert route_state['homeBannerCount'] == 0, route_state
                assert route_state['overflow'] <= 1, route_state
                assert not console_errors and not page_errors and not failed_requests, {
                    'route': route,
                    'consoleErrors': console_errors,
                    'pageErrors': page_errors,
                    'failedRequests': failed_requests,
                }
                route_state['status'] = response.status
                results['protectedRoutes'][route] = route_state
                context.close()
            browser.close()

        result_file = OUT / 'r49-production-results.json'
        result_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({
            'homeViewports': len(results['home']),
            'protectedRoutes': len(results['protectedRoutes']),
            'resultFile': str(result_file),
        }, ensure_ascii=False))
    finally:
        token = ''


if __name__ == '__main__':
    main()
