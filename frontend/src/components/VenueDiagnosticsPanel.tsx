import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Stethoscope,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ListChecks,
  UserX,
  MessagesSquare,
  ThumbsUp,
  ThumbsDown,
} from "lucide-react";
import {
  startVenueDiagnosticsJob,
  pollVenueDiagnosticsJob,
  submitVenueDiagnosticsFeedback,
} from "../api/client";
import type {
  TtlaGlobalFilters,
  VenueDiagJob,
  VenueDiagResult,
  VenueDiagStatus,
} from "../types";
import { ConversationThemesPanel } from "./venue-diag/ConversationThemesPanel";
import { VenueTrendChart } from "./venue-diag/VenueTrendChart";
import { VenueHourlyChart } from "./venue-diag/VenueHourlyChart";
import { PeerBenchmarkPanel } from "./venue-diag/PeerBenchmarkPanel";
import { FindingsPanel } from "./venue-diag/FindingsPanel";
import { RecommendedActionsPanel } from "./venue-diag/RecommendedActionsPanel";
import { VenueLocationPanel } from "./venue-diag/VenueLocationPanel";

const MAX_VENUES = 10;
const POLL_MS = 2500;

// ---- formatting helpers -----------------------------------------------------
function fmtSec(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Math.round(v).toLocaleString()} s`;
}
function fmtPct(rate: number | null | undefined): string {
  if (rate == null || Number.isNaN(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}
function deltaSec(v: number | null | undefined, base: number | null | undefined): string {
  if (v == null || base == null) return "—";
  const d = Math.round(v - base);
  return `${d > 0 ? "+" : ""}${d.toLocaleString()} s`;
}
const STATUS_META: Record<VenueDiagStatus, { label: string; cls: string }> = {
  waiting: { label: "Waiting", cls: "text-[var(--color-text-muted)] bg-[var(--color-surface)]" },
  collecting_data: { label: "Collecting data", cls: "text-sky-400 bg-sky-500/10" },
  analyzing_performance: { label: "Analyzing", cls: "text-sky-400 bg-sky-500/10" },
  generating_summary: { label: "Generating summary", cls: "text-violet-400 bg-violet-500/10" },
  completed: { label: "Completed", cls: "text-emerald-400 bg-emerald-500/10" },
  insufficient_data: { label: "Insufficient data", cls: "text-amber-400 bg-amber-500/10" },
  failed: { label: "Failed", cls: "text-red-400 bg-red-500/10" },
};

function StatusPill({ status }: { status: VenueDiagStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.waiting;
  const busy = status === "collecting_data" || status === "analyzing_performance" || status === "generating_summary" || status === "waiting";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>
      {busy ? <Loader2 size={11} className="animate-spin" /> : status === "completed" ? <CheckCircle2 size={11} /> : status === "failed" ? <AlertTriangle size={11} /> : null}
      {meta.label}
    </span>
  );
}

function Chip({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${className}`}>{children}</span>
  );
}

// ---- numbers-first pack views ----------------------------------------------
function StatBox({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${tone ?? "text-[var(--color-text)]"}`}>{value}</div>
      {sub && <div className="text-[11px] text-[var(--color-text-muted)]">{sub}</div>}
    </div>
  );
}

function PacksView({ r }: { r: VenueDiagResult }) {
  const packs = r.packs;
  if (!packs) return null;
  const m = packs.metrics;
  const bench = m.benchmark;
  const ttlaTone =
    m.avg_ttla_sec != null && bench?.segment_city_avg_ttla_sec != null
      ? m.avg_ttla_sec > bench.segment_city_avg_ttla_sec
        ? "text-red-400"
        : "text-emerald-400"
      : undefined;
  const unTone =
    m.unassign_rate != null && bench?.segment_city_unassign_rate != null
      ? m.unassign_rate > bench.segment_city_unassign_rate
        ? "text-red-400"
        : "text-emerald-400"
      : undefined;

  return (
    <div className="space-y-4">
      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatBox
          label="Avg Accept latency"
          value={fmtSec(m.avg_ttla_sec)}
          sub={bench?.segment_city_avg_ttla_sec != null ? `${deltaSec(m.avg_ttla_sec, bench.segment_city_avg_ttla_sec)} vs city ${m.segment ?? ""}` : undefined}
          tone={ttlaTone}
        />
        <StatBox
          label="Reassignment rate"
          value={fmtPct(m.unassign_rate)}
          sub={bench?.segment_city_unassign_rate != null ? `city ${fmtPct(bench.segment_city_unassign_rate)}` : undefined}
          tone={unTone}
        />
        <StatBox label="Orders" value={(m.order_count ?? 0).toLocaleString()} sub={m.product_line_category ?? undefined} />
        <StatBox
          label="Prep error"
          value={m.avg_prep_error_min != null ? `${m.avg_prep_error_min > 0 ? "+" : ""}${m.avg_prep_error_min} min` : "—"}
          sub="ready vs promise"
          tone={m.avg_prep_error_min != null && m.avg_prep_error_min > 0 ? "text-amber-400" : undefined}
        />
      </div>

      {/* Worst hours + daily trend (charts) */}
      <div className="space-y-3">
        <VenueHourlyChart hourly={packs.hourly} location={packs.location} />
        <VenueTrendChart daily={packs.daily} />
      </div>

      <ConversationThemesPanel convos={packs.conversations} />

      {/* Peer benchmark + reassignment events */}
      {packs.peers?.found && <PeerBenchmarkPanel peers={packs.peers} city={r.city} />}

      {packs.unassign.events_available && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 min-w-0">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text)]">
            <UserX size={13} className="text-teal-500" /> Reassignment events
            <span className="font-normal text-[var(--color-text-muted)]">
              ({(packs.unassign.unassign_events ?? 0).toLocaleString()} · {packs.unassign.events_per_100_orders ?? 0}/100 orders)
            </span>
          </div>
          <ul className="grid gap-2 text-xs sm:grid-cols-2">
            <li className="flex justify-between rounded bg-[var(--color-bg)] px-2 py-1">
              <span className="text-[var(--color-text-muted)]">Courier / Ops split</span>
              <span className="tabular-nums text-[var(--color-text)]">
                {(packs.unassign.events_courier ?? 0).toLocaleString()} / {(packs.unassign.events_ops ?? 0).toLocaleString()}
              </span>
            </li>
            <li className="flex justify-between rounded bg-[var(--color-bg)] px-2 py-1">
              <span className="text-[var(--color-text-muted)]">Drops / reassigned job</span>
              <span className="tabular-nums text-[var(--color-text)]">{packs.unassign.events_per_unassigned_order ?? "—"}</span>
            </li>
            <li className="flex justify-between rounded bg-[var(--color-bg)] px-2 py-1">
              <span className="text-[var(--color-text-muted)]">Distinct couriers</span>
              <span className="tabular-nums text-[var(--color-text)]">{(packs.unassign.distinct_couriers ?? 0).toLocaleString()}</span>
            </li>
            <li className="flex justify-between rounded bg-[var(--color-bg)] px-2 py-1">
              <span className="text-[var(--color-text-muted)]">Median hold before drop</span>
              <span className="tabular-nums text-[var(--color-text)]">{fmtSec(packs.unassign.median_hold_before_unassign_sec)}</span>
            </li>
          </ul>
        </div>
      )}

      <VenueLocationPanel location={packs.location} city={r.city} />

      {/* Raw conversation-text themes (deep mode, PII-scrubbed) */}
      {packs.conversation_text?.available && (packs.conversation_text.themes?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text)]">
            <MessagesSquare size={13} className="text-violet-400" /> Courier chat themes
            <span className="font-normal text-[var(--color-text-muted)]">
              (scrubbed · {packs.conversation_text.message_count} msgs · {packs.conversation_text.dominant_language ?? ""})
            </span>
          </div>
          <ul className="space-y-1.5 text-xs">
            {packs.conversation_text.themes.map((t, i) => (
              <li key={i} className="rounded bg-[var(--color-bg)] px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-[var(--color-text)]">
                    {t.theme}
                    {!t.venue_related && <Chip className="ml-1 bg-[var(--color-surface)] text-[var(--color-text-muted)]">generic</Chip>}
                  </span>
                  <span className="tabular-nums text-[var(--color-text-muted)]">
                    {t.mention_count}× · {t.severity}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] italic text-[var(--color-text-muted)]">{t.paraphrase}</p>
              </li>
            ))}
          </ul>
          {packs.conversation_text.scrubbed_note && (
            <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">{packs.conversation_text.scrubbed_note}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---- LLM narrative ----------------------------------------------------------
function AnalysisView({ r }: { r: VenueDiagResult }) {
  const a = r.analysis;
  if (!a) return null;
  const rc = a.root_cause;
  const rcGroups = ([
    ["Venue ops", rc.venue_ops],
    ["Courier access", rc.courier_access],
    ["Location / infra", rc.location_infra],
    ["Peak / capacity", rc.peak_capacity],
    ["Bad venue info", rc.bad_venue_info],
    ["External", rc.external],
    ["Data quality", rc.data_quality],
  ] as [string, string[]][]).filter(([, v]) => v && v.length > 0);

  return (
    <div className="space-y-4 border-t border-[var(--color-border)] pt-4">
      <div className="rounded-lg border border-teal-500/30 bg-teal-500/5 p-3 text-sm text-[var(--color-text)]">
        {a.executive_summary}
      </div>

      <FindingsPanel findings={a.findings} />

      {/* Root cause */}
      {rcGroups.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Root cause</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {rcGroups.map(([label, items]) => (
              <div key={label} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
                <div className="text-[11px] font-semibold text-[var(--color-text)]">{label}</div>
                <ul className="mt-1 list-disc pl-4 text-[11px] text-[var(--color-text-muted)]">
                  {items.map((it, i) => (
                    <li key={i}>{it}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      <RecommendedActionsPanel actions={a.recommended_actions} />

      {/* Limitations */}
      {(a.limitations.missing_data.length > 0 ||
        a.limitations.weak_evidence.length > 0 ||
        a.limitations.assumptions.length > 0 ||
        a.limitations.data_needed.length > 0) && (
        <details className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-[11px] text-[var(--color-text-muted)]">
          <summary className="cursor-pointer font-semibold text-[var(--color-text)]">Limitations & assumptions</summary>
          <div className="mt-1 space-y-1">
            {a.limitations.missing_data.length > 0 && <div>Missing: {a.limitations.missing_data.join("; ")}</div>}
            {a.limitations.weak_evidence.length > 0 && <div>Weak evidence: {a.limitations.weak_evidence.join("; ")}</div>}
            {a.limitations.assumptions.length > 0 && <div>Assumptions: {a.limitations.assumptions.join("; ")}</div>}
            {a.limitations.data_needed.length > 0 && <div>Data needed: {a.limitations.data_needed.join("; ")}</div>}
          </div>
        </details>
      )}
    </div>
  );
}

function FeedbackControl({ r, ctx }: { r: VenueDiagResult; ctx: { lookback_days: number; order_type: string } }) {
  const [sent, setSent] = useState<"up" | "down" | null>(null);
  const [busy, setBusy] = useState(false);
  const send = (rating: "up" | "down") => {
    if (busy || sent) return;
    setBusy(true);
    submitVenueDiagnosticsFeedback({
      venue_id: r.venue_id,
      rating,
      city: r.city,
      lookback_days: ctx.lookback_days,
      order_type: ctx.order_type,
    })
      .then(() => setSent(rating))
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex items-center gap-2 border-t border-[var(--color-border)] pt-2 text-[11px] text-[var(--color-text-muted)]">
      <span>Was this useful?</span>
      <button
        onClick={() => send("up")}
        disabled={!!sent || busy}
        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-emerald-500/10 disabled:opacity-50 ${sent === "up" ? "text-emerald-400" : ""}`}
        aria-label="Helpful"
      >
        <ThumbsUp size={12} />
      </button>
      <button
        onClick={() => send("down")}
        disabled={!!sent || busy}
        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-red-500/10 disabled:opacity-50 ${sent === "down" ? "text-red-400" : ""}`}
        aria-label="Not helpful"
      >
        <ThumbsDown size={12} />
      </button>
      {sent && <span className="text-emerald-400">Thanks for the feedback.</span>}
    </div>
  );
}

function VenueCard({ r, ctx }: { r: VenueDiagResult; ctx: { lookback_days: number; order_type: string } }) {
  const [open, setOpen] = useState(false);
  const done = r.status === "completed" || r.status === "insufficient_data" || r.status === "failed";
  // Auto-expand a card the first time it finishes.
  const prev = useRef(r.status);
  useEffect(() => {
    if (prev.current !== r.status && r.status === "completed") setOpen(true);
    prev.current = r.status;
  }, [r.status]);

  const avg = r.packs?.metrics?.avg_ttla_sec;
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/40">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        {open ? <ChevronDown size={15} className="text-[var(--color-text-muted)]" /> : <ChevronRight size={15} className="text-[var(--color-text-muted)]" />}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--color-text)]" title={r.venue_name ?? r.venue_id}>
          {r.venue_name ?? r.venue_id}
        </span>
        {avg != null && <span className="shrink-0 text-xs tabular-nums text-[var(--color-text-muted)]">{fmtSec(avg)} Accept latency</span>}
        <StatusPill status={r.status} />
      </button>

      {open && (
        <div className="space-y-4 px-3 pb-3">
          {r.status === "insufficient_data" && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-300">
              Insufficient evidence for a reliable diagnosis.
              {r.insufficient_reasons?.length ? " " + r.insufficient_reasons.join(" ") : ""}
            </div>
          )}
          {r.status === "failed" && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-2.5 text-xs text-red-300">
              Diagnosis failed{ r.error ? `: ${r.error}` : "" }. The numbers below are still valid.
            </div>
          )}
          {r.summary && !r.analysis && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-xs text-[var(--color-text-muted)]">
              {r.summary}
            </div>
          )}
          {/* Numbers first, always */}
          <PacksView r={r} />
          {/* LLM narrative when present */}
          <AnalysisView r={r} />
          {done && r.status !== "failed" && <FeedbackControl r={r} ctx={ctx} />}
        </div>
      )}
    </div>
  );
}

// Convert the tab's global filters to the retail-style filter payload.
function toFilters(global: TtlaGlobalFilters) {
  return {
    orderType: global.orderType,
    completeWeeks: global.completeWeeks ?? null,
    dateFrom: global.dateFrom,
    dateTo: global.dateTo,
  };
}

export function VenueDiagnosticsPanel({
  global,
  inspectVenueIds,
}: {
  global: TtlaGlobalFilters;
  inspectVenueIds: string[];
}) {
  const [job, setJob] = useState<VenueDiagJob | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deep, setDeep] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedCount = inspectVenueIds.length;
  const capped = Math.min(selectedCount, MAX_VENUES);

  // Filter/selection scope key — a change invalidates a previous job's result.
  const scopeKey = useMemo(
    () =>
      [
        global.city,
        global.orderType,
        global.dateFrom && global.dateTo ? `${global.dateFrom}_${global.dateTo}` : global.completeWeeks ? `${global.completeWeeks}w` : `${global.lookbackDays}d`,
        inspectVenueIds.join("+"),
      ].join(":"),
    [global.city, global.orderType, global.dateFrom, global.dateTo, global.completeWeeks, global.lookbackDays, inspectVenueIds],
  );

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Reset when the scope changes (stale job no longer matches the selection).
  useEffect(() => {
    stopPolling();
    setJob(null);
    setRunning(false);
    setError(null);
  }, [scopeKey, stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const poll = useCallback(
    (jobId: string) => {
      pollVenueDiagnosticsJob(jobId)
        .then((j) => {
          setJob(j);
          const allDone =
            j.status === "done" ||
            Object.values(j.venues).every(
              (v) => v.status === "completed" || v.status === "insufficient_data" || v.status === "failed",
            );
          if (allDone) {
            setRunning(false);
            stopPolling();
          } else {
            pollRef.current = setTimeout(() => poll(jobId), POLL_MS);
          }
        })
        .catch(() => {
          pollRef.current = setTimeout(() => poll(jobId), POLL_MS);
        });
    },
    [stopPolling],
  );

  const run = useCallback(() => {
    if (!selectedCount) return;
    setRunning(true);
    setError(null);
    startVenueDiagnosticsJob(inspectVenueIds.slice(0, MAX_VENUES), global.city, global.lookbackDays, toFilters(global), deep)
      .then((j) => {
        setJob(j);
        poll(j.job_id);
      })
      .catch(() => {
        setError("Could not start the diagnostic job. Try again once synthetic data source data is warm.");
        setRunning(false);
      });
  }, [inspectVenueIds, selectedCount, global, poll, deep]);

  const venueList: VenueDiagResult[] = useMemo(() => {
    if (!job) return [];
    return job.venue_ids.map((id) => job.venues[id]).filter(Boolean);
  }, [job]);

  return (
    <section className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Stethoscope size={18} className="text-teal-500" />
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text)]">AI venue diagnostics</h2>
            <p className="text-xs text-[var(--color-text-muted)]">
              Tick venues in the Venue Accept latency panel above, then run a per-venue diagnosis of high Accept latency & reassignment rate.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--color-text-muted)]" title="Adds a PII-scrubbed pass over raw courier chat messages (slower, 1 extra LLM call per venue).">
            <input
              type="checkbox"
              checked={deep}
              disabled={running}
              onChange={(e) => setDeep(e.target.checked)}
              className="accent-[var(--color-primary)]"
            />
            <MessagesSquare size={13} /> Deep (courier chat)
          </label>
          <button
            onClick={run}
            disabled={!selectedCount || running}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-primary-dark)] disabled:opacity-40"
          >
            {running ? <Loader2 size={15} className="animate-spin" /> : <ListChecks size={15} />}
            {running ? "Diagnosing…" : `Run diagnostics on ${capped} venue${capped === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>

      {selectedCount > MAX_VENUES && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300">
          {selectedCount} venues selected — only the first {MAX_VENUES} will be diagnosed per run.
        </div>
      )}

      {global.orderType === "drive" && (
        <div className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-300">
          Drive order type: the venue id is the platform id, so venue attributes (notes, hours, type) describe the platform, not one store.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">{error}</div>
      )}

      {!selectedCount && !job && (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-8 text-center text-sm text-[var(--color-text-muted)]">
          No venues selected. Tick one or more venues in the Venue Accept latency list/map above to enable diagnostics.
        </div>
      )}

      {venueList.length > 0 && (
        <div className="space-y-2">
          {venueList.map((r) => (
            <VenueCard
              key={r.venue_id}
              r={r}
              ctx={{ lookback_days: global.lookbackDays, order_type: global.orderType }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
