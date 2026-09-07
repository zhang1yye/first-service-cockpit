#!/usr/bin/env python3
"""R59 生产页内影子验收：侧栏展开时全站工作区同步让位。"""

from __future__ import annotations

import importlib.util
import json
import os
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("R59_QA_BASE", "https://www.firstcare.cloud").rstrip("/")
CSS = ROOT / "firstcare-cloud-local/aph2-r59-sidebar-content-safe-area-20260813-v1.css"
INJECT_CANDIDATE = os.environ.get("R59_QA_INJECT", "1").strip().lower() not in {
    "0", "false", "no",
}
OUT = Path(os.environ.get(
    "R59_QA_OUT",
    ROOT / "docs/qa/frontend-skill-cloud-20260813/r59-sidebar-shadow",
))
SHOTS = OUT / "screenshots"
DEFAULT_ROUTES = [
    "/", "/command", "/projects", "/payment", "/daily", "/collection",
    "/arrears", "/ai-alerts", "/ai-report", "/import", "/review",
    "/system", "/tasks", "/admin",
]
ROUTES = [
    route.strip()
    for route in os.environ.get("R59_QA_ROUTES", ",".join(DEFAULT_ROUTES)).split(",")
    if route.strip()
]
DEFAULT_VIEWPORTS = "1440x1000,1814x986"
VIEWPORTS = []
for viewport_spec in os.environ.get("R59_QA_VIEWPORTS", DEFAULT_VIEWPORTS).split(","):
    width_text, height_text = viewport_spec.strip().lower().split("x", 1)
    width, height = int(width_text), int(height_text)
    VIEWPORTS.append((f"{width}x{height}", {"width": width, "height": height}))
EXPECTED_PATHS = {"/system": "/admin", "/tasks": "/command"}


spec = importlib.util.spec_from_file_location(
    "qa", ROOT / "tests/full_remediation_shadow_qa.py"
)
qa = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(qa)


PROBE = r"""
() => {
  const visible = element => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity || 1) !== 0 && rect.width > 2 && rect.height > 2;
  };
  const box = element => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      left: Number(rect.left.toFixed(3)),
      right: Number(rect.right.toFixed(3)),
      top: Number(rect.top.toFixed(3)),
      width: Number(rect.width.toFixed(3)),
      height: Number(rect.height.toFixed(3)),
      paddingLeft: style.paddingLeft,
      marginLeft: style.marginLeft,
      transform: style.transform,
    };
  };
  const sidebar = document.querySelector('.aph-exact-sidebar');
  const panel = document.querySelector('.aph-exact-sidebar-panel');
  const main = document.querySelector('main#main-content');
  const tabs = document.querySelector('.aph-page-tabs');
  const content = main
    ? [...main.children].find(visible) || [...main.querySelectorAll('*')].find(visible)
    : null;
  return {
    sidebar: box(sidebar),
    panel: box(panel),
    main: box(main),
    tabs: box(tabs),
    content: box(content),
    sidebarClasses: sidebar?.className || null,
    h1Count: document.querySelectorAll('main h1').length,
    overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    innerWidth,
  };
}
"""


def auth_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R59全站侧栏验收',role:'admin'}));"
        "sessionStorage.removeItem('aph-nav-pinned-v2');"
    )


def near(value: float, expected: float, tolerance: float = 1.0) -> bool:
    return abs(value - expected) <= tolerance


def safe_name(route: str) -> str:
    return "home" if route == "/" else route.strip("/").replace("/", "-")


def state_checks(state: dict, expanded: bool) -> dict:
    expected_left = 140 if expanded else 60
    panel = state.get("panel") or {}
    sidebar = state.get("sidebar") or {}
    main = state.get("main") or {}
    tabs = state.get("tabs") or {}
    content = state.get("content") or {}
    checks = {
        "sidebarWidth": near(sidebar.get("width", -1), expected_left),
        "panelWidth": near(panel.get("width", -1), expected_left),
        "mainStartsAfterPanel": main.get("left", -1) + 1 >= panel.get("right", 999),
        "mainLeft": near(main.get("left", -1), expected_left),
        "mainRight": near(main.get("right", -1), state.get("innerWidth", -2)),
        "contentStartsAfterPanel": content.get("left", -1) + 1 >= panel.get("right", 999),
        "tabsStartsAfterPanel": tabs.get("left", -1) + 1 >= panel.get("right", 999),
        "tabsLeft": near(tabs.get("left", -1), expected_left),
        "mainHeading": state.get("h1Count", 0) >= 1,
        "noOverflow": state.get("overflowX", 999) <= 1,
    }
    return checks


def inspect_route(browser, token: str, viewport_name: str, viewport: dict, route: str) -> dict:
    context = browser.new_context(viewport=viewport)
    context.add_init_script(script=auth_script(token))
    page = context.new_page()
    if INJECT_CANDIDATE:
        page.route(
            "**/aph2-r59-sidebar-content-safe-area-20260813-v1.css*",
            lambda request: request.fulfill(path=str(CSS), content_type="text/css; charset=utf-8"),
        )
    page_errors: list[str] = []
    console_errors: list[str] = []
    failed_requests: list[dict] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on(
        "console",
        lambda message: console_errors.append(message.text) if message.type == "error" else None,
    )
    page.on(
        "requestfailed",
        lambda request: failed_requests.append({"url": request.url, "error": request.failure}),
    )
    result: dict = {"route": route, "viewport": viewport, "failures": []}
    try:
        response = page.goto(BASE + route, wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_load_state("networkidle", timeout=30_000)
        page.wait_for_timeout(700)
        r59_loaded = page.evaluate(
            "performance.getEntriesByType('resource').some(item => item.name.includes('aph2-r59-sidebar-content-safe-area'))"
        )
        if INJECT_CANDIDATE and not r59_loaded:
            page.add_style_tag(
                url=BASE + "/aph2-r59-sidebar-content-safe-area-20260813-v1.css?shadow=1"
            )
            page.wait_for_timeout(250)
            r59_loaded = True

        page.mouse.move(viewport["width"] - 8, viewport["height"] - 8)
        page.wait_for_timeout(300)
        collapsed = page.evaluate(PROBE)

        panel = collapsed.get("panel")
        if panel:
            page.mouse.move(panel["left"] + 30, min(viewport["height"] - 10, panel["top"] + 160))
            page.wait_for_timeout(550)
        hover = page.evaluate(PROBE)

        page.mouse.move(viewport["width"] - 8, viewport["height"] - 8)
        page.wait_for_timeout(500)
        leave = page.evaluate(PROBE)

        menu = page.locator(".aph-header-menu")
        if menu.count():
            menu.click()
            page.wait_for_timeout(450)
        pinned = page.evaluate(PROBE)
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        escaped = page.evaluate(PROBE)

        actual_path = urllib.parse.urlsplit(page.url).path.rstrip("/") or "/"
        expected_path = EXPECTED_PATHS.get(route, route).rstrip("/") or "/"
        checks = {
            "response200": response is not None and response.status == 200,
            "routeMatched": actual_path == expected_path,
            "r59Loaded": r59_loaded,
            **{f"collapsed.{key}": value for key, value in state_checks(collapsed, False).items()},
            **{f"hover.{key}": value for key, value in state_checks(hover, True).items()},
            **{f"leave.{key}": value for key, value in state_checks(leave, False).items()},
            **{f"pinned.{key}": value for key, value in state_checks(pinned, True).items()},
            **{f"escaped.{key}": value for key, value in state_checks(escaped, False).items()},
            "mainPaddingStable": len({
                state["main"]["paddingLeft"] for state in (collapsed, hover, leave, pinned, escaped)
                if state.get("main")
            }) == 1,
            "mainMarginStable": len({
                state["main"]["marginLeft"] for state in (collapsed, hover, leave, pinned, escaped)
                if state.get("main")
            }) == 1,
            "mainTransformStable": len({
                state["main"]["transform"] for state in (collapsed, hover, leave, pinned, escaped)
                if state.get("main")
            }) == 1,
        }
        result.update({
            "responseStatus": response.status if response else None,
            "finalPath": actual_path,
            "states": {
                "collapsed": collapsed,
                "hover": hover,
                "leave": leave,
                "pinned": pinned,
                "escaped": escaped,
            },
            "checks": checks,
            "failures": [name for name, passed in checks.items() if not passed],
        })
        if viewport_name == "1440x1000" and route in {"/", "/ai-report", "/daily", "/admin"}:
            page.mouse.move(30, 210)
            page.wait_for_timeout(400)
            page.screenshot(
                path=str(SHOTS / f"{viewport_name}-{safe_name(route)}-expanded.png"),
                full_page=False,
            )
    except Exception as error:  # 单页失败不阻断其余路由取证。
        result["failures"].append(f"{type(error).__name__}: {error}")
    finally:
        result["pageErrors"] = page_errors
        result["consoleErrors"] = console_errors
        result["failedRequests"] = failed_requests
        context.close()
    return result


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    SHOTS.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("R59_QA_TOKEN", "").strip() or qa.ephemeral_token()
    output = {
        "base": BASE,
        "method": {
            "browser": "Python Playwright / headless Chromium",
            "context": "fresh context per route and viewport",
            "loadSequence": ["domcontentloaded", "networkidle", "700ms settle"],
            "candidate": CSS.name,
            "candidateInjected": INJECT_CANDIDATE,
            "productionMutation": False,
        },
        "runs": [],
    }
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for viewport_name, viewport in VIEWPORTS:
                    for route in ROUTES:
                        result = inspect_route(browser, token, viewport_name, viewport, route)
                        output["runs"].append(result)
                        print(json.dumps({
                            "viewport": viewport_name,
                            "route": route,
                            "failures": result["failures"],
                        }, ensure_ascii=False), flush=True)
            finally:
                browser.close()
    finally:
        token = ""

    failed = [run for run in output["runs"] if run["failures"]]
    output["summary"] = {
        "runs": len(output["runs"]),
        "passed": len(output["runs"]) - len(failed),
        "failed": len(failed),
    }
    result_path = OUT / "r59-sidebar-shadow-results.json"
    result_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(output["summary"], ensure_ascii=False, indent=2), flush=True)
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
