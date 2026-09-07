#!/usr/bin/env python3
"""将每日抓取生成的华北地区卡片快照原子发布到驾驶舱根目录。"""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path

REQUIRED_RECONCILIATIONS = (
    "annualBudgetCardVsWeekly",
    "annualBudgetCardVsCenterDetail",
    "samePeriodCardVsCenterDetail",
)
REQUIRED_PROVENANCE = (
    "年度预算_万",
    "累计预算_万",
    "累计执行_万",
    "同期执行_万",
    "增幅",
)


def as_number(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label}缺少有效数字")
    return float(value)


def validate_snapshot(raw: dict, business_date: str) -> dict:
    if raw.get("sourceStatus") != "available":
        raise ValueError("APH快照来源状态不可用")
    if str(raw.get("businessDate") or raw.get("date") or "")[:10] != business_date:
        raise ValueError("APH快照业务日期与待发布日期不一致")

    card = raw.get("华北地区", {}).get("回款额")
    if not isinstance(card, dict):
        raise ValueError("APH快照缺少华北地区回款额卡片")
    values = {
        "annualBudget": as_number(card.get("年度预算_万"), "年度预算"),
        "cumulativeBudget": as_number(card.get("累计预算_万"), "累计预算"),
        "cumulativeExecuted": as_number(card.get("累计执行_万"), "累计执行"),
        "samePeriod": as_number(card.get("同期执行_万"), "同期执行"),
        "growthPercent": as_number(card.get("增幅"), "增幅"),
    }
    if values["annualBudget"] <= 0 or values["cumulativeBudget"] <= 0:
        raise ValueError("APH预算关键值必须为正数")

    region_card = raw.get("sourceLayers", {}).get("regionCard")
    if not isinstance(region_card, dict) or "华北地区卡片" not in str(region_card.get("source") or ""):
        raise ValueError("APH快照缺少华北地区卡片来源层")
    if str(region_card.get("businessDate") or "")[:10] != business_date:
        raise ValueError("华北地区卡片来源层业务日期不一致")
    layer_values = region_card.get("values") or {}
    for key in ("annualBudget", "samePeriod", "growthPercent"):
        layer_value = as_number(layer_values.get(key), f"regionCard.{key}")
        if layer_value != values[key]:
            raise ValueError(f"华北卡片顶层值与来源层不一致：{key}")
    # 卡片只展示整数，顶层可在中心明细四舍五入勾稽一致时保留小数精度。
    for key in ("cumulativeBudget", "cumulativeExecuted"):
        layer_value = as_number(layer_values.get(key), f"regionCard.{key}")
        if round(values[key]) != layer_value:
            raise ValueError(f"华北卡片顶层值与来源层整数精度不一致：{key}")

    provenance = raw.get("fieldProvenance") or {}
    if not all(isinstance(provenance.get(key), str) and provenance[key].strip() for key in REQUIRED_PROVENANCE):
        raise ValueError("APH快照字段血缘不完整")
    reconciliations = raw.get("reconciliations") or {}
    for key in REQUIRED_RECONCILIATIONS:
        item = reconciliations.get(key)
        if not isinstance(item, dict) or item.get("status") not in {"matched", "warning"}:
            raise ValueError(f"APH勾稽结果缺失或非法：{key}")
        if "leftValue" not in item or "rightValue" not in item:
            raise ValueError(f"APH勾稽结果缺少双方原值：{key}")

    same_period = values["samePeriod"]
    if same_period == 0:
        if values["cumulativeExecuted"] != 0 or values["growthPercent"] != 0:
            raise ValueError("同期为0时累计执行与增幅不勾稽")
    else:
        calculated = (values["cumulativeExecuted"] - same_period) / same_period * 100
        if abs(calculated - values["growthPercent"]) > 1.0:
            raise ValueError("同期执行与增幅不勾稽")
    return values


def publish_snapshot(source: Path, target: Path, business_date: str) -> dict:
    raw = json.loads(source.read_text(encoding="utf-8"))
    values = validate_snapshot(raw, business_date)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".aph-summary-", suffix=".json", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(raw, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, 0o640)
        os.replace(temp_name, target)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return values


def main() -> None:
    cockpit = Path(os.environ.get("COCKPIT_ROOT", "/home/ubuntu/cockpit"))
    data_dir = Path(os.environ.get("COCKPIT_DATA_DIR", str(Path.home() / "Desktop/绿仔数据")))
    business_date = os.environ.get("COCKPIT_BUSINESS_DATE", datetime.now().strftime("%Y-%m-%d"))
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", business_date):
        raise SystemExit("非法业务日期")
    source = data_dir / f"APH决策_每日提取_{business_date}.json"
    target = cockpit / "APH决策_每日提取.json"
    if not source.is_file():
        raise SystemExit(f"未找到已验证APH卡片快照：{source}")
    values = publish_snapshot(source, target, business_date)
    print(f"✅ 原子发布 {source} → {target}")
    print(f"   日期: {business_date}")
    print(f"   年度预算: {values['annualBudget']:.2f}万")
    print(f"   累计执行: {values['cumulativeExecuted']:.2f}万")
    print(f"   同期执行: {values['samePeriod']:.2f}万")
    print(f"   增幅: {values['growthPercent']:.1f}%")


if __name__ == "__main__":
    main()
