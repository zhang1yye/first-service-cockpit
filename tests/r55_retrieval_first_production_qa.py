#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
import full_remediation_shadow_qa as qa  # noqa: E402

BASE = os.environ.get('QA_BASE_URL', 'https://firstcare.cloud').rstrip('/')
EXPECTED_BUSINESS_DATE = os.environ.get('QA_R55_BUSINESS_DATE', '2026-08-12')
USER_QUESTION = '上第累计回款和同期差异是多少？请引用可信来源。'
SHANGDI_CENTER = '第一服务北京上第MOMΛ服务中心'
DYNAMIC_SOURCE = 'FineReport日报+预算周报+执行评估中心明细'
HOST = os.environ.get('QA_R55_HOST', 'ubuntu@82.157.119.78')

REMOTE_SCOPED_TOKEN_SCRIPT = r"""
sudo -n python3 - <<'PY'
import os
import subprocess
from pathlib import Path
pid = subprocess.check_output(
    ["systemctl", "show", "first-service-cockpit", "--property=MainPID", "--value"],
    text=True,
).strip()
env = os.environ.copy()
for item in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0"):
    if b"=" not in item:
        continue
    key, value = item.split(b"=", 1)
    key = key.decode("utf-8", errors="ignore")
    if key in {"JWT_SECRET", "JWT_SECRET_FILE", "COCKPIT_DB_PATH", "NODE_ENV", "HOME"}:
        env[key] = value.decode("utf-8", errors="ignore")
env.setdefault("HOME", "/home/ubuntu")
node_script = r'''import db from "./dist/db.js";
import { signToken } from "./dist/auth.js";
const columns = new Set(db.prepare("PRAGMA table_info(users)").all().map(row => row.name));
if (!columns.has("service_center_scope")) throw new Error("users表缺少service_center_scope");
const select = `SELECT id,username,role,area_scope,project_scope,service_center_scope,token_version
  FROM users WHERE role != 'admin' AND TRIM(service_center_scope) != ''`;
const shangdi = db.prepare(select + " AND service_center_scope LIKE '%上第%' ORDER BY id LIMIT 1").get();
const other = db.prepare(select + " AND service_center_scope NOT LIKE '%上第%' ORDER BY id LIMIT 1").get();
if (!shangdi || !other) throw new Error("需要已分配上第中心和其他中心的现有QA账号");
function tokenFor(user) {
  return signToken({
    userId:user.id,
    username:user.username,
    role:user.role,
    areaScope:user.area_scope||"",
    projectScope:user.project_scope||"",
    serviceCenterScope:user.service_center_scope||"",
    tokenVersion:Number(user.token_version||0),
  });
}
process.stdout.write("\n__R55_SCOPED_TOKENS__" + JSON.stringify({
  shangdi: tokenFor(shangdi),
  other: tokenFor(other),
  otherCenter: other.service_center_scope,
}));'''
result = subprocess.run(
    ["/usr/bin/node", "--input-type=module", "-e", node_script],
    cwd="/home/ubuntu/cockpit",
    env=env,
    capture_output=True,
    text=True,
)
if result.returncode != 0:
    print(result.stderr, end="")
    raise SystemExit(result.returncode)
print(result.stdout, end="")
PY
"""


def scoped_ephemeral_tokens() -> dict[str, str]:
    shangdi_token = os.environ.get('QA_R55_SHANGDI_TOKEN', '').strip()
    other_token = os.environ.get('QA_R55_OTHER_CENTER_TOKEN', '').strip()
    if shangdi_token and other_token:
        return {
            'shangdi': shangdi_token,
            'other': other_token,
            'otherCenter': os.environ.get('QA_R55_OTHER_CENTER', '').strip(),
        }
    result = subprocess.run(
        ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', HOST, REMOTE_SCOPED_TOKEN_SCRIPT],
        check=True,
        capture_output=True,
        text=True,
    )
    match = re.search(r'__R55_SCOPED_TOKENS__(\{.*\})', result.stdout)
    if not match:
        raise RuntimeError('未能从现有账号在内存中取得R55服务中心QA令牌')
    return json.loads(match.group(1))


def init_script(token: str, role: str = 'admin', service_center_scope: str = '') -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify("
        f"{{name:'R55生产验收',role:{json.dumps(role)},serviceCenterScope:{json.dumps(service_center_scope)}}}));"
    )


def post_question(request, question: str, topic: str = ''):
    response = request.post(
        '/api/ai/assistant/ask',
        data={'question': question, 'topic': topic, 'history': []},
        timeout=60_000,
    )
    payload = response.json()
    return response.status, payload


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


class ProductionWriteGuard:
    """浏览器只允许读请求和助手问数；助手响应另行强制断言readOnly。"""

    def __init__(self) -> None:
        self.blocked: list[dict[str, str]] = []
        self.allowed_assistant_posts = 0

    def handle(self, route) -> None:
        request = route.request
        method = request.method.upper()
        path = urllib.parse.urlsplit(request.url).path
        if method in {'GET', 'HEAD', 'OPTIONS'}:
            route.continue_()
            return
        if method == 'POST' and path == '/api/ai/assistant/ask':
            self.allowed_assistant_posts += 1
            route.continue_()
            return
        self.blocked.append({'method': method, 'path': path})
        route.abort('blockedbyclient')


def main() -> None:
    admin_token = qa.ephemeral_token()
    scoped_tokens = scoped_ephemeral_tokens()
    results: dict[str, object] = {
        'base': BASE,
        'productionBusinessWrites': False,
        'api': {},
        'browser': {},
    }
    try:
        with sync_playwright() as playwright:
            admin_request = playwright.request.new_context(
                base_url=BASE,
                extra_http_headers={'Authorization': f'Bearer {admin_token}'},
            )
            shangdi_request = playwright.request.new_context(
                base_url=BASE,
                extra_http_headers={'Authorization': f"Bearer {scoped_tokens['shangdi']}"},
            )
            other_request = playwright.request.new_context(
                base_url=BASE,
                extra_http_headers={'Authorization': f"Bearer {scoped_tokens['other']}"},
            )

            health = admin_request.get('/api/health', timeout=20_000)
            assert health.status == 200, health.text()

            payments = admin_request.get('/api/payments', timeout=20_000)
            assert payments.status == 200, payments.text()
            payment_rows = payments.json()
            shangdi_rows = [row for row in payment_rows if '上第' in str(row.get('center') or '')]
            assert len(shangdi_rows) == 1, shangdi_rows
            assert abs(float(shangdi_rows[0]['cumulativeExecuted']) - 1300.17) < 0.001
            results['api']['payments'] = {
                'status': payments.status,
                'count': len(payment_rows),
                'shangdiCenter': shangdi_rows[0].get('center'),
                'cumulativeExecuted': shangdi_rows[0].get('cumulativeExecuted'),
                'samePeriod': shangdi_rows[0].get('samePeriod'),
            }

            shangdi_me = shangdi_request.get('/api/auth/me', timeout=20_000)
            assert shangdi_me.status == 200, shangdi_me.text()
            shangdi_identity = shangdi_me.json().get('user') or {}
            assert shangdi_identity.get('role') != 'admin', shangdi_identity
            assert '上第' in str(shangdi_identity.get('serviceCenterScope') or ''), shangdi_identity

            other_me = other_request.get('/api/auth/me', timeout=20_000)
            assert other_me.status == 200, other_me.text()
            other_identity = other_me.json().get('user') or {}
            assert other_identity.get('role') != 'admin', other_identity
            assert '上第' not in str(other_identity.get('serviceCenterScope') or ''), other_identity
            if scoped_tokens.get('otherCenter'):
                assert other_identity.get('serviceCenterScope') == scoped_tokens['otherCenter'], {
                    'identity': other_identity,
                    'selectedCenter': scoped_tokens.get('otherCenter'),
                }

            admin_status, admin_original = post_question(admin_request, USER_QUESTION)
            assert admin_status == 200, admin_original
            assert_shangdi(admin_original, require_requested_answer=True)
            results['api']['adminOriginal'] = {
                'status': admin_status,
                'topic': admin_original.get('topic'),
                'lookup': admin_original.get('centerPaymentLookup'),
                'generatedBy': admin_original.get('generatedBy'),
                'fallbackUsed': admin_original.get('fallbackUsed'),
                'businessDate': admin_original.get('businessDate'),
                'citationCount': len(admin_original.get('citations') or []),
            }

            denied_status, denied = post_question(other_request, USER_QUESTION)
            assert_scope_denied(denied_status, denied)
            results['api']['otherCenterScope'] = {
                'status': denied_status,
                'code': denied.get('code'),
                'generic': True,
            }

            ambiguous_status, ambiguous = post_question(admin_request, '万国城的回款情况')
            assert_lookup_failure(ambiguous_status, ambiguous, 'ambiguous')
            assert len(ambiguous.get('centerPaymentCandidates') or []) >= 2, ambiguous
            results['api']['ambiguous'] = {
                'status': ambiguous_status,
                'lookup': ambiguous.get('centerPaymentLookup'),
                'candidates': len(ambiguous.get('centerPaymentCandidates') or []),
            }

            project_status, project = post_question(admin_request, '上第项目的利润和品质情况', 'aph')
            assert project_status == 409, project
            assert project.get('code') == 'PROJECT_DATA_QUALITY_BLOCKED', project
            results['api']['projectGate'] = {'status': project_status, 'code': project.get('code')}

            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={'width': 1440, 'height': 1000})
            context.add_init_script(script=init_script(
                scoped_tokens['shangdi'],
                role=str(shangdi_identity.get('role') or 'viewer'),
                service_center_scope=str(shangdi_identity.get('serviceCenterScope') or SHANGDI_CENTER),
            ))
            write_guard = ProductionWriteGuard()
            context.route('**/*', write_guard.handle)
            page = context.new_page()
            console_errors: list[str] = []
            page_errors: list[str] = []
            failed_requests: list[str] = []
            page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
            page.on('pageerror', lambda error: page_errors.append(str(error)))
            page.on('requestfailed', lambda req: failed_requests.append(req.url) if req.failure != 'net::ERR_ABORTED' else None)

            response = page.goto(BASE + '/', wait_until='domcontentloaded', timeout=30_000)
            assert response and response.status == 200
            page.wait_for_timeout(1_500)
            launcher = page.locator('#north-ai-assistant .north-ai-launcher')
            launcher.wait_for(state='visible', timeout=15_000)
            launcher.click()
            input_box = page.locator('.north-ai-input')
            input_box.wait_for(state='visible', timeout=10_000)
            input_box.fill(USER_QUESTION)
            with page.expect_response(lambda item: '/api/ai/assistant/ask' in item.url, timeout=60_000) as info:
                page.locator('.north-ai-composer').evaluate('form => form.requestSubmit()')
            assistant_response = info.value
            assistant_payload = assistant_response.json()
            assert assistant_response.status == 200, assistant_payload
            assert_shangdi(assistant_payload, require_requested_answer=True)

            message = page.locator('.north-ai-message-assistant:not(.north-ai-message-loading)').last
            message.wait_for(state='visible', timeout=60_000)
            copy = message.inner_text()
            normalized_copy = normalized_numbers(copy)
            for expected in ('1300.17', '1505', '204.83', '13.61'):
                assert expected in normalized_copy, copy
            assert any(term in copy for term in ('同比下降', '同比下滑', '同比减少', '-13.61%')), copy
            assert '未提供上第' not in copy and '不含上第' not in copy, copy

            source_items = message.locator('.north-ai-meta span').all_inner_texts()
            assert any(DYNAMIC_SOURCE in item for item in source_items), source_items
            assert any(EXPECTED_BUSINESS_DATE in item for item in source_items), source_items
            assert any(
                item == f'来源：{DYNAMIC_SOURCE} · {EXPECTED_BUSINESS_DATE}'
                for item in source_items
            ), source_items

            knowledge = message.locator('.north-ai-knowledge[aria-label="知识引用"]')
            knowledge.wait_for(state='visible', timeout=10_000)
            assert message.locator('.north-ai-meta').count() == 1
            assert knowledge.count() == 1
            knowledge_items = knowledge.locator('.north-ai-knowledge-item').all_inner_texts()
            assert knowledge_items and all(item.startswith('知识：') for item in knowledge_items), knowledge_items
            assert len(knowledge_items) == len(assistant_payload.get('citations') or []), {
                'knowledgeItems': knowledge_items,
                'citations': assistant_payload.get('citations'),
            }
            for citation in assistant_payload.get('citations') or []:
                assert any(citation['title'] in item for item in knowledge_items), {
                    'citation': citation,
                    'knowledgeItems': knowledge_items,
                }

            assert write_guard.allowed_assistant_posts == 1, write_guard.allowed_assistant_posts
            assert not write_guard.blocked, write_guard.blocked
            assert not console_errors and not page_errors and not failed_requests, {
                'consoleErrors': console_errors,
                'pageErrors': page_errors,
                'failedRequests': failed_requests,
            }
            results['browser'] = {
                'route': '/',
                'homeLauncherVisible': True,
                'authorizedServiceCenterScope': shangdi_identity.get('serviceCenterScope'),
                'question': USER_QUESTION,
                'assistantStatus': assistant_response.status,
                'assistantLookup': assistant_payload.get('centerPaymentLookup'),
                'assistantGeneratedBy': assistant_payload.get('generatedBy'),
                'fallbackUsed': assistant_payload.get('fallbackUsed'),
                'businessDateVisible': any(EXPECTED_BUSINESS_DATE in item for item in source_items),
                'dynamicSourceVisible': any(DYNAMIC_SOURCE in item for item in source_items),
                'knowledgeCitationCount': len(knowledge_items),
                'knowledgeCitationsVisible': True,
                'dynamicAndKnowledgeSeparated': True,
                'allowedReadOnlyAssistantPosts': write_guard.allowed_assistant_posts,
                'blockedProductionWrites': write_guard.blocked,
                'consoleErrors': console_errors,
                'pageErrors': page_errors,
                'failedRequests': failed_requests,
            }
            context.close()
            browser.close()
            admin_request.dispose()
            shangdi_request.dispose()
            other_request.dispose()

        print(json.dumps(results, ensure_ascii=False, indent=2))
    finally:
        admin_token = ''
        scoped_tokens = {}


if __name__ == '__main__':
    main()
