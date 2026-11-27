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

**Local by design** — health data lives in the user's application-data folder, outside the source code. There is no telemetry or cloud sync. Optional coaching connects directly to a locally installed Ollama model without using system proxies.

## What It Does

1. **Load demo data safely** into an empty database
2. **Compute next-day associations** — Spearman rank correlations with permutation tests and multiple-test correction
3. **Surface cautious experiment ideas** without claiming that correlation proves cause
4. **Optional AI coach** — local Ollama generates personalized bullet-point advice (falls back to template nudges gracefully)
5. **Upload AtmaSutra, Oura-, Whoop-, or Apple Health-style CSV columns** or log habits manually

## Quick Start (< 5 minutes)

### Prerequisites

- Python 3.12 or newer
- Node.js 20 or newer

The Windows launcher creates the Python environment and installs missing packages automatically on the first run.

### Start the complete app on Windows

From the AtmaSutra folder, double-click `start.cmd` or run:

```powershell
.\start.cmd
```

This starts both the local data service and the page. Keep the terminal open, visit **http://localhost:3000**, and press `Ctrl+C` when finished.

### Showcase flow

1. Click **Load demo data** to create 21 days of local sample data.
2. Point out the next-day pattern cards and their sample size and adjusted p-value.
3. Use **Quick habit log** to save today's habit without replacing earlier data.
4. Explain that Ollama is optional; the dashboard and cautious template recommendations work without it.
5. Start a 7-day personal experiment, check in daily, and compare sleep and recovery with the prior week.
6. Add a dated timeline note for travel, illness, or stress to keep unusual days in context.

### Manual start (all platforms)

If you prefer, run these in two separate terminals:

```bash
cd backend
python -m venv venv
# Windows: venv\Scripts\activate
# macOS/Linux: source venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

```bash
cd frontend
npm install
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
The first AI response after Ollama starts can take up to about 45 seconds while the model loads; later responses are faster.

## Local data location

- Windows: `%LOCALAPPDATA%\AtmaSutra\atmasutra.duckdb`
- Linux and other platforms: `$XDG_DATA_HOME/AtmaSutra/atmasutra.duckdb`, or `~/.local/share/AtmaSutra/atmasutra.duckdb`

Set `ATMASUTRA_DATA_DIR` to use another local folder.

AtmaSutra's DuckDB storage is intended for one local backend process. Keep Uvicorn at its default single worker; use a client/server database such as PostgreSQL before deploying multiple backend workers.

## Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/demo-data` | Generate 21 days of sample data when the database is empty |
| GET | `/api/metrics` | All health metrics |
| GET | `/api/habits` | All habit logs |
| GET | `/api/insights` | Computed correlations + nudges |
| POST | `/api/upload-csv` | Import CSV (metrics or habits) |
| POST | `/api/log-habit` | Log a single habit entry |
| GET/POST | `/api/annotations` | List and save dated context notes |
| DELETE | `/api/annotations/{id}` | Remove a context note |

## MVP vs. 24-Hour Sprint Roadmap

### ✅ MVP (Current)
- Safe demo data generation with embedded associations
- Next-day Spearman analysis with permutation-based adjusted p-values
- Deterministic coaching nudges + optional Ollama AI
- Interactive charts (Recharts)
- CSV upload and manual habit logging
- Dated notes for travel, illness, stress, and other context
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
