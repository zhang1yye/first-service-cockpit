"""每日自动: 预算周报(年度/累计预算) + 日报(KPI+日回款) + 执行评估(明细) → cockpit.db"""
import glob, json, os, re, sqlite3
from datetime import datetime
from playwright.sync_api import sync_playwright
from finereport_daily import DAILY_NORTH_TITLE, is_daily_body_ready
from finereport_eval import parse_region_kpi, is_growth_consistent, reconcile_rounded_card_precision

USER = os.environ.get('APH_USER')
PWD = os.environ.get('APH_PWD')
if not USER or not PWD:
    raise SystemExit('缺少 APH_USER/APH_PWD 环境变量，拒绝使用明文凭据')
today = datetime.now().strftime('%Y-%m-%d')
DB = os.environ.get(
    'COCKPIT_DB_PATH',
    os.path.join(os.path.dirname(__file__), '..', 'cockpit.db'),
)

BUDGET_FR_ID = "a12f1c8c-0133-40d5-81d7-60c401aa173d"
DAILY_FR_ID  = "810ca5a0-b239-466b-85c2-386373244c8e"
EVAL_FR_ID   = "e23841f7-dceb-4118-b50e-a68cb1e0b933"

aph_summary = {}
daily_centers = []       # {center, cumulative_executed, cumulative_budget, daily}
budget_centers = {}      # center → {annual_budget, cumulative_budget}
detail_centers = []      # {center, area, annual_budget, same_period, ...}

def chromium_executable():
    """Use a verified system/agent-browser Chromium when Playwright's bundle is absent."""
    candidates = [
        os.environ.get('CHROME_BIN'),
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        *sorted(glob.glob(os.path.expanduser('~/.cache/agent-browser/chrome/*/chrome-linux64/chrome')), reverse=True),
    ]
    return next((path for path in candidates if path and os.path.isfile(path)), None)

def set_area_select(page):
    """选择华北地区(FineReport参数面板)"""
    page.keyboard.press('Escape')  # 关闭可能的弹窗
    page.wait_for_timeout(1000)
    triggers = page.locator('.fr-trigger-texteditor').all()
    for t in triggers:
        val = t.input_value()
        if val and ('地区' in val or val.endswith('区')):
            t.click()
            page.wait_for_timeout(500)
            t.fill('')           # 清空，不能用 Meta+A
            page.wait_for_timeout(300)
            t.type('华北地区', delay=80)
            page.wait_for_timeout(3000)
            page.keyboard.press('Enter')
            page.wait_for_timeout(1000)
            return
    # fallback: 空输入框
    for t in triggers:
        if not t.input_value():
            t.click(); page.wait_for_timeout(500)
            t.type('华北地区', delay=80); page.wait_for_timeout(3000)
            page.keyboard.press('Enter'); page.wait_for_timeout(1000)
            return

def click_query(page):
    """点击查询按钮,JS兜底"""
    try:
        page.locator('button:has-text("查询")').click(timeout=5000)
    except:
        page.evaluate("""() => {
            for (var b of document.querySelectorAll('button')) {
                if (b.textContent.includes('查询')) { b.click(); return; }
            }
        }""")

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
    page = browser.contexts[0].new_page()

    # ─── 登录 ───
    page.goto("https://aph.firstcare.com.cn/", timeout=60000)
    page.wait_for_timeout(3000)
    if 'sso' in page.url or 'login' in page.url:
        page.fill('input[name="username"]', USER)
        page.fill('input[name="password"]', PWD)
        page.locator('#loginBtn').first.click()
        page.wait_for_timeout(6000)

    # ════════════════════════════════════════════════════════
    # 报表1: 预算周报 → 年度预算 + 累计预算 per-center
    # ════════════════════════════════════════════════════════
    print("📊 预算周报...")
    page.goto(f"https://finereport.firstcare.com.cn/webroot/decision/v10/entry/access/{BUDGET_FR_ID}", timeout=60000)
    page.wait_for_timeout(8000)

    set_area_select(page)
    click_query(page)
    print("  查询中...")
    for i in range(30):
        page.wait_for_timeout(3000)
        body = page.locator('body').inner_text() or ''
        if len(body) > 5000: break

    body = page.locator('body').inner_text() or ''
    lines = body.split('\n')
    for line in lines:
        if '\t' not in line: continue
        parts = line.split('\t')
        if len(parts) < 7: continue
        # Header: 业务单元 地区 项目名称 项目编码 全年预算 累计预算 执行合计
        if '全年预算' in line: continue
        if parts[1] != '华北地区': continue
        center = parts[2].strip()
        try:
            annual = round(float(parts[4].replace(',','')) / 10000, 2)   # 元→万元
            cum_budget = round(float(parts[5].replace(',','')) / 10000, 2)
        except: continue
        if annual <= 0: continue
        # Multiple projects per center → SUM
        if center in budget_centers:
            budget_centers[center]['annual_budget'] += annual
            budget_centers[center]['cumulative_budget'] += cum_budget
        else:
            budget_centers[center] = {'annual_budget': annual, 'cumulative_budget': cum_budget}
    # Compute 华北 total
    total_annual = sum(v['annual_budget'] for v in budget_centers.values())
    total_cum_budget = sum(v['cumulative_budget'] for v in budget_centers.values())
    aph_summary['年度预算_万'] = round(total_annual, 2)
    aph_summary['累计预算_万'] = round(total_cum_budget, 2)
    print(f"  预算周报: {len(budget_centers)} 中心, 年度预算={total_annual:.2f}万, 累计预算={total_cum_budget:.2f}万")

    # ════════════════════════════════════════════════════════
    # 报表2: 计划预算回款日报 → KPI + 日回款
    # ════════════════════════════════════════════════════════
    print("📊 日报...")
    page.goto(f"https://finereport.firstcare.com.cn/webroot/decision/v10/entry/access/{DAILY_FR_ID}", timeout=60000)
    page.wait_for_timeout(8000)

    set_area_select(page)
    click_query(page)
    print("  查询中...")
    # 轮询等待：点击查询后，FineReport 会先保留旧地区数据，再经历空白阶段，
    # 最后才渲染华北数据。参数输入框本身也含“华北地区”，不能用泛化关键词判定。
    max_wait = 120
    poll_interval = 5
    waited = 0
    retried = False
    daily_ready = False
    body = ''
    while waited < max_wait:
        page.wait_for_timeout(poll_interval * 1000)
        waited += poll_interval
        body = page.locator('body').inner_text() or ''
        if is_daily_body_ready(body):
            print(f"  数据就绪 ({waited}s, {len(body)}chars)")
            daily_ready = True
            break
        # 参数面板/加载中；15秒后允许重试一次。重试必须位于 continue 之前。
        if len(body) < 500:
            if waited >= 15 and not retried:
                print(f"  报表未渲染({len(body)}chars), 重试查询...")
                click_query(page)
                retried = True
            continue
    if not daily_ready:
        raise SystemExit(
            f"日报等待{max_wait}s仍未出现华北报表标题或完整中心数据"
            f"（body={len(body)}chars，期望标题={DAILY_NORTH_TITLE}）；拒绝写库"
        )
    m = re.search(r'累计执行([\d,]+\.?\d*)万', body)
    if m: aph_summary['累计执行_万'] = float(m.group(1).replace(',',''))
    m = re.search(r'本日回款总额([\d,]+\.?\d*)万元', body)
    if m: aph_summary['本日回款_万'] = float(m.group(1).replace(',',''))
    print(f"  KPI: 执行={aph_summary.get('累计执行_万')} 日回款={aph_summary.get('本日回款_万')}")

    # Parse daily center data
    lines = body.split('\n')
    current_center, current_area, in_header = '', '', True
    for line in lines:
        stripped = line.strip()
        if in_header:
            if '累计完成率' in stripped and '累计预算' in stripped: in_header = False
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
        elif ('第一服务' in stripped or '第一酒店' in stripped or '华北第一保洁' in stripped or '北京通州区' in stripped) and '各服务中心' not in stripped:
            current_center = stripped
        elif stripped.endswith('片区') and not stripped.startswith('\t'):
            current_area = stripped
        elif not stripped.startswith('\t') and '累计完成率' not in stripped and '本日回款' not in stripped and '战区排名' not in stripped and '组织蝶变' not in stripped:
            # Catch other center names (e.g. 单体/撤场项目 labels come from bottom table)
            if re.search(r'[服务|中心|公司|酒店|保洁]', stripped) and len(stripped) > 4:
                current_center = stripped
    print(f"  中心: {len(daily_centers)} 个")
    if len(daily_centers) < 40:
        raise SystemExit(f'日报明细只有 {len(daily_centers)} 条，低于安全阈值40；拒绝写库')

    # ════════════════════════════════════════════════════════
    # 报表3: 回款额执行评估 → 明细 (same_period等)
    # ════════════════════════════════════════════════════════
    print("📊 执行评估...")
    page.goto(f"https://finereport.firstcare.com.cn/webroot/decision/v10/entry/access/{EVAL_FR_ID}", timeout=60000)
    for i in range(20):
        page.wait_for_timeout(2000)
        body = page.locator('body').inner_text() or ''
        if '预算' in body and len(body) > 500: break

    # 按华北地区卡片的字段标签精确解析，禁止用数值区间猜测或跨到下一地区取数。
    north_kpi = parse_region_kpi(body, '华北地区')
    if not north_kpi:
        raise SystemExit('执行评估华北地区KPI解析失败；拒绝写库')
    if not is_growth_consistent(north_kpi):
        raise SystemExit(
            '执行评估同期执行与增幅不勾稽；拒绝写库: '
            f"累计执行={north_kpi['cumulative_executed']}, "
            f"同期执行={north_kpi['same_period']}, 增幅={north_kpi['growth']}%"
        )
    # 首页正式汇总必须完整来自同一张FineReport华北地区卡片。
    # 预算周报和中心钻取明细只用于勾稽，禁止与卡片字段拼接成“混合汇总”。
    aph_summary['年度预算_万'] = north_kpi['annual_budget']
    aph_summary['累计预算_万'] = north_kpi['cumulative_budget']
    aph_summary['累计执行_万'] = north_kpi['cumulative_executed']
    aph_summary['同期执行_万'] = north_kpi['same_period']
    aph_summary['年度完成率'] = north_kpi['annual_rate']
    aph_summary['累计完成率'] = north_kpi['cumulative_rate']
    aph_summary['增幅'] = north_kpi['growth']
    print(
        '  补充: '
        f"同期执行={north_kpi['same_period']}, 增幅={north_kpi['growth']}%（勾稽通过）"
    )

    # 钻取华北明细
    page.evaluate("""() => {
        const spans = document.querySelectorAll('.linkspan');
        for (const s of spans) { if (s.textContent?.trim()==='华北地区') { s.click(); return; } }
        for (const td of document.querySelectorAll('td')) {
            if (td.textContent?.trim()==='华北地区') { td.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return; }
        }
    }""")
    page.wait_for_timeout(10000)

    body = page.frames[1].locator('body').inner_text() if len(page.frames)>=2 else ''
    if body:
        data_lines = []
        for l in body.split('\n'):
            l = l.strip()
            if not l or any(l.startswith(kw) for kw in ['业务','年度','累计','同期','增幅']): continue
            if l in ('预算','执行','完成率','累计执行','名称'): continue
            data_lines.append(l)
        i = 0
        while i < len(data_lines):
            name = data_lines[i]
            if re.match(r'^[\d,]+\.?\d*%?$', name.replace(',','')): i+=1; continue
            nums = []
            j = i+1
            while j < len(data_lines) and j < i+10:
                try: nums.append(float(data_lines[j].replace(',','').replace('%','')))
                except: pass
                j+=1
            if len(nums) >= 5:
                detail_centers.append({
                    'center': name,
                    'annual_budget': nums[0],
                    'cumulative_budget': nums[1],
                    'cumulative_executed': nums[2],
                    'annual_rate': nums[3],
                    'cumulative_rate': nums[4],
                    'same_period': nums[5] if len(nums)>5 else None,
                    'growth': nums[8] if len(nums)>8 else None,
                })
            i = j if j>i+1 else i+1
    print(f"  中心: {len(detail_centers)} 个")
    browser.close()

# ==================== 数据合并 ====================
# 优先级: 预算周报 > 日报 > 执行评估
daily_map = {dc['center']: dc for dc in daily_centers}

for dc in detail_centers:
    name = dc['center']
    # 年度预算: 预算周报
    if name in budget_centers:
        dc['annual_budget'] = budget_centers[name]['annual_budget']
    # 累计预算: 日报 > 预算周报 > 执行评估
    if name in daily_map:
        dc['cumulative_budget'] = daily_map[name]['cumulative_budget']
    elif name in budget_centers:
        dc['cumulative_budget'] = budget_centers[name]['cumulative_budget']
    # 累计执行: 日报 > 执行评估
    if name in daily_map:
        dc['cumulative_executed'] = daily_map[name]['cumulative_executed']

print(f"合并: 预算周报{len(budget_centers)} + 日报{len(daily_centers)} + 执行评估{len(detail_centers)}")

# 华北卡片解析失败时前面已经拒绝写库，禁止再用中心明细合计静默替代汇总口径。

# ==================== 服务中心合并 ====================
MERGE_GROUPS = [
    (['第一服务北京满庭芳园服务中心', '第一服务北京青云大厦服务中心'], '第一服务满庭青云服务中心', '海淀片区'),
    (['第一服务北京西山上品湾MOMΛ服务中心', '第一服务北京西山上品湾二期MOMΛ服务中心'], '第一服务北京西山上品湾MOMΛ服务中心', '海淀片区'),
    (['第一服务北京上第MOMΛ服务中心', '第一服务北京IMOMΛ服务中心', '第一服务北京悦MOMΛ服务中心'], '第一服务北京上第MOMΛ服务中心', '海淀片区'),
    (['第一服务北京MOMΛ万万树服务中心一期', '第一服务北京MOMΛ万万树服务中心二期'], '第一服务北京MOMΛ万万树服务中心', '顺平片区'),
]
for srcs, target, area in MERGE_GROUPS:
    # detail_centers 合并
    merged = None
    for src in srcs:
        match = next((d for d in detail_centers if d['center'] == src), None)
        if match:
            if merged is None:
                merged = match.copy(); merged['center'] = target
            else:
                for k in ['annual_budget','cumulative_budget','cumulative_executed','same_period']:
                    left, right = merged.get(k), match.get(k)
                    merged[k] = left + right if left is not None and right is not None else None
                left_rate, right_rate = merged.get('annual_rate'), match.get('annual_rate')
                merged['annual_rate'] = (left_rate + right_rate) / 2 if left_rate is not None and right_rate is not None else None
                budget, executed = merged.get('cumulative_budget'), merged.get('cumulative_executed')
                merged['cumulative_rate'] = executed / budget * 100 if budget not in (None, 0) and executed is not None else None
    if merged:
        detail_centers = [d for d in detail_centers if d['center'] not in srcs]
        detail_centers.append(merged)
    # daily_centers 合并
    d_merged = None
    for src in srcs:
        match = next((d for d in daily_centers if d['center'] == src), None)
        if match:
            if d_merged is None:
                d_merged = {**match, 'center': target}
            else:
                for key in ['cumulative_budget', 'cumulative_executed', 'daily']:
                    left, right = d_merged.get(key), match.get(key)
                    d_merged[key] = left + right if left is not None and right is not None else None
    if d_merged is not None:
        daily_centers = [d for d in daily_centers if d['center'] not in srcs]
        daily_centers.append(d_merged)
    # budget_centers 合并
    b_merged = None
    for src in srcs:
        if src in budget_centers:
            match = budget_centers[src]
            if b_merged is None:
                b_merged = dict(match)
            else:
                for key in ['annual_budget', 'cumulative_budget']:
                    left, right = b_merged.get(key), match.get(key)
                    b_merged[key] = left + right if left is not None and right is not None else None
            del budget_centers[src]
    if b_merged is not None:
        budget_centers[target] = b_merged
        print(f"  合并: {' + '.join(srcs)} → {target}")

# ==================== 写入 DB ====================
conn = sqlite3.connect(DB)
conn.execute('PRAGMA journal_mode=WAL')
payment_schema = {row[1]: row for row in conn.execute('PRAGMA table_info(payment_centers)')}
if payment_schema.get('same_period', (None, None, None, 0))[3] or payment_schema.get('collection_rate', (None, None, None, 0))[3]:
    with conn:
        conn.execute('''CREATE TABLE payment_centers_truthful (
            id INTEGER PRIMARY KEY AUTOINCREMENT, area TEXT NOT NULL, center TEXT NOT NULL,
            annual_budget REAL NOT NULL, cumulative_budget REAL NOT NULL, cumulative_executed REAL NOT NULL,
            same_period REAL, collection_rate REAL)''')
        conn.execute('''INSERT INTO payment_centers_truthful
            SELECT id,area,center,annual_budget,cumulative_budget,cumulative_executed,
              CASE WHEN same_period=0 THEN NULL ELSE same_period END,
              CASE WHEN collection_rate=0 THEN NULL ELSE collection_rate END
            FROM payment_centers''')
        conn.execute('DROP TABLE payment_centers')
        conn.execute('ALTER TABLE payment_centers_truthful RENAME TO payment_centers')

# ==================== 服务中心→片区 精确匹配表 ====================
CENTER_AREA_MAP = {
    '第一服务北京万国城MOMΛ服务中心': '朝阳片区',
    '第一服务北京当代MOMΛ服务中心': '顺平片区',
    '第一服务北京上第MOMΛ服务中心': '海淀片区',
    '第一服务北京通州万国城MOMΛ服务中心': '京东片区',
    '第一服务北京采育满庭春MOMΛ服务中心': '京东片区',
    '第一服务北京朝阳旺座服务中心': '朝阳片区',
    '华北第一保洁': '华北第一保洁',
    '第一服务北京满庭青云服务中心': '海淀片区',
    '第一服务东戴河·白金海MOMΛ服务中心': '辽宁片区',
    '第一服务北京清缘东里服务中心': '海淀片区',
    '第一服务葫芦岛首创·象墅服务中心': '辽宁片区',
    '第一服务天津中信珺台服务中心': '京东片区',
    '北京通州区综合检查站服务中心': '京东片区',
    '第一服务北京MOMΛ万万树服务中心': '顺平片区',
    '第一服务满庭青云服务中心': '海淀片区',
    '第一服务北京西山上品湾MOMΛ服务中心': '海淀片区',
    '第一服务北京上第MOMΛ服务中心': '海淀片区',
    '第一服务营口林昌天铂服务中心': '辽宁片区',
    '第一服务北京国融国际服务中心': '京东片区',
    '第一服务营口恒大城服务中心': '辽宁片区',
    '第一服务北京西山御园服务中心': '海淀片区',
    '第一服务营口东城天下服务中心': '辽宁片区',
    '第一服务北京旭辉墅服务中心': '顺平片区',
    '第一服务北京嘉润花园服务中心': '朝阳片区',
    '第一服务保定中尚泊心湾服务中心': '河北片区',
    '第一服务张家口垣著MOMΛ服务中心': '河北片区',
    '第一服务葫芦岛龙港区公共行政服务中心': '辽宁片区',
    '第一服务营口天铂院子服务中心': '辽宁片区',
    '第一服务营口第五郡服务中心': '辽宁片区',
    '第一服务北京景龙国际名苑服务中心': '朝阳片区',
    '第一服务葫芦岛龙港区政府行政管理服务中心': '辽宁片区',
    '第一服务张家口金悦广场服务中心': '河北片区',
    '第一服务天津名郡大厦服务中心': '京东片区',
    '第一服务营口天铂瑞府服务中心': '辽宁片区',
    '第一服务北京丽喜南苑服务中心': '顺平片区',
    '第一服务北京裕瑞轩服务中心': '朝阳片区',
    '第一服务北京中行项目部服务中心': '朝阳片区',
    '第一服务张家口垣郡MOMΛ服务中心': '河北片区',
    '第一服务营口经典名郡服务中心': '辽宁片区',
    '第一服务北京品驰医疗亦庄开发区产业园服务中心': '已撤场项目',
    '第一服务石家庄当代府MOMΛ服务中心': '河北片区',
    '第一服务北京工业大学通州校区服务中心': '京东片区',
    '第一服务北京品驰医疗服务中心': '华北第一保洁',
    '第一服务北京悦MOMΛ服务中心': '海淀片区',
    '第一服务营口林昌天奕服务中心': '辽宁片区',
    '第一服务营口林昌天铂体验中心': '辽宁片区',
    '第一服务华北地区公司': '华北地区公司',
    '第一服务天津公园阅MOMΛ服务中心': '已撤场项目',
    '第一酒店保定易县·中尚泊心湾体验中心': '已撤场项目',
    '第一服务北京西山上品湾MOMΛ服务中心': '海淀片区',
    '第一服务北京清华大学液晶大厦服务中心': '已撤场项目',
    '第一酒店北京西山当代上品湾MOMΛ体验中心': '已撤场项目',
    '第一酒店北京当代通州万国城MOMΛ体验中心': '已撤场项目',
    '第一酒店天津公园阅MOMΛ体验中心': '已撤场项目',
    '第一酒店张家口垣郡MOMΛ体验中心': '已撤场项目',
    '第一酒店东戴河白金海MOMΛ体验中心': '已撤场项目',
    '第一酒店廊坊图书文化交易中心体验中心': '已撤场项目',
    '第一酒店青岛新基业当代阅MOMΛ体验中心': '已撤场项目',
    '第一酒店石家庄当代境MOMΛ体验中心': '已撤场项目',
    '第一服务北京顺义悦MOMΛ服务中心': '已撤场项目',
}


def assign_area(name):
    area = CENTER_AREA_MAP.get(name)
    if not area:
        raise SystemExit(f'服务中心缺少片区映射：{name}；拒绝覆盖 payment_centers')
    return area

if len(detail_centers) < 40:
    raise SystemExit(f'执行评估明细只有 {len(detail_centers)} 条，低于安全阈值40；拒绝清空 payment_centers')
if aph_summary.get('年度预算_万', 0) < 20000:
    raise SystemExit(f"年度预算异常: {aph_summary.get('年度预算_万', 0)}；拒绝写库")

inserted = 0
with conn:
    conn.execute('DELETE FROM payment_centers')
    for c in detail_centers:
        area = assign_area(c['center'])
        conn.execute(
            'INSERT INTO payment_centers (area, center, annual_budget, cumulative_budget, cumulative_executed, same_period, collection_rate) VALUES (?,?,?,?,?,?,?)',
            (area, c['center'], c['annual_budget'], c['cumulative_budget'],
             c['cumulative_executed'], c['same_period'],
             round(c['cumulative_rate']/100, 3) if c['cumulative_rate'] is not None else None))
        inserted += 1
print(f"💾 payment_centers: {inserted} 条")

# 只删当天，保留历史
conn.execute('DELETE FROM daily_snapshots WHERE date = ?', (today,))
# 同步脚本可独立运行，必须自行确保快照真实性与血缘列存在；旧行默认未验证。
snapshot_columns = {row[1] for row in conn.execute('PRAGMA table_info(daily_snapshots)')}
for name, definition in {
    'daily_collection': 'REAL',
    'quality_status': "TEXT NOT NULL DEFAULT 'unverified'",
    'quality_reason': "TEXT DEFAULT '历史记录缺少可验证来源与字段血缘'",
    'source': "TEXT DEFAULT ''",
    'source_status': "TEXT DEFAULT 'unverified'",
    'business_date': 'TEXT',
    'last_validated_at': 'TEXT',
    'field_provenance': "TEXT DEFAULT '{}'",
}.items():
    if name not in snapshot_columns:
        conn.execute(f'ALTER TABLE daily_snapshots ADD COLUMN {name} {definition}')
# 快照中的年度预算必须随服务中心写入，不能固定为 0。
annual_budget_by_center = {c['center']: c.get('annual_budget') for c in detail_centers}
missing_annual = [dc['center'] for dc in daily_centers if annual_budget_by_center.get(dc['center']) is None]
if missing_annual:
    raise SystemExit(f'日报中心缺少已验证年度预算：{missing_annual[:10]}；拒绝写入快照')
validated_at = datetime.now().isoformat(timespec='seconds')
for dc in daily_centers:
    values = [annual_budget_by_center[dc['center']], dc['cumulative_budget'], dc['cumulative_executed'], dc['daily']]
    negative_fields = [name for name, value in zip(
        ['annual_budget', 'cumulative_budget', 'cumulative_executed', 'daily_collection'], values
    ) if value is not None and value < 0]
    # 质量状态表示“来源是否可验证”，不是“业务数值是否为正”。
    # FineReport原始负数可能是冲销/退款：必须保留原值、标记业务告警，但不能改0或伪装成来源不可信。
    quality_status = 'verified'
    quality_reason = '' if not negative_fields else f"来源已验证；负数业务异常待复核：{','.join(negative_fields)}"
    field_provenance = json.dumps({
        'annual_budget': {'report': '预算周报', 'label': '全年预算', 'region': '华北地区'},
        'cumulative_budget': {'report': DAILY_NORTH_TITLE, 'label': '累计预算', 'region': '华北地区'},
        'cumulative_executed': {'report': DAILY_NORTH_TITLE, 'label': '累计执行', 'region': '华北地区'},
        'daily_collection': {'report': DAILY_NORTH_TITLE, 'label': '本日回款', 'region': '华北地区'},
    }, ensure_ascii=False)
    conn.execute(
        '''INSERT OR REPLACE INTO daily_snapshots
        (date, center, annual_budget, cumulative_budget, cumulative_executed, daily_collection,
         quality_status, quality_reason, source, source_status, business_date, last_validated_at, field_provenance)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        (today, dc['center'], *values, quality_status, quality_reason,
         'FineReport预算周报+回款日报+执行评估中心明细', 'available', today, validated_at, field_provenance))
conn.commit()
print(f"📸 daily_snapshots: {len(daily_centers)} 条")

conn.close()

outdir = os.environ.get('COCKPIT_DATA_DIR', os.path.expanduser('~/Desktop/绿仔数据'))
os.makedirs(outdir, exist_ok=True)

def numeric_total(rows, field):
    values = [row.get(field) for row in rows]
    present = [value for value in values if value is not None]
    return round(sum(present), 2) if present else None

def reconciliation(left_source, left_value, right_source, right_value, warn_rate=0.01):
    if left_value is None or right_value is None:
        return {
            'leftSource': left_source, 'leftValue': left_value,
            'rightSource': right_source, 'rightValue': right_value,
            'difference': None, 'differenceRate': None, 'status': 'unavailable',
        }
    difference = round(right_value - left_value, 2)
    difference_rate = round(abs(difference) / abs(left_value), 6) if left_value else None
    return {
        'leftSource': left_source, 'leftValue': left_value,
        'rightSource': right_source, 'rightValue': right_value,
        'difference': difference, 'differenceRate': difference_rate,
        'status': 'warning' if difference_rate is None or difference_rate > warn_rate else 'matched',
    }

center_detail_totals = {
    'annualBudget': numeric_total(detail_centers, 'annual_budget'),
    'cumulativeBudget': numeric_total(detail_centers, 'cumulative_budget'),
    'cumulativeExecuted': numeric_total(detail_centers, 'cumulative_executed'),
    'samePeriod': numeric_total(detail_centers, 'same_period'),
    'samePeriodPresentCount': sum(1 for row in detail_centers if row.get('same_period') is not None),
    'samePeriodMissingCount': sum(1 for row in detail_centers if row.get('same_period') is None),
    'centerCount': len(detail_centers),
}
budget_weekly_totals = {
    'annualBudget': round(sum(v.get('annual_budget') or 0 for v in budget_centers.values()), 2),
    'cumulativeBudget': round(sum(v.get('cumulative_budget') or 0 for v in budget_centers.values()), 2),
    'centerCount': len(budget_centers),
}
region_card_values = {
    'annualBudget': aph_summary.get('年度预算_万'),
    'cumulativeBudget': aph_summary.get('累计预算_万'),
    'cumulativeExecuted': aph_summary.get('累计执行_万'),
    'samePeriod': aph_summary.get('同期执行_万'),
    'growthPercent': aph_summary.get('增幅'),
}
precision_candidates = {
    'annualBudget': ('年度预算_万', budget_weekly_totals['annualBudget'], 'budgetWeekly'),
    'cumulativeBudget': ('累计预算_万', center_detail_totals['cumulativeBudget'], 'centerDetail'),
    'cumulativeExecuted': ('累计执行_万', center_detail_totals['cumulativeExecuted'], 'centerDetail'),
    'samePeriod': ('同期执行_万', center_detail_totals['samePeriod'], 'centerDetail'),
}
precision_reconciliation = {}
for metric, (summary_key, candidate, candidate_source) in precision_candidates.items():
    card_value = region_card_values[metric]
    refined = reconcile_rounded_card_precision(card_value, candidate)
    enriched = refined != card_value
    if enriched:
        aph_summary[summary_key] = refined
    precision_reconciliation[metric] = {
        'cardValue': card_value,
        'candidateValue': candidate,
        'candidateSource': candidate_source,
        'publishedValue': refined,
        'status': 'precision-enriched' if enriched else 'card-value-retained',
    }
source_layers = {
    'regionCard': {
        'source': 'FineReport回款额执行评估·华北地区卡片',
        'businessDate': today,
        'values': region_card_values,
    },
    'budgetWeekly': {
        'source': 'FineReport业务单元预算周报·华北地区',
        'businessDate': today,
        'values': budget_weekly_totals,
    },
    'centerDetail': {
        'source': 'FineReport日报+预算周报+执行评估中心明细',
        'businessDate': today,
        'values': center_detail_totals,
    },
    'precisionReconciliation': {
        'source': 'FineReport卡片整数值与同口径明细合计勾稽',
        'businessDate': today,
        'values': precision_reconciliation,
    },
}
reconciliations = {
    'annualBudgetCardVsWeekly': reconciliation(
        'regionCard', region_card_values['annualBudget'],
        'budgetWeekly', budget_weekly_totals['annualBudget']),
    'annualBudgetCardVsCenterDetail': reconciliation(
        'regionCard', region_card_values['annualBudget'],
        'centerDetail', center_detail_totals['annualBudget']),
    'samePeriodCardVsCenterDetail': reconciliation(
        'regionCard', region_card_values['samePeriod'],
        'centerDetail', center_detail_totals['samePeriod']),
}
output = {
    '华北地区': {'回款额': aph_summary},
    'extractedAt': validated_at,
    'date': today,
    'businessDate': today,
    'sourceStatus': 'available',
    'lastValidatedAt': validated_at,
    'source': 'FineReport回款额执行评估·华北地区卡片（中心明细同整数位精度勾稽）',
    'sourceLayers': source_layers,
    'reconciliations': reconciliations,
    'fieldProvenance': {
        '年度预算_万': '华北地区卡片/年度预算',
        '累计预算_万': '华北地区卡片/累计预算；中心明细合计四舍五入一致时补足小数精度',
        '累计执行_万': '华北地区卡片/累计执行；中心明细合计四舍五入一致时补足小数精度',
        '同期执行_万': '华北地区卡片/同期执行',
        '增幅': '华北地区卡片/增幅并经公式勾稽',
    },
}
with open(os.path.join(outdir, f'APH决策_每日提取_{today}.json'), 'w', encoding='utf-8') as f:
    json.dump(output, f, ensure_ascii=False, indent=2)
with open(os.path.join(outdir, f'回款额明细_{today}.json'), 'w', encoding='utf-8') as f:
    json.dump(detail_centers, f, ensure_ascii=False, indent=2)

print(f"📊 年度预算={aph_summary.get('年度预算_万',0)} 累计预算={aph_summary.get('累计预算_万',0)} 累计执行={aph_summary.get('累计执行_万',0)}")
print("✅ 完成")
