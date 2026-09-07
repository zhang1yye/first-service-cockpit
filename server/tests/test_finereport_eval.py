import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))

from finereport_eval import parse_region_kpi, is_growth_consistent


LIVE_TEXT = '''
华北地区\t12,709
\t年度
预算\t25,069\t累计
预算\t14,575
\t年度
完成率\t累计
完成率\t同期
执行\t增幅
\t51%\t87%\t14,276\t-11%
\t西北地区\t10,270
\t年度
预算\t22,578\t累计
预算\t12,107
\t年度
完成率\t累计
完成率\t同期
执行\t增幅
\t45%\t85%\t12,074\t-15%
'''


class FineReportEvalParserTests(unittest.TestCase):
    def test_parses_huabei_same_period_without_crossing_into_next_region(self):
        result = parse_region_kpi(LIVE_TEXT, '华北地区')
        self.assertEqual(result['cumulative_executed'], 12709.0)
        self.assertEqual(result['annual_budget'], 25069.0)
        self.assertEqual(result['cumulative_budget'], 14575.0)
        self.assertEqual(result['annual_rate'], 51.0)
        self.assertEqual(result['cumulative_rate'], 87.0)
        self.assertEqual(result['same_period'], 14276.0)
        self.assertEqual(result['growth'], -11.0)
        self.assertTrue(is_growth_consistent(result))

    def test_rejects_wrong_same_period_even_when_number_is_nearby(self):
        result = parse_region_kpi(LIVE_TEXT, '华北地区')
        result['same_period'] = 10270.0
        self.assertFalse(is_growth_consistent(result))

    def test_returns_none_when_region_is_missing(self):
        self.assertIsNone(parse_region_kpi('华南地区 1,000', '华北地区'))


if __name__ == '__main__':
    unittest.main()
