#!/usr/bin/env python3
"""R90候选真实浏览器回归：来源依据、项目范围和保护路由。"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("R90_QA_BASE", "http://127.0.0.1:4198").rstrip("/")
OUT = ROOT / os.environ.get(
    "R90_QA_OUT",
    "docs/qa/frontend-skill-cloud-20260816/r90-operating-capabilities-shadow",
)
ACTIVE_ROUTES = ["/", "/command", "/projects", "/ai-report", "/ai-alerts"]
PROTECTED_ROUTES = ["/daily", "/payment", "/collection"]


def wait_loaded(page):
    try:
        page.wait_for_load_state("networkidle", timeout=10000)
    except PlaywrightTimeoutError:
        # 主应用存在持续请求时，以React根节点完成渲染作为业务就绪条件。
        page.locator("#root > *").first.wait_for(state="visible", timeout=10000)
    page.wait_for_timeout(500)


def navigate(page, route, initial=False):
    if initial:
        page.goto(f"{BASE}{route}", wait_until="commit", timeout=30000)
    else:
        link = page.locator(f'a[href="{route}"]').first
        if link.count():
            link.click()
        else:
            page.evaluate(
                "route => { history.pushState({}, '', route); dispatchEvent(new PopStateEvent('popstate')); dispatchEvent(new Event('cockpit:navigation')); }",
                route,
            )
        page.wait_for_url(f"{BASE}{route}", timeout=15000)
    wait_loaded(page)


def panel_state(page, console_errors=None, request_failures=None, response_errors=None):
    panel = page.locator("#aph-r90-operating-capabilities")
    try:
        panel.wait_for(state="visible", timeout=10000)
    except PlaywrightTimeoutError as error:
        diagnostics = page.evaluate("""() => ({
          url: location.href,
          bodyText: (document.body?.innerText || '').slice(0, 1000),
          rootHtml: (document.querySelector('#root')?.innerHTML || '').slice(0, 1000),
          operatingStatus: document.documentElement.dataset.r90OperatingStatus || null,
          capabilityLoaded: Boolean(window.__cockpitOperatingCapabilities),
          resources: performance.getEntriesByType('resource')
            .map(item => item.name).filter(name => name.includes('r90') || name.includes('operating-capabilities'))
        })""")
        diagnostics["consoleErrors"] = console_errors or []
        diagnostics["requestFailures"] = request_failures or []
        diagnostics["responseErrors"] = response_errors or []
        raise AssertionError(f"R90面板未挂载：{json.dumps(diagnostics, ensure_ascii=False)}") from error
    panel.locator("summary").click()
    text = panel.inner_text()
    box = panel.bounding_box()
    return {
        "text": text,
        "status": panel.get_attribute("data-status"),
        "box": box,
        "documentOverflow": page.evaluate("document.documentElement.scrollWidth > innerWidth + 1"),
    }


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = {"release": "cockpit-r90-operating-capabilities-20260816-204727", "active": [], "protected": []}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        password = os.environ.get("R90_ADMIN_PASSWORD", "").strip()
        token = os.environ.get("R90_QA_TOKEN", "").strip()
        user = {"name": "R90生产验收", "role": "admin"}
        if password:
            login = context.request.post(
                f"{BASE}/api/auth/login",
                data={"username": "admin", "password": password},
            )
            if not login.ok:
                raise AssertionError(f"登录失败：{login.status} {login.text()}")
            auth = login.json()
            token = auth["token"]
            user = auth["user"]
        elif not token:
            sys.path.insert(0, str(ROOT / "tests"))
            import full_remediation_shadow_qa as shared_qa

            token = shared_qa.ephemeral_token()
        token_json = json.dumps(token)
        user_json = json.dumps(user, ensure_ascii=False)
        context.add_init_script(
            script=f"localStorage.setItem('cockpit_token', {token_json});"
            f"localStorage.setItem('cockpit_user', JSON.stringify({user_json}));"
        )

        page = context.new_page()
        console_errors = []
        request_failures = []
        response_errors = []
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("requestfailed", lambda request: request_failures.append({"url": request.url, "failure": request.failure}))
        page.on("response", lambda response: response_errors.append({"url": response.url, "status": response.status}) if response.status >= 400 else None)

        for index, route in enumerate(ACTIVE_ROUTES):
            capability_requests = []
            listener = lambda request: capability_requests.append(request.url) if "/api/operating-capabilities" in request.url else None
            page.on("request", listener)
            navigate(page, route, initial=index == 0)
            state = panel_state(page, console_errors, request_failures, response_errors)
            page.remove_listener("request", listener)
            assert len(capability_requests) == 1, f"{route} 能力接口请求次数异常：{len(capability_requests)}"
            assert "APH" in state["text"] and "绿仔" in state["text"], f"{route} 缺少双来源依据"
            assert "当前系统不接入" in state["text"], f"{route} 缺少项目范围声明"
            assert "成本、利润率、品质、安全、满意度" in state["text"], f"{route} 范围文案不完整"
            assert not state["documentOverflow"], f"{route} 出现横向溢出"
            screenshot = OUT / f"active-{route.strip('/').replace('/', '-') or 'home'}-1440.png"
            page.screenshot(path=str(screenshot), full_page=True)
            results["active"].append({"route": route, "capabilityRequests": 1, **state, "screenshot": str(screenshot.relative_to(ROOT))})

        for route in PROTECTED_ROUTES:
            capability_requests = []
            listener = lambda request: capability_requests.append(request.url) if "/api/operating-capabilities" in request.url else None
            page.on("request", listener)
            navigate(page, route)
            page.remove_listener("request", listener)
            assert not page.locator("#aph-r90-operating-capabilities").count(), f"{route} 不应挂载R90"
            assert not capability_requests, f"{route} 不应请求能力接口"
            results["protected"].append({"route": route, "capabilityRequests": 0, "panelCount": 0})

        navigate(page, "/projects")
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(500)
        mobile = panel_state(page, console_errors, request_failures, response_errors)
        columns = page.locator("#aph-r90-operating-capabilities .aph-r90-content").evaluate(
            "element => getComputedStyle(element).gridTemplateColumns"
        )
        assert " " not in columns.strip(), f"移动端不是单列布局：{columns}"
        assert not mobile["documentOverflow"], "390px项目页出现横向溢出"
        mobile_shot = OUT / "projects-390.png"
        page.screenshot(path=str(mobile_shot), full_page=True)
        results["mobile"] = {**mobile, "gridTemplateColumns": columns, "screenshot": str(mobile_shot.relative_to(ROOT))}

        expected_source_blocks = [
            response for response in response_errors
            if response["status"] == 503 and response["url"].endswith("/api/collections")
        ]
        unexpected_response_errors = [response for response in response_errors if response not in expected_source_blocks]
        relevant_console_errors = [
            error for error in console_errors
            if "favicon" not in error.lower()
            and not (expected_source_blocks and "status of 503" in error)
        ]
        results["consoleErrors"] = relevant_console_errors
        results["requestFailures"] = request_failures
        results["expectedSourceBlocks"] = expected_source_blocks
        assert not request_failures, f"静态资源请求失败：{request_failures}"
        assert not unexpected_response_errors, f"非预期HTTP错误：{unexpected_response_errors}"
        assert not relevant_console_errors, f"浏览器控制台错误：{relevant_console_errors}"
        browser.close()

    report = OUT / "report.json"
    report.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "activeRoutes": len(results["active"]),
        "protectedRoutes": len(results["protected"]),
        "mobile": True,
        "consoleErrors": len(results["consoleErrors"]),
        "expectedSourceBlocks": len(results["expectedSourceBlocks"]),
        "report": str(report),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
