import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from finereport_daily import is_daily_body_ready


class DailyBodyReadyTests(unittest.TestCase):
    def test_rejects_south_report_even_when_parameter_contains_north(self):
        body = (
            "华北地区\n"
            "第一服务华南地区各服务中心计划预算回款日报\n"
            "累计执行14,295.30万\n" + "第一服务华南中心\n" * 20
        )
        self.assertFalse(is_daily_body_ready(body))

    def test_rejects_transitional_empty_page(self):
        self.assertFalse(is_daily_body_ready("华北地区\n查询\n加载中"))

    def test_accepts_fully_rendered_north_report(self):
        body = (
            "第一服务华北地区各服务中心计划预算回款日报\n"
            "累计执行12,557.64万\n" + "第一服务北京中心\n" * 20 + "X" * 1200
        )
        self.assertTrue(is_daily_body_ready(body))


if __name__ == "__main__":
    unittest.main()
