#!/usr/bin/env python3
"""R74 影子验收：侧栏悬停让位，刷新保留路由、查询参数和全部页签。"""

from __future__ import annotations

import importlib.util
import json
import os
import urllib.parse
from pathlib import Path

from playwright.sync_api import Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = "https://firstcare.cloud"
TARGET = os.environ.get("R74_QA_TARGET", "shadow").strip().lower()
OUT = Path(os.environ.get(
    "R74_QA_OUT",
    ROOT / f"docs/qa/frontend-skill-cloud-20260813/r74-sidebar-refresh-{TARGET}-final",
))
R74_JS = (ROOT / "firstcare-cloud-local/aph2-r74-refresh-tabs-preserve-20260813-v1.js").read_text(encoding="utf-8")
R73_LINE = b'    <link rel="stylesheet" href="/aph2-r73-sidebar-no-occlusion-20260813-v1.css?v=r73-no-occlusion1">\n'
R59_LINE = b'    <link rel="stylesheet" href="/aph2-r59-sidebar-content-safe-area-20260813-v1.css?v=r59-sidebar1">\n'
R44_LINE = b'    <script src="/aph2-r44-sidebar-tabs-20260812-v1.js?v=r44-shell1"></script>\n'
R74_LINE = b'    <script src="/aph2-r74-refresh-tabs-preserve-20260813-v1.js?v=r74-tabs1"></script>\n'
R74_PATH = "/aph2-r74-refresh-tabs-preserve-20260813-v1.js"
ROUTES = [
    "/", "/command", "/projects", "/payment", "/daily", "/collection",
    "/arrears", "/ai-alerts", "/ai-report", "/import", "/review",
    "/system", "/tasks", "/admin",
]
VIEWPORTS = [("641", 641), ("1249", 1249), ("1440", 1440)]
SAFE = {"GET", "HEAD", "OPTIONS"}
SSO = {("POST", "/api/integrations/review/sso"), ("POST", "/review-api/auth/cockpit-sso")}

spec = importlib.util.spec_from_file_location("qa", ROOT / "tests/full_remediation_shadow_qa.py")
qa = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(qa)


class Guard:
    def __init__(self) -> None:
        self.blocked: list[dict] = []
        self.transformed_documents = 0

    def handle(self, route: Route) -> None:
        request = route.request
        method = request.method.upper()
        path = urllib.parse.urlsplit(request.url).path
        if method not in SAFE and (method, path) not in SSO:
            self.blocked.append({"method": method, "path": path})
            route.abort("blockedbyclient")
            return
        if TARGET == "shadow" and method == "GET" and path == R74_PATH:
            route.fulfill(status=200, body=R74_JS, content_type="application/javascript; charset=utf-8")
            return
        if TARGET == "shadow" and method == "GET" and request.resource_type == "document" and request.url.startswith(BASE):
            response = route.fetch()
            body = response.body()
            if body.count(R73_LINE) == 1:
                body = body.replace(R73_LINE, R59_LINE, 1)
                self.transformed_documents += 1
            if body.count(R44_LINE) == 1 and body.count(R74_LINE) == 0:
                body = body.replace(R44_LINE, R74_LINE + R44_LINE, 1)
            route.fulfill(response=response, body=body)
            return
        route.continue_()


def init_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
    )


def geometry(page) -> dict:
    return page.evaluate("""
    () => {
      const box = node => {
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return {left:r.left,right:r.right,width:r.width};
      };
      const visible = node => {
        const s=getComputedStyle(node),r=node.getBoundingClientRect();
        return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>.01&&r.width>1&&r.height>1;
      };
      const sidebar=document.querySelector('.aph-exact-sidebar');
      const panel=document.querySelector('.aph-exact-sidebar-panel');
      const main=document.querySelector('main#main-content,main,[role="main"]');
      const tabs=document.querySelector('.aph-page-tabs');
      return {
        sidebar:box(sidebar),panel:box(panel),main:box(main),tabs:box(tabs),
        labels:[...panel.querySelectorAll('a span')].filter(visible).length,
        classes:sidebar.className,hover:sidebar.matches(':hover'),
        overflow:Math.max(0,document.documentElement.scrollWidth-innerWidth),
      };
    }
    """)


def after_panel(state: dict, key: str) -> bool:
    region = state.get(key)
    return region is None or region["left"] + 1 >= state["panel"]["right"]


def run_geometry(browser, token: str) -> tuple[list[dict], list[dict]]:
    runs: list[dict] = []
    blocked: list[dict] = []
    for viewport, width in VIEWPORTS:
        for path in ROUTES:
            guard = Guard()
            context = browser.new_context(viewport={"width": width, "height": 900})
            context.add_init_script(script=init_script(token))
            context.route("**/*", guard.handle)
            page = context.new_page()
            page.goto(BASE + path, wait_until="domcontentloaded", timeout=30_000)
            page.locator(".aph-exact-sidebar-panel").wait_for(state="attached", timeout=15_000)
            page.wait_for_function("""() => {
              const n=document.querySelector('.aph-exact-sidebar');
              return n&&Math.abs(n.getBoundingClientRect().left)<.75;
            }""", timeout=10_000)
            page.wait_for_timeout(500)
            page.mouse.move(width - 10, 200)
            page.wait_for_timeout(250)
            collapsed = geometry(page)
            page.mouse.move(30, 180)
            page.wait_for_timeout(450)
            hover = geometry(page)
            page.mouse.move(width - 10, 200)
            page.wait_for_timeout(450)
            leave = geometry(page)
            production_assets = page.evaluate("""() => ({
              r59:[...document.querySelectorAll('link[rel="stylesheet"]')].some(link=>link.href.includes('r59-sidebar-content-safe-area')),
              r73:[...document.querySelectorAll('link[rel="stylesheet"]')].some(link=>link.href.includes('r73-sidebar-no-occlusion')),
            })""")
            checks = {
                "candidateDocument": guard.transformed_documents >= 1 if TARGET == "shadow" else production_assets == {"r59": True, "r73": False},
                "collapsed60": collapsed["sidebar"]["width"] == 60 and collapsed["panel"]["width"] == 60,
                "hover140": hover["sidebar"]["width"] == 140 and hover["panel"]["width"] == 140,
                "hoverLabels": hover["labels"] >= 10,
                "hoverMainAfterPanel": after_panel(hover, "main"),
                "hoverTabsAfterPanel": after_panel(hover, "tabs"),
                "leave60": leave["sidebar"]["width"] == 60 and leave["panel"]["width"] == 60,
                "leaveLabelsHidden": leave["labels"] == 0,
                "noOverflow": collapsed["overflow"] == hover["overflow"] == leave["overflow"] == 0,
                "noWrites": not guard.blocked,
            }
            runs.append({"viewport": viewport, "route": path, "collapsed": collapsed, "hover": hover, "leave": leave,
                         "checks": checks, "failures": [name for name, passed in checks.items() if not passed]})
            blocked.extend(guard.blocked)
            context.close()
    return runs, blocked


def tab_state(page) -> dict:
    return page.evaluate("""() => ({
      url:location.pathname+location.search+location.hash,
      tabsRaw:sessionStorage.getItem('aph-open-tabs-v1'),
      tabs:[...document.querySelectorAll('.aph-page-tabs a')].map(a=>({text:a.textContent.trim(),href:a.getAttribute('href'),current:a.getAttribute('aria-current')})),
      h1:[...document.querySelectorAll('main h1')].map(node=>node.textContent.trim()),
      reset:document.documentElement.dataset.r44TabsReset||null,
      blocked:document.documentElement.dataset.r74TabsResetBlocked||null,
      preserved:document.documentElement.dataset.r74TabsPreserved||null,
    })""")


def run_refresh(browser, token: str) -> tuple[dict, list[dict]]:
    guard = Guard()
    context = browser.new_context(viewport={"width": 1249, "height": 900})
    context.add_init_script(script=init_script(token))
    context.route("**/*", guard.handle)
    page = context.new_page()
    for path in ("/command", "/projects", "/payment?area=%E5%8C%97%E4%BA%AC", "/review?view=logs", "/admin?focus=users"):
        page.goto(BASE + path, wait_until="domcontentloaded", timeout=30_000)
        page.locator(".aph-page-tabs").wait_for(state="attached", timeout=15_000)
        page.wait_for_timeout(500)
    before = tab_state(page)
    page.reload(wait_until="domcontentloaded", timeout=30_000)
    page.locator(".aph-page-tabs").wait_for(state="attached", timeout=15_000)
    page.wait_for_timeout(700)
    after = tab_state(page)
    checks = {
        "routePreserved": after["url"] == before["url"] == "/admin?focus=users",
        "tabsPreserved": after["tabsRaw"] == before["tabsRaw"],
        "tabCountPreserved": len(after["tabs"]) == len(before["tabs"]) and len(after["tabs"]) >= 6,
        "activeTabPreserved": [item for item in after["tabs"] if item["current"] == "page"] == [item for item in before["tabs"] if item["current"] == "page"],
        "contentPreserved": after["h1"] == before["h1"] and "系统管理" in after["h1"],
        "r44AttemptBlocked": after["reset"] == "true" and after["blocked"] == "true",
        "r74Completed": after["preserved"] == "true",
        "candidateDocuments": guard.transformed_documents >= 6 if TARGET == "shadow" else after["blocked"] == "true",
        "noWrites": not guard.blocked,
    }
    result = {"before": before, "after": after, "checks": checks,
              "failures": [name for name, passed in checks.items() if not passed]}
    context.close()
    return result, guard.blocked


def main() -> None:
    if TARGET not in {"shadow", "production"}:
        raise SystemExit("R74_QA_TARGET 仅支持 shadow 或 production")
    OUT.mkdir(parents=True, exist_ok=True)
    token = qa.ephemeral_token()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            geometry_runs, geometry_blocked = run_geometry(browser, token)
            refresh, refresh_blocked = run_refresh(browser, token)
        finally:
            browser.close()
    failed = [run for run in geometry_runs if run["failures"]]
    if refresh["failures"]:
        failed.append(refresh)
    blocked = geometry_blocked + refresh_blocked
    result = {
        "target": TARGET, "candidateInjected": TARGET == "shadow", "productionMutation": False,
        "geometryRuns": geometry_runs, "refreshRun": refresh, "blockedWrites": blocked,
        "summary": {"runs": len(geometry_runs) + 1, "passed": len(geometry_runs) + 1 - len(failed),
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
