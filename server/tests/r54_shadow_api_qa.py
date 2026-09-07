#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request
from pathlib import Path


CANDIDATE = Path(os.environ.get('QA_CANDIDATE', '/home/ubuntu/cockpit.candidates/r54-center-payment-20260813-0000'))
BASE = os.environ.get('QA_BASE_URL', 'http://127.0.0.1:3114').rstrip('/')


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
    environment['COCKPIT_DB_PATH'] = str(CANDIDATE / 'cockpit.db')
    environment['COCKPIT_ROOT'] = str(CANDIDATE)
    return environment


def ephemeral_tokens(environment: dict[str, str]) -> dict[str, str]:
    node_script = r'''
import db from './dist/db.js';
import { signToken } from './dist/auth.js';
function ensure(username, role, areaScope = '', projectScope = '') {
  db.prepare(`INSERT INTO users(username,password_hash,role,area_scope,project_scope)
    VALUES(?,?,?,?,?) ON CONFLICT(username) DO UPDATE SET
    role=excluded.role,area_scope=excluded.area_scope,project_scope=excluded.project_scope`)
    .run(username,'unused-r54-hash',role,areaScope,projectScope);
  return db.prepare('SELECT id,username,role,area_scope,project_scope FROM users WHERE username=?').get(username);
}
const admin=db.prepare("SELECT id,username,role,area_scope,project_scope FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
const users={
  admin,
  haidian:ensure('__r54_haidian','area_manager','海淀片区',''),
  hebei:ensure('__r54_hebei','area_manager','河北片区',''),
  project:ensure('__r54_project','project_manager','','7'),
};
const output={};
for (const [key,user] of Object.entries(users)) {
  output[key]=signToken({userId:user.id,username:user.username,role:user.role,areaScope:user.area_scope||'',projectScope:user.project_scope||''});
}
process.stdout.write('\n__R54_TOKENS__' + JSON.stringify(output));
'''
    completed = subprocess.run(
        ['/usr/bin/node', '--input-type=module', '-e', node_script],
        cwd=CANDIDATE,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )
    marker = '__R54_TOKENS__'
    if marker not in completed.stdout:
        raise RuntimeError('未能在内存中生成影子验收令牌')
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
    assert (payload.get('sources') or [{}])[0].get('name') == 'FineReport日报+预算周报+执行评估中心明细', payload
    answer = str(payload.get('answer') or '')
    assert '上第' in answer and ('1,300.17' in answer or '1300.17' in answer), payload
    assert '未提供上第' not in answer and '无任何项目级回款' not in answer, payload


def main() -> None:
    environment = service_environment()
    tokens = ephemeral_tokens(environment)
    results: dict[str, object] = {}

    status, payments = call(tokens['admin'], '/api/payments')
    assert status == 200 and len(payments) == 56
    shangdi = [row for row in payments if '上第' in row.get('center', '')]
    assert len(shangdi) == 1 and abs(shangdi[0]['cumulativeExecuted'] - 1300.17) < 0.001
    results['payments'] = {
        'status': status,
        'count': len(payments),
        'shangdi': {key: shangdi[0][key] for key in [
            'center', 'area', 'annualBudget', 'cumulativeBudget', 'cumulativeExecuted',
            'samePeriod', 'annualRate', 'cumulativeRate', 'growth',
        ]},
    }

    for label, question, topic in [
        ('short', '上第的回款情况', ''),
        ('full', '第一服务北京上第MOMΛ服务中心的回款情况', ''),
        ('staleProject', '上第的回款情况', 'project'),
        ('projectPayment', '上第项目的回款情况', 'project'),
        ('today', '今天上第的回款情况', ''),
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
            'qualityStatus': payload.get('qualityStatus'),
        }

    status, ambiguous = ask(tokens['admin'], '万国城的回款情况')
    assert status == 200 and ambiguous.get('centerPaymentLookup') == 'ambiguous', ambiguous
    assert not ambiguous.get('centerPayment'), ambiguous
    results['ambiguous'] = {
        'status': status,
        'lookup': ambiguous.get('centerPaymentLookup'),
        'candidateCount': len(ambiguous.get('centerPaymentCandidates') or []),
    }

    status, missing = ask(tokens['admin'], '不存在中心的回款情况')
    assert status == 200 and missing.get('centerPaymentLookup') == 'not-found', missing
    assert not missing.get('centerPayment'), missing
    results['notFound'] = {'status': status, 'lookup': missing.get('centerPaymentLookup')}

    status, blocked = ask(tokens['admin'], '上第项目的利润和品质情况', 'aph')
    assert status == 409 and blocked.get('code') == 'PROJECT_DATA_QUALITY_BLOCKED', blocked
    results['projectGate'] = {'status': status, 'code': blocked.get('code')}

    status, haidian = ask(tokens['haidian'], '上第的回款情况')
    assert status == 200 and haidian.get('centerPaymentLookup') == 'matched', haidian
    results['haidianScope'] = {'status': status, 'lookup': haidian.get('centerPaymentLookup')}

    for label in ['hebei', 'project']:
        status, scoped = ask(tokens[label], '上第的回款情况')
        answer = str(scoped.get('answer') or '')
        assert status == 200 and scoped.get('centerPaymentLookup') == 'not-found', scoped
        assert not scoped.get('centerPayment'), scoped
        assert '上第' not in answer and '海淀' not in answer and '1,300' not in answer, scoped
        results[f'{label}Scope'] = {'status': status, 'lookup': scoped.get('centerPaymentLookup'), 'generic': True}

    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
