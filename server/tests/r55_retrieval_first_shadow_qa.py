#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request
from pathlib import Path


CANDIDATE = Path(os.environ.get(
    'QA_CANDIDATE',
    '/home/ubuntu/cockpit.candidates/r55-ai-retrieval-20260813-0414',
))
BASE = os.environ.get('QA_BASE_URL', 'http://127.0.0.1:3115').rstrip('/')
EXPECTED_BUSINESS_DATE = os.environ.get('QA_R55_BUSINESS_DATE', '2026-08-12')
USER_QUESTION = '上第累计回款和同期差异是多少？请引用可信来源。'
SHANGDI_CENTER = '第一服务北京上第MOMΛ服务中心'
OTHER_CENTER = '第一服务北京通州万国城MOMΛ服务中心'
DYNAMIC_SOURCE = 'FineReport日报+预算周报+执行评估中心明细'


def service_environment() -> dict[str, str]:
    result = subprocess.run(
        ['systemctl', 'show', 'first-service-cockpit.service', '-p', 'MainPID', '--value'],
        check=True,
        capture_output=True,
        text=True,
    )
    pid = result.stdout.strip()
    environment = os.environ.copy()
    for item in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0'):
        if b'=' not in item:
            continue
        key, value = item.split(b'=', 1)
        environment[key.decode(errors='ignore')] = value.decode(errors='ignore')
    candidate_root = CANDIDATE.resolve()
    candidate_db = (candidate_root / 'cockpit.db').resolve()
    if not candidate_db.is_file():
        raise RuntimeError(f'R55影子QA候选库不存在：{candidate_db}')
    production_root = Path(environment.get('COCKPIT_ROOT', '/home/ubuntu/cockpit')).resolve()
    production_db = Path(
        environment.get('COCKPIT_DB_PATH', '').strip() or production_root / 'cockpit.db'
    ).resolve()
    if candidate_root == production_root or candidate_db == production_db:
        raise RuntimeError('影子QA候选库不得与生产库指向同一路径')
    if candidate_db.parent != candidate_root:
        raise RuntimeError('影子QA写入目标必须位于候选目录')
    environment['COCKPIT_DB_PATH'] = str(candidate_db)
    environment['COCKPIT_ROOT'] = str(candidate_root)
    return environment


def ephemeral_tokens(environment: dict[str, str]) -> dict[str, str]:
    node_script = r'''
import db from './dist/db.js';
import { signToken } from './dist/auth.js';
const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map(row => row.name));
if (!columns.has('service_center_scope')) throw new Error('R55影子库缺少service_center_scope');
function ensure(username, serviceCenterScope) {
  db.prepare(`INSERT INTO users(username,password_hash,role,area_scope,project_scope,service_center_scope)
    VALUES(?,?,'viewer','','',?) ON CONFLICT(username) DO UPDATE SET
    role='viewer',area_scope='',project_scope='',service_center_scope=excluded.service_center_scope`)
    .run(username,'unused-r55-hash',serviceCenterScope);
  return db.prepare(`SELECT id,username,role,area_scope,project_scope,service_center_scope,token_version
    FROM users WHERE username=?`).get(username);
}
const admin=db.prepare(`SELECT id,username,role,area_scope,project_scope,service_center_scope,token_version
  FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
if (!admin) throw new Error('R55影子库缺少管理员');
const users={
  admin,
  shangdi:ensure('__r55_shangdi_center','第一服务北京上第MOMΛ服务中心'),
  other:ensure('__r55_other_center','第一服务北京通州万国城MOMΛ服务中心'),
};
const output={};
for (const [key,user] of Object.entries(users)) {
  output[key]=signToken({
    userId:user.id,
    username:user.username,
    role:user.role,
    areaScope:user.area_scope||'',
    projectScope:user.project_scope||'',
    serviceCenterScope:user.service_center_scope||'',
    tokenVersion:Number(user.token_version||0),
  });
}
process.stdout.write('\n__R55_TOKENS__' + JSON.stringify(output));
'''
    completed = subprocess.run(
        ['/usr/bin/node', '--input-type=module', '-e', node_script],
        cwd=CANDIDATE,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )
    marker = '__R55_TOKENS__'
    if marker not in completed.stdout:
        raise RuntimeError('未能在内存中生成R55影子验收令牌')
    return json.loads(completed.stdout.split(marker, 1)[1])


def call(token: str, path: str, method: str = 'GET', payload: dict | None = None, timeout: int = 60):
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
    request = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def ask(token: str, question: str, topic: str = ''):
    return call(token, '/api/ai/assistant/ask', 'POST', {
        'question': question,
        'topic': topic,
        'history': [],
    })


def normalized_numbers(text: str) -> str:
    return text.replace(',', '').replace('，', '')


def assert_success_metadata(payload: dict) -> None:
    assert payload.get('generatedBy') == 'hermes-grounded', payload
    assert payload.get('fallbackUsed') is False, payload
    assert payload.get('readOnly') is True, payload
    assert payload.get('modelUsed'), payload
    assert payload.get('answer'), payload
    assert payload.get('citations'), payload


def assert_knowledge_citations(payload: dict) -> None:
    citations = payload.get('citations') or []
    assert citations, payload
    for citation in citations:
        assert citation.get('documentId'), citation
        assert citation.get('title'), citation
        assert citation.get('version'), citation
        assert citation.get('section'), citation


def assert_shangdi(payload: dict, require_requested_answer: bool = False) -> None:
    fact = payload.get('centerPayment') or {}
    facts = payload.get('facts') or {}
    assert payload.get('topic') == 'aph', payload
    assert payload.get('centerPaymentLookup') == 'matched', payload
    assert fact.get('center') == SHANGDI_CENTER, payload
    assert payload.get('businessDate') == EXPECTED_BUSINESS_DATE, payload
    assert fact.get('businessDate') == EXPECTED_BUSINESS_DATE, payload
    assert abs(float(fact.get('annualBudget')) - 2238.93) < 0.001, payload
    assert abs(float(fact.get('cumulativeBudget')) - 1312.04) < 0.001, payload
    assert abs(float(fact.get('cumulativeExecuted')) - 1300.17) < 0.001, payload
    assert abs(float(fact.get('samePeriod')) - 1505.00) < 0.001, payload
    assert abs(float(facts.get('samePeriodVariance')) - (-204.83)) < 0.001, payload
    assert abs(float(facts.get('samePeriodVarianceAbsolute')) - 204.83) < 0.001, payload
    assert abs(float(facts.get('yearOverYearGrowthRate')) - (-13.61)) < 0.001, payload
    assert facts.get('yearOverYearGrowthRateDisplay') == '-13.61%', payload
    sources = payload.get('sources') or []
    assert sources and sources[0].get('name') == DYNAMIC_SOURCE, payload
    assert sources[0].get('businessDate') == EXPECTED_BUSINESS_DATE, payload
    assert sources[0].get('status') in {'verified', 'warning'}, payload
    assert_success_metadata(payload)
    assert_knowledge_citations(payload)
    answer = normalized_numbers(str(payload.get('answer') or ''))
    if require_requested_answer:
        for expected in ('1300.17', '1505', '204.83', '13.61'):
            assert expected in answer, payload
        assert any(term in answer for term in ('同比下降', '同比下滑', '同比减少', '-13.61%')), payload
    assert '未提供上第' not in answer and '无任何项目级回款' not in answer, payload


def assert_lookup_failure(status: int, payload: dict, lookup: str) -> None:
    assert status == 422, payload
    assert payload.get('code') == 'CENTER_PAYMENT_NOT_RESOLVED', payload
    assert payload.get('centerPaymentLookup') == lookup, payload
    assert not payload.get('centerPayment'), payload
    assert payload.get('generatedBy') is None, payload
    assert payload.get('modelUsed') is None, payload
    assert payload.get('citations') == [], payload
    assert payload.get('fallbackUsed') is False, payload
    assert payload.get('readOnly') is True, payload


def assert_scope_denied(status: int, payload: dict) -> None:
    assert status == 403, payload
    assert set(payload) == {
        'error', 'code', 'generatedBy', 'modelUsed', 'citations', 'fallbackUsed', 'readOnly',
    }, payload
    assert payload.get('code') == 'SERVICE_CENTER_OUT_OF_SCOPE', payload
    assert payload.get('error') == '该服务中心不在当前账号的数据范围内。', payload
    assert payload.get('generatedBy') is None, payload
    assert payload.get('modelUsed') is None, payload
    assert payload.get('citations') == [], payload
    assert payload.get('fallbackUsed') is False, payload
    assert payload.get('readOnly') is True, payload
    for forbidden_key in (
        'question', 'topic', 'centerPaymentLookup', 'centerPaymentCandidates',
        'centerPayment', 'facts', 'sources', 'businessDate',
    ):
        assert forbidden_key not in payload, payload
    serialized = normalized_numbers(json.dumps(payload, ensure_ascii=False))
    for forbidden in (
        SHANGDI_CENTER, '上第', '海淀片区', '1300.17', '1505', '204.83',
        '13.61', EXPECTED_BUSINESS_DATE, DYNAMIC_SOURCE,
    ):
        assert forbidden not in serialized, payload


def main() -> None:
    environment = service_environment()
    tokens = ephemeral_tokens(environment)
    results: dict[str, object] = {
        'writeScope': 'candidate-only',
        'candidateDb': environment['COCKPIT_DB_PATH'],
    }

    status, payments = call(tokens['admin'], '/api/payments')
    assert status == 200 and len(payments) == 56
    shangdi = [row for row in payments if '上第' in row.get('center', '')]
    assert len(shangdi) == 1 and abs(shangdi[0]['cumulativeExecuted'] - 1300.17) < 0.001
    assert any(row.get('center') == OTHER_CENTER for row in payments), OTHER_CENTER
    results['payments'] = {
        'status': status,
        'count': len(payments),
        'shangdi': {key: shangdi[0][key] for key in [
            'center', 'area', 'annualBudget', 'cumulativeBudget', 'cumulativeExecuted',
            'samePeriod', 'annualRate', 'cumulativeRate', 'growth',
        ]},
    }

    original_attempts = []
    for attempt in range(1, 4):
        status, payload = ask(tokens['admin'], USER_QUESTION)
        assert status == 200, {'attempt': attempt, 'payload': payload}
        assert_shangdi(payload, require_requested_answer=True)
        original_attempts.append({
            'attempt': attempt,
            'status': status,
            'topic': payload.get('topic'),
            'lookup': payload.get('centerPaymentLookup'),
            'businessDate': payload.get('businessDate'),
            'generatedBy': payload.get('generatedBy'),
            'fallbackUsed': payload.get('fallbackUsed'),
            'citationCount': len(payload.get('citations') or []),
        })
    results['adminOriginalStability'] = {
        'question': USER_QUESTION,
        'consecutiveSuccesses': len(original_attempts),
        'attempts': original_attempts,
    }

    for label, question, topic in [
        ('shortName', '上第的回款情况', ''),
        ('fullName', '第一服务北京上第MOMΛ服务中心的回款情况', ''),
    ]:
        status, payload = ask(tokens['admin'], question, topic)
        assert status == 200, payload
        assert_shangdi(payload)
        results[label] = {
            'status': status,
            'topic': payload.get('topic'),
            'lookup': payload.get('centerPaymentLookup'),
            'businessDate': payload.get('businessDate'),
            'generatedBy': payload.get('generatedBy'),
            'fallbackUsed': payload.get('fallbackUsed'),
            'citationCount': len(payload.get('citations') or []),
        }

    status, ambiguous = ask(tokens['admin'], '万国城的回款情况')
    assert_lookup_failure(status, ambiguous, 'ambiguous')
    assert len(ambiguous.get('centerPaymentCandidates') or []) >= 2, ambiguous
    results['ambiguous'] = {
        'status': status,
        'lookup': ambiguous.get('centerPaymentLookup'),
        'candidateCount': len(ambiguous.get('centerPaymentCandidates') or []),
    }

    for label, question in [
        ('notFound', '不存在中心的回款情况'),
        ('regionFalsePositive', '北京地区的回款情况'),
        ('managementFalsePositive', '管理的回款情况'),
    ]:
        status, missing = ask(tokens['admin'], question)
        assert_lookup_failure(status, missing, 'not-found')
        leaked = normalized_numbers(str(missing.get('answer') or missing.get('error') or ''))
        assert '1300.17' not in leaked and '1505' not in leaked, missing
        results[label] = {'status': status, 'lookup': missing.get('centerPaymentLookup')}

    status, blocked = ask(tokens['admin'], '上第项目的利润和品质情况', 'aph')
    assert status == 409 and blocked.get('code') == 'PROJECT_DATA_QUALITY_BLOCKED', blocked
    results['projectGate'] = {'status': status, 'code': blocked.get('code')}

    status, shangdi_member = ask(tokens['shangdi'], USER_QUESTION)
    assert status == 200, shangdi_member
    assert_shangdi(shangdi_member, require_requested_answer=True)
    results['authorizedShangdiScope'] = {
        'status': status,
        'lookup': shangdi_member.get('centerPaymentLookup'),
        'generatedBy': shangdi_member.get('generatedBy'),
        'fallbackUsed': shangdi_member.get('fallbackUsed'),
        'citationCount': len(shangdi_member.get('citations') or []),
    }

    status, denied = ask(tokens['other'], USER_QUESTION)
    assert_scope_denied(status, denied)
    results['otherCenterScope'] = {
        'status': status,
        'code': denied.get('code'),
        'generic': True,
    }

    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
