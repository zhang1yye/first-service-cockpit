#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright

import full_remediation_shadow_qa as qa

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/qa/frontend-skill-cloud-20260812/r44-production'
OUT.mkdir(parents=True, exist_ok=True)
BASE = 'https://www.firstcare.cloud'


def probe(page):
    return page.evaluate("""() => {
      const box = element => {
        const rect = element?.getBoundingClientRect()
        return rect ? {left:Math.round(rect.left),right:Math.round(rect.right),width:Math.round(rect.width)} : null
      }
      const panel = document.querySelector('.aph-exact-sidebar-panel')
      const root = document.querySelector('main#main-content > div')
      return {
        navigationType: performance.getEntriesByType('navigation')[0]?.type,
        tabs: [...document.querySelectorAll('.aph-route-tab a')].map(link => link.textContent.trim()),
        storedTabs: JSON.parse(sessionStorage.getItem('aph-open-tabs-v1') || '[]'),
        tabsReset: document.documentElement.dataset.r44TabsReset || null,
        release: document.documentElement.dataset.r44Release || null,
        panel: box(panel),
        content: box(root),
        mainPaddingLeft: getComputedStyle(document.querySelector('main#main-content')).paddingLeft,
        overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        resources: performance.getEntriesByType('resource').map(item => item.name)
          .filter(name => name.includes('aph2-r44-sidebar-tabs-20260812-v1')),
      }
    }""")


def init_script(token):
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "sessionStorage.setItem('aph-nav-pinned-v2','1');"
        "if (!sessionStorage.getItem('aph-open-tabs-v1')) sessionStorage.setItem('aph-open-tabs-v1',JSON.stringify(["
        "{href:'/',label:'首页'},"
        "{href:'/arrears',label:'欠费经营分析'},"
        "{href:'/command',label:'经营工作台'}]));"
    )


def collect_errors(page):
    console_errors, page_errors, failed_requests = [], [], []
    page.on('console', lambda message: console_errors.append(message.text)
            if message.type == 'error' and '409 (Conflict)' not in message.text else None)
    page.on('pageerror', lambda error: page_errors.append(str(error)))
    page.on('requestfailed', lambda request: failed_requests.append(request.url)
            if request.failure != 'net::ERR_ABORTED' else None)
    return console_errors, page_errors, failed_requests


def main():
    token = qa.ephemeral_token()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            results = {'home': {}}
            for width, height in [(1517, 824), (1920, 1080)]:
                context = browser.new_context(viewport={'width': width, 'height': height})
                context.add_init_script(script=init_script(token))
                page = context.new_page()
                console_errors, page_errors, failed_requests = collect_errors(page)
                page.goto(BASE + '/', wait_until='domcontentloaded', timeout=30_000)
                page.wait_for_timeout(1_800)
                before = probe(page)
                assert before['release'] == 'r44-sidebar-tabs-20260812-v1', before
                assert len(before['resources']) == 2, before
                assert before['tabs'] == ['首页', '欠费经营分析', '经营工作台'], before
                assert before['panel']['right'] <= before['content']['left'], before
                assert before['overflow'] <= 1, before
                page.screenshot(path=str(OUT / f'{width}-home-before-reload.png'), full_page=False)

                page.reload(wait_until='domcontentloaded', timeout=30_000)
                page.wait_for_timeout(1_800)
                after = probe(page)
                assert after['navigationType'] == 'reload', after
                assert after['tabsReset'] == 'true', after
                assert after['tabs'] == ['首页'], after
                assert after['storedTabs'] == [{'href': '/', 'label': '首页'}], after
                assert after['panel']['right'] <= after['content']['left'], after
                assert after['overflow'] <= 1, after
                assert not console_errors and not page_errors and not failed_requests, {
                    'consoleErrors': console_errors,
                    'pageErrors': page_errors,
                    'failedRequests': failed_requests,
                }
                page.screenshot(path=str(OUT / f'{width}-home-after-reload.png'), full_page=False)
                results['home'][str(width)] = {'before': before, 'after': after}
                context.close()

            browser.close()

        result_file = OUT / 'r44-production-results.json'
        result_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'checks': 2, 'resultFile': str(result_file)}, ensure_ascii=False))
    finally:
        token = ''


if __name__ == '__main__':
    main()
