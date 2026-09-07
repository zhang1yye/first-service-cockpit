#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright

import full_remediation_shadow_qa as qa
from r50_home_map_label_shadow_qa import probe

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/qa/frontend-skill-cloud-20260812/r54-production'
OUT.mkdir(parents=True, exist_ok=True)
BASE = 'https://www.firstcare.cloud'
ASSETS = (
    'aph2-r50-home-map-label-20260812-v1.js',
    'aph2-r50-home-map-label-20260812-v1.css',
)


def attach_error_capture(page):
    unexpected_console, allowed_console, page_errors, failed_requests = [], [], [], []

    def capture_console(message):
        if message.type != 'error' or '409 (Conflict)' in message.text:
            return
        if 'Executing inline script violates' in message.text:
            allowed_console.append(message.text)
        else:
            unexpected_console.append(message.text)

    page.on('console', capture_console)
    page.on('pageerror', lambda error: page_errors.append(str(error)))
    page.on('requestfailed', lambda request: failed_requests.append(request.url)
            if request.failure != 'net::ERR_ABORTED' else None)
    return unexpected_console, allowed_console, page_errors, failed_requests


def init_context(browser, token: str, viewport: dict):
    context = browser.new_context(viewport=viewport)
    context.add_init_script(script=(
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R54生产验收',role:'admin'}));"
    ))
    return context


def assert_asset_resources(page):
    resources = page.evaluate("""assets => {
      const names = performance.getEntriesByType('resource').map(item => item.name)
      return Object.fromEntries(assets.map(asset => [asset, names.filter(name => name.includes(asset))]))
    }""", list(ASSETS))
    assert all(resources[asset] for asset in ASSETS), resources
    return resources


def main():
    token = qa.ephemeral_token()
    results = {'home': {}, 'protectedRoutes': {}}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in [(390, 844), (640, 844), (932, 700), (1517, 900), (1864, 1000)]:
                context = init_context(browser, token, {'width': width, 'height': height})
                page = context.new_page()
                unexpected, allowed, page_errors, failed = attach_error_capture(page)
                response = page.goto(BASE + '/', wait_until='domcontentloaded', timeout=30_000)
                map_locator = page.locator('svg[aria-label="辽宁、河北、天津、北京区域地图"]')
                map_locator.wait_for(state='attached', timeout=15_000)
                map_locator.scroll_into_view_if_needed()
                page.wait_for_function(
                    'selector => Boolean(document.querySelector(selector))',
                    arg='[data-r50-map-label-overlay="beijing"]',
                    timeout=5_000,
                )
                page.wait_for_timeout(180)
                result = probe(page)
                result['resources'] = assert_asset_resources(page)

                assert response and response.status == 200, result
                assert result['release'] == 'r50-home-map-label-20260812-v1', result
                assert result['order'] == ['北京', '天津', '河北', '辽宁'], result
                assert result['overlay']['isLast'] is True, result
                assert result['overlay']['ariaHidden'] == 'true', result
                assert result['overlay']['focusable'] == 'false', result
                assert result['overlay']['pointerEvents'] == 'none', result
                assert result['overlay']['texts'][0] == '北京', result
                assert result['overlay']['texts'][1].endswith('%'), result
                assert result['overlay']['lineCount'] == 1, result
                assert all(style['stroke'] == 'rgba(245, 246, 250, 0.96)'
                           for style in result['overlay']['textStyles']), result
                assert result['overflow'] <= 1, result
                assert not unexpected and not page_errors and not failed, {
                    'unexpectedConsoleErrors': unexpected,
                    'pageErrors': page_errors,
                    'failedRequests': failed,
                }

                page.screenshot(path=str(OUT / f'{width}-home-map.png'), full_page=False)
                for region in ('北京', '天津', '河北', '辽宁'):
                    group = map_locator.locator(f'g[aria-label^="{region}"]')
                    group.evaluate("""element => element.dispatchEvent(
                      new MouseEvent('click', {bubbles: true, cancelable: true})
                    )""")
                    assert group.get_attribute('aria-pressed') == 'true', region
                result['selectionInteraction'] = '4/4'
                result['allowedPreexistingConsoleErrors'] = len(allowed)
                result['status'] = response.status
                results['home'][str(width)] = result
                context.close()

            for route in ('daily', 'payment', 'collection'):
                context = init_context(browser, token, {'width': 1517, 'height': 900})
                page = context.new_page()
                unexpected, allowed, page_errors, failed = attach_error_capture(page)
                response = page.goto(f'{BASE}/{route}', wait_until='domcontentloaded', timeout=30_000)
                page.wait_for_timeout(1_500)
                state = page.evaluate("""expected => ({
                  bodyRoute: document.body.dataset.r42Route,
                  path: location.pathname,
                  overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
                  homeMapCount: document.querySelectorAll(
                    'svg[aria-label="辽宁、河北、天津、北京区域地图"]'
                  ).length,
                  mapOverlayCount: document.querySelectorAll('[data-r50-map-label-overlay]').length,
                  expected,
                })""", route)
                state['resources'] = assert_asset_resources(page)
                assert response and response.status == 200, state
                assert state['bodyRoute'] == route, state
                assert state['path'].rstrip('/') == f'/{route}', state
                assert state['homeMapCount'] == 0 and state['mapOverlayCount'] == 0, state
                assert state['overflow'] <= 1, state
                assert not unexpected and not page_errors and not failed, {
                    'route': route,
                    'unexpectedConsoleErrors': unexpected,
                    'pageErrors': page_errors,
                    'failedRequests': failed,
                }
                state['allowedPreexistingConsoleErrors'] = len(allowed)
                state['status'] = response.status
                results['protectedRoutes'][route] = state
                context.close()

            browser.close()

        result_file = OUT / 'r54-production-results.json'
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
