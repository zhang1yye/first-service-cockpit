#!/usr/bin/env python3
"""验证绿仔官方收缴率字段及应收加权聚合口径。"""

import argparse
import json
from pathlib import Path


def parse_rate(value):
    text = str(value or "").strip().replace("%", "")
    if not text:
        raise ValueError("缺少 gatheringCurrentYearRecedRate")
    return float(text) / 100


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("raw_json", type=Path)
    parser.add_argument("--tolerance-pp", type=float, default=0.02)
    args = parser.parse_args()

    payload = json.loads(args.raw_json.read_text(encoding="utf-8"))
    rows = payload.get("data") or []
    total = next(
        (
            row
            for row in rows
            if not row.get("regionName") and row.get("costTypeName") == "合计"
        ),
        None,
    )
    if not total:
        raise SystemExit("未找到绿仔华北合计行")

    projects = [
        row
        for row in rows
        if row.get("regionName") and row.get("costTypeName") == "合计"
    ]
    if not projects:
        raise SystemExit("未找到项目合计行")

    receivable = sum(float(row.get("receCurrentPeriod") or 0) for row in projects)
    numerator = sum(
        float(row.get("receCurrentPeriod") or 0)
        * parse_rate(row.get("gatheringCurrentYearRecedRate"))
        for row in projects
    )
    weighted = numerator / receivable if receivable else 0
    official_total = parse_rate(total.get("gatheringCurrentYearRecedRate"))
    diff_pp = abs(weighted - official_total) * 100

    result = {
        "file": str(args.raw_json),
        "projectRows": len(projects),
        "rateField": "gatheringCurrentYearRecedRate",
        "weightedOfficialRate": round(weighted, 6),
        "sourceTotalRate": round(official_total, 6),
        "differencePp": round(diff_pp, 6),
        "tolerancePp": args.tolerance_pp,
        "passed": diff_pp <= args.tolerance_pp,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
