#!/usr/bin/env python3
"""R69 后台 AI 入口视口几何与焦点链路的只读浏览器 QA。"""

from __future__ import annotations

import importlib.util
import json
import os
import urllib.parse
from pathlib import Path

from playwright.sync_api import Route, TimeoutError as PlaywrightTimeoutError, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
TARGET = os.environ.get("R69_QA_TARGET", "shadow").strip().lower()
if TARGET not in {"shadow", "production"}:
    raise ValueError(f"R69_QA_TARGET 仅支持 shadow/production，当前为 {TARGET!r}")

BASE = os.environ.get("R69_QA_BASE", "https://firstcare.cloud").rstrip("/")
OUT = Path(os.environ.get(
    "R69_QA_OUT",
    ROOT / f"docs/qa/frontend-skill-cloud-20260813/r69-admin-ai-{TARGET}",
))
SHOTS = OUT / "screenshots"
ROUTES = ["/admin", "/system"]
VIEWPORTS = [
    ("mobile640", {"width": 640, "height": 844}),
    ("boundary641", {"width": 641, "height": 844}),
    ("boundary1023", {"width": 1023, "height": 900}),
    ("desktop1280", {"width": 1280, "height": 720}),
    ("desktop1440", {"width": 1440, "height": 1000}),
]
VIEWPORT_FILTER = {
    value.strip()
    for value in os.environ.get("R69_QA_VIEWPORTS", "").split(",")
    if value.strip()
}
if VIEWPORT_FILTER:
    VIEWPORTS = [item for item in VIEWPORTS if item[0] in VIEWPORT_FILTER]

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
R64_RELEASE = "r64-ai-header-all-viewports-20260813-v1"


spec = importlib.util.spec_from_file_location(
    "qa", ROOT / "tests/full_remediation_shadow_qa.py"
)
qa = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(qa)


def candidate_css() -> Path | None:
    """shadow 必须显式指定候选 CSS；production 始终不读取、不注入。"""
    if TARGET == "production":
        return None
    supplied = os.environ.get("R69_QA_CSS", "").strip()
    if not supplied:
        raise RuntimeError("shadow 模式需通过 R69_QA_CSS 指定 R69 候选 CSS")
    path = Path(supplied).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"R69 候选 CSS 不存在：{path}")
    if path.suffix.lower() != ".css":
        raise ValueError(f"R69_QA_CSS 必须是 CSS 文件：{path}")
    return path


def request_record(method: str, url: str) -> dict:
    parsed = urllib.parse.urlsplit(url)
    return {
        "method": method.upper(),
        "scheme": parsed.scheme,
        "host": parsed.netloc,
        "path": parsed.path,
    }


class ReadOnlyGuard:
    """仅放行安全读方法，后台与系统路由不应触发任何认证或业务写入。"""

    def __init__(self) -> None:
        self.blocked_writes: list[dict] = []

    def handle(self, route: Route) -> None:
        record = request_record(route.request.method, route.request.url)
        if record["method"] in SAFE_METHODS:
            route.continue_()
            return
        self.blocked_writes.append(record)
        route.abort("blockedbyclient")


def auth_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',"
        "JSON.stringify({name:'R69显示验收',role:'admin'}));"
    )


def new_context(browser, token: str, viewport: dict, guard: ReadOnlyGuard):
    context = browser.new_context(viewport=viewport)
    context.add_init_script(script=auth_script(token))
    context.route("**/*", guard.handle)
    return context


def inject_shadow_css(page, css: Path | None) -> None:
    """production 绝不注入；shadow 只在当前页面追加候选 CSS。"""
    if TARGET == "shadow":
        assert css is not None
        page.add_style_tag(path=str(css))


def wait_for_shell(page) -> None:
    page.locator(".aph-r64-ai-launcher:not([hidden])").wait_for(
        state="attached", timeout=15_000
    )
    page.wait_for_function(
        "release => document.body.dataset.r64AiHeader === release",
        arg=R64_RELEASE,
        timeout=12_000,
    )
    page.wait_for_function(
        "() => location.pathname === '/admin' && Boolean(document.querySelector('header.aph-admin-shell-header'))",
        timeout=15_000,
    )
    page.wait_for_timeout(450)


GEOMETRY_PROBE = r"""
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
      && Number(style.opacity || 1) > 0 && box.width > 0 && box.height > 0;
  };
  const intersection = box => {
    if (!box) return null;
    const width = Math.max(0, Math.min(innerWidth, box.right) - Math.max(0, box.x));
    const height = Math.max(0, Math.min(innerHeight, box.bottom) - Math.max(0, box.y));
    return {
      width: Number(width.toFixed(2)), height: Number(height.toFixed(2)),
      area: Number((width * height).toFixed(2)),
      full: width >= box.width - 1 && height >= box.height - 1,
    };
  };
  const proxy = document.querySelector('.aph-r64-ai-launcher:not([hidden])');
  const header = proxy?.closest('header') || document.querySelector('header.aph-admin-shell-header');
  const source = document.querySelector('#north-ai-assistant > .north-ai-launcher');
  const r57 = document.querySelector('.aph-r57-mobile-ai-launcher');
  const nav = document.querySelector('.aph-mobile-primary-nav');
  const identity = header?.querySelector('.aph-r64-admin-mobile-identity');
  const account = header?.querySelector('.aph-r64-admin-account');
  const headerBox = rect(header);
  const proxyBox = rect(proxy);
  const navBox = rect(nav);
  return {
    path: location.pathname,
    scrollY: Number(scrollY.toFixed(2)),
    viewport: {width: innerWidth, height: innerHeight},
    documentWidth: document.documentElement.scrollWidth,
    horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    bodyPaddingTop: Number.parseFloat(getComputedStyle(document.body).paddingTop) || 0,
    mobileShell: document.body.classList.contains('aph-r64-mobile-shell'),
    headerBox,
    headerIntersection: intersection(headerBox),
    headerPosition: header ? getComputedStyle(header).position : null,
    headerZIndex: header ? getComputedStyle(header).zIndex : null,
    proxyBox,
    proxyIntersection: intersection(proxyBox),
    proxyPosition: proxy ? getComputedStyle(proxy).position : null,
    proxyCssVisible: visible(proxy),
    proxy44: Boolean(proxyBox && proxyBox.width >= 44 && proxyBox.height >= 44),
    proxyInsideHeader: Boolean(proxyBox && headerBox
      && proxyBox.x >= headerBox.x - 1 && proxyBox.right <= headerBox.right + 1
      && proxyBox.y >= headerBox.y - 1 && proxyBox.bottom <= headerBox.bottom + 1),
    visibleAiEntries: [...document.querySelectorAll(
      '.north-ai-launcher,.aph-r57-mobile-ai-launcher,.aph-r64-ai-launcher'
    )].filter(visible).length,
    sourceDisplay: source ? getComputedStyle(source).display : null,
    sourceVisible: visible(source),
    r57Display: r57 ? getComputedStyle(r57).display : null,
    r57Visible: visible(r57),
    navBox,
    navPosition: nav ? getComputedStyle(nav).position : null,
    identityVisible: visible(identity),
    accountVisible: visible(account),
    accountBox: rect(account),
  };
}
"""


def geometry(page) -> dict:
    return page.evaluate(GEOMETRY_PROBE)


def near(value: float | int | None, expected: float, tolerance: float = 1.1) -> bool:
    return value is not None and abs(float(value) - expected) <= tolerance


def fixed_after_scroll(page, before: dict) -> dict:
    max_scroll = page.evaluate(
        "Math.max(0, document.documentElement.scrollHeight - innerHeight)"
    )
    target = min(max_scroll, 420)
    if target > 0:
        page.evaluate("value => scrollTo({top:value,behavior:'instant'})", target)
        page.wait_for_timeout(180)
    after = geometry(page)
    before_box = before.get("proxyBox")
    after_box = after.get("proxyBox")
    stable = bool(
        before_box and after_box
        and near(after_box["x"], before_box["x"])
        and near(after_box["y"], before_box["y"])
        and near(after_box["width"], before_box["width"])
        and near(after_box["height"], before_box["height"])
    )
    fixed_ancestor = after.get("proxyPosition") == "fixed" or after.get("headerPosition") in {
        "fixed", "sticky",
    }
    page.evaluate("scrollTo({top:0,behavior:'instant'})")
    page.wait_for_timeout(100)
    return {
        "maxScroll": max_scroll,
        "target": target,
        "state": after,
        "proxyGeometryStable": stable,
        "fixedAnchor": fixed_ancestor,
    }


def assistant_interaction(page) -> dict:
    proxy = page.locator(".aph-r64-ai-launcher:not([hidden])")
    proxy.click()
    overlay = page.locator("#north-ai-assistant > .north-ai-overlay")
    page.wait_for_function(
        "() => document.querySelector('#north-ai-assistant > .north-ai-overlay')?.getAttribute('aria-hidden') === 'false'",
        timeout=8_000,
    )
    input_box = page.locator("#north-ai-assistant .north-ai-input")
    input_box.wait_for(state="visible", timeout=8_000)
    page.wait_for_function(
        "() => document.activeElement?.classList.contains('north-ai-input')",
        timeout=5_000,
    )
    opened = page.evaluate(r"""() => {
      const overlay = document.querySelector('#north-ai-assistant > .north-ai-overlay');
      const box = overlay?.getBoundingClientRect();
      return {
        ariaHidden: overlay?.getAttribute('aria-hidden'),
        inputFocused: document.activeElement?.classList.contains('north-ai-input') || false,
        overlayBox: box ? {x:box.x,y:box.y,width:box.width,height:box.height,right:box.right,bottom:box.bottom} : null,
      };
    }""")
    page.locator("#north-ai-assistant .north-ai-close").click()
    page.wait_for_function(
        "() => document.querySelector('#north-ai-assistant > .north-ai-overlay')?.getAttribute('aria-hidden') === 'true'",
        timeout=5_000,
    )
    page.wait_for_function(
        "() => document.activeElement?.classList.contains('aph-r64-ai-launcher')",
        timeout=5_000,
    )
    return {
        "opened": opened,
        "closed": page.evaluate(r"""() => ({
          ariaHidden: document.querySelector('#north-ai-assistant > .north-ai-overlay')?.getAttribute('aria-hidden'),
          focusRestored: document.activeElement?.classList.contains('aph-r64-ai-launcher') || false,
        })"""),
    }


def inspect_route(browser, token: str, css: Path | None, viewport_name: str, viewport: dict, requested: str) -> dict:
    guard = ReadOnlyGuard()
    context = new_context(browser, token, viewport, guard)
    page = context.new_page()
    page_errors: list[str] = []
    console_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)[:800]))
    page.on(
        "console",
        lambda message: console_errors.append(message.text[:800]) if message.type == "error" else None,
    )
    result = {
        "viewportName": viewport_name,
        "viewport": viewport,
        "requestedRoute": requested,
        "failures": [],
    }
    try:
        response = page.goto(BASE + requested, wait_until="domcontentloaded", timeout=35_000)
        try:
            page.wait_for_load_state("networkidle", timeout=4_000)
        except PlaywrightTimeoutError:
            pass
        inject_shadow_css(page, css)
        wait_for_shell(page)
        top = geometry(page)
        shot = SHOTS / f"{viewport_name}-{requested.strip('/')}-top.png"
        page.screenshot(path=str(shot), full_page=False)
        scroll = fixed_after_scroll(page, top)
        interaction = assistant_interaction(page)

        mobile = viewport["width"] <= 640
        proxy_box = top.get("proxyBox")
        proxy_intersection = top.get("proxyIntersection") or {}
        header_intersection = top.get("headerIntersection") or {}
        after = scroll["state"]
        after_intersection = after.get("proxyIntersection") or {}
        checks = {
            "response200": response is not None and response.status == 200,
            "canonicalAdminPath": top["path"] == "/admin",
            "headerIntersectsViewport": header_intersection.get("area", 0) > 0,
            "proxyFullyInViewport": proxy_intersection.get("full") is True,
            "proxyFullyInViewportAfterScroll": after_intersection.get("full") is True,
            "proxy44": top["proxy44"],
            "fixedGeometry": scroll["proxyGeometryStable"] and scroll["fixedAnchor"],
            "singleVisibleAi": top["visibleAiEntries"] == 1,
            "sourceHidden": top["sourceDisplay"] == "none" and not top["sourceVisible"],
            "r57Hidden": not top["r57Visible"] and top["r57Display"] in {None, "none"},
            "noHorizontalOverflow": top["horizontalOverflow"] <= 1
                and after["horizontalOverflow"] <= 1,
            "assistantOpened": interaction["opened"]["ariaHidden"] == "false",
            "assistantInputFocused": interaction["opened"]["inputFocused"],
            "assistantClosed": interaction["closed"]["ariaHidden"] == "true",
            "focusRestored": interaction["closed"]["focusRestored"],
            "noBlockedWrites": not guard.blocked_writes,
        }
        if mobile:
            account_box = top.get("accountBox")
            nav_box = top.get("navBox")
            checks.update({
                "mobileShellApplied": top["mobileShell"],
                "mobileBodyReserves50": near(top["bodyPaddingTop"], 50),
                "mobileHeaderFixed": top["headerPosition"] == "fixed"
                    and top["headerBox"] is not None
                    and near(top["headerBox"]["x"], 0)
                    and near(top["headerBox"]["y"], 0)
                    and near(top["headerBox"]["right"], viewport["width"])
                    and near(top["headerBox"]["height"], 50),
                "mobileProxyInsideHeader": top["proxyInsideHeader"],
                "mobileIdentityVisible": top["identityVisible"],
                "mobileAccount44": top["accountVisible"] and account_box is not None
                    and account_box["width"] >= 44 and account_box["height"] >= 44,
                "mobileNavFixed50To102": top["navPosition"] == "fixed"
                    and nav_box is not None and near(nav_box["y"], 50)
                    and near(nav_box["bottom"], 102),
            })
        else:
            right_gap = viewport["width"] - proxy_box["right"] if proxy_box else None
            checks["desktopViewportAnchor"] = bool(
                proxy_box is not None
                and near(proxy_box["y"], 3)
                and near(right_gap, 16)
            )

        result.update({
            "status": response.status if response else None,
            "finalPath": top["path"],
            "top": top,
            "scroll": scroll,
            "interaction": interaction,
            "checks": checks,
            "failures": [name for name, passed in checks.items() if not passed],
            "blockedWrites": guard.blocked_writes,
            "pageErrors": page_errors,
            "consoleErrors": console_errors,
            "screenshot": str(shot),
        })
    except Exception as error:
        result["failures"].append(f"{type(error).__name__}: {error}")
        result["blockedWrites"] = guard.blocked_writes
        result["pageErrors"] = page_errors
        result["consoleErrors"] = console_errors
    finally:
        context.close()
    return result


def main() -> None:
    css = candidate_css()
    OUT.mkdir(parents=True, exist_ok=True)
    SHOTS.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("R69_QA_TOKEN", "").strip() or qa.ephemeral_token()
    output = {
        "target": TARGET,
        "base": BASE,
        "candidateCss": str(css) if css else None,
        "method": {
            "readOnly": True,
            "shadowCssPageInjection": TARGET == "shadow",
            "productionInjection": False,
            "safeMethods": sorted(SAFE_METHODS),
            "viewports": VIEWPORTS,
            "routes": ROUTES,
        },
        "runs": [],
    }
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for viewport_name, viewport in VIEWPORTS:
                    for requested in ROUTES:
                        run = inspect_route(
                            browser, token, css, viewport_name, viewport, requested
                        )
                        output["runs"].append(run)
                        print(json.dumps({
                            "viewport": viewport_name,
                            "route": requested,
                            "failures": run["failures"],
                        }, ensure_ascii=False), flush=True)
            finally:
                browser.close()
    finally:
        token = ""

    failed = [run for run in output["runs"] if run["failures"]]
    output["summary"] = {
        "runs": len(output["runs"]),
        "passes": len(output["runs"]) - len(failed),
        "failures": len(failed),
        "blockedWriteCount": sum(
            len(run.get("blockedWrites", [])) for run in output["runs"]
        ),
    }
    result_path = OUT / "r69-admin-ai-results.json"
    result_path.write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(output["summary"], ensure_ascii=False, indent=2))
    print(f"RESULT_PATH={result_path}")
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
