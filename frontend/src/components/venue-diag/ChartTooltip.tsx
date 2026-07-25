// Shared Recharts tooltip for the venue-diagnostic charts, styled to match the
// Accept latency tab's existing TtlaPanel tooltip. Pass `rows` describing each series,
// and (optionally) a `titleKey`/`titleFormat` to render a header line from the
// hovered datum (e.g. the hour label on the hourly chart).
export interface ChartTooltipRow {
  dataKey: string;
  label: string;
  format: (v: number) => string;
}

export function ChartTooltip({
  active,
  payload,
  label,
  rows,
  titleKey,
  titleFormat,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ dataKey: string; value: number | null; color?: string; payload?: Record<string, unknown> }>;
  label?: string | number;
  rows: ChartTooltipRow[];
  titleKey?: string;
  titleFormat?: (v: unknown) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const datum = payload[0]?.payload ?? {};
  const items = payload.filter((p) => p.value != null);
  const title =
    titleKey && titleFormat && datum[titleKey] != null
      ? titleFormat(datum[titleKey])
      : label != null
        ? String(label)
        : "";
  return (
    <div
      style={{
        backgroundColor: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        fontSize: 11,
        padding: "8px 10px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
      }}
    >
      {title && (
        <div style={{ marginBottom: 4, color: "var(--color-text-muted)", fontSize: 10 }}>{title}</div>
      )}
      {items.map((item) => {
        const row = rows.find((r) => r.dataKey === item.dataKey);
        if (!row) return null;
        return (
          <div key={item.dataKey} style={{ display: "flex", alignItems: "center", gap: 6, padding: "1px 0" }}>
            <span
              style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: item.color, flexShrink: 0 }}
            />
            <span style={{ color: "var(--color-text)" }}>
              {row.label}: {row.format(Number(item.value))}
            </span>
          </div>
        );
      })}
    </div>
  );
}
