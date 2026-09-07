#!/usr/bin/env python3
"""Read one historical FineReport daily report and emit daily-only reconciliation JSON.

This probe never opens cockpit.db and never reads historical cumulative fields into its output.
"""
import argparse
import json
import os
import re

from datetime import datetime
from pathlib import Path
from typing import TypedDict

from daily_reconciliation_probe import (
    DAILY_REPORT_ID,
    DAILY_REPORT_REGION,
    DailyRow,
    is_daily_body_ready,
    merge_daily_rows,
    parse_daily_report_body,
    set_daily_parameters,
)


def click_query(page) -> None:
    try:
        page.locator('button:has-text("查询")').click(timeout=5000)
    except Exception:
        clicked = page.evaluate("""() => {
          for (const button of document.querySelectorAll('button')) {
            if ((button.textContent || '').includes('查询')) { button.click(); return true }
          }
          return false
        }""")
        if not clicked:
            raise RuntimeError('未找到回款日报查询按钮')


class ReconciliationPayload(TypedDict):
    schemaVersion: int
    businessDate: str
    extractedAt: str
    reportId: str
    region: str
    officialTotal: float
    rows: list[DailyRow]


def wait_for_initial_report(page, timeout_seconds: int = 70) -> str:
    for _ in range(timeout_seconds // 5):
        page.wait_for_timeout(5000)
        body = page.locator('body').inner_text() or ''
        if '地区各服务中心计划预算回款日报' in body and body.count('服务中心') >= 10:
            return body
    raise RuntimeError('初始日报未稳定，拒绝并发提交历史查询')


def _rendered_cutoff_dates(body: str) -> set[str]:
    dates: set[str] = set()
    for value in re.findall(r'数据截止日期\s*[：:]?\s*((?:\d{4}-\d{2}-\d{2})|(?:\d{4}年\d{1,2}月\d{1,2}日))', body):
        chinese = re.fullmatch(r'(\d{4})年(\d{1,2})月(\d{1,2})日', value)
        dates.add(f'{chinese.group(1)}-{int(chinese.group(2)):02d}-{int(chinese.group(3)):02d}' if chinese else value)
    return dates


def wait_for_queried_report(page, business_date: str, initial_body: str, timeout_seconds: int = 120, poll_ms: int = 5000) -> str:
    observed_unready = False
    for _ in range(max(1, timeout_seconds * 1000 // poll_ms)):
        page.wait_for_timeout(poll_ms)
        body = page.locator('body').inner_text() or ''
        if not is_daily_body_ready(body):
            observed_unready = True
            continue
        parameters = page.locator('.fr-trigger-texteditor').evaluate_all('(els)=>els.map(e=>e.value)')
        rendered_cutoff_dates = _rendered_cutoff_dates(body)
        if (
            observed_unready
            and body != initial_body
            and parameters == [business_date, DAILY_REPORT_REGION, business_date]
            and rendered_cutoff_dates == {business_date}
        ):
            return body
    raise RuntimeError(f'历史回款日报未形成已确认日期为{business_date}的完整华北中心明细')


def summarize_daily_totals(official_total: float, raw_rows: list[DailyRow]) -> dict[str, float]:
    detail_total = round(sum(float(row['dailyCollection']) for row in raw_rows), 2)
    return {
        'detailTotal': detail_total,
        'totalDifference': round(round(float(official_total), 2) - detail_total, 2),
    }


def scrape(business_date: str) -> ReconciliationPayload:
    from playwright.sync_api import sync_playwright  # pyright: ignore[reportMissingImports]

    cdp_url = os.environ.get('COCKPIT_CDP_URL', 'http://127.0.0.1:9222')
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(cdp_url)
        if not browser.contexts:
            raise RuntimeError('CDP浏览器没有可用上下文')
        page = browser.contexts[0].new_page()
        try:
            page.goto('https://aph.firstcare.com.cn/', timeout=60000)
            page.wait_for_timeout(3000)
            if 'sso' in page.url or 'login' in page.url:
                username = os.environ.get('APH_USER')
                password = os.environ.get('APH_PWD')
                if not username or not password:
                    raise RuntimeError('APH登录态失效且缺少APH_USER/APH_PWD')
                page.fill('input[name="username"]', username)
                page.fill('input[name="password"]', password)
                page.locator('#loginBtn').first.click()
                page.wait_for_timeout(6000)
            page.goto(
                f'https://finereport.firstcare.com.cn/webroot/decision/v10/entry/access/{DAILY_REPORT_ID}',
                timeout=60000,
            )
            if DAILY_REPORT_ID not in page.url:
                raise RuntimeError(f'回款日报导航失败，当前页面不是目标报表: {page.url.split("?")[0]}')
            initial_body = wait_for_initial_report(page)
            set_daily_parameters(page, business_date)
            click_query(page)
            body = wait_for_queried_report(page, business_date, initial_body)
            official_total, raw_rows = parse_daily_report_body(body)
            if len(raw_rows) != 61:
                raise RuntimeError(f'历史回款日报源中心必须为61条，实际{len(raw_rows)}条')
            rows = merge_daily_rows(raw_rows)
            if len(rows) != 56:
                raise RuntimeError(f'合并后历史日报中心必须为56条，实际{len(rows)}条')
            return {
                'schemaVersion': 1,
                'businessDate': business_date,
                'extractedAt': datetime.now().astimezone().isoformat(timespec='seconds'),
                'reportId': DAILY_REPORT_ID,
                'region': DAILY_REPORT_REGION,
                'officialTotal': round(official_total, 2),
                'rows': raw_rows,
            }
        finally:
            page.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('business_date')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        datetime.strptime(args.business_date, '%Y-%m-%d')
    except ValueError as error:
        raise SystemExit(f'业务日期必须为YYYY-MM-DD: {error}')
    payload = scrape(args.business_date)
    totals = summarize_daily_totals(payload['officialTotal'], payload['rows'])
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + '.tmp')
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    os.chmod(temporary, 0o640)
    temporary.replace(output)
    print(json.dumps({
        'ok': True,
        'businessDate': payload['businessDate'],
        'sourceRows': len(payload['rows']),
        'canonicalRows': len(merge_daily_rows(payload['rows'])),
        'officialTotal': payload['officialTotal'],
        'detailTotal': totals['detailTotal'],
        'totalDifference': totals['totalDifference'],
        'output': str(output),
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
