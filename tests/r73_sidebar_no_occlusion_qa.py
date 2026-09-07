#!/usr/bin/env python3
"""R73 桌面侧栏无覆盖影子/生产回归。"""

from __future__ import annotations

import importlib.util
import json
import os
import urllib.parse
from pathlib import Path

from playwright.sync_api import Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("R73_QA_BASE", "https://firstcare.cloud").rstrip("/")
TARGET = os.environ.get("R73_QA_TARGET", "shadow").strip().lower()
OUT = Path(os.environ.get(
    "R73_QA_OUT",
    ROOT / f"docs/qa/frontend-skill-cloud-20260813/r73-sidebar-{TARGET}",
))
CSS = ROOT / "firstcare-cloud-local/aph2-r73-sidebar-no-occlusion-20260813-v1.css"
ROUTES = [
    "/", "/command", "/projects", "/payment", "/daily", "/collection",
    "/arrears", "/ai-alerts", "/ai-report", "/import", "/review",
    "/system", "/tasks", "/admin",
]
VIEWPORTS = [("641", 641), ("1249", 1249), ("1440", 1440)]
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
SSO = {
    ("POST", "/api/integrations/review/sso"),
    ("POST", "/review-api/auth/cockpit-sso"),
}

spec = importlib.util.spec_from_file_location("qa", ROOT / "tests/full_remediation_shadow_qa.py")
qa = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(qa)


class Guard:
    def __init__(self) -> None:
        self.blocked: list[dict] = []
        self.sso: list[dict] = []

    def handle(self, route: Route) -> None:
        request = route.request
        method = request.method.upper()
        path = urllib.parse.urlsplit(request.url).path
        if method in SAFE_METHODS:
            route.continue_()
        elif (method, path) in SSO:
            self.sso.append({"method": method, "path": path})
            route.continue_()
        else:
            self.blocked.append({"method": method, "path": path})
            route.abort("blockedbyclient")


def probe(page) -> dict:
    return page.evaluate("""
    () => {
      const box = node => {
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {left: rect.left, right: rect.right, width: rect.width};
      };
      const visible = node => {
        const style = getComputedStyle(node), rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' &&
          Number(style.opacity || 1) > 0 && rect.width > 1 && rect.height > 1;
      };
      const sidebar = document.querySelector('.aph-exact-sidebar');
      const panel = document.querySelector('.aph-exact-sidebar-panel');
      const main = document.querySelector('main#main-content, main, [role="main"]');
      const menu = document.querySelector('.aph-header-menu');
      return {
        sidebar: box(sidebar), panel: box(panel), main: box(main),
        classes: sidebar.className, hover: sidebar.matches(':hover'),
        labelsVisible: [...panel.querySelectorAll('a span')].filter(visible).length,
        menuVisible: menu ? visible(menu) : false,
        overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      };
    }
    """)


def same_main(first: dict, second: dict) -> bool:
    if first["main"] is None or second["main"] is None:
        return first["main"] is second["main"]
    return all(abs(first["main"][key] - second["main"][key]) < 0.75 for key in ("left", "right", "width"))


def main() -> None:
    if TARGET not in {"shadow", "production"}:
        raise SystemExit("R73_QA_TARGET 仅支持 shadow 或 production")
    css = CSS.read_text(encoding="utf-8")
    token = os.environ.get("R73_QA_TOKEN", "").strip() or qa.ephemeral_token()
    OUT.mkdir(parents=True, exist_ok=True)
    shots = OUT / "screenshots"
    shots.mkdir(exist_ok=True)
    runs: list[dict] = []
    blocked: list[dict] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for name, width in VIEWPORTS:
                for route_path in ROUTES:
                    guard = Guard()
                    context = browser.new_context(viewport={"width": width, "height": 900})
                    context.route("**/*", guard.handle)
                    context.add_init_script(script=(
                        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
                        f"localStorage.setItem('token',{json.dumps(token)});"
                    ))
                    if TARGET == "shadow":
                        context.add_init_script(script=(
                            "(()=>{const install=()=>{if(!document.documentElement)return false;"
                            "const style=document.createElement('style');style.id='r72-shadow-style';"
                            f"style.textContent={json.dumps(css)};document.documentElement.append(style);return true;}};"
                            "if(!install()){const observer=new MutationObserver(()=>{if(install())observer.disconnect()});"
                            "observer.observe(document,{childList:true});}})();"
                        ))
                    page = context.new_page()
                    page.goto(f"{BASE}{route_path}", wait_until="domcontentloaded", timeout=30_000)
                    page.locator(".aph-exact-sidebar-panel").wait_for(state="attached", timeout=15_000)
                    # 部分路由会在认证后替换一次壳层；以最终左侧几何而不是固定时长判稳。
                    page.wait_for_function(
                        """() => {
                          const node = document.querySelector('.aph-exact-sidebar');
                          return node && Math.abs(node.getBoundingClientRect().left) < 0.75;
                        }""",
                        timeout=10_000,
                    )
                    page.wait_for_timeout(500)
                    before = probe(page)
                    page.mouse.move(30, 180)
                    page.wait_for_timeout(350)
                    hover = probe(page)
                    page.evaluate("document.querySelector('.aph-exact-sidebar').classList.add('is-expanded')")
                    page.wait_for_timeout(100)
                    forced = probe(page)
                    checks = {
                        "before60": before["sidebar"]["width"] == 60 and before["panel"]["width"] == 60,
                        "hover60": hover["sidebar"]["width"] == 60 and hover["panel"]["width"] == 60,
                        "forcedPin60": forced["sidebar"]["width"] == 60 and forced["panel"]["width"] == 60,
                        "labelsHidden": before["labelsVisible"] == hover["labelsVisible"] == forced["labelsVisible"] == 0,
                        "menuRemoved": not forced["menuVisible"],
                        "mainStable": same_main(before, hover) and same_main(before, forced),
                        "noOverflow": forced["overflow"] == 0,
                        "noWrites": not guard.blocked,
                    }
                    if width == 1249 and route_path == "/":
                        page.screenshot(path=shots / "1249-home-hover.png")
                    runs.append({
                        "viewport": name, "route": route_path,
                        "before": before, "hover": hover, "forced": forced,
                        "checks": checks,
                        "failures": [key for key, passed in checks.items() if not passed],
                        "allowedSso": guard.sso,
                    })
                    blocked.extend(guard.blocked)
                    context.close()
        finally:
            browser.close()

    failed = [run for run in runs if run["failures"]]
    result = {
        "target": TARGET,
        "candidateInjected": TARGET == "shadow",
        "productionMutation": False,
        "runs": runs,
        "blockedWrites": blocked,
        "summary": {"runs": len(runs), "passed": len(runs) - len(failed), "failed": len(failed), "blockedWrites": len(blocked)},
    }
    path = OUT / "results.json"
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result["summary"], ensure_ascii=False))
    print(f"RESULT_PATH={path}")
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
