import os

import duckdb

DB_PATH = os.path.join(os.path.dirname(__file__), "atmasutra.duckdb")

def get_conn():
    conn = duckdb.connect(DB_PATH)
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
    return conn
