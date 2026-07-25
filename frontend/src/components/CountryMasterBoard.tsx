import { Fragment, useMemo, useState, useCallback } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import type { CountryMasterData, PerfMetricsRow, HeavyLargeReasons } from "../types";
import { RateTrendChart } from "./RateTrendChart";
import { TtlaPanel } from "./TtlaPanel";
import { LatenessReasonChart } from "./LatenessReasonChart";
import { OverlapMatrix } from "./OverlapMatrix";
import { flagAnalysisFromBlock } from "../lib/flagUtils";

interface Props {
  countryName: string;
  data: CountryMasterData;
  lateReasons?: HeavyLargeReasons | null;
}

const VEHICLE_COLORS: Record<string, string> = {
  car: "#6366f1",
  bicycle: "#10b981",
  walking: "#f59e0b",
  motorcycle: "#ef4444",
  scooter: "#8b5cf6",
  van: "#06b6d4",
};

function getColor(vt: string): string {
  return VEHICLE_COLORS[vt.toLowerCase()] ?? "#94a3b8";
}

function HLLatenessSummaryChart({ data }: { data: CountryMasterData["hl_lateness_total"] }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const handleLegendClick = useCallback((entry: any) => {
    const name = entry?.value;
    if (!name) return;
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const rawChartData = useMemo(
    () =>
      data.map((d) => ({
        date: d.confirmed_date,
        heavy_late_pct:
          d.heavy_count > 0 ? Math.round((d.heavy_late / d.heavy_count) * 1000) / 10 : 0,
        large_late_pct:
          d.large_count > 0 ? Math.round((d.large_late / d.large_count) * 1000) / 10 : 0,
        avg_delivery_time: d.avg_delivery_time,
        _heavy_late: d.heavy_late,
        _heavy_count: d.heavy_count,
        _large_late: d.large_late,
        _large_count: d.large_count,
        _total_orders: d.total_orders,
      })),
    [data]
  );

  const masterKeyMap: Record<string, string> = {
    "Tier A Late %": "heavy_late_pct",
    "Tier B Late %": "large_late_pct",
    "Avg Delivery (min)": "avg_delivery_time",
  };

  const chartData = useMemo(() => {
    const nullKeys = Object.entries(masterKeyMap)
      .filter(([name]) => hidden.has(name))
      .map(([, key]) => key);
    if (!nullKeys.length) return rawChartData;
    return rawChartData.map((row) => {
      const copy = { ...row } as any;
      for (const k of nullKeys) copy[k] = undefined;
      return copy;
    });
  }, [rawChartData, hidden]);

  if (!data.length) return null;

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
      <h4 className="mb-2 text-xs font-semibold text-[var(--color-text)]">
        %Tier A Lateness & %Tier B Lateness (Country)
      </h4>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 9, fill: "var(--color-text-muted)" }}
            tickFormatter={(v) => v.slice(5)}
          />
          <YAxis
            yAxisId="left"
            tick={{ fontSize: 9, fill: "var(--color-text-muted)" }}
            tickFormatter={(v) => `${v}%`}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 9, fill: "var(--color-text-muted)" }}
            label={{
              value: "min",
              angle: 90,
              position: "insideRight",
              style: { fontSize: 9, fill: "var(--color-text-muted)" },
            }}
          />
          <Tooltip
            wrapperStyle={{ zIndex: 50 }}
            position={{ y: 0 }}
            allowEscapeViewBox={{ x: false, y: true }}
            content={({ active, payload, label }: any) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]?.payload;
              const items = (payload as any[]).filter((p: any) => p.value != null);
              return (
                <div style={{
                  backgroundColor: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 8, fontSize: 11, padding: "8px 10px",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
                }}>
                  <div style={{ marginBottom: 4, color: "var(--color-text-muted)", fontSize: 10 }}>{label}</div>
                  {items.map((item: any) => {
                    let detail = "";
                    if (item.dataKey === "heavy_late_pct" && row) detail = ` (${row._heavy_late} of ${row._heavy_count})`;
                    else if (item.dataKey === "large_late_pct" && row) detail = ` (${row._large_late} of ${row._large_count})`;
                    const suffix = String(item.name).includes("min") ? " min" : "%";
                    return (
                      <div key={item.dataKey} style={{ display: "flex", alignItems: "center", gap: 6, padding: "1px 0" }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: item.color, flexShrink: 0 }} />
                        <span style={{ color: "var(--color-text)" }}>
                          {item.name}: {item.value}{suffix}
                          {detail && <span style={{ color: "var(--color-text-muted)" }}>{detail}</span>}
                        </span>
                      </div>
                    );
                  })}
                  {row?._total_orders != null && (
                    <div style={{ marginTop: 4, paddingTop: 4, borderTop: "1px solid var(--color-border)", color: "var(--color-text-muted)", fontSize: 10 }}>
                      Total orders: {row._total_orders.toLocaleString()}
                    </div>
                  )}
                </div>
              );
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 10, cursor: "pointer" }}
            onClick={handleLegendClick}
            {...{ payload: [
              { value: "Tier A Late %", type: "line", color: "#ef4444" },
              { value: "Tier B Late %", type: "line", color: "#f97316" },
              { value: "Avg Delivery (min)", type: "line", color: "#10b981" },
            ] } as any}
            formatter={(value: string) => (
              <span style={{ opacity: hidden.has(value) ? 0.3 : 1 }}>{value}</span>
            )}
          />
          <Line
            yAxisId="left"
            dataKey="heavy_late_pct"
            name="Tier A Late %"
            stroke="#ef4444"
            strokeWidth={2}
            dot={false}
            strokeOpacity={hidden.has("Tier A Late %") ? 0 : 1}
          />
          <Line
            yAxisId="left"
            dataKey="large_late_pct"
            name="Tier B Late %"
            stroke="#f97316"
            strokeWidth={2}
            dot={false}
            strokeOpacity={hidden.has("Tier B Late %") ? 0 : 1}
          />
          <Line
            yAxisId="right"
            dataKey="avg_delivery_time"
            name="Avg Delivery (min)"
            stroke="#10b981"
            strokeWidth={1.5}
            strokeDasharray="4 2"
            dot={false}
            strokeOpacity={hidden.has("Avg Delivery (min)") ? 0 : 1}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

interface DiffRow {
  vehicle_type: string;
  cities: Record<string, {
    orderDiff: number | null;
    acceptDiff: number | null;
    ttlaDiff: number | null;
    adtDiff: number | null;
  }>;
}

function diffVal(heavy: number | null | undefined, nonHeavy: number | null | undefined): number | null {
  if (heavy == null || nonHeavy == null) return null;
  return heavy - nonHeavy;
}

function DiffCell({ value, suffix, decimals = 1, invert = false }: {
  value: number | null;
  suffix: string;
  decimals?: number;
  invert?: boolean;
}) {
  if (value == null) return <span className="text-[var(--color-text-muted)]">—</span>;
  const positive = invert ? value < 0 : value > 0;
  const negative = invert ? value > 0 : value < 0;
  const color = positive ? "text-red-400" : negative ? "text-emerald-400" : "text-[var(--color-text-muted)]";
  const sign = value > 0 ? "+" : "";
  return <span className={color}>{sign}{value.toFixed(decimals)}{suffix}</span>;
}

interface AggRow {
  order_count: number;
  task_acceptance_rate: number | null;
  avg_ttla_sec: number | null;
  avg_delivery_time: number | null;
}

function aggregateRows(rows: PerfMetricsRow[]): AggRow {
  let totalOrders = 0;
  let ttlaSum = 0, ttlaCount = 0;
  let adtSum = 0, adtCount = 0;
  let acceptSum = 0, acceptCount = 0;

  for (const r of rows) {
    totalOrders += r.order_count;
    if (r.avg_ttla_sec != null) { ttlaSum += r.avg_ttla_sec * r.order_count; ttlaCount += r.order_count; }
    if (r.avg_delivery_time != null) { adtSum += r.avg_delivery_time * r.order_count; adtCount += r.order_count; }
    if (r.task_acceptance_rate != null) { acceptSum += r.task_acceptance_rate * r.order_count; acceptCount += r.order_count; }
  }

  return {
    order_count: totalOrders,
    task_acceptance_rate: acceptCount > 0 ? acceptSum / acceptCount : null,
    avg_ttla_sec: ttlaCount > 0 ? ttlaSum / ttlaCount : null,
    avg_delivery_time: adtCount > 0 ? adtSum / adtCount : null,
  };
}

function PerfMetricsTable({ rows }: { rows: PerfMetricsRow[] }) {
  const { cities, diffRows } = useMemo(() => {
    const citySet = new Set<string>();
    const vtSet = new Set<string>();
    for (const r of rows) {
      citySet.add(r.city);
      vtSet.add(r.vehicle_type);
    }
    const cities = [...citySet].sort();
    const vehicleTypes = [...vtSet].sort();

    const buckets = new Map<string, PerfMetricsRow[]>();
    for (const r of rows) {
      const key = `${r.vehicle_type}|${r.city}|${r.is_heavy}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(r);
    }

    const agg = new Map<string, AggRow>();
    for (const [key, bucket] of buckets) {
      agg.set(key, aggregateRows(bucket));
    }

    const diffRows: DiffRow[] = vehicleTypes.map((vt) => {
      const citiesData: DiffRow["cities"] = {};
      for (const city of cities) {
        const h = agg.get(`${vt}|${city}|Yes`);
        const n = agg.get(`${vt}|${city}|No`);
        const hAccept = h?.task_acceptance_rate != null ? h.task_acceptance_rate * 100 : null;
        const nAccept = n?.task_acceptance_rate != null ? n.task_acceptance_rate * 100 : null;
        citiesData[city] = {
          orderDiff: diffVal(h?.order_count ?? null, n?.order_count ?? null),
          acceptDiff: diffVal(hAccept, nAccept),
          ttlaDiff: diffVal(h?.avg_ttla_sec ?? null, n?.avg_ttla_sec ?? null),
          adtDiff: diffVal(h?.avg_delivery_time ?? null, n?.avg_delivery_time ?? null),
        };
      }
      return { vehicle_type: vt, cities: citiesData };
    });

    return { cities, diffRows };
  }, [rows]);

  if (!rows.length) return null;

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
      <h4 className="mb-1 text-xs font-semibold text-[var(--color-text)]">
        Performance Metrics Difference
      </h4>
      <p className="mb-3 text-[9px] text-[var(--color-text-muted)]">
        Tier A minus Non-Tier A (positive = heavy is higher)
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] text-[var(--color-text)]">
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <th className="px-2 py-1.5 text-left font-semibold">Vehicle</th>
              <th className="px-2 py-1.5 text-left font-semibold">Metric</th>
              {cities.map((city) => (
                <th
                  key={city}
                  className="px-2 py-1.5 text-center font-semibold border-l border-[var(--color-border)]"
                >
                  {city}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {diffRows.map((row) => (
              <Fragment key={row.vehicle_type}>
                <tr className="border-t border-[var(--color-border)]">
                  <td className="px-2 py-1 font-semibold" rowSpan={4}>
                    <div className="flex items-center gap-1.5">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: getColor(row.vehicle_type) }}
                      />
                      {row.vehicle_type}
                    </div>
                  </td>
                  <td className="px-2 py-0.5 text-[var(--color-text-muted)]">Orders</td>
                  {cities.map((city) => (
                    <td key={city} className="px-2 py-0.5 text-center border-l border-[var(--color-border)]">
                      <DiffCell value={row.cities[city]?.orderDiff ?? null} suffix="" decimals={0} />
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="px-2 py-0.5 text-[var(--color-text-muted)]">Accept %</td>
                  {cities.map((city) => (
                    <td key={city} className="px-2 py-0.5 text-center border-l border-[var(--color-border)]">
                      <DiffCell value={row.cities[city]?.acceptDiff ?? null} suffix="pp" invert />
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="px-2 py-0.5 text-[var(--color-text-muted)]">Accept latency</td>
                  {cities.map((city) => (
                    <td key={city} className="px-2 py-0.5 text-center border-l border-[var(--color-border)]">
                      <DiffCell value={row.cities[city]?.ttlaDiff ?? null} suffix="s" decimals={0} />
                    </td>
                  ))}
                </tr>
                <tr className="border-b border-[var(--color-border)]/30">
                  <td className="px-2 py-0.5 text-[var(--color-text-muted)]">ADT</td>
                  {cities.map((city) => (
                    <td key={city} className="px-2 py-0.5 text-center border-l border-[var(--color-border)]">
                      <DiffCell value={row.cities[city]?.adtDiff ?? null} suffix=" min" />
                    </td>
                  ))}
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HeavyLargeReasonsSection({ reasons }: { reasons?: HeavyLargeReasons | null }) {
  if (reasons === undefined) return null;

  const heavyFA = flagAnalysisFromBlock(reasons?.heavy);
  const largeFA = flagAnalysisFromBlock(reasons?.large);
  const heavyTotal = reasons?.heavy?.total ?? 0;
  const largeTotal = reasons?.large?.total ?? 0;

  return (
    <div className="border-t border-[var(--color-border)] p-4">
      <h3 className="mb-1 text-sm font-bold text-[var(--color-text)]">
        Why are heavy &amp; large orders late?
      </h3>
      <p className="mb-3 text-[11px] text-[var(--color-text-muted)]">
        Reason flags for the late heavy / large subsets — each bar shows the count and its
        share of late heavy / large orders.
      </p>
      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <LatenessReasonChart
          flagAnalysis={heavyFA}
          title="Why are HEAVY orders late?"
          subtitle={`${heavyTotal.toLocaleString()} late heavy orders · % of late heavy`}
          total={heavyTotal}
          showPct
        />
        <LatenessReasonChart
          flagAnalysis={largeFA}
          title="Why are LARGE orders late?"
          subtitle={`${largeTotal.toLocaleString()} late large orders · % of late large`}
          total={largeTotal}
          showPct
        />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <OverlapMatrix
          flagAnalysis={heavyFA}
          title="Tier A — Top Reason Combinations"
          subtitle="Most common co-occurring reasons among late Tier A jobs"
        />
        <OverlapMatrix
          flagAnalysis={largeFA}
          title="Tier B — Top Reason Combinations"
          subtitle="Most common co-occurring reasons among late Tier B jobs"
        />
      </div>
      <p className="mt-3 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
        Source: the city late-orders model (per-city late set, pre-estimate based) + the
        shared lateness-flag engine — not the Country Overview SLA heavy/large-late
        definition above, so these counts won't perfectly reconcile to those KPIs (the
        same trade-off accepted for redispatch rate). Some reason inputs (courier pickup/dropoff
        timing, task-group fields) are populated mainly for R1, so several reasons may read
        0 for other countries — a data-coverage matter, not a bug.
      </p>
    </div>
  );
}

export function CountryMasterBoard({ countryName, data, lateReasons }: Props) {
  const totals = useMemo(() => {
    const rows = data.hl_lateness_total;
    if (!rows.length) return null;

    let heavyTotal = 0,
      heavyLate = 0,
      largeTotal = 0,
      largeLate = 0,
      totalOrders = 0;

    for (const r of rows) {
      heavyTotal += r.heavy_count;
      heavyLate += r.heavy_late;
      largeTotal += r.large_count;
      largeLate += r.large_late;
      totalOrders += r.total_orders;
    }

    return {
      totalOrders,
      heavyLatePct: heavyTotal > 0 ? Math.round((heavyLate / heavyTotal) * 1000) / 10 : 0,
      largeLatePct: largeTotal > 0 ? Math.round((largeLate / largeTotal) * 1000) / 10 : 0,
      heavyTotal,
      heavyLate,
      largeTotal,
      largeLate,
    };
  }, [data.hl_lateness_total]);

  const rateTotals = useMemo(() => {
    const rows = data.daily_rates_total ?? [];
    if (!rows.length) return null;
    let total = 0,
      late = 0,
      rotten = 0;
    for (const r of rows) {
      total += r.total_orders;
      late += r.late_count;
      rotten += r.rotten_count;
    }
    return {
      total,
      late,
      rotten,
      latePct: total > 0 ? Math.round((late / total) * 1000) / 10 : 0,
      rottenPct: total > 0 ? Math.round((rotten / total) * 1000) / 10 : 0,
    };
  }, [data.daily_rates_total]);

  return (
    <div className="rounded-xl border-2 border-[var(--color-primary)]/30 bg-[var(--color-surface)] overflow-hidden">
      <div className="border-b border-[var(--color-border)] px-5 py-3 bg-[var(--color-primary)]/5">
        <h3 className="text-sm font-bold text-[var(--color-text)]">
          {countryName} — Country Overview
        </h3>
      </div>

      {totals && (
        <div className="grid grid-cols-2 gap-3 px-5 py-4 sm:grid-cols-4">
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/50 p-3">
            <div className="text-[10px] text-[var(--color-text-muted)]">Total Orders</div>
            <div className="mt-1 text-lg font-bold text-[var(--color-text)]">
              {totals.totalOrders.toLocaleString()}
            </div>
          </div>
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/50 p-3">
            <div className="text-[10px] text-[var(--color-text-muted)]">Tier A Late %</div>
            <div className="mt-1 text-lg font-bold text-red-400">{totals.heavyLatePct}%</div>
            <div className="text-[9px] text-[var(--color-text-muted)]">
              {totals.heavyLate} / {totals.heavyTotal}
            </div>
          </div>
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/50 p-3">
            <div className="text-[10px] text-[var(--color-text-muted)]">Tier B Late %</div>
            <div className="mt-1 text-lg font-bold text-orange-400">{totals.largeLatePct}%</div>
            <div className="text-[9px] text-[var(--color-text-muted)]">
              {totals.largeLate} / {totals.largeTotal}
            </div>
          </div>
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/50 p-3">
            <div className="text-[10px] text-[var(--color-text-muted)]">Tier A Orders</div>
            <div className="mt-1 text-lg font-bold text-[var(--color-text)]">
              {totals.heavyTotal.toLocaleString()}
            </div>
            <div className="text-[9px] text-[var(--color-text-muted)]">
              {((totals.heavyTotal / totals.totalOrders) * 100).toFixed(1)}% of total
            </div>
          </div>
        </div>
      )}

      {rateTotals && (
        <div className="grid grid-cols-2 gap-3 px-5 pb-4 sm:grid-cols-4">
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/50 p-3">
            <div className="text-[10px] text-[var(--color-text-muted)]">
              Total Lateness Rate (excl. drive)
            </div>
            <div className="mt-1 text-lg font-bold text-red-400">{rateTotals.latePct}%</div>
            <div className="text-[9px] text-[var(--color-text-muted)]">
              {rateTotals.late.toLocaleString()} / {rateTotals.total.toLocaleString()}
            </div>
          </div>
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/50 p-3">
            <div className="text-[10px] text-[var(--color-text-muted)]">
              Queue Aging Rate (excl. drive)
            </div>
            <div className="mt-1 text-lg font-bold text-purple-400">{rateTotals.rottenPct}%</div>
            <div className="text-[9px] text-[var(--color-text-muted)]">
              {rateTotals.rotten.toLocaleString()} / {rateTotals.total.toLocaleString()}
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-4 p-4 lg:grid-cols-2 [&>*]:min-w-0">
        <HLLatenessSummaryChart data={data.hl_lateness_total} />
        <PerfMetricsTable rows={data.perf_metrics} />
        <RateTrendChart
          rows={data.daily_rates_total ?? []}
          metric="late"
          title="Lateness Rate Over Time (excl. drive)"
        />
        <RateTrendChart
          rows={data.daily_rates_total ?? []}
          metric="rotten"
          title="Queue Aging Over Time (excl. drive)"
        />
        <TtlaPanel
          title="Task to Last Accept (Country)"
          subtitle="Order-weighted mean seconds to last accept"
          rows={data.ttla_total ?? []}
          targetSec={data.ttla_target_sec ?? null}
        />
      </div>

      <HeavyLargeReasonsSection reasons={lateReasons} />
    </div>
  );
}
