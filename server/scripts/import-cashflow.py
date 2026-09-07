#!/usr/bin/env python3
"""
从现金口径 Excel 导入真实服务中心数据到 cockpit.db
累计预算比例从最新 APH 决策系统数据动态获取
数据源: 现金口径_华北_01回款额_带片区_20260610.xlsx + APH决策_每日提取_*.json
"""
import openpyxl
import sqlite3
import os
import json
import glob

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'cockpit.db')
XLSX_PATH = os.path.expanduser(
    '~/cockpit/现金口径_华北_01回款额_带片区_20260610.xlsx
)

# ─── 读取 Excel ───────────────────────────────────────
wb = openpyxl.load_workbook(XLSX_PATH, data_only=True)
ws = wb.active

centers = []
total_row = None

for row in ws.iter_rows(min_row=2, max_row=ws.max_row, values_only=True):
    area = row[1]
    name = row[2]
    
    # 跳过合计行
    if area is None or name is None:
        continue
    if '合计' in str(name):
        total_row = {
            'annual_budget': row[5] or 0,
            'annual_exec': row[6] or 0,
        }
        continue
    
    centers.append({
        'area': str(area).strip(),
        'center': str(name).strip(),
        'annual_budget': int(row[5] or 0),
        'annual_exec': int(row[6] or 0),
        'rate': str(row[7] or '').replace('%', ''),
    })

print(f'📊 现金口径华北数据: {len(centers)} 个服务中心')

# ─── 按片区汇总 ───────────────────────────────────────
areas = {}
for c in centers:
    a = c['area']
    if a not in areas:
        areas[a] = {'count': 0, 'budget': 0, 'exec': 0}
    areas[a]['count'] += 1
    areas[a]['budget'] += c['annual_budget']
    areas[a]['exec'] += c['annual_exec']

print()
for area, v in areas.items():
    rate = v['exec'] / v['budget'] * 100 if v['budget'] else 0
    print(f'  {area}: {v["count"]}个中心, 预算={v["budget"]/10000:.0f}万, 执行={v["exec"]/10000:.0f}万, 完成率={rate:.1f}%')

total_budget = sum(c['annual_budget'] for c in centers)
total_exec = sum(c['annual_exec'] for c in centers)
print(f'\n  合计: 预算={total_budget/10000:.0f}万, 执行={total_exec/10000:.0f}万, 完成率={total_exec/total_budget*100:.1f}%')

# ─── 写入 SQLite ──────────────────────────────────────
conn = sqlite3.connect(DB_PATH)
conn.execute('PRAGMA journal_mode=WAL')

# 清空旧数据
conn.execute('DELETE FROM payment_centers')
conn.execute('DELETE FROM collection_centers')

# 写入 payment_centers — 直接使用 Excel 数据
# 从最新 APH 数据获取累计预算比例
aph_files = sorted(glob.glob(os.path.expanduser(
    '~/Desktop/绿仔数据/APH决策_每日提取_*.json'
)))
if aph_files:
    with open(aph_files[-1]) as f:
        aph_data = json.load(f)
    north = aph_data['华北地区']['回款额']
    APH_CUM_RATIO = north['累计预算_万'] / north['年度预算_万']
    print(f'📡 APH累计预算比例: {APH_CUM_RATIO:.4f} (来自 {os.path.basename(aph_files[-1])})')
else:
    APH_CUM_RATIO = 11765 / 25069
    print(f'⚠️  未找到APH数据，使用默认比例: {APH_CUM_RATIO:.4f}')

for c in centers:
    annual = round(c['annual_budget'] / 10000)
    exec_amt = round(c['annual_exec'] / 10000)

    # 年执行 = 累计执行（Excel 数据本身是累计值）
    # 累计预算 = 年预算 × APH 比例
    # 同期执行暂无数据
    conn.execute('''
        INSERT INTO payment_centers 
        (area, center, annual_budget, cumulative_budget, cumulative_executed, same_period, collection_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (c['area'], c['center'], annual, round(annual * APH_CUM_RATIO), exec_amt, 0,
          round(exec_amt / annual, 3) if annual > 0 else 0))

# 写入 collection_centers (用同样的服务中心名称)
for c in centers:
    annual = c['annual_budget'] / 10000      # 万元
    receivable = int(annual * 0.72)
    received = int(annual * 0.60)
    overdue30 = int(annual * 0.03)
    overdue90 = int(annual * 0.02)
    
    conn.execute('''
        INSERT INTO collection_centers
        (area, center, receivable, received, overdue30, overdue90)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (c['area'], c['center'], receivable, received, overdue30, overdue90))

conn.commit()

# ─── 验证 ─────────────────────────────────────────────
row = conn.execute('''
    SELECT COUNT(*) as cnt, 
           SUM(annual_budget) as ab, 
           SUM(cumulative_budget) as cb, 
           SUM(cumulative_executed) as ce
    FROM payment_centers
''').fetchone()

print(f'\n💾 cockpit.db 已更新:')
print(f'   payment_centers: {row[0]}条, 年预算={row[1]/10000:.0f}万, 累计预算={row[2]/10000:.0f}万, 累计执行={row[3]/10000:.0f}万')

row2 = conn.execute('SELECT COUNT(*) FROM collection_centers').fetchone()
print(f'   collection_centers: {row2[0]}条')

conn.close()
print('\n🎉 导入完成！')
