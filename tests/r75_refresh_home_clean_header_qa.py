#!/usr/bin/env python3
"""R75 影子/生产验收：刷新回首页、页签重置、顶部项目提示条不可见。"""

from __future__ import annotations

import importlib.util
import json
import os
import urllib.parse
from pathlib import Path

from playwright.sync_api import Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = "https://firstcare.cloud"
TARGET = os.environ.get("R75_QA_TARGET", "shadow").strip().lower()
OUT = Path(os.environ.get(
    "R75_QA_OUT",
    ROOT / f"docs/qa/frontend-skill-cloud-20260813/r75-refresh-home-clean-header-{TARGET}-final",
))
JS_PATH = ROOT / "firstcare-cloud-local/aph2-r75-refresh-home-clean-header-20260813-v1.js"
JS = JS_PATH.read_text(encoding="utf-8")
R74_LINE = b'    <script src="/aph2-r74-refresh-tabs-preserve-20260813-v1.js?v=r74-tabs1"></script>\n'
R44_LINE = b'    <script src="/aph2-r44-sidebar-tabs-20260812-v1.js?v=r44-shell1"></script>\n'
R75_JS_LINE = b'    <script src="/aph2-r75-refresh-home-clean-header-20260813-v1.js?v=r75-home1"></script>\n'
R75_JS_PATH = "/aph2-r75-refresh-home-clean-header-20260813-v1.js"
ROUTES = [
    "/", "/command", "/projects", "/payment", "/daily", "/collection",
    "/arrears", "/ai-alerts", "/ai-report", "/import", "/review",
    "/system", "/tasks", "/admin",
]
SAFE = {"GET", "HEAD", "OPTIONS"}
SSO = {("POST", "/api/integrations/review/sso"), ("POST", "/review-api/auth/cockpit-sso")}

spec = importlib.util.spec_from_file_location("qa", ROOT / "tests/full_remediation_shadow_qa.py")
qa = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(qa)


class Guard:
    def __init__(self) -> None:
        self.blocked: list[dict] = []
        self.documents = 0

    def handle(self, route: Route) -> None:
        request = route.request
        method = request.method.upper()
        path = urllib.parse.urlsplit(request.url).path
        if method not in SAFE and (method, path) not in SSO:
            self.blocked.append({"method": method, "path": path})
            route.abort("blockedbyclient")
            return
        if TARGET == "shadow" and method == "GET" and path == R75_JS_PATH:
            route.fulfill(status=200, body=JS, content_type="application/javascript; charset=utf-8")
            return
        if TARGET == "shadow" and method == "GET" and request.resource_type == "document" and request.url.startswith(BASE):
            response = route.fetch()
            body = response.body()
            if body.count(R74_LINE) == 1 and body.count(R75_JS_LINE) == 0:
                body = body.replace(R74_LINE, R75_JS_LINE, 1)
            self.documents += 1
            route.fulfill(response=response, body=body)
            return
        route.continue_()


def context_for(browser, token: str, viewport: dict):
    guard = Guard()
    context = browser.new_context(viewport=viewport)
    context.add_init_script(script=(
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
    ))
    context.route("**/*", guard.handle)
    return context, guard


def state(page) -> dict:
    return page.evaluate("""() => {
      const gate=document.querySelector('.aph-r45-project-gate');
      const style=gate&&getComputedStyle(gate);
      return {
        url:location.pathname+location.search+location.hash,
        tabs:[...document.querySelectorAll('.aph-page-tabs a')].map(a=>({text:a.textContent.trim(),href:a.getAttribute('href'),current:a.getAttribute('aria-current')})),
        h1:[...document.querySelectorAll('main h1')].map(node=>node.textContent.trim()),
        gateExists:Boolean(gate),
        gateVisible:Boolean(gate&&style.display!=='none'&&style.visibility!=='hidden'&&gate.getBoundingClientRect().height>1),
        r75:document.documentElement.dataset.r75RefreshHome||null,
        tabsReset:document.documentElement.dataset.r75TabsReset||null,
        r74:document.documentElement.dataset.r74TabsPreserve||null,
      };
    }""")


def route_matrix(browser, token: str) -> tuple[list[dict], list[dict]]:
    runs, blocked = [], []
    for path in ROUTES:
        context, guard = context_for(browser, token, {"width": 1249, "height": 900})
        page = context.new_page()
        page.goto(BASE + path, wait_until="domcontentloaded", timeout=30_000)
        page.locator(".aph-page-tabs").wait_for(state="attached", timeout=15_000)
        page.wait_for_timeout(1_000)
        current = state(page)
        expected = {"/system": "/admin", "/tasks": "/command"}.get(path, path)
        checks = {
            "normalNavigationPreserved": urllib.parse.urlsplit(current["url"]).path == expected,
            "gateHidden": not current["gateVisible"],
            "r75Loaded": current["r75"] is not None,
            "r74Absent": current["r74"] is None,
            "noWrites": not guard.blocked,
        }
        runs.append({"route": path, "state": current, "checks": checks,
                     "failures": [name for name, passed in checks.items() if not passed]})
        blocked.extend(guard.blocked)
        context.close()
    return runs, blocked


def refresh_run(browser, token: str) -> tuple[dict, list[dict]]:
    context, guard = context_for(browser, token, {"width": 1249, "height": 900})
    page = context.new_page()
    for path in ("/command", "/projects", "/payment", "/review?view=logs", "/admin?focus=users"):
        page.goto(BASE + path, wait_until="domcontentloaded", timeout=30_000)
        page.locator(".aph-page-tabs").wait_for(state="attached", timeout=15_000)
        page.wait_for_timeout(400)
    before = state(page)
    page.reload(wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_url(BASE + "/", timeout=15_000)
    page.locator(".aph-page-tabs").wait_for(state="attached", timeout=15_000)
    page.wait_for_timeout(700)
    after = state(page)
    visible_tabs = [item for item in after["tabs"] if item["text"]]
    checks = {
        "beforeHadMultipleTabs": len([item for item in before["tabs"] if item["text"]]) >= 6,
        "refreshReturnedHome": after["url"] == "/",
        "tabsResetToHome": visible_tabs == [{"text": "首页", "href": "/", "current": "page"}],
        "homeContent": "华北地区经营驾驶舱" in after["h1"],
        "gateHidden": not after["gateVisible"],
        "r75Loaded": after["r75"] is not None,
        "r74Absent": after["r74"] is None,
        "noWrites": not guard.blocked,
    }
    result = {"before": before, "after": after, "checks": checks,
              "failures": [name for name, passed in checks.items() if not passed]}
    context.close()
    return result, guard.blocked


def sidebar_run(browser, token: str) -> tuple[dict, list[dict]]:
    context, guard = context_for(browser, token, {"width": 1249, "height": 900})
    page = context.new_page()
    page.goto(BASE + "/payment", wait_until="domcontentloaded", timeout=30_000)
    page.locator(".aph-exact-sidebar-panel").wait_for(state="attached", timeout=15_000)
    page.wait_for_timeout(600)
    page.mouse.move(30, 180)
    page.wait_for_timeout(450)
    geometry = page.evaluate("""() => {
      const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width}};
      const s=document.querySelector('.aph-exact-sidebar'),p=document.querySelector('.aph-exact-sidebar-panel'),m=document.querySelector('main#main-content');
      return {sidebar:box(s),panel:box(p),main:box(m)};
    }""")
    checks = {
        "hoverStillExpands": geometry["sidebar"]["width"] == geometry["panel"]["width"] == 140,
        "mainStillYields": geometry["main"]["left"] + 1 >= geometry["panel"]["right"],
        "noWrites": not guard.blocked,
    }
    result = {"geometry": geometry, "checks": checks,
              "failures": [name for name, passed in checks.items() if not passed]}
    context.close()
    return result, guard.blocked


def main() -> None:
    if TARGET not in {"shadow", "production"}:
        raise SystemExit("R75_QA_TARGET 仅支持 shadow 或 production")
    OUT.mkdir(parents=True, exist_ok=True)
    token = qa.ephemeral_token()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            routes, route_blocked = route_matrix(browser, token)
            refresh, refresh_blocked = refresh_run(browser, token)
            sidebar, sidebar_blocked = sidebar_run(browser, token)
        finally:
            browser.close()
    failed = [run for run in routes if run["failures"]]
    failed.extend(item for item in (refresh, sidebar) if item["failures"])
    blocked = route_blocked + refresh_blocked + sidebar_blocked
    result = {
        "target": TARGET, "candidateInjected": TARGET == "shadow", "productionMutation": False,
        "routeRuns": routes, "refreshRun": refresh, "sidebarRun": sidebar, "blockedWrites": blocked,
        "summary": {"runs": len(routes) + 2, "passed": len(routes) + 2 - len(failed),
                    "failed": len(failed), "blockedWrites": len(blocked)},
    }
    path = OUT / "results.json"
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result["summary"], ensure_ascii=False))
    print(f"RESULT_PATH={path}")
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
