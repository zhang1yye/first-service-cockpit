#!/usr/bin/env python3
"""生产移动端驾驶舱纯只读视觉取证；不使用 axe，不发送业务写请求。"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import time
import urllib.parse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import Route, TimeoutError as PlaywrightTimeoutError, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("QA_BASE_URL", "https://firstcare.cloud").rstrip("/")
OUT = Path(os.environ.get(
    "QA_OUT_DIR",
    ROOT / "docs/qa/frontend-skill-cloud-20260813/production-mobile-visual-audit-stable",
))
OUT.mkdir(parents=True, exist_ok=True)
ROUTES = [
    value.strip()
    for value in os.environ.get(
        "QA_ROUTES",
        "/,/command,/projects,/payment,/daily,/collection,/arrears,/ai-alerts,/ai-report,/import,/review,/system,/admin,/tasks",
    ).split(",")
    if value.strip()
]
WIDTHS = [
    int(value.strip())
    for value in os.environ.get("QA_WIDTHS", "320,390,640").split(",")
    if value.strip()
]
HEIGHT = 844

spec = importlib.util.spec_from_file_location("visual_qa", ROOT / "tests/full_remediation_shadow_qa.py")
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


class ReadOnlyGuard:
    def __init__(self) -> None:
        self.blocked: list[dict] = []

    def handle(self, route: Route) -> None:
        request = route.request
        method = request.method.upper()
        if method in {"GET", "HEAD", "OPTIONS"}:
            route.continue_()
            return
        self.blocked.append({
            "method": method,
            "url": request.url,
            "path": urllib.parse.urlsplit(request.url).path,
        })
        route.abort("blockedbyclient")


def token() -> str:
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
        timeout=25,
    )
    import re
    match = re.search(r"__QA_TOKEN__(\S+)", result.stdout)
    if not match:
        raise RuntimeError("未能取得内存 QA 令牌")
    return match.group(1)


def auth_script(jwt: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(jwt)});"
        f"localStorage.setItem('token',{json.dumps(jwt)});"
        "localStorage.setItem('cockpit_user',JSON.stringify({name:'生产移动视觉审计',role:'admin'}));"
    )


def inspect_dom(page) -> dict:
    return page.evaluate(r"""() => {
      const visible = node => {
        if (!(node instanceof Element)) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden'
          && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
      };
      const text = node => String(node?.textContent || '').replace(/\s+/g, ' ').trim();
      const box = node => {
        if (!node || !visible(node)) return null;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          selector: node.id ? `#${node.id}` : `${node.tagName.toLowerCase()}.${String(node.className || '').trim().replace(/\s+/g,'.').slice(0,100)}`,
          text: text(node).slice(0, 100),
          x: +rect.x.toFixed(1), y: +rect.y.toFixed(1),
          width: +rect.width.toFixed(1), height: +rect.height.toFixed(1),
          right: +rect.right.toFixed(1), bottom: +rect.bottom.toFixed(1),
          position: style.position, zIndex: style.zIndex,
          overflowX: style.overflowX, overflowY: style.overflowY,
        };
      };
      const first = selector => [...document.querySelectorAll(selector)].find(visible) || null;
      const main = first('main#main-content, main');
      const mainFirst = main ? [...main.children].find(visible) : null;
      const header = first('header.sticky.top-0, header.aph-admin-shell-header, #root > div > header');
      const nav = first('.aph-mobile-primary-nav, nav[aria-label="移动端主导航"]');
      const pageTabs = first('.aph-page-tabs');
      const ai = first('.aph-r57-mobile-ai-launcher, #north-ai-assistant > .north-ai-launcher');
      const account = first('header button[aria-label="账号菜单"]');
      const brand = first('.aph-top-brand, header img[alt="第一服务"]');
      const shellTitle = first('header [data-aph-shell-title="true"], header h1');
      const headerMenu = first('header .aph-header-menu');
      const key = {header,nav,pageTabs,ai,account,brand,shellTitle,headerMenu,main,mainFirst};
      const keyBoxes = Object.fromEntries(Object.entries(key).map(([name,node]) => [name,box(node)]));
      const overlaps = (a,b) => a && b
        && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
      const overlapPairs = [];
      const names = Object.keys(keyBoxes);
      for (let i=0;i<names.length;i+=1) for (let j=i+1;j<names.length;j+=1) {
        const a=keyBoxes[names[i]], b=keyBoxes[names[j]];
        if (!overlaps(a,b)) continue;
        const containment = (a.x <= b.x && a.y <= b.y && a.right >= b.right && a.bottom >= b.bottom)
          || (b.x <= a.x && b.y <= a.y && b.right >= a.right && b.bottom >= a.bottom);
        if (!containment) overlapPairs.push([names[i],names[j]]);
      }
      const important = [...document.querySelectorAll(
        'h1,h2,h3,h4,p,button,a,[data-aph-shell-title="true"],th,td,label,strong'
      )].filter(node => visible(node) && text(node).length >= 2);
      const truncated = important.filter(node =>
        node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1
      ).slice(0,80).map(node => ({...box(node), fullText:text(node).slice(0,220), scrollWidth:node.scrollWidth, clientWidth:node.clientWidth, scrollHeight:node.scrollHeight, clientHeight:node.clientHeight}));
      const clippedX = [...document.querySelectorAll('body *')].filter(node => {
        if (!visible(node)) return false;
        const rect=node.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      }).slice(0,80).map(box);
      const chrome = [...document.querySelectorAll('body *')].filter(node => {
        if (!visible(node)) return false;
        const position=getComputedStyle(node).position;
        return position === 'fixed' || position === 'sticky';
      }).slice(0,80).map(box);
      const headings = [...document.querySelectorAll('h1,h2,h3')].filter(visible).map(node => ({level:node.tagName,text:text(node).slice(0,150),box:box(node)}));
      const mainChildren = main ? [...main.children].filter(visible).slice(0,30).map(box) : [];
      const gaps = [];
      for (let i=1;i<mainChildren.length;i+=1) {
        const gap=mainChildren[i].y-mainChildren[i-1].bottom;
        if (gap > 80) gaps.push({after:mainChildren[i-1].text,before:mainChildren[i].text,gap:+gap.toFixed(1)});
      }
      return {
        path: location.pathname,
        url: location.href,
        title: document.title,
        bodyClass: document.body.className,
        document: {width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,viewportWidth:innerWidth,viewportHeight:innerHeight,horizontalOverflow:Math.max(0,document.documentElement.scrollWidth-innerWidth)},
        keyBoxes, overlapPairs, truncated, clippedX, chrome, headings, mainChildren, gaps,
        visibleDialogs: [...document.querySelectorAll('[role="dialog"]')].filter(visible).map(box),
        visibleEmptyStates: [...document.querySelectorAll('[class*="empty"],[data-empty]')].filter(visible).map(box).slice(0,30),
      };
    }""")


def capture_route(page, route: str, width: int) -> dict:
    label = "home" if route == "/" else route.strip("/").replace("/", "-")
    response = page.goto(BASE + route, wait_until="domcontentloaded", timeout=35_000)
    proxy_ready = True
    content_ready = True
    try:
        page.wait_for_selector(".aph-r64-ai-launcher, .aph-r57-mobile-ai-launcher", state="visible", timeout=5_000)
    except PlaywrightTimeoutError:
        proxy_ready = False
    try:
        page.wait_for_function(r"""requested => {
          const visible = node => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden'
              && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
          };
          const loading = [...document.querySelectorAll('body *')].some(node =>
            visible(node) && String(node.textContent || '').replace(/\s+/g, ' ').trim() === '正在加载工作台'
          );
          if (loading) return false;
          if (requested === '/admin') return document.body.innerText.includes('运行编辑保护');
          if (requested === '/arrears') {
            const frame = document.querySelector('#aph-arrears-frame');
            return Boolean(frame?.contentDocument?.body?.innerText?.trim().length > 80);
          }
          const main = document.querySelector('main#main-content, main');
          return Boolean(main && main.innerText.replace(/\s+/g, '').length > 80);
        }""", arg=route, timeout=20_000)
    except PlaywrightTimeoutError:
        content_ready = False
    page.wait_for_timeout(650)
    top = OUT / f"{width}-{label}-top.png"
    page.screenshot(path=str(top), full_page=False)
    dom = inspect_dom(page)
    dom["status"] = response.status if response else None
    dom["screenshotTop"] = str(top)
    dom["requestedRoute"] = route
    dom["proxyReady"] = proxy_ready
    dom["contentReady"] = content_ready

    scroll_height = page.evaluate("document.documentElement.scrollHeight")
    if scroll_height > HEIGHT * 1.6:
        page.evaluate("y => scrollTo(0, y)", min(scroll_height - HEIGHT, max(HEIGHT, scroll_height // 2)))
        page.wait_for_timeout(160)
        middle = OUT / f"{width}-{label}-middle.png"
        page.screenshot(path=str(middle), full_page=False)
        dom["screenshotMiddle"] = str(middle)
    if scroll_height > HEIGHT * 2.7:
        page.evaluate("scrollTo(0, document.documentElement.scrollHeight)")
        page.wait_for_timeout(160)
        bottom = OUT / f"{width}-{label}-bottom.png"
        page.screenshot(path=str(bottom), full_page=False)
        dom["screenshotBottom"] = str(bottom)
    return dom


def contact_sheet(width: int) -> str:
    files = []
    for route in ROUTES:
        label = "home" if route == "/" else route.strip("/").replace("/", "-")
        file = OUT / f"{width}-{label}-top.png"
        if file.is_file():
            files.append((route, file))
    columns = 2 if width == 640 else 3
    label_height = 30
    tile_width = width
    tile_height = HEIGHT + label_height
    rows = (len(files) + columns - 1) // columns
    sheet = Image.new("RGB", (tile_width * columns, tile_height * rows), "#d9dde3")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=16)
    for index, (route, file) in enumerate(files):
        x = index % columns * tile_width
        y = index // columns * tile_height
        image = Image.open(file).convert("RGB")
        sheet.paste(image, (x, y + label_height))
        draw.rectangle((x, y, x + tile_width, y + label_height), fill="#111820")
        draw.text((x + 8, y + 6), f"{width}px  {route}", fill="white", font=font)
    output = OUT / f"contact-{width}-top.png"
    sheet.save(output)
    return str(output)


def main() -> None:
    jwt = token()
    guard = ReadOnlyGuard()
    results = {"base": BASE, "routes": ROUTES, "viewports": {}, "blockedWrites": []}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width in WIDTHS:
            context = browser.new_context(viewport={"width": width, "height": HEIGHT})
            context.add_init_script(script=auth_script(jwt))
            context.route("**/*", guard.handle)
            results["viewports"][str(width)] = {}
            for route in ROUTES:
                started = time.monotonic()
                page = context.new_page()
                console_errors: list[str] = []
                page_errors: list[str] = []
                page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                try:
                    data = capture_route(page, route, width)
                    data["consoleErrors"] = console_errors
                    data["pageErrors"] = page_errors
                    results["viewports"][str(width)][route] = data
                    print(f"[VISUAL] {width}px {route} -> {data['path']} {time.monotonic()-started:.1f}s", flush=True)
                finally:
                    page.close()
            context.close()
        browser.close()
    results["blockedWrites"] = guard.blocked
    results["contactSheets"] = {str(width): contact_sheet(width) for width in WIDTHS}
    output = OUT / "production-mobile-visual-audit.json"
    output.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "screenshots": len(WIDTHS) * len(ROUTES),
        "blockedWrites": len(guard.blocked),
        "output": str(output),
        "contactSheets": results["contactSheets"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
