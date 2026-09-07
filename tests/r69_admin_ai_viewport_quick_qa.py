#!/usr/bin/env python3
"""R69 候选的只读真实 DOM 影子探针；不重复注入已发布 R64 JS。"""

from __future__ import annotations

import importlib.util
import json
import os
import urllib.parse
from pathlib import Path

from playwright.sync_api import Route, TimeoutError as PlaywrightTimeoutError, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("R69_QA_BASE", "https://firstcare.cloud").rstrip("/")
TARGET = os.environ.get("R69_QA_TARGET", "shadow")
CSS = ROOT / "firstcare-cloud-local/aph2-r69-admin-desktop-ai-viewport-20260813-v1.css"
OUT = Path(os.environ.get(
    "R69_QA_OUT",
    ROOT / "docs/qa/frontend-skill-cloud-20260813/r69-admin-ai-viewport-shadow",
))
SAFE = {"GET", "HEAD", "OPTIONS"}


spec = importlib.util.spec_from_file_location(
    "qa", ROOT / "tests/full_remediation_shadow_qa.py"
)
qa = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(qa)


class Guard:
    def __init__(self) -> None:
        self.blocked: list[dict] = []

    def handle(self, route: Route) -> None:
        request = route.request
        if request.method.upper() in SAFE:
            route.continue_()
            return
        parsed = urllib.parse.urlsplit(request.url)
        self.blocked.append({"method": request.method, "path": parsed.path})
        route.abort("blockedbyclient")


PROBE = r"""
() => {
  const proxy = document.querySelector('.aph-r64-ai-launcher:not([hidden])');
  const header = proxy?.closest('header');
  const box = node => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
      width: rect.width, height: rect.height};
  };
  const proxyBox = box(proxy);
  const headerBox = box(header);
  return {
    path: location.pathname,
    proxyBox,
    headerBox,
    headerPosition: header ? getComputedStyle(header).position : null,
    headerLeft: header ? getComputedStyle(header).left : null,
    release: document.body.dataset.r64AiHeader || null,
    proxyCount: document.querySelectorAll('.aph-r64-ai-launcher:not([hidden])').length,
    insideViewport: Boolean(proxyBox && proxyBox.x >= -1 && proxyBox.y >= -1
      && proxyBox.right <= innerWidth + 1 && proxyBox.bottom <= innerHeight + 1),
    horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
  };
}
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("R69_QA_TOKEN", "").strip() or qa.ephemeral_token()
    output = {"target": TARGET, "runs": []}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for width, height in ((640, 844), (641, 844), (1023, 900), (1280, 720), (1440, 1000)):
                    for requested in ("/admin", "/system"):
                        guard = Guard()
                        context = browser.new_context(viewport={"width": width, "height": height})
                        context.add_init_script(script=(
                            f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
                            f"localStorage.setItem('token',{json.dumps(token)});"
                            "localStorage.setItem('cockpit_user',JSON.stringify({name:'R69只读验收',role:'admin'}));"
                        ))
                        context.route("**/*", guard.handle)
                        page = context.new_page()
                        failures: list[str] = []
                        try:
                            response = page.goto(BASE + requested, wait_until="domcontentloaded", timeout=35_000)
                            try:
                                page.wait_for_load_state("networkidle", timeout=4_000)
                            except PlaywrightTimeoutError:
                                pass
                            page.locator(".aph-r64-ai-launcher:not([hidden])").wait_for(
                                state="attached", timeout=15_000
                            )
                            if TARGET == "shadow":
                                page.add_style_tag(path=str(CSS))
                            page.wait_for_timeout(500)
                            state = page.evaluate(PROBE)
                            expected = "/admin"
                            checks = {
                                "response200": response is not None and response.status == 200,
                                "routeMatched": state["path"] == expected,
                                "singleProxy": state["proxyCount"] == 1,
                                "insideViewport": state["insideViewport"],
                                "noOverflow": state["horizontalOverflow"] <= 1,
                                "desktopFixed": width <= 640 or state["headerPosition"] == "fixed",
                                "noWrites": not guard.blocked,
                            }
                            failures = [key for key, passed in checks.items() if not passed]
                            output["runs"].append({
                                "width": width, "requested": requested, "state": state,
                                "checks": checks, "failures": failures, "blockedWrites": guard.blocked,
                            })
                            if requested == "/admin":
                                page.screenshot(path=str(OUT / f"{width}-admin.png"), full_page=False)
                        except Exception as error:
                            output["runs"].append({
                                "width": width, "requested": requested,
                                "failures": [f"{type(error).__name__}: {error}"],
                                "blockedWrites": guard.blocked,
                            })
                        finally:
                            context.close()
            finally:
                browser.close()
    finally:
        token = ""
    failures = [run for run in output["runs"] if run["failures"]]
    output["summary"] = {"runs": len(output["runs"]), "passes": len(output["runs"]) - len(failures), "failures": len(failures)}
    path = OUT / "results.json"
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(output["summary"], ensure_ascii=False))
    print(f"RESULT_PATH={path}")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
