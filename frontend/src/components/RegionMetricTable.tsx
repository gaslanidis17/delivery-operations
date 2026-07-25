import { Fragment, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowUpDown,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  ChevronDown,
  Loader2,
} from "lucide-react";
import type {
  MetricConfig,
  OutlierFlag,
  RegionMetricModel,
  RegionRow,
  Granularity,
} from "../lib/regionBuckets";
import {
  formatValue,
  formatRateCount,
  buildCityBreakdown,
  CITY_TOP_N,
  ttlaTargetStatus,
  formatTargetSec,
} from "../lib/regionBuckets";
import type { RegionCityBreakdown } from "../types";
import type { TtlaMode } from "../types";

export type CityState = RegionCityBreakdown | "loading" | "error";

// Accept latency calculation-logic modes for the Region tab's Accept latency panel — the SAME three
// modes the Accept latency tab + Country tab expose (default | 1st courier | fixed). The
// control is rendered INSIDE the Accept latency metric panel's header (not the top filter
// bar), so only the Accept latency table passes the props below. Mirrors the Country tab's
// ACCEPT_LATENCY_MODE_OPTIONS (labels/titles kept in sync).
const ACCEPT_LATENCY_MODE_OPTIONS: { value: TtlaMode; label: string; title: string }[] = [
  {
    value: "default",
    label: "Default",
    title:
      "Combined Accept latency: last pickup-accept minus the order's first task-shown (includes idle gaps on reassigns / splits). Current behavior.",
  },
  {
    value: "first_courier",
    label: "1st courier",
    title:
      "Accept latency of the 1st (original) task group only — the courier shown the task first. Isolates that courier's accept speed (no upstream idle gap).",
  },
  {
    value: "fixed",
    label: "Fixed",
    title:
      "Average of all couriers' per-task Accept latency on the order (each courier's own accept time, idle gaps excluded).",
  },
];

interface Props {
  model: RegionMetricModel;
  granularity: Granularity;
  /** Lazily fetch (once, shared across all six tables) a country's cities. */
  getCities: (code: string) => void;
  /** Shared per-country city data keyed by country code. */
  citiesData: Map<string, CityState>;
  /** Accept latency-calculation-logic mode (default | 1st courier | fixed). Only the Accept latency
   *  table passes this + onTtlaModeChange; others leave them undefined so no
   *  control renders. */
  ttlaMode?: TtlaMode;
  onTtlaModeChange?: (mode: TtlaMode) => void;
}

type SortKey = "influence" | "own" | "name";
type SortDir = "asc" | "desc";

function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Cell text: rate metrics show 1-decimal (header carries the %), counts compact. */
function cellText(metric: MetricConfig, value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  if (metric.kind === "count") return compact(value);
  // Accept latency (average, unit "sec") shows whole seconds; ADT + rates show 1 decimal.
  if (metric.kind === "average" && metric.unit === "sec") return String(Math.round(value));
  return value.toFixed(1);
}

/**
 * Compact secondary count for a dense bucket cell: the numerator (k/M
 * compacted), plus the denominator for sub-population metrics (heavy/large).
 * For an average (ADT) it is the order count the mean is taken over (den).
 * Null for count metrics — the cell value is already the count.
 */
function cellCountText(metric: MetricConfig, num: number, den: number): string | null {
  if (metric.kind === "count") return null;
  if (metric.kind === "average") return compact(den);
  return metric.denIsSubpopulation ? `${compact(num)}/${compact(den)}` : compact(num);
}

/** Outlier tint: red for bad (high) rate metrics, neutral indigo for counts. */
function outlierBg(metric: MetricConfig, flag?: OutlierFlag): string | undefined {
  if (!flag) return undefined;
  const a = 0.14 + flag.severity * 0.46;
  if (metric.kind === "count") return `rgba(99,102,241,${a.toFixed(3)})`;
  return `rgba(239,68,68,${a.toFixed(3)})`;
}

function InfluenceBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <span className="h-1.5 w-8 overflow-hidden rounded-full bg-[var(--color-border)]">
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.min(100, value)}%`, backgroundColor: color }}
        />
      </span>
      <span className="w-9">{value.toFixed(1)}%</span>
    </div>
  );
}

/**
 * Window / aggregate "own rate" cell: the rate (or count) on top with a compact
 * secondary count line beneath — the numerator, plus the denominator for
 * sub-population metrics (heavy/large). Count metrics show only the value.
 */
function WindowCell({
  metric,
  value,
  num,
  den,
  target,
}: {
  metric: MetricConfig;
  value: number | null;
  num: number;
  den: number;
  /** Accept latency-only target (seconds); colours the value good/bad + shows a target
   *  line (mirrors the Country tab's TtlaPanel). null/undefined ⇒ plain value. */
  target?: number | null;
}) {
  const count = value === null ? null : formatRateCount(metric, num, den);
  const status = metric.id === "ttla" ? ttlaTargetStatus(value, target) : null;
  return (
    <div className="leading-tight">
      <div className={status?.colorClass ?? undefined}>{formatValue(metric, value)}</div>
      {count !== null && (
        <div className="text-[9px] font-normal text-[var(--color-text-muted)] whitespace-nowrap">
          {count}
        </div>
      )}
      {status?.hasTarget && (
        <div className="text-[9px] font-normal text-[var(--color-text-muted)] whitespace-nowrap">
          target {formatTargetSec(target as number)}
          {status.deltaSec != null && (
            <span className={status.overTarget ? "text-red-400" : "text-emerald-400"}>
              {" "}({status.deltaSec > 0 ? "+" : ""}{Math.round(status.deltaSec)}s)
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function RegionMetricTable({ model, granularity, getCities, citiesData, ttlaMode, onTtlaModeChange }: Props) {
  const { metric, buckets, rows, regional, outliers } = model;
  const regionCount =
    regional.windowValue === null
      ? null
      : formatRateCount(metric, regional.windowNum, regional.windowDen);
  // Averages (ADT) default to sorting by their own value (slowest first), since
  // an influence/numerator share is not the natural ordering for a mean.
  const [sortKey, setSortKey] = useState<SortKey>(metric.kind === "average" ? "own" : "influence");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAllCodes, setShowAllCodes] = useState<Set<string>>(new Set());

  // Re-fetch expanded countries whose city data is missing — e.g. after the
  // shared map is invalidated on a window change (the row stays expanded).
  useEffect(() => {
    for (const code of expanded) {
      if (!citiesData.has(code)) getCities(code);
    }
  }, [expanded, citiesData, getCities]);

  const sortedRows = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") cmp = a.name.localeCompare(b.name);
      else if (sortKey === "own") cmp = (a.windowValue ?? -1) - (b.windowValue ?? -1);
      else cmp = a.influence - b.influence;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [rows, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const toggleExpand = (code: string) => {
    const willExpand = !expanded.has(code);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
    if (willExpand) getCities(code);
  };

  const toggleShowAll = (code: string) => {
    setShowAllCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return <ArrowUpDown size={10} className="opacity-40" />;
    return sortDir === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />;
  };

  const unitLabel =
    metric.kind === "count"
      ? "orders"
      : metric.kind === "average"
        ? metric.unit === "sec"
          ? "s"
          : "min"
        : "%";
  const colCount = 3 + buckets.length;

  /** Bucket <td>s for any row, aligned to the COUNTRY model's columns. */
  const renderBucketCells = (
    row: RegionRow,
    outlierMap: Map<string, OutlierFlag>,
    outlierCode: string,
  ) =>
    buckets.map((b) => {
      const cell = row.cells.get(b.key);
      const flag = outlierMap.get(`${outlierCode}|${b.key}`);
      const bg = outlierBg(metric, flag);
      const title = !cell
        ? `${row.name} · ${b.label}: no data`
        : metric.kind === "count"
          ? `${row.name} · ${b.label}: ${cell.num.toLocaleString()} orders`
          : metric.kind === "average"
            ? `${row.name} · ${b.label}: ${cell.value === null ? "—" : formatValue(metric, cell.value)} (${cell.den.toLocaleString()} orders)`
            : `${row.name} · ${b.label}: ${cell.value === null ? "—" : cell.value.toFixed(1) + "%"} (${cell.num.toLocaleString()} / ${cell.den.toLocaleString()})`;
      const countText = cell && cell.value !== null ? cellCountText(metric, cell.num, cell.den) : null;
      return (
        <td
          key={b.key}
          className="px-1.5 py-1 text-center tabular-nums"
          style={{ backgroundColor: bg, fontWeight: flag ? 600 : 400 }}
          title={title}
        >
          {cell ? (
            <>
              <div className="leading-none">{cellText(metric, cell.value)}</div>
              {countText !== null && (
                <div className="mt-0.5 text-[9px] font-normal leading-none text-[var(--color-text-muted)]">
                  {countText}
                </div>
              )}
            </>
          ) : (
            <span className="text-[var(--color-text-muted)]">·</span>
          )}
        </td>
      );
    });

  /** A nested city (or "Other") sub-row beneath an expanded country. */
  const renderCityRow = (
    parentCode: string,
    row: RegionRow,
    cityOutliers: Map<string, OutlierFlag>,
    isOther: boolean,
  ) => (
    <tr
      key={`${parentCode}:${row.code}`}
      className="border-b border-[var(--color-border)]/30 bg-[var(--color-bg)]/20 hover:bg-[var(--color-surface-hover)]/30"
    >
      <td
        className="sticky left-0 z-10 bg-[var(--color-surface)] py-1 pl-8 pr-3 whitespace-nowrap"
        style={{ boxShadow: "inset 2px 0 0 var(--color-border)" }}
      >
        <span
          className={
            isOther
              ? "italic text-[var(--color-text-muted)]"
              : "text-[var(--color-text-muted)]"
          }
        >
          {row.name}
        </span>
      </td>
      <td className="px-2 py-1 text-right tabular-nums text-[var(--color-text-muted)]">
        <WindowCell metric={metric} value={row.windowValue} num={row.windowNum} den={row.windowDen} target={row.target} />
      </td>
      <td
        className="px-2 py-1 text-right tabular-nums border-r border-[var(--color-border)]"
        title={
          metric.kind === "average"
            ? `Share of the country's orders — the city's weight in the country ${metric.short}`
            : "Share of the country total for this metric"
        }
      >
        <InfluenceBar value={row.influence} color={metric.color} />
      </td>
      {renderBucketCells(row, cityOutliers, row.code)}
    </tr>
  );

  /** The full expansion (loading / error / city rows + Other + toggle). */
  const renderExpansion = (code: string, countryName: string) => {
    const state = citiesData.get(code);

    if (state === undefined || state === "loading") {
      return (
        <tr key={`${code}:loading`} className="bg-[var(--color-bg)]/20">
          <td colSpan={colCount} className="px-3 py-2">
            <span className="sticky left-0 inline-flex items-center gap-2 pl-8 text-[var(--color-text-muted)]">
              <Loader2 size={12} className="animate-spin" /> Loading cities for {countryName}…
            </span>
          </td>
        </tr>
      );
    }

    if (state === "error") {
      return (
        <tr key={`${code}:error`} className="bg-red-900/10">
          <td colSpan={colCount} className="px-3 py-2">
            <span className="sticky left-0 inline-flex items-center gap-2 pl-8 text-red-400">
              Failed to load city data.
              <button
                onClick={() => getCities(code)}
                className="underline underline-offset-2 hover:text-red-300"
              >
                Retry
              </button>
            </span>
          </td>
        </tr>
      );
    }

    const showAll = showAllCodes.has(code);
    const bd = buildCityBreakdown(metric, state, granularity, showAll);

    if (bd.totalCities === 0) {
      return (
        <tr key={`${code}:empty`} className="bg-[var(--color-bg)]/20">
          <td colSpan={colCount} className="px-3 py-2">
            <span className="sticky left-0 pl-8 text-[var(--color-text-muted)]">
              No city data for {countryName}.
            </span>
          </td>
        </tr>
      );
    }

    const out: ReactNode[] = bd.rows.map((r) =>
      renderCityRow(code, r, bd.outliers, false),
    );
    if (bd.other) {
      out.push(renderCityRow(code, bd.other, bd.outliers, true));
    }
    if (bd.hasMore) {
      out.push(
        <tr key={`${code}:toggle`} className="bg-[var(--color-bg)]/20">
          <td colSpan={colCount} className="px-3 py-1">
            <button
              onClick={() => toggleShowAll(code)}
              className="sticky left-0 pl-8 text-[10px] font-medium text-[var(--color-primary)] hover:underline"
            >
              {showAll
                ? `Show top ${CITY_TOP_N} cities ${metric.kind === "average" ? `by ${metric.short} (slowest)` : "by influence"}`
                : `Show all ${bd.totalCities} cities`}
            </button>
          </td>
        </tr>,
      );
    }
    return out;
  };

  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: metric.color }} />
          <h3 className="text-sm font-semibold text-[var(--color-text)]">{metric.label}</h3>
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {metric.kind === "count"
              ? "count"
              : metric.kind === "average"
                ? "min — order-weighted mean"
                : "% — summed counts per bucket"}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {/* Accept latency calculation logic — rendered ONLY in the Accept latency panel (the control
              lives inside the panel, not the top filter bar). Threads the selected
              mode back up to the page so the overview + city drill-down re-fetch
              with the new `ttla_mode`. */}
          {metric.id === "ttla" && onTtlaModeChange && (
            <div className="flex items-center gap-2">
              <label
                className="text-[11px] font-medium text-[var(--color-text-muted)]"
                title="How each order's Accept latency is computed for this panel (country + per-city)."
              >
                Accept latency logic
              </label>
              <div className="flex items-center overflow-hidden rounded-md border border-[var(--color-border)]">
                {ACCEPT_LATENCY_MODE_OPTIONS.map((o) => {
                  const active = ttlaMode === o.value;
                  return (
                    <button
                      key={o.value}
                      onClick={() => onTtlaModeChange(o.value)}
                      title={o.title}
                      className={`h-7 px-2 text-[11px] font-medium transition-colors ${
                        active
                          ? "bg-[var(--color-primary)] text-white"
                          : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                      }`}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="text-[10px] text-[var(--color-text-muted)]">
            Region:{" "}
            <span className="font-semibold text-[var(--color-text)]">
              {formatValue(metric, regional.windowValue)}
            </span>
            {regionCount && <span className="ml-1 font-normal">({regionCount})</span>}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11px] text-[var(--color-text)]">
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg)]/40">
              <th
                className="sticky left-0 z-20 cursor-pointer bg-[var(--color-surface)] px-3 py-1.5 text-left font-semibold"
                onClick={() => toggleSort("name")}
                style={{ minWidth: 132 }}
              >
                <span className="inline-flex items-center gap-1">Country <SortIcon k="name" /></span>
              </th>
              <th
                className="cursor-pointer px-2 py-1.5 text-right font-semibold whitespace-nowrap"
                onClick={() => toggleSort("own")}
                title={`Each country's own ${metric.label} over the whole window`}
              >
                <span className="inline-flex items-center gap-1">Own <SortIcon k="own" /></span>
              </th>
              <th
                className="cursor-pointer px-2 py-1.5 text-right font-semibold whitespace-nowrap border-r border-[var(--color-border)]"
                onClick={() => toggleSort("influence")}
                title={
                  metric.kind === "average"
                    ? `Share of the regional orders over the window — the weight this country carries in the order-weighted ${metric.short}`
                    : "Share of the regional total for this metric over the window"
                }
              >
                <span className="inline-flex items-center gap-1">Influence <SortIcon k="influence" /></span>
              </th>
              {buckets.map((b) => (
                <th
                  key={b.key}
                  className="px-1.5 py-1.5 text-center font-medium text-[var(--color-text-muted)] whitespace-nowrap"
                  style={{ minWidth: 46 }}
                  title={b.key}
                >
                  {b.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r) => {
              const isOpen = expanded.has(r.code);
              return (
                <Fragment key={r.code}>
                  <tr className="border-b border-[var(--color-border)]/40 hover:bg-[var(--color-surface-hover)]/40">
                    <td
                      className="sticky left-0 z-10 cursor-pointer bg-[var(--color-surface)] px-3 py-1 font-medium whitespace-nowrap select-none"
                      onClick={() => toggleExpand(r.code)}
                      title={isOpen ? "Collapse cities" : "Expand cities"}
                    >
                      <span className="inline-flex items-center gap-1">
                        {isOpen ? (
                          <ChevronDown size={12} className="text-[var(--color-text-muted)]" />
                        ) : (
                          <ChevronRight size={12} className="text-[var(--color-text-muted)]" />
                        )}
                        {r.name}
                        <span className="ml-0.5 text-[9px] text-[var(--color-text-muted)]">{r.code}</span>
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      <WindowCell metric={metric} value={r.windowValue} num={r.windowNum} den={r.windowDen} target={r.target} />
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums border-r border-[var(--color-border)]">
                      <InfluenceBar value={r.influence} color={metric.color} />
                    </td>
                    {renderBucketCells(r, outliers, r.code)}
                  </tr>
                  {isOpen && renderExpansion(r.code, r.name)}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[var(--color-border)] bg-[var(--color-bg)]/50 font-semibold">
              <td className="sticky left-0 z-10 bg-[var(--color-bg)] px-3 py-1.5 whitespace-nowrap">Region</td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                <WindowCell metric={metric} value={regional.windowValue} num={regional.windowNum} den={regional.windowDen} />
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums border-r border-[var(--color-border)]">100.0%</td>
              {buckets.map((b) => {
                const cell = regional.cells.get(b.key);
                const countText = cell && cell.value !== null ? cellCountText(metric, cell.num, cell.den) : null;
                return (
                  <td key={b.key} className="px-1.5 py-1.5 text-center tabular-nums text-[var(--color-text-muted)]">
                    {cell ? (
                      <>
                        <div className="leading-none">{cellText(metric, cell.value)}</div>
                        {countText !== null && (
                          <div className="mt-0.5 text-[9px] font-normal leading-none opacity-80">{countText}</div>
                        )}
                      </>
                    ) : (
                      "·"
                    )}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex items-center gap-3 px-4 py-2 text-[10px] text-[var(--color-text-muted)]">
        <span>{metric.description}</span>
        <span className="ml-auto inline-flex items-center gap-1">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: metric.kind === "count" ? "rgba(99,102,241,0.5)" : "rgba(239,68,68,0.5)" }}
          />
          {metric.kind === "count" ? "statistical outlier (high/low)" : "statistically high (IQR outlier)"} · cell values in {unitLabel}
        </span>
      </div>
    </div>
  );
}
