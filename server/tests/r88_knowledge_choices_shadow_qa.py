#!/usr/bin/env python3
from __future__ import annotations

import json

from r55_retrieval_first_shadow_qa import ask, ephemeral_tokens, service_environment


EXPECTED = {
    'first-service-oa-e1b31384-3f5f-44fd-9311-e25631c25fff': {
        'version': '13.0',
        'scope': '适用于第一服务控股（含第一酒店）薪酬管理',
    },
    'first-service-oa-9c7e3941-17e7-4efe-acdc-4f5c9e18c11c': {
        'version': '1.0',
        'scope': '适用于山东上诚物业薪酬管理',
    },
}


def main() -> None:
    environment = service_environment()
    token = ephemeral_tokens(environment)['admin']

    status, payload = ask(token, '薪酬管理作业标准', '')
    assert status == 409, (status, payload)
    assert payload.get('code') == 'KNOWLEDGE_SELECTION_REQUIRED', payload
    assert payload.get('answer') is None, payload
    assert payload.get('generatedBy') is None and payload.get('modelUsed') is None, payload
    assert payload.get('citations') == [] and payload.get('fallbackUsed') is False, payload

    choices = payload.get('knowledgeChoices') or []
    by_id = {item.get('documentId'): item for item in choices}
    assert set(by_id) == set(EXPECTED), payload
    for document_id, expected in EXPECTED.items():
        item = by_id[document_id]
        assert item.get('version') == expected['version'], item
        assert item.get('scope') == expected['scope'], item
        assert item.get('question') and item.get('title') == item.get('question'), item

    selected = {}
    for document_id, choice in by_id.items():
        selected_status, selected_payload = ask(token, choice['question'], 'knowledge')
        assert selected_status == 200, (selected_status, selected_payload)
        assert selected_payload.get('generatedBy') == 'hermes-grounded', selected_payload
        assert selected_payload.get('fallbackUsed') is False and selected_payload.get('readOnly') is True, selected_payload
        citation_ids = [item.get('documentId') for item in selected_payload.get('citations') or []]
        assert citation_ids == [document_id], selected_payload
        selected[document_id] = citation_ids

    print(json.dumps({
        'ambiguousStatus': status,
        'code': payload.get('code'),
        'choices': [
            {'title': item.get('title'), 'version': item.get('version'), 'scope': item.get('scope')}
            for item in choices
        ],
        'selectedCitationIds': selected,
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
