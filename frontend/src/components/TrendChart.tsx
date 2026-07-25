import { useState, useCallback, useMemo } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { LEX } from "../lib/lexicon";
import type { TrendPoint, RottenSummaryDay } from "../types";

const L = {
  jobs: LEX.metrics.totalOrders,
  breaches: LEX.metrics.breachCount,
  breachPct: LEX.metrics.slaBreachShort,
  aging: LEX.metrics.agingCount,
  agingPct: LEX.metrics.queueAgingShort,
  avgCycle: "Avg cycle (min)",
} as const;

interface TrendChartProps {
  data: TrendPoint[] | RottenSummaryDay[];
  mode: "late" | "rotten";
}

export function TrendChart({ data, mode }: TrendChartProps) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const sortedData = useMemo(
    () =>
      data
        .map((d) => {
          const row = {
            ...d,
            date: "delivered_date" in d ? d.delivered_date : "",
          };
          const total = (row as any).total_orders ?? 0;
          if (mode === "late") {
            const late = (row as any).late_orders_sla ?? 0;
            (row as any).late_pct = total > 0 ? Math.round((late / total) * 1000) / 10 : 0;
          } else {
            const rotten = (row as any).rotten_count ?? 0;
            (row as any).rotten_pct = total > 0 ? Math.round((rotten / total) * 1000) / 10 : 0;
          }
          return row;
        })
        .sort((a, b) => a.date.localeCompare(b.date)),
    [data, mode],
  );

  const lateHiddenKeys: Record<string, string> = {
    [L.jobs]: "total_orders",
    [L.breaches]: "late_orders_sla",
    [L.avgCycle]: "avg_completion_min",
    [L.breachPct]: "late_pct",
  };
  const rottenHiddenKeys: Record<string, string> = {
    [L.jobs]: "total_orders",
    [L.aging]: "rotten_count",
    [L.breaches]: "late_count",
    [L.agingPct]: "rotten_pct",
  };

  const chartData = useMemo(() => {
    const keyMap = mode === "late" ? lateHiddenKeys : rottenHiddenKeys;
    const nullKeys = Object.entries(keyMap)
      .filter(([name]) => hidden.has(name))
      .map(([, key]) => key);
    if (!nullKeys.length) return sortedData;
    return sortedData.map((row) => {
      const copy = { ...row } as any;
      for (const k of nullKeys) copy[k] = undefined;
      return copy;
    });
  }, [sortedData, hidden, mode]);

  const handleLegendClick2 = useCallback((entry: any) => {
    const name = entry?.value;
    if (!name) return;
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const lateLegend = [
    { value: L.jobs, type: "rect" as const, color: "var(--color-border)" },
    { value: L.breaches, type: "rect" as const, color: "var(--color-danger)" },
    { value: L.avgCycle, type: "line" as const, color: "var(--color-warning)" },
    { value: L.breachPct, type: "line" as const, color: "#a78bfa" },
  ];

  const rottenLegend = [
    { value: L.jobs, type: "rect" as const, color: "var(--color-border)" },
    { value: L.aging, type: "rect" as const, color: "var(--color-danger)" },
    { value: L.breaches, type: "rect" as const, color: "var(--color-warning)" },
    { value: L.agingPct, type: "line" as const, color: "#a78bfa" },
  ];

  if (!data.length) {
    return (
      <div className="flex h-72 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-sm text-[var(--color-text-muted)]">
        No trend data available
      </div>
    );
  }

  const pctKey = mode === "late" ? "late_pct" : "rotten_pct";
  const pctLabel = mode === "late" ? L.breachPct : L.agingPct;
  const pctValues = sortedData.map((d) => (d as any)[pctKey] ?? 0).filter((v: number) => v > 0);
  const maxPct = pctValues.length > 0 ? Math.ceil(Math.max(...pctValues) * 1.2) : 10;

  return (
    <div className="flex flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <h3 className="mb-4 text-sm font-semibold text-[var(--color-text)]">
        {mode === "late" ? LEX.metrics.slaTrend : LEX.metrics.agingTrend}
      </h3>
      <ResponsiveContainer width="100%" height="100%" minHeight={280}>
        <ComposedChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis
            dataKey="date"
            tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis
            yAxisId="left"
            tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fill: "#a78bfa", fontSize: 11 }}
            domain={[0, maxPct]}
            tickFormatter={(v: number) => `${v}%`}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--color-tooltip-bg)",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              color: "var(--color-tooltip-text)",
              fontSize: 12,
            }}
            labelStyle={{ color: "var(--color-text)" }}
            itemStyle={{ color: "var(--color-text)" }}
            formatter={(value, name) => {
              const label = String(name);
              const numericValue = Number(value ?? 0);
              if (label === pctLabel) return [`${numericValue}%`, label];
              return [numericValue, label];
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, cursor: "pointer" }}
            onClick={handleLegendClick2}
            {...{ payload: mode === "late" ? lateLegend : rottenLegend } as any}
            formatter={(value: string) => (
              <span style={{ opacity: hidden.has(value) ? 0.3 : 1 }}>{value}</span>
            )}
          />
          {mode === "late" ? (
            <>
              <Bar
                dataKey="total_orders"
                name={L.jobs}
                fill="var(--color-border)"
                radius={[3, 3, 0, 0]}
                opacity={hidden.has(L.jobs) ? 0 : 0.5}
                yAxisId="left"
              />
              <Bar
                dataKey="late_orders_sla"
                name={L.breaches}
                fill="var(--color-danger)"
                radius={[3, 3, 0, 0]}
                opacity={hidden.has(L.breaches) ? 0 : 1}
                yAxisId="left"
              />
              <Line
                dataKey="avg_completion_min"
                name={L.avgCycle}
                stroke="var(--color-warning)"
                strokeWidth={2}
                dot={false}
                yAxisId="left"
                strokeOpacity={hidden.has(L.avgCycle) ? 0 : 1}
              />
              <Line
                dataKey="late_pct"
                name={L.breachPct}
                stroke="#a78bfa"
                strokeWidth={2}
                dot={{ r: 3, fill: "#a78bfa", strokeWidth: 0 }}
                activeDot={{ r: 5, fill: "#a78bfa", stroke: "#fff", strokeWidth: 2 }}
                yAxisId="right"
                strokeOpacity={hidden.has(L.breachPct) ? 0 : 1}
              />
            </>
          ) : (
            <>
              <Bar
                dataKey="total_orders"
                name={L.jobs}
                fill="var(--color-border)"
                radius={[3, 3, 0, 0]}
                opacity={hidden.has(L.jobs) ? 0 : 0.5}
                yAxisId="left"
              />
              <Bar
                dataKey="rotten_count"
                name={L.aging}
                fill="var(--color-danger)"
                radius={[3, 3, 0, 0]}
                opacity={hidden.has(L.aging) ? 0 : 1}
                yAxisId="left"
              />
              <Bar
                dataKey="late_count"
                name={L.breaches}
                fill="var(--color-warning)"
                radius={[3, 3, 0, 0]}
                opacity={hidden.has(L.breaches) ? 0 : 1}
                yAxisId="left"
              />
              <Line
                dataKey="rotten_pct"
                name={L.agingPct}
                stroke="#a78bfa"
                strokeWidth={2}
                dot={{ r: 3, fill: "#a78bfa", strokeWidth: 0 }}
                activeDot={{ r: 5, fill: "#a78bfa", stroke: "#fff", strokeWidth: 2 }}
                yAxisId="right"
                strokeOpacity={hidden.has(L.agingPct) ? 0 : 1}
              />
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
