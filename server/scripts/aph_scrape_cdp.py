#!/usr/bin/env python3
"""
APH 驾驶舱数据抓取完整脚本 (Playwright connect over CDP)
抓取: 预算周报 + 回款日报 + 执行评估 → JSON + DB
"""
import asyncio, json, re, os, sqlite3
from datetime import datetime
from playwright.async_api import async_playwright

today = datetime.now().strftime('%Y-%m-%d')
COCKPIT = '/home/ubuntu/cockpit'
DB = f'{COCKPIT}/cockpit.db'

BUDGET_FR_ID = "a12f1c8c-0133-40d5-81d7-60c401aa173d"
DAILY_FR_ID  = "810ca5a0-b239-466b-85c2-386373244c8e"
EVAL_FR_ID   = "e23841f7-dceb-4118-b50e-a68cb1e0b933"

async def select_region(page):
    """Select 华北地区 in FineReport parameter panel"""
    await page.keyboard.press('Escape')
    await page.wait_for_timeout(1000)
    triggers = await page.locator('.fr-trigger-texteditor').all()
    for t in triggers:
        val = await t.input_value()
        if val and '华北' in val:
            return True  # Already selected
        if val and '地区' in val:
            await t.click()
            await page.wait_for_timeout(500)
            await t.fill('')
            await page.wait_for_timeout(300)
            await t.type('华北地区', delay=80)
            await page.wait_for_timeout(3000)
            await page.keyboard.press('Enter')
            await page.wait_for_timeout(1000)
            return True
    # Fallback: first empty
    for t in triggers:
        val = await t.input_value()
        if not val:
            await t.click()
            await page.wait_for_timeout(500)
            await t.type('华北地区', delay=80)
            await page.wait_for_timeout(3000)
            await page.keyboard.press('Enter')
            await page.wait_for_timeout(1000)
            return True
    return False

async def click_query(page):
    try:
        await page.locator('button:has-text("查询")').click(timeout=5000)
    except:
        await page.evaluate("""() => {
            for (var b of document.querySelectorAll('button')) {
                if (b.textContent.includes('查询')) { b.click(); return; }
            }
        }""")

async def wait_for_data(page, min_chars=3000, max_wait=120):
    for i in range(max_wait // 3):
        await page.wait_for_timeout(3000)
        text = await page.evaluate("document.body.innerText")
        if len(text) > min_chars:
            return text
    return await page.evaluate("document.body.innerText")

async def goto_report(page, fr_id):
    url = f"https://finereport.firstcare.com.cn/webroot/decision/v10/entry/access/{fr_id}"
    await page.goto(url, timeout=60000, wait_until="domcontentloaded")
    await page.wait_for_timeout(5000)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        page = await browser.contexts[0].new_page()

        # ===== Report 1: Budget Weekly =====
        print("📊 [1/3] 预算周报...")
        await goto_report(page, BUDGET_FR_ID)
        await select_region(page)
        await click_query(page)
        budget_text = await wait_for_data(page, min_chars=3000)

        budget_centers = {}
        for line in budget_text.split('\n'):
            if '\t' not in line: continue
            parts = line.split('\t')
            if len(parts) < 7: continue
            if '全年预算' in line or '年度预算' in line: continue
            if parts[1] != '华北地区': continue
            center = parts[2].strip()
            try:
                annual = round(float(parts[4].replace(',','')) / 10000, 2)
                cum_b = round(float(parts[5].replace(',','')) / 10000, 2)
            except: continue
            if annual <= 0: continue
            if center in budget_centers:
                budget_centers[center]['annual_budget'] += annual
                budget_centers[center]['cumulative_budget'] += cum_b
            else:
                budget_centers[center] = {'annual_budget': annual, 'cumulative_budget': cum_b}

        total_annual = round(sum(v['annual_budget'] for v in budget_centers.values()), 2)
        total_cum_budget = round(sum(v['cumulative_budget'] for v in budget_centers.values()), 2)
        print(f"  ✅ {len(budget_centers)} centers, 年度预算={total_annual}万, 累计预算={total_cum_budget}万")

        # ===== Report 2: Daily Report =====
        print("📊 [2/3] 回款日报...")
        await goto_report(page, DAILY_FR_ID)
        await select_region(page)
        await click_query(page)
        daily_text = await wait_for_data(page, min_chars=5000, max_wait=120)

        m = re.search(r'累计执行([\d,]+\.?\d*)万', daily_text)
        cumulative_executed = float(m.group(1).replace(',','')) if m else 0
        m = re.search(r'本日回款总额([\d,]+\.?\d*)万元', daily_text)
        daily_collection = float(m.group(1).replace(',','')) if m else 0

        daily_centers = []
        lines = daily_text.split('\n')
        current_center = ''
        in_header = True
        for line in lines:
            stripped = line.strip()
            if in_header:
                if '累计完成率' in stripped: in_header = False
                continue
            if not stripped: continue
            if line.startswith('\t') and current_center:
                parts = [p.strip() for p in line.split('\t') if p.strip()]
                if len(parts) >= 7 and re.match(r'\d+%', parts[0]):
                    try:
                        daily_centers.append({
                            'center': current_center,
                            'cumulative_budget': float(parts[1].replace(',','')),
                            'cumulative_executed': float(parts[2].replace(',','')),
                            'daily': float(parts[6].replace(',','')),
                        })
                    except: pass
                    current_center = ''
            elif ('第一服务' in stripped or '第一酒店' in stripped or '华北第一保洁' in stripped) and '各服务中心' not in stripped:
                current_center = stripped

        print(f"  ✅ {len(daily_centers)} centers, 累计执行={cumulative_executed}万, 本日回款={daily_collection}万")

        # ===== Report 3: Execution Evaluation =====
        print("📊 [3/3] 执行评估...")
        await goto_report(page, EVAL_FR_ID)
        eval_text = await wait_for_data(page, min_chars=500, max_wait=60)

        north_kpi = {}
        # Parse evaluation report for North China KPI
        body = eval_text
        # Find "华北地区" section
        for kw, key in [('年度预算', 'annual_budget'), ('累计预算', 'cumulative_budget'),
                         ('累计执行', 'cumulative_executed'), ('同期执行', 'same_period'),
                         ('增幅', 'growth'), ('年度完成率', 'annual_rate'),
                         ('累计完成率', 'cumulative_rate')]:
            pattern = re.escape(kw) + r'.*?([\d,]+\.?\d*)'
            m = re.search(pattern, body)
            if m and not north_kpi.get(key):
                val = float(m.group(1).replace(',',''))
                if key in ('annual_rate', 'cumulative_rate', 'growth'):
                    north_kpi[key] = val
                else:
                    north_kpi[key] = val

        print(f"  ✅ Eval KPI: {json.dumps(north_kpi, ensure_ascii=False)[:200]}")

        # ===== Save Results =====
        summary = {
            '华北地区': {'回款额': {
                '年度预算_万': total_annual,
                '累计预算_万': total_cum_budget,
                '累计执行_万': cumulative_executed,
                '本日回款_万': daily_collection,
                '同期执行_万': north_kpi.get('same_period', 0),
                '年度完成率': north_kpi.get('annual_rate', 0),
                '累计完成率': north_kpi.get('cumulative_rate', 0),
                '增幅': north_kpi.get('growth', 0),
            }},
            'extractedAt': datetime.now().isoformat(),
            'date': today,
            'centers': len(daily_centers),
        }

        os.makedirs(f'{COCKPIT}/runtime', exist_ok=True)
        output_path = f'{COCKPIT}/APH决策_每日提取_{today}.json'
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)

        # ===== Write to DB =====
        conn = sqlite3.connect(DB)
        conn.execute('PRAGMA journal_mode=WAL')

        # Write daily_snapshots
        daily_map = {dc['center']: dc for dc in daily_centers}
        with conn:
            for dc in daily_centers:
                center = dc['center']
                ab = budget_centers.get(center, {}).get('annual_budget', 0)
                conn.execute('''INSERT OR REPLACE INTO daily_snapshots
                    (date, center, annual_budget, cumulative_budget, cumulative_executed, daily_collection,
                     quality_status, source, source_status, business_date, last_validated_at, field_provenance)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',
                    (today, center, ab, dc['cumulative_budget'], dc['cumulative_executed'],
                     dc['daily'], 'verified', 'Playwright-CDP自动抓取', 'available',
                     today, datetime.now().isoformat(), '{}'))

        # Update payment_centers summary
        if len(daily_centers) >= 40 and total_annual >= 20000:
            conn.execute('DELETE FROM payment_centers')
            for dc in daily_centers:
                ab = budget_centers.get(dc['center'], {}).get('annual_budget', 0)
                conn.execute('''INSERT INTO payment_centers
                    (area, center, annual_budget, cumulative_budget, cumulative_executed)
                    VALUES (?,?,?,?,?)''',
                    ('华北地区', dc['center'], ab, dc['cumulative_budget'], dc['cumulative_executed']))

        conn.commit()
        conn.close()

        # Update last_sync
        import time
        with open(f'{COCKPIT}/.last_sync', 'w') as f:
            f.write(str(int(time.time() * 1000)))

        # ===== Summary =====
        print(f"\n{'='*60}")
        print(f"✅ APH数据抓取完成!")
        print(f"   年度预算: {total_annual:.2f}万")
        print(f"   累计预算: {total_cum_budget:.2f}万")
        print(f"   累计执行: {cumulative_executed:.2f}万")
        print(f"   本日回款: {daily_collection:.2f}万")
        print(f"   预算中心: {len(budget_centers)} 个")
        print(f"   日报中心: {len(daily_centers)} 个")
        print(f"   输出文件: {output_path}")
        print(f"   数据库: {DB}")
        print(f"{'='*60}")

        await browser.close()

asyncio.run(main())
