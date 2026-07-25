import { LEX } from "../lib/lexicon";
import { formatNumber, formatPct, formatMinutes } from "../lib/utils";
import { TrendingDown, TrendingUp, Clock, AlertTriangle, Package, Timer } from "lucide-react";
import type { LateSummary, RottenSummaryDay } from "../types";

interface KPICardsProps {
  summary?: LateSummary | null;
  rottenSummary?: RottenSummaryDay[];
  mode: "late" | "rotten";
  sizeLabel?: string;
}

interface CardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ReactNode;
  color: string;
}

function Card({ title, value, subtitle, icon, color }: CardProps) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-[var(--color-text-muted)]">{title}</p>
          <p className="mt-1 text-2xl font-bold" style={{ color }}>
            {value}
          </p>
          {subtitle && (
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {subtitle}
            </p>
          )}
        </div>
        <div
          className="flex h-10 w-10 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${color}18` }}
        >
          {icon}
        </div>
      </div>
    </div>
  );
}

export function KPICards({ summary, rottenSummary, mode, sizeLabel }: KPICardsProps) {
  if (mode === "late" && summary) {
    const filterNote = sizeLabel ? ` (${sizeLabel} only)` : "";
    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card
          title={sizeLabel ? `SLA breach (${sizeLabel})` : "SLA breach count"}
          value={formatNumber(summary.late_orders)}
          subtitle={`out of ${formatNumber(summary.total_orders)} completed jobs`}
          icon={<AlertTriangle size={20} color="var(--color-danger)" />}
          color="var(--color-danger)"
        />
        <Card
          title="Breach rate"
          value={formatPct(summary.late_pct)}
          subtitle={`${summary.period_start} → ${summary.period_end}`}
          icon={<TrendingUp size={20} color="var(--color-warning)" />}
          color="var(--color-warning)"
        />
        <Card
          title="Avg breach cycle"
          value={formatMinutes(summary.avg_late_completion_min)}
          subtitle={`cycle time for breached jobs${filterNote}`}
          icon={<Clock size={20} color="#f97316" />}
          color="#f97316"
        />
        <Card
          title="Avg all jobs"
          value={formatMinutes(summary.avg_completion_min)}
          subtitle="overall cycle time"
          icon={<Timer size={20} color="var(--color-success)" />}
          color="var(--color-success)"
        />
      </div>
    );
  }

  if (mode === "rotten" && rottenSummary && rottenSummary.length > 0) {
    const totalRotten = rottenSummary.reduce((s, d) => s + d.rotten_count, 0);
    const totalOrders = rottenSummary.reduce((s, d) => s + d.total_orders, 0);
    const totalLate = rottenSummary.reduce((s, d) => s + d.late_count, 0);
    const rottenPct = totalOrders > 0 ? (totalRotten / totalOrders) * 100 : 0;

    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card
          title={LEX.metrics.agingCount}
          value={formatNumber(totalRotten)}
          subtitle={`over ${rottenSummary.length} days`}
          icon={<Package size={20} color="var(--color-danger)" />}
          color="var(--color-danger)"
        />
        <Card
          title={LEX.metrics.agingRate}
          value={formatPct(rottenPct)}
          subtitle={`of ${formatNumber(totalOrders)} completed jobs`}
          icon={<TrendingDown size={20} color="var(--color-warning)" />}
          color="var(--color-warning)"
        />
        <Card
          title={LEX.metrics.breachCount}
          value={formatNumber(totalLate)}
          subtitle={LEX.metrics.officialBreach}
          icon={<AlertTriangle size={20} color="#f97316" />}
          color="#f97316"
        />
        <Card
          title={LEX.metrics.totalOrders}
          value={formatNumber(totalOrders)}
          subtitle="in selected period"
          icon={<Timer size={20} color="var(--color-success)" />}
          color="var(--color-success)"
        />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {[1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="h-28 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
        />
      ))}
    </div>
  );
}
