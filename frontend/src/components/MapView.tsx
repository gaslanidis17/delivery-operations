import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Map as MapGL, NavigationControl } from "react-map-gl/maplibre";
import { DeckGL } from "@deck.gl/react";
import { ScatterplotLayer } from "@deck.gl/layers";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import type { PickingInfo } from "@deck.gl/core";
import type { VenueMapPoint, HexMapPoint, HourlyPoint, CityInfo, LateOrder, RottenOrder } from "../types";
import "maplibre-gl/dist/maplibre-gl.css";

interface MapViewProps {
  venues: VenueMapPoint[];
  hexagons: HexMapPoint[];
  hourly: HourlyPoint[];
  loading: boolean;
  cityInfo?: CityInfo;
  lateOrders?: LateOrder[];
  rottenOrders?: RottenOrder[];
}

type LayerMode = "venues" | "dropoffs" | "both";

const DEFAULT_VIEW = {
  longitude: 76.8512,
  latitude: 43.222,
  zoom: 12,
  pitch: 45,
  bearing: 0,
};

const MAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

function deliveryTimeToColor(avgMin: number, minVal: number, maxVal: number): [number, number, number, number] {
  const range = maxVal - minVal || 1;
  const ratio = (avgMin - minVal) / range;
  if (ratio > 0.8) return [239, 68, 68, 200];
  if (ratio > 0.6) return [249, 115, 22, 200];
  if (ratio > 0.4) return [245, 158, 11, 200];
  if (ratio > 0.2) return [250, 204, 21, 180];
  return [16, 185, 129, 180];
}

interface AggregatedHex {
  h3_index: string;
  total_orders: number;
  late_orders: number;
  lateness_rate: number;
  avg_completion_min: number;
}

interface AggregatedVenue {
  venue_id: string;
  venue_name: string;
  venue_lat: number;
  venue_long: number;
  total_orders: number;
  late_orders: number;
  lateness_rate: number;
  avg_completion_min: number;
}

function aggregateOrdersByHex(orders: LateOrder[], hourFilter: number | null): AggregatedHex[] {
  const filtered = hourFilter != null
    ? orders.filter((o) => o.delivered_hour === hourFilter)
    : orders;

  const byHex = new Map<string, { total: number; late: number; sumComp: number; compN: number }>();
  for (const o of filtered) {
    if (!o.dropoff_h3_index) continue;
    const entry = byHex.get(o.dropoff_h3_index) ?? { total: 0, late: 0, sumComp: 0, compN: 0 };
    entry.total++;
    if (o.is_sla_breach) entry.late++;
    if (o.completion_time_min != null) {
      entry.sumComp += o.completion_time_min;
      entry.compN++;
    }
    byHex.set(o.dropoff_h3_index, entry);
  }

  return Array.from(byHex.entries()).map(([h3, e]) => ({
    h3_index: h3,
    total_orders: e.total,
    late_orders: e.late,
    lateness_rate: e.total > 0 ? Math.round((e.late / e.total) * 1000) / 10 : 0,
    avg_completion_min: e.compN > 0 ? Math.round((e.sumComp / e.compN) * 10) / 10 : 0,
  }));
}

function aggregateOrdersByVenue(orders: LateOrder[], hourFilter: number | null): AggregatedVenue[] {
  const filtered = hourFilter != null
    ? orders.filter((o) => o.delivered_hour === hourFilter)
    : orders;

  const byVenue = new Map<string, { name: string; lat: number; lon: number; total: number; late: number; sumComp: number; compN: number }>();
  for (const o of filtered) {
    if (!o.venue_id || o.venue_lat == null || o.venue_long == null) continue;
    const entry = byVenue.get(o.venue_id) ?? { name: o.venue_name, lat: o.venue_lat, lon: o.venue_long, total: 0, late: 0, sumComp: 0, compN: 0 };
    entry.total++;
    if (o.is_sla_breach) entry.late++;
    if (o.completion_time_min != null) {
      entry.sumComp += o.completion_time_min;
      entry.compN++;
    }
    byVenue.set(o.venue_id, entry);
  }

  return Array.from(byVenue.entries()).map(([id, e]) => ({
    venue_id: id,
    venue_name: e.name,
    venue_lat: e.lat,
    venue_long: e.lon,
    total_orders: e.total,
    late_orders: e.late,
    lateness_rate: e.total > 0 ? Math.round((e.late / e.total) * 1000) / 10 : 0,
    avg_completion_min: e.compN > 0 ? Math.round((e.sumComp / e.compN) * 10) / 10 : 0,
  }));
}

export function MapView({ venues, hexagons, hourly, loading, cityInfo, lateOrders, rottenOrders }: MapViewProps) {
  const [layerMode, setLayerMode] = useState<LayerMode>("both");
  const [is3D, setIs3D] = useState(true);
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [mapDateFrom, setMapDateFrom] = useState("");
  const [mapDateTo, setMapDateTo] = useState("");

  const [viewState, setViewState] = useState({
    ...DEFAULT_VIEW,
    longitude: cityInfo?.lon ?? DEFAULT_VIEW.longitude,
    latitude: cityInfo?.lat ?? DEFAULT_VIEW.latitude,
    zoom: cityInfo?.zoom ?? DEFAULT_VIEW.zoom,
  });

  useEffect(() => {
    if (cityInfo) {
      setViewState((v) => ({
        ...v,
        longitude: cityInfo.lon,
        latitude: cityInfo.lat,
        zoom: cityInfo.zoom,
        pitch: is3D ? 45 : 0,
      }));
    }
  }, [cityInfo]);

  useEffect(() => {
    setViewState((v) => ({ ...v, pitch: is3D ? 45 : 0 }));
  }, [is3D]);

  useEffect(() => {
    if (isPlaying) {
      playRef.current = setInterval(() => {
        setSelectedHour((prev) => {
          const next = (prev ?? -1) + 1;
          if (next > 23) {
            setIsPlaying(false);
            return null;
          }
          return next;
        });
      }, 800);
    }
    return () => {
      if (playRef.current) clearInterval(playRef.current);
    };
  }, [isPlaying]);

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      setIsPlaying(false);
    } else {
      setSelectedHour(0);
      setIsPlaying(true);
    }
  }, [isPlaying]);

  const mapOrders: LateOrder[] = useMemo(() => {
    if (lateOrders && lateOrders.length > 0) return lateOrders;
    if (!rottenOrders || rottenOrders.length === 0) return [];
    return rottenOrders.map((r) => ({
      ...r,
      is_sla_breach: r.is_late_official,
      is_sla_breach_official: r.is_late_official,
      status: "delivered",
      pre_estimate_avg: null,
      pre_estimate_high: null,
      delivered_at: "",
      received_at: "",
      pre_estimate_error_min: null,
      ready_vs_pickup_eta_sec: 0,
      courier_arrived_after_eta: false,
      courier_wait_at_venue_sec: 0,
      pickup_duration_min: null,
      initial_pickup_eta_min: 0,
      courier_task_total_min: 0,
      courier_started_before_ready: false,
      bundled_count: 0,
      time_to_last_accept_sec: null,
      dropoff_distance_m: 0,
      eta_error_seconds: 0,
      restaurant_total_time_min: 0,
      courier_travel_to_venue_min: 0,
    } as unknown as LateOrder));
  }, [lateOrders, rottenOrders]);

  const dateFilteredOrders = useMemo(() => {
    let result = mapOrders;
    if (mapDateFrom) {
      result = result.filter((o) => o.delivered_date >= mapDateFrom);
    }
    if (mapDateTo) {
      result = result.filter((o) => o.delivered_date <= mapDateTo);
    }
    return result;
  }, [mapOrders, mapDateFrom, mapDateTo]);

  const dateRange = useMemo(() => {
    if (mapOrders.length === 0) return { min: "", max: "" };
    const dates = mapOrders.map((o) => o.delivered_date).sort();
    return { min: dates[0], max: dates[dates.length - 1] };
  }, [mapOrders]);

  const hours = useMemo(() => {
    if (dateFilteredOrders.length > 0) {
      const set = new Set(dateFilteredOrders.map((o) => o.delivered_hour));
      return Array.from(set).sort((a, b) => a - b);
    }
    const set = new Set(hourly.map((h) => h.hour_of_day));
    return Array.from(set).sort((a, b) => a - b);
  }, [hourly, dateFilteredOrders]);

  const orderCountByHour = useMemo(() => {
    const counts = new Map<number, number>();
    if (dateFilteredOrders.length > 0) {
      for (const o of dateFilteredOrders) {
        counts.set(o.delivered_hour, (counts.get(o.delivered_hour) ?? 0) + 1);
      }
    } else {
      for (const h of hourly) {
        counts.set(h.hour_of_day, (counts.get(h.hour_of_day) ?? 0) + h.total_orders);
      }
    }
    return counts;
  }, [dateFilteredOrders, hourly]);

  const effectiveHexagons = useMemo(() => {
    if (dateFilteredOrders.length > 0) {
      return aggregateOrdersByHex(dateFilteredOrders, selectedHour);
    }
    return hexagons;
  }, [dateFilteredOrders, hexagons, selectedHour]);

  const effectiveVenues = useMemo(() => {
    if (dateFilteredOrders.length > 0) {
      return aggregateOrdersByVenue(dateFilteredOrders, selectedHour);
    }
    return venues.map((v) => ({
      venue_id: v.venue_id ?? "",
      venue_name: v.venue_name,
      venue_lat: v.venue_lat,
      venue_long: v.venue_long,
      total_orders: v.total_orders,
      late_orders: v.late_orders,
      lateness_rate: v.lateness_rate,
      avg_completion_min: v.avg_completion_min,
    }));
  }, [dateFilteredOrders, venues, selectedHour]);

  const maxVolume = useMemo(
    () => Math.max(1, ...effectiveHexagons.map((h) => h.total_orders)),
    [effectiveHexagons]
  );

  const avgTimeRange = useMemo(() => {
    const allTimes = [
      ...effectiveHexagons.map((h) => h.avg_completion_min),
      ...effectiveVenues.map((v) => v.avg_completion_min),
    ].filter((v) => v > 0);
    return {
      min: allTimes.length > 0 ? Math.min(...allTimes) : 0,
      max: allTimes.length > 0 ? Math.max(...allTimes) : 1,
    };
  }, [effectiveHexagons, effectiveVenues]);

  const layers = useMemo(() => {
    const result: any[] = [];

    if ((layerMode === "dropoffs" || layerMode === "both") && effectiveHexagons.length > 0) {
      result.push(
        new H3HexagonLayer<AggregatedHex>({
          id: "h3-hexagons",
          data: effectiveHexagons,
          getHexagon: (d) => d.h3_index,
          getFillColor: (d) => deliveryTimeToColor(d.avg_completion_min, avgTimeRange.min, avgTimeRange.max),
          getElevation: (d) => d.total_orders,
          extruded: is3D,
          elevationScale: is3D ? 15 : 0,
          pickable: true,
          opacity: 0.7,
          coverage: 0.9,
          wireframe: false,
        })
      );
    }

    if (layerMode === "venues" || layerMode === "both") {
      const maxVenueVol = Math.max(1, ...effectiveVenues.map((v) => v.total_orders));
      result.push(
        new ScatterplotLayer<AggregatedVenue>({
          id: "venues",
          data: effectiveVenues,
          getPosition: (d) => [d.venue_long, d.venue_lat],
          getRadius: (d) => 30 + (d.total_orders / maxVenueVol) * 250,
          getFillColor: (d) => deliveryTimeToColor(d.avg_completion_min, avgTimeRange.min, avgTimeRange.max),
          pickable: true,
          radiusMinPixels: 4,
          radiusMaxPixels: 40,
          opacity: 0.8,
        })
      );
    }

    return result;
  }, [effectiveVenues, effectiveHexagons, layerMode, maxVolume, is3D, avgTimeRange]);

  const getTooltip = useCallback(({ object }: PickingInfo) => {
    if (!object) return null;
    const d = object as any;
    const name = d.venue_name ?? `Hex ${(d.h3_index ?? "").slice(0, 8)}…`;
    return {
      html: `<div style="padding:8px;font-size:12px">
        <b>${name}</b><br/>
        Orders: ${d.total_orders}<br/>
        Late: ${d.late_orders} (${d.lateness_rate}%)<br/>
        Avg delivery: ${d.avg_completion_min?.toFixed(1) ?? "—"} min
      </div>`,
      style: {
        backgroundColor: "#1a1d29",
        color: "#e2e8f0",
        border: "1px solid #2a2e3d",
        borderRadius: "8px",
      },
    };
  }, []);

  if (loading) {
    return (
      <div className="flex h-[500px] items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="text-sm text-[var(--color-text-muted)]">Loading map data…</div>
      </div>
    );
  }

  const hasDateFilter = mapDateFrom || mapDateTo;

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-[var(--color-text-muted)]">Layer:</span>
          {(["venues", "dropoffs", "both"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setLayerMode(m)}
              className={`rounded px-2 py-1 capitalize transition-colors ${
                layerMode === m
                  ? "bg-[var(--color-primary)] text-white"
                  : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        <button
          onClick={() => setIs3D(!is3D)}
          className={`rounded px-2 py-1 text-xs transition-colors ${
            is3D
              ? "bg-[var(--color-primary)] text-white"
              : "bg-[var(--color-bg)] text-[var(--color-text-muted)]"
          }`}
        >
          3D
        </button>

        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-[var(--color-text-muted)]">Date:</span>
          <input
            type="date"
            value={mapDateFrom}
            min={dateRange.min}
            max={mapDateTo || dateRange.max}
            onChange={(e) => setMapDateFrom(e.target.value)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[11px] text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
          />
          <span className="text-[var(--color-text-muted)]">–</span>
          <input
            type="date"
            value={mapDateTo}
            min={mapDateFrom || dateRange.min}
            max={dateRange.max}
            onChange={(e) => setMapDateTo(e.target.value)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[11px] text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
          />
          {hasDateFilter && (
            <button
              onClick={() => { setMapDateFrom(""); setMapDateTo(""); }}
              className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              title="Clear date filter"
            >
              ✕
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
          <span>{effectiveVenues.length} venues · {effectiveHexagons.length} hex cells</span>
          {hasDateFilter && (
            <span className="inline-flex items-center rounded-full bg-[var(--color-primary)]/20 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-primary)]">
              filtered
            </span>
          )}
          <div className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: "rgb(16,185,129)" }} />
            <span>{Math.round(avgTimeRange.min)}m</span>
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: "rgb(250,204,21)" }} />
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: "rgb(245,158,11)" }} />
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: "rgb(249,115,22)" }} />
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: "rgb(239,68,68)" }} />
            <span>{Math.round(avgTimeRange.max)}m</span>
            <span className="ml-1 text-[var(--color-text-muted)]">avg delivery</span>
          </div>
          {is3D && <span>| Height = order volume</span>}
        </div>
      </div>

      <div className="relative h-[500px]">
        <DeckGL
          viewState={viewState}
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

      {hours.length > 0 && (() => {
        const maxCount = Math.max(1, ...Array.from(orderCountByHour.values()));
        return (
          <div className="border-t border-[var(--color-border)] px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-[var(--color-text)]">
                Timeline
                {selectedHour != null && (
                  <span className="ml-2 inline-flex items-center rounded-full bg-[var(--color-primary)]/20 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-primary)]">
                    {String(selectedHour).padStart(2, "0")}:00 – {String(selectedHour).padStart(2, "0")}:59
                  </span>
                )}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => { setSelectedHour(null); setIsPlaying(false); }}
                  className={`rounded-md px-2.5 py-1 text-[10px] font-medium transition-colors ${
                    selectedHour == null && !isPlaying
                      ? "bg-[var(--color-primary)] text-white"
                      : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  }`}
                >
                  All hours
                </button>
                <button
                  onClick={togglePlay}
                  className={`rounded-md px-2.5 py-1 text-[10px] font-medium transition-colors ${
                    isPlaying
                      ? "bg-red-500 text-white"
                      : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  }`}
                >
                  {isPlaying ? "⏹ Stop" : "▶ Play"}
                </button>
              </div>
            </div>

            {/* Bars */}
            <div className="flex items-end gap-[2px]" style={{ height: 44 }}>
              {Array.from({ length: 24 }, (_, h) => {
                const count = orderCountByHour.get(h) ?? 0;
                const intensity = count > 0 ? 0.2 + (count / maxCount) * 0.8 : 0.05;
                const isActive = selectedHour === h;
                const hasData = hours.includes(h);
                const barH = hasData ? Math.max(4, Math.round(intensity * 40)) : 2;
                return (
                  <button
                    key={h}
                    onClick={() => setSelectedHour(isActive ? null : h)}
                    className="flex-1 transition-all cursor-pointer"
                    style={{ minWidth: 0 }}
                    title={`${String(h).padStart(2, "0")}:00 — ${count} orders`}
                  >
                    <div
                      className="w-full transition-all duration-150"
                      style={{
                        height: isActive ? 44 : barH,
                        background: isActive
                          ? "var(--color-primary)"
                          : hasData
                            ? `rgba(99,102,241,${intensity})`
                            : "var(--color-bg)",
                        borderRadius: "3px 3px 0 0",
                      }}
                    />
                  </button>
                );
              })}
            </div>

            {/* Ruler line */}
            <div className="h-[1px] bg-[var(--color-border)]" />

            {/* Hour labels */}
            <div className="flex">
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="flex-1 text-center" style={{ minWidth: 0 }}>
                  <div
                    className="mx-auto h-[5px] w-[1px]"
                    style={{ background: h % 6 === 0 ? "var(--color-text-muted)" : "var(--color-border)" }}
                  />
                  <span
                    className="block tabular-nums leading-none"
                    style={{
                      fontSize: h % 2 === 0 ? 9 : 0,
                      color: selectedHour === h ? "var(--color-primary)" : "var(--color-text-muted)",
                      fontWeight: selectedHour === h ? 600 : 400,
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
        );
      })()}
    </div>
  );
}
