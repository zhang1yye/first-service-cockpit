#!/usr/bin/env python3
"""AI 预警中心窄桌面真实裁切探针：不只检查 document overflow。"""

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
    ROOT / "docs/qa/frontend-skill-cloud-20260813/r65-ai-alerts-clip-repro",
))
WIDTHS = [int(value) for value in os.environ.get(
    "R65_QA_WIDTHS", "641,768,900,1024,1100,1218,1280,1440",
).split(",")]
SHADOW = os.environ.get("R65_QA_SHADOW", "0").strip().lower() in {"1", "true", "yes"}
R65_CSS = ROOT / "firstcare-cloud-local/aph2-r65-sidebar-suppressed-labels-20260813-v1.css"

spec = importlib.util.spec_from_file_location(
    "qa", ROOT / "tests/full_remediation_shadow_qa.py"
)
qa = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(qa)


PROBE = r"""
() => {
  const selectors = [
    'main#main-content', '[data-r56-ai-center-app]', '.r56-page-header',
    '.r56-page-header h2', '.r56-page-intro', '.r56-context', '.r56-summary',
    '.r56-filters', '.r56-center-list', '.r56-center-toggle'
  ];
  const box = element => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      selector: element.matches?.('[data-r56-ai-center-app]') ? '[data-r56-ai-center-app]' : null,
      left: +rect.left.toFixed(2), right: +rect.right.toFixed(2),
      top: +rect.top.toFixed(2), width: +rect.width.toFixed(2), height: +rect.height.toFixed(2),
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      overflowX: style.overflowX, overflowY: style.overflowY,
      minWidth: style.minWidth, maxWidth: style.maxWidth,
      whiteSpace: style.whiteSpace, fontSize: style.fontSize,
      display: style.display, gridTemplateColumns: style.gridTemplateColumns,
    };
  };
  const app = document.querySelector('[data-r56-ai-center-app]');
  const main = document.querySelector('main#main-content');
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 2 && rect.height > 2 && style.display !== 'none' &&
      style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
  };
  const clippedElements = [];
  if (app) {
    for (const element of app.querySelectorAll('*')) {
      if (!visible(element) || element.closest('.r56-sr-only')) continue;
      const rect = element.getBoundingClientRect();
      let ancestor = element.parentElement;
      let clippedBy = null;
      while (ancestor && ancestor !== document.documentElement) {
        const style = getComputedStyle(ancestor);
        if (/(hidden|clip)/.test(style.overflowX)) {
          const ancestorRect = ancestor.getBoundingClientRect();
          if (rect.left < ancestorRect.left - 1 || rect.right > ancestorRect.right + 1) {
            clippedBy = {
              tag: ancestor.tagName,
              className: String(ancestor.className || '').slice(0, 160),
              left: +ancestorRect.left.toFixed(2), right: +ancestorRect.right.toFixed(2),
              overflowX: style.overflowX,
            };
            break;
          }
        }
        ancestor = ancestor.parentElement;
      }
      if (clippedBy || rect.left < (main?.getBoundingClientRect().left || 0) - 1 || rect.right > innerWidth + 1) {
        clippedElements.push({
          tag: element.tagName,
          className: String(element.className || '').slice(0, 160),
          text: (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100),
          left: +rect.left.toFixed(2), right: +rect.right.toFixed(2), width: +rect.width.toFixed(2),
          clippedBy,
        });
      }
      if (clippedElements.length >= 40) break;
    }
  }
  const clippedText = [];
  if (app) {
    const walker = document.createTreeWalker(app, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = (node.textContent || '').trim();
      if (!text || node.parentElement.closest('.r56-sr-only')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width <= 1 || rect.height <= 1) continue;
        if (rect.left < (main?.getBoundingClientRect().left || 0) - 1 || rect.right > innerWidth + 1) {
          clippedText.push({
            text: text.slice(0, 120), left: +rect.left.toFixed(2),
            right: +rect.right.toFixed(2), top: +rect.top.toFixed(2),
          });
          break;
        }
      }
      if (clippedText.length >= 30) break;
    }
  }
  return {
    innerWidth, devicePixelRatio,
    documentOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    boxes: Object.fromEntries(selectors.map(selector => [selector, box(document.querySelector(selector))])),
    clippedElements, clippedText,
    bodyClasses: document.body.className,
    sidebarClasses: document.querySelector('.aph-exact-sidebar')?.className || '',
  };
}
"""


def auth_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R65裁切验收',role:'admin'}));"
        "sessionStorage.removeItem('aph-nav-pinned-v2');"
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    token = qa.ephemeral_token()
    output = {"base": BASE, "runs": []}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for width in WIDTHS:
                context = browser.new_context(viewport={"width": width, "height": 900})
                context.add_init_script(script=auth_script(token))
                page = context.new_page()
                if SHADOW:
                    page.route(
                        "**/aph2-r65-sidebar-suppressed-labels-20260813-v1.css*",
                        lambda request: request.fulfill(
                            path=str(R65_CSS), content_type="text/css; charset=utf-8"
                        ),
                    )
                response = page.goto(BASE + "/ai-alerts", wait_until="domcontentloaded", timeout=30_000)
                page.wait_for_load_state("networkidle", timeout=30_000)
                page.wait_for_timeout(900)
                if SHADOW:
                    page.add_style_tag(
                        url=BASE + "/aph2-r65-sidebar-suppressed-labels-20260813-v1.css?shadow=1"
                    )
                    page.wait_for_timeout(150)
                states = {"collapsed": page.evaluate(PROBE)}
                panel = page.locator('.aph-exact-sidebar-panel')
                if panel.count() and panel.is_visible():
                    panel.hover(position={"x": 24, "y": 180})
                    page.wait_for_timeout(500)
                    states["hover"] = page.evaluate(PROBE)
                    page.screenshot(path=str(OUT / f"ai-alerts-{width}-hover.png"), full_page=False)
                output["runs"].append({
                    "width": width,
                    "responseStatus": response.status if response else None,
                    "states": states,
                })
                print(json.dumps({
                    "width": width,
                    "collapsedClip": len(states["collapsed"]["clippedElements"]),
                    "hoverClip": len(states.get("hover", {}).get("clippedElements", [])),
                    "documentOverflow": states.get("hover", states["collapsed"])["documentOverflow"],
                }, ensure_ascii=False), flush=True)
                context.close()
        finally:
            browser.close()
            token = ""
    (OUT / "results.json").write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
