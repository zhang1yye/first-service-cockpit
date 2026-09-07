import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "sync_aph_to_root.py"
spec = importlib.util.spec_from_file_location("sync_aph_to_root", SCRIPT)
if spec is None or spec.loader is None:
    raise RuntimeError(f"无法加载脚本：{SCRIPT}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def valid_snapshot():
    return {
        "华北地区": {"回款额": {
            "年度预算_万": 25069.0,
            "累计预算_万": 14575.0,
            "累计执行_万": 12996.08,
            "同期执行_万": 14276.0,
            "增幅": -9.0,
        }},
        "date": "2026-08-07",
        "businessDate": "2026-08-07",
        "sourceStatus": "available",
        "source": "FineReport回款额执行评估·华北地区卡片",
        "fieldProvenance": {
            "年度预算_万": "华北地区卡片/年度预算",
            "累计预算_万": "华北地区卡片/累计预算",
            "累计执行_万": "华北地区卡片/累计执行",
            "同期执行_万": "华北地区卡片/同期执行",
            "增幅": "华北地区卡片/增幅并经公式勾稽",
        },
        "sourceLayers": {
            "regionCard": {
                "source": "FineReport回款额执行评估·华北地区卡片",
                "businessDate": "2026-08-07",
                "values": {
                    "annualBudget": 25069.0,
                    "cumulativeBudget": 14575.0,
                    "cumulativeExecuted": 12996.0,
                    "samePeriod": 14276.0,
                    "growthPercent": -9.0,
                },
            }
        },
        "reconciliations": {
            "annualBudgetCardVsWeekly": {"leftValue": 25069.0, "rightValue": 25884.52, "status": "warning"},
            "annualBudgetCardVsCenterDetail": {"leftValue": 25069.0, "rightValue": 26731.52, "status": "warning"},
            "samePeriodCardVsCenterDetail": {"leftValue": 14276.0, "rightValue": 13637.0, "status": "warning"},
        },
    }


class SyncAphToRootTest(unittest.TestCase):
    def test_publishes_region_card_without_replacing_it_with_detail_totals(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / "source.json", root / "target.json"
            source.write_text(json.dumps(valid_snapshot(), ensure_ascii=False), encoding="utf-8")
            values = module.publish_snapshot(source, target, "2026-08-07")
            published = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(values["annualBudget"], 25069.0)
            self.assertEqual(values["samePeriod"], 14276.0)
            self.assertEqual(published["华北地区"]["回款额"]["年度预算_万"], 25069.0)
            self.assertEqual(published["reconciliations"]["samePeriodCardVsCenterDetail"]["status"], "warning")

    def test_rejects_fabricated_reconciliation_and_preserves_existing_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / "source.json", root / "target.json"
            snapshot = valid_snapshot()
            snapshot["reconciliations"]["samePeriodCardVsCenterDetail"] = {"status": "ok"}
            source.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
            target.write_text('{"keep":true}', encoding="utf-8")
            with self.assertRaises(ValueError):
                module.publish_snapshot(source, target, "2026-08-07")
            self.assertEqual(target.read_text(encoding="utf-8"), '{"keep":true}')

    def test_rejects_top_level_value_that_disagrees_with_region_card_layer(self):
        snapshot = valid_snapshot()
        snapshot["华北地区"]["回款额"]["同期执行_万"] = 13637.0
        with self.assertRaisesRegex(ValueError, "samePeriod"):
            module.validate_snapshot(snapshot, "2026-08-07")


if __name__ == "__main__":
    unittest.main()
