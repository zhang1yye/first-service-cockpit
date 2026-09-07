#!/usr/bin/env python3
from __future__ import annotations

import json

from playwright.sync_api import sync_playwright

import full_remediation_shadow_qa as qa


def main() -> None:
    token = qa.ephemeral_token()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 390, 'height': 844})
        context.add_init_script(script=(
            f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
            f"localStorage.setItem('token',{json.dumps(token)});"
            "localStorage.setItem('cockpit_user',JSON.stringify({name:'R85生产验收',role:'admin'}));"
        ))
        page = context.new_page()
        console_errors: list[str] = []
        page_errors: list[str] = []
        failed_requests: list[str] = []
        page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
        page.on('pageerror', lambda error: page_errors.append(str(error)))
        page.on('requestfailed', lambda request: failed_requests.append(request.url))

        response = page.goto('https://firstcare.cloud/', wait_until='domcontentloaded', timeout=30_000)
        assert response and response.status == 200
        page.locator('button.aph-r64-ai-launcher').wait_for(state='visible', timeout=15_000)
        page.locator('button.aph-r64-ai-launcher').click()
        page.locator('.north-ai-input').fill('上第怎么样')
        with page.expect_response(lambda item: '/api/ai/assistant/ask' in item.url, timeout=60_000) as info:
            page.locator('.north-ai-composer').evaluate('form => form.requestSubmit()')
        api_response = info.value
        payload = api_response.json()
        assert api_response.status == 200, payload
        assert payload.get('generatedBy') == 'hermes-grounded', payload
        assert (payload.get('centerPayment') or {}).get('center') == '第一服务北京上第MOMΛ服务中心', payload

        answer = page.locator('.north-ai-message-assistant:not(.north-ai-message-loading)').last
        answer.wait_for(state='visible', timeout=60_000)
        visible = answer.inner_text()
        for heading in ('中心数据', '未达标项', 'AI判断', '核心矛盾', '待验证假设', 'AI建议', '验证方案', '分支决策', '观察触发'):
            assert heading in visible, {'missing': heading, 'answer': visible}
        assert '来源：' not in visible and '限制说明：' not in visible and '[K' not in visible
        follow_ups = answer.locator('.north-ai-follow-ups .north-ai-center-choice')
        assert follow_ups.all_inner_texts() == ['看未达标指标', '分析异常重点', '给三个优先动作']
        focused_answers: dict[str, str] = {}
        for label, expected_heading in (
            ('看未达标指标', '未达标指标'),
            ('分析异常重点', '异常重点'),
            ('给三个优先动作', '三个优先动作'),
        ):
            current = page.locator('.north-ai-message-assistant:not(.north-ai-message-loading)').last
            button = current.locator('.north-ai-follow-ups .north-ai-center-choice').get_by_text(label, exact=True)
            with page.expect_response(lambda item: '/api/ai/assistant/ask' in item.url, timeout=60_000) as focused_info:
                button.evaluate('element => element.click()')
            focused_response = focused_info.value
            focused_payload = focused_response.json()
            assert focused_response.status == 200, focused_payload
            expected_generator = 'verified-facts' if label == '看未达标指标' else 'hermes-grounded'
            assert focused_payload.get('generatedBy') == expected_generator, focused_payload
            focused_answer = page.locator('.north-ai-message-assistant:not(.north-ai-message-loading)').last
            focused_answer.wait_for(state='visible', timeout=60_000)
            focused_text = focused_answer.locator('.north-ai-bubble').inner_text()
            assert focused_text.startswith(expected_heading), {'label': label, 'answer': focused_text}
            focused_answers[label] = focused_text
        assert 'AI判断' not in focused_answers['看未达标指标']
        assert '验证方案' not in focused_answers['分析异常重点']
        assert all(item in focused_answers['给三个优先动作'] for item in ('验证方案', '分支决策', '观察触发'))
        assert len(set(focused_answers.values())) == 3, focused_answers
        assert not console_errors and not page_errors and not failed_requests, {
            'consoleErrors': console_errors,
            'pageErrors': page_errors,
            'failedRequests': failed_requests,
        }
        print(json.dumps({
            'status': api_response.status,
            'center': payload['centerPayment']['center'],
            'generatedBy': payload.get('generatedBy'),
            'threeStepAdvice': True,
            'sourceHidden': True,
            'followUps': follow_ups.all_inner_texts(),
            'focusedAnswersDistinct': len(set(focused_answers.values())) == 3,
            'consoleErrors': console_errors,
            'pageErrors': page_errors,
            'failedRequests': failed_requests,
        }, ensure_ascii=False, indent=2))
        context.close()
        browser.close()


if __name__ == '__main__':
    main()
