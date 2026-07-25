import { useEffect, useMemo, useState, useCallback } from "react";
import { Loader2, PieChart } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { fetchVehicleShare } from "../api/client";
import type { VehicleShareResponse, VehicleShareRow } from "../types";

interface Props {
  city: string;
  lookbackDays: number;
}

type SizeKind = "heavy" | "large" | "hl";

const SIZE_OPTIONS: { value: SizeKind; label: string; field: keyof Pick<VehicleShareRow, "heavy_orders" | "large_orders" | "hl_orders"> }[] = [
  { value: "hl", label: "Tier A | Tier B", field: "hl_orders" },
  { value: "heavy", label: "Tier A", field: "heavy_orders" },
  { value: "large", label: "Tier B", field: "large_orders" },
];

const COLORS = ["#8b5cf6", "#60a5fa", "#34d399", "#f59e0b", "#ef4444", "#ec4899", "#14b8a6", "#f97316", "#a3e635"];

export function VehicleSharePanel({ city, lookbackDays }: Props) {
  const [data, setData] = useState<VehicleShareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<SizeKind>("hl");
  const [selectedVehicle, setSelectedVehicle] = useState<string>("");

  const field = useMemo(() => SIZE_OPTIONS.find((o) => o.value === size)!.field, [size]);
  const sizeLabel = SIZE_OPTIONS.find((o) => o.value === size)!.label;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchVehicleShare(city, lookbackDays);
      setData(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load vehicle share");
    } finally {
      setLoading(false);
    }
  }, [city, lookbackDays]);

  useEffect(() => {
    load();
  }, [load]);

  // Per-day totals + per-vehicle counts for the selected size.
  const { dayTotals, perVehicleTotals, grandTotal, dates } = useMemo(() => {
    const dayTotals = new Map<string, number>();
    const perVehicleTotals = new Map<string, number>();
    let grandTotal = 0;
    if (data) {
      for (const r of data.rows) {
        const v = (r[field] as number) || 0;
        if (v === 0) continue;
        dayTotals.set(r.confirmed_date, (dayTotals.get(r.confirmed_date) || 0) + v);
        perVehicleTotals.set(r.vehicle_type, (perVehicleTotals.get(r.vehicle_type) || 0) + v);
        grandTotal += v;
      }
    }
    const dates = [...dayTotals.keys()].sort();
    return { dayTotals, perVehicleTotals, grandTotal, dates };
  }, [data, field]);

  // Vehicle rows sorted by total share desc.
  const vehicleRows = useMemo(() => {
    const rows = Array.from(perVehicleTotals.entries()).map(([vt, orders]) => ({
      vehicle_type: vt,
      orders,
      share_pct: grandTotal > 0 ? (orders / grandTotal) * 100 : 0,
    }));
    rows.sort((a, b) => b.orders - a.orders);
    return rows;
  }, [perVehicleTotals, grandTotal]);

  // Default the graph's selected vehicle to the top one once data arrives.
  useEffect(() => {
    if (vehicleRows.length > 0 && !vehicleRows.some((r) => r.vehicle_type === selectedVehicle)) {
      setSelectedVehicle(vehicleRows[0].vehicle_type);
    }
  }, [vehicleRows, selectedVehicle]);

  // Recompute per-day share for the selected vehicle (needs perDayVehicle).
  const dailyShare = useMemo(() => {
    if (!data || !selectedVehicle) return [] as { date: string; share_pct: number; orders: number }[];
    const perDayVehicle = new Map<string, Map<string, number>>();
    for (const r of data.rows) {
      const v = (r[field] as number) || 0;
      if (v === 0) continue;
      if (!perDayVehicle.has(r.confirmed_date)) perDayVehicle.set(r.confirmed_date, new Map());
      perDayVehicle.get(r.confirmed_date)!.set(r.vehicle_type, v);
    }
    return dates.map((d) => {
      const total = dayTotals.get(d) || 0;
      const vc = perDayVehicle.get(d)?.get(selectedVehicle) || 0;
      return {
        date: d,
        orders: vc,
        share_pct: total > 0 ? Math.round((vc / total) * 1000) / 10 : 0,
      };
    });
  }, [data, field, selectedVehicle, dates, dayTotals]);

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-1 flex items-center gap-2">
        <PieChart size={16} className="text-violet-400" />
        <h3 className="text-sm font-semibold text-[var(--color-text)]">Vehicle Share of Tier A/Tier B Deliveries</h3>
        {loading && <Loader2 size={14} className="animate-spin text-violet-400" />}
      </div>
      <p className="mb-4 text-xs text-[var(--color-text-muted)]">
        Of all {sizeLabel} orders, what share each vehicle type delivered (by the delivering courier's vehicle).
      </p>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-[var(--color-text-muted)]">Order type</label>
          <select
            value={size}
            onChange={(e) => setSize(e.target.value as SizeKind)}
            className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
          >
            {SIZE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-[var(--color-text-muted)]">Vehicle (graph)</label>
          <select
            value={selectedVehicle}
            onChange={(e) => setSelectedVehicle(e.target.value)}
            className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
          >
            {vehicleRows.map((r) => (
              <option key={r.vehicle_type} value={r.vehicle_type}>{r.vehicle_type}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {!error && (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Average table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                  <th className="px-2 py-1.5">Vehicle</th>
                  <th className="px-2 py-1.5 text-right">Orders</th>
                  <th className="px-2 py-1.5 text-right">Share %</th>
                </tr>
              </thead>
              <tbody>
                {vehicleRows.map((r, i) => (
                  <tr
                    key={r.vehicle_type}
                    className={`cursor-pointer border-b border-[var(--color-border)]/30 hover:bg-[var(--color-bg)]/40 ${
                      r.vehicle_type === selectedVehicle ? "bg-[var(--color-bg)]/30" : ""
                    }`}
                    onClick={() => setSelectedVehicle(r.vehicle_type)}
                  >
                    <td className="px-2 py-1.5 font-medium text-[var(--color-text)]">
                      <span
                        className="mr-1.5 inline-block h-2 w-2 rounded-full"
                        style={{ background: COLORS[i % COLORS.length] }}
                      />
                      {r.vehicle_type}
                    </td>
                    <td className="px-2 py-1.5 text-right text-[var(--color-text-muted)]">{r.orders.toLocaleString()}</td>
                    <td className="px-2 py-1.5 text-right font-medium text-[var(--color-text)]">{r.share_pct.toFixed(1)}%</td>
                  </tr>
                ))}
                {vehicleRows.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-2 py-6 text-center text-[var(--color-text-muted)]">
                      {loading ? "Loading…" : "No data for this period."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Daily share graph for selected vehicle */}
          <div>
            <p className="mb-2 text-xs text-[var(--color-text-muted)]">
              Daily share for <span className="font-semibold text-[var(--color-text)]">{selectedVehicle || "—"}</span>
            </p>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={dailyShare}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                  tickFormatter={(v) => v.slice(5)}
                />
                <YAxis
                  tickFormatter={(v) => `${v}%`}
                  tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                  domain={[0, 100]}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "8px",
                    fontSize: 12,
                  }}
                  formatter={(value, _name, item) => {
                    const payload = item.payload as { orders?: number } | undefined;
                    return [
                      `${Number(value ?? 0)}% (${payload?.orders ?? 0} orders)`,
                      "Share",
                    ];
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="share_pct"
                  name="Share"
                  stroke="#8b5cf6"
                  strokeWidth={2}
                  dot={{ r: 2, fill: "#8b5cf6" }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
