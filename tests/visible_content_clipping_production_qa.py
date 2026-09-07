#!/usr/bin/env python3
"""生产全站真实裁切验收。

只读执行：所有非 GET/HEAD/OPTIONS 请求都会在浏览器端阻断。
与仅比对 main/sidebar 外壳位置不同，本验收会检查：

1. 可见文本字形范围和交互控件是否越出 viewport/main；
2. 是否被 overflow:hidden/clip 祖先真实裁切；
3. main 或内层语义容器是否存在隐藏的水平溢出；
4. 横向表格/列表只在 overflow-x:auto|scroll 且能真实滚到末端时放行。
"""

from __future__ import annotations

import importlib.util
import json
import os
import urllib.parse
from pathlib import Path
from typing import Any

from playwright.sync_api import Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("CLIP_QA_BASE", "https://www.firstcare.cloud").rstrip("/")
OUT = Path(
    os.environ.get(
        "CLIP_QA_OUT",
        ROOT / "docs/qa/frontend-skill-cloud-20260813/visible-content-clipping-production",
    )
)
SHOTS = OUT / "screenshots"

DEFAULT_ROUTES = [
    "/",
    "/command",
    "/projects",
    "/payment",
    "/daily",
    "/collection",
    "/arrears",
    "/ai-alerts",
    "/ai-report",
    "/import",
    "/review",
    "/system",
    "/tasks",
    "/admin",
]
ROUTES = [
    route.strip()
    for route in os.environ.get("CLIP_QA_ROUTES", ",".join(DEFAULT_ROUTES)).split(",")
    if route.strip()
]
EXPECTED_PATHS = {"/system": "/admin", "/tasks": "/command"}

DEFAULT_VIEWPORTS = "641x900,768x900,1024x900,1218x900,1440x1000"
VIEWPORTS: list[tuple[str, dict[str, int]]] = []
for viewport_spec in os.environ.get("CLIP_QA_VIEWPORTS", DEFAULT_VIEWPORTS).split(","):
    width_text, height_text = viewport_spec.strip().lower().split("x", 1)
    width, height = int(width_text), int(height_text)
    VIEWPORTS.append((f"{width}x{height}", {"width": width, "height": height}))

spec = importlib.util.spec_from_file_location(
    "qa", ROOT / "tests/full_remediation_shadow_qa.py"
)
qa = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(qa)


class ReadOnlyGuard:
    """只读防线：任何写请求都不发往服务器。"""

    def __init__(self) -> None:
        self.blocked_writes: list[dict[str, str]] = []

    def handle(self, route: Route) -> None:
        method = route.request.method.upper()
        if method in {"GET", "HEAD", "OPTIONS"}:
            route.continue_()
            return
        self.blocked_writes.append({"method": method, "url": route.request.url})
        route.abort("blockedbyclient")


def auth_script(token: str) -> str:
    return (
        f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
        f"localStorage.setItem('token',{json.dumps(token)});"
        "localStorage.setItem('cockpit_user',"
        "JSON.stringify({name:'全站裁切QA',role:'admin'}));"
        "sessionStorage.removeItem('aph-nav-pinned-v2');"
    )


PROBE = r"""
() => {
  const EPSILON = 1.5;
  const OVERFLOW_EPSILON = 4;
  const MAX_ISSUES = 160;
  const hard = [];
  const accepted = [];
  const rootMain = document.querySelector('main#main-content, main');
  const mainRect = rootMain?.getBoundingClientRect() || null;

  const round = value => Number(Number(value || 0).toFixed(2));
  const box = rect => rect ? ({
    left: round(rect.left), right: round(rect.right), top: round(rect.top),
    bottom: round(rect.bottom), width: round(rect.width), height: round(rect.height),
  }) : null;

  const compactText = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 120);

  const cssEscape = value => {
    if (globalThis.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  };

  const selector = node => {
    if (!(node instanceof Element)) return null;
    if (node.id) return `#${cssEscape(node.id)}`;
    const parts = [];
    let current = node;
    while (current && current !== document.body && parts.length < 5) {
      let part = current.localName;
      const useful = [...current.classList]
        .filter(name => !name.startsWith('css-') && !name.match(/^\w{6,}$/))
        .slice(0, 2);
      if (useful.length) part += `.${useful.map(cssEscape).join('.')}`;
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(item => item.localName === current.localName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  };

  const hiddenBySemantics = node => Boolean(node.closest(
    '[hidden],[inert],[aria-hidden="true"],.aph-visually-hidden,.sr-only,.visually-hidden'
  ));

  const rendered = node => {
    if (!(node instanceof Element) || hiddenBySemantics(node)) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity || 1) > 0.01 && rect.width > 0.5 && rect.height > 0.5;
  };

  const horizontalScroller = node => {
    let current = node.parentElement;
    while (current && current !== document.documentElement) {
      const style = getComputedStyle(current);
      if ((style.overflowX === 'auto' || style.overflowX === 'scroll') &&
          current.scrollWidth > current.clientWidth + EPSILON) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  };

  const clipAncestor = (node, fragment) => {
    let current = node.parentElement;
    while (current && current !== document.documentElement) {
      const style = getComputedStyle(current);
      if (style.overflowX === 'hidden' || style.overflowX === 'clip') {
        const rect = current.getBoundingClientRect();
        const left = rect.left + current.clientLeft;
        const right = left + current.clientWidth;
        if (fragment.left < left - EPSILON || fragment.right > right + EPSILON) {
          return {node: current, rect: {left, right}, overflowX: style.overflowX};
        }
      }
      current = current.parentElement;
    }
    return null;
  };

  // getClientRects() 会返回已经完全被祖先裁掉的字形布局矩形。
  // 这些内容并非用户当前可见，不算“真实可见裁切”；只保留部分相交的情形。
  const visibleHorizontalSlice = (node, fragment) => {
    let left = Math.max(0, fragment.left);
    let right = Math.min(innerWidth, fragment.right);
    let current = node.parentElement;
    while (current && current !== document.documentElement) {
      const style = getComputedStyle(current);
      if (style.overflowX === 'hidden' || style.overflowX === 'clip') {
        const rect = current.getBoundingClientRect();
        const clipLeft = rect.left + current.clientLeft;
        const clipRight = clipLeft + current.clientWidth;
        left = Math.max(left, clipLeft);
        right = Math.min(right, clipRight);
      }
      current = current.parentElement;
    }
    return {left, right, width: Math.max(0, right - left)};
  };

  const push = (bucket, issue) => {
    if (bucket.length >= MAX_ISSUES) return;
    const key = `${issue.kind}|${issue.selector}|${issue.text}|${issue.ancestor || ''}`;
    if (bucket.some(item => item.key === key)) return;
    bucket.push({...issue, key});
  };

  const classifyFragment = (node, fragment, kind, text) => {
    if (!fragment || fragment.width <= 0.25 || fragment.height <= 0.25) return;
    if (visibleHorizontalSlice(node, fragment).width <= 0.25) return;
    const scroller = horizontalScroller(node);
    const outsideViewport = fragment.left < -EPSILON || fragment.right > innerWidth + EPSILON;
    const inMain = Boolean(rootMain && rootMain.contains(node));
    const outsideMain = Boolean(inMain && mainRect && (
      fragment.left < mainRect.left - EPSILON || fragment.right > mainRect.right + EPSILON
    ));
    const clipped = clipAncestor(node, fragment);
    if (!outsideViewport && !outsideMain && !clipped) return;

    const issue = {
      kind,
      selector: selector(node),
      text: compactText(text || node.getAttribute('aria-label') || node.textContent),
      rect: box(fragment),
      outsideViewport,
      outsideMain,
      ancestor: clipped ? selector(clipped.node) : null,
      ancestorRect: clipped ? {
        left: round(clipped.rect.left), right: round(clipped.rect.right),
        overflowX: clipped.overflowX,
      } : null,
    };
    if (scroller) {
      const old = scroller.scrollLeft;
      const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      scroller.scrollLeft = max;
      const reached = Math.abs(scroller.scrollLeft - max) <= 2;
      scroller.scrollLeft = old;
      push(accepted, {
        ...issue,
        kind: 'intentional-horizontal-scroll',
        scroller: selector(scroller),
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        reachesEnd: reached,
      });
      if (!reached) push(hard, {...issue, kind: `${kind}-unreachable-scroll`});
      return;
    }
    push(hard, issue);
  };

  const scanRoots = [
    document.querySelector('header'),
    document.querySelector('.aph-page-tabs'),
    document.querySelector('.aph-exact-sidebar-panel'),
    rootMain,
  ].filter(Boolean);
  const sidebarPanel = document.querySelector('.aph-exact-sidebar-panel');
  const candidates = new Set();
  for (const root of scanRoots) {
    candidates.add(root);
    for (const node of root.querySelectorAll('*')) candidates.add(node);
  }

  for (const node of candidates) {
    if (!rendered(node)) continue;
    if (node.closest('svg,canvas')) continue;
    const isControl = node.matches(
      'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[tabindex]:not([tabindex="-1"])'
    );
    const collapsedSidebarControl = Boolean(
      sidebarPanel && sidebarPanel.clientWidth <= 61 && sidebarPanel.contains(node)
    );
    if (isControl && !collapsedSidebarControl) {
      const rect = node.getBoundingClientRect();
      classifyFragment(node, rect, 'control-boundary',
        node.getAttribute('aria-label') || node.innerText || node.value || node.name);
    }

    for (const child of node.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE || !compactText(child.textContent)) continue;
      const range = document.createRange();
      range.selectNodeContents(child);
      for (const fragment of range.getClientRects()) {
        classifyFragment(node, fragment, 'text-boundary', child.textContent);
      }
      range.detach();
    }
  }

  // 补充容器级判断：overflow:hidden 可能裁掉伪元素或 flex/grid 末列，
  // 即使子节点本身因裁切后没有可用字形矩形，仍不应漏报。
  const semanticContainers = rootMain ? [...rootMain.querySelectorAll(
    'section,article,table,thead,tbody,tr,form,[role="table"],[role="grid"],.card,.panel'
  )] : [];
  for (const node of semanticContainers) {
    if (!rendered(node)) continue;
    const style = getComputedStyle(node);
    const hiddenOverflow = style.overflowX === 'hidden' || style.overflowX === 'clip';
    if (hiddenOverflow && node.scrollWidth > node.clientWidth + OVERFLOW_EPSILON) {
      push(hard, {
        kind: 'hidden-container-overflow',
        selector: selector(node),
        text: compactText(node.getAttribute('aria-label') || node.innerText),
        rect: box(node.getBoundingClientRect()),
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        overflowX: style.overflowX,
      });
    }
  }

  const allScrollers = [...document.querySelectorAll('*')].filter(node => {
    if (!rendered(node)) return false;
    const style = getComputedStyle(node);
    return (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
      node.scrollWidth > node.clientWidth + EPSILON;
  }).map(node => {
    const old = node.scrollLeft;
    const max = Math.max(0, node.scrollWidth - node.clientWidth);
    node.scrollLeft = max;
    const reached = Math.abs(node.scrollLeft - max) <= 2;
    node.scrollLeft = old;
    return {
      selector: selector(node), rect: box(node.getBoundingClientRect()),
      scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
      maxScrollLeft: max, reachesEnd: reached,
    };
  });

  const mainStyle = rootMain ? getComputedStyle(rootMain) : null;
  const mainHiddenOverflow = Boolean(rootMain && mainStyle &&
    (mainStyle.overflowX === 'hidden' || mainStyle.overflowX === 'clip') &&
    rootMain.scrollWidth > rootMain.clientWidth + OVERFLOW_EPSILON);
  if (mainHiddenOverflow) {
    push(hard, {
      kind: 'main-hidden-overflow', selector: selector(rootMain),
      text: '', rect: box(mainRect), scrollWidth: rootMain.scrollWidth,
      clientWidth: rootMain.clientWidth, overflowX: mainStyle.overflowX,
    });
  }

  const panel = document.querySelector('.aph-exact-sidebar-panel');
  const sidebar = document.querySelector('.aph-exact-sidebar');
  return {
    innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    main: rootMain ? {
      rect: box(mainRect), scrollWidth: rootMain.scrollWidth,
      clientWidth: rootMain.clientWidth, overflowX: mainStyle.overflowX,
    } : null,
    sidebar: sidebar ? box(sidebar.getBoundingClientRect()) : null,
    panel: panel ? box(panel.getBoundingClientRect()) : null,
    hard,
    accepted,
    horizontalScrollers: allScrollers,
    counts: {hard: hard.length, accepted: accepted.length, scrollers: allScrollers.length},
  };
}
"""


def label(route: str) -> str:
    return "home" if route == "/" else route.strip("/").replace("/", "-")


def audit_state(page, state: str) -> dict[str, Any]:
    probe = page.evaluate(PROBE)
    return {
        "state": state,
        "probe": probe,
        "failures": [
            f"{issue['kind']}:{issue.get('selector') or '?'}"
            for issue in probe["hard"]
        ],
    }


def move_outside_sidebar(page, viewport: dict[str, int]) -> None:
    page.mouse.move(viewport["width"] - 8, min(viewport["height"] - 8, 500))
    page.wait_for_timeout(420)


def inspect_route(
    browser,
    token: str,
    viewport_name: str,
    viewport: dict[str, int],
    route: str,
) -> dict[str, Any]:
    guard = ReadOnlyGuard()
    context = browser.new_context(viewport=viewport)
    context.add_init_script(script=auth_script(token))
    context.route("**/*", guard.handle)
    page = context.new_page()
    page_errors: list[str] = []
    console_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on(
        "console",
        lambda message: console_errors.append(message.text)
        if message.type == "error"
        else None,
    )
    result: dict[str, Any] = {
        "route": route,
        "viewport": viewport,
        "states": [],
        "failures": [],
    }
    try:
        response = page.goto(BASE + route, wait_until="domcontentloaded", timeout=30_000)
        try:
            page.wait_for_load_state("networkidle", timeout=30_000)
        except Exception:
            # 某个辅助请求长连接不应阻断几何取证；保留异常到页面日志。
            page_errors.append("networkidle-timeout")
        page.wait_for_timeout(700)

        actual_path = urllib.parse.urlsplit(page.url).path.rstrip("/") or "/"
        expected_path = EXPECTED_PATHS.get(route, route).rstrip("/") or "/"
        result.update(
            {
                "responseStatus": response.status if response else None,
                "finalPath": actual_path,
                "routeMatched": actual_path == expected_path,
            }
        )
        if not response or response.status != 200:
            result["failures"].append("response-not-200")
        if actual_path != expected_path:
            result["failures"].append("route-mismatch")

        move_outside_sidebar(page, viewport)
        collapsed = audit_state(page, "collapsed")
        result["states"].append(collapsed)

        panel = collapsed["probe"].get("panel")
        if panel:
            page.mouse.move(
                max(12, min(panel["right"] - 8, 30)),
                max(120, min(viewport["height"] - 20, 190)),
            )
            page.wait_for_timeout(560)
        hover = audit_state(page, "hover")
        result["states"].append(hover)

        move_outside_sidebar(page, viewport)
        menu = page.locator(".aph-header-menu")
        if menu.count() and menu.is_visible():
            menu.click()
            page.wait_for_timeout(500)
            pinned = audit_state(page, "pinned")
        else:
            pinned = {
                "state": "pinned",
                "probe": None,
                "failures": ["sidebar-pin-control-unavailable"],
            }
        result["states"].append(pinned)

        for state in result["states"]:
            result["failures"].extend(
                f"{state['state']}:{failure}" for failure in state["failures"]
            )

        # 失败时保留当前 pinned 态；成功样本也保留 AI 页用于人工复核。
        if result["failures"] or route == "/ai-alerts":
            page.screenshot(
                path=str(SHOTS / f"{viewport_name}-{label(route)}-pinned.png"),
                full_page=False,
            )
    except Exception as error:  # 单页异常不阻断全站取证。
        result["failures"].append(f"{type(error).__name__}: {error}")
    finally:
        result["blockedWrites"] = guard.blocked_writes
        result["pageErrors"] = page_errors
        result["consoleErrors"] = console_errors
        context.close()
    return result


def summarize(output: dict[str, Any]) -> dict[str, Any]:
    runs = output["runs"]
    state_runs = [state for run in runs for state in run.get("states", [])]
    hard_issues = [
        {
            "route": run["route"],
            "viewport": run["viewport"],
            "state": state["state"],
            **issue,
        }
        for run in runs
        for state in run.get("states", [])
        if state.get("probe")
        for issue in state["probe"]["hard"]
    ]
    by_width: dict[str, dict[str, int]] = {}
    for run in runs:
        width = str(run["viewport"]["width"])
        bucket = by_width.setdefault(width, {"routes": 0, "failedRoutes": 0, "hardIssues": 0})
        bucket["routes"] += 1
        if run["failures"]:
            bucket["failedRoutes"] += 1
        bucket["hardIssues"] += sum(
            (state.get("probe") or {}).get("counts", {}).get("hard", 0)
            for state in run.get("states", [])
        )
    return {
        "routeViewportRuns": len(runs),
        "stateRuns": len(state_runs),
        "passedRouteViewportRuns": sum(not run["failures"] for run in runs),
        "failedRouteViewportRuns": sum(bool(run["failures"]) for run in runs),
        "hardIssueInstances": len(hard_issues),
        "blockedWrites": sum(len(run["blockedWrites"]) for run in runs),
        "byWidth": by_width,
        "hardIssueKinds": {
            kind: sum(issue["kind"] == kind for issue in hard_issues)
            for kind in sorted({issue["kind"] for issue in hard_issues})
        },
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    SHOTS.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("CLIP_QA_TOKEN", "").strip() or qa.ephemeral_token()
    output: dict[str, Any] = {
        "base": BASE,
        "method": {
            "browser": "Python Playwright / headless Chromium",
            "productionMutation": False,
            "writeGuard": "POST/PUT/PATCH/DELETE blocked in browser",
            "loadSequence": ["domcontentloaded", "networkidle", "700ms settle"],
            "states": ["collapsed", "hover", "pinned"],
            "hardContract": [
                "visible text glyphs and controls stay inside viewport and main",
                "no visible semantic content is cut by overflow:hidden or overflow:clip",
                "main has no hidden horizontal overflow",
            ],
            "approvedException": (
                "descendants of an overflow-x:auto|scroll container whose scrollLeft "
                "can reach scrollWidth-clientWidth"
            ),
        },
        "routes": ROUTES,
        "viewports": [viewport for _, viewport in VIEWPORTS],
        "runs": [],
    }
    result_path = OUT / "visible-content-clipping-results.json"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for viewport_name, viewport in VIEWPORTS:
                    for route in ROUTES:
                        result = inspect_route(
                            browser, token, viewport_name, viewport, route
                        )
                        output["runs"].append(result)
                        output["summary"] = summarize(output)
                        result_path.write_text(
                            json.dumps(output, ensure_ascii=False, indent=2),
                            encoding="utf-8",
                        )
                        print(
                            json.dumps(
                                {
                                    "viewport": viewport_name,
                                    "route": route,
                                    "hard": sum(
                                        (state.get("probe") or {})
                                        .get("counts", {})
                                        .get("hard", 0)
                                        for state in result.get("states", [])
                                    ),
                                    "failures": len(result["failures"]),
                                },
                                ensure_ascii=False,
                            ),
                            flush=True,
                        )
            finally:
                browser.close()
    finally:
        token = ""

    output["summary"] = summarize(output)
    result_path.write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(output["summary"], ensure_ascii=False, indent=2), flush=True)
    if output["summary"]["failedRouteViewportRuns"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
