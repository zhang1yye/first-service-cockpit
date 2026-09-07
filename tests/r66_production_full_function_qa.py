#!/usr/bin/env python3
"""R66 云端全功能受控验收。

默认只读；仅在显式设置 R66_ALLOW_PRODUCTION_WRITES=YES 时执行写操作。
临时账号无论中途任何断言失败，都会在 finally 中逐个删除并回读确认。
正式目录、趋势、归档和数据源检测是幂等/审计型业务动作，不伪造临时记录，不做反向删除。
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import secrets
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("R66_BASE_URL", "https://www.firstcare.cloud").rstrip("/")
ALLOW_WRITES = os.environ.get("R66_ALLOW_PRODUCTION_WRITES", "") == "YES"
OUT = Path(
    os.environ.get(
        "R66_PRODUCTION_QA_OUT",
        str(ROOT / "docs/qa/frontend-skill-cloud-20260813/production"),
    )
)
RESULT_FILE = OUT / "r66-production-full-function-results.json"
AXE_PATH = ROOT / "node_modules/axe-core/axe.min.js"
USER_PREFIX = f"r66-qa-{datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(2)}"
TREND_AREAS = ("华北汇总", "朝阳片区", "京东片区", "海淀片区", "顺平片区", "河北片区", "辽宁片区")
EXPECTED_DIRECTORY_PROJECTS = 42
EXPECTED_KNOWN_COLLECTION_MAPPINGS = 32
EXPECTED_UNKNOWN_COLLECTION_MAPPINGS = 10
OFFICIAL_COLLECTION_CENTER_COUNT = 35
UNKNOWN_DIRECTORY_OPERATING_FIELDS = (
    "staff_count", "annual_income", "annual_cost", "ytd_income", "ytd_cost",
    "quality_score", "safety_incidents", "customer_satisfaction", "complaint_count",
)
ARCHIVE_UNKNOWN_FIELDS = (
    "annual_income", "annual_cost", "ytd_income", "ytd_cost", "quality_score",
    "safety_incidents", "customer_satisfaction", "complaint_count",
)
ARCHIVE_NULL_SUMMARY_FIELDS = (
    "ytd_income", "ytd_cost", "profitRate", "avg_quality", "avg_satisfaction",
    "total_complaints", "total_incidents",
)
FORMAL_ACTION_AUDITS = {
    "发布权威项目目录",
    "确认权威项目目录状态",
    "重建官方月度趋势",
    "确认官方月度趋势状态",
    "生成可追溯经营归档",
    "确认经营归档幂等状态",
}


def load_token_helper():
    helper_path = ROOT / "tests/full_remediation_shadow_qa.py"
    spec = importlib.util.spec_from_file_location("r66_token_helper", helper_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("临时令牌工具不可用")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def admin_token() -> str:
    supplied = os.environ.get("R66_ADMIN_TOKEN", "").strip()
    return supplied or load_token_helper().ephemeral_token()


def ephemeral_user_token(user_id: int) -> str:
    """仅为现存未分配成员签发内存 JWT，不改数据库。"""
    supplied = os.environ.get("R66_UNASSIGNED_TOKEN", "").strip()
    if supplied:
        return supplied
    helper = load_token_helper()
    numeric_id = int(user_id)
    remote = rf"""
sudo -n python3 - <<'PY'
import os
import subprocess
from pathlib import Path
pid = subprocess.check_output(["systemctl", "show", "first-service-cockpit", "--property=MainPID", "--value"], text=True).strip()
env = os.environ.copy()
for item in Path(f"/proc/{{pid}}/environ").read_bytes().split(b"\0"):
    if b"=" not in item:
        continue
    key, value = item.split(b"=", 1)
    key = key.decode("utf-8", errors="ignore")
    if key in {{"JWT_SECRET", "JWT_SECRET_FILE", "COCKPIT_DB_PATH", "NODE_ENV", "HOME"}}:
        env[key] = value.decode("utf-8", errors="ignore")
env.setdefault("HOME", "/home/ubuntu")
node_script = r'''import db from "./dist/db.js";
import {{ signToken }} from "./dist/auth.js";
const user = db.prepare("SELECT id,username,role,area_scope,project_scope,service_center_scope FROM users WHERE id=?").get({numeric_id});
if (!user) process.exit(2);
const token = signToken({{userId:user.id,username:user.username,role:user.role,areaScope:user.area_scope||"",projectScope:user.project_scope||"",serviceCenterScope:user.service_center_scope||""}});
process.stdout.write("\\n__R66_USER_TOKEN__" + token);'''
result = subprocess.run(["/usr/bin/node", "--input-type=module", "-e", node_script], cwd="/home/ubuntu/cockpit", env=env, capture_output=True, text=True)
if result.returncode != 0:
    raise SystemExit(result.returncode)
print(result.stdout, end="")
PY
"""
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", helper.HOST, remote],
        check=True,
        capture_output=True,
        text=True,
    )
    match = re.search(r"__R66_USER_TOKEN__(\S+)", result.stdout)
    if not match:
        raise RuntimeError("未能在内存中取得未分配成员令牌")
    return match.group(1)


class Api:
    def __init__(self, token: str = "") -> None:
        self.token = token

    def request(self, path: str, method: str = "GET", body: Any = None) -> dict[str, Any]:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = {"Accept": "application/json, text/csv;q=0.9"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if data is not None:
            headers["Content-Type"] = "application/json; charset=utf-8"
        request = urllib.request.Request(f"{BASE}{path}", data=data, headers=headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=45)
            status = response.status
            raw = response.read().decode("utf-8", errors="replace")
            response_headers = dict(response.headers.items())
        except urllib.error.HTTPError as error:
            status = error.code
            raw = error.read().decode("utf-8", errors="replace")
            response_headers = dict(error.headers.items())
        content_type = response_headers.get("Content-Type", response_headers.get("content-type", ""))
        payload: Any = raw
        if "json" in content_type or raw.lstrip().startswith(("{", "[")):
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                pass
        return {"status": status, "body": payload, "text": raw, "headers": response_headers}


def rows_of(body: Any) -> list[dict[str, Any]]:
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        for key in ("rows", "users", "centers"):
            if isinstance(body.get(key), list):
                return body[key]
    return []


def expect(result: dict[str, Any], allowed: set[int], label: str) -> Any:
    if result["status"] not in allowed:
        body = result["body"]
        message = body.get("error") if isinstance(body, dict) else str(body)[:240]
        raise AssertionError(f"{label}状态{result['status']}：{message}")
    return result["body"]


def login(username: str, password: str) -> str:
    result = Api().request("/api/auth/login", "POST", {"username": username, "password": password})
    if result["status"] != 200 or not isinstance(result["body"], dict) or not result["body"].get("token"):
        raise AssertionError(f"{username}受控登录失败，状态{result['status']}")
    return str(result["body"]["token"])


def safe_check(result: dict[str, Any]) -> dict[str, Any]:
    body = result.get("body")
    return {
        "status": result.get("status"),
        "rowCount": len(rows_of(body)),
        "state": body.get("status", {}).get("state")
        if isinstance(body, dict) and isinstance(body.get("status"), dict)
        else body.get("state") if isinstance(body, dict) else None,
    }


def object_of(value: Any, label: str) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as error:
            raise AssertionError(f"{label}不是有效JSON对象") from error
        if isinstance(parsed, dict):
            return parsed
    raise AssertionError(f"{label}缺少对象结构")


def valid_sha256(value: Any) -> bool:
    return bool(re.fullmatch(r"[a-fA-F0-9]{64}", str(value or "")))


def directory_readback_contract(body: Any) -> dict[str, Any]:
    """锁定当前生产权威目录基线：42条，收缴映射32条已知、10条未知。"""
    if not isinstance(body, dict):
        raise AssertionError("项目目录GET未返回对象")
    rows = rows_of(body)
    status = object_of(body.get("status"), "项目目录status")
    actual_count = len(rows)
    if actual_count != EXPECTED_DIRECTORY_PROJECTS:
        raise AssertionError(
            f"生产权威项目目录已不是{EXPECTED_DIRECTORY_PROJECTS}条，当前{actual_count}条；"
            "须先确认权威中心基线后再更新验收合同"
        )
    if int(body.get("total", -1)) != EXPECTED_DIRECTORY_PROJECTS:
        raise AssertionError(f"项目目录total应为{EXPECTED_DIRECTORY_PROJECTS}")
    if int(status.get("projectCount", -1)) != EXPECTED_DIRECTORY_PROJECTS:
        raise AssertionError(f"项目目录status.projectCount应为{EXPECTED_DIRECTORY_PROJECTS}")
    if status.get("state") != "directory_ready":
        raise AssertionError(f"项目目录应为directory_ready，当前{status.get('state')!r}")

    names: set[str] = set()
    known = 0
    unknown = 0
    collection_batch_ids: set[int] = set()
    for row in rows:
        name = str(row.get("name") or "").strip()
        if not name or name in names:
            raise AssertionError(f"项目目录存在空名或重名：{name!r}")
        names.add(name)
        if row.get("validation_status") != "directory_only":
            raise AssertionError(f"{name}不是directory_only：{row.get('validation_status')!r}")
        leaked = [field for field in UNKNOWN_DIRECTORY_OPERATING_FIELDS if row.get(field) is not None]
        if leaked:
            raise AssertionError(f"{name}未知经营字段未保持null：{leaked}")

        availability = object_of(row.get("dataAvailability"), f"{name}.dataAvailability")
        provenance = object_of(row.get("field_provenance"), f"{name}.field_provenance")
        fields = object_of(provenance.get("fields"), f"{name}.field_provenance.fields")
        collection = provenance.get("collection")
        collection_object = object_of(collection, f"{name}.field_provenance.collection") if collection else {}
        centers = collection_object.get("centers") or []
        if not isinstance(centers, list):
            raise AssertionError(f"{name}收缴映射centers不是数组")

        mapped = bool(centers)
        receivable = row.get("receivable")
        received = row.get("received")
        official_rate = row.get("official_collection_rate")
        if mapped:
            if receivable is None or received is None:
                raise AssertionError(f"{name}已映射但官方应收/实收缺失")
            if not availability.get("collectionFactsAvailable"):
                raise AssertionError(f"{name}已映射但collectionFactsAvailable未就绪")
            if fields.get("receivable") is None or fields.get("received") is None:
                raise AssertionError(f"{name}已映射但缺少官方字段血缘")
            if official_rate is not None and not 0 <= float(official_rate) <= 1:
                raise AssertionError(f"{name}官方收缴率超出0-1：{official_rate!r}")
            batch_id = int(collection_object.get("batchId") or 0)
            if batch_id <= 0 or not valid_sha256(collection_object.get("batchSha256")):
                raise AssertionError(f"{name}已映射但P46批次血缘无效")
            collection_batch_ids.add(batch_id)
            known += 1
        else:
            if any(value is not None for value in (receivable, received, official_rate)):
                raise AssertionError(f"{name}未映射却暴露官方收缴事实")
            if availability.get("collectionFactsAvailable") or availability.get("officialCollectionRateAvailable"):
                raise AssertionError(f"{name}未映射却标记收缴数据可用")
            if any(key in fields for key in ("receivable", "received", "official_collection_rate")):
                raise AssertionError(f"{name}未映射却生成收缴字段血缘")
            unknown += 1

    if known != EXPECTED_KNOWN_COLLECTION_MAPPINGS or unknown != EXPECTED_UNKNOWN_COLLECTION_MAPPINGS:
        raise AssertionError(
            f"生产项目收缴映射应为已知{EXPECTED_KNOWN_COLLECTION_MAPPINGS}/"
            f"未知{EXPECTED_UNKNOWN_COLLECTION_MAPPINGS}，当前已知{known}/未知{unknown}"
        )
    traceability = object_of(body.get("traceability"), "项目目录traceability")
    if int(traceability.get("batchId") or 0) <= 0 or not valid_sha256(traceability.get("sourceSha256")):
        raise AssertionError("项目目录批次血缘无效")
    return {
        "projectCount": actual_count,
        "knownMappings": known,
        "unknownMappings": unknown,
        "directoryBatchId": int(traceability["batchId"]),
        "collectionBatchIds": sorted(collection_batch_ids),
    }


def trend_display_contract(body: Any, *, require_rows: bool = False) -> tuple[str | None, str | None, int]:
    """校验服务端趋势为带P46血缘的 0-1 比例，并返回浏览器对照值。"""
    rows = rows_of(body)
    if require_rows and not rows:
        raise AssertionError("月度趋势写后GET仍为空")
    if rows and not isinstance(body, dict):
        raise AssertionError("月度趋势GET未返回{rows,status}")
    if rows:
        status = object_of(body.get("status"), "月度趋势status")
        if status.get("state") != "ready" or int(status.get("count", -1)) != len(rows):
            raise AssertionError("月度趋势status与rows不一致")
    first: float | None = None
    value_count = 0
    for row in rows:
        if row.get("quality_status") != "verified" or row.get("source") != "p46-official-collection":
            raise AssertionError(f"月度趋势{row.get('m')!r}不是已验证P46正式来源")
        if row.get("source_status") != "published":
            raise AssertionError(f"月度趋势{row.get('m')!r}未标记published")
        provenance = object_of(row.get("field_provenance"), f"月度趋势{row.get('m')}.field_provenance")
        if provenance.get("schemaVersion") != 1 or provenance.get("source") != "data_ingestion_rows.collection_center":
            raise AssertionError(f"月度趋势{row.get('m')!r}血缘schema/source无效")
        if int(provenance.get("batchId") or 0) <= 0 or not valid_sha256(provenance.get("batchSha256")):
            raise AssertionError(f"月度趋势{row.get('m')!r}批次血缘无效")
        if int(provenance.get("officialRowCount") or 0) != OFFICIAL_COLLECTION_CENTER_COUNT:
            raise AssertionError(f"月度趋势{row.get('m')!r}官方明细不是{OFFICIAL_COLLECTION_CENTER_COUNT}条")
        if provenance.get("businessDate") != row.get("business_date"):
            raise AssertionError(f"月度趋势{row.get('m')!r}业务日期与血缘不一致")
        if "SUM(receivable * collectionRate)" not in str(provenance.get("formula") or ""):
            raise AssertionError(f"月度趋势{row.get('m')!r}缺少官方加权公式")
        for area in TREND_AREAS:
            value = row.get(area)
            if value is None or value == "":
                raise AssertionError(f"月度趋势 {row.get('m')} {area} 缺失")
            if isinstance(value, bool):
                raise AssertionError(f"月度趋势 {area} 不得是布尔值")
            try:
                number = float(value)
            except (TypeError, ValueError) as error:
                raise AssertionError(f"月度趋势 {area} 不是数值：{value!r}") from error
            if not 0 <= number <= 1:
                raise AssertionError(f"月度趋势 {area} 超出 0-1 正式比例：{number}")
            value_count += 1
            if first is None:
                first = number
    if rows and first is None:
        raise AssertionError("月度趋势存在月份记录，但没有任何正式比例")
    if first is None:
        return None, None, 0
    return f"{first * 100:.2f}%", str(first), value_count


def archive_detail_contract(
    body: Any,
    *,
    archive_id: int,
    directory_batch_id: int,
    trend_batch_ids: set[int],
) -> dict[str, Any]:
    """验证服务端归档不可变、部分已验证，且只展示真实目录/P46嵌套血缘。"""
    if not isinstance(body, dict) or int(body.get("id") or 0) != archive_id:
        raise AssertionError("归档详情id不一致")
    if body.get("immutable") is not True:
        raise AssertionError("归档详情未明确immutable=true")
    payload = object_of(body.get("payload"), "归档payload")
    completeness = object_of(payload.get("completeness"), "归档payload.completeness")
    if completeness.get("state") != "partial_verified":
        raise AssertionError(f"归档完整性应为partial_verified，当前{completeness.get('state')!r}")
    summary = object_of(payload.get("summary"), "归档payload.summary")
    not_null = [field for field in ARCHIVE_NULL_SUMMARY_FIELDS if summary.get(field) is not None]
    if not_null:
        raise AssertionError(f"归档未知经营字段未保持null：{not_null}")
    unavailable = set(completeness.get("unavailableFields") or [])
    missing_unknown = sorted(set(ARCHIVE_UNKNOWN_FIELDS) - unavailable)
    if missing_unknown:
        raise AssertionError(f"归档未声明未知经营字段：{missing_unknown}")

    traceability = object_of(body.get("traceability"), "归档traceability")
    payload_traceability = object_of(payload.get("traceability"), "归档payload.traceability")
    if traceability.get("generationSignature") != payload_traceability.get("generationSignature"):
        raise AssertionError("归档顶层与payload血缘签名不一致")
    if not valid_sha256(traceability.get("generationSignature")):
        raise AssertionError("归档generationSignature无效")
    directory = object_of(traceability.get("projectDirectory"), "归档traceability.projectDirectory")
    facts = object_of(traceability.get("publishedFacts"), "归档traceability.publishedFacts")
    if int(directory.get("batchId") or 0) != directory_batch_id or not valid_sha256(directory.get("sourceSha256")):
        raise AssertionError("归档项目目录批次与GET回读不一致")
    fact_batch_id = int(facts.get("batchId") or 0)
    if fact_batch_id <= 0 or not valid_sha256(facts.get("batchSha256")) or not facts.get("businessDate"):
        raise AssertionError("归档P46事实批次血缘无效")
    if trend_batch_ids and fact_batch_id not in trend_batch_ids:
        raise AssertionError("归档P46事实批次未出现在写后趋势血缘中")
    return {
        "archiveId": archive_id,
        "immutable": True,
        "completeness": "partial_verified",
        "directoryBatchId": int(directory["batchId"]),
        "factBatchId": fact_batch_id,
        "unknownFieldsNull": list(ARCHIVE_NULL_SUMMARY_FIELDS),
    }


def choose_same_area_centers(
    options: list[dict[str, Any]], payments: list[dict[str, Any]], collections: list[dict[str, Any]], projects: list[dict[str, Any]]
) -> tuple[dict[str, str], dict[str, str]]:
    payment_names = {str(row.get("center") or "") for row in payments}
    collection_names = {str(row.get("center") or "") for row in collections}
    project_names = {str(row.get("name") or "") for row in projects}
    eligible = [
        {"center": str(row.get("center") or row.get("value") or ""), "area": str(row.get("area") or "")}
        for row in options
        if str(row.get("center") or row.get("value") or "") in payment_names
        and str(row.get("center") or row.get("value") or "") in collection_names
        and str(row.get("center") or row.get("value") or "") in project_names
    ]
    for first in eligible:
        for second in eligible:
            if first["center"] != second["center"] and first["area"] and first["area"] == second["area"]:
                return first, second
    raise AssertionError("生产未找到同片区且同时有回款、收缴和项目目录的两个服务中心")


def assert_member_rows(token: str, own: str, denied: str) -> dict[str, int]:
    member = Api(token)
    counts: dict[str, int] = {}
    for path, key in [
        ("/api/payments", "center"),
        ("/api/collections", "center"),
        ("/api/projects", "name"),
    ]:
        result = member.request(path)
        body = expect(result, {200}, f"成员读取{path}")
        rows = rows_of(body)
        if not rows or any(str(row.get(key) or "") != own for row in rows):
            raise AssertionError(f"{path}未严格收口到{own}")
        serialized = json.dumps(body, ensure_ascii=False)
        if denied in serialized:
            raise AssertionError(f"{path}泄露同片区其他中心")
        counts[path] = len(rows)
    return counts


def browser_check(
    token: str,
    viewport_name: str,
    viewport: dict[str, int],
    trend_expected: str | None,
    trend_raw: str | None,
) -> dict[str, Any]:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        # 只在本地自动化浏览器上绕过 CSP 以注入 axe，不修改线上安全头。
        context = browser.new_context(viewport=viewport, bypass_csp=True)
        quoted_token = json.dumps(token)
        context.add_init_script(
            script=f"""(() => {{
              const token = {quoted_token};
              localStorage.setItem('cockpit_token', token);
              localStorage.setItem('token', token);
              localStorage.setItem('cockpit_user', JSON.stringify({{username:'R66受控验收',role:'admin'}}));
            }})()""",
        )
        page = context.new_page()
        page_errors: list[str] = []
        console_errors: list[str] = []
        failed_requests: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("requestfailed", lambda request: failed_requests.append(request.url) if request.failure != "net::ERR_ABORTED" else None)
        page.goto(f"{BASE}/admin", wait_until="networkidle", timeout=60_000)
        admin = page.locator(".r65-admin")
        admin.wait_for(state="visible", timeout=30_000)
        nav = page.get_by_role("navigation", name="系统管理功能")
        if nav.get_by_role("button").count() != 8:
            raise AssertionError("生产系统管理不是8个功能域")
        for key in ("payments", "collections", "trends", "rules", "logs", "reports", "sources", "users"):
            nav.locator(f'[data-r65-tab="{key}"]').click()
            page.wait_for_timeout(350)
            if key == "trends" and trend_expected:
                trend_region = page.get_by_role("region", name="已验证月度趋势")
                trend_region.get_by_text(trend_expected, exact=True).first.wait_for(timeout=15_000)
                trend_text = trend_region.inner_text()
                if trend_raw and trend_raw in trend_text:
                    raise AssertionError(f"生产月度趋势直接显示了 0-1 原始比例：{trend_raw}")
            visible_errors = [text for text in page.get_by_role("alert").all_inner_texts() if text.strip()]
            if visible_errors:
                raise AssertionError(f"生产{key}域显示错误：{visible_errors[:2]}")
        nav.locator('[data-r65-tab="payments"]').click()
        page.get_by_role("region", name="正式回款额").wait_for(timeout=15_000)
        page.wait_for_timeout(500)
        overflow = page.evaluate("Math.max(0, document.documentElement.scrollWidth - innerWidth)")
        axe_blocking: list[dict[str, Any]] = []
        if AXE_PATH.is_file():
            page.add_script_tag(path=str(AXE_PATH))
            axe = page.evaluate("""async () => await axe.run(document.querySelector('.r65-admin'), {
              runOnly: {type:'tag', values:['wcag2a','wcag2aa','wcag21aa']}
            })""")
            axe_blocking = [
                {"id": item["id"], "impact": item.get("impact"), "nodes": len(item.get("nodes", []))}
                for item in axe["violations"]
                if item.get("impact") in {"critical", "serious"}
            ]
        screenshot = OUT / f"r66-production-admin-{viewport_name}.png"
        page.screenshot(path=str(screenshot), full_page=True)
        context.close()
        browser.close()
    if page_errors or console_errors or failed_requests or overflow > 1 or axe_blocking:
        raise AssertionError(
            f"{viewport_name}浏览器门禁失败："
            f"page={page_errors},console={console_errors},requests={len(failed_requests)},overflow={overflow},axe={axe_blocking}"
        )
    return {"viewport": viewport, "tabs": 8, "overflow": overflow, "axeBlocking": 0, "screenshot": str(screenshot)}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    token = ""
    temp_passwords: list[str] = []
    temp_tokens: list[str] = []
    created_users: list[dict[str, Any]] = []
    cleanup: list[dict[str, Any]] = []
    rule_restore: dict[str, Any] | None = None
    result: dict[str, Any] = {
        "production": True,
        "origin": BASE,
        "mode": "controlled-write" if ALLOW_WRITES else "read-only",
        "writesExplicitlyEnabled": ALLOW_WRITES,
        "checks": {},
        "actions": {},
        "permissions": {},
        "browser": {},
        "cleanup": cleanup,
        "tokenPersisted": False,
        "passwordPersisted": False,
    }
    failure: str | None = None
    api: Api | None = None
    try:
        health = Api().request("/api/health/ready")
        expect(health, {200}, "health/ready")
        result["checks"]["health"] = safe_check(health)
        token = admin_token()
        api = Api(token)

        read_paths = {
            "payments": "/api/payments",
            "collections": "/api/collections",
            "trends": "/api/trends",
            "rules": "/api/governance/rules",
            "logs": "/api/governance/logs?limit=300",
            "archives": "/api/governance/report-archives",
            "sources": "/api/data-sources/status",
            "users": "/api/users",
            "centers": "/api/users/service-centers",
            "projects": "/api/projects",
            "projectGate": "/api/data-quality/project-gate",
        }
        snapshots: dict[str, Any] = {}
        for name, path in read_paths.items():
            response = api.request(path)
            snapshots[name] = expect(response, {200}, name)
            result["checks"][name] = safe_check(response)

        trend_expected, trend_raw, trend_value_count = trend_display_contract(snapshots["trends"])
        result["checks"]["trendRatio"] = {
            "contract": "0-1",
            "valueCount": trend_value_count,
            "displaySample": trend_expected,
        }

        users = rows_of(snapshots["users"])
        unassigned_users = [
            row for row in users
            if row.get("role") != "admin" and not str(row.get("service_center_scope") or "").strip()
        ]
        result["permissions"]["unassignedExistingCount"] = len(unassigned_users)
        for row in unassigned_users:
            scoped_token = ephemeral_user_token(int(row["id"]))
            temp_tokens.append(scoped_token)
            unassigned_api = Api(scoped_token)
            for path in ("/api/payments", "/api/collections", "/api/projects", "/api/export/projects-csv"):
                response = unassigned_api.request(path)
                expect(response, {200, 403, 404, 409}, f"未分配成员{path}")
                text = response["text"]
                center_names = [
                    str(item.get("center") or item.get("name") or "").strip()
                    for item in rows_of(snapshots["centers"])
                ]
                if any(center and center in text for center in center_names):
                    raise AssertionError(f"未分配成员从{path}读取到服务中心")

        if ALLOW_WRITES:
            for path in (
                "/api/projects/directory/publish",
                "/api/trends/rebuild",
                "/api/governance/report-archives/generate",
            ):
                denied = api.request(path, "POST", {})
                expect(denied, {400}, f"{path}缺确认")
            for path in (
                "/api/projects/directory/publish-confirmed",
                "/api/trends/rebuild-confirmed",
                "/api/governance/report-archives/generate-confirmed",
            ):
                retired = api.request(path, "POST", {})
                expect(retired, {404, 405, 410}, f"{path}旧路由")

            directory_action = {"confirmation": "确认发布项目目录"}
            published = api.request("/api/projects/directory/publish", "POST", directory_action)
            published_body = object_of(expect(published, {200}, "发布项目目录"), "发布项目目录响应")
            published_again = api.request("/api/projects/directory/publish", "POST", directory_action)
            published_again_body = object_of(
                expect(published_again, {200}, "二次发布项目目录"), "二次发布项目目录响应"
            )
            if published_again_body.get("idempotent") is not True:
                raise AssertionError("项目目录第二次发布未返回idempotent=true")
            if any(int(published_again_body.get(key) or 0) != 0 for key in ("inserted", "updated", "deactivated")):
                raise AssertionError("项目目录幂等确认仍修改了正式数据")
            directory_after = api.request("/api/projects")
            directory_after_body = expect(directory_after, {200}, "项目目录写后GET回读")
            directory_contract = directory_readback_contract(directory_after_body)
            snapshots["projects"] = directory_after_body
            result["checks"]["projectsAfterPublish"] = {**safe_check(directory_after), **directory_contract}
            result["actions"]["publishDirectory"] = {
                **safe_check(published),
                "idempotent": bool(published_body.get("idempotent")),
                "inserted": published_body.get("inserted"),
                "updated": published_body.get("updated"),
                "second": {
                    "status": published_again["status"],
                    "idempotent": True,
                    "unchanged": published_again_body.get("unchanged"),
                },
            }

            trend_action = {"confirmation": "确认重建月度趋势"}
            rebuilt = api.request("/api/trends/rebuild", "POST", trend_action)
            rebuilt_body = object_of(expect(rebuilt, {200}, "重建月度趋势"), "重建月度趋势响应")
            if not rows_of(rebuilt_body):
                raise AssertionError("月度趋势重建后仍为空")
            rebuilt_again = api.request("/api/trends/rebuild", "POST", trend_action)
            rebuilt_again_body = object_of(
                expect(rebuilt_again, {200}, "二次重建月度趋势"), "二次重建月度趋势响应"
            )
            if rebuilt_again_body.get("idempotent") is not True:
                raise AssertionError("月度趋势第二次重建未返回idempotent=true")
            if any(int(rebuilt_again_body.get(key) or 0) != 0 for key in ("inserted", "updated")):
                raise AssertionError("月度趋势幂等确认仍改写了数据")
            trends_after = api.request("/api/trends")
            trends_after_body = expect(trends_after, {200}, "月度趋势写后GET回读")
            trend_expected, trend_raw, trend_value_count = trend_display_contract(
                trends_after_body, require_rows=True
            )
            if rows_of(rebuilt_again_body) != rows_of(trends_after_body):
                raise AssertionError("月度趋势第二次响应与GET回读不一致")
            trend_batch_ids = {
                int(object_of(row.get("field_provenance"), f"趋势{row.get('m')}血缘")["batchId"])
                for row in rows_of(trends_after_body)
            }
            snapshots["trends"] = trends_after_body
            result["checks"]["trendsAfterRebuild"] = {
                **safe_check(trends_after),
                "contract": "ratio_0_to_1",
                "valueCount": trend_value_count,
                "displaySample": trend_expected,
                "batchIds": sorted(trend_batch_ids),
            }
            result["actions"]["rebuildTrends"] = {
                **safe_check(rebuilt),
                "idempotent": bool(rebuilt_body.get("idempotent")),
                "second": {
                    "status": rebuilt_again["status"],
                    "idempotent": True,
                    "unchanged": rebuilt_again_body.get("unchanged"),
                },
            }

            report_date = datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()
            archive_action = {
                "confirmation": "确认生成正式归档",
                "area": "华北",
                "version": "operation",
                "reportDate": report_date,
            }
            archived = api.request("/api/governance/report-archives/generate", "POST", archive_action)
            archived_body = object_of(expect(archived, {200, 201}, "生成正式归档"), "生成正式归档响应")
            archive_id = int(archived_body.get("id") or 0)
            if archive_id <= 0:
                raise AssertionError("生成正式归档未返回有效id")
            archived_again = api.request("/api/governance/report-archives/generate", "POST", archive_action)
            archived_again_body = object_of(
                expect(archived_again, {200}, "二次生成正式归档"), "二次生成正式归档响应"
            )
            if archived_again_body.get("idempotent") is not True:
                raise AssertionError("正式归档第二次生成未返回idempotent=true")
            if int(archived_again_body.get("id") or 0) != archive_id:
                raise AssertionError("正式归档幂等确认返回了不同id")
            archives_after = api.request("/api/governance/report-archives")
            archives_after_body = object_of(
                expect(archives_after, {200}, "归档列表写后GET回读"), "归档列表写后响应"
            )
            archive_status = object_of(archives_after_body.get("status"), "归档列表status")
            if archive_status.get("state") != "ready":
                raise AssertionError(f"归档列表写后未就绪：{archive_status.get('state')!r}")
            if not any(int(row.get("id") or 0) == archive_id for row in rows_of(archives_after_body)):
                raise AssertionError("正式归档列表未回读到新生成记录")
            archive_detail_response = api.request(f"/api/governance/report-archives/{archive_id}")
            archive_detail_body = expect(archive_detail_response, {200}, "正式归档详情回读")
            archive_contract = archive_detail_contract(
                archive_detail_body,
                archive_id=archive_id,
                directory_batch_id=int(directory_contract["directoryBatchId"]),
                trend_batch_ids=trend_batch_ids,
            )
            result["checks"]["archiveDetail"] = {
                **safe_check(archive_detail_response), **archive_contract
            }
            result["actions"]["generateArchive"] = {
                **safe_check(archived),
                "idempotent": bool(archived_body.get("idempotent")),
                "archiveId": archive_id,
                "second": {
                    "status": archived_again["status"],
                    "idempotent": True,
                    "archiveId": archive_id,
                },
            }

            payment_rows = rows_of(expect(api.request("/api/payments"), {200}, "回款回读"))
            if not payment_rows:
                raise AssertionError("生产没有可验收的正式回款记录")
            payment = payment_rows[0]
            payment_before = dict(payment)
            payment_blocked = api.request(
                f"/api/payments/{int(payment['id'])}",
                "PUT",
                {"annualBudget": payment.get("annualBudget"), "version": int(payment["version"])},
            )
            payment_blocked_body = expect(payment_blocked, {403}, "生产回款手工写入阻断")
            if payment_blocked_body.get("code") != "FORMAL_PAYMENT_READ_ONLY":
                raise AssertionError("回款写入未返回正式只读合同")
            payment_after = next(
                row for row in rows_of(expect(api.request("/api/payments"), {200}, "回款阻断后回读"))
                if int(row["id"]) == int(payment["id"])
            )
            if payment_after != payment_before:
                raise AssertionError("生产回款写入被阻断后数据仍发生变化")
            result["actions"]["paymentFormalReadOnly"] = {
                "status": payment_blocked["status"], "id": payment.get("id"), "unchanged": True
            }

            rules = rows_of(expect(api.request("/api/governance/rules"), {200}, "规则回读"))
            if not rules:
                raise AssertionError("生产没有可验收的预警规则")
            rule = rules[0]
            rule_restore = {
                "id": int(rule["id"]),
                "threshold_value": rule["threshold_value"],
                "enabled": bool(rule.get("enabled")),
            }
            rule_saved = api.request(
                f"/api/governance/rules/{int(rule['id'])}",
                "PUT",
                {"threshold_value": rule["threshold_value"], "enabled": bool(rule.get("enabled"))},
            )
            expect(rule_saved, {200}, "规则同值写入")
            rule_after = next(
                row for row in rows_of(expect(api.request("/api/governance/rules"), {200}, "规则写后回读"))
                if int(row["id"]) == int(rule["id"])
            )
            if float(rule_after["threshold_value"]) != float(rule["threshold_value"]):
                raise AssertionError("规则同值回读不一致")
            result["actions"]["ruleSameValue"] = {"status": rule_saved["status"], "id": rule.get("id")}

            sources = rows_of(expect(api.request("/api/data-sources/status"), {200}, "数据源回读"))
            sync_results = []
            for source in sources:
                source_key = str(source.get("source_key") or "")
                if not source_key:
                    continue
                checked = api.request(f"/api/data-sources/sync/{urllib.parse.quote(source_key)}", "POST", {})
                checked_body = expect(checked, {200}, f"检测数据源{source_key}")
                sync_results.append({"source": source_key, "status": checked["status"], "runStatus": checked_body.get("run", {}).get("status")})
            result["actions"]["sourceChecks"] = sync_results

            repair_negative = api.request("/api/data-sources/repair/aph", "POST", {})
            expect(repair_negative, {400}, "APH修复缺确认")
            result["actions"]["aphRepairPositiveSkipped"] = True

            projects = rows_of(expect(api.request("/api/projects"), {200}, "项目目录回读"))
            collections = rows_of(expect(api.request("/api/collections"), {200}, "收缴回读"))
            centers = rows_of(expect(api.request("/api/users/service-centers"), {200}, "服务中心回读"))
            center_a, center_b = choose_same_area_centers(centers, payment_rows, collections, projects)

            password_a = f"R66x!{secrets.token_urlsafe(18)}9a"
            password_b = f"R66x!{secrets.token_urlsafe(18)}9b"
            temp_passwords.extend([password_a, password_b])
            for suffix, center, password in (("a", center_a, password_a), ("b", center_b, password_b)):
                username = f"{USER_PREFIX}-{suffix}"
                created = api.request(
                    "/api/users",
                    "POST",
                    {"username": username, "password": password, "role": "viewer", "service_center_scope": center["center"]},
                )
                created_body = expect(created, {201}, f"创建临时成员{suffix}")
                created_users.append({"id": int(created_body["id"]), "username": username, "center": center["center"]})

            user_a, user_b = created_users[-2:]
            token_a = login(user_a["username"], password_a)
            token_b = login(user_b["username"], password_b)
            temp_tokens.extend([token_a, token_b])
            isolation_a = assert_member_rows(token_a, user_a["center"], user_b["center"])
            isolation_b = assert_member_rows(token_b, user_b["center"], user_a["center"])
            b_project = next(row for row in projects if row.get("name") == user_b["center"])
            cross = Api(token_a).request(f"/api/projects/{int(b_project['id'])}")
            expect(cross, {404}, "跨中心项目详情")
            if user_b["center"] in cross["text"]:
                raise AssertionError("跨中心详情拒绝泄露资源名称")

            for path, body in (
                ("/api/projects/directory/publish", {"confirmation": "确认发布项目目录"}),
                ("/api/trends/rebuild", {"confirmation": "确认重建月度趋势"}),
                ("/api/governance/report-archives/generate", {"confirmation": "确认生成正式归档", "area": "华北", "version": "operation"}),
            ):
                expect(Api(token_a).request(path, "POST", body), {403}, f"普通成员写入{path}")

            scope_changed = api.request(
                f"/api/users/{user_a['id']}/scope", "PUT", {"service_center_scope": user_b["center"]}
            )
            expect(scope_changed, {200}, "临时成员范围修改")
            expect(Api(token_a).request("/api/auth/me"), {401}, "范围修改后旧JWT失效")
            token_a = login(user_a["username"], password_a)
            temp_tokens.append(token_a)
            assert_member_rows(token_a, user_b["center"], user_a["center"])
            expect(
                api.request(f"/api/users/{user_a['id']}/scope", "PUT", {"service_center_scope": user_a["center"]}),
                {200},
                "临时成员范围回滚",
            )
            expect(Api(token_a).request("/api/auth/me"), {401}, "范围回滚后旧JWT失效")
            token_a = login(user_a["username"], password_a)
            temp_tokens.append(token_a)

            role_saved = api.request(
                f"/api/users/{user_a['id']}/role",
                "PUT",
                {"role": "viewer", "service_center_scope": user_a["center"]},
            )
            expect(role_saved, {200}, "临时成员角色保存")
            expect(Api(token_a).request("/api/auth/me"), {401}, "角色保存后旧JWT失效")
            token_a = login(user_a["username"], password_a)
            temp_tokens.append(token_a)

            new_password = f"R66y!{secrets.token_urlsafe(18)}8z"
            temp_passwords.append(new_password)
            password_saved = api.request(
                f"/api/users/{user_a['id']}/password", "PUT", {"password": new_password}
            )
            expect(password_saved, {200}, "临时成员密码重置")
            expect(Api(token_a).request("/api/auth/me"), {401}, "改密后旧JWT失效")
            old_login = Api().request(
                "/api/auth/login", "POST", {"username": user_a["username"], "password": password_a}
            )
            expect(old_login, {401}, "旧密码拒绝")
            token_a = login(user_a["username"], new_password)
            temp_tokens.append(token_a)
            assert_member_rows(token_a, user_a["center"], user_b["center"])
            result["permissions"].update(
                {
                    "sameArea": center_a["area"],
                    "centerA": center_a["center"],
                    "centerB": center_b["center"],
                    "memberA": isolation_a,
                    "memberB": isolation_b,
                    "crossDetailStatus": cross["status"],
                    "scopeRolePasswordInvalidatedOldJwt": True,
                    "viewerWritesDenied": True,
                }
            )

            audit_rows = rows_of(expect(api.request("/api/governance/logs?limit=300"), {200}, "审计日志回读"))
            action_counts: dict[str, int] = {}
            for row in audit_rows:
                action = str(row.get("action") or "")
                action_counts[action] = action_counts.get(action, 0) + 1
            required_actions = FORMAL_ACTION_AUDITS | {
                "修改预警规则", "检测外部数据源", "创建用户",
                "修改用户数据范围", "修改用户角色", "重置用户密码",
            }
            missing_actions = sorted(action for action in required_actions if action_counts.get(action, 0) < 1)
            if missing_actions:
                raise AssertionError(f"审计日志缺失：{missing_actions}")
            result["actions"]["auditRequiredActionsPresent"] = {
                "ok": True,
                "formalFirstAndIdempotent": {
                    action: action_counts[action] for action in sorted(FORMAL_ACTION_AUDITS)
                },
            }

        result["browser"]["desktop1440"] = browser_check(
            token, "desktop-1440", {"width": 1440, "height": 900}, trend_expected, trend_raw
        )
        result["browser"]["mobile390"] = browser_check(
            token, "mobile-390", {"width": 390, "height": 844}, trend_expected, trend_raw
        )
    except BaseException as error:
        failure = f"{type(error).__name__}: {error}"
    finally:
        # 回款为正式只读，无需恢复；仅恢复规则并删除临时成员。
        if api is not None and ALLOW_WRITES and rule_restore is not None:
            item = {"type": "rule", "id": rule_restore["id"], "restored": False, "verified": False}
            try:
                current_rules = rows_of(expect(api.request("/api/governance/rules"), {200}, "规则清理前回读"))
                current = next(row for row in current_rules if int(row.get("id") or 0) == rule_restore["id"])
                changed = (
                    float(current["threshold_value"]) != float(rule_restore["threshold_value"])
                    or bool(current.get("enabled")) != bool(rule_restore["enabled"])
                )
                if changed:
                    expect(
                        api.request(
                            f"/api/governance/rules/{rule_restore['id']}",
                            "PUT",
                            {
                                "threshold_value": rule_restore["threshold_value"],
                                "enabled": rule_restore["enabled"],
                            },
                        ),
                        {200},
                        "规则原值恢复",
                    )
                item["restored"] = True
                verify_rules = rows_of(expect(api.request("/api/governance/rules"), {200}, "规则恢复后回读"))
                verified = next(row for row in verify_rules if int(row.get("id") or 0) == rule_restore["id"])
                item["verified"] = (
                    float(verified["threshold_value"]) == float(rule_restore["threshold_value"])
                    and bool(verified.get("enabled")) == bool(rule_restore["enabled"])
                )
                if not item["verified"]:
                    raise AssertionError("规则原值恢复后校验失败")
            except BaseException as restore_error:
                item["error"] = f"{type(restore_error).__name__}: {restore_error}"
            cleanup.append(item)

        # 只删除本次记录且前缀严格匹配的临时成员；任一失败都让整次验收失败。
        if api is not None:
            for user in reversed(created_users):
                item = {"id": user.get("id"), "username": user.get("username"), "deleted": False, "verifiedAbsent": False}
                try:
                    if not str(user.get("username") or "").startswith("r66-qa-"):
                        raise AssertionError("拒绝删除非R66临时账号")
                    deleted = api.request(
                        f"/api/users/{int(user['id'])}", "DELETE", {"confirmation": user["username"]}
                    )
                    expect(deleted, {200, 404}, f"清理临时成员{user['id']}")
                    item["deleted"] = True
                    users_after = rows_of(expect(api.request("/api/users"), {200}, "清理后成员回读"))
                    item["verifiedAbsent"] = not any(int(row.get("id") or 0) == int(user["id"]) for row in users_after)
                    if not item["verifiedAbsent"]:
                        raise AssertionError("临时成员删除后仍存在")
                except BaseException as cleanup_error:
                    item["error"] = f"{type(cleanup_error).__name__}: {cleanup_error}"
                cleanup.append(item)
        secret_candidates = [
            value
            for value in [
                token,
                *temp_tokens,
                *temp_passwords,
                os.environ.get("R66_ADMIN_TOKEN", ""),
                os.environ.get("R66_UNASSIGNED_TOKEN", ""),
            ]
            if value
        ]
        token = ""
        temp_tokens = []
        temp_passwords = []

        cleanup_errors = [
            item for item in cleanup
            if item.get("error")
            or (item.get("type") in {"payment", "rule"} and not item.get("verified"))
            or ("username" in item and not item.get("verifiedAbsent"))
        ]

        def scrub(value: str | None) -> str | None:
            if value is None:
                return None
            cleaned = value
            for secret in secret_candidates:
                cleaned = cleaned.replace(secret, "[REDACTED]")
            cleaned = re.sub(r"eyJ[A-Za-z0-9_.-]{40,}", "[REDACTED_JWT]", cleaned)
            return cleaned

        result["failure"] = scrub(failure)
        for item in cleanup:
            if item.get("error"):
                item["error"] = scrub(str(item["error"]))
        result["ok"] = failure is None and not cleanup_errors
        result["completedAt"] = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
        RESULT_FILE.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(
            json.dumps(
                {
                    "ok": result["ok"],
                    "mode": result["mode"],
                    "checks": len(result["checks"]),
                    "actions": len(result["actions"]),
                    "cleanup": cleanup,
                    "resultFile": str(RESULT_FILE),
                },
                ensure_ascii=False,
            )
        )
        if failure is not None or cleanup_errors:
            raise SystemExit(scrub(failure) or f"临时账号清理失败：{cleanup_errors}")


if __name__ == "__main__":
    main()
