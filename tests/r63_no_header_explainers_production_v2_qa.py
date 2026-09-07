#!/usr/bin/env python3
"""R63 标题说明清理生产只读验收。"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://www.firstcare.cloud"
OUT = Path(os.environ.get(
    "R63_QA_OUT",
    ROOT / "docs/qa/r63-no-header-explainers/production-v2",
))
OUT.mkdir(parents=True, exist_ok=True)
RELEASE_CHECK = os.environ.get("R63_QA_RELEASE_CHECK", "production-v2")
EXPECT_EYEBROW_VISIBLE = os.environ.get("R63_QA_EXPECT_EYEBROW_VISIBLE", "1") == "1"

shared_path = ROOT / "tests/full_remediation_shadow_qa.py"
spec = importlib.util.spec_from_file_location("r63_production_shared", shared_path)
if spec is None or spec.loader is None:
    raise SystemExit("无法加载生产验收共享模块")
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


def init_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R63生产验收',role:'admin'}));"
    )


def visible(locator) -> bool:
    return locator.count() > 0 and locator.first.is_visible()


def runtime_watch(page) -> dict[str, list[Any]]:
    result: dict[str, list[Any]] = {
        "consoleErrors": [],
        "pageErrors": [],
        "failedRequests": [],
        "errorResponses": [],
    }
    page.on(
        "console",
        lambda message: result["consoleErrors"].append(message.text)
        if message.type == "error"
        else None,
    )
    page.on("pageerror", lambda error: result["pageErrors"].append(str(error)))
    page.on(
        "requestfailed",
        lambda request: result["failedRequests"].append(
            {"url": request.url, "error": request.failure or ""}
        )
        if request.failure != "net::ERR_ABORTED"
        else None,
    )
    page.on(
        "response",
        lambda response: result["errorResponses"].append(
            {"url": response.url, "status": response.status}
        )
        if response.status >= 400
        else None,
    )
    return result


def inspect_ai(browser, token: str, name: str, viewport: dict[str, int]) -> dict[str, Any]:
    context = browser.new_context(viewport=viewport)
    context.add_init_script(script=init_script(token))
    page = context.new_page()
    runtime = runtime_watch(page)
    response = page.goto(BASE + "/ai-alerts", wait_until="domcontentloaded", timeout=30_000)
    assert response and response.status == 200
    root = page.locator("[data-r56-ai-center-app]")
    root.wait_for(state="visible", timeout=25_000)
    page.locator("[data-r56-center-row]").nth(55).wait_for(state="attached", timeout=25_000)

    title = root.locator(".r56-page-header h2").inner_text()
    long_intro = root.locator(".r56-page-intro")
    eyebrow = root.locator(".r56-eyebrow")
    page_context = root.locator(".r56-page-context")
    if page_context.count():
        context_text = page_context.inner_text()
    else:
        # R56 页头在后续小版本中可只保留同等的短事实栏，不依赖 class 名。
        header_text = root.locator(".r56-page-header").inner_text()
        expected_facts = ["业务日期", "2026-08-12", "整体可信度", "部分可信", "数据口径", "部分发布"]
        context_text = "\n".join(item for item in expected_facts if item in header_text)
    shared_subtitles = page.locator(
        "#main-content > div > div.flex-1.min-w-0 > div.text-sm,"
        "#main-content > div > div.flex-1.min-w-0 > p"
    )
    assert title == "56个服务中心，逐一给出经营判断", title
    assert long_intro.count() == 0, long_intro.all_inner_texts()
    assert shared_subtitles.count() == 0, shared_subtitles.all_inner_texts()
    assert visible(eyebrow) is EXPECT_EYEBROW_VISIBLE, {
        "expected": EXPECT_EYEBROW_VISIBLE,
        "actual": visible(eyebrow),
        "text": eyebrow.first.inner_text() if eyebrow.count() else "",
    }
    assert "2026-08-12" in context_text, context_text
    assert "部分可信" in context_text, context_text
    assert "部分发布" in context_text, context_text

    overflow = page.evaluate("Math.max(0, document.documentElement.scrollWidth - innerWidth)")
    assert overflow <= 1, overflow

    r64 = page.evaluate("""() => {
      const visible = node => {
        if (!node) return false;
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden'
          && Number(style.opacity || 1) !== 0 && box.width > 0 && box.height > 0;
      };
      const proxy = document.querySelector('.aph-r64-ai-launcher:not([hidden])');
      const source = document.querySelector('#north-ai-assistant > .north-ai-launcher');
      const legacy = document.querySelector('.aph-r57-mobile-ai-launcher');
      return {
        release: document.body.dataset.r64AiHeader || null,
        mobileShell: document.body.classList.contains('aph-r64-mobile-shell'),
        proxyVisible: visible(proxy),
        placement: proxy?.dataset.r64Placement || null,
        sourceVisible: visible(source),
        legacyVisible: visible(legacy),
        visibleAiEntries: [...document.querySelectorAll(
          '.north-ai-launcher,.aph-r57-mobile-ai-launcher,.aph-r64-ai-launcher'
        )].filter(visible).length,
      };
    }""")
    assert r64["release"] == "r64-ai-header-all-viewports-20260813-v1", r64
    assert r64["proxyVisible"] is True, r64
    assert r64["sourceVisible"] is False and r64["legacyVisible"] is False, r64
    assert r64["visibleAiEntries"] == 1, r64

    status_filter = page.locator("#r56-status-filter")
    status_filter.select_option("attention")
    page.locator("[data-r56-center-row]").nth(46).wait_for(state="attached", timeout=10_000)
    attention_count = page.locator("[data-r56-center-row]").count()
    status_filter.select_option("all")
    page.locator("[data-r56-center-row]").nth(55).wait_for(state="attached", timeout=10_000)

    first_row = page.locator("[data-r56-center-row]").first
    first_toggle = first_row.locator("[data-r56-center-toggle]")
    first_toggle.focus()
    first_toggle.press("Enter")
    assert first_row.get_attribute("open") is not None
    evidence = first_row.locator("[data-r56-center-evidence]")
    evidence.wait_for(state="visible", timeout=10_000)
    evidence_text = evidence.inner_text()
    assert "数据依据" in evidence_text or "依据" in evidence_text, evidence_text

    page.screenshot(path=str(OUT / f"{name}-ai-alerts.png"), full_page=False)
    first_row.evaluate("element => element.scrollIntoView({block:'start'})")
    page.wait_for_timeout(150)
    page.screenshot(path=str(OUT / f"{name}-ai-alerts-expanded-evidence.png"), full_page=False)

    result = {
        "status": response.status,
        "url": page.url,
        "title": title,
        "longIntroCount": long_intro.count(),
        "longIntroVisible": visible(long_intro),
        "sharedSubtitleCount": shared_subtitles.count(),
        "eyebrowCount": eyebrow.count(),
        "eyebrowVisible": visible(eyebrow),
        "eyebrowText": eyebrow.first.inner_text() if eyebrow.count() else "",
        "context": context_text,
        "rows": page.locator("[data-r56-center-row]").count(),
        "attentionFilterCount": attention_count,
        "expandedEvidenceVisible": evidence.is_visible(),
        "expandedEvidenceTextSample": evidence_text[:500],
        "overflow": overflow,
        "r64": r64,
        **runtime,
    }
    context.close()
    return result


def inspect_projects(browser, token: str, name: str, viewport: dict[str, int]) -> dict[str, Any]:
    context = browser.new_context(viewport=viewport)
    context.add_init_script(script=init_script(token))
    page = context.new_page()
    runtime = runtime_watch(page)
    response = page.goto(BASE + "/projects", wait_until="domcontentloaded", timeout=30_000)
    assert response and response.status == 200
    page.locator(".aph-project-profile-page").wait_for(state="visible", timeout=25_000)

    direct_explainer = page.locator(
        ".aph-project-profile-page > .aph-project-page-head > div:first-child > p"
    )
    assert direct_explainer.count() == 1
    assert not direct_explainer.is_visible()
    gate = page.locator(".aph-r45-project-gate")
    footnote = page.locator(".aph-project-footnote")
    assert visible(gate)
    assert "项目经营分析未生成" in gate.inner_text()
    assert visible(footnote)
    assert "—”表示尚无对应事实数据" in footnote.inner_text()
    overflow = page.evaluate("Math.max(0, document.documentElement.scrollWidth - innerWidth)")
    assert overflow <= 1, overflow

    page.screenshot(path=str(OUT / f"{name}-projects.png"), full_page=False)
    result = {
        "status": response.status,
        "url": page.url,
        "directExplainerCount": direct_explainer.count(),
        "directExplainerVisible": direct_explainer.is_visible(),
        "directExplainerDisplay": direct_explainer.evaluate("el => getComputedStyle(el).display"),
        "gateVisible": gate.is_visible(),
        "gateText": gate.inner_text(),
        "footnoteVisible": footnote.is_visible(),
        "footnoteText": footnote.inner_text(),
        "overflow": overflow,
        **runtime,
    }
    context.close()
    return result


def main() -> None:
    token = shared.ephemeral_token()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            results: dict[str, Any] = {"origin": BASE, "releaseCheck": RELEASE_CHECK}
            for name, viewport in {
                "desktop-1440": {"width": 1440, "height": 1000},
                "mobile-390": {"width": 390, "height": 844},
            }.items():
                results[f"{name}:ai-alerts"] = inspect_ai(browser, token, name, viewport)
                results[f"{name}:projects"] = inspect_projects(browser, token, name, viewport)
            browser.close()

        error_count = sum(
            len(item.get(key, []))
            for item in results.values()
            if isinstance(item, dict)
            for key in ("consoleErrors", "pageErrors", "failedRequests", "errorResponses")
        )
        results["summary"] = {
            "longIntroCount": sum(
                item.get("longIntroCount", 0) for item in results.values() if isinstance(item, dict)
            ),
            "sharedSubtitleCount": sum(
                item.get("sharedSubtitleCount", 0) for item in results.values() if isinstance(item, dict)
            ),
            "eyebrowVisibleViewports": sum(
                1 for item in results.values() if isinstance(item, dict) and item.get("eyebrowVisible")
            ),
            "runtimeErrorCount": error_count,
            "expectedEyebrowVisible": EXPECT_EYEBROW_VISIBLE,
            "knownFailure": (
                "AI页面重复装饰眉题仍可见，待immutable v3移除"
                if EXPECT_EYEBROW_VISIBLE else None
            ),
        }
        result_path = OUT / f"r63-{RELEASE_CHECK}-results.json"
        result_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"summary": results["summary"], "resultFile": str(result_path)}, ensure_ascii=False, indent=2))
    finally:
        token = ""


if __name__ == "__main__":
    main()
