#!/usr/bin/env python3
"""R55 云端驾驶舱生产验收；所有动态页面均等待 networkidle。"""

from __future__ import annotations

import importlib.util
import json
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = "https://www.firstcare.cloud"
OUT = ROOT / "docs/qa/frontend-skill-cloud-20260812/r55-production/r55-production-results.json"
ROUTES = [
    "/", "/command", "/projects", "/payment", "/daily", "/collection", "/arrears",
    "/ai-alerts", "/ai-report", "/import", "/review", "/system", "/tasks", "/admin",
]
AI_ENDPOINTS = [
    ("GET", "/api/ai/brief"),
    ("GET", "/api/ai/week-focus"),
    ("GET", "/api/alerts"),
    ("GET", "/api/ai/health"),
    ("GET", "/api/ai/trends"),
    ("GET", "/api/ai/risk-trends"),
    ("POST", "/api/ai/interpret"),
    ("GET", "/api/ai/monthly-report?area=华北"),
]

spec = importlib.util.spec_from_file_location("qa", ROOT / "tests/full_remediation_shadow_qa.py")
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


def init_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R55生产验收',role:'admin'}));"
    )


def rendered_rows(page) -> int:
    return page.locator("table tbody tr").evaluate_all(
        "rows => rows.filter(row => getComputedStyle(row).display !== 'none' && row.getClientRects().length > 0).length"
    )


def assert_box(locator, label: str) -> dict:
    box = locator.bounding_box()
    assert box and box["width"] >= 44 and box["height"] >= 44, (label, box)
    return {key: round(value, 2) for key, value in box.items()}


def runtime_page(context, route: str, viewport_name: str) -> tuple[dict, object]:
    page = context.new_page()
    console_errors, page_errors, failed_requests, error_responses = [], [], [], []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on("requestfailed", lambda request: failed_requests.append({"url": request.url, "error": request.failure}))
    page.on("response", lambda response: error_responses.append({"url": response.url, "status": response.status}) if response.status >= 400 else None)

    response = page.goto(BASE + route, wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_load_state("networkidle", timeout=30_000)
    page.wait_for_timeout(800)
    expected_path = "/command" if route == "/tasks" else "/admin" if route == "/system" else route
    actual_path = urllib.parse.urlsplit(page.url).path.rstrip("/") or "/"
    expected_path = expected_path.rstrip("/") or "/"
    assert response and response.status == 200, (route, response.status if response else None)
    assert actual_path == expected_path, (route, page.url)
    assert page.locator("body").get_attribute("data-r45-release") == "r45-cloud-remediation-20260812-v1"

    main_count = page.locator("main").count()
    assert main_count == 1, (route, main_count)
    visible_h1 = page.locator("main h1:visible").count()
    if route == "/arrears":
        frame = page.locator("#aph-arrears-frame")
        frame.wait_for(state="visible", timeout=15_000)
        assert frame.content_frame.locator("h1").first.inner_text() == "欠费经营分析"
        assert page.title() == "欠费经营分析 · 第一服务华北地区"
    else:
        assert visible_h1 == 1, (route, visible_h1)

    overflow = page.evaluate("Math.max(0, document.documentElement.scrollWidth - innerWidth)")
    assert overflow <= 1, (route, viewport_name, overflow)
    relevant_failed = [item for item in failed_requests if "ERR_ABORTED" not in str(item.get("error"))]
    assert not console_errors, (route, console_errors)
    assert not page_errors, (route, page_errors)
    assert not relevant_failed, (route, failed_requests)
    assert not error_responses, (route, error_responses)

    result = {
        "status": response.status,
        "url": page.url,
        "title": page.title(),
        "main": main_count,
        "visibleH1": visible_h1,
        "overflow": overflow,
        "consoleErrors": console_errors,
        "pageErrors": page_errors,
        "failedRequests": failed_requests,
        "errorResponses": error_responses,
    }
    return result, page


def test_mobile_controls(page, route: str, result: dict) -> None:
    if route not in {"/admin", "/system"}:
        result["account"] = assert_box(page.locator('button[aria-label="账号菜单"]'), f"{route} 账号菜单")

    if route == "/projects":
        for selector in [
            '[data-project-filter="area"]', '[data-project-filter="property"]', '[data-project-filter="q"]',
            'button.r6-sort-button', 'a:has-text("查看未关联映射")',
        ]:
            result.setdefault("touch", {})[selector] = assert_box(page.locator(selector).first, f"{route} {selector}")
    if route == "/payment":
        result.setdefault("touch", {})["sort"] = assert_box(page.locator("button.r6-sort-button").first, "回款排序")
        result["touch"]["area"] = assert_box(page.locator("main select").first, "回款片区筛选")
    if route in {"/daily", "/collection", "/ai-alerts", "/ai-report"}:
        result.setdefault("touch", {})["area"] = assert_box(page.locator("main select").first, f"{route} 片区筛选")
    if route == "/import":
        result.setdefault("touch", {})["refresh"] = assert_box(page.get_by_role("button", name="刷新", exact=True), "导入刷新")
    if route == "/review":
        # 审核工作台会在隐藏的次级面板中保留同名操作，只验收当前可操作的按钮。
        buttons = page.locator('button[aria-label^="查看方案："]:visible')
        assert buttons.count() == 3, buttons.count()
        for index in range(buttons.count()):
            result.setdefault("touch", {})[f"plan{index + 1}"] = assert_box(buttons.nth(index), "查看方案")
    if route == "/":
        map_targets = page.locator('svg [role="button"][aria-label]')
        for index in range(map_targets.count()):
            assert_box(map_targets.nth(index), f"首页地图目标 {index + 1}")
        launcher = page.locator(".north-ai-launcher")
        if launcher.is_visible():
            launcher.click()
            page.wait_for_timeout(150)
            result.setdefault("touch", {})["aiClose"] = assert_box(page.locator(".north-ai-close"), "AI 关闭")
            page.locator(".north-ai-close").click()


def test_import(page, result: dict) -> None:
    assert page.title() == "数据导入 · 第一服务华北地区"
    assert page.locator("main h1").all_inner_texts() == ["数据导入"]
    batches = page.locator(".aph-r42-import-batch")
    total = batches.count()
    assert total >= 4
    rendered = batches.evaluate_all("rows => rows.filter(row => getComputedStyle(row).display !== 'none' && row.getClientRects().length > 0).length")
    assert rendered == 3, (total, rendered)
    fourth = batches.nth(3).evaluate("row => ({hidden:row.hidden,display:getComputedStyle(row).display,rects:row.getClientRects().length})")
    assert fourth == {"hidden": True, "display": "none", "rects": 0}, fourth
    toggle = page.locator(".aph-r42-import-toggle")
    toggle.click()
    page.wait_for_timeout(150)
    expanded = batches.evaluate_all("rows => rows.filter(row => getComputedStyle(row).display !== 'none' && row.getClientRects().length > 0).length")
    assert expanded == total
    result["importDisclosure"] = {"total": total, "defaultRendered": 3, "expandedRendered": expanded, "fourth": fourth}


def test_admin(page, result: dict) -> None:
    main = page.locator('main[aria-labelledby="aph-admin-title"]')
    assert main.count() == 1
    assert main.locator("#aph-admin-title").inner_text() == "后台数据管理"
    tabs = page.locator('[role="tablist"][aria-label="后台业务域"] > button[role="tab"]')
    assert tabs.count() == 8
    page.wait_for_function(
        "document.querySelectorAll('[role=\"tablist\"][aria-label=\"后台业务域\"] > button[role=\"tab\"][aria-selected=\"true\"]').length === 1",
        timeout=5_000,
    )
    selected_tabs = page.locator(
        '[role="tablist"][aria-label="后台业务域"] > button[role="tab"][aria-selected="true"]'
    )
    assert selected_tabs.count() == 1
    for index in range(tabs.count()):
        assert_box(tabs.nth(index), f"后台业务域 {index + 1}")
    rows = main.locator("table").first.locator("tbody tr")
    assert rows.count() == 56
    assert rendered_rows(page) == 10
    row11 = rows.nth(10).evaluate("row => ({hidden:row.hidden,display:getComputedStyle(row).display,rects:row.getClientRects().length})")
    assert row11 == {"hidden": True, "display": "none", "rects": 0}, row11
    toggle = page.locator(".aph-r46-table-toggle").first
    assert toggle.get_attribute("aria-expanded") == "false"
    assert_box(toggle, "后台长表展开")
    toggle.click()
    page.wait_for_timeout(180)
    assert rendered_rows(page) == 56
    assert rows.nth(10).get_attribute("hidden") is None
    last_labels = rows.locator("td:last-child").evaluate_all("cells => [...new Set(cells.map(cell => cell.dataset.r34Label || cell.getAttribute('data-r34-label')))]")
    assert last_labels == ["操作"], last_labels
    result["adminDisclosure"] = {"tabs": 8, "rows": 56, "defaultRendered": 10, "expandedRendered": 56, "row11": row11, "lastLabels": last_labels}


def main() -> None:
    token = qa.ephemeral_token()
    output = {"release": "r55-ai-touch-20260812-225803", "routes": {}, "api": {}}
    try:
        with sync_playwright() as playwright:
            for viewport_name, viewport in [("desktop", {"width": 1440, "height": 1000}), ("mobile", {"width": 390, "height": 844})]:
                output["routes"][viewport_name] = {}
                # 两个视口分别启动 Chromium，避免长时间连续创建 context 导致验收进程资源耗尽。
                browser = playwright.chromium.launch(headless=True)
                try:
                    for route in ROUTES:
                        context = browser.new_context(viewport=viewport)
                        context.add_init_script(script=init_script(token))
                        try:
                            result, page = runtime_page(context, route, viewport_name)
                            if viewport_name == "mobile":
                                test_mobile_controls(page, route, result)
                                if route == "/import":
                                    test_import(page, result)
                                if route == "/admin":
                                    test_admin(page, result)
                            output["routes"][viewport_name][route] = result
                        finally:
                            context.close()
                finally:
                    browser.close()

            api = playwright.request.new_context(extra_http_headers={"Authorization": f"Bearer {token}"})
            for path in ["/api/health", "/api/health/live", "/api/health/ready"]:
                response = api.get(BASE + path)
                assert response.status == 200, (path, response.status)
                output["api"][path] = response.status
            gate = api.get(BASE + "/api/data-quality/project-gate")
            gate_json = gate.json()
            assert gate.status == 200 and gate_json.get("code") == "PROJECT_DATA_QUALITY_BLOCKED"
            output["api"]["projectGate"] = {"status": gate.status, "code": gate_json.get("code"), "ready": gate_json.get("ready")}
            for method, path in AI_ENDPOINTS:
                response = api.post(BASE + path, data={"question": "生产验收"}) if method == "POST" else api.get(BASE + path)
                payload = response.json()
                assert response.status == 409 and payload.get("code") == "PROJECT_DATA_QUALITY_BLOCKED", (path, response.status, payload)
                output["api"][path] = {"status": response.status, "code": payload.get("code")}
            api.dispose()
    finally:
        token = ""

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = {
        "desktopRoutes": len(output["routes"]["desktop"]),
        "mobileRoutes": len(output["routes"]["mobile"]),
        "runtimeErrors": sum(
            len(data["consoleErrors"]) + len(data["pageErrors"]) + len(data["errorResponses"])
            for routes in output["routes"].values() for data in routes.values()
        ),
        "projectGate": output["api"]["projectGate"],
        "directAiBlocked": len(AI_ENDPOINTS),
    }
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
