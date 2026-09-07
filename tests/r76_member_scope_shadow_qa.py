import importlib.util
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CHUNK = ROOT / "firstcare-cloud-local/assets/cockpit-r76-member-scope-20260813-v1/chunk-R65SIMPLEADMIN.js"
CSS = ROOT / "firstcare-cloud-local/aph2-r76-member-scope-20260813-v1.css"
OUT = ROOT / "docs/qa/frontend-skill-cloud-20260813/r76-member-scope-shadow"
TARGET = os.environ.get("R76_QA_TARGET", "shadow")
if TARGET == "production":
    OUT = ROOT / "docs/qa/frontend-skill-cloud-20260813/r76-member-scope-production"
OUT.mkdir(parents=True, exist_ok=True)


def token():
    spec = importlib.util.spec_from_file_location("shared_qa", ROOT / "tests/full_remediation_shadow_qa.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.ephemeral_token()


def run_viewport(browser, auth_token, width, height):
    writes = []
    console_errors = []
    context = browser.new_context(viewport={"width": width, "height": height})
    context.add_init_script(f"localStorage.setItem('cockpit_token', {json.dumps(auth_token)}); localStorage.setItem('authToken', {json.dumps(auth_token)});")
    page = context.new_page()
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)

    def route_handler(route):
        request = route.request
        if TARGET == "shadow" and request.url.endswith("/assets/cockpit-r66-full-admin-20260813-v1/chunk-R65SIMPLEADMIN.js"):
            return route.fulfill(status=200, content_type="application/javascript; charset=utf-8", body=CHUNK.read_text())
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            payload = json.loads(request.post_data or "{}")
            writes.append({"method": request.method, "path": request.url.split("firstcare.cloud")[-1], "payload": payload})
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"success": True, "id": 99999}))
        route.continue_()

    page.route("**/*", route_handler)
    page.goto("https://firstcare.cloud/admin", wait_until="networkidle")
    if TARGET == "shadow":
        page.add_style_tag(path=str(CSS))
    page.get_by_role("button", name="成员管理").click()
    page.wait_for_selector("text=新建成员")

    role_select = page.locator(".r65-member-form select").nth(0)
    area_select = page.locator(".r65-member-form select").nth(1)
    role_options = role_select.locator("option").all_text_contents()
    areas = area_select.locator("option:not([disabled])").all_text_contents()
    assert role_options == ["地区职能", "片区经理", "项目经理", "项目职员"]
    assert areas
    area_select.select_option(label=areas[0])
    page.locator(".r65-member-form .r76-center-select summary").click()
    center_boxes = page.locator(".r65-member-form .r76-center-options input[type=checkbox]")
    assert center_boxes.count() >= 2
    center_boxes.nth(0).check()
    center_boxes.nth(1).check()
    selected_centers = page.locator(".r65-member-form .r76-center-options input:checked + span").all_text_contents()
    summary = page.locator(".r65-member-form .r76-center-select summary").inner_text()
    assert summary == "已选择 2 个服务中心"
    page.locator(".r65-member-form .r76-center-select summary").click()

    page.locator(".r65-member-form input").nth(0).fill("r76-shadow-member")
    page.locator(".r65-member-form input[type=password]").fill("R76-Shadow-2026")
    role_select.select_option("area_manager")
    page.locator(".r65-member-form button[type=submit]").click()
    page.wait_for_timeout(250)
    post = next(item for item in writes if item["method"] == "POST" and item["path"].startswith("/api/users"))
    assert post["payload"]["role"] == "area_manager"
    assert post["payload"]["area_scope"] == areas[0]
    assert post["payload"]["service_center_scope"] == selected_centers

    page.screenshot(path=str(OUT / f"{width}x{height}-member-scope.png"), full_page=True)
    result = {
        "target": TARGET,
        "candidateInjected": TARGET == "shadow",
        "viewport": [width, height],
        "roles": role_options,
        "area": areas[0],
        "selectedCenters": selected_centers,
        "summary": summary,
        "capturedWrite": post,
        "horizontalOverflow": page.evaluate("document.documentElement.scrollWidth - innerWidth"),
        "consoleErrors": console_errors,
    }
    context.close()
    return result


def main():
    auth_token = token()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        results = [run_viewport(browser, auth_token, 1440, 1000), run_viewport(browser, auth_token, 390, 844)]
        browser.close()
    (OUT / "results.json").write_text(json.dumps({"results": results}, ensure_ascii=False, indent=2))
    print(json.dumps({"passed": len(results), "output": str(OUT / "results.json")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
