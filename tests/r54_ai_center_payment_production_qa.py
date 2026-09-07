#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
import full_remediation_shadow_qa as qa  # noqa: E402

BASE = os.environ.get('QA_BASE_URL', 'https://firstcare.cloud').rstrip('/')


def init_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R54生产验收',role:'admin'}));"
    )


def post_question(request, question: str, topic: str = ''):
    response = request.post(
        '/api/ai/assistant/ask',
        data={'question': question, 'topic': topic, 'history': []},
        timeout=60_000,
    )
    payload = response.json()
    return response.status, payload


def assert_shangdi(payload: dict) -> None:
    fact = payload.get('centerPayment') or {}
    assert payload.get('topic') == 'aph', payload
    assert payload.get('centerPaymentLookup') == 'matched', payload
    assert fact.get('center') == '第一服务北京上第MOMΛ服务中心', payload
    assert fact.get('businessDate') == '2026-08-12', payload
    assert abs(float(fact.get('annualBudget')) - 2238.93) < 0.001, payload
    assert abs(float(fact.get('cumulativeBudget')) - 1312.04) < 0.001, payload
    assert abs(float(fact.get('cumulativeExecuted')) - 1300.17) < 0.001, payload
    assert abs(float(fact.get('samePeriod')) - 1505.00) < 0.001, payload
    assert abs(float(fact.get('dailyCollection')) - 0.07) < 0.001, payload
    assert payload.get('sources', [{}])[0].get('name') == 'FineReport日报+预算周报+执行评估中心明细', payload
    answer = str(payload.get('answer') or '')
    assert '上第' in answer, payload
    assert '未提供上第' not in answer and '无任何项目级回款' not in answer, payload


def main() -> None:
    token = qa.ephemeral_token()
    results: dict[str, object] = {'base': BASE, 'api': {}, 'browser': {}}
    try:
        with sync_playwright() as playwright:
            request = playwright.request.new_context(
                base_url=BASE,
                extra_http_headers={'Authorization': f'Bearer {token}'},
            )

            health = request.get('/api/health', timeout=20_000)
            assert health.status == 200, health.text()

            payments = request.get('/api/payments', timeout=20_000)
            assert payments.status == 200, payments.text()
            payment_rows = payments.json()
            shangdi_rows = [row for row in payment_rows if '上第' in str(row.get('center') or '')]
            assert len(shangdi_rows) == 1, shangdi_rows
            assert abs(float(shangdi_rows[0]['cumulativeExecuted']) - 1300.17) < 0.001

            for label, question, topic in [
                ('shortName', '上第的回款情况', ''),
                ('fullName', '第一服务北京上第MOMΛ服务中心的回款情况', ''),
                ('spacedBrand', '上第 MOM Λ 的回款情况', ''),
                ('staleProjectTopic', '上第的回款情况', 'project'),
                ('mixedProjectPayment', '上第项目的回款情况', 'project'),
            ]:
                status, payload = post_question(request, question, topic)
                assert status == 200, payload
                assert_shangdi(payload)
                results['api'][label] = {
                    'status': status,
                    'topic': payload.get('topic'),
                    'lookup': payload.get('centerPaymentLookup'),
                    'generatedBy': payload.get('generatedBy'),
                    'businessDate': payload.get('businessDate'),
                }

            ambiguous_status, ambiguous = post_question(request, '万国城的回款情况')
            assert ambiguous_status == 200, ambiguous
            assert ambiguous.get('centerPaymentLookup') == 'ambiguous', ambiguous
            assert not ambiguous.get('centerPayment'), ambiguous
            assert '任选一条' in str(ambiguous.get('answer') or ''), ambiguous
            results['api']['ambiguous'] = {
                'status': ambiguous_status,
                'lookup': ambiguous.get('centerPaymentLookup'),
                'candidates': len(ambiguous.get('centerPaymentCandidates') or []),
            }

            missing_status, missing = post_question(request, '不存在中心的回款情况')
            assert missing_status == 200, missing
            assert missing.get('centerPaymentLookup') == 'not-found', missing
            assert not missing.get('centerPayment'), missing
            results['api']['notFound'] = {'status': missing_status, 'lookup': missing.get('centerPaymentLookup')}

            project_status, project = post_question(request, '上第项目的利润和品质情况', 'aph')
            assert project_status == 409, project
            assert project.get('code') == 'PROJECT_DATA_QUALITY_BLOCKED', project
            results['api']['projectGate'] = {'status': project_status, 'code': project.get('code')}

            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={'width': 1440, 'height': 1000})
            context.add_init_script(script=init_script(token))
            page = context.new_page()
            console_errors: list[str] = []
            page_errors: list[str] = []
            failed_requests: list[str] = []
            page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
            page.on('pageerror', lambda error: page_errors.append(str(error)))
            page.on('requestfailed', lambda req: failed_requests.append(req.url) if req.failure != 'net::ERR_ABORTED' else None)

            response = page.goto(BASE + '/payment', wait_until='domcontentloaded', timeout=30_000)
            assert response and response.status == 200
            page.wait_for_timeout(1_500)
            row = page.get_by_text('第一服务北京上第MOMΛ服务中心', exact=True)
            row.first.wait_for(state='visible', timeout=15_000)

            page.locator('#north-ai-assistant .north-ai-launcher').click()
            input_box = page.locator('.north-ai-input')
            input_box.wait_for(state='visible', timeout=10_000)
            input_box.fill('上第的回款情况')
            with page.expect_response(lambda item: '/api/ai/assistant/ask' in item.url, timeout=60_000) as info:
                page.locator('.north-ai-composer').evaluate('form => form.requestSubmit()')
            assistant_response = info.value
            assistant_payload = assistant_response.json()
            assert assistant_response.status == 200, assistant_payload
            assert_shangdi(assistant_payload)
            message = page.locator('.north-ai-message-assistant:not(.north-ai-message-loading)').last
            message.wait_for(state='visible', timeout=60_000)
            copy = message.inner_text()
            assert '上第' in copy and ('1,300.17' in copy or '1300.17' in copy), copy
            assert '未提供上第' not in copy and '不含上第' not in copy, copy
            assert not console_errors and not page_errors and not failed_requests, {
                'consoleErrors': console_errors,
                'pageErrors': page_errors,
                'failedRequests': failed_requests,
            }
            results['browser'] = {
                'paymentRowVisible': True,
                'assistantStatus': assistant_response.status,
                'assistantLookup': assistant_payload.get('centerPaymentLookup'),
                'assistantGeneratedBy': assistant_payload.get('generatedBy'),
                'answerContainsExecuted': '1,300.17' in copy or '1300.17' in copy,
                'consoleErrors': console_errors,
                'pageErrors': page_errors,
                'failedRequests': failed_requests,
            }
            context.close()
            browser.close()
            request.dispose()

        print(json.dumps(results, ensure_ascii=False, indent=2))
    finally:
        token = ''


if __name__ == '__main__':
    main()
