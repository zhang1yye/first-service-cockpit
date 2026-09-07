#!/usr/bin/env python3
"""企小码受控增量聊天提取器：固定只读接口，原文仅经stdout内存管道交给标准化层。"""
import asyncio
import base64
import json
import os
import re
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from playwright.async_api import TimeoutError as PlaywrightTimeoutError, async_playwright

ORIGIN = "https://qxm.huihuacundang.com"
MAX_CONTACT_PAGES = 500
MAX_RELATION_PAGES = 100
MAX_MESSAGE_PAGES = 1000
ID = re.compile(r"^[A-Za-z0-9_.:-]{1,256}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def decode_cursor(value):
    if not value:
        return {"occurredAt": "", "messageId": "", "upperOccurredAt": "", "upperMessageId": ""}
    try:
        padding = "=" * (-len(value) % 4)
        data = json.loads(base64.urlsafe_b64decode(value + padding))
        occurred = str(data.get("occurredAt", ""))
        message = str(data.get("messageId", ""))
        upper_occurred = str(data.get("upperOccurredAt", ""))
        upper_message = str(data.get("upperMessageId", ""))
        valid_message = lambda item: bool(item) and len(item) <= 1024 and not re.search(r"[\x00-\x1f\x7f]", item)
        if occurred and not valid_message(message):
            raise ValueError()
        if bool(upper_occurred) != bool(upper_message) or (upper_message and not valid_message(upper_message)):
            raise ValueError()
        return {"occurredAt": occurred, "messageId": message, "upperOccurredAt": upper_occurred, "upperMessageId": upper_message}
    except Exception as exc:
        raise RuntimeError("企小码增量游标无效") from exc


def encode_cursor(occurred_at, message_id, upper=None):
    data = {"occurredAt": occurred_at, "messageId": message_id}
    if upper:
        data.update({"upperOccurredAt": upper[0], "upperMessageId": upper[1]})
    raw = json.dumps(data, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def after_cursor(row, cursor):
    return (str(row.get("occurredAt", "")), str(row.get("messageId", ""))) > (cursor["occurredAt"], cursor["messageId"])


def within_snapshot(row, cursor):
    if not cursor["upperOccurredAt"]:
        return True
    return (str(row.get("occurredAt", "")), str(row.get("messageId", ""))) <= (cursor["upperOccurredAt"], cursor["upperMessageId"])


def normalized_time(value):
    raw = str(value or "").strip()
    if re.fullmatch(r"\d{13}", raw):
        return datetime.fromtimestamp(int(raw) / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", raw):
        return raw.replace(" ", "T") + "+08:00"
    return raw


def content_kind(value):
    raw = str(value or "").lower()
    return {"1": "text", "2": "image", "4": "link", "6": "voice", "8": "file"}.get(raw, raw if raw in {"text", "image", "link", "voice", "file"} else "other")


class SessionExpired(Exception):
    pass


async def checked_post(request, path, headers, data):
    response = await request.post(ORIGIN + path, headers=headers, data=data, timeout=60_000)
    body = await response.json()
    if response.status in (401, 403) or body.get("code") in (401, 403):
        raise SessionExpired()
    if response.status != 200 or body.get("code") != 200:
        raise RuntimeError("企小码只读接口响应无效")
    return body.get("data")


async def contacts(request, headers, department_id, cursor):
    result = []
    for page in range(1, MAX_CONTACT_PAGES + 1):
        payload = {"page": page, "page_size": 500, "search_name": "", "order": "lastchat_desc", "del_type": "0", "del_time": "", "start_time": "", "end_time": "", "tag_ids": "", "user_ids": "", "department": department_id, "last_msg_time": "", "is_wachat": "", "is_wxwork": ""}
        rows = await checked_post(request, "/admin/work_party/getExternalContact", headers, payload)
        if not isinstance(rows, list):
            raise RuntimeError("企小码外部联系人响应结构无效")
        result.extend(rows)
        if len(rows) < 500:
            return result
    raise RuntimeError("企小码外部联系人分页超过安全上限")


async def relations(request, headers, external_id):
    result = []
    for page in range(1, MAX_RELATION_PAGES + 1):
        data = await checked_post(request, "/admin/work_msg_audit/getExternalMsgList", headers, {"external_id": external_id, "type": 0, "name": "", "last_msg_time": "", "node": "conversation_customer", "page": page, "page_size": 100, "filter_user": ""})
        if not isinstance(data, dict) or not isinstance(data.get("data"), list) or not isinstance(data.get("total"), int):
            raise RuntimeError("企小码客户会话响应结构无效")
        result.extend(data["data"])
        if len(result) >= data["total"]:
            return result
    raise RuntimeError("企小码客户会话分页超过安全上限")


async def messages(request, headers, external_id, employee_id, cursor):
    result, last_time = [], ""
    for _ in range(MAX_MESSAGE_PAGES):
        payload = {"from_id": external_id, "to_id": employee_id, "type": 0, "start_date": "", "end_date": "", "search_name": "", "msg_size": 100, "chat_members": "", "msg_type": ""}
        if last_time:
            payload["last_time"] = last_time
        rows = await checked_post(request, "/admin/work_msg_audit/getExternalMsgContent", headers, payload)
        if not isinstance(rows, list):
            raise RuntimeError("企小码消息响应结构无效")
        if not rows:
            return result
        result.extend(rows)
        times = [str(row.get("msgtime", "")) for row in rows if row.get("msgtime")]
        oldest = min(times) if times else ""
        if not oldest or oldest == last_time:
            raise RuntimeError("企小码消息分页时间未推进")
        last_time = oldest
        if cursor["occurredAt"] and normalized_time(oldest) <= cursor["occurredAt"]:
            return result
        if len(rows) < 100:
            return result
    raise RuntimeError("企小码消息分页超过安全上限")


async def extract(request_payload, session):
    token = str(session.get("xToken", ""))
    for _ in range(3):
        decoded = urllib.parse.unquote(token)
        if decoded == token:
            break
        token = decoded
    if not token:
        raise SessionExpired()
    headers = {"X-Token": token, "Token": token, "X-Node": "conversation_customer", "Content-Type": "application/json"}
    cursor = decode_cursor(request_payload["cursor"])
    limit = request_payload["limit"]
    async with async_playwright() as playwright:
        api = await playwright.request.new_context(storage_state=session.get("storageState"), timeout=60_000)
        try:
            contact_rows = await contacts(api, headers, request_payload["departmentId"], cursor)
            output, seen = [], set()
            for contact in contact_rows:
                external_id = contact.get("id")
                external_user_id = str(contact.get("external_userid", ""))
                if external_id is None or not external_user_id:
                    raise RuntimeError("企小码外部联系人缺少稳定ID")
                room = str(contact.get("remark", "") or "")
                for relation in await relations(api, headers, external_id):
                    user = relation.get("user") if isinstance(relation.get("user"), dict) else {}
                    employee_id = user.get("id")
                    employee_user_id = str(user.get("userid", ""))
                    if employee_id is None or not employee_user_id:
                        raise RuntimeError("企小码会话缺少稳定员工ID")
                    for source in await messages(api, headers, external_id, employee_id, cursor):
                        message_id = str(source.get("msgid", ""))
                        occurred_at = normalized_time(source.get("msgtime"))
                        if not message_id or not occurred_at or message_id in seen:
                            if message_id in seen:
                                continue
                            raise RuntimeError("企小码消息缺少稳定ID或时间")
                        row = {"messageId": message_id, "externalUserId": external_user_id, "employeeUserId": employee_user_id, "roomRemark": room, "occurredAt": occurred_at, "direction": "inbound" if source.get("from_type") == 2 else "outbound", "contentKind": content_kind(source.get("msgtype")), "content": str(source.get("content", "") or "")}
                        if occurred_at[:10] <= request_payload["businessDate"] and after_cursor(row, cursor) and within_snapshot(row, cursor):
                            seen.add(message_id)
                            output.append(row)
            output.sort(key=lambda row: (row["occurredAt"], row["messageId"]))
            total = len(output)
            page_rows = output[:limit]
            has_more = total > limit
            latest = page_rows[-1] if page_rows else None
            upper = (cursor["upperOccurredAt"], cursor["upperMessageId"]) if cursor["upperOccurredAt"] else ((output[-1]["occurredAt"], output[-1]["messageId"]) if output else None)
            if has_more and latest and upper:
                next_cursor = encode_cursor(latest["occurredAt"], latest["messageId"], upper)
            elif latest:
                next_cursor = encode_cursor(latest["occurredAt"], latest["messageId"])
            elif upper:
                next_cursor = encode_cursor(upper[0], upper[1])
            else:
                next_cursor = request_payload["cursor"]
            return {"rows": page_rows, "total": total, "nextCursor": next_cursor, "hasMore": has_more}
        finally:
            await api.dispose()


async def main():
    raw = sys.stdin.buffer.read(64 * 1024 + 1)
    if len(raw) > 64 * 1024:
        raise RuntimeError("企小码提取请求超过安全上限")
    request_payload = json.loads(raw)
    if request_payload.get("operation") != "read_messages" or not ID.fullmatch(str(request_payload.get("departmentId", ""))) or not DATE.fullmatch(str(request_payload.get("businessDate", ""))) or not isinstance(request_payload.get("cursor"), str) or not isinstance(request_payload.get("limit"), int) or not 10 <= request_payload["limit"] <= 20000:
        raise RuntimeError("企小码提取请求合同无效")
    session_file = Path(os.environ.get("QXM_SESSION_FILE", "")).expanduser().resolve()
    if not session_file.is_file():
        raise RuntimeError("缺少企小码受控会话文件")
    session = json.loads(session_file.read_text())
    result = await asyncio.wait_for(extract(request_payload, session), timeout=1750)
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


try:
    asyncio.run(main())
except SessionExpired:
    raise SystemExit(42)
except (TimeoutError, PlaywrightTimeoutError):
    raise SystemExit(43)
except Exception:
    raise SystemExit(1)
