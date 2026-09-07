#!/usr/bin/env python3
import importlib.util,json,urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('qa',ROOT/'tests/full_remediation_shadow_qa.py'); qa=importlib.util.module_from_spec(spec); spec.loader.exec_module(qa)
token=qa.ephemeral_token(); base='https://www.firstcare.cloud'
try:
  with sync_playwright() as p:
    browser=p.chromium.launch(headless=True); context=browser.new_context(viewport={'width':1440,'height':1000})
    context.add_init_script(script=f"localStorage.setItem('cockpit_token',{json.dumps(token)});localStorage.setItem('token',{json.dumps(token)});")
    page=context.new_page(); network=[]; consoles=[]; page_errors=[]
    page.on('response',lambda r: network.append({'path':urllib.parse.urlsplit(r.url).path,'status':r.status,'type':r.headers.get('content-type','')}) if '/review-api/' in r.url else None)
    page.on('console',lambda m: consoles.append(m.text[:300]) if m.type=='error' else None)
    page.on('pageerror',lambda e: page_errors.append(str(e)[:300]))
    page.goto(base+'/',wait_until='domcontentloaded')
    review_url=page.evaluate("""async()=>{const t=localStorage.getItem('cockpit_token');const r=await fetch('/api/integrations/review/sso',{method:'POST',headers:{Authorization:`Bearer ${t}`}});const d=await r.json();if(!r.ok||!d.url)throw new Error(d.error||'sso issue failed');return d.url;}""")
    target=urllib.parse.urljoin(base+'/',review_url)
    page.evaluate('(url)=>window.location.assign(url)',target)
    page.wait_for_load_state('domcontentloaded',timeout=30000); page.wait_for_timeout(5000)
    state=page.evaluate("""()=>({path:location.pathname,hasSso:new URLSearchParams(location.search).has('sso'),title:document.title,body:document.body.innerText.slice(0,800),hasReviewToken:Boolean(localStorage.getItem('token')),reviewUserRole:(()=>{try{return JSON.parse(localStorage.getItem('user')||'{}').role||null}catch{return null}})()})""")
    print(json.dumps({'state':state,'reviewApiResponses':network,'consoleErrors':consoles,'pageErrors':page_errors},ensure_ascii=False))
    context.close(); browser.close()
finally:
  token=''
