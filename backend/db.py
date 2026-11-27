import os
import threading

import duckdb

BASE_DATA_DIR = (
    os.environ.get("LOCALAPPDATA")
    or os.environ.get("XDG_DATA_HOME")
    or os.path.join(os.path.expanduser("~"), ".local", "share")
)
DATA_DIR = os.environ.get("ATMASUTRA_DATA_DIR") or os.path.join(BASE_DATA_DIR, "AtmaSutra")
DB_PATH = os.path.join(DATA_DIR, "atmasutra.duckdb")
_SCHEMA_LOCK = threading.Lock()
_INITIALIZED_DATABASES = set()

def get_conn():
    path = os.path.abspath(DB_PATH)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = duckdb.connect(path)
    with _SCHEMA_LOCK:
        if path not in _INITIALIZED_DATABASES:
            try:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS metrics (
                        date DATE PRIMARY KEY,
                        sleep_hours FLOAT,
                        sleep_score FLOAT,
                        recovery_score FLOAT,
                        workout_strain FLOAT,
                        resting_hr FLOAT
                    )
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS habits (
                        date DATE,
                        habit TEXT,
                        value FLOAT,
                        PRIMARY KEY (date, habit)
                    )
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS experiments (
                        id VARCHAR PRIMARY KEY,
                        habit TEXT NOT NULL,
                        change TEXT NOT NULL,
                        start_date DATE NOT NULL,
                        duration_days INTEGER NOT NULL
                    )
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS experiment_checkins (
                        experiment_id VARCHAR NOT NULL,
                        date DATE NOT NULL,
                        followed BOOLEAN NOT NULL,
                        PRIMARY KEY (experiment_id, date)
                    )
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS annotations (
                        id VARCHAR PRIMARY KEY,
                        date DATE NOT NULL,
                        category VARCHAR NOT NULL,
                        note VARCHAR NOT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                conn.execute(
                    "ALTER TABLE experiment_checkins ADD COLUMN IF NOT EXISTS followed BOOLEAN DEFAULT TRUE"
                )
            except Exception:
                conn.close()
                raise
            _INITIALIZED_DATABASES.add(path)
    return conn
