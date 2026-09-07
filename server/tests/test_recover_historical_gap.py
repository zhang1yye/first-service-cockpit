import importlib.util
import pathlib
import unittest

MODULE_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "recover_historical_gap.py"
SPEC = importlib.util.spec_from_file_location("recover_historical_gap", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class HistoricalGapRecoveryTest(unittest.TestCase):
    def payload(self):
        rows = []
        for sources, _target in MODULE.MERGE_GROUPS:
            rows.extend({"center": center, "dailyCollection": 1.0} for center in sources)
        used = {row["center"] for row in rows}
        for index in range(56 - len(MODULE.MERGE_GROUPS)):
            center = f"普通中心{index:02d}"
            if center not in used:
                rows.append({"center": center, "dailyCollection": 1.0})
        self.assertEqual(len(rows), 61)
        return {"schemaVersion": 1, "reportId": MODULE.REPORT_ID, "region": MODULE.REPORT_REGION, "rows": rows}

    def test_canonical_daily_merges_61_sources_to_56_without_inventing_amounts(self):
        result = MODULE.canonical_daily(self.payload())
        self.assertEqual(len(result), 56)
        self.assertEqual(round(sum(result.values()), 2), 61.0)
        for sources, target in MODULE.MERGE_GROUPS:
            self.assertEqual(result[target], float(len(sources)))

    def test_canonical_daily_rejects_incomplete_merge_group(self):
        payload = self.payload()
        payload["rows"] = payload["rows"][1:]
        with self.assertRaisesRegex(ValueError, "61条"):
            MODULE.canonical_daily(payload)

    def test_javascript_json_normalizes_integral_floats_for_persisted_equality(self):
        value = [{"received": 1.0, "rate": 0.75, "nested": [2.0]}]
        self.assertEqual(MODULE.javascript_json(value), [{"received": 1, "rate": 0.75, "nested": [2]}])

    def test_publish_confirmation_is_explicit(self):
        self.assertEqual(MODULE.CONFIRMATION, "确认补发历史缺口并保留当前数据")


if __name__ == "__main__":
    unittest.main()
