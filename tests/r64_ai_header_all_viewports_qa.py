#!/usr/bin/env python3
"""R64 AI 顶栏、移动壳层与抽屉修复的候选/生产只读浏览器验收。"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import urllib.parse
from pathlib import Path

from playwright.sync_api import Route, TimeoutError as PlaywrightTimeoutError, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
TARGET = os.environ.get("R64_QA_TARGET", "shadow").strip().lower()
if TARGET not in {"shadow", "production"}:
    raise ValueError(f"R64_QA_TARGET 仅支持 shadow/production，当前为 {TARGET!r}")

BASE = os.environ.get("R64_QA_BASE", "https://firstcare.cloud").rstrip("/")
OUT = Path(os.environ.get(
    "R64_QA_OUT",
    ROOT / f"docs/qa/frontend-skill-cloud-20260813/r64-ai-header-{TARGET}",
))
SHOTS = OUT / "screenshots"
JS = ROOT / "firstcare-cloud-local/aph2-r64-ai-header-all-viewports-20260813-v1.js"
CSS = ROOT / "firstcare-cloud-local/aph2-r64-ai-header-all-viewports-20260813-v1.css"
RELEASE = "r64-ai-header-all-viewports-20260813-v1"

ROUTES = [
    "/", "/command", "/projects", "/payment", "/daily", "/collection",
    "/arrears", "/ai-alerts", "/ai-report", "/import", "/review", "/system",
    "/tasks", "/admin",
]
EXPECTED_PATHS = {"/system": "/admin", "/tasks": "/command"}
BOUNDARY_ROUTES = ["/", "/payment", "/review", "/admin"]
MOBILE_VIEWPORTS = [
    ("mobile320", {"width": 320, "height": 844}),
    ("mobile390", {"width": 390, "height": 844}),
    ("mobile640", {"width": 640, "height": 844}),
]
BOUNDARY_VIEWPORTS = [
    ("boundary641", {"width": 641, "height": 844}),
    ("boundary1023", {"width": 1023, "height": 900}),
]
DESKTOP_VIEWPORTS = [
    ("desktop1280", {"width": 1280, "height": 720}),
    ("desktop1440", {"width": 1440, "height": 1000}),
]
MATRIX = [
    *[(name, viewport, "mobile", ROUTES) for name, viewport in MOBILE_VIEWPORTS],
    *[(name, viewport, "boundary", BOUNDARY_ROUTES) for name, viewport in BOUNDARY_VIEWPORTS],
    *[(name, viewport, "desktop", ROUTES) for name, viewport in DESKTOP_VIEWPORTS],
]
VIEWPORT_FILTER = {
    value.strip()
    for value in os.environ.get("R64_QA_VIEWPORTS", "").split(",")
    if value.strip()
}
ROUTE_FILTER = {
    value.strip() or "/"
    for value in os.environ.get("R64_QA_ROUTES", "").split(",")
    if value.strip()
}
if VIEWPORT_FILTER or ROUTE_FILTER:
    MATRIX = [
        (
            name,
            viewport,
            kind,
            [route for route in routes if not ROUTE_FILTER or route in ROUTE_FILTER],
        )
        for name, viewport, kind, routes in MATRIX
        if (not VIEWPORT_FILTER or name in VIEWPORT_FILTER)
    ]
    MATRIX = [item for item in MATRIX if item[3]]
RUN_INTERACTIONS = os.environ.get("R64_QA_INTERACTIONS", "1").strip() != "0"

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
# 审核系统的两段式认证握手是会话交换，不是业务数据写入；只允许这两个精确端点。
SSO_AUTH_HANDSHAKES = {
    ("POST", "/api/integrations/review/sso"),
    ("POST", "/review-api/auth/cockpit-sso"),
}


spec = importlib.util.spec_from_file_location(
    "qa", ROOT / "tests/full_remediation_shadow_qa.py"
)
qa = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(qa)


def scrub_secret(value: object) -> str:
    """避免把一次性 SSO query 或 JWT 写入 QA 证据。"""
    text = str(value or "")
    text = re.sub(r"([?&]sso=)[^&#\s]+", r"\1[redacted]", text, flags=re.IGNORECASE)
    text = re.sub(
        r"\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b",
        "[jwt-redacted]",
        text,
    )
    return text[:1200]


def request_evidence(method: str, url: str) -> dict:
    parsed = urllib.parse.urlsplit(url)
    return {
        "method": method.upper(),
        "scheme": parsed.scheme,
        "host": parsed.netloc,
        "path": parsed.path,
    }


class ReadOnlyGuard:
    """阻断业务写请求；单独放行并记录两段式 SSO 认证握手。"""

    def __init__(self) -> None:
        self.blocked_writes: list[dict] = []
        self.allowed_handshakes: list[dict] = []

    def handle(self, route: Route) -> None:
        request = route.request
        record = request_evidence(request.method, request.url)
        key = (record["method"], record["path"])
        if record["method"] in SAFE_METHODS:
            route.continue_()
            return
        if key in SSO_AUTH_HANDSHAKES:
            self.allowed_handshakes.append(record)
            route.continue_()
            return
        self.blocked_writes.append(record)
        route.abort("blockedbyclient")


def auth_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',"
        "JSON.stringify({name:'R64显示验收',role:'admin'}));"
    )


def new_context(browser, token: str, viewport: dict, guard: ReadOnlyGuard):
    context = browser.new_context(viewport=viewport)
    context.add_init_script(script=auth_script(token))
    # JS 必须在页面脚本前执行；add_script_tag 会受 CSP 约束且时序过晚。
    if TARGET == "shadow":
        context.add_init_script(path=str(JS))
    context.route("**/*", guard.handle)
    return context


def inject_shadow_css(page) -> None:
    """生产模式绝不注入；影子模式仅在当前页面追加候选 CSS。"""
    if TARGET == "shadow":
        page.add_style_tag(path=str(CSS))


def label(route: str) -> str:
    return "home" if route == "/" else route.strip("/").replace("/", "-")


PROBE = r"""
() => {
  const rect = node => {
    if (!node) return null;
    const value = node.getBoundingClientRect();
    return {
      x: Number(value.x.toFixed(2)), y: Number(value.y.toFixed(2)),
      width: Number(value.width.toFixed(2)), height: Number(value.height.toFixed(2)),
      right: Number(value.right.toFixed(2)), bottom: Number(value.bottom.toFixed(2)),
    };
  };
  const visible = node => {
    if (!(node instanceof Element)) return false;
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity || 1) !== 0 && box.width > 0 && box.height > 0;
  };
  const overlaps = (a, b) => Boolean(
    a && b && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y
  );
  const proxy = document.querySelector('.aph-r64-ai-launcher:not([hidden])');
  const source = document.querySelector('#north-ai-assistant > .north-ai-launcher');
  const r57 = document.querySelector('.aph-r57-mobile-ai-launcher');
  const header = proxy?.closest('header')
    || document.querySelector('header.sticky.top-0, header.aph-admin-shell-header');
  const nav = document.querySelector('.aph-mobile-primary-nav');
  const headerMenu = document.querySelector('.aph-header-menu');
  const account = header?.querySelector('.aph-r64-admin-account')
    || header?.querySelector('button[aria-label="账号菜单"]');
  const accountWrap = account?.parentElement;
  const main = document.querySelector('main#main-content, main');
  const firstContent = main
    ? [...main.querySelectorAll('*')]
        .filter(node => {
          if (!visible(node) || node.classList.contains('aph-visually-hidden')) return false;
          const box = node.getBoundingClientRect();
          if (box.width <= 2 || box.height <= 2) return false;
          const directText = [...node.childNodes].some(child =>
            child.nodeType === Node.TEXT_NODE && (child.textContent || '').trim()
          );
          return directText || node.matches('img,iframe,input,select,textarea,button,svg,canvas');
        })
        .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)[0] || null
    : null;
  const identity = header?.querySelector('.aph-r64-admin-mobile-identity');
  const adminTitle = header?.querySelector('.aph-r64-admin-mobile-title');
  const adminAccount = header?.querySelector('.aph-r64-admin-account');
  const proxyBox = rect(proxy);
  const sourceBox = rect(source);
  const r57Box = rect(r57);
  const accountBox = rect(account);
  const headerBox = rect(header);
  const navBox = rect(nav);
  const mainBox = rect(main);
  const firstContentBox = rect(firstContent);
  const beforeAccount = !accountWrap || !proxy ? true
    : Boolean(proxy.compareDocumentPosition(accountWrap) & Node.DOCUMENT_POSITION_FOLLOWING);
  return {
    release: document.body.dataset.r64AiHeader || null,
    mobileShell: document.body.classList.contains('aph-r64-mobile-shell'),
    bodyPaddingTop: Number.parseFloat(getComputedStyle(document.body).paddingTop) || 0,
    placement: proxy?.dataset.r64Placement || null,
    proxyVisible: visible(proxy),
    navVisible: visible(nav),
    proxyBox, sourceBox, r57Box, accountBox, headerBox, navBox, mainBox, firstContentBox,
    sourceDisplay: source ? getComputedStyle(source).display : null,
    sourceVisible: visible(source),
    sourcePosition: source ? getComputedStyle(source).position : null,
    r57Display: r57 ? getComputedStyle(r57).display : null,
    r57Visible: visible(r57),
    headerPosition: header ? getComputedStyle(header).position : null,
    headerOverflow: header ? getComputedStyle(header).overflow : null,
    navPosition: nav ? getComputedStyle(nav).position : null,
    menuDisplay: headerMenu ? getComputedStyle(headerMenu).display : null,
    menuVisible: visible(headerMenu),
    identityVisible: visible(identity),
    adminTitleVisible: visible(adminTitle),
    adminAccountVisible: visible(adminAccount),
    visibleAiEntries: [...document.querySelectorAll(
      '.north-ai-launcher,.aph-r57-mobile-ai-launcher,.aph-r64-ai-launcher'
    )].filter(visible).length,
    beforeAccount,
    proxyMainOverlap: overlaps(proxyBox, mainBox),
    proxyContentOverlap: overlaps(proxyBox, firstContentBox),
    proxyAccountOverlap: overlaps(proxyBox, accountBox),
    proxyInsideHeader: Boolean(
      proxyBox && headerBox && proxyBox.y >= headerBox.y - 1 && proxyBox.bottom <= headerBox.bottom + 1
    ),
    proxyInsideViewport: Boolean(
      proxyBox && proxyBox.x >= -1 && proxyBox.y >= -1
        && proxyBox.right <= innerWidth + 1 && proxyBox.bottom <= innerHeight + 1
    ),
    horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
  };
}
"""


STABILITY_PROBE = r"""
async () => {
  const proxy = document.querySelector('.aph-r64-ai-launcher:not([hidden])');
  const header = proxy?.closest('header');
  if (!header) return {observed: false, relevantMoves: -1, records: []};
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const records = [];
  const includesEntry = node => node instanceof Element && (
    node.matches('.aph-r57-mobile-ai-launcher,.aph-r64-ai-launcher')
      || Boolean(node.querySelector('.aph-r57-mobile-ai-launcher,.aph-r64-ai-launcher'))
  );
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;
      const added = [...mutation.addedNodes].some(includesEntry);
      const removed = [...mutation.removedNodes].some(includesEntry);
      if (added || removed) records.push({added, removed});
    }
  });
  observer.observe(header, {childList: true, subtree: true});
  await new Promise(resolve => setTimeout(resolve, 700));
  observer.disconnect();
  return {observed: true, relevantMoves: records.length, records};
}
"""


SCROLL_PROBE = r"""
async () => {
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  const target = Math.min(maxScroll, Math.max(240, Math.round(innerHeight * .62)));
  const scrolling = document.scrollingElement;
  const previousBehavior = scrolling?.style.scrollBehavior || '';
  if (scrolling) {
    scrolling.style.scrollBehavior = 'auto';
    scrolling.scrollTop = target;
  } else {
    scrollTo({top: target, behavior: 'instant'});
  }
  await new Promise(resolve => setTimeout(resolve, 180));
  const box = node => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {y: Number(rect.y.toFixed(2)), height: Number(rect.height.toFixed(2)), bottom: Number(rect.bottom.toFixed(2))};
  };
  const result = {
    maxScroll,
    scrollY: Number(scrollY.toFixed(2)),
    header: box(document.querySelector('header.sticky.top-0, header.aph-admin-shell-header')),
    nav: box(document.querySelector('.aph-mobile-primary-nav')),
  };
  if (scrolling) scrolling.style.scrollBehavior = previousBehavior;
  return result;
}
"""


def near(value: float | int | None, expected: float, tolerance: float = 1.1) -> bool:
    return value is not None and abs(float(value) - expected) <= tolerance


def wait_for_shell(page) -> None:
    page.locator(".aph-r64-ai-launcher:not([hidden])").wait_for(state="visible", timeout=15_000)
    page.wait_for_function(
        "release => document.body.dataset.r64AiHeader === release",
        arg=RELEASE,
        timeout=12_000,
    )
    page.wait_for_timeout(300)


def wait_for_content_stability(page) -> None:
    """等待 React 路由内容与后置增强完成，避免把过渡帧当成显示缺陷。"""
    page.wait_for_function(
        r"""() => {
          const main = document.querySelector('main#main-content, main');
          if (!main || !(main.textContent || '').trim()) return false;
          const first = [...main.children].find(node => {
            const box = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return style.display !== 'none' && style.visibility !== 'hidden'
              && box.width > 2 && box.height > 2;
          });
          if (!first) return false;
          const box = first.getBoundingClientRect();
          const signature = JSON.stringify({
            path: location.pathname,
            children: main.children.length,
            textLength: (main.textContent || '').trim().length,
            scrollHeight: main.scrollHeight,
            firstY: Math.round(box.y),
            firstHeight: Math.round(box.height),
          });
          const now = performance.now();
          const previous = window.__r64ContentStable;
          if (!previous || previous.signature !== signature) {
            window.__r64ContentStable = {signature, since: now};
            return false;
          }
          return now - previous.since >= 700;
        }""",
        timeout=15_000,
    )


def reset_scroll_top(page) -> None:
    """立即回到页面顶部并等待完成，避免平滑滚动过渡帧污染顶部截图。"""
    previous = page.evaluate(r"""() => {
      const scrolling = document.scrollingElement;
      if (!scrolling) return null;
      const value = scrolling.style.scrollBehavior;
      scrolling.style.scrollBehavior = 'auto';
      window.scrollTo(0, 0);
      return value;
    }""")
    page.wait_for_function("() => Math.abs(window.scrollY) <= 1", timeout=3_000)
    page.evaluate(
        "value => { if (document.scrollingElement) document.scrollingElement.style.scrollBehavior = value || ''; }",
        previous,
    )
    page.wait_for_timeout(120)


def account_menu_evidence(page) -> dict:
    button = page.locator(".aph-r64-admin-account")
    button.wait_for(state="visible", timeout=5_000)
    button.click()
    menu = page.locator(".aph-r64-admin-account-menu:not([hidden])")
    menu.wait_for(state="visible", timeout=5_000)
    evidence = page.evaluate(r"""() => {
      const menu = document.querySelector('.aph-r64-admin-account-menu:not([hidden])');
      const header = menu?.closest('header');
      const box = menu?.getBoundingClientRect();
      return {
        visible: Boolean(menu && box && box.width > 0 && box.height > 0),
        box: box ? {x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom} : null,
        withinViewport: Boolean(box && box.x >= 0 && box.y >= 0
          && box.right <= innerWidth && box.bottom <= innerHeight),
        headerOverflow: header ? getComputedStyle(header).overflow : null,
        aboveNav: Number(getComputedStyle(header).zIndex) > Number(getComputedStyle(document.querySelector('.aph-mobile-primary-nav')).zIndex),
        expanded: document.querySelector('.aph-r64-admin-account')?.getAttribute('aria-expanded'),
      };
    }""")
    page.keyboard.press("Escape")
    page.wait_for_function(
        "document.querySelector('.aph-r64-admin-account-menu')?.hidden === true"
    )
    return evidence


def inspect_route(browser, token: str, name: str, viewport: dict, kind: str, requested: str) -> dict:
    guard = ReadOnlyGuard()
    context = new_context(browser, token, viewport, guard)
    page = context.new_page()
    page_errors: list[str] = []
    console_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(scrub_secret(error)))
    page.on(
        "console",
        lambda message: console_errors.append(scrub_secret(message.text)) if message.type == "error" else None,
    )
    result: dict = {
        "requestedRoute": requested,
        "viewportName": name,
        "viewport": viewport,
        "kind": kind,
        "failures": [],
    }
    try:
        response = page.goto(BASE + requested, wait_until="domcontentloaded", timeout=35_000)
        try:
            page.wait_for_load_state("networkidle", timeout=4_000)
        except PlaywrightTimeoutError:
            pass
        inject_shadow_css(page)
        wait_for_shell(page)
        wait_for_content_stability(page)

        state = page.evaluate(PROBE)
        stability = page.evaluate(STABILITY_PROBE)
        actual = urllib.parse.urlsplit(page.url).path.rstrip("/") or "/"
        expected = EXPECTED_PATHS.get(requested, requested).rstrip("/") or "/"
        is_mobile = kind == "mobile"
        is_admin = actual == "/admin"
        checks = {
            "response200": response is not None and response.status == 200,
            "routeMatched": actual == expected,
            "releaseApplied": state["release"] == RELEASE,
            "singleVisibleEntry": state["visibleAiEntries"] == 1,
            "proxyVisible": state["proxyVisible"],
            "proxy44": state["proxyBox"] is not None
                and state["proxyBox"]["width"] >= 44 and state["proxyBox"]["height"] >= 44,
            "sourceHidden": state["sourceDisplay"] == "none" and not state["sourceVisible"],
            "r57Hidden": not state["r57Visible"] and state["r57Display"] in {None, "none"},
            "insideHeader": state["proxyInsideHeader"],
            "insideViewport": state["proxyInsideViewport"],
            "beforeAccount": state["beforeAccount"],
            "notOverContent": not state["proxyContentOverlap"],
            "notOverAccount": not state["proxyAccountOverlap"],
            "noHorizontalOverflow": state["horizontalOverflow"] <= 1,
            "headerEntriesStable": stability["observed"] and stability["relevantMoves"] == 0,
            "noBlockedWrites": not guard.blocked_writes,
        }

        scroll_state = None
        menu_state = None
        if is_mobile:
            checks.update({
                "mobileShellApplied": state["mobileShell"],
                "bodyReservesHeader50": near(state["bodyPaddingTop"], 50),
                "headerFixed0To50": state["headerPosition"] == "fixed"
                    and state["headerBox"] is not None
                    and near(state["headerBox"]["y"], 0)
                    and near(state["headerBox"]["height"], 50),
                "navFixed50To102": state["navPosition"] == "fixed"
                    and state["navBox"] is not None
                    and near(state["navBox"]["y"], 50)
                    and near(state["navBox"]["bottom"], 102),
                "hamburgerHidden": not state["menuVisible"] and state["menuDisplay"] in {None, "none"},
                "contentStartsBelowShell": state["firstContentBox"] is not None
                    and state["firstContentBox"]["y"] >= 102,
            })
            scroll_state = page.evaluate(SCROLL_PROBE)
            checks.update({
                "scrollAppliedWhenScrollable": scroll_state["maxScroll"] <= 0 or scroll_state["scrollY"] > 0,
                "headerFixedAfterScroll": scroll_state["header"] is not None
                    and near(scroll_state["header"]["y"], 0)
                    and near(scroll_state["header"]["height"], 50),
                "navFixedAfterScroll": scroll_state["nav"] is not None
                    and near(scroll_state["nav"]["y"], 50)
                    and near(scroll_state["nav"]["bottom"], 102),
            })
            if requested in {"/", "/payment", "/collection", "/review", "/admin"}:
                page.screenshot(path=str(SHOTS / f"{name}-{label(requested)}-scrolled.png"), full_page=False)
            reset_scroll_top(page)

            if is_admin:
                menu_state = account_menu_evidence(page)
                checks.update({
                    "adminPlacement": state["placement"] == "admin",
                    "adminIdentityVisible": state["identityVisible"] and state["adminTitleVisible"],
                    "adminAccount44": state["adminAccountVisible"] and state["accountBox"] is not None
                        and state["accountBox"]["width"] >= 44 and state["accountBox"]["height"] >= 44,
                    "adminMenuVisibleUnclipped": menu_state["visible"]
                        and menu_state["box"] is not None
                        and menu_state["box"]["height"] >= 44
                        and menu_state["box"]["bottom"] > 50
                        and menu_state["withinViewport"]
                        and menu_state["headerOverflow"] == "visible"
                        and menu_state["aboveNav"]
                        and menu_state["expanded"] == "true",
                })
            else:
                checks["mainPlacement"] = state["placement"] in {"account", "actions"}
        else:
            checks.update({
                "mobileShellAbsent": not state["mobileShell"] and state["bodyPaddingTop"] < 1,
                "mobileNavHidden": not state["navVisible"],
            })
            if is_admin:
                checks["adminDesktopPlacement"] = state["placement"] == "admin"
            else:
                checks["desktopPlacement"] = state["placement"] in {"account", "actions"}

        result.update({
            "status": response.status if response else None,
            "finalPath": actual,
            "state": state,
            "stability": stability,
            "scrollState": scroll_state,
            "accountMenu": menu_state,
            "checks": checks,
            "failures": [key for key, passed in checks.items() if not passed],
            "blockedWrites": guard.blocked_writes,
            "allowedSsoAuthHandshakes": guard.allowed_handshakes,
        })
        if (
            kind == "boundary"
            or (kind == "desktop" and name == "desktop1440" and requested in {"/", "/collection", "/admin", "/arrears"})
            or (kind == "mobile" and requested in {"/", "/payment", "/review", "/admin"})
        ):
            page.screenshot(path=str(SHOTS / f"{name}-{label(requested)}-top.png"), full_page=False)
    except Exception as error:
        result["failures"].append(f"{type(error).__name__}: {scrub_secret(error)}")
        result["blockedWrites"] = guard.blocked_writes
        result["allowedSsoAuthHandshakes"] = guard.allowed_handshakes
    finally:
        result["pageErrors"] = page_errors
        result["consoleErrors"] = console_errors
        context.close()
    return result


def ai_interaction(browser, token: str, name: str, viewport: dict) -> dict:
    guard = ReadOnlyGuard()
    context = new_context(browser, token, viewport, guard)
    page = context.new_page()
    result: dict = {"viewportName": name, "viewport": viewport, "failures": []}
    try:
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=35_000)
        try:
            page.wait_for_load_state("networkidle", timeout=4_000)
        except PlaywrightTimeoutError:
            pass
        inject_shadow_css(page)
        wait_for_shell(page)
        proxy = page.locator(".aph-r64-ai-launcher:not([hidden])")
        proxy.focus()
        proxy.click()
        overlay = page.locator('.north-ai-overlay[aria-hidden="false"].is-open')
        overlay.wait_for(state="visible", timeout=12_000)
        page.wait_for_timeout(250)
        opened = page.evaluate(r"""() => ({
          inputFocused: document.activeElement?.classList.contains('north-ai-input'),
          overlayZ: Number(getComputedStyle(document.querySelector('.north-ai-overlay')).zIndex),
          headerZ: Number(getComputedStyle(document.querySelector('.aph-r64-ai-launcher').closest('header')).zIndex),
        })""")
        page.keyboard.press("Escape")
        page.wait_for_function(
            "document.querySelector('.north-ai-overlay')?.getAttribute('aria-hidden') === 'true'"
        )
        page.wait_for_timeout(120)
        escape_restored = page.evaluate(
            "document.activeElement?.classList.contains('aph-r64-ai-launcher')"
        )
        proxy.click()
        page.locator('.north-ai-overlay[aria-hidden="false"] .north-ai-close').click()
        page.wait_for_function(
            "document.querySelector('.north-ai-overlay')?.getAttribute('aria-hidden') === 'true'"
        )
        page.wait_for_timeout(120)
        close_restored = page.evaluate(
            "document.activeElement?.classList.contains('aph-r64-ai-launcher')"
        )
        checks = {
            "inputFocused": opened["inputFocused"],
            "overlayAboveHeader": opened["overlayZ"] > opened["headerZ"],
            "escapeRestored": escape_restored,
            "closeRestored": close_restored,
            "noBlockedWrites": not guard.blocked_writes,
        }
        result.update({
            "opened": opened,
            "escapeRestored": escape_restored,
            "closeRestored": close_restored,
            "checks": checks,
            "failures": [key for key, passed in checks.items() if not passed],
            "blockedWrites": guard.blocked_writes,
            "allowedSsoAuthHandshakes": guard.allowed_handshakes,
        })
    except Exception as error:
        result["failures"].append(f"{type(error).__name__}: {scrub_secret(error)}")
        result["blockedWrites"] = guard.blocked_writes
        result["allowedSsoAuthHandshakes"] = guard.allowed_handshakes
    finally:
        context.close()
    return result


def mobile_drawer_interaction(browser, token: str) -> dict:
    guard = ReadOnlyGuard()
    viewport = {"width": 390, "height": 844}
    context = new_context(browser, token, viewport, guard)
    page = context.new_page()
    result: dict = {"viewport": viewport, "failures": []}
    try:
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=35_000)
        try:
            page.wait_for_load_state("networkidle", timeout=4_000)
        except PlaywrightTimeoutError:
            pass
        inject_shadow_css(page)
        wait_for_shell(page)

        trigger = page.locator(".aph-mobile-more-trigger")
        trigger.click()
        page.locator(".aph-mobile-more-drawer:not([hidden])").wait_for(state="visible", timeout=5_000)
        page.evaluate(r"""() => {
          sessionStorage.removeItem('r64QaProjectClickClosure');
          const recordProjectClosure = event => {
            const target = event.target instanceof Element
              ? event.target.closest('.aph-mobile-primary-nav a[href="/projects"]')
              : null;
            if (!target) return;
            const drawer = document.querySelector('.aph-mobile-more-drawer');
            const trigger = document.querySelector('.aph-mobile-more-trigger');
            sessionStorage.setItem('r64QaProjectClickClosure', JSON.stringify({
              drawerHidden: drawer?.hidden === true,
              drawerClassGone: !document.body.classList.contains('aph-mobile-drawer-open'),
              triggerExpanded: trigger?.getAttribute('aria-expanded') ?? null,
              navPresent: Boolean(document.querySelector('.aph-mobile-primary-nav')),
              drawerPresent: Boolean(drawer),
              triggerPresent: Boolean(trigger),
            }));
            document.removeEventListener('click', recordProjectClosure, true);
          };
          // R64 的 document capture 已先注册；这里后注册，且仍早于链接 target 导航处理。
          document.addEventListener('click', recordProjectClosure, true);
        }""")
        page.locator('.aph-mobile-primary-nav a[href="/projects"]').click()
        page.wait_for_function("location.pathname === '/projects'", timeout=8_000)
        page.wait_for_function(
            "document.querySelector('.aph-mobile-more-drawer')?.hidden === true",
            timeout=5_000,
        )
        inject_shadow_css(page)
        wait_for_shell(page)
        after_project = page.evaluate(r"""() => ({
          path: location.pathname,
          drawerHidden: document.querySelector('.aph-mobile-more-drawer')?.hidden === true,
          drawerClassGone: !document.body.classList.contains('aph-mobile-drawer-open'),
          triggerExpanded: document.querySelector('.aph-mobile-more-trigger')?.getAttribute('aria-expanded') ?? null,
          navPresent: Boolean(document.querySelector('.aph-mobile-primary-nav')),
          drawerPresent: Boolean(document.querySelector('.aph-mobile-more-drawer')),
          triggerPresent: Boolean(document.querySelector('.aph-mobile-more-trigger')),
          proxyVisible: getComputedStyle(document.querySelector('.aph-r64-ai-launcher')).display !== 'none',
          synchronousClosure: (() => {
            try {
              return JSON.parse(sessionStorage.getItem('r64QaProjectClickClosure') || 'null');
            } catch (_) {
              return null;
            }
          })(),
        })""")

        trigger.click()
        page.locator(".aph-mobile-more-drawer:not([hidden])").wait_for(state="visible", timeout=5_000)
        proxy = page.locator(".aph-r64-ai-launcher:not([hidden])")
        proxy.click()
        page.locator('.north-ai-overlay[aria-hidden="false"].is-open').wait_for(
            state="visible", timeout=12_000
        )
        page.wait_for_timeout(250)
        after_ai = page.evaluate(r"""() => ({
          drawerHidden: document.querySelector('.aph-mobile-more-drawer')?.hidden === true,
          drawerClassGone: !document.body.classList.contains('aph-mobile-drawer-open'),
          inputFocused: document.activeElement?.classList.contains('north-ai-input'),
          overlayZ: Number(getComputedStyle(document.querySelector('.north-ai-overlay')).zIndex),
          visibleAiEntries: [...document.querySelectorAll(
            '.north-ai-launcher,.aph-r57-mobile-ai-launcher,.aph-r64-ai-launcher'
          )].filter(node => {
            const style = getComputedStyle(node); const box = node.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
          }).length,
        })""")
        page.keyboard.press("Escape")
        page.wait_for_function(
            "document.querySelector('.north-ai-overlay')?.getAttribute('aria-hidden') === 'true'"
        )
        page.wait_for_timeout(120)
        focus_restored = page.evaluate(
            "document.activeElement?.classList.contains('aph-r64-ai-launcher')"
        )
        checks = {
            "projectRouteReached": after_project["path"] == "/projects",
            "drawerClosedAtProjectClick": after_project["synchronousClosure"] is not None
                and after_project["synchronousClosure"]["drawerHidden"]
                and after_project["synchronousClosure"]["drawerClassGone"]
                and after_project["synchronousClosure"].get("triggerExpanded") == "false",
            "drawerRemainsClosedAfterProjectRoute": after_project["drawerHidden"]
                and after_project["drawerClassGone"]
                and after_project.get("triggerExpanded") == "false",
            "proxySurvivesProjectRoute": after_project["proxyVisible"],
            "drawerClosedBeforeAi": after_ai["drawerHidden"] and after_ai["drawerClassGone"],
            "aiInputFocused": after_ai["inputFocused"],
            "overlayAboveDrawer": after_ai["overlayZ"] > 79,
            "singleVisibleEntry": after_ai["visibleAiEntries"] == 1,
            "focusRestored": focus_restored,
            "noBlockedWrites": not guard.blocked_writes,
        }
        result.update({
            "afterProjectNavigation": after_project,
            "afterAiOpen": after_ai,
            "focusRestored": focus_restored,
            "checks": checks,
            "failures": [key for key, passed in checks.items() if not passed],
            "blockedWrites": guard.blocked_writes,
            "allowedSsoAuthHandshakes": guard.allowed_handshakes,
        })
    except Exception as error:
        result["failures"].append(f"{type(error).__name__}: {scrub_secret(error)}")
        result["blockedWrites"] = guard.blocked_writes
        result["allowedSsoAuthHandshakes"] = guard.allowed_handshakes
    finally:
        context.close()
    return result


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    SHOTS.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("R64_QA_TOKEN", "").strip() or qa.ephemeral_token()
    output: dict = {
        "target": TARGET,
        "base": BASE,
        "method": {
            "readOnly": True,
            "shadowJsInitScript": TARGET == "shadow",
            "shadowCssPageInjection": TARGET == "shadow",
            "productionInjection": False,
            "safeMethods": sorted(SAFE_METHODS),
            "allowedSsoAuthHandshakes": [
                {"method": method, "path": path}
                for method, path in sorted(SSO_AUTH_HANDSHAKES)
            ],
            "matrix": [
                {"name": name, "viewport": viewport, "kind": kind, "routes": routes}
                for name, viewport, kind, routes in MATRIX
            ],
        },
        "runs": [],
    }
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for name, viewport, kind, routes in MATRIX:
                    for requested in routes:
                        run = inspect_route(browser, token, name, viewport, kind, requested)
                        output["runs"].append(run)
                        print(json.dumps({
                            "viewport": name,
                            "route": requested,
                            "failures": run["failures"],
                        }, ensure_ascii=False), flush=True)
                if RUN_INTERACTIONS:
                    output["desktopAiInteraction"] = ai_interaction(
                        browser, token, "desktop1440", {"width": 1440, "height": 1000}
                    )
                    output["mobileAiInteraction"] = ai_interaction(
                        browser, token, "mobile390", {"width": 390, "height": 844}
                    )
                    output["mobileDrawerInteraction"] = mobile_drawer_interaction(browser, token)
                else:
                    skipped = {"skipped": True, "failures": [], "allowedSsoAuthHandshakes": []}
                    output["desktopAiInteraction"] = dict(skipped)
                    output["mobileAiInteraction"] = dict(skipped)
                    output["mobileDrawerInteraction"] = dict(skipped)
            finally:
                browser.close()
    finally:
        token = ""

    failed = [run for run in output["runs"] if run["failures"]]
    interactions = [
        output["desktopAiInteraction"],
        output["mobileAiInteraction"],
        output["mobileDrawerInteraction"],
    ]
    observed_handshakes = [
        item
        for record in [*output["runs"], *interactions]
        for item in record.get("allowedSsoAuthHandshakes", [])
    ]
    output["summary"] = {
        "routeRuns": len(output["runs"]),
        "routePasses": len(output["runs"]) - len(failed),
        "routeFailures": len(failed),
        "mobileRuns": sum(run["kind"] == "mobile" for run in output["runs"]),
        "boundaryRuns": sum(run["kind"] == "boundary" for run in output["runs"]),
        "desktopRuns": sum(run["kind"] == "desktop" for run in output["runs"]),
        "desktopAiInteractionPassed": not output["desktopAiInteraction"]["failures"],
        "mobileAiInteractionPassed": not output["mobileAiInteraction"]["failures"],
        "mobileDrawerInteractionPassed": not output["mobileDrawerInteraction"]["failures"],
        "interactionsRun": RUN_INTERACTIONS,
        "allowedSsoAuthHandshakeCount": len(observed_handshakes),
        "allowedSsoAuthHandshakePaths": sorted({item["path"] for item in observed_handshakes}),
    }
    result_path = OUT / "r64-ai-header-results.json"
    result_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(output["summary"], ensure_ascii=False, indent=2))
    print(f"RESULT_PATH={result_path}")
    if failed or any(record["failures"] for record in interactions):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
