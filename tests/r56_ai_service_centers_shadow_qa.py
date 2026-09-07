#!/usr/bin/env python3
"""R56 AI 预警中心影子验收：不可变候选资产 + 纯本地 56 行 fixture。"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
STATIC_ROOT = ROOT / 'firstcare-cloud-local'
RELEASE_NAME = os.environ.get(
    'R56_AI_RELEASE_NAME',
    'cockpit-r56-ai-service-center-20260812-v1',
)
ASSET_URL_ROOT = os.environ.get(
    'R56_AI_ASSET_URL_ROOT',
    f'/assets/{RELEASE_NAME}',
).rstrip('/')
BOOTSTRAP = Path(os.environ.get(
    'R56_AI_BOOTSTRAP_PATH',
    str(STATIC_ROOT / 'aph2-r56-app-bootstrap-20260812-v1.js'),
)).resolve()
OUT = Path(os.environ.get(
    'R56_QA_OUT_DIR',
    str(ROOT / 'docs/qa/r56-ai-service-centers/shadow'),
))
LOCAL_PORT = int(os.environ.get('R56_QA_LOCAL_PORT', '4196'))
BASE = f'http://127.0.0.1:{LOCAL_PORT}'
BOOTSTRAP_URL = '/' + BOOTSTRAP.relative_to(STATIC_ROOT).as_posix()
R56_CSS_URL = '/aph2-r56-ai-service-centers-20260812-v1.css'
OUT.mkdir(parents=True, exist_ok=True)

PROTECTED_ROUTES = {
    '/daily': '每日回款',
    '/payment': '回款',
    '/collection': '收缴率',
}
VIEWPORTS = {
    'desktop-1440': {'width': 1440, 'height': 1000},
    'mobile-390': {'width': 390, 'height': 844},
}
REQUIRED_EVIDENCE_FIELDS = {
    'source', 'businessDate', 'lastValidatedAt', 'methodology', 'rule',
}
OPERATING_STATUSES = {'stable', 'attention', 'insufficient'}
DATA_STATUSES = {'complete', 'partial', 'missing'}
FIXTURE_BUSINESS_DATE = '2026-08-12'
FIXTURE_VALIDATED_AT = '2026-08-12T20:00:00+08:00'


def evidence(source: str, methodology: str, rule: str) -> dict[str, str]:
    return {
        'source': source,
        'businessDate': FIXTURE_BUSINESS_DATE,
        'lastValidatedAt': FIXTURE_VALIDATED_AT,
        'methodology': methodology,
        'rule': rule,
    }


def build_fixture() -> dict[str, Any]:
    """生成与最终 API 同契约的确定性 fixture，不引用远端数据。"""
    area_specs = [
        ('北京片区', '北京'),
        ('天津片区', '天津'),
        ('河北片区', '河北'),
        ('辽宁片区', '辽宁'),
    ]
    payments: list[dict[str, Any]] = []
    analysis_rows: list[dict[str, Any]] = []
    daily_rows: list[dict[str, Any]] = []
    collection_rows: list[dict[str, Any]] = []

    for center_id in range(1, 57):
        area, prefix = area_specs[(center_id - 1) // 14]
        center_no = (center_id - 1) % 14 + 1
        center = f'第一服务{prefix}{center_no:02d}服务中心'
        normalized_center = f'第一服务{prefix}{center_no:02d}服务中心'
        annual_budget = round(720 + center_id * 17.25, 2)
        cumulative_budget = round(annual_budget * 0.62, 2)

        # 三条允许的经营信号均有独立、可追溯输入；不把日报缺失当经营信号。
        if center_id % 5 == 0:
            cumulative_executed = round(cumulative_budget - (18 + center_id * 0.35), 2)
        else:
            cumulative_executed = round(cumulative_budget + (12 + center_id * 0.4), 2)
        same_period = round(
            cumulative_executed * (1.06 if center_id % 7 == 0 else 0.94),
            2,
        )
        cumulative_budget_gap = round(cumulative_executed - cumulative_budget, 2)
        yoy_growth = round((cumulative_executed - same_period) / same_period, 6)
        daily_collection = None if center_id == 56 else (0 if center_id == 2 else round(1.5 + center_id * 0.23, 2))
        official_collection_rate = None
        if center_id <= 35:
            official_collection_rate = 0.75 if center_id % 4 == 0 else round(0.845 + (center_id % 6) * 0.008, 4)

        payment_source = evidence(
            'R56本地fixture · APH回款执行数据集',
            '以payment_centers授权全集为主表，合并最新quality_status=verified中心快照',
            '每个服务中心仅输出一次；保留已验证0和负数；缺失值不补0',
        )
        daily_source = None if daily_collection is None else evidence(
            'R56本地fixture · FineReport已验证每日回款快照',
            '最新quality_status=verified日快照的daily_collection官方字段',
            '只使用全局最新业务日期的已验证日快照；中心缺失时不回退旧日期、不补0',
        )
        collection_source = None if official_collection_rate is None else evidence(
            'R56本地fixture · 绿仔正式收缴数据集',
            'gatheringCurrentYearRecedRate官方字段',
            '仅使用已发布正式数据集的官方收缴率；不用实收除以应收反算',
        )

        signals: list[dict[str, Any]] = []
        if cumulative_budget_gap < 0:
            signals.append({
                'code': 'cumulative-budget-gap',
                'severity': 'attention',
                'message': f'累计执行较累计预算落后{abs(cumulative_budget_gap):.2f}万元',
                'value': cumulative_budget_gap,
                'threshold': 0,
                'evidence': payment_source,
            })
        if yoy_growth < 0:
            signals.append({
                'code': 'yoy-decline',
                'severity': 'attention',
                'message': f'累计执行同比下降{abs(yoy_growth * 100):.2f}%',
                'value': yoy_growth,
                'threshold': 0,
                'evidence': payment_source,
            })
        if official_collection_rate is not None and official_collection_rate < 0.8:
            signals.append({
                'code': 'official-collection-below-threshold',
                'severity': 'attention',
                'message': f'官方收缴率{official_collection_rate * 100:.2f}%，低于80%关注阈值',
                'value': official_collection_rate,
                'threshold': 0.8,
                'evidence': collection_source,
            })

        data_status = 'complete' if daily_collection is not None and official_collection_rate is not None else 'partial'
        operating_status = 'attention' if signals else 'stable'
        recommendations = []
        if any(signal['code'] == 'cumulative-budget-gap' for signal in signals):
            recommendations.append('核对累计预算节点与回款明细，确认差额对应的未执行事项。')
        if any(signal['code'] == 'yoy-decline' for signal in signals):
            recommendations.append('复核同期口径与当期回款节奏，定位同比下降的具体明细。')
        if any(signal['code'] == 'official-collection-below-threshold' for signal in signals):
            recommendations.append('按正式收缴明细定位欠费对象和金额，优先复核低于80%阈值的原始证据。')
        if daily_collection is None:
            recommendations.append('补齐并验证该中心最新每日回款快照；在此之前保持为数据缺失，不记为0。')
        if official_collection_rate is None:
            recommendations.append('补齐该中心与已发布正式收缴数据集的规范名映射；未通过发布门禁前不形成收缴结论。')

        if operating_status == 'attention':
            analysis = f"{center}需关注：{'；'.join(signal['message'] for signal in signals)}。"
        else:
            suffix = '。' if data_status == 'complete' else '；仍有数据待补齐。'
            analysis = f'{center}当前可用的已验证指标未触发经营关注规则{suffix}'

        annual_rate = round(cumulative_executed / annual_budget, 6)
        cumulative_rate = round(cumulative_executed / cumulative_budget, 6)
        payment = {
            'id': center_id,
            'area': area,
            'center': center,
            'annualBudget': annual_budget,
            'cumulativeBudget': cumulative_budget,
            'cumulativeExecuted': cumulative_executed,
            'samePeriod': same_period,
            'executionVariance': cumulative_budget_gap,
            'annualRate': annual_rate,
            'cumulativeRate': cumulative_rate,
            'growth': yoy_growth,
        }
        payments.append(payment)
        daily_rows.append({
            'id': center_id,
            'area': area,
            'center': center,
            'annual_budget': annual_budget,
            'today': cumulative_executed,
            'daily': daily_collection,
        })
        if official_collection_rate is not None:
            receivable = round(90 + center_id * 2.6, 2)
            received = round(receivable * official_collection_rate, 2)
            collection_rows.append({
                'id': center_id,
                'area': area,
                'center': center,
                'receivable': receivable,
                'received': received,
                'outstanding': round(receivable - received, 2),
                'rate': official_collection_rate,
                'overdue30': round((receivable - received) * 0.35, 2),
                'overdue90': round((receivable - received) * 0.22, 2),
            })

        analysis_rows.append({
            'id': center_id,
            'center': center,
            'normalizedCenter': normalized_center,
            'area': area,
            'operatingStatus': operating_status,
            'dataStatus': data_status,
            'analysis': analysis,
            'recommendations': recommendations,
            'metrics': {
                'annualBudget': annual_budget,
                'cumulativeBudget': cumulative_budget,
                'cumulativeExecuted': cumulative_executed,
                'cumulativeBudgetGap': cumulative_budget_gap,
                'samePeriod': same_period,
                'yoyGrowth': yoy_growth,
                'officialCollectionRate': official_collection_rate,
                'dailyCollection': daily_collection,
            },
            'availability': {
                'payment': 'available',
                'daily': 'missing' if daily_collection is None else 'available',
                'officialCollection': 'missing' if official_collection_rate is None else 'available',
            },
            'signals': signals,
            'evidence': {
                'payment': payment_source,
                'daily': daily_source,
                'officialCollection': collection_source,
            },
        })

    status_order = {'attention': 0, 'insufficient': 1, 'stable': 2}
    analysis_rows.sort(key=lambda row: (
        status_order[row['operatingStatus']],
        row['area'],
        row['center'],
    ))
    operating_counts = {
        key: sum(row['operatingStatus'] == key for row in analysis_rows)
        for key in OPERATING_STATUSES
    }
    data_counts = {
        key: sum(row['dataStatus'] == key for row in analysis_rows)
        for key in DATA_STATUSES
    }
    analysis = {
        'businessDate': FIXTURE_BUSINESS_DATE,
        'publicationStatus': 'partial',
        'collectionPublicationStatus': 'published',
        'scope': {'areas': [item[0] for item in area_specs], 'total': 56},
        'credibility': {
            'status': 'partial',
            'payment': 'verified',
            'daily': 'verified',
            'officialCollection': 'published',
            'note': '本地QA fixture：回款、日报与正式收缴来源链独立；缺失值保持null。',
        },
        'coverage': {
            'paymentCenters': 56,
            'dailyCenters': 55,
            'officialCollectionCenters': 35,
        },
        'thresholds': {'officialCollectionRate': 0.8},
        'summary': {
            'total': 56,
            'stable': operating_counts['stable'],
            'attention': operating_counts['attention'],
            'insufficient': operating_counts['insufficient'],
            'dataComplete': data_counts['complete'],
            'dataIncomplete': data_counts['partial'] + data_counts['missing'],
            'dataPartial': data_counts['partial'],
            'dataMissing': data_counts['missing'],
        },
        'rows': analysis_rows,
    }

    trend_rows = []
    for month in range(1, 11):
        trend = {'m': f'2026-{month:02d}', '华北汇总': round(0.81 + month * 0.006, 4)}
        for area, _prefix in area_specs:
            trend[area] = round(0.79 + month * 0.006 + len(area) * 0.002, 4)
        trend_rows.append(trend)

    return {
        'analysis': analysis,
        'payments': payments,
        'dailyRows': daily_rows,
        'collections': collection_rows,
        'trends': trend_rows,
    }


FIXTURE = build_fixture()


def send_payload(handler: BaseHTTPRequestHandler, payload: bytes, content_type: str, status: int = 200) -> None:
    handler.send_response(status)
    handler.send_header('Content-Type', content_type)
    handler.send_header('Content-Length', str(len(payload)))
    handler.send_header('Cache-Control', 'no-store')
    handler.end_headers()
    if handler.command != 'HEAD':
        handler.wfile.write(payload)


def json_payload(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False).encode('utf-8')


def fixture_api(path: str, query: dict[str, list[str]]) -> Any:
    if path == '/api/ai/service-centers':
        return FIXTURE['analysis']
    if path == '/api/payments':
        return FIXTURE['payments']
    if path == '/api/collections':
        return FIXTURE['collections']
    if path == '/api/trends':
        return FIXTURE['trends']
    if path == '/api/daily/dates':
        return [{'date': FIXTURE_BUSINESS_DATE, 'qualityStatus': 'verified'}]
    if path == '/api/daily':
        return {
            'date': query.get('date', [FIXTURE_BUSINESS_DATE])[0],
            'rows': FIXTURE['dailyRows'],
            'dailyTotal': round(sum(row['daily'] for row in FIXTURE['dailyRows'] if row['daily'] is not None), 2),
            'sourceStatus': 'verified',
            'note': 'R56本地fixture，1个中心日报缺失且保持null。',
        }
    if path == '/api/summary':
        total_receivable = sum(row['receivable'] for row in FIXTURE['collections'])
        total_received = sum(row['received'] for row in FIXTURE['collections'])
        return {
            'centerCount': 56,
            'collectionRate': total_received / total_receivable,
            'businessDate': FIXTURE_BUSINESS_DATE,
        }
    if path == '/api/data-quality/project-gate':
        return {'ready': True, 'code': 'PROJECT_DATA_QUALITY_READY', 'issues': []}
    if path == '/api/auth/me':
        return {'id': 1, 'username': 'r56-fixture', 'name': 'R56本地验收', 'role': 'admin'}
    if path == '/api/client-errors':
        return {'ok': True}
    # 影子站不代理任何未知 API；返回成功的空集合，避免触碰云端。
    return []


class R56FixtureHandler(BaseHTTPRequestHandler):
    """只提供本地静态资产与 fixture API，绝不做代理或建立远端连接。"""

    server_version = 'R56FixtureShadowQA/1.0'

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def do_GET(self) -> None:
        self.handle_request()

    def do_HEAD(self) -> None:
        self.handle_request()

    def do_POST(self) -> None:
        self.handle_request()

    def handle_request(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path.startswith('/api/'):
            payload = fixture_api(parsed.path, urllib.parse.parse_qs(parsed.query))
            return send_payload(self, json_payload(payload), 'application/json; charset=utf-8')
        return self.serve_cockpit(parsed.path)

    def serve_bootstrap(self) -> None:
        source = BOOTSTRAP.read_text(encoding='utf-8')
        candidate = f'{ASSET_URL_ROOT}/app-G7HUEEER.js'
        source, replacements = re.subn(
            r'/assets/cockpit-[^\'"\s]+/app-G7HUEEER\.js',
            candidate,
            source,
        )
        if replacements == 0 and candidate not in source:
            raise RuntimeError('启动器中未找到可替换的驾驶舱 app 资产')
        send_payload(self, source.encode('utf-8'), 'text/javascript; charset=utf-8')

    def send_file(self, file: Path) -> None:
        payload = file.read_bytes()
        mime = mimetypes.guess_type(file.name)[0] or 'application/octet-stream'
        send_payload(self, payload, mime)

    def serve_cockpit(self, request_path: str) -> None:
        # 当前 index 仍引用旧启动器；影子服务在传输层替换其内容，不改 index.html。
        if re.fullmatch(r'/aph2-r\d+-app-bootstrap-20260812-v1\.js', request_path) or request_path == BOOTSTRAP_URL:
            return self.serve_bootstrap()
        spa_routes = {
            '/', '/command', '/payment', '/collection', '/daily', '/projects', '/import',
            '/ai-report', '/ai-alerts', '/tasks', '/review', '/system', '/login',
        }
        if request_path.rstrip('/') in spa_routes:
            return self.send_file(STATIC_ROOT / 'index.html')
        relative = urllib.parse.unquote(request_path).lstrip('/')
        candidate = STATIC_ROOT / relative
        if candidate.is_dir():
            candidate = candidate / 'index.html'
        if not candidate.is_file():
            candidate = STATIC_ROOT / 'index.html'
        return self.send_file(candidate)


def initial_script() -> str:
    return (
        "localStorage.setItem('cockpit_token','r56-local-fixture-token');"
        "localStorage.setItem('token','r56-local-fixture-token');"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R56本地验收',username:'r56-fixture',role:'admin'}));"
    )


def request_path(url: str) -> str:
    return urllib.parse.urlsplit(url).path


def capture_runtime(page: Page) -> dict[str, Any]:
    runtime: dict[str, Any] = {
        'requests': [],
        'consoleErrors': [],
        'pageErrors': [],
        'failedRequests': [],
        'errorResponses': [],
    }
    page.on('request', lambda request: runtime['requests'].append(request_path(request.url)))
    page.on(
        'console',
        lambda message: runtime['consoleErrors'].append(message.text)
        if message.type == 'error' and 'favicon' not in message.text.lower()
        else None,
    )
    page.on('pageerror', lambda error: runtime['pageErrors'].append(str(error)))
    page.on(
        'requestfailed',
        lambda request: runtime['failedRequests'].append({
            'path': request_path(request.url),
            'error': request.failure,
        }) if request.failure != 'net::ERR_ABORTED' else None,
    )
    page.on(
        'response',
        lambda response: runtime['errorResponses'].append({
            'path': request_path(response.url),
            'status': response.status,
        }) if response.status >= 400 and request_path(response.url) != '/favicon.ico' else None,
    )
    return runtime


def api_json(page: Page, endpoint: str) -> tuple[int, object]:
    result = page.evaluate(
        """async endpoint => {
          const token = localStorage.getItem('cockpit_token') || localStorage.getItem('token') || ''
          const response = await fetch(endpoint, {
            method: 'GET',
            headers: token ? {Authorization: `Bearer ${token}`} : {},
            cache: 'no-store',
          })
          return {status: response.status, payload: await response.json()}
        }""",
        endpoint,
    )
    return int(result['status']), result['payload']


def validate_api_contract(payments: object, payload: object) -> dict[str, Any]:
    assert isinstance(payments, list), type(payments)
    assert len(payments) == 56, f'当前授权 payment 中心应为56，实际{len(payments)}'
    assert isinstance(payload, dict), type(payload)
    rows = payload.get('rows')
    assert isinstance(rows, list), payload.keys()
    assert len(rows) == 56, f'AI分析应覆盖56中心，实际{len(rows)}'
    assert payload.get('scope', {}).get('total') == 56, payload.get('scope')
    assert payload.get('summary', {}).get('total') == 56, payload.get('summary')
    assert payload.get('coverage') == {
        'paymentCenters': 56,
        'dailyCenters': 55,
        'officialCollectionCenters': 35,
    }, payload.get('coverage')

    payment_ids = [str(item.get('id')) for item in payments]
    row_ids = [str(item.get('id')) for item in rows]
    assert len(set(payment_ids)) == 56, '授权 payment 中心 ID 不唯一'
    assert len(set(row_ids)) == 56, 'AI 分析中心 ID 重复'
    assert set(row_ids) == set(payment_ids), {
        'missing': sorted(set(payment_ids) - set(row_ids)),
        'extra': sorted(set(row_ids) - set(payment_ids)),
    }

    payment_names = {str(item.get('id')): item.get('center') for item in payments}
    operating_counts = {key: 0 for key in OPERATING_STATUSES}
    data_counts = {key: 0 for key in DATA_STATUSES}
    daily_nulls = 0
    official_collection_nulls = 0
    verified_zero_count = 0
    partial_stable_count = 0
    for row in rows:
        row_id = str(row.get('id'))
        assert row.get('center') == payment_names[row_id], (row_id, row.get('center'), payment_names[row_id])
        operating_status = row.get('operatingStatus')
        data_status = row.get('dataStatus')
        assert operating_status in OPERATING_STATUSES, (row_id, operating_status)
        assert data_status in DATA_STATUSES, (row_id, data_status)
        operating_counts[operating_status] += 1
        data_counts[data_status] += 1
        partial_stable_count += int(data_status == 'partial' and operating_status == 'stable')
        assert isinstance(row.get('analysis'), str) and row['analysis'].strip(), row_id
        assert isinstance(row.get('recommendations'), list), row_id
        assert isinstance(row.get('metrics'), dict), row_id
        assert isinstance(row.get('availability'), dict), row_id
        assert isinstance(row.get('signals'), list), row_id
        evidence_items = row.get('evidence')
        assert isinstance(evidence_items, dict), row_id
        assert {'payment', 'daily', 'officialCollection'} <= set(evidence_items), (row_id, evidence_items.keys())
        assert isinstance(evidence_items['payment'], dict), (row_id, evidence_items['payment'])
        for evidence_name, evidence_item in evidence_items.items():
            if evidence_item is None:
                continue
            assert isinstance(evidence_item, dict), (row_id, evidence_name, evidence_item)
            assert set(evidence_item) == REQUIRED_EVIDENCE_FIELDS, (
                row_id,
                evidence_name,
                evidence_item.keys(),
            )

        metrics = row['metrics']
        availability = row['availability']
        if availability.get('daily') == 'missing':
            assert metrics.get('dailyCollection') is None, f'{row_id}:dailyCollection 未可用时必须为null'
            assert evidence_items.get('daily') is None, f'{row_id}:daily 缺失时不得伪造证据'
            daily_nulls += 1
        elif metrics.get('dailyCollection') == 0:
            assert evidence_items.get('daily') is not None, f'{row_id}:已验证0必须有证据'
            verified_zero_count += 1
        if availability.get('officialCollection') == 'missing':
            assert metrics.get('officialCollectionRate') is None, f'{row_id}:officialCollectionRate 未可用时必须为null'
            assert evidence_items.get('officialCollection') is None, f'{row_id}:officialCollection 缺失时不得伪造证据'
            official_collection_nulls += 1
        payment_values = [
            metrics.get('annualBudget'),
            metrics.get('cumulativeBudget'),
            metrics.get('cumulativeExecuted'),
        ]
        if availability.get('payment') == 'missing':
            assert all(value is None for value in payment_values), f'{row_id}:payment missing 必须保留null'
        elif availability.get('payment') == 'partial':
            assert any(value is None for value in payment_values), f'{row_id}:payment partial 必须至少有一个null'
            assert any(value is not None for value in payment_values), f'{row_id}:payment partial 不得全部缺失'

        allowed_signal_codes = {
            'cumulative-budget-gap',
            'yoy-decline',
            'official-collection-below-threshold',
        }
        assert all(signal.get('code') in allowed_signal_codes for signal in row['signals']), row['signals']
        signal_text = json.dumps(row['signals'], ensure_ascii=False).lower()
        assert not re.search(r'今日|日报|daily.*(?:missing|unavailable)|日回款.*缺失', signal_text), (
            row_id,
            row['signals'],
        )

    summary = payload['summary']
    assert summary.get('stable') == operating_counts['stable'], summary
    assert summary.get('attention') == operating_counts['attention'], summary
    assert summary.get('insufficient') == operating_counts['insufficient'], summary
    assert summary.get('dataComplete') == data_counts['complete'], summary
    assert summary.get('dataPartial') == data_counts['partial'], summary
    assert summary.get('dataMissing') == data_counts['missing'], summary
    assert summary.get('dataIncomplete') == data_counts['partial'] + data_counts['missing'], summary
    assert daily_nulls >= 1, daily_nulls
    assert official_collection_nulls == 21, official_collection_nulls
    assert verified_zero_count >= 1, verified_zero_count
    assert partial_stable_count >= 1, 'operatingStatus 与 dataStatus 必须独立验证'
    return {
        'paymentCenters': len(payments),
        'analysisRows': len(rows),
        'uniqueIds': len(set(row_ids)),
        'operatingStatus': operating_counts,
        'dataStatus': data_counts,
        'dailyNulls': daily_nulls,
        'officialCollectionNulls': official_collection_nulls,
        'verifiedZeroCount': verified_zero_count,
        'partialStableCount': partial_stable_count,
        'businessDate': payload.get('businessDate'),
        'publicationStatus': payload.get('publicationStatus'),
    }


def assert_no_old_ai_requests(paths: list[str]) -> None:
    forbidden = [
        path for path in paths
        if path == '/api/alerts' or path == '/api/tasks' or path.startswith('/api/tasks/')
    ]
    assert not forbidden, f'AI预警中心仍请求旧接口：{forbidden}'


def wait_for_centers(page: Page) -> None:
    page.locator('[data-r56-ai-center-app]').wait_for(state='visible', timeout=20_000)
    page.wait_for_function(
        "document.querySelectorAll('[data-r56-center-row]').length === 56",
        timeout=30_000,
    )


def probe_ui(page: Page, viewport_name: str, runtime: dict[str, Any]) -> dict[str, Any]:
    request_start = len(runtime['requests'])
    response = page.goto(BASE + '/ai-alerts', wait_until='domcontentloaded', timeout=30_000)
    page.wait_for_load_state('networkidle')
    wait_for_centers(page)

    root = page.locator('[data-r56-ai-center-app]')
    summaries = root.locator('[data-r56-summary]')
    filters = root.locator('[data-r56-filter]')
    rows = root.locator('[data-r56-center-row]')
    toggles = root.locator('[data-r56-center-toggle]')
    assert response and response.status == 200
    assert summaries.count() == 3, summaries.all_inner_texts()
    summary_text = summaries.all_inner_texts()
    for label in ['服务中心总数', '需关注', '数据待补齐']:
        assert any(label in text for text in summary_text), summary_text
    assert filters.count() == 1
    assert filters.locator('input[type="search"]').count() == 1
    assert filters.locator('select').count() == 2
    assert rows.count() == 56
    assert toggles.count() == 56
    assert root.locator('[data-r56-center-evidence]').count() == 56
    scope_title = root.get_by_role('heading', name='56个服务中心，逐一给出经营判断')
    assert scope_title.count() == 1, root.get_by_role('heading').all_inner_texts()

    control_sizes = filters.locator('input, select').evaluate_all(
        'elements => elements.map(element => ({tag:element.tagName,height:element.getBoundingClientRect().height}))',
    )
    assert all(item['height'] >= 44 for item in control_sizes), control_sizes

    base_screenshot = OUT / f'{viewport_name}-ai-alerts.png'
    page.screenshot(path=str(base_screenshot), full_page=True)

    # 原生 details/summary 键盘契约：可聚焦，Enter 展开/收起，证据随状态显示。
    first_toggle = toggles.first
    toggle_probe = first_toggle.evaluate(
        """summary => ({
          tag: summary.tagName,
          tabIndex: summary.tabIndex,
          width: summary.getBoundingClientRect().width,
          height: summary.getBoundingClientRect().height,
          parentTag: summary.parentElement?.tagName,
          initiallyOpen: summary.parentElement?.open,
        })""",
    )
    assert toggle_probe['tag'] == 'SUMMARY' and toggle_probe['parentTag'] == 'DETAILS', toggle_probe
    assert toggle_probe['tabIndex'] >= 0, toggle_probe
    assert toggle_probe['height'] >= 44, toggle_probe
    first_toggle.focus()
    assert first_toggle.evaluate('element => document.activeElement === element')
    page.keyboard.press('Enter')
    assert first_toggle.evaluate('element => element.parentElement.open')
    evidence_panel = rows.first.locator('[data-r56-center-evidence]')
    assert evidence_panel.is_visible()
    evidence_text = evidence_panel.inner_text()
    assert '证据来源' in evidence_text
    assert '业务日期' in evidence_text and '校验' in evidence_text, evidence_text
    expanded_screenshot = OUT / f'{viewport_name}-expanded-evidence.png'
    rows.first.screenshot(path=str(expanded_screenshot))
    page.keyboard.press('Enter')
    assert not first_toggle.evaluate('element => element.parentElement.open')

    # 搜索和两个筛选均在本地56中心集合上生效。
    first_name = rows.first.locator('.r56-center-name').inner_text().strip()
    search = page.get_by_role('searchbox', name='搜索服务中心')
    search.fill(first_name)
    page.wait_for_timeout(120)
    search_count = rows.count()
    assert search_count == 1, (first_name, search_count)
    search.fill('')
    page.wait_for_timeout(120)
    assert rows.count() == 56

    status_select = page.locator('#r56-status-filter')
    status_select.select_option('attention')
    page.wait_for_timeout(120)
    attention_count = rows.count()
    assert attention_count == FIXTURE['analysis']['summary']['attention'], attention_count
    filtered_screenshot = None
    if viewport_name == 'desktop-1440':
        filtered_screenshot = OUT / 'desktop-1440-attention-filter.png'
        page.screenshot(path=str(filtered_screenshot), full_page=True)
    status_select.select_option('all')
    page.wait_for_timeout(120)
    assert rows.count() == 56

    area_select = page.locator('#r56-area-filter')
    area_options = area_select.locator('option').evaluate_all(
        "options => options.map(option => ({value: option.value, text: option.textContent.trim()}))",
    )
    assert area_options[0]['text'] == '全部片区', area_options
    assert {option['text'] for option in area_options[1:]} == {
        '北京片区', '天津片区', '河北片区', '辽宁片区',
    }, area_options
    non_all = next((option for option in area_options if option['value'] != 'all'), None)
    assert non_all is not None, area_options
    area_select.select_option(non_all['value'])
    page.wait_for_timeout(120)
    area_count = rows.count()
    assert area_count == 14, (non_all, area_count)
    area_select.select_option('all')
    page.wait_for_timeout(120)
    assert rows.count() == 56

    overflow = page.evaluate('Math.max(0, document.documentElement.scrollWidth - innerWidth)')
    assert overflow <= 1, (viewport_name, overflow)
    request_paths = runtime['requests'][request_start:]
    assert request_paths.count('/api/ai/service-centers') == 1, request_paths
    assert_no_old_ai_requests(request_paths)
    return {
        'status': response.status,
        'path': urllib.parse.urlsplit(page.url).path,
        'summaries': summary_text,
        'rows': 56,
        'searchCount': search_count,
        'attentionFilterCount': attention_count,
        'areaFilter': non_all,
        'areaFilterCount': area_count,
        'scopeTitle': scope_title.inner_text(),
        'scopeOptions': area_options,
        'toggle': toggle_probe,
        'controlSizes': control_sizes,
        'overflow': overflow,
        'serviceCenterRequests': request_paths.count('/api/ai/service-centers'),
        'screenshots': {
            'base': str(base_screenshot),
            'expandedEvidence': str(expanded_screenshot),
            'attentionFilter': str(filtered_screenshot) if filtered_screenshot else None,
        },
    }


def probe_spa_round_trip(page: Page, runtime: dict[str, Any]) -> dict[str, Any]:
    request_start = len(runtime['requests'])
    if urllib.parse.urlsplit(page.url).path != '/ai-alerts':
        page.goto(BASE + '/ai-alerts', wait_until='domcontentloaded', timeout=30_000)
    wait_for_centers(page)
    navigation_entries_before = page.evaluate("performance.getEntriesByType('navigation').length")

    payment_link = page.locator('a[href="/payment"]').first
    payment_link.click()
    page.wait_for_url(re.compile(r'/payment(?:\?.*)?$'), timeout=12_000)
    page.get_by_role('heading', name=re.compile('回款额执行')).wait_for(state='visible', timeout=12_000)
    assert page.locator('[data-r56-ai-center-app]').count() == 0

    alerts_link = page.locator('a[href="/ai-alerts"]').first
    alerts_link.click()
    page.wait_for_url(re.compile(r'/ai-alerts(?:\?.*)?$'), timeout=12_000)
    wait_for_centers(page)
    navigation_entries_after = page.evaluate("performance.getEntriesByType('navigation').length")
    assert navigation_entries_after == navigation_entries_before, {
        'before': navigation_entries_before,
        'after': navigation_entries_after,
    }
    paths = runtime['requests'][request_start:]
    assert_no_old_ai_requests(paths)
    return {
        'from': '/ai-alerts',
        'via': '/payment',
        'to': urllib.parse.urlsplit(page.url).path,
        'navigationEntries': navigation_entries_after,
        'rows': page.locator('[data-r56-center-row]').count(),
    }


def probe_protected_routes(page: Page, viewport_name: str, runtime: dict[str, Any]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for route, identity in PROTECTED_ROUTES.items():
        request_start = len(runtime['requests'])
        response = page.goto(BASE + route, wait_until='domcontentloaded', timeout=30_000)
        page.wait_for_load_state('networkidle')
        page.locator('main').first.wait_for(state='visible', timeout=15_000)
        page.wait_for_timeout(250)
        body_text = page.locator('main').first.inner_text()
        paths = runtime['requests'][request_start:]
        screenshot = OUT / f"{viewport_name}-protected-{route.lstrip('/')}.png"
        page.screenshot(path=str(screenshot), full_page=False)
        probe = {
            'status': response.status if response else None,
            'path': urllib.parse.urlsplit(page.url).path,
            'identity': identity,
            'identityVisible': identity in body_text,
            'r56RootCount': page.locator('[data-r56-ai-center-app]').count(),
            'r56RowCount': page.locator('[data-r56-center-row]').count(),
            'overflow': page.evaluate('Math.max(0, document.documentElement.scrollWidth - innerWidth)'),
            'serviceCenterRequests': paths.count('/api/ai/service-centers'),
            'screenshot': str(screenshot),
        }
        assert probe['status'] == 200, probe
        assert probe['path'] == route, probe
        assert probe['identityVisible'], probe
        assert probe['r56RootCount'] == 0 and probe['r56RowCount'] == 0, probe
        assert probe['overflow'] <= 1, probe
        assert probe['serviceCenterRequests'] == 0, probe
        output[route] = probe
    return output


def probe_assets(page: Page) -> dict[str, Any]:
    assets = {
        'bootstrap': BOOTSTRAP_URL,
        'aiRouteChunk': f'{ASSET_URL_ROOT}/chunk-IWVMRTJI.js',
        'aiCss': R56_CSS_URL,
        'paymentChunk': f'{ASSET_URL_ROOT}/chunk-5G47Z27Q.js',
        'collectionChunk': f'{ASSET_URL_ROOT}/chunk-D3P3MDJ2.js',
        'dailyChunk': f'{ASSET_URL_ROOT}/chunk-24D7OGMQ.js',
    }
    output: dict[str, Any] = {}
    for label, path in assets.items():
        response = page.request.get(BASE + path)
        body = response.body()
        assert response.status == 200, (label, path, response.status)
        assert len(body) > 100, (label, path, len(body))
        output[label] = {
            'path': path,
            'status': response.status,
            'contentType': response.headers.get('content-type'),
            'bytes': len(body),
            'sha256': hashlib.sha256(body).hexdigest(),
        }
    return output


def run_mobile_expand_safe_area_only() -> None:
    """只复验移动端展开后的固定导航安全区，并增量更新既有证据。"""
    result_file = OUT / 'r56-ai-service-centers-shadow-results.json'
    assert result_file.is_file(), f'缺少全量基线结果：{result_file}'
    results = json.loads(result_file.read_text(encoding='utf-8'))
    screenshot = OUT / 'mobile-390-expanded-evidence.png'
    server = ThreadingHTTPServer(('127.0.0.1', LOCAL_PORT), R56FixtureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    try:
        thread.start()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport=VIEWPORTS['mobile-390'])
            context.add_init_script(script=initial_script())
            page = context.new_page()
            runtime = capture_runtime(page)
            response = page.goto(BASE + '/ai-alerts', wait_until='networkidle', timeout=30_000)
            assert response and response.status == 200
            wait_for_centers(page)

            row = page.locator('[data-r56-center-row]').first
            toggle = row.locator('[data-r56-center-toggle]')
            navigation = page.locator('.aph-mobile-primary-nav')
            assert navigation.count() == 1 and navigation.is_visible()
            row.evaluate("element => element.scrollIntoView({block:'start', behavior:'instant'})")
            page.wait_for_timeout(180)
            toggle.focus()
            page.keyboard.press('Enter')
            assert toggle.evaluate('element => element.parentElement.open')
            evidence_panel = row.locator('[data-r56-center-evidence]')
            assert evidence_panel.is_visible()
            page.wait_for_timeout(180)

            safe_area = page.evaluate(
                """() => {
                  const row = document.querySelector('[data-r56-center-row]')
                  const toggle = row?.querySelector('[data-r56-center-toggle]')
                  const navigation = document.querySelector('.aph-mobile-primary-nav')
                  const rowRect = row.getBoundingClientRect()
                  const toggleRect = toggle.getBoundingClientRect()
                  const navRect = navigation.getBoundingClientRect()
                  return {
                    rowTop: rowRect.top,
                    toggleTop: toggleRect.top,
                    navBottom: navRect.bottom,
                    clearance: rowRect.top - navRect.bottom,
                    rowScrollMarginTop: getComputedStyle(row).scrollMarginTop,
                    toggleScrollMarginTop: getComputedStyle(toggle).scrollMarginTop,
                    navigationPosition: getComputedStyle(navigation).position,
                    navigationZIndex: getComputedStyle(navigation).zIndex,
                  }
                }""",
            )
            assert safe_area['navigationPosition'] == 'fixed', safe_area
            assert safe_area['rowScrollMarginTop'] == '108px', safe_area
            assert safe_area['toggleScrollMarginTop'] == '108px', safe_area
            assert safe_area['rowTop'] + 0.5 >= safe_area['navBottom'], safe_area
            assert safe_area['toggleTop'] + 0.5 >= safe_area['navBottom'], safe_area
            assert page.evaluate('Math.max(0, document.documentElement.scrollWidth - innerWidth)') <= 1
            page.screenshot(path=str(screenshot), full_page=False)

            css_response = page.request.get(BASE + R56_CSS_URL)
            css_body = css_response.body()
            assert css_response.status == 200
            css_asset = {
                'path': R56_CSS_URL,
                'status': css_response.status,
                'contentType': css_response.headers.get('content-type'),
                'bytes': len(css_body),
                'sha256': hashlib.sha256(css_body).hexdigest(),
            }
            assert css_asset['sha256'] == '049e89ca7dce2533aec08edc59354ffc3bdd283d003d242cb775e3beee35f366', css_asset
            assert not runtime['consoleErrors'], runtime
            assert not runtime['pageErrors'], runtime
            assert not runtime['failedRequests'], runtime
            assert not runtime['errorResponses'], runtime
            assert_no_old_ai_requests(runtime['requests'])

            results.setdefault('assets', {})['aiCss'] = css_asset
            results.setdefault('targetedChecks', {})['mobileExpandedSafeArea'] = {
                **safe_area,
                'passed': True,
                'viewport': VIEWPORTS['mobile-390'],
                'expanded': True,
                'evidenceVisible': True,
                'overflow': 0,
                'screenshot': str(screenshot),
                'runtimeErrors': 0,
                'oldAiRequests': [],
            }
            results.setdefault('viewports', {}).setdefault('mobile-390', {}).setdefault('screenshots', {})['expandedEvidence'] = str(screenshot)
            result_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
            context.close()
            browser.close()

        print(json.dumps({
            'mode': 'mobile-expand-safe-area-only',
            'rowTop': safe_area['rowTop'],
            'navBottom': safe_area['navBottom'],
            'clearance': safe_area['clearance'],
            'scrollMarginTop': safe_area['rowScrollMarginTop'],
            'cssSha256': css_asset['sha256'],
            'screenshot': str(screenshot),
            'resultFile': str(result_file),
        }, ensure_ascii=False))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def main() -> None:
    server = ThreadingHTTPServer(('127.0.0.1', LOCAL_PORT), R56FixtureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    results: dict[str, Any] = {
        'mode': 'local-fixture-only',
        'remoteConnections': 0,
        'release': RELEASE_NAME,
        'api': {},
        'assets': {},
        'viewports': {},
        'spaRoundTrip': {},
        'protectedRoutes': {},
        'runtime': {},
    }
    fixture_file = OUT / 'r56-service-centers-fixture.json'
    fixture_file.write_text(json.dumps(FIXTURE['analysis'], ensure_ascii=False, indent=2), encoding='utf-8')
    results['fixtureFile'] = str(fixture_file)
    try:
        thread.start()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for viewport_name, viewport in VIEWPORTS.items():
                context = browser.new_context(viewport=viewport)
                context.add_init_script(script=initial_script())
                page = context.new_page()
                runtime = capture_runtime(page)
                results['viewports'][viewport_name] = probe_ui(page, viewport_name, runtime)

                payment_status, payments = api_json(page, '/api/payments')
                analysis_status, analysis = api_json(page, '/api/ai/service-centers')
                assert payment_status == 200, payment_status
                assert analysis_status == 200, (analysis_status, analysis)
                api_probe = validate_api_contract(payments, analysis)
                if not results['api']:
                    results['api'] = api_probe
                    results['assets'] = probe_assets(page)
                else:
                    assert api_probe == results['api'], (api_probe, results['api'])

                if viewport_name == 'desktop-1440':
                    results['spaRoundTrip'] = probe_spa_round_trip(page, runtime)
                results['protectedRoutes'][viewport_name] = probe_protected_routes(page, viewport_name, runtime)

                assert not runtime['consoleErrors'], runtime
                assert not runtime['pageErrors'], runtime
                assert not runtime['failedRequests'], runtime
                assert not runtime['errorResponses'], runtime
                results['runtime'][viewport_name] = {
                    'requestCount': len(runtime['requests']),
                    'consoleErrors': runtime['consoleErrors'],
                    'pageErrors': runtime['pageErrors'],
                    'failedRequests': runtime['failedRequests'],
                    'errorResponses': runtime['errorResponses'],
                    'oldAiRequests': [
                        path for path in runtime['requests']
                        if path == '/api/alerts' or path == '/api/tasks' or path.startswith('/api/tasks/')
                    ],
                }
                context.close()
            browser.close()

        result_file = OUT / 'r56-ai-service-centers-shadow-results.json'
        result_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({
            'mode': results['mode'],
            'remoteConnections': results['remoteConnections'],
            'apiRows': results['api'].get('analysisRows'),
            'dailyNulls': results['api'].get('dailyNulls'),
            'officialCollectionNulls': results['api'].get('officialCollectionNulls'),
            'viewports': len(results['viewports']),
            'protectedRouteChecks': sum(len(item) for item in results['protectedRoutes'].values()),
            'spaRows': results['spaRoundTrip'].get('rows'),
            'fixtureFile': str(fixture_file),
            'resultFile': str(result_file),
        }, ensure_ascii=False))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == '__main__':
    if os.environ.get('R56_QA_MOBILE_EXPAND_ONLY') == '1':
        run_mobile_expand_safe_area_only()
    else:
        main()
