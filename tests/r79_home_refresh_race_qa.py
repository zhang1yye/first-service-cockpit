#!/usr/bin/env python3
"""首页刷新竞态只读取证：连续刷新并记录各布局节点的类名与几何。"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = Path(
    os.environ.get(
        "R79_QA_OUT",
        str(ROOT / "docs/qa/frontend-skill-cloud-20260814/r79-home-refresh-race-baseline"),
    )
)
BASE = "https://firstcare.cloud/"


def token() -> str:
    helper = ROOT / "tests/full_remediation_shadow_qa.py"
    spec = importlib.util.spec_from_file_location("r79_token", helper)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module.ephemeral_token()


PROBE = """() => {
  const box = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),display:s.display,gridColumn:s.gridColumn,gridRow:s.gridRow};
  };
    const main = document.querySelector('#main-content');
  const root = main?.querySelector('.aph-home-reflow');
  const grid = root?.querySelector(':scope > .aph-home-kpi-grid');
  const cards = grid ? [...grid.children].map((el,index)=>({
    index,
    cls:el.className,
    hidden:el.hidden,
    text:(el.innerText||'').replace(/\\s+/g,' ').trim().slice(0,100),
    box:box(el),
  })) : [];
  const role = name => cards.find(card => String(card.cls).includes(name));
  return {
    path:location.pathname,
    ready:document.readyState,
    bodyClass:document.body?.className,
    bodyR8:document.body?.getAttribute('data-r8-home-layout'),
    htmlR75:document.documentElement.dataset.r75RefreshHome || null,
    rootDataset:root ? {...root.dataset} : null,
    rootBox:box(root),
    gridBox:box(grid),
    cardCount:cards.length,
    cards,
    mainChildren:main ? [...main.children].map(el=>({tag:el.tagName,cls:el.className,text:(el.innerText||'').replace(/\\s+/g,' ').trim().slice(0,80),children:el.children.length})) : [],
    firstChildChildren:main?.firstElementChild ? [...main.firstElementChild.children].map(el=>({tag:el.tagName,cls:el.className,text:(el.innerText||'').replace(/\\s+/g,' ').trim().slice(0,80),children:el.children.length})) : [],
    signature:[role('r8-home-core')?.box?.x,role('r8-home-budget')?.box?.x,role('r8-home-collection')?.box?.x,role('r8-home-period')?.box?.y].join('|'),
  };
}"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    auth = token()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1536, "height": 900})
        context.add_init_script(
            f"localStorage.setItem('cockpit_token',{json.dumps(auth)});"
            f"localStorage.setItem('token',{json.dumps(auth)});"
        )
        fix_script = os.environ.get("R79_FIX_JS", "")
        if fix_script:
            context.add_init_script(path=str(Path(fix_script).resolve()))
        page = context.new_page()
        blocked = []
        errors = []
        failed = []

        def guard(route):
            req = route.request
            if req.method not in ("GET", "HEAD", "OPTIONS"):
                blocked.append({"method": req.method, "url": req.url})
                return route.abort()
            route.continue_()

        page.route("**/*", guard)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.on("requestfailed", lambda req: failed.append({"url": req.url, "failure": req.failure}))
        runs = []
        variants = set()
        run_count = int(os.environ.get("R79_RUNS", "24"))
        extended = os.environ.get("R79_EXTENDED", "") == "1"
        delays = (0, 100, 300, 900, 1800, 3500, 6000) if extended else (0, 30, 90, 180, 400, 900, 1800)
        for index in range(run_count):
            if index == 0:
                page.goto(BASE, wait_until="domcontentloaded", timeout=60_000)
            else:
                page.reload(wait_until="domcontentloaded", timeout=60_000)
            samples = []
            elapsed = 0
            for delay in delays:
                page.wait_for_timeout(delay - elapsed)
                elapsed = delay
                samples.append({"ms": delay, "state": page.evaluate(PROBE)})
            final = samples[-1]["state"]
            signature = final.get("signature") or "missing"
            if signature not in variants:
                variants.add(signature)
                page.screenshot(path=str(OUT / f"variant-{len(variants)}-run-{index + 1}.png"), full_page=True)
            runs.append({"run": index + 1, "samples": samples})
        browser.close()
    result = {"target":"shadow" if fix_script else "production","candidateInjected":bool(fix_script),"viewport":[1536,900],"runs":runs,"variantCount":len(variants),"signatures":sorted(variants),"blockedWrites":blocked,"errors":errors,"failedRequests":failed}
    (OUT / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"runs":len(runs),"variants":len(variants),"output":str(OUT / 'results.json')}, ensure_ascii=False))


if __name__ == "__main__":
    main()
