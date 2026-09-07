import importlib.util
import pathlib
import unittest

from daily_reconciliation_probe import is_daily_body_ready, merge_daily_rows, parse_daily_report_body, set_daily_parameters

probe_path = pathlib.Path(__file__).parents[1] / 'scripts' / 'probe-fine-report-daily-reconciliation.py'
probe_spec = importlib.util.spec_from_file_location('fine_report_daily_reconciliation_probe', probe_path)
assert probe_spec and probe_spec.loader
fine_report_probe = importlib.util.module_from_spec(probe_spec)
probe_spec.loader.exec_module(fine_report_probe)


class DailyReconciliationProbeTests(unittest.TestCase):
    def test_rendered_date_accepts_finereport_chinese_prefix_without_separator(self):
        self.assertEqual(
            fine_report_probe._rendered_cutoff_dates('第一服务华北日报\t数据截止日期2026-08-28'),
            {'2026-08-28'},
        )

    def test_query_wait_rejects_ready_prior_date_until_requested_report_changes(self):
        def report(date):
            return (
                f'第一服务华北地区各服务中心计划预算回款日报\t数据截止日期{date}\n累计执行1万\n'
                + ('第一服务测试服务中心\n' * 100)
                + ('X' * 1200)
            )

        prior = report('2026-08-27')
        requested = report('2026-08-28')

        class Body:
            def __init__(self, page): self.page = page
            def inner_text(self):
                value = self.page.bodies[min(self.page.index, len(self.page.bodies) - 1)]
                self.page.index += 1
                return value

        class Triggers:
            def evaluate_all(self, _script): return ['2026-08-28', '华北地区', '2026-08-28']

        class Page:
            def __init__(self): self.bodies = [prior, requested]; self.index = 0; self.waits = 0
            def locator(self, selector): return Body(self) if selector == 'body' else Triggers()
            def wait_for_timeout(self, _milliseconds): self.waits += 1

        page = Page()
        page.bodies = [requested, '', requested]
        body = fine_report_probe.wait_for_queried_report(page, '2026-08-28', prior, timeout_seconds=3, poll_ms=1)
        self.assertEqual(body, requested)
        self.assertEqual(page.waits, 3)

    def test_query_wait_rejects_target_date_outside_authoritative_cutoff_label(self):
        initial = (
            '第一服务华北地区各服务中心计划预算回款日报\t数据截止日期2026-08-27\n累计执行1万\n'
            + ('第一服务测试服务中心\n' * 100) + ('X' * 1200)
        )
        changed = (
            '第一服务华北地区各服务中心计划预算回款日报\n'
            '报表日期：2026-08-28\n累计执行1万\n'
            + ('第一服务测试服务中心\n' * 100) + ('Y' * 1200)
        )

        class Body:
            def __init__(self, page): self.page = page
            def inner_text(self):
                value = self.page.bodies[min(self.page.index, len(self.page.bodies) - 1)]
                self.page.index += 1
                return value

        class Triggers:
            def evaluate_all(self, _script): return ['2026-08-28', '华北地区', '2026-08-28']

        class Page:
            def __init__(self): self.bodies = ['', changed]; self.index = 0
            def locator(self, selector): return Body(self) if selector == 'body' else Triggers()
            def wait_for_timeout(self, _milliseconds): pass

        with self.assertRaisesRegex(RuntimeError, '已确认日期为2026-08-28'):
            fine_report_probe.wait_for_queried_report(Page(), '2026-08-28', initial, timeout_seconds=2, poll_ms=1000)

    def test_only_north_daily_body_is_ready(self):
        north = '第一服务华北地区各服务中心计划预算回款日报\n累计执行\n' + ('第一服务测试服务中心\n' * 100)
        south = north.replace('华北地区', '华南地区')
        self.assertTrue(is_daily_body_ready(north))
        self.assertFalse(is_daily_body_ready(south))

    def test_parameter_update_uses_single_submit_contract(self):
        events = []

        class Item:
            def __init__(self, value=''):
                self.value = value
            def input_value(self): return self.value
            def fill(self, value): self.value = value; events.append(('fill', value))
            def press(self, key): events.append(('press', key))
            def locator(self, selector): return Clicker(('dropdown', selector))

        class Clicker:
            def __init__(self, event, callback=None): self.event = event; self.callback = callback
            def click(self):
                events.append(self.event)
                if self.callback: self.callback()

        class Items:
            def __init__(self, items): self.items = items
            def count(self): return len(self.items)
            def nth(self, index): return self.items[index]
            def evaluate_all(self, _script): return [item.value for item in self.items]
            def filter(self, **_kwargs): return self
            @property
            def last(self): return Clicker(('option', '华北地区'))

        class Options(Items):
            def __init__(self, region): super().__init__([]); self.region = region
            @property
            def last(self): return Clicker(('option', '华北地区'), lambda: setattr(self.region, 'value', '华北地区'))

        class Keyboard:
            def press(self, key): events.append(('keyboard', key))

        class Page:
            keyboard = Keyboard()
            triggers = Items([Item('2026-08-30'), Item('华南地区'), Item('2026-08-30')])
            options = Options(triggers.items[1])
            def locator(self, selector):
                return self.triggers if selector == '.fr-trigger-texteditor' else self.options
            def wait_for_timeout(self, milliseconds): events.append(('wait', milliseconds))

        values = set_daily_parameters(Page(), '2026-08-28')
        self.assertEqual(values, ['2026-08-28', '华北地区', '2026-08-28'])
        self.assertNotIn(('press', 'Enter'), events)
        self.assertIn(('option', '华北地区'), events)

    def test_parses_official_total_and_center_rows_without_cumulative_fields(self):
        body = """第一服务华北地区各服务中心计划预算回款日报
累计执行13,860.48万
本日回款总额45.57万元
累计完成率\t累计预算\t累计执行\t本日回款
第一服务北京满庭芳园服务中心
\t80%\t100.00\t80.00\t0\t0\t0\t10.25
第一服务北京青云大厦服务中心
\t70%\t50.00\t35.00\t0\t0\t0\t2.75
"""
        official_total, rows = parse_daily_report_body(body)
        self.assertEqual(official_total, 45.57)
        self.assertEqual(rows, [
            {'center': '第一服务北京满庭芳园服务中心', 'dailyCollection': 10.25},
            {'center': '第一服务北京青云大厦服务中心', 'dailyCollection': 2.75},
        ])
        self.assertNotIn('cumulativeExecuted', rows[0])

    def test_merges_source_centers_to_canonical_daily_only_rows(self):
        merged = merge_daily_rows([
            {'center': '第一服务北京满庭芳园服务中心', 'dailyCollection': 10.25},
            {'center': '第一服务北京青云大厦服务中心', 'dailyCollection': 2.75},
            {'center': '第一服务其他服务中心', 'dailyCollection': -1.0},
        ])
        self.assertEqual(merged, [
            {'center': '第一服务其他服务中心', 'dailyCollection': -1.0},
            {'center': '第一服务满庭青云服务中心', 'dailyCollection': 13.0},
        ])

    def test_small_official_detail_difference_is_preserved_for_human_confirmation(self):
        summary = fine_report_probe.summarize_daily_totals(10.03, [
            {'center': 'A', 'dailyCollection': 6.0},
            {'center': 'B', 'dailyCollection': 4.0},
        ])
        self.assertEqual(summary, {'detailTotal': 10.0, 'totalDifference': 0.03})


if __name__ == '__main__':
    unittest.main()
