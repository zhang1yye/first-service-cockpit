#!/usr/bin/env python3
"""欠费经营分析生产环境只读验收。"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import threading
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
TARGET = os.environ.get("QA_TARGET", "production")
BASE = "https://www.firstcare.cloud"
OUT = ROOT / "docs/qa/arrears-20260812"
AXE = ROOT / "node_modules/axe-core/axe.min.js"

spec = importlib.util.spec_from_file_location(
    "shared_qa", ROOT / "tests/full_remediation_shadow_qa.py"
)
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


def compact_violations(items: list[dict]) -> list[dict]:
    return [
        {
            "id": item["id"],
            "impact": item.get("impact"),
            "nodes": [
                {
                    "target": node.get("target"),
                    "html": node.get("html", "")[:400],
                    "failureSummary": node.get("failureSummary"),
                }
                for node in item.get("nodes", [])
            ],
        }
        for item in items
    ]


def run_viewport(browser, token: str, name: str, viewport: dict) -> dict:
    context = browser.new_context(viewport=viewport)
    context.add_init_script(
        script=(
            f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
            f"localStorage.setItem('token',{json.dumps(token)});"
            "localStorage.setItem('cockpit_user',JSON.stringify({name:'欠费分析验收',role:'admin'}));"
        )
    )
    context.add_init_script(path=str(AXE))
    page = context.new_page()
    console_errors: list[str] = []
    page_errors: list[str] = []
    failed_requests: list[dict] = []
    page.on(
        "console",
        lambda message: console_errors.append(message.text)
        if message.type == "error"
        else None,
    )
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on(
        "requestfailed",
        lambda request: failed_requests.append(
            {"url": request.url, "error": request.failure}
        )
        if request.failure != "net::ERR_ABORTED"
        else None,
    )

    response = page.goto(BASE + "/arrears", wait_until="domcontentloaded", timeout=30_000)
    frame_element = page.locator("#aph-arrears-frame")
    frame_element.wait_for(state="visible", timeout=15_000)
    frame_handle = frame_element.element_handle()
    frame = frame_handle.content_frame() if frame_handle else None
    if frame is None:
        raise AssertionError("欠费分析 iframe 未加载")
    frame.locator("h1", has_text="欠费经营分析").wait_for(state="visible", timeout=15_000)
    expect(frame.locator("#overviewStatus")).not_to_have_text(
        "数据读取中", timeout=15_000
    )

    shell = page.evaluate(
        """() => ({
          path: location.pathname,
          title: document.title,
          h1: [...document.querySelectorAll('h1')].filter(el => el.getClientRects().length).map(el => el.textContent.trim()),
          overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
          frameSrc: document.querySelector('#aph-arrears-frame')?.getAttribute('src') || '',
        })"""
    )
    if shell["path"] != "/arrears" or len(shell["h1"]) > 1:
        raise AssertionError(f"外层路由或标题异常: {shell}")

    business = frame.evaluate(
        """async () => {
          const token = localStorage.getItem('cockpit_token') || localStorage.getItem('token') || ''
          const headers = token ? {Authorization:`Bearer ${token}`} : {}
          const [overviewResponse, batchesResponse, projectsResponse] = await Promise.all([
            fetch('/api/arrears/overview', {headers}),
            fetch('/api/arrears/batches', {headers}),
            fetch('/api/arrears/projects', {headers}),
          ])
          const overview = await overviewResponse.json()
          const batches = await batchesResponse.json()
          const projects = await projectsResponse.json()
          return {
            api: {
              overview: overviewResponse.status,
              batches: batchesResponse.status,
              projects: projectsResponse.status,
            },
            overview: {
              ready: Boolean(overview.ready),
              totalAmount: overview.totalAmount ?? null,
              resourceCount: overview.resourceCount ?? null,
              projectCount: overview.projectCount ?? null,
              effectiveBatchCount: overview.effectiveBatchCount ?? null,
              revokedBatchCount: overview.revokedBatchCount ?? null,
              pendingReviewCount: overview.pendingReviewCount ?? null,
              latestBusinessDate: overview.latestBusinessDate ?? null,
              amountCompletenessRate: overview.amountCompletenessRate ?? null,
            },
            rowCounts: {
              batches: Array.isArray(batches.rows) ? batches.rows.length : null,
              projects: Array.isArray(projects.rows) ? projects.rows.length : null,
            },
            visibleMetrics: [...document.querySelectorAll('.operating-metrics article')]
              .map(node => node.innerText.trim()),
            status: document.querySelector('#overviewStatus')?.textContent?.trim() || '',
            innerOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
            visibleH1: [...document.querySelectorAll('h1')]
              .filter(el => el.getClientRects().length).length,
          }
        }"""
    )
    if set(business["api"].values()) != {200}:
        raise AssertionError(f"欠费 API 未全部可用: {business['api']}")
    if business["innerOverflow"] > 1 or business["visibleH1"] != 1:
        raise AssertionError(f"欠费内容布局异常: {business}")

    tabs = frame.get_by_role("tab")
    if tabs.count() != 3:
        raise AssertionError(f"视图页签数异常: {tabs.count()}")
    tabs.nth(0).focus()
    frame.page.keyboard.press("ArrowRight")
    focused_after_arrow = frame.evaluate("document.activeElement?.textContent?.trim()")
    selected_after_arrow = frame.locator('[role="tab"][aria-selected="true"]').inner_text()
    if focused_after_arrow != "项目与资源明细" or selected_after_arrow != "项目与资源明细":
        raise AssertionError(
            f"页签键盘切换异常: {focused_after_arrow=} {selected_after_arrow=}"
        )

    document_probe = frame.evaluate(
        "() => ({title:document.title, titleCount:document.querySelectorAll('title').length, url:location.href})"
    )
    state_axes = {}
    for index, state_name in enumerate(["经营总览", "项目与资源明细", "批次工作台"]):
        tabs.nth(index).click()
        if state_name == "批次工作台":
            view_button = frame.get_by_role("button", name="查看").first
            if view_button.count():
                view_button.click()
                frame.locator("#resultPanel:not(.hidden)").wait_for(
                    state="visible", timeout=10_000
                )
        axe = frame.evaluate(
            """async () => axe.run(document, {
              runOnly: {type:'tag', values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']},
              resultTypes: ['violations','incomplete','passes'],
            })"""
        )
        violations = compact_violations(
            [
                item
                for item in axe["violations"]
                if not (
                    item["id"] == "document-title"
                    and document_probe["title"]
                    and document_probe["titleCount"] == 1
                )
            ]
        )
        state_axes[state_name] = {
            "violations": violations,
            "incomplete": compact_violations(axe["incomplete"]),
            "passRuleCount": len(axe["passes"]),
        }
        if violations:
            raise AssertionError(
                f"欠费 iframe {state_name} WCAG 违规: {violations}; 文档={document_probe}"
            )

    screenshot = OUT / f"production-{name}.png"
    page.screenshot(path=str(screenshot), full_page=False)
    result = {
        "viewport": viewport,
        "status": response.status if response else None,
        "shell": shell,
        "business": business,
        "keyboardTabs": {
            "focusedAfterArrowRight": focused_after_arrow,
            "selectedAfterArrowRight": selected_after_arrow,
        },
        "axe": {
            "documentTitle": document_probe,
            "states": state_axes,
        },
        "consoleErrors": console_errors,
        "pageErrors": page_errors,
        "failedRequests": failed_requests,
        "screenshot": str(screenshot),
    }
    context.close()
    return result


def verify_sidebar_click(browser, token: str) -> dict:
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    context.add_init_script(
        script=(
            f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
            f"localStorage.setItem('token',{json.dumps(token)});"
            "localStorage.setItem('cockpit_user',JSON.stringify({name:'欠费路由验收',role:'admin'}));"
        )
    )
    page = context.new_page()
    page.goto(BASE + "/", wait_until="domcontentloaded", timeout=30_000)
    link = page.get_by_role("link", name="欠费经营分析").first
    link.wait_for(state="attached", timeout=15_000)
    href = link.get_attribute("href")
    link.click()
    page.wait_for_url("**/arrears", timeout=15_000)
    page.locator("#aph-arrears-frame").wait_for(state="visible", timeout=15_000)
    result = {
        "href": href,
        "path": urlsplit(page.url).path,
        "title": page.title(),
        "frameVisible": page.locator("#aph-arrears-frame:visible").count() == 1,
    }
    if result["href"] != "/arrears" or result["path"] != "/arrears":
        raise AssertionError(f"侧栏真实点击路由异常: {result}")
    context.close()
    return result


def main() -> None:
    global BASE
    OUT.mkdir(parents=True, exist_ok=True)
    token = shared.ephemeral_token()
    tunnel = None
    server = None
    thread = None
    try:
        if TARGET != "production":
            tunnel = subprocess.Popen(
                [
                    "ssh", "-N", "-o", "BatchMode=yes", "-o",
                    "StrictHostKeyChecking=yes", "-L",
                    f"{shared.TUNNEL_PORT}:127.0.0.1:{shared.REMOTE_SHADOW_PORT}",
                    shared.HOST,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )
            shared.wait_port(shared.TUNNEL_PORT)
            server = shared.ThreadingHTTPServer(
                ("127.0.0.1", shared.LOCAL_PORT), shared.ShadowHandler
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            BASE = shared.BASE
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            result = {
                "origin": BASE,
                "strictTls": True,
                "desktop": run_viewport(
                    browser, token, "desktop", {"width": 1440, "height": 1000}
                ),
                "mobile": run_viewport(
                    browser, token, "mobile", {"width": 390, "height": 844}
                ),
                "sidebarClick": verify_sidebar_click(browser, token),
            }
            browser.close()
        result_file = OUT / f"{TARGET}-results.json"
        result_file.write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(
            json.dumps(
                {
                    "desktopViolations": sum(
                        len(item["violations"])
                        for item in result["desktop"]["axe"]["states"].values()
                    ),
                    "mobileViolations": sum(
                        len(item["violations"])
                        for item in result["mobile"]["axe"]["states"].values()
                    ),
                    "desktopOverflow": result["desktop"]["business"]["innerOverflow"],
                    "mobileOverflow": result["mobile"]["business"]["innerOverflow"],
                    "sidebarPath": result["sidebarClick"]["path"],
                    "resultFile": str(result_file),
                },
                ensure_ascii=False,
            )
        )
    finally:
        token = ""
        if server:
            server.shutdown()
            server.server_close()
        if thread:
            thread.join(timeout=2)
        if tunnel:
            tunnel.terminate()
            try:
                tunnel.wait(timeout=5)
            except subprocess.TimeoutExpired:
                tunnel.kill()


if __name__ == "__main__":
    main()
