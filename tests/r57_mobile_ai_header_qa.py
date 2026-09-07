#!/usr/bin/env python3
"""R57 移动端 AI 顶栏入口候选/生产浏览器验收（只读）。"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path

from playwright.sync_api import Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
TARGET = os.environ.get("QA_TARGET", "candidate").strip().lower()
if TARGET not in {"candidate", "production"}:
    raise ValueError(f"QA_TARGET 仅支持 candidate/production，当前为 {TARGET!r}")
CANDIDATE = Path(os.environ.get(
    "QA_STATIC_ROOT",
    ROOT / "release-candidates/cockpit-r57-mobile-ai-header-20260812-233824/payload",
))
OUT = Path(os.environ.get(
    "QA_OUT_DIR",
    ROOT / f"docs/qa/frontend-skill-cloud-20260812/r57-mobile-ai-header-{TARGET}",
))
OUT.mkdir(parents=True, exist_ok=True)
ROUTES = ["/", "/projects", "/admin", "/payment", "/daily", "/collection"]
EXPECTED_WIDTHS = [320, 390, 640]
WIDTHS = [
    int(value.strip())
    for value in os.environ.get("QA_WIDTHS", ",".join(map(str, EXPECTED_WIDTHS))).split(",")
    if value.strip()
]
if not WIDTHS or len(WIDTHS) != len(set(WIDTHS)) or not set(WIDTHS) <= set(EXPECTED_WIDTHS):
    raise ValueError(f"QA_WIDTHS 仅支持 320/390/640 且不得重复，当前为 {WIDTHS!r}")

os.environ["QA_TARGET"] = TARGET
if TARGET == "candidate":
    os.environ["QA_STATIC_ROOT"] = str(CANDIDATE)
os.environ.setdefault("QA_LOCAL_PORT", "4207")
os.environ.setdefault("QA_TUNNEL_PORT", "13133")

spec = importlib.util.spec_from_file_location("r57_a11y", ROOT / "tests/r48_full_accessibility_qa.py")
a11y = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a11y)
qa = a11y.qa


class BrowserReadOnlyGuard:
    """浏览器网络只读总闸：候选和生产模式都阻断业务写请求。"""

    def __init__(self) -> None:
        self.blocked_writes: list[dict] = []

    def handle(self, route: Route) -> None:
        request = route.request
        method = request.method.upper()
        if method in {"GET", "HEAD", "OPTIONS"}:
            route.continue_()
            return
        self.blocked_writes.append({"method": method, "url": request.url})
        route.abort("blockedbyclient")


def ephemeral_token() -> str:
    """仅在内存中使用 QA JWT；允许协作进程传入，否则走官方云端签发脚本。"""
    supplied = os.environ.get("QA_COCKPIT_TOKEN", "").strip()
    if supplied:
        return supplied
    result = subprocess.run(
        [
            "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=12",
            "-o", "ConnectionAttempts=1", "-o", "StrictHostKeyChecking=yes",
            qa.HOST, qa.REMOTE_TOKEN_SCRIPT,
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=20,
    )
    match = re.search(r"__QA_TOKEN__(\S+)", result.stdout)
    if not match:
        raise RuntimeError("未能在内存中取得临时 QA 令牌")
    return match.group(1)


def start_shadow():
    tunnel = subprocess.Popen([
        "ssh", "-N", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "-L", f"{qa.TUNNEL_PORT}:127.0.0.1:{qa.REMOTE_SHADOW_PORT}", qa.HOST,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    qa.wait_port(qa.TUNNEL_PORT)
    server = qa.ThreadingHTTPServer(("127.0.0.1", qa.LOCAL_PORT), a11y.ProductionShellHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return qa.BASE, tunnel, server, thread


def auth_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'R57移动端验收',role:'admin'}));"
    )


def browser_context(browser, token: str, viewport: dict, guard: BrowserReadOnlyGuard):
    context = browser.new_context(viewport=viewport)
    context.add_init_script(script=auth_script(token))
    context.route("**/*", guard.handle)
    return context


def box_relation(page) -> dict:
    return page.evaluate("""() => {
      const proxy = document.querySelector('.aph-r57-mobile-ai-launcher');
      const source = document.querySelector('#north-ai-assistant > .north-ai-launcher');
      const account = document.querySelector('header button[aria-label="账号菜单"]');
      const actions = account?.parentElement?.parentElement;
      const header = account?.closest('header');
      const proxyHeader = proxy?.closest('header');
      const placement = proxy?.dataset.r57Placement || null;
      const mobileNav = document.querySelector('.aph-mobile-primary-nav');
      const main = document.querySelector('main#main-content, main');
      const rect = node => {
        if (!node) return null;
        const value = node.getBoundingClientRect();
        return {x:value.x,y:value.y,width:value.width,height:value.height,right:value.right,bottom:value.bottom};
      };
      const overlaps = (first, second) => first && second
        && first.x < second.right && first.right > second.x
        && first.y < second.bottom && first.bottom > second.y;
      const focusable = [...document.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
      )].filter(node => {
        const style = getComputedStyle(node);
        const value = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && value.width > 0 && value.height > 0;
      });
      const proxyIndex = focusable.indexOf(proxy);
      const accountIndex = focusable.indexOf(account);
      const proxyBox = rect(proxy);
      const accountBox = rect(account);
      const headerBox = rect(proxyHeader || header);
      const navBox = rect(mobileNav);
      const mainBox = rect(main);
      return {
        proxyBox, accountBox, headerBox, navBox, mainBox, placement,
        sourceHidden: source?.hidden === true || getComputedStyle(source).display === 'none',
        sourceTabIndex: source?.tabIndex,
        proxyParentIsActions: placement === 'admin'
          ? proxy?.parentElement === proxyHeader
          : proxy?.parentElement === actions,
        proxyImmediatelyBeforeAccount: placement === 'admin'
          ? true
          : proxy?.nextElementSibling === account?.parentElement,
        proxyAccountFocusAdjacent: placement === 'admin'
          ? proxyIndex >= 0
          : proxyIndex >= 0 && accountIndex === proxyIndex + 1,
        proxyIndex, accountIndex,
        proxyMainOverlap: overlaps(proxyBox, mainBox),
        proxyNavOverlap: overlaps(proxyBox, navBox),
        proxyAccountOverlap: overlaps(proxyBox, accountBox),
        horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      };
    }""")


def verify_mobile_route(page, base: str, width: int, route: str) -> dict:
    response = page.goto(base + route, wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_selector(".aph-r57-mobile-ai-launcher", state="visible", timeout=15_000)
    page.wait_for_timeout(500)
    result = box_relation(page)
    result["status"] = response.status if response else None
    result["assetLoaded"] = page.evaluate("""() => performance.getEntriesByType('resource')
      .some(item => item.name.includes('aph2-r57-mobile-ai-header-20260812-v1'))""")

    assert result["status"] == 200, (width, route, result)
    assert result["assetLoaded"], (width, route, result)
    assert result["proxyParentIsActions"] and result["proxyImmediatelyBeforeAccount"], (width, route, result)
    assert result["proxyAccountFocusAdjacent"], (width, route, result)
    assert result["sourceHidden"] and result["sourceTabIndex"] == -1, (width, route, result)
    assert result["proxyBox"]["width"] >= 44 and result["proxyBox"]["height"] >= 44, (width, route, result)
    if route == "/admin":
        assert result["placement"] == "admin" and result["accountBox"] is None, (width, route, result)
        assert result["proxyBox"]["right"] <= result["headerBox"]["right"], (width, route, result)
    else:
        assert result["placement"] == "account" and result["accountBox"], (width, route, result)
        assert result["proxyBox"]["right"] <= result["accountBox"]["x"], (width, route, result)
    assert result["proxyBox"]["y"] >= result["headerBox"]["y"], (width, route, result)
    assert result["proxyBox"]["bottom"] <= result["headerBox"]["bottom"], (width, route, result)
    assert not result["proxyMainOverlap"] and not result["proxyNavOverlap"] and not result["proxyAccountOverlap"], (width, route, result)
    assert result["horizontalOverflow"] <= 1, (width, route, result)
    return result


def verify_interaction(page, base: str) -> dict:
    page.goto(base + "/", wait_until="domcontentloaded", timeout=30_000)
    proxy = page.locator(".aph-r57-mobile-ai-launcher")
    proxy.wait_for(state="visible", timeout=15_000)
    proxy.focus()
    proxy.click()
    page.wait_for_selector('.north-ai-overlay[aria-hidden="false"] .north-ai-input', state="visible")
    page.wait_for_timeout(320)
    input_focused = page.evaluate("document.activeElement?.classList.contains('north-ai-input')")
    page.keyboard.press("Escape")
    page.wait_for_function("document.querySelector('.north-ai-overlay')?.getAttribute('aria-hidden') === 'true'")
    page.wait_for_timeout(80)
    escape_restored = page.evaluate("document.activeElement?.classList.contains('aph-r57-mobile-ai-launcher')")

    proxy.click()
    page.wait_for_selector('.north-ai-overlay[aria-hidden="false"] .north-ai-close', state="visible")
    page.locator(".north-ai-close").click()
    page.wait_for_function("document.querySelector('.north-ai-overlay')?.getAttribute('aria-hidden') === 'true'")
    page.wait_for_timeout(80)
    close_restored = page.evaluate("document.activeElement?.classList.contains('aph-r57-mobile-ai-launcher')")
    assert input_focused and escape_restored and close_restored
    return {
        "inputFocused": input_focused,
        "escapeRestoredProxy": escape_restored,
        "closeRestoredProxy": close_restored,
    }


def verify_desktop(page, base: str) -> dict:
    page.goto(base + "/", wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_selector("#north-ai-assistant > .north-ai-launcher", state="visible", timeout=15_000)
    page.wait_for_timeout(400)
    result = page.evaluate("""() => {
      const source = document.querySelector('#north-ai-assistant > .north-ai-launcher');
      const style = getComputedStyle(source);
      const rect = source.getBoundingClientRect();
      return {
        proxyCount: document.querySelectorAll('.aph-r57-mobile-ai-launcher').length,
        sourceVisible: !source.hidden && style.display !== 'none' && rect.width > 0 && rect.height > 0,
        sourceTabIndex: source.tabIndex,
        sourceAriaHidden: source.getAttribute('aria-hidden'),
        sourceBox: {x:rect.x,y:rect.y,width:rect.width,height:rect.height},
      };
    }""")
    assert result["proxyCount"] == 0 and result["sourceVisible"], result
    assert result["sourceTabIndex"] == 0 and result["sourceAriaHidden"] is None, result
    return result


def main() -> None:
    if TARGET == "candidate":
        assert CANDIDATE.is_dir(), f"候选目录不存在：{CANDIDATE}"
    print("[R57] 正在取得内存 QA 令牌", flush=True)
    token = ephemeral_token()
    base = tunnel = server = thread = None
    guard = BrowserReadOnlyGuard()
    results = {
        "target": TARGET,
        "source": str(CANDIDATE) if TARGET == "candidate" else "production-direct",
        "mobile": {},
        "interaction": {},
        "desktop": {},
        "blockedWrites": [],
    }
    try:
        if TARGET == "candidate":
            print("[R57] 正在启动独立候选影子站", flush=True)
            base, tunnel, server, thread = start_shadow()
            print(f"[R57] 影子站已就绪 {base}", flush=True)
        else:
            base = os.environ.get("QA_BASE_URL", "https://firstcare.cloud").rstrip("/")
            print(f"[R57] 生产直连只读验收 {base}", flush=True)
        results["base"] = base
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width in WIDTHS:
                results["mobile"][str(width)] = {}
                for route in ROUTES:
                    started = time.monotonic()
                    print(f"[R57] 验收 width={width} route={route}", flush=True)
                    context = browser_context(
                        browser,
                        token,
                        {"width": width, "height": 844},
                        guard,
                    )
                    page = context.new_page()
                    results["mobile"][str(width)][route] = verify_mobile_route(page, base, width, route)
                    if width == 390 and route in {"/", "/projects", "/admin"}:
                        label = "home" if route == "/" else route.strip("/")
                        page.screenshot(path=str(OUT / f"r57-{width}-{label}.png"), full_page=False)
                    context.close()
                    print(f"[R57] 通过 width={width} route={route} elapsed={time.monotonic() - started:.1f}s", flush=True)
                if width == 390:
                    context = browser_context(
                        browser,
                        token,
                        {"width": width, "height": 844},
                        guard,
                    )
                    page = context.new_page()
                    print("[R57] 验收打开/焦点/关闭链路", flush=True)
                    results["interaction"] = verify_interaction(page, base)
                    context.close()

            desktop_context = browser_context(
                browser,
                token,
                {"width": 1440, "height": 1000},
                guard,
            )
            print("[R57] 验收 1440px 桌面恢复", flush=True)
            results["desktop"] = verify_desktop(desktop_context.new_page(), base)
            desktop_context.close()
            browser.close()

        results["blockedWrites"] = guard.blocked_writes
        assert not guard.blocked_writes, {
            "message": "R57 只读验收期间发现业务写尝试，已由浏览器总闸阻断",
            "blockedWrites": guard.blocked_writes,
        }
        result_file = OUT / "r57-mobile-ai-header-results.json"
        result_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({
            "mobileAssertions": len(WIDTHS) * len(ROUTES),
            "interaction": results["interaction"],
            "desktop": results["desktop"],
            "blockedWrites": len(results["blockedWrites"]),
            "resultFile": str(result_file),
        }, ensure_ascii=False))
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
            except subprocess.TimeoutExpired:
                tunnel.kill()


if __name__ == "__main__":
    main()
