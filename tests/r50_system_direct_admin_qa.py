#!/usr/bin/env python3
"""R50 系统管理直达后台的真实浏览器回归。"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("r48_qa", ROOT / "tests/r48_full_accessibility_qa.py")
r48_qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r48_qa)


def assert_admin(page) -> dict:
    page.wait_for_url(re.compile(r"/admin(?:[?#]|$)"), timeout=30_000)
    page.wait_for_timeout(4_500)
    assert page.locator(".aph-system-hub").count() == 0
    assert page.get_by_text("使用界面", exact=True).count() == 0
    assert page.get_by_text("进入后台管理", exact=True).count() == 0
    admin_tabs = [
        label
        for label in ["回款额", "收缴率", "月度趋势", "预警规则", "操作日志", "月报归档", "数据源接入", "用户管理"]
        if page.get_by_role("tab", name=label, exact=True).count()
    ]
    assert len(admin_tabs) == 8
    return {
        "url": page.url,
        "systemHub": page.locator(".aph-system-hub").count(),
        "adminTabs": admin_tabs,
    }


def main() -> None:
    token = r48_qa.qa.ephemeral_token()
    base = tunnel = server = thread = None
    result = {}
    try:
        base, tunnel, server, thread = r48_qa.start_shadow()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)

            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            context.add_init_script(script=(
                f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
                f"localStorage.setItem('token',{json.dumps(token)});"
                "localStorage.setItem('cockpit_user',JSON.stringify({name:'R50路由验收',role:'admin'}));"
            ))
            page = context.new_page()

            page.goto(base + "/system", wait_until="domcontentloaded", timeout=30_000)
            result["directLegacyRoute"] = assert_admin(page)

            page.goto(base + "/", wait_until="domcontentloaded", timeout=30_000)
            page.wait_for_timeout(2_000)
            sidebar_link = page.locator(".aph-exact-sidebar a", has_text="系统管理").first
            sidebar_link.wait_for(state="visible", timeout=15_000)
            assert sidebar_link.get_attribute("href") == "/admin"
            sidebar_link.click()
            result["sidebarClick"] = assert_admin(page)

            tab_link = page.locator(".aph-page-tabs a[data-aph-tab-href]", has_text="系统管理").first
            assert tab_link.count() == 1
            assert tab_link.get_attribute("href") == "/admin"
            assert tab_link.get_attribute("data-aph-tab-href") == "/admin"
            result["pageTab"] = {
                "href": tab_link.get_attribute("href"),
                "route": tab_link.get_attribute("data-aph-tab-href"),
            }
            open_tabs = page.evaluate("JSON.parse(sessionStorage.getItem('aph-open-tabs-v1') || '[]')")
            assert all(item.get("href") != "/system" for item in open_tabs)
            result["storedTabs"] = open_tabs

            page.go_back(wait_until="domcontentloaded")
            page.wait_for_url(re.compile(r"/$"), timeout=30_000)
            page.go_forward(wait_until="domcontentloaded")
            result["historyForward"] = assert_admin(page)
            context.close()

            guest = browser.new_context(viewport={"width": 390, "height": 844})
            guest_page = guest.new_page()
            guest_page.goto(base + "/system", wait_until="domcontentloaded", timeout=30_000)
            guest_page.wait_for_url(re.compile(r"/login\?next=%2Fadmin(?:&|$)"), timeout=30_000)
            assert guest_page.locator(".aph-system-hub").count() == 0
            guest_page.evaluate(
                """token => {
                  localStorage.setItem('cockpit_token', token);
                  localStorage.setItem('cockpit_user', JSON.stringify({name:'R50回跳验收', role:'admin'}));
                }""",
                token,
            )
            guest_page.goto(base + "/", wait_until="domcontentloaded", timeout=30_000)
            result["guestLoginReturn"] = assert_admin(guest_page)
            guest.close()

            viewer = browser.new_context(viewport={"width": 390, "height": 844})
            viewer_page = viewer.new_page()
            viewer_page.goto(base + "/login?next=%2Fadmin", wait_until="domcontentloaded", timeout=30_000)
            viewer_page.evaluate(
                """token => {
                  localStorage.setItem('cockpit_token', token);
                  localStorage.setItem('cockpit_user', JSON.stringify({name:'R50权限验收', role:'viewer'}));
                }""",
                token,
            )
            viewer_page.goto(base + "/", wait_until="domcontentloaded", timeout=30_000)
            viewer_page.wait_for_url(re.compile(r"/$"), timeout=30_000)
            assert viewer_page.locator(".aph-system-hub").count() == 0
            result["viewerBoundary"] = {"url": viewer_page.url, "systemHub": 0}
            viewer.close()

            mobile = browser.new_context(viewport={"width": 390, "height": 844})
            mobile.add_init_script(script=(
                f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
                f"localStorage.setItem('token',{json.dumps(token)});"
                "localStorage.setItem('cockpit_user',JSON.stringify({name:'R50移动验收',role:'admin'}));"
            ))
            mobile_page = mobile.new_page()
            mobile_page.goto(base + "/", wait_until="domcontentloaded", timeout=30_000)
            mobile_page.wait_for_timeout(2_000)
            mobile_page.locator(".aph-mobile-more-trigger").click()
            drawer = mobile_page.locator("#aph-mobile-more-drawer")
            assert drawer.is_visible()
            mobile_admin = drawer.get_by_role("link", name="系统管理", exact=True)
            assert mobile_admin.get_attribute("href") == "/admin"
            mobile_admin.click()
            result["mobileDrawer"] = assert_admin(mobile_page)
            assert "aph-mobile-drawer-open" not in (mobile_page.locator("body").get_attribute("class") or "")
            mobile.close()
            browser.close()

        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        token = ""
        if server:
            server.shutdown()
            server.server_close()
        if thread:
            thread.join(timeout=2)
        if tunnel:
            tunnel.terminate()
            try:
                tunnel.wait(timeout=5)
            except Exception:
                tunnel.kill()


if __name__ == "__main__":
    main()
