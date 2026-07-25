import { useMemo, useState, useRef, useEffect } from "react";
import { RefreshCw, X, Bike, Store, ChevronDown, Check } from "lucide-react";
import type { CityInfo, TtlaGlobalFilters, TtlaMode, TtlaOrderType } from "../types";

// Country code -> display name (kept local so this bar is self-contained; matches
// the map in Filters.tsx / TtlaFilterBar / the backend COUNTRY_NAMES set).
const COUNTRY_NAMES: Record<string, string> = {
  R1: "Region One", R2: "Region Two", R3: "Region Three", R4: "Region Four",
  R5: "Region Five", R6: "Region Six", R7: "Region Seven", R8: "Region Eight",
};

const DAY_OPTIONS = [7, 14, 28];
const WEEK_OPTIONS = [1, 2, 4];

// Selectable courier-delivery counts (1-5). ≥2 = a redispatched job. Any
// count >5 is only reachable via the "All" option (no filter), per the user spec.
const DELIVERY_COUNT_OPTIONS = [1, 2, 3, 4, 5];

const ORDER_TYPE_OPTIONS: { value: TtlaOrderType; label: string; icon: typeof Bike }[] = [
  { value: "regular", label: "Regular", icon: Store },
  { value: "drive", label: "Drive", icon: Bike },
];

// Accept latency calculation-logic modes: how each order's Accept latency is computed. The order SET
// is unchanged; only the per-order Accept latency value differs. Applied to EVERY panel.
const ACCEPT_LATENCY_MODE_OPTIONS: { value: TtlaMode; label: string; title: string }[] = [
  {
    value: "default",
    label: "Default",
    title:
      "Combined Accept latency: last pickup-accept minus the order's first task-shown (includes idle gaps on reassigns / splits). Current behavior.",
  },
  {
    value: "first_courier",
    label: "1st courier",
    title:
      "Accept latency of the 1st (original) task group only — the courier shown the task first. Isolates that courier's accept speed (no upstream idle gap).",
  },
  {
    value: "fixed",
    label: "Fixed",
    title:
      "Average of all couriers' per-task Accept latency on the order (each courier's own accept time, idle gaps excluded). The order-list Accept latency column shows this average.",
  },
];

const selectCls =
  "h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none";
const labelCls = "text-sm text-[var(--color-text-muted)]";

// Master "Deliveries" multi-select: pick specific courier-delivery counts (1-5)
// to keep, or "All" (no filter). Applied to every Accept latency panel. Empty selection is
// treated as "All" so the dashboard never goes blank.
function DeliveryCountFilter({
  value,
  onChange,
}: {
  value: number[] | null;
  onChange: (next: number[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selected = (value ?? []).slice().sort((a, b) => a - b);
  const allMode = selected.length === 0;
  const summary = allMode ? "All" : selected.join(", ");

  const toggle = (n: number) => {
    const set = new Set(selected);
    if (set.has(n)) set.delete(n);
    else set.add(n);
    const next = Array.from(set).sort((a, b) => a - b);
    onChange(next.length ? next : null); // empty => All (null)
  };

  const row = (active: boolean) =>
    `flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors ${
      active
        ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
        : "hover:bg-[var(--color-surface-hover)] text-[var(--color-text)]"
    }`;
  const box = (active: boolean) =>
    `flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
      active ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white" : "border-[var(--color-border)]"
    }`;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`${selectCls} flex min-w-[7.5rem] items-center justify-between gap-1`}
        title="Filter jobs by field-unit delivery count (≥2 = redispatched). Pick specific values or All. Applied to every panel."
      >
        <span className="truncate">{summary}</span>
        <ChevronDown size={13} className="shrink-0 opacity-60" />
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-50 w-44 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg">
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={row(allMode)}
          >
            <span className={box(allMode)}>{allMode ? <Check size={11} /> : null}</span>
            All
          </button>
          <div className="my-1 h-px bg-[var(--color-border)]" />
          {DELIVERY_COUNT_OPTIONS.map((n) => {
            const on = selected.includes(n);
            return (
              <button key={n} type="button" onClick={() => toggle(n)} className={row(on)}>
                <span className={box(on)}>{on ? <Check size={11} /> : null}</span>
                {n}
              </button>
            );
          })}
          <div className="mt-1 border-t border-[var(--color-border)] px-2 pt-1 text-[10px] text-[var(--color-text-muted)]">
            ≥2 = redispatched job
          </div>
        </div>
      )}
    </div>
  );
}

// The Accept latency tab's single GLOBAL filter bar — Country, City, Period and Order type
// applied to every panel (Retail overview, Orders, Venues, Couriers).
export function TtlaGlobalFilterBar({
  filters,
  onChange,
  cities,
  onRefresh,
  loading,
}: {
  filters: TtlaGlobalFilters;
  onChange: (patch: Partial<TtlaGlobalFilters>) => void;
  cities: CityInfo[];
  onRefresh: () => void;
  loading: boolean;
}) {
  const grouped = useMemo(
    () =>
      cities.reduce<Record<string, CityInfo[]>>((acc, c) => {
        (acc[c.country] ??= []).push(c);
        return acc;
      }, {}),
    [cities],
  );
  const countryOrder = Object.keys(grouped);
  const selectedCity = cities.find((c) => c.name === filters.city);
  const selectedCountry = selectedCity?.country ?? countryOrder[0] ?? "";
  const countryCities = grouped[selectedCountry] ?? [];

  const usingRange = !!(filters.dateFrom && filters.dateTo);
  const usingWeeks = !usingRange && !!filters.completeWeeks;
  const usingDays = !usingRange && !usingWeeks;

  const btn = (active: boolean) =>
    `h-8 px-2.5 text-xs font-medium transition-colors ${
      active
        ? "bg-[var(--color-primary)] text-white"
        : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
    }`;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/60 p-3">
      {/* Country */}
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

      {/* City */}
      <div className="flex items-center gap-2">
        <label className={labelCls}>City</label>
        <select value={filters.city} onChange={(e) => onChange({ city: e.target.value })} className={selectCls}>
          {countryCities.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
          {cities.length === 0 && <option value={filters.city}>{filters.city}</option>}
        </select>
      </div>

      {/* Period: rolling days | complete weeks | custom range */}
      <div className="flex items-center gap-2">
        <label className={labelCls}>Period</label>
        <div className="flex overflow-hidden rounded-md border border-[var(--color-border)]">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => onChange({ lookbackDays: d, completeWeeks: null, dateFrom: undefined, dateTo: undefined })}
              className={btn(usingDays && filters.lookbackDays === d)}
            >
              {d}d
            </button>
          ))}
          <span className="w-px self-stretch bg-[var(--color-border)]" />
          {WEEK_OPTIONS.map((w) => (
            <button
              key={w}
              onClick={() => onChange({ completeWeeks: w, dateFrom: undefined, dateTo: undefined })}
              className={btn(usingWeeks && filters.completeWeeks === w)}
              title={`Last ${w} complete ISO week${w > 1 ? "s" : ""} (Mon–Sun; current partial week excluded)`}
            >
              {w}w
            </button>
          ))}
        </div>
      </div>

      {/* Custom range (overrides quick period) */}
      <div className="flex items-center gap-1.5">
        <input
          type="date"
          value={filters.dateFrom || ""}
          max={filters.dateTo || undefined}
          onChange={(e) => onChange({ dateFrom: e.target.value || undefined })}
          className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
          title="Custom range start (overrides quick period)"
        />
        <span className="text-xs text-[var(--color-text-muted)]">→</span>
        <input
          type="date"
          value={filters.dateTo || ""}
          min={filters.dateFrom || undefined}
          onChange={(e) => onChange({ dateTo: e.target.value || undefined })}
          className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
          title="Custom range end (overrides quick period)"
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

      {/* Order type: Regular (on-demand) vs Drive (Express partner / Super Express) */}
      <div className="flex items-center gap-2">
        <label className={labelCls}>Order type</label>
        <div className="flex items-center overflow-hidden rounded-md border border-[var(--color-border)]">
          {ORDER_TYPE_OPTIONS.map((o) => {
            const Icon = o.icon;
            const active = (filters.orderType ?? "regular") === o.value;
            return (
              <button
                key={o.value}
                onClick={() => onChange({ orderType: o.value })}
                className={`flex h-8 items-center gap-1.5 px-3 text-xs font-medium transition-colors ${
                  active ? "bg-teal-600 text-white" : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
                title={o.value === "drive" ? "Relay Express routes (is_drive)" : "On-demand Restaurant + Retail"}
              >
                <Icon size={13} />
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Master filter: courier-delivery count multi-select (≥2 = cloned/
          duplicated order). Pick specific values (1-5) or All. Applied to EVERY
          panel (Orders / Venues / Couriers / Country-Context) so the whole tab
          recalculates on the same subset. */}
      <div className="flex items-center gap-2">
        <label className={labelCls} title="Keep only jobs whose field-unit delivery count is selected (≥2 = redispatched). Applied to every panel.">
          Deliveries
        </label>
        <DeliveryCountFilter
          value={filters.deliveryCounts ?? null}
          onChange={(next) => onChange({ deliveryCounts: next })}
        />
      </div>

      {/* Accept latency calculation logic: how each order's Accept latency is computed (default |
          1st courier | fixed). Applied to EVERY panel (Orders / Venues / Couriers
          / Country-Context). For deliveries_count=1 all three coincide. */}
      <div className="flex items-center gap-2">
        <label className={labelCls} title="How each order's Accept latency is computed. Applied to every panel.">
          Accept latency logic
        </label>
        <div className="flex items-center overflow-hidden rounded-md border border-[var(--color-border)]">
          {ACCEPT_LATENCY_MODE_OPTIONS.map((o) => {
            const active = (filters.ttlaMode ?? "default") === o.value;
            return (
              <button
                key={o.value}
                onClick={() => onChange({ ttlaMode: o.value })}
                title={o.title}
                className={btn(active)}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      <button
        onClick={onRefresh}
        disabled={loading}
        className="ml-auto flex h-8 items-center gap-1.5 rounded-md bg-[var(--color-primary)] px-3 text-sm font-medium text-white transition-colors hover:bg-[var(--color-primary-dark)] disabled:opacity-50"
      >
        <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        {loading ? "Loading…" : "Refresh all"}
      </button>
    </div>
  );
}
