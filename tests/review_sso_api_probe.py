#!/usr/bin/env python3
import importlib.util,json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('qa',ROOT/'tests/full_remediation_shadow_qa.py'); qa=importlib.util.module_from_spec(spec); spec.loader.exec_module(qa)
cockpit_token=qa.ephemeral_token(); base='https://www.firstcare.cloud'
try:
  with sync_playwright() as p:
    browser=p.chromium.launch(headless=True); context=browser.new_context(); page=context.new_page(); page.goto(base+'/',wait_until='domcontentloaded')
    result=page.evaluate("""async (cockpitToken)=>{
      const issued=await fetch('/api/integrations/review/sso',{method:'POST',headers:{Authorization:`Bearer ${cockpitToken}`}});
      const issuedData=await issued.json();
      const oneTime=new URL(issuedData.url,location.origin).searchParams.get('sso');
      const exchange=await fetch('/review-api/auth/cockpit-sso',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:oneTime})});
      const exchangeData=await exchange.json().catch(()=>({}));
      const reviewToken=exchangeData.token||'';
      const session=await fetch('/review-api/auth/session',{headers:reviewToken?{Authorization:`Bearer ${reviewToken}`}:{}});
      const sessionData=await session.json().catch(()=>({}));
      return {issueStatus:issued.status,issueHasUrl:Boolean(issuedData.url),exchangeStatus:exchange.status,exchangeKeys:Object.keys(exchangeData).filter(k=>k!=='token'),exchangeHasToken:Boolean(reviewToken),exchangeTokenLength:reviewToken.length,exchangeRole:exchangeData.user?.role||null,sessionStatus:session.status,sessionKeys:Object.keys(sessionData),sessionMessage:sessionData.message||sessionData.error||null,sessionRole:sessionData.user?.role||sessionData.role||null};
    }""",cockpit_token)
    print(json.dumps(result,ensure_ascii=False)); context.close(); browser.close()
finally:
  cockpit_token=''
