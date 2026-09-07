import os
"""每日自动: Playwright登录 → 回款额 FineReport → 提取华北"""
import json, os, re
from datetime import datetime
from playwright.sync_api import sync_playwright

USER = os.environ.get('APH_USER')
PWD = os.environ.get('APH_PWD')
if not USER or not PWD:
    raise SystemExit('缺少 APH_USER/APH_PWD 环境变量')
FR_ID = "e23841f7-dceb-4118-b50e-a68cb1e0b933"
FR_URL = f"https://finereport.firstcare.com.cn/webroot/decision/v10/entry/access/{FR_ID}"
today = datetime.now().strftime('%Y-%m-%d')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto("https://aph.firstcare.com.cn/", timeout=60000)
    page.wait_for_timeout(3000)
    if 'sso' in page.url or 'login' in page.url:
        page.fill('input[name="username"]', USER)
        page.fill('input[name="password"]', PWD)
        page.locator('#loginBtn').first.click()
        page.wait_for_timeout(6000)
    
    page.goto(FR_URL, timeout=60000)
    page.wait_for_timeout(10000)
    
    for i in range(15):
        page.wait_for_timeout(2000)
        body = page.locator('body').inner_text() or ''
        if '预算' in body and len(body) > 500:
            break

    idx = body.find('华北')
    result = {}
    if idx >= 0:
        chunk = body[idx:idx+500]
        maps = {'累计执行_万': r'华北地区[^\d]*([\d,]+)',
                '年度预算_万': r'年度[^\d]*预算[^\d]*([\d,]+)',
                '累计预算_万': r'累计[^\d]*预算[^\d]*([\d,]+)',
                '同期执行_万': r'同期[^\d]*执行[^\d]*([\d,]+)',
                '年度完成率': r'年度[^\d]*完成率[^\d]*(\d+)%',
                '累计完成率': r'累计[^\d]*完成率[^\d]*(\d+)%',
                '增幅': r'增幅[^\d]*(-?\d+)%'}
        for k,p in maps.items():
            m = re.search(p, chunk)
            if m: result[k] = float(m.group(1).replace(',',''))
    
    if not result: result['_raw'] = body[:500]
    browser.close()

output = {'华北地区': {'回款额': result}, 'extractedAt': datetime.now().isoformat(), 'date': today}
os.makedirs(os.path.expanduser('~/Desktop/绿仔数据'), exist_ok=True)
path = os.path.expanduser(f'~/Desktop/绿仔数据/APH决策_每日提取_{today}.json')
with open(path, 'w', encoding='utf-8') as f:
    json.dump(output, f, ensure_ascii=False, indent=2)
print(f"💾 {path}")
print(json.dumps(result, ensure_ascii=False))
