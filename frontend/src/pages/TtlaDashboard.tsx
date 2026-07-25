import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LEX } from "../lib/lexicon";
import type { ReactNode } from "react";
import { useFilters } from "../hooks/useFilters";
import { useViewFreshness } from "../hooks/useViewFreshness";
import { StaleDataBanner, PollRetryHint } from "../components/StaleDataBanner";
import { TtlaFilterBar } from "../components/TtlaFilterBar";
import { TtlaGlobalFilterBar } from "../components/TtlaGlobalFilterBar";
import { TtlaCountryContextPanel } from "../components/TtlaCountryContextPanel";
import { VenueDiagnosticsPanel } from "../components/VenueDiagnosticsPanel";
import { RetailPanel } from "./RetailTtlaDashboard";
import {
  fetchCities,
  fetchTtlaOrders,
  fetchTtlaVenues,
  fetchTtlaCouriers,
  fetchTtlaViewFreshness,
} from "../api/client";
import type {
  CityInfo,
  TtlaOrderRow,
  TtlaVenueRow,
  TtlaCourierRow,
  TtlaQuery,
  TtlaGlobalFilters,
} from "../types";
import { Package, Store, Bike, ArrowUp, ArrowDown, Timer, X } from "lucide-react";

function PurchaseLink({ id }: { id: string }) {
  return <span className="font-mono text-xs text-[var(--color-text-muted)]">{id}</span>;
}

function fmtSec(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${Math.round(v).toLocaleString()} s`;
}

// Higher Accept latency = slower to accept = worse. At/under target = good (emerald), over =
// bad (red), no target = plain.
function ttlaColorClass(v: number | null | undefined, target?: number | null): string {
  const hasTarget = target != null && Number.isFinite(target);
  if (!hasTarget || v == null || Number.isNaN(v)) return "text-[var(--color-text)]";
  return v > (target as number) ? "text-red-400" : "text-emerald-400";
}

// Venue "impact on city avg Accept latency" = leave-one-out effect (seconds): how much the
// city's order-weighted avg Accept latency would DROP if this venue's orders were removed.
// Positive = the venue drags the city average UP (worse; a venue to work on).
function fmtImpact(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  const r = Math.round(v * 10) / 10;
  return `${r > 0 ? "+" : ""}${r.toLocaleString()} s`;
}

// Prep-estimate error: signed minutes between the venue's initial pickup ETA (its
// prep-time promise) and the actual ready time. + = ready later than promised.
function fmtErrMin(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  const r = Math.round(v * 10) / 10;
  return `${r > 0 ? "+" : ""}${r.toLocaleString()} min`;
}

// + (ready late vs promise) = worse (amber); ≤0 (early / on time) = good (emerald).
function errColorClass(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "text-[var(--color-text-muted)]";
  return v > 0 ? "text-amber-400" : "text-emerald-400";
}

// Sign-based colouring only for now (positive = worse = red). Impact-LEVEL bands
// (high/medium/low) are intentionally deferred until real thresholds are set.
function impactColorClass(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "text-[var(--color-text-muted)]";
  if (v > 0.05) return "text-red-400";
  if (v < -0.05) return "text-emerald-400";
  return "text-[var(--color-text-muted)]";
}

// Stable freshness/reload key for a panel's full filter set, so changing ANY
// filter re-scopes the panel's serve-stale probe + data fetch.
function queryKey(view: string, q: TtlaQuery): string {
  return [
    view,
    q.city,
    q.orderType ?? "regular",
    q.dateFrom && q.dateTo
      ? `${q.dateFrom}_${q.dateTo}`
      : q.completeWeeks
      ? `${q.completeWeeks}w`
      : `${q.lookbackDays}d`,
    q.sizeFilter ?? "all",
    q.venueType ?? "all",
    (q.retailVenueIds ?? []).join("+"),
    q.minTtla ?? "",
    q.vehicleType ?? "all",
    q.venueId ?? "",
    q.courierId ?? "",
    (q.inspectVenueIds ?? []).join("+"),
    (q.deliveryCounts ?? []).slice().sort((a, b) => a - b).join("-"),
    q.ttlaMode ?? "default",
  ].join(":");
}

// Merge the tab's GLOBAL filters (city / period / order type) into a panel's
// query state, seeding once from ``global`` + the panel's own ``extra`` defaults
// and re-syncing the global dims whenever they change (the panel-specific dims —
// size / venue type / min-Accept latency / vehicle — are preserved across a global change).
function usePanelQuery(global: TtlaGlobalFilters, extra: Partial<TtlaQuery>) {
  const [query, setQuery] = useState<TtlaQuery>(() => ({ ...extra, ...global }));
  const patch = useCallback((p: Partial<TtlaQuery>) => setQuery((q) => ({ ...q, ...p })), []);
  useEffect(() => {
    setQuery((q) => ({
      ...q,
      city: global.city,
      lookbackDays: global.lookbackDays,
      completeWeeks: global.completeWeeks,
      dateFrom: global.dateFrom,
      dateTo: global.dateTo,
      orderType: global.orderType,
      deliveryCounts: global.deliveryCounts,
      ttlaMode: global.ttlaMode,
    }));
  }, [global.city, global.lookbackDays, global.completeWeeks, global.dateFrom, global.dateTo, global.orderType, global.deliveryCounts, global.ttlaMode]);
  return { query, patch };
}

// Re-run a panel's force-refresh when the global "Refresh all" nonce advances
// (skips the initial render).
function useGlobalRefresh(refreshSignal: number, retry: () => void) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    retry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);
}

// Each panel shows the first COLLAPSED_COUNT rows; "Show all" expands to a paged
// view of PAGE_SIZE rows/page (client-side over the already-loaded rows).
const COLLAPSED_COUNT = 20;
const PAGE_SIZE = 100;

function usePager(total: number) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  useEffect(() => {
    if (page > pageCount - 1) setPage(0);
  }, [pageCount, page]);
  const start = expanded ? page * PAGE_SIZE : 0;
  const end = expanded ? start + PAGE_SIZE : COLLAPSED_COUNT;
  return { expanded, setExpanded, page, setPage, pageCount, start, end };
}

function PanelPager({ total, pager }: { total: number; pager: ReturnType<typeof usePager> }) {
  const { expanded, setExpanded, page, setPage, pageCount, start, end } = pager;
  if (total <= COLLAPSED_COUNT) return null;
  const shownEnd = Math.min(end, total);
  const btn =
    "h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-40";
  const btnPrimary =
    "h-7 rounded-md bg-[var(--color-primary)] px-2.5 text-xs font-medium text-white transition-colors hover:bg-[var(--color-primary-dark)]";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-3 text-xs text-[var(--color-text-muted)]">
      <span>
        Showing {(start + 1).toLocaleString()}–{shownEnd.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-2">
        {expanded && pageCount > 1 && (
          <div className="flex items-center gap-1.5">
            <button className={btn} disabled={page === 0} onClick={() => setPage(page - 1)}>
              Prev
            </button>
            <span className="tabular-nums">
              Page {page + 1} / {pageCount}
            </span>
            <button className={btn} disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        )}
        {!expanded ? (
          <button className={btnPrimary} onClick={() => setExpanded(true)}>
            Show all items
          </button>
        ) : (
          <button
            className={btn}
            onClick={() => {
              setExpanded(false);
              setPage(0);
            }}
          >
            Show less
          </button>
        )}
      </div>
    </div>
  );
}

interface SortState {
  key: string;
  dir: "asc" | "desc";
}

function useSort(defaultKey: string) {
  const [sort, setSort] = useState<SortState>({ key: defaultKey, dir: "desc" });
  const onSort = useCallback((key: string) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  }, []);
  return { sort, onSort };
}

function cmp(a: any, b: any, key: string, dir: "asc" | "desc"): number {
  const va = a[key];
  const vb = b[key];
  let r: number;
  if (typeof va === "number" || typeof vb === "number") {
    r = (va ?? -Infinity) - (vb ?? -Infinity);
  } else {
    r = String(va ?? "").localeCompare(String(vb ?? ""));
  }
  return dir === "asc" ? r : -r;
}

function SortHeader({
  label,
  colKey,
  sort,
  onSort,
  align = "left",
  tooltip,
}: {
  label: string;
  colKey: string;
  sort: SortState;
  onSort: (k: string) => void;
  align?: "left" | "right";
  tooltip?: string;
}) {
  const active = sort.key === colKey;
  return (
    <th
      onClick={() => onSort(colKey)}
      title={tooltip}
      className={`cursor-pointer select-none whitespace-nowrap px-3 py-2 text-xs font-semibold text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      <span className={`inline-flex items-center gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}>
        {label}
        {active && (sort.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </span>
    </th>
  );
}

// Small order-weighted Accept latency headline shared by all three panels.
function HeadlineKpi({
  label,
  avg,
  targetSec,
  subtitle,
}: {
  label: string;
  avg: number | null;
  targetSec: number | null;
  subtitle: string;
}) {
  const hasTarget = targetSec != null && Number.isFinite(targetSec);
  return (
    <div className="flex items-center gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
      <Timer size={18} className="text-teal-500" />
      <div>
        <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{label}</div>
        <div className="flex items-baseline gap-2">
          <span className={`text-xl font-bold tabular-nums ${ttlaColorClass(avg, targetSec)}`}>{fmtSec(avg)}</span>
          <span className="text-[11px] text-[var(--color-text-muted)]">{subtitle}</span>
        </div>
      </div>
      <div className="border-l border-[var(--color-border)] pl-3 text-[11px]">
        {hasTarget ? (
          <span className="text-[var(--color-text-muted)]">
            Target <span className="font-semibold text-[var(--color-text)]">{fmtSec(targetSec)}</span>
          </span>
        ) : (
          <span className="italic text-[var(--color-text-muted)]">No target set</span>
        )}
      </div>
    </div>
  );
}

// Chrome shared by every panel: title + headline, the panel's OWN filter bar, its
// OWN stale/refresh banner + poll-error hint, an optional notice, then the table.
function PanelFrame({
  title,
  icon: Icon,
  accent,
  headline,
  filterBar,
  freshness,
  onSignIn,
  signingIn,
  onRetry,
  pollError,
  notice,
  children,
  footer,
}: {
  title: string;
  icon: typeof Package;
  accent: string;
  headline: ReactNode;
  filterBar: ReactNode;
  freshness: ReturnType<typeof useViewFreshness>["freshness"];
  onSignIn: () => void;
  signingIn: boolean;
  onRetry: () => void;
  pollError: boolean;
  notice?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon size={18} className={accent} />
          <h2 className="text-base font-semibold text-[var(--color-text)]">{title}</h2>
        </div>
        {headline}
      </div>

      {filterBar}

      {freshness && (
        <StaleDataBanner summary={freshness} onSignIn={onSignIn} signingIn={signingIn} onRetry={onRetry} />
      )}
      {pollError && <PollRetryHint onRetry={onRetry} />}

      {notice}

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        {children}
      </div>

      {footer}
    </section>
  );
}

function EmptyRow({ span }: { span: number }) {
  return (
    <tr>
      <td colSpan={span} className="px-3 py-10 text-center text-sm text-[var(--color-text-muted)]">
        No data
      </td>
    </tr>
  );
}

// --- Orders panel -----------------------------------------------------------
function OrdersPanel({
  global,
  refreshSignal,
  cities,
  inspectVenueIds,
  onClearInspect,
}: {
  global: TtlaGlobalFilters;
  refreshSignal: number;
  cities: CityInfo[];
  inspectVenueIds: string[];
  onClearInspect: () => void;
}) {
  const { query, patch } = usePanelQuery(global, { sizeFilter: "all", venueType: "all" });

  // Sync the cross-panel inspect selection into the query (drives the server-side
  // venue-set filter). Keyed on the joined ids so identity churn doesn't refetch.
  const inspectKey = inspectVenueIds.join(",");
  useEffect(() => {
    patch({ inspectVenueIds: inspectVenueIds.length ? inspectVenueIds : null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectKey]);

  const [orders, setOrders] = useState<TtlaOrderRow[]>([]);
  const [rowLimit, setRowLimit] = useState<number>(1000);
  const [targetSec, setTargetSec] = useState<number | null>(null);
  const { sort, onSort } = useSort("ttla_sec");

  const loadData = useCallback(() => {
    fetchTtlaOrders(query)
      .then((d) => {
        setOrders(d.orders);
        setRowLimit(d.row_limit);
        setTargetSec(d.ttla_target_sec ?? null);
      })
      .catch(() => setOrders([]));
  }, [query]);

  const probe = useCallback((force?: boolean) => fetchTtlaViewFreshness(query, "orders", force), [query]);
  const reloadData = useCallback((_silent: boolean) => { loadData(); }, [loadData]);
  const { freshness, pollError, retry, signIn, signingIn } = useViewFreshness({
    key: queryKey("ttla-orders", query),
    probe,
    reloadData,
    // Only the top panel publishes to the shared header status.
    publish: true,
  });
  useGlobalRefresh(refreshSignal, retry);

  const sorted = useMemo(() => [...orders].sort((a, b) => cmp(a, b, sort.key, sort.dir)), [orders, sort]);
  const pager = usePager(sorted.length);
  const visible = useMemo(() => sorted.slice(pager.start, pager.end), [sorted, pager.start, pager.end]);
  const avg = useMemo(() => {
    if (orders.length === 0) return null;
    return orders.reduce((s, o) => s + (o.ttla_sec || 0), 0) / orders.length;
  }, [orders]);
  const capped = orders.length >= rowLimit;

  return (
    <PanelFrame
      title="Orders"
      icon={Package}
      accent="text-teal-500"
      headline={
        <HeadlineKpi
          label="Avg accept latency (shown jobs)"
          avg={avg}
          targetSec={targetSec}
          subtitle={`${orders.length.toLocaleString()} orders shown`}
        />
      }
      filterBar={
        <TtlaFilterBar query={query} onChange={patch} cities={cities} showMinTtla showLocation={false} showPeriod={false} showDateRange={false} onRefresh={retry} loading={!!freshness?.refreshing} />
      }
      freshness={freshness}
      onSignIn={signIn}
      signingIn={signingIn}
      onRetry={retry}
      pollError={pollError}
      notice={
        <>
          {inspectVenueIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-teal-500/40 bg-teal-500/10 px-3 py-1.5 text-xs text-[var(--color-text)]">
              <Store size={13} className="text-teal-400" />
              <span>
                Filtered to <b>{inspectVenueIds.length}</b> venue{inspectVenueIds.length === 1 ? "" : "s"} selected in the Venue Accept latency panel — worst-Accept latency orders first.
              </span>
              <button
                onClick={onClearInspect}
                className="ml-auto flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
              >
                <X size={11} /> Clear selection
              </button>
            </div>
          )}
          {capped && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/50 px-3 py-1.5 text-xs text-[var(--color-text-muted)]">
              Showing the {rowLimit.toLocaleString()} slowest-to-accept orders by Accept latency (inspection list). The Venue &amp;
              Courier panels aggregate the full window.
            </div>
          )}
        </>
      }
      footer={<PanelPager total={sorted.length} pager={pager} />}
    >
      <table className="w-full min-w-[980px] border-collapse">
        <thead className="border-b border-[var(--color-border)] bg-[var(--color-bg)]/40">
          <tr>
            <SortHeader label="Purchase" colKey="purchase_id" sort={sort} onSort={onSort} />
            <SortHeader label="Venue" colKey="venue_name" sort={sort} onSort={onSort} />
            <SortHeader label="Courier" colKey="courier_id" sort={sort} onSort={onSort} />
            <SortHeader label="City" colKey="city" sort={sort} onSort={onSort} />
            <SortHeader label="Confirmed" colKey="confirmed_at" sort={sort} onSort={onSort} />
            <SortHeader label="Size" colKey="is_heavy" sort={sort} onSort={onSort} />
            <SortHeader label="Deliveries" colKey="delivery_count" sort={sort} onSort={onSort} align="right" tooltip="# of completed courier deliveries for this order. More than 1 = a redispatched job (fulfilled by multiple couriers)." />
            <SortHeader label="Prep error" colKey="prep_error_min" sort={sort} onSort={onSort} align="right" tooltip="Actual ready time minus the venue's initial pickup ETA (its prep-time promise). + = ready later than promised." />
            <SortHeader label={LEX.metrics.acceptLatencySec} colKey="ttla_sec" sort={sort} onSort={onSort} align="right" />
          </tr>
        </thead>
        <tbody>
          {visible.map((o) => (
            <tr key={o.purchase_id} className="border-b border-[var(--color-border)]/50 hover:bg-[var(--color-surface-hover)]">
              <td className="px-3 py-1.5"><PurchaseLink id={o.purchase_id} /></td>
              <td className="px-3 py-1.5 text-sm text-[var(--color-text)]">{o.venue_name}</td>
              <td className="px-3 py-1.5 font-mono text-xs text-[var(--color-text-muted)]">{o.courier_id ?? "—"}</td>
              <td className="px-3 py-1.5 text-sm text-[var(--color-text-muted)]">{o.city}</td>
              <td className="px-3 py-1.5 whitespace-nowrap text-xs text-[var(--color-text-muted)]">{o.confirmed_at}</td>
              <td className="px-3 py-1.5">
                <span className="flex gap-1">
                  {o.is_heavy ? <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-medium text-orange-400">Tier A</span> : null}
                  {o.is_large ? <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-400">Tier B</span> : null}
                  {!o.is_heavy && !o.is_large ? <span className="text-[10px] text-[var(--color-text-muted)]">—</span> : null}
                </span>
              </td>
              <td
                className={`px-3 py-1.5 text-right text-sm tabular-nums ${(o.delivery_count ?? 1) > 1 ? "font-semibold text-red-400" : "text-[var(--color-text-muted)]"}`}
                title={(o.delivery_count ?? 1) > 1 ? `Redispatched job — ${o.delivery_count} courier deliveries` : undefined}
              >
                {o.delivery_count ?? 1}
              </td>
              <td className={`px-3 py-1.5 text-right text-sm tabular-nums ${errColorClass(o.prep_error_min)}`}>
                {fmtErrMin(o.prep_error_min)}
              </td>
              <td className={`px-3 py-1.5 text-right text-sm font-semibold tabular-nums ${ttlaColorClass(o.ttla_sec, targetSec)}`}>
                {fmtSec(o.ttla_sec)}
              </td>
            </tr>
          ))}
          {sorted.length === 0 && <EmptyRow span={9} />}
        </tbody>
      </table>
    </PanelFrame>
  );
}

// --- Venues panel -----------------------------------------------------------
type VenueWithImpact = TtlaVenueRow & { impact_sec: number | null };

function VenuesPanel({ global, refreshSignal, cities }: { global: TtlaGlobalFilters; refreshSignal: number; cities: CityInfo[] }) {
  const { query, patch } = usePanelQuery(global, { sizeFilter: "all", venueType: "all" });
  // Client-side min-impact filter (seconds); null = show all. NOT part of the
  // fetch query (impact is computed here), so it never refetches/rewarms.
  const [minImpact, setMinImpact] = useState<number | null>(null);

  const [venues, setVenues] = useState<TtlaVenueRow[]>([]);
  const [targetSec, setTargetSec] = useState<number | null>(null);
  const { sort, onSort } = useSort("order_count");

  const loadData = useCallback(() => {
    fetchTtlaVenues(query)
      .then((d) => {
        setVenues(d.venues);
        setTargetSec(d.ttla_target_sec ?? null);
      })
      .catch(() => setVenues([]));
  }, [query]);

  const probe = useCallback((force?: boolean) => fetchTtlaViewFreshness(query, "venues", force), [query]);
  const reloadData = useCallback((_silent: boolean) => { loadData(); }, [loadData]);
  const { freshness, pollError, retry, signIn, signingIn } = useViewFreshness({
    key: queryKey("ttla-venues", query),
    probe,
    reloadData,
    publish: false,
  });
  useGlobalRefresh(refreshSignal, retry);

  // City totals (over ALL loaded venues) → each venue's leave-one-out impact.
  const cityStats = useMemo(() => {
    const N = venues.reduce((s, v) => s + (v.order_count || 0), 0);
    const S = venues.reduce((s, v) => s + (v.ttla_sec_sum || 0), 0);
    return { N, S, avg: N > 0 ? S / N : null };
  }, [venues]);

  const withImpact = useMemo<VenueWithImpact[]>(() => {
    const { N, S, avg } = cityStats;
    return venues.map((v) => {
      const n = v.order_count || 0;
      const s = v.ttla_sec_sum || 0;
      let impact: number | null = null;
      if (avg != null && N - n > 0) impact = avg - (S - s) / (N - n);
      return { ...v, impact_sec: impact };
    });
  }, [venues, cityStats]);

  const filtered = useMemo(
    () =>
      minImpact == null
        ? withImpact
        : withImpact.filter((v) => v.impact_sec != null && v.impact_sec >= minImpact),
    [withImpact, minImpact],
  );

  const sorted = useMemo(() => [...filtered].sort((a, b) => cmp(a, b, sort.key, sort.dir)), [filtered, sort]);
  const pager = usePager(sorted.length);
  const visible = useMemo(() => sorted.slice(pager.start, pager.end), [sorted, pager.start, pager.end]);

  const headline = useMemo(() => {
    const cnt = venues.reduce((s, v) => s + (v.order_count || 0), 0);
    return { avg: cityStats.avg, orders: cnt, count: venues.length };
  }, [venues, cityStats]);

  const hiddenByImpact = minImpact != null ? withImpact.length - filtered.length : 0;

  return (
    <PanelFrame
      title="Venues"
      icon={Store}
      accent="text-teal-500"
      headline={
        <HeadlineKpi
          label="Avg accept latency (weighted)"
          avg={headline.avg}
          targetSec={targetSec}
          subtitle={`${headline.orders.toLocaleString()} orders · ${headline.count.toLocaleString()} venues`}
        />
      }
      filterBar={
        <TtlaFilterBar
          query={query}
          onChange={patch}
          cities={cities}
          showMinTtla
          showMinImpact
          minImpact={minImpact}
          onMinImpact={setMinImpact}
          showLocation={false}
          showPeriod={false}
          showDateRange={false}
          onRefresh={retry}
          loading={!!freshness?.refreshing}
        />
      }
      freshness={freshness}
      onSignIn={signIn}
      signingIn={signingIn}
      onRetry={retry}
      pollError={pollError}
      notice={
        hiddenByImpact > 0 ? (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/50 px-3 py-1.5 text-xs text-[var(--color-text-muted)]">
            Showing venues with impact ≥ {fmtImpact(minImpact)} on the city avg Accept latency — {hiddenByImpact.toLocaleString()} lower-impact venue(s) hidden.
          </div>
        ) : null
      }
      footer={<PanelPager total={sorted.length} pager={pager} />}
    >
      <table className="w-full min-w-[680px] border-collapse">
        <thead className="border-b border-[var(--color-border)] bg-[var(--color-bg)]/40">
          <tr>
            <SortHeader label="Venue" colKey="venue_name" sort={sort} onSort={onSort} />
            <SortHeader label="Type" colKey="product_line_category" sort={sort} onSort={onSort} />
            <SortHeader label="Orders" colKey="order_count" sort={sort} onSort={onSort} align="right" />
            <SortHeader label="Avg accept" colKey="avg_ttla_sec" sort={sort} onSort={onSort} align="right" />
            <SortHeader label="Impact on city avg" colKey="impact_sec" sort={sort} onSort={onSort} align="right" />
          </tr>
        </thead>
        <tbody>
          {visible.map((v) => (
            <tr key={`${v.venue_id ?? v.venue_name}`} className="border-b border-[var(--color-border)]/50 hover:bg-[var(--color-surface-hover)]">
              <td className="px-3 py-1.5 text-sm text-[var(--color-text)]">{v.venue_name}</td>
              <td className="px-3 py-1.5 text-xs text-[var(--color-text-muted)]">{v.product_line_category ?? "—"}</td>
              <td className="px-3 py-1.5 text-right text-sm tabular-nums">
                {v.venue_id ? (
                  <OrderCountButton
                    baseQuery={query}
                    drill={{ venueId: String(v.venue_id) }}
                    label={v.venue_name ?? "Venue"}
                    count={v.order_count}
                  />
                ) : (
                  <span className="text-[var(--color-text-muted)]">{v.order_count.toLocaleString()}</span>
                )}
              </td>
              <td className={`px-3 py-1.5 text-right text-sm font-semibold tabular-nums ${ttlaColorClass(v.avg_ttla_sec, targetSec)}`}>
                {fmtSec(v.avg_ttla_sec)}
              </td>
              <td
                className={`px-3 py-1.5 text-right text-sm font-semibold tabular-nums ${impactColorClass(v.impact_sec)}`}
                title="Leave-one-out: seconds this venue adds to the city order-weighted avg Accept latency"
              >
                {fmtImpact(v.impact_sec)}
              </td>
            </tr>
          ))}
          {sorted.length === 0 && <EmptyRow span={5} />}
        </tbody>
      </table>
    </PanelFrame>
  );
}

// --- Couriers panel ---------------------------------------------------------
function CouriersPanel({ global, refreshSignal, cities }: { global: TtlaGlobalFilters; refreshSignal: number; cities: CityInfo[] }) {
  const { query, patch } = usePanelQuery(global, { sizeFilter: "all", venueType: "all" });

  const [couriers, setCouriers] = useState<TtlaCourierRow[]>([]);
  const [targetSec, setTargetSec] = useState<number | null>(null);
  const { sort, onSort } = useSort("order_count");

  const loadData = useCallback(() => {
    fetchTtlaCouriers(query)
      .then((d) => {
        setCouriers(d.couriers);
        setTargetSec(d.ttla_target_sec ?? null);
      })
      .catch(() => setCouriers([]));
  }, [query]);

  const probe = useCallback((force?: boolean) => fetchTtlaViewFreshness(query, "couriers", force), [query]);
  const reloadData = useCallback((_silent: boolean) => { loadData(); }, [loadData]);
  const { freshness, pollError, retry, signIn, signingIn } = useViewFreshness({
    key: queryKey("ttla-couriers", query),
    probe,
    reloadData,
    publish: false,
  });
  useGlobalRefresh(refreshSignal, retry);

  const sorted = useMemo(() => [...couriers].sort((a, b) => cmp(a, b, sort.key, sort.dir)), [couriers, sort]);
  const pager = usePager(sorted.length);
  const visible = useMemo(() => sorted.slice(pager.start, pager.end), [sorted, pager.start, pager.end]);
  const headline = useMemo(() => {
    const sum = couriers.reduce((s, c) => s + (c.ttla_sec_sum || 0), 0);
    const cnt = couriers.reduce((s, c) => s + (c.order_count || 0), 0);
    return { avg: cnt > 0 ? sum / cnt : null, orders: cnt, count: couriers.length };
  }, [couriers]);

  return (
    <PanelFrame
      title="Couriers"
      icon={Bike}
      accent="text-teal-500"
      headline={
        <HeadlineKpi
          label="Avg accept latency (weighted)"
          avg={headline.avg}
          targetSec={targetSec}
          subtitle={`${headline.orders.toLocaleString()} orders · ${headline.count.toLocaleString()} couriers`}
        />
      }
      filterBar={
        <TtlaFilterBar query={query} onChange={patch} cities={cities} showVehicleType showLocation={false} showPeriod={false} showDateRange={false} onRefresh={retry} loading={!!freshness?.refreshing} />
      }
      freshness={freshness}
      onSignIn={signIn}
      signingIn={signingIn}
      onRetry={retry}
      pollError={pollError}
      footer={<PanelPager total={sorted.length} pager={pager} />}
    >
      <table className="w-full min-w-[520px] border-collapse">
        <thead className="border-b border-[var(--color-border)] bg-[var(--color-bg)]/40">
          <tr>
            <SortHeader label="Courier" colKey="courier_id" sort={sort} onSort={onSort} />
            <SortHeader label="Orders" colKey="order_count" sort={sort} onSort={onSort} align="right" />
            <SortHeader label="Avg accept" colKey="avg_ttla_sec" sort={sort} onSort={onSort} align="right" />
          </tr>
        </thead>
        <tbody>
          {visible.map((c) => (
            <tr key={c.courier_id} className="border-b border-[var(--color-border)]/50 hover:bg-[var(--color-surface-hover)]">
              <td className="px-3 py-1.5 font-mono text-xs text-[var(--color-text)]">{c.courier_id}</td>
              <td className="px-3 py-1.5 text-right text-sm tabular-nums">
                <OrderCountButton
                  baseQuery={query}
                  drill={{ courierId: c.courier_id }}
                  label={`Courier ${c.courier_id}`}
                  count={c.order_count}
                />
              </td>
              <td className={`px-3 py-1.5 text-right text-sm font-semibold tabular-nums ${ttlaColorClass(c.avg_ttla_sec, targetSec)}`}>
                {fmtSec(c.avg_ttla_sec)}
              </td>
            </tr>
          ))}
          {sorted.length === 0 && <EmptyRow span={3} />}
        </tbody>
      </table>
    </PanelFrame>
  );
}

// --- Order-count drill-down (Venues / Couriers) -----------------------------
// The order-count cell becomes a button opening a fixed-position popover that
// lists that venue's / courier's orders. The popover is its OWN self-contained
// serve-stale unit (its own useViewFreshness scope keyed on the drill query), so
// a cold single-entity slice warms + polls exactly like a panel — never popping
// sign-in on its own.
function OrderCountButton({
  baseQuery,
  drill,
  label,
  count,
}: {
  baseQuery: TtlaQuery;
  drill: { venueId?: string; courierId?: string };
  label: string;
  count: number;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const toggle = () => {
    if (!open && btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    setOpen((o) => !o);
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className="tabular-nums text-[var(--color-primary)] transition-colors hover:underline"
        title="Show orders"
      >
        {count.toLocaleString()}
      </button>
      {open && rect && (
        <OrdersDrilldownPopover baseQuery={baseQuery} drill={drill} label={label} anchor={rect} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function OrdersDrilldownPopover({
  baseQuery,
  drill,
  label,
  anchor,
  onClose,
}: {
  baseQuery: TtlaQuery;
  drill: { venueId?: string; courierId?: string };
  label: string;
  anchor: DOMRect;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // The drill orders slice: the entity's OWN orders under the panel's structural
  // filters (size / date / venue type / vehicle type), but NOT min-Accept latency — the
  // order count is over all the entity's orders, not the min-Accept latency-filtered set.
  const query = useMemo<TtlaQuery>(
    () => ({ ...baseQuery, minTtla: null, venueId: drill.venueId, courierId: drill.courierId }),
    [baseQuery, drill.venueId, drill.courierId],
  );

  const [orders, setOrders] = useState<TtlaOrderRow[]>([]);
  const [targetSec, setTargetSec] = useState<number | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const loadData = useCallback(() => {
    fetchTtlaOrders(query)
      .then((d) => {
        setOrders(d.orders);
        setTargetSec(d.ttla_target_sec ?? null);
      })
      .catch(() => setOrders([]))
      .finally(() => setLoadedOnce(true));
  }, [query]);

  const probe = useCallback((force?: boolean) => fetchTtlaViewFreshness(query, "orders", force), [query]);
  const reloadData = useCallback((_silent: boolean) => { loadData(); }, [loadData]);
  const { freshness, pollError, retry, signIn, signingIn } = useViewFreshness({
    key: `ttla-drill:${queryKey("orders", query)}`,
    probe,
    reloadData,
    publish: false,
  });

  // Close on click-outside / Esc.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const sorted = useMemo(() => [...orders].sort((a, b) => (b.ttla_sec || 0) - (a.ttla_sec || 0)), [orders]);

  // Anchor the fixed popover under the clicked cell, right-aligned, clamped to the
  // viewport (fixed positioning ignores the table's overflow clip).
  const width = 560;
  const left = Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12));
  const top = Math.min(anchor.bottom + 6, window.innerHeight - 340);

  return (
    <div
      ref={ref}
      style={{ position: "fixed", top, left, width, zIndex: 60 }}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-xl shadow-black/30"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[var(--color-text)]" title={label}>{label}</div>
          <div className="text-[11px] text-[var(--color-text-muted)]">{orders.length.toLocaleString()} orders</div>
        </div>
        <button onClick={onClose} className="text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]" aria-label="Close">
          <X size={15} />
        </button>
      </div>

      {freshness && (freshness.stale || freshness.refreshing || freshness.reason === "initialization_required") && (
        <div className="mb-2">
          <StaleDataBanner summary={freshness} onSignIn={signIn} signingIn={signingIn} onRetry={retry} />
        </div>
      )}
      {pollError && <div className="mb-2"><PollRetryHint onRetry={retry} /></div>}

      <div className="max-h-64 overflow-auto rounded-lg border border-[var(--color-border)]">
        <table className="w-full min-w-[520px] border-collapse">
          <thead className="sticky top-0 border-b border-[var(--color-border)] bg-[var(--color-bg)]/90 backdrop-blur">
            <tr>
              <th className="px-3 py-1.5 text-left text-[11px] font-semibold text-[var(--color-text-muted)]">Purchase</th>
              <th className="px-3 py-1.5 text-left text-[11px] font-semibold text-[var(--color-text-muted)]">Confirmed</th>
              <th className="px-3 py-1.5 text-left text-[11px] font-semibold text-[var(--color-text-muted)]">Size</th>
              <th className="px-3 py-1.5 text-right text-[11px] font-semibold text-[var(--color-text-muted)]">{LEX.metrics.acceptLatencyShort}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((o) => (
              <tr key={o.purchase_id} className="border-b border-[var(--color-border)]/50 hover:bg-[var(--color-surface-hover)]">
                <td className="px-3 py-1.5"><PurchaseLink id={o.purchase_id} /></td>
                <td className="px-3 py-1.5 whitespace-nowrap text-xs text-[var(--color-text-muted)]">{o.confirmed_at}</td>
                <td className="px-3 py-1.5">
                  <span className="flex gap-1">
                    {o.is_heavy ? <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-medium text-orange-400">Tier A</span> : null}
                    {o.is_large ? <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-400">Tier B</span> : null}
                    {!o.is_heavy && !o.is_large ? <span className="text-[10px] text-[var(--color-text-muted)]">—</span> : null}
                  </span>
                </td>
                <td className={`px-3 py-1.5 text-right text-sm font-semibold tabular-nums ${ttlaColorClass(o.ttla_sec, targetSec)}`}>
                  {fmtSec(o.ttla_sec)}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-xs text-[var(--color-text-muted)]">
                  {loadedOnce ? "No orders cached for this slice yet — sign in / refresh to warm." : "Loading…"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// The Accept latency tab: four STACKED panels (Retail overview → Orders → Venues →
// Couriers) driven by ONE shared GLOBAL filter bar (Country / City / Period /
// Order type). Each panel still owns its own serve-stale / freshness scope +
// panel-specific refinements (size / venue type / min-Accept latency / vehicle), but the
// four global dimensions are lifted here and synced into every panel.
export function TtlaDashboard() {
  const { filters } = useFilters();
  const [cities, setCities] = useState<CityInfo[]>([]);

  useEffect(() => {
    fetchCities().then(setCities).catch(() => {});
  }, []);

  // Seed the global filters once from the app-wide filters (city/lookback);
  // Regular order type by default.
  const [global, setGlobal] = useState<TtlaGlobalFilters>(() => ({
    city: filters.city,
    lookbackDays: filters.lookbackDays,
    completeWeeks: null,
    orderType: "regular",
    ttlaMode: "default",
    deliveryCounts: null,
  }));
  const patchGlobal = useCallback(
    (p: Partial<TtlaGlobalFilters>) => setGlobal((g) => ({ ...g, ...p })),
    [],
  );

  // "Refresh all" nonce — advancing it force-refreshes every panel.
  const [refreshSignal, setRefreshSignal] = useState(0);
  const refreshAll = useCallback(() => setRefreshSignal((n) => n + 1), []);

  // Cross-panel "inspect these venues" selection: venue ids checked in the Venue
  // Accept latency panel. It filters that panel's map AND scopes the Orders panel to just
  // those venues (worst-Accept latency orders first). Reset when the venue population
  // changes (city / order type / period) so stale ids can't zero out the Orders.
  const [inspectVenueIds, setInspectVenueIds] = useState<string[]>([]);
  const globalPeriodKey =
    global.dateFrom && global.dateTo
      ? `${global.dateFrom}_${global.dateTo}`
      : global.completeWeeks
      ? `${global.completeWeeks}w`
      : `${global.lookbackDays}d`;
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    setInspectVenueIds([]);
  }, [global.city, global.orderType, globalPeriodKey]);
  const clearInspect = useCallback(() => setInspectVenueIds([]), []);

  return (
    <div className="space-y-6">
      <TtlaGlobalFilterBar filters={global} onChange={patchGlobal} cities={cities} onRefresh={refreshAll} loading={false} />
      <TtlaCountryContextPanel global={global} refreshSignal={refreshSignal} />
      <RetailPanel
        global={global}
        refreshSignal={refreshSignal}
        cities={cities}
        inspectVenueIds={inspectVenueIds}
        onInspectChange={setInspectVenueIds}
      />
      <VenueDiagnosticsPanel global={global} inspectVenueIds={inspectVenueIds} />
      <OrdersPanel
        global={global}
        refreshSignal={refreshSignal}
        cities={cities}
        inspectVenueIds={inspectVenueIds}
        onClearInspect={clearInspect}
      />
      <VenuesPanel global={global} refreshSignal={refreshSignal} cities={cities} />
      <CouriersPanel global={global} refreshSignal={refreshSignal} cities={cities} />
    </div>
  );
}
