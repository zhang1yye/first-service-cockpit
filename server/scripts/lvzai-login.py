#!/usr/bin/env python3
"""绿仔最小化登录器：仅建立受控会话，不截图、不抓包、不输出页面或验证码。"""

import glob
import os
import sys
from pathlib import Path

import ddddocr
from playwright.sync_api import sync_playwright

BASE = "https://erp.firstpm.com.cn"
ACCOUNT = os.environ.get("LVZAI_USER", "").strip()
PASSWORD = os.environ.get("LVZAI_PWD", "")
STATE_INPUT = Path(os.environ.get("LVZAI_STATE_PATH", "~/.lvzai_state.json")).expanduser()
STATE = STATE_INPUT.absolute()

if not ACCOUNT or not PASSWORD:
    raise SystemExit("缺少LVZAI_USER或LVZAI_PWD环境变量")
if STATE_INPUT.is_symlink():
    raise SystemExit("绿仔会话文件不得为符号链接")
if STATE.exists() and (not STATE.is_file() or STATE.stat().st_uid != os.getuid()):
    raise SystemExit("绿仔会话文件不属于当前任务用户")
if STATE.parent.stat().st_uid != os.getuid() or STATE.parent.stat().st_mode & 0o022:
    raise SystemExit("绿仔会话目录必须由当前任务用户独占写入")


def chromium_executable():
    candidates = [
        os.environ.get("CHROME_BIN"),
        *sorted(glob.glob(os.path.expanduser("~/.cache/agent-browser/chrome/*/chrome-linux64/chrome")), reverse=True),
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ]
    executable = next((item for item in candidates if item and os.path.isfile(item) and os.access(item, os.X_OK)), None)
    if not executable:
        raise SystemExit("服务器未找到受控Chromium")
    return executable


def logged_in(page):
    return "login" not in page.url.lower()


def authenticate(page):
    for _attempt in range(8):
        page.goto(f"{BASE}/account/login", timeout=60_000, wait_until="domcontentloaded")
        page.wait_for_timeout(2_000)
        page.fill('input[name="account"]', ACCOUNT)
        page.fill('input[name="password"]', PASSWORD)
        captcha = page.locator('img[src*="captcha"]').first
        captcha.scroll_into_view_if_needed(timeout=3_000)
        code = ddddocr.DdddOcr(show_ad=False).classification(captcha.screenshot())
        if not code or not code.isdigit() or len(code) != 4:
            continue
        try:
            page.fill('input[placeholder="请输入验证码"]', code)
        except Exception:
            page.locator('input[type="text"]').nth(3).fill(code)
        try:
            page.locator('input[type="submit"]').first.click(timeout=5_000)
        except Exception:
            page.keyboard.press("Enter")
        page.wait_for_timeout(4_000)
        if logged_in(page):
            return True
    return False


temporary = STATE.with_name(f".{STATE.name}.tmp-{os.getpid()}")
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=chromium_executable(),
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        try:
            context = browser.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900})
            page = context.new_page()
            if not authenticate(page):
                raise SystemExit("绿仔登录失败")
            context.storage_state(path=str(temporary))
        finally:
            browser.close()
    os.chmod(temporary, 0o600)
    os.replace(temporary, STATE)
    os.chmod(STATE, 0o600)
except BaseException:
    try:
        temporary.unlink(missing_ok=True)
    finally:
        raise

sys.stdout.write("绿仔会话已更新\n")
