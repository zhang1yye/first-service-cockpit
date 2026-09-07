import unittest

from finereport_eval import reconcile_rounded_card_precision


class ReconcileRoundedCardPrecisionTest(unittest.TestCase):
    def test_uses_detail_precision_only_when_same_integer_value(self):
        self.assertEqual(reconcile_rounded_card_precision(14575.0, 14574.97), 14574.97)
        self.assertEqual(reconcile_rounded_card_precision(12917.0, 12917.13), 12917.13)

    def test_keeps_card_for_different_scope(self):
        self.assertEqual(reconcile_rounded_card_precision(25069.0, 26731.52), 25069.0)
        self.assertEqual(reconcile_rounded_card_precision(14276.0, 13637.0), 14276.0)

    def test_keeps_existing_card_precision_and_missing_detail(self):
        self.assertEqual(reconcile_rounded_card_precision(14574.91, 14574.97), 14574.91)
        self.assertEqual(reconcile_rounded_card_precision(14575.0, None), 14575.0)


if __name__ == '__main__':
    unittest.main()
