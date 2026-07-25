import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { fetchRegionOverview, fetchRegionCountryCities } from "../api/client";
import type { RegionOverview, TtlaMode } from "../types";
import {
  REGION_METRICS,
  buildMetricModel,
  formatValue,
  formatRateCount,
  type Granularity,
} from "../lib/regionBuckets";
import { RegionMetricTable, type CityState } from "../components/RegionMetricTable";
import { StaleDataBanner, PollRetryHint, aggregateFreshness, pollDelayMs, type FreshnessSummary } from "../components/StaleDataBanner";
import { useConnection } from "../hooks/useConnection";

const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

// Depth presets per granularity → lookback_days for the fetch.
// The backend deep cache is a rolling MONTH-ANCHORED window ("current month +
// 6 complete months" ≈ 6 months / ~199–214 days) and clamps any larger request,
// so the deepest preset is "6mo" (the old 365d / "12mo" option was dropped — it
// can no longer be served).
const DEPTHS: Record<Granularity, { d: number; l: string }[]> = {
  day: [
    { d: 14, l: "14d" },
    { d: 28, l: "28d" },
    { d: 56, l: "56d" },
  ],
  week: [
    { d: 56, l: "8w" },
    { d: 84, l: "12w" },
    { d: 182, l: "26w" },
  ],
  month: [
    { d: 90, l: "3mo" },
    { d: 120, l: "4mo" },
    { d: 180, l: "6mo" },
  ],
};

const DEFAULT_DEPTH: Record<Granularity, number> = { day: 28, week: 84, month: 180 };

export function RegionDashboard() {
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [lookbackDays, setLookbackDays] = useState(DEFAULT_DEPTH.day);
  // Accept latency calculation-logic mode for the Region tab's Accept latency panel (default | 1st
  // courier | fixed) — the SAME three modes the Accept latency tab + Country tab expose.
  // In-memory (like granularity): threaded to /overview + /country/{code}/cities
  // as the `ttla_mode` query param. The control itself lives INSIDE the Accept latency
  // metric panel (see RegionMetricTable), not this top filter bar.
  const [ttlaMode, setTtlaMode] = useState<TtlaMode>("default");
  const [data, setData] = useState<RegionOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Auto-refresh-on-tab-open freshness (see StaleDataBanner). The region overview
  // serves stale deep-cache rows immediately and warms in the background; we poll
  // until fresh.
  const [freshness, setFreshness] = useState<FreshnessSummary | null>(null);
  // Poll backoff + silent-failure hint (see CountryDashboard / StaleDataBanner).
  const [pollAttempt, setPollAttempt] = useState(0);
  const [pollError, setPollError] = useState(false);

  // Shared synthetic data source session + global header status (see useConnection).
  const { live, connect, connecting, setStatus } = useConnection();

  // City drill-down: lazily fetched once per country and SHARED across all
  // metric tables. Keyed by country code; invalidated whenever the window
  // changes so city data always matches the currently displayed window.
  const [citiesData, setCitiesData] = useState<Map<string, CityState>>(new Map());
  const cityReqRef = useRef<Set<string>>(new Set());

  const loadData = useCallback(async (lb: number, opts?: { silent?: boolean; force?: boolean }) => {
    const silent = opts?.silent ?? false;
    if (!silent) {
      setLoading(true);
      setError(null);
      setPollAttempt(0);
      setPollError(false);
    }
    try {
      // `force` (explicit Retry) bypasses the backend warm cooldown.
      const result = await fetchRegionOverview(lb, opts?.force, ttlaMode);
      setData(result);
      setFreshness(aggregateFreshness([result._freshness]));
      setPollError(false);
    } catch (e: unknown) {
      if (!silent) setError(e instanceof Error ? e.message : "Failed to load region data");
      else setPollError(true); // keep last-good data; surface a retry hint
    } finally {
      if (!silent) setLoading(false);
      else setPollAttempt((a) => a + 1); // grows backoff + re-arms the poll effect
    }
  }, [ttlaMode]);

  useEffect(() => {
    loadData(lookbackDays);
  }, [lookbackDays, loadData]);

  // Auto-refresh poll: silently re-fetch the overview while a background warm is
  // in flight (or the deep cache is stale) until it reports fresh.
  useEffect(() => {
    if (!freshness) return;
    const delay = pollDelayMs(freshness, pollAttempt);
    if (delay === null) {
      if (pollAttempt !== 0) setPollAttempt(0);
      return;
    }
    const t = setTimeout(() => { loadData(lookbackDays, { silent: true }); }, delay);
    return () => clearTimeout(t);
  }, [freshness, pollAttempt, loadData, lookbackDays]);

  // Publish this tab's freshness to the global header status while mounted.
  useEffect(() => {
    setStatus(freshness);
    return () => setStatus(null);
  }, [freshness, setStatus]);

  // Sign in to synthetic data source (pops sign-in), then immediately re-load so the background
  // warm of the on-screen countries starts without waiting out the backoff.
  const handleSignIn = useCallback(async () => {
    const ok = await connect();
    if (ok) { setPollAttempt(0); loadData(lookbackDays, { silent: true, force: true }); }
  }, [connect, loadData, lookbackDays]);

  // Explicit Retry from the failed/stalled banner — force a re-warm now.
  const handleRetry = useCallback(() => {
    setPollAttempt(0);
    setPollError(false);
    loadData(lookbackDays, { silent: true, force: true });
  }, [loadData, lookbackDays]);

  // If a session comes online elsewhere (header, another tab) while stale, warm now.
  useEffect(() => {
    if (live && freshness && freshness.stale && !freshness.canAutoRefresh) {
      setPollAttempt(0);
      loadData(lookbackDays, { silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  // Invalidate the shared city map when the window OR the Accept latency mode changes
  // (granularity changes also reset lookbackDays via handleGranularity, so this
  // covers both). The by-city ttla file is mode-specific, so an expanded Accept latency row
  // must re-fetch when the mode flips; the other by-city files are mode-
  // independent (they re-fetch too and return identical cached data). Rows that
  // stay expanded re-fetch via the table's effect using the new window/mode.
  useEffect(() => {
    setCitiesData(new Map());
    cityReqRef.current = new Set();
  }, [lookbackDays, ttlaMode]);

  const getCities = useCallback(
    (code: string) => {
      if (cityReqRef.current.has(code)) return; // already loading/loaded
      cityReqRef.current.add(code);
      setCitiesData((prev) => new Map(prev).set(code, "loading"));
      fetchRegionCountryCities(code, lookbackDays, false, ttlaMode)
        .then((result) => setCitiesData((prev) => new Map(prev).set(code, result)))
        .catch(() => {
          cityReqRef.current.delete(code); // allow a retry
          setCitiesData((prev) => new Map(prev).set(code, "error"));
        });
    },
    [lookbackDays, ttlaMode],
  );

  const handleGranularity = (g: Granularity) => {
    setGranularity(g);
    setLookbackDays(DEFAULT_DEPTH[g]);
  };

  const countries = useMemo(() => data?.countries ?? [], [data]);

  const models = useMemo(
    () => REGION_METRICS.map((m) => buildMetricModel(m, countries, granularity)),
    [countries, granularity],
  );

  const hasData = countries.length > 0;

  return (
    <div className="space-y-6">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-[var(--color-text-muted)]">Bucket</label>
          <div className="flex rounded-md border border-[var(--color-border)] overflow-hidden">
            {GRANULARITIES.map((g) => (
              <button
                key={g.value}
                onClick={() => handleGranularity(g.value)}
                className={`h-8 px-3 text-xs font-medium transition-colors ${
                  granularity === g.value
                    ? "bg-[var(--color-primary)] text-white"
                    : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-[var(--color-text-muted)]">Depth</label>
          <div className="flex rounded-md border border-[var(--color-border)] overflow-hidden">
            {DEPTHS[granularity].map((opt) => (
              <button
                key={opt.d}
                onClick={() => setLookbackDays(opt.d)}
                className={`h-8 px-2.5 text-xs font-medium transition-colors ${
                  lookbackDays === opt.d
                    ? "bg-[var(--color-primary)] text-white"
                    : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {opt.l}
              </button>
            ))}
          </div>
        </div>

        <div className="text-[11px] text-[var(--color-text-muted)]">
          {hasData
            ? `${countries.length} countries · last ${lookbackDays}d · ${granularity} buckets`
            : "—"}
        </div>

        <button
          onClick={() => loadData(lookbackDays)}
          disabled={loading}
          className="ml-auto flex h-8 items-center gap-1.5 rounded-md bg-indigo-600 px-4 text-xs font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800/40 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {freshness && (
        <StaleDataBanner
          summary={freshness}
          onSignIn={handleSignIn}
          signingIn={connecting}
          onRetry={handleRetry}
        />
      )}
      {pollError && <PollRetryHint onRetry={handleRetry} />}

      {loading && !hasData && (
        <div className="flex h-64 items-center justify-center">
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <Loader2 size={16} className="animate-spin" />
            Loading region comparison for all countries…
          </div>
        </div>
      )}

      {hasData && (
        <>
          {/* KPI strip — region-wide value per metric over the window */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
            {models.map((m) => (
              <div
                key={m.metric.id}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-sm"
                    style={{ backgroundColor: m.metric.color }}
                  />
                  <div className="text-[10px] text-[var(--color-text-muted)]">{m.metric.label}</div>
                </div>
                <div className="mt-1 text-lg font-bold text-[var(--color-text)]">
                  {formatValue(m.metric, m.regional.windowValue)}
                </div>
                {m.metric.kind !== "count" && m.regional.windowValue !== null && (
                  <div className="text-[9px] text-[var(--color-text-muted)]">
                    {formatRateCount(m.metric, m.regional.windowNum, m.regional.windowDen)}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Metric comparison tables (one per REGION_METRICS entry) */}
          <div className="space-y-5">
            {models.map((m) => (
              <RegionMetricTable
                key={m.metric.id}
                model={m}
                granularity={granularity}
                getCities={getCities}
                citiesData={citiesData}
                // Only the Accept latency panel renders the Accept latency-logic control (the table
                // gates on metric.id === "ttla"); pass the mode + setter so the
                // control can switch modes, which re-fetches overview + cities.
                ttlaMode={ttlaMode}
                onTtlaModeChange={setTtlaMode}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
