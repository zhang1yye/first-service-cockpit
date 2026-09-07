#!/usr/bin/env python3
"""R66 全功能系统管理浏览器验收：新不可变资产 + 正式 API 合同模拟。"""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import Route, TimeoutError as PlaywrightTimeoutError, sync_playwright


BASE_URL = os.environ.get("R66_QA_BASE_URL", "http://127.0.0.1:43166/")
CENTER_A = "第一服务QA甲服务中心"
CENTER_B = "第一服务QA乙服务中心"
AXE_PATH = Path(__file__).resolve().parents[1] / "node_modules" / "axe-core" / "axe.min.js"


def archive_traceability() -> dict[str, object]:
    """与 report-archive-generator 输出一致的嵌套血缘。"""
    return {
        "reportDate": "2026-08-13",
        "reportMonth": "2026-08",
        "area": "华北",
        "edition": "operation",
        "projectDirectory": {
            "batchId": 66,
            "sourceFile": "项目档案.xlsx",
            "sourceSha256": "a" * 64,
            "sourceSheet": "在管项目",
            "importedAt": "2026-08-12T08:00:00+08:00",
            "profileCount": 1,
        },
        "publishedFacts": {
            "batchId": 46,
            "batchSha256": "b" * 64,
            "businessDate": "2026-08-12",
            "extractedAt": "2026-08-12T09:00:00+08:00",
            "publishedAt": "2026-08-12T10:00:00+08:00",
            "paymentRows": 1,
            "officialCollectionRows": 35,
        },
        "formulas": {
            "official_collection_rate": "SUM(receivable * collectionRate) / SUM(receivable), receivable > 0",
            "collectionRate": "official_collection_rate * 100",
        },
        "metricUnits": {"official_collection_rate": "ratio_0_to_1", "collectionRate": "percent_0_to_100"},
        "knownFields": ["project_count", "collectionRate"],
        "unavailableFields": ["annual_income", "annual_cost", "quality_score", "customer_satisfaction"],
        "generationSignature": "c" * 64,
    }


class ApiHarness:
    def __init__(
        self,
        *,
        center_failure: bool = False,
        auth_role: str = "admin",
        directory_state: str = "directory_ready",
        publication_mode: str = "complete",
    ) -> None:
        self.center_failure = center_failure
        self.auth_role = auth_role
        self.directory_state = directory_state
        self.publication_mode = publication_mode
        self.requests: list[dict] = []

    @staticmethod
    def _json(route: Route, body: object, status: int = 200) -> None:
        route.fulfill(
            status=status,
            content_type="application/json; charset=utf-8",
            body=json.dumps(body, ensure_ascii=False),
        )

    def handle(self, route: Route) -> None:
        request = route.request
        path = urlparse(request.url).path
        method = request.method
        try:
            request_body = json.loads(request.post_data or "null")
        except json.JSONDecodeError:
            request_body = request.post_data
        self.requests.append({"method": method, "path": path, "body": request_body})

        if path == "/api/auth/me":
            return self._json(route, {
                "user": {
                    "id": 1,
                    "username": "qa-admin" if self.auth_role == "admin" else "qa-legacy-member",
                    "role": self.auth_role,
                    "serviceCenterScope": "" if self.auth_role == "admin" else CENTER_A,
                }
            })
        if path == "/api/payments" and method == "GET":
            return self._json(route, [{
                "id": 1, "area": "QA同片区", "center": CENTER_A,
                "annualBudget": 100, "cumulativeBudget": 80,
                "cumulativeExecuted": 70, "samePeriod": 60,
                "collectionRate": 88, "version": 2,
            }])
        if path == "/api/summary":
            return self._json(route, {
                "annualBudget": 100, "cumulativeBudget": 80, "cumulativeExecuted": 70,
                "samePeriod": 60, "growth": 0.16, "collectionRate": 0.88,
                "collectionReceivable": 100, "collectionReceived": 88,
                "collectionAnnualTargets": [], "collectionSourceStatus": "published",
            })
        if path == "/api/daily":
            return self._json(route, {"date": "2026-08-13", "rows": [], "dailyTotal": None, "sourceStatus": "missing"})
        if path == "/api/daily/dates":
            return self._json(route, [])
        if path == "/api/projects":
            directory_ready = self.directory_state == "directory_ready"
            return self._json(route, {
                "rows": [{
                    "id": 1, "name": CENTER_A, "area": "QA同片区", "property_type": "住宅",
                    "area_sqm": 1000, "units": 100, "receivable": 100, "received": 88,
                    "annual_income": None, "annual_cost": None, "ytd_income": None, "ytd_cost": None,
                    "quality_score": None, "safety_incidents": None,
                    "customer_satisfaction": None, "complaint_count": None,
                    "validation_status": "directory_only", "data_status": "directory_only",
                }],
                "total": 1,
                "status": {
                    "state": self.directory_state,
                    "projectCount": 1,
                    "message": "已发布1个权威项目目录" if directory_ready else "项目目录中存在未验证或演示数据，已阻断正式使用",
                },
                "traceability": {"sourceTable": "project_profiles", "batchId": 66, "sourceFile": "项目档案.xlsx"},
            })
        if path == "/api/projects/summary":
            return self._json(route, {"rows": []})
        if path == "/api/projects/areas":
            return self._json(route, {"areas": ["QA同片区"]})
        if path == "/api/projects/1":
            project = {
                "id": 1, "name": CENTER_A, "area": "QA同片区", "property_type": "住宅",
                "annual_income": None, "annual_cost": None, "ytd_income": None, "ytd_cost": None,
                "receivable": 100, "received": 88, "quality_score": None,
                "safety_incidents": None, "customer_satisfaction": None, "complaint_count": None,
                "area_sqm": 1000, "units": 100,
                "validation_status": "directory_only", "data_status": "directory_only",
            }
            return self._json(route, {"project": project, "collectionRate": 88, "profitRate": None, "areaAvg": {}})
        if path == "/api/data-quality/project-gate":
            return self._json(route, {"ready": False, "status": "blocked", "scoped": True, "projectCount": 1, "reasons": ["项目仅有目录，经营指标未接入"]})
        if path == "/api/alerts":
            return self._json(route, {"alerts": [], "total": 0, "summary": "当前未发现重大经营异常。", "thresholds": []})
        if path == "/api/ai/trends":
            return self._json(route, {"rows": [], "summary": {"total": 0, "lagging": 0, "topLagging": [], "realSnapshotCount": 0}})
        if path == "/api/ai/risk-trends":
            return self._json(route, {"rows": [], "summary": {"total": 0, "withSnapshots": 0, "worsening": 0, "improving": 0}})
        if path == "/api/ai/project/1/diagnosis":
            return self._json(route, {"projectId": 1, "level": "稳健", "reasons": [], "actions": [], "text": "本中心经营稳定。"})
        if path == "/api/ai/interpret":
            return self._json(route, {"text": "本中心经营数据已加载。"})
        if path == "/api/ai/monthly-report":
            return self._json(route, {
                "reportDate": "2026-08-13", "area": CENTER_A,
                "summary": {"project_count": 1, "collectionRate": 88, "profitRate": 57},
                "areaRank": [], "alerts": [], "dataQuality": {"projectCount": 1},
                "autoTaskReview": None, "riskTrendSummary": {"worsening": [], "improving": [], "total": 0},
                "weakestProjects": [], "sections": [{"title": "一、区域经营总览", "content": "本中心数据已加载。"}],
                "aiText": "",
            })
        if path == "/api/forecasts":
            return self._json(route, {"rows": [], "summary": {}, "workflow": {}, "discipline": {"roles": {}}})
        if path == "/api/formal-outputs":
            return self._json(route, {"rows": []})
        if path.startswith("/api/arrears/"):
            return self._json(route, {"rows": [], "projectCount": 0, "totalAmount": 0})
        if path == "/api/payments/1" and method == "PUT":
            return self._json(route, {"error": "生产回款事实为正式只读数据", "code": "FORMAL_PAYMENT_READ_ONLY"}, 403)
        if path == "/api/collections":
            return self._json(route, {"rows": [{
                "id": 1, "area": "QA同片区", "center": CENTER_A,
                "receivable": 100, "received": 88,
                "overdue30": None, "overdue90": None,
            }]})
        if path == "/api/trends" and method == "GET":
            return self._json(route, {
                "rows": [{
                    "m": "2026-08", "华北汇总": 0.88, "source": "p46-official-collection",
                    "quality_status": "verified", "business_date": "2026-08-12",
                    "field_provenance": {"sourceTable": "official_collection_rows", "batchId": 46},
                }],
                "status": {"state": "ready", "count": 1, "latestMonth": "2026-08", "message": "已读取1个已验证月份"},
            })
        if path == "/api/trends/rebuild" and method == "POST":
            return self._json(route, {
                "success": True, "idempotent": False,
                "rows": [{"m": "2026-08", "华北汇总": 0.88, "source": "p46-official-collection", "quality_status": "verified", "business_date": "2026-08-12"}],
                "status": {"state": "ready", "count": 1, "latestMonth": "2026-08", "message": "已从已发布批次重建1个月份"},
            })
        if path == "/api/governance/rules":
            return self._json(route, {"rows": [{
                "id": 1, "label": "低收缴率", "rule_key": "collection_low",
                "threshold_value": 80, "description": "低于阈值预警", "enabled": True,
            }]})
        if path == "/api/governance/logs":
            return self._json(route, {"rows": [{
                "id": 1, "created_at": "2026-08-13 10:00", "username": "qa-admin",
                "action": "查看", "target": "系统管理", "result": "成功",
            }]})
        if path == "/api/governance/report-archives" and method == "GET":
            return self._json(route, {"rows": [{
                "id": 1, "report_date": "2026-08", "version": "leader",
                "status": "已归档", "created_by": "qa-admin", "created_at": "2026-08-13",
            }], "status": {"state": "ready", "count": 1, "latestReportDate": "2026-08", "message": "已读取1份不可变归档"}})
        if path == "/api/governance/report-archives/generate" and method == "POST":
            return self._json(route, {
                "success": True, "idempotent": True, "id": 1, "archiveVersion": "A1",
                "status": {"state": "ready", "count": 1, "message": "本月经营归档已存在，已返回原归档"},
                "traceability": archive_traceability(),
            })
        if path == "/api/governance/report-archives/1":
            traceability = archive_traceability()
            return self._json(route, {
                "id": 1, "report_date": "2026-08-13", "area": "华北", "version": "operation",
                "archive_version": "A1", "status": "已归档", "summary": "正式归档摘要",
                "created_by": "qa-admin", "snapshot_month": "2026-08",
                "payload": {"reportDate": "2026-08-13", "summary": "正式归档摘要", "traceability": traceability},
                "traceability": traceability,
                "comparison": {"metricChanges": [{"key": "collectionRate", "label": "综合收缴率", "current": 88, "delta": 1}]},
            })
        if path == "/api/projects/directory/publish" and method == "POST":
            return self._json(route, {
                "success": True, "idempotent": False,
                "status": {"state": "directory_ready", "projectCount": 1, "message": "权威项目目录已发布"},
                "traceability": {"sourceTable": "project_profiles", "batchId": 66, "sourceFile": "项目档案.xlsx"},
                "inserted": 1, "updated": 0, "deactivated": 0,
            })
        if path == "/api/data-sources/status":
            return self._json(route, {"rows": [{
                "source_key": "aph", "name": "APH正式数据", "health": "danger",
                "lastSuccessAt": "2026-08-12 12:00", "detail": "固定入口待修复",
                "repair": {"repairable": True, "candidate": {
                    "name": "APH候选.json", "mtime": "2026-08-13T08:00:00+08:00", "size": 1234,
                }},
            }]})
        if path == "/api/data-sources/publication-status":
            publications = {
                "complete": {
                    "code": "complete", "label": "已完整发布", "tone": "success", "isComplete": True,
                    "summary": "2026-08-12三项必需数据源、正式批次和发布审计全部一致。",
                    "businessDate": "2026-08-12", "officialBusinessDate": "2026-08-12",
                },
                "partial": {
                    "code": "partial", "label": "部分更新", "tone": "warning", "isComplete": False,
                    "summary": "业务数据已到2026-08-13，正式发布停留在2026-08-12。",
                    "businessDate": "2026-08-13", "officialBusinessDate": "2026-08-12",
                },
                "failed": {
                    "code": "failed", "label": "更新失败", "tone": "danger", "isComplete": False,
                    "summary": "2026-08-13批次未通过真实性门禁，正式数据未推进。",
                    "businessDate": "2026-08-13", "officialBusinessDate": "2026-08-12",
                },
            }
            if self.publication_mode == "error":
                return self._json(route, {"error": "权威正式回执读取失败"}, 503)
            return self._json(route, publications[self.publication_mode])
        if path.startswith("/api/data-sources/sync/") and method == "POST":
            return self._json(route, {"success": True})
        if path.startswith("/api/data-sources/repair/") and method == "POST":
            return self._json(route, {"success": True})
        if path == "/api/users/service-centers":
            if self.center_failure:
                return self._json(route, {"error": "权威服务中心读取失败"}, 503)
            return self._json(route, {"rows": [{"center": CENTER_A}, {"center": CENTER_B}]})
        if path == "/api/users" and method == "GET":
            return self._json(route, {"rows": [
                {"id": 1, "username": "qa-admin", "role": "admin", "created_at": "2026-08-01"},
                {"id": 2, "username": "qa-member", "role": "viewer", "service_center_scope": CENTER_A, "created_at": "2026-08-02"},
            ]})
        if path == "/api/users" and method == "POST":
            return self._json(route, {"id": 3, "success": True}, 201)
        if path.startswith("/api/users/") and method in {"PUT", "DELETE"}:
            return self._json(route, {"success": True})

        # 仅用于避免无关旧页面请求制造噪声；本测试的合同端点都在上方显式定义。
        return self._json(route, {"rows": []})


def install_login(
    page,
    *,
    role: str = "admin",
    pathname: str = "/admin",
    defer_member_delete: bool = False,
) -> None:
    user = {
        "id": 1,
        "username": "qa-admin" if role == "admin" else "qa-legacy-member",
        "role": role,
        "service_center_scope": "" if role == "admin" else CENTER_A,
        "serviceCenterScope": "" if role == "admin" else CENTER_A,
    }
    payload = json.dumps({"user": user, "pathname": pathname}, ensure_ascii=False)
    page.add_init_script(f"""(() => {{
      const payload = {payload};
      localStorage.setItem('cockpit_token', 'qa-browser-token');
      localStorage.setItem('cockpit_user', JSON.stringify(payload.user));
      history.replaceState({{}}, '', payload.pathname);
    }})()""")
    if defer_member_delete:
        page.add_init_script(r"""(() => {
          const nativeFetch = window.fetch.bind(window);
          window.__r66QaMemberDeleteReleases = [];
          window.__r66QaPendingMemberDeletes = 0;
          window.__r66QaReleaseMemberDeletes = () => {
            const releases = window.__r66QaMemberDeleteReleases.splice(0);
            window.__r66QaPendingMemberDeletes = 0;
            releases.forEach(release => release());
          };
          window.fetch = (input, init = {}) => {
            const url = typeof input === 'string' ? input : input.url;
            const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
            const pathname = new URL(url, window.location.href).pathname;
            const network = nativeFetch(input, init);
            if (method !== 'DELETE' || !/^\/api\/users\/\d+$/.test(pathname)) return network;
            return network.then(response => new Promise(resolve => {
              window.__r66QaMemberDeleteReleases.push(() => resolve(response));
              window.__r66QaPendingMemberDeletes = window.__r66QaMemberDeleteReleases.length;
            }));
          };
        })()""")


def assert_desktop_admin(browser) -> Path:
    harness = ApiHarness()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.set_default_timeout(15_000)
    page_errors: list[str] = []
    console_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.route("**/api/**", harness.handle)
    install_login(page, defer_member_delete=True)
    page.goto(BASE_URL, wait_until="networkidle")

    page.locator(".r65-admin").wait_for()
    admin_box = page.locator(".r65-admin").bounding_box()
    assert admin_box and admin_box["y"] < 200, f"系统管理被旧增强层推离首屏：{admin_box}"
    assert page.locator(".aph-admin-safety-toolbar").count() == 0, "旧逐行编辑保护不得污染 R65 管理界面"
    assert "系统管理" in (page.locator(".r65-admin-title").text_content() or "")
    nav = page.get_by_role("navigation", name="系统管理功能")
    assert nav.get_by_role("button").count() == 8
    assert page.locator("#main-content").count() == 1
    assert page.get_by_text("后台数据管理", exact=True).count() == 0
    assert page.get_by_text("按业务域维护正式数据", exact=False).count() == 0
    assert page.get_by_role("region", name="当前功能状态").is_visible()
    assert "正式只读" in page.get_by_role("region", name="当前功能状态").inner_text()

    payment_region = page.get_by_role("region", name="正式回款额")
    assert payment_region.get_attribute("tabindex") == "0"
    payment_region.focus()
    assert page.evaluate("document.activeElement?.getAttribute('aria-label')") == "正式回款额"

    page.add_script_tag(path=str(AXE_PATH))
    axe = page.evaluate("""async () => await axe.run(document.querySelector('.r65-admin'), {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }
    })""")
    blocking_axe = [item for item in axe["violations"] if item.get("impact") in {"critical", "serious"}]
    assert not blocking_axe, [(item["id"], item["impact"], len(item["nodes"])) for item in blocking_axe]

    assert payment_region.get_by_role("spinbutton").count() == 0
    assert payment_region.get_by_role("button", name="保存修改", exact=True).count() == 0
    assert not any(item["path"].startswith("/api/payments/") and item["method"] == "PUT" for item in harness.requests)

    nav.locator('[data-r65-tab="collections"]').click()
    page.get_by_role("region", name="正式收缴数据").wait_for()
    assert "正式只读" in page.get_by_role("region", name="当前功能状态").inner_text()

    nav.locator('[data-r65-tab="trends"]').click()
    trend_region = page.get_by_role("region", name="已验证月度趋势")
    trend_region.wait_for()
    trend_region.get_by_text("88.00%", exact=True).wait_for()
    trend_text = trend_region.inner_text()
    trend_requests = [item for item in harness.requests if item["path"].startswith("/api/trends")]
    assert "88.00%" in trend_text, (
        f"0.88 正式比例必须且只能格式化为 88.00%：{trend_text!r}；"
        f"趋势请求={trend_requests!r}"
    )
    assert "0.88" not in trend_text, f"月度趋势不得直接显示 0-1 原始比例：{trend_text!r}"
    rebuild = page.get_by_role("button", name="从已发布批次刷新")
    page.once("dialog", lambda dialog: dialog.accept())
    rebuild.click()
    page.wait_for_function("() => document.querySelector('[role=status]')?.textContent.includes('重建1个月份')")
    trend_post = next(item for item in harness.requests if item["path"] == "/api/trends/rebuild")
    assert trend_post["body"] == {"confirmation": "确认重建月度趋势"}

    nav.locator('[data-r65-tab="rules"]').click()
    page.get_by_role("region", name="预警规则维护").wait_for()
    nav.locator('[data-r65-tab="logs"]').click()
    page.get_by_role("region", name="操作日志").wait_for()
    assert "审计只读" in page.get_by_role("region", name="当前功能状态").inner_text()

    nav.locator('[data-r65-tab="reports"]').click()
    page.get_by_role("region", name="月报归档").wait_for()
    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_role("button", name="生成本月经营归档").click()
    page.wait_for_function("() => document.querySelector('[role=status]')?.textContent.includes('已存在')")
    report_post = next(item for item in harness.requests if item["path"] == "/api/governance/report-archives/generate")
    assert report_post["body"] == {"confirmation": "确认生成正式归档", "area": "华北", "version": "operation"}
    page.get_by_role("button", name="查看", exact=True).click()
    report_detail = page.get_by_role("region", name="归档详情")
    report_detail.wait_for()
    report_text = report_detail.inner_text()
    assert "来源追溯" in report_text
    assert "项目目录批次 #66" in report_text
    assert "P46 事实批次 #46" in report_text
    assert "数据源 0 项" not in report_text

    nav.locator('[data-r65-tab="users"]').click()
    page.get_by_role("heading", name="新建成员").wait_for()
    page.wait_for_function(f"() => document.querySelectorAll('option').length >= 4 && document.body.textContent.includes({json.dumps(CENTER_A, ensure_ascii=False)})")
    form = page.locator("form.r65-member-form")
    assert form.get_by_role("option", name=CENTER_A).count() == 1
    assert form.get_by_role("option", name=CENTER_B).count() == 1
    assert form.locator('input[name*="scope"], input[aria-label*="服务中心"]').count() == 0
    form.get_by_label("用户名").fill("qa-new-member")
    form.get_by_label("初始密码").fill("QaMember2026!")
    form.get_by_label("服务中心").select_option(CENTER_B)
    form.get_by_role("button", name="创建成员").click()
    page.get_by_role("status").wait_for()
    created = next(item for item in harness.requests if item["path"] == "/api/users" and item["method"] == "POST")
    assert created["body"]["role"] == "viewer"
    assert created["body"]["service_center_scope"] == CENTER_B

    delete_button = page.get_by_role("button", name="删除", exact=True)
    page.once("dialog", lambda dialog: dialog.dismiss())
    delete_button.click()
    assert not any(item["method"] == "DELETE" for item in harness.requests)
    page.once("dialog", lambda dialog: dialog.accept())
    delete_button.click()
    deleting = page.get_by_role("button", name="删除中…", exact=True)
    deleting.wait_for()
    page.wait_for_function("() => window.__r66QaPendingMemberDeletes === 1")
    assert deleting.is_disabled()
    member_region = page.get_by_role("region", name="成员管理")
    assert form.locator("input, select, button").evaluate_all("controls => controls.every(control => control.disabled)")
    assert member_region.locator("select, button").evaluate_all("controls => controls.every(control => control.disabled)")

    # 强制派发双击事件，即使绕过 disabled 的浏览器默认阻止，busyKey 也必须阻止第二次请求。
    deleting.evaluate("""button => {
      button.dispatchEvent(new MouseEvent('click', {bubbles: true, detail: 2}));
      button.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, detail: 2}));
    }""")
    page.wait_for_timeout(100)
    delete_requests = [item for item in harness.requests if item["method"] == "DELETE"]

    # 同一个父级busyKey还必须禁用其他功能域的正式写动作。
    nav.locator('[data-r65-tab="trends"]').click()
    rebuild_while_busy = page.get_by_role("button", name="从已发布批次刷新")
    rebuild_while_busy.wait_for()
    assert rebuild_while_busy.is_disabled()
    nav.locator('[data-r65-tab="reports"]').click()
    archive_while_busy = page.get_by_role("button", name="生成本月经营归档")
    archive_while_busy.wait_for()
    assert archive_while_busy.is_disabled()
    nav.locator('[data-r65-tab="sources"]').click()
    for action_name in ("刷新权威项目目录", "检测并记录", "修复固定入口"):
        action = page.get_by_role("button", name=action_name)
        action.wait_for()
        assert action.is_disabled(), f"busy期间{action_name}必须禁用"
    nav.locator('[data-r65-tab="users"]').click()
    deleting = page.get_by_role("button", name="删除中…", exact=True)
    deleting.wait_for()

    page.evaluate("window.__r66QaReleaseMemberDeletes()")
    assert len(delete_requests) == 1, f"双击删除不得发送多个DELETE：{delete_requests!r}"
    page.wait_for_function("() => document.querySelector('[role=status]')?.textContent.includes('成员已删除')")
    deleted = delete_requests[0]
    assert deleted["body"] == {"confirmation": "qa-member"}
    assert form.locator("input, select").evaluate_all("controls => controls.every(control => !control.disabled)")
    assert member_region.locator("select").evaluate_all("controls => controls.every(control => !control.disabled)")
    assert all(not button.is_disabled() for button in member_region.get_by_role("button", name="改密", exact=True).all())
    assert all(not button.is_disabled() for button in member_region.get_by_role("button", name="删除", exact=True).all())

    nav.locator('[data-r65-tab="sources"]').click()
    page.get_by_role("region", name="项目目录与经营门禁").wait_for()
    assert "项目经营真实性门禁" in page.get_by_role("region", name="项目目录与经营门禁").inner_text()
    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_role("button", name="刷新权威项目目录").click()
    page.wait_for_function("() => document.querySelector('[role=status]')?.textContent.includes('权威项目目录已发布')")
    directory_post = next(item for item in harness.requests if item["path"] == "/api/projects/directory/publish")
    assert directory_post["body"] == {"confirmation": "确认发布项目目录"}
    page.get_by_role("button", name="修复固定入口").wait_for()
    repair_button = page.get_by_role("button", name="修复固定入口")
    page.once("dialog", lambda dialog: dialog.dismiss())
    repair_button.click()
    assert not any(item["path"] == "/api/data-sources/repair/aph" for item in harness.requests)
    page.once("dialog", lambda dialog: dialog.accept("确认修复"))
    repair_button.click()
    page.wait_for_function("() => document.querySelector('[role=status]')?.textContent.includes('固定入口已修复')")
    repair = next(item for item in harness.requests if item["path"] == "/api/data-sources/repair/aph")
    assert repair["body"] == {
        "confirmation": "确认修复",
        "candidateName": "APH候选.json",
        "candidateMtime": "2026-08-13T08:00:00+08:00",
        "candidateSize": 1234,
    }
    assert not page_errors, page_errors
    unexpected_console = [message for message in console_errors if "status of 409 (Conflict)" not in message]
    assert not unexpected_console, unexpected_console

    screenshot = Path(os.environ.get("R66_QA_SCREENSHOT", "/tmp/r66-admin-desktop.png"))
    page.screenshot(path=str(screenshot), full_page=True)
    page.close()
    return screenshot


def assert_authoritative_failure(browser) -> None:
    harness = ApiHarness(center_failure=True)
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    page.set_default_timeout(15_000)
    page.route("**/api/**", harness.handle)
    install_login(page)
    page.goto(BASE_URL, wait_until="networkidle")
    page.locator('[data-r65-tab="users"]').click()
    alert = page.get_by_role("alert")
    alert.wait_for()
    assert "权威服务中心读取失败" in alert.inner_text()
    assert page.get_by_role("option", name=CENTER_A).count() == 0
    assert page.get_by_role("option", name=CENTER_B).count() == 0
    page.close()


def assert_publication_and_directory_states(browser) -> None:
    cases = [
        ("complete", "directory_ready", "已发布", "已完整发布", "2026-08-12三项必需数据源", False),
        ("partial", "operating_ready", "已发布", "部分更新", "正式发布停留在2026-08-12", False),
        ("failed", "blocked", "待发布", "更新失败", "未通过真实性门禁", False),
        ("error", "empty", "待发布", "正式回执未知", "权威正式回执读取失败", True),
    ]
    for publication_mode, directory_state, directory_label, receipt_label, summary, expect_console_error in cases:
        harness = ApiHarness(directory_state=directory_state, publication_mode=publication_mode)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.set_default_timeout(15_000)
        console_errors: list[str] = []
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.route("**/api/**", harness.handle)
        install_login(page)
        page.goto(BASE_URL, wait_until="networkidle")
        page.locator('[data-r65-tab="sources"]').click()
        gate = page.get_by_role("region", name="项目目录与经营门禁")
        gate.wait_for()
        gate_text = gate.inner_text()
        assert directory_label in gate_text, (directory_state, gate_text)
        assert receipt_label in gate_text, (publication_mode, gate_text)
        assert summary in gate_text, (publication_mode, gate_text)
        if directory_state in {"blocked", "empty"}:
            assert "已发布" not in gate_text.split("权威项目目录", 1)[1].split("项目经营真实性门禁", 1)[0]
        if publication_mode != "complete":
            assert "已完整发布" not in gate_text
        status_text = page.get_by_role("region", name="当前功能状态").inner_text()
        assert summary in status_text
        assert "数据源连接状态" not in status_text or publication_mode == "error"
        if expect_console_error:
            assert any("503" in message for message in console_errors), console_errors
        page.close()


def assert_mobile_and_route_guard(browser) -> Path:
    harness = ApiHarness()
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.set_default_timeout(15_000)
    page.route("**/api/**", harness.handle)
    install_login(page)
    page.goto(BASE_URL, wait_until="networkidle")
    admin_nav = page.get_by_role("navigation", name="系统管理功能")
    admin_nav.wait_for()
    page.wait_for_timeout(800)
    assert admin_nav.is_visible(), "移动端系统管理功能导航不能被宿主壳隐藏"
    nav_box = admin_nav.bounding_box()
    assert nav_box and 0 <= nav_box["y"] < 844, nav_box
    assert nav_box["width"] >= 300 and nav_box["height"] >= 36, nav_box
    assert nav_box["x"] < 390 and nav_box["x"] + nav_box["width"] > 0, nav_box
    nav_style = admin_nav.evaluate("element => ({ opacity: getComputedStyle(element).opacity, visibility: getComputedStyle(element).visibility, display: getComputedStyle(element).display })")
    assert nav_style == {"opacity": "1", "visibility": "visible", "display": "flex"}, nav_style
    active_tab = admin_nav.locator('[aria-current="page"]')
    assert active_tab.is_visible()
    active_style = active_tab.evaluate("element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor })")
    assert active_style["color"] != active_style["background"], active_style
    tab_texts = admin_nav.get_by_role("button").all_inner_texts()
    assert tab_texts[:4] == ["回款额", "收缴率", "月度趋势", "预警规则"], tab_texts
    first_tab_visual = admin_nav.get_by_role("button").first.evaluate("""element => ({
      text: element.textContent,
      fontSize: getComputedStyle(element).fontSize,
      color: getComputedStyle(element).color,
      before: getComputedStyle(element, '::before').content,
      after: getComputedStyle(element, '::after').content,
    })""")
    assert first_tab_visual["before"] == "none" and first_tab_visual["after"] == "none", first_tab_visual
    tab_box = active_tab.bounding_box()
    assert tab_box
    tab_hit = page.evaluate("""({x, y}) => {
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit?.closest('.r65-tabs'));
    }""", {"x": tab_box["x"] + tab_box["width"] / 2, "y": tab_box["y"] + tab_box["height"] / 2})
    assert tab_hit, "移动端系统管理标签被宿主导航遮挡"
    screenshot = Path(os.environ.get("R66_QA_MOBILE_SCREENSHOT", "/tmp/r66-admin-mobile.png"))
    page.screenshot(path=str(screenshot), full_page=True)
    mobile_table = page.get_by_role("region", name="正式回款额")
    assert mobile_table.is_visible(), "移动端后台工作表必须可见"
    assert mobile_table.get_by_text(CENTER_A, exact=True).is_visible()
    metrics = page.evaluate("""() => ({
      viewport: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
      tabScroll: document.querySelector('.r65-tabs')?.scrollWidth,
      tabClient: document.querySelector('.r65-tabs')?.clientWidth,
    })""")
    assert metrics["pageWidth"] <= metrics["viewport"] + 1, metrics
    assert metrics["tabScroll"] >= metrics["tabClient"]
    page.close()

    # 旧非 admin 角色也必须被当成普通成员，不能直接进入后台。
    member_harness = ApiHarness(auth_role="region_manager")
    member = browser.new_page(viewport={"width": 1280, "height": 800})
    member.set_default_timeout(15_000)
    member.route("**/api/**", member_harness.handle)
    install_login(member, role="region_manager", pathname="/admin")
    member.goto(BASE_URL, wait_until="domcontentloaded")
    member.wait_for_function("() => location.pathname === '/'")
    assert member.get_by_text("管理员 · 全部服务中心", exact=True).count() == 0
    member.close()
    return screenshot


def assert_member_mobile_routes_and_badge(browser) -> None:
    allowed = ["/", "/payment", "/daily", "/collection", "/projects", "/projects/1", "/ai-alerts", "/ai-report"]
    harness = ApiHarness(auth_role="viewer")
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.set_default_timeout(30_000)
    route_errors: list[str] = []
    route_console: list[str] = []
    page.on("pageerror", lambda error: route_errors.append(str(error)))
    page.on("console", lambda message: route_console.append(f"{message.type}:{message.text}"))
    page.route("**/api/**", harness.handle)
    install_login(page, role="viewer", pathname="/")
    page.goto(BASE_URL, wait_until="commit")
    page.wait_for_function("() => location.pathname === '/' && document.querySelector('#root')?.children.length")
    for pathname in allowed:
        print(f"R66 member route: {pathname}", flush=True)
        if pathname != "/":
            page.evaluate("""target => {
              history.pushState({}, '', target);
              window.dispatchEvent(new PopStateEvent('popstate'));
            }""", pathname)
        try:
            page.wait_for_function("expected => location.pathname === expected", arg=pathname)
        except PlaywrightTimeoutError as error:
            raise AssertionError(
                f"成员允许路由未保持：expected={pathname}, actual={urlparse(page.url).path}, "
                f"page_errors={route_errors}, console={route_console}"
            ) from error
        page.wait_for_timeout(800)
        assert page.url.endswith(pathname) or urlparse(page.url).path == pathname, (pathname, page.url)
        assert page.get_by_text("页面运行异常", exact=True).count() == 0, (pathname, route_errors, route_console)
        if pathname == "/":
            badge = page.locator("#aph-r65-service-center-scope")
            badge.wait_for(state="attached")
            assert CENTER_A in (badge.text_content() or "")
    page.close()

    # 欠费页由初始路由引导到同壳 iframe，必须按真实整页进入方式单测。
    arrears = browser.new_page(viewport={"width": 390, "height": 844})
    arrears.set_default_timeout(30_000)
    arrears.route("**/api/**", ApiHarness(auth_role="viewer").handle)
    install_login(arrears, role="viewer", pathname="/arrears")
    arrears.goto(BASE_URL, wait_until="commit")
    arrears.locator("#aph-arrears-frame").wait_for(state="attached")
    assert urlparse(arrears.url).path == "/arrears"
    arrears.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        desktop = assert_desktop_admin(browser)
        assert_authoritative_failure(browser)
        assert_publication_and_directory_states(browser)
        mobile = assert_mobile_and_route_guard(browser)
        browser.close()
    print(json.dumps({
        "ok": True,
        "checks": [
            "8域后台直达与正式状态条",
            "回款正式只读且无手工写入入口",
            "趋势0-1比例只格式化一次并从已发布批次重建",
            "月报不可变归档与项目目录/P46嵌套血缘",
            "项目目录发布与真实性门禁",
            "成员中心仅权威选项",
            "成员创建/保存/改密/删除共享busy与双击防重",
            "危险修复二次确认",
            "权威中心失败不回退",
            "blocked/empty目录拒绝已发布且正式回执四态实话展示",
            "桌面/移动/键盘基础",
            "旧角色禁止后台路由",
        ],
        "screenshots": [str(desktop), str(mobile)],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
