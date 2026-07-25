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
import type { CityAnalyticsData, VehicleShareRow, HLLatenessRow, WeightPerfRow, HeavyLargeReasons } from "../types";
import { RateTrendChart } from "./RateTrendChart";
import { TtlaPanel } from "./TtlaPanel";
import { LatenessReasonChart } from "./LatenessReasonChart";
import { flagAnalysisFromBlock } from "../lib/flagUtils";

interface CityAnalyticsCardProps {
  cityName: string;
  data: CityAnalyticsData;
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

function getVehicleColor(vt: string): string {
  return VEHICLE_COLORS[vt.toLowerCase()] ?? "#94a3b8";
}

function pivotByVehicle(rows: VehicleShareRow[], countKey: "heavy_count" | "large_count" | "split_count") {
  const vehicleTypes = [...new Set(rows.map((r) => r.vehicle_type))].sort();
  const byDate = new Map<string, Record<string, number>>();

  for (const r of rows) {
    const entry = byDate.get(r.confirmed_date) ?? ({ date: r.confirmed_date } as unknown as Record<string, number>);
    entry[r.vehicle_type] = r.total_orders;
    const cv = r[countKey];
    if (cv != null) {
      entry[`${r.vehicle_type}_target`] = cv;
    }
    entry._day_total = (entry._day_total || 0) + r.total_orders;
    byDate.set(r.confirmed_date, entry);
  }

  const chartData = Array.from(byDate.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));

  for (const row of chartData) {
    const dayTotal = row._day_total || 1;
    for (const vt of vehicleTypes) {
      const target = (row[`${vt}_target`] as number) || 0;
      row[`${vt}_pct`] = Math.round((target / dayTotal) * 1000) / 10;
    }
  }

  const activeVehicleTypes = vehicleTypes.filter((vt) =>
    chartData.some((row) => (row[`${vt}_pct`] as number) > 0)
  );

  return { vehicleTypes: activeVehicleTypes, chartData };
}

function NonZeroTooltip(props: any) {
  const { active, payload, label, suffix = "%", showCounts = false } = props;
  if (!active || !payload) return null;
  const items = (payload as any[]).filter((p: any) => p.value != null && p.value !== 0);
  if (!items.length) return null;
  const row = payload[0]?.payload;
  const dayTotal = row?._day_total;
  return (
    <div
      style={{
        backgroundColor: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        fontSize: 11,
        padding: "8px 10px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{ marginBottom: 4, color: "var(--color-text-muted)", fontSize: 10 }}>{label}</div>
      {items.map((item: any) => {
        const rawKey = item.dataKey?.replace(/_pct$/, "_target");
        const rawCount = showCounts && row ? row[rawKey] : null;
        return (
          <div key={item.dataKey} style={{ display: "flex", alignItems: "center", gap: 6, padding: "1px 0" }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: item.color, flexShrink: 0 }} />
            <span style={{ color: "var(--color-text)" }}>
              {item.name}: {item.value}{suffix}
              {rawCount != null && <span style={{ color: "var(--color-text-muted)" }}> ({rawCount})</span>}
            </span>
          </div>
        );
      })}
      {showCounts && dayTotal != null && (
        <div style={{ marginTop: 4, paddingTop: 4, borderTop: "1px solid var(--color-border)", color: "var(--color-text-muted)", fontSize: 10 }}>
          Total orders: {dayTotal.toLocaleString()}
        </div>
      )}
    </div>
  );
}

function VehicleShareChart({
  title,
  rows,
  countKey,
  targetLabel,
}: {
  title: string;
  rows: VehicleShareRow[];
  countKey: "heavy_count" | "large_count" | "split_count";
  targetLabel: string;
}) {
  const { vehicleTypes, chartData } = useMemo(() => pivotByVehicle(rows, countKey), [rows, countKey]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const handleLegendClick = useCallback((e: any) => {
    const key = e.dataKey || e.value;
    if (!key) return;
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const scaledData = useMemo(() => {
    const nullKeys = vehicleTypes
      .filter((vt) => hidden.has(vt))
      .map((vt) => `${vt}_pct`);
    if (!nullKeys.length) return chartData;
    return chartData.map((row) => {
      const copy = { ...row };
      for (const k of nullKeys) copy[k] = undefined as any;
      return copy;
    });
  }, [chartData, hidden, vehicleTypes]);

  if (!rows.length) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/50">
        <span className="text-xs text-[var(--color-text-muted)]">No data</span>
      </div>
    );
  }

  const legendPayload = vehicleTypes.map((vt) => ({
    value: vt,
    type: "line" as const,
    color: getVehicleColor(vt),
  }));

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
      <h4 className="mb-2 text-xs font-semibold text-[var(--color-text)]">{title}</h4>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={scaledData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 9, fill: "var(--color-text-muted)" }}
            tickFormatter={(v) => v.slice(5)}
          />
          <YAxis
            yAxisId="right"
            tick={{ fontSize: 9, fill: "var(--color-text-muted)" }}
            tickFormatter={(v) => `${v}%`}
            domain={[0, "auto"]}
          />
          <Tooltip
            wrapperStyle={{ zIndex: 50 }}
            content={<NonZeroTooltip showCounts />}
            position={{ y: 0 }}
            allowEscapeViewBox={{ x: false, y: true }}
          />
          <Legend
            wrapperStyle={{ fontSize: 10, cursor: "pointer" }}
            onClick={handleLegendClick}
            {...{ payload: legendPayload } as any}
            formatter={(value: string) => (
              <span style={{ opacity: hidden.has(value) ? 0.3 : 1 }}>{value}</span>
            )}
          />
          {vehicleTypes.map((vt) => (
            <Line
              key={`${vt}_pct`}
              yAxisId="right"
              dataKey={`${vt}_pct`}
              name={vt}
              stroke={getVehicleColor(vt)}
              strokeWidth={2}
              dot={false}
              strokeOpacity={hidden.has(vt) ? 0 : 1}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function HLLatenessChart({ data }: { data: HLLatenessRow[] }) {
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
        heavy_late_pct: d.heavy_count > 0 ? Math.round((d.heavy_late / d.heavy_count) * 1000) / 10 : 0,
        large_late_pct: d.large_count > 0 ? Math.round((d.large_late / d.large_count) * 1000) / 10 : 0,
        avg_delivery_time: d.avg_delivery_time,
        _heavy_late: d.heavy_late,
        _heavy_count: d.heavy_count,
        _large_late: d.large_late,
        _large_count: d.large_count,
        _total_orders: d.total_orders,
      })),
    [data],
  );

  const hlKeyMap: Record<string, string> = {
    "Tier A Late %": "heavy_late_pct",
    "Tier B Late %": "large_late_pct",
    "Avg Delivery (min)": "avg_delivery_time",
  };

  const chartData = useMemo(() => {
    const nullKeys = Object.entries(hlKeyMap)
      .filter(([name]) => hidden.has(name))
      .map(([, key]) => key);
    if (!nullKeys.length) return rawChartData;
    return rawChartData.map((row) => {
      const copy = { ...row } as any;
      for (const k of nullKeys) copy[k] = undefined;
      return copy;
    });
  }, [rawChartData, hidden]);

  if (!data.length) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/50">
        <span className="text-xs text-[var(--color-text-muted)]">No data</span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
      <h4 className="mb-2 text-xs font-semibold text-[var(--color-text)]">Tier A & Tier B Orders — Late Share</h4>
      <ResponsiveContainer width="100%" height={220}>
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
            label={{ value: "min", angle: 90, position: "insideRight", style: { fontSize: 9, fill: "var(--color-text-muted)" } }}
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

function WeightPerfTable({ rows }: { rows: WeightPerfRow[] }) {
  const { groups, vehicleTypes, lookup } = useMemo(() => {
    const groupSet = new Set<string>();
    const vtSet = new Set<string>();
    const buckets = new Map<string, WeightPerfRow[]>();

    for (const r of rows) {
      groupSet.add(r.capability_group);
      vtSet.add(r.vehicle_type);
      const key = `${r.capability_group}|${r.vehicle_type}`;
      const arr = buckets.get(key) ?? [];
      arr.push(r);
      buckets.set(key, arr);
    }

    const groups = [...groupSet].sort();
    const vehicleTypes = [...vtSet].sort();
    const lookup = new Map<string, WeightPerfRow>();

    for (const [key, items] of buckets) {
      const totalDropoff = items.reduce((s, r) => s + r.dropoff_count, 0);
      const avgCloned = items.reduce((s, r) => s + r.cloned_pct, 0) / items.length;
      const accNums = items.filter((r) => r.acceptance_rate != null);
      const avgAcc = accNums.length > 0
        ? accNums.reduce((s, r) => s + (r.acceptance_rate ?? 0), 0) / accNums.length
        : null;
      const ttlaNums = items.filter((r) => r.avg_ttla_sec != null);
      const avgTtla = ttlaNums.length > 0
        ? ttlaNums.reduce((s, r) => s + (r.avg_ttla_sec ?? 0), 0) / ttlaNums.length
        : null;

      lookup.set(key, {
        confirmed_date: "",
        capability_group: items[0].capability_group,
        vehicle_type: items[0].vehicle_type,
        dropoff_count: totalDropoff,
        cloned_pct: Math.round(avgCloned * 10) / 10,
        acceptance_rate: avgAcc,
        avg_ttla_sec: avgTtla != null ? Math.round(avgTtla) : null,
      });
    }

    return { groups, vehicleTypes, lookup };
  }, [rows]);

  if (!rows.length) return null;

  const fmt = (v: number | null | undefined) => {
    if (v == null) return "—";
    return Number(v).toFixed(1);
  };

  const pct = (v: number | null | undefined) => {
    if (v == null) return "—";
    return `${(Number(v) * 100).toFixed(1)}%`;
  };

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3 lg:col-span-2">
      <h4 className="mb-3 text-xs font-semibold text-[var(--color-text)]">
        Performance Metrics by Weight Capability & Vehicle Type
      </h4>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] text-[var(--color-text)]">
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <th className="px-2 py-1.5 text-left font-semibold">Vehicle</th>
              {groups.map((g) => (
                <th
                  key={g}
                  className="px-2 py-1.5 text-center font-semibold border-l border-[var(--color-border)]"
                  colSpan={4}
                >
                  {g}
                </th>
              ))}
            </tr>
            <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
              <th />
              {groups.map((g) => (
                <Fragment key={g}>
                  <th className="px-1 py-1 text-center font-medium border-l border-[var(--color-border)]">
                    Tasks
                  </th>
                  <th className="px-1 py-1 text-center font-medium">Redispatch%</th>
                  <th className="px-1 py-1 text-center font-medium">Accept%</th>
                  <th className="px-1 py-1 text-center font-medium">Accept latency</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {vehicleTypes.map((vt) => (
              <tr key={vt} className="border-b border-[var(--color-border)]/40 hover:bg-[var(--color-bg)]/50">
                <td className="px-2 py-1.5 font-semibold">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: getVehicleColor(vt) }}
                    />
                    {vt}
                  </div>
                </td>
                {groups.map((g) => {
                  const r = lookup.get(`${g}|${vt}`);
                  return (
                    <Fragment key={g}>
                      <td className="px-1 py-1 text-center border-l border-[var(--color-border)]">
                        {r?.dropoff_count ?? "—"}
                      </td>
                      <td className="px-1 py-1 text-center">{fmt(r?.cloned_pct)}%</td>
                      <td className="px-1 py-1 text-center">{pct(r?.acceptance_rate)}</td>
                      <td className="px-1 py-1 text-center">{fmt(r?.avg_ttla_sec)}s</td>
                    </Fragment>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CityAnalyticsCard({ cityName, data, lateReasons }: CityAnalyticsCardProps) {
  const heavyTotal = lateReasons?.heavy?.total ?? 0;
  const largeTotal = lateReasons?.large?.total ?? 0;
  const heavyFA = flagAnalysisFromBlock(lateReasons?.heavy);
  const largeFA = flagAnalysisFromBlock(lateReasons?.large);

  const hasData = data.heavy_vehicle_share.length > 0 ||
    data.large_vehicle_share.length > 0 ||
    data.split_heavy_vehicle.length > 0 ||
    data.hl_lateness.length > 0 ||
    (data.daily_rates?.length ?? 0) > 0 ||
    (data.ttla?.length ?? 0) > 0 ||
    heavyTotal > 0 ||
    largeTotal > 0;

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <div className="border-b border-[var(--color-border)] px-5 py-3">
        <h3 className="text-sm font-bold text-[var(--color-text)]">{cityName}</h3>
        {!hasData && (
          <span className="text-xs text-[var(--color-text-muted)]">No data available for this period</span>
        )}
      </div>

      {hasData && (
        <div className="grid gap-4 p-4 lg:grid-cols-2 [&>*]:min-w-0">
          <VehicleShareChart
            title="Tier A Order Share by Vehicle Type"
            rows={data.heavy_vehicle_share}
            countKey="heavy_count"
            targetLabel="Tier A"
          />
          <VehicleShareChart
            title="Tier B Order Share by Vehicle Type"
            rows={data.large_vehicle_share}
            countKey="large_count"
            targetLabel="Tier B"
          />
          <VehicleShareChart
            title="Split Order Share (Tier A Orders)"
            rows={data.split_heavy_vehicle}
            countKey="split_count"
            targetLabel="Split"
          />
          <HLLatenessChart data={data.hl_lateness} />
          {lateReasons && (
            <>
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
            </>
          )}
          <RateTrendChart
            rows={data.daily_rates ?? []}
            metric="late"
            title="Lateness Rate Over Time (excl. drive)"
          />
          <RateTrendChart
            rows={data.daily_rates ?? []}
            metric="rotten"
            title="Queue Aging Over Time (excl. drive)"
          />
          <TtlaPanel
            title="Task to Last Accept"
            subtitle="Seconds to last accept · target = country target"
            rows={data.ttla ?? []}
            targetSec={data.ttla_target_sec ?? null}
          />
          {data.weight_perf && data.weight_perf.length > 0 && (
            <WeightPerfTable rows={data.weight_perf} />
          )}
        </div>
      )}
    </div>
  );
}
