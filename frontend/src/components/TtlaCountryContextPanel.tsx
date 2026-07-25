import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Globe2, Timer, PieChart, TrendingUp } from "lucide-react";
import { useViewFreshness } from "../hooks/useViewFreshness";
import { StaleDataBanner, PollRetryHint } from "./StaleDataBanner";
import { fetchTtlaCountryContext, fetchTtlaViewFreshness } from "../api/client";
import type { TtlaCountryContext, TtlaGlobalFilters, TtlaQuery } from "../types";

function fmtSec(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Math.round(v).toLocaleString()} s`;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

// Signed seconds (city impact).
function fmtDeltaSec(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  const r = Math.round(v);
  return `${r > 0 ? "+" : ""}${r.toLocaleString()} s`;
}

function KpiCard({
  icon: Icon,
  label,
  value,
  valueClass,
  sub,
}: {
  icon: typeof Timer;
  label: string;
  value: string;
  valueClass?: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <Icon size={18} className="mt-0.5 shrink-0 text-teal-500" />
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{label}</div>
        <div className={`text-2xl font-bold tabular-nums ${valueClass ?? "text-[var(--color-text)]"}`}>{value}</div>
        {sub != null && <div className="mt-0.5 text-[11px] leading-tight text-[var(--color-text-muted)]">{sub}</div>}
      </div>
    </div>
  );
}

function periodLabel(g: TtlaGlobalFilters): string {
  if (g.dateFrom && g.dateTo) return `${g.dateFrom} → ${g.dateTo}`;
  if (g.completeWeeks) return `last ${g.completeWeeks} complete week${g.completeWeeks === 1 ? "" : "s"}`;
  return `last ${g.lookbackDays} days`;
}

// Country Accept latency context — the panel above Venue Accept latency & unassign. Shows the whole
// country's order-weighted Accept latency for the chosen period + order type, how far it is
// off the target, and how much the selected city influences it (order-volume share
// + leave-one-out impact in seconds). Same population as the Orders/Venues/Couriers
// panels; owns its own serve-stale freshness scope.
export function TtlaCountryContextPanel({
  global,
  refreshSignal,
}: {
  global: TtlaGlobalFilters;
  refreshSignal: number;
}) {
  const query = useMemo<TtlaQuery>(
    () => ({
      city: global.city,
      lookbackDays: global.lookbackDays,
      completeWeeks: global.completeWeeks,
      dateFrom: global.dateFrom,
      dateTo: global.dateTo,
      orderType: global.orderType,
      ttlaMode: global.ttlaMode,
      deliveryCounts: global.deliveryCounts,
    }),
    [global.city, global.lookbackDays, global.completeWeeks, global.dateFrom, global.dateTo, global.orderType, global.ttlaMode, global.deliveryCounts],
  );
  const periodKey =
    global.dateFrom && global.dateTo
      ? `${global.dateFrom}_${global.dateTo}`
      : global.completeWeeks
      ? `${global.completeWeeks}w`
      : `${global.lookbackDays}d`;

  const [ctx, setCtx] = useState<TtlaCountryContext | null>(null);

  const loadData = useCallback(() => {
    fetchTtlaCountryContext(query)
      .then(setCtx)
      .catch(() => setCtx(null));
  }, [query]);

  const probe = useCallback((force?: boolean) => fetchTtlaViewFreshness(query, "context", force), [query]);
  const reloadData = useCallback((_silent: boolean) => { loadData(); }, [loadData]);
  const { freshness, pollError, retry, signIn, signingIn } = useViewFreshness({
    key: `ttla-context:${global.city}:${periodKey}:${global.orderType}:${global.ttlaMode ?? "default"}:${(global.deliveryCounts ?? []).slice().sort((a, b) => a - b).join("-") || "all"}`,
    probe,
    reloadData,
  });

  // "Refresh all" nonce → force-refresh (skip initial render).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    retry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  const target = ctx?.ttla_target_sec ?? null;
  const countryAvg = ctx?.country_avg_sec ?? null;
  const cityAvg = ctx?.city_avg_sec ?? null;
  // The tab is segmented by order type (Regular default / Drive), but the target
  // is a single ALL-order-types figure (matches the Region tab). So we show this
  // segment's Accept latency WITHOUT target coloring / an off-target score — comparing a
  // single segment to the overall target would be misleading (e.g. R1 Regular
  // ~147 s looks "under" the 174 s target while the overall metric is ~186 s).
  const segLabel = global.orderType === "drive" ? "Drive" : "Regular";
  const orderTypeLabel =
    global.orderType === "drive" ? "Express-route jobs" : "sample platform orders (Drive excluded)";

  return (
    <section className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/40 p-4">
      <div className="flex items-center gap-2">
        <Globe2 size={18} className="text-teal-500" />
        <div>
          <h2 className="text-base font-semibold text-[var(--color-text)]">
            Country Accept latency context{ctx?.country_name ? ` — ${ctx.country_name}` : ""}
          </h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            Order-weighted Task-to-Last-Accept across all cities of the country for {orderTypeLabel}; {periodLabel(global)}.
            {ctx ? ` ${ctx.city} is 1 of ${ctx.city_count.toLocaleString()} cities.` : ""}
          </p>
        </div>
      </div>

      {freshness && (
        <StaleDataBanner summary={freshness} onSignIn={signIn} signingIn={signingIn} onRetry={retry} />
      )}
      {pollError && <PollRetryHint onRetry={retry} />}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          icon={Timer}
          label={`${ctx?.country_name ?? "Country"} Accept latency · ${segLabel}`}
          value={fmtSec(countryAvg)}
          sub={`${(ctx?.country_order_count ?? 0).toLocaleString()} orders`}
        />
        <KpiCard
          icon={Timer}
          label={`${ctx?.city ?? "City"} Accept latency · ${segLabel}`}
          value={fmtSec(cityAvg)}
          sub={`${(ctx?.city_order_count ?? 0).toLocaleString()} orders`}
        />
        <KpiCard
          icon={PieChart}
          label={`${ctx?.city ?? "City"} share of country`}
          value={fmtPct(ctx?.influence_pct)}
          sub="of the country's Accept latency orders (its weight in the average)"
        />
        <KpiCard
          icon={TrendingUp}
          label={`${ctx?.city ?? "City"} impact on country Accept latency`}
          value={fmtDeltaSec(ctx?.impact_sec)}
          valueClass={
            ctx?.impact_sec == null
              ? undefined
              : ctx.impact_sec > 0
              ? "text-red-400"
              : "text-emerald-400"
          }
          sub={
            ctx?.rest_avg_sec != null
              ? `country would be ${fmtSec(ctx.rest_avg_sec)} without ${ctx.city}`
              : "leave-one-out effect on the country average"
          }
        />
      </div>

      <p className="text-[11px] leading-snug text-[var(--color-text-muted)]">
        {target != null ? (
          <>
            {ctx?.country_name ?? "This country"}'s Accept latency target is <b>{fmtSec(target)}</b> — an{" "}
            <b>all-order-types</b> figure (the same basis as the Region tab, which mixes Drive + Regular).
            The values above are <b>{segLabel} orders only</b>, so they are <b>not</b> directly comparable to
            the target; switch the Order type filter to compare each segment on its own.
          </>
        ) : (
          <>No Accept latency target is configured for this country. Values above are {segLabel} orders only.</>
        )}
      </p>
    </section>
  );
}
