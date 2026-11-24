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
type PendingAction = "demo" | "upload" | "habit" | null;
type HabitName = "late_dinner" | "alcohol_drinks" | "exercise_min" | "screen_before_bed_hrs";
type ChartDatum = Record<string, string | number | null> & { dateLabel: string };

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
  const [insights, setInsights] = useState<Insight[]>([]);
  const [aiNudge, setAiNudge] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [habitForm, setHabitForm] = useState({ date: "", habit: "late_dinner" as HabitName, value: "1" });

  const fetchAll = useCallback(async (signal?: AbortSignal) => {
    const [metricRows, habitRows, insightData] = await Promise.all([
      fetchJson<MetricRecord[]>("/api/metrics", { signal }),
      fetchJson<HabitRecord[]>("/api/habits", { signal }),
      fetchJson<InsightResponse>("/api/insights", { signal }),
    ]);
    setMetrics(metricRows);
    setHabits(habitRows);
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
    const form = new FormData();
    form.append("file", file);
    const result = await fetchJson<{ rows_imported: number }>("/api/upload-csv", { method: "POST", body: form });
    await fetchAll();
    setMessage(`${result.rows_imported} CSV row${result.rows_imported === 1 ? "" : "s"} imported.`);
  });

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
