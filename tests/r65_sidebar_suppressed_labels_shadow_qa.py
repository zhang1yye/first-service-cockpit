#!/usr/bin/env python3
"""R65 全侧栏入口影子验收：路由切换收起态不得露出文字残片。"""

from __future__ import annotations

import importlib.util
import json
import os
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("R65_QA_BASE", "https://www.firstcare.cloud").rstrip("/")
OUT = Path(os.environ.get(
    "R65_QA_OUT",
    ROOT / "docs/qa/frontend-skill-cloud-20260813/r65-sidebar-labels-shadow",
))
SHADOW = os.environ.get("R65_QA_SHADOW", "1").strip().lower() in {"1", "true", "yes"}
WIDTHS = [int(value) for value in os.environ.get("R65_QA_WIDTHS", "641,1440").split(",")]
TARGETS = [
    ("/", "/"),
    ("/command", "/command"),
    ("/projects", "/projects"),
    ("/payment", "/payment"),
    ("/daily", "/daily"),
    ("/collection", "/collection"),
    ("/arrears", "/arrears"),
    ("/ai-alerts", "/ai-alerts"),
    ("/ai-report", "/ai-report"),
    ("/review?view=workbench", "/review"),
    ("/admin", "/admin"),
]

probe_spec = importlib.util.spec_from_file_location(
    "probe", ROOT / "tests/r65_sidebar_route_suppression_probe.py"
)
probe = importlib.util.module_from_spec(probe_spec)
assert probe_spec.loader is not None
probe_spec.loader.exec_module(probe)


def is_state(state: dict, *, width: int, labels: int, expanded: str, suppressed: bool) -> bool:
    return (
        abs((state.get("panelWidth") or -1) - width) <= 1
        and len(state.get("paintedLabels") or []) == labels
        and state.get("menuExpanded") == expanded
        and ("aph-r57-hover-suppressed" in state.get("sidebarClasses", "")) == suppressed
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    token = probe.qa.ephemeral_token()
    output = {"base": BASE, "shadow": SHADOW, "runs": []}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for width in WIDTHS:
                for href, expected_path in TARGETS:
                    context = browser.new_context(viewport={"width": width, "height": 900})
                    context.add_init_script(script=probe.auth_script(token))
                    page = context.new_page()
                    page_errors: list[str] = []
                    console_errors: list[str] = []
                    page.on("pageerror", lambda error: page_errors.append(str(error)))
                    page.on(
                        "console",
                        lambda message: console_errors.append(message.text)
                        if message.type == "error" else None,
                    )
                    if SHADOW:
                        page.route(
                            "**/aph2-r59-sidebar-content-safe-area-20260813-v1.css*",
                            lambda request: request.fulfill(
                                body=(
                                    probe.R59_CSS.read_text(encoding="utf-8")
                                    + "\n"
                                    + probe.CSS.read_text(encoding="utf-8")
                                ),
                                content_type="text/css; charset=utf-8",
                            ),
                        )
                        page.route(
                            "**/aph2-r57-sidebar-overlay-20260812-v1.js*",
                            lambda request: request.fulfill(
                                body=(
                                    probe.R57_JS.read_text(encoding="utf-8")
                                    + "\n;\n"
                                    + probe.JS.read_text(encoding="utf-8")
                                ),
                                content_type="application/javascript; charset=utf-8",
                            ),
                        )
                    start = "/daily" if expected_path != "/daily" else "/"
                    failures = []
                    states = {}
                    try:
                        page.goto(BASE + start, wait_until="domcontentloaded", timeout=30_000)
                        page.wait_for_load_state("networkidle", timeout=30_000)
                        page.wait_for_timeout(600)
                        link = page.locator(f'.aph-exact-sidebar a[href="{href}"]')
                        link.hover(position={"x": 30, "y": 24})
                        page.wait_for_timeout(500)
                        states["hoverBeforeClick"] = page.evaluate(probe.PROBE)
                        link.click(position={"x": 30, "y": 24})
                        page.wait_for_url(
                            lambda url: urllib.parse.urlsplit(url).path.rstrip("/") or "/"
                            == expected_path.rstrip("/") or "/",
                            timeout=30_000,
                        )
                        page.wait_for_load_state("networkidle", timeout=30_000)
                        page.wait_for_timeout(900)
                        states["suppressedAfterClick"] = page.evaluate(probe.PROBE)

                        page.mouse.move(width - 4, 880)
                        page.wait_for_timeout(320)
                        states["collapsedAfterLeave"] = page.evaluate(probe.PROBE)

                        checks = {
                            "hoverBeforeClick": is_state(
                                states["hoverBeforeClick"], width=140, labels=11,
                                expanded="true", suppressed=False,
                            ),
                            "suppressedAfterClick": is_state(
                                states["suppressedAfterClick"], width=60, labels=0,
                                expanded="false", suppressed=True,
                            ),
                            "collapsedAfterLeave": is_state(
                                states["collapsedAfterLeave"], width=60, labels=0,
                                expanded="false", suppressed=False,
                            ),
                        }
                        failures.extend(name for name, passed in checks.items() if not passed)
                    except Exception as error:
                        checks = {}
                        failures.append(f"{type(error).__name__}: {error}")

                    run = {
                        "width": width,
                        "href": href,
                        "expectedPath": expected_path,
                        "states": states,
                        "checks": checks,
                        "pageErrors": page_errors,
                        "consoleErrors": console_errors,
                        "failures": failures,
                    }
                    output["runs"].append(run)
                    print(json.dumps({
                        "width": width, "href": href, "failures": failures,
                    }, ensure_ascii=False), flush=True)
                    context.close()
        finally:
            browser.close()
            token = ""

    failed = [run for run in output["runs"] if run["failures"]]
    output["summary"] = {
        "runs": len(output["runs"]),
        "passed": len(output["runs"]) - len(failed),
        "failed": len(failed),
    }
    (OUT / "results.json").write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(output["summary"], ensure_ascii=False), flush=True)
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
