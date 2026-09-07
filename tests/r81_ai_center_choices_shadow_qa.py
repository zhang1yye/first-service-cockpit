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

BASE = 'https://firstcare.cloud'
ASSISTANT_JS = ROOT / 'firstcare-cloud-local' / 'north-ai-assistant-20260813-r55.js'
EVIDENCE_CSS = ROOT / 'firstcare-cloud-local' / 'aph2-r66-ai-evidence-20260813-v1.css'
USE_LOCAL_ASSETS = os.environ.get('QA_LOCAL_ASSETS', '1') != '0'
VIEWPORT = {
    'width': int(os.environ.get('QA_WIDTH', '390')),
    'height': int(os.environ.get('QA_HEIGHT', '844')),
}


def init_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R81隔离验收',role:'admin'}));"
    )


def main() -> None:
    token = qa.ephemeral_token()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport=VIEWPORT)
        context.add_init_script(script=init_script(token))
        page = context.new_page()
        console_errors: list[str] = []
        page_errors: list[str] = []
        failed_requests: list[str] = []
        page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
        page.on('pageerror', lambda error: page_errors.append(str(error)))
        page.on('requestfailed', lambda request: failed_requests.append(request.url) if request.failure != 'net::ERR_ABORTED' else None)

        if USE_LOCAL_ASSETS:
            page.route(
                '**/north-ai-assistant-20260813-r55.js*',
                lambda route: route.fulfill(path=ASSISTANT_JS, content_type='application/javascript; charset=utf-8'),
            )
            page.route(
                '**/aph2-r66-ai-evidence-20260813-v1.css*',
                lambda route: route.fulfill(path=EVIDENCE_CSS, content_type='text/css; charset=utf-8'),
            )

        response = page.goto(BASE + '/', wait_until='domcontentloaded', timeout=30_000)
        assert response and response.status == 200
        page.locator('button.aph-r64-ai-launcher').wait_for(state='visible', timeout=15_000)
        page.locator('button.aph-r64-ai-launcher').click()
        input_box = page.locator('.north-ai-input')
        input_box.fill('万国城数据')
        with page.expect_response(lambda item: '/api/ai/assistant/ask' in item.url, timeout=60_000) as first_info:
            page.locator('.north-ai-composer').evaluate('form => form.requestSubmit()')
        first_response = first_info.value
        first_payload = first_response.json()
        assert first_response.status == 422, first_payload
        assert first_payload.get('centerPaymentLookup') == 'ambiguous', first_payload

        choices = page.locator('.north-ai-center-choice')
        assert choices.count() == 3
        expected = [
            '第一服务北京万国城MOMΛ服务中心',
            '第一服务北京通州万国城MOMΛ服务中心',
            '第一酒店北京当代通州万国城MOMΛ体验中心',
        ]
        assert choices.all_inner_texts() == expected
        meta = page.locator('.north-ai-message-assistant:not(.north-ai-message-loading)').last.locator('.north-ai-meta')
        assert meta.get_by_text('服务中心名称待确认', exact=True).count() == 1
        assert '部分数据不可用' not in meta.inner_text()

        with page.expect_response(lambda item: '/api/ai/assistant/ask' in item.url, timeout=60_000) as second_info:
            choices.nth(1).click()
        second_response = second_info.value
        second_payload = second_response.json()
        assert second_response.status == 200, second_payload
        assert (second_payload.get('centerPayment') or {}).get('center') == expected[1], second_payload
        answer = page.locator('.north-ai-message-assistant:not(.north-ai-message-loading)').last
        answer.wait_for(state='visible', timeout=60_000)
        visible_answer = answer.inner_text()
        assert '通州万国城' in visible_answer
        assert '来源：' not in visible_answer
        assert '限制说明：' not in visible_answer
        assert '[K' not in visible_answer
        assert answer.locator('.north-ai-knowledge').count() == 0
        assert answer.locator('.north-ai-limitations').count() == 0
        unexpected_console_errors = [message for message in console_errors if '422' not in message]
        assert not unexpected_console_errors and not page_errors and not failed_requests, {
            'consoleErrors': unexpected_console_errors,
            'pageErrors': page_errors,
            'failedRequests': failed_requests,
        }

        print(json.dumps({
            'initialStatus': first_response.status,
            'candidateCount': choices.count(),
            'candidateLabels': expected,
            'selectedStatus': second_response.status,
            'selectedCenter': (second_payload.get('centerPayment') or {}).get('center'),
            'sourceHidden': '来源：' not in visible_answer,
            'limitationsHidden': '限制说明：' not in visible_answer,
            'knowledgeMarkersHidden': '[K' not in visible_answer,
            'viewport': VIEWPORT,
            'assetMode': 'local-shadow' if USE_LOCAL_ASSETS else 'production',
            'expectedAmbiguityConsoleNotice': console_errors,
            'unexpectedConsoleErrors': unexpected_console_errors,
            'pageErrors': page_errors,
            'failedRequests': failed_requests,
        }, ensure_ascii=False, indent=2))
        context.close()
        browser.close()


if __name__ == '__main__':
    main()
