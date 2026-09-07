#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright

import full_remediation_shadow_qa as qa

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/qa/frontend-skill-cloud-20260812/r53-ai-usability-production'
OUT.mkdir(parents=True, exist_ok=True)
BASE = 'https://firstcare.cloud'
ASSET = 'aph2-r50-ai-usability-20260812-v2'
DESKTOP_ROUTES = [
    '/', '/command', '/projects', '/payment', '/daily', '/collection', '/arrears',
    '/ai-alerts', '/ai-report', '/import', '/review', '/system', '/admin', '/tasks',
]
MOBILE_ROUTES = ['/', '/projects', '/tasks', '/ai-alerts', '/ai-report']


def capture_errors(page):
    console_errors, page_errors, failed_requests = [], [], []
    page.on(
        'console',
        lambda message: console_errors.append(message.text)
        if message.type == 'error' and '409 (Conflict)' not in message.text
        else None,
    )
    page.on('pageerror', lambda error: page_errors.append(str(error)))
    page.on(
        'requestfailed',
        lambda request: failed_requests.append(request.url)
        if request.failure != 'net::ERR_ABORTED'
        else None,
    )
    return console_errors, page_errors, failed_requests


def init_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R53生产验收',role:'admin'}));"
    )


def route_probe(page, route: str, mobile: bool) -> dict:
    response = page.goto(BASE + route, wait_until='domcontentloaded', timeout=30_000)
    page.wait_for_timeout(1_600)
    launcher = page.locator('#north-ai-assistant .north-ai-launcher')
    launcher.wait_for(state='visible', timeout=12_000)
    box = launcher.bounding_box()
    gate_actions = page.locator('.aph-r50-ai-actions button')
    # 服务中心级预警现已使用已验证回款/收缴事实正式生成；只有项目月报仍受项目主数据门禁阻断。
    expected_actions = 2 if route == '/ai-report' else 0
    if expected_actions:
        gate_actions.first.wait_for(state='visible', timeout=12_000)
    resources = page.evaluate(
        "asset => performance.getEntriesByType('resource').map(item => item.name).filter(name => name.includes(asset))",
        ASSET,
    )
    result = {
        'status': response.status if response else None,
        'path': page.evaluate('location.pathname'),
        'title': page.title(),
        'launcher': box,
        'gateActions': gate_actions.all_inner_texts(),
        'overflow': page.evaluate('Math.max(0, document.documentElement.scrollWidth - innerWidth)'),
        'resources': resources,
    }
    assert response and response.status == 200, (route, result)
    assert resources, (route, result)
    assert box and box['width'] >= 44 and box['height'] >= 44, (route, result)
    assert len(result['gateActions']) == expected_actions, (route, result)
    if route == '/ai-alerts':
        assert page.get_by_text('56个服务中心，逐一给出经营判断', exact=True).count() == 1, result
    assert result['overflow'] <= 1, (route, result)
    if mobile:
        assert box['y'] + box['height'] <= 844 - 72, (route, result)
    return result


def assistant_probe(page) -> dict:
    response = page.goto(BASE + '/ai-alerts', wait_until='domcontentloaded', timeout=30_000)
    page.wait_for_timeout(1_800)
    assert response and response.status == 200
    page.locator('.aph-r50-ai-actions button').first.click()
    panel = page.locator('.north-ai-overlay[aria-hidden="false"] .north-ai-panel')
    panel.wait_for(state='visible', timeout=10_000)
    input_box = page.locator('.north-ai-input')
    input_box.wait_for(state='visible', timeout=10_000)
    assert input_box.evaluate('input => document.activeElement === input')

    input_box.fill('当前有哪些数据质量问题？')
    with page.expect_response(
        lambda item: '/api/ai/assistant/ask' in item.url,
        timeout=55_000,
    ) as answer_info:
        page.locator('.north-ai-composer').evaluate('form => form.requestSubmit()')
    answer_response = answer_info.value
    answer_payload = answer_response.json()
    page.locator('.north-ai-message-assistant:not(.north-ai-message-loading)').last.wait_for(
        state='visible', timeout=55_000,
    )
    assert answer_response.status == 200, answer_payload
    assert answer_payload.get('readOnly') is True, answer_payload
    assert answer_payload.get('answer'), answer_payload
    assert answer_payload.get('sources'), answer_payload
    assert page.locator('.aph-r50-ai-recovery').count() == 0

    input_box.fill('哪个项目风险最高？')
    with page.expect_response(
        lambda item: '/api/ai/assistant/ask' in item.url,
        timeout=30_000,
    ) as gate_info:
        page.locator('.north-ai-composer').evaluate('form => form.requestSubmit()')
    gate_response = gate_info.value
    gate_payload = gate_response.json()
    recoveries = page.locator('.aph-r50-ai-recovery')
    assert recoveries.count() == 1
    recovery = recoveries.last
    recovery.wait_for(state='visible', timeout=12_000)
    recovery_buttons = recovery.locator('button').all_inner_texts()
    assert gate_response.status == 409, gate_payload
    assert gate_payload.get('code') == 'PROJECT_DATA_QUALITY_BLOCKED', gate_payload
    assert len(recovery_buttons) == 3, recovery_buttons
    assert input_box.is_enabled()
    assert page.locator('.north-ai-send').is_enabled()

    return {
        'answerStatus': answer_response.status,
        'generatedBy': answer_payload.get('generatedBy'),
        'fallbackUsed': answer_payload.get('fallbackUsed'),
        'topic': answer_payload.get('topic'),
        'qualityStatus': answer_payload.get('qualityStatus'),
        'sourceCount': len(answer_payload.get('sources') or []),
        'citationCount': len(answer_payload.get('citations') or []),
        'answerLength': len(answer_payload.get('answer') or ''),
        'projectStatus': gate_response.status,
        'projectCode': gate_payload.get('code'),
        'recoveryButtons': recovery_buttons,
    }


def main():
    token = qa.ephemeral_token()
    results = {'desktopRoutes': {}, 'mobileRoutes': {}, 'assistant': {}}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for viewport_name, viewport, routes in [
                ('desktop', {'width': 1440, 'height': 1000}, DESKTOP_ROUTES),
                ('mobile', {'width': 390, 'height': 844}, MOBILE_ROUTES),
            ]:
                context = browser.new_context(viewport=viewport)
                context.add_init_script(script=init_script(token))
                page = context.new_page()
                console_errors, page_errors, failed_requests = capture_errors(page)
                target = results['mobileRoutes' if viewport_name == 'mobile' else 'desktopRoutes']
                for route in routes:
                    target[route] = route_probe(page, route, viewport_name == 'mobile')
                results['assistant'][viewport_name] = assistant_probe(page)
                assert not console_errors and not page_errors and not failed_requests, {
                    'viewport': viewport_name,
                    'consoleErrors': console_errors,
                    'pageErrors': page_errors,
                    'failedRequests': failed_requests,
                }
                context.close()
            browser.close()

        result_file = OUT / 'r53-ai-usability-production-results.json'
        result_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({
            'desktopRoutes': len(results['desktopRoutes']),
            'mobileRoutes': len(results['mobileRoutes']),
            'assistantViewports': len(results['assistant']),
            'resultFile': str(result_file),
        }, ensure_ascii=False))
    finally:
        token = ''


if __name__ == '__main__':
    main()
