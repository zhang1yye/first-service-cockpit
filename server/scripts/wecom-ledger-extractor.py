#!/usr/bin/env python3
"""企业微信文档受控只读提取器：固定真实API、官方前端解码器、stdout仅输出进程合同JSON。"""
import asyncio
import glob
import json
import os
import re
import sys
import urllib.parse
from pathlib import Path

from playwright.async_api import async_playwright

ORIGIN = "https://doc.weixin.qq.com"
SHEET_API_PATH = "/dop-api/get/sheet"
REQUIRED_HEADERS = ["片区", "小区", "房间", "费用开始日期", "费用结束日期", "欠费原因", "催缴措施", "提升计划", "完成时间", "是否回款", "回款时间"]
ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
FULL_ROOM = re.compile(r"^[A-Z]{2,3}-[A-Z0-9]+-[A-Z0-9\u3400-\u9FFF]+-[A-Z0-9\u3400-\u9FFF]+-[A-Z0-9\u3400-\u9FFF]+$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_API_PAYLOAD_BYTES = 16 * 1024 * 1024
ALLOWED_SHEET_QUERY_KEYS = {"_r", "endrow", "needSheetState", "normal", "nowb", "outformat", "padId", "preview_token", "rev", "sliceStates", "startrow", "subId", "xsrf"}
REQUIRED_SHEET_QUERY_KEYS = {"endrow", "nowb", "outformat", "padId", "rev", "startrow", "subId", "xsrf"}


def chromium_executable():
    candidates = [
        os.environ.get("CHROME_BIN"),
        "/usr/bin/chromium-browser", "/usr/bin/chromium",
        *sorted(glob.glob(os.path.expanduser("~/.cache/agent-browser/chrome/*/chrome-linux64/chrome")), reverse=True),
    ]
    return next((item for item in candidates if item and os.path.isfile(item) and os.access(item, os.X_OK)), None)


def normalized_room(value):
    parts = str(value or "").strip().upper().replace("－", "-").replace("—", "-").split("-")
    if len(parts) != 5:
        return "-".join(parts)
    parts[2] = re.sub(r"(?:号)?(?:楼|栋)$", "", parts[2])
    parts[2] = re.sub(r"(?:#|\.0)$", "", parts[2])
    parts[3] = re.sub(r"单元$", "", parts[3])
    parts[3] = re.sub(r"\.0$", "", parts[3])
    parts[4] = re.sub(r"(?:室|房)$", "", parts[4])
    parts[4] = re.sub(r"\.0$", "", parts[4])
    return "-".join(parts)


def complete_api_items(captures):
    items = [item for capture in captures for item in capture["items"]]
    versions = [item.get("formula_version") for item in items if isinstance(item.get("formula_version"), int)]
    if not versions:
        raise RuntimeError("企业微信工作表API缺少版本号")
    version = max(versions)
    current = [item for item in items if item.get("formula_version") == version]
    maximum_rows = {item.get("max_row") for item in current}
    maximum_columns = {item.get("max_col") for item in current}
    if len(maximum_rows) != 1 or len(maximum_columns) != 1:
        raise RuntimeError("企业微信工作表API同版本边界不一致")
    maximum_row = next(iter(maximum_rows))
    if not isinstance(maximum_row, int) or maximum_row < 1:
        raise RuntimeError("企业微信工作表API行边界无效")
    unique = {}
    for item in current:
        start = item.get("start_row_index")
        end = item.get("end_row_index")
        if start is None and end is None:
            continue
        start = 0 if start is None else start
        if not isinstance(start, int) or not isinstance(end, int):
            raise RuntimeError("企业微信工作表API分片缺少行边界")
        if start < 0 or end < start:
            raise RuntimeError("企业微信工作表API分片行边界倒置")
        if end >= maximum_row:
            raise RuntimeError("企业微信工作表API分片超出工作表边界")
        identity = (start, end)
        if identity in unique and unique[identity]["related_sheet"] != item["related_sheet"]:
            raise RuntimeError("企业微信工作表API同版本分片内容冲突")
        unique[identity] = item
    intervals = sorted(unique)
    covered = -1
    for start, end in intervals:
        if start > covered + 1:
            raise RuntimeError("企业微信工作表API分片不完整")
        covered = max(covered, end)
    if covered < maximum_row - 1:
        raise RuntimeError("企业微信工作表API分片未覆盖完整工作表")
    return list(unique.values())


async def decode_sheet_api(page, items):
    return await page.evaluate("""({items, required}) => {
        let webpackRequire
        self.webpackChunksheet.push([["controlled_wecom_sheet_decoder"], {}, value => { webpackRequire = value }])
        if (!webpackRequire) throw new Error("webpack decoder unavailable")
        const decoder = webpackRequire(222272)?.tq
        if (typeof decoder !== "function") throw new Error("official revision decoder unavailable")
        const cells = new Map(), merges = []
        let maximumRow = 0, maximumColumn = 0, positionCount = 0
        const rendered = cell => {
            if (!cell) return ""
            let value = cell.value
            if (value && Array.isArray(value.r)) value = value.r.map(item => item?.t || "").join("")
            else if (value && value.formulaResult) value = value.formulaResult.value
            if (value === null || value === undefined) return ""
            if (typeof value === "number") {
                const format = cell.style?.numberFormat?.formatCode || ""
                if (/[ymd]/i.test(format) && Number.isFinite(value)) {
                    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000)
                    if (Number.isFinite(date.getTime())) return date.toISOString().slice(0, 10)
                }
            }
            return String(value)
        }
        for (const item of items) {
            maximumRow = Math.max(maximumRow, Number(item.max_row || 0))
            maximumColumn = Math.max(maximumColumn, Number(item.max_col || 0))
            const revision = decoder(item.related_sheet, true)
            for (const command of revision.commands || []) for (const mutation of command.mutations || []) {
                for (const position of mutation.setRange?.cellAtPositions || []) {
                    positionCount += 1
                    if (positionCount > 2000000) throw new Error("cell count exceeds safety limit")
                    const key = `${position.rowIndex},${position.colIndex}`
                    const value = rendered(position.cell)
                    if (cells.has(key) && cells.get(key) !== value) throw new Error("cell value conflict")
                    cells.set(key, value)
                }
                const range = mutation.mergeCells?.gridRangeData
                if (range) merges.push(range)
            }
        }
        if (!Number.isInteger(maximumRow) || maximumRow < 1 || maximumRow > 100000 || !Number.isInteger(maximumColumn) || maximumColumn < 1 || maximumColumn > 256) throw new Error("sheet bounds invalid")
        for (const range of merges) {
            const startRow = Number(range.startRowIndex), endRow = Number(range.endRowIndex)
            const startColumn = Number(range.startColIndex), endColumn = Number(range.endColIndex)
            if (![startRow, endRow, startColumn, endColumn].every(Number.isInteger) || startRow < 0 || startColumn < 0 || endRow < startRow || endColumn < startColumn || endRow >= maximumRow || endColumn >= maximumColumn) throw new Error("merge range invalid")
            const inherited = cells.get(`${startRow},${startColumn}`) || ""
            for (let row = startRow; row <= endRow; row += 1) for (let column = startColumn; column <= endColumn; column += 1) {
                const key = `${row},${column}`
                if (!cells.has(key)) cells.set(key, inherited)
            }
        }
        let headerRow = -1, index = {}
        for (let row = 0; row < Math.min(maximumRow, 30); row += 1) {
            const values = []
            for (let column = 0; column < maximumColumn; column += 1) values.push((cells.get(`${row},${column}`) || "").trim())
            if (required.every(name => values.includes(name))) {
                headerRow = row
                for (const name of required) index[name] = values.indexOf(name)
                break
            }
        }
        if (headerRow < 0) throw new Error("required headers missing")
        const rows = []
        for (let row = headerRow + 1; row < maximumRow; row += 1) {
            const value = { __sourceRowNumber: row + 1 }
            let nonempty = false
            for (const name of required) {
                const cell = cells.get(`${row},${index[name]}`) || ""
                value[name] = cell
                if (cell.trim()) nonempty = true
            }
            if (nonempty) rows.push(value)
        }
        return { rows, maximumRow, maximumColumn, headerRow }
    }""", {"items": items, "required": REQUIRED_HEADERS})


async def extract(request, session_file):
    document_id, sheet_id = request["documentId"], request["sheetId"]
    executable = chromium_executable()
    captures, capture_errors = [], []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, executable_path=executable)
        try:
            context = await browser.new_context(storage_state=str(session_file), viewport={"width": 1440, "height": 900})
            page = await context.new_page()

            async def capture(response):
                parsed = urllib.parse.urlparse(response.url)
                if parsed.scheme != "https" or parsed.netloc != "doc.weixin.qq.com" or parsed.path != SHEET_API_PATH:
                    return
                try:
                    payload = await response.json()
                    data = payload.get("data") if isinstance(payload, dict) else None
                    query = urllib.parse.parse_qs(parsed.query)
                    if response.status != 200 or payload.get("retcode") != 0 or not isinstance(data, dict) or data.get("sheetId") != sheet_id:
                        return
                    query_keys = set(query)
                    if response.request.method != "GET" or not REQUIRED_SHEET_QUERY_KEYS.issubset(query_keys) or not query_keys.issubset(ALLOWED_SHEET_QUERY_KEYS):
                        return
                    text = (data.get("initialAttributedText") or {}).get("text")
                    if not isinstance(text, list) or not text:
                        raise RuntimeError("企业微信工作表API缺少分片数据")
                    items = []
                    for item in text:
                        if not isinstance(item, dict) or not isinstance(item.get("related_sheet"), str) or not item["related_sheet"]:
                            raise RuntimeError("企业微信工作表API分片合同无效")
                        items.append({key: item.get(key) for key in ["related_sheet", "max_row", "max_col", "start_row_index", "end_row_index", "formula_version"]})
                    captures.append({"full": query.get("startrow", [""])[0] == "0" and query.get("endrow", [""])[0] == "-1", "items": items})
                except RuntimeError as error:
                    capture_errors.append(str(error))
                except Exception:
                    return

            page.on("response", capture)
            await page.goto(f"{ORIGIN}/sheet/{document_id}", wait_until="domcontentloaded", timeout=60_000)
            await page.wait_for_timeout(5_000)
            if "login" in page.url.lower():
                raise SystemExit(42)
            tab = page.locator(f'.tab-bar-item[data-tab-id="{sheet_id}"]')
            try:
                await tab.wait_for(state="visible", timeout=20_000)
            except Exception as exc:
                raise RuntimeError("授权工作表不存在或不可见") from exc
            if await tab.count() != 1:
                raise RuntimeError("授权工作表不存在或不可见")
            await tab.click()
            items, last_error = None, None
            for _ in range(25):
                await page.wait_for_timeout(1_000)
                if capture_errors:
                    raise RuntimeError(capture_errors[0])
                if not captures:
                    continue
                try:
                    items = complete_api_items(captures)
                    break
                except RuntimeError as error:
                    last_error = error
            if items is None:
                raise last_error or RuntimeError("企业微信工作表API未返回只读分片")
            if sum(len(item["related_sheet"].encode()) for item in items) > MAX_API_PAYLOAD_BYTES:
                raise RuntimeError("企业微信工作表API分片超过16MiB安全上限")
            decoded = await decode_sheet_api(page, items)
        finally:
            await browser.close()

    source_rows = decoded.get("rows") if isinstance(decoded, dict) else None
    if not isinstance(source_rows, list) or not source_rows:
        raise RuntimeError("企业微信工作表为空")
    rows, record_ids = [], set()
    for source in source_rows:
        if not isinstance(source, dict):
            raise RuntimeError("企业微信工作表API行结构无效")
        number = source.get("__sourceRowNumber")
        if not isinstance(number, int) or number < 1:
            raise RuntimeError("企业微信工作表API缺少稳定源行号")
        room = normalized_room(source.get("房间"))
        period_start = str(source.get("费用开始日期") or "").strip()
        period_end = str(source.get("费用结束日期") or "").strip()
        record_id = f"{sheet_id}:{room}:{period_start}:{period_end}" if FULL_ROOM.fullmatch(room) else f"{sheet_id}:invalid-row:{number}"
        if record_id in record_ids:
            raise RuntimeError("企业微信工作表存在重复稳定记录键")
        record_ids.add(record_id)
        cause = str(source.get("欠费原因") or "").strip()
        progress_parts = [str(source.get(name) or "").strip() for name in ["催缴措施", "提升计划"]]
        if str(source.get("是否回款") or "").strip() in {"是", "已回款", "已缴"}:
            progress_parts.append("已缴费，等待绿仔确认")
        latest = str(source.get("回款时间") or "").strip()
        promised = str(source.get("完成时间") or "").strip()
        rows.append({
            "recordId": record_id,
            "房屋编号": room,
            "欠费原因": cause,
            "催缴进展": "；".join(item for item in progress_parts if item),
            "最新跟进日期": latest if DATE.fullmatch(latest) else "",
            "承诺缴费日期": promised if DATE.fullmatch(promised) else "",
        })
    return {"rows": rows, "total": len(rows)}


async def main():
    raw = sys.stdin.buffer.read(64 * 1024 + 1)
    if len(raw) > 64 * 1024:
        raise RuntimeError("企业微信提取请求超过安全上限")
    request = json.loads(raw)
    if request.get("operation") != "read_sheet" or not ID.fullmatch(str(request.get("documentId", ""))) or not ID.fullmatch(str(request.get("sheetId", ""))) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(request.get("businessDate", ""))):
        raise RuntimeError("企业微信提取请求合同无效")
    session_file = Path(os.environ.get("WECOM_SESSION_FILE", "")).expanduser().resolve()
    if not session_file.is_file():
        raise RuntimeError("缺少企业微信受控会话文件")
    result = await asyncio.wait_for(extract(request, session_file), timeout=110)
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


try:
    asyncio.run(main())
except SystemExit:
    raise
except Exception:
    raise SystemExit(1)
