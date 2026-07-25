import { useCallback, useMemo, useState } from "react";
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
import type { CountryRateRow } from "../types";

interface Props {
  rows: CountryRateRow[];
  metric: "late" | "rotten";
  title: string;
}

const METRIC_CONFIG = {
  late: {
    rateName: "Lateness Rate",
    rateColor: "#ef4444",
    countField: "late_count" as const,
    detailLabel: "late",
  },
  rotten: {
    rateName: "Queue Aging Rate",
    rateColor: "#a855f7",
    countField: "rotten_count" as const,
    detailLabel: "rotten",
  },
};

const ORDERS_NAME = "Total Orders";
const ORDERS_COLOR = "#64748b";

export function RateTrendChart({ rows, metric, title }: Props) {
  const cfg = METRIC_CONFIG[metric];
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
      rows.map((d) => {
        const count = d[cfg.countField];
        return {
          date: d.confirmed_date,
          total_orders: d.total_orders,
          rate_pct: d.total_orders > 0 ? Math.round((count / d.total_orders) * 1000) / 10 : 0,
          _count: count,
          _total_orders: d.total_orders,
        };
      }),
    [rows, cfg.countField]
  );

  const keyMap: Record<string, string> = {
    [ORDERS_NAME]: "total_orders",
    [cfg.rateName]: "rate_pct",
  };

  const chartData = useMemo(() => {
    const nullKeys = Object.entries(keyMap)
      .filter(([name]) => hidden.has(name))
      .map(([, key]) => key);
    if (!nullKeys.length) return rawChartData;
    return rawChartData.map((row) => {
      const copy = { ...row } as any;
      for (const k of nullKeys) copy[k] = undefined;
      return copy;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawChartData, hidden]);

  if (!rows.length) {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
        <h4 className="mb-2 text-xs font-semibold text-[var(--color-text)]">{title}</h4>
        <div className="flex h-[200px] items-center justify-center text-xs text-[var(--color-text-muted)]">
          No data
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
      <h4 className="mb-2 text-xs font-semibold text-[var(--color-text)]">{title}</h4>
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
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 9, fill: "var(--color-text-muted)" }}
            tickFormatter={(v) => `${v}%`}
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
                    let display: string;
                    let detail = "";
                    if (item.dataKey === "rate_pct" && row) {
                      display = `${item.value}%`;
                      detail = ` (${row._count} of ${row._total_orders})`;
                    } else {
                      display = Number(item.value).toLocaleString();
                    }
                    return (
                      <div key={item.dataKey} style={{ display: "flex", alignItems: "center", gap: 6, padding: "1px 0" }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: item.color, flexShrink: 0 }} />
                        <span style={{ color: "var(--color-text)" }}>
                          {item.name}: {display}
                          {detail && <span style={{ color: "var(--color-text-muted)" }}>{detail}</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 10, cursor: "pointer" }}
            onClick={handleLegendClick}
            {...{ payload: [
              { value: ORDERS_NAME, type: "rect", color: ORDERS_COLOR },
              { value: cfg.rateName, type: "line", color: cfg.rateColor },
            ] } as any}
            formatter={(value: string) => (
              <span style={{ opacity: hidden.has(value) ? 0.3 : 1 }}>{value}</span>
            )}
          />
          <Bar
            yAxisId="left"
            dataKey="total_orders"
            name={ORDERS_NAME}
            fill={ORDERS_COLOR}
            fillOpacity={0.45}
            radius={[2, 2, 0, 0]}
            hide={hidden.has(ORDERS_NAME)}
          />
          <Line
            yAxisId="right"
            dataKey="rate_pct"
            name={cfg.rateName}
            stroke={cfg.rateColor}
            strokeWidth={2}
            dot={false}
            strokeOpacity={hidden.has(cfg.rateName) ? 0 : 1}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
