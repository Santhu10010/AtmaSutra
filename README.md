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

**Local by design** — health data lives in the user's application-data folder, outside the source code. There is no telemetry or automatic cloud sync. Optional WHOOP import makes an explicit connection only when the user chooses to connect and sync; optional coaching uses a locally installed Ollama model.

## What It Does

1. **Load demo data safely** into an empty database
2. **Compute next-day associations** — Spearman rank correlations with permutation tests and multiple-test correction
3. **Surface cautious experiment ideas** without claiming that correlation proves cause
4. **Optional AI coach** — local Ollama generates personalized bullet-point advice (falls back to template nudges gracefully)
5. **Upload AtmaSutra, Oura-, Whoop-, or Apple Health-style CSV columns** or log habits manually
6. **Connect WHOOP optionally** to import recent sleep, recovery, resting heart rate, and strain data
7. **Export metrics and habit logs as separate CSV files** for spreadsheets or re-import
8. **Connect Google Health optionally** to import sleep duration and resting heart rate from Google Fit-compatible sources

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
5. Start a personal experiment, check in daily, and review each day's next-day scores plus the final baseline comparison.
6. Add a dated timeline note for travel, illness, or stress to keep unusual days in context.
7. Use **Print / Save PDF** to create a shareable summary of the current local data.
8. Export metrics and habits as CSV, or download a full local backup and restore it later.

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

### Install as an app and use offline

AtmaSutra includes a PWA manifest, home-screen icons, and a service worker. Open it in a supported browser on `localhost` or over HTTPS, then choose **Install app** or **Add to Home Screen** from the browser menu. On iPhone/iPad, use **Share → Add to Home Screen**. Open the app online once so the dashboard and data can be saved for offline viewing. When offline, previously fetched dashboard data is read-only; logging, imports, sync, and other changes need the API connection. **Delete all local data** also clears the browser's saved data copy.

The current launcher binds both services to this computer. Installing from another device requires a reachable HTTPS deployment and a correctly configured `NEXT_PUBLIC_API_URL`; user accounts and cross-device sync are a later milestone and are not included yet.

### Optional: AI Coach

```bash
ollama pull llama3.2:3b
ollama serve
```

If Ollama isn't running, the app works fine with deterministic template nudges.
The first AI response after Ollama starts can take up to about 45 seconds while the model loads; later responses are faster.

### Optional: WHOOP Sync

Create an app in the [WHOOP Developer Dashboard](https://developer.whoop.com/), register this redirect URI, and allow `read:cycles`, `read:sleep`, and `read:recovery`. AtmaSutra also requests `offline` so it can refresh the connection during the current run:

```text
http://127.0.0.1:8000/api/integrations/whoop/callback
```

In the same PowerShell window used to launch AtmaSutra, set the app credentials and start the app:

```powershell
$env:WHOOP_CLIENT_ID = "your-client-id"
$env:WHOOP_CLIENT_SECRET = "your-client-secret"
.\start.cmd
```

Then choose **Connect WHOOP** in AtmaSutra and approve access. Sync imports up to 90 days. The access and refresh tokens stay in backend memory and are cleared when the local service stops, so reconnect after restarting AtmaSutra. Disconnect revokes WHOOP access; synced measurements remain in the local database.

### Optional: Google Health (Google Fit data)

Google Fit's legacy developer APIs are being deprecated. AtmaSutra uses Google's current Google Health API for cloud sync. It imports sleep duration and daily resting heart rate; Google Health does not provide the recovery score used by WHOOP. You need a Google Health profile linked to your Google account in the Google Health mobile app before connecting.

Create a Google Cloud project, enable Google Health API, create a Web application OAuth client, and add this AtmaSutra callback as an authorized redirect URI:

```text
http://127.0.0.1:8000/api/integrations/google-health/callback
```

While the OAuth consent screen is in Testing mode, add your Google account as a test user. In the same PowerShell window used to launch AtmaSutra, set the credentials and start the app:

```powershell
$env:GOOGLE_HEALTH_CLIENT_ID = "your-client-id"
$env:GOOGLE_HEALTH_CLIENT_SECRET = "your-client-secret"
.\start.cmd
```

Choose **Connect Google Health**, approve read-only sleep and health-metric access, and use **Sync Google Health** to import up to 90 days. The connection uses the production API (Google does not provide a sandbox), and tokens stay in backend memory until the local service stops. Reconnect after restarting AtmaSutra. Disconnect revokes access; already synced data remains on this device.

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
| GET | `/api/backup` | Download a local JSON backup |
| POST | `/api/restore` | Validate and merge a JSON backup |
| DELETE | `/api/data` | Delete all local health and experiment data |
| GET | `/api/integrations/whoop/connect` | Start WHOOP OAuth consent |
| GET | `/api/integrations/whoop/status` | Check local WHOOP connection state |
| POST | `/api/integrations/whoop/sync` | Sync recent WHOOP scores |
| DELETE | `/api/integrations/whoop/connection` | Revoke and clear the WHOOP connection |
| GET | `/api/integrations/google-health/connect` | Start Google Health OAuth consent |
| GET | `/api/integrations/google-health/status` | Check local Google Health connection state |
| POST | `/api/integrations/google-health/sync` | Sync recent sleep and resting heart rate |
| DELETE | `/api/integrations/google-health/connection` | Revoke and clear the Google Health connection |

## MVP vs. 24-Hour Sprint Roadmap

### ✅ MVP (Current)
- Safe demo data generation with embedded associations
- Next-day Spearman analysis with permutation-based adjusted p-values
- Deterministic coaching nudges + optional Ollama AI
- Interactive charts (Recharts)
- CSV upload and manual habit logging
- CSV export for metrics and habits
- Dated notes for travel, illness, stress, and other context
- Print-ready personal summaries for saving or sharing as PDF
- Local JSON backup and restore
- Confirmed deletion of all local data
- Daily experiment check-ins and before/during comparisons
- Data coverage and optional WHOOP / Google Health sync
- Privacy-first: DuckDB local storage; external connections are opt-in

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
