#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

os.environ.setdefault('QA_LOCAL_PORT', '4182')
os.environ.setdefault('QA_TUNNEL_PORT', '13108')
os.environ.setdefault('QA_REMOTE_SHADOW_PORT', '3102')

import full_remediation_shadow_qa as base

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/qa/frontend-skill-cloud-20260812/r44-shadow'
OUT.mkdir(parents=True, exist_ok=True)


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
        panel: box(panel),
        content: box(root),
        mainPaddingLeft: getComputedStyle(document.querySelector('main#main-content')).paddingLeft,
        overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      }
    }""")


def main():
    token = base.ephemeral_token()
    tunnel = subprocess.Popen([
        'ssh', '-N', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-L', f'{base.TUNNEL_PORT}:127.0.0.1:{base.REMOTE_SHADOW_PORT}', base.HOST,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    server = None
    thread = None
    try:
        base.wait_port(base.TUNNEL_PORT)
        server = base.ThreadingHTTPServer(('127.0.0.1', base.LOCAL_PORT), base.ShadowHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            results = {}
            for width, height in [(1517, 824), (1920, 1080)]:
                context = browser.new_context(viewport={'width': width, 'height': height})
                context.add_init_script(script=(
                    f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
                    f"localStorage.setItem('token',{json.dumps(token)});"
                    "sessionStorage.setItem('aph-nav-pinned-v2','1');"
                    "if (!sessionStorage.getItem('aph-open-tabs-v1')) sessionStorage.setItem('aph-open-tabs-v1',JSON.stringify(["
                    "{href:'/',label:'首页'},"
                    "{href:'/arrears',label:'欠费经营分析'},"
                    "{href:'/command',label:'经营工作台'}]));"
                ))
                page = context.new_page()
                console_errors, page_errors, failed_requests = [], [], []
                page.on('console', lambda message: console_errors.append(message.text)
                        if message.type == 'error' and '409 (Conflict)' not in message.text else None)
                page.on('pageerror', lambda error: page_errors.append(str(error)))
                page.on('requestfailed', lambda request: failed_requests.append(request.url)
                        if request.failure != 'net::ERR_ABORTED' else None)
                page.goto(base.BASE + '/', wait_until='domcontentloaded', timeout=30_000)
                page.wait_for_timeout(1_800)
                before = probe(page)
                assert before['tabs'] == ['首页', '欠费经营分析', '经营工作台'], before
                assert before['panel']['right'] <= before['content']['left'], before
                assert before['overflow'] <= 1, before
                page.screenshot(path=str(OUT / f'{width}-before-reload.png'), full_page=False)

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
                page.screenshot(path=str(OUT / f'{width}-after-reload.png'), full_page=False)
                results[str(width)] = {'before': before, 'after': after}
                context.close()
            browser.close()
        result_file = OUT / 'r44-shadow-results.json'
        result_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'viewports': len(results), 'resultFile': str(result_file)}, ensure_ascii=False))
    finally:
        token = ''
        if server:
            server.shutdown()
            server.server_close()
        if thread:
            thread.join(timeout=2)
        tunnel.terminate()
        try:
            tunnel.wait(timeout=5)
        except subprocess.TimeoutExpired:
            tunnel.kill()


if __name__ == '__main__':
    main()
