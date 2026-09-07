#!/usr/bin/env python3
"""R56 AI 服务中心经营分析生产验收。"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://www.firstcare.cloud'
OUT = ROOT / 'docs/qa/r56-ai-service-centers/production'
OUT.mkdir(parents=True, exist_ok=True)

shared_path = ROOT / 'tests/full_remediation_shadow_qa.py'
spec = importlib.util.spec_from_file_location('r56_production_shared', shared_path)
if spec is None or spec.loader is None:
    raise SystemExit('无法加载生产验收共享模块')
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


def init_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R56生产验收',role:'admin'}));"
    )


def assert_evidence(value: Any) -> None:
    assert isinstance(value, dict), value
    assert {'source', 'businessDate', 'lastValidatedAt', 'methodology', 'rule'} <= set(value), value
    assert str(value['source']).strip(), value
    assert str(value['methodology']).strip(), value
    assert str(value['rule']).strip(), value


def validate_api(request) -> dict[str, Any]:
    health = request.get('/api/health/ready', timeout=20_000)
    assert health.status == 200, health.text()
    assert health.json().get('ready') is True, health.json()

    payments_response = request.get('/api/payments', timeout=20_000)
    analysis_response = request.get('/api/ai/service-centers', timeout=20_000)
    assert payments_response.status == 200, payments_response.text()
    assert analysis_response.status == 200, analysis_response.text()
    payments = payments_response.json()
    analysis = analysis_response.json()
    rows = analysis.get('rows') or []
    assert len(payments) == 56 and len(rows) == 56, (len(payments), len(rows))
    payment_pairs = {(row.get('id'), row.get('center')) for row in payments}
    analysis_pairs = {(row.get('id'), row.get('center')) for row in rows}
    assert len(payment_pairs) == len(analysis_pairs) == 56
    assert payment_pairs == analysis_pairs
    assert analysis.get('summary', {}).get('total') == 56
    assert analysis.get('scope', {}).get('total') == 56
    assert analysis.get('coverage', {}).get('paymentCenters') == 56
    assert analysis.get('publicationStatus') == 'partial'
    assert analysis.get('credibility', {}).get('status') == 'partial'

    for row in rows:
        assert row.get('operatingStatus') in {'stable', 'attention', 'insufficient'}, row
        assert row.get('dataStatus') in {'complete', 'partial', 'missing'}, row
        metrics = row.get('metrics') or {}
        availability = row.get('availability') or {}
        evidence = row.get('evidence') or {}
        assert_evidence(evidence.get('payment'))
        if availability.get('daily') == 'missing':
            assert metrics.get('dailyCollection') is None and evidence.get('daily') is None, row
        else:
            assert_evidence(evidence.get('daily'))
        if availability.get('officialCollection') == 'missing':
            assert metrics.get('officialCollectionRate') is None and evidence.get('officialCollection') is None, row
        else:
            assert_evidence(evidence.get('officialCollection'))

    summary = analysis['summary']
    assert summary['stable'] + summary['attention'] + summary['insufficient'] == 56
    assert summary['dataComplete'] + summary['dataIncomplete'] == 56
    return {
        'paymentCenters': len(payments),
        'analysisCenters': len(rows),
        'uniquePairs': len(analysis_pairs),
        'businessDate': analysis.get('businessDate'),
        'publicationStatus': analysis.get('publicationStatus'),
        'collectionPublicationStatus': analysis.get('collectionPublicationStatus'),
        'coverage': analysis.get('coverage'),
        'summary': summary,
    }


def validate_viewport(browser, token: str, name: str, viewport: dict[str, int], expected: dict[str, Any]) -> dict[str, Any]:
    context = browser.new_context(viewport=viewport)
    context.add_init_script(script=init_script(token))
    page = context.new_page()
    console_errors: list[str] = []
    page_errors: list[str] = []
    failed_requests: list[dict[str, str]] = []
    error_responses: list[dict[str, Any]] = []
    requests: list[str] = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.on('pageerror', lambda error: page_errors.append(str(error)))
    page.on('request', lambda request: requests.append(request.url))
    page.on('requestfailed', lambda request: failed_requests.append({'url': request.url, 'error': request.failure or ''}) if request.failure != 'net::ERR_ABORTED' else None)
    page.on('response', lambda response: error_responses.append({'url': response.url, 'status': response.status}) if response.status >= 400 else None)

    response = page.goto(BASE + '/ai-alerts', wait_until='domcontentloaded', timeout=30_000)
    assert response and response.status == 200
    root = page.locator('[data-r56-ai-center-app]')
    root.wait_for(state='visible', timeout=20_000)
    extra_css = os.environ.get('R56_QA_EXTRA_CSS')
    if extra_css:
        page.add_style_tag(path=str(Path(extra_css).resolve()))
    page.wait_for_function("document.querySelectorAll('[data-r56-center-row]').length === 56", timeout=20_000)
    rows = page.locator('[data-r56-center-row]')
    assert rows.count() == 56
    title = root.locator('.r56-page-header h2').inner_text()
    assert title == '56个服务中心，逐一给出经营判断', title
    summaries = root.locator('[data-r56-summary]').all_inner_texts()
    assert any(str(expected['summary']['attention']) in value for value in summaries), summaries
    overflow = page.evaluate('Math.max(0, document.documentElement.scrollWidth - innerWidth)')
    assert overflow <= 1, overflow

    attention = str(expected['summary']['attention'])
    page.locator('#r56-status-filter').select_option('attention')
    page.wait_for_function(
        "expected => document.querySelectorAll('[data-r56-center-row]').length === expected",
        arg=int(attention),
    )
    assert rows.count() == int(attention)
    page.locator('#r56-status-filter').select_option('all')
    page.wait_for_function("document.querySelectorAll('[data-r56-center-row]').length === 56")

    first_toggle = page.locator('[data-r56-center-toggle]').first
    first_toggle.focus()
    first_toggle.press('Enter')
    first_detail = page.locator('[data-r56-center-row]').first
    assert first_detail.get_attribute('open') is not None
    first_detail.locator('[data-r56-center-evidence]').wait_for(state='visible')
    first_detail.evaluate("element => element.scrollIntoView({block:'start'})")
    page.wait_for_timeout(150)
    scroll_probe = first_detail.evaluate("""element => {
      const fixed = [...document.querySelectorAll('*')]
        .filter(node => {
          const style = getComputedStyle(node)
          const rect = node.getBoundingClientRect()
          return ['fixed','sticky'].includes(style.position) && rect.height > 0 && rect.top <= 1 && rect.bottom > 0
        })
        .reduce((bottom, node) => Math.max(bottom, node.getBoundingClientRect().bottom), 0)
      const rect = element.getBoundingClientRect()
      return {rowTop: rect.top, fixedBottom: fixed, scrollMarginTop: getComputedStyle(element).scrollMarginTop}
    }""")
    assert float(str(scroll_probe['scrollMarginTop']).replace('px', '')) >= (100 if name == 'mobile-390' else 80), scroll_probe
    assert scroll_probe['rowTop'] + 1 >= scroll_probe['fixedBottom'], scroll_probe

    screenshot = OUT / f'{name}-ai-alerts.png'
    page.screenshot(path=str(screenshot), full_page=False)

    protected: dict[str, Any] = {}
    for route, identity in {'/daily': '每日回款', '/payment': '回款', '/collection': '收缴率'}.items():
        before = sum('/api/ai/service-centers' in url for url in requests)
        page.evaluate("""route => {
          history.pushState(history.state, '', route)
          dispatchEvent(new PopStateEvent('popstate', {state: history.state}))
        }""", route)
        page.wait_for_function("route => location.pathname === route", arg=route)
        page.locator('main').first.wait_for(state='visible', timeout=15_000)
        page.wait_for_function(
            "identity => [...document.querySelectorAll('main *')].some(node => node.getClientRects().length && (node.textContent || '').includes(identity))",
            arg=identity,
            timeout=15_000,
        )
        assert page.locator('[data-r56-ai-center-app]').count() == 0
        after = sum('/api/ai/service-centers' in url for url in requests)
        assert after == before
        protected[route] = {'path': page.url, 'identity': identity, 'r56Root': 0, 'serviceCenterRequests': 0}

    assert not console_errors, console_errors
    assert not page_errors, page_errors
    assert not failed_requests, failed_requests
    assert not error_responses, error_responses
    old_requests = [url for url in requests if '/api/alerts' in url or '/api/tasks' in url]
    assert not old_requests, old_requests
    service_requests = [url for url in requests if '/api/ai/service-centers' in url]
    assert len(service_requests) == 1, service_requests

    result = {
        'viewport': viewport,
        'rows': 56,
        'title': title,
        'summaries': summaries,
        'attentionFilterCount': int(attention),
        'overflow': overflow,
        'scrollProbe': scroll_probe,
        'serviceCenterRequests': len(service_requests),
        'oldAiRequests': old_requests,
        'consoleErrors': console_errors,
        'pageErrors': page_errors,
        'failedRequests': failed_requests,
        'errorResponses': error_responses,
        'protectedRoutes': protected,
        'screenshot': str(screenshot),
    }
    context.close()
    return result


def main() -> None:
    token = shared.ephemeral_token()
    try:
        with sync_playwright() as playwright:
            request = playwright.request.new_context(
                base_url=BASE,
                extra_http_headers={'Authorization': f'Bearer {token}'},
            )
            api = validate_api(request)
            browser = playwright.chromium.launch(headless=True)
            viewports = {
                'desktop-1440': validate_viewport(browser, token, 'desktop-1440', {'width': 1440, 'height': 1000}, api),
                'mobile-390': validate_viewport(browser, token, 'mobile-390', {'width': 390, 'height': 844}, api),
            }
            browser.close()
            request.dispose()
        output = {'production': True, 'origin': BASE, 'release': 'cockpit-r56-ai-service-centers-20260812-234839', 'api': api, 'viewports': viewports}
        result_path = OUT / 'r56-ai-service-centers-production-results.json'
        result_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'api': api, 'viewports': {key: {'rows': value['rows'], 'attentionFilterCount': value['attentionFilterCount'], 'overflow': value['overflow'], 'scrollProbe': value['scrollProbe'], 'errors': len(value['consoleErrors']) + len(value['pageErrors']) + len(value['failedRequests']) + len(value['errorResponses'])} for key, value in viewports.items()}, 'resultFile': str(result_path)}, ensure_ascii=False, indent=2))
    finally:
        token = ''


if __name__ == '__main__':
    main()
