"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import PwaStatus from "./pwa-status";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

type MetricRecord = {
  date: string;
  sleep_hours: number | null;
  sleep_score: number | null;
  recovery_score: number | null;
  workout_strain: number | null;
  resting_hr: number | null;
};

type HabitRecord = { date: string; habit: string; value: number };
type Annotation = { id: string; date: string; category: "travel" | "illness" | "stress" | "other"; note: string };

type Insight = {
  habit: string;
  metric: string;
  correlation: number;
  p_value: number;
  p_adjusted: number;
  n: number;
  delta: number;
  delta_pct: number;
  nudge: string;
};

type InsightResponse = { insights: Insight[]; ai_nudge: string | null };
type WhoopStatus = { configured: boolean; connected: boolean; last_sync: string | null; redirect_uri: string };
type GoogleHealthStatus = { configured: boolean; connected: boolean; last_sync: string | null; redirect_uri: string };
type CsvPreview = {
  kind: "metrics" | "habits";
  rows_imported: number;
  columns_imported: string[];
  date_start: string;
  date_end: string;
  replacements: number;
  sample_rows: Array<Record<string, string | number | null>>;
};
type PendingAction = "demo" | "upload" | "backup" | "restore" | "deleteData" | "whoopSync" | "whoopDisconnect" | "googleHealthSync" | "googleHealthDisconnect" | "habit" | "experiment" | "checkin" | "annotation" | "deleteAnnotation" | null;
type HabitName = "late_dinner" | "alcohol_drinks" | "exercise_min" | "screen_before_bed_hrs";
type ChartDatum = Record<string, string | number | null> & { dateLabel: string };
type Experiment = {
  id: string;
  habit: HabitName;
  change: string;
  start_date: string;
  duration_days: number;
  end_date: string;
  completed: boolean;
  checkins: Array<{ date: string; followed: boolean }>;
  checked_in_today: boolean;
  baseline: { sleep_score: number | null; sleep_score_days: number; recovery_score: number | null; recovery_score_days: number };
  during: { sleep_score: number | null; sleep_score_days: number; recovery_score: number | null; recovery_score_days: number };
};

const habitOptions: Array<{ value: HabitName; label: string; step: number; max: number; defaultValue: string }> = [
  { value: "late_dinner", label: "Late dinner", step: 1, max: 1, defaultValue: "1" },
  { value: "alcohol_drinks", label: "Alcohol (drinks)", step: 1, max: 20, defaultValue: "0" },
  { value: "exercise_min", label: "Exercise (minutes)", step: 5, max: 1440, defaultValue: "30" },
  { value: "screen_before_bed_hrs", label: "Screen before bed (hours)", step: 0.25, max: 24, defaultValue: "1" },
];

function localDate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDate(date: string, days: number) {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function formatP(value: number) {
  if (value < 0.0001) return "<0.0001";
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function errorMessage(payload: unknown, status: number) {
  if (payload && typeof payload === "object" && "detail" in payload) {
    const detail = (payload as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) return detail.map((item) => (typeof item === "object" && item && "msg" in item ? item.msg : String(item))).join(" ");
  }
  return `Request failed (${status}). Check that the local API is running.`;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { cache: "no-store", ...init });
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === "AbortError") throw reason;
    throw new Error("Could not reach AtmaSutra's local data service. Start the backend, or close this dev server and run start.cmd, then try again.");
  }
  if (response.ok && (init?.method ?? "GET").toUpperCase() === "GET" && typeof caches !== "undefined") {
    void caches.open("atmasutra-offline-v2-data").then((cache) => cache.put(`${API}${path}`, response.clone())).catch(() => undefined);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorMessage(payload, response.status));
  return payload as T;
}

export default function Home() {
  const [metrics, setMetrics] = useState<MetricRecord[]>([]);
  const [habits, setHabits] = useState<HabitRecord[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [experiment, setExperiment] = useState<Experiment | null>(null);
  const [whoopStatus, setWhoopStatus] = useState<WhoopStatus | null>(null);
  const [googleHealthStatus, setGoogleHealthStatus] = useState<GoogleHealthStatus | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [aiNudge, setAiNudge] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [today, setToday] = useState("");
  const [activeSection, setActiveSection] = useState("overview");
  const [pending, setPending] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [csvPreview, setCsvPreview] = useState<{ file: File; summary: CsvPreview } | null>(null);
  const [habitForm, setHabitForm] = useState({ date: "", habit: "late_dinner" as HabitName, value: "1" });
  const [experimentForm, setExperimentForm] = useState({ habit: "late_dinner" as HabitName, change: "", duration_days: 7 });
  const [annotationForm, setAnnotationForm] = useState({ date: "", category: "travel" as Annotation["category"], note: "" });

  const fetchAll = useCallback(async (signal?: AbortSignal) => {
    const [metricRows, habitRows, insightData, experimentData, annotationRows, whoopData, googleHealthData] = await Promise.all([
      fetchJson<MetricRecord[]>("/api/metrics", { signal }),
      fetchJson<HabitRecord[]>("/api/habits", { signal }),
      fetchJson<InsightResponse>("/api/insights", { signal }),
      fetchJson<{ experiment: Experiment | null }>("/api/experiments", { signal }),
      fetchJson<Annotation[]>("/api/annotations", { signal }),
      fetchJson<WhoopStatus>("/api/integrations/whoop/status", { signal }),
      fetchJson<GoogleHealthStatus>("/api/integrations/google-health/status", { signal }),
    ]);
    setMetrics(metricRows);
    setHabits(habitRows);
    setExperiment(experimentData.experiment);
    setAnnotations(annotationRows);
    setWhoopStatus(whoopData);
    setGoogleHealthStatus(googleHealthData);
    setInsights(insightData.insights ?? []);
    setAiNudge(insightData.ai_nudge ?? null);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await fetchAll();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load local data.");
    } finally {
      setLoading(false);
    }
  }, [fetchAll]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setToday(localDate());
      setHabitForm((current) => current.date ? current : { ...current, date: localDate() });
      setAnnotationForm((current) => current.date ? current : { ...current, date: localDate() });
      const whoopResult = new URLSearchParams(window.location.search).get("whoop");
      if (whoopResult) {
        setMessage(whoopResult === "connected" ? "WHOOP connected. Sync your recent data when ready." : "WHOOP connection failed or was cancelled. Check your app settings and try again.");
        window.history.replaceState({}, "", window.location.pathname);
      }
      const googleHealthResult = new URLSearchParams(window.location.search).get("google_health");
      if (googleHealthResult) {
        setMessage(googleHealthResult === "connected"
          ? "Google Health connected. Sync your recent sleep and resting heart rate when ready."
          : googleHealthResult === "not-linked"
            ? "Link Google Health to this Google account in the Google Health mobile app, then connect again."
            : "Google Health connection failed or was cancelled. Check your account and app settings, then try again.");
        window.history.replaceState({}, "", window.location.pathname);
      }
      void fetchAll(controller.signal)
        .catch((reason) => {
          if (reason instanceof DOMException && reason.name === "AbortError") return;
          setError(reason instanceof Error ? reason.message : "Could not load local data.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    });
    return () => controller.abort();
  }, [fetchAll]);

  const runAction = async (action: Exclude<PendingAction, null>, task: () => Promise<void>) => {
    setPending(action);
    setError(null);
    setMessage(null);
    try {
      await task();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The action could not be completed.");
    } finally {
      setPending(null);
    }
  };

  const loadDemo = () => runAction("demo", async () => {
    await fetchJson("/api/demo-data", { method: "POST" });
    await fetchAll();
    setMessage("Demo data loaded. Your existing data was not replaced.");
  });

  const uploadCSV = (file: File) => runAction("upload", async () => {
    setCsvPreview(null);
    const form = new FormData();
    form.append("file", file);
    const summary = await fetchJson<CsvPreview>("/api/preview-csv", { method: "POST", body: form });
    setCsvPreview({ file, summary });
    setMessage("Review the CSV preview before importing.");
  });

  const downloadBackup = () => runAction("backup", async () => {
    let response: Response;
    try {
      response = await fetch(`${API}/api/backup`, { cache: "no-store" });
    } catch {
      throw new Error("Could not reach AtmaSutra's local data service to create a backup.");
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(errorMessage(payload, response.status));
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `atmasutra-backup-${localDate()}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage("Local backup downloaded.");
  });

  const exportCSV = (kind: "metrics" | "habits") => {
    const headers = kind === "metrics"
      ? ["date", "sleep_hours", "sleep_score", "recovery_score", "workout_strain", "resting_hr"]
      : ["date", "habit", "value"];
    const rows = kind === "metrics"
      ? metrics.map((row) => headers.map((column) => column === "date" ? String(row.date).slice(0, 10) : row[column as keyof MetricRecord] as number | null))
      : habits.map((row) => [String(row.date).slice(0, 10), row.habit, row.value]);
    if (!rows.length) return;
    const csvCell = (value: string | number | null) => {
      const text = value === null ? "" : String(value);
      const safeText = typeof value === "string" && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      return `"${safeText.replaceAll('"', '""')}"`;
    };
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `atmasutra-${kind}-${localDate()}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage(`${kind === "metrics" ? "Metrics" : "Habit logs"} CSV downloaded.`);
  };

  const restoreBackup = (file: File) => {
    if (!window.confirm("Restore this AtmaSutra backup? Records with matching keys will be replaced; unrelated local records will be kept.")) return;
    void runAction("restore", async () => {
      const form = new FormData();
      form.append("file", file);
      const result = await fetchJson<{
        metrics_restored: number;
        habits_restored: number;
        experiments_restored: number;
        checkins_restored: number;
        annotations_restored: number;
      }>("/api/restore", { method: "POST", body: form });
      await fetchAll();
      setMessage(`Backup restored: ${result.metrics_restored} metrics, ${result.habits_restored} habits, ${result.experiments_restored} experiments, ${result.checkins_restored} check-ins, and ${result.annotations_restored} notes.`);
    });
  };

  const deleteLocalData = () => {
    if (!window.confirm("Permanently delete all health metrics, habits, experiments, check-ins, and timeline notes from this device? Download a backup first if you may need this data later.")) return;
    void runAction("deleteData", async () => {
      await fetchJson("/api/data", { method: "DELETE" });
      if (typeof caches !== "undefined") await caches.delete("atmasutra-offline-v2-data");
      setCsvPreview(null);
      await fetchAll();
      setMessage("All AtmaSutra data was deleted from this device. Downloaded backup files were not affected.");
    });
  };

  const syncWhoop = () => runAction("whoopSync", async () => {
    const result = await fetchJson<{ rows_synced: number; date_start: string | null; date_end: string | null }>("/api/integrations/whoop/sync", { method: "POST" });
    await fetchAll();
    setMessage(result.rows_synced
      ? `Synced ${result.rows_synced} WHOOP days${result.date_start && result.date_end ? ` (${result.date_start} to ${result.date_end})` : ""}.`
      : "WHOOP connected, but no scored data was available in the last 90 days.");
  });

  const disconnectWhoop = () => {
    if (!window.confirm("Disconnect WHOOP and revoke AtmaSutra's access? Data already synced will stay on this device.")) return;
    void runAction("whoopDisconnect", async () => {
      await fetchJson("/api/integrations/whoop/connection", { method: "DELETE" });
      await fetchAll();
      setMessage("WHOOP disconnected. Synced data remains on this device.");
    });
  };

  const syncGoogleHealth = () => runAction("googleHealthSync", async () => {
    const result = await fetchJson<{ rows_synced: number; date_start: string | null; date_end: string | null }>("/api/integrations/google-health/sync", { method: "POST" });
    await fetchAll();
    setMessage(result.rows_synced
      ? `Synced ${result.rows_synced} Google Health days${result.date_start && result.date_end ? ` (${result.date_start} to ${result.date_end})` : ""}.`
      : "Google Health is connected, but no sleep or resting heart rate data was available in the last 90 days.");
  });

  const disconnectGoogleHealth = () => {
    if (!window.confirm("Disconnect Google Health and revoke AtmaSutra's access? Data already synced will stay on this device.")) return;
    void runAction("googleHealthDisconnect", async () => {
      await fetchJson("/api/integrations/google-health/connection", { method: "DELETE" });
      await fetchAll();
      setMessage("Google Health disconnected. Synced measurements remain on this device.");
    });
  };

  const importCSV = () => {
    if (!csvPreview) return;
    void runAction("upload", async () => {
      const form = new FormData();
      form.append("file", csvPreview.file);
      const result = await fetchJson<{ rows_imported: number }>("/api/upload-csv", { method: "POST", body: form });
    await fetchAll();
      setCsvPreview(null);
    setMessage(`${result.rows_imported} CSV row${result.rows_imported === 1 ? "" : "s"} imported.`);
    });
  };

  const logHabit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runAction("habit", async () => {
      await fetchJson("/api/log-habit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...habitForm, value: Number(habitForm.value) }),
      });
      await fetchAll();
      setMessage("Habit saved.");
    });
  };

  const startExperiment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runAction("experiment", async () => {
      await fetchJson("/api/experiments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(experimentForm),
      });
      await fetchAll();
      setMessage("Experiment started. Check in each day to track your progress.");
    });
  };

  const checkInExperiment = (followed: boolean) => runAction("checkin", async () => {
    await fetchJson("/api/experiments/check-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ followed }),
    });
    await fetchAll();
    setMessage("Today's experiment check-in is saved.");
  });

  const saveAnnotation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runAction("annotation", async () => {
      await fetchJson("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(annotationForm),
      });
      await fetchAll();
      setAnnotationForm((current) => ({ ...current, note: "" }));
      setMessage("Timeline note saved.");
    });
  };

  const removeAnnotation = (id: string) => runAction("deleteAnnotation", async () => {
    await fetchJson(`/api/annotations/${encodeURIComponent(id)}`, { method: "DELETE" });
    await fetchAll();
    setMessage("Timeline note removed.");
  });

  const chartData = useMemo<ChartDatum[]>(() => {
    const habitsByDate = new Map<string, HabitRecord[]>();
    for (const habit of habits) {
      const key = String(habit.date).slice(0, 10);
      habitsByDate.set(key, [...(habitsByDate.get(key) ?? []), habit]);
    }
    return metrics.map((metric) => {
      const date = String(metric.date).slice(0, 10);
      const datum: ChartDatum = { ...metric, dateLabel: date.slice(5) };
      for (const habit of habitsByDate.get(date) ?? []) datum[habit.habit] = habit.value;
      return datum;
    });
  }, [habits, metrics]);

  const dataCoverage = useMemo(() => {
    const scoreDates = new Set(
      metrics
        .filter((metric) => metric.sleep_score !== null || metric.recovery_score !== null)
        .map((metric) => String(metric.date).slice(0, 10)),
    );
    const habitDates = new Set(habits.map((habit) => String(habit.date).slice(0, 10)));
    const matchedDays = [...habitDates].filter((day) => scoreDates.has(shiftDate(day, 1))).length;
    const sortedScoreDates = [...scoreDates].sort();
    const spanDays = sortedScoreDates.length
      ? (Date.parse(`${sortedScoreDates[sortedScoreDates.length - 1]}T00:00:00Z`) - Date.parse(`${sortedScoreDates[0]}T00:00:00Z`)) / 86_400_000 + 1
      : 0;
    return {
      scoreDays: scoreDates.size,
      habitDays: habitDates.size,
      matchedDays,
      missingScoreDays: spanDays - scoreDates.size,
    };
  }, [habits, metrics]);

  const experimentDays = useMemo(() => {
    if (!experiment) return [];
    const lastDate = experiment.completed || (today && experiment.end_date < today)
      ? experiment.end_date
      : today || experiment.start_date;
    const rows: Array<{ date: string; followed: boolean | null; nextDay: MetricRecord | undefined }> = [];
    for (let date = experiment.start_date; date <= lastDate; date = shiftDate(date, 1)) {
      const checkin = experiment.checkins.find((item) => item.date === date);
      const nextDate = shiftDate(date, 1);
      rows.push({
        date,
        followed: checkin?.followed ?? null,
        nextDay: metrics.find((item) => String(item.date).slice(0, 10) === nextDate),
      });
    }
    return rows;
  }, [experiment, metrics, today]);

  const reportPeriod = useMemo(() => {
    const dates = [...metrics.map((metric) => metric.date), ...habits.map((habit) => habit.date)]
      .map((value) => String(value).slice(0, 10))
      .sort();
    return dates.length ? `${dates[0]} to ${dates[dates.length - 1]}` : "No dated records";
  }, [habits, metrics]);

  const topInsights = useMemo(
    () => insights.filter((item) => item.p_adjusted <= 0.05 && Math.abs(item.correlation) > 0.3).slice(0, 6),
    [insights],
  );
  const hasData = metrics.length > 0 || habits.length > 0;
  const busy = loading || pending !== null;
  const selectedHabit = habitOptions.find((option) => option.value === habitForm.habit) ?? habitOptions[0];

  useEffect(() => {
    if (!hasData || !("IntersectionObserver" in window)) return;
    const sections = ["overview", "patterns", "trends", "experiment", "quick-log", "notes", "sources"]
      .map((id) => document.getElementById(id))
      .filter((section): section is HTMLElement => section !== null);
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActiveSection(visible.target.id);
    }, { rootMargin: "-18% 0px -68% 0px", threshold: 0 });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [hasData]);

  const renderExperimentDays = (completed: boolean) => (
    <>
      <h3 className="mt-5 text-base font-semibold">Daily check-ins and next-day scores</h3>
      <div className="mt-3 space-y-2">
        {experimentDays.map((day) => (
          <div key={day.date} className={`grid gap-2 rounded-xl p-3 text-sm sm:grid-cols-[minmax(8rem,0.7fr)_minmax(8rem,0.6fr)_minmax(12rem,1.5fr)] sm:items-center ${completed ? "bg-white dark:bg-gray-900" : "bg-gray-50 dark:bg-gray-800"}`}>
            <span className="font-medium">{day.date}</span>
            <span className="text-gray-600 dark:text-gray-300">{day.followed === null ? "No check-in" : day.followed ? "Plan followed" : "Plan not followed"}</span>
            <span className="text-gray-600 dark:text-gray-300">Next day ({shiftDate(day.date, 1)}): {day.nextDay && (day.nextDay.sleep_score !== null || day.nextDay.recovery_score !== null)
              ? `Sleep ${day.nextDay.sleep_score ?? "—"} · Recovery ${day.nextDay.recovery_score ?? "—"}`
              : "No scores recorded"}</span>
          </div>
        ))}
        {!experimentDays.length && experiment && <p className="text-sm text-gray-600 dark:text-gray-300">Your first experiment day starts {experiment.start_date}.</p>}
      </div>
    </>
  );

  return (
    <main className="app-shell mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <header className="app-header mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight">AtmaSutra</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Sleep, recovery, and everyday habits</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <p className="privacy-note max-w-full rounded-full px-3 py-1.5 text-xs font-semibold">
            Data stays on this device
          </p>
          <PwaStatus />
        </div>
      </header>

      {hasData && <nav className="dashboard-nav mb-6" aria-label="Dashboard sections">
        {[
          ["overview", "Overview"], ["patterns", "Patterns"], ["trends", "Trends"],
          ["experiment", "Experiment"], ["quick-log", "Habit log"], ["notes", "Notes"], ["sources", "Sources"],
        ].map(([id, label]) => (
          <a key={id} href={`#${id}`} aria-current={activeSection === id ? "location" : undefined} className={activeSection === id ? "dashboard-nav-link is-active" : "dashboard-nav-link"}>{label}</a>
        ))}
      </nav>}

      <div className="dashboard-actions mb-8">
        <div className="flex flex-wrap items-center gap-3">
          {hasData ? (
            <a href="#quick-log" className="primary-action">Log a habit</a>
          ) : (
            <button type="button" onClick={() => void loadDemo()} disabled={busy} className="primary-action disabled:cursor-not-allowed disabled:opacity-60">
              {pending === "demo" ? "Loading demo…" : "Load demo data"}
            </button>
          )}
        <input
          id="csv-upload"
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void uploadCSV(file);
            event.currentTarget.value = "";
          }}
          className="peer sr-only"
        />
        <label
          htmlFor="csv-upload"
          className="secondary-action flex min-h-11 cursor-pointer items-center justify-center peer-disabled:cursor-not-allowed peer-disabled:opacity-60 peer-focus-visible:outline peer-focus-visible:outline-3 peer-focus-visible:outline-offset-3 peer-focus-visible:outline-indigo-400"
        >
          {pending === "upload" ? "Importing CSV…" : "Upload CSV"}
        </label>
        </div>
        <details className="data-tools">
          <summary aria-label="Open data tools">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M7 12h10m-7 5h4" /></svg>
            <span>More tools</span>
          </summary>
          <div className="data-tools-menu">
        <button type="button" onClick={() => exportCSV("metrics")} disabled={!metrics.length || busy} className="min-h-11 rounded-xl border border-gray-300 px-4 py-2 font-semibold transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:hover:bg-gray-900">
          Export metrics CSV
        </button>
        <button type="button" onClick={() => exportCSV("habits")} disabled={!habits.length || busy} className="min-h-11 rounded-xl border border-gray-300 px-4 py-2 font-semibold transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:hover:bg-gray-900">
          Export habits CSV
        </button>
        <button
          type="button"
          onClick={() => void downloadBackup()}
          disabled={busy}
          className="min-h-11 rounded-xl border border-gray-300 px-4 py-2 font-semibold transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          {pending === "backup" ? "Preparing backup…" : "Download backup"}
        </button>
        <input
          id="backup-restore"
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) restoreBackup(file);
            event.currentTarget.value = "";
          }}
          className="peer sr-only"
        />
        <label
          htmlFor="backup-restore"
          className="flex min-h-11 cursor-pointer items-center justify-center rounded-xl border border-gray-300 px-4 py-2 font-semibold transition-colors hover:bg-gray-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-60 peer-focus-visible:outline peer-focus-visible:outline-3 peer-focus-visible:outline-offset-3 peer-focus-visible:outline-indigo-400 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          {pending === "restore" ? "Restoring backup…" : "Restore backup"}
        </label>
        <button
          type="button"
          onClick={() => window.print()}
          disabled={!hasData || busy}
          className="min-h-11 rounded-xl border border-gray-300 px-4 py-2 font-semibold transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          Print / Save PDF
        </button>
          </div>
        </details>
      </div>

      {(whoopStatus || googleHealthStatus) && <div id="sources" className="source-connections mb-6">
      {whoopStatus && (
        <details className="integration-disclosure" open={whoopStatus.connected}>
          <summary><span>WHOOP</span><span>{whoopStatus.connected ? `Connected${whoopStatus.last_sync ? ` · Last sync ${whoopStatus.last_sync.slice(0, 10)}` : ""}` : whoopStatus.configured ? "Ready to connect" : "Optional · setup needed"}</span></summary>
          <div className="integration-body">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div>
              <h2 id="whoop-heading" className="text-lg font-semibold">WHOOP sync</h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Import the last 90 days of sleep, recovery, resting heart rate, and cycle strain to this device.</p>
              {!whoopStatus.configured && <p className="mt-3 text-sm">To enable, register a WHOOP developer app, then set <code>WHOOP_CLIENT_ID</code> and <code>WHOOP_CLIENT_SECRET</code> before starting AtmaSutra.</p>}
              {whoopStatus.configured && whoopStatus.connected && <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-300">Connected{whoopStatus.last_sync ? ` · Last sync ${whoopStatus.last_sync.slice(0, 10)}` : " · Not synced yet"}. Authorization is held in memory until the local service stops.</p>}
              {whoopStatus.configured && !whoopStatus.connected && <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">Connect your WHOOP account. AtmaSutra requests only cycle, sleep, and recovery read access.</p>}
            </div>
            {whoopStatus.configured && (whoopStatus.connected ? (
              <div className="flex shrink-0 flex-wrap gap-2">
                <button type="button" onClick={() => void syncWhoop()} disabled={busy} className="primary-button min-h-11 rounded-lg px-4 py-2 font-semibold disabled:cursor-not-allowed disabled:opacity-60">{pending === "whoopSync" ? "Syncing WHOOP…" : "Sync WHOOP data"}</button>
                <button type="button" onClick={disconnectWhoop} disabled={busy} className="min-h-11 rounded-lg border border-gray-300 px-4 py-2 font-semibold hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:hover:bg-gray-800">{pending === "whoopDisconnect" ? "Disconnecting…" : "Disconnect"}</button>
              </div>
            ) : (
              <a href={`${API}/api/integrations/whoop/connect`} className="primary-button flex min-h-11 shrink-0 items-center justify-center rounded-lg px-4 py-2 font-semibold">Connect WHOOP</a>
            ))}
          </div>
          {!whoopStatus.configured && <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">Register this redirect URI in the WHOOP Developer Dashboard: <code>{whoopStatus.redirect_uri}</code></p>}
          </div>
        </details>
      )}

      {googleHealthStatus && (
        <details className="integration-disclosure" open={googleHealthStatus.connected}>
          <summary><span>Google Health</span><span>{googleHealthStatus.connected ? `Connected${googleHealthStatus.last_sync ? ` · Last sync ${googleHealthStatus.last_sync.slice(0, 10)}` : ""}` : googleHealthStatus.configured ? "Ready to connect" : "Optional · setup needed"}</span></summary>
          <div className="integration-body">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div>
              <h2 id="google-health-heading" className="text-lg font-semibold">Google Health sync</h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Connect Google Fit data through Google’s current Health API to import up to 90 days of sleep duration and resting heart rate.</p>
              {!googleHealthStatus.configured && <p className="mt-3 text-sm">To enable, create a Google Cloud OAuth web client for Google Health, then set <code>GOOGLE_HEALTH_CLIENT_ID</code> and <code>GOOGLE_HEALTH_CLIENT_SECRET</code> before starting AtmaSutra.</p>}
              {googleHealthStatus.configured && googleHealthStatus.connected && <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-300">Connected{googleHealthStatus.last_sync ? ` · Last sync ${googleHealthStatus.last_sync.slice(0, 10)}` : " · Not synced yet"}. Authorization is held in memory until the local service stops.</p>}
              {googleHealthStatus.configured && !googleHealthStatus.connected && <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">Before connecting, sign in to the Google Health mobile app with the same Google account and create or link a Google Health profile. AtmaSutra requests read-only sleep and health-metric access.</p>}
            </div>
            {googleHealthStatus.configured && (googleHealthStatus.connected ? (
              <div className="flex shrink-0 flex-wrap gap-2">
                <button type="button" onClick={() => void syncGoogleHealth()} disabled={busy} className="primary-button min-h-11 rounded-lg px-4 py-2 font-semibold disabled:cursor-not-allowed disabled:opacity-60">{pending === "googleHealthSync" ? "Syncing Google Health…" : "Sync Google Health"}</button>
                <button type="button" onClick={disconnectGoogleHealth} disabled={busy} className="min-h-11 rounded-lg border border-gray-300 px-4 py-2 font-semibold hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:hover:bg-gray-800">{pending === "googleHealthDisconnect" ? "Disconnecting…" : "Disconnect"}</button>
              </div>
            ) : (
              <a href={`${API}/api/integrations/google-health/connect`} className="primary-button flex min-h-11 shrink-0 items-center justify-center rounded-lg px-4 py-2 font-semibold">Connect Google Health</a>
            ))}
          </div>
          {!googleHealthStatus.configured && <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">Register this redirect URI with your Google OAuth client: <code>{googleHealthStatus.redirect_uri}</code></p>}
          </div>
        </details>
      )}
      </div>}

      {csvPreview && (
        <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900 sm:p-6" aria-labelledby="csv-preview-heading">
          <h2 id="csv-preview-heading" className="text-lg font-semibold">Review CSV import</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            Detected {csvPreview.summary.kind} data · {csvPreview.summary.rows_imported} rows · {csvPreview.summary.date_start} to {csvPreview.summary.date_end}
          </p>
          <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">
            {csvPreview.summary.replacements
              ? `${csvPreview.summary.replacements} existing record${csvPreview.summary.replacements === 1 ? "" : "s"} with matching dates will be replaced.`
              : "No existing records with matching dates were found."}
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead><tr className="border-b border-gray-200 dark:border-gray-700">{csvPreview.summary.columns_imported.map((column) => <th key={column} scope="col" className="px-3 py-2 font-semibold">{column.replaceAll("_", " ")}</th>)}</tr></thead>
              <tbody>
                {csvPreview.summary.sample_rows.map((row, index) => (
                  <tr key={index} className="border-b border-gray-100 dark:border-gray-800">{csvPreview.summary.columns_imported.map((column) => <td key={column} className="whitespace-nowrap px-3 py-2">{row[column] ?? "—"}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" onClick={importCSV} disabled={busy} className="primary-button min-h-11 rounded-lg px-4 py-2 font-semibold disabled:cursor-not-allowed disabled:opacity-60">{pending === "upload" ? "Importing…" : "Import these rows"}</button>
            <button type="button" onClick={() => setCsvPreview(null)} disabled={busy} className="min-h-11 rounded-lg border border-gray-300 px-4 py-2 font-semibold hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:hover:bg-gray-800">Cancel</button>
          </div>
        </section>
      )}

      <div aria-live="polite" className="mb-6 min-h-6">
        {error && (
          <div role="alert" className="flex flex-col items-start justify-between gap-3 rounded-xl bg-red-50 p-4 text-sm text-red-900 sm:flex-row sm:items-center dark:bg-red-950/50 dark:text-red-100">
            <span>{error}</span>
            <button type="button" onClick={() => void refresh()} className="min-h-10 rounded-lg bg-red-700 px-3 py-2 font-semibold text-white hover:bg-red-800">
              Try again
            </button>
          </div>
        )}
        {!error && message && <p className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100">{message}</p>}
      </div>

      {loading && (
        <section className="loading-panel" aria-busy="true" aria-live="polite">
          <div className="flex items-center gap-3">
            <span className="loading-signal" aria-hidden="true"><i /><i /><i /></span>
            <div>
              <h2 className="font-semibold">Loading your data</h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Reading your sleep, recovery, and habit history from this device.</p>
            </div>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-3" aria-hidden="true">
            <span className="loading-skeleton h-20 rounded-xl" />
            <span className="loading-skeleton h-20 rounded-xl" />
            <span className="loading-skeleton h-20 rounded-xl" />
          </div>
          <span className="loading-skeleton mt-3 block h-48 rounded-xl" aria-hidden="true" />
        </section>
      )}

      {!loading && !error && !hasData && (
        <section className="flex min-h-[42vh] flex-col items-center justify-center text-center">
          <h2 className="text-xl font-semibold">No records yet</h2>
          <p className="mt-2 max-w-xl text-gray-600 dark:text-gray-300">
            Load sample data to explore the dashboard, or import a CSV of your sleep, recovery, and habit history.
          </p>
        </section>
      )}

      {hasData && (
        <>
          <section id="overview" className="mb-10 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900 sm:p-6" aria-labelledby="coverage-heading">
            <h2 id="coverage-heading" className="text-xl font-semibold">Data coverage</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">See how much history supports the patterns. Gaps are left out of each comparison.</p>
            <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="border-t border-gray-200 pt-3 dark:border-gray-700">
                <dt className="text-sm text-gray-600 dark:text-gray-300">Nights with sleep or recovery scores</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">{dataCoverage.scoreDays}</dd>
              </div>
              <div className="border-t border-gray-200 pt-3 dark:border-gray-700">
                <dt className="text-sm text-gray-600 dark:text-gray-300">Days with a habit logged</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">{dataCoverage.habitDays}</dd>
              </div>
              <div className="border-t border-gray-200 pt-3 dark:border-gray-700">
                <dt className="text-sm text-gray-600 dark:text-gray-300">Habit days followed by next-day scores</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">{dataCoverage.matchedDays}</dd>
              </div>
              <div className="border-t border-gray-200 pt-3 dark:border-gray-700">
                <dt className="text-sm text-gray-600 dark:text-gray-300">Missing score days within score history</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">{dataCoverage.missingScoreDays}</dd>
              </div>
            </dl>
            <p className="mt-4 text-xs text-gray-600 dark:text-gray-300">Each pattern card shows its own matched sample size (n). More data can help make a personal pattern easier to assess, but does not prove cause.</p>
          </section>

          <section id="experiment" className="mb-10 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900 sm:p-6">
            <h2 className="text-xl font-semibold">Personal experiment</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Try one small change and compare your sleep and recovery with the previous week.</p>
            {experiment && !experiment.completed ? (
              <div className="mt-5">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                  <div>
                    <p className="font-semibold">{habitOptions.find((item) => item.value === experiment.habit)?.label}: {experiment.change}</p>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{experiment.start_date} to {experiment.end_date} · {experiment.checkins.filter((item) => item.followed).length} of {experiment.duration_days} days followed</p>
                  </div>
                  <span className="experiment-status w-fit rounded-full px-3 py-1 text-xs font-semibold">{experiment.completed ? "Experiment complete" : "In progress"}</span>
                </div>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800" role="progressbar" aria-label="Days followed" aria-valuemin={0} aria-valuemax={experiment.duration_days} aria-valuenow={experiment.checkins.filter((item) => item.followed).length}>
                  <div className="experiment-progress-fill h-full rounded-full" style={{ width: `${Math.min(100, experiment.checkins.filter((item) => item.followed).length / experiment.duration_days * 100)}%` }} />
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {(["sleep_score", "recovery_score"] as const).map((metric) => (
                    <div key={metric} className="rounded-xl bg-gray-50 p-3 dark:bg-gray-800">
                      <p className="text-sm font-medium">{metric === "sleep_score" ? "Sleep score" : "Recovery score"}</p>
                      <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Baseline: {experiment.baseline[metric] ?? "No score data"} ({experiment.baseline[`${metric}_days`]} nights) <span aria-hidden="true">→</span> Next-day during: {experiment.during[metric] ?? "Waiting for next-day data"} ({experiment.during[`${metric}_days`]} nights)</p>
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap gap-3">
                  <button type="button" onClick={() => void checkInExperiment(true)} disabled={busy || experiment.checked_in_today} className="primary-button min-h-11 rounded-lg px-4 py-2 font-semibold disabled:cursor-not-allowed disabled:opacity-60">
                    {pending === "checkin" ? "Saving…" : experiment.checked_in_today ? "Checked in today" : "I followed my plan"}
                  </button>
                  <button type="button" onClick={() => void checkInExperiment(false)} disabled={busy || experiment.checked_in_today} className="min-h-11 rounded-lg border border-gray-300 px-4 py-2 font-semibold hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:hover:bg-gray-800">
                    I didn’t follow it today
                  </button>
                </div>
                {renderExperimentDays(false)}
                <p className="mt-3 text-xs text-gray-600 dark:text-gray-300">Daily check-ins help you see how consistently you followed the plan; they don’t prove it caused a change.</p>
              </div>
            ) : (
              <>
              {experiment?.completed && <div className="mt-4 rounded-xl bg-gray-50 p-4 dark:bg-gray-800">
                <p className="text-sm">Experiment complete: {experiment.checkins.filter((item) => item.followed).length} of {experiment.duration_days} days followed your plan.</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {(["sleep_score", "recovery_score"] as const).map((metric) => {
                    const baseline = experiment.baseline[metric];
                    const during = experiment.during[metric];
                    const label = metric === "sleep_score" ? "Sleep score" : "Recovery score";
                    return <p key={metric} className="rounded-lg bg-white p-3 text-sm dark:bg-gray-900"><span className="font-medium">{label}: </span>{baseline === null || during === null
                      ? "Not enough score data to compare."
                      : `Baseline ${baseline.toFixed(1)} (n=${experiment.baseline[`${metric}_days`]}) → During ${during.toFixed(1)} (n=${experiment.during[`${metric}_days`]}) · ${during - baseline >= 0 ? "+" : ""}${(during - baseline).toFixed(1)} points`}</p>;
                  })}
                </div>
                {renderExperimentDays(true)}
                <p className="mt-3 text-xs text-gray-600 dark:text-gray-300">These before-and-during differences are personal observations, not proof that the habit change caused them.</p>
              </div>}
              <form onSubmit={startExperiment} className="mt-5 grid items-end gap-3 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(14rem,1.5fr)_8rem_auto]">
                <label className="grid gap-1.5 text-sm font-medium">
                  Focus habit
                  <select value={experimentForm.habit} onChange={(event) => setExperimentForm({ ...experimentForm, habit: event.target.value as HabitName })} className="min-h-11 rounded-lg border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-700">
                    {habitOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  What will you try?
                  <input required minLength={3} maxLength={160} value={experimentForm.change} onChange={(event) => setExperimentForm({ ...experimentForm, change: event.target.value })} placeholder="e.g. Finish dinner before 8 pm" className="min-h-11 rounded-lg border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-700" />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Duration
                  <select value={experimentForm.duration_days} onChange={(event) => setExperimentForm({ ...experimentForm, duration_days: Number(event.target.value) })} className="min-h-11 rounded-lg border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-700">
                    {[7, 14, 21].map((days) => <option key={days} value={days}>{days} days</option>)}
                  </select>
                </label>
                <button type="submit" disabled={busy} className="primary-button min-h-11 rounded-lg px-4 py-2 font-semibold disabled:cursor-not-allowed disabled:opacity-60">{pending === "experiment" ? "Starting…" : "Start experiment"}</button>
              </form>
              </>
            )}
          </section>

          <section id="notes" className="mb-10 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900 sm:p-6" aria-labelledby="timeline-heading">
            <h2 id="timeline-heading" className="text-xl font-semibold">Timeline notes</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Add context for unusual days that may help explain your data, such as travel, illness, or stress.</p>
            <form onSubmit={saveAnnotation} className="mt-5 grid items-end gap-3 sm:grid-cols-[9rem_10rem_minmax(12rem,1fr)_auto]">
              <label className="grid gap-1.5 text-sm font-medium">
                Date
                <input type="date" required value={annotationForm.date} onChange={(event) => setAnnotationForm({ ...annotationForm, date: event.target.value })} className="min-h-11 rounded-lg border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-700" />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Context
                <select value={annotationForm.category} onChange={(event) => setAnnotationForm({ ...annotationForm, category: event.target.value as Annotation["category"] })} className="min-h-11 rounded-lg border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-700">
                  <option value="travel">Travel</option><option value="illness">Illness</option><option value="stress">Stress</option><option value="other">Other</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Note
                <input required minLength={2} maxLength={240} value={annotationForm.note} onChange={(event) => setAnnotationForm({ ...annotationForm, note: event.target.value })} placeholder="e.g. Long flight and late arrival" className="min-h-11 rounded-lg border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-700" />
              </label>
              <button type="submit" disabled={busy} className="primary-button min-h-11 rounded-lg px-4 py-2 font-semibold disabled:cursor-not-allowed disabled:opacity-60">{pending === "annotation" ? "Saving…" : "Add note"}</button>
            </form>
            {annotations.length ? (
              <ol className="mt-5 divide-y divide-gray-200 dark:divide-gray-700">
                {annotations.map((annotation) => (
                  <li key={annotation.id} className="flex flex-col justify-between gap-2 py-3 sm:flex-row sm:items-start">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold"><time dateTime={annotation.date}>{annotation.date}</time> <span className="font-normal text-gray-600 dark:text-gray-300">· {annotation.category}</span></p>
                      <p className="mt-1 break-words text-sm">{annotation.note}</p>
                    </div>
                    <button type="button" onClick={() => void removeAnnotation(annotation.id)} disabled={busy} aria-label={`Remove note from ${annotation.date}`} className="min-h-10 self-start rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-60 dark:text-gray-300 dark:hover:bg-gray-800">{pending === "deleteAnnotation" ? "Removing…" : "Remove"}</button>
                  </li>
                ))}
              </ol>
            ) : <p className="mt-5 text-sm text-gray-600 dark:text-gray-300">No timeline notes yet. Add a note when something unusual may affect your sleep or recovery.</p>}
          </section>

          <section id="patterns" className="mb-10">
            <h2 className="mb-4 text-xl font-semibold">Reliable next-day patterns</h2>
            {topInsights.length ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {topInsights.map((insight) => (
                  <article key={`${insight.habit}-${insight.metric}`} className="pattern-card min-w-0 rounded-2xl border bg-white p-4 dark:bg-gray-900">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <p className="min-w-0 break-words text-sm font-semibold text-gray-700 dark:text-gray-200">
                        {insight.habit.replaceAll("_", " ")} → {insight.metric.replaceAll("_", " ")}
                      </p>
                      <span className={`correlation-badge shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${insight.correlation > 0 ? "correlation-positive" : "correlation-negative"}`}>
                        r={insight.correlation}
                      </span>
                    </div>
                    <p className="text-sm leading-6">{insight.nudge}</p>
                    <p className="mt-3 text-xs text-gray-600 dark:text-gray-300">n={insight.n} · adjusted p {formatP(insight.p_adjusted)}</p>
                  </article>
                ))}
              </div>
            ) : (
              <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-700 dark:bg-gray-900 dark:text-gray-200">
                No statistically reliable next-day pattern yet. Keep logging consistent data and check again later.
              </p>
            )}
          </section>

          {aiNudge && (
            <section className="ai-nudge mb-10 rounded-xl p-4">
              <h2 className="mb-2 font-semibold">Local AI experiment ideas</h2>
              <p className="whitespace-pre-line text-sm leading-6">{aiNudge}</p>
            </section>
          )}

          {chartData.length > 0 && (
            <section id="trends" className="mb-10 space-y-8">
              <div>
                <h2 className="mb-4 text-xl font-semibold">Sleep and recovery</h2>
                <div role="img" aria-label="Line chart of sleep score, recovery score, and resting heart rate by date" className="chart-area h-72 w-full min-w-0">
                  <ResponsiveContainer>
                    <LineChart data={chartData} margin={{ left: 0, right: 8 }}>
                      <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" opacity={0.75} />
                      <XAxis dataKey="dateLabel" tick={{ fontSize: 11, fill: "var(--muted)" }} axisLine={{ stroke: "var(--border)" }} tickLine={false} minTickGap={28} />
                      <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} axisLine={false} tickLine={false} width={36} />
                      <Tooltip contentStyle={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)" }} labelStyle={{ color: "var(--muted)" }} />
                      <Legend />
                      <Line type="monotone" dataKey="sleep_score" stroke="var(--chart-sleep)" strokeWidth={2} name="Sleep score" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
                      <Line type="monotone" dataKey="recovery_score" stroke="var(--chart-recovery)" strokeWidth={2} name="Recovery" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
                      <Line type="monotone" dataKey="resting_hr" stroke="var(--chart-heart)" strokeWidth={1.8} name="Resting HR" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div>
                <h2 className="mb-4 text-xl font-semibold">Daily habits</h2>
                <div role="img" aria-label="Bar chart of late dinners, alcohol drinks, and exercise minutes by date" className="chart-area h-64 w-full min-w-0">
                  <ResponsiveContainer>
                    <BarChart data={chartData} margin={{ left: 0, right: 8 }}>
                      <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" opacity={0.75} />
                      <XAxis dataKey="dateLabel" tick={{ fontSize: 11, fill: "var(--muted)" }} axisLine={{ stroke: "var(--border)" }} tickLine={false} minTickGap={28} />
                      <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} axisLine={false} tickLine={false} width={36} />
                      <Tooltip contentStyle={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)" }} labelStyle={{ color: "var(--muted)" }} />
                      <Legend />
                      <Bar dataKey="late_dinner" fill="var(--chart-dinner)" name="Late dinner" radius={[2, 2, 0, 0]} />
                      <Bar dataKey="alcohol_drinks" fill="var(--chart-heart)" name="Alcohol" radius={[2, 2, 0, 0]} />
                      <Bar dataKey="exercise_min" fill="var(--chart-recovery)" name="Exercise (min)" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </section>
          )}

          <section id="quick-log" className="mb-10">
            <h2 className="mb-4 text-xl font-semibold">Quick habit log</h2>
            <form onSubmit={logHabit} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[auto_minmax(12rem,1fr)_7rem_auto]">
              <label className="grid gap-1.5 text-sm font-medium">
                Date
                <input
                  type="date"
                  required
                  value={habitForm.date}
                  onChange={(event) => setHabitForm({ ...habitForm, date: event.target.value })}
                  className="min-h-11 rounded-lg border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-700"
                />
              </label>
              <label className="grid min-w-0 gap-1.5 text-sm font-medium">
                Habit
                <select
                  value={habitForm.habit}
                  onChange={(event) => {
                    const option = habitOptions.find((item) => item.value === event.target.value) ?? habitOptions[0];
                    setHabitForm({ ...habitForm, habit: option.value, value: option.defaultValue });
                  }}
                  className="min-h-11 min-w-0 rounded-lg border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-700"
                >
                  {habitOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Value
                <input
                  type="number"
                  required
                  min={0}
                  max={selectedHabit.max}
                  step={selectedHabit.step}
                  value={habitForm.value}
                  onChange={(event) => setHabitForm({ ...habitForm, value: event.target.value })}
                  className="min-h-11 rounded-lg border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-700"
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                className="primary-button min-h-11 rounded-lg px-4 py-2 font-semibold disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending === "habit" ? "Saving…" : "Save habit"}
              </button>
            </form>
          </section>
        </>
      )}

      <section className="mb-8 border-t border-gray-200 pt-5 dark:border-gray-800" aria-labelledby="local-data-heading">
        <h2 id="local-data-heading" className="text-lg font-semibold">Local data controls</h2>
        <p className="mt-1 max-w-2xl text-sm text-gray-600 dark:text-gray-300">Delete the data stored by AtmaSutra on this device. Any backup you downloaded remains in your files.</p>
        <button type="button" onClick={deleteLocalData} disabled={busy || !hasData} className="mt-3 min-h-11 rounded-lg border border-red-300 px-4 py-2 font-semibold text-red-800 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:text-red-200 dark:hover:bg-red-950/40">
          {pending === "deleteData" ? "Deleting local data…" : "Delete all local data"}
        </button>
      </section>

      <section className="print-report hidden" aria-label="AtmaSutra personal health summary">
        <header className="report-header">
          <h1>AtmaSutra</h1>
          <p>Personal health summary</p>
          <p>Data period: {reportPeriod} · Prepared: {today || "—"}</p>
        </header>

        <section className="report-section">
          <h2>Data coverage</h2>
          <p>{dataCoverage.scoreDays} nights with sleep or recovery scores · {dataCoverage.habitDays} habit days · {dataCoverage.matchedDays} next-day matches · {dataCoverage.missingScoreDays} missing score days within the score history</p>
        </section>

        <section className="report-section">
          <h2>Reliable next-day patterns</h2>
          {topInsights.length ? topInsights.map((insight) => (
            <article className="report-item" key={`${insight.habit}-${insight.metric}`}>
              <h3>{insight.habit.replaceAll("_", " ")} → {insight.metric.replaceAll("_", " ")}</h3>
              <p>{insight.nudge}</p>
              <small>Matched sample: n={insight.n} · Adjusted p-value: {formatP(insight.p_adjusted)}</small>
            </article>
          )) : <p>No reliable next-day patterns are available in this data period.</p>}
        </section>

        <section className="report-section">
          <h2>Personal experiment</h2>
          {experiment ? (
            <>
              <p>{habitOptions.find((item) => item.value === experiment.habit)?.label}: {experiment.change} · {experiment.start_date} to {experiment.end_date} · {experiment.completed ? "Complete" : "In progress"}</p>
              <p>{experiment.checkins.filter((item) => item.followed).length} of {experiment.duration_days} days followed the plan.</p>
              {(["sleep_score", "recovery_score"] as const).map((metric) => (
                <p key={metric}>{metric === "sleep_score" ? "Sleep score" : "Recovery score"}: baseline {experiment.baseline[metric] ?? "no data"} ({experiment.baseline[`${metric}_days`]} nights); next-day during {experiment.during[metric] ?? "no data yet"} ({experiment.during[`${metric}_days`]} nights).</p>
              ))}
            </>
          ) : <p>No personal experiment has been recorded.</p>}
        </section>

        <section className="report-section">
          <h2>Timeline notes</h2>
          {annotations.length ? annotations.map((annotation) => (
            <p className="report-item" key={annotation.id}><strong>{annotation.date} · {annotation.category}</strong><br />{annotation.note}</p>
          )) : <p>No timeline notes have been recorded.</p>}
        </section>

        <footer className="report-footer">For personal exploration only. Associations do not prove cause; this summary is not a diagnosis or medical advice.</footer>
      </section>

      <footer className="mt-auto border-t border-gray-200 py-6 text-center text-xs text-gray-600 dark:border-gray-800 dark:text-gray-300">
        AtmaSutra · Local health and habit insight
      </footer>
    </main>
  );
}
