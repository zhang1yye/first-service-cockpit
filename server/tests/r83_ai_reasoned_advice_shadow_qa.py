#!/usr/bin/env python3
from __future__ import annotations

import json

from r55_retrieval_first_shadow_qa import (
    ask,
    assert_knowledge_citations,
    call,
    ephemeral_tokens,
    normalized_numbers,
    service_environment,
)


def main() -> None:
    environment = service_environment()
    tokens = ephemeral_tokens(environment)
    payment_status, payment_rows = call(tokens['admin'], '/api/payments')
    assert payment_status == 200, payment_rows
    shangdi = [row for row in payment_rows if row.get('center') == '第一服务北京上第MOMΛ服务中心']
    assert len(shangdi) == 1, shangdi

    status, payload = ask(tokens['admin'], '上第哪些指标没达标，给我建议')
    assert status == 200, payload
    assert payload.get('generatedBy') == 'hermes-grounded', payload
    assert payload.get('fallbackUsed') is False and payload.get('readOnly') is True, payload
    assert payload.get('centerPaymentLookup') == 'matched', payload
    assert_knowledge_citations(payload)

    answer = normalized_numbers(str(payload.get('answer') or ''))
    assert 'AI判断' in answer, payload
    assert 'AI建议' in answer, payload
    assert '优先处理' in answer and '原因假设' in answer, payload
    for label in ('先做什么', '谁来协同', '所需材料', '完成凭证', '升级条件'):
        assert label in answer, payload
    assert '若' in answer and '则' in answer, payload
    assert '来源：' not in answer and '限制说明：' not in answer, payload
    assert '建议执行「' not in answer, payload
    assert '知识原文中的完整动作句' not in answer, payload
    assert '累计回款低于累计预算' in answer, payload
    assert '累计回款同比下降' in answer, payload
    for value in (
        shangdi[0].get('cumulativeExecuted'),
        shangdi[0].get('cumulativeBudget'),
        shangdi[0].get('samePeriod'),
    ):
        assert f'{float(value):.2f}' in answer, payload

    center_name = payload['centerPayment']['center']
    focused_answers: dict[str, str] = {}
    for label, question in (
        ('metrics', f'{center_name}哪些指标没达标'),
        ('analysis', f'{center_name}的异常重点是什么'),
        ('actions', f'{center_name}给我三个优先动作'),
    ):
        focused_status, focused = ask(tokens['admin'], question)
        assert focused_status == 200, {'label': label, 'payload': focused}
        expected_generator = 'verified-facts' if label == 'metrics' else 'hermes-grounded'
        assert focused.get('generatedBy') == expected_generator, {'label': label, 'payload': focused}
        focused_answers[label] = normalized_numbers(str(focused.get('answer') or ''))
    assert focused_answers['metrics'].startswith('未达标指标'), focused_answers
    assert 'AI判断' not in focused_answers['metrics'] and '先做什么' not in focused_answers['metrics'], focused_answers
    assert focused_answers['analysis'].startswith('异常重点'), focused_answers
    assert '先做什么' not in focused_answers['analysis'] and '中心数据' not in focused_answers['analysis'], focused_answers
    assert focused_answers['actions'].startswith('一线执行卡'), focused_answers
    assert all(item in focused_answers['actions'] for item in ('先做什么', '谁来协同', '所需材料', '完成凭证', '升级条件')), focused_answers
    assert len(set(focused_answers.values())) == 3, focused_answers

    print(json.dumps({
        'status': status,
        'center': payload.get('centerPayment', {}).get('center'),
        'businessDate': payload.get('businessDate'),
        'generatedBy': payload.get('generatedBy'),
        'hasAiAssessment': 'AI判断' in answer,
        'hasReasonedAction': 'AI建议' in answer,
        'hasFrontlineCard': all(label in answer for label in ('先做什么', '谁来协同', '所需材料', '完成凭证', '升级条件')),
        'sourceHiddenInAnswer': '来源：' not in answer,
        'verbatimTemplateAbsent': '建议执行「' not in answer,
        'citationCount': len(payload.get('citations') or []),
        'focusedAnswersDistinct': len(set(focused_answers.values())) == 3,
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
