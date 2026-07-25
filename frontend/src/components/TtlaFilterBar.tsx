import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Store, ChevronDown, Check, X, Search, Loader2 } from "lucide-react";
import { fetchTtlaVenues } from "../api/client";
import type { CityInfo, SizeFilter, TtlaQuery, TtlaVenueType, TtlaVenueRow } from "../types";

// Country code -> display name (kept local so this bar is self-contained; matches
// the map in Filters.tsx / the backend COUNTRY_NAMES set).
const COUNTRY_NAMES: Record<string, string> = {
  R1: "Region One", R2: "Region Two", R3: "Region Three", R4: "Region Four",
  R5: "Region Five", R6: "Region Six", R7: "Region Seven", R8: "Region Eight",
};

const LOOKBACK_OPTIONS = [7, 14, 28];

const SIZE_OPTIONS: { value: SizeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "heavy", label: "Tier A" },
  { value: "large", label: "Tier B" },
  { value: "heavy_or_large", label: "Tier A | Tier B" },
  { value: "normal", label: "Normal" },
];

const VENUE_TYPE_OPTIONS: { value: TtlaVenueType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "restaurant", label: "Restaurant" },
  { value: "retail", label: "Retail" },
];

// Fixed vehicle-type choices for the Couriers panel. Matched case-insensitively
// server-side (the raw completed_with_vehicle_type values are undocumented); edit
// this list if the warehouse uses different labels.
const VEHICLE_OPTIONS = ["all", "bicycle", "scooter", "car", "motorcycle", "walker"];

const selectCls =
  "h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none";
const labelCls = "text-sm text-[var(--color-text-muted)]";

interface TtlaFilterBarProps {
  query: TtlaQuery;
  onChange: (patch: Partial<TtlaQuery>) => void;
  cities: CityInfo[];
  /** View-specific controls to show. */
  showMinTtla?: boolean;
  showVehicleType?: boolean;
  // Venues-only min-impact filter (seconds; client-side, not part of the query).
  showMinImpact?: boolean;
  minImpact?: number | null;
  onMinImpact?: (v: number | null) => void;
  // Structural controls (default on). The Retail overview panel turns these off
  // since its endpoints only accept city + lookback (no size / venue-type / custom
  // date range).
  showSize?: boolean;
  showVenueType?: boolean;
  showDateRange?: boolean;
  // Location (country + city) and Period (quick lookback buttons) are now the
  // Accept latency tab's GLOBAL filters, so per-panel bars turn these off and only render
  // their panel-specific controls.
  showLocation?: boolean;
  showPeriod?: boolean;
  onRefresh: () => void;
  loading: boolean;
}

export function TtlaFilterBar({
  query,
  onChange,
  cities,
  showMinTtla = false,
  showVehicleType = false,
  showMinImpact = false,
  minImpact = null,
  onMinImpact,
  showSize = true,
  showVenueType = true,
  showDateRange = true,
  showLocation = true,
  showPeriod = true,
  onRefresh,
  loading,
}: TtlaFilterBarProps) {
  const grouped = useMemo(
    () =>
      cities.reduce<Record<string, CityInfo[]>>((acc, c) => {
        (acc[c.country] ??= []).push(c);
        return acc;
      }, {}),
    [cities],
  );
  const countryOrder = Object.keys(grouped);
  const selectedCity = cities.find((c) => c.name === query.city);
  const selectedCountry = selectedCity?.country ?? countryOrder[0] ?? "";
  const countryCities = grouped[selectedCountry] ?? [];

  const usingRange = !!(query.dateFrom && query.dateTo);

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Country */}
      {showLocation && (
      <div className="flex items-center gap-2">
        <label className={labelCls}>Country</label>
        <select
          value={selectedCountry}
          onChange={(e) => {
            const first = grouped[e.target.value]?.[0];
            if (first) onChange({ city: first.name });
          }}
          className={selectCls}
        >
          {countryOrder.map((code) => (
            <option key={code} value={code}>
              {COUNTRY_NAMES[code] ?? code}
            </option>
          ))}
        </select>
      </div>
      )}

      {/* City */}
      {showLocation && (
      <div className="flex items-center gap-2">
        <label className={labelCls}>City</label>
        <select
          value={query.city}
          onChange={(e) => onChange({ city: e.target.value })}
          className={selectCls}
        >
          {countryCities.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
          {cities.length === 0 && <option value={query.city}>{query.city}</option>}
        </select>
      </div>
      )}

      {/* Date range: quick lookback OR a custom from/to (custom wins when set) */}
      {showPeriod && (
      <div className="flex overflow-hidden rounded-md border border-[var(--color-border)]">
        {LOOKBACK_OPTIONS.map((d) => (
          <button
            key={d}
            onClick={() => onChange({ lookbackDays: d, dateFrom: undefined, dateTo: undefined })}
            className={`h-8 px-2.5 text-xs font-medium transition-colors ${
              !usingRange && query.lookbackDays === d
                ? "bg-[var(--color-primary)] text-white"
                : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {d}d
          </button>
        ))}
      </div>
      )}
      {showDateRange && (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={query.dateFrom || ""}
            max={query.dateTo || undefined}
            onChange={(e) => onChange({ dateFrom: e.target.value || undefined })}
            className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
            title="Custom range start (overrides quick range)"
          />
          <span className="text-xs text-[var(--color-text-muted)]">→</span>
          <input
            type="date"
            value={query.dateTo || ""}
            min={query.dateFrom || undefined}
            onChange={(e) => onChange({ dateTo: e.target.value || undefined })}
            className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
            title="Custom range end (overrides quick range)"
          />
          {usingRange && (
            <button
              onClick={() => onChange({ dateFrom: undefined, dateTo: undefined })}
              className="text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
              title="Clear custom range"
            >
              <X size={13} />
            </button>
          )}
        </div>
      )}

      {/* Size */}
      {showSize && (
        <div className="flex items-center overflow-hidden rounded-md border border-[var(--color-border)]">
          {SIZE_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => onChange({ sizeFilter: o.value })}
              className={`h-8 px-2.5 text-xs font-medium transition-colors ${
                (query.sizeFilter ?? "all") === o.value
                  ? "bg-[var(--color-primary)] text-white"
                  : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}

      {/* Venue type */}
      {showVenueType && (
        <div className="flex items-center gap-2">
          <label className={labelCls}>Venue</label>
          <div className="flex items-center overflow-hidden rounded-md border border-[var(--color-border)]">
            {VENUE_TYPE_OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() =>
                  onChange({
                    venueType: o.value,
                    ...(o.value === "retail" ? {} : { retailVenueIds: undefined }),
                  })
                }
                className={`h-8 px-2.5 text-xs font-medium transition-colors ${
                  (query.venueType ?? "all") === o.value
                    ? "bg-[var(--color-primary)] text-white"
                    : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Retail venue picker (only when Retail is selected) */}
      {showVenueType && query.venueType === "retail" && (
        <RetailVenuePicker query={query} onChange={onChange} />
      )}

      {/* Min Accept latency (orders / venues) */}
      {showMinTtla && (
        <div className="flex items-center gap-2">
          <label className={labelCls}>Min Accept latency</label>
          <input
            type="number"
            min={0}
            step={10}
            value={query.minTtla ?? ""}
            placeholder="—"
            onChange={(e) => {
              const v = e.target.value;
              onChange({ minTtla: v === "" ? null : Math.max(0, Number(v)) });
            }}
            className="h-8 w-20 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
          />
          <span className="text-xs text-[var(--color-text-muted)]">s+</span>
        </div>
      )}

      {/* Min impact on city avg Accept latency (venues) */}
      {showMinImpact && (
        <div className="flex items-center gap-2">
          <label className={labelCls}>Min impact</label>
          <input
            type="number"
            step={1}
            value={minImpact ?? ""}
            placeholder="—"
            onChange={(e) => {
              const v = e.target.value;
              onMinImpact?.(v === "" ? null : Number(v));
            }}
            className="h-8 w-20 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
            title="Hide venues whose leave-one-out impact on the city avg Accept latency is below this (seconds)"
          />
          <span className="text-xs text-[var(--color-text-muted)]">s+</span>
        </div>
      )}

      {/* Vehicle type (couriers) */}
      {showVehicleType && (
        <div className="flex items-center gap-2">
          <label className={labelCls}>Vehicle</label>
          <select
            value={query.vehicleType ?? "all"}
            onChange={(e) => onChange({ vehicleType: e.target.value })}
            className={selectCls}
          >
            {VEHICLE_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v === "all" ? "All" : v.charAt(0).toUpperCase() + v.slice(1)}
              </option>
            ))}
          </select>
        </div>
      )}

      <button
        onClick={onRefresh}
        disabled={loading}
        className="ml-auto flex h-8 items-center gap-1.5 rounded-md bg-[var(--color-primary)] px-3 text-sm font-medium text-white transition-colors hover:bg-[var(--color-primary-dark)] disabled:opacity-50"
      >
        <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        {loading ? "Loading…" : "Refresh"}
      </button>
    </div>
  );
}

// Dropdown checklist of the city's retail venues (populated from the Venues view
// filtered to retail, cache-only). Selection restricts the panel to those venue
// ids; empty = all retail venues.
function RetailVenuePicker({
  query,
  onChange,
}: {
  query: TtlaQuery;
  onChange: (patch: Partial<TtlaQuery>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [venues, setVenues] = useState<TtlaVenueRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [qtext, setQtext] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const selected = query.retailVenueIds ?? [];
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // Load the retail venue options for this city/window (cache-only; may be empty
  // until the retail Venues slice has been warmed).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTtlaVenues({
      city: query.city,
      lookbackDays: query.lookbackDays,
      completeWeeks: query.completeWeeks,
      orderType: query.orderType,
      sizeFilter: query.sizeFilter,
      venueType: "retail",
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    })
      .then((d) => {
        if (!cancelled) setVenues(d.venues.filter((v) => v.venue_id));
      })
      .catch(() => {
        if (!cancelled) setVenues([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query.city, query.lookbackDays, query.completeWeeks, query.orderType, query.sizeFilter, query.dateFrom, query.dateTo]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = qtext.trim().toLowerCase();
    if (!q) return venues;
    return venues.filter((v) => (v.venue_name ?? "").toLowerCase().includes(q));
  }, [venues, qtext]);

  const toggle = (id: string) => {
    if (selectedSet.has(id)) onChange({ retailVenueIds: selected.filter((x) => x !== id) });
    else onChange({ retailVenueIds: [...selected, id] });
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] transition-colors hover:border-[var(--color-primary)]"
      >
        <Store size={14} className="text-[var(--color-primary)]" />
        <span>Retail venues</span>
        <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)]">
          {selected.length ? `${selected.length} selected` : "all"}
        </span>
        <ChevronDown size={13} className={`text-[var(--color-text-muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-[min(30rem,calc(100vw-3rem))] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-lg shadow-black/20">
          <div className="mb-2 flex items-center justify-between text-[11px] text-[var(--color-text-muted)]">
            <span>{selected.length} selected · {venues.length} retail venues</span>
            <button
              onClick={() => onChange({ retailVenueIds: [] })}
              disabled={selected.length === 0}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-medium transition-colors hover:text-[var(--color-text)] disabled:opacity-40"
            >
              Clear
            </button>
          </div>
          <div className="relative mb-2">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              value={qtext}
              onChange={(e) => setQtext(e.target.value)}
              placeholder="Search venues…"
              className="h-8 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] pl-8 pr-3 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
            />
          </div>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-[var(--color-text-muted)]">
              <Loader2 size={14} className="animate-spin" /> Loading venues…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-6 text-center text-xs text-[var(--color-text-muted)]">
              {venues.length === 0 ? "No retail venues cached yet — refresh to warm." : `No venues match “${qtext}”.`}
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto pr-1">
              {filtered.map((v) => {
                const id = String(v.venue_id);
                const on = selectedSet.has(id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => toggle(id)}
                    className={`flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
                      on
                        ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-text)]"
                        : "border-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
                          on ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white" : "border-[var(--color-border)]"
                        }`}
                      >
                        {on && <Check size={10} />}
                      </span>
                      <span className="truncate">{v.venue_name}</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-[10px] text-[var(--color-text-muted)]">
                      {v.order_count > 0 ? v.order_count.toLocaleString() : "—"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
