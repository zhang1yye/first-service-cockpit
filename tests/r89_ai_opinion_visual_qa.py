from pathlib import Path
from playwright.sync_api import sync_playwright


BASE_URL = "http://127.0.0.1:4174"
OUTPUT = Path("docs/qa/frontend-skill-cloud-20260816/r89-ai-opinion-local")
OUTPUT.mkdir(parents=True, exist_ok=True)
CANDIDATE = Path("release-candidates/cockpit-r89-ai-opinion-20260816-194449/payload")


def context_payload():
    return {
        "businessDate": "2026-08-16",
        "qualityStatus": "verified",
        "projectDataReady": False,
        "suggestedQuestions": ["上第服务中心的数据和未达标建议"],
    }


def answer_payload():
    return {
        "question": "上第服务中心的数据和未达标建议",
        "topic": "aph",
        "answer": "中心数据\n累计执行：1306.88万\nAI判断：预算缺口是当前主要风险，具体原因仍需核验。\nAI建议：先核对入账记录与欠费清单。[K1]",
        "businessDate": "2026-08-16",
        "qualityStatus": "verified",
        "centerPayment": {"center": "第一服务北京上第MOMΛ服务中心"},
        "generatedBy": "hermes-grounded",
        "modelUsed": "north-cockpit",
        "aiOpinion": {
            "label": "AI意见",
            "judgement": "预算缺口是当前主要风险，具体原因仍需核验。",
            "recommendations": "先核对入账记录与欠费清单。[K1]",
            "basis": {
                "businessDate": "2026-08-16",
                "qualityStatus": "verified",
                "sources": ["APH中心明细", "绿仔正式收缴数据"],
                "signalCodes": ["aph-budget-gap"],
            },
            "limitations": ["缺少项目级成本数据"],
            "disclaimer": "AI意见用于经营分析和核查提示，不替代业务确认或审批结论。",
        },
        "citations": [{"documentId": "PM4-KF-01"}],
        "fallbackUsed": False,
        "readOnly": True,
    }


def inspect_viewport(browser, width, height):
    page = browser.new_page(viewport={"width": width, "height": height})
    page.add_init_script("localStorage.setItem('cockpit_token', 'local-visual-qa-token')")
    page.route(
        f"{BASE_URL}/",
        lambda route: route.fulfill(path=str(CANDIDATE / "index.expected.html"), content_type="text/html"),
    )
    page.route(
        "**/assets/cockpit-bundle-defer-20260816-r89-ai-opinion.js*",
        lambda route: route.fulfill(
            path=str(CANDIDATE / "assets/cockpit-bundle-defer-20260816-r89-ai-opinion.js"),
            content_type="text/javascript",
        ),
    )
    page.route(
        "**/assets/cockpit-bundle-20260816-r89-ai-opinion.css",
        lambda route: route.fulfill(
            path=str(CANDIDATE / "assets/cockpit-bundle-20260816-r89-ai-opinion.css"),
            content_type="text/css",
        ),
    )
    page.route("**/api/ai/assistant/context", lambda route: route.fulfill(json=context_payload()))
    page.route("**/api/ai/assistant/ask", lambda route: route.fulfill(json=answer_payload()))
    # 驾驶舱有持续数据轮询，不能使用永远无法稳定的networkidle作为完成条件。
    page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30_000)
    # R64把原按钮作为顶栏代理源隐藏，组件挂载完成以attached为准。
    page.wait_for_selector("#north-ai-assistant .north-ai-launcher", state="attached")
    page.evaluate("document.querySelector('#north-ai-assistant .north-ai-launcher').click()")
    page.wait_for_selector("#north-ai-assistant .north-ai-overlay.is-open")
    page.locator(".north-ai-input").fill("上第服务中心的数据和未达标建议")
    page.locator(".north-ai-composer").evaluate("form => form.requestSubmit()")
    page.wait_for_selector(".north-ai-opinion")

    fact_text = page.locator(".north-ai-message-assistant:not(.north-ai-message-loading) .north-ai-bubble").last.text_content() or ""
    opinion = page.locator(".north-ai-opinion").last
    assert "累计执行：1306.88万" in fact_text
    assert "AI判断" not in fact_text
    assert opinion.get_attribute("aria-label") == "AI意见"
    assert "预算缺口是当前主要风险" in (opinion.text_content() or "")
    assert "先核对入账记录与欠费清单" in (opinion.text_content() or "")
    assert "不替代业务确认或审批结论" in (opinion.text_content() or "")

    opinion.locator("summary").click()
    assert "APH中心明细" in (opinion.text_content() or "")
    assert "绿仔正式收缴数据" in (opinion.text_content() or "")
    assert "缺少项目级成本数据" in (opinion.text_content() or "")

    box = page.evaluate("""() => {
        const cards = document.querySelectorAll('.north-ai-opinion')
        const rect = cards[cards.length - 1]?.getBoundingClientRect()
        return rect ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null
    }""")
    assert box is not None
    assert box["x"] >= 0
    assert box["x"] + box["width"] <= width + 1
    overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    assert overflow <= 1

    screenshot = OUTPUT / f"ai-opinion-{width}.png"
    page.screenshot(path=str(screenshot), full_page=True)
    page.close()
    return {"width": width, "height": height, "overflow": overflow, "screenshot": str(screenshot)}


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    results = [
        inspect_viewport(browser, 390, 844),
        inspect_viewport(browser, 1440, 1000),
    ]
    browser.close()
    print({"ok": True, "results": results})
