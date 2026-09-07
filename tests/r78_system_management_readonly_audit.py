#!/usr/bin/env python3
"""生产系统管理只读巡检：遍历8个功能域，不放行任何业务写请求。"""

from __future__ import annotations

import importlib.util
import json
import re
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get(
    "R78_QA_OUT",
    str(ROOT / "docs/qa/frontend-skill-cloud-20260813/r78-system-management-readonly"),
))
BASE = "https://firstcare.cloud"
TABS = {
    "payments": "回款额",
    "collections": "收缴率",
    "trends": "月度趋势",
    "rules": "预警规则",
    "logs": "操作日志",
    "reports": "月报归档",
    "sources": "数据源",
    "users": "成员管理",
}


def token() -> str:
    path = ROOT / "tests/full_remediation_shadow_qa.py"
    spec = importlib.util.spec_from_file_location("r78_token", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module.ephemeral_token()


def viewport_audit(browser, auth_token: str, name: str, width: int, height: int) -> dict:
    blocked_writes: list[dict] = []
    console_errors: list[str] = []
    page_errors: list[str] = []
    failed_requests: list[str] = []
    dialogs: list[dict] = []
    context = browser.new_context(viewport={"width": width, "height": height}, bypass_csp=True)
    context.add_init_script(
        f"localStorage.setItem('cockpit_token',{json.dumps(auth_token)});"
        f"localStorage.setItem('token',{json.dumps(auth_token)});"
    )
    page = context.new_page()
    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on("requestfailed", lambda req: failed_requests.append(f"{req.method} {req.url}: {req.failure}"))

    def guard(route):
        request = route.request
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            blocked_writes.append({"method": request.method, "url": request.url})
            return route.abort()
        return route.continue_()

    page.route("**/*", guard)
    page.goto(f"{BASE}/admin", wait_until="networkidle", timeout=60_000)
    page.locator(".r65-admin").wait_for(state="visible", timeout=30_000)
    nav = page.get_by_role("navigation", name="系统管理功能")
    shell_geometry = page.evaluate("""() => {
      const info = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,z:s.zIndex,position:s.position,overflowX:s.overflowX,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,text:(el.innerText||'').trim().slice(0,120)};
      };
      const tabs = info('.r65-tabs'), bar = info('.r66-domain-bar');
      return {
        header: info('body > #root header, header.sticky.top-0'),
        mobileNav: info('.aph-mobile-primary-nav'),
        adminBar: info('.r65-admin-bar'),
        tabs,
        domainBar: bar,
        tabsOverlapDomainBar: Boolean(tabs && bar && Math.min(tabs.bottom,bar.bottom) > Math.max(tabs.top,bar.top)),
      };
    }""")
    results = {}

    def dismiss_dialog(dialog):
        dialogs.append({"type": dialog.type, "message": dialog.message})
        dialog.dismiss()

    page.on("dialog", dismiss_dialog)
    for key, label in TABS.items():
        nav.locator(f'[data-r65-tab="{key}"]').click()
        page.wait_for_timeout(700)
        panel = page.locator(".r65-admin-main")
        visible_alerts = [text.strip() for text in page.get_by_role("alert").all_inner_texts() if text.strip()]
        snapshot = panel.evaluate("""(root) => {
          const visible = (el) => {
            const style = getComputedStyle(el), rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const texts = (selector) => [...root.querySelectorAll(selector)].filter(visible).map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean);
          const actionable = [...root.querySelectorAll('button,input,select,summary,a[href]')].filter(visible);
          const clipped = actionable.filter(el => {
            const r = el.getBoundingClientRect();
            if (r.right > innerWidth + 1 || r.left < -1) {
              let p = el.parentElement;
              while (p && p !== document.body) {
                const s = getComputedStyle(p);
                if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth) return false;
                p = p.parentElement;
              }
              return true;
            }
            return false;
          });
          return {
            headings: texts('h1,h2,h3'),
            buttons: texts('button,summary'),
            tableCount: root.querySelectorAll('table').length,
            rowCount: root.querySelectorAll('tbody tr').length,
            inputCount: actionable.filter(el => ['INPUT','SELECT'].includes(el.tagName)).length,
            clippedActions: clipped.map(el => (el.getAttribute('aria-label') || el.innerText || el.name || el.tagName).trim()).slice(0, 20),
            panelWidth: Math.round(root.getBoundingClientRect().width),
            panelScrollWidth: root.scrollWidth,
          };
        }""")
        snapshot["alerts"] = visible_alerts
        snapshot["documentOverflow"] = page.evaluate("Math.max(0, document.documentElement.scrollWidth - innerWidth)")
        snapshot["activeTab"] = nav.locator(f'[data-r65-tab="{key}"]').get_attribute("aria-current")
        results[key] = snapshot
        page.screenshot(path=str(OUT / f"{name}-{key}.png"), full_page=True)

    # 只读交互：长表展开/收起、归档详情打开/关闭。
    safe_interactions = {}
    for key in ("payments", "collections", "logs"):
        nav.locator(f'[data-r65-tab="{key}"]').click()
        page.wait_for_timeout(300)
        expand = page.get_by_role("button", name=re.compile(r"^显示其余"))
        if expand.count() and expand.first.is_visible():
            before = expand.first.inner_text()
            expand.first.click()
            page.wait_for_timeout(200)
            collapse = page.get_by_role("button", name="收起")
            safe_interactions[key] = {"expandLabel": before, "collapseVisible": bool(collapse.count() and collapse.first.is_visible())}
            if collapse.count() and collapse.first.is_visible():
                collapse.first.click()
        else:
            safe_interactions[key] = {"expandLabel": None, "collapseVisible": None}

    nav.locator('[data-r65-tab="reports"]').click()
    page.wait_for_timeout(300)
    view = page.get_by_role("button", name="查看", exact=True)
    if view.count() and view.first.is_visible():
        view.first.click()
        detail = page.locator('section[aria-label="归档详情"]')
        detail.wait_for(state="visible", timeout=10_000)
        safe_interactions["reportDetail"] = {
            "opened": True,
            "textLength": len(detail.inner_text()),
            "hasTraceability": any(word in detail.inner_text() for word in ("来源", "追溯", "SHA256", "批次")),
        }
        detail.get_by_role("button", name="关闭").click()
        safe_interactions["reportDetail"]["closed"] = detail.count() == 0 or not detail.is_visible()
    else:
        safe_interactions["reportDetail"] = {"opened": False}

    # 成员表单静态交互：只切换角色和选项，不提交。
    nav.locator('[data-r65-tab="users"]').click()
    page.wait_for_timeout(400)
    form = page.locator(".r65-member-form")
    role = form.locator("select").first
    role.select_option("region_manager")
    region_labels = form.locator(".r76-all-scope").all_inner_texts()
    region_selector_count = form.locator(".r76-center-select").count()
    role.select_option("area_manager")
    area = form.locator("select").nth(1)
    available_areas = area.locator("option:not([disabled])").all_text_contents()
    if available_areas:
        area.select_option(label=available_areas[0])
    multi_count = form.locator(".r76-center-select").count()

    # 改密和删除仅验证对话框可触发，一律取消。
    password_button = page.get_by_role("button", name="改密", exact=True).first
    password_opened = False
    password_cancelled = False
    if password_button.count() and password_button.is_visible():
        password_button.click()
        page.wait_for_timeout(100)
        password_input = page.locator('input[aria-label^="修改"][type="password"]').first
        password_opened = bool(password_input.count() and password_input.is_visible())
        cancel = page.get_by_role("button", name="取消", exact=True).first
        if cancel.count() and cancel.is_visible():
            cancel.click()
            password_cancelled = True
    delete_button = page.get_by_role("button", name="删除", exact=True).first
    delete_dialog_before = len(dialogs)
    if delete_button.count() and delete_button.is_visible():
        delete_button.click()
        page.wait_for_timeout(100)

    results["memberStaticInteractions"] = {
        "regionLabels": region_labels,
        "regionCenterSelectorCount": region_selector_count,
        "areaOptionCount": len(available_areas),
        "areaManagerMultiSelectorCount": multi_count,
        "passwordEditorOpened": password_opened,
        "passwordEditorCancelled": password_cancelled,
        "deleteConfirmationOpened": len(dialogs) > delete_dialog_before,
        "dismissedDialogs": dialogs,
    }
    results["safeInteractions"] = safe_interactions
    result = {
        "viewport": [width, height],
        "shellGeometry": shell_geometry,
        "tabs": results,
        "blockedWrites": blocked_writes,
        "consoleErrors": console_errors,
        "pageErrors": page_errors,
        "failedRequests": failed_requests,
    }
    context.close()
    return result


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    auth_token = token()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        results = [
            viewport_audit(browser, auth_token, "desktop1440", 1440, 1000),
            viewport_audit(browser, auth_token, "mobile390", 390, 844),
        ]
        browser.close()
    output = {"target": "production", "writePolicy": "all non-GET requests aborted", "results": results}
    (OUT / "results.json").write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "output": str(OUT / 'results.json')}, ensure_ascii=False))


if __name__ == "__main__":
    main()
