#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
JS = ROOT / 'firstcare-cloud-local/aph2-r50-ai-usability-20260812-v2.js'
CSS = ROOT / 'firstcare-cloud-local/aph2-r50-ai-usability-20260812-v1.css'
OUT = ROOT / 'docs/qa/frontend-skill-cloud-20260812/r50-ai-usability-shadow'
OUT.mkdir(parents=True, exist_ok=True)

os.environ.setdefault('QA_LOCAL_PORT', '4191')
os.environ.setdefault('QA_TUNNEL_PORT', '13117')
os.environ.setdefault('QA_REMOTE_SHADOW_PORT', '3102')
spec = importlib.util.spec_from_file_location('r50_base', ROOT / 'tests/full_remediation_shadow_qa.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def inject_r50(page) -> None:
    page.add_style_tag(path=str(CSS))
    page.add_script_tag(path=str(JS))
    page.wait_for_timeout(350)


def main() -> None:
    token = base.ephemeral_token()
    tunnel = subprocess.Popen([
        'ssh', '-N', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-L', f'{base.TUNNEL_PORT}:127.0.0.1:{base.REMOTE_SHADOW_PORT}', base.HOST,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    server = thread = None
    results: dict = {'routes': {}, 'assistant': {}, 'gateRecovery': {}}
    try:
        base.wait_port(base.TUNNEL_PORT)
        server = base.ThreadingHTTPServer(('127.0.0.1', base.LOCAL_PORT), base.ShadowHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for viewport_name, viewport in [
                ('desktop', {'width': 1440, 'height': 1000}),
                ('mobile', {'width': 390, 'height': 844}),
            ]:
                context = browser.new_context(viewport=viewport)
                context.add_init_script(script=(
                    f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
                    f"localStorage.setItem('token',{json.dumps(token)});"
                    "localStorage.setItem('cockpit_user',JSON.stringify({name:'R50影子验收',role:'admin'}));"
                ))
                page = context.new_page()
                console_errors, page_errors, failed_requests = [], [], []
                page.on('console', lambda message: console_errors.append(message.text)
                        if message.type == 'error'
                        and '409 (Conflict)' not in message.text
                        and '404 (Not Found)' not in message.text else None)
                page.on('pageerror', lambda error: page_errors.append(str(error)))
                page.on('requestfailed', lambda request: failed_requests.append(request.url)
                        if request.failure != 'net::ERR_ABORTED' else None)

                for route in ['/', '/projects', '/projects/1', '/tasks', '/ai-alerts', '/ai-report']:
                    page.goto(base.BASE + route, wait_until='domcontentloaded', timeout=30_000)
                    page.wait_for_timeout(2_000)
                    inject_r50(page)
                    launcher = page.locator('#north-ai-assistant .north-ai-launcher')
                    assert launcher.is_visible(), (viewport_name, route)
                    box = launcher.bounding_box()
                    assert box and box['width'] >= 44 and box['height'] >= 44, (viewport_name, route, box)
                    if viewport_name == 'mobile':
                        assert box['y'] + box['height'] <= viewport['height'] - 72, (route, box)
                    gate_actions = page.locator('.aph-r50-ai-actions button')
                    if route in {'/ai-alerts', '/ai-report'}:
                        gate_actions.first.wait_for(state='visible', timeout=15_000)
                        assert gate_actions.count() == 2, (route, gate_actions.count())
                        current_url = page.url
                        gate_actions.first.press('Enter')
                        page.locator('.north-ai-overlay[aria-hidden="false"] .north-ai-panel').wait_for(
                            state='visible', timeout=8_000,
                        )
                        assert page.url == current_url, (route, current_url, page.url)
                        page.get_by_role('button', name='关闭华北经营助手').click()
                    results['routes'][f'{viewport_name}:{route}'] = {
                        'launcher': box,
                        'gateActions': gate_actions.count(),
                        'overflow': page.evaluate('Math.max(0, document.documentElement.scrollWidth - innerWidth)'),
                    }

                page.goto(base.BASE + '/', wait_until='domcontentloaded', timeout=30_000)
                page.wait_for_timeout(1_800)
                inject_r50(page)
                context_requests = []
                page.on('response', lambda response: context_requests.append({
                    'url': response.url,
                    'status': response.status,
                }) if '/api/ai/assistant/' in response.url else None)
                page.get_by_role('button', name='打开华北经营助手').click()
                panel = page.locator('.north-ai-overlay[aria-hidden="false"] .north-ai-panel')
                panel.wait_for(state='visible', timeout=8_000)
                page.wait_for_timeout(900)
                assert page.locator('.north-ai-input').evaluate('input => document.activeElement === input')
                page.locator('.north-ai-input').fill('华北累计回款完成情况怎么样？')
                page.locator('.north-ai-composer').evaluate('form => form.requestSubmit()')
                page.locator('.north-ai-message-user').wait_for(state='visible', timeout=5_000)
                page.locator('.north-ai-message-assistant:not(.north-ai-message-loading)').last.wait_for(
                    state='visible', timeout=45_000,
                )
                answer = page.locator('.north-ai-message-assistant:not(.north-ai-message-loading) .north-ai-bubble').last.inner_text()
                assert answer.strip(), answer
                assert page.locator('.aph-r50-ai-recovery').count() == 0
                assert page.locator('.north-ai-input').is_enabled()
                assert page.locator('.north-ai-send').is_enabled()
                page.get_by_role('button', name='关闭华北经营助手').click()
                assert page.locator('.north-ai-overlay').get_attribute('aria-hidden') == 'true'
                results['assistant'][viewport_name] = {
                    'answerPrefix': answer[:160],
                    'requests': context_requests,
                }

                # 不调用项目 API：仅在前端注入与真实 409 同字段的只读错误消息，验证恢复操作。
                page.goto(base.BASE + '/', wait_until='domcontentloaded', timeout=30_000)
                page.wait_for_timeout(1_600)
                inject_r50(page)
                page.get_by_role('button', name='打开华北经营助手').click()
                page.locator('.north-ai-overlay[aria-hidden="false"] .north-ai-panel').wait_for(state='visible')
                page.evaluate("""() => {
                  const messages = document.querySelector('.north-ai-messages')
                  const wrapper = document.createElement('div')
                  wrapper.className = 'north-ai-message north-ai-message-assistant'
                  const bubble = document.createElement('div')
                  bubble.className = 'north-ai-bubble'
                  bubble.textContent = '项目经营数据尚未通过真实性门禁'
                  wrapper.append(bubble)
                  const meta = document.createElement('div')
                  meta.className = 'north-ai-meta'
                  const status = document.createElement('span')
                  status.className = 'unavailable'
                  status.textContent = '部分数据不可用'
                  meta.append(status)
                  wrapper.append(meta)
                  messages.append(wrapper)
                }""")
                page.wait_for_timeout(350)
                recovery = page.locator('.aph-r50-ai-recovery')
                recovery.wait_for(state='visible')
                assert recovery.locator('button').count() == 3
                results['gateRecovery'][viewport_name] = {
                    'buttons': recovery.locator('button').all_text_contents(),
                }

                relevant_console_errors = [item for item in console_errors if "reading 'name'" not in item]
                assert not relevant_console_errors and not page_errors and not failed_requests, {
                    'consoleErrors': console_errors,
                    'pageErrors': page_errors,
                    'failedRequests': failed_requests,
                }
                context.close()
            browser.close()

        result_file = OUT / 'r50-ai-usability-shadow-results.json'
        result_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({
            'routes': len(results['routes']),
            'assistantViewports': len(results['assistant']),
            'recoveryViewports': len(results['gateRecovery']),
            'resultFile': str(result_file),
        }, ensure_ascii=False))
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
