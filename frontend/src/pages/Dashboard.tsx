import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { useFilters } from "../hooks/useFilters";
import { useOrders } from "../hooks/useOrders";
import { useMapData } from "../hooks/useMapData";
import { useViewFreshness } from "../hooks/useViewFreshness";
import { fetchCities, fetchCourierPerformance, fetchLateViewFreshness, startDataRefresh, getRefreshStatus, type RefreshStatus } from "../api/client";
import { KPICards } from "../components/KPICards";
import { TrendChart } from "../components/TrendChart";
import { LatenessReasonChart } from "../components/LatenessReasonChart";
import { OverlapMatrix } from "../components/OverlapMatrix";
import { OrderTable } from "../components/OrderTable";
import { MapView } from "../components/MapView";
import { AISummaryPanel } from "../components/AISummaryPanel";
import { CourierPerformancePanel } from "../components/CourierPerformancePanel";
import { VenuePerformancePanel } from "../components/VenuePerformancePanel";
import { StaleDataBanner, PollRetryHint } from "../components/StaleDataBanner";
import { ConnectionStatus } from "../components/ConnectionStatus";
import { Filters } from "../components/Filters";
import { ExportButtons } from "../components/ExportButtons";
import { BarChart3, Package, Globe, Globe2, LogOut, ScrollText, Sun, Moon, Database, Copy, Timer } from "lucide-react";
import { useTheme } from "../hooks/useTheme";
import { CountryDashboard } from "./CountryDashboard";
import { CloneRateDashboard } from "./CloneRateDashboard";
import { RegionDashboard } from "./RegionDashboard";
import { TtlaDashboard } from "./TtlaDashboard";
import { LogsPage } from "./LogsPage";
import type { CityInfo, LateOrder, RottenOrder, LateSummary, FlagAnalysis, TrendPoint, CourierTravelOrder, SizeFilter } from "../types";
import { LEX } from "../lib/lexicon";
import {
  compute_flag_counts,
  compute_overlap_matrix,
  compute_combination_counts,
  FLAG_LABELS,
} from "../lib/flagUtils";

function applySizeFilter<T extends { is_heavy_delivery?: boolean; is_large_delivery?: boolean }>(
  orders: T[],
  sizeFilter: string
): T[] {
  switch (sizeFilter) {
    case "heavy":
      return orders.filter((o) => o.is_heavy_delivery);
    case "large":
      return orders.filter((o) => o.is_large_delivery);
    case "heavy_or_large":
      return orders.filter((o) => o.is_heavy_delivery || o.is_large_delivery);
    case "normal":
      return orders.filter((o) => !o.is_heavy_delivery && !o.is_large_delivery);
    default:
      return orders;
  }
}

function getTotalForSize(trendData: TrendPoint[], sizeFilter: string): number {
  if (!trendData.length) return 0;
  switch (sizeFilter) {
    case "heavy":
      return trendData.reduce((s, t) => s + (t.total_heavy ?? 0), 0);
    case "large":
      return trendData.reduce((s, t) => s + (t.total_large ?? 0), 0);
    case "heavy_or_large":
      return trendData.reduce((s, t) => s + (t.total_heavy_or_large ?? 0), 0);
    case "normal": {
      const all = trendData.reduce((s, t) => s + t.total_orders, 0);
      const hl = trendData.reduce((s, t) => s + (t.total_heavy_or_large ?? 0), 0);
      return all - hl;
    }
    default:
      return trendData.reduce((s, t) => s + t.total_orders, 0);
  }
}

function computeSummaryFromOrders(
  orders: LateOrder[],
  trendData: TrendPoint[],
  sizeFilter: string,
): LateSummary | null {
  if (!orders.length && !trendData.length) return null;

  const lateCount = orders.length;
  const totalOrders = getTotalForSize(trendData, sizeFilter) || lateCount;

  const completionTimes = orders
    .map((o) => o.completion_time_min)
    .filter((v): v is number => v != null);

  const avgCompAll = trendData.length > 0
    ? (() => {
        const allTotal = trendData.reduce((s, t) => s + t.total_orders, 0);
        const weighted = trendData.reduce((s, t) => s + t.avg_completion_min * t.total_orders, 0);
        return allTotal > 0 ? Math.round((weighted / allTotal) * 10) / 10 : 0;
      })()
    : (completionTimes.length > 0
        ? Math.round((completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length) * 10) / 10
        : 0);

  const dates = orders.map((o) => o.delivered_date).sort();
  const trendDates = trendData.map((t) => t.delivered_date).sort();

  return {
    total_orders: totalOrders,
    late_orders: lateCount,
    late_orders_official: lateCount,
    late_pct: totalOrders > 0
      ? Math.round((lateCount / totalOrders) * 10000) / 100
      : 0,
    avg_late_completion_min: completionTimes.length > 0
      ? Math.round((completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length) * 10) / 10
      : 0,
    avg_completion_min: avgCompAll,
    period_start: trendDates[0] ?? dates[0] ?? "",
    period_end: trendDates[trendDates.length - 1] ?? dates[dates.length - 1] ?? "",
  };
}

function computeTrendFromOrders(orders: LateOrder[], apiTrend: TrendPoint[], sizeFilter: SizeFilter) {
  const lateByDate = new Map<string, number>();
  for (const o of orders) {
    if (!o.delivered_date) continue;
    lateByDate.set(o.delivered_date, (lateByDate.get(o.delivered_date) ?? 0) + 1);
  }

  if (apiTrend.length > 0) {
    return apiTrend
      .slice()
      .sort((a, b) => a.delivered_date.localeCompare(b.delivered_date))
      .map((t) => {
        let totalOrders = t.total_orders;
        if (sizeFilter === "heavy") totalOrders = t.total_heavy ?? 0;
        else if (sizeFilter === "large") totalOrders = t.total_large ?? 0;
        else if (sizeFilter === "heavy_or_large") totalOrders = t.total_heavy_or_large ?? 0;
        else if (sizeFilter === "normal") totalOrders = t.total_orders - (t.total_heavy_or_large ?? 0);

        const lateCount = sizeFilter === "all"
          ? (lateByDate.get(t.delivered_date) ?? t.late_orders_sla)
          : (lateByDate.get(t.delivered_date) ?? 0);
        return {
          ...t,
          total_orders: totalOrders,
          late_orders_sla: lateCount,
          late_orders_official: lateCount,
        };
      });
  }

  const byDate = new Map<string, { total: number; late: number; sumComp: number; compN: number }>();
  for (const o of orders) {
    const d = o.delivered_date;
    if (!d) continue;
    const entry = byDate.get(d) ?? { total: 0, late: 0, sumComp: 0, compN: 0 };
    entry.total++;
    if (o.is_sla_breach) entry.late++;
    if (o.completion_time_min != null) {
      entry.sumComp += o.completion_time_min;
      entry.compN++;
    }
    byDate.set(d, entry);
  }
  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, e]) => ({
      delivered_date: date,
      total_orders: e.total,
      late_orders_official: e.late,
      late_orders_sla: e.late,
      avg_completion_min: e.compN > 0 ? Math.round((e.sumComp / e.compN) * 10) / 10 : 0,
    }));
}

function computeFlagAnalysis(orders: LateOrder[]): FlagAnalysis {
  return {
    flag_counts: compute_flag_counts(orders),
    flag_labels: FLAG_LABELS,
    overlap_matrix: compute_overlap_matrix(orders),
    top_combinations: compute_combination_counts(orders),
  };
}

interface DashboardProps {
  user?: { username: string; name: string; role?: string };
  onLogout?: () => void;
}

export function Dashboard({ user, onLogout }: DashboardProps) {
  const { filters, activeTab, setActiveTab } = useFilters();
  const { theme, toggleTheme } = useTheme();
  const [cities, setCities] = useState<CityInfo[]>([]);

  const isAdmin = user?.role === "admin";
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus | null>(null);
  const [refreshModalOpen, setRefreshModalOpen] = useState(false);
  const [countryTabCountry, setCountryTabCountry] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollRefreshStatus = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const st = await getRefreshStatus();
        setRefreshStatus(st);
        if (!st.running) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, 2000);
  }, []);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleStartRefresh = async (opts?: { city?: string; country?: string }) => {
    try {
      await startDataRefresh(opts);
      setRefreshStatus({ running: true, progress: "Starting...", completed: 0, total: 0, errors: [] });
      pollRefreshStatus();
    } catch (e: any) {
      const msg = e?.response?.data?.detail || "Failed to start refresh";
      alert(msg);
    }
  };

  useEffect(() => {
    fetchCities().then(setCities).catch(() => {});
  }, []);

  const cityInfo = useMemo(
    () => cities.find((c) => c.name === filters.city),
    [cities, filters.city]
  );

  const {
    lateOrders,
    trendData,
    rottenOrders,
    rottenSummary,
    loading,
    error,
    loadLateData,
    loadRottenData,
  } = useOrders(filters.city, filters.lookbackDays);

  const mapData = useMapData(filters.city, filters.lookbackDays);

  const [courierTravelMap, setCourierTravelMap] = useState<Map<string, CourierTravelOrder>>(new Map());

  // Re-pull the whole Late/Queue aging view from the (cache-only) endpoints. No live
  // synthetic data source query ever happens here — the backend serves whatever is cached and
  // the freshness hook drives any background warm. Cheap enough to call on every
  // poll tick so warmed data swaps in as it lands.
  const loadAllData = useCallback(() => {
    loadLateData().catch(() => {});
    loadRottenData().catch(() => {});
    mapData.loadMapData().catch(() => {});
    fetchCourierPerformance(filters.city, filters.lookbackDays)
      .then((data) => {
        const map = new Map<string, CourierTravelOrder>();
        for (const o of data.orders) map.set(o.purchase_id, o);
        setCourierTravelMap(map);
      })
      .catch(() => setCourierTravelMap(new Map()));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.city, filters.lookbackDays]);

  // Serve-stale freshness + sign-in-gated background warm for the Late/Queue aging view.
  // Only active while one of those tabs is on-screen; drives the shared banner,
  // the poll loop, the global header status, and the Sign-in affordance.
  const cityTabActive = activeTab === "late" || activeTab === "rotten";
  const probeFreshness = useCallback(
    (force?: boolean) => fetchLateViewFreshness(filters.city, filters.lookbackDays, force),
    [filters.city, filters.lookbackDays],
  );
  const reloadViewData = useCallback((_silent: boolean) => { loadAllData(); }, [loadAllData]);
  const { freshness, pollError, retry, signIn, signingIn } = useViewFreshness({
    key: `${filters.city}:${filters.lookbackDays}`,
    enabled: cityTabActive,
    probe: probeFreshness,
    reloadData: reloadViewData,
  });

  const handleRefresh = () => {
    loadAllData();
  };

  const dateFilteredLate = useMemo(() => {
    if (filters.periodMode === "custom" || filters.periodMode === "completed_days" || filters.periodMode === "completed_weeks") {
      const from = filters.customFrom;
      const to = filters.customTo;
      if (from && to) {
        return lateOrders.filter((o) => o.delivered_date >= from && o.delivered_date <= to);
      }
    }
    return lateOrders;
  }, [lateOrders, filters.periodMode, filters.customFrom, filters.customTo]);

  const dateFilteredRotten = useMemo(() => {
    if (filters.periodMode === "custom" || filters.periodMode === "completed_days" || filters.periodMode === "completed_weeks") {
      const from = filters.customFrom;
      const to = filters.customTo;
      if (from && to) {
        return rottenOrders.filter((o) => o.delivered_date >= from && o.delivered_date <= to);
      }
    }
    return rottenOrders;
  }, [rottenOrders, filters.periodMode, filters.customFrom, filters.customTo]);

  const lateOrdersWithTravelFlags = useMemo(() => {
    if (courierTravelMap.size === 0) return dateFilteredLate;
    return dateFilteredLate.map((o) => {
      const travel = courierTravelMap.get(o.purchase_id);
      if (!travel) return o;
      return {
        ...o,
        is_slow_pickup: travel.is_slow_pickup_travel,
        is_slow_dropoff: travel.is_slow_dropoff_travel,
      };
    });
  }, [dateFilteredLate, courierTravelMap]);

  const filteredLateOrders = useMemo(
    () => applySizeFilter(lateOrdersWithTravelFlags, filters.sizeFilter),
    [lateOrdersWithTravelFlags, filters.sizeFilter]
  );

  const filteredRottenOrders = useMemo(
    () => applySizeFilter(dateFilteredRotten, filters.sizeFilter),
    [dateFilteredRotten, filters.sizeFilter]
  );

  const dateFilteredTrend = useMemo(() => {
    if (filters.periodMode === "custom" || filters.periodMode === "completed_days" || filters.periodMode === "completed_weeks") {
      const from = filters.customFrom;
      const to = filters.customTo;
      if (from && to) {
        return trendData.filter((t) => t.delivered_date >= from && t.delivered_date <= to);
      }
    }
    return trendData;
  }, [trendData, filters.periodMode, filters.customFrom, filters.customTo]);

  const computedSummary = useMemo(
    () => computeSummaryFromOrders(filteredLateOrders, dateFilteredTrend, filters.sizeFilter),
    [filteredLateOrders, dateFilteredTrend, filters.sizeFilter]
  );

  const computedTrend = useMemo(
    () => computeTrendFromOrders(filteredLateOrders, dateFilteredTrend, filters.sizeFilter),
    [filteredLateOrders, dateFilteredTrend, filters.sizeFilter]
  );

  const computedFlags = useMemo(
    () => computeFlagAnalysis(filteredLateOrders),
    [filteredLateOrders]
  );

  const filteredRottenSummary = useMemo(() => {
    if (filters.sizeFilter === "all") return rottenSummary;
    const byDate = new Map<string, { total: number; platform: number; late: number; rotten: number }>();
    for (const o of filteredRottenOrders) {
      const d = o.delivered_date;
      if (!d) continue;
      const entry = byDate.get(d) ?? { total: 0, platform: 0, late: 0, rotten: 0 };
      entry.total++;
      entry.platform++;
      if (o.is_rotten) entry.rotten++;
      if (o.is_late_official) entry.late++;
      byDate.set(d, entry);
    }
    return Array.from(byDate.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, e]) => ({
        delivered_date: date,
        total_orders: e.total,
        platform_orders: e.platform,
        late_count: e.late,
        rotten_count: e.rotten,
      }));
  }, [rottenSummary, filteredRottenOrders, filters.sizeFilter]);

  return (
    <div className="min-h-screen bg-[var(--color-bg)]">
      <header className="sticky top-0 z-50 border-b border-[var(--color-border)] bg-[var(--color-bg)]/80 backdrop-blur-md">
        <p className="mx-auto max-w-[1600px] px-6 pt-2 text-center text-[11px] text-[var(--color-text-muted)]">
          {LEX.demoDisclaimer}
        </p>
        {/* Row 1: Title, Tabs, User */}
        <div className="mx-auto flex max-w-[1600px] items-center justify-between px-6 pt-3 pb-2">
          <div className="flex items-center gap-5">
            <h1 className="text-lg font-bold text-[var(--color-text)]">
              {LEX.appTitle}
            </h1>

            <nav className="flex rounded-lg border border-[var(--color-border)] p-0.5">
              <button
                onClick={() => setActiveTab("region")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  activeTab === "region"
                    ? "bg-indigo-600 text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                <Globe2 size={14} />
                {LEX.tabRegion}
              </button>
              <button
                onClick={() => setActiveTab("country")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  activeTab === "country"
                    ? "bg-emerald-600 text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                <Globe size={14} />
                {LEX.tabMarket}
              </button>
              <button
                onClick={() => setActiveTab("late")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  activeTab === "late"
                    ? "bg-[var(--color-primary)] text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                <BarChart3 size={14} />
                {LEX.tabSla}
              </button>
              <button
                onClick={() => setActiveTab("rotten")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  activeTab === "rotten"
                    ? "bg-[var(--color-danger)] text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                <Package size={14} />
                {LEX.tabQueue}
              </button>
              <button
                onClick={() => setActiveTab("clone")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  activeTab === "clone"
                    ? "bg-violet-600 text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                <Copy size={14} />
                {LEX.tabRedispatch}
              </button>
              <button
                onClick={() => setActiveTab("ttla")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  activeTab === "ttla"
                    ? "bg-teal-600 text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                <Timer size={14} />
                {LEX.tabAccept}
              </button>
              <button
                onClick={() => setActiveTab("logs")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  activeTab === "logs"
                    ? "bg-amber-600 text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                <ScrollText size={14} />
                Logs
              </button>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <ConnectionStatus />
            <ExportButtons />
            {isAdmin && (
              <button
                onClick={() => setRefreshModalOpen(true)}
                className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${
                  refreshStatus?.running
                    ? "animate-pulse border-blue-500/50 bg-blue-500/10 text-blue-400"
                    : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                }`}
                title={LEX.warehouseRefreshHint}
              >
                <Database size={14} />
                {refreshStatus?.running
                  ? `Refreshing ${refreshStatus.completed}/${refreshStatus.total}`
                  : "Refresh all data"}
              </button>
            )}
            <button
              onClick={toggleTheme}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            {user && (
              <div className="flex items-center gap-2 border-l border-[var(--color-border)] pl-3">
                <span className="text-xs text-[var(--color-text-muted)]">{user.name}</span>
                <button
                  onClick={onLogout}
                  className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-400"
                  title="Sign out"
                >
                  <LogOut size={13} />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Row 2: Filters (Late/Queue aging/Redispatch share the top filter bar). The Accept latency
            tab is excluded — each of its three stacked panels renders its OWN
            filter bar + freshness scope inside TtlaDashboard. */}
        {(activeTab === "late" || activeTab === "rotten" || activeTab === "clone") && (
          <div className="mx-auto max-w-[1600px] border-t border-[var(--color-border)]/50 px-6 py-2">
            <Filters onRefresh={handleRefresh} loading={loading} />
          </div>
        )}
      </header>

      {error && (
        <div className="mx-auto max-w-[1600px] px-6 pt-4">
          <div className="rounded-lg border border-red-800/40 bg-red-900/20 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        </div>
      )}

      <main className="mx-auto max-w-[1600px] space-y-6 px-6 py-6">
        {cityTabActive && freshness && (
          <StaleDataBanner summary={freshness} onSignIn={signIn} signingIn={signingIn} onRetry={retry} />
        )}
        {cityTabActive && pollError && <PollRetryHint onRetry={retry} />}

        {activeTab === "logs" ? (
          <LogsPage />
        ) : activeTab === "country" ? (
          <CountryDashboard onCountryChange={setCountryTabCountry} />
        ) : activeTab === "clone" ? (
          <CloneRateDashboard city={filters.city} lookbackDays={filters.lookbackDays} sizeFilter={filters.sizeFilter} />
        ) : activeTab === "ttla" ? (
          <TtlaDashboard />
        ) : activeTab === "region" ? (
          <RegionDashboard />
        ) : activeTab === "late" ? (
          <>
            <KPICards
              summary={computedSummary}
              mode="late"
              sizeLabel={
                filters.sizeFilter === "heavy" ? "Tier A" :
                filters.sizeFilter === "large" ? "Tier B" :
                filters.sizeFilter === "heavy_or_large" ? "Tier A/Tier B" :
                filters.sizeFilter === "normal" ? "normal" :
                undefined
              }
            />

            <div className="grid gap-6 lg:grid-cols-2">
              <TrendChart data={computedTrend} mode="late" />
              <LatenessReasonChart flagAnalysis={computedFlags} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <OverlapMatrix flagAnalysis={computedFlags} />
              <AISummaryPanel tab="late" />
            </div>

            <MapView
              venues={mapData.venues}
              hexagons={mapData.hexagons}
              hourly={mapData.hourly}
              loading={mapData.loading}
              cityInfo={cityInfo}
              lateOrders={filteredLateOrders}
            />

            <CourierPerformancePanel city={filters.city} lookbackDays={filters.lookbackDays} />

            <VenuePerformancePanel city={filters.city} lookbackDays={filters.lookbackDays} sizeFilter={filters.sizeFilter} lateOrders={filteredLateOrders} />

            <OrderTable orders={filteredLateOrders} mode="late" />
          </>
        ) : (
          <>
            <KPICards rottenSummary={filteredRottenSummary} mode="rotten" />

            <TrendChart data={filteredRottenSummary} mode="rotten" />

            <MapView
              venues={mapData.venues}
              hexagons={mapData.hexagons}
              hourly={mapData.hourly}
              loading={mapData.loading}
              cityInfo={cityInfo}
              rottenOrders={filteredRottenOrders}
            />

            <AISummaryPanel tab="rotten" />

            <OrderTable orders={filteredRottenOrders} mode="rotten" />
          </>
        )}
      </main>

      {refreshModalOpen && isAdmin && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-2xl">
            <h2 className="mb-4 text-lg font-semibold text-[var(--color-text)]">
              Refresh all data (optional)
            </h2>

            {refreshStatus?.running ? (
              <div className="space-y-3">
                <div className="text-sm text-[var(--color-text-muted)]">
                  {refreshStatus.progress}
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[var(--color-border)]">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all duration-300"
                    style={{
                      width: refreshStatus.total > 0
                        ? `${(refreshStatus.completed / refreshStatus.total) * 100}%`
                        : "0%",
                    }}
                  />
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  {refreshStatus.completed} / {refreshStatus.total} datasets generated
                </div>
                {refreshStatus.errors.length > 0 && (
                  <div className="mt-2 max-h-32 overflow-y-auto rounded-lg border border-red-800/40 bg-red-900/20 p-2 text-xs text-red-300">
                    {refreshStatus.errors.map((e, i) => (
                      <div key={i}>{e}</div>
                    ))}
                  </div>
                )}
              </div>
            ) : refreshStatus && !refreshStatus.running && refreshStatus.total > 0 ? (
              <div className="space-y-3">
                <div className="text-sm text-green-400">
                  Refresh completed! {refreshStatus.completed} datasets generated.
                </div>
                {refreshStatus.errors.length > 0 && (
                  <div className="max-h-32 overflow-y-auto rounded-lg border border-red-800/40 bg-red-900/20 p-2 text-xs text-red-300">
                    <div className="mb-1 font-medium">{refreshStatus.errors.length} error(s):</div>
                    {refreshStatus.errors.map((e, i) => (
                      <div key={i}>{e}</div>
                    ))}
                  </div>
                )}
                <p className="text-xs text-[var(--color-text-muted)]">
                  Updated data flows into each tab automatically as it finishes — no need to reload.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-[var(--color-text-muted)]">
                  Optional. Tabs generate their own fictional view automatically. Use this
                  only to regenerate every market now; it runs locally in the background.
                </p>
                <p className="text-xs text-yellow-400/80">
                  {LEX.warehouseRefreshNote}
                </p>
              </div>
            )}

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                onClick={() => setRefreshModalOpen(false)}
                className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)]"
              >
                Close
              </button>
              {!refreshStatus?.running && (
                <>
                  {activeTab === "country" ? (
                    <button
                      onClick={() => handleStartRefresh({ country: countryTabCountry })}
                      disabled={!countryTabCountry}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                    >
                      Refresh {countryTabCountry || "Country"}
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => handleStartRefresh({ city: filters.city })}
                        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
                      >
                        Refresh {filters.city}
                      </button>
                      {cityInfo?.country && (
                        <button
                          onClick={() => handleStartRefresh({ country: cityInfo.country })}
                          className="rounded-lg border border-blue-600 px-4 py-2 text-sm font-medium text-blue-400 transition-colors hover:bg-blue-600/10"
                        >
                          Refresh {cityInfo.country}
                        </button>
                      )}
                    </>
                  )}
                  <button
                    onClick={() => handleStartRefresh()}
                    className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)]"
                  >
                    Refresh All
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
