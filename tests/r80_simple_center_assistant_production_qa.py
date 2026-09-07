#!/usr/bin/env python3
from __future__ import annotations

import json
import urllib.error
import urllib.request

import full_remediation_shadow_qa as qa
from playwright.sync_api import sync_playwright


BASE = 'https://firstcare.cloud'


def init_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R80生产验收',role:'admin'}));"
    )


def ask(token: str, question: str):
    request = urllib.request.Request(
        f'{BASE}/api/ai/assistant/ask',
        data=json.dumps({'question': question, 'topic': '', 'history': []}, ensure_ascii=False).encode(),
        method='POST',
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def assert_success(payload: dict) -> None:
    center = payload.get('centerPayment') or {}
    facts = payload.get('facts') or {}
    assert payload.get('generatedBy') == 'hermes-grounded', payload
    assert payload.get('fallbackUsed') is False and payload.get('readOnly') is True, payload
    assert payload.get('centerPaymentLookup') == 'matched', payload
    assert center.get('center') == '第一服务北京上第MOMΛ服务中心', payload
    assert payload.get('businessDate') == '2026-08-13', payload
    assert abs(float(center.get('cumulativeExecuted')) - 1305.03) < 0.001, payload
    assert abs(float(facts.get('cumulativeVariance')) - (-7.01)) < 0.001, payload
    assert abs(float(facts.get('samePeriodVariance')) - (-199.97)) < 0.001, payload
    assert abs(float(facts.get('yearOverYearGrowthRate')) - (-13.29)) < 0.001, payload
    assert {item.get('code') for item in payload.get('signals') or []} >= {
        'aph-budget-gap', 'aph-yoy-decline',
    }, payload
    answer = str(payload.get('answer') or '').replace(',', '')
    for expected in ('1305.03', '1312.04', '1505', '7.01', '199.97', '13.29'):
        assert expected in answer, payload
    assert '累计回款低于累计预算' in answer and '累计回款同比下降' in answer, payload
    assert '建议' in answer and '[K' in answer, payload
    assert payload.get('citations'), payload


def main() -> None:
    token = qa.ephemeral_token()
    results = []
    for question in ('上第数据', '上第哪些指标没达标，给我建议'):
        status, payload = ask(token, question)
        assert status == 200, payload
        assert_success(payload)
        results.append({
            'question': question,
            'status': status,
            'businessDate': payload.get('businessDate'),
            'generatedBy': payload.get('generatedBy'),
            'citationCount': len(payload.get('citations') or []),
        })

    status, ambiguous = ask(token, '万国城数据')
    assert status == 422 and ambiguous.get('centerPaymentLookup') == 'ambiguous', ambiguous
    status, project = ask(token, '上第项目利润和品质数据')
    assert status == 409 and project.get('code') == 'PROJECT_DATA_QUALITY_BLOCKED', project

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        context.add_init_script(script=init_script(token))
        page = context.new_page()
        console_errors: list[str] = []
        page_errors: list[str] = []
        failed_requests: list[str] = []
        page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
        page.on('pageerror', lambda error: page_errors.append(str(error)))
        page.on('requestfailed', lambda request: failed_requests.append(request.url) if request.failure != 'net::ERR_ABORTED' else None)

        response = page.goto(BASE + '/', wait_until='domcontentloaded', timeout=30_000)
        assert response and response.status == 200
        launcher = page.locator('button.aph-r64-ai-launcher')
        launcher.wait_for(state='visible', timeout=15_000)
        launcher.click()
        page.locator('.north-ai-input').fill('上第哪些指标没达标，给我建议')
        with page.expect_response(lambda item: '/api/ai/assistant/ask' in item.url, timeout=60_000) as info:
            page.locator('.north-ai-composer').evaluate('form => form.requestSubmit()')
        assistant_response = info.value
        assistant_payload = assistant_response.json()
        assert assistant_response.status == 200, assistant_payload
        assert_success(assistant_payload)
        message = page.locator('.north-ai-message-assistant:not(.north-ai-message-loading)').last
        message.wait_for(state='visible', timeout=60_000)
        copy = message.inner_text().replace(',', '')
        for expected in ('第一服务北京上第MOMΛ服务中心', '1305.03', '1312.04', '1505', '7.01', '199.97', '13.29', 'AI建议'):
            assert expected in copy, copy
        knowledge = page.locator('.north-ai-knowledge[aria-label="知识引用"]')
        knowledge.wait_for(state='visible', timeout=10_000)
        assert 'PM4-KF-01' in knowledge.inner_text(), knowledge.inner_text()
        assert not console_errors and not page_errors and not failed_requests, {
            'consoleErrors': console_errors,
            'pageErrors': page_errors,
            'failedRequests': failed_requests,
        }
        browser_result = {
            'status': assistant_response.status,
            'question': '上第哪些指标没达标，给我建议',
            'center': assistant_payload.get('centerPayment', {}).get('center'),
            'businessDate': assistant_payload.get('businessDate'),
            'knowledgeVisible': True,
            'consoleErrors': console_errors,
            'pageErrors': page_errors,
            'failedRequests': failed_requests,
        }
        context.close()
        browser.close()

    print(json.dumps({
        'productionQuestions': results,
        'ambiguousStatus': 422,
        'projectGateStatus': 409,
        'browser': browser_result,
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
