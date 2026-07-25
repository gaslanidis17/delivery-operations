import { Users } from "lucide-react";
import type { VenueDiagPeersPack } from "../../types";
import { SectionHeader } from "./SectionHeader";
import { InfoTooltip } from "./InfoTooltip";

// "How this venue compares to similar venues" — replaces the bare percentile
// list. Explains in plain language what a "peer" is (same city + same segment
// + same venue_type, each with enough orders) and what the percentile means
// ("slower than X% of those peers"), then shows a visual gauge + the peer
// distribution so the number has context.

function fmtSec(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Math.round(v).toLocaleString()} s`;
}
function fmtPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}
function fmtPctile(p: number | null | undefined): string {
  if (p == null || Number.isNaN(p)) return "—";
  return `${Math.round(p * 100)}%`;
}
// Higher percentile = worse than peers -> warmer color.
function pctTone(p: number | null | undefined): string {
  if (p == null) return "text-[var(--color-text)]";
  if (p >= 0.8) return "text-red-400";
  if (p >= 0.6) return "text-amber-400";
  return "text-emerald-400";
}
function pctFill(p: number | null | undefined): string {
  if (p == null) return "var(--color-text-muted)";
  if (p >= 0.8) return "#ef4444";
  if (p >= 0.6) return "#f59e0b";
  return "#10b981";
}

// A 0->100 track with the venue's percentile shown as a fill + end marker.
function PercentileGauge({ percentile }: { percentile: number | null }) {
  const pct = percentile != null ? Math.max(0, Math.min(1, percentile)) * 100 : null;
  return (
    <div>
      <div className="relative h-2.5 rounded-full bg-[var(--color-bg)]">
        {pct != null && (
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${pct}%`, backgroundColor: pctFill(percentile) }}
          />
        )}
        {pct != null && (
          <div
            className="absolute top-1/2 h-3.5 w-1 -translate-y-1/2 rounded-full bg-[var(--color-text)]"
            style={{ left: `calc(${pct}% - 2px)` }}
          />
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-[var(--color-text-muted)]">
        <span>Faster than peers</span>
        <span>Slower than peers</span>
      </div>
    </div>
  );
}

// Track showing where the venue sits vs the peer median and p75 (Accept latency seconds).
function DistributionBar({ venue, median, p75 }: { venue: number | null; median: number | null; p75: number | null }) {
  const vals = [venue, median, p75].filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  const max = Math.max(...vals) * 1.1;
  const pos = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  return (
    <div className="relative mt-2 h-2 rounded-full bg-[var(--color-bg)]">
      {median != null && (
        <div className="absolute top-1/2 h-2.5 w-0.5 -translate-y-1/2 bg-[var(--color-text-muted)]" style={{ left: pos(median) }} title={`peer median ${fmtSec(median)}`} />
      )}
      {p75 != null && (
        <div className="absolute top-1/2 h-2.5 w-0.5 -translate-y-1/2 bg-amber-400/70" style={{ left: pos(p75) }} title={`peer p75 ${fmtSec(p75)}`} />
      )}
      {venue != null && (
        <div className="absolute top-1/2 h-3 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-teal-400" style={{ left: pos(venue) }} title={`this venue ${fmtSec(venue)}`} />
      )}
    </div>
  );
}

function StatCard({
  label,
  venueValue,
  percentile,
  median,
  p75,
  medianLabel,
  format,
  showDistribution,
}: {
  label: string;
  venueValue: number | null;
  percentile: number | null;
  median: number | null;
  p75: number | null;
  medianLabel: string;
  format: (v: number | null) => string;
  showDistribution?: boolean;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{label}</span>
        <span className={`text-[11px] font-semibold ${pctTone(percentile)}`}>
          {fmtPctile(percentile)} <span className="font-normal text-[var(--color-text-muted)]">of peers</span>
        </span>
      </div>
      <div className="mt-0.5 text-lg font-bold tabular-nums text-[var(--color-text)]">{format(venueValue)}</div>
      <div className="text-[11px] text-[var(--color-text-muted)]">
        {medianLabel}: {format(median)}
        {p75 != null && <> · slow quarter {format(p75)}</>}
      </div>
      {showDistribution && <DistributionBar venue={venueValue} median={median} p75={p75} />}
    </div>
  );
}

export function PeerBenchmarkPanel({ peers, city }: { peers: VenueDiagPeersPack; city?: string | null }) {
  if (!peers.found) return null;
  const pct = peers.ttla_percentile;
  const cityText = city ? ` in ${city}` : "";
  const whereText = `${peers.venue_type ?? "similar"} ${peers.segment ?? ""} venues${cityText}`;
  const headline = pct != null
    ? `Slower than ${Math.round(pct * 100)}% of ${whereText}`
    : `Accept latency rank unavailable for ${whereText}`;

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 min-w-0">
      <SectionHeader
        icon={Users}
        title="How this venue compares to similar venues"
        subtitle={
          <>
            <span className={pctTone(pct)}>{headline}</span>
          </>
        }
        explainer={
          <>
            <strong>Peers</strong> = other venues in the same city, same segment (Restaurant or
            Retail) AND same venue type, each with enough orders to be comparable. The{" "}
            <strong>percentile</strong> is this venue&rsquo;s rank among those peers — &ldquo;slower
            than 82%&rdquo; means 82% of similar venues accept faster, only 18% are slower. Higher =
            worse. The <strong>peer median</strong> is the typical peer; the <strong>slow
            quarter</strong> (p75) is where the slowest 25% of peers sit.
          </>
        }
      />

      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--color-text-muted)]">
          <span>Accept latency percentile</span>
          <span className={`font-semibold ${pctTone(pct)}`}>{fmtPctile(pct)}</span>
        </div>
        <PercentileGauge percentile={pct ?? null} />
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <StatCard
          label="Avg Accept latency"
          venueValue={peers.venue_avg_ttla_sec ?? null}
          percentile={peers.ttla_percentile ?? null}
          median={peers.peer_ttla_median_sec ?? null}
          p75={peers.peer_ttla_p75_sec ?? null}
          medianLabel="peer median"
          format={fmtSec}
          showDistribution
        />
        <StatCard
          label="Reassignment rate"
          venueValue={peers.venue_unassign_rate ?? null}
          percentile={peers.unassign_percentile ?? null}
          median={peers.peer_unassign_median ?? null}
          p75={null}
          medianLabel="peer median"
          format={fmtPct}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
        <span>
          Compared to <span className="font-semibold text-[var(--color-text)]">{peers.peer_count ?? 0}</span> similar
          venues — same type &amp; segment{peers.matched_on && peers.matched_on !== "segment+type" ? ` (matched on ${peers.matched_on})` : ""}.
        </span>
        {peers.low_peer_count && (
          <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-400">
            Only {peers.peer_count ?? 0} peers — comparison is directional
            <InfoTooltip text="Too few comparable venues to trust the rank precisely — read it as a hint, not a verdict." />
          </span>
        )}
      </div>
    </div>
  );
}
