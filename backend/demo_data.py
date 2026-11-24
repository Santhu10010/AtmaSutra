"""Generate 21 days of demo data without replacing existing user data."""
from datetime import date, timedelta

import numpy as np

from db import get_conn


class DemoDataExistsError(Exception):
    """Raised when demo data would overwrite an existing local dataset."""


def generate_demo_data():
    np.random.seed(42)
    conn = get_conn()
    try:
        metrics_count = conn.execute("SELECT COUNT(*) FROM metrics").fetchone()[0]
        habits_count = conn.execute("SELECT COUNT(*) FROM habits").fetchone()[0]
        if metrics_count or habits_count:
            raise DemoDataExistsError("Demo data was not loaded because this database already contains data.")

        start = date.today() - timedelta(days=21)
        habit_dates = [start + timedelta(days=i) for i in range(21)]
        rows_metrics = []
        rows_habits = []

        for habit_date in habit_dates:
            late_dinner = 1.0 if np.random.random() < 0.4 else 0.0
            alcohol = float(np.random.choice([0, 0, 0, 1, 2, 3]))
            exercise_min = float(np.clip(np.random.normal(35, 20), 0, 90))
            screen_before_bed = float(np.clip(np.random.normal(1.5, 0.8), 0, 4))

            sleep_hours = 7.5 - 0.6 * late_dinner - 0.3 * alcohol - 0.25 * screen_before_bed + np.random.normal(0, 0.3)
            sleep_hours = round(np.clip(sleep_hours, 4.0, 9.5), 1)
            sleep_score = round(np.clip(55 + 5 * sleep_hours - 8 * late_dinner - 5 * alcohol + np.random.normal(0, 3), 30, 100), 0)
            recovery_score = round(np.clip(50 + 4 * sleep_hours + 0.15 * exercise_min - 10 * late_dinner - 6 * alcohol + np.random.normal(0, 4), 20, 100), 0)
            workout_strain = round(np.clip(exercise_min / 6.0 + np.random.normal(0, 1), 0, 21), 1)
            resting_hr = round(np.clip(62 - 0.05 * exercise_min + 2 * alcohol + 3 * late_dinner + np.random.normal(0, 2), 48, 85), 0)

            metric_date = habit_date + timedelta(days=1)
            rows_metrics.append((metric_date, sleep_hours, sleep_score, recovery_score, workout_strain, resting_hr))
            rows_habits.extend([
                (habit_date, "late_dinner", late_dinner),
                (habit_date, "alcohol_drinks", alcohol),
                (habit_date, "exercise_min", exercise_min),
                (habit_date, "screen_before_bed_hrs", screen_before_bed),
            ])

        conn.execute("BEGIN TRANSACTION")
        conn.executemany("INSERT INTO metrics VALUES (?, ?, ?, ?, ?, ?)", rows_metrics)
        conn.executemany("INSERT INTO habits (date, habit, value) VALUES (?, ?, ?)", rows_habits)
        conn.execute("COMMIT")
        return {"days": len(habit_dates), "metrics_rows": len(rows_metrics), "habit_rows": len(rows_habits)}
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()
