#!/usr/bin/env python3
"""Fail closed when APH payment-center area attribution is missing or collapsed."""
import argparse
import json
import sqlite3
from collections import Counter

ALLOWED_AREAS = {
    "朝阳片区",
    "海淀片区",
    "顺平片区",
    "京东片区",
    "河北片区",
    "辽宁片区",
    "华北第一保洁",
    "华北地区公司",
    "已撤场项目",
}
FORBIDDEN_COLLAPSED_AREAS = {"华北地区", "华北区域"}


def verify(db_path: str) -> dict:
    connection = sqlite3.connect(db_path)
    rows = connection.execute(
        "SELECT center, area FROM payment_centers ORDER BY center"
    ).fetchall()
    if len(rows) < 40:
        raise SystemExit(f"payment_centers只有{len(rows)}条，低于安全阈值40")
    missing = [center for center, area in rows if not str(area or "").strip()]
    forbidden = [(center, area) for center, area in rows if area in FORBIDDEN_COLLAPSED_AREAS]
    unknown = [(center, area) for center, area in rows if area not in ALLOWED_AREAS]
    if missing:
        raise SystemExit(f"存在空片区：{missing[:8]}")
    if forbidden:
        raise SystemExit(f"片区被折叠为地区级标签：{forbidden[:8]}")
    if unknown:
        raise SystemExit(f"存在未登记片区：{unknown[:8]}")
    distribution = dict(sorted(Counter(area for _, area in rows).items()))
    core_count = sum(distribution.get(area, 0) for area in ALLOWED_AREAS if area.endswith("片区"))
    if core_count == 0:
        raise SystemExit("六大片区均无服务中心")
    return {"rows": len(rows), "core_rows": core_count, "areas": distribution}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="/home/ubuntu/cockpit/cockpit.db")
    args = parser.parse_args()
    print(json.dumps(verify(args.db), ensure_ascii=False, sort_keys=True))
