import { useMemo, useState, type ReactNode } from "react";
import { Map as MapGL, NavigationControl } from "react-map-gl/maplibre";
import { DeckGL } from "@deck.gl/react";
import { ScatterplotLayer, LineLayer } from "@deck.gl/layers";
import type { Layer } from "@deck.gl/core";
import { MapPin, Building2, Car, Clock, AlertTriangle, type LucideIcon } from "lucide-react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { VenueDiagLocationPack } from "../../types";
import { SectionHeader } from "./SectionHeader";
import { InfoTooltip } from "./InfoTooltip";

// "Where this venue sits in the city" — the geo investigation the panel lacked.
// Plots the venue pin against the curated city-centre marker on a real map, and
// states the great-circle distance + a coarse position band (centre / inner /
// outer / far outskirts), a mall heuristic, and a rush-hour traffic hint derived
// from the venue's OWN hourly Accept latency (no external traffic feed). Backend-computed
// in `venue_diagnostics._geo_signal`; this component only renders.

const MAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const VENUE_COLOR: [number, number, number, number] = [20, 184, 166, 230];
const CENTER_COLOR: [number, number, number, number] = [56, 189, 248, 220];

interface Pt {
  position: [number, number];
}
interface Seg {
  source: [number, number];
  target: [number, number];
}

function positionTone(label: string | null | undefined): string {
  switch (label) {
    case "city centre":
    case "inner city":
      return "text-emerald-400";
    case "outer city":
      return "text-amber-400";
    case "far outskirts":
      return "text-red-400";
    default:
      return "text-[var(--color-text)]";
  }
}

// Fit the view to show both the venue and the city centre (with margin). Falls
// back to centring on the venue when there is no curated centre for this city.
function fitViewState(lat: number, lon: number, cLat: number | null, cLon: number | null) {
  if (cLat == null || cLon == null) {
    return { longitude: lon, latitude: lat, zoom: 12, pitch: 0, bearing: 0 };
  }
  const span = Math.max(Math.abs(lon - cLon), Math.abs(lat - cLat), 0.01) * 4;
  const zoom = Math.max(9, Math.min(14, Math.log2(360 / span)));
  return {
    longitude: (lon + cLon) / 2,
    latitude: (lat + cLat) / 2,
    zoom,
    pitch: 0,
    bearing: 0,
  };
}

function SignalRow({
  icon: Icon,
  tone,
  label,
  children,
}: {
  icon: LucideIcon;
  tone?: string;
  label: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-1.5">
      <Icon size={13} className={`mt-0.5 shrink-0 ${tone ?? "text-[var(--color-text-muted)]"}`} />
      <div className="min-w-0 text-[11px]">
        <span className="text-[var(--color-text-muted)]">{label}: </span>
        <span className="text-[var(--color-text)]">{children}</span>
      </div>
    </div>
  );
}

export function VenueLocationPanel({
  location,
  city,
}: {
  location: VenueDiagLocationPack;
  city?: string | null;
}) {
  if (!location.found) return null;
  const lat = location.lat ?? null;
  const lon = location.lon ?? null;
  const cLat = location.city_center_lat ?? null;
  const cLon = location.city_center_lon ?? null;
  const dist = location.distance_km_from_center ?? null;
  const pos = location.position_label ?? null;
  const hasCoords = lat != null && lon != null;

  const [viewState, setViewState] = useState<any>(lat != null && lon != null ? fitViewState(lat, lon, cLat, cLon) : null);

  const layers = useMemo<Layer[]>(() => {
    if (!hasCoords) return [];
    const out: Layer[] = [];
    if (cLat != null && cLon != null) {
      out.push(
        new LineLayer<Seg>({
          id: "venue-center-line",
          data: [{ source: [cLon, cLat], target: [lon as number, lat as number] }],
          getSourcePosition: (d) => d.source,
          getTargetPosition: (d) => d.target,
          getColor: [148, 163, 184, 110],
          getWidth: 1,
          widthMinPixels: 1,
          pickable: false,
        }),
      );
    }
    if (cLat != null && cLon != null) {
      out.push(
        new ScatterplotLayer<Pt>({
          id: "venue-city-center",
          data: [{ position: [cLon, cLat] }],
          getPosition: (d) => d.position,
          getRadius: 200,
          radiusMinPixels: 5,
          radiusMaxPixels: 10,
          getFillColor: CENTER_COLOR,
          stroked: true,
          getLineColor: [255, 255, 255, 160],
          lineWidthMinPixels: 1,
          pickable: false,
        }),
      );
    }
    out.push(
      new ScatterplotLayer<Pt>({
        id: "venue-pin",
        data: [{ position: [lon as number, lat as number] }],
        getPosition: (d) => d.position,
        getRadius: 300,
        radiusMinPixels: 8,
        radiusMaxPixels: 16,
        getFillColor: VENUE_COLOR,
        stroked: true,
        getLineColor: [15, 23, 42, 255],
        lineWidthMinPixels: 1,
        pickable: false,
      }),
    );
    return out;
  }, [hasCoords, lat, lon, cLat, cLon]);

  const distText = dist != null ? `${dist.toLocaleString()} km from ${city ?? "city"} centre` : null;
  const contextBits = [
    location.venue_type ? location.venue_type.replace(/_/g, " ") : null,
    location.brand_name,
    location.is_hub_store ? "Hub store" : null,
  ].filter(Boolean);

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 min-w-0">
      <SectionHeader
        icon={MapPin}
        title={city ? `Where this venue sits in ${city}` : "Where this venue sits"}
        subtitle={
          <>
            {distText ? (
              <>
                <span className={positionTone(pos)}>{distText}</span>
                {pos && <span className="text-[var(--color-text-muted)]"> · {pos}</span>}
              </>
            ) : hasCoords ? (
              "Coordinates plotted on the map"
            ) : (
              "No coordinates available for this venue"
            )}
          </>
        }
        explainer={
          <>
            The map plots the venue (teal) against the curated city centre (sky). The distance is the
            great-circle km from that centre; the band is <strong>city centre / inner / outer / far
            outskirts</strong>. <strong>Mall</strong> is a heuristic from the venue type/brand/notes
            (a multi-entrance / hard-to-find-pickup risk). <strong>Traffic</strong> is derived from
            THIS venue&rsquo;s own slowest hours falling in the local rush window (07-09 / 17-19) —
            it is NOT a live traffic feed. Treat &ldquo;hard-to-reach&rdquo; as a hypothesis until a
            courier conversation theme corroborates it.
          </>
        }
      />

      <div className="grid gap-3 md:grid-cols-2">
        <div className="relative h-[220px] min-w-0 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
          {hasCoords && viewState ? (
            <DeckGL
              viewState={viewState}
              onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
              controller={true}
              layers={layers}
            >
              <MapGL mapStyle={MAP_STYLE} attributionControl={false}>
                <NavigationControl position="top-right" showCompass={false} />
              </MapGL>
            </DeckGL>
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-[var(--color-text-muted)]">
              No coordinates to plot for this venue.
            </div>
          )}
          {hasCoords && (
            <div className="pointer-events-none absolute bottom-1 left-2 flex items-center gap-3 text-[10px] text-[var(--color-text-muted)]">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: "rgb(20,184,166)" }} /> venue
              </span>
              {cLat != null && (
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: "rgb(56,189,248)" }} /> city centre
                </span>
              )}
            </div>
          )}
        </div>

        <div className="space-y-2">
          {contextBits.length > 0 && (
            <div className="flex flex-wrap gap-1 text-[10px]">
              {contextBits.map((b, i) => (
                <span key={i} className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[var(--color-text-muted)]">
                  {b}
                </span>
              ))}
            </div>
          )}

          {dist != null && (
            <div className="text-sm">
              <span className={`font-bold tabular-nums ${positionTone(pos)}`}>{dist.toLocaleString()} km</span>
              <span className="text-[var(--color-text-muted)]"> from {city ?? "city"} centre</span>
              {pos && <span className={`ml-1 font-medium ${positionTone(pos)}`}>· {pos}</span>}
              <InfoTooltip text="Great-circle distance from the curated city-centre coordinates. The band is a coarse read of how central the venue is: ≤2 km centre, ≤5 inner, ≤10 outer, else far outskirts." />
            </div>
          )}

          <div className="space-y-1.5">
            {location.mall_hint && (
              <SignalRow icon={Building2} tone="text-sky-400" label="Mall / shopping centre">
                likely ({location.mall_reason ?? "matched"})
                <InfoTooltip text="Heuristic: the venue type, brand, franchise or courier notes match a shopping-mall keyword (e.g. 'mall', 'ТРЦ', 'Mega'). Malls often mean multiple entrances / hard-to-find pickup points." />
              </SignalRow>
            )}
            {location.traffic_hint && (
              <SignalRow icon={Car} tone="text-amber-400" label="Traffic">
                {location.traffic_hint}
                <InfoTooltip text="Derived from THIS venue's own slowest hours falling in the local rush window (07-09 / 17-19). It is a traffic / access-congestion signal, not a live traffic feed." />
              </SignalRow>
            )}
            {location.worst_hours_near_close && (
              <SignalRow icon={Clock} tone="text-amber-400" label="Opening hours">
                worst Accept latency in the last hour(s) before close
              </SignalRow>
            )}
            {location.out_of_hours_order_share != null && location.out_of_hours_order_share > 0.05 && (
              <SignalRow icon={AlertTriangle} tone="text-amber-400" label="Out-of-hours">
                {Math.round(location.out_of_hours_order_share * 100)}% of orders land outside the parsed opening hours
              </SignalRow>
            )}
            {!!location.special_opening_count && (
              <SignalRow icon={Clock} tone="text-amber-400" label="Special hours">
                {location.special_opening_count} temporary-hours override{location.special_opening_count === 1 ? "" : "s"}
              </SignalRow>
            )}
            {location.access_keywords && location.access_keywords.length > 0 && (
              <SignalRow icon={MapPin} label="Access notes">
                {location.access_keywords.map((k) => k.replace(/_/g, " ")).join(", ")}
              </SignalRow>
            )}
            {location.courier_notes && (
              <div className="rounded bg-[var(--color-bg)] px-2 py-1 text-[11px] italic text-[var(--color-text-muted)]">
                &ldquo;{location.courier_notes}&rdquo;
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
