"""FastAPI backend for AtmaSutra."""
from datetime import date, datetime, timedelta, timezone
import asyncio
import io
import json
import math
import os
import secrets
import time
from typing import Literal
from uuid import uuid4
from urllib.parse import urlencode

import httpx
import pandas as pd
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field, ValidationError, model_validator

from analytics import compute_insights, try_ollama_nudge
from db import get_conn
from demo_data import DemoDataExistsError, generate_demo_data


MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_BACKUP_BYTES = 20 * 1024 * 1024
WHOOP_API = "https://api.prod.whoop.com/developer"
WHOOP_AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth"
WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token"
WHOOP_REDIRECT_URI = os.environ.get(
    "WHOOP_REDIRECT_URI", "http://127.0.0.1:8000/api/integrations/whoop/callback"
)
WHOOP_FRONTEND_URL = os.environ.get("WHOOP_FRONTEND_URL", "http://localhost:3000/")
_WHOOP_TOKENS = None
_WHOOP_OAUTH_STATES = {}
_WHOOP_LAST_SYNC = None
GOOGLE_HEALTH_API = "https://health.googleapis.com"
GOOGLE_HEALTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_HEALTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_HEALTH_REDIRECT_URI = os.environ.get(
    "GOOGLE_HEALTH_REDIRECT_URI", "http://127.0.0.1:8000/api/integrations/google-health/callback"
)
GOOGLE_HEALTH_FRONTEND_URL = os.environ.get("GOOGLE_HEALTH_FRONTEND_URL", "http://localhost:3000/")
GOOGLE_HEALTH_SCOPES = (
    "https://www.googleapis.com/auth/googlehealth.sleep.readonly "
    "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly"
)
_GOOGLE_HEALTH_TOKENS = None
_GOOGLE_HEALTH_OAUTH_STATES = {}
_GOOGLE_HEALTH_LAST_SYNC = None
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


class BackupMetric(BaseModel):
    date: date
    sleep_hours: float | None = Field(default=None, ge=0, le=24)
    sleep_score: float | None = Field(default=None, ge=0, le=100)
    recovery_score: float | None = Field(default=None, ge=0, le=100)
    workout_strain: float | None = Field(default=None, ge=0, le=100)
    resting_hr: float | None = Field(default=None, ge=20, le=250)


class BackupExperiment(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    habit: Literal["late_dinner", "alcohol_drinks", "exercise_min", "screen_before_bed_hrs"]
    change: str = Field(min_length=3, max_length=160)
    start_date: date
    duration_days: Literal[7, 14, 21]


class BackupCheckin(BaseModel):
    experiment_id: str = Field(min_length=1, max_length=64)
    date: date
    followed: bool


class BackupAnnotation(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    date: date
    category: Literal["travel", "illness", "stress", "other"]
    note: str = Field(min_length=2, max_length=240)


class BackupDocument(BaseModel):
    format: Literal["atmasutra-backup"]
    version: Literal[1]
    exported_at: datetime
    metrics: list[BackupMetric]
    habits: list[HabitEntry]
    annotations: list[BackupAnnotation]
    experiments: list[BackupExperiment]
    checkins: list[BackupCheckin]

    @model_validator(mode="after")
    def validate_checkins(self):
        experiment_ids = {experiment.id for experiment in self.experiments}
        if any(item.experiment_id not in experiment_ids for item in self.checkins):
            raise ValueError("Every check-in must belong to an experiment in this backup.")
        return self


app = FastAPI(title="AtmaSutra API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _whoop_configured():
    return bool(os.environ.get("WHOOP_CLIENT_ID") and os.environ.get("WHOOP_CLIENT_SECRET"))


def _google_health_configured():
    return bool(os.environ.get("GOOGLE_HEALTH_CLIENT_ID") and os.environ.get("GOOGLE_HEALTH_CLIENT_SECRET"))


async def _google_health_token():
    global _GOOGLE_HEALTH_TOKENS
    if not _GOOGLE_HEALTH_TOKENS:
        raise HTTPException(status_code=409, detail="Connect Google Health before syncing data.")
    if _GOOGLE_HEALTH_TOKENS["expires_at"] > time.time() + 60:
        return _GOOGLE_HEALTH_TOKENS["access_token"]
    refresh_token = _GOOGLE_HEALTH_TOKENS.get("refresh_token")
    if not refresh_token:
        _GOOGLE_HEALTH_TOKENS = None
        raise HTTPException(status_code=401, detail="Google Health authorization expired. Connect again to continue.")
    async with httpx.AsyncClient(trust_env=False, timeout=30) as client:
        response = await client.post(
            GOOGLE_HEALTH_TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": os.environ["GOOGLE_HEALTH_CLIENT_ID"],
                "client_secret": os.environ["GOOGLE_HEALTH_CLIENT_SECRET"],
            },
        )
    if response.is_error:
        _GOOGLE_HEALTH_TOKENS = None
        raise HTTPException(status_code=401, detail="Google Health authorization expired. Connect again to continue.")
    token = response.json()
    _GOOGLE_HEALTH_TOKENS = {
        **_GOOGLE_HEALTH_TOKENS,
        **token,
        "refresh_token": token.get("refresh_token", refresh_token),
        "expires_at": time.time() + int(token.get("expires_in", 3600)),
    }
    return _GOOGLE_HEALTH_TOKENS["access_token"]


async def _google_health_get(path: str, params: dict | None = None):
    token = await _google_health_token()
    async with httpx.AsyncClient(trust_env=False, timeout=30) as client:
        response = await client.get(
            f"{GOOGLE_HEALTH_API}{path}",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
        )
    if response.status_code == 401:
        global _GOOGLE_HEALTH_TOKENS
        _GOOGLE_HEALTH_TOKENS = None
        raise HTTPException(status_code=401, detail="Google Health authorization expired. Connect again to continue.")
    if response.is_error:
        raise HTTPException(status_code=502, detail="Google Health could not return the requested data. Check your Google Health profile and permissions, then try again.")
    return response.json()


async def _google_health_collection(data_type: str, *, reconcile: bool, params: dict):
    records = []
    path = f"/v4/users/me/dataTypes/{data_type}/dataPoints" + (":reconcile" if reconcile else "")
    query = {**params, "pageSize": 25 if data_type == "sleep" else 1000}
    for _ in range(50):
        page = await _google_health_get(path, query)
        records.extend(page.get("dataPoints", []))
        next_token = page.get("nextPageToken")
        if not next_token:
            return records
        query["pageToken"] = next_token
    raise HTTPException(status_code=502, detail="Google Health returned too many pages. Try syncing a shorter period.")


def _google_health_date(value):
    if isinstance(value, dict) and all(key in value for key in ("year", "month", "day")):
        return date(int(value["year"]), int(value["month"]), int(value["day"]))
    if isinstance(value, str):
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _google_health_sleep_hours(record: dict):
    sleep = record.get("sleep", {})
    if sleep.get("metadata", {}).get("mainSleep") is False:
        return None
    summary = sleep.get("summary", {})
    minutes = summary.get("minutesAsleep")
    if minutes is None:
        minutes = sum(
            max(0, int((datetime.fromisoformat(stage["endTime"].replace("Z", "+00:00")) - datetime.fromisoformat(stage["startTime"].replace("Z", "+00:00"))).total_seconds() // 60))
            for stage in sleep.get("stages", [])
            if stage.get("type") in {"LIGHT", "REM", "DEEP", "ASLEEP"} and stage.get("startTime") and stage.get("endTime")
        )
    try:
        hours = float(minutes) / 60
    except (TypeError, ValueError):
        return None
    return round(hours, 2) if 0 < hours <= 24 else None


async def _whoop_token():
    global _WHOOP_TOKENS
    if not _WHOOP_TOKENS:
        raise HTTPException(status_code=409, detail="Connect WHOOP before syncing data.")
    if _WHOOP_TOKENS["expires_at"] > time.time() + 60:
        return _WHOOP_TOKENS["access_token"]
    refresh_token = _WHOOP_TOKENS.get("refresh_token")
    if not refresh_token:
        _WHOOP_TOKENS = None
        raise HTTPException(status_code=401, detail="WHOOP authorization expired. Connect again to continue.")
    async with httpx.AsyncClient(trust_env=False, timeout=30) as client:
        response = await client.post(
            WHOOP_TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "scope": "offline",
                "client_id": os.environ["WHOOP_CLIENT_ID"],
                "client_secret": os.environ["WHOOP_CLIENT_SECRET"],
            },
        )
    if response.is_error:
        _WHOOP_TOKENS = None
        raise HTTPException(status_code=401, detail="WHOOP authorization expired. Connect again to continue.")
    token = response.json()
    _WHOOP_TOKENS = {
        **token,
        "expires_at": time.time() + int(token.get("expires_in", 3600)),
    }
    return _WHOOP_TOKENS["access_token"]


async def _whoop_get(path: str, params: dict):
    token = await _whoop_token()
    async with httpx.AsyncClient(trust_env=False, timeout=30) as client:
        response = await client.get(
            f"{WHOOP_API}{path}",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
        )
    if response.status_code == 401:
        global _WHOOP_TOKENS
        _WHOOP_TOKENS = None
        raise HTTPException(status_code=401, detail="WHOOP authorization expired. Connect again to continue.")
    if response.is_error:
        raise HTTPException(status_code=502, detail="WHOOP could not return the requested data. Try again later.")
    return response.json()


async def _whoop_collection(path: str, start: str, end: str):
    records = []
    params = {"limit": 25, "start": start, "end": end}
    for _ in range(20):
        page = await _whoop_get(path, params)
        records.extend(page.get("records", []))
        next_token = page.get("next_token")
        if not next_token:
            return records
        params["nextToken"] = next_token
    raise HTTPException(status_code=502, detail="WHOOP returned too many pages. Try syncing a shorter period.")


def _whoop_day(cycle: dict):
    if not cycle.get("end"):
        return None
    ended = datetime.fromisoformat(cycle["end"].replace("Z", "+00:00"))
    offset = datetime.strptime(cycle.get("timezone_offset", "Z"), "%z").tzinfo
    return ended.astimezone(offset).date()


def _whoop_metrics(cycles: list[dict], sleeps: list[dict], recoveries: list[dict]):
    sleep_by_cycle = {
        item.get("cycle_id"): item
        for item in sleeps
        if item.get("cycle_id") is not None and not item.get("nap") and item.get("score_state") == "SCORED"
    }
    recovery_by_cycle = {
        item.get("cycle_id"): item
        for item in recoveries
        if item.get("cycle_id") is not None and item.get("score_state") == "SCORED"
    }
    daily = {}
    for cycle in cycles:
        day = _whoop_day(cycle)
        if day is None or cycle.get("score_state") != "SCORED":
            continue
        row = daily.setdefault(day, {
            "date": day,
            "sleep_hours": None,
            "sleep_score": None,
            "recovery_score": None,
            "workout_strain": None,
            "resting_hr": None,
        })
        cycle_score = cycle.get("score") or {}
        if cycle_score.get("strain") is not None:
            row["workout_strain"] = cycle_score["strain"]
        sleep_score = (sleep_by_cycle.get(cycle.get("id")) or {}).get("score") or {}
        if sleep_score.get("sleep_performance_percentage") is not None:
            row["sleep_score"] = sleep_score["sleep_performance_percentage"]
        stages = sleep_score.get("stage_summary") or {}
        asleep_millis = sum(
            stages.get(key) or 0
            for key in (
                "total_light_sleep_time_milli",
                "total_slow_wave_sleep_time_milli",
                "total_rem_sleep_time_milli",
            )
        )
        if asleep_millis:
            row["sleep_hours"] = round(asleep_millis / 3_600_000, 2)
        recovery_score = (recovery_by_cycle.get(cycle.get("id")) or {}).get("score") or {}
        if recovery_score.get("recovery_score") is not None:
            row["recovery_score"] = recovery_score["recovery_score"]
        if recovery_score.get("resting_heart_rate") is not None:
            row["resting_hr"] = recovery_score["resting_heart_rate"]
    return [daily[day] for day in sorted(daily)]


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


@app.get("/api/integrations/whoop/status")
def whoop_status():
    return {
        "configured": _whoop_configured(),
        "connected": _WHOOP_TOKENS is not None,
        "last_sync": _WHOOP_LAST_SYNC,
        "redirect_uri": WHOOP_REDIRECT_URI,
    }


@app.get("/api/integrations/whoop/connect")
def connect_whoop():
    if not _whoop_configured():
        raise HTTPException(status_code=503, detail="Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET before connecting.")
    state = secrets.token_urlsafe(24)
    now = time.time()
    for old_state, expiry in list(_WHOOP_OAUTH_STATES.items()):
        if expiry <= now:
            del _WHOOP_OAUTH_STATES[old_state]
    _WHOOP_OAUTH_STATES[state] = now + 600
    query = urlencode({
        "response_type": "code",
        "client_id": os.environ["WHOOP_CLIENT_ID"],
        "redirect_uri": WHOOP_REDIRECT_URI,
        "scope": "read:cycles read:sleep read:recovery offline",
        "state": state,
    })
    return RedirectResponse(f"{WHOOP_AUTH_URL}?{query}", status_code=302)


def _whoop_frontend_redirect(result: str):
    separator = "&" if "?" in WHOOP_FRONTEND_URL else "?"
    return RedirectResponse(f"{WHOOP_FRONTEND_URL}{separator}{urlencode({'whoop': result})}", status_code=303)


@app.get("/api/integrations/whoop/callback")
async def whoop_callback(code: str | None = None, state: str | None = None, error: str | None = None):
    global _WHOOP_TOKENS
    expiry = _WHOOP_OAUTH_STATES.pop(state, 0) if state else 0
    if expiry <= time.time():
        return _whoop_frontend_redirect("error")
    if error or not code:
        return _whoop_frontend_redirect("error")
    async with httpx.AsyncClient(trust_env=False, timeout=30) as client:
        response = await client.post(
            WHOOP_TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": WHOOP_REDIRECT_URI,
                "client_id": os.environ.get("WHOOP_CLIENT_ID", ""),
                "client_secret": os.environ.get("WHOOP_CLIENT_SECRET", ""),
            },
        )
    if response.is_error:
        return _whoop_frontend_redirect("error")
    token = response.json()
    _WHOOP_TOKENS = {
        **token,
        "expires_at": time.time() + int(token.get("expires_in", 3600)),
    }
    return _whoop_frontend_redirect("connected")


@app.post("/api/integrations/whoop/sync")
async def sync_whoop():
    global _WHOOP_LAST_SYNC
    if not _WHOOP_TOKENS:
        raise HTTPException(status_code=409, detail="Connect WHOOP before syncing data.")
    end_time = datetime.now(timezone.utc)
    start_time = end_time - timedelta(days=90)
    start = start_time.isoformat().replace("+00:00", "Z")
    end = end_time.isoformat().replace("+00:00", "Z")
    cycles, sleeps, recoveries = await asyncio.gather(
        _whoop_collection("/v2/cycle", start, end),
        _whoop_collection("/v2/activity/sleep", start, end),
        _whoop_collection("/v2/recovery", start, end),
    )
    rows = _whoop_metrics(cycles, sleeps, recoveries)
    if rows:
        conn = get_conn()
        try:
            conn.execute("BEGIN TRANSACTION")
            for row in rows:
                conn.execute(
                    """INSERT INTO metrics (date, sleep_hours, sleep_score, recovery_score, workout_strain, resting_hr)
                       VALUES (?, ?, ?, ?, ?, ?)
                       ON CONFLICT(date) DO UPDATE SET
                         sleep_hours = COALESCE(EXCLUDED.sleep_hours, metrics.sleep_hours),
                         sleep_score = COALESCE(EXCLUDED.sleep_score, metrics.sleep_score),
                         recovery_score = COALESCE(EXCLUDED.recovery_score, metrics.recovery_score),
                         workout_strain = COALESCE(EXCLUDED.workout_strain, metrics.workout_strain),
                         resting_hr = COALESCE(EXCLUDED.resting_hr, metrics.resting_hr)""",
                    (row["date"], row["sleep_hours"], row["sleep_score"], row["recovery_score"], row["workout_strain"], row["resting_hr"]),
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
    _WHOOP_LAST_SYNC = datetime.now(timezone.utc).isoformat()
    return {
        "rows_synced": len(rows),
        "date_start": rows[0]["date"].isoformat() if rows else None,
        "date_end": rows[-1]["date"].isoformat() if rows else None,
        "last_sync": _WHOOP_LAST_SYNC,
    }


@app.delete("/api/integrations/whoop/connection")
async def disconnect_whoop():
    global _WHOOP_TOKENS
    if _WHOOP_TOKENS:
        try:
            token = await _whoop_token()
            async with httpx.AsyncClient(trust_env=False, timeout=15) as client:
                await client.delete(
                    f"{WHOOP_API}/v2/user/access",
                    headers={"Authorization": f"Bearer {token}"},
                )
        finally:
            _WHOOP_TOKENS = None
    return {"disconnected": True}


@app.get("/api/integrations/google-health/status")
def google_health_status():
    return {
        "configured": _google_health_configured(),
        "connected": _GOOGLE_HEALTH_TOKENS is not None,
        "last_sync": _GOOGLE_HEALTH_LAST_SYNC,
        "redirect_uri": GOOGLE_HEALTH_REDIRECT_URI,
    }


@app.get("/api/integrations/google-health/connect")
def connect_google_health():
    if not _google_health_configured():
        raise HTTPException(status_code=503, detail="Set GOOGLE_HEALTH_CLIENT_ID and GOOGLE_HEALTH_CLIENT_SECRET before connecting.")
    state = secrets.token_urlsafe(24)
    now = time.time()
    for old_state, expiry in list(_GOOGLE_HEALTH_OAUTH_STATES.items()):
        if expiry <= now:
            del _GOOGLE_HEALTH_OAUTH_STATES[old_state]
    _GOOGLE_HEALTH_OAUTH_STATES[state] = now + 600
    query = urlencode({
        "response_type": "code",
        "client_id": os.environ["GOOGLE_HEALTH_CLIENT_ID"],
        "redirect_uri": GOOGLE_HEALTH_REDIRECT_URI,
        "scope": GOOGLE_HEALTH_SCOPES,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    })
    return RedirectResponse(f"{GOOGLE_HEALTH_AUTH_URL}?{query}", status_code=302)


def _google_health_frontend_redirect(result: str):
    separator = "&" if "?" in GOOGLE_HEALTH_FRONTEND_URL else "?"
    return RedirectResponse(f"{GOOGLE_HEALTH_FRONTEND_URL}{separator}{urlencode({'google_health': result})}", status_code=303)


@app.get("/api/integrations/google-health/callback")
async def google_health_callback(code: str | None = None, state: str | None = None, error: str | None = None):
    global _GOOGLE_HEALTH_TOKENS
    expiry = _GOOGLE_HEALTH_OAUTH_STATES.pop(state, 0) if state else 0
    if expiry <= time.time() or error or not code or not _google_health_configured():
        return _google_health_frontend_redirect("error")
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=30) as client:
            response = await client.post(
                GOOGLE_HEALTH_TOKEN_URL,
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": GOOGLE_HEALTH_REDIRECT_URI,
                    "client_id": os.environ["GOOGLE_HEALTH_CLIENT_ID"],
                    "client_secret": os.environ["GOOGLE_HEALTH_CLIENT_SECRET"],
                },
            )
    except httpx.HTTPError:
        return _google_health_frontend_redirect("error")
    if response.is_error:
        return _google_health_frontend_redirect("error")
    token = response.json()
    _GOOGLE_HEALTH_TOKENS = {
        **token,
        "expires_at": time.time() + int(token.get("expires_in", 3600)),
    }
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=30) as client:
            identity_response = await client.get(
                f"{GOOGLE_HEALTH_API}/v4/users/me/identity",
                headers={"Authorization": f"Bearer {_GOOGLE_HEALTH_TOKENS['access_token']}"},
            )
    except httpx.HTTPError:
        _GOOGLE_HEALTH_TOKENS = None
        return _google_health_frontend_redirect("error")
    if identity_response.status_code == 400 and "ACCOUNT_NOT_LINKED" in identity_response.text:
        _GOOGLE_HEALTH_TOKENS = None
        return _google_health_frontend_redirect("not-linked")
    if identity_response.is_error:
        _GOOGLE_HEALTH_TOKENS = None
        return _google_health_frontend_redirect("error")
    return _google_health_frontend_redirect("connected")


@app.post("/api/integrations/google-health/sync")
async def sync_google_health():
    global _GOOGLE_HEALTH_LAST_SYNC
    if not _GOOGLE_HEALTH_TOKENS:
        raise HTTPException(status_code=409, detail="Connect Google Health before syncing data.")
    today = date.today()
    start_day = today - timedelta(days=89)
    end_day = today + timedelta(days=1)
    sleep_filter = f'sleep.interval.civil_end_time >= "{start_day.isoformat()}" AND sleep.interval.civil_end_time < "{end_day.isoformat()}"'
    heart_rate_filter = f'daily_resting_heart_rate.date >= "{start_day.isoformat()}" AND daily_resting_heart_rate.date < "{end_day.isoformat()}"'
    sleep_records, heart_rate_records = await asyncio.gather(
        _google_health_collection("sleep", reconcile=True, params={"filter": sleep_filter}),
        _google_health_collection("daily-resting-heart-rate", reconcile=False, params={"filter": heart_rate_filter}),
    )
    rows_by_date = {}
    for record in sleep_records:
        sleep = record.get("sleep", {})
        civil_end = sleep.get("interval", {}).get("civilEndTime", {}).get("date")
        session_end = sleep.get("interval", {}).get("endTime")
        day = _google_health_date(civil_end) or _google_health_date(session_end)
        hours = _google_health_sleep_hours(record)
        if day and hours is not None:
            values = rows_by_date.setdefault(day, {"sleep_hours": None, "resting_hr": None})
            total_hours = round((values["sleep_hours"] or 0) + hours, 2)
            values["sleep_hours"] = total_hours if total_hours <= 24 else values["sleep_hours"]
    for record in heart_rate_records:
        resting = record.get("dailyRestingHeartRate", {})
        day = _google_health_date(resting.get("date"))
        try:
            value = float(resting.get("beatsPerMinute"))
        except (TypeError, ValueError):
            continue
        if day and 20 <= value <= 250:
            rows_by_date.setdefault(day, {"sleep_hours": None, "resting_hr": None})["resting_hr"] = value
    rows = [{"date": day, **values} for day, values in sorted(rows_by_date.items())]
    if rows:
        conn = get_conn()
        try:
            conn.execute("BEGIN TRANSACTION")
            for row in rows:
                conn.execute(
                    """INSERT INTO metrics (date, sleep_hours, resting_hr) VALUES (?, ?, ?)
                       ON CONFLICT(date) DO UPDATE SET
                         sleep_hours = COALESCE(EXCLUDED.sleep_hours, metrics.sleep_hours),
                         resting_hr = COALESCE(EXCLUDED.resting_hr, metrics.resting_hr)""",
                    (row["date"], row["sleep_hours"], row["resting_hr"]),
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
    _GOOGLE_HEALTH_LAST_SYNC = datetime.now(timezone.utc).isoformat()
    return {
        "rows_synced": len(rows),
        "date_start": rows[0]["date"].isoformat() if rows else None,
        "date_end": rows[-1]["date"].isoformat() if rows else None,
        "last_sync": _GOOGLE_HEALTH_LAST_SYNC,
    }


@app.delete("/api/integrations/google-health/connection")
async def disconnect_google_health():
    global _GOOGLE_HEALTH_TOKENS
    if _GOOGLE_HEALTH_TOKENS:
        token = _GOOGLE_HEALTH_TOKENS.get("refresh_token") or _GOOGLE_HEALTH_TOKENS.get("access_token")
        try:
            async with httpx.AsyncClient(trust_env=False, timeout=15) as client:
                await client.post("https://oauth2.googleapis.com/revoke", data={"token": token})
        except httpx.HTTPError:
            pass
        finally:
            _GOOGLE_HEALTH_TOKENS = None
    return {"disconnected": True}


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


@app.get("/api/backup")
def download_backup():
    conn = get_conn()
    try:
        experiments = conn.execute(
            "SELECT id, habit, change, start_date, duration_days FROM experiments ORDER BY start_date"
        ).fetchall()
        checkins = conn.execute(
            "SELECT experiment_id, date, followed FROM experiment_checkins ORDER BY date"
        ).fetchall()
    finally:
        conn.close()
    document = {
        "format": "atmasutra-backup",
        "version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "metrics": _records("metrics"),
        "habits": _records("habits"),
        "annotations": get_annotations(),
        "experiments": [
            {
                "id": row[0],
                "habit": row[1],
                "change": row[2],
                "start_date": row[3].isoformat(),
                "duration_days": row[4],
            }
            for row in experiments
        ],
        "checkins": [
            {"experiment_id": row[0], "date": row[1].isoformat(), "followed": row[2]}
            for row in checkins
        ],
    }
    return JSONResponse(
        content=document,
        headers={"Content-Disposition": f'attachment; filename="atmasutra-backup-{date.today().isoformat()}.json"'},
    )


@app.post("/api/restore")
async def restore_backup(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".json"):
        raise HTTPException(status_code=400, detail="Choose an AtmaSutra JSON backup file.")
    content = await file.read(MAX_BACKUP_BYTES + 1)
    if len(content) > MAX_BACKUP_BYTES:
        raise HTTPException(status_code=413, detail="Backup files must be 20 MB or smaller.")
    try:
        backup = BackupDocument.model_validate(json.loads(content))
    except (json.JSONDecodeError, UnicodeDecodeError, ValidationError, ValueError) as error:
        raise HTTPException(status_code=400, detail=f"This backup is invalid: {error}") from error

    conn = get_conn()
    try:
        conn.execute("BEGIN TRANSACTION")
        for metric in backup.metrics:
            conn.execute(
                "INSERT OR REPLACE INTO metrics VALUES (?, ?, ?, ?, ?, ?)",
                (metric.date, metric.sleep_hours, metric.sleep_score, metric.recovery_score, metric.workout_strain, metric.resting_hr),
            )
        for habit in backup.habits:
            conn.execute(
                "INSERT OR REPLACE INTO habits VALUES (?, ?, ?)",
                (habit.date, habit.habit, habit.value),
            )
        for experiment in backup.experiments:
            conn.execute("DELETE FROM experiment_checkins WHERE experiment_id = ?", (experiment.id,))
            conn.execute(
                "INSERT OR REPLACE INTO experiments VALUES (?, ?, ?, ?, ?)",
                (experiment.id, experiment.habit, experiment.change, experiment.start_date, experiment.duration_days),
            )
        for checkin in backup.checkins:
            conn.execute(
                "INSERT OR REPLACE INTO experiment_checkins VALUES (?, ?, ?)",
                (checkin.experiment_id, checkin.date, checkin.followed),
            )
        for annotation in backup.annotations:
            conn.execute(
                "INSERT OR REPLACE INTO annotations (id, date, category, note) VALUES (?, ?, ?, ?)",
                (annotation.id, annotation.date, annotation.category, annotation.note),
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
    return {
        "metrics_restored": len(backup.metrics),
        "habits_restored": len(backup.habits),
        "experiments_restored": len(backup.experiments),
        "checkins_restored": len(backup.checkins),
        "annotations_restored": len(backup.annotations),
    }


@app.delete("/api/data")
def delete_local_data():
    conn = get_conn()
    try:
        conn.execute("BEGIN TRANSACTION")
        for table in ("experiment_checkins", "experiments", "annotations", "habits", "metrics"):
            conn.execute(f"DELETE FROM {table}")
        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()
    return {"deleted": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
