#!/usr/bin/env python3
"""R51 研发小组审核系统云端定向验收。

默认只读访问 https://www.firstcare.cloud，不触发审批、签发、归档等业务写操作。
每个视口都从 /review 启动桥独立签发一次 SSO，验证一次性 query 已清理后，
再扫描管理员全路由与真实方案详情（如存在）。路由矩阵在浏览器层禁止业务写请求。

用法：
  python3 tests/r51_review_system_production_qa.py --static-check
  python3 tests/r51_review_system_production_qa.py
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import time
import traceback
import urllib.parse
from pathlib import Path
from typing import Any

from playwright.sync_api import BrowserContext, Page, Response, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
AXE = ROOT / "node_modules/axe-core/axe.min.js"
BASE = os.environ.get("QA_BASE", "https://www.firstcare.cloud").rstrip("/")
OUT = Path(os.environ.get(
    "QA_OUT_FILE",
    ROOT / "docs/qa/frontend-skill-cloud-20260812/r51-review-production/r51-review-production-results.json",
))
SCREENSHOT_DIR = Path(os.environ.get("QA_SCREENSHOT_DIR", str(OUT.parent / "screenshots")))
VIEWPORTS = [
    ("desktop", {"width": 1440, "height": 1000}),
    ("mobile320", {"width": 320, "height": 844}),
]
WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]
ROUTE_MATRIX = [
    {"route": "/", "heading": "让每一次方案审核，都有标准、有依据、有结论"},
    {"route": "/submit", "heading": "方案提交"},
    {"route": "/review", "heading": "审核中心"},
    {"route": "/bots", "heading": "审核机器人配置"},
    {"route": "/users", "heading": "人员管理"},
    {"route": "/knowledge", "heading": "专业知识库"},
    {"route": "/rules", "heading": "规则配置"},
    {"route": "/stats", "heading": "数据分析"},
    {"route": "/logs", "heading": "日志中心"},
    {"route": "/settings", "heading": "系统设置"},
]
SAFE_MATRIX_METHODS = {"GET", "HEAD", "OPTIONS"}
SSO_WRITE_ALLOWLIST = {
    ("POST", "/api/integrations/review/sso"),
    ("POST", "/review-api/auth/cockpit-sso"),
}


def scrub_secret(value: Any) -> str:
    """从报告与异常中移除 SSO/JWT，不让验收证据反向泄露会话。"""
    text = str(value or "")
    text = re.sub(r"([?&]sso=)[^&#\s]+", r"\1[redacted]", text, flags=re.IGNORECASE)
    text = re.sub(
        r"\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b",
        "[jwt-redacted]",
        text,
    )
    text = re.sub(r"(/review-system/review/)[^/?#\s'\"]+", r"\1:id", text)
    text = re.sub(r"(/review-api/proposals/)[^/?#\s'\"]+", r"\1:id", text)
    return text[:1000]


def url_evidence(url: str) -> dict[str, Any]:
    """只保留 URL 结构证据，不保留任何 query 值。"""
    parsed = urllib.parse.urlsplit(url)
    query_keys = sorted(set(urllib.parse.parse_qs(parsed.query, keep_blank_values=True)))
    return {
        "scheme": parsed.scheme,
        "host": parsed.netloc,
        "path": redact_business_path(parsed.path),
        "queryKeys": query_keys,
        "hasSso": "sso" in query_keys,
    }


def redact_business_path(path: str) -> str:
    """详情验收报告仅保留 :id 占位，不把真实方案 ID 写入报告。"""
    text = str(path or "")
    text = re.sub(r"^(/review-api/proposals/)[^/]+", r"\1:id", text)
    text = re.sub(r"^(/review-system/review/)[^/]+", r"\1:id", text)
    return text


def request_record(request) -> dict[str, Any]:
    parsed = urllib.parse.urlsplit(request.url)
    return {
        "host": parsed.netloc,
        "path": redact_business_path(parsed.path),
        "queryKeys": sorted(set(urllib.parse.parse_qs(parsed.query, keep_blank_values=True))),
        "method": request.method,
        "resourceType": request.resource_type,
    }


def response_record(response: Response) -> dict[str, Any]:
    parsed = urllib.parse.urlsplit(response.url)
    return {
        "host": parsed.netloc,
        "path": redact_business_path(parsed.path),
        "queryKeys": sorted(set(urllib.parse.parse_qs(parsed.query, keep_blank_values=True))),
        "method": response.request.method,
        "status": response.status,
        "resourceType": response.request.resource_type,
    }


def install_runtime_observers(page: Page) -> dict[str, Any]:
    tracker: dict[str, Any] = {
        "navigations": [],
        "requests": [],
        "responses": [],
        "dashboardResponses": [],
        "proposalListResponses": [],
        "consoleErrors": [],
        "pageErrors": [],
        "failedRequests": [],
        "errorResponses": [],
    }

    def on_navigation(frame) -> None:
        if frame == page.main_frame:
            tracker["navigations"].append(url_evidence(frame.url))

    def on_response(response: Response) -> None:
        record = response_record(response)
        tracker["responses"].append(record)
        if record["path"] == "/review-api/dashboard" and record["method"] == "GET":
            tracker["dashboardResponses"].append(response)
        if record["path"] == "/review-api/proposals" and record["method"] == "GET":
            tracker["proposalListResponses"].append(response)
        if response.status >= 400:
            tracker["errorResponses"].append(record)

    def on_failed_request(request) -> None:
        record = request_record(request)
        tracker["failedRequests"].append({
            **record,
            "error": scrub_secret(request.failure),
        })

    page.on("framenavigated", on_navigation)
    page.on("request", lambda request: tracker["requests"].append(request_record(request)))
    page.on("response", on_response)
    page.on("console", lambda message: tracker["consoleErrors"].append(scrub_secret(message.text)) if message.type == "error" else None)
    page.on("pageerror", lambda error: tracker["pageErrors"].append(scrub_secret(error)))
    page.on("requestfailed", on_failed_request)
    return tracker


def install_read_only_guard(
    page: Page,
    tracker: dict[str, Any],
    allowlist: set[tuple[str, str]] | None = None,
) -> None:
    """先在浏览器层拦截非安全方法，即使页面误发写请求也不会抵达后端。"""
    allowed = allowlist or set()
    tracker["blockedUnsafeRequests"] = []

    def guard(route, request) -> None:
        record = request_record(request)
        if request.method in SAFE_MATRIX_METHODS or (request.method, record["path"]) in allowed:
            route.continue_()
            return
        tracker["blockedUnsafeRequests"].append(record)
        route.abort("blockedbyclient")

    page.route("**/*", guard)


def await_response(
    page: Page,
    tracker: dict[str, Any],
    path: str,
    method: str,
    status: int = 200,
    timeout_ms: int = 30_000,
) -> dict[str, Any]:
    """使用事件记录等待跨文档响应，避免 SSO 硬跳转造成 wait_for_response 竞态。"""
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        matches = [
            item for item in tracker["responses"]
            if item["path"] == path and item["method"] == method and item["status"] == status
        ]
        if matches:
            return matches[-1]
        page.wait_for_timeout(100)
    observed = [item for item in tracker["responses"] if item["path"] == path]
    raise AssertionError(f"未观测到 {method} {path} -> {status}：{observed}")


def compact_violation(violation: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": violation.get("id"),
        "impact": violation.get("impact"),
        "help": violation.get("help"),
        "tags": [tag for tag in violation.get("tags", []) if tag.startswith("wcag")],
        "nodeCount": len(violation.get("nodes", [])),
        "nodes": [
            {
                "target": node.get("target"),
                "html": node.get("html", "")[:500],
                "failureSummary": node.get("failureSummary"),
            }
            for node in violation.get("nodes", [])
        ],
    }


def run_axe(page: Page, state: str) -> dict[str, Any]:
    page.wait_for_timeout(350)
    result = page.evaluate(
        """async tags => {
          if (typeof axe === 'undefined') throw new Error('axe-core 未注入')
          return axe.run(document, {
            runOnly: {type: 'tag', values: tags},
            resultTypes: ['violations', 'incomplete', 'passes'],
          })
        }""",
        WCAG_TAGS,
    )
    return {
        "state": state,
        "engine": result.get("testEngine", {}),
        "standardTags": WCAG_TAGS,
        "violations": [compact_violation(item) for item in result.get("violations", [])],
        "incomplete": [compact_violation(item) for item in result.get("incomplete", [])],
        "passRuleCount": len(result.get("passes", [])),
    }


def tab_state(page: Page) -> dict[str, Any]:
    return page.evaluate("""() => {
      const tabs = [...document.querySelectorAll('[role="tablist"][aria-label="首页工作视图"] [role="tab"]')]
      const selected = tabs.filter(tab => tab.getAttribute('aria-selected') === 'true')
      const panel = document.getElementById('home-panel')
      return {
        labels: tabs.map(tab => tab.textContent.trim()),
        selected: selected.map(tab => tab.textContent.trim()),
        focused: tabs.includes(document.activeElement) ? document.activeElement.textContent.trim() : '',
        tabIndexes: Object.fromEntries(tabs.map(tab => [tab.textContent.trim(), tab.tabIndex])),
        controls: Object.fromEntries(tabs.map(tab => [tab.id, tab.getAttribute('aria-controls')])),
        panelRole: panel?.getAttribute('role') || null,
        panelLabelledBy: panel?.getAttribute('aria-labelledby') || null,
        mode: new URLSearchParams(location.search).get('mode') || 'review',
      }
    }""")


def wait_selected_tab(page: Page, label: str) -> None:
    page.wait_for_function(
        """label => {
          const tabs = [...document.querySelectorAll('[role="tablist"][aria-label="首页工作视图"] [role="tab"]')]
          const tab = tabs.find(item => item.textContent.trim() === label)
          return tab?.getAttribute('aria-selected') === 'true' && document.activeElement === tab
        }""",
        arg=label,
        timeout=5_000,
    )


def keyboard_tab_evidence(page: Page) -> list[dict[str, Any]]:
    today = page.get_by_role("tab", name="今日审核", exact=True)
    ops = page.get_by_role("tab", name="运行与安全", exact=True)
    assert today.count() == 1 and ops.count() == 1, "管理员视图应显示两个工作 tab"

    sequence: list[dict[str, Any]] = []
    today.focus()
    wait_selected_tab(page, "今日审核")
    sequence.append({"action": "focus", **tab_state(page)})

    today.press("ArrowRight")
    wait_selected_tab(page, "运行与安全")
    sequence.append({"action": "ArrowRight", **tab_state(page)})

    ops.press("Home")
    wait_selected_tab(page, "今日审核")
    sequence.append({"action": "Home", **tab_state(page)})

    today.press("End")
    wait_selected_tab(page, "运行与安全")
    sequence.append({"action": "End", **tab_state(page)})

    ops.press("ArrowLeft")
    wait_selected_tab(page, "今日审核")
    sequence.append({"action": "ArrowLeft", **tab_state(page)})

    expected = ["今日审核", "运行与安全", "今日审核", "运行与安全", "今日审核"]
    assert [item["selected"][0] for item in sequence] == expected, sequence
    assert all(item["selected"] == [item["focused"]] for item in sequence), sequence
    assert all(item["panelRole"] == "tabpanel" for item in sequence), sequence
    assert all(item["controls"] == {"home-tab-review": "home-panel", "home-tab-ops": "home-panel"} for item in sequence), sequence
    for item in sequence:
        selected_id = "home-tab-ops" if item["selected"] == ["运行与安全"] else "home-tab-review"
        unselected_label = "今日审核" if item["selected"] == ["运行与安全"] else "运行与安全"
        assert item["panelLabelledBy"] == selected_id, item
        assert item["tabIndexes"][item["selected"][0]] == 0, item
        assert item["tabIndexes"][unselected_label] == -1, item
    return sequence


def expected_freshness(page: Page, dashboard: dict[str, Any]) -> dict[str, Any]:
    """基于页面实际收到的 dashboard 响应重算，不单独信任 DOM 文案。"""
    return page.evaluate(r"""data => {
      const parseBusinessTimestamp = value => {
        const text = String(value || '').trim()
        if (!text) return null
        const localMatch = text.match(/^(\d{4})[./年-](\d{1,2})[./月-](\d{1,2})(?:日)?(?:[ T]+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?$/)
        if (localMatch) {
          const [, y, m, d, h = '0', minute = '0', second = '0'] = localMatch
          const values = [y, m, d, h, minute, second].map(Number)
          const [year, month, day, hour, minutes, seconds] = values
          const localDate = new Date(year, month - 1, day, hour, minutes, seconds)
          const exact = localDate.getFullYear() === year
            && localDate.getMonth() === month - 1
            && localDate.getDate() === day
            && localDate.getHours() === hour
            && localDate.getMinutes() === minutes
            && localDate.getSeconds() === seconds
          return exact ? localDate.getTime() : null
        }
        const timestamp = Date.parse(text)
        return Number.isFinite(timestamp) ? timestamp : null
      }
      const proposals = Array.isArray(data?.proposals) ? data.proposals : []
      const executions = Array.isArray(data?.executionLogs) ? data.executionLogs : []
      const candidates = [
        ...proposals.map(item => ({source: '方案', value: item.updatedAt || item.createdAt})),
        {source: 'AI', value: data?.aiTraceStats?.latestAt},
        ...executions.map(item => ({source: '执行动作', value: item.at})),
      ]
        .map(item => ({...item, timestamp: parseBusinessTimestamp(item.value)}))
        .filter(item => item.timestamp !== null)
        .sort((a, b) => b.timestamp - a.timestamp)

      if (!candidates.length) {
        return {
          expectedText: '暂无记录',
          expectedState: 'stale',
          proposalCount: proposals.length,
          executionLogCount: executions.length,
          latest: null,
        }
      }
      const latest = candidates[0]
      const stale = Date.now() - latest.timestamp > 24 * 60 * 60 * 1000
      const formatted = new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(latest.timestamp).replaceAll('/', '-')
      return {
        expectedText: `最近业务记录 ${formatted} · ${stale ? '已超过24小时' : '24小时内'} · ${latest.source}`,
        expectedState: stale ? 'stale' : 'fresh',
        proposalCount: proposals.length,
        executionLogCount: executions.length,
        latest: {source: latest.source, iso: new Date(latest.timestamp).toISOString()},
      }
    }""", dashboard)


def freshness_evidence(page: Page, tracker: dict[str, Any]) -> dict[str, Any]:
    responses: list[Response] = tracker["dashboardResponses"]
    assert responses, "页面未收到 /review-api/dashboard 响应"
    response = responses[-1]
    response.finished()
    dashboard = response.json()
    assert isinstance(dashboard, dict), "dashboard 响应必须是 JSON object"
    expected = expected_freshness(page, dashboard)

    locator = page.locator("[data-review-data-freshness]")
    assert locator.count() == 1 and locator.is_visible(), "真实数据新鲜度必须可见且唯一"
    actual = {
        "text": locator.inner_text().strip(),
        "state": locator.get_attribute("data-review-data-freshness"),
        "role": locator.get_attribute("role"),
        "ariaLive": locator.get_attribute("aria-live"),
        "ariaAtomic": locator.get_attribute("aria-atomic"),
    }
    assert actual["text"] == expected["expectedText"], {"actual": actual, "expected": expected}
    assert actual["state"] == expected["expectedState"], {"actual": actual, "expected": expected}
    assert actual["role"] == "status" and actual["ariaLive"] == "polite" and actual["ariaAtomic"] == "true", actual
    return {"actual": actual, "sourceEvidence": expected}


def mobile_table_evidence(page: Page) -> dict[str, Any]:
    region = page.locator(
        '.review-table-scroll[role="region"][tabindex="0"]'
        '[aria-label="方案审核队列表格，可横向滚动"]'
    )
    assert region.count() == 1 and region.is_visible(), "320px 审核队列滚动区必须可见且可聚焦"
    region.focus()
    probe = region.evaluate("""element => {
      const descriptionId = element.getAttribute('aria-describedby')
      const description = descriptionId ? document.getElementById(descriptionId) : null
      const maxScroll = Math.max(0, element.scrollWidth - element.clientWidth)
      element.scrollLeft = Math.min(120, maxScroll)
      return {
        focused: document.activeElement === element,
        role: element.getAttribute('role'),
        label: element.getAttribute('aria-label'),
        tabIndex: element.tabIndex,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        maxScroll,
        scrollLeft: element.scrollLeft,
        overflowX: getComputedStyle(element).overflowX,
        descriptionId,
        descriptionText: description?.textContent?.trim() || '',
      }
    }""")
    assert probe["focused"], probe
    assert probe["scrollWidth"] > probe["clientWidth"] and probe["maxScroll"] > 0, probe
    assert probe["scrollLeft"] > 0 and probe["overflowX"] in {"auto", "scroll"}, probe
    assert probe["descriptionId"] == "review-table-scroll-help" and "横向滚动" in probe["descriptionText"], probe
    return probe


def screenshot(page: Page, viewport_name: str, state: str) -> str:
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    target = SCREENSHOT_DIR / f"{viewport_name}-{state}.png"
    page.screenshot(path=str(target), full_page=False)
    try:
        return str(target.relative_to(ROOT))
    except ValueError:
        return str(target)


def relevant_failed_requests(tracker: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item for item in tracker["failedRequests"]
        if "ERR_ABORTED" not in item["error"] and "NS_BINDING_ABORTED" not in item["error"]
    ]


def unsafe_requests(
    tracker: dict[str, Any],
    allowlist: set[tuple[str, str]] | None = None,
) -> list[dict[str, Any]]:
    allowed = allowlist or set()
    return [
        item for item in tracker["requests"]
        if item["method"] not in SAFE_MATRIX_METHODS
        and (item["method"], item["path"]) not in allowed
    ]


def review_document_path(route: str) -> str:
    return "/review-system/" if route == "/" else f"/review-system{route}"


def normalized_text(value: str) -> str:
    return " ".join(str(value or "").split())


def first_real_proposal(
    tracker: dict[str, Any],
    route_result: dict[str, Any],
) -> str | None:
    """从审核列表页本次实际 GET 响应取首个 ID，不构造测试方案。"""
    responses: list[Response] = tracker["proposalListResponses"]
    assert responses, "审核中心未观测到 GET /review-api/proposals"
    response = responses[-1]
    response.finished()
    payload = response.json()
    assert isinstance(payload, dict) and isinstance(payload.get("items"), list), "方案列表响应结构异常"
    items = payload["items"]
    proposal_id = next((str(item.get("id")) for item in items if item.get("id") not in {None, ""}), None)
    route_result["proposalList"] = {
        "responseObserved": True,
        "itemCount": len(items),
        "detailCandidateAvailable": proposal_id is not None,
        "candidateIdPersistedToReport": False,
    }
    return proposal_id


def scan_read_only_route(
    context: BrowserContext,
    route_spec: dict[str, Any],
    route_result: dict[str, Any],
    proposal_holder: dict[str, str],
) -> None:
    report_route = route_spec["route"]
    actual_route = route_spec.get("actualRoute", report_route)
    expected_document_path = review_document_path(actual_route)
    page = context.new_page()
    tracker = install_runtime_observers(page)
    install_read_only_guard(page, tracker)
    try:
        response = page.goto(f"{BASE}{expected_document_path}", wait_until="domcontentloaded", timeout=30_000)
        route_result.update({
            "route": report_route,
            "readOnly": True,
            "status": response.status if response else None,
            "documentPath": redact_business_path(expected_document_path),
        })
        assert response and response.status == 200, route_result

        heading = page.locator("#main-content h1:visible")
        heading.first.wait_for(state="visible", timeout=20_000)
        page.wait_for_load_state("networkidle", timeout=20_000)
        page.wait_for_timeout(250)

        actual_path = urllib.parse.urlsplit(page.url).path
        headings = [normalized_text(text) for text in heading.all_inner_texts()]
        reported_headings = ["已读取真实方案标题"] if report_route == "/review/:id" else headings
        overflow = page.evaluate("Math.max(0, document.documentElement.scrollWidth - innerWidth)")
        axe = run_axe(page, report_route)
        failed_requests = relevant_failed_requests(tracker)
        unsafe = unsafe_requests(tracker)
        api_responses = [item for item in tracker["responses"] if item["path"].startswith("/review-api/")]
        server_errors = [item for item in tracker["errorResponses"] if item["status"] >= 500]

        route_result.update({
            "finalDocumentPath": redact_business_path(actual_path),
            "title": page.title(),
            "mainCount": page.locator("main.aph-main").count(),
            "visibleH1": reported_headings,
            "overflow": overflow,
            "network": {
                "apiResponses": api_responses,
                "serverErrors": server_errors,
                "httpErrors": tracker["errorResponses"],
                "failedRequests": failed_requests,
                "unsafeRequests": unsafe,
                "blockedUnsafeRequests": tracker["blockedUnsafeRequests"],
            },
            "consoleErrors": tracker["consoleErrors"],
            "pageErrors": tracker["pageErrors"],
            "axe": axe,
            "axeViolationSummary": [
                {"id": item["id"], "nodeCount": item["nodeCount"]}
                for item in axe["violations"]
            ],
        })

        if report_route == "/review":
            proposal_id = first_real_proposal(tracker, route_result)
            if proposal_id:
                proposal_holder["id"] = proposal_id
        if report_route == "/review/:id":
            detail_responses = [
                item for item in api_responses
                if item["path"] == "/review-api/proposals/:id"
                and item["method"] == "GET"
                and item["status"] == 200
            ]
            route_result["realDetailResponse"] = {
                "observed": bool(detail_responses),
                "path": "/review-api/proposals/:id",
                "status": 200 if detail_responses else None,
            }
            assert detail_responses, "未观测到真实方案详情 GET 200"

        assert actual_path == expected_document_path, {
            "expected": redact_business_path(expected_document_path),
            "actual": redact_business_path(actual_path),
        }
        assert route_result["mainCount"] == 1, route_result["mainCount"]
        assert len(headings) == 1, {"visibleH1Count": len(headings)}
        expected_heading = route_spec.get("heading")
        if expected_heading:
            assert headings == [expected_heading], {"expected": expected_heading, "actual": headings}
        assert page.locator("#access-denied-title").count() == 0, f"{report_route} 被错误降级为无权限"
        assert "页面资源需要刷新" not in page.locator("body").inner_text(), f"{report_route} 命中资源错误边界"
        assert overflow <= 1, {"route": report_route, "overflow": overflow}
        assert not server_errors, server_errors
        assert not tracker["consoleErrors"], tracker["consoleErrors"]
        assert not tracker["pageErrors"], tracker["pageErrors"]
        assert not failed_requests, failed_requests
        assert not unsafe, f"{report_route} 只读路由出现非安全 HTTP 方法：{unsafe}"
        assert not tracker["blockedUnsafeRequests"], tracker["blockedUnsafeRequests"]
        assert not axe["violations"], route_result["axeViolationSummary"]
        route_result["passed"] = True
    finally:
        page.close()


def run_read_only_route_matrix(context: BrowserContext) -> dict[str, Any]:
    matrix: dict[str, Any] = {}
    proposal_holder: dict[str, str] = {}
    for route_spec in ROUTE_MATRIX:
        route_result: dict[str, Any] = {}
        try:
            scan_read_only_route(context, route_spec, route_result, proposal_holder)
        except Exception as error:
            route_result["passed"] = False
            route_result["runtimeError"] = scrub_secret(error)
            route_result["traceback"] = scrub_secret(traceback.format_exc())
        matrix[route_spec["route"]] = route_result

    if proposal_holder.get("id"):
        encoded_id = urllib.parse.quote(proposal_holder["id"], safe="")
        detail_result: dict[str, Any] = {
            "source": "实际 GET /review-api/proposals 列表的首个可用方案",
            "candidateIdPersistedToReport": False,
        }
        try:
            scan_read_only_route(
                context,
                {"route": "/review/:id", "actualRoute": f"/review/{encoded_id}"},
                detail_result,
                proposal_holder,
            )
        except Exception as error:
            detail_result["passed"] = False
            detail_result["runtimeError"] = scrub_secret(error)
            detail_result["traceback"] = scrub_secret(traceback.format_exc())
        matrix["/review/:id"] = detail_result
    else:
        matrix["/review/:id"] = {
            "route": "/review/:id",
            "readOnly": True,
            "skipped": True,
            "passed": True,
            "reason": "真实审核列表暂无可用方案，未伪造详情 ID",
        }
    return matrix


def exercise_viewport(
    context: BrowserContext,
    viewport_name: str,
    viewport: dict[str, int],
    result: dict[str, Any],
) -> None:
    page = context.new_page()
    tracker = install_runtime_observers(page)
    install_read_only_guard(page, tracker, SSO_WRITE_ALLOWLIST)

    launcher_response = page.goto(f"{BASE}/review", wait_until="commit", timeout=30_000)
    result["launcher"] = {
        "requestedPath": "/review",
        "status": launcher_response.status if launcher_response else None,
        "responsePath": url_evidence(launcher_response.url)["path"] if launcher_response else None,
    }
    assert launcher_response and launcher_response.status == 200, result["launcher"]
    assert result["launcher"]["responsePath"] == "/review", result["launcher"]

    await_response(page, tracker, "/api/integrations/review/sso", "POST")
    await_response(page, tracker, "/review-system/", "GET")
    await_response(page, tracker, "/review-api/auth/cockpit-sso", "POST")
    await_response(page, tracker, "/review-api/auth/session", "GET")
    await_response(page, tracker, "/review-api/dashboard", "GET")

    page.wait_for_function(
        """() => location.pathname === '/review-system/'
          && !new URLSearchParams(location.search).has('sso')
          && document.querySelector('h1')?.textContent?.includes('让每一次方案审核')""",
        timeout=30_000,
    )
    page.get_by_role("heading", name="让每一次方案审核，都有标准、有依据、有结论", exact=True).wait_for(
        state="visible", timeout=10_000
    )
    page.wait_for_timeout(500)

    session = page.evaluate("""() => ({
      path: location.pathname,
      queryKeys: [...new URLSearchParams(location.search).keys()].sort(),
      hasSso: new URLSearchParams(location.search).has('sso'),
      hasReviewToken: Boolean(localStorage.getItem('token')),
      reviewTokenIsScoped: Boolean(localStorage.getItem('token'))
        && localStorage.getItem('token') !== localStorage.getItem('cockpit_token'),
      hasReviewUser: Boolean(localStorage.getItem('user')),
    })""")
    result["sso"] = {
        "final": session,
        "ssoNavigationObserved": any(item["path"] == "/review-system/" and item["hasSso"] for item in tracker["navigations"]),
        "cleanNavigationObserved": any(item["path"] == "/review-system/" and not item["hasSso"] for item in tracker["navigations"]),
        "navigationChain": tracker["navigations"],
        "requiredResponses": [
            item for item in tracker["responses"]
            if item["path"] in {
                "/review", "/api/integrations/review/sso", "/review-system/",
                "/review-api/auth/cockpit-sso", "/review-api/auth/session", "/review-api/dashboard",
            }
        ],
    }
    assert session == {
        "path": "/review-system/",
        "queryKeys": [],
        "hasSso": False,
        "hasReviewToken": True,
        "reviewTokenIsScoped": True,
        "hasReviewUser": True,
    }, session
    assert result["sso"]["ssoNavigationObserved"] and result["sso"]["cleanNavigationObserved"], result["sso"]

    result["freshness"] = freshness_evidence(page, tracker)
    initial_state = tab_state(page)
    result["initialTabs"] = initial_state
    assert initial_state["labels"] == ["今日审核", "运行与安全"], initial_state
    assert initial_state["selected"] == ["今日审核"] and initial_state["mode"] == "review", initial_state

    overflow_today = page.evaluate("Math.max(0, document.documentElement.scrollWidth - innerWidth)")
    result["layout"] = {"viewport": viewport, "todayOverflow": overflow_today}
    assert overflow_today <= 1, result["layout"]
    result["screenshots"] = {"today": screenshot(page, viewport_name, "today")}
    result["axe"] = {"today": run_axe(page, "today")}

    result["keyboardTabs"] = keyboard_tab_evidence(page)
    if viewport_name == "mobile320":
        result["mobileTable"] = mobile_table_evidence(page)

    # 用已验证的 End 键进入运行与安全，对第二个 panel 状态单独扫描。
    page.get_by_role("tab", name="今日审核", exact=True).press("End")
    wait_selected_tab(page, "运行与安全")
    ops_state = tab_state(page)
    result["opsTabs"] = ops_state
    assert ops_state["selected"] == ["运行与安全"] and ops_state["mode"] == "ops", ops_state
    overflow_ops = page.evaluate("Math.max(0, document.documentElement.scrollWidth - innerWidth)")
    result["layout"]["opsOverflow"] = overflow_ops
    assert overflow_ops <= 1, result["layout"]
    result["screenshots"]["ops"] = screenshot(page, viewport_name, "ops")
    result["axe"]["ops"] = run_axe(page, "ops")

    # 收尾回到今日审核，避免 QA 会话留在次级状态。
    page.get_by_role("tab", name="运行与安全", exact=True).press("Home")
    wait_selected_tab(page, "今日审核")

    relevant_failed = [
        item for item in tracker["failedRequests"]
        if "ERR_ABORTED" not in item["error"] and "NS_BINDING_ABORTED" not in item["error"]
    ]
    result["runtime"] = {
        "consoleErrors": tracker["consoleErrors"],
        "pageErrors": tracker["pageErrors"],
        "failedRequests": relevant_failed,
        "ignoredNavigationAborts": len(tracker["failedRequests"]) - len(relevant_failed),
        "errorResponses": tracker["errorResponses"],
        "unsafeRequests": unsafe_requests(tracker, SSO_WRITE_ALLOWLIST),
        "blockedUnsafeRequests": tracker["blockedUnsafeRequests"],
    }
    axe_violations = [
        {"state": state, "id": violation["id"], "nodeCount": violation["nodeCount"]}
        for state, scan in result["axe"].items()
        for violation in scan["violations"]
    ]
    result["axeViolationSummary"] = axe_violations
    assert not tracker["consoleErrors"], tracker["consoleErrors"]
    assert not tracker["pageErrors"], tracker["pageErrors"]
    assert not relevant_failed, relevant_failed
    assert not tracker["errorResponses"], tracker["errorResponses"]
    assert not result["runtime"]["unsafeRequests"], result["runtime"]["unsafeRequests"]
    assert not result["runtime"]["blockedUnsafeRequests"], result["runtime"]["blockedUnsafeRequests"]
    assert not axe_violations, axe_violations

    # 启动桥与首页深测通过后，在同一审核会话内做全管理员路由只读矩阵。
    result["routeMatrix"] = run_read_only_route_matrix(context)
    matrix_failures = {
        route: item.get("runtimeError") or item.get("axeViolationSummary")
        for route, item in result["routeMatrix"].items()
        if not item.get("passed")
    }
    result["routeMatrixSummary"] = {
        "requiredRoutes": [item["route"] for item in ROUTE_MATRIX],
        "detailRoute": "/review/:id",
        "routeCount": len(result["routeMatrix"]),
        "passed": not matrix_failures,
        "failures": matrix_failures,
        "axeViolationCount": sum(
            len(item.get("axeViolationSummary", []))
            for item in result["routeMatrix"].values()
        ),
    }
    assert not matrix_failures, matrix_failures


def load_ephemeral_token() -> tuple[str, str]:
    configured = os.environ.get("QA_COCKPIT_TOKEN", "").strip()
    if configured:
        return configured, "environment"

    helper_path = ROOT / "tests/full_remediation_shadow_qa.py"
    spec = importlib.util.spec_from_file_location("r51_token_helper", helper_path)
    if not spec or not spec.loader:
        raise RuntimeError(f"无法加载临时令牌辅助：{helper_path}")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper.ephemeral_token(), "ephemeral_ssh"


def static_check() -> dict[str, Any]:
    """仅验证脚本依赖和被测合同，不启动浏览器、不访问云端。"""
    files = {
        "axe": AXE,
        "tokenHelper": ROOT / "tests/full_remediation_shadow_qa.py",
        "launcherHtml": ROOT / "firstcare-cloud-local/review-launcher.html",
        "launcherJs": ROOT / "firstcare-cloud-local/review-launcher-20260812-v1.js",
        "app": ROOT / "review-system/active/frontend/src/App.jsx",
        "permissions": ROOT / "review-system/active/frontend/src/lib/permissions.js",
        "home": ROOT / "review-system/active/frontend/src/views/HomeView.jsx",
        "nginx": ROOT / "deploy/r51-review-recovery/review-system.conf",
    }
    missing = [name for name, path in files.items() if not path.is_file()]
    if missing:
        raise AssertionError(f"缺少静态验收依赖：{missing}")

    launcher_html = files["launcherHtml"].read_text(encoding="utf-8")
    launcher_js = files["launcherJs"].read_text(encoding="utf-8")
    app = files["app"].read_text(encoding="utf-8")
    permissions = files["permissions"].read_text(encoding="utf-8")
    home = files["home"].read_text(encoding="utf-8")
    nginx = files["nginx"].read_text(encoding="utf-8")
    required_routes = ["/", "/submit", "/review", "/bots", "/users", "/knowledge", "/rules", "/stats", "/logs", "/settings"]
    configured_routes = [item["route"] for item in ROUTE_MATRIX]
    contracts = {
        "launcherAsset": "/review-launcher-20260812-v1.js" in launcher_html,
        "launcherIssuesSso": "/api/integrations/review/sso" in launcher_js,
        "launcherRestrictsTarget": "target.pathname.startsWith('/review-system/')" in launcher_js,
        "ssoQueryCleanup": "params.delete('sso')" in app and "window.location.replace(cleanPath)" in app,
        "reviewApiPrefix": "'/review-api'" in app or "'/review-api'" in (ROOT / "review-system/active/frontend/src/lib/api.js").read_text(encoding="utf-8"),
        "tabSemantics": 'role="tablist" aria-label="首页工作视图"' in home and 'role="tabpanel"' in home,
        "tabKeyboard": all(key in home for key in ["ArrowRight", "ArrowLeft", "Home", "End"]),
        "freshnessStatus": "data-review-data-freshness" in home and 'aria-live="polite"' in home,
        "mobileTableRegion": '方案审核队列表格，可横向滚动' in home and "tabIndex={0}" in home,
        "nginxPreservesSsoQuery": "return 308 /review-system/$is_args$args;" in nginx,
        "completeAdminRouteMatrix": configured_routes == required_routes,
        "matrixMatchesPermissions": all(f"path: '{route}'" in permissions for route in required_routes),
        "matrixMatchesAppRoutes": all(
            'path="/"' in app if route == "/" else f'path="{route}"' in app
            for route in required_routes
        ),
        "realProposalDetailRoute": '<Route path="/review/:id"' in app,
        "readOnlyMethodPolicy": SAFE_MATRIX_METHODS == {"GET", "HEAD", "OPTIONS"},
        "ssoOnlyWriteAllowlist": SSO_WRITE_ALLOWLIST == {
            ("POST", "/api/integrations/review/sso"),
            ("POST", "/review-api/auth/cockpit-sso"),
        },
    }
    failed = [name for name, passed in contracts.items() if not passed]
    if failed:
        raise AssertionError(f"静态合同未满足：{failed}")
    return {
        "ok": True,
        "mode": "static-only",
        "browserStarted": False,
        "networkAccessed": False,
        "axeBytes": AXE.stat().st_size,
        "viewports": VIEWPORTS,
        "wcagTags": WCAG_TAGS,
        "routeMatrix": configured_routes + ["/review/:id"],
        "routeScansPerViewport": len(configured_routes) + 1,
        "readOnlyMethods": sorted(SAFE_MATRIX_METHODS),
        "contracts": contracts,
    }


def runtime_main() -> None:
    assert AXE.is_file(), f"未找到 axe-core：{AXE}"
    parsed_base = urllib.parse.urlsplit(BASE)
    allow_shadow_http = os.environ.get("QA_ALLOW_SHADOW_HTTP") == "1"
    is_loopback_shadow = parsed_base.scheme == "http" and parsed_base.hostname in {"127.0.0.1", "localhost"}
    assert (
        parsed_base.scheme == "https" and parsed_base.netloc
    ) or (
        allow_shadow_http and is_loopback_shadow
    ), f"生产 QA 要求 HTTPS；仅显式开启时允许 loopback shadow：{BASE}"

    token, token_source = load_ephemeral_token()
    output: dict[str, Any] = {
        "release": "r51-review-production",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "base": BASE,
        "shadowMode": allow_shadow_http and is_loopback_shadow,
        "readOnly": True,
        "routeMatrix": [item["route"] for item in ROUTE_MATRIX] + ["/review/:id"],
        "matrixPolicy": "GET/HEAD/OPTIONS only; SSO POST 仅限启动桥深测",
        "tokenSource": token_source,
        "tokenPersistedToReport": False,
        "standard": "WCAG A/AA (axe-core tags through WCAG 2.2 AA)",
        "viewports": {},
    }
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=os.environ.get("QA_HEADLESS", "1") != "0")
            try:
                for viewport_name, viewport in VIEWPORTS:
                    viewport_result: dict[str, Any] = {"viewport": viewport}
                    context = browser.new_context(
                        viewport=viewport,
                        locale="zh-CN",
                        timezone_id="Asia/Shanghai",
                        reduced_motion="reduce",
                    )
                    context.add_init_script(script=(
                        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
                        "if(location.pathname==='/review'){"
                        "localStorage.removeItem('token');"
                        "localStorage.removeItem('user');"
                        "localStorage.removeItem('sessionExpiresAt');"
                        "}"
                        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R51审核验收',role:'admin'}));"
                    ))
                    context.add_init_script(path=str(AXE))
                    try:
                        exercise_viewport(context, viewport_name, viewport, viewport_result)
                    except Exception as error:  # 必须落报告后再返回非零，避免丢失定位证据。
                        viewport_result["runtimeError"] = scrub_secret(error)
                        viewport_result["traceback"] = scrub_secret(traceback.format_exc())
                    finally:
                        context.close()
                    output["viewports"][viewport_name] = viewport_result
            finally:
                browser.close()
    finally:
        token = ""

    failures = {
        name: result.get("runtimeError")
        for name, result in output["viewports"].items()
        if result.get("runtimeError")
    }
    output["summary"] = {
        "passed": not failures,
        "viewportCount": len(output["viewports"]),
        "requiredRouteCountPerViewport": len(ROUTE_MATRIX),
        "detailRouteAttemptedWhenRealItemExists": True,
        "failedViewports": failures,
        "axeViolationCount": sum(
            len(result.get("axeViolationSummary", []))
            + result.get("routeMatrixSummary", {}).get("axeViolationCount", 0)
            for result in output["viewports"].values()
        ),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(OUT), **output["summary"]}, ensure_ascii=False))
    if failures:
        raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--static-check",
        action="store_true",
        help="仅验证依赖和源码合同，不启动浏览器、不访问云端",
    )
    args = parser.parse_args()
    if args.static_check:
        print(json.dumps(static_check(), ensure_ascii=False, indent=2))
        return
    runtime_main()


if __name__ == "__main__":
    main()
