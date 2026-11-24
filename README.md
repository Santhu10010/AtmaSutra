# 🧘 AtmaSutra — Self-Insight Thread

> **wHACKiest 2026 · Track 03: Know Thyself**
> Local-first personal health and habit insight dashboard.

## Architecture

```
frontend/ (Next.js + Tailwind + Recharts)  →  http://localhost:3000
    ↕  REST API
backend/  (FastAPI + DuckDB + SciPy)       →  http://localhost:8000
    ↕  optional
Ollama (llama3.2:3b)                       →  http://localhost:11434
```

**Local by design** — health data lives in a local DuckDB file. There is no telemetry or cloud sync. Optional coaching uses a locally installed Ollama model.

## What It Does

1. **Load demo data safely** into an empty database
2. **Compute next-day associations** — Spearman rank correlations with multiple-test correction
3. **Surface cautious experiment ideas** without claiming that correlation proves cause
4. **Optional AI coach** — local Ollama generates personalized bullet-point advice (falls back to template nudges gracefully)
5. **Upload AtmaSutra, Oura-, Whoop-, or Apple Health-style CSV columns** or log habits manually

## Quick Start (< 5 minutes)

### First-time setup

```bash
cd backend
python -m venv venv
# Windows: venv\Scripts\activate
# macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
```

```bash
cd ..
cd frontend
npm install
```

### Start the complete app on Windows

From the AtmaSutra folder, double-click `start.cmd` or run:

```powershell
.\start.cmd
```

This starts both the local data service and the page. Keep the terminal open, visit **http://localhost:3000**, and press `Ctrl+C` when finished.

### Manual start (all platforms)

If you prefer, run these in two separate terminals:

```bash
cd backend
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

```bash
cd frontend
npm run dev
```

Open **http://localhost:3000** → click **Load demo data** on an empty database → explore.

The demo endpoint refuses to replace existing data.

### Optional: AI Coach

```bash
ollama pull llama3.2:3b
ollama serve
```

If Ollama isn't running, the app works fine with deterministic template nudges.

## Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/demo-data` | Generate 21 days of sample data when the database is empty |
| GET | `/api/metrics` | All health metrics |
| GET | `/api/habits` | All habit logs |
| GET | `/api/insights` | Computed correlations + nudges |
| POST | `/api/upload-csv` | Import CSV (metrics or habits) |
| POST | `/api/log-habit` | Log a single habit entry |

## MVP vs. 24-Hour Sprint Roadmap

### ✅ MVP (Current)
- Safe demo data generation with embedded associations
- Next-day Spearman analysis with adjusted p-values
- Deterministic coaching nudges + optional Ollama AI
- Interactive charts (Recharts)
- CSV upload and manual habit logging
- Privacy-first: DuckDB local storage, no network calls

### 🚀 24-Hour Sprint
- Additional vendor-specific import templates and units
- Lagged correlation (habit on day N → metric on day N+1)
- Weekly/monthly trend views
- Habit streaks and goal tracking
- Dark mode toggle
- Export insights as PDF
- Multi-user profiles (still local)

## Tech Stack

- **Frontend:** Next.js 16 (App Router), Tailwind CSS, Recharts
- **Backend:** FastAPI, DuckDB, pandas, SciPy
- **AI (optional):** Ollama with llama3.2:3b
- **Storage:** DuckDB (local file, zero config)

## CSV columns

The importer accepts the native AtmaSutra names plus common aliases:

- Date: `date`, `day`, `Date`, or `Cycle start time`
- Sleep: `sleep_hours`, `Sleep Analysis [hr]`, `total_sleep_duration`, `sleep_score`, `score`, or `Sleep performance %`
- Recovery and strain: `recovery_score`, `Recovery score %`, `workout_strain`, or `Day Strain`
- Resting heart rate: `resting_hr`, `average_heart_rate`, `Resting heart rate (bpm)`, or `Resting Heart Rate [count/min]`

Imports are validated and committed as one transaction: an invalid row leaves the database unchanged.

## Checks

```bash
cd backend
python -m unittest -v test_app.py

cd ../frontend
npm run lint
npm run build
```
