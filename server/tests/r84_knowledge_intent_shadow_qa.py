#!/usr/bin/env python3
from __future__ import annotations

import json

from r55_retrieval_first_shadow_qa import ask, ephemeral_tokens, service_environment


def main() -> None:
    environment = service_environment()
    token = ephemeral_tokens(environment)['admin']
    status, payload = ask(token, '第一服务新建改造作业标准', 'aph')
    assert status == 200, (status, payload)
    assert payload.get('topic') == 'knowledge', payload
    assert payload.get('generatedBy') == 'hermes-grounded', payload
    assert payload.get('fallbackUsed') is False and payload.get('readOnly') is True, payload
    assert payload.get('centerPaymentLookup') is None, payload
    answer = str(payload.get('answer') or '')
    assert '第一服务工程新建、改造管理作业标准' in answer, payload
    assert '新建' in answer and '改造' in answer, payload
    citations = payload.get('citations') or []
    assert {item.get('documentId') for item in citations} == {'first-service-oa-1604'}, payload
    assert any('PM4-SS-68' in str(item.get('title') or '') for item in citations), payload
    print(json.dumps({
        'status': status,
        'topic': payload.get('topic'),
        'generatedBy': payload.get('generatedBy'),
        'titleMatched': '第一服务工程新建、改造管理作业标准' in answer,
        'citationIds': [item.get('documentId') for item in citations],
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
