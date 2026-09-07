#!/usr/bin/env python3
"""只读比较首页与审核页移动顶栏子元素的真实坐标和计算样式。"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SHOT_DIR = ROOT / "docs/qa/frontend-skill-cloud-20260813/r64-current-pre-scroll"
os.environ["R64_QA_TARGET"] = "production"
os.environ["R64_QA_BASE"] = "https://firstcare.cloud"

spec = importlib.util.spec_from_file_location(
    "r64_qa", ROOT / "tests/r64_ai_header_all_viewports_qa.py"
)
r64 = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(r64)


PROBE = r"""
() => {
  const header = document.querySelector('header.sticky.top-0');
  const rect = node => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      tag: node.tagName,
      classes: node.className,
      ariaLabel: node.getAttribute('aria-label'),
      text: (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      x: box.x, y: box.y, width: box.width, height: box.height,
      right: box.right, bottom: box.bottom,
      position: style.position,
      top: style.top,
      marginTop: style.marginTop,
      paddingTop: style.paddingTop,
      transform: style.transform,
      alignItems: style.alignItems,
      overflow: style.overflow,
    };
  };
  return {
    path: location.pathname,
    scrollY,
    header: rect(header),
    hits: [[30, 20], [100, 20], [230, 20], [280, 20], [230, 40], [280, 40]].map(([x, y]) => {
      const node = document.elementFromPoint(x, y);
      const style = node ? getComputedStyle(node) : null;
      return {
        x, y,
        tag: node?.tagName || null,
        classes: node?.className || null,
        ariaLabel: node?.getAttribute?.('aria-label') || null,
        id: node?.id || null,
        insideHeader: Boolean(node?.closest?.('header')),
        zIndex: style?.zIndex || null,
        position: style?.position || null,
      };
    }),
    descendants: header ? [...header.querySelectorAll('*')]
      .map(rect)
      .filter(item => item.width > 0 && item.height > 0) : [],
  };
}
"""


def main() -> None:
    SHOT_DIR.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("R64_QA_TOKEN", "").strip() or r64.qa.ephemeral_token()
    output = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for route in ("/", "/review"):
                    guard = r64.ReadOnlyGuard()
                    context = r64.new_context(browser, token, {"width": 320, "height": 844}, guard)
                    page = context.new_page()
                    response = page.goto(
                        r64.BASE + route, wait_until="domcontentloaded", timeout=35_000
                    )
                    try:
                        page.wait_for_load_state("networkidle", timeout=4_000)
                    except PlaywrightTimeoutError:
                        pass
                    r64.wait_for_shell(page)
                    r64.wait_for_content_stability(page)
                    page.evaluate("scrollTo(0, 0)")
                    page.wait_for_timeout(500)
                    page.screenshot(
                        path=str(SHOT_DIR / f"mobile320-{'home' if route == '/' else 'review'}-pre-scroll.png"),
                        full_page=False,
                    )
                    page.screenshot(
                        path=str(SHOT_DIR / f"mobile320-{'home' if route == '/' else 'review'}-header-clip.png"),
                        clip={"x": 0, "y": 0, "width": 320, "height": 110},
                    )
                    evidence = page.evaluate(PROBE)
                    evidence["status"] = response.status if response else None
                    evidence["blockedWrites"] = guard.blocked_writes
                    evidence["allowedSsoAuthHandshakes"] = guard.allowed_handshakes
                    output.append(evidence)
                    context.close()
            finally:
                browser.close()
    finally:
        token = ""
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
