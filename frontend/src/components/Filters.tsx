import { useEffect, useState } from "react";
import { useFilters } from "../hooks/useFilters";
import { fetchCities } from "../api/client";
import { RefreshCw } from "lucide-react";
import type { CityInfo, SizeFilter, PeriodMode } from "../types";

interface FiltersProps {
  onRefresh: () => void;
  loading: boolean;
}

const LOOKBACK_OPTIONS = [
  { value: 7, label: "7d" },
  { value: 14, label: "14d" },
  { value: 28, label: "28d" },
];

const SIZE_OPTIONS: { value: SizeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "heavy", label: "Tier A" },
  { value: "large", label: "Tier B" },
  { value: "heavy_or_large", label: "Tier A | B" },
  { value: "normal", label: "Normal" },
];

const COUNTRY_NAMES: Record<string, string> = {
  R1: "Region One",
  R2: "Region Two",
  R3: "Region Three",
  R4: "Region Four",
  R5: "Region Five",
  R6: "Region Six",
  R7: "Region Seven",
  R8: "Region Eight",
};

const PERIOD_MODES: { value: PeriodMode; label: string }[] = [
  { value: "lookback", label: "Last N days" },
  { value: "completed_days", label: "Completed days" },
  { value: "completed_weeks", label: "Completed weeks" },
  { value: "custom", label: "Custom range" },
];

function getCompletedDaysRange(days: number): { from: string; to: string } {
  const to = new Date();
  to.setDate(to.getDate() - 1);
  const from = new Date(to);
  from.setDate(from.getDate() - days + 1);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function getCompletedWeeksRange(weeks: number): { from: string; to: string } {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const lastSunday = new Date(now);
  lastSunday.setDate(now.getDate() - (dayOfWeek === 0 ? 7 : dayOfWeek));
  const from = new Date(lastSunday);
  from.setDate(lastSunday.getDate() - (weeks - 1) * 7 - 6);
  return { from: from.toISOString().slice(0, 10), to: lastSunday.toISOString().slice(0, 10) };
}

export function Filters({ onRefresh, loading }: FiltersProps) {
  const { filters, setFilters } = useFilters();
  const [cities, setCities] = useState<CityInfo[]>([]);

  useEffect(() => {
    fetchCities().then(setCities).catch(() => {});
  }, []);

  const grouped = cities.reduce<Record<string, CityInfo[]>>((acc, c) => {
    (acc[c.country] ??= []).push(c);
    return acc;
  }, {});

  const countryOrder = Object.keys(grouped);
  const selectedCity = cities.find((c) => c.name === filters.city);
  const selectedCountry = selectedCity?.country ?? countryOrder[0] ?? "";
  const countryCities = grouped[selectedCountry] ?? [];

  const handleCountryChange = (country: string) => {
    const first = grouped[country]?.[0];
    if (first) {
      setFilters((f) => ({ ...f, city: first.name }));
    }
  };

  const handlePeriodMode = (mode: PeriodMode) => {
    setFilters((f) => ({ ...f, periodMode: mode }));
  };

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex items-center gap-2">
        <label className="text-sm text-[var(--color-text-muted)]">Country</label>
        <select
          value={selectedCountry}
          onChange={(e) => handleCountryChange(e.target.value)}
          className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
        >
          {countryOrder.map((code) => (
            <option key={code} value={code}>
              {COUNTRY_NAMES[code] ?? code}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-sm text-[var(--color-text-muted)]">City</label>
        <select
          value={filters.city}
          onChange={(e) =>
            setFilters((f) => ({ ...f, city: e.target.value }))
          }
          className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
        >
          {countryCities.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
          {cities.length === 0 && (
            <option value={filters.city}>{filters.city}</option>
          )}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-sm text-[var(--color-text-muted)]">Period</label>
        <select
          value={filters.periodMode}
          onChange={(e) => handlePeriodMode(e.target.value as PeriodMode)}
          className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
        >
          {PERIOD_MODES.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {(filters.periodMode === "lookback" || filters.periodMode === "completed_days") && (
        <div className="flex rounded-md border border-[var(--color-border)] overflow-hidden">
          {LOOKBACK_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => {
                if (filters.periodMode === "completed_days") {
                  const range = getCompletedDaysRange(o.value);
                  setFilters((f) => ({ ...f, lookbackDays: o.value, customFrom: range.from, customTo: range.to }));
                } else {
                  setFilters((f) => ({ ...f, lookbackDays: o.value, customFrom: undefined, customTo: undefined }));
                }
              }}
              className={`h-8 px-2.5 text-xs font-medium transition-colors ${
                filters.lookbackDays === o.value
                  ? "bg-[var(--color-primary)] text-white"
                  : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}

      {filters.periodMode === "completed_weeks" && (
        <div className="flex rounded-md border border-[var(--color-border)] overflow-hidden">
          {[1, 2, 4, 8, 12].map((w) => {
            const days = w * 7;
            return (
              <button
                key={w}
                onClick={() => {
                  const range = getCompletedWeeksRange(w);
                  setFilters((f) => ({ ...f, lookbackDays: days, customFrom: range.from, customTo: range.to }));
                }}
                className={`h-8 px-2.5 text-xs font-medium transition-colors ${
                  filters.lookbackDays === days
                    ? "bg-[var(--color-primary)] text-white"
                    : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {w}w
              </button>
            );
          })}
        </div>
      )}

      {filters.periodMode === "custom" && (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={filters.customFrom || ""}
            onChange={(e) => setFilters((f) => ({ ...f, customFrom: e.target.value }))}
            className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
          />
          <span className="text-xs text-[var(--color-text-muted)]">→</span>
          <input
            type="date"
            value={filters.customTo || ""}
            onChange={(e) => setFilters((f) => ({ ...f, customTo: e.target.value }))}
            className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
          />
        </div>
      )}

      <div className="flex items-center gap-1 rounded-md border border-[var(--color-border)] overflow-hidden">
        {SIZE_OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() =>
              setFilters((f) => ({ ...f, sizeFilter: o.value }))
            }
            className={`h-8 px-3 text-xs font-medium transition-colors ${
              filters.sizeFilter === o.value
                ? "bg-[var(--color-primary)] text-white"
                : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

      <button
        onClick={onRefresh}
        disabled={loading}
        className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--color-primary)] px-3 text-sm font-medium text-white transition-colors hover:bg-[var(--color-primary-dark)] disabled:opacity-50"
      >
        <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        {loading ? "Loading…" : "Refresh"}
      </button>
    </div>
  );
}
