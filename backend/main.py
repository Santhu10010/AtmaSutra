"""FastAPI backend for AtmaSutra."""
from datetime import date
import io
import math
from typing import Literal

import pandas as pd
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, model_validator

from analytics import compute_insights, try_ollama_nudge
from db import get_conn
from demo_data import DemoDataExistsError, generate_demo_data


MAX_UPLOAD_BYTES = 5 * 1024 * 1024
METRIC_COLS = ["sleep_hours", "sleep_score", "recovery_score", "workout_strain", "resting_hr"]
METRIC_RANGES = {
    "sleep_hours": (0, 24),
    "sleep_score": (0, 100),
    "recovery_score": (0, 100),
    "workout_strain": (0, 100),
    "resting_hr": (20, 250),
}
COLUMN_ALIASES = {
    "date": "date",
    "day": "date",
    "cycle start time": "date",
    "habit": "habit",
    "value": "value",
    "sleep_hours": "sleep_hours",
    "sleep analysis [hr]": "sleep_hours",
    "total_sleep_duration": "sleep_seconds",
    "sleep_score": "sleep_score",
    "score": "sleep_score",
    "sleep performance %": "sleep_score",
    "recovery_score": "recovery_score",
    "recovery score %": "recovery_score",
    "workout_strain": "workout_strain",
    "day strain": "workout_strain",
    "resting_hr": "resting_hr",
    "average_heart_rate": "resting_hr",
    "resting heart rate (bpm)": "resting_hr",
    "resting heart rate [count/min]": "resting_hr",
}


class HabitEntry(BaseModel):
    date: date
    habit: Literal["late_dinner", "alcohol_drinks", "exercise_min", "screen_before_bed_hrs"]
    value: float

    @model_validator(mode="after")
    def validate_value(self):
        limits = {
            "late_dinner": (0, 1),
            "alcohol_drinks": (0, 20),
            "exercise_min": (0, 1440),
            "screen_before_bed_hrs": (0, 24),
        }
        low, high = limits[self.habit]
        if not math.isfinite(self.value) or not low <= self.value <= high:
            raise ValueError(f"value for {self.habit} must be between {low} and {high}")
        return self


app = FastAPI(title="AtmaSutra API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _records(table: str):
    conn = get_conn()
    try:
        df = conn.execute(f"SELECT * FROM {table} ORDER BY date").fetchdf()
    finally:
        conn.close()
    if not df.empty:
        df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
    return df.to_dict(orient="records")


def _normalize_csv(df: pd.DataFrame) -> pd.DataFrame:
    renamed = {}
    claimed = set()
    for original in df.columns:
        canonical = COLUMN_ALIASES.get(str(original).strip().lower())
        if canonical and canonical not in claimed:
            renamed[original] = canonical
            claimed.add(canonical)
    df = df.rename(columns=renamed)
    if "sleep_seconds" in df.columns:
        df["sleep_hours"] = pd.to_numeric(df["sleep_seconds"], errors="raise") / 3600
        df = df.drop(columns="sleep_seconds")
    return df


def _prepare_csv(df: pd.DataFrame):
    df = _normalize_csv(df)
    if "date" not in df.columns:
        raise ValueError("CSV must include a date, day, or cycle start time column.")
    df["date"] = pd.to_datetime(df["date"], errors="raise").dt.date

    if {"habit", "value"}.issubset(df.columns):
        df["habit"] = df["habit"].astype(str).str.strip()
        if df["habit"].eq("").any() or df["habit"].str.len().gt(64).any():
            raise ValueError("Habit names must contain 1 to 64 characters.")
        df["value"] = pd.to_numeric(df["value"], errors="raise")
        if not df["value"].map(math.isfinite).all():
            raise ValueError("Habit values must be finite numbers.")
        return "habits", df[["date", "habit", "value"]], ["habit", "value"]

    metric_cols = [column for column in METRIC_COLS if column in df.columns]
    if not metric_cols:
        raise ValueError("CSV does not contain a supported health metric column.")
    for column in metric_cols:
        df[column] = pd.to_numeric(df[column], errors="raise")
        low, high = METRIC_RANGES[column]
        values = df[column].dropna()
        if not values.map(math.isfinite).all() or not values.between(low, high).all():
            raise ValueError(f"{column} values must be between {low} and {high}.")
    return "metrics", df[["date", *metric_cols]], metric_cols


def _write_csv(kind: str, df: pd.DataFrame, columns: list[str]):
    conn = get_conn()
    try:
        conn.execute("BEGIN TRANSACTION")
        if kind == "habits":
            rows = [(row.date, row.habit, float(row.value)) for row in df.itertuples(index=False)]
            conn.executemany(
                "INSERT OR REPLACE INTO habits (date, habit, value) VALUES (?, ?, ?)",
                rows,
            )
        else:
            placeholders = ", ".join(["?"] * (1 + len(columns)))
            names = "date, " + ", ".join(columns)
            sql = f"INSERT OR REPLACE INTO metrics ({names}) VALUES ({placeholders})"
            rows = []
            for row in df.itertuples(index=False):
                values = [getattr(row, column) for column in columns]
                rows.append([row.date, *[float(value) if pd.notna(value) else None for value in values]])
            conn.executemany(sql, rows)
        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()


@app.get("/api/health")
def health():
    return {"status": "ok", "local": True}


@app.post("/api/demo-data")
def load_demo():
    try:
        result = generate_demo_data()
    except DemoDataExistsError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    insights = compute_insights()
    return {"loaded": result, "insights_count": len(insights)}


@app.get("/api/metrics")
def get_metrics():
    return _records("metrics")


@app.get("/api/habits")
def get_habits():
    return _records("habits")


@app.get("/api/insights")
async def get_insights():
    insights = compute_insights()
    significant = [item for item in insights if item["p_adjusted"] <= 0.05]
    ai_nudge = await try_ollama_nudge(significant) if significant else None
    return {"insights": insights, "ai_nudge": ai_nudge}


@app.post("/api/upload-csv")
async def upload_csv(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Choose a CSV file.")
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="CSV files must be 5 MB or smaller.")
    try:
        df = pd.read_csv(io.BytesIO(content))
        if df.empty:
            raise ValueError("CSV has no data rows.")
        kind, prepared, columns = _prepare_csv(df)
        _write_csv(kind, prepared, columns)
    except (ValueError, TypeError, pd.errors.ParserError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {"rows_imported": len(prepared), "kind": kind, "columns_imported": columns}


@app.post("/api/log-habit")
def log_habit(data: HabitEntry):
    conn = get_conn()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO habits (date, habit, value) VALUES (?, ?, ?)",
            (data.date, data.habit, data.value),
        )
    finally:
        conn.close()
    return {"logged": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
