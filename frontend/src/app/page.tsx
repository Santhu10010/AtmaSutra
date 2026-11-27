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
type CsvPreview = {
  kind: "metrics" | "habits";
  rows_imported: number;
  columns_imported: string[];
  date_start: string;
  date_end: string;
  replacements: number;
  sample_rows: Array<Record<string, string | number | null>>;
};
type PendingAction = "demo" | "upload" | "habit" | "experiment" | "checkin" | "annotation" | "deleteAnnotation" | null;
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
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorMessage(payload, response.status));
  return payload as T;
}

export default function Home() {
  const [metrics, setMetrics] = useState<MetricRecord[]>([]);
  const [habits, setHabits] = useState<HabitRecord[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [experiment, setExperiment] = useState<Experiment | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [aiNudge, setAiNudge] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [csvPreview, setCsvPreview] = useState<{ file: File; summary: CsvPreview } | null>(null);
  const [habitForm, setHabitForm] = useState({ date: "", habit: "late_dinner" as HabitName, value: "1" });
  const [experimentForm, setExperimentForm] = useState({ habit: "late_dinner" as HabitName, change: "", duration_days: 7 });
  const [annotationForm, setAnnotationForm] = useState({ date: "", category: "travel" as Annotation["category"], note: "" });

  const fetchAll = useCallback(async (signal?: AbortSignal) => {
    const [metricRows, habitRows, insightData, experimentData, annotationRows] = await Promise.all([
      fetchJson<MetricRecord[]>("/api/metrics", { signal }),
      fetchJson<HabitRecord[]>("/api/habits", { signal }),
      fetchJson<InsightResponse>("/api/insights", { signal }),
      fetchJson<{ experiment: Experiment | null }>("/api/experiments", { signal }),
      fetchJson<Annotation[]>("/api/annotations", { signal }),
    ]);
    setMetrics(metricRows);
    setHabits(habitRows);
    setExperiment(experimentData.experiment);
    setAnnotations(annotationRows);
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
      setHabitForm((current) => current.date ? current : { ...current, date: localDate() });
      setAnnotationForm((current) => current.date ? current : { ...current, date: localDate() });
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

  const topInsights = useMemo(
    () => insights.filter((item) => item.p_adjusted <= 0.05 && Math.abs(item.correlation) > 0.3).slice(0, 6),
    [insights],
  );
  const hasData = metrics.length > 0 || habits.length > 0;
  const busy = loading || pending !== null;
  const selectedHabit = habitOptions.find((option) => option.value === habitForm.habit) ?? habitOptions[0];

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-8 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight">AtmaSutra</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Self-Insight Thread — Know Thyself</p>
        </div>
        <p className="max-w-full rounded-full bg-emerald-100 px-3 py-1.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          Data stays on this device
        </p>
      </header>

      <div className="mb-6 flex w-full flex-col gap-3 sm:flex-row sm:flex-wrap">
        <button
          type="button"
          onClick={() => void loadDemo()}
          disabled={busy}
          className="min-h-11 rounded-xl bg-indigo-600 px-4 py-2 font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending === "demo" ? "Loading demo…" : "Load demo data"}
        </button>
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
          className="flex min-h-11 cursor-pointer items-center justify-center rounded-xl border border-gray-300 px-4 py-2 font-semibold transition-colors hover:bg-gray-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-60 peer-focus-visible:outline peer-focus-visible:outline-3 peer-focus-visible:outline-offset-3 peer-focus-visible:outline-indigo-400 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          {pending === "upload" ? "Importing CSV…" : "Upload CSV"}
        </label>
      </div>

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
            <button type="button" onClick={importCSV} disabled={busy} className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60">{pending === "upload" ? "Importing…" : "Import these rows"}</button>
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

      {loading && <p className="py-16 text-center text-gray-600 dark:text-gray-300">Loading local data…</p>}

      {!loading && !error && !hasData && (
        <section className="flex min-h-[42vh] flex-col items-center justify-center text-center">
          <h2 className="text-xl font-semibold">Start with a sample or your own CSV</h2>
          <p className="mt-2 max-w-xl text-gray-600 dark:text-gray-300">
            Load the demo on an empty database, or import metrics from AtmaSutra, Oura, Whoop, or Apple Health-style CSV columns.
          </p>
        </section>
      )}

      {hasData && (
        <>
          <section className="mb-10 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900 sm:p-6" aria-labelledby="coverage-heading">
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

          <section className="mb-10 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900 sm:p-6">
            <h2 className="text-xl font-semibold">Personal experiment</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Try one small change and compare your sleep and recovery with the previous week.</p>
            {experiment && !experiment.completed ? (
              <div className="mt-5">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                  <div>
                    <p className="font-semibold">{habitOptions.find((item) => item.value === experiment.habit)?.label}: {experiment.change}</p>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{experiment.start_date} to {experiment.end_date} · {experiment.checkins.filter((item) => item.followed).length} of {experiment.duration_days} days followed</p>
                  </div>
                  <span className="w-fit rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200">{experiment.completed ? "Experiment complete" : "In progress"}</span>
                </div>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800" role="progressbar" aria-label="Days followed" aria-valuemin={0} aria-valuemax={experiment.duration_days} aria-valuenow={experiment.checkins.filter((item) => item.followed).length}>
                  <div className="h-full rounded-full bg-indigo-600" style={{ width: `${Math.min(100, experiment.checkins.filter((item) => item.followed).length / experiment.duration_days * 100)}%` }} />
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
                  <button type="button" onClick={() => void checkInExperiment(true)} disabled={busy || experiment.checked_in_today} className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60">
                    {pending === "checkin" ? "Saving…" : experiment.checked_in_today ? "Checked in today" : "I followed my plan"}
                  </button>
                  <button type="button" onClick={() => void checkInExperiment(false)} disabled={busy || experiment.checked_in_today} className="min-h-11 rounded-lg border border-gray-300 px-4 py-2 font-semibold hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:hover:bg-gray-800">
                    I didn’t follow it today
                  </button>
                </div>
                <p className="mt-3 text-xs text-gray-600 dark:text-gray-300">Daily check-ins help you see how consistently you followed the plan; they don’t prove it caused a change.</p>
              </div>
            ) : (
              <>
              {experiment?.completed && <p className="mt-4 rounded-xl bg-gray-50 p-4 text-sm dark:bg-gray-800">Your last experiment is complete: {experiment.checkins.filter((item) => item.followed).length} of {experiment.duration_days} days followed your plan. Compare the baseline and experiment averages above before starting another.</p>}
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
                <button type="submit" disabled={busy} className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60">{pending === "experiment" ? "Starting…" : "Start experiment"}</button>
              </form>
              </>
            )}
          </section>

          <section className="mb-10 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900 sm:p-6" aria-labelledby="timeline-heading">
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
              <button type="submit" disabled={busy} className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60">{pending === "annotation" ? "Saving…" : "Add note"}</button>
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

          <section className="mb-10">
            <h2 className="mb-4 text-xl font-semibold">Reliable next-day patterns</h2>
            {topInsights.length ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {topInsights.map((insight) => (
                  <article key={`${insight.habit}-${insight.metric}`} className="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <p className="min-w-0 break-words text-sm font-semibold text-gray-700 dark:text-gray-200">
                        {insight.habit.replaceAll("_", " ")} → {insight.metric.replaceAll("_", " ")}
                      </p>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${insight.correlation > 0 ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200"}`}>
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
            <section className="mb-10 rounded-xl bg-violet-50 p-4 text-violet-950 dark:bg-violet-950/40 dark:text-violet-100">
              <h2 className="mb-2 font-semibold">Local AI experiment ideas</h2>
              <p className="whitespace-pre-line text-sm leading-6">{aiNudge}</p>
            </section>
          )}

          {chartData.length > 0 && (
            <section className="mb-10 space-y-8">
              <div>
                <h2 className="mb-4 text-xl font-semibold">Sleep and recovery</h2>
                <div role="img" aria-label="Line chart of sleep score, recovery score, and resting heart rate by date" className="h-72 w-full min-w-0">
                  <ResponsiveContainer>
                    <LineChart data={chartData} margin={{ left: 0, right: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                      <XAxis dataKey="dateLabel" tick={{ fontSize: 11 }} minTickGap={28} />
                      <YAxis tick={{ fontSize: 11 }} width={36} />
                      <Tooltip />
                      <Legend />
                      <Line type="monotone" dataKey="sleep_score" stroke="#6366f1" strokeWidth={2} name="Sleep score" dot={false} />
                      <Line type="monotone" dataKey="recovery_score" stroke="#16a34a" strokeWidth={2} name="Recovery" dot={false} />
                      <Line type="monotone" dataKey="resting_hr" stroke="#dc2626" strokeWidth={2} name="Resting HR" dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div>
                <h2 className="mb-4 text-xl font-semibold">Daily habits</h2>
                <div role="img" aria-label="Bar chart of late dinners, alcohol drinks, and exercise minutes by date" className="h-64 w-full min-w-0">
                  <ResponsiveContainer>
                    <BarChart data={chartData} margin={{ left: 0, right: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                      <XAxis dataKey="dateLabel" tick={{ fontSize: 11 }} minTickGap={28} />
                      <YAxis tick={{ fontSize: 11 }} width={36} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="late_dinner" fill="#d97706" name="Late dinner" />
                      <Bar dataKey="alcohol_drinks" fill="#dc2626" name="Alcohol" />
                      <Bar dataKey="exercise_min" fill="#16a34a" name="Exercise (min)" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </section>
          )}

          <section className="mb-10">
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
                className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending === "habit" ? "Saving…" : "Save habit"}
              </button>
            </form>
          </section>
        </>
      )}

      <footer className="mt-auto border-t border-gray-200 py-6 text-center text-xs text-gray-600 dark:border-gray-800 dark:text-gray-300">
        AtmaSutra · Local health and habit insight
      </footer>
    </main>
  );
}
