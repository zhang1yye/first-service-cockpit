#!/usr/bin/env python3
"""绿仔管家“新收费率统计”实时提取，并按供暖费跨年周期修正华北收缴率。"""

import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime


HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get("COCKPIT_DB_PATH", os.path.join(HERE, "..", "cockpit.db"))
STATE = os.path.expanduser("~/.lvzai_state.json")
LOGIN = os.path.join(HERE, "lvzai-login.py")
OUTDIR = os.environ.get("COCKPIT_DATA_DIR", os.path.expanduser("~/Desktop/绿仔数据"))
COCKPIT_DIR = os.environ.get("COCKPIT_ROOT", os.path.expanduser("~/cockpit"))
PSTAR = "https://pstar.firstpm.com.cn/qdp-polestar-web"
OASIS = "https://oasis.firstpm.com.cn/qdp-oasis-web"
TODAY = datetime.now().strftime("%Y-%m-%d")
YEAR = datetime.now().year
YEAR_START = f"{YEAR}-01-01"
YEAR_END = TODAY
BILL_YEAR_END = f"{YEAR}-12-31"

# 万国城、满庭、青云的供暖费按当年11月至次年3月计费，不能沿用自然年度。
HEATING_REGION_IDS = {
    "北京万国城MOMΛ": "2020031917291236842",
    "北京满庭芳园": "20200402114700933f2",
    "北京青云大厦": "20200402114723189a0",
}
HEATING_FEE_IDS = [138, 139]
HEATING_START = f"{YEAR}-11-01"
HEATING_END = f"{YEAR + 1}-03-31"

# 收缴率只统计新风类、物业类和供暖类；供暖补贴不计入。
# 按绿仔费用类别节点动态展开，避免类别新增子项后漏取。
COLLECTION_FEE_CATEGORY_CODES = {
    "1000492": "新风类",
    "1000490": "物业类",
    "1000491": "供暖类",
}
EXCLUDED_COLLECTION_FEE_IDS = {137}

# 下列项目不计入华北收缴率。名称按绿仔小区名称和驾驶舱服务中心名称共同归一化匹配。
EXCLUDED_COLLECTION_REGION_RULES = {
    "葫芦岛龙港区公共行政": "葫芦岛龙港区公共行政服务中心",
    "葫芦岛龙港区政府行政管理": "葫芦岛龙港区政府行政管理服务中心",
    "中信珺台": "天津中信珺台服务中心",
    "葫芦岛首创象墅": "葫芦岛首创·象墅服务中心",
}

ALIAS = {
    "北京IMOMΛ": "北京上第MOMΛ",
    "北京悦MOMΛ": "北京上第MOMΛ",
    "北京满庭芳园": "满庭青云",
    "北京青云大厦": "满庭青云",
    "营口林昌天铂院子": "营口天铂院子",
    "中行项目部": "北京中行项目部",
}


def norm(value):
    value = value or ""
    value = value.replace("MOMA", "MOMΛ").replace("ΜΟΜΛ", "MOMΛ").replace("MOM∧", "MOMΛ")
    value = re.sub(r"第一服务|第一物业|第一酒店", "", value)
    value = re.sub(r"服务中心|体验中心", "", value)
    value = re.sub(r"[-－].*$", "", value)
    value = re.sub(r"停车场.*$", "", value)
    value = re.sub(r"[(（].*$", "", value)
    value = re.sub(r"一期|二期", "", value)
    return value.strip()


def collection_scope_key(value):
    return re.sub(r"[\s·•・]", "", norm(value))


def excluded_collection_region_label(value):
    key = collection_scope_key(value)
    for keyword, label in EXCLUDED_COLLECTION_REGION_RULES.items():
        if keyword in key:
            return label
    return None


def is_excluded_collection_region(value):
    return excluded_collection_region_label(value) is not None


def load_cookie():
    with open(STATE, encoding="utf-8") as handle:
        storage = json.load(handle)
    return "; ".join(
        f"{cookie['name']}={cookie['value']}"
        for cookie in storage.get("cookies", [])
        if "firstpm.com.cn" in cookie.get("domain", "")
    )


def api(url, body=None, timeout=300):
    command = [
        "curl",
        "-ksS",
        "--http1.1",
        "--max-time",
        str(timeout),
        "--retry",
        "3",
        "--retry-delay",
        "2",
        "--retry-all-errors",
        "--write-out",
        "\n__HTTP_STATUS__:%{http_code}",
        "-H",
        f"Cookie: {load_cookie()}",
        "-H",
        "X-Requested-With: XMLHttpRequest",
        "-H",
        "Referer: https://pstar.firstpm.com.cn/qdp-polestar-webui-standard/index.html",
        "-H",
        "Content-Type: application/json",
        "-H",
        "Accept: application/json, text/javascript, */*; q=0.01",
        "-H",
        "User-Agent: Mozilla/5.0",
    ]
    payload = None
    if body is not None:
        command.extend(["-X", "POST", "--data-binary", "@-"])
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    command.append(url)
    try:
        result = subprocess.run(command, input=payload, capture_output=True, timeout=timeout + 15)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"接口请求超过{timeout}秒") from error
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace")[:300])
    output = result.stdout.decode("utf-8", errors="strict")
    body_text, marker, status_text = output.rpartition("\n__HTTP_STATUS__:")
    if not marker or not status_text.isdigit():
        raise RuntimeError("接口响应缺少HTTP状态")
    status = int(status_text)
    if status < 200 or status >= 300:
        raise RuntimeError(f"接口HTTP {status}")
    if not body_text.strip():
        raise RuntimeError(f"接口HTTP {status}返回空响应")
    try:
        return json.loads(body_text)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"接口HTTP {status}返回非JSON响应") from error


def session_alive():
    if not os.path.exists(STATE):
        return False
    try:
        result = api(f"{OASIS}/common/getRegionTree", timeout=30)
        return bool(result.get("data"))
    except Exception:
        return False


def relogin():
    print("会话失效，正在重新登录绿仔管家……", flush=True)
    environment = dict(os.environ)
    result = subprocess.run(
        [sys.executable, LOGIN],
        env=environment,
        capture_output=True,
        text=True,
        timeout=300,
    )
    print(result.stdout[-500:], flush=True)
    if result.returncode != 0:
        print(result.stderr[-500:], flush=True)
        raise SystemExit("自动登录失败")


def fetch_north_ids():
    tree = api(f"{OASIS}/common/getRegionTree", timeout=60)
    ids = []

    def collect_leaves(node):
        children = node.get("children") or []
        if children:
            for child in children:
                collect_leaves(child)
        elif node.get("code"):
            ids.append(node["code"])

    for top in tree.get("data", []):
        if "华北" in (top.get("text") or ""):
            collect_leaves(top)
    return ids


def fetch_collection_fee_scope(region_ids):
    response = api(
        f"{OASIS}/common/getFeeItemTree",
        body={
            "regionId": ",".join(region_ids),
            "billCycle": "",
            "costTypes": "",
            "allowInput": "",
        },
        timeout=60,
    )
    selected = []
    found_categories = set()

    def collect_fee_items(node):
        code = str(node.get("code") or "")
        children = node.get("children") or []
        if code in COLLECTION_FEE_CATEGORY_CODES:
            found_categories.add(code)
            for child in children:
                attribute = child.get("attribute") or {}
                fee_id = attribute.get("feeId") or child.get("code")
                try:
                    fee_id = int(fee_id)
                except (TypeError, ValueError):
                    continue
                if fee_id in EXCLUDED_COLLECTION_FEE_IDS:
                    continue
                selected.append(
                    {
                        "feeId": fee_id,
                        "feeName": child.get("text") or attribute.get("feeName") or "",
                        "categoryCode": code,
                        "categoryName": COLLECTION_FEE_CATEGORY_CODES[code],
                    }
                )
            return
        for child in children:
            collect_fee_items(child)

    for root in response.get("data") or []:
        collect_fee_items(root)

    missing = set(COLLECTION_FEE_CATEGORY_CODES) - found_categories
    if missing:
        names = "、".join(COLLECTION_FEE_CATEGORY_CODES[code] for code in sorted(missing))
        raise SystemExit(f"绿仔收费项目树缺少类别：{names}")

    selected_by_id = {item["feeId"]: item for item in selected}
    selected = [selected_by_id[fee_id] for fee_id in sorted(selected_by_id)]
    if not selected:
        raise SystemExit("绿仔收费项目树未返回收缴率所需费项")
    return selected


def query_body(region_ids, fee_ids=None, bill_start=None, bill_end=None):
    return {
        "regionIds": region_ids,
        "feeIds": fee_ids or [],
        "buildingIds": [],
        "roomIds": [],
        "personIds": [],
        "dictCodeIds": [],
        "buildingType": [],
        "collectionDateType": 2,
        "receStartDate": YEAR_START,
        "receEndDate": YEAR_END,
        "billReceDateType": 2,
        "billStartDate": bill_start or YEAR_START,
        "billEndDate": bill_end or BILL_YEAR_END,
        "showType": 2,
        "isDerateInRate": 0,
        "isReceEndDate": 2,
        "isOpen": 1,
        "isDebtOpen": 1,
    }


def fetch_rece_rate(region_ids, fee_ids=None, bill_start=None, bill_end=None):
    return api(
        f"{PSTAR}/oas/newBillReceRate",
        body=query_body(region_ids, fee_ids, bill_start, bill_end),
        timeout=300,
    )


def fetch_rece_rate_chunked(region_ids, fee_ids=None, chunk_size=10):
    """绿仔大范围年度查询会在网关中长时间挂起，按小区分片后在本地按官方字段叠加。"""
    responses = []
    for offset in range(0, len(region_ids), chunk_size):
        chunk = region_ids[offset : offset + chunk_size]
        print(
            f"年度收费率分片：{offset // chunk_size + 1}/"
            f"{(len(region_ids) + chunk_size - 1) // chunk_size} ({len(chunk)}个小区)",
            flush=True,
        )
        response = fetch_rece_rate(chunk, fee_ids)
        rows = response.get("data") or []
        if not rows:
            raise RuntimeError(
                f"年度收费率分片{offset // chunk_size + 1}无数据"
            )
        responses.append(response)

    totals = [row_amounts(total_row(response.get("data") or [])) for response in responses]
    received = sum(item[0] for item in totals)
    receivable = sum(item[1] for item in totals)
    outstanding = sum(item[2] for item in totals)
    rate_numerator = sum(item[3] for item in totals)
    combined_total = {
        "costTypeName": "总计",
        "receCurrentPeriod": receivable,
        "gatheringLastPeriodReceCurrentPeriod": 0,
        "gatheringCurrentPeriodReceCurrentPeriod": received,
        "arrearageCurrentPeriod": outstanding,
        # 绿仔原字段是0到100的百分数，official_rate()会再除100。
        "gatheringCurrentYearRecedRate": rate_numerator / receivable * 100
        if receivable
        else 0,
    }
    merged = dict(responses[0])
    merged["data"] = [combined_total] + [
        row
        for response in responses
        for row in (response.get("data") or [])[1:]
    ]
    merged["_chunking"] = {
        "enabled": True,
        "chunkSize": chunk_size,
        "chunkCount": len(responses),
        "regionCount": len(region_ids),
    }
    return merged


def to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def official_rate(value):
    """解析绿仔官方收缴率字段，返回0到1之间的小数。"""
    text = str(value or "").strip().replace("%", "")
    if not text:
        raise ValueError("绿仔响应缺少官方字段 gatheringCurrentYearRecedRate")
    try:
        return float(text) / 100
    except (TypeError, ValueError):
        raise ValueError(f"无法解析官方收缴率：{value!r}")


def row_amounts(row):
    receivable = to_float(row.get("receCurrentPeriod"))
    received = (
        to_float(row.get("gatheringLastPeriodReceCurrentPeriod"))
        + to_float(row.get("gatheringCurrentPeriodReceCurrentPeriod"))
    )
    outstanding = to_float(row.get("arrearageCurrentPeriod"))
    # 项目官方率必须直接使用 gatheringCurrentYearRecedRate；乘以应收得到
    # 可加总的“官方率权重分子”，用于服务中心归并、排除项目和供暖周期修正。
    rate_weighted_numerator = official_rate(
        row.get("gatheringCurrentYearRecedRate")
    ) * receivable
    return received, receivable, outstanding, rate_weighted_numerator


def total_row(rows):
    return rows[0] if rows else {}


def project_totals(rows):
    result = {}
    for row in rows:
        name = row.get("regionName")
        if name and row.get("costTypeName") == "合计":
            result[name] = row_amounts(row)
    return result


def corrected_amounts(annual, annual_heating, seasonal_heating, name):
    received, receivable, outstanding, rate_numerator = annual
    if name not in HEATING_REGION_IDS:
        return received, receivable, outstanding, rate_numerator
    old_received, old_receivable, old_outstanding, old_rate_numerator = annual_heating.get(
        name, (0.0, 0.0, 0.0, 0.0)
    )
    new_received, new_receivable, new_outstanding, new_rate_numerator = seasonal_heating.get(
        name, (0.0, 0.0, 0.0, 0.0)
    )
    return (
        received - old_received + new_received,
        receivable - old_receivable + new_receivable,
        outstanding - old_outstanding + new_outstanding,
        rate_numerator - old_rate_numerator + new_rate_numerator,
    )


def main():
    if not session_alive():
        relogin()
        if not session_alive():
            raise SystemExit("重新登录后会话仍不可用")
    print("绿仔会话有效", flush=True)

    north_ids = fetch_north_ids()
    if len(north_ids) < 50:
        raise SystemExit(f"华北权限范围异常，仅返回 {len(north_ids)} 个小区")
    print(f"华北小区：{len(north_ids)} 个", flush=True)

    collection_fee_scope = fetch_collection_fee_scope(north_ids)
    collection_fee_ids = [item["feeId"] for item in collection_fee_scope]
    print(
        "收费项目："
        + "、".join(item["feeName"] for item in collection_fee_scope),
        flush=True,
    )

    annual_response = fetch_rece_rate_chunked(north_ids, collection_fee_ids)
    annual_rows = annual_response.get("data") or []
    if not annual_rows:
        raise SystemExit(f"全年接口无数据：{annual_response.get('errorMessage')}")

    heating_ids = list(HEATING_REGION_IDS.values())
    annual_heating_response = fetch_rece_rate(heating_ids, HEATING_FEE_IDS)
    seasonal_heating_response = fetch_rece_rate(
        heating_ids,
        HEATING_FEE_IDS,
        HEATING_START,
        HEATING_END,
    )
    annual_heating = project_totals(annual_heating_response.get("data") or [])
    seasonal_heating = project_totals(seasonal_heating_response.get("data") or [])

    connection = sqlite3.connect(DB)
    connection.execute("PRAGMA journal_mode=WAL")
    database_centers = connection.execute(
        "SELECT area, center FROM collection_centers"
    ).fetchall()
    center_map = {norm(center): (area, center) for area, center in database_centers}

    aggregated = {}
    unmatched = []
    excluded_projects_by_label = {}
    excluded_received = 0.0
    excluded_receivable = 0.0
    excluded_outstanding = 0.0
    excluded_rate_numerator = 0.0
    for row in annual_rows:
        region_name = row.get("regionName")
        if not region_name or row.get("costTypeName") != "合计":
            continue
        excluded_label = excluded_collection_region_label(region_name)
        if excluded_label:
            received, receivable, outstanding, rate_numerator = row_amounts(row)
            excluded_received += received
            excluded_receivable += receivable
            excluded_outstanding += outstanding
            excluded_rate_numerator += rate_numerator
            excluded_item = excluded_projects_by_label.setdefault(
                excluded_label,
                {
                    "center": excluded_label,
                    "sourceRegions": [],
                    "received": 0.0,
                    "receivable": 0.0,
                    "outstanding": 0.0,
                    "rateNumerator": 0.0,
                },
            )
            excluded_item["sourceRegions"].append(region_name)
            excluded_item["received"] += received
            excluded_item["receivable"] += receivable
            excluded_item["outstanding"] += outstanding
            excluded_item["rateNumerator"] += rate_numerator
            continue
        key = ALIAS.get(norm(region_name), norm(region_name))
        match = center_map.get(key)
        if not match:
            for normalized, value in center_map.items():
                if key and (key in normalized or normalized in key):
                    match = value
                    break
        if not match:
            unmatched.append(region_name)
            continue

        area, center = match
        amounts = corrected_amounts(
            row_amounts(row),
            annual_heating,
            seasonal_heating,
            region_name,
        )
        item = aggregated.setdefault(
            center,
            {
                "received": 0.0,
                "receivable": 0.0,
                "outstanding": 0.0,
                "rateNumerator": 0.0,
                "area": area,
            },
        )
        item["received"] += amounts[0]
        item["receivable"] += amounts[1]
        item["outstanding"] += amounts[2]
        item["rateNumerator"] += amounts[3]

    detail_rows = []
    for center, values in aggregated.items():
        received_w = round(values["received"] / 10000, 2)
        receivable_w = round(values["receivable"] / 10000, 2)
        outstanding_w = round(values["outstanding"] / 10000, 2)
        connection.execute(
            "UPDATE collection_centers SET receivable=?, received=? WHERE center=?",
            (receivable_w, received_w, center),
        )
        detail_rows.append(
            {
                "area": values["area"],
                "center": center,
                "receivable": receivable_w,
                "received": received_w,
                "outstanding": outstanding_w,
                "collectionRate": round(
                    values["rateNumerator"] / values["receivable"], 4
                )
                if values["receivable"] > 0
                else 0,
            }
        )
    connection.commit()
    connection.close()

    annual_received, annual_receivable, annual_outstanding, annual_rate_numerator = row_amounts(
        total_row(annual_rows)
    )
    old_received, old_receivable, old_outstanding, old_rate_numerator = row_amounts(
        total_row(annual_heating_response.get("data") or [])
    )
    new_received, new_receivable, new_outstanding, new_rate_numerator = row_amounts(
        total_row(seasonal_heating_response.get("data") or [])
    )
    official_received = (
        annual_received - excluded_received - old_received + new_received
    )
    official_receivable = (
        annual_receivable - excluded_receivable - old_receivable + new_receivable
    )
    official_outstanding = (
        annual_outstanding
        - excluded_outstanding
        - old_outstanding
        + new_outstanding
    )
    official_rate_numerator = (
        annual_rate_numerator
        - excluded_rate_numerator
        - old_rate_numerator
        + new_rate_numerator
    )
    official_rate = (
        official_rate_numerator / official_receivable
        if official_receivable
        else 0
    )
    excluded_projects = [
        {
            **{key: value for key, value in item.items() if key != "rateNumerator"},
            "received": round(item["received"], 2),
            "receivable": round(item["receivable"], 2),
            "outstanding": round(item["outstanding"], 2),
            "officialRate": round(
                item["rateNumerator"] / item["receivable"], 4
            ) if item["receivable"] else 0,
        }
        for item in excluded_projects_by_label.values()
    ]

    os.makedirs(OUTDIR, exist_ok=True)
    os.makedirs(COCKPIT_DIR, exist_ok=True)
    correction = {
        "rule": "全年合计减去万国城、满庭、青云自然年度供暖费，再加当年11月至次年3月供暖费",
        "regionNames": list(HEATING_REGION_IDS),
        "feeIds": HEATING_FEE_IDS,
        "collectionFeeScope": collection_fee_scope,
        "excludedFeeIds": sorted(EXCLUDED_COLLECTION_FEE_IDS),
        "excludedProjects": excluded_projects,
        "excludedProjectAmounts": {
            "received": round(excluded_received, 2),
            "receivable": round(excluded_receivable, 2),
            "outstanding": round(excluded_outstanding, 2),
            "officialRateNumerator": round(excluded_rate_numerator, 2),
        },
        "annualReceiptPeriod": [YEAR_START, YEAR_END],
        "annualBillPeriod": [YEAR_START, BILL_YEAR_END],
        "heatingBillPeriod": [HEATING_START, HEATING_END],
        "annualRateBefore": round(annual_rate_numerator / annual_receivable, 4)
        if annual_receivable
        else 0,
        "correctedRate": round(official_rate, 4),
        "rateField": "gatheringCurrentYearRecedRate",
        "rateAggregation": "按receCurrentPeriod对应收加权官方项目率",
        "annualHeating": {
            "received": round(old_received, 2),
            "receivable": round(old_receivable, 2),
            "outstanding": round(old_outstanding, 2),
        },
        "seasonalHeating": {
            "received": round(new_received, 2),
            "receivable": round(new_receivable, 2),
            "outstanding": round(new_outstanding, 2),
        },
    }
    annual_response["_periodCorrection"] = correction

    raw_path = os.path.join(OUTDIR, f"收款统计_API_{TODAY}.json")
    with open(raw_path, "w", encoding="utf-8") as handle:
        json.dump(annual_response, handle, ensure_ascii=False, indent=2)

    summary = {
        "received_万": round(official_received / 10000, 2),
        "receivable_万": round(official_receivable / 10000, 2),
        "outstanding_万": round(official_outstanding / 10000, 2),
        "collectionRate": round(official_rate, 4),
        "source": "绿仔管家·新收费率统计（官方字段gatheringCurrentYearRecedRate；按本期应收加权；费用结束日期12月31日）",
        "extractedAt": datetime.now().isoformat(),
        "date": TODAY,
        "periodCorrection": correction,
    }
    with open(
        os.path.join(COCKPIT_DIR, "绿仔收款汇总.json"),
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)
    with open(
        os.path.join(COCKPIT_DIR, "绿仔收缴明细.json"),
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(
            {
                "rows": sorted(detail_rows, key=lambda item: (item["area"], item["center"])),
                "extractedAt": summary["extractedAt"],
                "date": TODAY,
                "businessDate": TODAY,
                "periodCorrection": correction,
            },
            handle,
            ensure_ascii=False,
            indent=2,
        )
    with open(
        os.path.join(COCKPIT_DIR, "绿仔同步状态.json"),
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(
            {
                "ok": True,
                "date": TODAY,
                "finishedAt": datetime.now().isoformat(),
                "message": "绿仔数据已提取，并完成供暖费跨年周期及指定项目排除修正",
            },
            handle,
            ensure_ascii=False,
            indent=2,
        )
    last_sync_path = os.path.join(COCKPIT_DIR, ".last_sync")
    last_sync_tmp = f"{last_sync_path}.{os.getpid()}.tmp"
    with open(last_sync_tmp, "w", encoding="utf-8") as handle:
        handle.write(str(int(time.time() * 1000)))
    os.replace(last_sync_tmp, last_sync_path)

    print(f"更新 collection_centers：{len(detail_rows)} 个中心")
    print(
        f"修正前收缴率：{correction['annualRateBefore'] * 100:.2f}% / "
        f"修正后收缴率：{official_rate * 100:.2f}%"
    )
    print(
        f"修正后实收：{official_received / 10000:.2f}万 / "
        f"应收：{official_receivable / 10000:.2f}万"
    )
    print(
        f"排除项目 {len(excluded_projects)} 个："
        + "、".join(item["center"] for item in excluded_projects)
    )
    if unmatched:
        print(f"未匹配项目 {len(set(unmatched))} 个：{', '.join(sorted(set(unmatched)))}")
    print("完成")


if __name__ == "__main__":
    main()
