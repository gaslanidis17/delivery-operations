import type { FlagAnalysis } from "../types";

interface OverlapMatrixProps {
  flagAnalysis: FlagAnalysis | null;
  title?: string;
  subtitle?: string;
}

export function OverlapMatrix({ flagAnalysis, title, subtitle }: OverlapMatrixProps) {
  const heading = title ?? "Top Reason Combinations (UpSet-style)";
  const sub = subtitle ?? "Most common co-occurring lateness reason sets";

  if (!flagAnalysis) {
    return (
      <div className="flex h-72 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-sm text-[var(--color-text-muted)]">
        Loading overlap data…
      </div>
    );
  }

  const { top_combinations } = flagAnalysis;

  if (!top_combinations.length) {
    return (
      <div className="flex h-72 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-sm text-[var(--color-text-muted)]">
        No overlap data
      </div>
    );
  }

  const maxCount = Math.max(...top_combinations.map((c) => c.count));

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <h3 className="mb-1 text-sm font-semibold text-[var(--color-text)]">
        {heading}
      </h3>
      <p className="mb-4 text-xs text-[var(--color-text-muted)]">
        {sub}
      </p>
      <div className="space-y-2 overflow-y-auto" style={{ maxHeight: 280 }}>
        {top_combinations.map((combo, i) => {
          const pct = maxCount > 0 ? (combo.count / maxCount) * 100 : 0;
          return (
            <div key={i} className="flex items-center gap-3">
              <div className="w-40 shrink-0">
                <div className="flex flex-wrap gap-1">
                  {combo.labels.map((label) => (
                    <span
                      key={label}
                      className="inline-block rounded bg-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex-1">
                <div className="h-5 overflow-hidden rounded-sm bg-[var(--color-bg)]">
                  <div
                    className="h-full rounded-sm bg-[var(--color-primary)] transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
              <span className="w-12 text-right text-xs font-medium tabular-nums text-[var(--color-text)]">
                {combo.count}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
