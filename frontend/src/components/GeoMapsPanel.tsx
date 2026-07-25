import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Map as MapGL, NavigationControl } from "react-map-gl/maplibre";
import { DeckGL } from "@deck.gl/react";
import { ScatterplotLayer } from "@deck.gl/layers";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import type { PickingInfo } from "@deck.gl/core";
import { latLngToCell } from "h3-js";
import { Loader2, Truck, Package, MapPin, ChevronLeft, ChevronRight, Play, Pause } from "lucide-react";
import { fetchCourierPositions, fetchOrderPositions } from "../api/client";
import {
  iso,
  addDays,
  SIZE_KIND_TO_FILTER,
  SIZE_KIND_LABEL,
  type SizeKind,
} from "../lib/calendar";
import type { CourierPositionRow, OrderPositionRow } from "../types";
import "maplibre-gl/dist/maplibre-gl.css";

type RenderMode = "dots" | "heatmap";

interface Props {
  city: string;
  /** Most recent day of the shared period; used only to seed the map's own day. */
  dateTo: string;
  size: SizeKind;
  vehicleType: string;
}

const MAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const H3_RES = 8;

const VEHICLE_COLORS: Record<string, [number, number, number]> = {
  MOTORCYCLE: [139, 92, 246],
  CAR: [59, 130, 246],
  EMOTORCYCLE: [168, 85, 247],
  EBICYCLE: [16, 185, 129],
  BICYCLE: [34, 197, 94],
  ECAR: [14, 165, 233],
  WALKER: [245, 158, 11],
  ESCOOTER: [236, 72, 153],
  VAN: [239, 68, 68],
  UNKNOWN: [148, 163, 184],
};

function violetRamp(t: number): [number, number, number, number] {
  return [139, 92, 246, Math.round(40 + Math.min(1, t) * 200)];
}
function amberRamp(t: number): [number, number, number, number] {
  return [245, 158, 11, Math.round(40 + Math.min(1, t) * 200)];
}

/** Median of a numeric array (robust to outliers for map centering). */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface DensityPoint {
  lat: number;
  lon: number;
  weight: number;
  color: [number, number, number];
  label: string;
  detail: string;
}

interface HexCell {
  h3: string;
  weight: number;
}

function DensityMap({
  points,
  mode,
  ramp,
  center,
  countLabel,
}: {
  points: DensityPoint[];
  mode: RenderMode;
  ramp: (t: number) => [number, number, number, number];
  center: { longitude: number; latitude: number; zoom: number };
  countLabel: string;
}) {
  const [viewState, setViewState] = useState({
    longitude: center.longitude,
    latitude: center.latitude,
    zoom: center.zoom,
    pitch: 0,
    bearing: 0,
  });

  // Recenter when the city (center) changes meaningfully.
  useEffect(() => {
    setViewState((v) => ({ ...v, longitude: center.longitude, latitude: center.latitude, zoom: center.zoom }));
  }, [center.longitude, center.latitude, center.zoom]);

  const hexCells = useMemo<HexCell[]>(() => {
    if (mode !== "heatmap") return [];
    const m = new Map<string, number>();
    for (const p of points) {
      const h = latLngToCell(p.lat, p.lon, H3_RES);
      m.set(h, (m.get(h) || 0) + p.weight);
    }
    return Array.from(m.entries()).map(([h3, weight]) => ({ h3, weight }));
  }, [points, mode]);

  const maxHexWeight = useMemo(
    () => Math.max(1, ...hexCells.map((c) => c.weight)),
    [hexCells]
  );
  const maxPointWeight = useMemo(
    () => Math.max(1, ...points.map((p) => p.weight)),
    [points]
  );

  const layers = useMemo(() => {
    // deck.gl layer typing is loose here (mirrors MapView.tsx).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any[] = [];
    if (mode === "heatmap") {
      result.push(
        new H3HexagonLayer<HexCell>({
          id: "density-hex",
          data: hexCells,
          getHexagon: (d) => d.h3,
          getFillColor: (d) => ramp(d.weight / maxHexWeight),
          extruded: false,
          pickable: true,
          opacity: 0.75,
          coverage: 0.95,
        })
      );
    } else {
      result.push(
        new ScatterplotLayer<DensityPoint>({
          id: "density-dots",
          data: points,
          getPosition: (d) => [d.lon, d.lat],
          getRadius: (d) => 20 + (d.weight / maxPointWeight) * 120,
          getFillColor: (d) => [...d.color, 180] as [number, number, number, number],
          radiusMinPixels: 2.5,
          radiusMaxPixels: 26,
          pickable: true,
          opacity: 0.85,
          stroked: false,
        })
      );
    }
    return result;
  }, [mode, hexCells, points, maxHexWeight, maxPointWeight, ramp]);

  const getTooltip = useCallback(({ object }: PickingInfo) => {
    if (!object) return null;
    const o = object as Partial<DensityPoint & HexCell>;
    if (o.h3 !== undefined) {
      return {
        html: `<div style="padding:6px 8px;font-size:12px"><b>${countLabel}:</b> ${Math.round(o.weight ?? 0)}</div>`,
        style: { backgroundColor: "#1a1d29", color: "#e2e8f0", border: "1px solid #2a2e3d", borderRadius: "8px" },
      };
    }
    return {
      html: `<div style="padding:6px 8px;font-size:12px"><b>${o.label ?? ""}</b><br/>${o.detail ?? ""}</div>`,
      style: { backgroundColor: "#1a1d29", color: "#e2e8f0", border: "1px solid #2a2e3d", borderRadius: "8px" },
    };
  }, [countLabel]);

  return (
    <div className="relative h-[440px] overflow-hidden rounded-lg border border-[var(--color-border)]">
      <DeckGL
        viewState={viewState}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
        controller={true}
        layers={layers}
        getTooltip={getTooltip}
      >
        <MapGL mapStyle={MAP_STYLE} attributionControl={false}>
          <NavigationControl position="top-right" />
        </MapGL>
      </DeckGL>
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function GeoMapsPanel({ city, dateTo, size, vehicleType }: Props) {
  const [couriers, setCouriers] = useState<CourierPositionRow[]>([]);
  const [orders, setOrders] = useState<OrderPositionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<RenderMode>("dots");

  // The maps use their OWN single day (independent of the calendars' period) plus
  // an hour range, so couriers (one point per courier per hour) are comparable to
  // the per-occurrence orders within the same day/hours.
  const fallbackDay = iso(addDays(new Date(), -1));
  const [mapDate, setMapDate] = useState<string>(dateTo || fallbackDay);
  const [hourStart, setHourStart] = useState<number>(0);
  const [hourEnd, setHourEnd] = useState<number>(23);

  // Timelapse playback: sweeps a single-hour window across the day.
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(800);
  const playHourRef = useRef<number>(0);

  // When the city changes, snap the map day back to the most recent shared day.
  useEffect(() => {
    setMapDate(dateTo || fallbackDay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city]);

  // Drive the timelapse: advance the focused hour, looping 0→23.
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => {
      const next = (playHourRef.current + 1) % 24;
      playHourRef.current = next;
      setHourStart(next);
      setHourEnd(next);
    }, speed);
    return () => clearInterval(id);
  }, [isPlaying, speed]);

  // Stop playback whenever the underlying data reloads (day/filter change).
  useEffect(() => {
    setIsPlaying(false);
  }, [mapDate, size, vehicleType]);

  const sizeFilter = SIZE_KIND_TO_FILTER[size];
  const rangeAllHours = hourStart === 0 && hourEnd === 23;

  const load = useCallback(async () => {
    if (!mapDate) return;
    setLoading(true);
    setError(null);
    try {
      const [c, o] = await Promise.all([
        fetchCourierPositions(city, mapDate, mapDate, vehicleType),
        fetchOrderPositions(city, mapDate, mapDate, sizeFilter),
      ]);
      setCouriers(c.rows);
      setOrders(o.rows);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load map data");
    } finally {
      setLoading(false);
    }
  }, [city, mapDate, sizeFilter, vehicleType]);

  useEffect(() => {
    load();
  }, [load]);

  const inRange = useCallback(
    (h: number) => h >= hourStart && h <= hourEnd,
    [hourStart, hourEnd]
  );

  // Courier density points within the selected hour range (one per courier per hour).
  const courierPoints = useMemo<DensityPoint[]>(() => {
    return couriers
      .filter((r) => inRange(r.hour_of_day))
      .map((r) => ({
        lat: r.lat,
        lon: r.lon,
        weight: 1,
        color: VEHICLE_COLORS[r.vehicle_type] ?? VEHICLE_COLORS.UNKNOWN,
        label: r.vehicle_type,
        detail: `Courier ${r.courier_id} · ${String(r.hour_of_day).padStart(2, "0")}:00`,
      }));
  }, [couriers, inRange]);

  // Order density points aggregated by venue across the selected hour range.
  const orderPoints = useMemo<DensityPoint[]>(() => {
    const byVenue = new Map<string, { lat: number; lon: number; orders: number; name: string }>();
    for (const r of orders) {
      if (!inRange(r.hour_of_day)) continue;
      const key = `${r.lat},${r.lon}`;
      const e = byVenue.get(key) ?? { lat: r.lat, lon: r.lon, orders: 0, name: r.venue_name ?? "Venue" };
      e.orders += r.orders;
      byVenue.set(key, e);
    }
    return Array.from(byVenue.values()).map((e) => ({
      lat: e.lat,
      lon: e.lon,
      weight: e.orders,
      color: [245, 158, 11],
      label: e.name,
      detail: `${e.orders.toLocaleString()} ${SIZE_KIND_LABEL[size]} orders`,
    }));
  }, [orders, inRange, size]);

  // Map center: median of the day's points (robust to stray coordinates).
  const center = useMemo(() => {
    const lats = [...couriers.map((c) => c.lat), ...orders.map((o) => o.lat)].filter((v) => v);
    const lons = [...couriers.map((c) => c.lon), ...orders.map((o) => o.lon)].filter((v) => v);
    return {
      latitude: lats.length ? median(lats) : 43.238,
      longitude: lons.length ? median(lons) : 76.889,
      zoom: 11,
    };
  }, [couriers, orders]);

  // Timeline bars: total orders per hour-of-day for the selected day.
  const ordersByHour = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of orders) m.set(r.hour_of_day, (m.get(r.hour_of_day) || 0) + r.orders);
    return m;
  }, [orders]);
  const maxHourOrders = useMemo(() => Math.max(1, ...Array.from(ordersByHour.values())), [ordersByHour]);

  const distinctCouriers = useMemo(
    () => new Set(couriers.filter((r) => inRange(r.hour_of_day)).map((r) => r.courier_id)).size,
    [couriers, inRange]
  );

  const shiftDay = useCallback((delta: number) => {
    setMapDate((d) => iso(addDays(new Date((d || fallbackDay) + "T00:00:00"), delta)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStart = (v: number) => {
    setIsPlaying(false);
    setHourStart(v);
    if (v > hourEnd) setHourEnd(v);
  };
  const handleEnd = (v: number) => {
    setIsPlaying(false);
    setHourEnd(v);
    if (v < hourStart) setHourStart(v);
  };
  const handleBarClick = (h: number) => {
    setIsPlaying(false);
    // Click a bar to focus that single hour; click the same single hour to reset.
    if (hourStart === h && hourEnd === h) {
      setHourStart(0);
      setHourEnd(23);
    } else {
      setHourStart(h);
      setHourEnd(h);
    }
  };
  const togglePlay = () => {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    // Start the sweep from the current focused hour (or 0 if a range is active).
    const start = hourStart === hourEnd ? hourStart : 0;
    playHourRef.current = start;
    setHourStart(start);
    setHourEnd(start);
    setIsPlaying(true);
  };

  const today = iso(new Date());

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <MapPin size={16} className="text-violet-400" />
        <h3 className="text-sm font-semibold text-[var(--color-text)]">Vehicle &amp; Order Maps</h3>
        {loading && <Loader2 size={14} className="animate-spin text-violet-400" />}
        <div className="ml-auto flex items-center gap-1.5 text-xs">
          <span className="text-[var(--color-text-muted)]">View:</span>
          {(["dots", "heatmap"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded px-2 py-1 capitalize transition-colors ${
                mode === m
                  ? "bg-[var(--color-primary)] text-white"
                  : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-4 text-xs text-[var(--color-text-muted)]">
        Left: where available couriers were online (real couriers only — delivered or online &gt;15&nbsp;min that day).
        Right: where {size === "hl" ? "Tier A/Tier B" : SIZE_KIND_LABEL[size]} jobs came from.
        Single day. {rangeAllHours
          ? "Showing all hours."
          : `Showing ${String(hourStart).padStart(2, "0")}:00–${String(hourEnd).padStart(2, "0")}:59.`}
      </p>

      {/* Map-specific day + hour-range controls */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-[var(--color-text-muted)]">Day</label>
          <div className="flex items-center gap-1">
            <button
              onClick={() => shiftDay(-1)}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              title="Previous day"
            >
              <ChevronLeft size={15} />
            </button>
            <input
              type="date"
              value={mapDate}
              max={today}
              onChange={(e) => setMapDate(e.target.value)}
              className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
            />
            <button
              onClick={() => shiftDay(1)}
              disabled={mapDate >= today}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-40"
              title="Next day"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-[var(--color-text-muted)]">Hours</label>
          <div className="flex items-center gap-1 text-sm">
            <select
              value={hourStart}
              onChange={(e) => handleStart(Number(e.target.value))}
              className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
              ))}
            </select>
            <span className="text-[var(--color-text-muted)]">to</span>
            <select
              value={hourEnd}
              onChange={(e) => handleEnd(Number(e.target.value))}
              className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>{String(h).padStart(2, "0")}:59</option>
              ))}
            </select>
          </div>
        </div>

        {!rangeAllHours && (
          <button
            onClick={() => { setIsPlaying(false); setHourStart(0); setHourEnd(23); }}
            className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            All hours
          </button>
        )}

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-[var(--color-text-muted)]">Timelapse</label>
          <div className="flex items-center gap-1">
            <button
              onClick={togglePlay}
              className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors ${
                isPlaying
                  ? "bg-red-500 text-white hover:bg-red-600"
                  : "bg-[var(--color-primary)] text-white hover:opacity-90"
              }`}
              title={isPlaying ? "Pause timelapse" : "Play timelapse across the day"}
            >
              {isPlaying ? <Pause size={14} /> : <Play size={14} />}
              {isPlaying ? "Pause" : "Play"}
            </button>
            <select
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-xs text-[var(--color-text)]"
              title="Playback speed"
            >
              <option value={1500}>0.5×</option>
              <option value={800}>1×</option>
              <option value={400}>2×</option>
              <option value={200}>4×</option>
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[var(--color-text)]">
            <Truck size={13} className="text-violet-400" />
            Available couriers (online)
            <span className="text-[var(--color-text-muted)]">· {distinctCouriers.toLocaleString()} couriers{vehicleType !== "all" ? ` (${vehicleType})` : ""}</span>
          </div>
          <DensityMap points={courierPoints} mode={mode} ramp={violetRamp} center={center} countLabel="Couriers" />
        </div>
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[var(--color-text)]">
            <Package size={13} className="text-amber-400" />
            Order origins (by venue)
            <span className="text-[var(--color-text-muted)]">· {orderPoints.reduce((s, p) => s + p.weight, 0).toLocaleString()} orders</span>
          </div>
          <DensityMap points={orderPoints} mode={mode} ramp={amberRamp} center={center} countLabel="Orders" />
        </div>
      </div>

      {/* Hour-of-day timeline for the selected day. Click a bar to focus one hour. */}
      <div className="mt-4 border-t border-[var(--color-border)] pt-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-medium text-[var(--color-text)]">
            Orders by hour — {mapDate}
            <span className="ml-2 inline-flex items-center rounded-full bg-[var(--color-primary)]/20 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-primary)]">
              {String(hourStart).padStart(2, "0")}:00 – {String(hourEnd).padStart(2, "0")}:59
            </span>
          </span>
          <span className="text-[10px] text-[var(--color-text-muted)]">click a bar to focus an hour</span>
        </div>

        <div className="flex items-end gap-[2px]" style={{ height: 44 }}>
          {HOURS.map((h) => {
            const count = ordersByHour.get(h) ?? 0;
            const intensity = count > 0 ? 0.2 + (count / maxHourOrders) * 0.8 : 0.05;
            const isActive = inRange(h);
            const barH = count > 0 ? Math.max(4, Math.round(intensity * 40)) : 2;
            return (
              <button
                key={h}
                onClick={() => handleBarClick(h)}
                className="flex-1 cursor-pointer transition-all"
                style={{ minWidth: 0 }}
                title={`${String(h).padStart(2, "0")}:00 — ${count.toLocaleString()} orders`}
              >
                <div
                  className="w-full transition-all duration-150"
                  style={{
                    height: Math.max(barH, isActive ? 6 : barH),
                    background: isActive ? "var(--color-primary)" : `rgba(99,102,241,${intensity})`,
                    borderRadius: "3px 3px 0 0",
                    opacity: isActive ? 1 : 0.5,
                  }}
                />
              </button>
            );
          })}
        </div>
        <div className="h-[1px] bg-[var(--color-border)]" />
        <div className="flex">
          {HOURS.map((h) => (
            <div key={h} className="flex-1 text-center" style={{ minWidth: 0 }}>
              <span
                className="block tabular-nums leading-none"
                style={{
                  fontSize: h % 2 === 0 ? 9 : 0,
                  color: inRange(h) ? "var(--color-primary)" : "var(--color-text-muted)",
                  marginTop: 2,
                  visibility: h % 2 === 0 ? "visible" : "hidden",
                }}
              >
                {String(h).padStart(2, "0")}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
