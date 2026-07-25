import { useMemo } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import type { TtlaTotalRow } from "../types";

// Accept latency (Task to Last Accept) panel — shared by the Country-tab country overview
// and each per-city card. Accept latency is an order-weighted mean in SECONDS
// (Σ ttla_sec_sum / Σ ttla_order_count), so we aggregate by summing both fields,
// never averaging daily means. When a per-country `targetSec` is set the headline
// value is coloured against it (at/under target = good, over = bad) and the trend
// draws a dashed target reference line; with no target the value renders plain,
// so the panel works fine before targets are filled in.

interface Props {
  title: string;
  rows: TtlaTotalRow[];
  /** Per-country Accept latency target (seconds), or null/undefined when unset. */
  targetSec?: number | null;
  /** Optional small caption under the title (e.g. "vs country target"). */
  subtitle?: string;
}

const ACCEPT_LATENCY_COLOR = "#14b8a6"; // matches the Region tab's Accept latency metric color
const ORDERS_COLOR = "#64748b";

function fmtSec(v: number | null): string {
  if (v === null || Number.isNaN(v)) return "—";
  return `${Math.round(v).toLocaleString()} s`;
}

export function TtlaPanel({ title, rows, targetSec, subtitle }: Props) {
  const { chartData, value, orders } = useMemo(() => {
    let secSum = 0;
    let orderCount = 0;
    const data = rows.map((d) => {
      secSum += d.ttla_sec_sum;
      orderCount += d.ttla_order_count;
      return {
        date: d.confirmed_date,
        ttla_sec: d.ttla_order_count > 0 ? d.ttla_sec_sum / d.ttla_order_count : null,
        orders: d.ttla_order_count,
      };
    });
    return {
      chartData: data,
      value: orderCount > 0 ? secSum / orderCount : null,
      orders: orderCount,
    };
  }, [rows]);

  const hasTarget = targetSec != null && Number.isFinite(targetSec);
  // Higher Accept latency = slower to accept = bad. At/under target is good.
  const overTarget = hasTarget && value != null && value > (targetSec as number);
  const valueColor = !hasTarget || value == null
    ? "text-[var(--color-text)]"
    : overTarget
      ? "text-red-400"
      : "text-emerald-400";
  const deltaSec = hasTarget && value != null ? value - (targetSec as number) : null;

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div>
          <h4 className="text-xs font-semibold text-[var(--color-text)]">{title}</h4>
          {subtitle && (
            <p className="text-[9px] text-[var(--color-text-muted)]">{subtitle}</p>
          )}
        </div>
        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: ACCEPT_LATENCY_COLOR }} />
      </div>

      {/* Headline value + target indicator */}
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`text-2xl font-bold tabular-nums ${valueColor}`}>{fmtSec(value)}</span>
        {value != null && (
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {orders.toLocaleString()} orders
          </span>
        )}
        {hasTarget ? (
          <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
            Target <span className="font-semibold text-[var(--color-text)]">{fmtSec(targetSec as number)}</span>
            {deltaSec != null && (
              <span className={overTarget ? "text-red-400" : "text-emerald-400"}>
                {" "}({deltaSec > 0 ? "+" : ""}{Math.round(deltaSec)}s)
              </span>
            )}
          </span>
        ) : (
          <span className="ml-auto text-[9px] italic text-[var(--color-text-muted)]">No target set</span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="flex h-[180px] items-center justify-center text-xs text-[var(--color-text-muted)]">
          No data
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 9, fill: "var(--color-text-muted)" }}
              tickFormatter={(v) => String(v).slice(5)}
            />
            <YAxis yAxisId="left" tick={{ fontSize: 9, fill: "var(--color-text-muted)" }} />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 9, fill: "var(--color-text-muted)" }}
              tickFormatter={(v) => `${v}s`}
            />
            {hasTarget && (
              <ReferenceLine
                yAxisId="right"
                y={targetSec as number}
                stroke={ACCEPT_LATENCY_COLOR}
                strokeDasharray="4 3"
                strokeOpacity={0.7}
                label={{
                  value: `target ${Math.round(targetSec as number)}s`,
                  position: "insideTopRight",
                  style: { fontSize: 9, fill: "var(--color-text-muted)" },
                }}
              />
            )}
            <Tooltip
              wrapperStyle={{ zIndex: 50 }}
              position={{ y: 0 }}
              allowEscapeViewBox={{ x: false, y: true }}
              content={({ active, payload, label }: any) => {
                if (!active || !payload?.length) return null;
                const items = (payload as any[]).filter((p: any) => p.value != null);
                return (
                  <div style={{
                    backgroundColor: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 8, fontSize: 11, padding: "8px 10px",
                    boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
                  }}>
                    <div style={{ marginBottom: 4, color: "var(--color-text-muted)", fontSize: 10 }}>{label}</div>
                    {items.map((item: any) => (
                      <div key={item.dataKey} style={{ display: "flex", alignItems: "center", gap: 6, padding: "1px 0" }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: item.color, flexShrink: 0 }} />
                        <span style={{ color: "var(--color-text)" }}>
                          {item.dataKey === "ttla_sec"
                            ? `Accept latency: ${Math.round(item.value)}s`
                            : `Orders: ${Number(item.value).toLocaleString()}`}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            <Bar
              yAxisId="left"
              dataKey="orders"
              name="Orders"
              fill={ORDERS_COLOR}
              fillOpacity={0.4}
              radius={[2, 2, 0, 0]}
            />
            <Line
              yAxisId="right"
              dataKey="ttla_sec"
              name="Accept latency (s)"
              stroke={ACCEPT_LATENCY_COLOR}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
