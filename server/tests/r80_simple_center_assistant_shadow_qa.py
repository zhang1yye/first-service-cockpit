#!/usr/bin/env python3
from __future__ import annotations

import json

from r55_retrieval_first_shadow_qa import (
    ask,
    assert_knowledge_citations,
    ephemeral_tokens,
    normalized_numbers,
    service_environment,
)


QUESTIONS = (
    '上第数据',
    '看一下上第服务中心的指标',
    '上第哪些指标没达标，给我建议',
)


def assert_simple_answer(payload: dict) -> None:
    center = payload.get('centerPayment') or {}
    facts = payload.get('facts') or {}
    assert payload.get('generatedBy') == 'hermes-grounded', payload
    assert payload.get('fallbackUsed') is False and payload.get('readOnly') is True, payload
    assert payload.get('centerPaymentLookup') == 'matched', payload
    assert center.get('center') == '第一服务北京上第MOMΛ服务中心', payload
    assert payload.get('businessDate') == '2026-08-13', payload
    for actual, expected in (
        (center.get('annualBudget'), 2238.93),
        (center.get('cumulativeBudget'), 1312.04),
        (center.get('cumulativeExecuted'), 1305.03),
        (center.get('samePeriod'), 1505.00),
        (center.get('dailyCollection'), 2.32),
        (facts.get('cumulativeVariance'), -7.01),
        (facts.get('samePeriodVariance'), -199.97),
        (facts.get('cumulativeCompletionRate'), 99.47),
        (facts.get('annualExecutionRate'), 58.29),
        (facts.get('yearOverYearGrowthRate'), -13.29),
    ):
        assert abs(float(actual) - expected) < 0.001, payload
    signals = {item.get('code') for item in payload.get('signals') or []}
    assert {'aph-budget-gap', 'aph-yoy-decline'} <= signals, payload
    answer = normalized_numbers(str(payload.get('answer') or ''))
    for expected in (
        '2238.93', '1312.04', '1305.03', '1505', '2.32',
        '7.01', '199.97', '99.47', '58.29', '13.29',
    ):
        assert expected in answer, payload
    assert '累计回款低于累计预算' in answer and '累计回款同比下降' in answer, payload
    assert any(word in answer for word in ('建议', '应当', '需要', '可以', '优先')), payload
    assert '[K' in answer, payload
    assert_knowledge_citations(payload)


def main() -> None:
    environment = service_environment()
    tokens = ephemeral_tokens(environment)
    results = []
    for question in QUESTIONS:
        status, payload = ask(tokens['admin'], question)
        assert status == 200, {'question': question, 'payload': payload}
        assert_simple_answer(payload)
        results.append({
            'question': question,
            'status': status,
            'center': payload['centerPayment']['center'],
            'businessDate': payload['businessDate'],
            'signals': [item.get('code') for item in payload.get('signals') or []],
            'generatedBy': payload.get('generatedBy'),
            'citationCount': len(payload.get('citations') or []),
        })

    status, ambiguous = ask(tokens['admin'], '万国城数据')
    assert status == 422 and ambiguous.get('centerPaymentLookup') == 'ambiguous', ambiguous

    status, denied = ask(tokens['other'], '上第数据')
    assert status == 403 and denied.get('code') == 'SERVICE_CENTER_OUT_OF_SCOPE', denied

    status, project = ask(tokens['admin'], '上第项目利润和品质数据')
    assert status == 409 and project.get('code') == 'PROJECT_DATA_QUALITY_BLOCKED', project

    print(json.dumps({
        'simpleQuestions': results,
        'ambiguousStatus': 422,
        'crossScopeStatus': 403,
        'projectGateStatus': 409,
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
