import { useState, useEffect, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Store,
  Download,
  X,
  ExternalLink,
} from "lucide-react";
import { fetchCloneVenues } from "../api/client";
import type { CloneVenueRow, CloneOrderRow } from "../types";

type OrderType = "hl" | "heavy" | "large";

interface Props {
  city: string;
  /** Default window (the tab's global timeline); the panel can override it. */
  dateFrom: string;
  dateTo: string;
  /** Already-fetched redispatched jobs (reused to populate the per-venue modal). */
  cloneOrders?: CloneOrderRow[];
}

const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  hl: "Tier A | Tier B",
  heavy: "Tier A",
  large: "Tier B",
};

function contributionOf(v: CloneVenueRow, t: OrderType): number {
  return t === "heavy" ? v.heavy_orders : t === "large" ? v.large_orders : v.hl_orders;
}
function clonedOf(v: CloneVenueRow, t: OrderType): number {
  return t === "heavy" ? v.cloned_heavy : t === "large" ? v.cloned_large : v.cloned_hl;
}
function clonePctOf(v: CloneVenueRow, t: OrderType): number {
  const c = contributionOf(v, t);
  return c > 0 ? Math.round((clonedOf(v, t) / c) * 1000) / 10 : 0;
}

function downloadCsv(venues: CloneVenueRow[], t: OrderType, city: string) {
  const headers = [
    "Venue ID", "Venue Name", "Type", "Total Orders",
    "Tier A", "Tier B", "Tier A|Tier B",
    `Redispatched (${ORDER_TYPE_LABEL[t]})`, "Redispatch %", "Avg Accept latency (sec)",
  ];
  const rows = venues.map((v) => [
    v.venue_id,
    `"${(v.venue_name ?? "").replace(/"/g, '""')}"`,
    v.venue_vertical ?? "",
    v.total_orders,
    v.heavy_orders,
    v.large_orders,
    v.hl_orders,
    clonedOf(v, t),
    clonePctOf(v, t),
    v.avg_ttla_sec ?? "",
  ]);
  const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `clone_venues_${city}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function VenueClonedModal({
  venueName,
  orders,
  onClose,
}: {
  venueName: string;
  orders: CloneOrderRow[];
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="relative mx-4 max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text)]">Redispatched Jobs for Venue</h3>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              <span className="font-semibold">{venueName}</span>
              <span className="ml-2">{orders.length} redispatched jobs</span>
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
              No redispatched jobs for this venue in the current filters
            </div>
          ) : (
            <table className="w-full text-xs text-[var(--color-text)]">
              <thead className="sticky top-0 bg-[var(--color-surface)]">
                <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
                  <th className="px-2 py-1.5 text-left font-medium">Order ID</th>
                  <th className="px-2 py-1.5 text-left font-medium">Date</th>
                  <th className="px-2 py-1.5 text-left font-medium">Tier</th>
                  <th className="px-2 py-1.5 text-right font-medium">Redispatches</th>
                  <th className="px-2 py-1.5 text-left font-medium">Vehicle</th>
                  <th className="px-2 py-1.5 text-center font-medium">Link</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.purchase_id} className="border-b border-[var(--color-border)]/30 hover:bg-[var(--color-bg)]/50">
                    <td className="px-2 py-1.5 font-mono text-[10px]">{o.purchase_id}</td>
                    <td className="px-2 py-1.5">{o.confirmed_date}</td>
                    <td className="px-2 py-1.5 text-[var(--color-text-muted)]">{o.capability_group}</td>
                    <td className="px-2 py-1.5 text-right">{o.clone_count}</td>
                    <td className="px-2 py-1.5">{o.vehicle_types ?? "—"}</td>
                    <td className="px-2 py-1.5 text-center text-[var(--color-text-muted)]">—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function sortVenues(
  list: CloneVenueRow[],
  key: string,
  asc: boolean,
  t: OrderType,
): CloneVenueRow[] {
  const derived = (v: CloneVenueRow): number | string => {
    if (key === "contribution") return contributionOf(v, t);
    if (key === "cloned_sel") return clonedOf(v, t);
    if (key === "clone_pct") return clonePctOf(v, t);
    return (v as unknown as Record<string, number | string | null>)[key] ?? "";
  };
  return [...list].sort((a, b) => {
    const av = derived(a);
    const bv = derived(b);
    let cmp: number;
    if (typeof av === "string" && typeof bv === "string") {
      cmp = av.localeCompare(bv);
    } else {
      cmp = (Number(av) || 0) - (Number(bv) || 0);
    }
    if (cmp === 0) cmp = (a.venue_name ?? "").localeCompare(b.venue_name ?? "");
    return asc ? cmp : -cmp;
  });
}

export function CloneVenuePanel({ city, dateFrom, dateTo, cloneOrders = [] }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [venues, setVenues] = useState<CloneVenueRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Own timeline: defaults to the tab's global window, overridable here.
  const [from, setFrom] = useState(dateFrom);
  const [to, setTo] = useState(dateTo);
  const [followGlobal, setFollowGlobal] = useState(true);

  const [orderType, setOrderType] = useState<OrderType>("hl");
  const [venueTypeFilter, setVenueTypeFilter] = useState("all");
  const [retailSubFilter, setRetailSubFilter] = useState("all");
  const [nameSearch, setNameSearch] = useState("");
  const [minOrders, setMinOrders] = useState(1);
  const [sortKey, setSortKey] = useState("contribution");
  const [sortAsc, setSortAsc] = useState(false);
  const [selectedVenue, setSelectedVenue] = useState<string | null>(null);

  // Keep the local window in sync with the global timeline while "follow" is on.
  useEffect(() => {
    if (followGlobal) {
      setFrom(dateFrom);
      setTo(dateTo);
    }
  }, [dateFrom, dateTo, followGlobal]);

  useEffect(() => {
    if (!expanded || !from || !to) return;
    setLoading(true);
    setError(null);
    fetchCloneVenues(city, from, to)
      .then((d) => setVenues(d.venues))
      .catch((e) => setError(e?.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, [expanded, city, from, to]);

  const retailSubTypes = useMemo(() => {
    const types = new Set<string>();
    for (const v of venues) {
      if (v.venue_vertical && v.venue_vertical !== "restaurant") types.add(v.venue_vertical);
    }
    return Array.from(types).sort();
  }, [venues]);

  const filtered = useMemo(() => {
    const searchLower = nameSearch.toLowerCase().trim();
    return venues.filter((v) => {
      if (contributionOf(v, orderType) < minOrders) return false;
      if (searchLower && !(v.venue_name ?? "").toLowerCase().includes(searchLower)) return false;
      if (venueTypeFilter === "restaurant") return v.venue_vertical === "restaurant";
      if (venueTypeFilter === "retail") {
        if (retailSubFilter === "all") return v.venue_vertical !== "restaurant";
        return v.venue_vertical === retailSubFilter;
      }
      return true;
    });
  }, [venues, orderType, minOrders, nameSearch, venueTypeFilter, retailSubFilter]);

  const rows = useMemo(
    () => sortVenues(filtered, sortKey, sortAsc, orderType),
    [filtered, sortKey, sortAsc, orderType]
  );

  const totalContribution = useMemo(
    () => rows.reduce((s, v) => s + contributionOf(v, orderType), 0),
    [rows, orderType]
  );
  const totalCloned = useMemo(
    () => rows.reduce((s, v) => s + clonedOf(v, orderType), 0),
    [rows, orderType]
  );

  function handleSort(key: string) {
    if (key === sortKey) setSortAsc((p) => !p);
    else {
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

  const modalOrders = useMemo(() => {
    if (!selectedVenue) return [];
    return cloneOrders.filter((o) => {
      if ((o.venue_name ?? "") !== selectedVenue) return false;
      if (orderType === "heavy") return o.is_heavy === 1;
      if (orderType === "large") return o.is_large === 1;
      return o.is_heavy === 1 || o.is_large === 1;
    });
  }, [selectedVenue, cloneOrders, orderType]);

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
          <Store size={15} className="text-amber-400" />
          <h3 className="text-sm font-semibold text-[var(--color-text)]">
            Top Venues by Tier A/Tier B Orders
          </h3>
          {!loading && venues.length > 0 && (
            <span className="ml-2 text-xs text-[var(--color-text-muted)]">
              {from} → {to} · {rows.length} venues · {totalContribution.toLocaleString()} {ORDER_TYPE_LABEL[orderType]} orders · {totalCloned.toLocaleString()} cloned
            </span>
          )}
        </div>
        {loading && <Loader2 size={14} className="animate-spin text-[var(--color-text-muted)]" />}
      </button>

      {expanded && (
        <div className="border-t border-[var(--color-border)] px-5 pb-5 pt-4 space-y-4">
          {error && (
            <div className="rounded-lg border border-red-800/40 bg-red-900/20 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}

          {loading && venues.length === 0 && (
            <div className="flex h-32 items-center justify-center">
              <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                <Loader2 size={14} className="animate-spin" />
                Loading venue contribution data...
              </div>
            </div>
          )}

          {venues.length > 0 && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-4">
              <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3 flex-wrap">
                  <label className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
                    From:
                    <input
                      type="date"
                      value={from}
                      max={to}
                      onChange={(e) => {
                        setFollowGlobal(false);
                        setFrom(e.target.value);
                      }}
                      className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-text)]"
                    />
                  </label>
                  <label className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
                    To:
                    <input
                      type="date"
                      value={to}
                      min={from}
                      onChange={(e) => {
                        setFollowGlobal(false);
                        setTo(e.target.value);
                      }}
                      className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-text)]"
                    />
                  </label>
                  {!followGlobal && (
                    <button
                      onClick={() => setFollowGlobal(true)}
                      className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
                      title="Sync this panel back to the tab's global timeline"
                    >
                      Follow global
                    </button>
                  )}
                  <span className="mx-0.5 h-3 w-px bg-[var(--color-border)]" />
                  <label className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
                    Order type:
                    <select
                      value={orderType}
                      onChange={(e) => setOrderType(e.target.value as OrderType)}
                      className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-text)]"
                    >
                      <option value="hl">Tier A | Tier B</option>
                      <option value="heavy">Tier A</option>
                      <option value="large">Tier B</option>
                    </select>
                  </label>
                  <input
                    type="text"
                    value={nameSearch}
                    onChange={(e) => setNameSearch(e.target.value)}
                    placeholder="Search venue..."
                    className="h-5 w-36 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[10px] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
                  />
                  <label className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
                    Min {ORDER_TYPE_LABEL[orderType]}:
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
                          <option key={vt} value={vt}>{vt}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <span className="text-[10px] text-[var(--color-text-muted)]">{rows.length} venues</span>
                </div>
                <button
                  onClick={() => downloadCsv(rows, orderType, city)}
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
                        {thCell("Total", "total_orders", "text-center")}
                        {thCell("Tier A", "heavy_orders")}
                        {thCell("Tier B", "large_orders")}
                        {thCell("Tier A|Tier B", "hl_orders")}
                        {thCell(`Redispatched (${ORDER_TYPE_LABEL[orderType]})`, "cloned_sel")}
                        {thCell("Redispatch %", "clone_pct")}
                        {thCell("Avg Accept latency", "avg_ttla_sec")}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((v) => {
                        const cloned = clonedOf(v, orderType);
                        const pct = clonePctOf(v, orderType);
                        return (
                          <tr key={v.venue_id} className="border-b border-[var(--color-border)]/30 hover:bg-[var(--color-bg)]/50">
                            <td className="px-2 py-1.5 max-w-[220px] truncate" title={v.venue_name ?? ""}>
                              {v.venue_name ?? "—"}
                            </td>
                            <td className="px-2 py-1.5 text-[var(--color-text-muted)]">{v.venue_vertical ?? "—"}</td>
                            <td className="px-2 py-1.5 text-center">{v.total_orders.toLocaleString()}</td>
                            <td className="px-2 py-1.5 text-right">{v.heavy_orders.toLocaleString()}</td>
                            <td className="px-2 py-1.5 text-right">{v.large_orders.toLocaleString()}</td>
                            <td className="px-2 py-1.5 text-right font-semibold">{v.hl_orders.toLocaleString()}</td>
                            <td className="px-2 py-1.5 text-right">
                              {cloned > 0 && cloneOrders.length > 0 ? (
                                <button
                                  onClick={() => setSelectedVenue(v.venue_name)}
                                  className="cursor-pointer font-semibold text-amber-400 transition-opacity hover:opacity-70"
                                  title="View redispatched jobs"
                                >
                                  {cloned.toLocaleString()}
                                </button>
                              ) : (
                                <span className={cloned > 0 ? "font-semibold text-amber-400" : ""}>{cloned.toLocaleString()}</span>
                              )}
                            </td>
                            <td className={`px-2 py-1.5 text-right font-semibold ${
                              pct > 15 ? "text-red-400" : pct > 5 ? "text-yellow-400" : "text-[var(--color-text-muted)]"
                            }`}>
                              {pct}%
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              {v.avg_ttla_sec != null ? `${Math.round(v.avg_ttla_sec)}s` : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {selectedVenue && (
        <VenueClonedModal
          venueName={selectedVenue}
          orders={modalOrders}
          onClose={() => setSelectedVenue(null)}
        />
      )}
    </div>
  );
}
