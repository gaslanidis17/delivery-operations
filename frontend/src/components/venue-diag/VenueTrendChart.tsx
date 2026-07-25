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
import { CalendarDays, TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { VenueDiagDailyPack } from "../../types";
import { SectionHeader } from "./SectionHeader";
import { ChartTooltip } from "./ChartTooltip";

// Daily Accept latency trend as a chart (replaces the old "Trend: spike · worsening" text
// + worst-days list). Mirrors the Accept latency tab's TtlaPanel: dates on X, faint order
// bars on the left Y, the avg-Accept latency line on the right Y, hover shows both. Bad
// days (avg Accept latency >= 1.5x the venue mean) are marked with red dots and the venue
// mean is a dashed reference line, so "spike vs recurring vs stable" is visual.

const ACCEPT_LATENCY_COLOR = "#14b8a6";
const ORDERS_COLOR = "#64748b";
const BAD_COLOR = "#ef4444";
const BAD_THRESHOLD = 1.5;

function fmtSec(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Math.round(v).toLocaleString()} s`;
}

function trendMeta(trend: string): { label: string; Icon: typeof TrendingUp; cls: string } {
  switch (trend) {
    case "improving":
      return { label: "improving", Icon: TrendingUp, cls: "text-emerald-400" };
    case "worsening":
      return { label: "worsening", Icon: TrendingDown, cls: "text-red-400" };
    default:
      return { label: "stable", Icon: Minus, cls: "text-[var(--color-text-muted)]" };
  }
}

function classificationExplainer(c: string): string {
  switch (c) {
    case "spike":
      return "Spike: a few days clearly worse than the venue's typical Accept latency (>= 1.5x its mean), but most days are fine.";
    case "recurring":
      return "Recurring: bad days are common (more than ~20% of eligible days), so this is a steady pattern, not a one-off.";
    case "stable":
      return "Stable: no day stands out as a spike — Accept latency is consistent across the window.";
    case "insufficient":
      return "Insufficient: too few days with enough orders to call a trend.";
    default:
      return c;
  }
}

export function VenueTrendChart({ daily }: { daily: VenueDiagDailyPack }) {
  const { chartData, mean } = useMemo(() => {
    const m = daily.venue_avg_ttla_sec ?? null;
    const data = daily.days.map((d) => ({
      date: d.date,
      orders: d.order_count,
      ttla_sec: d.avg_ttla_sec,
      bad_ttla: m != null && d.avg_ttla_sec != null && d.avg_ttla_sec >= m * BAD_THRESHOLD ? d.avg_ttla_sec : null,
    }));
    return { chartData: data, mean: m };
  }, [daily]);

  const { Icon, label: trendLabel, cls: trendCls } = trendMeta(daily.trend);
  const classification = daily.classification;
  const headline = `Trend: ${trendLabel} · ${classification}${daily.bad_day_count > 0 ? ` (${daily.bad_day_count} bad day${daily.bad_day_count === 1 ? "" : "s"})` : ""}`;

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <SectionHeader
        icon={CalendarDays}
        title="Daily Accept latency trend"
        subtitle={
          <span className={`inline-flex items-center gap-1 ${trendCls}`}>
            <Icon size={11} /> {headline}
          </span>
        }
        explainer={
          <>
            Each point is one day&rsquo;s order-weighted average Accept latency (seconds before a courier
            accepted). The faint bars are order volume; the teal line is avg Accept latency. Red dots mark
            <strong> bad days</strong> (avg Accept latency ≥ 1.5× this venue&rsquo;s mean); the dashed line is
            the venue mean.
            <br />
            <br />
            {classificationExplainer(classification)}
          </>
        }
      />

      {chartData.length === 0 ? (
        <div className="flex h-[180px] items-center justify-center text-xs text-[var(--color-text-muted)]">
          No daily data in this window.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 9, fill: "var(--color-text-muted)" }}
              tickFormatter={(v) => String(v).slice(5)}
              minTickGap={20}
            />
            <YAxis yAxisId="left" tick={{ fontSize: 9, fill: "var(--color-text-muted)" }} />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 9, fill: "var(--color-text-muted)" }}
              tickFormatter={(v) => `${v}s`}
            />
            {mean != null && (
              <ReferenceLine
                yAxisId="right"
                y={mean}
                stroke={ORDERS_COLOR}
                strokeDasharray="4 3"
                strokeOpacity={0.6}
                label={{ value: "avg", position: "insideTopRight", style: { fontSize: 9, fill: "var(--color-text-muted)" } }}
              />
            )}
            <Tooltip
              wrapperStyle={{ zIndex: 50 }}
              content={
                <ChartTooltip
                  titleKey="date"
                  titleFormat={(v) => String(v)}
                  rows={[
                    { dataKey: "ttla_sec", label: "Avg Accept latency", format: (v) => fmtSec(v) },
                    { dataKey: "orders", label: "Orders", format: (v) => Number(v).toLocaleString() },
                  ]}
                />
              }
            />
            <Bar yAxisId="left" dataKey="orders" name="Orders" fill={ORDERS_COLOR} fillOpacity={0.35} radius={[2, 2, 0, 0]} />
            <Line yAxisId="right" dataKey="ttla_sec" name="Accept latency" stroke={ACCEPT_LATENCY_COLOR} strokeWidth={2} dot={false} connectNulls />
            <Line
              yAxisId="right"
              dataKey="bad_ttla"
              name="Bad day"
              stroke="none"
              dot={{ r: 3.5, fill: BAD_COLOR, stroke: BAD_COLOR }}
              connectNulls={false}
              isAnimationActive={false}
              legendType="none"
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
