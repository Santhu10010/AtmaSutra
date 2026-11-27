import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from unittest.mock import patch

import pandas as pd
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

    def test_csv_rejects_missing_fields_and_invalid_known_habits(self):
        samples = [
            ("missing-date.csv", "date,sleep_score\n,88\n"),
            ("blank-habit.csv", "date,habit,value\n2026-01-01,,30\n"),
            ("invalid-habit.csv", "date,habit,value\n2026-01-01,late_dinner,9\n"),
        ]
        for name, csv in samples:
            with self.subTest(name=name):
                self.assertEqual(self.upload(name, csv).status_code, 400)
        self.assertEqual(self.count("metrics"), 0)
        self.assertEqual(self.count("habits"), 0)

    def test_five_rows_do_not_claim_statistical_significance(self):
        conn = db.get_conn()
        try:
            for offset in range(5):
                habit_date = date(2026, 1, 1) + timedelta(days=offset)
                value = offset + 1
                conn.execute("INSERT INTO habits VALUES (?, 'custom_habit', ?)", (habit_date, value))
                conn.execute(
                    "INSERT INTO metrics VALUES (?, ?, ?, ?, ?, ?)",
                    (habit_date + timedelta(days=1), 5 + value, 50 + value, 60 + value, 5, 70 - value),
                )
        finally:
            conn.close()
        insights = analytics.compute_insights()
        self.assertEqual(len(insights), 4)
        self.assertTrue(all(item["p_adjusted"] > 0.05 for item in insights))

    def test_nonzero_habit_values_produce_an_insight(self):
        conn = db.get_conn()
        try:
            for offset, (value, score) in enumerate(zip([10, 10, 10, 20, 30], [50, 51, 52, 80, 95])):
                habit_date = date(2026, 3, 1) + timedelta(days=offset)
                conn.execute("INSERT INTO habits VALUES (?, 'exercise_min', ?)", (habit_date, value))
                conn.execute(
                    "INSERT INTO metrics VALUES (?, ?, ?, ?, ?, ?)",
                    (habit_date + timedelta(days=1), 7, score, 70, 5, 55),
                )
        finally:
            conn.close()
        insights = analytics.compute_insights()
        self.assertTrue(any(item["metric"] == "sleep_score" for item in insights))

    def test_large_samples_skip_expensive_permutations(self):
        values = pd.Series(range(501))
        with patch.object(analytics, "permutation_test", side_effect=AssertionError):
            correlation, p_value = analytics._spearman_test(values, values)
        self.assertEqual(correlation, 1.0)
        self.assertLess(p_value, 0.05)

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

    def test_concurrent_first_access_initializes_schema_once(self):
        def connect(_):
            conn = db.get_conn()
            conn.close()

        with ThreadPoolExecutor(max_workers=20) as pool:
            list(pool.map(connect, range(50)))

        self.assertEqual(self.count("metrics"), 0)
        self.assertEqual(self.count("habits"), 0)


if __name__ == "__main__":
    unittest.main()
