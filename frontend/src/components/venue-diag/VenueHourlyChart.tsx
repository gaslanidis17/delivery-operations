import { useMemo } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceArea,
} from "recharts";
import { Clock } from "lucide-react";
import type { VenueDiagHourlyPack, VenueDiagLocationPack } from "../../types";
import { SectionHeader } from "./SectionHeader";
import { ChartTooltip } from "./ChartTooltip";

// "Slowest handovers by hour of day" — replaces the old worst-hours text list.
// Vertical bars: X = local hour (0-23), Y = avg Accept latency (sec). The slowest hours
// are red, normal hours teal, low-volume hours dimmed; hover shows order count
// + reassignment rate. The parsed open->close envelope is drawn as a shaded
// vertical band (open→close span on X) so a near-close cluster is visible.

const ACCEPT_LATENCY_COLOR = "#14b8a6";
const BAD_COLOR = "#ef4444";
const DIM_COLOR = "#334155";
const ENVELOPE_COLOR = "#14b8a6";
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21];

function pad(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}
function fmtSec(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Math.round(v).toLocaleString()} s`;
}
function fmtPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export function VenueHourlyChart({
  hourly,
  location,
}: {
  hourly: VenueDiagHourlyPack;
  location?: VenueDiagLocationPack | null;
}) {
  const { chartData, worstSet } = useMemo(() => {
    const worst = new Set((hourly.worst_hours ?? []).map((h) => h.hour));
    const data = hourly.hours
      .slice()
      .sort((a, b) => a.hour - b.hour)
      .map((h) => ({
        hour: h.hour,
        ttla_sec: h.avg_ttla_sec,
        orders: h.order_count,
        unassign_rate: h.unassign_rate,
        low_volume: h.low_volume,
        worst: worst.has(h.hour),
      }));
    return { chartData: data, worstSet: worst };
  }, [hourly]);

  const oh = location?.open_hour ?? null;
  const ch = location?.close_hour ?? null;
  const hasEnvelope = oh != null && ch != null && oh !== ch;
  const crossesMidnight = hasEnvelope && (ch as number) < (oh as number);
  // Two bands when the envelope crosses midnight: [open,23] and [0,close] on the X axis.
  const band1 = hasEnvelope ? { x1: oh as number, x2: crossesMidnight ? 23 : (ch as number) } : null;
  const band2 = crossesMidnight ? { x1: 0, x2: ch as number } : null;

  const worstHours = [...worstSet].sort((a, b) => a - b);
  const headline =
    worstHours.length > 3
      ? `Slowest handovers ${pad(worstHours[0])}–${pad((worstHours[worstHours.length - 1] + 1) % 24)}`
      : worstHours.length > 0
        ? `Slowest handovers at ${worstHours.map(pad).join(", ")}`
        : "No hour meets the volume floor";

  function barFill(d: (typeof chartData)[number]): string {
    if (d.worst) return BAD_COLOR;
    if (d.low_volume) return DIM_COLOR;
    return ACCEPT_LATENCY_COLOR;
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 min-w-0">
      <SectionHeader
        icon={Clock}
        title="Slowest handovers by hour of day"
        subtitle={
          <>
            {headline}
            {hasEnvelope && (
              <span className="text-[var(--color-text-muted)]"> · open {pad(oh as number)}–{pad(ch as number)}</span>
            )}
          </>
        }
        explainer={
          <>
            Each bar is one local hour on the X axis; its height is the avg Accept latency (seconds before a
            courier accepted). <strong>Red bars</strong> are the venue&rsquo;s slowest hours; dim
            bars are low-volume (few orders, treat as noise). Hover a bar for its order count and
            reassignment rate. The shaded vertical band is the venue&rsquo;s parsed opening hours
            (open→close) — bars rising near its right edge (closing) hint at staff winding down.
          </>
        }
      />

      {chartData.length === 0 ? (
        <div className="flex h-[220px] items-center justify-center text-xs text-[var(--color-text-muted)]">
          No hourly data in this window.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chartData} barSize={10} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis
              type="number"
              dataKey="hour"
              domain={[0, 23]}
              ticks={HOUR_TICKS}
              tick={{ fontSize: 9, fill: "var(--color-text-muted)" }}
              tickFormatter={(h) => pad(Number(h))}
            />
            <YAxis
              type="number"
              tick={{ fontSize: 9, fill: "var(--color-text-muted)" }}
              tickFormatter={(v) => `${v}s`}
            />
            {band1 && (
              <ReferenceArea
                xAxisId={0}
                x1={band1.x1}
                x2={band1.x2}
                fill={ENVELOPE_COLOR}
                fillOpacity={0.08}
                strokeOpacity={0}
              />
            )}
            {band2 && (
              <ReferenceArea
                xAxisId={0}
                x1={band2.x1}
                x2={band2.x2}
                fill={ENVELOPE_COLOR}
                fillOpacity={0.08}
                strokeOpacity={0}
              />
            )}
            <Tooltip
              wrapperStyle={{ zIndex: 50 }}
              content={
                <ChartTooltip
                  titleKey="hour"
                  titleFormat={(v) => pad(Number(v))}
                  rows={[
                    { dataKey: "ttla_sec", label: "Avg Accept latency", format: (v) => fmtSec(v) },
                    { dataKey: "orders", label: "Orders", format: (v) => Number(v).toLocaleString() },
                    { dataKey: "unassign_rate", label: "Reassignment rate", format: (v) => fmtPct(v) },
                  ]}
                />
              }
            />
            <Bar dataKey="ttla_sec" name="Avg Accept latency" radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {chartData.map((d) => (
                <Cell key={d.hour} fill={barFill(d)} fillOpacity={d.low_volume ? 0.35 : 0.9} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
