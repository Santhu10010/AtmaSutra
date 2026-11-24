import tempfile
import unittest
from datetime import date, timedelta

from fastapi.testclient import TestClient

import analytics
import db
import main


class AtmaSutraTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="atmasutra-tests-")
        db.DB_PATH = f"{self.tempdir.name}/test.duckdb"
        self.client = TestClient(main.app, raise_server_exceptions=False)

    def tearDown(self):
        self.tempdir.cleanup()

    def count(self, table):
        conn = db.get_conn()
        try:
            return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        finally:
            conn.close()

    def upload(self, name, csv):
        return self.client.post(
            "/api/upload-csv",
            files={"file": (name, csv, "text/csv")},
        )

    def test_demo_refuses_to_replace_existing_data(self):
        conn = db.get_conn()
        conn.execute("INSERT INTO habits VALUES ('2026-01-01', 'exercise_min', 30)")
        conn.close()

        response = self.client.post("/api/demo-data")

        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.count("habits"), 1)

    def test_demo_stores_metrics_one_day_after_habits(self):
        response = self.client.post("/api/demo-data")
        self.assertEqual(response.status_code, 200)
        conn = db.get_conn()
        try:
            habit_date = conn.execute("SELECT MIN(date) FROM habits").fetchone()[0]
            metric_date = conn.execute("SELECT MIN(date) FROM metrics").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(metric_date - habit_date, timedelta(days=1))

    def test_invalid_csv_writes_nothing(self):
        response = self.upload(
            "bad.csv",
            "date,sleep_score\n2026-01-01,88\n2026-01-02,not-a-number\n",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.count("metrics"), 0)

    def test_common_wearable_columns_import(self):
        samples = [
            ("oura.csv", "day,score,total_sleep_duration,average_heart_rate\n2026-01-01,86,26640,54\n"),
            ("whoop.csv", "Cycle start time,Recovery score %,Resting heart rate (bpm),Sleep performance %,Day Strain\n2026-01-02 04:00:00,79,55,84,7.2\n"),
            ("apple.csv", "Date,Sleep Analysis [hr],Resting Heart Rate [count/min]\n2026-01-03,7.4,56\n"),
        ]
        for name, csv in samples:
            with self.subTest(name=name):
                self.assertEqual(self.upload(name, csv).status_code, 200)
        self.assertEqual(self.count("metrics"), 3)

    def test_constant_habit_is_skipped(self):
        conn = db.get_conn()
        try:
            for offset in range(5):
                habit_date = date(2026, 2, 1) + timedelta(days=offset)
                metric_date = habit_date + timedelta(days=1)
                conn.execute("INSERT INTO habits VALUES (?, 'constant_habit', 1)", (habit_date,))
                conn.execute(
                    "INSERT INTO metrics VALUES (?, ?, ?, ?, ?, ?)",
                    (metric_date, 7 + offset / 10, 70 + offset, 60 + offset, 5, 55 + offset),
                )
        finally:
            conn.close()
        self.assertEqual(analytics.compute_insights(), [])

    def test_habit_validation_returns_422(self):
        response = self.client.post(
            "/api/log-habit",
            json={"date": "2026-01-01", "habit": "late_dinner", "value": 2},
        )
        self.assertEqual(response.status_code, 422)

    def test_cors_accepts_advertised_dev_origin(self):
        response = self.client.options(
            "/api/health",
            headers={
                "Origin": "http://127.0.0.1:3000",
                "Access-Control-Request-Method": "GET",
            },
        )
        self.assertEqual(response.headers["access-control-allow-origin"], "http://127.0.0.1:3000")


if __name__ == "__main__":
    unittest.main()
