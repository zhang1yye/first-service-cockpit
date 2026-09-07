#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright

import full_remediation_shadow_qa as qa

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/qa/frontend-skill-cloud-20260812/r48-production'
OUT.mkdir(parents=True, exist_ok=True)
BASE = 'https://www.firstcare.cloud'


def probe(page):
    return page.evaluate("""() => {
      const rect = element => {
        const box = element?.getBoundingClientRect()
        return box ? {
          top: Math.round(box.top), bottom: Math.round(box.bottom),
          left: Math.round(box.left), right: Math.round(box.right),
          width: Math.round(box.width), height: Math.round(box.height),
          centerX: Math.round((box.left + box.right) * 10 / 2) / 10,
        } : null
      }
      const banner = document.querySelector('.aph-business-banner')
      const title = banner?.querySelector('.aph-banner-copy h1')
      const bannerBox = banner.getBoundingClientRect()
      const kpiItems = [...document.querySelectorAll('.aph-home-kpi-grid > *')]
        .map(element => element.getBoundingClientRect())
        .filter(box => box.width > 0 && box.height > 0)
      const nextKpiTop = Math.min(...kpiItems
        .filter(box => box.top >= bannerBox.bottom - 1)
        .map(box => box.top))
      const bannerStyle = getComputedStyle(banner)
      const yearStyle = getComputedStyle(banner, '::before')
      const bannerCenter = (bannerBox.left + bannerBox.right) / 2
      const titleBox = title.getBoundingClientRect()
      const yearAnchor = bannerBox.left + parseFloat(yearStyle.left)
      return {
        viewport: {width: innerWidth, height: innerHeight},
        banner: rect(banner),
        title: rect(title),
        backgroundColor: bannerStyle.backgroundColor,
        backgroundImage: bannerStyle.backgroundImage,
        nextKpiTop: Math.round(nextKpiTop),
        gapToNextKpi: Math.round(nextKpiTop - bannerBox.bottom),
        titleCenterDelta: Math.round(((titleBox.left + titleBox.right) / 2 - bannerCenter) * 10) / 10,
        yearCenterDelta: Math.round((yearAnchor - bannerCenter) * 10) / 10,
        year: {content: yearStyle.content, top: yearStyle.top, left: yearStyle.left},
        overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        resources: performance.getEntriesByType('resource').map(item => item.name)
          .filter(name => name.includes('aph2-r48-home-banner-20260812-v1.css')),
      }
    }""")


def main():
    token = qa.ephemeral_token()
    results = {}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in [(390, 844), (932, 700), (1024, 900), (1517, 900), (1864, 900)]:
                context = browser.new_context(viewport={'width': width, 'height': height})
                context.add_init_script(script=(
                    f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
                    f"localStorage.setItem('token',{json.dumps(token)});"
                ))
                page = context.new_page()
                console_errors, page_errors, failed_requests = [], [], []
                page.on('console', lambda message: console_errors.append(message.text)
                        if message.type == 'error' and '409 (Conflict)' not in message.text else None)
                page.on('pageerror', lambda error: page_errors.append(str(error)))
                page.on('requestfailed', lambda request: failed_requests.append(request.url)
                        if request.failure != 'net::ERR_ABORTED' else None)
                response = page.goto(BASE + '/', wait_until='domcontentloaded', timeout=30_000)
                page.wait_for_timeout(1_800)
                result = probe(page)
                assert response and response.status == 200, result
                assert result['resources'], result
                assert result['backgroundColor'] == 'rgb(215, 25, 32)', result
                assert result['backgroundImage'] == 'none', result
                assert abs(result['titleCenterDelta']) <= 1, result
                assert abs(result['yearCenterDelta']) <= 1, result
                assert result['overflow'] <= 1, result
                if width >= 1024:
                    assert result['banner']['height'] == 218, result
                    assert result['gapToNextKpi'] == 10, result
                else:
                    assert result['gapToNextKpi'] <= 12, result
                assert not console_errors and not page_errors and not failed_requests, {
                    'consoleErrors': console_errors,
                    'pageErrors': page_errors,
                    'failedRequests': failed_requests,
                }
                result['status'] = response.status
                page.screenshot(path=str(OUT / f'{width}-home.png'), full_page=False)
                results[str(width)] = result
                context.close()
            browser.close()
        result_file = OUT / 'r48-production-results.json'
        result_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'viewports': len(results), 'resultFile': str(result_file)}, ensure_ascii=False))
    finally:
        token = ''


if __name__ == '__main__':
    main()
