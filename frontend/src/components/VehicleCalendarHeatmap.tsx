import { useEffect, useMemo, useState, useCallback } from "react";
import { Loader2, Truck } from "lucide-react";
import { fetchCloneVehicleCalendar } from "../api/client";
import type { VehicleCalendarResponse } from "../types";
import {
  WEEKDAYS,
  MONTHS,
  buildWeeks,
  dateRange,
  type CalendarViewMode,
} from "../lib/calendar";

interface Props {
  city: string;
  view: CalendarViewMode;
  dateFrom: string;
  dateTo: string;
  vehicleType: string;
  /** Reports the vehicle types found in the window so a shared filter can list them. */
  onVehicleTypes?: (types: string[]) => void;
}

function violet(intensity: number): string {
  if (intensity <= 0) return "var(--color-surface)";
  const alpha = 0.12 + intensity * 0.85;
  return `rgba(139, 92, 246, ${alpha.toFixed(3)})`;
}

export function VehicleCalendarHeatmap({ city, view, dateFrom, dateTo, vehicleType, onVehicleTypes }: Props) {
  const [data, setData] = useState<VehicleCalendarResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!dateFrom || !dateTo) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchCloneVehicleCalendar(city, dateFrom, dateTo, vehicleType);
      setData(res);
      onVehicleTypes?.(res.vehicle_types ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load vehicle calendar");
    } finally {
      setLoading(false);
    }
  }, [city, dateFrom, dateTo, vehicleType, onVehicleTypes]);

  useEffect(() => {
    load();
  }, [load]);

  // Aggregate rows -> Map<date, Map<hour, value>> summing across vehicle types.
  const byDayHour = useMemo(() => {
    const m = new Map<string, Map<number, number>>();
    if (!data) return m;
    for (const r of data.rows) {
      if (!m.has(r.confirmed_date)) m.set(r.confirmed_date, new Map());
      const hm = m.get(r.confirmed_date)!;
      hm.set(r.hour_of_day, (hm.get(r.hour_of_day) || 0) + (r.available_vehicles || 0));
    }
    return m;
  }, [data]);

  const dates = useMemo(() => dateRange(dateFrom, dateTo), [dateFrom, dateTo]);

  // Day value = peak hourly availability that day.
  const dayValue = useMemo(() => {
    const m = new Map<string, number>();
    byDayHour.forEach((hm, date) => {
      let peak = 0;
      hm.forEach((v) => { if (v > peak) peak = v; });
      m.set(date, peak);
    });
    return m;
  }, [byDayHour]);

  const maxDay = useMemo(() => {
    let mx = 0;
    dayValue.forEach((v) => { if (v > mx) mx = v; });
    return mx;
  }, [dayValue]);

  const maxHour = useMemo(() => {
    let mx = 0;
    byDayHour.forEach((hm) => hm.forEach((v) => { if (v > mx) mx = v; }));
    return mx;
  }, [byDayHour]);

  const weeks = useMemo(() => buildWeeks(dates), [dates]);

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-1 flex items-center gap-2">
        <Truck size={16} className="text-violet-400" />
        <h3 className="text-sm font-semibold text-[var(--color-text)]">Vehicle Availability Calendar</h3>
        {loading && <Loader2 size={14} className="animate-spin text-violet-400" />}
      </div>
      <p className="mb-4 text-xs text-[var(--color-text-muted)]">
        Cell intensity = distinct active couriers ({vehicleType === "all" ? "all vehicles" : vehicleType}).
        {view === "day" ? " Day cells show the peak hour of the day." : " Each cell is one hour."}
      </p>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {!error && dates.length === 0 && (
        <p className="text-sm text-[var(--color-text-muted)]">Select a valid date range.</p>
      )}

      {/* Fixed-height content area so the panel size stays constant across views */}
      {!error && dates.length > 0 && (
        <div className="h-[420px] overflow-auto pr-1">
          {/* Day calendar view */}
          {view === "day" && (
            <div className="w-full">
              <div className="grid grid-cols-7 gap-1">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="pb-1 text-center text-[10px] font-medium text-[var(--color-text-muted)]">
                    {w}
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-1">
                {weeks.map((row, ri) => (
                  <div key={ri} className="grid grid-cols-7 gap-1">
                    {row.map((key, ci) => {
                      if (!key) return <div key={ci} className="h-12 rounded" />;
                      const v = dayValue.get(key) || 0;
                      const d = new Date(key + "T00:00:00");
                      const isFirst = d.getDate() === 1;
                      return (
                        <div
                          key={ci}
                          title={`${key} — peak ${v} vehicles`}
                          className="flex h-12 flex-col items-center justify-center rounded border border-[var(--color-border)]/40 text-[11px] leading-tight"
                          style={{ backgroundColor: violet(maxDay > 0 ? v / maxDay : 0) }}
                        >
                          <span className="text-[var(--color-text-muted)]">
                            {isFirst ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : d.getDate()}
                          </span>
                          {v > 0 && <span className="font-semibold text-[var(--color-text)]">{v}</span>}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Hour matrix view */}
          {view === "hour" && (
            <div className="w-full">
              <div
                className="mb-1 grid items-center gap-[2px]"
                style={{ gridTemplateColumns: "2.75rem repeat(24, minmax(15px, 1fr))" }}
              >
                <div className="text-[10px] font-medium text-[var(--color-text-muted)]">Date</div>
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="text-center text-[9px] font-medium text-[var(--color-text-muted)]">
                    {h}
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-[2px]">
                {dates.map((date) => {
                  const hm = byDayHour.get(date);
                  return (
                    <div
                      key={date}
                      className="grid items-center gap-[2px]"
                      style={{ gridTemplateColumns: "2.75rem repeat(24, minmax(15px, 1fr))" }}
                    >
                      <div className="whitespace-nowrap text-[10px] text-[var(--color-text-muted)]">
                        {date.slice(5)}
                      </div>
                      {Array.from({ length: 24 }, (_, h) => {
                        const v = hm?.get(h) || 0;
                        return (
                          <div
                            key={h}
                            title={`${date} · ${String(h).padStart(2, "0")}:00 — ${v} vehicles`}
                            className="flex h-6 items-center justify-center rounded text-[8px] text-[var(--color-text)]"
                            style={{ backgroundColor: violet(maxHour > 0 ? v / maxHour : 0) }}
                          >
                            {v > 0 ? v : ""}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Legend */}
      {!error && dates.length > 0 && (
        <div className="mt-4 flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
          <span>0</span>
          <div className="flex h-3 w-32 overflow-hidden rounded">
            {[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => (
              <div key={t} className="flex-1" style={{ backgroundColor: violet(t) }} />
            ))}
          </div>
          <span>{view === "day" ? maxDay : maxHour} vehicles</span>
        </div>
      )}
    </div>
  );
}
