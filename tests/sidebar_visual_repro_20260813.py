#!/usr/bin/env python3
"""R70 侧栏只读影子/生产验收。

覆盖六档桌面宽度、十四个路由、汉堡鼠标/键盘状态、SPA 切页，以及
`/arrears` 离开时的整页 reload 首帧抑制。浏览器中的非只读请求一律阻断。
"""

from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import urllib.parse
from pathlib import Path

from playwright.sync_api import Route, TimeoutError as PlaywrightTimeoutError, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("R70_QA_BASE", "https://www.firstcare.cloud").rstrip("/")
TARGET = os.environ.get("R70_QA_TARGET", "shadow").strip().lower()
PROFILE = os.environ.get("R70_QA_PROFILE", "full").strip().lower()
RUN_INTERACTIONS = os.environ.get("R70_QA_RUN_INTERACTIONS", "1").strip() != "0"
RUN_CROSS_DOCUMENT = os.environ.get("R70_QA_RUN_CROSS_DOCUMENT", "1").strip() != "0"
RUN_TOUCH = os.environ.get("R70_QA_RUN_TOUCH", "1").strip() != "0"
OUT = Path(os.environ.get(
    "R70_QA_OUT",
    ROOT / f"docs/qa/frontend-skill-cloud-20260813/r70-sidebar-{TARGET}",
))
SHOTS = OUT / "screenshots"
JS = ROOT / "firstcare-cloud-local/aph2-r70-sidebar-transient-overlay-20260813-v1.js"
CSS = ROOT / "firstcare-cloud-local/aph2-r70-sidebar-transient-overlay-20260813-v1.css"
EXTRA_CSS = Path(os.environ["R70_QA_EXTRA_CSS"]).resolve() \
    if os.environ.get("R70_QA_EXTRA_CSS", "").strip() else None
RELEASE = "r70-sidebar-transient-overlay-20260813-v1"
EXPECTED_JS_SHA256 = "bda58758e141eb37582dd1e615f66411737421335618a6aaf199f818cf1ffe8a"
EXPECTED_CSS_SHA256 = "024c02ffc643c68294cfc2b763a7917fbe73cc968c231ad8f57a7a879b388a48"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
# 审核系统只允许两段精确会话交换；它们不是业务数据写入，单独记录。
SSO_AUTH_HANDSHAKES = {
    ("POST", "/api/integrations/review/sso"),
    ("POST", "/review-api/auth/cockpit-sso"),
}
FROZEN_JS_BYTES = JS.read_bytes() if JS.is_file() else b""
FROZEN_CSS_BYTES = CSS.read_bytes() if CSS.is_file() else b""
FROZEN_JS_TEXT = FROZEN_JS_BYTES.decode("utf-8") if FROZEN_JS_BYTES else ""
FROZEN_CSS_TEXT = FROZEN_CSS_BYTES.decode("utf-8") if FROZEN_CSS_BYTES else ""
EXTRA_CSS_TEXT = EXTRA_CSS.read_text(encoding="utf-8") if EXTRA_CSS else ""
ACTUAL_JS_SHA256 = hashlib.sha256(FROZEN_JS_BYTES).hexdigest() if FROZEN_JS_BYTES else None
ACTUAL_CSS_SHA256 = hashlib.sha256(FROZEN_CSS_BYTES).hexdigest() if FROZEN_CSS_BYTES else None

ROUTES = [
    "/", "/command", "/projects", "/payment", "/daily", "/collection",
    "/arrears", "/ai-alerts", "/ai-report", "/import", "/review",
    "/system", "/tasks", "/admin",
]
EXPECTED_PATHS = {"/system": "/admin", "/tasks": "/command"}
VIEWPORTS = [
    ("641x844", {"width": 641, "height": 844}),
    ("642x844", {"width": 642, "height": 844}),
    ("768x900", {"width": 768, "height": 900}),
    ("1024x900", {"width": 1024, "height": 900}),
    ("1249x900", {"width": 1249, "height": 900}),
    ("1440x1000", {"width": 1440, "height": 1000}),
    ("1814x986", {"width": 1814, "height": 986}),
]
CROSS_DOCUMENT_TARGETS = [
    "/command", "/projects", "/payment", "/daily", "/collection",
    "/ai-alerts", "/ai-report",
]

if os.environ.get("R70_QA_VIEWPORTS", "").strip():
    selected_viewports = {
        item.strip() for item in os.environ["R70_QA_VIEWPORTS"].split(",") if item.strip()
    }
    VIEWPORTS = [
        (name, viewport) for name, viewport in VIEWPORTS
        if name in selected_viewports or str(viewport["width"]) in selected_viewports
    ]
if os.environ.get("R70_QA_ROUTES", "").strip():
    ROUTES = [
        item.strip() for item in os.environ["R70_QA_ROUTES"].split(",") if item.strip()
    ]
if os.environ.get("R70_QA_CROSS_TARGETS", "").strip():
    CROSS_DOCUMENT_TARGETS = [
        item.strip()
        for item in os.environ["R70_QA_CROSS_TARGETS"].split(",")
        if item.strip()
    ]


spec = importlib.util.spec_from_file_location("qa", ROOT / "tests/full_remediation_shadow_qa.py")
qa = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(qa)


class BrowserReadOnlyGuard:
    """允许页面读取，阻断并记录所有潜在写请求。"""

    def __init__(self) -> None:
        self.blocked: list[dict] = []
        self.allowed_handshakes: list[dict] = []

    def handle(self, route: Route) -> None:
        request = route.request
        method = request.method.upper()
        parsed = urllib.parse.urlsplit(request.url)
        if method in SAFE_METHODS:
            route.continue_()
            return
        if (method, parsed.path) in SSO_AUTH_HANDSHAKES:
            self.allowed_handshakes.append({
                "method": method,
                "path": parsed.path,
                "resourceType": request.resource_type,
            })
            route.continue_()
            return
        self.blocked.append({
            "method": method,
            "path": parsed.path,
            "resourceType": request.resource_type,
        })
        route.abort("blockedbyclient")


PROBE = r"""
() => {
  const rect = node => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      left: Number(box.left.toFixed(2)), right: Number(box.right.toFixed(2)),
      top: Number(box.top.toFixed(2)), bottom: Number(box.bottom.toFixed(2)),
      width: Number(box.width.toFixed(2)), height: Number(box.height.toFixed(2)),
      paddingLeft: style.paddingLeft, marginLeft: style.marginLeft,
    };
  };
  const visible = node => {
    if (!node) return false;
    const style = getComputedStyle(node), box = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity || 1) > 0 && box.width > 1 && box.height > 1;
  };
  const sidebar = document.querySelector('.aph-exact-sidebar');
  const panel = document.querySelector('.aph-exact-sidebar-panel');
  const main = document.querySelector('main#main-content');
  const content = main && (
    [...main.children].find(visible) || [...main.querySelectorAll('*')].find(visible)
  );
  const labels = [...document.querySelectorAll('.aph-exact-sidebar-panel a span')];
  const active = document.activeElement;
  return {
    path: location.pathname + location.search,
    documentId: window.__r70QaDocumentId || null,
    sidebar: rect(sidebar), panel: rect(panel), main: rect(main), content: rect(content),
    classes: sidebar?.className || null,
    hover: sidebar?.matches(':hover') || false,
    focus: active ? {
      tag: active.tagName, className: String(active.className || ''),
      href: active.getAttribute?.('href') || null,
    } : null,
    labelsVisible: labels.filter(visible).map(node => node.textContent.trim()),
    labelsTotal: labels.length,
    menuExpanded: document.querySelector('.aph-header-menu')?.getAttribute('aria-expanded') || null,
    pin: sessionStorage.getItem('aph-nav-pinned-v2'),
    release: document.documentElement.dataset.r70SidebarRelease || null,
    shadowStyle: Boolean(document.querySelector('#r70-qa-shadow-style')),
    pointer: window.__r70QaPointer || null,
    earlySamples: window.__r70QaEarlySamples || [],
    classMutations: window.__r70QaClassMutations || [],
    overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
  };
}
"""


EARLY_RECORDER = r"""
(() => {
  window.__r70QaEarlySamples = [];
  window.__r70QaClassMutations = [];
  let sidebarFound = false;
  const sample = label => {
    const sidebar = document.querySelector('.aph-exact-sidebar');
    const panel = document.querySelector('.aph-exact-sidebar-panel');
    if (!sidebar || !panel) return;
    const box = panel.getBoundingClientRect();
    const labels = [...panel.querySelectorAll('a span')];
    const visibleLabels = labels.filter(node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 1;
    });
    window.__r70QaEarlySamples.push({
      label, at: Number(performance.now().toFixed(2)),
      panelWidth: Number(box.width.toFixed(2)),
      classes: sidebar.className,
      hover: sidebar.matches(':hover'),
      labelsVisible: visibleLabels.length,
      release: document.documentElement.dataset.r70SidebarRelease || null,
    });
  };
  const detect = () => {
    if (sidebarFound || !document.querySelector('.aph-exact-sidebar-panel')) return;
    sidebarFound = true;
    const sidebar = document.querySelector('.aph-exact-sidebar');
    const classObserver = new MutationObserver(() => {
      window.__r70QaClassMutations.push({
        at: Number(performance.now().toFixed(2)),
        classes: sidebar.className,
      });
    });
    classObserver.observe(sidebar, {attributes: true, attributeFilter: ['class']});
    requestAnimationFrame(() => sample('first-frame'));
    setTimeout(() => sample('0.1s'), 100);
    setTimeout(() => sample('0.7s'), 700);
    setTimeout(() => sample('2s'), 2000);
  };
  const observer = new MutationObserver(detect);
  observer.observe(document.documentElement, {childList: true, subtree: true});
  detect();
})();
"""


def browser_init_script(token: str, inject_candidate: bool = True) -> str:
    script = (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R70只读验收',role:'admin'}));"
        "sessionStorage.removeItem('aph-nav-pinned-v2');"
        "window.__r70QaDocumentId=Math.random().toString(36).slice(2);"
        "addEventListener('pointermove',event=>{window.__r70QaPointer={x:event.clientX,y:event.clientY,type:event.pointerType};},{passive:true,capture:true});"
    )
    boot_body = ""
    if TARGET == "shadow" and inject_candidate:
        css_text = FROZEN_CSS_TEXT + "\n" + EXTRA_CSS_TEXT
        js_text = FROZEN_JS_TEXT
        boot_body += (
            "const r70QaStyle=document.createElement('style');"
            "r70QaStyle.id='r70-qa-shadow-style';"
            f"r70QaStyle.textContent={json.dumps(css_text)};"
            "document.documentElement.appendChild(r70QaStyle);"
            + js_text
        )
    # 产品 IIFE 无尾分号；影子记录器前显式分隔，避免被解析为对 IIFE 返回值的调用。
    boot_body += ";\n" + EARLY_RECORDER
    script += (
        "(()=>{"
        "const r70QaBoot=()=>{"
        "if(window.__r70QaBooted||!document.documentElement)return;"
        "window.__r70QaBooted=true;"
        + boot_body
        + "};"
        "if(document.documentElement){r70QaBoot();}else{"
        "const r70QaDocumentObserver=new MutationObserver(()=>{"
        "if(!document.documentElement)return;"
        "r70QaDocumentObserver.disconnect();r70QaBoot();"
        "});"
        "r70QaDocumentObserver.observe(document,{childList:true});"
        "}"
        "})();"
    )
    return script


def new_context(
    browser,
    token: str,
    viewport: dict,
    *,
    touch: bool = False,
    inject_candidate: bool = True,
):
    guard = BrowserReadOnlyGuard()
    context = browser.new_context(
        viewport=viewport,
        has_touch=touch,
        is_mobile=touch,
    )
    context.add_init_script(script=browser_init_script(token, inject_candidate))
    context.route("**/*", guard.handle)
    return context, guard


def wait_shell(page, delay: int = 300) -> None:
    page.locator(".aph-exact-sidebar-panel").wait_for(state="attached", timeout=15_000)
    page.locator("main#main-content").wait_for(state="attached", timeout=15_000)
    try:
        page.locator("main#main-content h1").first.wait_for(state="attached", timeout=2_000)
    except PlaywrightTimeoutError:
        pass
    page.wait_for_timeout(delay)


def wait_sidebar(page, delay: int = 300) -> None:
    page.locator(".aph-exact-sidebar-panel").wait_for(state="attached", timeout=15_000)
    page.wait_for_timeout(delay)


def state_summary(state: dict) -> dict:
    return {
        "path": state.get("path"),
        "documentId": state.get("documentId"),
        "panelWidth": (state.get("panel") or {}).get("width"),
        "sidebarWidth": (state.get("sidebar") or {}).get("width"),
        "main": state.get("main"),
        "classes": state.get("classes"),
        "hover": state.get("hover"),
        "labelsVisible": len(state.get("labelsVisible", [])),
        "menuExpanded": state.get("menuExpanded"),
        "release": state.get("release"),
        "pointer": state.get("pointer"),
        "overflowX": state.get("overflowX"),
    }


def panel_point(state: dict, viewport: dict) -> tuple[float, float]:
    panel = state["panel"]
    return (
        panel["left"] + 30,
        min(viewport["height"] - 12, panel["top"] + 160),
    )


def main_stable(before: dict, after: dict, tolerance: float = 0.75) -> bool:
    first, second = before.get("main"), after.get("main")
    if not first or not second:
        return False
    return all(abs(first[key] - second[key]) <= tolerance for key in ("left", "width"))


def safe_name(route: str) -> str:
    return "home" if route == "/" else route.strip("/").replace("/", "-")


def run_route_matrix(
    browser,
    token: str,
    cases: list[tuple[str, dict, list[str]]] | None = None,
) -> list[dict]:
    runs: list[dict] = []
    route_cases = cases or [
        (viewport_name, viewport, ROUTES)
        for viewport_name, viewport in VIEWPORTS
    ]
    for viewport_name, viewport, case_routes in route_cases:
        context, guard = new_context(browser, token, viewport)
        page = context.new_page()
        page_errors: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        try:
            for route in case_routes:
                blocked_before = len(guard.blocked)
                run: dict = {"kind": "route", "viewport": viewport_name, "route": route}
                try:
                    response = page.goto(BASE + route, wait_until="domcontentloaded", timeout=30_000)
                    wait_shell(page)
                    page.mouse.move(viewport["width"] - 8, viewport["height"] - 8)
                    page.wait_for_timeout(250)
                    collapsed = page.evaluate(PROBE)
                    x, y = panel_point(collapsed, viewport)
                    page.mouse.move(x, y)
                    page.wait_for_timeout(450)
                    hovered = page.evaluate(PROBE)
                    if (
                        viewport_name == "1440x1000"
                        and route in {"/", "/daily", "/collection", "/admin"}
                    ) or (
                        viewport_name == "1249x900"
                        and route in {"/", "/daily", "/collection", "/admin"}
                    ):
                        page.screenshot(
                            path=str(SHOTS / f"{viewport_name}-{safe_name(route)}-hover.png"),
                            full_page=False,
                        )
                    page.mouse.move(viewport["width"] - 8, viewport["height"] - 8)
                    page.wait_for_timeout(400)
                    left = page.evaluate(PROBE)
                    actual_path = urllib.parse.urlsplit(page.url).path.rstrip("/") or "/"
                    expected_path = EXPECTED_PATHS.get(route, route).rstrip("/") or "/"
                    writes = guard.blocked[blocked_before:]
                    checks = {
                        "response200": response is not None and response.status == 200,
                        "routeMatched": actual_path == expected_path,
                        "releaseLoaded": collapsed.get("release") == RELEASE,
                        "productionNoShadowStyle": (
                            TARGET != "production" or not collapsed.get("shadowStyle")
                        ),
                        "collapsed60": (collapsed.get("panel") or {}).get("width") == 60,
                        "hover140": (hovered.get("panel") or {}).get("width") == 140,
                        "mainStable": main_stable(collapsed, hovered),
                        "leave60": (left.get("panel") or {}).get("width") == 60,
                        "collapsedLabelsHidden": len(collapsed.get("labelsVisible", [])) == 0,
                        "hoverLabelsVisible": len(hovered.get("labelsVisible", [])) > 0,
                        "leaveLabelsHidden": len(left.get("labelsVisible", [])) == 0,
                        "collapsedAriaFalse": collapsed.get("menuExpanded") == "false",
                        "hoverAriaTrue": hovered.get("menuExpanded") == "true",
                        "leaveAriaFalse": left.get("menuExpanded") == "false",
                        "noOverflow": max(
                            collapsed.get("overflowX", 999),
                            hovered.get("overflowX", 999),
                            left.get("overflowX", 999),
                        ) <= 1,
                        "noWrites": not writes,
                    }
                    run.update({
                        "responseStatus": response.status if response else None,
                        "actualPath": actual_path,
                        "states": {
                            "collapsed": state_summary(collapsed),
                            "hover": state_summary(hovered),
                            "leave": state_summary(left),
                        },
                        "checks": checks,
                        "failures": [name for name, passed in checks.items() if not passed],
                        "blockedWrites": writes,
                        "allowedSsoAuthHandshakes": guard.allowed_handshakes,
                    })
                except Exception as error:
                    run.update({
                        "failures": [f"{type(error).__name__}: {error}"],
                        "blockedWrites": guard.blocked[blocked_before:],
                    })
                runs.append(run)
                print(json.dumps({
                    "kind": "route", "viewport": viewport_name, "route": route,
                    "failures": run.get("failures", []),
                }, ensure_ascii=False), flush=True)
        finally:
            context.close()
        if page_errors:
            runs.append({
                "kind": "route-page-errors", "viewport": viewport_name,
                "failures": [f"pageerror: {error}" for error in page_errors],
                "blockedWrites": guard.blocked,
                "allowedSsoAuthHandshakes": guard.allowed_handshakes,
            })
    return runs


def run_interactions(
    browser,
    token: str,
    viewports: list[tuple[str, dict]] | None = None,
) -> list[dict]:
    runs: list[dict] = []
    for viewport_name, viewport in (viewports or VIEWPORTS):
        context, guard = new_context(browser, token, viewport)
        page = context.new_page()
        run: dict = {"kind": "interactions", "viewport": viewport_name}
        try:
            page.goto(BASE + "/", wait_until="domcontentloaded", timeout=30_000)
            wait_shell(page)
            page.mouse.move(viewport["width"] - 8, viewport["height"] - 8)
            page.wait_for_timeout(250)
            collapsed = page.evaluate(PROBE)
            menu = page.locator(".aph-header-menu")

            # 鼠标点击汉堡，不进入面板，应在 1.2 秒定时器后自动收起。
            menu.click()
            page.wait_for_timeout(120)
            pointer_open = page.evaluate(PROBE)
            page.wait_for_timeout(1500)
            pointer_timeout = page.evaluate(PROBE)

            # 再次鼠标打开并及时进入面板；面板保持可用，离开后收起。
            menu.click()
            page.wait_for_timeout(100)
            opening_for_enter = page.evaluate(PROBE)
            x, y = panel_point(opening_for_enter, viewport)
            page.mouse.move(x, y)
            page.wait_for_timeout(250)
            pointer_entered = page.evaluate(PROBE)
            page.wait_for_timeout(1500)
            pointer_entered_held = page.evaluate(PROBE)
            page.mouse.move(viewport["width"] - 8, viewport["height"] - 8)
            page.wait_for_timeout(400)
            pointer_left = page.evaluate(PROBE)

            # 键盘 Enter 打开不设自动关闭计时；Escape 显式关闭并回焦菜单。
            menu.focus()
            page.keyboard.press("Enter")
            page.wait_for_timeout(150)
            keyboard_open = page.evaluate(PROBE)
            page.keyboard.press("Escape")
            page.wait_for_timeout(150)
            keyboard_escape = page.evaluate(PROBE)

            # SPA 点击后保持 60px；指针真正离开后，重新 hover 应恢复 140px。
            page.mouse.move(viewport["width"] - 8, viewport["height"] - 8)
            page.wait_for_timeout(200)
            before_spa_id = page.evaluate("window.__r70QaDocumentId")
            collapsed_for_spa = page.evaluate(PROBE)
            x, y = panel_point(collapsed_for_spa, viewport)
            page.mouse.move(x, y)
            page.wait_for_timeout(250)
            spa_link = page.locator('.aph-exact-sidebar a[href="/ai-report"]')
            spa_link.evaluate("node => node.click()")
            page.wait_for_url("**/ai-report", timeout=15_000)
            wait_shell(page, 700)
            spa_after_click = page.evaluate(PROBE)
            page.mouse.move(viewport["width"] - 8, viewport["height"] - 8)
            page.wait_for_timeout(350)
            spa_after_leave = page.evaluate(PROBE)
            x, y = panel_point(spa_after_leave, viewport)
            page.mouse.move(x, y)
            page.wait_for_timeout(450)
            spa_rehover = page.evaluate(PROBE)

            checks = {
                "releaseLoaded": collapsed.get("release") == RELEASE,
                "productionNoShadowStyle": (
                    TARGET != "production" or not collapsed.get("shadowStyle")
                ),
                "initial60": (collapsed.get("panel") or {}).get("width") == 60,
                "pointerMenuOpened140": (pointer_open.get("panel") or {}).get("width") == 140,
                "pointerMenuMainStable": main_stable(collapsed, pointer_open),
                "pointerMenuAutoClosed60": (pointer_timeout.get("panel") or {}).get("width") == 60,
                "pointerEnterOpened140": (pointer_entered.get("panel") or {}).get("width") == 140,
                "pointerEnterHeld140": (pointer_entered_held.get("panel") or {}).get("width") == 140,
                "pointerLeaveClosed60": (pointer_left.get("panel") or {}).get("width") == 60,
                "keyboardEnterOpened140": (keyboard_open.get("panel") or {}).get("width") == 140,
                "keyboardEscapeClosed60": (keyboard_escape.get("panel") or {}).get("width") == 60,
                "keyboardEscapeAriaFalse": keyboard_escape.get("menuExpanded") == "false",
                "spaSameDocument": spa_after_click.get("documentId") == before_spa_id,
                "spaPath": urllib.parse.urlsplit(page.url).path == "/ai-report",
                "spaClickCollapsed60": (spa_after_click.get("panel") or {}).get("width") == 60,
                "spaClickLabelsHidden": len(spa_after_click.get("labelsVisible", [])) == 0,
                "spaClickAriaFalse": spa_after_click.get("menuExpanded") == "false",
                "spaLeave60": (spa_after_leave.get("panel") or {}).get("width") == 60,
                "spaRehover140": (spa_rehover.get("panel") or {}).get("width") == 140,
                "spaRehoverLabels": len(spa_rehover.get("labelsVisible", [])) > 0,
                "noWrites": not guard.blocked,
            }
            run.update({
                "states": {
                    "collapsed": state_summary(collapsed),
                    "pointerOpen": state_summary(pointer_open),
                    "pointerTimeout": state_summary(pointer_timeout),
                    "pointerEntered": state_summary(pointer_entered),
                    "pointerEnteredHeld": state_summary(pointer_entered_held),
                    "pointerLeft": state_summary(pointer_left),
                    "keyboardOpen": state_summary(keyboard_open),
                    "keyboardEscape": state_summary(keyboard_escape),
                    "spaAfterClick": state_summary(spa_after_click),
                    "spaAfterLeave": state_summary(spa_after_leave),
                    "spaRehover": state_summary(spa_rehover),
                },
                "checks": checks,
                "failures": [name for name, passed in checks.items() if not passed],
                "blockedWrites": guard.blocked,
                "allowedSsoAuthHandshakes": guard.allowed_handshakes,
            })
            if viewport_name in {"641x844", "1249x900", "1440x1000", "1814x986"}:
                page.screenshot(path=str(SHOTS / f"{viewport_name}-spa-rehover.png"), full_page=False)
        except Exception as error:
            run.update({
                "failures": [f"{type(error).__name__}: {error}"],
                "blockedWrites": guard.blocked,
                "allowedSsoAuthHandshakes": guard.allowed_handshakes,
            })
        finally:
            context.close()
        runs.append(run)
        print(json.dumps({
            "kind": "interactions", "viewport": viewport_name,
            "failures": run.get("failures", []),
        }, ensure_ascii=False), flush=True)
    return runs


def early_sample_checks(samples: list[dict], class_mutations: list[dict]) -> dict:
    wanted = ("first-frame", "0.1s", "0.7s", "2s")
    by_label = {sample.get("label"): sample for sample in samples}
    settled_700 = by_label.get("0.7s", {})
    settled_2000 = by_label.get("2s", {})
    late_mutations = [
        mutation for mutation in class_mutations
        if mutation.get("at", -1) > settled_700.get("at", float("inf")) + 20
        and mutation.get("at", -1) <= settled_2000.get("at", -1) + 20
    ]
    return {
        f"{label}.present": label in by_label
        for label in wanted
    } | {
        f"{label}.panel60": by_label.get(label, {}).get("panelWidth") == 60
        for label in wanted
    } | {
        f"{label}.labelsHidden": by_label.get(label, {}).get("labelsVisible") == 0
        for label in wanted
    } | {
        "0.7s.suppressedClass": "aph-r70-hover-suppressed" in settled_700.get("classes", ""),
        "0.7s.noExpandedClass": "is-expanded" not in settled_700.get("classes", ""),
        "0.7s.noHoveredClass": "is-hovered" not in settled_700.get("classes", ""),
        "0.7sTo2s.sameClasses": settled_700.get("classes") == settled_2000.get("classes"),
        "0.7sTo2s.noLateClassMutation": not late_mutations,
    }


def run_cross_document(
    browser,
    token: str,
    viewports: list[tuple[str, dict]] | None = None,
    targets: list[str] | None = None,
) -> list[dict]:
    runs: list[dict] = []
    for viewport_name, viewport in (viewports or VIEWPORTS):
        context, guard = new_context(browser, token, viewport)
        page = context.new_page()
        try:
            for target in (targets or CROSS_DOCUMENT_TARGETS):
                blocked_before = len(guard.blocked)
                run: dict = {
                    "kind": "arrears-cross-document",
                    "viewport": viewport_name,
                    "source": "/arrears",
                    "target": target,
                }
                try:
                    page.goto(BASE + "/arrears", wait_until="domcontentloaded", timeout=30_000)
                    wait_shell(page)
                    page.mouse.move(viewport["width"] - 8, viewport["height"] - 8)
                    page.wait_for_timeout(250)
                    before = page.evaluate(PROBE)
                    source_document_id = before.get("documentId")
                    x, y = panel_point(before, viewport)
                    page.mouse.move(x, y)
                    page.wait_for_timeout(250)
                    link = page.locator(f'.aph-exact-sidebar a[href="{target}"]')
                    link.evaluate("node => node.click()")
                    target_path = target
                    page.wait_for_url(
                        lambda url: urllib.parse.urlsplit(url).path == target_path,
                        timeout=20_000,
                    )
                    wait_shell(page, 2200)
                    steady = page.evaluate(PROBE)
                    samples = steady.get("earlySamples", [])
                    class_mutations = steady.get("classMutations", [])
                    if viewport_name == "1249x900" and target == "/ai-alerts":
                        page.screenshot(
                            path=str(SHOTS / "1249x900-arrears-to-ai-alerts-steady-2s.png"),
                            full_page=False,
                        )
                    page.mouse.move(viewport["width"] - 8, viewport["height"] - 8)
                    page.wait_for_timeout(350)
                    after_leave = page.evaluate(PROBE)
                    x, y = panel_point(after_leave, viewport)
                    page.mouse.move(x, y)
                    page.wait_for_timeout(450)
                    rehover = page.evaluate(PROBE)
                    writes = guard.blocked[blocked_before:]
                    checks = {
                        "newDocument": steady.get("documentId") != source_document_id,
                        "routeMatched": urllib.parse.urlsplit(page.url).path == target_path,
                        "releaseLoaded": steady.get("release") == RELEASE,
                        "productionNoShadowStyle": (
                            TARGET != "production" or not steady.get("shadowStyle")
                        ),
                        **early_sample_checks(samples, class_mutations),
                        "steady2s60": (steady.get("panel") or {}).get("width") == 60,
                        "steadyLabelsHidden": len(steady.get("labelsVisible", [])) == 0,
                        "steadyAriaFalse": steady.get("menuExpanded") == "false",
                        "leave60": (after_leave.get("panel") or {}).get("width") == 60,
                        "rehover140": (rehover.get("panel") or {}).get("width") == 140,
                        "rehoverLabels": len(rehover.get("labelsVisible", [])) > 0,
                        "noWrites": not writes,
                    }
                    run.update({
                        "sourceDocumentId": source_document_id,
                        "targetDocumentId": steady.get("documentId"),
                        "earlySamples": samples,
                        "classMutations": class_mutations,
                        "states": {
                            "steady": state_summary(steady),
                            "afterLeave": state_summary(after_leave),
                            "rehover": state_summary(rehover),
                        },
                        "checks": checks,
                        "failures": [name for name, passed in checks.items() if not passed],
                        "blockedWrites": writes,
                        "allowedSsoAuthHandshakes": guard.allowed_handshakes,
                    })
                    if viewport_name in {"1249x900", "1440x1000"}:
                        page.screenshot(
                            path=str(SHOTS / f"{viewport_name}-arrears-to-{safe_name(target)}-rehover.png"),
                            full_page=False,
                        )
                except Exception as error:
                    run.update({
                        "failures": [f"{type(error).__name__}: {error}"],
                        "blockedWrites": guard.blocked[blocked_before:],
                    })
                runs.append(run)
                print(json.dumps({
                    "kind": "arrears-cross-document", "viewport": viewport_name,
                    "target": target, "failures": run.get("failures", []),
                }, ensure_ascii=False), flush=True)
        finally:
            context.close()
    return runs


def touch_fingerprint(state: dict) -> dict:
    """排除候选 release 标记，仅比较 640px 原移动端的可见行为。"""
    return {
        "sidebar": state.get("sidebar"),
        "panel": state.get("panel"),
        "classes": state.get("classes"),
        "menuExpanded": state.get("menuExpanded"),
        "labelsVisible": state.get("labelsVisible"),
        "overflowX": state.get("overflowX"),
    }


def capture_touch_state(browser, token: str, inject_candidate: bool) -> dict:
    viewport = {"width": 640, "height": 844}
    context, guard = new_context(
        browser,
        token,
        viewport,
        touch=True,
        inject_candidate=inject_candidate,
    )
    page = context.new_page()
    result: dict = {"injectCandidate": inject_candidate}
    try:
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=30_000)
        wait_sidebar(page, 400)
        before = page.evaluate(PROBE)
        # 640px 使用既有底部“更多”入口，桌面汉堡在该断点本来就是隐藏的。
        page.locator(".aph-mobile-more-trigger").tap(timeout=5_000)
        page.wait_for_timeout(300)
        after_tap = page.evaluate(PROBE)
        page.wait_for_timeout(1500)
        after_1500 = page.evaluate(PROBE)
        result.update({
            "desktopMedia": page.evaluate("matchMedia('(min-width: 641px)').matches"),
            "before": before,
            "afterTap": after_tap,
            "after1500": after_1500,
            "blockedWrites": guard.blocked,
            "allowedSsoAuthHandshakes": guard.allowed_handshakes,
        })
        if inject_candidate:
            page.screenshot(path=str(SHOTS / "640x844-touch-after-1500.png"), full_page=False)
    except Exception as error:
        result.update({
            "error": f"{type(error).__name__}: {error}",
            "blockedWrites": guard.blocked,
        })
    finally:
        context.close()
    return result


def run_touch_boundary(browser, token: str) -> list[dict]:
    if TARGET == "shadow":
        baseline = capture_touch_state(browser, token, False)
        candidate = capture_touch_state(browser, token, True)
    else:
        baseline = None
        candidate = capture_touch_state(browser, token, True)

    run: dict = {
        "kind": "touch-boundary",
        "viewport": "640x844-touch",
        "baseline": baseline,
        "candidate": candidate,
    }
    candidate_states = [
        candidate.get("before", {}),
        candidate.get("afterTap", {}),
        candidate.get("after1500", {}),
    ]
    candidate_mutations = [
        mutation
        for state in candidate_states
        for mutation in state.get("classMutations", [])
    ]
    checks = {
        "candidateLoaded": candidate.get("before", {}).get("release") == RELEASE,
        "productionNoShadowStyle": (
            TARGET != "production"
            or not candidate.get("before", {}).get("shadowStyle")
        ),
        "mobileMediaPreserved": candidate.get("desktopMedia") is False,
        "noR70SuppressionState": all(
            "aph-r70-hover-suppressed" not in (state.get("classes") or "")
            for state in candidate_states
        ),
        "noR70SuppressionMutation": all(
            "aph-r70-hover-suppressed" not in (mutation.get("classes") or "")
            for mutation in candidate_mutations
        ),
        "candidateNoWrites": not candidate.get("blockedWrites"),
        "candidateNoError": not candidate.get("error"),
    }
    if baseline is not None:
        checks.update({
            "baselineNoWrites": not baseline.get("blockedWrites"),
            "baselineNoError": not baseline.get("error"),
            "beforeUnchanged": touch_fingerprint(candidate.get("before", {}))
                == touch_fingerprint(baseline.get("before", {})),
            "tapUnchanged": touch_fingerprint(candidate.get("afterTap", {}))
                == touch_fingerprint(baseline.get("afterTap", {})),
            "after1500Unchanged": touch_fingerprint(candidate.get("after1500", {}))
                == touch_fingerprint(baseline.get("after1500", {})),
        })
    run.update({
        "checks": checks,
        "failures": [name for name, passed in checks.items() if not passed],
        "blockedWrites": (
            (baseline or {}).get("blockedWrites", [])
            + candidate.get("blockedWrites", [])
        ),
    })
    print(json.dumps({
        "kind": "touch-boundary", "viewport": "640x844-touch",
        "failures": run["failures"],
    }, ensure_ascii=False), flush=True)
    return [run]


def main() -> None:
    if TARGET not in {"shadow", "production"}:
        raise SystemExit("R70_QA_TARGET 仅支持 shadow 或 production")
    if TARGET == "shadow" and (not JS.is_file() or not CSS.is_file()):
        raise SystemExit("R70 冻结资产不存在")
    if TARGET == "shadow" and ACTUAL_JS_SHA256 != EXPECTED_JS_SHA256:
        raise SystemExit(f"R70 JS SHA 漂移: {ACTUAL_JS_SHA256}")
    if TARGET == "shadow" and ACTUAL_CSS_SHA256 != EXPECTED_CSS_SHA256:
        raise SystemExit(f"R70 CSS SHA 漂移: {ACTUAL_CSS_SHA256}")
    if PROFILE not in {"full", "focused"}:
        raise SystemExit("R70_QA_PROFILE 仅支持 full 或 focused")

    if PROFILE == "focused":
        viewport_map = {name: viewport for name, viewport in VIEWPORTS}
        required = {"641x844", "642x844", "1249x900"}
        missing = sorted(required - viewport_map.keys())
        if missing:
            raise SystemExit(f"focused 缺少视口: {','.join(missing)}")
        route_cases = [
            ("641x844", viewport_map["641x844"], ROUTES),
            ("642x844", viewport_map["642x844"], ["/"]),
            (
                "1249x900",
                viewport_map["1249x900"],
                ["/", "/daily", "/collection", "/admin"],
            ),
        ]
        interaction_viewports = [
            ("641x844", viewport_map["641x844"]),
            ("642x844", viewport_map["642x844"]),
            ("1249x900", viewport_map["1249x900"]),
        ]
        # 用户截图路径的跨 document 缺陷在 1249px 目标视口逐条覆盖七个入口。
        cross_viewports = [("1249x900", viewport_map["1249x900"])]
    else:
        route_cases = None
        interaction_viewports = None
        cross_viewports = None

    SHOTS.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("R70_QA_TOKEN", "").strip() or qa.ephemeral_token()
    output: dict = {
        "base": BASE,
        "target": TARGET,
        "profile": PROFILE,
        "candidate": [JS.name, CSS.name] if TARGET == "shadow" else None,
        "candidateInjected": TARGET == "shadow",
        "candidateSha256": {
            "js": ACTUAL_JS_SHA256,
            "css": ACTUAL_CSS_SHA256,
        } if TARGET == "shadow" else None,
        "extraCss": str(EXTRA_CSS) if TARGET == "shadow" and EXTRA_CSS else None,
        "productionMutation": False,
        "guard": (
            "BrowserReadOnlyGuard: GET/HEAD/OPTIONS plus two exact SSO auth "
            "handshakes allowed; every other non-read request aborted"
        ),
        "viewports": [name for name, _ in VIEWPORTS],
        "routes": ROUTES,
        "runPlan": {
            "routeMatrix": True,
            "interactions": RUN_INTERACTIONS,
            "crossDocument": RUN_CROSS_DOCUMENT,
            "touch": RUN_TOUCH,
        },
    }
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                output["routeRuns"] = run_route_matrix(browser, token, route_cases)
                output["interactionRuns"] = (
                    run_interactions(browser, token, interaction_viewports)
                    if RUN_INTERACTIONS else []
                )
                output["crossDocumentRuns"] = (
                    run_cross_document(
                        browser,
                        token,
                        cross_viewports,
                        CROSS_DOCUMENT_TARGETS,
                    )
                    if RUN_CROSS_DOCUMENT else []
                )
                output["touchRuns"] = (
                    run_touch_boundary(browser, token)
                    if RUN_TOUCH else []
                )
            finally:
                browser.close()
    finally:
        token = ""

    all_runs = (
        output["routeRuns"]
        + output["interactionRuns"]
        + output["crossDocumentRuns"]
        + output["touchRuns"]
    )
    failures = [run for run in all_runs if run.get("failures")]
    blocked_writes = [
        {"kind": run.get("kind"), "viewport": run.get("viewport"), **write}
        for run in all_runs
        for write in run.get("blockedWrites", [])
    ]
    output["blockedWrites"] = blocked_writes
    output["summary"] = {
        "runs": len(all_runs),
        "passed": len(all_runs) - len(failures),
        "failed": len(failures),
        "routeRuns": len(output["routeRuns"]),
        "interactionRuns": len(output["interactionRuns"]),
        "crossDocumentRuns": len(output["crossDocumentRuns"]),
        "touchRuns": len(output["touchRuns"]),
        "blockedWrites": len(blocked_writes),
    }
    result_path = OUT / "results.json"
    result_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(output["summary"], ensure_ascii=False, indent=2), flush=True)
    print(f"RESULT_PATH={result_path}", flush=True)
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
