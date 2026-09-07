#!/usr/bin/env python3
"""R65 极简系统管理与服务中心范围的本地影子浏览器回归。"""

from __future__ import annotations

import json
import hashlib
import subprocess
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PORT = 4205
BASE = f"http://127.0.0.1:{PORT}"
ARTIFACTS = ROOT / "artifacts" / "r65-simple-admin-scope"
AXE_PATH = ROOT / "node_modules" / "axe-core" / "axe.min.js"
PRODUCTION_LEGACY_ASSETS = {
    "/aph2-theme-20260808-progressive6.js": (
        "https://firstcare.cloud/aph2-theme-20260808-progressive6.js",
        "15309e96651a1e67a454afcb3c527c5ad931ff84a19c910683d5d4868e7f3336",
    ),
    "/admin/aph2-r46-admin-accessibility-20260812-v1.js": (
        "https://firstcare.cloud/admin/aph2-r46-admin-accessibility-20260812-v1.js",
        "ffb78746191e8231bbedbbc2134adcd8422ec4a85203075a805c0b442a2da05d",
    ),
}


def wait_ready() -> None:
    for _ in range(80):
        try:
            with urllib.request.urlopen(BASE + "/", timeout=0.3) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("本地影子站点启动超时")


def fulfill(route: Route, status: int = 200, payload=None) -> None:
    route.fulfill(
        status=status,
        content_type="application/json; charset=utf-8",
        body=json.dumps(payload if payload is not None else {}, ensure_ascii=False),
    )


def fetch_production_legacy_assets() -> dict[str, bytes]:
    assets = {}
    for path, (url, expected_sha256) in PRODUCTION_LEGACY_ASSETS.items():
        source = subprocess.run(
            ["curl", "-fsSL", url],
            check=True,
            capture_output=True,
        ).stdout
        actual_sha256 = hashlib.sha256(source).hexdigest()
        assert actual_sha256 == expected_sha256, {
            "asset": path,
            "expected": expected_sha256,
            "actual": actual_sha256,
        }
        assets[path] = source
    return assets


def use_production_legacy_assets(context, assets: dict[str, bytes]) -> None:
    for path, source in assets.items():
        context.route(
            f"**{path}*",
            lambda route, _request, body=source: route.fulfill(
                status=200,
                content_type="application/javascript; charset=utf-8",
                body=body,
            ),
        )


def admin_api(route: Route) -> None:
    request = route.request
    path = request.url.split("/api", 1)[-1]
    path = "/api" + path
    method = request.method
    if method != "GET":
        fulfill(route, payload={"ok": True})
        return
    if path == "/api/auth/me":
        fulfill(route, payload={"id": 1, "username": "admin", "role": "admin"})
    elif path == "/api/payments":
        fulfill(route, payload=[{
            "id": 1,
            "area": "京东片区",
            "center": "第一服务中心",
            "annualBudget": 100,
            "cumulativeBudget": 80,
            "cumulativeExecuted": 70,
            "samePeriod": 60,
            "collectionRate": 87.5,
            "version": 3,
        }])
    elif path == "/api/collections":
        fulfill(route, payload=[{
            "id": 2,
            "area": "京东片区",
            "center": "第一服务中心",
            "receivable": 120,
            "received": 90,
            "overdue30": None,
            "overdue90": None,
        }])
    elif path == "/api/trends":
        fulfill(route, payload=[])
    elif path == "/api/governance/rules":
        fulfill(route, payload={"rows": [{"id": 7, "rule_key": "collection_low", "label": "低收缴率", "threshold_value": 85, "enabled": True, "description": "低于阈值时预警"}]})
    elif path.startswith("/api/governance/logs"):
        fulfill(route, payload={"rows": []})
    elif path == "/api/governance/report-archives":
        fulfill(route, payload={"rows": []})
    elif path == "/api/data-sources/status":
        fulfill(route, payload={"rows": [{
            "source_key": "aph",
            "name": "APH 数据",
            "health": "danger",
            "detail": "固定入口不是最新文件",
            "repair": {"repairable": True, "candidate": {"name": "正式候选.xlsx"}},
        }]})
    elif path == "/api/users":
        fulfill(route, payload={"rows": [
            {"id": 1, "username": "admin", "role": "admin", "created_at": "2026-08-13"},
            {"id": 2, "username": "member", "role": "viewer", "service_center_scope": "第一服务中心", "created_at": "2026-08-13"},
        ]})
    elif path == "/api/users/service-centers":
        fulfill(route, payload={"rows": [{"center": "第一服务中心"}, {"name": "第二服务中心"}]})
    else:
        fulfill(route, payload={"rows": []})


def main() -> None:
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    production_legacy_assets = fetch_production_legacy_assets()
    server = subprocess.Popen(
        ["python3", str(ROOT / "tests/r57_local_spa_server.py"), str(PORT)],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_ready()
        result = {}
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)

            admin = browser.new_context(viewport={"width": 1440, "height": 960})
            use_production_legacy_assets(admin, production_legacy_assets)
            admin.add_init_script(
                "localStorage.setItem('cockpit_token','shadow-admin');"
                "localStorage.setItem('cockpit_user',JSON.stringify({id:1,username:'admin',role:'admin'}));"
            )
            writes = []

            def routed_admin_api(route: Route) -> None:
                if route.request.method != "GET":
                    writes.append({
                        "url": route.request.url,
                        "method": route.request.method,
                        "body": route.request.post_data_json if route.request.post_data else None,
                    })
                admin_api(route)

            admin.route("**/api/**", routed_admin_api)
            page = admin.new_page()
            admin_console_errors = []
            admin_page_errors = []
            page.on("console", lambda message: admin_console_errors.append(message.text) if message.type == "error" else None)
            page.on("pageerror", lambda error: admin_page_errors.append(str(error)))
            page.goto(BASE + "/admin", wait_until="domcontentloaded")
            payment_save = page.get_by_role("button", name="保存修改", exact=True).first
            assert payment_save.is_disabled()
            page.get_by_label("第一服务中心累计执行", exact=True).fill("-5")
            assert payment_save.is_enabled()
            payment_save.click()
            page.get_by_text("已保存", exact=True).wait_for()
            payment_write = next(item for item in writes if item["url"].endswith("/api/payments/1"))
            assert payment_write["body"]["version"] == 3
            assert payment_write["body"]["cumulativeExecuted"] == -5

            page.get_by_label("第一服务中心收缴率", exact=True).fill("101")
            page.wait_for_timeout(100)
            payment_save = page.locator('table[aria-label="回款额维护"] button').filter(has_text="保存修改")
            payment_state = page.locator('table[aria-label="回款额维护"]').evaluate("""table => ({
              rate: table.querySelector('input[aria-label$="收缴率"]')?.value,
              disabled: [...table.querySelectorAll('button')].find(button => button.textContent.trim() === '保存修改')?.disabled,
              validation: table.querySelector('.r65-validation')?.textContent || '',
              buttons: [...table.querySelectorAll('button')].map(button => ({text: button.textContent.trim(), disabled: button.disabled, html: button.outerHTML}))
            })""")
            assert payment_state == {
                "rate": "101",
                "disabled": True,
                "validation": "修改值不能为空；预算≥0；收缴率0–100",
                "buttons": payment_state["buttons"],
            }, payment_state
            save_buttons = [button for button in payment_state["buttons"] if button["text"] == "保存修改"]
            assert save_buttons and save_buttons[-1]["disabled"], payment_state
            page.get_by_text("修改值不能为空；预算≥0；收缴率0–100", exact=True).wait_for()

            assert page.get_by_role("button", name="回款额", exact=True).get_attribute("aria-current") == "page"
            page.get_by_role("button", name="成员管理", exact=True).click()
            page.get_by_text("新建成员", exact=True).wait_for()
            role_selects = page.locator("select").filter(has=page.locator("option", has_text="普通成员"))
            assert role_selects.count() == 3
            assert page.get_by_role("option", name="第一服务中心", exact=True).count() >= 1
            assert page.get_by_role("option", name="第二服务中心", exact=True).count() >= 1
            assert page.get_by_role("option", name="脏中心", exact=True).count() == 0
            assert page.get_by_role("button", name="创建成员", exact=True).is_disabled()

            page.get_by_role("button", name="收缴率", exact=True).click()
            page.locator(".r65-unavailable").first.wait_for()
            assert page.locator(".r65-unavailable").count() == 2
            assert page.locator(".r65-unavailable").all_text_contents() == ["未接入", "未接入"]
            assert page.locator('input[type="number"]').count() == 0
            assert page.get_by_role("button", name="保存修改", exact=True).count() == 0

            page.get_by_role("button", name="月度趋势", exact=True).click()
            page.get_by_text("尚无已核验月度趋势；数据接入后自动显示。", exact=True).wait_for()

            page.get_by_role("button", name="预警规则", exact=True).click()
            rule_enabled = page.get_by_role("checkbox", name="低收缴率启用状态", exact=True)
            rule_save = page.locator('table[aria-label="预警规则维护"] button').filter(has_text="保存修改")
            rule_enabled.wait_for()
            assert rule_enabled.is_checked()
            assert rule_save.is_disabled()
            rule_enabled.uncheck()
            page.get_by_label("低收缴率阈值", exact=True).fill("88")
            assert rule_save.is_enabled()
            rule_save.click()
            page.get_by_text("规则已保存", exact=True).wait_for()
            rule_write = next(item for item in writes if item["url"].endswith("/api/governance/rules/7"))
            assert rule_write["body"] == {"threshold_value": 88, "enabled": False}

            page.get_by_role("button", name="月报归档", exact=True).click()
            page.get_by_text("尚无月报归档；完成正式归档后显示。", exact=True).wait_for()

            page.get_by_role("button", name="数据源", exact=True).click()
            page.get_by_role("button", name="检测并记录", exact=True).wait_for()
            page.once("dialog", lambda dialog: dialog.dismiss())
            page.get_by_role("button", name="修复固定入口", exact=True).click()

            page.screenshot(path=str(ARTIFACTS / "admin-desktop.png"), full_page=True)
            page.wait_for_timeout(2_000)
            assert page.locator(".aph-admin-safety-toolbar").count() == 0
            assert page.locator(".aph-r46-admin-tabs").count() == 0
            assert page.locator('.r65-tabs [role="tab"]').count() == 0
            assert page.locator('.r65-tabs button[aria-current="page"]').count() == 1
            assert page.locator(".r65-admin").bounding_box()["y"] < 200
            page.add_script_tag(path=str(AXE_PATH))
            axe = page.evaluate("""async () => await axe.run(document.querySelector('.r65-admin'), {
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }
            })""")
            blocking_axe = [
                violation
                for violation in axe["violations"]
                if violation.get("impact") in {"critical", "serious"}
            ]
            assert not blocking_axe, [
                (violation["id"], violation.get("impact"), len(violation["nodes"]))
                for violation in blocking_axe
            ]
            assert page.locator("#aph-r65-service-center-scope").count() == 0
            assert not admin_page_errors
            assert not admin_console_errors
            result["admin"] = {
                "tabs": page.locator(".r65-tabs button").count(),
                "collectionInputs": 0,
                "authoritativeCenters": 2,
                "productionLegacyAssets": [
                    PRODUCTION_LEGACY_ASSETS[path][1]
                    for path in PRODUCTION_LEGACY_ASSETS
                ],
                "blockingAxeViolations": 0,
            }
            admin.close()

            admin_mobile = browser.new_context(viewport={"width": 390, "height": 844})
            use_production_legacy_assets(admin_mobile, production_legacy_assets)
            admin_mobile.add_init_script(
                "localStorage.setItem('cockpit_token','shadow-admin-mobile');"
                "localStorage.setItem('cockpit_user',JSON.stringify({id:1,username:'admin',role:'admin'}));"
            )
            admin_mobile.route("**/api/**", admin_api)
            admin_mobile_page = admin_mobile.new_page()
            admin_mobile_errors = []
            admin_mobile_page.on("console", lambda message: admin_mobile_errors.append(message.text) if message.type == "error" else None)
            admin_mobile_page.on("pageerror", lambda error: admin_mobile_errors.append(str(error)))
            admin_mobile_page.goto(BASE + "/admin", wait_until="domcontentloaded")
            admin_mobile_page.get_by_role("button", name="回款额", exact=True).wait_for()
            admin_mobile_page.evaluate("document.body.classList.add('aph-mobile-nav-ready')")
            admin_mobile_page.evaluate("""() => {
              const hostNav = document.createElement('nav')
              hostNav.className = 'aph-mobile-primary-nav'
              hostNav.innerHTML = '<a href="/">驾驶舱</a><a href="/projects">项目</a><button>更多</button>'
              document.body.appendChild(hostNav)
            }""")
            for tab_name in ["回款额", "收缴率", "月度趋势", "预警规则", "操作日志", "月报归档", "数据源", "成员管理"]:
                tab_button = admin_mobile_page.get_by_role("button", name=tab_name, exact=True)
                tab_button.scroll_into_view_if_needed()
                hit = tab_button.evaluate("""button => {
                  const rect = button.getBoundingClientRect()
                  const point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
                  return point === button || button.contains(point)
                }""")
                assert hit, {"coveredTab": tab_name}
                tab_button.click()
                assert tab_button.get_attribute("aria-current") == "page"
            overflow = admin_mobile_page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            assert overflow <= 1, {"horizontalOverflow": overflow}
            assert not admin_mobile_errors
            admin_mobile_page.screenshot(path=str(ARTIFACTS / "admin-mobile.png"), full_page=True)
            result["adminMobile"] = {"tabsTouchable": 8, "viewport": "390x844", "horizontalOverflow": overflow}
            admin_mobile.close()

            member = browser.new_context(viewport={"width": 390, "height": 844})
            member.add_init_script(
                "localStorage.setItem('cockpit_token','shadow-member');"
                "localStorage.setItem('cockpit_user',JSON.stringify({id:2,username:'member',role:'region_manager',service_center_scope:'第一服务中心'}));"
            )

            member_requests = []

            def member_api(route: Route) -> None:
                member_requests.append(route.request.url)
                path = route.request.url.split("/api", 1)[-1]
                path = "/api" + path
                if path == "/api/auth/me":
                    fulfill(route, status=503, payload={"error": "认证信息暂不可用"})
                elif path == "/api/summary":
                    fulfill(route, payload={})
                elif path == "/api/payments":
                    fulfill(route, payload=[])
                elif path == "/api/daily/dates":
                    fulfill(route, payload={"dates": ["2026-08-13"]})
                elif path.startswith("/api/daily?"):
                    fulfill(route, payload={"rows": [{"center": "第一服务中心", "area": "京东片区", "annual_budget": 100, "today": 80, "daily": 5}]})
                elif path.startswith("/api/projects/1"):
                    benchmark = {"count": 1, "collectionRate": 90, "profitRate": 15, "healthScore": 88, "quality": 90, "satisfaction": 91, "complaints": 1}
                    fulfill(route, payload={
                        "project": {"id": 1, "name": "中心项目", "area": "京东片区", "property_type": "住宅", "area_sqm": 1000, "units": 100, "annual_income": 100, "annual_cost": 80, "ytd_income": 70, "ytd_cost": 55, "received": 90, "receivable": 100, "quality_score": 90, "safety_incidents": 0, "customer_satisfaction": 91, "complaint_count": 1, "staff_count": 10},
                        "collectionRate": 90,
                        "profitRate": 15,
                        "areaAvg": {"avg_collection_rate": 90, "avg_quality": 90, "avg_satisfaction": 91},
                        "benchmarks": {"ranks": {"areaCollectionRank": 1, "areaTotal": 1, "northCollectionRank": 1, "northTotal": 1, "typeCollectionRank": 1, "typeTotal": 1}, "area": benchmark, "northChina": benchmark, "propertyType": benchmark},
                        "riskProfile": {"level": "正常", "healthScore": 88, "dimensions": None, "deductions": {}, "openTasks": None, "taskCount": 0, "openTaskCount": 0},
                    })
                elif path == "/api/data-quality/project-gate":
                    fulfill(route, payload={"projects": []})
                elif path == "/api/projects":
                    fulfill(route, payload={"rows": [{"id": 1, "name": "中心项目", "area": "京东片区", "property_type": "住宅", "area_sqm": 1000, "units": 100, "ytd_income": 70, "ytd_cost": 55, "received": 90, "receivable": 100, "quality_score": 90, "customer_satisfaction": 91, "safety_incidents": 0, "complaint_count": 1}]})
                elif path.startswith("/api/ai/monthly-report"):
                    fulfill(route, payload={"area": "第一服务中心", "reportDate": "2026-08-13", "summary": {"collectionRate": 90, "profitRate": 15, "project_count": 1, "ytd_income": 70}, "alerts": [], "sections": []})
                elif path == "/api/ai/interpret":
                    fulfill(route, payload={})
                elif path.startswith("/api/ai/project/1/diagnosis"):
                    fulfill(route, status=503, payload={"error": "AI 暂不可用"})
                elif path.startswith("/api/ai/trends"):
                    fulfill(route, status=403, payload={"error": "无权限"})
                elif path.startswith("/api/ai/risk-trends"):
                    fulfill(route, payload={})
                else:
                    fulfill(route, payload={"rows": []})

            member.route("**/api/**", member_api)
            mobile = member.new_page()
            member_console_errors = []
            member_page_errors = []
            mobile.on("console", lambda message: member_console_errors.append(message.text) if message.type == "error" else None)
            mobile.on("pageerror", lambda error: member_page_errors.append(str(error)))
            mobile.goto(BASE + "/daily", wait_until="domcontentloaded")
            mobile.get_by_text("当前服务中心：第一服务中心", exact=True).wait_for(timeout=20_000)
            before = mobile.evaluate("""() => ({
              badges: document.querySelectorAll('#aph-r65-service-center-scope').length,
              hidden: document.querySelectorAll('[data-r65-scope-control-hidden="true"]').length,
              text: document.querySelector('#aph-r65-service-center-scope')?.textContent
            })""")
            mobile.wait_for_timeout(2_000)
            after = mobile.evaluate("""() => ({
              badges: document.querySelectorAll('#aph-r65-service-center-scope').length,
              hidden: document.querySelectorAll('[data-r65-scope-control-hidden="true"]').length,
              text: document.querySelector('#aph-r65-service-center-scope')?.textContent
            })""")
            assert before == after
            assert before["badges"] == 1
            stored_user = mobile.evaluate("JSON.parse(localStorage.getItem('cockpit_user'))")
            assert stored_user["role"] == "viewer"
            assert stored_user["legacyRole"] == "region_manager"
            assert mobile.locator('select[data-r65-scope-control-hidden="true"]').count() == 0
            assert mobile.locator('[data-area-filter="true"][data-r65-scope-control-hidden="true"]').count() >= 1
            assert "第二服务中心" not in mobile.locator("body").inner_text()

            mobile.goto(BASE + "/projects", wait_until="domcontentloaded")
            mobile.get_by_role("heading", name="项目管理", exact=True).wait_for(timeout=20_000)
            assert "页面运行异常" not in mobile.locator("body").inner_text()
            assert not any("/api/tasks" in request for request in member_requests)

            mobile.goto(BASE + "/projects/1", wait_until="domcontentloaded")
            try:
                mobile.get_by_text("项目对标", exact=True).wait_for(timeout=20_000)
            except Exception as error:
                raise AssertionError({"projectUrl": mobile.url, "body": mobile.locator("body").inner_text()[:5000], "errors": member_page_errors + member_console_errors, "requests": member_requests[-40:]}) from error
            mobile.get_by_text("本服务中心口径", exact=True).first.wait_for()
            project_text = mobile.locator("main").inner_text()
            assert "片区收费排名" not in project_text
            assert "华北收费排名" not in project_text
            assert "生成本项目任务" not in project_text
            assert "查看本服务中心月报" in project_text
            mobile.screenshot(path=str(ARTIFACTS / "member-project-mobile.png"), full_page=True)

            mobile.goto(BASE + "/ai-report", wait_until="domcontentloaded")
            mobile.get_by_text("打印/导出PDF", exact=True).wait_for(timeout=20_000)
            report_text = mobile.locator("main").inner_text()
            assert "导出Word正式月报" not in report_text
            assert "归档当前月报" not in report_text
            assert "生成正式月报" not in report_text
            assert "打印/导出PDF" in report_text
            unexpected_member_console_errors = [
                message
                for message in member_console_errors
                if "Failed to load resource" not in message
            ]
            assert member_console_errors, "应实际覆盖 403/503 资源失败"
            assert not member_page_errors, member_page_errors
            assert not unexpected_member_console_errors, unexpected_member_console_errors
            mobile.screenshot(path=str(ARTIFACTS / "member-mobile.png"), full_page=True)
            result["member"] = {"scope": "第一服务中心", "normalizedRole": "viewer", "projectScopeCopy": "本服务中心口径", "viewport": "390x844"}
            member.close()
            browser.close()

        print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    main()
