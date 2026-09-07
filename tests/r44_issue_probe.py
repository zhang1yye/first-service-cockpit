#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('qa', ROOT / 'tests/full_remediation_shadow_qa.py')
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)
token = qa.ephemeral_token()

try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={
            'width': int(os.environ.get('R44_WIDTH', '1920')),
            'height': int(os.environ.get('R44_HEIGHT', '1080')),
        })
        context.add_init_script(script=(
            f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
            f"localStorage.setItem('token',{json.dumps(token)});"
            "sessionStorage.setItem('aph-nav-pinned-v2','1');"
            "sessionStorage.setItem('aph-open-tabs-v1',JSON.stringify(["
            "{href:'/',label:'首页'},"
            "{href:'/arrears',label:'欠费经营分析'},"
            "{href:'/command',label:'经营工作台'}]));"
        ))
        page = context.new_page()
        page.goto('https://www.firstcare.cloud/', wait_until='domcontentloaded', timeout=30_000)
        page.wait_for_timeout(2_500)
        probe = page.evaluate("""() => {
          const box = element => {
            const rect = element?.getBoundingClientRect()
            return rect ? {left:Math.round(rect.left),right:Math.round(rect.right),top:Math.round(rect.top),width:Math.round(rect.width)} : null
          }
          return {
            navigationType: performance.getEntriesByType('navigation')[0]?.type,
            tabs: [...document.querySelectorAll('.aph-route-tab a')].map(link => link.textContent.trim()),
            storedTabs: sessionStorage.getItem('aph-open-tabs-v1'),
            sidebar: box(document.querySelector('.aph-exact-sidebar')),
            panel: box(document.querySelector('.aph-exact-sidebar-panel')),
            main: box(document.querySelector('main#main-content')),
            banner: box(document.querySelector('.aph-business-banner')),
            brand: box(document.querySelector('.aph-banner-brand')),
            title: box(document.querySelector('.aph-banner-copy')),
            firstCard: box(document.querySelector('.aph-home-kpi-grid .card-soft')),
            sidebarClasses: document.querySelector('.aph-exact-sidebar')?.className,
          }
        }""")
        page.screenshot(path=str(ROOT / 'docs/qa/frontend-skill-cloud-20260812/r44-before.png'), full_page=False)
        print(json.dumps(probe, ensure_ascii=False, indent=2))
        context.close()
        browser.close()
finally:
    token = ''
