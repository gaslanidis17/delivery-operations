import { useState, useCallback, useRef } from "react";

export interface LoadingStep {
  key: string;
  label: string;
  status: "pending" | "loading" | "done" | "error";
  durationMs?: number;
}

interface ProgressState {
  steps: LoadingStep[];
  active: boolean;
  startedAt: number | null;
  elapsedMs: number;
}

const HISTORY_KEY = "loading_avg_times";

function loadHistory(): Record<string, number[]> {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveHistory(history: Record<string, number[]>) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function getEstimateMs(key: string): number {
  const history = loadHistory();
  const times = history[key];
  if (!times?.length) return 8000;
  const recent = times.slice(-5);
  return Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);
}

function recordDuration(key: string, ms: number) {
  const history = loadHistory();
  if (!history[key]) history[key] = [];
  history[key].push(ms);
  if (history[key].length > 10) history[key] = history[key].slice(-10);
  saveHistory(history);
}

export function useLoadingProgress() {
  const [state, setState] = useState<ProgressState>({
    steps: [],
    active: false,
    startedAt: null,
    elapsedMs: 0,
  });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stepTimers = useRef<Record<string, number>>({});

  const start = useCallback((stepDefs: { key: string; label: string }[]) => {
    const steps: LoadingStep[] = stepDefs.map((d) => ({
      ...d,
      status: "pending",
    }));
    const now = Date.now();
    stepTimers.current = {};
    setState({ steps, active: true, startedAt: now, elapsedMs: 0 });

    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setState((s) => ({ ...s, elapsedMs: Date.now() - now }));
    }, 200);
  }, []);

  const markLoading = useCallback((key: string) => {
    stepTimers.current[key] = Date.now();
    setState((s) => ({
      ...s,
      steps: s.steps.map((st) => (st.key === key ? { ...st, status: "loading" } : st)),
    }));
  }, []);

  const markDone = useCallback((key: string) => {
    const startTime = stepTimers.current[key];
    const duration = startTime ? Date.now() - startTime : undefined;
    if (duration) recordDuration(key, duration);

    setState((s) => {
      const newSteps = s.steps.map((st) =>
        st.key === key ? { ...st, status: "done" as const, durationMs: duration } : st
      );
      const allDone = newSteps.every((st) => st.status === "done" || st.status === "error");
      if (allDone && timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return { ...s, steps: newSteps, active: !allDone };
    });
  }, []);

  const markError = useCallback((key: string) => {
    setState((s) => {
      const newSteps = s.steps.map((st) =>
        st.key === key ? { ...st, status: "error" as const } : st
      );
      const allDone = newSteps.every((st) => st.status === "done" || st.status === "error");
      if (allDone && timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return { ...s, steps: newSteps, active: !allDone };
    });
  }, []);

  const completedCount = state.steps.filter((s) => s.status === "done" || s.status === "error").length;
  const totalCount = state.steps.length;
  const pct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  const estimatedTotalMs = state.steps.reduce((sum, st) => sum + getEstimateMs(st.key), 0);
  const completedMs = state.steps
    .filter((s) => s.status === "done" || s.status === "error")
    .reduce((sum, st) => sum + (st.durationMs ?? getEstimateMs(st.key)), 0);
  const remainingMs = Math.max(0, estimatedTotalMs - completedMs);

  return {
    ...state,
    pct,
    completedCount,
    totalCount,
    estimatedRemainingMs: remainingMs,
    start,
    markLoading,
    markDone,
    markError,
  };
}
