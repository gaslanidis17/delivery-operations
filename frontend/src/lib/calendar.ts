export type CalendarViewMode = "day" | "hour";
export type CalendarPeriodType = "days" | "weeks" | "completed_days" | "completed_weeks" | "custom";

/** Tier A/large order segment used across the Redispatch Rate calendars and maps. */
export type SizeKind = "heavy" | "large" | "hl";

/** Map a SizeKind to the backend size_filter query value. */
export const SIZE_KIND_TO_FILTER: Record<SizeKind, string> = {
  heavy: "heavy",
  large: "large",
  hl: "heavy_or_large",
};

export const SIZE_KIND_LABEL: Record<SizeKind, string> = {
  hl: "Tier A | B",
  heavy: "Tier A",
  large: "Tier B",
};

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Resolve a period selection to a [from, to] window (YYYY-MM-DD). */
export function resolvePeriod(
  type: CalendarPeriodType,
  count: number,
  customFrom: string,
  customTo: string
): { from: string; to: string } {
  const today = new Date();
  if (type === "custom") {
    return { from: customFrom, to: customTo };
  }
  if (type === "days") {
    const to = today;
    return { from: iso(addDays(to, -(count - 1))), to: iso(to) };
  }
  if (type === "weeks") {
    const to = today;
    return { from: iso(addDays(to, -(count * 7 - 1))), to: iso(to) };
  }
  if (type === "completed_days") {
    const to = addDays(today, -1);
    return { from: iso(addDays(to, -(count - 1))), to: iso(to) };
  }
  // completed_weeks — end on the most recent Saturday
  const dow = today.getDay();
  const lastSaturday = addDays(today, -(dow + 1));
  const from = addDays(lastSaturday, -(count * 7 - 1));
  return { from: iso(from), to: iso(lastSaturday) };
}

/** Build continuous week rows (Sun..Sat) covering the given sorted date list. */
export function buildWeeks(dates: string[]): (string | null)[][] {
  if (dates.length === 0) return [];
  const first = new Date(dates[0] + "T00:00:00");
  const last = new Date(dates[dates.length - 1] + "T00:00:00");
  const gridStart = addDays(first, -first.getDay());
  const gridEnd = addDays(last, 6 - last.getDay());
  const inRange = new Set(dates);
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [];
  for (let d = new Date(gridStart); d <= gridEnd; d = addDays(d, 1)) {
    const key = iso(d);
    row.push(inRange.has(key) ? key : null);
    if (row.length === 7) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  return rows;
}

/** Expand a [from,to] window to an inclusive list of YYYY-MM-DD dates. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  if (!from || !to) return out;
  const start = new Date(from + "T00:00:00");
  const end = new Date(to + "T00:00:00");
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return out;
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) out.push(iso(d));
  return out;
}
