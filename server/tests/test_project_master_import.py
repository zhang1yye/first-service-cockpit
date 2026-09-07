import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
SCRIPTS = SERVER / "scripts"
sys.path.insert(0, str(SCRIPTS))

from project_master_import import import_active_project_master, parse_active_project_master

WORKBOOK = Path("/Users/zhangye/Desktop/华北地区公司的项目基础信息汇编 - 3.26.xlsx")


class ProjectMasterImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.parsed = parse_active_project_master(WORKBOOK)

    def test_parser_only_keeps_current_active_rows(self):
        parsed = self.parsed
        self.assertEqual(len(parsed["phases"]), 58)
        self.assertEqual(len(parsed["profiles"]), 42)
        self.assertEqual({row["management_status"] for row in parsed["phases"]}, {"在管"})
        self.assertTrue(all(row["phase_name"] for row in parsed["phases"]))
        self.assertTrue(all(row["service_center"] for row in parsed["phases"]))

    def test_parser_excludes_contract_and_missing_status_rows(self):
        phase_names = {row["phase_name"] for row in self.parsed["phases"]}
        centers = {row["service_center"] for row in self.parsed["phases"]}
        self.assertNotIn("石家庄当代辰悦", phase_names)
        self.assertNotIn("经纬新天地", phase_names)
        self.assertNotIn("第一服务林昌天铂SOHO服务中心", centers)
        self.assertNotIn("第一服务营口恒大城服务中心", centers)

    def test_parser_corrects_shifted_facility_columns(self):
        row = next(row for row in self.parsed["phases"] if row["phase_name"] == "北京万国城MOMΛ")
        self.assertEqual(row["green_area"], 37070.78)
        self.assertEqual(row["green_staff"], 4)
        self.assertEqual(row["green_outsourced"], "否")
        self.assertEqual(row["entrances"], 7)
        self.assertEqual(row["operable_area"], 86)
        self.assertEqual(row["cameras"], 240)
        self.assertEqual(row["recorders"], 15)
        self.assertEqual(row["freight_elevators"], 10)

    def test_raw_values_are_preserved_when_numeric_normalization_is_not_safe(self):
        row = next(row for row in self.parsed["phases"] if row["phase_name"] == "北京万国城MOMΛ")
        self.assertEqual(row["management_room_area"], 150)
        self.assertEqual(row["raw"]["物业管理用房面积（平方米）"], "150平米")

    def test_sqlite_import_is_versioned_and_non_destructive(self):
        with tempfile.TemporaryDirectory() as td:
            db_path = Path(td) / "cockpit.db"
            conn = sqlite3.connect(db_path)
            conn.execute("CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT)")
            conn.execute("INSERT INTO projects(name) VALUES ('保留的旧项目数据')")
            conn.commit(); conn.close()
            result = import_active_project_master(WORKBOOK, db_path)
            with sqlite3.connect(db_path) as conn:
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0], 1)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM project_profile_import_batches").fetchone()[0], 1)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM project_profiles").fetchone()[0], 42)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM project_phase_profiles").fetchone()[0], 58)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM project_phase_profiles WHERE management_status != '在管'").fetchone()[0], 0)
            conn.close()
            self.assertEqual(result["profile_count"], 42)
            self.assertEqual(result["phase_count"], 58)
            self.assertTrue(result["source_sha256"])

    def test_reimport_same_file_is_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            db_path = Path(td) / "cockpit.db"
            first = import_active_project_master(WORKBOOK, db_path)
            second = import_active_project_master(WORKBOOK, db_path)
            with sqlite3.connect(db_path) as conn:
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM project_profile_import_batches").fetchone()[0], 1)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM project_profiles").fetchone()[0], 42)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM project_phase_profiles").fetchone()[0], 58)
            conn.close()
            self.assertEqual(second["batch_id"], first["batch_id"])
            self.assertEqual(second["status"], "already_imported")

    def test_explicit_operating_center_links_support_exact_and_one_to_many(self):
        with tempfile.TemporaryDirectory() as td:
            db_path = Path(td) / "cockpit.db"
            conn = sqlite3.connect(db_path)
            conn.executescript("""
                CREATE TABLE payment_centers (
                    id INTEGER PRIMARY KEY,
                    area TEXT,
                    center TEXT,
                    annual_budget REAL,
                    cumulative_budget REAL,
                    cumulative_executed REAL,
                    same_period REAL,
                    collection_rate REAL
                );
                CREATE TABLE collection_centers (
                    id INTEGER PRIMARY KEY,
                    area TEXT,
                    center TEXT,
                    receivable REAL,
                    received REAL,
                    overdue30 REAL,
                    overdue90 REAL
                );
            """)
            centers = [
                "第一服务北京万国城MOMΛ服务中心",
                "第一服务满庭青云服务中心",
                "第一服务营口林昌天铂服务中心",
                "第一服务营口林昌天铂体验中心",
            ]
            for index, center in enumerate(centers, 1):
                conn.execute(
                    "INSERT INTO payment_centers VALUES (?,?,?,?,?,?,?,?)",
                    (index, "朝阳片区", center, 100, 50, 40, 30, 0.8),
                )
                conn.execute(
                    "INSERT INTO collection_centers VALUES (?,?,?,?,?,?,?)",
                    (index, "朝阳片区", center, 100, 60, 0, 0),
                )
            conn.commit()
            conn.close()

            first = import_active_project_master(WORKBOOK, db_path)
            second = import_active_project_master(WORKBOOK, db_path)
            conn = sqlite3.connect(db_path)
            links = conn.execute(
                """
                SELECT p.service_center, l.source_system, l.source_center
                FROM project_profile_center_links l
                JOIN project_profiles p ON p.id = l.profile_id
                ORDER BY p.service_center, l.source_system, l.source_center
                """
            ).fetchall()
            conn.close()

            self.assertEqual(len(links), 8)
            self.assertEqual(sum(1 for row in links if row[0] == "第一服务北京万国城MOMΛ服务中心"), 2)
            self.assertEqual(sum(1 for row in links if row[0] == "第一服务北京满庭青云服务中心"), 2)
            self.assertEqual(sum(1 for row in links if row[0] == "第一服务营口林昌天铂服务中心"), 2)
            self.assertEqual(sum(1 for row in links if row[0] == "第一服务营口林昌天铂体验中心"), 2)
            self.assertFalse(any(row[0] == "第一服务保定易水名苑服务中心" for row in links))
            self.assertEqual(first["batch_id"], second["batch_id"])


if __name__ == "__main__":
    unittest.main()
