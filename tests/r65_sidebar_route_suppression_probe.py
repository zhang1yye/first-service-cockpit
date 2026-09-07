#!/usr/bin/env python3
"""复现侧栏路由点击后的 60px 抑制态，检测导航文字是否仍被绘制。"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("R65_QA_BASE", "https://www.firstcare.cloud").rstrip("/")
OUT = Path(os.environ.get(
    "R65_QA_OUT",
    ROOT / "docs/qa/frontend-skill-cloud-20260813/r65-sidebar-suppression-repro",
))
WIDTHS = [int(value) for value in os.environ.get("R65_QA_WIDTHS", "641,768,1218,1440").split(",")]
SHADOW = os.environ.get("R65_QA_SHADOW", "0").strip().lower() in {"1", "true", "yes"}
CSS = ROOT / "firstcare-cloud-local/aph2-r65-sidebar-suppressed-labels-20260813-v1.css"
JS = ROOT / "firstcare-cloud-local/aph2-r65-sidebar-suppressed-labels-20260813-v1.js"
R59_CSS = ROOT / "firstcare-cloud-local/aph2-r59-sidebar-content-safe-area-20260813-v1.css"
R57_JS = ROOT / "firstcare-cloud-local/aph2-r57-sidebar-overlay-20260812-v1.js"

spec = importlib.util.spec_from_file_location(
    "qa", ROOT / "tests/full_remediation_shadow_qa.py"
)
qa = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(qa)


PROBE = r"""
() => {
  const sidebar = document.querySelector('.aph-exact-sidebar');
  const panel = document.querySelector('.aph-exact-sidebar-panel');
  const panelRect = panel?.getBoundingClientRect();
  const labels = [...document.querySelectorAll('.aph-exact-sidebar-panel a span')].map(label => {
    const rect = label.getBoundingClientRect();
    const style = getComputedStyle(label);
    const range = document.createRange();
    range.selectNodeContents(label);
    const textRect = range.getBoundingClientRect();
    const visibleTextPixels = panelRect
      ? Math.max(0, Math.min(textRect.right, panelRect.right) - Math.max(textRect.left, panelRect.left))
      : 0;
    return {
      text: label.textContent.trim(), opacity: style.opacity, visibility: style.visibility,
      display: style.display, left: +rect.left.toFixed(2), right: +rect.right.toFixed(2),
      width: +rect.width.toFixed(2), height: +rect.height.toFixed(2),
      textLeft: +textRect.left.toFixed(2), textRight: +textRect.right.toFixed(2),
      visibleTextPixels: +visibleTextPixels.toFixed(2),
    };
  });
  return {
    path: location.pathname,
    sidebarClasses: sidebar?.className || '',
    panelWidth: panelRect ? +panelRect.width.toFixed(2) : null,
    menuExpanded: document.querySelector('.aph-header-menu')?.getAttribute('aria-expanded'),
    paintedLabels: labels.filter(label => label.visibility !== 'hidden' && Number(label.opacity) > 0 && label.visibleTextPixels > 1),
    labels,
  };
}
"""


def auth_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R65侧栏验收',role:'admin'}));"
        "sessionStorage.removeItem('aph-nav-pinned-v2');"
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    token = qa.ephemeral_token()
    results = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for width in WIDTHS:
                context = browser.new_context(viewport={"width": width, "height": 900})
                context.add_init_script(script=auth_script(token))
                page = context.new_page()
                if SHADOW:
                    page.route(
                        "**/aph2-r59-sidebar-content-safe-area-20260813-v1.css*",
                        lambda request: request.fulfill(
                            body=f"{R59_CSS.read_text(encoding='utf-8')}\n{CSS.read_text(encoding='utf-8')}",
                            content_type="text/css; charset=utf-8",
                        ),
                    )
                    page.route(
                        "**/aph2-r57-sidebar-overlay-20260812-v1.js*",
                        lambda request: request.fulfill(
                            body=f"{R57_JS.read_text(encoding='utf-8')}\n;\n{JS.read_text(encoding='utf-8')}",
                            content_type="application/javascript; charset=utf-8",
                        ),
                    )
                page.goto(BASE + "/daily", wait_until="domcontentloaded", timeout=30_000)
                page.wait_for_load_state("networkidle", timeout=30_000)
                page.wait_for_timeout(700)
                link = page.locator('.aph-exact-sidebar a[href="/ai-alerts"]')
                link.hover(position={"x": 30, "y": 24})
                page.wait_for_timeout(300)
                before = page.evaluate(PROBE)
                link.click(position={"x": 30, "y": 24})
                page.wait_for_load_state("networkidle", timeout=30_000)
                page.wait_for_timeout(800)
                after = page.evaluate(PROBE)
                page.screenshot(path=str(OUT / f"route-click-{width}.png"), full_page=False)
                result = {"width": width, "before": before, "after": after}
                results.append(result)
                print(json.dumps({
                    "width": width,
                    "afterClasses": after["sidebarClasses"],
                    "panelWidth": after["panelWidth"],
                    "paintedLabels": len(after["paintedLabels"]),
                }, ensure_ascii=False), flush=True)
                context.close()
        finally:
            browser.close()
            token = ""
    (OUT / "results.json").write_text(
        json.dumps({"shadow": SHADOW, "runs": results}, ensure_ascii=False, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
