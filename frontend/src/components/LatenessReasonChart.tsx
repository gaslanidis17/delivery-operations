import { LEX } from "../lib/lexicon";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  LabelList,
} from "recharts";
import type { FlagAnalysis } from "../types";

interface LatenessReasonChartProps {
  flagAnalysis: FlagAnalysis | null;
  /** Overrides the default panel heading. */
  title?: string;
  /** Overrides the default sub-heading line. */
  subtitle?: string;
  /**
   * Denominator for "% of late orders". When provided (together with showPct),
   * each bar is labelled with its count and that share. Leaving it undefined
   * keeps the original Late-tab rendering (bars + tooltip only) unchanged.
   */
  total?: number;
  showPct?: boolean;
}

const COLORS = [
  "#ef4444", "#f59e0b", "#f97316", "#8b5cf6",
  "#3b82f6", "#06b6d4", "#10b981", "#ec4899",
];

export function LatenessReasonChart({
  flagAnalysis,
  title,
  subtitle,
  total,
  showPct = false,
}: LatenessReasonChartProps) {
  const heading = title ?? LEX.metrics.reasonHeading;
  const sub =
    subtitle ?? "One order can appear in multiple bars — totals exceed order count";

  if (!flagAnalysis) {
    return (
      <div className="flex h-72 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-sm text-[var(--color-text-muted)]">
        Loading lateness reasons…
      </div>
    );
  }

  // Tier A/large reason panels pass an explicit total; when it is zero there are
  // no qualifying late orders, so a chart of all-zero bars would be misleading.
  if (showPct && total === 0) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <h3 className="mb-1 text-sm font-semibold text-[var(--color-text)]">{heading}</h3>
        <p className="mb-4 text-xs text-[var(--color-text-muted)]">{sub}</p>
        <div className="flex h-48 items-center justify-center text-sm text-[var(--color-text-muted)]">
          No qualifying late orders in this window
        </div>
      </div>
    );
  }

  const chartData = Object.entries(flagAnalysis.flag_counts)
    .map(([flag, count]) => ({
      flag,
      label: flagAnalysis.flag_labels[flag] || flag,
      count,
    }))
    .sort((a, b) => b.count - a.count);

  const showLabels = total != null;
  // `value` is typed loosely to satisfy both recharts' Tooltip Formatter and
  // LabelList LabelFormatter signatures (which pass string | number).
  const renderLabel = (value: any): string => {
    const n = typeof value === "number" ? value : Number(value) || 0;
    if (showPct && total) {
      const pct = Math.round((n / total) * 1000) / 10;
      return `${n} (${pct}%)`;
    }
    return `${n}`;
  };

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <h3 className="mb-1 text-sm font-semibold text-[var(--color-text)]">{heading}</h3>
      <p className="mb-4 text-xs text-[var(--color-text-muted)]">{sub}</p>
      <ResponsiveContainer width="100%" height={Math.max(280, chartData.length * 30 + 20)}>
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ top: 0, right: showLabels ? 70 : 20, bottom: 0, left: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
          <XAxis type="number" tick={{ fill: "var(--color-text-muted)", fontSize: 11 }} />
          <YAxis
            dataKey="label"
            type="category"
            tick={{ fill: "var(--color-text-muted)", fontSize: 10 }}
            width={115}
            interval={0}
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
            formatter={(value: any) => [renderLabel(value), "Orders"]}
          />
          <Bar dataKey="count" name="Orders" radius={[0, 4, 4, 0]}>
            {chartData.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
            {showLabels && (
              <LabelList
                dataKey="count"
                position="right"
                formatter={renderLabel}
                style={{ fill: "var(--color-text-muted)", fontSize: 10 }}
              />
            )}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
