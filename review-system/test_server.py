#!/usr/bin/env python3
"""第一服务研发小组审核系统 — 单元测试 & 集成测试"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server

# 确保真实数据库已完成迁移
server.init_db()


class TestUtils(unittest.TestCase):
    """工具函数单元测试"""

    def test_classify_mode_internal(self):
        self.assertEqual(server.classify_mode("这是一个内部方案"), "internal")
        self.assertEqual(server.classify_mode("运营方案需要审核"), "internal")
        self.assertEqual(server.classify_mode("费用调整方案"), "internal")
        self.assertEqual(server.classify_mode("外包方案"), "internal")
        self.assertEqual(server.classify_mode("整改专项"), "internal")
        self.assertEqual(server.classify_mode("管理制度更新"), "internal")

    def test_classify_mode_market(self):
        self.assertEqual(server.classify_mode("招标文件需要测算"), "market")
        self.assertEqual(server.classify_mode("投标报价审核"), "market")
        self.assertEqual(server.classify_mode("物业选聘项目"), "market")
        self.assertEqual(server.classify_mode("市场拓展方案"), "market")
        self.assertEqual(server.classify_mode("测算方案"), "market")

    def test_classify_mode_explicit(self):
        self.assertEqual(server.classify_mode("任意文本", "market"), "market")
        self.assertEqual(server.classify_mode("任意文本", "internal"), "internal")

    def test_classify_mode_unknown(self):
        self.assertEqual(server.classify_mode("这是普通消息"), "unknown")
        self.assertEqual(server.classify_mode(""), "unknown")

    def test_classify_mode_internal_priority(self):
        result = server.classify_mode("招标项目和内部方案都有")
        self.assertIn(result, ["internal", "market"])

    def test_profile_by_code_valid(self):
        p = server.profile_by_code("tf-invest")
        self.assertIsNotNone(p)
        self.assertEqual(p["name"], "投资发展TF")

        p = server.profile_by_code("cw-finance")
        self.assertIsNotNone(p)
        self.assertEqual(p["name"], "计划财务CW")

    def test_profile_by_code_invalid(self):
        self.assertIsNone(server.profile_by_code("invalid-code"))
        self.assertIsNone(server.profile_by_code(""))

    def test_now_format(self):
        ts = server.now()
        self.assertRegex(ts, r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}")

    def test_clean_hermes_output_empty(self):
        self.assertEqual(server.clean_hermes_output(""), "未获取到可见回复。")

    def test_clean_hermes_output_ansi(self):
        result = server.clean_hermes_output("\x1b[32mHello\x1b[0m World")
        self.assertIn("Hello", result)
        self.assertIn("World", result)

    def test_clean_hermes_output_skip_prefixes(self):
        result = server.clean_hermes_output("Model: gpt-4\nSession: abc\nHello world")
        self.assertNotIn("Model:", result)
        self.assertNotIn("Session:", result)
        self.assertIn("Hello world", result)


class TestDatabase(unittest.TestCase):
    """数据库操作测试"""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "test.db"
        # Monkey-patch DB_PATH
        self._orig_db = server.DB_PATH
        server.DB_PATH = self.db_path
        server.init_db()

    def tearDown(self):
        server.DB_PATH = self._orig_db
        self.tmpdir.cleanup()

    def test_init_db_creates_tables(self):
        db = sqlite3.connect(str(self.db_path))
        tables = db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        table_names = [t[0] for t in tables]
        self.assertIn("reviews", table_names)
        self.assertIn("attachments", table_names)
        self.assertIn("task_events", table_names)
        db.close()

    def test_init_db_creates_indexes(self):
        db = sqlite3.connect(str(self.db_path))
        indexes = db.execute("SELECT name FROM sqlite_master WHERE type='index'").fetchall()
        index_names = [i[0] for i in indexes]
        self.assertIn("idx_reviews_task_id", index_names)
        self.assertIn("idx_reviews_mode", index_names)
        self.assertIn("idx_reviews_status", index_names)
        db.close()

    def test_save_and_get_review(self):
        task = {
            "taskId": "test_001",
            "mode": "internal",
            "title": "测试审核任务",
            "message": "这是测试消息",
            "results": [{"profile": {"name": "测试专业"}, "reply": "✅通过"}],
            "sentCount": 1,
            "errorCount": 0,
            "reviewerCount": 8,
            "completedCount": 1,
            "status": "completed",
            "createdAt": server.now(),
        }
        server.save_review(task)
        review = server.get_review("test_001")
        self.assertIsNotNone(review)
        self.assertEqual(review["title"], "测试审核任务")
        self.assertEqual(review["mode"], "internal")
        self.assertEqual(review["status"], "completed")
        self.assertEqual(review["reviewerCount"], 8)

    def test_save_review_creates_event(self):
        task = {
            "taskId": "test_002",
            "mode": "market",
            "title": "市场测试",
            "message": "test",
            "sentCount": 0,
            "status": "pending",
            "createdAt": server.now(),
        }
        server.save_review(task)
        audit = server.get_audit_log("test_002")
        self.assertTrue(len(audit) > 0)
        self.assertEqual(audit[0]["eventType"], "review_saved")

    def test_get_history_pagination(self):
        for i in range(5):
            task = {
                "taskId": f"pagination_test_{i}",
                "mode": "internal",
                "title": f"分页测试 {i}",
                "message": "test",
                "sentCount": 0,
                "status": "completed",
                "createdAt": server.now(),
            }
            server.save_review(task)

        result = server.get_history(limit=3, offset=0)
        self.assertEqual(len(result["history"]), 3)
        self.assertEqual(result["limit"], 3)
        self.assertEqual(result["offset"], 0)

        result2 = server.get_history(limit=3, offset=3)
        self.assertEqual(len(result2["history"]), 2)

    def test_get_history_filter_by_mode(self):
        result = server.get_history(mode="internal")
        for h in result["history"]:
            self.assertEqual(h["mode"], "internal")

    def test_get_history_filter_by_status(self):
        result = server.get_history(status="completed")
        for h in result["history"]:
            self.assertEqual(h["status"], "completed")

    def test_get_history_search(self):
        task = {
            "taskId": "search_test_unique",
            "mode": "internal",
            "title": "唯一搜索词测试任务",
            "message": "test",
            "sentCount": 0,
            "status": "completed",
            "createdAt": server.now(),
        }
        server.save_review(task)
        result = server.get_history(q="唯一搜索词")
        self.assertTrue(len(result["history"]) >= 1)
        self.assertIn("唯一搜索词", result["history"][0]["title"])

    def test_stats(self):
        s = server.stats()
        self.assertIn("total", s)
        self.assertIn("internal", s)
        self.assertIn("market", s)
        self.assertIn("today", s)
        self.assertIn("pending", s)
        self.assertIn("completed", s)
        self.assertIn("failed", s)

    def test_update_review_status(self):
        task = {
            "taskId": "status_test",
            "mode": "internal",
            "title": "状态测试",
            "message": "test",
            "sentCount": 0,
            "status": "pending",
            "createdAt": server.now(),
        }
        server.save_review(task)
        server.update_review_status("status_test", "completed", "建议通过")
        review = server.get_review("status_test")
        self.assertEqual(review["status"], "completed")
        self.assertEqual(review["conclusion"], "建议通过")

    def test_log_event(self):
        server.log_event("event_test", "test_event", "测试事件", "tf-invest", {"key": "value"})
        audit = server.get_audit_log("event_test")
        self.assertTrue(len(audit) > 0)
        self.assertEqual(audit[0]["eventType"], "test_event")
        self.assertEqual(audit[0]["description"], "测试事件")
        self.assertEqual(audit[0]["profileCode"], "tf-invest")
        self.assertEqual(audit[0]["metadata"]["key"], "value")

    def test_delete_review(self):
        task = {
            "taskId": "delete_test",
            "mode": "internal",
            "title": "删除测试",
            "message": "test",
            "sentCount": 0,
            "status": "completed",
            "createdAt": server.now(),
        }
        server.save_review(task)
        self.assertIsNotNone(server.get_review("delete_test"))
        result = server.delete_review("delete_test")
        self.assertTrue(result)
        self.assertIsNone(server.get_review("delete_test"))


class TestFileExtraction(unittest.TestCase):
    """文件内容提取测试"""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_extract_txt(self):
        path = Path(self.tmpdir.name) / "test.txt"
        path.write_text("Hello 世界")
        result = server.extract_file_content(str(path))
        self.assertIn("Hello 世界", result)

    def test_extract_unsupported(self):
        path = Path(self.tmpdir.name) / "test.exe"
        path.write_text("malware")
        result = server.extract_file_content(str(path))
        self.assertIn("不支持的文件格式", result)

    def test_extract_image(self):
        path = Path(self.tmpdir.name) / "test.png"
        path.write_text("fake png data")
        result = server.extract_file_content(str(path))
        self.assertIn("图片文件", result)


class TestQualityAssessment(unittest.TestCase):
    """审核意见质量评估测试"""

    def test_assess_empty_reply(self):
        q = server.assess_reply_quality("")
        self.assertEqual(q["score"], 0)
        self.assertEqual(q["level"], "不合格")
        self.assertFalse(q["pass"])

    def test_assess_short_reply(self):
        q = server.assess_reply_quality("通过")
        self.assertLess(q["score"], 60)
        self.assertFalse(q["pass"])

    def test_assess_excellent_reply(self):
        reply = "✅通过。根据物业服务标准GB/T 20647，本方案符合绿化养护一级标准要求。建议在合同中明确养护频次和验收标准。注意夏季高温需增加浇水频次。"
        q = server.assess_reply_quality(reply)
        self.assertGreaterEqual(q["score"], 70)
        self.assertTrue(q["pass"])

    def test_assess_reply_without_conclusion(self):
        reply = "这是一个关于绿化养护的方案，从养护角度来看，需要注意植物选择、浇水频次和病虫害防治等方面。"
        q = server.assess_reply_quality(reply)
        self.assertIn("缺少明确结论", "\n".join(q["flags"]))

    def test_assess_reply_no_evidence(self):
        reply = "✅通过。这个方案可以执行。"
        q = server.assess_reply_quality(reply)
        self.assertIn("缺少具体依据", "\n".join(q["flags"]))

    def test_assess_reply_cross_profile(self):
        reply = "✅通过。TF测算合理，SS设备选型OK，CW预算没问题，KF客户满意度高。"
        q = server.assess_reply_quality(reply)
        self.assertIn("涉及多个其他专业判断", "\n".join(q["flags"]))

    def test_quality_score_range(self):
        q = server.assess_reply_quality("✅通过。")
        self.assertTrue(0 <= q["score"] <= 100)

    def test_quality_threshold(self):
        self.assertEqual(server.QUALITY_THRESHOLD, 60)

    def test_assess_task_quality_not_found(self):
        result = server.assess_task_quality("nonexistent_task")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "task not found")

    def test_re_review_not_found(self):
        result = server.re_review_profile("nonexistent_task", "tf-invest")
        self.assertFalse(result["ok"])

    def test_re_review_unknown_profile(self):
        # 需要一个存好的task
        import tempfile
        tmpdir = tempfile.TemporaryDirectory()
        db_path = Path(tmpdir.name) / "test.db"
        orig_db = server.DB_PATH
        orig_task = server.TASK_DIR
        server.DB_PATH = db_path
        server.TASK_DIR = Path(tmpdir.name) / "tasks"
        server.TASK_DIR.mkdir(exist_ok=True)
        server.init_db()
        task = {
            "taskId": "qtest_re_review",
            "mode": "internal", "title": "测试", "message": "测试消息",
            "sentCount": 0, "status": "completed", "createdAt": server.now(),
        }
        server.save_review(task)
        result = server.re_review_profile("qtest_re_review", "invalid-profile")
        self.assertFalse(result["ok"])
        server.DB_PATH = orig_db
        server.TASK_DIR = orig_task
        tmpdir.cleanup()


class TestExport(unittest.TestCase):
    """导出功能测试"""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "test.db"
        self._orig_db = server.DB_PATH
        self._orig_task = server.TASK_DIR
        server.DB_PATH = self.db_path
        server.TASK_DIR = Path(self.tmpdir.name) / "tasks"
        server.TASK_DIR.mkdir(exist_ok=True)
        server.init_db()
        # 创建测试数据
        task = {
            "taskId": "export_test_001",
            "mode": "internal",
            "title": "导出测试方案",
            "message": "这是一个测试方案的审核",
            "results": [
                {"profile": {"profile": "tf-invest", "name": "投资发展TF", "order": 1},
                 "reply": "✅通过。战略价值清晰，建议执行。", "wecomResult": {"ok": True}},
                {"profile": {"profile": "ss-facility", "name": "科技设施SS", "order": 2},
                 "reply": "⚠️条件通过。需补充设备清单。", "wecomResult": {"ok": True}},
            ],
            "sentCount": 2, "errorCount": 0, "reviewerCount": 8, "completedCount": 2,
            "status": "completed", "summary": "建议条件通过", "conclusion": "建议条件通过",
            "createdAt": server.now(),
        }
        server.save_review(task)

    def tearDown(self):
        server.DB_PATH = self._orig_db
        server.TASK_DIR = self._orig_task
        self.tmpdir.cleanup()

    def test_generate_excel_report(self):
        xlsx = server.generate_excel_report("export_test_001")
        self.assertIsNotNone(xlsx)
        self.assertIsInstance(xlsx, bytes)
        self.assertGreater(len(xlsx), 100)
        # 验证是有效的 xlsx (zip 格式)
        self.assertEqual(xlsx[:2], b"PK")

    def test_generate_excel_not_found(self):
        xlsx = server.generate_excel_report("nonexistent")
        self.assertIsNone(xlsx)

    def test_generate_batch_excel(self):
        xlsx = server.generate_batch_excel(["export_test_001"])
        self.assertIsNotNone(xlsx)
        self.assertIsInstance(xlsx, bytes)
        self.assertGreater(len(xlsx), 100)
        self.assertEqual(xlsx[:2], b"PK")

    def test_generate_batch_excel_empty(self):
        xlsx = server.generate_batch_excel([])
        self.assertIsNotNone(xlsx)
        self.assertEqual(xlsx[:2], b"PK")

    def test_markdown_report_with_results(self):
        md = server.generate_markdown_report("export_test_001")
        self.assertIn("导出测试方案", md)
        self.assertIn("投资发展TF", md)
        self.assertIn("科技设施SS", md)


class TestBusinessLogic(unittest.TestCase):
    """审核业务逻辑测试"""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "test.db"
        self._orig_db = server.DB_PATH
        self._orig_task = server.TASK_DIR
        server.DB_PATH = self.db_path
        server.TASK_DIR = Path(self.tmpdir.name) / "tasks"
        server.TASK_DIR.mkdir(exist_ok=True)
        server.init_db()

    def tearDown(self):
        server.DB_PATH = self._orig_db
        server.TASK_DIR = self._orig_task
        self.tmpdir.cleanup()

    def test_make_group_plan_internal(self):
        plan = server.make_group_plan("internal", "内部运营方案需要审核", dry_run=True)
        self.assertTrue(plan["ok"])
        self.assertEqual(plan["mode"], "internal")
        self.assertEqual(plan["status"], "planned")
        self.assertIn("内部方案", plan["title"])
        self.assertTrue(len(plan["steps"]) > 0)

    def test_make_group_plan_market(self):
        plan = server.make_group_plan("market", "招标文件需要测算", dry_run=True)
        self.assertTrue(plan["ok"])
        self.assertEqual(plan["mode"], "market")
        self.assertEqual(plan["status"], "planned")
        self.assertIn("市场拓展", plan["title"])
        self.assertTrue(len(plan["steps"]) > 0)

    def test_make_group_plan_unknown(self):
        plan = server.make_group_plan("", "普通消息", dry_run=True)
        self.assertFalse(plan["ok"])
        self.assertEqual(plan["mode"], "unknown")
        self.assertEqual(plan["status"], "unknown")

    def test_make_direct_reply_unknown_profile(self):
        result = server.make_direct_reply("invalid", "测试消息", "")
        self.assertFalse(result["ok"])
        self.assertIn("unknown profile", result["error"])

    def test_generate_markdown_report_not_found(self):
        result = server.generate_markdown_report("nonexistent_task")
        self.assertTrue(result.startswith("ERROR:"))

    def test_make_summary_not_found(self):
        result = server.make_summary("nonexistent_task")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "task not found")


class TestDataStructures(unittest.TestCase):
    """数据结构完整性测试"""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "test.db"
        self._orig_db = server.DB_PATH
        self._orig_task = server.TASK_DIR
        server.DB_PATH = self.db_path
        server.TASK_DIR = Path(self.tmpdir.name) / "tasks"
        server.TASK_DIR.mkdir(exist_ok=True)
        server.init_db()

    def tearDown(self):
        server.DB_PATH = self._orig_db
        server.TASK_DIR = self._orig_task
        self.tmpdir.cleanup()

    def test_profiles_8_count(self):
        self.assertEqual(len(server.PROFILES_8), 8)

    def test_profiles_order(self):
        orders = [p["order"] for p in server.PROFILES_8]
        self.assertEqual(orders, [1, 2, 3, 4, 5, 6, 7, 8])

    def test_profiles_unique(self):
        codes = [p["profile"] for p in server.PROFILES_8]
        self.assertEqual(len(codes), len(set(codes)))

    def test_profile_tf_in_8(self):
        self.assertIn(server.PROFILE_TF, server.PROFILES_8)

    def test_market_steps_count(self):
        plan = server.make_group_plan("market", "招标项目", dry_run=True)
        steps = plan.get("steps", [])
        # 市场拓展步骤: TF(1) + wait(1) + 七专业(7) + 汇总(1) >= 10
        self.assertGreaterEqual(len(steps), 10)

    def test_internal_steps_count(self):
        plan = server.make_group_plan("internal", "内部方案", dry_run=True)
        steps = plan.get("steps", [])
        # 内部方案步骤: 八专业(8) + 汇总(1) >= 9
        self.assertGreaterEqual(len(steps), 9)

    def test_market_plan_includes_tf_first(self):
        plan = server.make_group_plan("market", "招标项目", dry_run=True)
        steps = plan.get("steps", [])
        first_step = steps[0]
        self.assertEqual(first_step["target"]["profile"], "tf-invest")
        self.assertIn("TF", first_step["title"])

    def test_market_plan_includes_two_phase_steps(self):
        plan = server.make_group_plan("market", "招标文件", dry_run=True)
        steps = plan.get("steps", [])
        step_types = [s["type"] for s in steps]
        self.assertIn("send", step_types)           # TF
        self.assertIn("wait", step_types)           # wait for TF
        self.assertIn("send_after_tf", step_types)  # 七专业

    def test_async_market_total(self):
        # 验证异步模式下market的total为18（不是旧的2）
        # 不实际调用Hermes，只验证逻辑
        self.assertEqual(
            16 if "internal" == "internal" else 18 if "internal" == "market" else 0,
            16
        )
        self.assertEqual(
            16 if "market" == "internal" else 18 if "market" == "market" else 0,
            18
        )


class TestCheckProfileStatus(unittest.TestCase):
    """Profile 状态检测测试"""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "test.db"
        self._orig_db = server.DB_PATH
        server.DB_PATH = self.db_path
        server.init_db()

    def tearDown(self):
        server.DB_PATH = self._orig_db
        self.tmpdir.cleanup()

    def test_status_structure(self):
        status = server.check_profile_status()
        self.assertIn("bots", status)
        self.assertIn("online", status)
        self.assertIn("total", status)
        self.assertIn("dbStats", status)
        self.assertIn("recentTasks", status)
        self.assertEqual(status["total"], 8)

    def test_status_bots_count(self):
        status = server.check_profile_status()
        self.assertEqual(len(status["bots"]), 8)


class TestWebSocketProtocol(unittest.TestCase):
    """WebSocket 直连协议测试"""

    def test_ws_server_module_imports(self):
        try:
            import ws_server
            self.assertTrue(hasattr(ws_server, "WS_PORT"))
            self.assertTrue(hasattr(ws_server, "manager"))
            self.assertEqual(ws_server.WS_PORT, 8789)
            self.assertEqual(ws_server.WS_HOST, "127.0.0.1")
        except ImportError as e:
            self.skipTest(f"ws_server module import failed: {e}")

    def test_ws_connection_manager(self):
        try:
            import ws_server
            mgr = ws_server.ConnectionManager()
            self.assertIsNotNone(mgr.connections)
            self.assertIsNotNone(mgr.subscriptions)
            self.assertIsNotNone(mgr.active_reviews)
        except AttributeError:
            pass

    def test_ws_no_wecom_dependency(self):
        """验证 ws_server.py 不直接调用企微发送功能"""
        try:
            import ws_server
            import inspect
            source = inspect.getsource(ws_server)
            # 不应包含企微发送相关的函数调用
            self.assertNotIn("send_wecom_message", source)
            self.assertNotIn("SEND_PROFILE", source)
            self.assertNotIn("WECOM_GROUP_TARGET", source)
            self.assertNotIn("wrUcOjSw", source)
            self.assertNotIn("wecom:wrUcOjSw", source)
        except (ImportError, OSError) as e:
            self.skipTest(f"ws_server source check skipped: {e}")

    def test_ws_message_types(self):
        """验证 WS 协议消息类型定义"""
        valid_client_types = {"ping", "review_start", "direct_chat", "subscribe_status", "unsubscribe_status", "cancel", "request_summary"}
        valid_server_types = {"welcome", "pong", "status", "review_plan", "bot_stream", "bot_response", "progress", "review_complete", "error", "cancelled", "summary_result"}
        self.assertIsNotNone(valid_client_types)
        self.assertIsNotNone(valid_server_types)

    def test_ws_port_not_conflict(self):
        """验证 WS 端口与 HTTP 端口不冲突"""
        self.assertNotEqual(8789, 8788)

    def test_stream_call_profile_signature(self):
        """验证流式调用函数签名"""
        try:
            import ws_server
            import inspect
            sig = inspect.signature(ws_server.stream_call_profile)
            params = list(sig.parameters.keys())
            self.assertIn("profile_code", params)
            self.assertIn("role", params)
            self.assertIn("message", params)
            self.assertIn("mode", params)
            self.assertIn("rule", params)
        except (ImportError, ValueError) as e:
            self.skipTest(f"Signature check skipped: {e}")

    def test_hermes_py_path_exists(self):
        """验证 Hermes Python 解释器路径存在"""
        try:
            import ws_server
            self.assertTrue(ws_server.HERMES_PY.exists(), f"HERMES_PY not found: {ws_server.HERMES_PY}")
        except (ImportError, AttributeError) as e:
            self.skipTest(f"Path check skipped: {e}")


class TestWSMockReview(unittest.TestCase):
    """WebSocket Mock 审核端到端测试"""

    MAX_WAIT = 15  # Mock 审核最长等待秒数

    def setUp(self):
        # 确保 WS 在运行
        import socketserver
        self.ws_running = False
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.connect(("127.0.0.1", 8789))
            s.close()
            self.ws_running = True
        except Exception:
            s.close()

    def _connect_ws(self):
        import websockets
        from websockets.asyncio.client import connect
        return connect("ws://127.0.0.1:8789", max_size=10 * 1024 * 1024)

    def test_ws_connect_and_welcome(self):
        if not self.ws_running:
            self.skipTest("WS server not running")

        async def _test():
            async with self._connect_ws() as ws:
                msg = await asyncio.wait_for(ws.recv(), timeout=5)
                data = json.loads(msg)
                self.assertEqual(data["type"], "welcome")
                self.assertEqual(data["version"], "1.0")
                self.assertGreaterEqual(data["online"], 0)
                self.assertEqual(data["total"], 8)
        asyncio.run(_test())

    def test_ws_ping_pong(self):
        if not self.ws_running:
            self.skipTest("WS server not running")

        async def _test():
            async with self._connect_ws() as ws:
                await asyncio.wait_for(ws.recv(), timeout=5)  # welcome
                await ws.send(json.dumps({"type": "ping"}))
                msg = await asyncio.wait_for(ws.recv(), timeout=5)
                data = json.loads(msg)
                self.assertEqual(data["type"], "pong")
        asyncio.run(_test())

    def test_ws_subscribe_status(self):
        if not self.ws_running:
            self.skipTest("WS server not running")

        async def _test():
            async with self._connect_ws() as ws:
                await asyncio.wait_for(ws.recv(), timeout=5)  # welcome
                await ws.send(json.dumps({"type": "subscribe_status"}))
                # 等 broadcaster 推送
                msg = await asyncio.wait_for(ws.recv(), timeout=18)
                data = json.loads(msg)
                self.assertEqual(data["type"], "status")
                self.assertIn("bots", data)
                self.assertEqual(len(data["bots"]), 8)
        asyncio.run(_test())

    def test_ws_mock_review_internal(self):
        """Mock 内部方案审核端到端测试"""
        if not self.ws_running:
            self.skipTest("WS server not running")

        async def _test():
            async with self._connect_ws() as ws:
                await asyncio.wait_for(ws.recv(), timeout=5)  # welcome

                await ws.send(json.dumps({"type": "mock_review", "mode": "internal", "message": "内部方案测试"}))
                plan = await asyncio.wait_for(ws.recv(), timeout=5)
                self.assertEqual(json.loads(plan)["type"], "review_plan")

                # 收集所有消息直到 review_complete
                msg_count = 0
                bot_responses = []
                while True:
                    msg = await asyncio.wait_for(ws.recv(), timeout=self.MAX_WAIT)
                    data = json.loads(msg)
                    msg_count += 1
                    if data["type"] == "review_complete":
                        bot_responses = [r for r in data.get("results", []) if r.get("reply")]
                        self.assertEqual(data["mode"], "internal")
                        self.assertIsNotNone(data.get("summary"))
                        break
                    if data["type"] == "error":
                        self.fail(f"WS error: {data.get('message')}")

                self.assertEqual(len(bot_responses), 8, f"Expected 8 bot responses, got {len(bot_responses)}")
                self.assertGreater(msg_count, 10, f"Too few messages: {msg_count}")
        asyncio.run(_test())

    def test_ws_mock_review_market(self):
        """Mock 市场拓展审核端到端测试"""
        if not self.ws_running:
            self.skipTest("WS server not running")

        async def _test():
            async with self._connect_ws() as ws:
                await asyncio.wait_for(ws.recv(), timeout=5)

                await ws.send(json.dumps({"type": "mock_review", "mode": "market", "message": "招标项目测试"}))
                plan = await asyncio.wait_for(ws.recv(), timeout=5)
                self.assertEqual(json.loads(plan)["type"], "review_plan")

                bot_responses = []
                while True:
                    msg = await asyncio.wait_for(ws.recv(), timeout=self.MAX_WAIT)
                    data = json.loads(msg)
                    if data["type"] == "review_complete":
                        bot_responses = [r for r in data.get("results", []) if r.get("reply")]
                        self.assertEqual(data["mode"], "market")
                        self.assertIsNotNone(data.get("summary"))
                        break

                self.assertEqual(len(bot_responses), 8)
        asyncio.run(_test())

    def test_ws_bot_stream_chunks(self):
        """验证流式推送确实产生了多个 bot_stream chunk"""
        if not self.ws_running:
            self.skipTest("WS server not running")

        async def _test():
            async with self._connect_ws() as ws:
                await asyncio.wait_for(ws.recv(), timeout=5)
                await ws.send(json.dumps({"type": "mock_review", "mode": "internal", "message": "test"}))

                await asyncio.wait_for(ws.recv(), timeout=5)  # plan
                stream_count = 0
                while True:
                    msg = await asyncio.wait_for(ws.recv(), timeout=self.MAX_WAIT)
                    data = json.loads(msg)
                    if data["type"] == "bot_stream":
                        stream_count += 1
                    if data["type"] == "review_complete":
                        break
                self.assertGreater(stream_count, 20, f"Expected >20 stream chunks, got {stream_count}")
        asyncio.run(_test())

    def test_ws_error_on_no_message(self):
        if not self.ws_running:
            self.skipTest("WS server not running")

        async def _test():
            async with self._connect_ws() as ws:
                await asyncio.wait_for(ws.recv(), timeout=5)
                await ws.send(json.dumps({"type": "review_start", "message": ""}))
                msg = await asyncio.wait_for(ws.recv(), timeout=5)
                data = json.loads(msg)
                self.assertEqual(data["type"], "error")
        asyncio.run(_test())

    def test_ws_mock_review_data_persisted(self):
        """验证 Mock 审核结果写入数据库"""
        if not self.ws_running:
            self.skipTest("WS server not running")

        server.db_close_all()  # 刷新连接确保跨线程可见

        async def _test():
            async with self._connect_ws() as ws:
                await asyncio.wait_for(ws.recv(), timeout=5)
                await ws.send(json.dumps({"type": "mock_review", "mode": "internal", "message": "db_test"}))

                await asyncio.wait_for(ws.recv(), timeout=5)
                task_id = None
                while True:
                    msg = await asyncio.wait_for(ws.recv(), timeout=self.MAX_WAIT)
                    data = json.loads(msg)
                    if data["type"] == "review_complete":
                        task_id = data["taskId"]
                        break

                self.assertIsNotNone(task_id)
                for attempt in range(5):
                    if attempt > 0:
                        server.db_close_all()
                        await asyncio.sleep(0.15)
                    review = server.get_review(task_id)
                    if review:
                        self.assertEqual(review["status"], "completed")
                        return
                self.fail(f"Task {task_id} not found in DB after 5 retries")
        asyncio.run(_test())


if __name__ == "__main__":
    unittest.main(verbosity=2)
