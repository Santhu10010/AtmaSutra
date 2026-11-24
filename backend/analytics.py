"""Compute next-day correlations and generate cautious coaching nudges."""
import math

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
import httpx

from db import get_conn

METRIC_COLS = ["sleep_hours", "sleep_score", "recovery_score", "resting_hr"]
SUGGESTIONS = {
    "late_dinner": "Try finishing dinner earlier and see whether the pattern repeats.",
    "alcohol_drinks": "Try fewer drinks and compare several similar nights.",
    "exercise_min": "Compare similar days before treating this as a personal pattern.",
    "screen_before_bed_hrs": "Try reducing evening screen time and compare several nights.",
}

def compute_insights():
    conn = get_conn()
    try:
        metrics = conn.execute("SELECT * FROM metrics ORDER BY date").fetchdf()
        habits = conn.execute("SELECT * FROM habits ORDER BY date").fetchdf()
    finally:
        conn.close()

    if metrics.empty or habits.empty:
        return []

    habits_wide = habits.pivot_table(index="date", columns="habit", values="value", aggfunc="first").reset_index()
    habits_wide["metric_date"] = pd.to_datetime(habits_wide["date"]) + pd.Timedelta(days=1)
    metrics["metric_date"] = pd.to_datetime(metrics["date"])
    merged = pd.merge(habits_wide.drop(columns="date"), metrics.drop(columns="date"), on="metric_date", how="inner")

    if len(merged) < 5:
        return []

    habit_cols = [c for c in habits_wide.columns if c != "date"]
    habit_cols.remove("metric_date")
    results = []
    test_count = max(1, len(habit_cols) * len(METRIC_COLS))

    for habit in habit_cols:
        for metric in METRIC_COLS:
            if habit not in merged.columns or metric not in merged.columns:
                continue
            x = merged[habit].astype(float)
            y = merged[metric].astype(float)
            mask = x.notna() & y.notna()
            x, y = x[mask], y[mask]
            if len(x) < 5 or x.nunique() < 2 or y.nunique() < 2:
                continue

            r, p = spearmanr(x, y)
            if not math.isfinite(r) or not math.isfinite(p):
                continue
            med = x.median()
            if med == x.min():
                high = y[x > 0].mean()
                low = y[x == 0].mean()
            else:
                high = y[x > med].mean()
                low = y[x <= med].mean()

            if np.isnan(high) or np.isnan(low):
                continue
            delta = high - low
            delta_pct = (delta / low * 100) if low != 0 else 0
            adjusted_p = min(float(p) * test_count, 1.0)
            nudge = _make_nudge(habit, metric, delta)
            results.append({
                "habit": habit, "metric": metric,
                "correlation": round(r, 3), "p_value": round(p, 4),
                "p_adjusted": round(adjusted_p, 4), "n": int(len(x)),
                "delta": round(delta, 1), "delta_pct": round(delta_pct, 1),
                "nudge": nudge,
            })

    results.sort(key=lambda r: abs(r["correlation"]), reverse=True)

    return results

def _make_nudge(habit, metric, delta):
    direction = "higher" if delta > 0 else "lower"
    unit = "hours" if metric == "sleep_hours" else "bpm" if metric == "resting_hr" else "points"
    suggestion = SUGGESTIONS.get(habit, "Collect more days before treating this as a personal pattern.")
    return (
        f"{habit.replace('_', ' ').title()} was associated with {abs(delta):.1f} {unit} "
        f"{direction} {metric.replace('_', ' ')}. {suggestion}"
    )

async def try_ollama_nudge(insights: list[dict]) -> str | None:
    """Try local Ollama for AI summary. Returns None if unavailable."""
    summary_data = "\n".join(
        f"- {i['habit']} -> {i['metric']}: r={i['correlation']}, adjusted p={i['p_adjusted']}"
        for i in insights[:6]
    )
    prompt = f"""You are a cautious health coach. These are associations, not proof of cause. Write 3 short experiment ideas (max 20 words each).

{summary_data}

Respond with just the 3 bullets."""

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post("http://localhost:11434/api/generate", json={
                "model": "llama3.2:3b", "prompt": prompt, "stream": False
            })
            if resp.status_code == 200:
                return resp.json().get("response", "").strip()
    except Exception:
        pass
    return None
