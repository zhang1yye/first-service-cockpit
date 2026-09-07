import os
#!/usr/bin/env python3
"""Scrapling 自动登录帆软 → 提取华北回款额数据"""
import json, os, re
from datetime import datetime
from scrapling import StealthyFetcher

URL = "https://finereport.firstcare.com.cn/webroot/decision/v10/entry/access/12882923-edf7-44dc-b15a-a21c373db01d"
USER = os.environ.get('APH_USER')
PWD = os.environ.get('APH_PWD')
if not USER or not PWD:
    raise SystemExit('缺少 APH_USER/APH_PWD 环境变量')

result = {}

def go(page):
    global result
    today = datetime.now().strftime('%Y-%m-%d')
    print(f"📅 {today}")

    # Wait for login
    page.wait_for_timeout(5000)
    url = page.url
    print(f"📍 {url[:80]}")

    # CAS SSO login
    if 'sso' in url or 'login' in url:
        print("🔐 填写SSO登录...")
        page.fill('input[name="username"]', USER)
        page.fill('input[name="password"]', PWD)
        page.click('input[type="submit"], button[type="submit"]')
        page.wait_for_timeout(8000)
        print(f"📍 登录后: {page.url[:80]}")

    # Wait for report to load
    for i in range(15):
        page.wait_for_timeout(2000)
        body = page.locator('body').inner_text() or ''
        if any(k in body for k in ['预算', '执行', '回款']):
            print(f"✅ 报表已加载 ({i*2}s)")
            break

    body = page.locator('body').inner_text() or ''
    
    # Try to set date parameter via FineReport JS
    try:
        page.evaluate(f"FR.doParameterSubmit({{'LABEL0':'时间参数：','SHIJIANCANSHU':'{today}'}})")
        page.wait_for_timeout(3000)
        body = page.locator('body').inner_text() or ''
    except:
        pass

    # Extract numbers
    nums = {}
    patterns = {
        '累计执行_万': r'累计执行.*?([\d,]+\.?\d*)',
        '年度预算_万': r'年度预算.*?([\d,]+\.?\d*)',
        '累计预算_万': r'累计预算.*?([\d,]+\.?\d*)',
        '同期执行_万': r'同期.*?([\d,]+\.?\d*)',
        '累计完成率': r'累计完成率.*?(\d+\.?\d*)\s*%',
        '年度完成率': r'年度完成率.*?(\d+\.?\d*)\s*%',
        '增幅': r'增幅.*?(-?[\d.]+)\s*%',
    }
    
    # Find 华北 section
    lines = body.split('\n')
    north = []
    in_n = False
    for l in lines:
        if '华北' in l and any(k in l for k in ['预算','执行','完成']):
            in_n = True
            north.append(l)
        elif in_n and any(r in l for r in ['华南','西北','华东','华中']):
            break
        elif in_n and l.strip():
            north.append(l)
    
    context = '\n'.join(north) if north else body
    for key, pat in patterns.items():
        m = re.search(pat, context)
        if m:
            v = m.group(1).replace(',','')
            nums[key] = float(v) if '.' in v else int(float(v))

    if not nums:
        nums['_raw'] = context[:500]
    
    result = nums
    output = {
        '华北地区': {'回款额': result},
        'extractedAt': datetime.now().isoformat(),
        'date': today,
    }
    
    outdir = os.path.expanduser('~/Desktop/绿仔数据')
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, f'APH决策_每日提取_{today}.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    
    print(f"\n📊 {result}")
    print(f"💾 {path}")

print("🌐 启动浏览器...")
StealthyFetcher.fetch(URL, headless=True, timeout=180000, network_idle=True, load_dom=True, wait=5000, page_action=go)
print("✅ 完成")
