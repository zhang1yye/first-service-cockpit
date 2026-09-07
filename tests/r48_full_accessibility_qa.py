#!/usr/bin/env python3
"""全站 WCAG 2.2 AA 自动扫描；支持生产、候选与本地影子壳层。"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
AXE = ROOT / "node_modules/axe-core/axe.min.js"
TARGET = os.environ.get("QA_TARGET", "production")
CANDIDATE_ROOT = Path(os.environ["QA_STATIC_ROOT"]) if os.environ.get("QA_STATIC_ROOT") else None
OUT = Path(os.environ.get(
    "QA_OUT_FILE",
    ROOT / f"docs/qa/frontend-skill-cloud-20260812/r48-{TARGET}-accessibility.json",
))
ROUTES = [route.strip() for route in os.environ.get(
    "QA_ROUTES",
    "/,/command,/projects,/payment,/daily,/collection,/arrears,/ai-alerts,/ai-report,/import,/review,/system,/tasks,/admin",
).split(",") if route.strip()]

spec = importlib.util.spec_from_file_location("qa", ROOT / "tests/full_remediation_shadow_qa.py")
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


class ProductionShellHandler(qa.ShadowHandler):
    """影子环境复刻生产：/admin 由主驾驶舱 SPA 接管。"""

    def candidate_file(self, relative: str) -> Path:
        candidate = CANDIDATE_ROOT / relative if CANDIDATE_ROOT else None
        if candidate and candidate.is_file():
            return candidate
        return qa.STATIC_ROOT / relative

    def serve_cockpit(self, request_path: str):
        if request_path == "/":
            return self.send_file(self.candidate_file("index.html"))
        if request_path in {"/arrears/", "/arrears/index.html"}:
            return self.send_file(self.candidate_file("arrears/index.html"))
        if request_path in {"/arrears", "/admin", "/admin/"}:
            return self.send_file(self.candidate_file("index.html"))
        spa_routes = {
            "/", "/command", "/payment", "/collection", "/daily", "/projects",
            "/import", "/ai-report", "/ai-alerts", "/tasks", "/review", "/system", "/login",
        }
        if request_path.rstrip("/") in spa_routes:
            return self.send_file(self.candidate_file("index.html"))
        relative = request_path.lstrip("/")
        candidate = self.candidate_file(relative)
        if candidate.is_dir():
            candidate = candidate / "index.html"
        if candidate.is_file():
            return self.send_file(candidate)
        return self.send_file(self.candidate_file("index.html"))


def compact_violation(violation: dict) -> dict:
    return {
        "id": violation["id"],
        "impact": violation.get("impact"),
        "tags": [tag for tag in violation.get("tags", []) if tag.startswith("wcag")],
        "nodes": [
            {
                "target": node.get("target"),
                "html": node.get("html", "")[:500],
                "failureSummary": node.get("failureSummary"),
            }
            for node in violation.get("nodes", [])
        ],
        "nodeCount": len(violation.get("nodes", [])),
    }


def start_shadow() -> tuple[str, subprocess.Popen, qa.ThreadingHTTPServer, threading.Thread]:
    tunnel = subprocess.Popen([
        "ssh", "-N", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "-L", f"{qa.TUNNEL_PORT}:127.0.0.1:{qa.REMOTE_SHADOW_PORT}", qa.HOST,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    qa.wait_port(qa.TUNNEL_PORT)
    server = qa.ThreadingHTTPServer(("127.0.0.1", qa.LOCAL_PORT), ProductionShellHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return qa.BASE, tunnel, server, thread


def scan(base: str, token: str) -> dict:
    output = {
        "engine": "axe-core 4.11.4",
        "standard": "WCAG 2.2 AA",
        "target": TARGET,
        "base": base,
        "viewports": {},
    }
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for name, viewport in [
            ("desktop", {"width": 1440, "height": 1000}),
            ("mobile", {"width": 390, "height": 844}),
        ]:
            context = browser.new_context(viewport=viewport)
            context.add_init_script(script=(
                f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
                f"localStorage.setItem('token',{json.dumps(token)});"
                "localStorage.setItem('cockpit_user',JSON.stringify({name:'R48无障碍验收',role:'admin'}));"
            ))
            context.add_init_script(path=str(AXE))
            page = context.new_page()
            route_results = {}
            for route in ROUTES:
                response = page.goto(base + route, wait_until="domcontentloaded", timeout=30_000)
                page.wait_for_timeout(4_500 if route == "/admin" else 1_800)
                axe = page.evaluate("""async () => axe.run(document, {
                  runOnly: {type:'tag', values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']},
                  resultTypes: ['violations', 'incomplete', 'passes'],
                })""")
                route_results[route] = {
                    "status": response.status if response else None,
                    "url": page.url,
                    "overflow": page.evaluate("Math.max(0, document.documentElement.scrollWidth - innerWidth)"),
                    "visibleH1": page.locator("h1:visible").count(),
                    "violations": [compact_violation(item) for item in axe["violations"]],
                    "incomplete": [compact_violation(item) for item in axe["incomplete"]],
                    "passRuleCount": len(axe["passes"]),
                }
            output["viewports"][name] = route_results
            context.close()

        login_context = browser.new_context(viewport={"width": 390, "height": 844})
        login_context.add_init_script(path=str(AXE))
        login = login_context.new_page()
        login.goto(base + "/login", wait_until="domcontentloaded", timeout=30_000)
        login.wait_for_timeout(1_000)
        login_axe = login.evaluate("""async () => axe.run(document, {
          runOnly: {type:'tag', values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']},
          resultTypes: ['violations', 'incomplete', 'passes'],
        })""")
        output["login"] = {
            "url": login.url,
            "violations": [compact_violation(item) for item in login_axe["violations"]],
            "incomplete": [compact_violation(item) for item in login_axe["incomplete"]],
            "passRuleCount": len(login_axe["passes"]),
        }
        login_context.close()
        browser.close()
    return output


def summary(output: dict) -> dict:
    result = {}
    for viewport, routes in output["viewports"].items():
        result[viewport] = {
            route: {
                "nodes": sum(item["nodeCount"] for item in data["violations"]),
                "rules": [item["id"] for item in data["violations"]],
                "incomplete": sum(item["nodeCount"] for item in data["incomplete"]),
            }
            for route, data in routes.items()
        }
    result["login"] = {
        "nodes": sum(item["nodeCount"] for item in output["login"]["violations"]),
        "rules": [item["id"] for item in output["login"]["violations"]],
    }
    return result


def main() -> None:
    token = qa.ephemeral_token()
    tunnel = server = thread = None
    try:
        base = "https://www.firstcare.cloud"
        if TARGET != "production":
            base, tunnel, server, thread = start_shadow()
        output = scan(base, token)
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(summary(output), ensure_ascii=False))
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
