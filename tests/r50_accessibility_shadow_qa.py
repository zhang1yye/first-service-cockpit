#!/usr/bin/env python3
"""R50 候选的键盘、焦点、编辑解锁和保护路由影子回归。"""

from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import re
import ssl
import subprocess
import threading
import urllib.parse
import urllib.request
from pathlib import Path

from playwright.sync_api import Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
TARGET = os.environ.get("QA_TARGET", "candidate").strip().lower()
if TARGET not in {"candidate", "production"}:
    raise ValueError(f"QA_TARGET 仅支持 candidate/production，当前为 {TARGET!r}")
CANDIDATE = Path(os.environ.get(
    "QA_STATIC_ROOT",
    ROOT / "release-candidates/cockpit-r50-full-accessibility-20260812-222225/payload",
))
OUT = Path(os.environ.get(
    "QA_OUT_DIR",
    ROOT / f"docs/qa/frontend-skill-cloud-20260812/r50-{TARGET}-behavior",
))
OUT.mkdir(parents=True, exist_ok=True)

os.environ["QA_TARGET"] = TARGET
if TARGET == "candidate":
    os.environ.setdefault("QA_STATIC_ROOT", str(CANDIDATE))
os.environ.setdefault("QA_LOCAL_PORT", "4199")
os.environ.setdefault("QA_TUNNEL_PORT", "13125")

spec = importlib.util.spec_from_file_location("a11y", ROOT / "tests/r48_full_accessibility_qa.py")
a11y = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a11y)
qa = a11y.qa

EXPECTED_ROUTES = [
    "/", "/command", "/projects", "/payment", "/daily", "/collection",
    "/arrears", "/ai-alerts", "/ai-report", "/import", "/review", "/system",
    "/tasks", "/admin",
]
ROUTES = [route.strip() for route in os.environ.get(
    "QA_BEHAVIOR_ROUTES",
    ",".join(EXPECTED_ROUTES),
).split(",") if route.strip()]
ALLOW_PARTIAL = os.environ.get("QA_ALLOW_PARTIAL", "0") == "1"
BASE = qa.PRODUCTION if TARGET == "production" else qa.BASE

EXPECTED_CANDIDATE_FILES = {
    "index.html",
    "aph2-r45-global-accessibility-20260812-v1.css",
    "aph2-r45-global-accessibility-20260812-v1.js",
    "aph2-r47-project-accessibility-20260812-v1.css",
    "aph2-r47-project-accessibility-20260812-v1.js",
    "admin/index.html",
    "admin/aph2-r46-admin-accessibility-20260812-v1.css",
    "admin/aph2-r46-admin-accessibility-20260812-v1.js",
    "arrears/index.html",
    "arrears/aph2-r50-arrears-accessibility-20260812-v1.css",
}
EXPECTED_PRODUCTION_OVERLAYS = {
    "aph2-r45-global-accessibility-20260812-v1.css",
    "aph2-r45-global-accessibility-20260812-v1.js",
    "admin/aph2-r46-admin-accessibility-20260812-v1.css",
    "admin/aph2-r46-admin-accessibility-20260812-v1.js",
    "aph2-r47-project-accessibility-20260812-v1.css",
    "aph2-r47-project-accessibility-20260812-v1.js",
    "arrears/aph2-r50-arrears-accessibility-20260812-v1.css",
}
AUTH_HANDSHAKE_PATHS = {
    "/api/integrations/review/sso",
    "/review-api/auth/cockpit-sso",
}


class ReadOnlyCandidateHandler(a11y.ProductionShellHandler):
    """候选影子服务：仅代理读取；任何意外写请求都在本机返回 405。"""

    blocked_writes: list[dict] = []
    allowed_auth_handshakes: list[dict] = []
    served_files: list[dict] = []
    evidence_lock = threading.Lock()

    def handle_request(self):
        parsed_path = urllib.parse.urlsplit(self.path).path
        if self.command == "POST" and parsed_path in AUTH_HANDSHAKE_PATHS:
            with self.evidence_lock:
                self.allowed_auth_handshakes.append({"method": self.command, "path": self.path})
            return super().handle_request()
        if self.command not in {"GET", "HEAD", "OPTIONS"}:
            with self.evidence_lock:
                self.blocked_writes.append({"method": self.command, "path": self.path})
            payload = b'{"error":"R50 QA is read-only"}'
            self.send_response(405)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        return super().handle_request()

    def send_file(self, file: Path, transform_review: bool = False):
        resolved = file.resolve()
        candidate_root = CANDIDATE.resolve()
        try:
            relative = str(resolved.relative_to(candidate_root))
            source = "candidate"
        except ValueError:
            relative = str(resolved)
            source = "baseline"
        with self.evidence_lock:
            self.served_files.append({
                "requestPath": urllib.parse.urlsplit(self.path).path,
                "source": source,
                "file": relative,
            })
        return super().send_file(file, transform_review=transform_review)


class BrowserReadOnlyGuard:
    """浏览器网络总闸：生产与候选都不允许真实写请求。"""

    def __init__(self):
        self.mock_payment_save = False
        self.mocked_writes: list[dict] = []
        self.blocked_writes: list[dict] = []
        self.auth_handshakes: list[dict] = []

    def handle(self, route: Route) -> None:
        request = route.request
        method = request.method.upper()
        path = urllib.parse.urlsplit(request.url).path
        if method in {"GET", "HEAD", "OPTIONS"}:
            route.continue_()
            return
        evidence = {"method": method, "url": request.url, "path": path}
        if method == "POST" and path in AUTH_HANDSHAKE_PATHS:
            self.auth_handshakes.append(evidence)
            route.continue_()
            return
        if self.mock_payment_save and method == "PUT" and re.fullmatch(r"/api/payments/[^/]+", path):
            self.mocked_writes.append(evidence)
            route.fulfill(status=200, content_type="application/json", body='{"ok":true,"qaMock":true}')
            return
        self.blocked_writes.append(evidence)
        route.abort("blockedbyclient")


def start_read_only_shadow() -> tuple[str, subprocess.Popen, qa.ThreadingHTTPServer, threading.Thread]:
    """启动候选影子环境；后端仅允许读取。"""
    ReadOnlyCandidateHandler.blocked_writes = []
    ReadOnlyCandidateHandler.allowed_auth_handshakes = []
    ReadOnlyCandidateHandler.served_files = []
    tunnel = subprocess.Popen([
        "ssh", "-N", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "-L", f"{qa.TUNNEL_PORT}:127.0.0.1:{qa.REMOTE_SHADOW_PORT}", qa.HOST,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    qa.wait_port(qa.TUNNEL_PORT)
    server = qa.ThreadingHTTPServer(("127.0.0.1", qa.LOCAL_PORT), ReadOnlyCandidateHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return qa.BASE, tunnel, server, thread


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def fetch_bytes(url: str) -> bytes:
    request = urllib.request.Request(url, method="GET")
    ssl_context = None
    if urllib.parse.urlsplit(url).scheme == "https":
        system_ca = Path("/etc/ssl/cert.pem")
        ssl_context = ssl.create_default_context(cafile=str(system_ca) if system_ca.is_file() else None)
    with urllib.request.urlopen(request, timeout=30, context=ssl_context) as response:
        assert response.status == 200, (url, response.status)
        return response.read()


def candidate_url(relative: str) -> str:
    if relative == "index.html":
        return "/"
    if relative == "arrears/index.html":
        return "/arrears/"
    return f"/{relative}"


def verify_delivery_source() -> dict:
    """证明实际读取了候选字节，或证明生产不可变资源与候选一致。"""
    candidate_root = CANDIDATE.resolve()
    source_root = candidate_root if TARGET == "candidate" else (ROOT / "firstcare-cloud-local").resolve()
    assert source_root.is_dir(), f"交付源目录不存在：{source_root}"
    if TARGET == "candidate":
        source_files = {
            str(path.relative_to(source_root))
            for path in source_root.rglob("*")
            if path.is_file()
        }
        assert source_files == EXPECTED_CANDIDATE_FILES, {
            "missing": sorted(EXPECTED_CANDIDATE_FILES - source_files),
            "unexpected": sorted(source_files - EXPECTED_CANDIDATE_FILES),
        }
        selected_files = sorted(source_files)
    else:
        source_files = EXPECTED_PRODUCTION_OVERLAYS
        assert all((source_root / relative).is_file() for relative in source_files), source_files
        selected_files = sorted(source_files)
    checks = []
    for relative in selected_files:
        expected_payload = (source_root / relative).read_bytes()
        actual_payload = fetch_bytes(BASE + candidate_url(relative))
        expected_hash = sha256(expected_payload)
        actual_hash = sha256(actual_payload)
        assert actual_hash == expected_hash, {
            "target": TARGET,
            "file": relative,
            "expectedSha256": expected_hash,
            "actualSha256": actual_hash,
        }
        checks.append({
            "file": relative,
            "bytes": len(actual_payload),
            "sha256": actual_hash,
        })

    shell = fetch_bytes(BASE + "/").decode("utf-8")
    shell_tokens = [
        "aph2-r45-global-accessibility-20260812-v1",
        "aph2-r46-admin-accessibility-20260812-v1",
        "aph2-r47-project-accessibility-20260812-v1",
    ]
    assert all(token in shell for token in shell_tokens), shell_tokens
    arrears_shell = fetch_bytes(BASE + "/arrears/").decode("utf-8")
    assert "aph2-r50-arrears-accessibility-20260812-v1" in arrears_shell

    served_from_candidate = None
    if TARGET == "candidate":
        served = list(ReadOnlyCandidateHandler.served_files)
        for relative in selected_files:
            request_path = urllib.parse.urlsplit(candidate_url(relative)).path
            assert any(
                item["requestPath"] == request_path
                and item["source"] == "candidate"
                and item["file"] == relative
                for item in served
            ), {"file": relative, "served": served}
        served_from_candidate = len(selected_files)

    return {
        "target": TARGET,
        "base": BASE,
        "sourceRoot": str(source_root),
        "sourceFileCount": len(source_files),
        "byteExactFileCount": len(checks),
        "servedFromCandidateCount": served_from_candidate,
        "shellTokens": shell_tokens + ["aph2-r50-arrears-accessibility-20260812-v1"],
        "files": checks,
    }


def route_coverage() -> dict:
    assert len(ROUTES) == len(set(ROUTES)), f"路由列表含重复项：{ROUTES}"
    unexpected = sorted(set(ROUTES) - set(EXPECTED_ROUTES))
    missing = sorted(set(EXPECTED_ROUTES) - set(ROUTES))
    assert not unexpected, {"unexpectedRoutes": unexpected}
    if missing and not ALLOW_PARTIAL:
        raise AssertionError({
            "missingRoutes": missing,
            "hint": "仅调试时可显式设置 QA_ALLOW_PARTIAL=1；全量验收不允许缩窄路由",
        })
    return {
        "expected": EXPECTED_ROUTES,
        "tested": ROUTES,
        "full": not missing,
        "partialExplicitlyAllowed": ALLOW_PARTIAL,
        "missing": missing,
    }


EXPECTED_409_PATHS = {
    "/api/ai/brief",
    "/api/ai/health",
    "/api/ai/interpret",
    "/api/ai/monthly-report",
    "/api/ai/risk-trends",
    "/api/ai/trends",
    "/api/ai/week-focus",
    "/api/alerts",
}


def unexpected_bad_responses(items: list[dict]) -> list[dict]:
    return [
        item for item in items
        if not (
            item["status"] == 409
            and urllib.parse.urlsplit(item["url"]).path in EXPECTED_409_PATHS
        )
    ]


def api_json(page, path: str):
    response = page.evaluate("""async path => {
      const token = localStorage.getItem('cockpit_token') || localStorage.getItem('token')
      const response = await fetch(path, {
        method: 'GET',
        headers: token ? {Authorization: `Bearer ${token}`} : {},
      })
      const text = await response.text()
      return {status: response.status, payload: text ? JSON.parse(text) : null}
    }""", path)
    assert response["status"] == 200, {"path": path, "status": response["status"]}
    return response["payload"]


def json_sha256(value) -> str:
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def assert_close(actual, expected, tolerance: float = 0.00011) -> None:
    assert actual is not None and abs(float(actual) - float(expected)) <= tolerance, {
        "actual": actual,
        "expected": expected,
        "tolerance": tolerance,
    }


def format_wan(value) -> str:
    return f"{float(value):,.2f}万"


def format_signed_wan(value) -> str:
    number = float(value)
    return f"{'+' if number >= 0 else ''}{number:,.2f}万"


def format_rate(value) -> str:
    if value is None:
        return "—"
    return f"{float(value) * 100:.2f}%"


def visible_table(page) -> dict:
    return page.evaluate(r"""() => {
      const table = [...document.querySelectorAll('table')]
        .find(item => item.getClientRects().length && item.querySelector('tbody tr'))
      return {
        headers: [...table.querySelectorAll('thead th')]
          .filter(cell => cell.getClientRects().length)
          .map(cell => cell.textContent.replace(/\s*[↕↑↓]\s*$/, '').trim()),
        rows: [...table.querySelectorAll('tbody tr')]
          .filter(row => row.getClientRects().length)
          .map(row => [...row.cells].map(cell => cell.textContent.trim())),
        title: document.title,
        h1: [...document.querySelectorAll('h1')]
          .filter(item => item.getClientRects().length)
          .map(item => item.textContent.trim()),
      }
    }""")


def init_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R50候选验收',role:'admin'}));"
    )


def page_observers(page):
    console_errors, page_errors, failed_requests, bad_responses = [], [], [], []
    page.on("console", lambda message: console_errors.append(message.text)
            if message.type == "error" and "409 (Conflict)" not in message.text else None)
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on("requestfailed", lambda request: failed_requests.append({
        "url": request.url,
        "error": request.failure,
    }) if request.failure != "net::ERR_ABORTED" else None)
    page.on("response", lambda response: bad_responses.append({
        "url": response.url,
        "status": response.status,
        "type": response.request.resource_type,
    }) if response.status >= 400 else None)
    return console_errors, page_errors, failed_requests, bad_responses


def wait_route(page, route: str) -> None:
    page.goto(BASE + route, wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_timeout(4_500 if route == "/admin" else 1_800)


def smoke_all_routes(browser, token: str, network_guard: BrowserReadOnlyGuard) -> dict:
    result = {}
    for name, viewport in [
        ("desktop", {"width": 1440, "height": 1000}),
        ("mobile", {"width": 390, "height": 844}),
    ]:
        context = browser.new_context(viewport=viewport)
        context.add_init_script(script=init_script(token))
        context.route("**/*", network_guard.handle)
        page = context.new_page()
        console_errors, page_errors, failed_requests, bad_responses = page_observers(page)
        route_result = {}
        for route in ROUTES:
            before_bad_responses = len(bad_responses)
            response = page.goto(BASE + route, wait_until="domcontentloaded", timeout=30_000)
            page.wait_for_timeout(4_500 if route == "/admin" else 1_800)
            assert response and response.status < 400, (route, response.status if response else None)
            page.locator("h1:visible").first.wait_for(state="visible", timeout=12_000)
            page.wait_for_timeout(650)
            probe = page.evaluate("""() => ({
              overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
              h1: [...document.querySelectorAll('h1')]
                .filter(item => item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden').length,
              globalRelease: document.body.dataset.r45GlobalA11y || null,
              projectRelease: document.body.dataset.r47Release || null,
              adminRelease: document.body.dataset.r46AdminAccessibility || null,
              projectGateSources: performance.getEntriesByType('resource')
                .map(entry => entry.name)
                .filter(name => name.includes('r45-cloud') || name.includes('project-gate')),
            })""")
            assert probe["overflow"] <= 1, (name, route, probe)
            assert probe["h1"] >= 1, (name, route, probe)
            assert probe["globalRelease"] == "r45-global-accessibility-20260812-v1", (route, probe)
            if route == "/projects":
                assert probe["projectRelease"] == "r47-project-accessibility-20260812-v1", probe
            if route == "/admin":
                assert probe["adminRelease"] == "r46-admin-accessibility-20260812-v1", probe
            probe["badResponses"] = bad_responses[before_bad_responses:]
            unexpected_responses = unexpected_bad_responses(probe["badResponses"])
            assert not unexpected_responses, {
                "viewport": name,
                "route": route,
                "unexpectedBadResponses": unexpected_responses,
            }
            route_result[route] = probe
        assert not console_errors and not page_errors and not failed_requests, {
            "viewport": name,
            "consoleErrors": console_errors,
            "pageErrors": page_errors,
            "failedRequests": failed_requests,
            "badResponses": bad_responses,
            "routeResults": route_result,
        }
        result[name] = route_result
        context.close()
    return result


def verify_protected_business_routes(page) -> dict:
    result = {}

    wait_route(page, "/payment")
    page.locator("tbody tr:visible").first.wait_for(state="visible", timeout=12_000)
    payment_dom = visible_table(page)
    payments = api_json(page, "/api/payments")
    assert payment_dom["title"] == "回款额执行评估 · 第一服务华北地区", payment_dom
    assert payment_dom["h1"] == ["回款额执行"], payment_dom
    assert payment_dom["headers"] == [
        "#", "片区", "服务中心", "年度预算", "累计预算", "累计执行",
        "差额", "年度完成率", "累计完成率", "同期执行", "增幅",
    ], payment_dom["headers"]
    assert len(payments) == 56 and len(payment_dom["rows"]) == len(payments), {
        "api": len(payments), "dom": len(payment_dom["rows"]),
    }
    assert len({row["id"] for row in payments}) == len(payments)
    assert len({row["center"] for row in payments}) == len(payments)
    assert [row[2] for row in payment_dom["rows"]] == [row["center"] for row in payments]
    for dom_row, api_row in zip(payment_dom["rows"], payments):
        assert dom_row[1] == api_row["area"] and dom_row[2] == api_row["center"], dom_row
        assert dom_row[3] == format_wan(api_row["annualBudget"]), (dom_row, api_row)
        assert dom_row[4] == format_wan(api_row["cumulativeBudget"]), (dom_row, api_row)
        assert dom_row[5] == format_wan(api_row["cumulativeExecuted"]), (dom_row, api_row)
        assert dom_row[6] == format_signed_wan(api_row["executionVariance"]), (dom_row, api_row)
        assert dom_row[7] == format_rate(api_row["annualRate"]), (dom_row, api_row)
        assert dom_row[8] == format_rate(api_row["cumulativeRate"]), (dom_row, api_row)
        assert_close(api_row["diff"], api_row["cumulativeBudget"] - api_row["cumulativeExecuted"], 0.001)
        assert_close(api_row["executionVariance"], -api_row["diff"], 0.001)
        if api_row["annualBudget"]:
            assert_close(api_row["annualRate"], round(api_row["cumulativeExecuted"] / api_row["annualBudget"], 4))
        if api_row["cumulativeBudget"]:
            assert_close(api_row["cumulativeRate"], round(api_row["cumulativeExecuted"] / api_row["cumulativeBudget"], 4))
        if api_row["samePeriod"]:
            assert_close(api_row["growth"], round(api_row["cumulativeExecuted"] / api_row["samePeriod"] - 1, 4))
    result["payment"] = {
        "rows": len(payments),
        "title": payment_dom["title"],
        "h1": payment_dom["h1"],
        "headers": payment_dom["headers"],
        "apiSha256": json_sha256(payments),
        "domSha256": json_sha256(payment_dom["rows"]),
        "formulaRows": len(payments),
    }

    wait_route(page, "/daily")
    page.locator("tbody tr:visible").first.wait_for(state="visible", timeout=12_000)
    daily_dom = visible_table(page)
    dates = api_json(page, "/api/daily/dates")
    assert dates and all(re.fullmatch(r"\d{4}-\d{2}-\d{2}", item["date"]) for item in dates), dates
    latest = max(item["date"] for item in dates)
    daily = api_json(page, f"/api/daily?date={urllib.parse.quote(latest)}")
    daily_rows = daily["rows"]
    assert daily_dom["title"] == "每日回款明细 · 第一服务华北地区", daily_dom
    assert daily_dom["h1"] == ["每日回款"], daily_dom
    assert daily_dom["headers"] == ["服务中心", "片区", "累计预算", "今日累计", "完成率", "日回款"]
    assert daily["date"] == latest and daily["sourceStatus"] == "available", daily
    assert len(daily_rows) == 46 and len(daily_dom["rows"]) == len(daily_rows), {
        "api": len(daily_rows), "dom": len(daily_dom["rows"]),
    }
    assert len({row["center"] for row in daily_rows}) == len(daily_rows)
    daily_by_center = {row["center"]: row for row in daily_rows}
    assert {row[0] for row in daily_dom["rows"]} == set(daily_by_center), daily_dom["rows"]
    for dom_row in daily_dom["rows"]:
        api_row = daily_by_center[dom_row[0]]
        expected_rate = api_row["today"] / api_row["annual_budget"] if api_row["annual_budget"] else None
        assert dom_row[1] == api_row["area"], (dom_row, api_row)
        assert dom_row[2] == format_wan(api_row["annual_budget"]), (dom_row, api_row)
        assert dom_row[3] == format_wan(api_row["today"]), (dom_row, api_row)
        assert dom_row[4] == (format_rate(expected_rate) if expected_rate is not None else "—"), (dom_row, api_row)
        assert dom_row[5] == ("—" if not api_row["daily"] else format_wan(api_row["daily"])), (dom_row, api_row)
    assert_close(daily["dailyTotal"], sum(float(row["daily"] or 0) for row in daily_rows), 0.001)
    selected_dates = page.locator('input[type="date"]:visible').evaluate_all("items => items.map(item => item.value)")
    assert selected_dates == [latest], selected_dates
    result["daily"] = {
        "rows": len(daily_rows),
        "latestDate": latest,
        "sourceStatus": daily["sourceStatus"],
        "dailyTotal": daily["dailyTotal"],
        "title": daily_dom["title"],
        "h1": daily_dom["h1"],
        "headers": daily_dom["headers"],
        "apiSha256": json_sha256(daily),
        "domSha256": json_sha256(daily_dom["rows"]),
        "formulaRows": len(daily_rows),
    }

    wait_route(page, "/collection")
    collection_rows = page.locator("tbody tr")
    collection_rows.nth(34).wait_for(state="attached", timeout=12_000)
    assert collection_rows.count() == 35, collection_rows.count()
    collection_dom = visible_table(page)
    collections = api_json(page, "/api/collections")
    summary = api_json(page, "/api/summary")
    assert collection_dom["title"] == "收缴率明细 · 第一服务华北地区", collection_dom
    assert collection_dom["h1"] == ["华北各片区收缴明细"], collection_dom
    assert collection_dom["headers"] == ["片区", "服务中心", "应收", "实收", "未收", "收缴率"]
    assert len(collections) == 35 and len(collection_dom["rows"]) == len(collections), {
        "api": len(collections), "dom": len(collection_dom["rows"]),
    }
    assert len({row["id"] for row in collections}) == len(collections)
    assert len({row["center"] for row in collections}) == len(collections)
    collection_by_center = {row["center"]: row for row in collections}
    assert {row[1] for row in collection_dom["rows"]} == set(collection_by_center), collection_dom["rows"]
    allowed_rate_bases = {
        "official-gatheringCurrentYearRecedRate",
        "heating-adjusted-received-over-receivable",
    }
    for dom_row in collection_dom["rows"]:
        api_row = collection_by_center[dom_row[1]]
        assert api_row["sourceStatus"] == "available" and api_row["stale"] is False, api_row
        assert api_row["rateBasis"] in allowed_rate_bases and api_row["source"], api_row
        assert 0 <= api_row["rate"] <= 1 and api_row["rate"] == api_row["collectionRate"], api_row
        assert dom_row[0] == api_row["area"], (dom_row, api_row)
        assert dom_row[2] == format_wan(api_row["receivable"]), (dom_row, api_row)
        assert dom_row[3] == format_wan(api_row["received"]), (dom_row, api_row)
        assert dom_row[4] == format_wan(api_row["outstanding"]), (dom_row, api_row)
        assert dom_row[5] == format_rate(api_row["rate"]), (dom_row, api_row)
    lvzai = collections[0]["_lvzaiSummary"]
    quality = lvzai["sourceQuality"]
    assert quality == {
        **quality,
        "ready": True,
        "status": "available",
        "rowCount": 35,
        "duplicateCenterCount": 0,
        "invalidAmountCount": 0,
        "stale": False,
        "reasons": [],
    }, quality
    assert lvzai["publicationStatus"] == "published" and lvzai["sourceStatus"] == "available", lvzai
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", lvzai["businessDate"]), lvzai["businessDate"]
    for key, summary_key in [
        ("collectionRate", "collectionRate"),
        ("collectionReceivable", "collectionReceivable"),
        ("collectionReceived", "collectionReceived"),
        ("collectionOutstanding", "collectionOutstanding"),
    ]:
        assert_close(summary[summary_key], lvzai[key], 0.001)
    assert summary["collectionPublicationStatus"] == "published", summary
    assert summary["collectionBusinessDate"] == lvzai["businessDate"], summary
    collection_rate = qa.assert_official_collection_rate_display(page, "#main-content")
    result["collection"] = {
        "rows": len(collections),
        "businessDate": lvzai["businessDate"],
        "publicationStatus": lvzai["publicationStatus"],
        "sourceStatus": lvzai["sourceStatus"],
        "methodologyVersion": lvzai["methodologyVersion"],
        "sourceQuality": quality,
        "title": collection_dom["title"],
        "h1": collection_dom["h1"],
        "headers": collection_dom["headers"],
        "rateDisplay": collection_rate,
        "apiSha256": json_sha256(collections),
        "domSha256": json_sha256(collection_dom["rows"]),
        "verifiedRows": len(collections),
    }
    return result


def verify_assistant(page) -> dict:
    wait_route(page, "/")
    page.locator('svg[aria-label="辽宁、河北、天津、北京区域地图"][role="group"]').wait_for(
        state="attached", timeout=12_000,
    )
    closed = page.evaluate("""() => {
      const overlay = document.querySelector('.north-ai-overlay')
      return {
        hidden: overlay?.getAttribute('aria-hidden'),
        inert: overlay?.inert,
        display: overlay ? getComputedStyle(overlay).display : null,
        mapRole: document.querySelector('svg[aria-label="辽宁、河北、天津、北京区域地图"]')?.getAttribute('role'),
      }
    }""")
    assert closed == {"hidden": "true", "inert": True, "display": "none", "mapRole": "group"}, closed
    launcher = page.locator(".north-ai-launcher")
    launcher.click()
    page.locator(".north-ai-input").wait_for(state="visible")
    page.wait_for_timeout(280)
    opened = page.evaluate("""() => {
      const overlay = document.querySelector('.north-ai-overlay')
      return {
        hidden: overlay.getAttribute('aria-hidden'),
        inert: overlay.inert,
        display: getComputedStyle(overlay).display,
        focus: document.activeElement?.className,
      }
    }""")
    assert opened["hidden"] == "false" and opened["inert"] is False and opened["display"] == "flex", opened
    assert "north-ai-input" in opened["focus"], opened
    page.locator(".north-ai-close").click()
    page.wait_for_timeout(80)
    assert page.evaluate("document.activeElement?.classList.contains('north-ai-launcher')") is True
    return {"closed": closed, "opened": opened, "focusRestored": True}


def verify_projects(page) -> dict:
    wait_route(page, "/projects")
    project_rows = page.locator("[data-project-profile-id]")
    project_rows.nth(41).wait_for(state="attached", timeout=12_000)
    assert project_rows.count() == 42, project_rows.count()
    probe = page.evaluate("""() => ({
      rows: document.querySelectorAll('[data-project-profile-id]').length,
      navBeforeMain: (() => {
        const nav = document.querySelector('.aph-mobile-primary-nav')
        const main = document.getElementById('main-content')
        return Boolean(nav && main && nav.parentElement === main.parentElement && nav.nextSibling === main)
      })(),
      statusRole: document.querySelector('[data-project-visible-count]')?.getAttribute('role'),
      statusLive: document.querySelector('[data-project-visible-count]')?.getAttribute('aria-live'),
      tableRole: document.querySelector('.aph-project-table-wrap')?.getAttribute('role'),
    })""")
    assert probe == {
        "rows": 42,
        "navBeforeMain": True,
        "statusRole": "status",
        "statusLive": "polite",
        "tableRole": "region",
    }, probe

    skip = page.locator("a.skip-link")
    skip.focus()
    skip_top = round(skip.bounding_box()["y"])
    assert skip_top >= 0, skip_top
    skip.click()
    assert page.evaluate("document.activeElement?.id") == "main-content"

    opener = page.locator("[data-project-profile-id]").first
    opener.focus()
    opener.press("Enter")
    dialog = page.locator('.aph-project-drawer-panel[role="dialog"]')
    dialog.wait_for(state="visible")
    assert dialog.get_attribute("aria-modal") == "true"
    assert page.evaluate("document.querySelector('.aph-project-drawer-panel').contains(document.activeElement)") is True
    page.keyboard.press("Escape")
    page.wait_for_timeout(120)
    assert page.locator(".aph-project-drawer").get_attribute("hidden") is not None
    assert page.evaluate("document.activeElement === document.querySelector('[data-project-profile-id]')") is True
    probe.update({"skipTop": skip_top, "dialogEsc": True, "dialogFocusRestored": True})
    return probe


def verify_admin(page, network_guard: BrowserReadOnlyGuard) -> dict:
    wait_route(page, "/admin")
    admin_rows = page.locator("table tbody tr")
    admin_rows.nth(55).wait_for(state="attached", timeout=15_000)
    assert admin_rows.count() == 56, admin_rows.count()
    initial = page.evaluate("""() => {
      const rows = [...document.querySelectorAll('table tbody tr')]
      const editable = document.querySelector('td[data-r34-label] [title="点击编辑"]')
      const tabs = [...document.querySelectorAll('.aph-r46-admin-tabs > button')]
      return {
        rows: rows.length,
        rendered: rows.filter(row => row.getClientRects().length > 0).length,
        collapsedDisplayNone: rows.filter(row => row.hidden && getComputedStyle(row).display === 'none').length,
        editableRole: editable?.getAttribute('role'),
        editableTabIndex: editable?.tabIndex,
        editableName: editable?.getAttribute('aria-label'),
        mainCount: document.querySelectorAll('[role="main"], main').length,
        tabs: tabs.length,
        tabStops: tabs.filter(tab => tab.tabIndex === 0).length,
      }
    }""")
    assert initial["rows"] == 56 and initial["rendered"] == 10 and initial["collapsedDisplayNone"] == 46, initial
    assert initial["editableRole"] == "button" and initial["editableTabIndex"] == 0 and initial["editableName"], initial
    assert initial["mainCount"] == 1 and initial["tabs"] == 8 and initial["tabStops"] == 1, initial

    first_tab = page.locator(".aph-r46-admin-tabs > button").first
    first_tab.focus()
    first_tab.press("ArrowRight")
    page.wait_for_timeout(120)
    assert page.evaluate("document.activeElement?.textContent.trim()") == "收缴率"
    page.get_by_role("tab", name="回款额").click()
    admin_rows.nth(55).wait_for(state="attached", timeout=12_000)
    assert admin_rows.count() == 56, admin_rows.count()

    editable = page.locator('td[data-r34-label] [title="点击编辑"]').first
    editable.focus()
    editable.press("Enter")
    field = page.locator("table tbody tr").first.locator("input").first
    field.wait_for(state="visible")
    assert field.get_attribute("aria-label")
    value = float(field.input_value())
    field.fill(str(value + 0.01))
    page.wait_for_timeout(160)
    save = page.locator("table tbody tr").first.get_by_role("button", name="保存")
    assert save.is_enabled(), "编辑后保存按钮仍为 disabled"

    mocked_before = len(network_guard.mocked_writes)
    network_guard.mock_payment_save = True
    try:
        save.click()
        page.wait_for_timeout(300)
    finally:
        network_guard.mock_payment_save = False
    intercepted = network_guard.mocked_writes[mocked_before:]
    assert len(intercepted) == 1 and intercepted[0]["method"] == "PUT", intercepted

    page.reload(wait_until="domcontentloaded")
    page.wait_for_timeout(4_500)
    page.get_by_role("tab", name="操作日志").click()
    toggle = page.locator(".aph-r46-table-toggle").filter(has_text="显示其余 180 行")
    toggle.wait_for(state="visible", timeout=15_000)
    log_probe = page.evaluate("""() => {
      const tables = [...document.querySelectorAll('table')]
      const table = tables.find(item => item.querySelectorAll('tbody tr').length >= 200)
      const rows = [...table.querySelectorAll('tbody tr')]
      return {total: rows.length, rendered: rows.filter(row => row.getClientRects().length > 0).length}
    }""")
    assert log_probe == {"total": 200, "rendered": 20}, log_probe
    toggle.focus()
    toggle.press("Enter")
    page.wait_for_timeout(120)
    expanded = page.evaluate("""() => {
      const table = [...document.querySelectorAll('table')]
        .find(item => item.querySelectorAll('tbody tr').length === 200)
      return [...table.querySelectorAll('tbody tr')]
        .filter(row => row.getClientRects().length).length
    }""")
    assert expanded == 200, expanded
    page.locator(".aph-r46-table-toggle").filter(has_text="收起其余行").press("Enter")
    page.wait_for_timeout(120)

    page.get_by_role("tab", name="用户管理").click()
    page.wait_for_timeout(1_000)
    labels = page.evaluate("""() => [...document.querySelectorAll('#root label')]
      .filter(label => label.parentElement?.querySelector(':scope > input, :scope > select, :scope > textarea'))
      .map(label => ({forId: label.htmlFor, exists: Boolean(document.getElementById(label.htmlFor))}))""")
    assert len(labels) >= 5 and all(item["forId"] and item["exists"] for item in labels), labels
    initial.update({
        "saveEnabledAfterEdit": True,
        "interceptedSaveMethod": intercepted[0]["method"],
        "logs": log_probe,
        "expandedLogs": expanded,
        "associatedLabels": len(labels),
    })
    return initial


def verify_review_scroll(page) -> dict:
    wait_route(page, "/review")
    region = page.locator('[data-r45-a11y="scroll-region"]').first
    region.wait_for(state="visible")
    probe = {
        "tabIndex": region.evaluate("element => element.tabIndex"),
        "role": region.get_attribute("role"),
        "label": region.get_attribute("aria-label"),
    }
    assert probe["tabIndex"] == 0 and probe["role"] == "region" and probe["label"], probe
    return probe


def main() -> None:
    coverage = route_coverage()
    token = qa.ephemeral_token()
    tunnel = server = thread = None
    try:
        if TARGET == "candidate":
            base, tunnel, server, thread = start_read_only_shadow()
            assert base == BASE, {"expected": BASE, "actual": base}
        delivery = verify_delivery_source()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            network_guard = BrowserReadOnlyGuard()
            output = {
                "target": TARGET,
                "base": BASE,
                "candidate": str(CANDIDATE.resolve()),
                "routeCoverage": coverage,
                "delivery": delivery,
            }
            output["routes"] = smoke_all_routes(browser, token, network_guard)

            desktop = browser.new_context(viewport={"width": 1440, "height": 1000})
            desktop.add_init_script(script=init_script(token))
            desktop.route("**/*", network_guard.handle)
            page = desktop.new_page()
            console_errors, page_errors, failed_requests, bad_responses = page_observers(page)
            output["protectedBusiness"] = verify_protected_business_routes(page)
            output["assistant"] = verify_assistant(page)
            unexpected_responses = unexpected_bad_responses(bad_responses)
            assert not console_errors and not page_errors and not failed_requests and not unexpected_responses, {
                "consoleErrors": console_errors,
                "pageErrors": page_errors,
                "failedRequests": failed_requests,
                "unexpectedBadResponses": unexpected_responses,
                "allBadResponses": bad_responses,
            }
            desktop.close()

            mobile = browser.new_context(viewport={"width": 390, "height": 844})
            mobile.add_init_script(script=init_script(token))
            mobile.route("**/*", network_guard.handle)
            page = mobile.new_page()
            console_errors, page_errors, failed_requests, bad_responses = page_observers(page)
            output["projects"] = verify_projects(page)
            output["admin"] = verify_admin(page, network_guard)
            unexpected_responses = unexpected_bad_responses(bad_responses)
            assert not console_errors and not page_errors and not failed_requests and not unexpected_responses, {
                "consoleErrors": console_errors,
                "pageErrors": page_errors,
                "failedRequests": failed_requests,
                "unexpectedBadResponses": unexpected_responses,
                "allBadResponses": bad_responses,
            }
            mobile.close()

            review_context = browser.new_context(viewport={"width": 390, "height": 844})
            review_context.add_init_script(script=init_script(token))
            review_context.route("**/*", network_guard.handle)
            page = review_context.new_page()
            console_errors, page_errors, failed_requests, bad_responses = page_observers(page)
            output["review"] = verify_review_scroll(page)
            unexpected_responses = unexpected_bad_responses(bad_responses)
            assert not console_errors and not page_errors and not failed_requests and not unexpected_responses, {
                "consoleErrors": console_errors,
                "pageErrors": page_errors,
                "failedRequests": failed_requests,
                "unexpectedBadResponses": unexpected_responses,
                "allBadResponses": bad_responses,
            }
            review_context.close()
            output["networkSafety"] = {
                "mode": "browser-route-read-only",
                "mockedWrites": network_guard.mocked_writes,
                "allowedAuthHandshakes": network_guard.auth_handshakes,
                "blockedUnexpectedWrites": network_guard.blocked_writes,
                "candidateServerBlockedWrites": (
                    list(ReadOnlyCandidateHandler.blocked_writes)
                    if TARGET == "candidate" else None
                ),
            }
            assert len(network_guard.mocked_writes) == 1, network_guard.mocked_writes
            assert network_guard.auth_handshakes, "审核页未发起一次性 SSO 认证握手"
            assert all(item["path"] in AUTH_HANDSHAKE_PATHS for item in network_guard.auth_handshakes)
            assert not network_guard.blocked_writes, network_guard.blocked_writes
            if TARGET == "candidate":
                assert not ReadOnlyCandidateHandler.blocked_writes, ReadOnlyCandidateHandler.blocked_writes
            browser.close()

        result_file = OUT / f"r50-{TARGET}-behavior.json"
        result_file.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({
            "routes": sum(len(items) for items in output["routes"].values()),
            "collectionRows": output["protectedBusiness"]["collection"]["rows"],
            "paymentRows": output["protectedBusiness"]["payment"]["rows"],
            "dailyRows": output["protectedBusiness"]["daily"]["rows"],
            "projectRows": output["projects"]["rows"],
            "adminRows": output["admin"]["rows"],
            "saveMethod": output["admin"]["interceptedSaveMethod"],
            "target": TARGET,
            "base": BASE,
            "businessWrites": 0,
            "authHandshakes": len(output["networkSafety"]["allowedAuthHandshakes"]),
            "resultFile": str(result_file),
        }, ensure_ascii=False))
    finally:
        token = ""
        if server:
            server.shutdown()
            server.server_close()
        if thread:
            thread.join(timeout=2)
        if tunnel:
            tunnel.terminate()
            try:
                tunnel.wait(timeout=5)
            except subprocess.TimeoutExpired:
                tunnel.kill()


if __name__ == "__main__":
    main()
