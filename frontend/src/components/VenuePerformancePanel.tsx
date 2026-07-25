import { useState, useEffect, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Store,
  AlertTriangle,
  TrendingUp,
  Clock,
  Download,
  X,
  ExternalLink,
} from "lucide-react";
import { fetchVenuePerformance } from "../api/client";
import type { VenuePerformanceData, VenuePerformance, LateOrder } from "../types";

interface Props {
  city: string;
  lookbackDays: number;
  sizeFilter?: string;
  lateOrders?: LateOrder[];
}

function fmt(v: number | null | undefined, suffix = ""): string {
  if (v == null) return "—";
  return `${v}${suffix}`;
}

function downloadCsv(venues: VenuePerformance[], city: string) {
  const headers = [
    "Venue ID",
    "Venue Name",
    "Type",
    "Orders",
    "Late",
    "Late %",
    "Queue aging",
    "Aging %",
    "Venue Late",
    "Venue Early",
    "V. Impact %",
    "Venue Late Share %",
    "Avg Accept latency (sec)",
    "Avg Prep (min)",
    "Avg Completion (min)",
    "Score",
  ];
  const rows = venues.map((v) => [
    v.venue_id,
    `"${(v.venue_name ?? "").replace(/"/g, '""')}"`,
    v.venue_vertical ?? "",
    v.total_orders,
    v.late_orders,
    v.late_pct,
    v.delayed_orders,
    v.rotten_pct,
    v.venue_late_count,
    v.venue_early_count,
    v.total_orders > 0 ? Math.round(((v.venue_late_count + v.venue_early_count) / v.total_orders) * 1000) / 10 : 0,
    v.venue_late_share,
    v.avg_ttla_sec ?? "",
    v.avg_prep_time_min ?? "",
    v.avg_completion_min ?? "",
    v.problem_score,
  ]);
  const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `venue_performance_${city}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function VenueOrdersModal({
  venueId,
  venueName,
  orders,
  onClose,
}: {
  venueId: string;
  venueName: string;
  orders: LateOrder[];
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="relative mx-4 max-h-[80vh] w-full max-w-4xl overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text)]">
              Late Orders for Venue
            </h3>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              <span className="font-semibold">{venueName}</span>
              <span className="ml-2 font-mono text-[10px]">({venueId})</span>
              <span className="ml-2">{orders.length} late orders</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg)]/50 hover:text-[var(--color-text)]"
          >
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[65vh] overflow-y-auto p-4">
          {orders.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-xs text-[var(--color-text-muted)]">
              No late orders found for this venue in current filters
            </div>
          ) : (
            <table className="w-full text-xs text-[var(--color-text)]">
              <thead className="sticky top-0 bg-[var(--color-surface)]">
                <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
                  <th className="px-2 py-1.5 text-left font-medium">Order ID</th>
                  <th className="px-2 py-1.5 text-left font-medium">Date</th>
                  <th className="px-2 py-1.5 text-right font-medium">Completion</th>
                  <th className="px-2 py-1.5 text-right font-medium">Estimate</th>
                  <th className="px-2 py-1.5 text-right font-medium">Over Est.</th>
                  <th className="px-2 py-1.5 text-left font-medium">Vehicle</th>
                  <th className="px-2 py-1.5 text-center font-medium">Link</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const overEstimate =
                    o.completion_time_min != null && o.pre_estimate_high != null
                      ? Math.round((o.completion_time_min - o.pre_estimate_high) * 100) / 100
                      : null;
                  return (
                  <tr
                    key={o.purchase_id}
                    className="border-b border-[var(--color-border)]/30 hover:bg-[var(--color-bg)]/50"
                  >
                    <td className="px-2 py-1.5 font-mono text-[10px]">{o.purchase_id}</td>
                    <td className="px-2 py-1.5">{o.delivered_date}</td>
                    <td className="px-2 py-1.5 text-right">
                      {o.completion_time_min != null ? `${Math.round(o.completion_time_min * 100) / 100} min` : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {o.pre_estimate_high != null ? `${o.pre_estimate_high} min` : "—"}
                    </td>
                    <td
                      className={`px-2 py-1.5 text-right font-semibold ${
                        (overEstimate ?? 0) > 15
                          ? "text-red-400"
                          : (overEstimate ?? 0) > 5
                            ? "text-yellow-400"
                            : "text-green-400"
                      }`}
                    >
                      {overEstimate != null
                        ? `+${overEstimate} min`
                        : "—"}
                    </td>
                    <td className="px-2 py-1.5">{o.vehicle_type ?? "—"}</td>
                    <td className="px-2 py-1.5 text-center text-[var(--color-text-muted)]">—</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function venueImpactPct(v: VenuePerformance): number {
  return v.total_orders > 0
    ? Math.round(((v.venue_late_count + v.venue_early_count) / v.total_orders) * 1000) / 10
    : 0;
}

function sortVenues(
  list: VenuePerformance[],
  key: string,
  asc: boolean,
): VenuePerformance[] {
  return [...list].sort((a, b) => {
    const av = key === "venue_impact_pct" ? venueImpactPct(a) : (a as unknown as Record<string, unknown>)[key];
    const bv = key === "venue_impact_pct" ? venueImpactPct(b) : (b as unknown as Record<string, unknown>)[key];
    const aVal = av ?? "";
    const bVal = bv ?? "";
    let cmp: number;
    if (typeof aVal === "string" && typeof bVal === "string") {
      cmp = aVal.localeCompare(bVal);
    } else {
      cmp = (Number(aVal) || 0) - (Number(bVal) || 0);
    }
    if (cmp === 0) cmp = (a.venue_name ?? "").localeCompare(b.venue_name ?? "");
    return asc ? cmp : -cmp;
  });
}

function scoreColor(score: number): string {
  if (score > 60) return "text-red-400";
  if (score > 30) return "text-yellow-400";
  return "text-green-400";
}

function VenueTable({
  venues,
  lateOrders,
  city,
  lookbackDays,
}: {
  venues: VenuePerformance[];
  lateOrders: LateOrder[];
  city: string;
  lookbackDays: number;
}) {
  const [sortKey, setSortKey] = useState("problem_score");
  const [sortAsc, setSortAsc] = useState(false);
  const [minOrders, setMinOrders] = useState(5);
  const [venueTypeFilter, setVenueTypeFilter] = useState("all");
  const [retailSubFilter, setRetailSubFilter] = useState("all");
  const [nameSearch, setNameSearch] = useState("");
  const [selectedVenueId, setSelectedVenueId] = useState<string | null>(null);

  const retailSubTypes = useMemo(() => {
    const types = new Set<string>();
    for (const v of venues) {
      if (v.venue_vertical && v.venue_vertical !== "restaurant") {
        types.add(v.venue_vertical);
      }
    }
    return Array.from(types).sort();
  }, [venues]);

  const filtered = useMemo(() => {
    const searchLower = nameSearch.toLowerCase().trim();
    return venues.filter((v) => {
      if (v.total_orders < minOrders) return false;
      if (searchLower && !v.venue_name.toLowerCase().includes(searchLower)) return false;
      if (venueTypeFilter === "restaurant") {
        return v.venue_vertical === "restaurant";
      }
      if (venueTypeFilter === "retail") {
        if (retailSubFilter === "all") {
          return v.venue_vertical !== "restaurant";
        }
        return v.venue_vertical === retailSubFilter;
      }
      return true;
    });
  }, [venues, minOrders, venueTypeFilter, retailSubFilter, nameSearch]);

  const rows = useMemo(
    () => sortVenues(filtered, sortKey, sortAsc),
    [filtered, sortKey, sortAsc]
  );

  function handleSort(key: string) {
    if (key === sortKey) {
      setSortAsc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  }

  function thCell(label: string, key: string, align = "text-right") {
    return (
      <th
        className={`px-2 py-1.5 ${align} font-medium cursor-pointer hover:text-[var(--color-text)] select-none whitespace-nowrap`}
        onClick={() => handleSort(key)}
      >
        {label} {sortKey === key ? (sortAsc ? "↑" : "↓") : ""}
      </th>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-3 flex-wrap">
          <h4 className="text-xs font-semibold text-[var(--color-text)]">Venue List</h4>
          <input
            type="text"
            value={nameSearch}
            onChange={(e) => setNameSearch(e.target.value)}
            placeholder="Search venue..."
            className="h-5 w-36 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[10px] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
          />
          <label className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
            Min orders:
            <select
              value={minOrders}
              onChange={(e) => setMinOrders(Number(e.target.value))}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-text)]"
            >
              <option value={1}>1</option>
              <option value={3}>3</option>
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={20}>20</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
            Type:
            <select
              value={venueTypeFilter}
              onChange={(e) => {
                setVenueTypeFilter(e.target.value);
                setRetailSubFilter("all");
              }}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-text)]"
            >
              <option value="all">All</option>
              <option value="restaurant">Restaurant</option>
              <option value="retail">Retail</option>
            </select>
          </label>
          {venueTypeFilter === "retail" && (
            <label className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
              Category:
              <select
                value={retailSubFilter}
                onChange={(e) => setRetailSubFilter(e.target.value)}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-text)]"
              >
                <option value="all">All Retail</option>
                {retailSubTypes.map((vt) => (
                  <option key={vt} value={vt}>
                    {vt}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {rows.length} venues
          </span>
        </div>
        <button
          onClick={() => downloadCsv(rows, city)}
          className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-hover)]"
        >
          <Download size={10} />
          Export CSV
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="flex h-24 items-center justify-center text-xs text-[var(--color-text-muted)]">
          No venues match the filter
        </div>
      ) : (
        <div className="max-h-[500px] overflow-y-auto overflow-x-auto">
          <table className="w-full text-xs text-[var(--color-text)]">
            <thead className="sticky top-0 bg-[var(--color-surface)]">
              <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
                {thCell("Venue Name", "venue_name", "text-left")}
                {thCell("Type", "venue_vertical", "text-left")}
                {thCell("Orders", "total_orders", "text-center")}
                {thCell("Late", "late_orders")}
                {thCell("Late %", "late_pct")}
                {thCell("Queue aging", "delayed_orders")}
                {thCell("Aging %", "rotten_pct")}
                {thCell("V. Late", "venue_late_count")}
                {thCell("V. Early", "venue_early_count")}
                {thCell("V. Impact %", "venue_impact_pct")}
                {thCell("Avg Accept latency", "avg_ttla_sec")}
                {thCell("Avg Prep", "avg_prep_time_min")}
                {thCell("Avg Compl.", "avg_completion_min")}
                {thCell("Score", "problem_score")}
              </tr>
            </thead>
            <tbody>
              {rows.map((v, i) => (
                <tr
                  key={i}
                  className="border-b border-[var(--color-border)]/30 hover:bg-[var(--color-bg)]/50"
                >
                  <td className="px-2 py-1.5 max-w-[200px] truncate" title={v.venue_name}>
                    {v.venue_name}
                  </td>
                  <td className="px-2 py-1.5 text-[var(--color-text-muted)]">
                    {v.venue_vertical ?? "—"}
                  </td>
                  <td className="px-2 py-1.5 text-center">{v.total_orders}</td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      onClick={() => setSelectedVenueId(v.venue_id)}
                      className="cursor-pointer text-[var(--color-text)] transition-opacity hover:opacity-70"
                    >
                      {v.late_orders}
                    </button>
                  </td>
                  <td
                    className={`px-2 py-1.5 text-right font-semibold ${
                      v.late_pct > 50
                        ? "text-red-400"
                        : v.late_pct > 25
                          ? "text-yellow-400"
                          : "text-green-400"
                    }`}
                  >
                    {v.late_pct}%
                  </td>
                  <td className="px-2 py-1.5 text-right">{v.delayed_orders}</td>
                  <td
                    className={`px-2 py-1.5 text-right font-semibold ${
                      v.rotten_pct > 30
                        ? "text-red-400"
                        : v.rotten_pct > 10
                          ? "text-yellow-400"
                          : "text-green-400"
                    }`}
                  >
                    {v.rotten_pct}%
                  </td>
                  <td className="px-2 py-1.5 text-right">{v.venue_late_count}</td>
                  <td className="px-2 py-1.5 text-right">{v.venue_early_count}</td>
                  {(() => {
                    const impact = venueImpactPct(v);
                    return (
                      <td className={`px-2 py-1.5 text-right font-semibold ${
                        impact > 75 ? "text-red-400" : impact > 40 ? "text-yellow-400" : "text-[var(--color-text-muted)]"
                      }`}>
                        {impact}%
                      </td>
                    );
                  })()}
                  <td className="px-2 py-1.5 text-right">
                    {v.avg_ttla_sec != null ? `${Math.round(v.avg_ttla_sec)}s` : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right">{fmt(v.avg_prep_time_min, " min")}</td>
                  <td className="px-2 py-1.5 text-right">{fmt(v.avg_completion_min, " min")}</td>
                  <td
                    className={`px-2 py-1.5 text-right font-bold ${scoreColor(v.problem_score)}`}
                  >
                    {v.problem_score}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedVenueId &&
        (() => {
          const venue = venues.find((v) => v.venue_id === selectedVenueId);
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - lookbackDays);
          const cutoffStr = cutoff.toISOString().slice(0, 10);
          const venueOrders = lateOrders.filter(
            (o) => o.venue_id === selectedVenueId && o.delivered_date >= cutoffStr
          );
          return (
            <VenueOrdersModal
              venueId={selectedVenueId}
              venueName={venue?.venue_name ?? "Unknown"}
              orders={venueOrders}
              onClose={() => setSelectedVenueId(null)}
            />
          );
        })()}
    </div>
  );
}

export function VenuePerformancePanel({ city, lookbackDays, sizeFilter = "all", lateOrders = [] }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<VenuePerformanceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    setData(null);
    setLoading(true);
    setError(null);
    fetchVenuePerformance(city, lookbackDays, sizeFilter)
      .then(setData)
      .catch((e) => setError(e?.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, [expanded, city, lookbackDays, sizeFilter]);

  const summary = data?.summary;

  const venueCausedLate = useMemo(() => {
    if (!data) return 0;
    return data.venues.reduce((sum, v) => sum + v.venue_late_count, 0);
  }, [data]);

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown size={16} className="text-[var(--color-text-muted)]" />
          ) : (
            <ChevronRight size={16} className="text-[var(--color-text-muted)]" />
          )}
          <h3 className="text-sm font-semibold text-[var(--color-text)]">
            Venue Performance
          </h3>
          {summary && !loading && (
            <span className="ml-2 text-xs text-[var(--color-text-muted)]">
              {summary.problem_venues} problem venues of {summary.total_venues} total
            </span>
          )}
        </div>
        {loading && (
          <Loader2 size={14} className="animate-spin text-[var(--color-text-muted)]" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-[var(--color-border)] px-5 pb-5 pt-4 space-y-4">
          {error && (
            <div className="rounded-lg border border-red-800/40 bg-red-900/20 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}

          {loading && !data && (
            <div className="flex h-32 items-center justify-center">
              <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                <Loader2 size={14} className="animate-spin" />
                Loading venue performance data...
              </div>
            </div>
          )}

          {data && (
            <>
              <div className="grid grid-cols-4 gap-3">
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
                  <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                    <Store size={12} />
                    <span className="text-[10px] font-medium">Venues Analyzed</span>
                  </div>
                  <p className="mt-1 text-lg font-bold text-[var(--color-text)]">
                    {summary!.total_venues}
                  </p>
                </div>
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
                  <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                    <AlertTriangle size={12} />
                    <span className="text-[10px] font-medium">Problem Venues</span>
                  </div>
                  <p className="mt-1 text-lg font-bold text-red-400">
                    {summary!.problem_venues}
                  </p>
                </div>
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
                  <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                    <TrendingUp size={12} />
                    <span className="text-[10px] font-medium">Avg Late %</span>
                  </div>
                  <p className="mt-1 text-lg font-bold text-yellow-400">
                    {summary!.avg_late_pct}%
                  </p>
                </div>
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
                  <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                    <Clock size={12} />
                    <span className="text-[10px] font-medium">Venue-Caused Late</span>
                  </div>
                  <p className="mt-1 text-lg font-bold text-orange-400">
                    {venueCausedLate.toLocaleString()}
                  </p>
                </div>
              </div>

              <VenueTable venues={data.venues} lateOrders={lateOrders} city={city} lookbackDays={lookbackDays} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
