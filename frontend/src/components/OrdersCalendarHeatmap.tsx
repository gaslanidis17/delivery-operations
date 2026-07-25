import { useEffect, useMemo, useState, useCallback } from "react";
import { Loader2, Package } from "lucide-react";
import { fetchOrdersCalendar } from "../api/client";
import type { OrdersCalendarResponse } from "../types";
import {
  WEEKDAYS,
  MONTHS,
  buildWeeks,
  dateRange,
  SIZE_KIND_LABEL,
  type CalendarViewMode,
  type SizeKind,
} from "../lib/calendar";

interface Props {
  city: string;
  view: CalendarViewMode;
  dateFrom: string;
  dateTo: string;
  size: SizeKind;
}

interface OrderCounts {
  heavy_orders: number;
  large_orders: number;
  hl_orders: number;
}

const SIZE_FIELD: Record<SizeKind, keyof OrderCounts> = {
  hl: "hl_orders",
  heavy: "heavy_orders",
  large: "large_orders",
};

function amber(intensity: number): string {
  if (intensity <= 0) return "var(--color-surface)";
  const alpha = 0.12 + intensity * 0.85;
  return `rgba(245, 158, 11, ${alpha.toFixed(3)})`;
}

export function OrdersCalendarHeatmap({ city, view, dateFrom, dateTo, size }: Props) {
  const [data, setData] = useState<OrdersCalendarResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sizeField = SIZE_FIELD[size];

  const load = useCallback(async () => {
    if (!dateFrom || !dateTo) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchOrdersCalendar(city, dateFrom, dateTo);
      setData(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load orders calendar");
    } finally {
      setLoading(false);
    }
  }, [city, dateFrom, dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  // Map<date, Map<hour, value>> for the selected size.
  const byDayHour = useMemo(() => {
    const m = new Map<string, Map<number, number>>();
    if (!data) return m;
    for (const r of data.rows) {
      if (!m.has(r.confirmed_date)) m.set(r.confirmed_date, new Map());
      m.get(r.confirmed_date)!.set(r.hour_of_day, (r[sizeField] as number) || 0);
    }
    return m;
  }, [data, sizeField]);

  const dates = useMemo(() => dateRange(dateFrom, dateTo), [dateFrom, dateTo]);

  // Day value = total orders that day (sum across hours).
  const dayValue = useMemo(() => {
    const m = new Map<string, number>();
    byDayHour.forEach((hm, date) => {
      let sum = 0;
      hm.forEach((v) => { sum += v; });
      m.set(date, sum);
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
        <Package size={16} className="text-amber-400" />
        <h3 className="text-sm font-semibold text-[var(--color-text)]">Orders Volume Calendar</h3>
        {loading && <Loader2 size={14} className="animate-spin text-amber-400" />}
      </div>
      <p className="mb-4 text-xs text-[var(--color-text-muted)]">
        Cell intensity = number of {SIZE_KIND_LABEL[size]} orders.
        {view === "day" ? " Day cells show the daily total." : " Each cell is one hour."}
      </p>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {!error && dates.length === 0 && (
        <p className="text-sm text-[var(--color-text-muted)]">Select a valid date range.</p>
      )}

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
                          title={`${key} — ${v} orders`}
                          className="flex h-12 flex-col items-center justify-center rounded border border-[var(--color-border)]/40 text-[11px] leading-tight"
                          style={{ backgroundColor: amber(maxDay > 0 ? v / maxDay : 0) }}
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
                            title={`${date} · ${String(h).padStart(2, "0")}:00 — ${v} orders`}
                            className="flex h-6 items-center justify-center rounded text-[8px] text-[var(--color-text)]"
                            style={{ backgroundColor: amber(maxHour > 0 ? v / maxHour : 0) }}
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
              <div key={t} className="flex-1" style={{ backgroundColor: amber(t) }} />
            ))}
          </div>
          <span>{view === "day" ? maxDay : maxHour} orders</span>
        </div>
      )}
    </div>
  );
}
