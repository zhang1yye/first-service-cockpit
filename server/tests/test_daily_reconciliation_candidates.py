import importlib.util
import pathlib
import sqlite3
import tempfile
import unittest

MODULE_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "daily_reconciliation_candidates.py"
SPEC = importlib.util.spec_from_file_location("daily_reconciliation_candidates", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class DailyReconciliationCandidateTests(unittest.TestCase):
    def test_daily_mode_selects_latest_formal_business_date_before_today_across_weekend(self):
        connection = sqlite3.connect(":memory:")
        connection.executescript("""
          CREATE TABLE daily_snapshots(date TEXT,center TEXT);
          CREATE TABLE daily_collection_reconciliations(id INTEGER PRIMARY KEY,business_date TEXT,status TEXT,source_row_count INTEGER,publication_mode TEXT,report_id TEXT,extracted_at TEXT,official_total REAL,detail_total REAL,supersedes_id INTEGER);
          CREATE TABLE daily_collection_revision_rows(reconciliation_id INTEGER,center TEXT,new_daily_collection REAL,old_daily_collection REAL,old_cumulative_budget REAL,old_cumulative_executed REAL,old_last_validated_at TEXT,old_field_provenance TEXT);
          CREATE TABLE payment_centers(center TEXT);
          CREATE TABLE data_ingestion_batches(id INTEGER PRIMARY KEY,business_date TEXT,status TEXT,batch_sha256 TEXT,published_at TEXT);
          CREATE TABLE data_ingestion_publications(batch_id INTEGER PRIMARY KEY,business_date TEXT,backup_sha256 TEXT,published_at TEXT,payment_rows INTEGER,snapshot_rows INTEGER,collection_rows INTEGER);
          CREATE TABLE data_ingestion_rows(batch_id INTEGER,entity_type TEXT);
          INSERT INTO data_ingestion_batches VALUES(1,'2026-08-28','published',printf('%064d',1),'2026-08-28 17:30:00');
          INSERT INTO data_ingestion_publications VALUES(1,'2026-08-28',printf('%064d',9),'2026-08-28 17:31:00',56,56,35);
          INSERT INTO data_ingestion_batches VALUES(2,'2026-08-29','published',printf('%064d',2),'2026-08-29 17:30:00');
          INSERT INTO data_ingestion_publications VALUES(2,'2026-08-28',printf('%064d',9),'2026-08-29 17:31:00',56,56,35);
          INSERT INTO data_ingestion_batches VALUES(3,'2026-08-30','published',printf('%064d',3),'2026-08-30 17:30:00');
          INSERT INTO data_ingestion_publications VALUES(3,'2026-08-30','short','2026-08-30 17:31:00',56,56,35);
          INSERT INTO data_ingestion_batches VALUES(4,'2026-09-01','published',printf('%064d',4),'2026-09-01 17:30:00');
          INSERT INTO data_ingestion_publications VALUES(4,'2026-09-01',printf('%064d',9),'',56,56,35);
          INSERT INTO data_ingestion_batches VALUES(5,'2026-09-02','published',printf('%064d',5),'2026-09-02 17:30:00');
          INSERT INTO data_ingestion_publications VALUES(5,'2026-09-02',printf('%064d',9),'2026-09-02 17:31:00',56,56,36);
        """)
        for batch_id in range(1, 6):
            collection_count = 36 if batch_id == 5 else 35
            for entity_type, count in (("payment_center", 56), ("daily_snapshot", 56), ("collection_center", collection_count)):
                connection.executemany(
                    "INSERT INTO data_ingestion_rows VALUES(?,?)",
                    [(batch_id, entity_type) for _ in range(count)],
                )
        for date in ("2026-08-28", "2026-08-29", "2026-08-30", "2026-09-01", "2026-09-02"):
            connection.executemany("INSERT INTO daily_snapshots VALUES(?,?)", [(date, f"C{i}") for i in range(56)])
        MODULE.ensure_attempt_table(connection)
        self.assertEqual(MODULE.select_latest_formal_candidate(connection, "2026-09-05", connection), ["2026-08-28"])
        connection.close()

    def test_filters_illegal_snapshot_cardinality(self):
        connection = sqlite3.connect(":memory:")
        connection.executescript("""
          CREATE TABLE daily_snapshots(date TEXT,center TEXT);
          CREATE TABLE daily_collection_reconciliations(id INTEGER PRIMARY KEY,business_date TEXT,status TEXT,source_row_count INTEGER,publication_mode TEXT,report_id TEXT,extracted_at TEXT,official_total REAL,detail_total REAL,supersedes_id INTEGER);
          CREATE TABLE daily_collection_revision_rows(reconciliation_id INTEGER,center TEXT,new_daily_collection REAL,old_daily_collection REAL,old_cumulative_budget REAL,old_cumulative_executed REAL,old_last_validated_at TEXT,old_field_provenance TEXT);
          CREATE TABLE payment_centers(center TEXT);
          INSERT INTO daily_snapshots VALUES('2026-06-15','garbage');
        """)
        self.assertEqual(MODULE.select_candidates(connection, "2026-06-15", 5), [])
        connection.close()

    def test_failed_date_is_quarantined_after_bounded_retries_and_later_date_advances(self):
        connection = sqlite3.connect(":memory:")
        connection.executescript("""
          CREATE TABLE daily_snapshots(date TEXT,center TEXT);
          CREATE TABLE daily_collection_reconciliations(id INTEGER PRIMARY KEY,business_date TEXT,status TEXT,source_row_count INTEGER,publication_mode TEXT,report_id TEXT,extracted_at TEXT,official_total REAL,detail_total REAL,supersedes_id INTEGER);
          CREATE TABLE daily_collection_revision_rows(reconciliation_id INTEGER,center TEXT,new_daily_collection REAL,old_daily_collection REAL,old_cumulative_budget REAL,old_cumulative_executed REAL,old_last_validated_at TEXT,old_field_provenance TEXT);
          CREATE TABLE payment_centers(center TEXT);
        """)
        for date in ("2026-06-15", "2026-06-16"):
            connection.executemany("INSERT INTO daily_snapshots VALUES(?,?)", [(date, f"C{i}") for i in range(56)])
        MODULE.ensure_attempt_table(connection)
        for _ in range(3):
            MODULE.record_attempt(connection, "2026-06-15", "failed", "fixture failure", 3)
        self.assertEqual(MODULE.select_candidates(connection, "2026-06-15", 5, 3), ["2026-06-16"])
        self.assertEqual(MODULE.manual_review_dates(connection), [{"businessDate": "2026-06-15", "attempts": 3, "lastError": "fixture failure"}])
        connection.close()

    def test_selects_all_existing_unpublished_dates_from_june_15_in_bounded_batches(self):
        with tempfile.NamedTemporaryFile(suffix=".db") as file:
            connection = sqlite3.connect(file.name)
            connection.executescript("""
              CREATE TABLE daily_snapshots(id INTEGER PRIMARY KEY,date TEXT,center TEXT,quality_status TEXT,source_status TEXT,business_date TEXT,daily_collection REAL,cumulative_budget REAL,cumulative_executed REAL,last_validated_at TEXT,field_provenance TEXT);
              CREATE TABLE daily_collection_reconciliations(id INTEGER PRIMARY KEY,business_date TEXT,status TEXT,source_row_count INTEGER,publication_mode TEXT,report_id TEXT,extracted_at TEXT,official_total REAL,detail_total REAL,supersedes_id INTEGER,zero_value_confirmed INTEGER DEFAULT 0);
              CREATE TABLE daily_collection_revision_rows(id INTEGER PRIMARY KEY,reconciliation_id INTEGER,center TEXT,old_daily_collection REAL,new_daily_collection REAL,old_cumulative_budget REAL,old_cumulative_executed REAL,old_last_validated_at TEXT,old_field_provenance TEXT DEFAULT '{}');
              CREATE TABLE payment_centers(center TEXT PRIMARY KEY);
            """)
            for date, count in (("2026-06-14", 56), ("2026-06-15", 61), ("2026-06-17", 59), ("2026-06-22", 56), ("2026-08-03", 56), ("2026-08-26", 56)):
                connection.executemany(
                    "INSERT INTO daily_snapshots(date,center,quality_status,source_status,business_date) VALUES(?,?,?,?,?)",
                    [(date, f"{date}-legacy-{index}", "unverified", "unverified", None) for index in range(count)],
                )
            connection.execute("INSERT INTO daily_collection_reconciliations VALUES(1,'2026-08-26','published',61,'daily_only','810ca5a0-b239-466b-85c2-386373244c8e','2026-08-27T08:00:00+08:00',0,0,NULL,1)")
            connection.executemany("INSERT INTO payment_centers(center) VALUES(?)", [(f"C{index}",) for index in range(56)])
            connection.executemany("INSERT INTO daily_collection_revision_rows(reconciliation_id,center,new_daily_collection) VALUES(1,?,0)", [(f"C{index}",) for index in range(56)])
            connection.commit()
            self.assertEqual(MODULE.select_candidates(connection, "2026-06-15", 2), ["2026-06-15", "2026-06-17"])
            self.assertEqual(MODULE.select_candidates(connection, "2026-06-15", 20), ["2026-06-15", "2026-06-17", "2026-06-22", "2026-08-03"])
            connection.execute("UPDATE daily_collection_reconciliations SET zero_value_confirmed=0 WHERE id=1")
            self.assertIn("2026-08-26", MODULE.select_candidates(connection, "2026-06-15", 20))
            connection.close()

    def test_requeues_snapshot_revision_when_current_snapshot_gate_is_degraded(self):
        with tempfile.NamedTemporaryFile(suffix=".db") as file:
            connection = sqlite3.connect(file.name)
            connection.executescript("""
              CREATE TABLE daily_snapshots(id INTEGER PRIMARY KEY,date TEXT,center TEXT,quality_status TEXT,source_status TEXT,business_date TEXT,daily_collection REAL,cumulative_budget REAL,cumulative_executed REAL,last_validated_at TEXT,field_provenance TEXT);
              CREATE TABLE daily_collection_reconciliations(id INTEGER PRIMARY KEY,business_date TEXT,status TEXT,source_row_count INTEGER,publication_mode TEXT,report_id TEXT,extracted_at TEXT,official_total REAL,detail_total REAL,supersedes_id INTEGER);
              CREATE TABLE daily_collection_revision_rows(id INTEGER PRIMARY KEY,reconciliation_id INTEGER,center TEXT,old_daily_collection REAL,new_daily_collection REAL,old_cumulative_budget REAL,old_cumulative_executed REAL,old_last_validated_at TEXT,old_field_provenance TEXT DEFAULT '{}');
              CREATE TABLE payment_centers(center TEXT PRIMARY KEY);
              INSERT INTO daily_collection_reconciliations VALUES(1,'2026-08-25','published',61,'snapshot_revision','810ca5a0-b239-466b-85c2-386373244c8e','2026-08-26T08:00:00+08:00',56,56,NULL);
            """)
            for index in range(56):
                center = f"C{index}"
                provenance = '{"daily_collection":{"reportId":"810ca5a0-b239-466b-85c2-386373244c8e","businessDate":"2026-08-25","extractedAt":"2026-08-26T08:00:00+08:00","dailyReconciliationId":1}}'
                connection.execute("INSERT INTO payment_centers VALUES(?)", (center,))
                connection.execute(
                    "INSERT INTO daily_snapshots(date,center,quality_status,source_status,business_date,daily_collection,cumulative_budget,cumulative_executed,last_validated_at,field_provenance) VALUES('2026-08-25',?,'verified','available','2026-08-25',1,10,20,'2026-08-26T08:00:00+08:00',?)",
                    (center, provenance),
                )
                connection.execute(
                    "INSERT INTO daily_collection_revision_rows(reconciliation_id,center,old_daily_collection,new_daily_collection,old_cumulative_budget,old_cumulative_executed,old_last_validated_at,old_field_provenance) VALUES(1,?,0,1,10,20,'old','{}')",
                    (center,),
                )
            connection.commit()
            self.assertTrue(MODULE.has_current_published(connection, "2026-08-25"))

            connection.execute("UPDATE daily_snapshots SET field_provenance='{}' WHERE center='C0'")
            connection.commit()
            self.assertFalse(MODULE.has_current_published(connection, "2026-08-25"))
            self.assertEqual(MODULE.select_candidates(connection, "2026-06-15", 5), ["2026-08-25"])
            connection.close()

    def test_confirmed_bounded_difference_is_a_valid_published_head(self):
        connection = sqlite3.connect(":memory:")
        connection.executescript("""
          CREATE TABLE daily_snapshots(date TEXT,center TEXT);
          CREATE TABLE daily_collection_reconciliations(
            id INTEGER PRIMARY KEY,business_date TEXT,status TEXT,source_row_count INTEGER,
            publication_mode TEXT,report_id TEXT,extracted_at TEXT,official_total REAL,detail_total REAL,
            supersedes_id INTEGER,zero_value_confirmed INTEGER DEFAULT 0,total_difference_confirmed INTEGER DEFAULT 0);
          CREATE TABLE daily_collection_revision_rows(
            reconciliation_id INTEGER,center TEXT,new_daily_collection REAL,old_daily_collection REAL,
            old_cumulative_budget REAL,old_cumulative_executed REAL,old_last_validated_at TEXT,old_field_provenance TEXT);
          CREATE TABLE payment_centers(center TEXT);
          INSERT INTO daily_collection_reconciliations
            (id,business_date,status,source_row_count,publication_mode,report_id,extracted_at,
             official_total,detail_total,supersedes_id,zero_value_confirmed,total_difference_confirmed)
          VALUES(1,'2026-06-15','published',61,'daily_only','810ca5a0-b239-466b-85c2-386373244c8e',
            '2026-06-16T08:00:00+08:00',10.03,10.00,NULL,0,1);
        """)
        connection.executemany("INSERT INTO daily_snapshots VALUES('2026-06-15',?)", [(f"C{i}",) for i in range(56)])
        connection.executemany("INSERT INTO payment_centers VALUES(?)", [(f"C{i}",) for i in range(56)])
        connection.executemany(
            "INSERT INTO daily_collection_revision_rows VALUES(1,?,?,NULL,NULL,NULL,NULL,'{}')",
            [(f"C{i}", 10.0 if i == 0 else 0.0) for i in range(56)],
        )
        connection.commit()
        self.assertTrue(MODULE.has_current_published(connection, "2026-06-15"))
        MODULE.ensure_attempt_table(connection)
        for _ in range(3):
            MODULE.record_attempt(connection, "2026-06-15", "failed", "awaiting human confirmation", 3)
        completed = MODULE.backfill_completion_status(connection, connection, "2026-06-15")
        self.assertEqual(
            (completed["completed"], completed["eligiblePending"], completed["quarantined"], completed["validPublishedHeads"]),
            (True, 0, 0, 1),
        )
        self.assertEqual(completed["manualReview"], [])
        connection.execute("UPDATE daily_collection_reconciliations SET total_difference_confirmed=0 WHERE id=1")
        self.assertFalse(MODULE.has_current_published(connection, "2026-06-15"))
        connection.execute("UPDATE daily_collection_reconciliations SET official_total=10.06,total_difference_confirmed=1 WHERE id=1")
        self.assertFalse(MODULE.has_current_published(connection, "2026-06-15"))
        connection.close()

    def test_backfill_completion_reports_quarantine_on_every_rerun(self):
        connection = sqlite3.connect(":memory:")
        connection.executescript("""
          CREATE TABLE daily_snapshots(date TEXT,center TEXT);
          CREATE TABLE daily_collection_reconciliations(id INTEGER PRIMARY KEY,business_date TEXT,status TEXT,source_row_count INTEGER,publication_mode TEXT,report_id TEXT,extracted_at TEXT,official_total REAL,detail_total REAL,supersedes_id INTEGER);
          CREATE TABLE daily_collection_revision_rows(reconciliation_id INTEGER,center TEXT,new_daily_collection REAL,old_daily_collection REAL,old_cumulative_budget REAL,old_cumulative_executed REAL,old_last_validated_at TEXT,old_field_provenance TEXT);
          CREATE TABLE payment_centers(center TEXT);
        """)
        connection.executemany("INSERT INTO daily_snapshots VALUES('2026-06-15',?)", [(f"C{i}",) for i in range(56)])
        MODULE.ensure_attempt_table(connection)
        for _ in range(3):
            MODULE.record_attempt(connection, "2026-06-15", "failed", "needs finance review", 3)
        for _ in range(2):
            self.assertEqual(MODULE.select_candidates(connection, "2026-06-15", 5, 3), [])
            status = MODULE.backfill_completion_status(connection, connection, "2026-06-15")
            self.assertEqual(status["completed"], False)
            self.assertEqual(status["eligibleTotal"], 1)
            self.assertEqual(status["eligiblePending"], 0)
            self.assertEqual(status["validPublishedHeads"], 0)
            self.assertEqual(status["quarantined"], 1)
            self.assertEqual(status["manualReview"], [{"businessDate": "2026-06-15", "attempts": 3, "lastError": "needs finance review"}])
        connection.close()

    def test_backfill_completion_requires_a_valid_published_head_for_every_eligible_date(self):
        connection = sqlite3.connect(":memory:")
        connection.executescript("""
          CREATE TABLE daily_snapshots(date TEXT,center TEXT);
          CREATE TABLE daily_collection_reconciliations(id INTEGER PRIMARY KEY,business_date TEXT,status TEXT,source_row_count INTEGER,publication_mode TEXT,report_id TEXT,extracted_at TEXT,official_total REAL,detail_total REAL,supersedes_id INTEGER);
          CREATE TABLE daily_collection_revision_rows(reconciliation_id INTEGER,center TEXT,new_daily_collection REAL,old_daily_collection REAL,old_cumulative_budget REAL,old_cumulative_executed REAL,old_last_validated_at TEXT,old_field_provenance TEXT);
          CREATE TABLE payment_centers(center TEXT);
        """)
        connection.executemany("INSERT INTO daily_snapshots VALUES('2026-06-15',?)", [(f"C{i}",) for i in range(56)])
        connection.executemany("INSERT INTO payment_centers VALUES(?)", [(f"C{i}",) for i in range(56)])
        MODULE.ensure_attempt_table(connection)
        pending = MODULE.backfill_completion_status(connection, connection, "2026-06-15")
        self.assertEqual((pending["completed"], pending["eligiblePending"], pending["validPublishedHeads"]), (False, 1, 0))
        connection.execute("INSERT INTO daily_collection_reconciliations VALUES(1,'2026-06-15','published',61,'daily_only',?,?,56,56,NULL)", (MODULE.DAILY_REPORT_ID, "2026-06-16T08:00:00+08:00"))
        connection.executemany("INSERT INTO daily_collection_revision_rows VALUES(1,?,1,NULL,NULL,NULL,NULL,'{}')", [(f"C{i}",) for i in range(56)])
        connection.commit()
        completed = MODULE.backfill_completion_status(connection, connection, "2026-06-15")
        self.assertEqual((completed["completed"], completed["eligiblePending"], completed["quarantined"], completed["validPublishedHeads"]), (True, 0, 0, 1))
        connection.close()

    def test_runner_separates_conservative_daily_mode_from_bounded_backfill(self):
        runner = (MODULE_PATH.parent / "run-daily-reconciliation.sh").read_text(encoding="utf-8")
        self.assertIn('RECONCILIATION_MODE="${COCKPIT_RECONCILIATION_MODE:-daily}"', runner)
        self.assertIn('BACKFILL_BATCH_SIZE="${COCKPIT_RECONCILIATION_BACKFILL_BATCH_SIZE:-5}"', runner)
        self.assertIn('daily_reconciliation_candidates.py', runner)
        self.assertNotIn('LIMIT 3', runner)
        self.assertNotIn('recent AS', runner)
        self.assertIn('--completion-status', runner)
        self.assertIn('BACKFILL_QUARANTINE_EXIT=78', runner)
        self.assertIn('BACKFILL_INCOMPLETE_EXIT=76', runner)
        self.assertIn('BACKFILL_STATUS_ERROR_EXIT=77', runner)
        self.assertIn('if ! status=', runner)
        self.assertIn('if ! parsed=', runner)
        self.assertIn('finish_backfill', runner)


if __name__ == "__main__":
    unittest.main()
