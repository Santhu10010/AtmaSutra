"""FastAPI backend for AtmaSutra."""
from datetime import date, timedelta
import io
import math
from typing import Literal
from uuid import uuid4

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
HABIT_RANGES = {
    "late_dinner": (0, 1),
    "alcohol_drinks": (0, 20),
    "exercise_min": (0, 1440),
    "screen_before_bed_hrs": (0, 24),
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
        low, high = HABIT_RANGES[self.habit]
        if not math.isfinite(self.value) or not low <= self.value <= high:
            raise ValueError(f"value for {self.habit} must be between {low} and {high}")
        return self


class ExperimentPlan(BaseModel):
    habit: Literal["late_dinner", "alcohol_drinks", "exercise_min", "screen_before_bed_hrs"]
    change: str
    duration_days: Literal[7, 14, 21]

    @model_validator(mode="after")
    def validate_change(self):
        self.change = self.change.strip()
        if not 3 <= len(self.change) <= 160:
            raise ValueError("Describe your change in 3 to 160 characters.")
        return self


class ExperimentCheckin(BaseModel):
    followed: bool


class AnnotationEntry(BaseModel):
    date: date
    category: Literal["travel", "illness", "stress", "other"]
    note: str

    @model_validator(mode="after")
    def validate_note(self):
        self.note = self.note.strip()
        if not 2 <= len(self.note) <= 240:
            raise ValueError("A note must be between 2 and 240 characters.")
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
    dates = pd.to_datetime(df["date"], errors="raise")
    if dates.isna().any():
        raise ValueError("Every CSV row must include a valid date.")
    df["date"] = dates.dt.date

    if {"habit", "value"}.issubset(df.columns):
        if df["habit"].isna().any():
            raise ValueError("Habit names must contain 1 to 64 characters.")
        df["habit"] = df["habit"].astype(str).str.strip()
        if df["habit"].eq("").any() or df["habit"].str.len().gt(64).any():
            raise ValueError("Habit names must contain 1 to 64 characters.")
        df["value"] = pd.to_numeric(df["value"], errors="raise")
        if not df["value"].map(math.isfinite).all():
            raise ValueError("Habit values must be finite numbers.")
        for habit, (low, high) in HABIT_RANGES.items():
            values = df.loc[df["habit"].eq(habit), "value"]
            if not values.between(low, high).all():
                raise ValueError(f"value for {habit} must be between {low} and {high}")
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
        conn.register("upload_rows", df)
        if kind == "habits":
            conn.execute(
                """INSERT OR REPLACE INTO habits (date, habit, value)
                   SELECT date, habit, value FROM upload_rows"""
            )
        else:
            names = "date, " + ", ".join(columns)
            conn.execute(
                f"INSERT OR REPLACE INTO metrics ({names}) SELECT {names} FROM upload_rows"
            )
        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()


def _csv_replacement_count(kind: str, df: pd.DataFrame):
    conn = get_conn()
    try:
        conn.register("preview_rows", df)
        if kind == "habits":
            query = """SELECT COUNT(*) FROM habits h
                       WHERE EXISTS (
                           SELECT 1 FROM preview_rows p
                           WHERE p.date = h.date AND p.habit = h.habit
                       )"""
        else:
            query = """SELECT COUNT(*) FROM metrics m
                       WHERE EXISTS (SELECT 1 FROM preview_rows p WHERE p.date = m.date)"""
        return conn.execute(query).fetchone()[0]
    finally:
        conn.close()


async def _parse_csv_upload(file: UploadFile):
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise ValueError("Choose a CSV file.")
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="CSV files must be 5 MB or smaller.")
    df = pd.read_csv(io.BytesIO(content))
    if df.empty:
        raise ValueError("CSV has no data rows.")
    return _prepare_csv(df)


def _csv_sample_rows(df: pd.DataFrame):
    sample = []
    for row in df.head(5).to_dict(orient="records"):
        sample.append({
            key: None if pd.isna(value) else value.isoformat() if hasattr(value, "isoformat") else value.item() if hasattr(value, "item") else value
            for key, value in row.items()
        })
    return sample


@app.get("/api/health")
def health():
    return {"status": "ok", "local": True}


@app.post("/api/demo-data")
def load_demo():
    try:
        result = generate_demo_data()
    except DemoDataExistsError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return {"loaded": result}


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


@app.post("/api/preview-csv")
async def preview_csv(file: UploadFile = File(...)):
    try:
        kind, prepared, columns = await _parse_csv_upload(file)
    except (ValueError, TypeError, pd.errors.ParserError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    dates = prepared["date"].sort_values()
    return {
        "kind": kind,
        "rows_imported": len(prepared),
        "columns_imported": ["date", *columns],
        "date_start": dates.iloc[0].isoformat(),
        "date_end": dates.iloc[-1].isoformat(),
        "replacements": _csv_replacement_count(kind, prepared),
        "sample_rows": _csv_sample_rows(prepared),
    }


@app.post("/api/upload-csv")
async def upload_csv(file: UploadFile = File(...)):
    try:
        kind, prepared, columns = await _parse_csv_upload(file)
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


def _metric_averages(start: date, end: date):
    conn = get_conn()
    try:
        row = conn.execute(
            """SELECT COUNT(sleep_score), AVG(sleep_score),
                      COUNT(recovery_score), AVG(recovery_score)
               FROM metrics WHERE date >= ? AND date < ?""",
            (start, end),
        ).fetchone()
    finally:
        conn.close()
    return {
        "sleep_score_days": row[0],
        "sleep_score": round(float(row[1]), 1) if row[1] is not None else None,
        "recovery_score_days": row[2],
        "recovery_score": round(float(row[3]), 1) if row[3] is not None else None,
    }


def _latest_experiment():
    conn = get_conn()
    try:
        row = conn.execute(
            """SELECT id, habit, change, start_date, duration_days
               FROM experiments ORDER BY start_date DESC LIMIT 1"""
        ).fetchone()
        if row is None:
            return None
        experiment_id, habit, change, start_date, duration_days = row
        checkins = conn.execute(
            "SELECT date, followed FROM experiment_checkins WHERE experiment_id = ? ORDER BY date",
            (experiment_id,),
        ).fetchall()
    finally:
        conn.close()

    start_date = date.fromisoformat(str(start_date)[:10])
    end_date = start_date + timedelta(days=duration_days)
    today = date.today()
    baseline_start = start_date - timedelta(days=6)
    baseline_end = start_date + timedelta(days=1)
    during_start = baseline_end
    during_end = end_date + timedelta(days=1)
    observed_end = min(today + timedelta(days=1), during_end)
    checkin_rows = [
        {"date": date.fromisoformat(str(item[0])[:10]).isoformat(), "followed": item[1]}
        for item in checkins
    ]
    return {
        "id": experiment_id,
        "habit": habit,
        "change": change,
        "start_date": start_date.isoformat(),
        "duration_days": duration_days,
        "end_date": (end_date - timedelta(days=1)).isoformat(),
        "completed": today >= end_date,
        "checkins": checkin_rows,
        "checked_in_today": today.isoformat() in {item["date"] for item in checkin_rows},
        "baseline": _metric_averages(baseline_start, baseline_end),
        "during": _metric_averages(during_start, observed_end),
    }


@app.get("/api/experiments")
def get_experiment():
    return {"experiment": _latest_experiment()}


@app.post("/api/experiments")
def start_experiment(plan: ExperimentPlan):
    latest = _latest_experiment()
    if latest and not latest["completed"]:
        raise HTTPException(status_code=409, detail="Finish your current experiment before starting another.")
    experiment_id = str(uuid4())
    start_date = date.today()
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO experiments VALUES (?, ?, ?, ?, ?)",
            (experiment_id, plan.habit, plan.change, start_date, plan.duration_days),
        )
    finally:
        conn.close()
    return {"experiment": _latest_experiment()}


@app.post("/api/experiments/check-in")
def check_in_experiment(data: ExperimentCheckin):
    experiment = _latest_experiment()
    today = date.today()
    if not experiment or experiment["completed"] or not experiment["start_date"] <= today.isoformat() <= experiment["end_date"]:
        raise HTTPException(status_code=409, detail="There is no active experiment to check in today.")
    if experiment["checked_in_today"]:
        raise HTTPException(status_code=409, detail="Today is already checked in.")
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO experiment_checkins VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
            (experiment["id"], today, data.followed),
        )
    finally:
        conn.close()
    return {"checked_in": True}


@app.get("/api/annotations")
def get_annotations():
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, date, category, note FROM annotations ORDER BY date DESC, created_at DESC"
        ).fetchall()
    finally:
        conn.close()
    return [
        {"id": row[0], "date": row[1].isoformat(), "category": row[2], "note": row[3]}
        for row in rows
    ]


@app.post("/api/annotations")
def add_annotation(entry: AnnotationEntry):
    annotation_id = str(uuid4())
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO annotations (id, date, category, note) VALUES (?, ?, ?, ?)",
            (annotation_id, entry.date, entry.category, entry.note),
        )
    finally:
        conn.close()
    return {"id": annotation_id, "saved": True}


@app.delete("/api/annotations/{annotation_id}")
def delete_annotation(annotation_id: str):
    conn = get_conn()
    try:
        result = conn.execute("DELETE FROM annotations WHERE id = ? RETURNING id", (annotation_id,)).fetchone()
    finally:
        conn.close()
    if result is None:
        raise HTTPException(status_code=404, detail="That timeline note was not found.")
    return {"deleted": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
