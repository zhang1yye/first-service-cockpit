import re
from typing import Iterable, TypedDict

DAILY_REPORT_ID = '810ca5a0-b239-466b-85c2-386373244c8e'
DAILY_REPORT_REGION = '华北地区'
DAILY_NORTH_TITLE = '第一服务华北地区各服务中心计划预算回款日报'

MERGE_GROUPS = [
    (['第一服务北京满庭芳园服务中心', '第一服务北京青云大厦服务中心'], '第一服务满庭青云服务中心'),
    (['第一服务北京西山上品湾MOMΛ服务中心', '第一服务北京西山上品湾二期MOMΛ服务中心'], '第一服务北京西山上品湾MOMΛ服务中心'),
    (['第一服务北京上第MOMΛ服务中心', '第一服务北京IMOMΛ服务中心', '第一服务北京悦MOMΛ服务中心'], '第一服务北京上第MOMΛ服务中心'),
    (['第一服务北京MOMΛ万万树服务中心一期', '第一服务北京MOMΛ万万树服务中心二期'], '第一服务北京MOMΛ万万树服务中心'),
]


class DailyRow(TypedDict):
    center: str
    dailyCollection: float


def _money(value: str) -> float:
    return float(value.replace(',', '').strip())


def parse_daily_report_body(body: str) -> tuple[float, list[DailyRow]]:
    total_match = re.search(r'本日回款总额([\d,]+(?:\.\d+)?)万元', body)
    if not total_match:
        raise ValueError('未找到回款日报官方本日回款总额')
    official_total = _money(total_match.group(1))
    rows: list[DailyRow] = []
    current_center = ''
    in_header = True
    for line in body.splitlines():
        stripped = line.strip()
        if in_header:
            if '累计完成率' in stripped and '累计预算' in stripped:
                in_header = False
            continue
        if not stripped:
            continue
        if line.startswith('\t') and current_center:
            parts = [part.strip() for part in line.split('\t') if part.strip()]
            if len(parts) >= 7 and re.match(r'-?\d+(?:\.\d+)?%', parts[0]):
                try:
                    rows.append({'center': current_center, 'dailyCollection': _money(parts[6])})
                except ValueError:
                    pass
                current_center = ''
            continue
        if (
            ('第一服务' in stripped or '第一酒店' in stripped or '华北第一保洁' in stripped or '北京通州区' in stripped)
            and '各服务中心' not in stripped
        ):
            current_center = stripped
        elif (
            not stripped.startswith('\t')
            and '累计完成率' not in stripped
            and '本日回款' not in stripped
            and '战区排名' not in stripped
            and '组织蝶变' not in stripped
            and re.search(r'[服务中心公司酒店保洁]', stripped)
            and len(stripped) > 4
        ):
            current_center = stripped
    names = [str(row['center']) for row in rows]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        raise ValueError(f"日报中心重复: {','.join(duplicates)}")
    return official_total, rows


def merge_daily_rows(rows: Iterable[DailyRow]) -> list[DailyRow]:
    values = {str(row['center']): float(row['dailyCollection']) for row in rows}
    for sources, target in MERGE_GROUPS:
        present = [source for source in sources if source in values]
        if not present:
            continue
        merged_value = round(sum(values[source] for source in present) + 1e-12, 2)
        for source in present:
            values.pop(source, None)
        values[target] = merged_value
    return [
        {'center': center, 'dailyCollection': value}
        for center, value in sorted(values.items())
    ]


def set_daily_parameters(page, business_date: str) -> list[str]:
    """Set all parameters without starting overlapping report queries."""
    page.keyboard.press('Escape')
    triggers = page.locator('.fr-trigger-texteditor')
    if triggers.count() != 3:
        raise RuntimeError(f'日报参数数量异常: {triggers.count()}')

    values = [triggers.nth(index).input_value() for index in range(3)]
    date_indexes = [index for index, value in enumerate(values) if re.fullmatch(r'\d{4}-\d{2}-\d{2}', value)]
    region_indexes = [index for index in range(3) if index not in date_indexes]
    if len(date_indexes) != 2 or len(region_indexes) != 1:
        raise RuntimeError(f'无法识别日报参数: {values}')

    for index in date_indexes:
        trigger = triggers.nth(index)
        trigger.fill(business_date)
        trigger.press('Tab')
        page.wait_for_timeout(500)

    region = triggers.nth(region_indexes[0])
    region.locator('xpath=../following-sibling::div[contains(@class,"fr-trigger-btn-up")]').click()
    page.wait_for_timeout(1000)
    page.locator('.fr-combo-list-item').filter(has_text='华北地区').last.click()
    page.wait_for_timeout(1000)

    parameters = triggers.evaluate_all('(els)=>els.map(e=>e.value)')
    if parameters.count(business_date) != 2 or DAILY_REPORT_REGION not in parameters:
        raise RuntimeError(f'日报参数提交失败: {parameters}')
    return parameters


def is_daily_body_ready(body: str, min_centers: int = 10) -> bool:
    if len(body) <= 1000 or DAILY_NORTH_TITLE not in body or '累计执行' not in body:
        return False
    center_count = body.count('第一服务') + body.count('第一酒店') + body.count('华北第一保洁')
    return center_count >= min_centers
