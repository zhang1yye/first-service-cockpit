import os
#!/usr/bin/env python3
"""
云服务器自动登录 APH 决策系统 → 抓取华北回款额数据
凭据从环境变量读取: APH_USERNAME, APH_PASSWORD
"""
import os, json, re, sys
from datetime import datetime
from scrapling import StealthyFetcher

USERNAME = os.environ.get('APH_USERNAME') or os.environ.get('APH_USER')
PASSWORD = os.environ.get('APH_PASSWORD') or os.environ.get('APH_PWD')
if not USERNAME or not PASSWORD:
    raise SystemExit('缺少 APH_USERNAME/APH_PASSWORD 或 APH_USER/APH_PWD 环境变量')

FINEREPORT_ENTRY = (
    "https://finereport.firstcare.com.cn/webroot/decision/v10/entry/access/"
    "12882923-edf7-44dc-b15a-a21c373db01d"
)
OUTPUT_DIR = os.path.expanduser("~/aph-data")

extracted = {}

def page_action(page):
    global extracted
    
    # 等待 SSO 登录页加载
    page.wait_for_timeout(3000)
    url = page.url
    
    if 'sso' in url or 'login' in url:
        print("🔐 SSO 登录页面，填写凭据...")
        try:
            # CAS 登录表单
            page.fill('input[name="username"]', USERNAME)
            page.fill('input[name="password"]', PASSWORD)
            page.click('input[type="submit"], button[type="submit"], .login-btn')
            page.wait_for_timeout(5000)
        except:
            # FineReport 自带登录
            try:
                page.fill('#username', USERNAME)
                page.fill('#password', PASSWORD)
                page.click('#loginBtn, .login-button, button:has-text("登录")')
                page.wait_for_timeout(5000)
            except:
                print("⚠️ 未找到登录表单，尝试Cookie直接访问")
    
    # 等待报表加载
    for _ in range(10):
        page.wait_for_timeout(2000)
        body = page.locator('body').inner_text() or ''
        if '预算' in body or '回款' in body or '执行' in body:
            break
    
    today = datetime.now().strftime('%Y-%m-%d')
    
    # 提取华北数据
    body_text = page.locator('body').inner_text() or ''
    lines = body_text.split('\n')
    
    north_lines = []
    in_north = False
    for line in lines:
        s = line.strip()
        if not s: continue
        if '华北' in s and any(k in s for k in ['预算','执行','完成','增幅']):
            in_north = True
            north_lines.append(s)
        elif in_north and any(r in s for r in ['华南','西北','华东','华中']):
            break
        elif in_north:
            north_lines.append(s)
    
    # 提取数值
    nums = {}
    for line in north_lines:
        digits = re.findall(r'[\d,]+\.?\d*', line.replace(',', ''))
        label = re.sub(r'[\d,\.\s%]+', '', line).strip()
        if digits and label:
            nums[label] = float(digits[-1])
    
    # 如果结构化提取失败，尝试直接用关键词匹配
    if not nums:
        all_text = '\n'.join(lines)
        for kw, key in [('年度预算','年度预算_万'),('累计预算','累计预算_万'),
                         ('累计执行','累计执行_万'),('执行','累计执行_万'),
                         ('同期','同期执行_万')]:
            pattern = re.escape(kw) + r'.*?([\d,]+\.?\d*)'
            m = re.search(pattern, all_text)
            if m:
                nums[key] = float(m.group(1).replace(',',''))
    
    extracted = {
        '累计执行_万': nums.get('累计执行_万', 0),
        '年度预算_万': nums.get('年度预算_万', 0),
        '累计预算_万': nums.get('累计预算_万', 0),
        '年度完成率': nums.get('年度完成率', 0) or nums.get('完成率', 0),
        '累计完成率': nums.get('累计完成率', 0),
        '同期执行_万': nums.get('同期执行_万', 0),
        '增幅': nums.get('增幅', 0),
        '_raw_lines': north_lines[:20],
    }
    
    output = {
        '华北地区': {'回款额': extracted},
        'extractedAt': datetime.now().isoformat(),
        'date': today,
    }
    
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    filepath = os.path.join(OUTPUT_DIR, f'APH决策_每日提取_{today}.json')
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    
    print(f"📊 提取结果:")
    for k, v in extracted.items():
        if not k.startswith('_'):
            print(f"  {k}: {v}")
    print(f"\n💾 {filepath}")

# ─── 主流程 ────────────────────────────────────────────
print(f"🌐 启动无头浏览器...")
print(f"   凭据: {USERNAME}/***")

try:
    StealthyFetcher.fetch(
        FINEREPORT_ENTRY,
        headless=True,
        timeout=180000,
        network_idle=True,
        load_dom=True,
        wait=5000,
        page_action=page_action,
    )
    print("\n✅ 抓取完成")
    
    # 输出JSON到stdout供后续使用
    print("\n---RESULT---")
    print(json.dumps(extracted, ensure_ascii=False))
    
except Exception as e:
    print(f"❌ 错误: {e}")
    sys.exit(1)
