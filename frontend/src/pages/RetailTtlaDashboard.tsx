import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useViewFreshness } from "../hooks/useViewFreshness";
import { StaleDataBanner, PollRetryHint } from "../components/StaleDataBanner";
import { RetailTtlaMap } from "../components/RetailTtlaMap";
import {
  fetchRetailTtlaSummary,
  fetchRetailTtlaVenues,
  probeRetailTtlaFreshness,
} from "../api/client";
import type { RetailTtlaFilters } from "../api/client";
import type {
  CityInfo,
  RetailTtlaSummary,
  RetailTtlaVenueRow,
  RetailTtlaGroupStats,
  RetailTtlaCountryGroupStats,
  VenueSegment,
  TtlaGlobalFilters,
} from "../types";
import { Store, Timer, Utensils, ShoppingBag, ArrowUp, ArrowDown, Search, Columns3, X } from "lucide-react";

// How many venues to show before "show all".
const COLLAPSED_ROWS = 20;

const SEGMENT_LABEL: Record<VenueSegment, string> = { restaurant: "Restaurant", retail: "Retail" };

function fmtSec(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Math.round(v).toLocaleString()} s`;
}

function fmtMin(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v.toFixed(1)} min`;
}

// One "current → hypothetical" Accept latency stat for the selected-venues what-if box.
function WhatIfStat({
  label,
  sub,
  cur,
  next,
  delta,
}: {
  label: string;
  sub: string;
  cur: number | null;
  next: number | null;
  delta: number | null;
}) {
  const improved = delta != null && delta > 0.05;
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-[var(--color-text)]">{label}</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">{sub}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-sm tabular-nums text-[var(--color-text-muted)]">{fmtSec(cur)}</span>
        <span className="text-[var(--color-text-muted)]">→</span>
        <span className="text-lg font-semibold tabular-nums text-[var(--color-text)]">{fmtSec(next)}</span>
        {delta != null && (
          <span
            className={`ml-auto rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums ${
              improved ? "bg-emerald-500/15 text-emerald-500" : "bg-[var(--color-border)]/40 text-[var(--color-text-muted)]"
            }`}
          >
            {improved ? `−${Math.round(delta).toLocaleString()} s` : "no change"}
          </span>
        )}
      </div>
    </div>
  );
}

// Prep-estimate error (signed minutes): the venue's average gap between its
// INITIAL pickup ETA (prep-time promise) and the actual ready time. + = ready
// later than promised (amber); ≤0 = ready early / on time (emerald).
function fmtErrMin(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)} min`;
}

function errColorClass(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "text-[var(--color-text-muted)]";
  return v > 0 ? "text-amber-400" : "text-emerald-400";
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

// Signed percentage for the venue's impact on its segment's total Accept latency.
function fmtImpactPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

// Percentage-points (the Express partner additive unassign contribution).
function fmtPp(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v.toFixed(2)} pp`;
}

// Prettify a raw product_line (e.g. "relay_retail" → "Relay retail", "grocery" →
// "Grocery"); blank stays an em dash.
function fmtVenueType(v: string | null | undefined): string {
  if (!v) return "—";
  const s = v.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Stable selection/highlight key shared by the table + map (venue_id, else name).
export function venueKey(v: { venue_id: string | null; venue_name: string }): string {
  return String(v.venue_id ?? v.venue_name);
}

// Higher Accept latency = worse. At/under the reference = good (emerald), over = bad (red),
// no reference = plain.
function ttlaColorClass(v: number | null | undefined, ref?: number | null): string {
  const hasRef = ref != null && Number.isFinite(ref);
  if (!hasRef || v == null || Number.isNaN(v)) return "text-[var(--color-text)]";
  return v > (ref as number) ? "text-red-400" : "text-emerald-400";
}

// Reassignment rate vs the segment's city average: over = red, at/under = emerald.
function unassignColorClass(v: number | null | undefined, ref?: number | null): string {
  const hasRef = ref != null && Number.isFinite(ref);
  if (v == null || Number.isNaN(v)) return "text-[var(--color-text-muted)]";
  if (!hasRef) return "text-[var(--color-text)]";
  return v > (ref as number) ? "text-red-400" : "text-emerald-400";
}

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  valueClass,
}: {
  icon: typeof Store;
  label: string;
  value: string;
  sub: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <Icon size={20} className="text-teal-500" />
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{label}</div>
        <div className={`text-2xl font-bold tabular-nums ${valueClass ?? "text-[var(--color-text)]"}`}>{value}</div>
        <div className="text-[11px] text-[var(--color-text-muted)]">{sub}</div>
      </div>
    </div>
  );
}

interface SortState {
  key: keyof RetailTtlaVenueRow;
  dir: "asc" | "desc";
}

function cmp(a: RetailTtlaVenueRow, b: RetailTtlaVenueRow, key: keyof RetailTtlaVenueRow, dir: "asc" | "desc"): number {
  const va = a[key];
  const vb = b[key];
  let r: number;
  if (typeof va === "number" || typeof vb === "number") {
    r = ((va as number) ?? -Infinity) - ((vb as number) ?? -Infinity);
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
  colKey: SortState["key"];
  sort: SortState;
  onSort: (k: SortState["key"]) => void;
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

const EMPTY_GROUPS: Record<VenueSegment, RetailTtlaGroupStats | undefined> = {
  restaurant: undefined,
  retail: undefined,
};

const EMPTY_COUNTRY_GROUPS: Record<VenueSegment, RetailTtlaCountryGroupStats | undefined> = {
  restaurant: undefined,
  retail: undefined,
};

// Venue Accept latency & unassign overview panel — the first panel of the Accept latency tab. Driven
// by the tab's GLOBAL filters (city / period / order type); it has no filter bar
// of its own, only a Restaurant/Retail segment toggle that switches the view
// client-side (both segments are fetched together, each with its OWN per-group
// city denominators). Order type (Regular/Drive) + period flow in from ``global``.
export function RetailPanel({
  global,
  refreshSignal,
  cities,
  inspectVenueIds,
  onInspectChange,
}: {
  global: TtlaGlobalFilters;
  refreshSignal: number;
  cities: CityInfo[];
  // Cross-panel "inspect these venues" selection (venue ids) — checked venues
  // filter this panel's map AND scope the Orders panel. Owned by TtlaDashboard.
  inspectVenueIds: string[];
  onInspectChange: (ids: string[]) => void;
}) {
  const city = global.city;
  const lookbackDays = global.lookbackDays;
  const retailFilters = useMemo<RetailTtlaFilters>(
    () => ({
      orderType: global.orderType,
      completeWeeks: global.completeWeeks,
      dateFrom: global.dateFrom,
      dateTo: global.dateTo,
    }),
    [global.orderType, global.completeWeeks, global.dateFrom, global.dateTo],
  );
  // Stable freshness/reload key: any global change re-scopes the serve-stale
  // probe + data fetch.
  const periodKey =
    global.dateFrom && global.dateTo
      ? `${global.dateFrom}_${global.dateTo}`
      : global.completeWeeks
      ? `${global.completeWeeks}w`
      : `${lookbackDays}d`;

  const [summary, setSummary] = useState<RetailTtlaSummary | null>(null);
  const [venues, setVenues] = useState<RetailTtlaVenueRow[]>([]);
  const [groups, setGroups] = useState(EMPTY_GROUPS);
  const [countryGroups, setCountryGroups] = useState(EMPTY_COUNTRY_GROUPS);
  const [targetSec, setTargetSec] = useState<number | null>(null);
  const [segment, setSegment] = useState<VenueSegment>("retail");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [sort, setSort] = useState<SortState>({ key: "ttla_impact_pct", dir: "desc" });
  // Venue selected (from the table row OR a map dot) → highlighted/centred on the
  // map. Toggles off when the same one is picked again.
  const [selectedVenue, setSelectedVenue] = useState<string | null>(null);
  const toggleSelectedVenue = useCallback(
    (key: string | null) => setSelectedVenue((cur) => (cur === key ? null : key)),
    [],
  );

  const onSort = useCallback((key: SortState["key"]) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  }, []);

  const cityInfo = useMemo(() => cities.find((c) => c.name === city), [cities, city]);

  const loadData = useCallback(() => {
    fetchRetailTtlaSummary(city, lookbackDays, retailFilters)
      .then((d) => {
        setSummary(d);
        setTargetSec(d.ttla_target_sec ?? null);
      })
      .catch(() => setSummary(null));
    fetchRetailTtlaVenues(city, lookbackDays, retailFilters)
      .then((d) => {
        setVenues(d.venues);
        setGroups(d.groups ?? EMPTY_GROUPS);
        setCountryGroups(d.country_groups ?? EMPTY_COUNTRY_GROUPS);
        setTargetSec(d.ttla_target_sec ?? null);
      })
      .catch(() => {
        setVenues([]);
        setGroups(EMPTY_GROUPS);
        setCountryGroups(EMPTY_COUNTRY_GROUPS);
      });
  }, [city, lookbackDays, retailFilters]);

  const probe = useCallback(
    (force?: boolean) => probeRetailTtlaFreshness(city, lookbackDays, retailFilters, force),
    [city, lookbackDays, retailFilters],
  );
  const reloadData = useCallback((_silent: boolean) => { loadData(); }, [loadData]);
  const { freshness, pollError, retry, signIn, signingIn } = useViewFreshness({
    key: `retail-ttla:${city}:${periodKey}:${global.orderType}`,
    probe,
    reloadData,
  });

  // Global "Refresh all" nonce → force-refresh this panel (skip initial render).
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    retry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  const groupStats = groups[segment];
  const groupAvg = groupStats?.avg_ttla_sec ?? null;
  const groupUnassignRate = groupStats?.avg_unassign_rate ?? null;
  // Reference for the Accept latency good/bad coloring: the country target if set, else the
  // selected segment's order-weighted average Accept latency (the venue-impact baseline).
  const ttlaRef = targetSec ?? groupAvg;

  // Venues in the selected segment, name-filtered, sorted.
  const segmentVenues = useMemo(
    () => venues.filter((v) => v.segment === segment),
    [venues, segment],
  );
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return segmentVenues;
    return segmentVenues.filter((v) => (v.venue_name ?? "").toLowerCase().includes(q));
  }, [segmentVenues, search]);
  const sorted = useMemo(
    () => [...searched].sort((a, b) => cmp(a, b, sort.key, sort.dir)),
    [searched, sort],
  );
  const visible = expanded ? sorted : sorted.slice(0, COLLAPSED_ROWS);

  // Checkbox "inspect" selection: filters the map to just the checked venues and
  // scopes the Orders panel to them. Keyed by venue_id (only venues with an id can
  // be inspected — the Orders filter is by venue_id).
  const inspectSet = useMemo(() => new Set(inspectVenueIds), [inspectVenueIds]);
  const toggleInspect = useCallback(
    (venueId: string) => {
      onInspectChange(
        inspectSet.has(venueId)
          ? inspectVenueIds.filter((x) => x !== venueId)
          : [...inspectVenueIds, venueId],
      );
    },
    [inspectSet, inspectVenueIds, onInspectChange],
  );
  // Header checkbox toggles all currently-visible (selectable) rows at once.
  const visibleIds = useMemo(
    () => visible.filter((v) => v.venue_id != null).map((v) => String(v.venue_id)),
    [visible],
  );
  const allVisibleChecked = visibleIds.length > 0 && visibleIds.every((id) => inspectSet.has(id));
  const toggleAllVisible = useCallback(() => {
    if (allVisibleChecked) {
      const drop = new Set(visibleIds);
      onInspectChange(inspectVenueIds.filter((x) => !drop.has(x)));
    } else {
      onInspectChange(Array.from(new Set([...inspectVenueIds, ...visibleIds])));
    }
  }, [allVisibleChecked, visibleIds, inspectVenueIds, onInspectChange]);

  // The map shows only the checked venues when any are selected, else all.
  const mapVenues = useMemo(
    () =>
      inspectSet.size > 0
        ? segmentVenues.filter((v) => v.venue_id != null && inspectSet.has(String(v.venue_id)))
        : segmentVenues,
    [segmentVenues, inspectSet],
  );

  // "What-if" for the checked venues: if each selected venue's avg Accept latency were fixed
  // DOWN to (at least) the segment's city average — venues already at/under it are
  // left alone — how much do the city and countrywide segment Accept latency improve? The
  // removable excess accept-seconds (Σ orders × max(0, venueAvg − segAvg)) are part
  // of BOTH the city and country segment totals, so subtracting them from each
  // (order counts unchanged) gives the reconciling hypothetical averages.
  const whatIf = useMemo(() => {
    const citySeg = groups[segment];
    const countrySeg = countryGroups[segment];
    const segAvg = citySeg?.avg_ttla_sec ?? null;
    if (segAvg == null || !citySeg || citySeg.order_count <= 0) return null;
    const selected = segmentVenues.filter(
      (v) => v.venue_id != null && inspectSet.has(String(v.venue_id)),
    );
    if (selected.length === 0) return null;
    let selectedOrders = 0;
    let excessSec = 0;
    let fixableCount = 0;
    for (const v of selected) {
      const orders = v.order_count ?? 0;
      selectedOrders += orders;
      const va = v.avg_ttla_sec;
      if (va != null && va > segAvg) {
        excessSec += orders * (va - segAvg);
        fixableCount += 1;
      }
    }
    const cityNewAvg = (citySeg.ttla_sec_sum - excessSec) / citySeg.order_count;
    const cityDelta = segAvg - cityNewAvg;
    let countryCurAvg: number | null = null;
    let countryNewAvg: number | null = null;
    let countryDelta: number | null = null;
    if (countrySeg && countrySeg.order_count > 0) {
      countryCurAvg = countrySeg.avg_ttla_sec;
      countryNewAvg = (countrySeg.ttla_sec_sum - excessSec) / countrySeg.order_count;
      countryDelta = countryCurAvg != null ? countryCurAvg - countryNewAvg : null;
    }
    // Country OVERALL on-demand Accept latency = Restaurant + Retail combined (Drive already
    // excluded from this population). The selected venues' excess is part of this
    // combined total too, so the same subtraction gives the overall hypothetical.
    const rest = countryGroups.restaurant;
    const ret = countryGroups.retail;
    const overallSum = (rest?.ttla_sec_sum ?? 0) + (ret?.ttla_sec_sum ?? 0);
    const overallCount = (rest?.order_count ?? 0) + (ret?.order_count ?? 0);
    let overallCurAvg: number | null = null;
    let overallNewAvg: number | null = null;
    let overallDelta: number | null = null;
    if (overallCount > 0) {
      overallCurAvg = overallSum / overallCount;
      overallNewAvg = (overallSum - excessSec) / overallCount;
      overallDelta = overallCurAvg - overallNewAvg;
    }
    return {
      selectedCount: selected.length,
      fixableCount,
      selectedOrders,
      excessSec,
      segAvg,
      cityCurAvg: segAvg,
      cityNewAvg,
      cityDelta,
      cityOrders: citySeg.order_count,
      countryCurAvg,
      countryNewAvg,
      countryDelta,
      countryOrders: countrySeg?.order_count ?? 0,
      overallCurAvg,
      overallNewAvg,
      overallDelta,
      overallOrders: overallCount,
    };
  }, [groups, countryGroups, segment, segmentVenues, inspectSet]);

  const switchSegment = useCallback((s: VenueSegment) => {
    setSegment(s);
    setExpanded(false);
    setSearch("");
    setSelectedVenue(null);
    onInspectChange([]);
  }, [onInspectChange]);

  // +1 for the checkbox column.
  const colSpan = (showBreakdown ? 15 : 13) + 1;

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Store size={18} className="text-teal-500" />
            <div>
              <h2 className="text-base font-semibold text-[var(--color-text)]">Partner accept latency &amp; reassignment — {city}</h2>
              <p className="text-xs text-[var(--color-text-muted)]">
                Order-weighted Task-to-Last-Accept + courier reassignment rate for{" "}
                {global.orderType === "drive"
                  ? "Express-route jobs (simulated segment)"
                  : "Standard on-demand jobs (express excluded)"}
                ; preorders and time-slot orders always excluded. Venues ranked within their segment, against
                that segment's own city denominators.
              </p>
            </div>
          </div>
        </div>

        {freshness && (
          <StaleDataBanner summary={freshness} onSignIn={signIn} signingIn={signingIn} onRetry={retry} />
        )}
        {pollError && <PollRetryHint onRetry={retry} />}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <KpiCard
            icon={Timer}
            label="City avg Accept latency (all)"
            value={fmtSec(summary?.city_avg_sec)}
            sub={`${(summary?.city_order_count ?? 0).toLocaleString()} orders · ${fmtPct(summary?.city_unassign_rate)} unassigned${targetSec != null ? ` · target ${fmtSec(targetSec)}` : ""}`}
            valueClass={ttlaColorClass(summary?.city_avg_sec, targetSec)}
          />
          <KpiCard
            icon={Utensils}
            label={`Restaurant avg Accept latency${segment === "restaurant" ? " ●" : ""}`}
            value={fmtSec(summary?.restaurant_avg_sec)}
            sub={`${(summary?.restaurant_order_count ?? 0).toLocaleString()} orders · ${fmtPct(summary?.restaurant_unassign_rate)} unassigned`}
            valueClass={ttlaColorClass(summary?.restaurant_avg_sec, targetSec)}
          />
          <KpiCard
            icon={ShoppingBag}
            label={`Retail avg Accept latency${segment === "retail" ? " ●" : ""}`}
            value={fmtSec(summary?.retail_avg_sec)}
            sub={`${(summary?.retail_order_count ?? 0).toLocaleString()} orders · ${fmtPct(summary?.retail_unassign_rate)} unassigned`}
            valueClass={ttlaColorClass(summary?.retail_avg_sec, targetSec)}
          />
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {segment === "retail" ? <ShoppingBag size={16} className="text-teal-500" /> : <Utensils size={16} className="text-teal-500" />}
            <h3 className="text-sm font-semibold text-[var(--color-text)]">
              {SEGMENT_LABEL[segment]} venues worsening Accept latency / unassigns
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Segment toggle — scopes the venue table + map below (each segment
                ranked against its OWN city denominators, Express partner per-group rule). */}
            <div className="flex items-center overflow-hidden rounded-md border border-[var(--color-border)]" title="Choose which segment's venues to rank + map (measured against that segment's own city average)">
              {(["restaurant", "retail"] as VenueSegment[]).map((s) => (
                <button
                  key={s}
                  onClick={() => switchSegment(s)}
                  className={`flex h-8 items-center gap-1.5 px-3 text-xs font-medium transition-colors ${
                    segment === s
                      ? "bg-teal-600 text-white"
                      : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  }`}
                >
                  {s === "restaurant" ? <Utensils size={13} /> : <ShoppingBag size={13} />}
                  {SEGMENT_LABEL[s]}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search venue…"
                className="h-8 w-48 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] pl-8 pr-3 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
              />
            </div>
            <button
              onClick={() => setShowBreakdown((b) => !b)}
              className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${
                showBreakdown
                  ? "border-teal-600 bg-teal-600/10 text-[var(--color-text)]"
                  : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
              title="Show courier- vs ops-initiated reassignment rate columns"
            >
              <Columns3 size={13} />
              {showBreakdown ? "Hide breakdown" : "Reassignment breakdown"}
            </button>
            {inspectVenueIds.length > 0 && (
              <div className="flex items-center gap-1.5 rounded-md border border-teal-500/40 bg-teal-500/10 px-2 text-xs text-[var(--color-text)]" style={{ height: 32 }}>
                <span className="font-medium">{inspectVenueIds.length} selected</span>
                <button
                  onClick={() => onInspectChange([])}
                  className="flex items-center gap-0.5 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
                  title="Clear selected venues (show all on the map + Orders)"
                >
                  <X size={12} /> Clear
                </button>
              </div>
            )}
          </div>
        </div>

        <p className="text-xs text-[var(--color-text-muted)]">
          Tick venues to focus the map on them and scope the <b>Orders</b> panel below to their worst-Accept latency orders. Click a row to locate a single venue on the map.
        </p>

        {whatIf && (
          <div className="rounded-lg border border-teal-500/40 bg-teal-500/5 p-3">
            <div className="mb-1.5 flex items-center gap-2">
              <Timer size={14} className="text-teal-500" />
              <span className="text-sm font-semibold text-[var(--color-text)]">
                What-if: fix {whatIf.selectedCount} selected {SEGMENT_LABEL[segment].toLowerCase()} venue
                {whatIf.selectedCount === 1 ? "" : "s"} to the {SEGMENT_LABEL[segment].toLowerCase()} average
              </span>
            </div>
            <p className="mb-2.5 text-xs text-[var(--color-text-muted)]">
              Caps each selected venue's Accept latency at the {city} {SEGMENT_LABEL[segment].toLowerCase()} average (
              {fmtSec(whatIf.segAvg)}); the {whatIf.fixableCount} above average
              {whatIf.fixableCount === whatIf.selectedCount ? "" : ` of ${whatIf.selectedCount}`} shed{" "}
              <b className="text-[var(--color-text)]">{Math.round(whatIf.excessSec).toLocaleString()} accept-seconds</b>{" "}
              across {whatIf.selectedOrders.toLocaleString()} orders (venues already at/under the average are left as-is).
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <WhatIfStat
                label={`${city} ${SEGMENT_LABEL[segment].toLowerCase()} Accept latency`}
                sub={`${whatIf.cityOrders.toLocaleString()} orders`}
                cur={whatIf.cityCurAvg}
                next={whatIf.cityNewAvg}
                delta={whatIf.cityDelta}
              />
              <WhatIfStat
                label={`Countrywide ${SEGMENT_LABEL[segment].toLowerCase()} Accept latency`}
                sub={`${whatIf.countryOrders.toLocaleString()} orders`}
                cur={whatIf.countryCurAvg}
                next={whatIf.countryNewAvg}
                delta={whatIf.countryDelta}
              />
              <WhatIfStat
                label="Country overall Accept latency"
                sub={`Restaurant + Retail · ${whatIf.overallOrders.toLocaleString()} orders`}
                cur={whatIf.overallCurAvg}
                next={whatIf.overallNewAvg}
                delta={whatIf.overallDelta}
              />
            </div>
          </div>
        )}

        <RetailTtlaMap
          venues={mapVenues}
          cityInfo={cityInfo}
          targetSec={targetSec}
          cityAvgSec={ttlaRef}
          selectedVenue={selectedVenue}
          onSelectVenue={toggleSelectedVenue}
        />

        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full min-w-[1320px] border-collapse">
            <thead className="border-b border-[var(--color-border)] bg-[var(--color-bg)]/40">
              <tr>
                <th className="w-8 px-3 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={allVisibleChecked}
                    onChange={toggleAllVisible}
                    className="h-3.5 w-3.5 cursor-pointer accent-teal-500 align-middle"
                    title="Select/clear all shown venues"
                  />
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-[var(--color-text-muted)]">#</th>
                <SortHeader label="Venue" colKey="venue_name" sort={sort} onSort={onSort} />
                <SortHeader label="Type" colKey="venue_type" sort={sort} onSort={onSort} />
                <SortHeader label="Account manager" colKey="account_manager" sort={sort} onSort={onSort} />
                <SortHeader label="Orders" colKey="order_count" sort={sort} onSort={onSort} align="right" />
                <SortHeader label="Avg Accept latency" colKey="avg_ttla_sec" sort={sort} onSort={onSort} align="right" />
                <SortHeader label="Accept latency impact" colKey="ttla_impact_pct" sort={sort} onSort={onSort} align="right" />
                <SortHeader label="Reassignment rate" colKey="unassign_rate" sort={sort} onSort={onSort} align="right" />
                {showBreakdown && (
                  <>
                    <SortHeader label="· courier" colKey="unassign_rate_courier" sort={sort} onSort={onSort} align="right" />
                    <SortHeader label="· ops" colKey="unassign_rate_ops" sort={sort} onSort={onSort} align="right" />
                  </>
                )}
                <SortHeader label="Reassignment contrib" colKey="unassign_contribution_pp" sort={sort} onSort={onSort} align="right" />
                <SortHeader label="Share" colKey="share_of_unassigns" sort={sort} onSort={onSort} align="right" />
                <SortHeader label="Avg prep" colKey="avg_prep_min" sort={sort} onSort={onSort} align="right" />
                <SortHeader label="Prep error" colKey="avg_prep_error_min" sort={sort} onSort={onSort} align="right" tooltip="Average gap between the venue's initial pickup ETA (its prep-time promise) and the actual ready time, over the period. + = ready later than promised." />
                <SortHeader label="Pickup svc" colKey="avg_pickup_service_sec" sort={sort} onSort={onSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {visible.map((v, i) => {
                const key = venueKey(v);
                const isSelected = key === selectedVenue;
                const hasCoords = v.venue_lat != null && v.venue_long != null;
                return (
                <tr
                  key={key}
                  onClick={() => toggleSelectedVenue(key)}
                  title={hasCoords ? "Show this venue on the map" : "No coordinates to plot on the map"}
                  className={`cursor-pointer border-b border-[var(--color-border)]/50 transition-colors ${
                    isSelected
                      ? "bg-teal-500/15 ring-1 ring-inset ring-teal-500/50"
                      : "hover:bg-[var(--color-surface-hover)]"
                  }`}
                >
                  <td className="px-3 py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={v.venue_id != null && inspectSet.has(String(v.venue_id))}
                      disabled={v.venue_id == null}
                      onChange={() => v.venue_id != null && toggleInspect(String(v.venue_id))}
                      className="h-3.5 w-3.5 cursor-pointer accent-teal-500 align-middle disabled:cursor-not-allowed disabled:opacity-40"
                      title={v.venue_id != null ? "Focus map + Orders on this venue" : "No venue id — can't inspect"}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-xs tabular-nums text-[var(--color-text-muted)]">{i + 1}</td>
                  <td className="px-3 py-1.5 text-sm text-[var(--color-text)]">{v.venue_name}</td>
                  <td className="px-3 py-1.5 text-xs text-[var(--color-text-muted)]">{fmtVenueType(v.venue_type)}</td>
                  <td className="px-3 py-1.5 text-xs text-[var(--color-text-muted)]">{v.account_manager ?? "—"}</td>
                  <td className="px-3 py-1.5 text-right text-sm tabular-nums text-[var(--color-text)]">{v.order_count.toLocaleString()}</td>
                  <td className={`px-3 py-1.5 text-right text-sm font-semibold tabular-nums ${ttlaColorClass(v.avg_ttla_sec, ttlaRef)}`}>
                    {fmtSec(v.avg_ttla_sec)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-sm font-semibold tabular-nums text-amber-400">
                    {fmtImpactPct(v.ttla_impact_pct)}
                  </td>
                  <td className={`px-3 py-1.5 text-right text-sm font-semibold tabular-nums ${unassignColorClass(v.unassign_rate, groupUnassignRate)}`}>
                    {fmtPct(v.unassign_rate)}
                  </td>
                  {showBreakdown && (
                    <>
                      <td className="px-3 py-1.5 text-right text-xs tabular-nums text-[var(--color-text-muted)]">{fmtPct(v.unassign_rate_courier)}</td>
                      <td className="px-3 py-1.5 text-right text-xs tabular-nums text-[var(--color-text-muted)]">{fmtPct(v.unassign_rate_ops)}</td>
                    </>
                  )}
                  <td className="px-3 py-1.5 text-right text-sm font-semibold tabular-nums text-sky-400" title="Contribution to the segment's city reassignment rate (percentage points)">
                    {fmtPp(v.unassign_contribution_pp)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-sm tabular-nums text-[var(--color-text-muted)]">{fmtPct(v.share_of_unassigns)}</td>
                  <td className="px-3 py-1.5 text-right text-sm tabular-nums text-[var(--color-text-muted)]">{fmtMin(v.avg_prep_min)}</td>
                  <td className={`px-3 py-1.5 text-right text-sm tabular-nums ${errColorClass(v.avg_prep_error_min)}`}>{fmtErrMin(v.avg_prep_error_min)}</td>
                  <td className="px-3 py-1.5 text-right text-sm tabular-nums text-[var(--color-text-muted)]">{fmtSec(v.avg_pickup_service_sec)}</td>
                </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={colSpan} className="px-3 py-10 text-center text-sm text-[var(--color-text-muted)]">
                    No data
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {sorted.length > COLLAPSED_ROWS && (
          <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
            <span>
              Showing {Math.min(expanded ? sorted.length : COLLAPSED_ROWS, sorted.length).toLocaleString()} of {sorted.length.toLocaleString()} {SEGMENT_LABEL[segment].toLowerCase()} venues
            </span>
            <button
              onClick={() => setExpanded((e) => !e)}
              className="h-7 rounded-md bg-[var(--color-primary)] px-2.5 text-xs font-medium text-white transition-colors hover:bg-[var(--color-primary-dark)]"
            >
              {expanded ? "Show less" : `Show all ${sorted.length.toLocaleString()}`}
            </button>
          </div>
        )}

        <p className="text-[11px] text-[var(--color-text-muted)]">
          <b>Accept latency impact</b> = orders × (venue avg Accept latency − segment city avg Accept latency), as a % of the segment's total
          Accept latency-seconds. <b>Reassignment rate</b> = share of the venue's orders unassigned by a courier or ops (total;
          the courier/ops breakdown overlaps so it doesn't sum to the total). <b>Reassignment contrib</b> (Express partner) =
          the venue's contribution to the segment's city reassignment rate in percentage points (fix this venue → the
          segment rate drops by this much). <b>Share</b> = % of the segment's unassigns from this venue. Metrics
          use per-segment city denominators. Venues with fewer than the min-order guard are excluded.
        </p>
      </section>
    </div>
  );
}
