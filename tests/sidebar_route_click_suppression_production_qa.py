#!/usr/bin/env python3
"""生产侧栏点击后 suppressed 中间态全路由验收（只读）。"""

from __future__ import annotations

import importlib.util
import json
import os
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("SUPPRESSION_QA_BASE", "https://www.firstcare.cloud").rstrip("/")
OUT = Path(os.environ.get(
    "SUPPRESSION_QA_OUT",
    ROOT / "docs/qa/frontend-skill-cloud-20260813/sidebar-route-click-suppression-production",
))
SHOTS = OUT / "screenshots"
SHADOW_CSS_TEXT = ""
if os.environ.get("SUPPRESSION_QA_CSS", "").strip():
    SHADOW_CSS_TEXT = Path(os.environ["SUPPRESSION_QA_CSS"]).read_text(encoding="utf-8")
VIEWPORTS = [("641x900", {"width": 641, "height": 900}),
             ("768x900", {"width": 768, "height": 900}),
             ("1024x900", {"width": 1024, "height": 900}),
             ("1218x900", {"width": 1218, "height": 900}),
             ("1440x1000", {"width": 1440, "height": 1000})]

# 用一个其他路由的菜单项实际导航到目标，从而采集 route-click 后真实中间态。
CASES = [
    ("/command", "/", "a[href='/']"),
    ("/", "/command", "a[href='/command']"),
    ("/", "/projects", "a[href='/projects']"),
    ("/", "/payment", "a[href='/payment']"),
    ("/", "/daily", "a[href='/daily']"),
    ("/", "/collection", "a[href='/collection']"),
    ("/", "/arrears", "a[href='/arrears']"),
    ("/", "/ai-alerts", "a[href='/ai-alerts']"),
    ("/", "/ai-report", "a[href='/ai-report']"),
    # 以下三个没有独立侧栏项，使用直达页内状态契约；
    # /system 和 /tasks 分别是 /admin 与 /command 的真实别名。
    ("/", "/import", None),
    ("/", "/review", "a[href^='/review']"),
    ("/", "/system", None),
    ("/", "/tasks", None),
    ("/", "/admin", "a[href='/admin']"),
]
EXPECTED = {"/system": "/admin", "/tasks": "/command"}

spec = importlib.util.spec_from_file_location("qa", ROOT / "tests/full_remediation_shadow_qa.py")
qa = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(qa)


def auth_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'侧栏点击QA',role:'admin'}));"
        "sessionStorage.removeItem('aph-nav-pinned-v2');"
    )


PROBE = r"""
() => {
  const sidebar = document.querySelector('.aph-exact-sidebar');
  // 在同一个JS任务中加入宿主hover类并立即测量，捕获MutationObserver
  // 下一个microtask清理之前的真实可绘制竞态。
  if (window.__aphQaForceSuppressedHover) {
    sidebar?.classList.add('is-hovered');
    const firstLabel = sidebar?.querySelector('.aph-exact-sidebar-panel a span');
    if (firstLabel) void getComputedStyle(firstLabel).opacity;
    // 直接走到过渡终态，等价于截图中竞态已经显示了几帧。
    for (const animation of sidebar?.getAnimations({subtree:true}) || []) animation.finish();
  }
  const panel = document.querySelector('.aph-exact-sidebar-panel');
  const main = document.querySelector('main#main-content,main');
  const tabs = document.querySelector('.aph-page-tabs');
  const rect = node => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return {left:+r.left.toFixed(2), right:+r.right.toFixed(2), width:+r.width.toFixed(2)};
  };
  const labels = [...document.querySelectorAll('.aph-exact-sidebar-panel a span')].map(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const glyphs = [...range.getClientRects()].reduce((sum, r) => sum + Math.max(0,
      Math.min(r.right, panel?.clientWidth || 0) - Math.max(r.left, 0)), 0);
    range.detach();
    const style = getComputedStyle(node);
    return {text:(node.textContent||'').trim(), opacity:Number(style.opacity),
      visibility:style.visibility, display:style.display, glyphPixelsInsidePanel:+glyphs.toFixed(2)};
  }).filter(item => item.text);
  const visibleLabels = labels.filter(item => item.display !== 'none' &&
    item.visibility !== 'hidden' && item.opacity > 0.01 && item.glyphPixelsInsidePanel > .25);
  return {
    classes: sidebar?.className || '', sidebar:rect(sidebar), panel:rect(panel),
    main:rect(main), tabs:rect(tabs), labels, visibleLabels,
    counts:{labels:labels.length, visibleLabels:visibleLabels.length},
    overflowX:Math.max(0, document.documentElement.scrollWidth-innerWidth),
  };
}
"""


def slug(route: str) -> str:
    return "home" if route == "/" else route.strip("/").replace("/", "-")


def inspect(browser, token: str, viewport_name: str, viewport: dict, start: str,
            target: str, selector: str | None) -> dict:
    context = browser.new_context(viewport=viewport)
    context.add_init_script(script=auth_script(token))
    page = context.new_page()
    result = {"start": start, "target": target, "viewport": viewport, "failures": []}
    try:
        page.goto(BASE + start, wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_load_state("networkidle", timeout=30_000)
        page.wait_for_timeout(500)
        if SHADOW_CSS_TEXT:
            page.add_style_tag(content=SHADOW_CSS_TEXT)
        if selector:
            page.evaluate("window.__aphQaRouteClick = true")
            page.mouse.move(30, 180)
            page.wait_for_timeout(520)
            link = page.locator(f".aph-exact-sidebar-panel {selector}").first
            link.wait_for(state="visible", timeout=5_000)
            link.click()
            page.wait_for_timeout(700)
        else:
            page.goto(BASE + target, wait_until="domcontentloaded", timeout=30_000)
            page.wait_for_load_state("networkidle", timeout=30_000)
            page.wait_for_timeout(500)
            if SHADOW_CSS_TEXT:
                page.add_style_tag(content=SHADOW_CSS_TEXT)
            page.evaluate("""() => document.querySelector('.aph-exact-sidebar')
              ?.classList.add('aph-r57-hover-suppressed')""")
        # /arrears 等全文档导航会丢失起始页的影子样式，目标页再注入一次。
        if SHADOW_CSS_TEXT:
            page.add_style_tag(content=SHADOW_CSS_TEXT)
        # 复现生产截图的精确竞态组合：路由点击已设为 suppressed，
        # 但指针仍留在重建后的侧栏节点上，宿主又补上 is-hovered。
        # 这是仅影响当前浏览器页的确定性状态注入，不写入云端。
        state_mode = page.evaluate("""() => {
          const sidebar = document.querySelector('.aph-exact-sidebar');
          const fromRouteClick = Boolean(sidebar?.classList.contains('aph-r57-hover-suppressed'));
          if (!fromRouteClick) sidebar?.classList.add('aph-r57-hover-suppressed');
          window.__aphQaForceSuppressedHover = Boolean(sidebar);
          return fromRouteClick
            ? (window.__aphQaRouteClick ? 'route-click-suppressed-plus-host-hover' : 'direct-route-suppressed-state-contract')
            : 'full-navigation-suppressed-state-contract';
        }""")
        state = page.evaluate(PROBE)
        actual = urllib.parse.urlsplit(page.url).path.rstrip("/") or "/"
        expected = EXPECTED.get(target, target)
        checks = {
            "routeMatched": actual == expected,
            "suppressedClass": "aph-r57-hover-suppressed" in state["classes"],
            "panelCollapsed": state["panel"] is not None and state["panel"]["width"] <= 61,
            "mainStartsAfterPanel": state["main"] is not None and state["panel"] is not None
                and state["main"]["left"] + 1 >= state["panel"]["right"],
            "tabsStartsAfterPanel": state["tabs"] is not None and state["panel"] is not None
                and state["tabs"]["left"] + 1 >= state["panel"]["right"],
            # 核心契约：压缩到60px时，任何文字字形都不得在panel内露出。
            "noVisibleLabelGlyphs": state["counts"]["visibleLabels"] == 0,
            "noOverflow": state["overflowX"] <= 1,
        }
        result.update({"finalPath": actual, "stateMode": state_mode,
                       "state": state, "checks": checks,
                       "failures": [key for key, passed in checks.items() if not passed]})
        if result["failures"] and viewport_name in {"1218x900", "1440x1000"}:
            page.screenshot(path=str(SHOTS / f"{viewport_name}-{slug(target)}.png"), full_page=False)
    except Exception as error:
        result["failures"].append(f"{type(error).__name__}: {error}")
    finally:
        context.close()
    return result


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True); SHOTS.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("SUPPRESSION_QA_TOKEN", "").strip() or qa.ephemeral_token()
    output = {"base": BASE, "method": {"productionMutation": False,
        "shadowCss": os.environ.get("SUPPRESSION_QA_CSS") or None,
        "state": "real route-click suppression then deterministic host is-hovered race class",
        "contract": "suppressed 60px panel has zero visible label glyphs"}, "runs": []}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                for name, viewport in VIEWPORTS:
                    for start, target, selector in CASES:
                        run = inspect(browser, token, name, viewport, start, target, selector)
                        output["runs"].append(run)
                        print(json.dumps({"viewport": name, "target": target,
                            "failures": run["failures"],
                            "visibleLabels": run.get("state", {}).get("counts", {}).get("visibleLabels")},
                            ensure_ascii=False), flush=True)
            finally: browser.close()
    finally: token = ""
    failed = [run for run in output["runs"] if run["failures"]]
    output["summary"] = {"runs":len(output["runs"]), "passed":len(output["runs"])-len(failed),
                         "failed":len(failed), "visibleLabelFailures":sum(
                             not run.get("checks", {}).get("noVisibleLabelGlyphs", False)
                             for run in output["runs"])}
    (OUT / "sidebar-route-click-suppression-results.json").write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(output["summary"], ensure_ascii=False, indent=2))
    if failed: raise SystemExit(1)


if __name__ == "__main__": main()
