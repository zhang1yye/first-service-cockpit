#!/usr/bin/env python3
"""R65 欠费 AI 直达页生产只读验收；禁止发起任何业务写请求。"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE = "https://www.firstcare.cloud"
OUT = ROOT / "docs/qa/arrears-r65-20260813"
AXE = ROOT / "node_modules/axe-core/axe.min.js"

spec = importlib.util.spec_from_file_location("shared_qa", ROOT / "tests/full_remediation_shadow_qa.py")
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


def compact_violations(items: list[dict]) -> list[dict]:
    return [
        {
            "id": item["id"],
            "impact": item.get("impact"),
            "targets": [node.get("target") for node in item.get("nodes", [])],
        }
        for item in items
    ]


def run_viewport(browser, token: str, name: str, viewport: dict[str, int]) -> dict:
    context = browser.new_context(viewport=viewport)
    context.add_init_script(
        script=(
            f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
            f"localStorage.setItem('token',{json.dumps(token)});"
            "localStorage.setItem('cockpit_user',JSON.stringify({name:'欠费分析只读验收',role:'admin'}));"
        )
    )
    context.add_init_script(path=str(AXE))
    if os.environ.get("QA_R65_LOCAL") == "1":
        local_arrears = ROOT / "firstcare-cloud-local/arrears"
        context.route(
            "**/arrears/index.html*",
            lambda route: route.fulfill(path=str(local_arrears / "index.html"), content_type="text/html; charset=utf-8"),
        )
        context.route(
            "**/arrears/aph2-r59-arrears-embedded-inspector-20260813-v1.js*",
            lambda route: route.fulfill(path=str(local_arrears / "aph2-r59-arrears-embedded-inspector-20260813-v1.js"), content_type="text/javascript; charset=utf-8"),
        )
        context.route(
            "**/arrears/aph2-r59-arrears-embedded-inspector-20260813-v1.css*",
            lambda route: route.fulfill(path=str(local_arrears / "aph2-r59-arrears-embedded-inspector-20260813-v1.css"), content_type="text/css; charset=utf-8"),
        )
        context.route(
            "**/arrears/aph2-r60-arrears-modal-occlusion-20260813-v1.js*",
            lambda route: route.fulfill(path=str(local_arrears / "aph2-r60-arrears-modal-occlusion-20260813-v1.js"), content_type="text/javascript; charset=utf-8"),
        )
        context.route(
            "**/arrears/aph2-r62-arrears-direct-ai-20260813-v1.js*",
            lambda route: route.fulfill(path=str(local_arrears / "aph2-r62-arrears-direct-ai-20260813-v1.js"), content_type="text/javascript; charset=utf-8"),
        )
        context.route(
            "**/arrears/aph2-r62-arrears-direct-ai-20260813-v1.css*",
            lambda route: route.fulfill(path=str(local_arrears / "aph2-r62-arrears-direct-ai-20260813-v1.css"), content_type="text/css; charset=utf-8"),
        )
        context.route(
            "**/arrears/aph2-r65-arrears-optional-conclusion-20260813-v1.js*",
            lambda route: route.fulfill(path=str(local_arrears / "aph2-r65-arrears-optional-conclusion-20260813-v1.js"), content_type="text/javascript; charset=utf-8"),
        )
        context.route(
            "**/arrears/aph2-r65-arrears-optional-conclusion-20260813-v1.css*",
            lambda route: route.fulfill(path=str(local_arrears / "aph2-r65-arrears-optional-conclusion-20260813-v1.css"), content_type="text/css; charset=utf-8"),
        )
    page = context.new_page()
    console_errors: list[str] = []
    page_errors: list[str] = []
    request_failures: list[dict] = []
    http_errors: list[dict] = []
    write_requests: list[dict] = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on(
        "requestfailed",
        lambda request: request_failures.append({"method": request.method, "url": request.url, "error": request.failure})
        if request.failure != "net::ERR_ABORTED"
        else None,
    )
    page.on(
        "response",
        lambda response: http_errors.append({"status": response.status, "url": response.url})
        if response.status >= 400
        else None,
    )
    page.on(
        "request",
        lambda request: write_requests.append({"method": request.method, "url": request.url})
        if request.method not in {"GET", "HEAD", "OPTIONS"}
        else None,
    )

    response = page.goto(BASE + "/arrears", wait_until="domcontentloaded", timeout=30_000)
    frame_element = page.locator("#aph-arrears-frame")
    frame_element.wait_for(state="visible", timeout=15_000)
    frame_handle = frame_element.element_handle()
    frame = frame_handle.content_frame() if frame_handle else None
    if frame is None:
        raise AssertionError("欠费经营分析 iframe 未加载")
    frame.locator("#r55Workbench:not([hidden])").wait_for(state="visible", timeout=15_000)
    frame.locator("#r55CreatePanel:not([hidden])").wait_for(state="visible", timeout=15_000)
    frame.locator("#r55TaskRows tr[data-batch-id]").first.wait_for(state="attached", timeout=15_000)
    frame.wait_for_function("document.documentElement.dataset.r65ArrearsConclusion === 'true'")
    expect(frame.locator("#r65AiConclusion")).to_have_count(1)
    expect(frame.locator(".page-heading h1")).to_have_text("AI欠费分析")
    expect(frame.locator("#r55SubmitBatch")).to_have_text("开始AI分析")
    expect(frame.locator("#r55SubmitBatch")).to_be_enabled()
    expect(frame.locator("#r62History")).not_to_have_attribute("open", "")
    expect(frame.locator(".guardrail")).to_be_hidden()
    expect(frame.locator(".r55-view-nav")).to_be_hidden()
    expect(frame.locator(".r55-workbench-header")).to_be_hidden()
    expect(frame.locator(".r55-pipeline")).to_be_hidden()
    expect(frame.locator("#r62Views")).to_be_hidden()
    expect(frame.locator("#r55ArchiveState")).to_contain_text("可用")
    expect(frame.locator("#r55AiState")).to_contain_text("AI已配置")
    expect(frame.locator("#r55LedgerFile")).to_have_attribute("required", "")
    expect(frame.locator("#r55CommunicationFile")).not_to_have_attribute("required", "")
    expect(frame.locator("label[for='r55CommunicationFile'], .r55-file-field").filter(has=frame.locator("#r55CommunicationFile"))).to_contain_text("选填")

    direct_ui = frame.evaluate(
        """() => {
          const visible = selector => {
            const node = document.querySelector(selector)
            return Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
          }
          return {
            heading:document.querySelector('.page-heading h1')?.textContent?.trim(),
            submit:document.querySelector('#r55SubmitBatch')?.textContent?.trim(),
            formVisible:visible('#r55CreatePanel'),
            fieldCount:document.querySelectorAll('#r55CreateForm select, #r55CreateForm input').length,
            historyOpen:document.querySelector('#r62History')?.open,
            hiddenExplanations:['.guardrail','.r55-view-nav','.r55-workbench-header','.r55-pipeline','.r55-create-panel > .r55-section-heading']
              .every(selector => !visible(selector)),
            ledgerRequired:document.querySelector('#r55LedgerFile')?.required,
            communicationRequired:document.querySelector('#r55CommunicationFile')?.required,
            communicationOptional:document.querySelector('#r55CommunicationFile')?.closest('label')?.textContent?.includes('选填'),
            r65Loaded:document.documentElement.dataset.r65ArrearsConclusion === 'true',
            conclusionPanels:document.querySelectorAll('#r65AiConclusion').length,
            conclusionBorder:getComputedStyle(document.querySelector('#r65AiConclusion')).borderLeftWidth,
          }
        }"""
    )
    if direct_ui != {
        "heading": "AI欠费分析",
        "submit": "开始AI分析",
        "formVisible": True,
        "fieldCount": 4,
        "historyOpen": False,
        "hiddenExplanations": True,
        "ledgerRequired": True,
        "communicationRequired": False,
        "communicationOptional": True,
        "r65Loaded": True,
        "conclusionPanels": 1,
        "conclusionBorder": "3px",
    }:
        raise AssertionError(f"欠费 AI 直达首屏异常：{direct_ui}")

    entry_screenshot = OUT / f"production-{name}-entry.png"
    page.screenshot(path=str(entry_screenshot), full_page=False)

    frame.locator("#r62History > summary").click()
    expect(frame.locator("#r62Views")).to_be_visible()
    frame.locator("#r62Views > summary").click()
    frame.locator("#r55OverviewView").click()
    expect(frame.locator("body")).to_have_attribute("data-r55-mode", "overview")
    expect(frame.locator("#r62Views")).to_have_attribute("open", "")
    frame.locator("#r55DetailsView").click()
    expect(frame.locator("body")).to_have_attribute("data-r55-mode", "details")
    frame.locator("#r55TasksView").click()
    expect(frame.locator("body")).to_have_attribute("data-r55-mode", "tasks")
    expect(frame.locator("#r62Views")).not_to_have_attribute("open", "")
    expect(frame.locator("#r55CreatePanel")).to_be_visible()
    frame.locator("#r62History > summary").click()
    expect(frame.locator("#r62History")).not_to_have_attribute("open", "")

    api = frame.evaluate(
        """async () => {
          const token = localStorage.getItem('cockpit_token') || ''
          const headers = {Authorization:`Bearer ${token}`}
          const get = async path => {
            const response = await fetch(path, {headers})
            return {status:response.status, body:await response.json()}
          }
          const [readiness, overview, projects, batches] = await Promise.all([
            get('/api/arrears/readiness'),
            get('/api/arrears/overview'),
            get('/api/arrears/projects'),
            get('/api/arrears/batches'),
          ])
          const rows = Array.isArray(batches.body?.rows) ? batches.body.rows : []
          const historical = rows.find(row => row.status === 'revoked') || rows[0]
          const batchId = historical?.id
          const [results, runs, audit, conclusion] = batchId ? await Promise.all([
            get(`/api/arrears/batches/${batchId}/results?page=1&limit=50`),
            get(`/api/arrears/batches/${batchId}/runs?limit=20`),
            get(`/api/arrears/batches/${batchId}/audit`),
            get(`/api/arrears/batches/${batchId}/conclusion`),
          ]) : [{status:null,body:{}},{status:null,body:{}},{status:null,body:{}},{status:null,body:{}}]
          return {
            statuses: {
              readiness:readiness.status, overview:overview.status,
              projects:projects.status, batches:batches.status,
              results:results.status, runs:runs.status, audit:audit.status, conclusion:conclusion.status,
            },
            readiness: {
              ready:readiness.body?.ready,
              uploadReady:readiness.body?.uploadReady,
              analysisReady:readiness.body?.analysisReady,
              aiConfigured:readiness.body?.ai?.configured,
              archiveReady:readiness.body?.archive?.ready,
              hashReady:readiness.body?.hash?.ready,
              accessibleProjects:readiness.body?.projects?.accessible,
              ledgerRequired:readiness.body?.requirements?.ledgerRequired,
              communicationsRequired:readiness.body?.requirements?.communicationsRequired,
            },
            overview: {
              ready:overview.body?.ready,
              effectiveBatchCount:overview.body?.effectiveBatchCount,
              resourceCount:overview.body?.resourceCount,
              totalAmount:overview.body?.totalAmount ?? null,
              pendingReviewCount:overview.body?.pendingReviewCount,
              rejectedReviewCount:overview.body?.rejectedReviewCount,
            },
            counts: {
              projects:Array.isArray(projects.body?.rows) ? projects.body.rows.length : null,
              batches:rows.length,
              results:Array.isArray(results.body?.rows) ? results.body.rows.length : null,
              runs:Array.isArray(runs.body?.rows) ? runs.body.rows.length : null,
              audit:Array.isArray(audit.body?.rows) ? audit.body.rows.length : null,
            },
            historical: historical ? {
              id:historical.id,
              status:historical.status,
              archiveDeleted:Boolean(historical.archive_deleted_at),
              exportDisabledExpected:Number(historical.confirmed_review_count || 0) < 1 || ['analyzing','revoked','blocked'].includes(historical.status),
            } : null,
            conclusion: {
              available:conclusion.body?.available ?? conclusion.body?.aiSignals?.available,
              complete:conclusion.body?.analysisStatus?.complete,
              scope:conclusion.body?.traceability?.scope,
            },
          }
        }"""
    )
    if any(status != 200 for status in api["statuses"].values()):
        raise AssertionError(f"欠费只读 API 未全部返回200：{api['statuses']}")
    readiness = api["readiness"]
    if not all(readiness.get(key) is True for key in ("ready", "uploadReady", "analysisReady", "aiConfigured", "archiveReady", "hashReady")):
        raise AssertionError(f"欠费能力门禁未就绪：{readiness}")
    if readiness.get("ledgerRequired") is not True or readiness.get("communicationsRequired") is not False:
        raise AssertionError(f"欠费文件必填合同异常：{readiness}")
    if api["counts"]["projects"] is None or api["counts"]["projects"] < 1:
        raise AssertionError(f"授权项目不可用：{api['counts']}")
    if not api["historical"] or api["historical"]["status"] != "revoked" or not api["historical"]["archiveDeleted"]:
        raise AssertionError(f"历史批次状态与生产基线不一致：{api['historical']}")
    if api["overview"]["effectiveBatchCount"] != 0 or api["overview"]["totalAmount"] is not None:
        raise AssertionError(f"已撤回且密文已删批次错误进入经营汇总：{api['overview']}")
    if api["conclusion"] != {"available": False, "complete": False, "scope": "entire_batch"}:
        raise AssertionError(f"未完成历史批次错误形成AI结论：{api['conclusion']}")

    frame.locator("#r62History > summary").click()
    expect(frame.locator("#r62History")).to_have_attribute("open", "")
    task_row = frame.locator(f"#r55TaskRows tr[data-batch-id='{api['historical']['id']}']")
    task_row.wait_for(state="visible", timeout=10_000)
    expect(task_row).to_contain_text("已撤回")
    export_button = task_row.get_by_role("button", name="导出确认结果")
    expect(export_button).to_be_disabled()
    task_row.get_by_role("button", name="进入复核").click()
    frame.locator("#r55ReviewWorkspace:not([hidden])").wait_for(state="visible", timeout=15_000)
    frame.locator("#r55Inspector:not([hidden])").wait_for(state="visible", timeout=15_000)
    frame.wait_for_timeout(300)
    expect(frame.locator("#r65AiConclusion")).to_have_count(1)
    expect(frame.locator("#r65AiConclusion")).to_be_hidden()
    inspector = frame.locator("#r55Inspector")
    expect(inspector).to_contain_text("欠费台账事实")
    expect(inspector).to_contain_text("结构化沟通信号")
    expect(frame.locator("#r55ConfirmNext")).to_be_disabled()
    expect(frame.locator("#r55RejectNext")).to_be_disabled()
    mobile_modal = viewport["width"] <= 860
    mobile_geometry = None
    inspector_screenshot = None
    if mobile_modal:
        if inspector.get_attribute("role") != "dialog" or inspector.get_attribute("aria-modal") != "true":
            raise AssertionError("移动端资源证据未进入模态对话框")
        active_id = frame.evaluate("document.activeElement?.id")
        if active_id != "r55CloseInspector":
            raise AssertionError(f"移动端 Inspector 首焦点异常：{active_id}")
        mobile_geometry = {
            "frame": frame_element.bounding_box(),
            "closeInner": frame.locator("#r55CloseInspector").evaluate(
                "el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height} }"
            ),
            "innerViewport": frame.evaluate("() => ({width:innerWidth,height:innerHeight,scrollY})"),
            "innerParentRects": frame.evaluate(
                "() => ({frameTop:window.frameElement?.getBoundingClientRect().top ?? null,navBottom:window.parent.document.querySelector('.aph-mobile-primary-nav')?.getBoundingClientRect().bottom ?? null})"
            ),
            "inspector": inspector.evaluate(
                "el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return {x:r.x,y:r.y,width:r.width,height:r.height,inlineTop:el.style.top,computedTop:s.top,rootInset:getComputedStyle(document.documentElement).getPropertyValue('--r59-arrears-inspector-top-inset')} }"
            ),
            "outerNav": page.locator(".aph-mobile-primary-nav").evaluate(
                "el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return {x:r.x,y:r.y,width:r.width,height:r.height,zIndex:s.zIndex,position:s.position,display:s.display,inert:el.inert} }"
            ),
            "outerAiDisplay": page.locator("#north-ai-assistant").evaluate("el => getComputedStyle(el).display"),
        }
        mobile_geometry["outerHit"] = page.evaluate(
            """({frame,closeInner}) => {
              const x=frame.x+closeInner.x+closeInner.width/2
              const y=frame.y+closeInner.y+closeInner.height/2
              const el=document.elementFromPoint(x,y)
              return {x,y,tag:el?.tagName||'',id:el?.id||'',className:el?.className||'',text:el?.textContent?.trim().slice(0,30)||''}
            }""",
            mobile_geometry,
        )
        safe_inner_top = 0 if mobile_geometry["outerNav"]["display"] == "none" else max(0, mobile_geometry["outerNav"]["y"] + mobile_geometry["outerNav"]["height"] - mobile_geometry["frame"]["y"])
        if mobile_geometry["closeInner"]["y"] < safe_inner_top or mobile_geometry["outerHit"]["id"] != "aph-arrears-frame" or mobile_geometry["outerNav"]["inert"] is not True or mobile_geometry["outerNav"]["display"] != "none" or mobile_geometry["outerAiDisplay"] != "none":
            raise AssertionError(f"移动端 Inspector 仍被外层导航遮挡：{mobile_geometry}")
        inspector_screenshot = OUT / "production-mobile-inspector.png"
        page.screenshot(path=str(inspector_screenshot), full_page=False)
    frame.locator("#r55CloseInspector").click()
    expect(inspector).to_be_hidden()
    if mobile_modal:
        page.wait_for_function("document.querySelector('.aph-mobile-primary-nav')?.inert === false")
        page.wait_for_function("getComputedStyle(document.querySelector('.aph-mobile-primary-nav')).display !== 'none'")
        page.wait_for_function("getComputedStyle(document.querySelector('#north-ai-assistant')).display !== 'none'")

    frame.locator("#r55RunHistory").click()
    modal = frame.locator("#r55Modal[open]")
    modal.wait_for(state="visible", timeout=10_000)
    expect(modal).to_contain_text("AI运行记录")
    page.keyboard.press("Escape")
    expect(frame.locator("#r55Modal")).not_to_have_attribute("open", "")
    frame.locator("#r55AuditTrail").click()
    modal = frame.locator("#r55Modal[open]")
    modal.wait_for(state="visible", timeout=10_000)
    expect(modal).to_contain_text("审计记录")
    page.keyboard.press("Escape")

    frame.locator("#r62History > summary").click()
    expect(frame.locator("#r62History")).not_to_have_attribute("open", "")
    frame.locator("#r55CloseReview").click()
    frame.wait_for_timeout(100)
    visible_focus = frame.evaluate(
        "() => ({tag:document.activeElement?.tagName, text:document.activeElement?.textContent?.trim(), visible:Boolean(document.activeElement?.getClientRects().length)})"
    )
    if visible_focus != {"tag": "SUMMARY", "text": "历史分析1条", "visible": True}:
        raise AssertionError(f"折叠历史后关闭复核的焦点异常：{visible_focus}")

    document_title = frame.evaluate(
        "() => ({title:document.title,titleCount:document.querySelectorAll('title').length})"
    )
    axe = frame.evaluate(
        """async () => axe.run(document, {
          runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']},
          resultTypes:['violations','incomplete','passes'],
        })"""
    )
    violations = compact_violations(
        [
            item
            for item in axe["violations"]
            if not (
                item["id"] == "document-title"
                and document_title["title"]
                and document_title["titleCount"] == 1
            )
        ]
    )
    if violations:
        raise AssertionError(f"生产欠费工作台 WCAG 违规：{violations}")

    layout = {
        "outerOverflow": page.evaluate("Math.max(0,document.documentElement.scrollWidth-innerWidth)"),
        "innerOverflow": frame.evaluate("Math.max(0,document.documentElement.scrollWidth-innerWidth)"),
        "mode": frame.locator("body").get_attribute("data-r55-mode"),
        "visibleH1": frame.locator("h1:visible").count(),
    }
    if layout["outerOverflow"] > 1 or layout["innerOverflow"] > 1 or layout["mode"] != "tasks" or layout["visibleH1"] != 1:
        raise AssertionError(f"生产欠费工作台布局异常：{layout}")
    if console_errors or page_errors or request_failures or http_errors or write_requests:
        raise AssertionError(
            f"生产浏览器错误或越过只读边界：console={console_errors} page={page_errors} "
            f"failed={request_failures} http={http_errors} writes={write_requests}"
        )

    screenshot = OUT / f"production-{name}.png"
    page.screenshot(path=str(screenshot), full_page=False)
    result = {
        "viewport": viewport,
        "status": response.status if response else None,
        "api": api,
        "directUi": direct_ui,
        "layout": layout,
        "axeViolations": violations,
        "axePassRuleCount": len(axe["passes"]),
        "documentTitle": document_title,
        "mobileGeometry": mobile_geometry,
        "inspectorScreenshot": str(inspector_screenshot) if inspector_screenshot else None,
        "consoleErrors": console_errors,
        "pageErrors": page_errors,
        "requestFailures": request_failures,
        "httpErrors": http_errors,
        "writeRequests": write_requests,
        "entryScreenshot": str(entry_screenshot),
        "screenshot": str(screenshot),
    }
    context.close()
    return result


def verify_sidebar_click(browser, token: str) -> dict:
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    context.add_init_script(
        script=(
            f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
            f"localStorage.setItem('token',{json.dumps(token)});"
            "localStorage.setItem('cockpit_user',JSON.stringify({name:'欠费路由只读验收',role:'admin'}));"
        )
    )
    page = context.new_page()
    writes: list[dict] = []
    page.on("request", lambda request: writes.append({"method": request.method, "url": request.url}) if request.method not in {"GET", "HEAD", "OPTIONS"} else None)
    page.goto(BASE + "/", wait_until="domcontentloaded", timeout=30_000)
    link = page.get_by_role("link", name="欠费经营分析").first
    link.wait_for(state="attached", timeout=15_000)
    href = link.get_attribute("href")
    link.click()
    page.wait_for_url("**/arrears", timeout=15_000)
    page.locator("#aph-arrears-frame").wait_for(state="visible", timeout=15_000)
    result = {
        "href": href,
        "path": urlsplit(page.url).path,
        "frameVisible": page.locator("#aph-arrears-frame:visible").count() == 1,
        "writeRequests": writes,
    }
    if result["href"] != "/arrears" or result["path"] != "/arrears" or writes:
        raise AssertionError(f"驾驶舱侧栏真实点击异常：{result}")
    context.close()
    return result


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    token = shared.ephemeral_token()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                headless=True,
                args=["--host-resolver-rules=MAP firstcare.cloud 82.157.119.78, MAP www.firstcare.cloud 82.157.119.78"],
            )
            result = {
                "origin": BASE,
                "strictTls": True,
                "readOnly": True,
                "desktop": run_viewport(browser, token, "desktop", {"width": 1440, "height": 1000}),
                "mobile": run_viewport(browser, token, "mobile", {"width": 390, "height": 844}),
                "sidebarClick": verify_sidebar_click(browser, token),
            }
            browser.close()
        result_path = OUT / "production-results.json"
        result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(
            json.dumps(
                {
                    "result": str(result_path),
                    "desktop": {
                        "status": result["desktop"]["status"],
                        "axe": len(result["desktop"]["axeViolations"]),
                        "overflow": result["desktop"]["layout"],
                        "writes": len(result["desktop"]["writeRequests"]),
                    },
                    "mobile": {
                        "status": result["mobile"]["status"],
                        "axe": len(result["mobile"]["axeViolations"]),
                        "overflow": result["mobile"]["layout"],
                        "writes": len(result["mobile"]["writeRequests"]),
                    },
                    "readiness": result["desktop"]["api"]["readiness"],
                    "overview": result["desktop"]["api"]["overview"],
                    "counts": result["desktop"]["api"]["counts"],
                    "sidebarClick": result["sidebarClick"],
                },
                ensure_ascii=False,
            )
        )
    finally:
        token = ""


if __name__ == "__main__":
    main()
