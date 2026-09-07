#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright

import full_remediation_shadow_qa as qa

ROOT = Path(__file__).resolve().parents[1]
CSS = ROOT / 'firstcare-cloud-local/aph2-r49-year-placement-20260812-v1.css'
OUT = ROOT / 'docs/qa/frontend-skill-cloud-20260812/r49-shadow'
OUT.mkdir(parents=True, exist_ok=True)
BASE = 'https://www.firstcare.cloud'


def probe(page):
    return page.evaluate("""() => {
      const rect = (element, origin = null) => {
        const box = element?.getBoundingClientRect()
        if (!box) return null
        const offsetTop = origin ? origin.top : 0
        const offsetLeft = origin ? origin.left : 0
        return {
          top: Math.round((box.top - offsetTop) * 10) / 10,
          bottom: Math.round((box.bottom - offsetTop) * 10) / 10,
          left: Math.round((box.left - offsetLeft) * 10) / 10,
          right: Math.round((box.right - offsetLeft) * 10) / 10,
          width: Math.round(box.width * 10) / 10,
          height: Math.round(box.height * 10) / 10,
          centerX: Math.round((box.left + box.right) * 5) / 10,
        }
      }
      const banner = document.querySelector('.aph-business-banner')
      const copy = banner?.querySelector('.aph-banner-copy')
      const title = copy?.querySelector('h1')
      const subtitle = copy?.querySelector('h2')
      const bannerBox = banner.getBoundingClientRect()
      const copyBox = copy.getBoundingClientRect()
      const titleBox = title.getBoundingClientRect()
      const subtitleBox = subtitle.getBoundingClientRect()
      const beforeStyle = getComputedStyle(banner, '::before')
      const yearStyle = getComputedStyle(copy, '::after')
      const kpiItems = [...document.querySelectorAll('.aph-home-kpi-grid > *')]
        .map(element => element.getBoundingClientRect())
        .filter(box => box.width > 0 && box.height > 0)
      const nextKpiTop = Math.min(...kpiItems
        .filter(box => box.top >= bannerBox.bottom - 1)
        .map(box => box.top))
      return {
        viewport: {width: innerWidth, height: innerHeight},
        banner: rect(banner),
        copy: rect(copy, bannerBox),
        title: rect(title, bannerBox),
        subtitle: rect(subtitle, bannerBox),
        legacyYearContent: beforeStyle.content,
        year: {
          content: yearStyle.content,
          display: yearStyle.display,
          marginTop: parseFloat(yearStyle.marginTop),
          fontSize: parseFloat(yearStyle.fontSize),
          lineHeight: parseFloat(yearStyle.lineHeight),
          topAfterSubtitle: Math.round((copyBox.bottom - subtitleBox.bottom - parseFloat(yearStyle.lineHeight)) * 10) / 10,
          bottom: Math.round((copyBox.bottom - bannerBox.top) * 10) / 10,
        },
        gapToNextKpi: Math.round((nextKpiTop - bannerBox.bottom) * 10) / 10,
        titleCenterDelta: Math.round((((titleBox.left + titleBox.right) / 2) - ((bannerBox.left + bannerBox.right) / 2)) * 10) / 10,
        overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      }
    }""")


def main():
    token = qa.ephemeral_token()
    results = {}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in [(390, 844), (640, 844), (932, 700), (1024, 900), (1517, 900), (1864, 900)]:
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
                page.wait_for_timeout(1_600)
                page.add_style_tag(path=str(CSS))
                page.wait_for_timeout(120)
                result = probe(page)
                assert response and response.status == 200, result
                assert result['legacyYearContent'] == 'none', result
                assert result['year']['content'] == '"2026"', result
                assert result['year']['display'] == 'block', result
                assert result['year']['topAfterSubtitle'] >= 5, result
                assert result['year']['bottom'] <= result['banner']['height'] - 5, result
                assert abs(result['titleCenterDelta']) <= 1, result
                assert result['overflow'] <= 1, result
                if width <= 640:
                    assert result['banner']['height'] == 150, result
                    assert result['year']['fontSize'] == 42, result
                elif width < 1024:
                    assert result['banner']['height'] == 190, result
                    assert result['year']['fontSize'] == 50, result
                else:
                    assert result['banner']['height'] == 218, result
                    assert result['year']['fontSize'] == 60, result
                    assert result['gapToNextKpi'] == 10, result
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
        result_file = OUT / 'r49-shadow-results.json'
        result_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'viewports': len(results), 'resultFile': str(result_file)}, ensure_ascii=False))
    finally:
        token = ''


if __name__ == '__main__':
    main()
