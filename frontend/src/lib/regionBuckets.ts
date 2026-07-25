// Region tab helpers: bucket each country's daily rows into day/week/month
// columns, derive rates from SUMMED counts (never averaged daily %), flag
// per-bucket statistical outliers (IQR fence), and compute each country's
// "regional influence" = its share of the regional total numerator.
//
// Most metrics are a count or a rate (numerator/denominator). ADT (Average
// Delivery Time) is a third kind, "average": an ORDER-WEIGHTED MEAN where the
// row carries Σ(delivery minutes) as the numerator and the delivery-order count
// as the denominator, so ADT = num/den (minutes) and aggregates correctly by
// summing both num and den across days/cities/countries (Σ minutes / Σ orders).
// For averages, "influence" is the order-volume share (the weight a country/city
// carries in the order-weighted mean), not a numerator share, and city ranking is
// by ADT (slowest first) rather than by influence.
import type { RegionCountry, RegionCityBreakdown } from "../types";
import { MONTHS } from "./calendar";

export type Granularity = "day" | "week" | "month";
export type MetricKind = "count" | "rate" | "average";
export type MetricSource =
  | "daily_rates_total"
  | "hl_lateness_total"
  | "clone_rate_total"
  | "adt_total"
  | "ttla_total";
export type MetricId = "orders" | "lateness" | "rotten" | "heavy" | "large" | "clone" | "adt" | "ttla";

export interface MetricConfig {
  id: MetricId;
  label: string;
  short: string;
  kind: MetricKind;
  source: MetricSource;
  /** Numerator / count field on the source row. Also the influence numerator. */
  numField: string;
  /** Denominator field for rate metrics (omitted for counts). */
  denField?: string;
  /** True when the denominator is a sub-population (heavy/large deliveries)
   *  rather than total orders, so the count display shows numerator AND
   *  denominator (the denominator isn't already visible as Total Orders). */
  denIsSubpopulation?: boolean;
  /** Accent color for the metric (also used for KPI + outlier tint). */
  color: string;
  /** Direction that is "bad" and gets reddened. Counts use neutral both-side. */
  direction: "high" | "both";
  /** Display unit for an "average" metric: ADT is "min", Accept latency is "sec". Drives
   *  value formatting + the unit labels; ignored for count/rate metrics. */
  unit?: "min" | "sec";
  description: string;
}

// The Region metrics. Influence numerator is `numField` for every metric
// (orders->total_orders, lateness->late_count, rotten->rotten_count,
// heavy->heavy_late, large->large_late, clone->cloned_count). The two "average"
// metrics (ADT, Accept latency) are order-weighted means — see cellValue/influence below.
export const REGION_METRICS: MetricConfig[] = [
  {
    id: "orders", label: "Completed jobs", short: "Jobs", kind: "count",
    source: "daily_rates_total", numField: "total_orders",
    color: "#64748b", direction: "both",
    description: "Delivered jobs in the selected window (excluded categories omitted).",
  },
  {
    id: "lateness", label: "SLA breach share", short: "Breach %", kind: "rate",
    source: "daily_rates_total", numField: "late_count", denField: "total_orders",
    color: "#ef4444", direction: "high",
    description: "Share of jobs breaching the service-level promise (synthetic breach flag).",
  },
  {
    id: "rotten", label: "Queue aging share", short: "Aging %", kind: "rate",
    source: "daily_rates_total", numField: "rotten_count", denField: "total_orders",
    color: "#a855f7", direction: "high",
    description: "Jobs waiting longer than the accept-queue threshold before assignment.",
  },
  {
    id: "heavy", label: "Tier A breach share", short: "Tier A %", kind: "rate",
    source: "hl_lateness_total", numField: "heavy_late", denField: "heavy_count",
    denIsSubpopulation: true,
    color: "#f97316", direction: "high",
    description: "Breach share within tier-A (oversize) jobs.",
  },
  {
    id: "large", label: "Tier B breach share", short: "Tier B %", kind: "rate",
    source: "hl_lateness_total", numField: "large_late", denField: "large_count",
    denIsSubpopulation: true,
    color: "#eab308", direction: "high",
    description: "Breach share within tier-B (oversize) jobs.",
  },
  {
    id: "clone", label: "Redispatch share", short: "Redispatch %", kind: "rate",
    source: "clone_rate_total", numField: "cloned_count", denField: "total_orders",
    color: "#06b6d4", direction: "high",
    description: "Share of jobs fulfilled via a secondary dispatch leg.",
  },
  {
    id: "adt", label: "Mean cycle time", short: "Cycle", kind: "average",
    source: "adt_total", numField: "delivery_min_sum", denField: "delivery_order_count",
    color: "#3b82f6", direction: "high", unit: "min",
    description:
      "Order-weighted mean end-to-end cycle time in minutes. Lower is faster.",
  },
  {
    id: "ttla", label: "Mean accept latency", short: "Accept", kind: "average",
    source: "ttla_total", numField: "ttla_sec_sum", denField: "ttla_order_count",
    color: "#14b8a6", direction: "high", unit: "sec",
    description:
      "Order-weighted mean seconds until the assigned field unit accepts the job. Lower is faster.",
  },
];

export interface BucketColumn {
  key: string;       // identity / sort key
  label: string;     // compact display label
  startDate: string; // earliest YYYY-MM-DD in the bucket (for ordering)
}

export interface Cell {
  num: number;
  den: number;
  value: number | null; // count value, or rate as 0..100, null when no denominator
}

export interface RegionRow {
  code: string;
  name: string;
  cells: Map<string, Cell>;
  windowNum: number;
  windowDen: number;
  windowValue: number | null;
  influence: number; // 0..100, share of regional window numerator
  /** Accept latency-only: the per-country target (seconds) this row's value is coloured
   *  against (cities inherit their COUNTRY target). null/undefined = unset. */
  target?: number | null;
}

export interface OutlierFlag {
  side: "high" | "low";
  severity: number; // 0..1
}

export interface RegionMetricModel {
  metric: MetricConfig;
  buckets: BucketColumn[];
  rows: RegionRow[];
  regional: {
    cells: Map<string, Cell>;
    windowNum: number;
    windowDen: number;
    windowValue: number | null;
  };
  // key = `${code}|${bucketKey}`
  outliers: Map<string, OutlierFlag>;
}

// --- bucket keys -----------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** ISO-8601 week key, e.g. "2026-W12" (weeks start Monday, Thursday rule). */
function isoWeekKey(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const dayNr = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  // Shift to the Thursday of the current ISO week.
  d.setUTCDate(d.getUTCDate() - dayNr + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${pad(week)}`;
}

export function bucketKey(dateStr: string, g: Granularity): string {
  if (g === "day") return dateStr;
  if (g === "month") return dateStr.slice(0, 7); // YYYY-MM
  return isoWeekKey(dateStr);
}

function bucketLabel(key: string, startDate: string, g: Granularity): string {
  if (g === "day") return startDate.slice(5); // MM-DD
  if (g === "month") {
    const m = Number(startDate.slice(5, 7));
    return `${MONTHS[m - 1]} '${startDate.slice(2, 4)}`;
  }
  // week: show the week's Monday as MM-DD plus the ISO week number
  return `${startDate.slice(5)} (${key.slice(5)})`;
}

// --- stats -----------------------------------------------------------------

function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = base + 1 < n ? sorted[base + 1] : sorted[base];
  return sorted[base] + (next - sorted[base]) * rest;
}

/**
 * IQR-fence outliers over a set of {code,value} for one bucket column.
 * Needs >= 4 data points. `direction:"high"` flags only the upper fence
 * (bad/red metrics); `direction:"both"` flags both tails (neutral context).
 */
function fenceFlags(
  points: { code: string; value: number }[],
  direction: "high" | "both"
): Map<string, OutlierFlag> {
  const out = new Map<string, OutlierFlag>();
  if (points.length < 4) return out;
  const sorted = points.map((p) => p.value).slice().sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  if (iqr <= 0) return out;
  const upper = q3 + 1.5 * iqr;
  const lower = q1 - 1.5 * iqr;
  for (const p of points) {
    if (p.value > upper) {
      out.set(p.code, { side: "high", severity: Math.min(1, (p.value - upper) / (1.5 * iqr)) });
    } else if (direction === "both" && p.value < lower) {
      out.set(p.code, { side: "low", severity: Math.min(1, (lower - p.value) / (1.5 * iqr)) });
    }
  }
  return out;
}

// --- main builder ----------------------------------------------------------

function cellValue(kind: MetricKind, num: number, den: number): number | null {
  if (kind === "count") return num;
  // Average (ADT): order-weighted mean = Σ minutes / Σ orders, in minutes.
  if (kind === "average") return den > 0 ? num / den : null;
  // Rate: 0..100 percent.
  return den > 0 ? (num / den) * 100 : null;
}

export function buildMetricModel(
  metric: MetricConfig,
  countries: RegionCountry[],
  g: Granularity
): RegionMetricModel {
  const bucketMeta = new Map<string, string>(); // key -> earliest date
  const rows: RegionRow[] = [];
  const regionalCells = new Map<string, Cell>();
  let regionalWindowNum = 0;
  let regionalWindowDen = 0;

  for (const c of countries) {
    const source = (c[metric.source] ?? []) as unknown as Array<Record<string, unknown>>;
    const cells = new Map<string, Cell>();
    let windowNum = 0;
    let windowDen = 0;

    for (const raw of source) {
      const date = String(raw["confirmed_date"] ?? "");
      if (!date) continue;
      const num = Number(raw[metric.numField] ?? 0);
      const den = metric.denField ? Number(raw[metric.denField] ?? 0) : 0;
      const key = bucketKey(date, g);

      const prevDate = bucketMeta.get(key);
      if (prevDate === undefined || date < prevDate) bucketMeta.set(key, date);

      const cell = cells.get(key) ?? { num: 0, den: 0, value: null };
      cell.num += num;
      cell.den += den;
      cells.set(key, cell);

      windowNum += num;
      windowDen += den;

      const rc = regionalCells.get(key) ?? { num: 0, den: 0, value: null };
      rc.num += num;
      rc.den += den;
      regionalCells.set(key, rc);
    }

    for (const cell of cells.values()) cell.value = cellValue(metric.kind, cell.num, cell.den);

    regionalWindowNum += windowNum;
    regionalWindowDen += windowDen;

    rows.push({
      code: c.code,
      name: c.name,
      cells,
      windowNum,
      windowDen,
      windowValue: cellValue(metric.kind, windowNum, windowDen),
      influence: 0, // filled after regional totals are known
      // Accept latency carries a per-country target so its value can be coloured good/bad
      // (mirrors the Country tab's TtlaPanel). Other metrics leave it undefined.
      target: metric.id === "ttla" ? c.ttla_target_sec ?? null : undefined,
    });
  }

  for (const cell of regionalCells.values()) cell.value = cellValue(metric.kind, cell.num, cell.den);

  // Influence = share of the regional window total. For counts/rates that is the
  // numerator share. For an average (ADT) the numerator is summed minutes, which
  // is not a meaningful "share", so influence is the ORDER-VOLUME share (windowDen)
  // — the weight this country carries in the regional order-weighted mean.
  const inflTotal = metric.kind === "average" ? regionalWindowDen : regionalWindowNum;
  for (const r of rows) {
    const inflNum = metric.kind === "average" ? r.windowDen : r.windowNum;
    r.influence = inflTotal > 0 ? (inflNum / inflTotal) * 100 : 0;
  }

  const buckets: BucketColumn[] = [...bucketMeta.entries()]
    .map(([key, startDate]) => ({ key, startDate, label: bucketLabel(key, startDate, g) }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  // Per-bucket outlier flags across countries.
  const outliers = new Map<string, OutlierFlag>();
  for (const b of buckets) {
    const points: { code: string; value: number }[] = [];
    for (const r of rows) {
      const cell = r.cells.get(b.key);
      if (cell && cell.value !== null) points.push({ code: r.code, value: cell.value });
    }
    const flags = fenceFlags(points, metric.direction);
    for (const [code, flag] of flags) outliers.set(`${code}|${b.key}`, flag);
  }

  return {
    metric,
    buckets,
    rows,
    regional: {
      cells: regionalCells,
      windowNum: regionalWindowNum,
      windowDen: regionalWindowDen,
      windowValue: cellValue(metric.kind, regionalWindowNum, regionalWindowDen),
    },
    outliers,
  };
}

// --- city drill-down -------------------------------------------------------

/** Aggregate "Other (N cities)" row: a city sub-row in the country expansion. */
export const CITY_OTHER_CODE = "__other__";

/** How many cities are shown for a rate metric before the "show all" toggle. */
export const CITY_TOP_N = 10;

export interface CityBreakdownModel {
  metric: MetricConfig;
  /** Visible city rows, ranked by influence desc (share of the country total). */
  rows: RegionRow[];
  /** Aggregate of the cities not shown so visible rows reconcile to the country. */
  other: RegionRow | null;
  /** Per-bucket IQR outlier flags across cities, key = `${city}|${bucketKey}`. */
  outliers: Map<string, OutlierFlag>;
  totalCities: number;
  hiddenCount: number;
  /** True for rate metrics with more cities than CITY_TOP_N (toggle available). */
  hasMore: boolean;
}

/** Sum a set of city rows into a single aggregate row (per-bucket + window). */
function aggregateRows(
  rows: RegionRow[],
  metric: MetricConfig,
  code: string,
  name: string
): RegionRow {
  const cells = new Map<string, Cell>();
  let windowNum = 0;
  let windowDen = 0;
  let influence = 0;
  for (const r of rows) {
    windowNum += r.windowNum;
    windowDen += r.windowDen;
    influence += r.influence;
    for (const [k, c] of r.cells) {
      const agg = cells.get(k) ?? { num: 0, den: 0, value: null };
      agg.num += c.num;
      agg.den += c.den;
      cells.set(k, agg);
    }
  }
  for (const c of cells.values()) c.value = cellValue(metric.kind, c.num, c.den);
  return {
    code,
    name,
    cells,
    windowNum,
    windowDen,
    windowValue: cellValue(metric.kind, windowNum, windowDen),
    influence,
    // Hidden cities share the same country Accept latency target, so the "Other" aggregate
    // is coloured against it too (harmless/undefined for non-Accept latency metrics).
    target: rows[0]?.target,
  };
}

/**
 * Order cities by INFLUENCE (share of the country-total numerator) DESC so the
 * largest contributor is first for every metric. Tiebreaks: raw window
 * numerator DESC, then city name ASC, for a fully stable order. (Influence is
 * the window numerator over a constant country-total denominator, so the
 * numerator tiebreak only ever matters under floating-point equality.)
 */
function compareCityInfluence(a: RegionRow, b: RegionRow): number {
  if (b.influence !== a.influence) return b.influence - a.influence;
  if (b.windowNum !== a.windowNum) return b.windowNum - a.windowNum;
  return a.name.localeCompare(b.name);
}

/**
 * Order cities for an AVERAGE metric (ADT) by the average VALUE descending —
 * slowest first — since a numerator "share" is meaningless for a mean. Tiebreaks:
 * order volume (windowDen) DESC, then city name ASC. Cities with no qualifying
 * orders (windowValue null) sort last.
 */
function compareCityAverage(a: RegionRow, b: RegionRow): number {
  const av = a.windowValue ?? -Infinity;
  const bv = b.windowValue ?? -Infinity;
  if (bv !== av) return bv - av;
  if (b.windowDen !== a.windowDen) return b.windowDen - a.windowDen;
  return a.name.localeCompare(b.name);
}

/**
 * Build a country's city drill-down for one metric. Cities mirror the
 * RegionCountry shape (city in place of code/name), so `buildMetricModel`
 * computes each city's cells, window value, influence (= share of the COUNTRY
 * total, since `regional` here is the country) and per-bucket outliers for free.
 *
 * Ranking: EVERY metric orders cities by INFLUENCE (share of the country-total
 * numerator) descending — largest contributor first — with raw-numerator then
 * city-name tiebreaks (see `compareCityInfluence`). Rate metrics are shown
 * top-10 with a "show all" toggle; Total Orders shows ALL cities (same
 * influence-desc order, which equals volume desc). An "Other (N cities)"
 * aggregate captures any hidden cities so the visible rows reconcile to the
 * country row.
 */
export function buildCityBreakdown(
  metric: MetricConfig,
  breakdown: RegionCityBreakdown,
  g: Granularity,
  showAll: boolean
): CityBreakdownModel {
  const asCountries: RegionCountry[] = breakdown.cities.map((c) => ({
    code: c.city,
    name: c.city,
    daily_rates_total: c.daily_rates_total,
    hl_lateness_total: c.hl_lateness_total,
    clone_rate_total: c.clone_rate_total,
    adt_total: c.adt_total,
    ttla_total: c.ttla_total,
    // Cities compare their Accept latency against the COUNTRY target (the reference the
    // backend exposes once at the top level), so each city inherits it.
    ttla_target_sec: breakdown.ttla_target_sec,
  }));

  const model = buildMetricModel(metric, asCountries, g);

  // Ranking. Count/rate metrics order cities by influence (share of the
  // country-total numerator) descending — largest contributor first. An AVERAGE
  // (ADT) has no meaningful numerator share, so it ranks by the ADT value
  // descending (slowest city first); each city still shows its order-weighted
  // contribution (influence = order-volume share) and order count. The same
  // ordering drives both the top-N selection and the displayed rows.
  const ranked = [...model.rows].sort(
    metric.kind === "average" ? compareCityAverage : compareCityInfluence,
  );

  // Total Orders (count) shows ALL cities; rate and average metrics show the
  // top-N with a "show all" toggle. An "Other (N cities)" aggregate captures the
  // hidden cities so the visible rows reconcile to the country row (for ADT this
  // is the order-weighted mean of the hidden cities).
  const cap = metric.kind !== "count" && !showAll ? CITY_TOP_N : ranked.length;
  const visible = ranked.slice(0, cap);
  const hidden = ranked.slice(cap);
  const hiddenCount = hidden.length;

  const other =
    hiddenCount > 0
      ? aggregateRows(
          hidden,
          metric,
          CITY_OTHER_CODE,
          `Other (${hiddenCount} ${hiddenCount === 1 ? "city" : "cities"})`
        )
      : null;

  return {
    metric,
    rows: visible,
    other,
    outliers: model.outliers,
    totalCities: ranked.length,
    hiddenCount,
    hasMore: metric.kind !== "count" && ranked.length > CITY_TOP_N,
  };
}

// --- formatting ------------------------------------------------------------

export function formatValue(metric: MetricConfig, value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  if (metric.kind === "count") return Math.round(value).toLocaleString();
  if (metric.kind === "average") {
    // Accept latency is whole seconds (sub-second precision is noise on an accept latency);
    // ADT is minutes with one decimal. Both share the "average" kind.
    return metric.unit === "sec"
      ? `${Math.round(value).toLocaleString()} s`
      : `${value.toFixed(1)} min`;
  }
  return `${value.toFixed(1)}%`;
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString();
}

/**
 * Secondary "count" line shown beside a rate/average metric's value (window/own
 * column, regional aggregate, KPI strip). For rates: the numerator with thousands
 * separators, plus the denominator for sub-population metrics (heavy/large, where
 * the denominator is the heavy/large sub-population rather than total orders). For
 * an average (ADT): the order count it is averaged over (the denominator), tagged
 * "orders" to distinguish it from the minutes value. Returns null for count
 * metrics — the value itself is already a count.
 */
export function formatRateCount(metric: MetricConfig, num: number, den: number): string | null {
  if (metric.kind === "count") return null;
  if (metric.kind === "average") return `${formatCount(den)} orders`;
  return metric.denIsSubpopulation
    ? `${formatCount(num)} / ${formatCount(den)}`
    : formatCount(num);
}

// --- Accept latency target coloring (shared with the Country tab's TtlaPanel logic) ---

export interface TtlaTargetStatus {
  /** True when a finite target exists to compare against. */
  hasTarget: boolean;
  /** True when the value is over (worse than) the target. */
  overTarget: boolean;
  /** Tailwind text-color class for the value, or null when no target coloring
   *  applies (no target or no value → render plain). */
  colorClass: string | null;
  /** value − target (seconds), or null when either is missing. */
  deltaSec: number | null;
}

/**
 * Compare a Accept latency value (seconds) against a target, mirroring the Country tab's
 * `TtlaPanel`: higher Accept latency = slower to accept = bad, so at/under target is good
 * (emerald) and over target is bad (red). With no target (or no value) the value
 * renders plain (colorClass null) — the null/unset case the config placeholder
 * relies on.
 */
export function ttlaTargetStatus(value: number | null, target?: number | null): TtlaTargetStatus {
  const hasTarget = target != null && Number.isFinite(target);
  const overTarget = hasTarget && value != null && value > (target as number);
  const colorClass =
    !hasTarget || value == null ? null : overTarget ? "text-red-400" : "text-emerald-400";
  const deltaSec = hasTarget && value != null ? value - (target as number) : null;
  return { hasTarget, overTarget, colorClass, deltaSec };
}

/** Compact Accept latency target label for dense table cells, e.g. "174s". */
export function formatTargetSec(target: number): string {
  return `${Math.round(target)}s`;
}
