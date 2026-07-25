import { useState, useEffect, useMemo, useCallback } from "react";
import { ChevronDown, ChevronRight, Loader2, Users, Gauge, AlertTriangle, Clock, Download, X, ExternalLink } from "lucide-react";
import { fetchCourierPerformance } from "../api/client";
import type { CourierPerformanceData, CourierSummary, CourierTravelOrder, SpeedBenchmark } from "../types";

interface Props {
  city: string;
  lookbackDays: number;
}

function fmt(v: number | null | undefined, suffix = ""): string {
  if (v == null) return "—";
  return `${v}${suffix}`;
}

function SpeedBenchmarkTable({ benchmarks, targets }: { benchmarks: SpeedBenchmark[]; targets: Record<string, number> }) {
  if (!benchmarks.length) return null;
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-4">
      <h4 className="mb-3 text-xs font-semibold text-[var(--color-text)]">
        Speed Benchmarks by Vehicle Type (all orders, not just late)
      </h4>
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-[var(--color-text)]">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
              <th className="px-2 py-1.5 text-left font-medium">Vehicle</th>
              <th className="px-2 py-1.5 text-right font-medium">Orders</th>
              <th className="px-2 py-1.5 text-right font-medium">Avg Speed</th>
              <th className="px-2 py-1.5 text-right font-medium">Median</th>
              <th className="px-2 py-1.5 text-right font-medium">P25</th>
              <th className="px-2 py-1.5 text-right font-medium">P75</th>
              <th className="px-2 py-1.5 text-right font-medium">Target</th>
              <th className="px-2 py-1.5 text-right font-medium">Avg Pickup</th>
              <th className="px-2 py-1.5 text-right font-medium">Avg Dropoff</th>
            </tr>
          </thead>
          <tbody>
            {benchmarks.map((b) => {
              const target = targets[b.vehicle_type.toLowerCase()] ?? 15;
              return (
                <tr key={b.vehicle_type} className="border-b border-[var(--color-border)]/30 hover:bg-[var(--color-bg)]/50">
                  <td className="px-2 py-1.5 font-semibold">{b.vehicle_type}</td>
                  <td className="px-2 py-1.5 text-right">{b.order_count.toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-right">{fmt(b.avg_speed_kmh, " km/h")}</td>
                  <td className="px-2 py-1.5 text-right">{fmt(b.median_speed_kmh, " km/h")}</td>
                  <td className="px-2 py-1.5 text-right">{fmt(b.p25_speed_kmh)}</td>
                  <td className="px-2 py-1.5 text-right">{fmt(b.p75_speed_kmh)}</td>
                  <td className="px-2 py-1.5 text-right text-blue-400">{target} km/h</td>
                  <td className="px-2 py-1.5 text-right">{fmt(b.avg_pickup_min, " min")}</td>
                  <td className="px-2 py-1.5 text-right">{fmt(b.avg_dropoff_min, " min")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function downloadCsv(couriers: CourierSummary[], city: string, benchmarks: SpeedBenchmark[]) {
  const headers = [
    "Courier ID", "Vehicle", "Likely Vehicle", "Orders", "Slow Orders", "Slow %",
    "Avg Speed (km/h)", "Avg Pickup (min)", "Avg Dropoff (min)",
    "Avg Pickup Dist (m)", "Avg Dropoff Dist (m)",
  ];
  const rows = couriers.map((c) => [
    c.worker_id,
    c.vehicle_type ?? "",
    matchVehicleBySpeed(c.avg_speed_kmh, benchmarks) ?? "",
    c.order_count,
    c.slow_order_count,
    c.slow_pct,
    c.avg_speed_kmh ?? "",
    c.avg_pickup_min,
    c.avg_dropoff_min,
    Math.round(c.avg_pickup_dist_m),
    Math.round(c.avg_dropoff_dist_m),
  ]);
  const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `courier_performance_${city}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function CourierOrdersModal({
  workerId,
  vehicleType,
  orders,
  onClose,
}: {
  workerId: string;
  vehicleType: string | null;
  orders: CourierTravelOrder[];
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
            <h3 className="text-sm font-semibold text-[var(--color-text)]">
              Orders for Courier
            </h3>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              <span className="font-mono">{workerId}</span>
              {vehicleType && <span className="ml-2">({vehicleType})</span>}
              <span className="ml-2">{orders.length} orders</span>
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg)]/50 hover:text-[var(--color-text)]">
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[65vh] overflow-y-auto p-4">
          <table className="w-full text-xs text-[var(--color-text)]">
            <thead className="sticky top-0 bg-[var(--color-surface)]">
              <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
                <th className="px-2 py-1.5 text-left font-medium">Order ID</th>
                <th className="px-2 py-1.5 text-left font-medium">Date</th>
                <th className="px-2 py-1.5 text-right font-medium">Pickup</th>
                <th className="px-2 py-1.5 text-right font-medium">PU Target</th>
                <th className="px-2 py-1.5 text-right font-medium">Dropoff</th>
                <th className="px-2 py-1.5 text-right font-medium">DO Target</th>
                <th className="px-2 py-1.5 text-right font-medium">Total Travel</th>
                <th className="px-2 py-1.5 text-right font-medium">Ratio</th>
                <th className="px-2 py-1.5 text-center font-medium">Slow?</th>
                <th className="px-2 py-1.5 text-center font-medium">Link</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.purchase_id} className="border-b border-[var(--color-border)]/30 hover:bg-[var(--color-bg)]/50">
                  <td className="px-2 py-1.5 font-mono text-[10px]">{o.purchase_id}</td>
                  <td className="px-2 py-1.5">{o.delivered_date}</td>
                  <td className="px-2 py-1.5 text-right">{fmt(o.pickup_arrival_min, " min")}</td>
                  <td className="px-2 py-1.5 text-right text-[var(--color-text-muted)]">{fmt(o.pickup_target_min, " min")}</td>
                  <td className="px-2 py-1.5 text-right">{fmt(o.dropoff_arrival_min, " min")}</td>
                  <td className="px-2 py-1.5 text-right text-[var(--color-text-muted)]">{fmt(o.dropoff_target_min, " min")}</td>
                  <td className="px-2 py-1.5 text-right">{fmt(o.travel_total_min, " min")}</td>
                  <td className={`px-2 py-1.5 text-right font-semibold ${
                    o.travel_ratio != null && o.travel_ratio > 1.5 ? "text-red-400" : o.travel_ratio != null && o.travel_ratio > 1 ? "text-yellow-400" : "text-green-400"
                  }`}>
                    {o.travel_ratio != null ? `${o.travel_ratio}x` : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    {o.is_slow_travel ? (
                      <span className="inline-block rounded bg-red-900/30 px-1.5 py-0.5 text-[10px] font-semibold text-red-400">Yes</span>
                    ) : (
                      <span className="text-[var(--color-text-muted)]">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-center text-[var(--color-text-muted)]">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function matchVehicleBySpeed(avgSpeed: number | null, benchmarks: SpeedBenchmark[]): string | null {
  if (avgSpeed == null || !benchmarks.length) return null;
  let best: SpeedBenchmark | null = null;
  let bestDiff = Infinity;
  for (const b of benchmarks) {
    if (b.median_speed_kmh == null) continue;
    const diff = Math.abs(avgSpeed - b.median_speed_kmh);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = b;
    }
  }
  return best?.vehicle_type ?? null;
}

function CourierTable({ couriers, orders, city, benchmarks }: { couriers: CourierSummary[]; orders: CourierTravelOrder[]; city: string; benchmarks: SpeedBenchmark[] }) {
  const [sortKey, setSortKey] = useState<keyof CourierSummary>("slow_pct");
  const [sortAsc, setSortAsc] = useState(false);
  const [minOrders, setMinOrders] = useState(3);
  const [vehicleFilter, setVehicleFilter] = useState("all");
  const [courierIdFilter, setCourierIdFilter] = useState("");
  const [selectedCourier, setSelectedCourier] = useState<string | null>(null);

  const vehicleTypes = useMemo(() => {
    const types = new Set<string>();
    for (const c of couriers) {
      if (c.vehicle_type) types.add(c.vehicle_type);
    }
    return Array.from(types).sort();
  }, [couriers]);

  const filtered = useMemo(() => {
    const idQuery = courierIdFilter.trim().toLowerCase();
    return couriers.filter((c) => {
      const matchesId = idQuery === "" || String(c.worker_id ?? "").toLowerCase().includes(idQuery);
      if (!matchesId) return false;
      // When searching by ID, surface the courier regardless of the min-orders threshold.
      if (idQuery !== "") return vehicleFilter === "all" || c.vehicle_type === vehicleFilter;
      return c.order_count >= minOrders && (vehicleFilter === "all" || c.vehicle_type === vehicleFilter);
    });
  }, [couriers, minOrders, vehicleFilter, courierIdFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      return sortAsc ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
    });
    return copy;
  }, [filtered, sortKey, sortAsc]);

  const handleSort = useCallback((key: keyof CourierSummary) => {
    setSortKey((prev) => {
      if (prev === key) { setSortAsc((a) => !a); return key; }
      setSortAsc(false);
      return key;
    });
  }, []);

  const th = (label: string, key: keyof CourierSummary) => (
    <th
      className="px-2 py-1.5 text-right font-medium cursor-pointer hover:text-[var(--color-text)] select-none"
      onClick={() => handleSort(key)}
    >
      {label} {sortKey === key ? (sortAsc ? "↑" : "↓") : ""}
    </th>
  );

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h4 className="text-xs font-semibold text-[var(--color-text)]">
            Courier List
          </h4>
          <label className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
            Min orders:
            <select
              value={minOrders}
              onChange={(e) => setMinOrders(Number(e.target.value))}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-text)]"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={5}>5</option>
              <option value={10}>10</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
            Vehicle:
            <select
              value={vehicleFilter}
              onChange={(e) => setVehicleFilter(e.target.value)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-text)]"
            >
              <option value="all">All</option>
              {vehicleTypes.map((vt) => (
                <option key={vt} value={vt}>{vt}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
            Courier ID:
            <div className="relative">
              <input
                type="text"
                value={courierIdFilter}
                onChange={(e) => setCourierIdFilter(e.target.value)}
                placeholder="Paste courier ID…"
                className="w-44 rounded border border-[var(--color-border)] bg-[var(--color-surface)] py-0.5 pl-1.5 pr-5 text-[10px] text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
              />
              {courierIdFilter && (
                <button
                  onClick={() => setCourierIdFilter("")}
                  className="absolute right-1 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  title="Clear"
                >
                  <X size={10} />
                </button>
              )}
            </div>
          </label>
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {sorted.length} couriers
          </span>
        </div>
        <button
          onClick={() => downloadCsv(sorted, city, benchmarks)}
          className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-hover)]"
        >
          <Download size={10} />
          Export CSV
        </button>
      </div>
      {sorted.length === 0 ? (
        <div className="flex h-24 items-center justify-center text-xs text-[var(--color-text-muted)]">
          No couriers match the filter
        </div>
      ) : (
        <div className="max-h-[500px] overflow-y-auto overflow-x-auto">
          <table className="w-full text-xs text-[var(--color-text)]">
            <thead className="sticky top-0 bg-[var(--color-surface)]">
              <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
                <th className="px-2 py-1.5 text-left font-medium">Courier ID</th>
                <th className="px-2 py-1.5 text-left font-medium">Vehicle</th>
                <th className="px-2 py-1.5 text-left font-medium">Likely Vehicle</th>
                <th
                  className="px-2 py-1.5 text-center font-medium cursor-pointer hover:text-[var(--color-text)] select-none"
                  onClick={() => handleSort("order_count")}
                >
                  Orders {sortKey === "order_count" ? (sortAsc ? "↑" : "↓") : ""}
                </th>
                {th("Slow %", "slow_pct")}
                {th("Avg Speed", "avg_speed_kmh")}
                {th("Avg Pickup", "avg_pickup_min")}
                {th("Avg Dropoff", "avg_dropoff_min")}
                {th("Avg PU Dist", "avg_pickup_dist_m")}
                {th("Avg DO Dist", "avg_dropoff_dist_m")}
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={c.worker_id} className="border-b border-[var(--color-border)]/30 hover:bg-[var(--color-bg)]/50">
                  <td className="px-2 py-1.5 font-mono text-[10px]">{c.worker_id}</td>
                  <td className="px-2 py-1.5">{c.vehicle_type ?? "—"}</td>
                  {(() => {
                    const likely = matchVehicleBySpeed(c.avg_speed_kmh, benchmarks);
                    const mismatch = likely && c.vehicle_type && likely.toLowerCase() !== c.vehicle_type.toLowerCase();
                    return (
                      <td className={`px-2 py-1.5 ${mismatch ? "font-semibold text-yellow-400" : "text-[var(--color-text-muted)]"}`}>
                        {likely ?? "—"}
                      </td>
                    );
                  })()}
                  <td className="px-2 py-1.5 text-center">
                    <button
                      onClick={() => setSelectedCourier(c.worker_id)}
                      className="cursor-pointer text-[var(--color-text)] transition-opacity hover:opacity-70"
                    >
                      {c.order_count}
                    </button>
                  </td>
                  <td className={`px-2 py-1.5 text-right font-semibold ${c.slow_pct > 50 ? "text-red-400" : c.slow_pct > 25 ? "text-yellow-400" : "text-green-400"}`}>
                    {c.slow_pct}%
                  </td>
                  <td className="px-2 py-1.5 text-right">{fmt(c.avg_speed_kmh, " km/h")}</td>
                  <td className="px-2 py-1.5 text-right">{c.avg_pickup_min} min</td>
                  <td className="px-2 py-1.5 text-right">{c.avg_dropoff_min} min</td>
                  <td className="px-2 py-1.5 text-right">{Math.round(c.avg_pickup_dist_m)} m</td>
                  <td className="px-2 py-1.5 text-right">{Math.round(c.avg_dropoff_dist_m)} m</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedCourier && (() => {
        const courier = couriers.find((c) => c.worker_id === selectedCourier);
        const courierOrders = orders.filter(
          (o) => o.pickup_worker_id === selectedCourier || o.dropoff_worker_id === selectedCourier
        );
        return (
          <CourierOrdersModal
            workerId={selectedCourier}
            vehicleType={courier?.vehicle_type ?? null}
            orders={courierOrders}
            onClose={() => setSelectedCourier(null)}
          />
        );
      })()}
    </div>
  );
}

export function CourierPerformancePanel({ city, lookbackDays }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<CourierPerformanceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    setLoading(true);
    setError(null);
    fetchCourierPerformance(city, lookbackDays)
      .then(setData)
      .catch((e) => setError(e?.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, [expanded, city, lookbackDays]);

  const summary = data?.summary;

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown size={16} className="text-[var(--color-text-muted)]" /> : <ChevronRight size={16} className="text-[var(--color-text-muted)]" />}
          <h3 className="text-sm font-semibold text-[var(--color-text)]">Courier Travel Performance</h3>
          {summary && !loading && (
            <span className="ml-2 text-xs text-[var(--color-text-muted)]">
              {summary.slow_travel_orders} slow of {summary.total_late_orders} late ({summary.slow_travel_pct}%)
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

          {loading && !data && (
            <div className="flex h-32 items-center justify-center">
              <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                <Loader2 size={14} className="animate-spin" />
                Loading courier travel data...
              </div>
            </div>
          )}

          {data && (
            <>
              {/* KPI Cards */}
              <div className="grid grid-cols-4 gap-3">
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
                  <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                    <Users size={12} />
                    <span className="text-[10px] font-medium">Couriers Analyzed</span>
                  </div>
                  <p className="mt-1 text-lg font-bold text-[var(--color-text)]">
                    {data.couriers.length}
                  </p>
                </div>
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
                  <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                    <AlertTriangle size={12} />
                    <span className="text-[10px] font-medium">Slow Travel Orders</span>
                  </div>
                  <p className="mt-1 text-lg font-bold text-red-400">
                    {summary!.slow_travel_orders}
                    <span className="ml-1 text-xs font-normal text-[var(--color-text-muted)]">
                      ({summary!.slow_travel_pct}%)
                    </span>
                  </p>
                </div>
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
                  <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                    <Clock size={12} />
                    <span className="text-[10px] font-medium">Slow Pickup Travel</span>
                  </div>
                  <p className="mt-1 text-lg font-bold text-orange-400">
                    {data.orders.filter((o) => o.is_slow_pickup_travel).length}
                  </p>
                </div>
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
                  <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                    <Gauge size={12} />
                    <span className="text-[10px] font-medium">Slow Dropoff Travel</span>
                  </div>
                  <p className="mt-1 text-lg font-bold text-orange-400">
                    {data.orders.filter((o) => o.is_slow_dropoff_travel).length}
                  </p>
                </div>
              </div>

              <SpeedBenchmarkTable benchmarks={data.speed_benchmarks} targets={data.speed_targets} />
              <CourierTable couriers={data.couriers} orders={data.orders} city={city} benchmarks={data.speed_benchmarks} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
