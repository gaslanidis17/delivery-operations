import { useState, useMemo, useCallback } from "react";
import {
  fetchCloneSummary,
  fetchCloneAcceptance,
  fetchCloneVehicleDistribution,
  fetchCloneOrders,
  fetchCloneViewFreshness,
} from "../api/client";
import { useViewFreshness } from "../hooks/useViewFreshness";
import { StaleDataBanner, PollRetryHint } from "../components/StaleDataBanner";
import { AISummaryPanel } from "../components/AISummaryPanel";
import { VehicleCalendarHeatmap } from "../components/VehicleCalendarHeatmap";
import { OrdersCalendarHeatmap } from "../components/OrdersCalendarHeatmap";
import { VehicleSharePanel } from "../components/VehicleSharePanel";
import { CloneOrdersTable } from "../components/CloneOrdersTable";
import { CloneVenuePanel } from "../components/CloneVenuePanel";
import { GeoMapsPanel } from "../components/GeoMapsPanel";
import {
  iso,
  addDays,
  resolvePeriod,
  SIZE_KIND_LABEL,
  type CalendarViewMode,
  type CalendarPeriodType,
  type SizeKind,
} from "../lib/calendar";
import { Loader2, TrendingUp, Copy, Weight, Truck, FlaskConical, SlidersHorizontal } from "lucide-react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  AreaChart,
  Area,
  Cell,
} from "recharts";
import type {
  CloneSummaryResponse,
  CloneAcceptanceResponse,
  CloneVehicleDistributionResponse,
  CloneOrderRow,
  SizeFilter,
} from "../types";

interface Props {
  city: string;
  lookbackDays: number;
  sizeFilter: SizeFilter;
}

const SIZE_LABELS: Record<string, string> = {
  all: "Tier A | Tier B",
  heavy: "Tier A",
  large: "Tier B",
  heavy_or_large: "Tier A | Tier B",
  normal: "Tier A | Tier B",
};

const TIER_COLORS: Record<string, string> = {
  WEIGHT_L: "#60a5fa",
  WEIGHT_XL: "#f59e0b",
  WEIGHT_XXL: "#ef4444",
  WEIGHT_XXXL: "#a855f7",
};

type WeightFilter = "all" | "WEIGHT_L" | "WEIGHT_XL" | "WEIGHT_XXL" | "WEIGHT_XXXL";

const TREND_KEYS: Record<string, string> = {
  Orders: "total_orders",
  Redispatched: "cloned_count",
  "Redispatch %": "clone_rate_pct",
};

export function CloneRateDashboard({ city, lookbackDays, sizeFilter }: Props) {
  const [summaryData, setSummaryData] = useState<CloneSummaryResponse | null>(null);
  const [acceptanceData, setAcceptanceData] = useState<CloneAcceptanceResponse | null>(null);
  const [vehicleData, setVehicleData] = useState<CloneVehicleDistributionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [weightFilter, setWeightFilter] = useState<WeightFilter>("all");
  const [hiddenTrend, setHiddenTrend] = useState<Set<string>>(new Set());
  const [cloneOrders, setCloneOrders] = useState<CloneOrderRow[]>([]);

  // Shared filters for the calendars + maps (so they're set once, not per panel).
  const [geoSize, setGeoSize] = useState<SizeKind>("hl");
  const [geoVehicle, setGeoVehicle] = useState<string>("all");
  const [geoView, setGeoView] = useState<CalendarViewMode>("day");
  const [geoPeriodType, setGeoPeriodType] = useState<CalendarPeriodType>("completed_days");
  const [geoPeriodCount, setGeoPeriodCount] = useState<number>(28);
  const [geoCustomFrom, setGeoCustomFrom] = useState<string>(iso(addDays(new Date(), -28)));
  const [geoCustomTo, setGeoCustomTo] = useState<string>(iso(addDays(new Date(), -1)));
  const [vehicleTypeList, setVehicleTypeList] = useState<string[]>([]);

  const geoWindow = useMemo(
    () => resolvePeriod(geoPeriodType, geoPeriodCount, geoCustomFrom, geoCustomTo),
    [geoPeriodType, geoPeriodCount, geoCustomFrom, geoCustomTo]
  );

  const handleVehicleTypes = useCallback((types: string[]) => {
    setVehicleTypeList((prev) => (prev.join("|") === types.join("|") ? prev : types));
  }, []);

  const [simSupplyAdd, setSimSupplyAdd] = useState(0);
  const [simVehicleType, setSimVehicleType] = useState("motorcycle");
  const [simCostChange, setSimCostChange] = useState(0);
  const [simDxgyX, setSimDxgyX] = useState(5);
  const [simDxgyY, setSimDxgyY] = useState(10);
  const [simDxgyEnabled, setSimDxgyEnabled] = useState(false);

  // Cache-only pull of the Redispatch view (no live synthetic data source query on this path).
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, a, v, o] = await Promise.all([
        fetchCloneSummary(city, lookbackDays, sizeFilter, weightFilter),
        fetchCloneAcceptance(city, lookbackDays, sizeFilter),
        fetchCloneVehicleDistribution(city, lookbackDays),
        fetchCloneOrders(city, lookbackDays, sizeFilter, weightFilter),
      ]);
      setSummaryData(s);
      setAcceptanceData(a);
      setVehicleData(v);
      setCloneOrders(o.orders);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load redispatch rate data");
    } finally {
      setLoading(false);
    }
  }, [city, lookbackDays, sizeFilter, weightFilter]);

  // Serve-stale freshness + sign-in-gated background warm for the Redispatch view. The
  // probe only depends on city+lookback (the default warmed set), but the view
  // reloads whenever any filter changes so the displayed data always matches.
  const probeFreshness = useCallback(
    (force?: boolean) => fetchCloneViewFreshness(city, lookbackDays, force),
    [city, lookbackDays],
  );
  const reloadData = useCallback((_silent: boolean) => { loadData(); }, [loadData]);
  const { freshness, pollError, retry, signIn, signingIn } = useViewFreshness({
    key: `${city}:${lookbackDays}:${sizeFilter}:${weightFilter}`,
    probe: probeFreshness,
    reloadData,
  });

  // Filtering is done server-side via size_filter + weight_tier, so the daily
  // rows already reflect the active filters.
  const filteredDaily = useMemo(() => summaryData?.daily ?? [], [summaryData]);

  // Null out hidden series so the chart's axes rescale when toggled.
  const trendData = useMemo(() => {
    const nullKeys = Object.entries(TREND_KEYS)
      .filter(([name]) => hiddenTrend.has(name))
      .map(([, key]) => key);
    if (!nullKeys.length) return filteredDaily;
    return filteredDaily.map((row) => {
      const copy = { ...row };
      const writable = copy as unknown as Record<string, unknown>;
      for (const k of nullKeys) writable[k] = undefined;
      return copy;
    });
  }, [filteredDaily, hiddenTrend]);

  const handleTrendLegend = useCallback((entry: { value?: string }) => {
    const name = entry?.value;
    if (!name) return;
    setHiddenTrend((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const kpi = useMemo(() => {
    if (!summaryData) return null;
    const s = summaryData.summary;
    let avgAcceptance = 0;
    if (acceptanceData) {
      if (weightFilter !== "all") {
        const tier = acceptanceData.tiers.find((t) => t.capability_group === weightFilter);
        avgAcceptance = tier ? tier.acceptance_rate : 0;
      } else {
        // Order-weighted average across tiers with orders.
        const active = acceptanceData.tiers.filter((t) => t.total_orders > 0);
        const totalOrders = active.reduce((sum, t) => sum + t.total_orders, 0);
        avgAcceptance =
          totalOrders > 0
            ? active.reduce((sum, t) => sum + t.acceptance_rate * t.total_orders, 0) / totalOrders
            : 0;
      }
    }
    return { ...s, avgAcceptance };
  }, [summaryData, acceptanceData, weightFilter]);

  const tierOrderTotal = useMemo(
    () => (acceptanceData?.tiers ?? []).reduce((sum, t) => sum + (t.total_orders || 0), 0),
    [acceptanceData]
  );

  const shareData = useMemo(() => {
    if (!summaryData?.share_daily) return [];
    return summaryData.share_daily.map((d) => {
      const total = d.all_orders || 1;
      return {
        date: d.confirmed_date,
        heavy_pct: Math.round((d.heavy_count / total) * 1000) / 10,
        large_pct: Math.round((d.large_count / total) * 1000) / 10,
        heavy_count: d.heavy_count,
        large_count: d.large_count,
        all_orders: d.all_orders,
      };
    });
  }, [summaryData]);

  const simulation = useMemo(() => {
    if (!kpi || !vehicleData) return null;
    const totalCouriers = vehicleData.vehicles.reduce((s, v) => s + v.total_orders, 0);
    const currentCloneRate = kpi.clone_rate_pct;
    const currentAcceptance = kpi.avgAcceptance;

    const supplyIncreasePct = totalCouriers > 0 ? (simSupplyAdd / totalCouriers) * 100 : 0;
    const costFactor = 1 + simCostChange / 100;
    const projectedCloneRate = Math.max(0, currentCloneRate * (1 - supplyIncreasePct * 0.008));
    const projectedAcceptance = Math.min(1, currentAcceptance * (1 + supplyIncreasePct * 0.005) * (costFactor > 1 ? 1 + (costFactor - 1) * 0.3 : 1));
    const projectedTtlaReduction = kpi.avg_ttla_sec * (supplyIncreasePct * 0.006);

    const dxgyImpact = simDxgyEnabled
      ? { acceptanceBoost: 0.02, cloneReduction: currentCloneRate * 0.03, costPerOrder: simDxgyY / simDxgyX }
      : { acceptanceBoost: 0, cloneReduction: 0, costPerOrder: 0 };

    return {
      currentCloneRate,
      projectedCloneRate: Math.max(0, projectedCloneRate - dxgyImpact.cloneReduction),
      currentAcceptance,
      projectedAcceptance: Math.min(1, projectedAcceptance + dxgyImpact.acceptanceBoost),
      currentTtla: kpi.avg_ttla_sec,
      projectedTtla: Math.max(0, kpi.avg_ttla_sec - projectedTtlaReduction),
      supplyIncreasePct,
      dxgyCostPerOrder: dxgyImpact.costPerOrder,
      vehicleType: simVehicleType,
    };
  }, [kpi, vehicleData, simSupplyAdd, simCostChange, simVehicleType, simDxgyEnabled, simDxgyX, simDxgyY]);

  if (loading && !summaryData) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-violet-400" />
        <span className="ml-3 text-sm text-[var(--color-text-muted)]">Loading redispatch rate data...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-800/40 bg-red-900/20 px-4 py-3 text-sm text-red-300">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {freshness && (
        <StaleDataBanner summary={freshness} onSignIn={signIn} signingIn={signingIn} onRetry={retry} />
      )}
      {pollError && <PollRetryHint onRetry={retry} />}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-text-muted)]">
          Size filter (top bar):
          <span className="font-medium text-[var(--color-text)]">{SIZE_LABELS[sizeFilter] ?? "Tier A | Tier B"}</span>
        </span>
        <span className="text-[var(--color-text-muted)]">+</span>
        <label className="text-xs font-medium text-[var(--color-text-muted)]">Weight Tier:</label>
        <select
          value={weightFilter}
          onChange={(e) => setWeightFilter(e.target.value as WeightFilter)}
          className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
        >
          <option value="all">All Tiers</option>
          <option value="WEIGHT_L">WEIGHT_L</option>
          <option value="WEIGHT_XL">WEIGHT_XL</option>
          <option value="WEIGHT_XXL">WEIGHT_XXL</option>
          <option value="WEIGHT_XXXL">WEIGHT_XXXL</option>
        </select>
        {loading && <Loader2 size={14} className="animate-spin text-violet-400" />}
      </div>

      {/* KPI Cards */}
      {kpi && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <KPICard
            icon={<Weight size={16} className="text-violet-400" />}
            label="Tier A/Tier B Orders"
            value={kpi.total_orders.toLocaleString()}
            sub={`${kpi.heavy_count} heavy · ${kpi.large_count} large`}
          />
          <KPICard
            icon={<Copy size={16} className="text-red-400" />}
            label="Redispatch rate"
            value={`${kpi.clone_rate_pct}%`}
            sub={`${kpi.cloned_count} redispatched jobs`}
            highlight={kpi.clone_rate_pct > 10}
          />
          <KPICard
            icon={<TrendingUp size={16} className="text-emerald-400" />}
            label="Avg Acceptance Rate"
            value={`${(kpi.avgAcceptance * 100).toFixed(1)}%`}
            sub={weightFilter === "all" ? "across weight tiers" : weightFilter}
          />
          <KPICard
            icon={<Truck size={16} className="text-blue-400" />}
            label="Avg Accept latency"
            value={`${Math.round(kpi.avg_ttla_sec / 60)} min`}
            sub={`${kpi.avg_ttla_sec}s raw`}
          />
        </div>
      )}

      {/* Redispatch Rate Trend */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <h3 className="mb-1 text-sm font-semibold text-[var(--color-text)]">
          Redispatch trend
        </h3>
        <p className="mb-4 text-xs text-[var(--color-text-muted)]">Click a legend item to show or hide it; the chart rescales.</p>
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              dataKey="confirmed_date"
              tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
              tickFormatter={(v) => v.slice(5)}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
              label={{ value: "Orders", angle: -90, position: "insideLeft", style: { fontSize: 11, fill: "var(--color-text-muted)" } }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              domain={[0, "auto"]}
              tickFormatter={(v) => `${v}%`}
              tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
              label={{ value: "Redispatch %", angle: 90, position: "insideRight", style: { fontSize: 11, fill: "var(--color-text-muted)" } }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: 12,
              }}
              formatter={(value, name) => {
                const label = String(name);
                const numericValue = Number(value ?? 0);
                return label === "Redispatch %" ? [`${numericValue}%`, label] : [numericValue, label];
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 12, cursor: "pointer" }}
              onClick={handleTrendLegend}
              formatter={(value: string) => (
                <span style={{ opacity: hiddenTrend.has(value) ? 0.3 : 1 }}>{value}</span>
              )}
            />
            <Bar dataKey="total_orders" name="Orders" fill="#60a5fa" yAxisId="left" opacity={0.7} hide={hiddenTrend.has("Orders")} />
            <Bar dataKey="cloned_count" name="Redispatched" fill="#ef4444" yAxisId="left" opacity={0.8} hide={hiddenTrend.has("Redispatched")} />
            <Line
              dataKey="clone_rate_pct"
              name="Redispatch %"
              stroke="#a855f7"
              strokeWidth={2}
              dot={{ r: 3, fill: "#a855f7" }}
              yAxisId="right"
              hide={hiddenTrend.has("Redispatch %")}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Acceptance Rate + Share grid */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Acceptance by Weight Tier */}
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <h3 className="mb-4 text-sm font-semibold text-[var(--color-text)]">
            Weight Tier Dashboard
          </h3>
          {acceptanceData && (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={acceptanceData.tiers.filter((t) => t.total_orders > 0)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="capability_group" tick={{ fontSize: 11, fill: "var(--color-text-muted)" }} />
                  <YAxis
                    tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                    tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                    domain={[0, 1]}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--color-surface)",
                      border: "1px solid var(--color-border)",
                      borderRadius: "8px",
                      fontSize: 12,
                    }}
                    formatter={(value) => [
                      `${(Number(value ?? 0) * 100).toFixed(1)}%`,
                      "Acceptance",
                    ]}
                  />
                  <Bar dataKey="acceptance_rate" name="Acceptance Rate">
                    {acceptanceData.tiers.filter((t) => t.total_orders > 0).map((t) => (
                      <Cell key={t.capability_group} fill={TIER_COLORS[t.capability_group] || "#888"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>

              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                      <th className="px-2 py-1.5">Tier</th>
                      <th className="px-2 py-1.5 text-right">Orders</th>
                      <th className="px-2 py-1.5 text-right" title="Share of this tier among all weight-tier orders">Mix %</th>
                      <th className="px-2 py-1.5 text-right">Accept %</th>
                      <th className="px-2 py-1.5 text-right">Redispatch %</th>
                      <th className="px-2 py-1.5 text-right">Accept latency</th>
                      <th className="px-2 py-1.5 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {acceptanceData.tiers.map((t) => (
                      <tr key={t.capability_group} className="border-b border-[var(--color-border)]/30">
                        <td className="px-2 py-1.5 font-medium text-[var(--color-text)]">
                          <span
                            className="mr-1.5 inline-block h-2 w-2 rounded-full"
                            style={{ background: TIER_COLORS[t.capability_group] }}
                          />
                          {t.capability_group}
                        </td>
                        <td className="px-2 py-1.5 text-right text-[var(--color-text-muted)]">{t.total_orders}</td>
                        <td className="px-2 py-1.5 text-right text-[var(--color-text)]">
                          {tierOrderTotal > 0 ? ((t.total_orders / tierOrderTotal) * 100).toFixed(1) : "0.0"}%
                        </td>
                        <td className="px-2 py-1.5 text-right text-[var(--color-text-muted)]">
                          {(t.acceptance_rate * 100).toFixed(1)}%
                        </td>
                        <td className={`px-2 py-1.5 text-right ${t.cloned_pct > 15 ? "text-red-400 font-medium" : "text-[var(--color-text-muted)]"}`}>
                          {t.cloned_pct}%
                        </td>
                        <td className="px-2 py-1.5 text-right text-[var(--color-text-muted)]">
                          {Math.round(t.avg_ttla_sec / 60)}m
                        </td>
                        <td className="px-2 py-1.5 text-right text-[var(--color-text-muted)]">
                          {t.weight_cost > 0 ? `$${t.weight_cost.toFixed(2)}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* Share of City Volume */}
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <h3 className="text-sm font-semibold text-[var(--color-text)]">
            Tier A &amp; Tier B Share of City Volume
          </h3>
          <p className="mb-4 text-xs text-[var(--color-text-muted)]">
            Each line = that segment ÷ all completed jobs in the market. Lines are independent (a job can match both tiers).
          </p>
          <ResponsiveContainer width="100%" height={320}>
            <AreaChart data={shareData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                tickFormatter={(v) => v.slice(5)}
              />
              <YAxis
                tickFormatter={(v) => `${v}%`}
                tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                domain={[0, "auto"]}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "8px",
                  fontSize: 12,
                }}
                formatter={(value, name, item) => {
                  const label = String(name);
                  const payload = item.payload as {
                    heavy_count?: number;
                    large_count?: number;
                    all_orders?: number;
                  } | undefined;
                  const count = label.startsWith("Tier A") ? payload?.heavy_count : payload?.large_count;
                  return [
                    `${Number(value ?? 0)}%  (${(count ?? 0).toLocaleString()} of ${(payload?.all_orders ?? 0).toLocaleString()} orders)`,
                    label,
                  ];
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="heavy_pct" name="Tier A % of city" fill="#ef4444" stroke="#ef4444" fillOpacity={0.2} />
              <Area type="monotone" dataKey="large_pct" name="Tier B % of city" fill="#f59e0b" stroke="#f59e0b" fillOpacity={0.2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Shared filter bar for the calendars + maps below */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="mb-3 flex items-center gap-2">
          <SlidersHorizontal size={15} className="text-violet-400" />
          <h3 className="text-sm font-semibold text-[var(--color-text)]">Calendars &amp; Maps Filters</h3>
          <span className="text-xs text-[var(--color-text-muted)]">— applied to the calendars and maps below</span>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-[var(--color-text-muted)]">Order type</label>
            <select
              value={geoSize}
              onChange={(e) => setGeoSize(e.target.value as SizeKind)}
              className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
            >
              <option value="hl">{SIZE_KIND_LABEL.hl}</option>
              <option value="heavy">{SIZE_KIND_LABEL.heavy}</option>
              <option value="large">{SIZE_KIND_LABEL.large}</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-[var(--color-text-muted)]">Vehicle type</label>
            <select
              value={geoVehicle}
              onChange={(e) => setGeoVehicle(e.target.value)}
              className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
            >
              <option value="all">All vehicles</option>
              {vehicleTypeList.map((vt) => (
                <option key={vt} value={vt}>{vt}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-[var(--color-text-muted)]">Calendar view</label>
            <select
              value={geoView}
              onChange={(e) => setGeoView(e.target.value as CalendarViewMode)}
              className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
            >
              <option value="day">By day</option>
              <option value="hour">By hour</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-[var(--color-text-muted)]">Period</label>
            <select
              value={geoPeriodType}
              onChange={(e) => setGeoPeriodType(e.target.value as CalendarPeriodType)}
              className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
            >
              <option value="days">By days</option>
              <option value="weeks">By weeks</option>
              <option value="completed_days">Completed days</option>
              <option value="completed_weeks">Completed weeks</option>
              <option value="custom">Custom range</option>
            </select>
          </div>

          {geoPeriodType === "custom" ? (
            <>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-[var(--color-text-muted)]">From</label>
                <input
                  type="date"
                  value={geoCustomFrom}
                  max={geoCustomTo}
                  onChange={(e) => setGeoCustomFrom(e.target.value)}
                  className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-[var(--color-text-muted)]">To</label>
                <input
                  type="date"
                  value={geoCustomTo}
                  min={geoCustomFrom}
                  onChange={(e) => setGeoCustomTo(e.target.value)}
                  className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
                />
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-[var(--color-text-muted)]">
                {geoPeriodType.includes("week") ? "Weeks" : "Days"}
              </label>
              <input
                type="number"
                min={1}
                max={geoPeriodType.includes("week") ? 26 : 90}
                value={geoPeriodCount}
                onChange={(e) => setGeoPeriodCount(Math.max(1, parseInt(e.target.value || "1", 10)))}
                className="h-8 w-20 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
              />
            </div>
          )}

          <span className="ml-auto text-xs text-[var(--color-text-muted)]">
            {geoWindow.from} → {geoWindow.to}
          </span>
        </div>
      </div>

      {/* Calendars side by side for easy comparison */}
      <div className="grid gap-6 xl:grid-cols-2">
        <VehicleCalendarHeatmap
          city={city}
          view={geoView}
          dateFrom={geoWindow.from}
          dateTo={geoWindow.to}
          vehicleType={geoVehicle}
          onVehicleTypes={handleVehicleTypes}
        />
        <OrdersCalendarHeatmap
          city={city}
          view={geoView}
          dateFrom={geoWindow.from}
          dateTo={geoWindow.to}
          size={geoSize}
        />
      </div>

      {/* Vehicle & order maps — own day + hour-range picker, seeded from the shared window */}
      <GeoMapsPanel
        city={city}
        dateTo={geoWindow.to}
        size={geoSize}
        vehicleType={geoVehicle}
      />

      {/* Vehicle share of heavy/large deliveries */}
      <VehicleSharePanel city={city} lookbackDays={lookbackDays} />

      {/* Top venues contributing heavy/large orders (and how many were cloned) */}
      <CloneVenuePanel city={city} dateFrom={geoWindow.from} dateTo={geoWindow.to} cloneOrders={cloneOrders} />

      {/* Redispatched Orders list (reacts to the size + weight-tier filters above) */}
      <CloneOrdersTable orders={cloneOrders} loading={loading} />

      {/* What-If Simulation */}
      <div className="rounded-xl border border-violet-800/30 bg-[var(--color-surface)] p-5">
        <div className="mb-4 flex items-center gap-2">
          <FlaskConical size={16} className="text-violet-400" />
          <h3 className="text-sm font-semibold text-[var(--color-text)]">
            What-If Simulation
          </h3>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Inputs */}
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs text-[var(--color-text-muted)]">
                Add couriers
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={simSupplyAdd}
                  onChange={(e) => setSimSupplyAdd(Number(e.target.value))}
                  className="h-8 w-20 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
                />
                <span className="text-xs text-[var(--color-text-muted)]">of type</span>
                <select
                  value={simVehicleType}
                  onChange={(e) => setSimVehicleType(e.target.value)}
                  className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
                >
                  <option value="car">Car</option>
                  <option value="motorcycle">Motorcycle</option>
                  <option value="bicycle">Bicycle</option>
                  <option value="ebicycle">E-Bicycle</option>
                  <option value="emotorcycle">E-Motorcycle</option>
                  <option value="scooter">Scooter</option>
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs text-[var(--color-text-muted)]">
                Weight cost change (%)
              </label>
              <input
                type="number"
                min={-50}
                max={100}
                value={simCostChange}
                onChange={(e) => setSimCostChange(Number(e.target.value))}
                className="h-8 w-24 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
              />
            </div>

            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={simDxgyEnabled}
                  onChange={(e) => setSimDxgyEnabled(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-gray-600"
                />
                <label className="text-xs font-medium text-[var(--color-text)]">
                  Enable DxGy Bonus
                </label>
              </div>
              {simDxgyEnabled && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-[var(--color-text-muted)]">Do</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={simDxgyX}
                    onChange={(e) => setSimDxgyX(Number(e.target.value))}
                    className="h-7 w-14 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-xs text-[var(--color-text)]"
                  />
                  <span className="text-xs text-[var(--color-text-muted)]">orders, get</span>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={simDxgyY}
                    onChange={(e) => setSimDxgyY(Number(e.target.value))}
                    className="h-7 w-14 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-xs text-[var(--color-text)]"
                  />
                  <span className="text-xs text-[var(--color-text-muted)]">reward</span>
                </div>
              )}
            </div>
          </div>

          {/* Projected outcomes */}
          {simulation && (
            <div className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Projected Impact
              </h4>
              <SimMetric
                label="Redispatch rate"
                current={`${simulation.currentCloneRate.toFixed(1)}%`}
                projected={`${simulation.projectedCloneRate.toFixed(1)}%`}
                improved={simulation.projectedCloneRate < simulation.currentCloneRate}
              />
              <SimMetric
                label="Acceptance Rate"
                current={`${(simulation.currentAcceptance * 100).toFixed(1)}%`}
                projected={`${(simulation.projectedAcceptance * 100).toFixed(1)}%`}
                improved={simulation.projectedAcceptance > simulation.currentAcceptance}
              />
              <SimMetric
                label="Avg Accept latency"
                current={`${Math.round(simulation.currentTtla / 60)}m`}
                projected={`${Math.round(simulation.projectedTtla / 60)}m`}
                improved={simulation.projectedTtla < simulation.currentTtla}
              />
              {simDxgyEnabled && (
                <div className="rounded-lg border border-amber-800/30 bg-amber-900/10 p-2.5 text-xs text-amber-300">
                  DxGy cost: ~${simulation.dxgyCostPerOrder.toFixed(2)} per order
                </div>
              )}
              <p className="text-[10px] text-[var(--color-text-muted)]">
                Projections use simplified heuristic models. Actual results may vary.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* AI Analysis */}
      <AISummaryPanel tab="clone" />
    </div>
  );
}

function KPICard({
  icon,
  label,
  value,
  sub,
  highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        {icon}
        {label}
      </div>
      <div className={`mt-1 text-2xl font-bold ${highlight ? "text-red-400" : "text-[var(--color-text)]"}`}>
        {value}
      </div>
      <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{sub}</div>
    </div>
  );
}

function SimMetric({
  label,
  current,
  projected,
  improved,
}: {
  label: string;
  current: string;
  projected: string;
  improved: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[var(--color-border)] px-3 py-2">
      <span className="text-xs text-[var(--color-text-muted)]">{label}</span>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-[var(--color-text-muted)]">{current}</span>
        <span className="text-[var(--color-text-muted)]">&rarr;</span>
        <span className={improved ? "font-medium text-emerald-400" : "font-medium text-red-400"}>
          {projected}
        </span>
      </div>
    </div>
  );
}
