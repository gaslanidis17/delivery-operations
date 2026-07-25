import { useMemo, useState, useEffect } from "react";
import { X } from "lucide-react";
import { Map as MapGL, NavigationControl } from "react-map-gl/maplibre";
import { DeckGL } from "@deck.gl/react";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { PickingInfo } from "@deck.gl/core";
import type { CityInfo, RetailTtlaVenueRow } from "../types";
import "maplibre-gl/dist/maplibre-gl.css";

const MAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const DEFAULT_VIEW = {
  longitude: 76.8512,
  latitude: 43.222,
  zoom: 11,
  pitch: 0,
  bearing: 0,
};

interface RetailTtlaMapProps {
  venues: RetailTtlaVenueRow[];
  cityInfo?: CityInfo;
  // Reference for the good/bad color split: the country target if set, else the
  // city average Accept latency.
  targetSec?: number | null;
  cityAvgSec?: number | null;
  // Venue highlighted from the table (keyed by venue_id, else name). Rendered with
  // a white halo + centred; clicking a dot reports its key back (null = cleared).
  selectedVenue?: string | null;
  onSelectVenue?: (key: string | null) => void;
}

// Stable selection key shared with the venue table (venue_id, else name).
function keyOf(v: { venue_id: string | null; venue_name: string }): string {
  return String(v.venue_id ?? v.venue_name);
}

// Higher Accept latency vs the reference = worse. Emerald (at/under) → amber → red (well
// over). Ratio is (avg / ref); 1.0 = on the line.
function ttlaColor(avg: number | null, ref: number | null): [number, number, number, number] {
  if (avg == null || ref == null || ref <= 0) return [148, 163, 184, 200];
  const ratio = avg / ref;
  if (ratio <= 1.0) return [16, 185, 129, 210];
  if (ratio <= 1.25) return [250, 204, 21, 210];
  if (ratio <= 1.6) return [249, 115, 22, 215];
  return [239, 68, 68, 220];
}

function fmtSec(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Math.round(v).toLocaleString()} s`;
}

function fmtMin(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v.toFixed(1)} min`;
}

function fmtImpactPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPp(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v.toFixed(2)} pp`;
}

export function RetailTtlaMap({
  venues,
  cityInfo,
  targetSec,
  cityAvgSec,
  selectedVenue,
  onSelectVenue,
}: RetailTtlaMapProps) {
  const ref = targetSec ?? cityAvgSec ?? null;

  const points = useMemo(
    () => venues.filter((v) => v.venue_lat != null && v.venue_long != null),
    [venues],
  );

  const selectedPoint = useMemo(
    () => (selectedVenue ? points.find((p) => keyOf(p) === selectedVenue) ?? null : null),
    [points, selectedVenue],
  );

  const [viewState, setViewState] = useState({
    ...DEFAULT_VIEW,
    longitude: cityInfo?.lon ?? DEFAULT_VIEW.longitude,
    latitude: cityInfo?.lat ?? DEFAULT_VIEW.latitude,
    zoom: cityInfo?.zoom ? cityInfo.zoom - 1 : DEFAULT_VIEW.zoom,
  });

  useEffect(() => {
    if (cityInfo) {
      setViewState((v) => ({
        ...v,
        longitude: cityInfo.lon,
        latitude: cityInfo.lat,
        zoom: cityInfo.zoom - 1,
      }));
    }
  }, [cityInfo]);

  // When a venue is picked in the table, fly to it (keep any deeper zoom the user
  // already had, but at least 13 so a single venue reads clearly).
  useEffect(() => {
    if (selectedPoint) {
      setViewState((v) => ({
        ...v,
        longitude: selectedPoint.venue_long as number,
        latitude: selectedPoint.venue_lat as number,
        zoom: Math.max(v.zoom, 13),
        transitionDuration: 600,
      }));
    }
  }, [selectedPoint]);

  const maxImpact = useMemo(
    () => Math.max(1, ...points.map((p) => Math.abs(p.ttla_impact_sec ?? 0))),
    [points],
  );

  const layers = useMemo(() => {
    if (points.length === 0) return [];
    const base = new ScatterplotLayer<RetailTtlaVenueRow>({
      id: "retail-ttla-venues",
      data: points,
      getPosition: (d) => [d.venue_long as number, d.venue_lat as number],
      // Radius scales with the venue's excess-Accept latency-seconds impact (its drag on
      // the segment average) so the biggest offenders read as the biggest dots.
      getRadius: (d) => 60 + (Math.abs(d.ttla_impact_sec ?? 0) / maxImpact) * 500,
      getFillColor: (d) => ttlaColor(d.avg_ttla_sec, ref),
      getLineColor: [15, 23, 42, 255],
      lineWidthMinPixels: 1,
      stroked: true,
      pickable: true,
      radiusMinPixels: 6,
      radiusMaxPixels: 60,
      opacity: 0.85,
      onClick: ({ object }: PickingInfo) =>
        onSelectVenue?.(object ? keyOf(object as RetailTtlaVenueRow) : null),
    });
    // A white halo ring drawn on top of the selected venue so it stands out.
    const highlight = selectedPoint
      ? new ScatterplotLayer<RetailTtlaVenueRow>({
          id: "retail-ttla-selected",
          data: [selectedPoint],
          getPosition: (d) => [d.venue_long as number, d.venue_lat as number],
          getRadius: (d) => 60 + (Math.abs(d.ttla_impact_sec ?? 0) / maxImpact) * 500,
          stroked: true,
          filled: false,
          getLineColor: [255, 255, 255, 255],
          lineWidthMinPixels: 3,
          radiusMinPixels: 14,
          radiusMaxPixels: 70,
          pickable: false,
        })
      : null;
    return highlight ? [base, highlight] : [base];
  }, [points, maxImpact, ref, selectedPoint, onSelectVenue]);

  const getTooltip = ({ object }: PickingInfo) => {
    if (!object) return null;
    const d = object as RetailTtlaVenueRow;
    const unassign = d.unassign_rate != null ? `${(d.unassign_rate * 100).toFixed(1)}%` : "—";
    const meta = [
      d.venue_type ? d.venue_type.replace(/_/g, " ") : null,
      d.account_manager ? `AM: ${d.account_manager}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      html: `<div style="padding:8px;font-size:12px;max-width:260px">
        <b>${d.venue_name ?? "Venue"}</b><br/>
        ${meta ? `<span style="color:#94a3b8">${meta}</span><br/>` : ""}
        Avg Accept latency: <b>${fmtSec(d.avg_ttla_sec)}</b> · impact ${fmtImpactPct(d.ttla_impact_pct)}<br/>
        Orders: ${d.order_count.toLocaleString()}<br/>
        Reassignment rate: <b>${unassign}</b> · contrib ${fmtPp(d.unassign_contribution_pp)}<br/>
        Avg prep: ${fmtMin(d.avg_prep_min)}<br/>
        Avg pickup service: ${fmtSec(d.avg_pickup_service_sec)}
      </div>`,
      style: {
        backgroundColor: "#1a1d29",
        color: "#e2e8f0",
        border: "1px solid #2a2e3d",
        borderRadius: "8px",
      },
    };
  };

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 text-xs">
        <span className="font-medium text-[var(--color-text)]">Venue map</span>
        <span className="text-[var(--color-text-muted)]">
          {points.length} of {venues.length} venues plotted · dot size = Accept latency impact · color = avg Accept latency
        </span>
        {selectedPoint && (
          <button
            onClick={() => onSelectVenue?.(null)}
            className="flex items-center gap-1 rounded-full border border-teal-500/50 bg-teal-500/10 px-2 py-0.5 text-[11px] font-medium text-teal-300 transition-colors hover:bg-teal-500/20"
            title="Clear highlighted venue"
          >
            <span className="max-w-[180px] truncate">{selectedPoint.venue_name}</span>
            <X size={11} />
          </button>
        )}
        <div className="ml-auto flex items-center gap-1.5 text-[var(--color-text-muted)]">
          <span>{ref != null ? (targetSec != null ? "vs target" : "vs segment avg") : "Accept latency"}</span>
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "rgb(16,185,129)" }} />
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "rgb(250,204,21)" }} />
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "rgb(249,115,22)" }} />
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "rgb(239,68,68)" }} />
          <span>slower →</span>
        </div>
      </div>

      <div className="relative h-[520px]">
        {points.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
            No venue coordinates to plot yet.
          </div>
        ) : (
          <DeckGL
            viewState={viewState}
            onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
            controller={true}
            layers={layers}
            getTooltip={getTooltip}
            onClick={(info: PickingInfo) => {
              if (!info.object) onSelectVenue?.(null);
            }}
          >
            <MapGL mapStyle={MAP_STYLE} attributionControl={false}>
              <NavigationControl position="top-right" />
            </MapGL>
          </DeckGL>
        )}
      </div>
    </div>
  );
}
