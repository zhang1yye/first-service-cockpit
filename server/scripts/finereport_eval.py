"""FineReport 2.0 回款额执行评估的地区卡片解析。"""
from __future__ import annotations

import re
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional

REGIONS = (
    '华南地区', '华北地区', '陕西地区', '西北地区', '湖北地区',
    '赣闽地区', '华东地区', '安徽地区', '山东地区', '大连亚航',
)
NUM = r'(-?[\d,]+(?:\.\d+)?)'


def _number(value: str) -> float:
    return float(value.replace(',', ''))


def reconcile_rounded_card_precision(card_value: float, detail_value: Optional[float]) -> float:
    """仅在明细合计四舍五入后与卡片整数完全一致时补足真实小数。"""
    if detail_value is None or not float(card_value).is_integer():
        return card_value
    rounded_detail = Decimal(str(detail_value)).quantize(Decimal('1'), rounding=ROUND_HALF_UP)
    if rounded_detail != Decimal(str(int(card_value))):
        return card_value
    return round(detail_value, 2)


def parse_region_kpi(body: str, region: str = '华北地区') -> Optional[dict[str, float]]:
    """按地区卡片标签解析指标，不允许跨到下一地区卡片取数。"""
    start = body.find(region)
    if start < 0:
        return None

    ends = [body.find(name, start + len(region)) for name in REGIONS if name != region]
    ends = [pos for pos in ends if pos >= 0]
    end = min(ends) if ends else len(body)
    block = body[start:end]

    current = re.match(re.escape(region) + r'\s*' + NUM, block)
    budgets = re.search(r'年度\s*预算\s*' + NUM + r'\s*累计\s*预算\s*' + NUM, block, re.S)
    comparisons = re.search(
        r'年度\s*完成率\s*累计\s*完成率\s*同期\s*(?:累计\s*)?执行\s*增幅\s*'
        + NUM + r'\s*%\s*' + NUM + r'\s*%\s*' + NUM + r'\s*' + NUM + r'\s*%',
        block,
        re.S,
    )
    if not current or not budgets or not comparisons:
        return None

    return {
        'cumulative_executed': _number(current.group(1)),
        'annual_budget': _number(budgets.group(1)),
        'cumulative_budget': _number(budgets.group(2)),
        'annual_rate': _number(comparisons.group(1)),
        'cumulative_rate': _number(comparisons.group(2)),
        'same_period': _number(comparisons.group(3)),
        'growth': _number(comparisons.group(4)),
    }


def is_growth_consistent(kpi: dict[str, float], tolerance_pp: float = 1.0) -> bool:
    """校验报表增幅与(本期-同期)/同期一致，允许整数百分比的四舍五入误差。"""
    current = kpi['cumulative_executed']
    same_period = kpi['same_period']
    reported = kpi['growth']
    if same_period == 0:
        return current == 0 and reported == 0
    calculated = (current - same_period) / same_period * 100
    return abs(calculated - reported) <= tolerance_pp
