import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "rollback_r160_publication_mode.py"


class RollbackPublicationModeTests(unittest.TestCase):
    def test_rolls_back_empty_mode_column_and_preserves_snapshot_rows(self):
        with tempfile.NamedTemporaryFile(suffix=".db") as file:
            connection = sqlite3.connect(file.name)
            connection.executescript("""
              CREATE TABLE daily_collection_reconciliations(id INTEGER PRIMARY KEY,business_date TEXT NOT NULL,publication_mode TEXT NOT NULL DEFAULT 'snapshot_revision',payload_sha256 TEXT NOT NULL UNIQUE,status TEXT NOT NULL);
              INSERT INTO daily_collection_reconciliations VALUES(1,'2026-08-25','snapshot_revision','abc','published');
            """)
            connection.commit()
            connection.close()
            result = subprocess.run([sys.executable, str(SCRIPT), file.name], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            connection = sqlite3.connect(file.name)
            columns = [row[1] for row in connection.execute("PRAGMA table_info(daily_collection_reconciliations)")]
            self.assertNotIn("publication_mode", columns)
            self.assertEqual(connection.execute("SELECT id,business_date,status FROM daily_collection_reconciliations").fetchall(), [(1, "2026-08-25", "published")])
            connection.close()

    def test_refuses_rollback_while_daily_only_rows_exist(self):
        with tempfile.NamedTemporaryFile(suffix=".db") as file:
            connection = sqlite3.connect(file.name)
            connection.executescript("""
              CREATE TABLE daily_collection_reconciliations(id INTEGER PRIMARY KEY,publication_mode TEXT NOT NULL DEFAULT 'snapshot_revision');
              INSERT INTO daily_collection_reconciliations VALUES(1,'daily_only');
            """)
            connection.commit()
            connection.close()
            result = subprocess.run([sys.executable, str(SCRIPT), file.name], text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("daily_only", result.stderr)


if __name__ == "__main__":
    unittest.main()
