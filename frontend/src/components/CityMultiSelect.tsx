import { useMemo, useState, useRef, useEffect } from "react";
import { Search, Check, X, MapPin, Loader2, ChevronDown } from "lucide-react";
import type { CountryCityListItem } from "../types";

interface CityMultiSelectProps {
  cities: CountryCityListItem[];
  selected: string[];
  onChange: (next: string[]) => void;
  loading?: boolean;
  /** Size of the "Top N" quick-select shortcut. */
  topN?: number;
}

// How many selection chips to show beside the trigger before collapsing to "+N".
const MAX_VISIBLE_CHIPS = 6;

// Dropdown ("marked" city picker) for the Country tab. A compact trigger opens a
// menu containing a searchable, volume-desc checklist; the menu STAYS OPEN while
// toggling so several cities can be marked in a row, and closes only on
// click-outside or Esc. Selection state is owned by the parent (persisted
// per-country there) and driven purely through `onChange`, so marking/unmarking
// updates the page reactively. This component is presentational only.
export function CityMultiSelect({
  cities,
  selected,
  onChange,
  loading = false,
  topN = 5,
}: CityMultiSelectProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // Close on click-outside / Esc while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Focus the search on open; reset the query on close.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => searchRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    setQuery("");
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return cities;
    return cities.filter((c) => c.city.toLowerCase().includes(q));
  }, [cities, query]);

  const toggle = (city: string) => {
    if (selectedSet.has(city)) onChange(selected.filter((c) => c !== city));
    else onChange([...selected, city]);
  };

  const selectTop = () => onChange(cities.slice(0, topN).map((c) => c.city));
  const selectShown = () => {
    const merged = new Set(selected);
    filtered.forEach((c) => merged.add(c.city));
    onChange(Array.from(merged));
  };
  const clearAll = () => onChange([]);

  const actionBtn =
    "rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-40";

  const visibleChips = selected.slice(0, MAX_VISIBLE_CHIPS);
  const hiddenChipCount = selected.length - visibleChips.length;

  return (
    <div ref={containerRef} className="relative">
      <div className="flex flex-wrap items-center gap-2">
        {/* Compact trigger */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="listbox"
          className="flex h-8 shrink-0 items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] transition-colors hover:border-[var(--color-primary)]"
        >
          <MapPin size={15} className="text-[var(--color-primary)]" />
          <span className="font-medium">Cities to inspect</span>
          <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)]">
            {selected.length} selected
          </span>
          <ChevronDown
            size={14}
            className={`text-[var(--color-text-muted)] transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>

        {/* Selection chips (removable) — visible without opening the dropdown */}
        {visibleChips.map((city) => (
          <span
            key={city}
            className="inline-flex items-center gap-1 rounded-full bg-[var(--color-primary)]/10 px-2 py-0.5 text-[11px] text-[var(--color-text)]"
          >
            {city}
            <button
              type="button"
              onClick={() => toggle(city)}
              className="text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
              aria-label={`Remove ${city}`}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        {hiddenChipCount > 0 && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
          >
            +{hiddenChipCount} more
          </button>
        )}
      </div>

      {/* Dropdown menu */}
      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-2 w-[min(42rem,calc(100vw-3rem))] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-lg shadow-black/20"
          role="listbox"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--color-text-muted)]">
              {selected.length} selected · {cities.length} available
            </span>
            <div className="flex items-center gap-1.5 text-[11px]">
              <button onClick={selectTop} disabled={cities.length === 0} className={actionBtn}>
                Top {topN}
              </button>
              <button onClick={selectShown} disabled={filtered.length === 0} className={actionBtn}>
                Select shown
              </button>
              <button onClick={clearAll} disabled={selected.length === 0} className={actionBtn}>
                Clear
              </button>
            </div>
          </div>

          <div className="relative mb-2">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={cities.length ? `Search ${cities.length} cities…` : "Search cities…"}
              className="h-8 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] pl-8 pr-3 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
            />
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-[var(--color-text-muted)]">
              <Loader2 size={14} className="animate-spin" /> Loading cities…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-6 text-center text-xs text-[var(--color-text-muted)]">
              {cities.length === 0 ? "No cities available." : `No cities match “${query}”.`}
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto pr-1">
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                {filtered.map((c) => {
                  const on = selectedSet.has(c.city);
                  return (
                    <button
                      key={c.city}
                      type="button"
                      role="option"
                      aria-selected={on}
                      onClick={() => toggle(c.city)}
                      title={c.curated ? c.city : `${c.city} (not in curated list)`}
                      className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
                        on
                          ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-text)]"
                          : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span
                          className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
                            on
                              ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
                              : "border-[var(--color-border)]"
                          }`}
                        >
                          {on && <Check size={10} />}
                        </span>
                        <span className="truncate">{c.city}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-[10px] text-[var(--color-text-muted)]">
                        {c.orders > 0 ? c.orders.toLocaleString() : "—"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
