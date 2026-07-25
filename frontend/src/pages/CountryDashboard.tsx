import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import {
  fetchCountries,
  fetchCityAnalytics,
  fetchCountryMaster,
  fetchCountryLateReasons,
  fetchCountryCityList,
} from "../api/client";
import { CityAnalyticsCard } from "../components/CityAnalyticsCard";
import { CityMultiSelect } from "../components/CityMultiSelect";
import { CountryMasterBoard } from "../components/CountryMasterBoard";
import { AISummaryPanel } from "../components/AISummaryPanel";
import { CountryAIAnalysisPanel } from "../components/CountryAIAnalysisPanel";
import { StaleDataBanner, PollRetryHint, aggregateFreshness, pollDelayMs, type FreshnessSummary } from "../components/StaleDataBanner";
import { useConnection } from "../hooks/useConnection";
import type { CountryInfo, CountryCityListItem, CityAnalyticsData, CountryMasterData, PeriodMode, CountryLateReasons, HeavyLargeReasons, TtlaMode } from "../types";

// City picker: window used to enumerate the complete city list + their order
// volumes (wide enough to surface every reasonably-active city). A freshly
// selected country starts with NO cities marked — the user actively picks which
// cities to inspect (there is intentionally no auto-default).
const CITY_LIST_LOOKBACK = 84;

// SESSION-scoped selection cache. We persist the single current
// { selectedCountry, markedCities } pair in sessionStorage so leaving and
// returning to the Country tab (which unmounts/remounts the page) — and
// in-session reloads — restore the exact view the user left, while a brand-new
// browser session starts clean (sessionStorage is cleared when the tab closes).
// This intentionally REPLACES the old per-country localStorage map, which
// persisted across sessions and seeded a top-N default.
const SESSION_SELECTION_KEY = "countrySelection:v1";

interface CountrySelectionSession {
  selectedCountry: string;
  markedCities: string[];
}

function readSessionSelection(): CountrySelectionSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_SELECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.selectedCountry === "string" &&
      Array.isArray(parsed.markedCities)
    ) {
      return {
        selectedCountry: parsed.selectedCountry,
        markedCities: parsed.markedCities.filter(
          (c: unknown): c is string => typeof c === "string",
        ),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function writeSessionSelection(sel: CountrySelectionSession) {
  try {
    sessionStorage.setItem(SESSION_SELECTION_KEY, JSON.stringify(sel));
  } catch {
    /* storage unavailable / quota — selection just won't persist this session */
  }
}

// Upper bound for the late-reasons depth. The backend deep cache only retains
// the rolling MONTH-ANCHORED canonical window ("current month + 6 complete
// months" ≈ 6–7 months, resolved server-side by canonical_max_lookback_days())
// and clamps anything larger, so a wide custom range must not request beyond it.
const MAX_LOOKBACK_DAYS = 213;

const LOOKBACK_OPTIONS = [
  { value: 7, label: "7d" },
  { value: 14, label: "14d" },
  { value: 28, label: "28d" },
];

const PERIOD_MODES: { value: PeriodMode; label: string }[] = [
  { value: "lookback", label: "Last N days" },
  { value: "completed_days", label: "Completed days" },
  { value: "completed_weeks", label: "Completed weeks" },
  { value: "custom", label: "Custom range" },
];

// Accept latency calculation-logic modes for the Country tab's Accept latency panel — the SAME three
// modes the dedicated Accept latency tab exposes (default | 1st courier | fixed). The order
// SET is unchanged (still the pure on-demand synthetic_jobs population); only HOW
// each order's Accept latency is computed differs. For deliveries_count=1 all three
// coincide. Applied to BOTH the country-master `ttla_total` and each marked city's
// per-city `ttla` (threaded as the `ttla_mode` query param).
const ACCEPT_LATENCY_MODE_OPTIONS: { value: TtlaMode; label: string; title: string }[] = [
  {
    value: "default",
    label: "Default",
    title:
      "Combined Accept latency: last pickup-accept minus the order's first task-shown (includes idle gaps on reassigns / splits). Current behavior.",
  },
  {
    value: "first_courier",
    label: "1st courier",
    title:
      "Accept latency of the 1st (original) task group only — the courier shown the task first. Isolates that courier's accept speed (no upstream idle gap).",
  },
  {
    value: "fixed",
    label: "Fixed",
    title:
      "Average of all couriers' per-task Accept latency on the order (each courier's own accept time, idle gaps excluded).",
  },
];

function getCompletedDaysRange(days: number): { from: string; to: string } {
  const to = new Date();
  to.setDate(to.getDate() - 1);
  const from = new Date(to);
  from.setDate(from.getDate() - days + 1);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function getCompletedWeeksRange(weeks: number): { from: string; to: string } {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const lastSunday = new Date(now);
  lastSunday.setDate(now.getDate() - (dayOfWeek === 0 ? 7 : dayOfWeek));
  const from = new Date(lastSunday);
  from.setDate(lastSunday.getDate() - (weeks - 1) * 7 - 6);
  return { from: from.toISOString().slice(0, 10), to: lastSunday.toISOString().slice(0, 10) };
}

function computeDateRange(
  periodMode: PeriodMode,
  lookbackDays: number,
  customFrom?: string,
  customTo?: string,
): { from: string; to: string } {
  if (periodMode === "custom" && customFrom && customTo) {
    return { from: customFrom, to: customTo };
  }
  if (periodMode === "completed_days") {
    return getCompletedDaysRange(lookbackDays);
  }
  if (periodMode === "completed_weeks") {
    return getCompletedWeeksRange(Math.round(lookbackDays / 7) || 1);
  }
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - lookbackDays);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

interface CountryDashboardProps {
  onCountryChange?: (countryCode: string) => void;
}

export function CountryDashboard({ onCountryChange }: CountryDashboardProps = {}) {
  const [countries, setCountries] = useState<CountryInfo[]>([]);
  const [selectedCountry, setSelectedCountry] = useState("");
  const [lookbackDays, setLookbackDays] = useState(28);
  const [periodMode, setPeriodMode] = useState<PeriodMode>("lookback");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  // Accept latency calculation-logic mode for the Country tab's Accept latency panel (country-master
  // `ttla_total` + each marked city's `ttla`). In-memory (like the period filter):
  // resets to "default" when the page remounts on a tab switch. Threaded into the
  // /master + /analytics fetches as the `ttla_mode` query param.
  const [ttlaMode, setTtlaMode] = useState<TtlaMode>("default");
  const [cityData, setCityData] = useState<Record<string, CityAnalyticsData>>({});
  const [masterData, setMasterData] = useState<CountryMasterData | null>(null);
  const [lateReasons, setLateReasons] = useState<CountryLateReasons | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Complete city list for the selected country (from the by-city aggregate, so
  // it includes cities not in the curated CITY_DATA) + the user's MARKED subset.
  // Only marked cities get their per-city analytics fetched, rendered, and
  // auto-refreshed; unmarked cities are never fetched or warmed.
  const [cityList, setCityList] = useState<CountryCityListItem[]>([]);
  const [cityListLoading, setCityListLoading] = useState(false);
  const [selectedCities, setSelectedCities] = useState<string[]>([]);
  // Read marked cities at call time (keeps loadData stable across selections).
  const selectedCitiesRef = useRef<string[]>([]);
  selectedCitiesRef.current = selectedCities;
  // Auto-refresh-on-tab-open: freshness of the loaded country/city data. When the
  // backend reports it served a stale cache and kicked off a background synthetic data source
  // warm, we show a non-blocking banner and silently re-poll until fresh.
  const [freshness, setFreshness] = useState<FreshnessSummary | null>(null);
  // Auto-refresh poll bookkeeping: `pollAttempt` drives the exponential backoff
  // (reset on a manual/initial load and once fresh); `pollError` surfaces a small
  // non-blocking hint when a SILENT re-poll fails (kept-last-good data underneath).
  const [pollAttempt, setPollAttempt] = useState(0);
  const [pollError, setPollError] = useState(false);

  // Shared synthetic data source session + global header status (see useConnection).
  const { live, connect, connecting, setStatus } = useConnection();

  const dateRange = useMemo(
    () => computeDateRange(periodMode, lookbackDays, customFrom, customTo),
    [periodMode, lookbackDays, customFrom, customTo],
  );

  // Tier A/large reason counts are aggregated SERVER-SIDE over a lookback window
  // (not per-day rows the client can re-filter), so we re-fetch them whenever the
  // selected window changes. Derive an effective day-count from the date range so
  // every period mode (lookback / completed days/weeks / custom) maps to a depth.
  const effectiveLookbackDays = useMemo(() => {
    const { from, to } = dateRange;
    const ms = new Date(to).getTime() - new Date(from).getTime();
    const days = Math.round(ms / 86_400_000) + 1;
    return Math.min(MAX_LOOKBACK_DAYS, Math.max(1, Number.isFinite(days) ? days : 28));
  }, [dateRange]);

  useEffect(() => {
    fetchCountries().then((list) => {
      setCountries(list);
      if (list.length === 0) return;
      // RESTORE the session selection if it points at a still-valid country —
      // render exactly what the user left. This is a hydration, NOT a
      // user-initiated country change, so it deliberately does NOT clear the
      // marked cities (the swap-clear lives only on the selector's onChange).
      const session = readSessionSelection();
      if (session && list.some((c) => c.code === session.selectedCountry)) {
        setSelectedCountry(session.selectedCountry);
        setSelectedCities(session.markedCities);
        onCountryChange?.(session.selectedCountry);
        return;
      }
      // First-ever load (or a stale session): default to the first country with
      // an EMPTY marked set — the user actively picks which cities to inspect.
      const code = list[0].code;
      setSelectedCountry(code);
      setSelectedCities([]);
      onCountryChange?.(code);
    });
  }, []);

  // Persist the current (country, marked cities) to sessionStorage on every
  // change, so leaving/returning to the tab (remount) and in-session reloads
  // restore it via the mount hydration above. Guarded on a selected country so
  // the initial empty render can't clobber a stored selection before hydration.
  useEffect(() => {
    if (!selectedCountry) return;
    writeSessionSelection({ selectedCountry, markedCities: selectedCities });
  }, [selectedCountry, selectedCities]);

  const country = countries.find((c) => c.code === selectedCountry);

  const fetchLookback = 28;

  // Loads the country master + ONLY the marked cities' analytics (read from the
  // ref so this stays stable across selection changes). `reset` clears the board
  // (country switch); otherwise data is swapped in atomically (no flicker on a
  // marked-set change). `silent` reloads (the auto-refresh poll) keep the current
  // data on screen and don't toggle the big spinner.
  const loadData = useCallback(async (opts?: { silent?: boolean; reset?: boolean; force?: boolean }) => {
    if (!country) return;
    const code = country.code;
    const marked = selectedCitiesRef.current;
    const silent = opts?.silent ?? false;
    if (opts?.reset) {
      setCityData({});
      setMasterData(null);
      setFreshness(null);
    }
    if (!silent) {
      setLoading(true);
      setError(null);
      // A user-initiated / country-switch load resets the backoff and clears any
      // stale poll-error hint.
      setPollAttempt(0);
      setPollError(false);
    }

    try {
      const emptyCity: CityAnalyticsData = {
        heavy_vehicle_share: [],
        large_vehicle_share: [],
        split_heavy_vehicle: [],
        hl_lateness: [],
        daily_rates: [],
        weight_perf: [],
        ttla: [],
      };

      // `force` (explicit Retry) bypasses the backend warm cooldown on both the
      // country master and each marked city's per-city warm. `ttlaMode` selects the
      // Accept latency-calculation logic for the ttla panel (default | 1st courier | fixed).
      const [masterResult, ...cityResults] = await Promise.allSettled([
        fetchCountryMaster(code, fetchLookback, opts?.force, ttlaMode),
        ...marked.map((city) => fetchCityAnalytics(code, city, fetchLookback, opts?.force, ttlaMode)),
      ]);

      if (masterResult.status === "fulfilled") {
        setMasterData(masterResult.value);
      }

      // Set cityData to EXACTLY the marked set, so freshness/rendering never
      // include an unmarked (and never-fetched) city.
      const results: Record<string, CityAnalyticsData> = {};
      marked.forEach((city, i) => {
        const r = cityResults[i];
        results[city] = r.status === "fulfilled" ? r.value : emptyCity;
      });
      setCityData(results);

      // Aggregate freshness across the country master + the marked cities only.
      setFreshness(
        aggregateFreshness([
          masterResult.status === "fulfilled" ? masterResult.value._freshness : undefined,
          ...cityResults.map((r) =>
            r.status === "fulfilled" ? (r.value as CityAnalyticsData)._freshness : undefined,
          ),
        ]),
      );
      // A reachable backend clears the poll-error hint (Promise.allSettled means
      // we got here without throwing — at least the request round-trips).
      setPollError(false);
    } catch (e: unknown) {
      if (!silent) setError(e instanceof Error ? e.message : "Failed to load data");
      // Don't blow away last-good data on a silent poll failure — just surface a
      // small "retrying" hint; the backoff poll keeps trying.
      else setPollError(true);
    } finally {
      if (!silent) setLoading(false);
      // Count every silent poll so the backoff grows while the tab stays stale /
      // unreachable; a change here also re-arms the poll effect after a failure
      // (freshness is unchanged on failure, so it alone wouldn't re-trigger it).
      else setPollAttempt((a) => a + 1);
    }
  }, [country, ttlaMode]);

  // Stable key for the marked set so the load effect re-runs on add/remove.
  const selectedCitiesKey = useMemo(() => [...selectedCities].sort().join("|"), [selectedCities]);

  // Load master + marked cities on a country switch (reset) or marked-set change
  // (atomic swap). `reset` is true only when the country actually changed.
  const lastLoadedCountryRef = useRef<string | null>(null);
  useEffect(() => {
    if (!country) return;
    const reset = lastLoadedCountryRef.current !== selectedCountry;
    lastLoadedCountryRef.current = selectedCountry;
    loadData({ reset });
  }, [selectedCountry, selectedCitiesKey, loadData]);

  // Fetch the COMPLETE city list (for the picker) when the country changes.
  useEffect(() => {
    if (!selectedCountry) return;
    let cancelled = false;
    setCityListLoading(true);
    setCityList([]);
    fetchCountryCityList(selectedCountry, CITY_LIST_LOOKBACK)
      .then((res) => { if (!cancelled) setCityList(res.cities); })
      .catch(() => { if (!cancelled) setCityList([]); })
      .finally(() => { if (!cancelled) setCityListLoading(false); });
    return () => { cancelled = true; };
  }, [selectedCountry]);

  // No auto-default: a freshly selected country starts with no marked cities
  // (cleared on swap, see the selector onChange) and the user picks from the
  // dropdown. Session restore (mount effect) repopulates the user's last set.

  // Toggle/replace marked cities; sessionStorage persistence is handled by the
  // write-effect above (CityMultiSelect stays presentational).
  const handleMarkedChange = useCallback((next: string[]) => {
    setSelectedCities(next);
  }, []);

  // Auto-refresh poll: while the backend is warming a stale cache (or the data is
  // stale and could still self-heal), silently re-fetch on a backoff timer until
  // fresh. `pollAttempt` (bumped by each silent load) feeds the backoff AND
  // re-arms this effect after a failed poll (which leaves `freshness` unchanged).
  useEffect(() => {
    if (!freshness) return;
    const delay = pollDelayMs(freshness, pollAttempt);
    if (delay === null) {
      if (pollAttempt !== 0) setPollAttempt(0); // fresh → reset backoff (settles)
      return;
    }
    const t = setTimeout(() => { loadData({ silent: true }); }, delay);
    return () => clearTimeout(t);
  }, [freshness, pollAttempt, loadData]);

  // Publish this tab's freshness to the global header status while mounted.
  useEffect(() => {
    setStatus(freshness);
    return () => setStatus(null);
  }, [freshness, setStatus]);

  // Sign in to synthetic data source (pops sign-in), then immediately re-load so the background
  // warm of the loaded country/cities starts without waiting out the backoff.
  const handleSignIn = useCallback(async () => {
    const ok = await connect();
    if (ok) { setPollAttempt(0); loadData({ silent: true, force: true }); }
  }, [connect, loadData]);

  // Explicit Retry from the failed/stalled banner — force a re-warm now
  // (bypasses the backend cooldown) across the master + marked cities.
  const handleRetry = useCallback(() => {
    setPollAttempt(0);
    setPollError(false);
    loadData({ silent: true, force: true });
  }, [loadData]);

  // If a session comes online elsewhere (header, another tab) while stale, warm now.
  useEffect(() => {
    if (live && freshness && freshness.stale && !freshness.canAutoRefresh) {
      setPollAttempt(0);
      loadData({ silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  // Tier A/large lateness reasons: fetched independently of loadData because they
  // are server-aggregated over the window (can't be client-filtered like the
  // daily-row master/city data), so they must re-fetch when the country OR the
  // effective window changes — "respecting the period/lookback filter".
  useEffect(() => {
    if (!selectedCountry) return;
    let cancelled = false;
    setLateReasons(null);
    fetchCountryLateReasons(selectedCountry, effectiveLookbackDays)
      .then((r) => { if (!cancelled) setLateReasons(r); })
      .catch(() => { if (!cancelled) setLateReasons(null); });
    return () => { cancelled = true; };
  }, [selectedCountry, effectiveLookbackDays]);

  const filteredMaster = useMemo((): CountryMasterData | null => {
    if (!masterData) return null;
    const { from, to } = dateRange;
    return {
      hl_lateness_total: masterData.hl_lateness_total.filter(
        (r) => r.confirmed_date >= from && r.confirmed_date <= to,
      ),
      daily_rates_total: (masterData.daily_rates_total ?? []).filter(
        (r) => r.confirmed_date >= from && r.confirmed_date <= to,
      ),
      perf_metrics: masterData.perf_metrics.filter(
        (r) => r.confirmed_date >= from && r.confirmed_date <= to,
      ),
      ttla_total: (masterData.ttla_total ?? []).filter(
        (r) => r.confirmed_date >= from && r.confirmed_date <= to,
      ),
      // Target is config-static (not a dated row) — pass it through unfiltered.
      ttla_target_sec: masterData.ttla_target_sec,
    };
  }, [masterData, dateRange]);

  const filteredCityData = useMemo(() => {
    const { from, to } = dateRange;
    const result: Record<string, CityAnalyticsData> = {};
    for (const [city, data] of Object.entries(cityData)) {
      result[city] = {
        heavy_vehicle_share: data.heavy_vehicle_share.filter(
          (r) => r.confirmed_date >= from && r.confirmed_date <= to,
        ),
        large_vehicle_share: data.large_vehicle_share.filter(
          (r) => r.confirmed_date >= from && r.confirmed_date <= to,
        ),
        split_heavy_vehicle: data.split_heavy_vehicle.filter(
          (r) => r.confirmed_date >= from && r.confirmed_date <= to,
        ),
        hl_lateness: data.hl_lateness.filter(
          (r) => r.confirmed_date >= from && r.confirmed_date <= to,
        ),
        daily_rates: (data.daily_rates ?? []).filter(
          (r) => r.confirmed_date >= from && r.confirmed_date <= to,
        ),
        weight_perf: data.weight_perf.filter(
          (r) => r.confirmed_date >= from && r.confirmed_date <= to,
        ),
        ttla: (data.ttla ?? []).filter(
          (r) => r.confirmed_date >= from && r.confirmed_date <= to,
        ),
        // Country Accept latency target (config-static) — pass through unfiltered.
        ttla_target_sec: data.ttla_target_sec,
      };
    }
    return result;
  }, [cityData, dateRange]);

  // Guard against showing a previous country's reasons during a switch.
  const activeReasons = lateReasons && lateReasons.code === selectedCountry ? lateReasons : null;

  const cityReasonsMap = useMemo(() => {
    const m: Record<string, HeavyLargeReasons> = {};
    for (const c of activeReasons?.cities ?? []) {
      m[c.city] = { heavy: c.heavy, large: c.large };
    }
    return m;
  }, [activeReasons]);

  return (
    <div className="space-y-6">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-[var(--color-text-muted)]">Country</label>
          <select
            value={selectedCountry}
            onChange={(e) => {
              const code = e.target.value;
              if (code === selectedCountry) return;
              // USER-initiated country change → CLEAR marked cities so the user
              // actively picks cities for the newly-selected country (shows the
              // "select cities" prompt + the always-on country board). Session
              // RESTORE, by contrast, hydrates in the mount effect and never
              // clears — that's the swap-vs-restore distinction.
              setSelectedCountry(code);
              setSelectedCities([]);
              onCountryChange?.(code);
            }}
            className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
          >
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* City picker lives inline in the toolbar (Country-tab only). Its
            dropdown is absolutely positioned with a high z-index and the toolbar
            has no overflow clipping, so the menu overlays the content below. */}
        {country && (
          <CityMultiSelect
            cities={cityList}
            selected={selectedCities}
            onChange={handleMarkedChange}
            loading={cityListLoading}
          />
        )}

        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-[var(--color-text-muted)]">Period</label>
          <select
            value={periodMode}
            onChange={(e) => setPeriodMode(e.target.value as PeriodMode)}
            className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-xs text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
          >
            {PERIOD_MODES.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {(periodMode === "lookback" || periodMode === "completed_days") && (
          <div className="flex rounded-md border border-[var(--color-border)] overflow-hidden">
            {LOOKBACK_OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() => setLookbackDays(o.value)}
                className={`h-8 px-2.5 text-xs font-medium transition-colors ${
                  lookbackDays === o.value
                    ? "bg-[var(--color-primary)] text-white"
                    : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}

        {periodMode === "completed_weeks" && (
          <div className="flex rounded-md border border-[var(--color-border)] overflow-hidden">
            {[1, 2, 4].map((w) => {
              const days = w * 7;
              return (
                <button
                  key={w}
                  onClick={() => setLookbackDays(days)}
                  className={`h-8 px-2.5 text-xs font-medium transition-colors ${
                    lookbackDays === days
                      ? "bg-[var(--color-primary)] text-white"
                      : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  }`}
                >
                  {w}w
                </button>
              );
            })}
          </div>
        )}

        {periodMode === "custom" && (
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-xs text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
            />
            <span className="text-xs text-[var(--color-text-muted)]">→</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-xs text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
            />
          </div>
        )}

        {/* Accept latency calculation logic: how each order's Accept latency is computed for the Accept latency
            panel (default | 1st courier | fixed) — the same 3 modes the dedicated
            Accept latency tab exposes. Applied to the country-master `ttla_total` + each
            marked city's `ttla`. For deliveries_count=1 all three coincide. */}
        <div className="flex items-center gap-2">
          <label
            className="text-xs font-medium text-[var(--color-text-muted)]"
            title="How each order's Accept latency is computed for the Accept latency panel (country + per-city)."
          >
            Accept latency logic
          </label>
          <div className="flex items-center overflow-hidden rounded-md border border-[var(--color-border)]">
            {ACCEPT_LATENCY_MODE_OPTIONS.map((o) => {
              const active = ttlaMode === o.value;
              return (
                <button
                  key={o.value}
                  onClick={() => setTtlaMode(o.value)}
                  title={o.title}
                  className={`h-8 px-2.5 text-xs font-medium transition-colors ${
                    active
                      ? "bg-[var(--color-primary)] text-white"
                      : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  }`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>

        <button
          onClick={() => loadData()}
          disabled={loading}
          className="ml-auto flex h-8 items-center gap-1.5 rounded-md bg-emerald-600 px-4 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
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

      {loading && Object.keys(cityData).length === 0 && (
        <div className="flex h-64 items-center justify-center">
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <Loader2 size={16} className="animate-spin" />
            Loading {country?.name ?? "country"} analytics
            {selectedCities.length > 0 ? ` + ${selectedCities.length} cit${selectedCities.length === 1 ? "y" : "ies"}…` : "…"}
          </div>
        </div>
      )}

      {filteredMaster && country && (
        <CountryMasterBoard
          countryName={country.name}
          data={filteredMaster}
          lateReasons={activeReasons?.country ?? null}
        />
      )}

      {country && (
        <CountryAIAnalysisPanel
          countryCode={country.code}
          countryName={country.name}
          cities={country.cities}
          defaultLookbackDays={effectiveLookbackDays}
        />
      )}

      {selectedCountry && (
        <AISummaryPanel tab="country" countryCode={selectedCountry} />
      )}

      {/* Marked-city analytics. The "Cities to inspect" dropdown (in the toolbar
          above) lists the COMPLETE set of cities for the country; only the marked
          cities render here and participate in the auto-refresh. */}
      {country &&
        (selectedCities.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-10 text-center text-sm text-[var(--color-text-muted)]">
            Use the “Cities to inspect” dropdown above to choose cities and view their analytics.
            <span className="mt-1 block text-xs">
              The country-level panel above always reflects all cities.
            </span>
          </div>
        ) : (
          selectedCities.map((cityName) => {
            const data = filteredCityData[cityName];
            // A freshly-marked, never-warmed city is served empty (no cache file
            // yet) while its background warm runs. Without a per-card signal that
            // empty card is indistinguishable from a city that genuinely has no
            // data — so show the loading state until THIS city's warm settles
            // (`_freshness.refreshing`). The poll then swaps the populated card in.
            const raw = cityData[cityName];
            const cityWarming = raw?._freshness?.refreshing ?? false;
            const cityHasNoRows =
              !raw ||
              ((raw.heavy_vehicle_share?.length ?? 0) === 0 &&
                (raw.large_vehicle_share?.length ?? 0) === 0 &&
                (raw.split_heavy_vehicle?.length ?? 0) === 0 &&
                (raw.hl_lateness?.length ?? 0) === 0 &&
                (raw.daily_rates?.length ?? 0) === 0 &&
                (raw.weight_perf?.length ?? 0) === 0 &&
                (raw.ttla?.length ?? 0) === 0);
            if (!data || (cityHasNoRows && cityWarming)) {
              return (
                <div
                  key={cityName}
                  className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-sm text-[var(--color-text-muted)]"
                >
                  <Loader2 size={14} className="animate-spin" />{" "}
                  {cityWarming ? `Generating ${cityName}…` : `Loading ${cityName}…`}
                </div>
              );
            }
            return (
              <CityAnalyticsCard
                key={cityName}
                cityName={cityName}
                data={data}
                lateReasons={cityReasonsMap[cityName] ?? null}
              />
            );
          })
        ))}
    </div>
  );
}
