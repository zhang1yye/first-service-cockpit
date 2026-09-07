#!/usr/bin/env python3
"""在生产页面内注入 R57 候选，验证侧栏不再跨页面压住正文。"""

from __future__ import annotations

import importlib.util
import json
import os
import urllib.parse
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("R57_QA_BASE", "https://www.firstcare.cloud").rstrip("/")
OUT = Path(os.environ.get(
    "R57_QA_OUT",
    ROOT / "docs/qa/frontend-skill-cloud-20260812/r57-sidebar-shadow",
))
SHOTS = OUT / "screenshots"
CSS = ROOT / "firstcare-cloud-local/aph2-r57-sidebar-safe-area-20260812-v1.css"
JS = ROOT / "firstcare-cloud-local/aph2-r57-sidebar-overlay-20260812-v1.js"
DEFAULT_ROUTES = [
    "/",
    "/command",
    "/projects",
    "/payment",
    "/daily",
    "/collection",
    "/arrears",
    "/ai-alerts",
    "/ai-report",
    "/import",
    "/review",
    "/system",
    "/tasks",
    "/admin",
]
ROUTES = [
    route.strip()
    for route in os.environ.get("R57_QA_ROUTES", ",".join(DEFAULT_ROUTES)).split(",")
    if route.strip()
]
EXPECTED_PATHS = {"/system": "/admin", "/tasks": "/command"}
VIEWPORTS = [("1440x1000", {"width": 1440, "height": 1000}), ("1814x986", {"width": 1814, "height": 986})]


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
      width: Number(rect.width.toFixed(3)),
      top: Number(rect.top.toFixed(3)),
      height: Number(rect.height.toFixed(3)),
      paddingLeft: style.paddingLeft,
      marginLeft: style.marginLeft,
      transform: style.transform,
    };
  };
  const sidebar = document.querySelector('.aph-exact-sidebar');
  const panel = document.querySelector('.aph-exact-sidebar-panel');
  const main = document.querySelector('main#main-content');
  const content = main ? [...main.children].find(visible) || [...main.querySelectorAll('*')].find(visible) : null;
  const tabs = document.querySelector('.aph-page-tabs');
  const menu = document.querySelector('.aph-header-menu');
  return {
    sidebar: box(sidebar),
    panel: box(panel),
    main: box(main),
    content: box(content),
    tabs: box(tabs),
    sidebarClasses: sidebar?.className || null,
    menuExpanded: menu?.getAttribute('aria-expanded') || null,
    pinned: sessionStorage.getItem('aph-nav-pinned-v2'),
    release: document.documentElement.dataset.r57SidebarRelease || null,
    h1: [...document.querySelectorAll('main h1')].filter(visible).map(node => node.textContent.trim()),
    h1Count: document.querySelectorAll('main h1').length,
    overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
  };
}
"""


def init_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R57侧栏影子验收',role:'admin'}));"
        "sessionStorage.setItem('aph-nav-pinned-v2','1');"
    )


def install_candidate_routes(page) -> None:
    page.route(
        "**/aph2-r57-sidebar-safe-area-20260812-v1.css*",
        lambda route: route.fulfill(path=str(CSS), content_type="text/css; charset=utf-8"),
    )
    page.route(
        "**/aph2-r57-sidebar-overlay-20260812-v1.js*",
        lambda route: route.fulfill(path=str(JS), content_type="text/javascript; charset=utf-8"),
    )


def same_geometry(before: dict | None, after: dict | None, tolerance: float = 0.75) -> bool:
    if not before or not after:
        return False
    return all(abs(before[key] - after[key]) <= tolerance for key in ("left", "width"))


def inspect_route(browser, token: str, viewport_name: str, viewport: dict, route: str) -> dict:
    context = browser.new_context(viewport=viewport)
    context.add_init_script(script=init_script(token))
    page = context.new_page()
    install_candidate_routes(page)
    page_errors: list[str] = []
    failed_requests: list[dict] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on(
        "requestfailed",
        lambda request: failed_requests.append({"url": request.url, "error": request.failure}),
    )
    result: dict = {"route": route, "viewport": viewport, "failures": []}
    try:
        response = page.goto(BASE + route, wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_load_state("networkidle", timeout=30_000)
        page.wait_for_timeout(700)
        result["responseStatus"] = response.status if response else None
        result["beforeInjection"] = page.evaluate(PROBE)

        if page.evaluate("document.documentElement.dataset.r57SidebarRelease || ''") != "r57-sidebar-overlay-20260812-v1":
            page.add_style_tag(url=BASE + "/aph2-r57-sidebar-safe-area-20260812-v1.css?shadow=1")
            page.add_script_tag(url=BASE + "/aph2-r57-sidebar-overlay-20260812-v1.js?shadow=1")
        page.wait_for_timeout(500)
        page.mouse.move(viewport["width"] - 8, viewport["height"] - 8)
        page.wait_for_timeout(150)
        collapsed = page.evaluate(PROBE)

        panel = collapsed.get("panel")
        if panel:
            page.mouse.move(panel["left"] + 30, min(viewport["height"] - 10, panel["top"] + 150))
            page.wait_for_timeout(450)
        hover = page.evaluate(PROBE)

        page.mouse.move(viewport["width"] - 8, viewport["height"] - 8)
        page.wait_for_timeout(450)
        leave = page.evaluate(PROBE)

        menu = page.locator(".aph-header-menu")
        if menu.count():
            menu.click()
            page.wait_for_timeout(350)
        clicked = page.evaluate(PROBE)
        page.keyboard.press("Escape")
        page.wait_for_timeout(250)
        escaped = page.evaluate(PROBE)

        result["states"] = {
            "collapsed": collapsed,
            "hover": hover,
            "leave": leave,
            "menuClicked": clicked,
            "escaped": escaped,
        }
        result["finalPath"] = urllib.parse.urlsplit(page.url).path.rstrip("/") or "/"
        expected = EXPECTED_PATHS.get(route, route).rstrip("/") or "/"

        checks = {
            "routeMatched": result["finalPath"] == expected,
            "releaseLoaded": collapsed.get("release") == "r57-sidebar-overlay-20260812-v1",
            "stalePinCleared": collapsed.get("pinned") is None,
            "initiallyCollapsed": panel is not None and abs(panel["width"] - 60) <= 1,
            "hoverExpanded": hover.get("panel") is not None and abs(hover["panel"]["width"] - 140) <= 1,
            "mainStableOnHover": same_geometry(collapsed.get("main"), hover.get("main")),
            "contentStableOnHover": same_geometry(collapsed.get("content"), hover.get("content")),
            "mainPaddingStable": collapsed.get("main", {}).get("paddingLeft") == hover.get("main", {}).get("paddingLeft"),
            "tabsStableOnHover": collapsed.get("tabs") is None or same_geometry(collapsed.get("tabs"), hover.get("tabs")),
            "leaveCollapsed": leave.get("panel") is not None and abs(leave["panel"]["width"] - 60) <= 1,
            "menuCanOpen": clicked.get("panel") is not None and abs(clicked["panel"]["width"] - 140) <= 1,
            "escapeCollapsed": escaped.get("panel") is not None and abs(escaped["panel"]["width"] - 60) <= 1,
            "escapeClearedPin": escaped.get("pinned") is None,
            "noOverflow": all(state.get("overflowX", 999) <= 1 for state in (collapsed, hover, leave, clicked, escaped)),
            "mainLandmark": bool(collapsed.get("main")),
            "mainHeading": collapsed.get("h1Count", 0) > 0,
        }
        result["checks"] = checks
        result["failures"] = [name for name, passed in checks.items() if not passed]

        if route in ("/", "/ai-report") and viewport_name == "1440x1000":
            page.screenshot(path=str(SHOTS / f"{viewport_name}-{route.strip('/') or 'home'}-escaped.png"), full_page=False)
    except PlaywrightTimeoutError as error:
        result["failures"].append(f"networkidle: {error}")
    except Exception as error:  # 单页失败不阻断其余路由取证。
        result["failures"].append(f"{type(error).__name__}: {error}")
    finally:
        result["pageErrors"] = page_errors
        result["failedRequests"] = failed_requests
        context.close()
    return result


def verify_navigation_collapse(browser, token: str) -> dict:
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    context.add_init_script(script=init_script(token))
    page = context.new_page()
    install_candidate_routes(page)
    try:
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_load_state("networkidle", timeout=30_000)
        if page.evaluate("document.documentElement.dataset.r57SidebarRelease || ''") != "r57-sidebar-overlay-20260812-v1":
            page.add_style_tag(url=BASE + "/aph2-r57-sidebar-safe-area-20260812-v1.css?shadow=1")
            page.add_script_tag(url=BASE + "/aph2-r57-sidebar-overlay-20260812-v1.js?shadow=1")
        page.wait_for_timeout(500)
        page.locator('.aph-exact-sidebar a[href="/ai-report"]').click()
        page.wait_for_load_state("networkidle", timeout=30_000)
        page.wait_for_timeout(700)
        state = page.evaluate(PROBE)
        page.screenshot(path=str(SHOTS / "1440-home-to-ai-report-after-click.png"), full_page=False)
        return {
            "finalPath": urllib.parse.urlsplit(page.url).path,
            "state": state,
            "passed": (
                urllib.parse.urlsplit(page.url).path == "/ai-report"
                and state.get("panel") is not None
                and abs(state["panel"]["width"] - 60) <= 1
                and "is-expanded" not in (state.get("sidebarClasses") or "")
                and state.get("pinned") is None
                and state.get("overflowX", 999) <= 1
            ),
        }
    finally:
        context.close()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    SHOTS.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("R57_QA_TOKEN", "").strip() or qa.ephemeral_token()
    output = {
        "base": BASE,
        "method": {
            "browser": "Python Playwright / headless Chromium",
            "loadSequence": ["domcontentloaded", "networkidle", "700ms settle"],
            "candidate": [CSS.name, JS.name],
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
                        print(json.dumps({"viewport": viewport_name, "route": route, "failures": result["failures"]}, ensure_ascii=False), flush=True)
                output["navigationCollapse"] = verify_navigation_collapse(browser, token)
            finally:
                browser.close()
    finally:
        token = ""

    failed = [run for run in output["runs"] if run["failures"]]
    output["summary"] = {
        "runs": len(output["runs"]),
        "passed": len(output["runs"]) - len(failed),
        "failed": len(failed),
        "navigationCollapsePassed": output["navigationCollapse"]["passed"],
    }
    result_path = OUT / "r57-sidebar-shadow-results.json"
    result_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(output["summary"], ensure_ascii=False, indent=2), flush=True)
    if failed or not output["navigationCollapse"]["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
