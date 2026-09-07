#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('qa', ROOT / 'tests/full_remediation_shadow_qa.py')
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


def box_script():
    return """() => {
      const box = element => {
        if (!element) return null
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          tag: element.tagName,
          className: element.className,
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          display: style.display,
          marginTop: style.marginTop,
          marginBottom: style.marginBottom,
          paddingTop: style.paddingTop,
          paddingBottom: style.paddingBottom,
          gridRow: style.gridRow,
          gridColumn: style.gridColumn,
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
        }
      }
      const root = document.querySelector('main#main-content > div')
      const banner = document.querySelector('.aph-business-banner')
      const copy = banner?.querySelector('.aph-banner-copy')
      const title = copy?.querySelector('h1')
      const firstKpi = document.querySelector('.aph-home-kpi-grid .card-soft')
      const rootStyle = getComputedStyle(root)
      const year = getComputedStyle(banner, '::before')
      return {
        viewport: {width: innerWidth, height: innerHeight},
        root: box(root),
        rootLayout: {
          display: rootStyle.display,
          rowGap: rootStyle.rowGap,
          columnGap: rootStyle.columnGap,
          gridRows: rootStyle.gridTemplateRows,
        },
        children: [...root.children].map(box),
        banner: box(banner),
        copy: box(copy),
        title: box(title),
        firstKpi: box(firstKpi),
        gapBannerToFirstKpi: Math.round(firstKpi.getBoundingClientRect().top - banner.getBoundingClientRect().bottom),
        year: {
          content: year.content,
          left: year.left,
          top: year.top,
          bottom: year.bottom,
          transform: year.transform,
          fontSize: year.fontSize,
          color: year.color,
        },
        overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      }
    }"""


def main():
    token = qa.ephemeral_token()
    results = {}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width in (932, 1023, 1024, 1517, 1920):
                context = browser.new_context(viewport={'width': width, 'height': 900})
                context.add_init_script(script=(
                    f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
                    f"localStorage.setItem('token',{json.dumps(token)});"
                ))
                page = context.new_page()
                page.goto('https://www.firstcare.cloud/', wait_until='domcontentloaded', timeout=30_000)
                page.wait_for_timeout(2_000)
                results[str(width)] = page.evaluate(box_script())
                context.close()
            browser.close()
        print(json.dumps(results, ensure_ascii=False, indent=2))
    finally:
        token = ''


if __name__ == '__main__':
    main()
