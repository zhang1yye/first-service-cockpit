#!/usr/bin/env python3
from __future__ import annotations
import importlib.util
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
module_path=ROOT/'tests/full_remediation_shadow_qa.py'
spec=importlib.util.spec_from_file_location('full_remediation_qa_shared',module_path)
if spec is None or spec.loader is None: raise SystemExit('QA module unavailable')
qa=importlib.util.module_from_spec(spec); spec.loader.exec_module(qa)
qa.BASE='https://www.firstcare.cloud'
qa.OUT=ROOT/'docs/qa/full-remediation-20260809/production'
qa.OUT.mkdir(parents=True,exist_ok=True)
os.environ.pop('QA_ONLY_ROUTE',None)
os.environ.pop('QA_ROUTES',None)
os.environ.pop('QA_SKIP_SUBAPPS',None)
token=qa.ephemeral_token()
try:
    with sync_playwright() as playwright:
        launch_options: dict[str, object]={'headless':True}
        if os.environ.get('QA_SOCKS_PROXY'):
            launch_options['proxy']={'server':os.environ['QA_SOCKS_PROXY']}
        browser=playwright.chromium.launch(**launch_options)
        results=[
            qa.run_viewport(browser,token,'desktop',{'width':1440,'height':1000}),
            qa.run_viewport(browser,token,'mobile',{'width':390,'height':844}),
        ]
        browser.close()
    output={'production':True,'strictTls':True,'origin':qa.BASE,'release':'cockpit-r6-operations-20260810-091802','results':results}
    result_file=qa.OUT/'production-results.json'
    result_file.write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'desktopPages':len(results[0]['pages']),'mobilePages':len(results[1]['pages']),'desktopConsoleErrors':len(results[0]['consoleErrors']),'mobileConsoleErrors':len(results[1]['consoleErrors']),'desktopFailedRequests':len(results[0]['failedRequests']),'mobileFailedRequests':len(results[1]['failedRequests']),'resultFile':str(result_file)},ensure_ascii=False))
finally:
    token=''
