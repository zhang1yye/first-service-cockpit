#!/usr/bin/env python3
"""R80 当前站点修复影子 QA：只放行 GET/HEAD/OPTIONS。"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("R80_QA_BASE", "https://firstcare.cloud")
TARGET = os.environ.get("R80_QA_TARGET", "shadow")
OUT = Path(os.environ.get(
    "R80_QA_OUT",
    str(ROOT / "docs/qa/frontend-skill-cloud-20260816/r80-current-site-fixes-shadow"),
))
JS = ROOT / "firstcare-cloud-local/aph2-r80-current-site-fixes-20260816-v1.js"
CSS = ROOT / "firstcare-cloud-local/aph2-r80-current-site-fixes-20260816-v1.css"
ROUTES = ("/", "/admin", "/projects", "/ai-alerts", "/daily", "/payment", "/collection")


def token() -> str:
    path = ROOT / "tests/full_remediation_shadow_qa.py"
    spec = importlib.util.spec_from_file_location("r80_token", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module.ephemeral_token()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    auth = token()
    if TARGET not in ("shadow", "production"):
        raise RuntimeError("R80_QA_TARGET 只能为 shadow 或 production")
    result = {
        "target": TARGET,
        "candidateInjected": TARGET == "shadow",
        "blockedWrites": [],
        "runs": [],
    }
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for name, width, height in (("mobile390", 390, 844), ("desktop1440", 1440, 1000)):
            context = browser.new_context(viewport={"width": width, "height": height}, bypass_csp=True)
            context.add_init_script(
                f"localStorage.setItem('cockpit_token',{json.dumps(auth)});"
                f"localStorage.setItem('token',{json.dumps(auth)});"
            )
            if TARGET == "shadow":
                context.add_init_script(path=str(JS))

            def guard(route):
                request = route.request
                if request.method not in ("GET", "HEAD", "OPTIONS"):
                    result["blockedWrites"].append({"method": request.method, "url": request.url})
                    return route.abort()
                return route.continue_()

            context.route("**/*", guard)
            page = context.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            for path in ROUTES:
                page.goto(BASE + path, wait_until="domcontentloaded", timeout=60_000)
                if TARGET == "shadow":
                    page.add_style_tag(path=str(CSS))
                page.wait_for_timeout(1_100)
                probe = page.evaluate("""() => {
                  const q = (s) => document.querySelector(s);
                  const box = (e) => { if (!e) return null; const r=e.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}; };
                  const tabs=q('.r65-tabs'), bar=q('.r66-domain-bar');
                  const rows=[...document.querySelectorAll('.r56-center-row')];
                  const first=q('.aph-project-table-wrap th:first-child');
                  return {
                    finalPath: location.pathname,
                    overflow: Math.max(0, document.documentElement.scrollWidth-innerWidth),
                    adminOverlap: Boolean(tabs && bar && Math.min(tabs.getBoundingClientRect().bottom,bar.getBoundingClientRect().bottom) > Math.max(tabs.getBoundingClientRect().top,bar.getBoundingClientRect().top)),
                    tabs: box(tabs), domainBar: box(bar), banner: box(q('.aph-business-banner')),
                    aiTotal: rows.length,
                    aiVisible: rows.filter(row => getComputedStyle(row).display !== 'none').length,
                    aiPager: q('.aph-r80-ai-pager')?.innerText || null,
                    projectFirstPosition: first ? getComputedStyle(first).position : null,
                    release: document.documentElement.dataset.r80Release || null,
                  };
                }""")
                checks = {
                    "noHorizontalOverflow": probe["overflow"] == 0,
                    "releaseLoaded": probe["release"] == "r80-current-site-fixes-20260816-v1",
                }
                if name == "mobile390" and path == "/admin":
                    checks["adminNoOverlap"] = not probe["adminOverlap"]
                    checks["adminOrder"] = probe["tabs"]["bottom"] <= probe["domainBar"]["top"]
                if name == "mobile390" and path == "/":
                    checks["homeStartsAfterNav"] = 102 <= probe["banner"]["top"] <= 120
                if name == "mobile390" and path == "/ai-alerts":
                    checks["aiFirstPage"] = probe["aiTotal"] == 56 and probe["aiVisible"] == 12
                    checks["aiPager"] = probe["aiPager"] == "显示其余 44 个服务中心"
                if name == "mobile390" and path == "/projects":
                    checks["projectFirstColumnSticky"] = probe["projectFirstPosition"] == "sticky"
                result["runs"].append({"viewport": name, "path": path, "probe": probe, "checks": checks})
                if name == "mobile390" and path in ("/", "/admin", "/projects", "/ai-alerts"):
                    page.screenshot(path=str(OUT / f"{name}-{path.strip('/') or 'home'}.png"), full_page=True)
            result.setdefault("pageErrors", []).extend(errors)
            context.close()
        browser.close()

    result["passed"] = (
        not result["blockedWrites"]
        and not result.get("pageErrors")
        and all(all(run["checks"].values()) for run in result["runs"])
    )
    (OUT / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": result["passed"], "runs": len(result["runs"]), "output": str(OUT / "results.json")}, ensure_ascii=False))
    raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
