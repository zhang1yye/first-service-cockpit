#!/usr/bin/env python3
from __future__ import annotations

import json

from r55_retrieval_first_shadow_qa import ask, ephemeral_tokens, service_environment


QUESTION = '第一服务八个一级专业'
EXPECTED = [
    '投资发展专业',
    '科技设施专业',
    '客户服务专业',
    '社区经营专业',
    '五个三专业',
    '计划财务专业',
    '信息运营专业',
    '人力资源与行政专业',
]


def main() -> None:
    environment = service_environment()
    token = ephemeral_tokens(environment)['admin']
    status, payload = ask(token, QUESTION, '')
    assert status == 200, (status, payload)
    assert payload.get('topic') == 'knowledge', payload
    assert payload.get('generatedBy') == 'hermes-grounded', payload
    assert payload.get('fallbackUsed') is False and payload.get('readOnly') is True, payload
    answer = str(payload.get('answer') or '')
    for name in EXPECTED:
        assert name in answer, (name, payload)
    assert 'AI回答服务暂时不可用' not in answer, payload
    assert '文件名称' not in answer and '版本' not in answer and '来源：' not in answer, payload
    citations = payload.get('citations') or []
    assert [item.get('documentId') for item in citations] == ['first-service-oa-2437'], payload
    print(json.dumps({
        'status': status,
        'topic': payload.get('topic'),
        'generatedBy': payload.get('generatedBy'),
        'answerHasAllEight': all(name in answer for name in EXPECTED),
        'sourceMetadataHiddenInAnswer': all(term not in answer for term in ['文件名称', '版本', '来源：']),
        'citationIds': [item.get('documentId') for item in citations],
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
