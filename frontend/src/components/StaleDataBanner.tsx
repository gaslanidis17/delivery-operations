import { useEffect, useRef, useState } from "react";
import { Loader2, Clock, AlertTriangle, Database, RefreshCw } from "lucide-react";
import { LEX } from "../lib/lexicon";
import type { DataFreshness } from "../types";

export interface FreshnessSummary {
  stale: boolean;
  refreshing: boolean;
  canAutoRefresh: boolean;
  newestDate: string | null;
  expectedDate: string | null;
  reason: string | null;
  // Merged warm PROGRESS across every `_freshness` block of the tab: summed
  // completed/total, earliest start, latest update. null when no warm has run.
  progress: {
    completed: number;
    total: number;
    startedAt: number | null;
    updatedAt: number | null;
  } | null;
  // Latest server clock (epoch seconds) observed — used with `progress.updatedAt`
  // to detect a stall without relying on the client's own clock.
  serverNow: number | null;
  // Last warm error (only meaningful when reason === "error").
  lastError: string | null;
}

/**
 * Combine the per-response `_freshness` blocks of a tab into one banner-level
 * summary. The tab is "refreshing" if ANY part is, "stale" if ANY part is, and
 * can auto-refresh if ANY part reports a live synthetic data source connection. `newestDate`
 * is the most-behind (earliest) cached date so the banner states the worst case;
 * `reason` is forced to "error" if ANY part failed so the banner surfaces it once
 * every part has settled.
 *
 * PROGRESS is SUMMED across EVERY source that carries a warm job, so the single
 * determinate bar reflects the combined work of ALL in-flight warms for the view
 * — the country master + each marked city's per-city warm (Country tab), or the
 * one all-countries job (Region tab, which server-aggregates so it passes a
 * single source here). Each source contributes by its job STATE:
 *   - running        → its live (completed, total);
 *   - done / error   → PINNED to (total, total) — a SETTLED source counts as
 *                      fully complete. This is what keeps the bar from (a)
 *                      sticking below 100% because one city FAILED partway, and
 *                      (b) jumping BACKWARDS when a source transitions
 *                      running→done. (A failed source still flips the banner to
 *                      the red "Retry" state once nothing is running — see
 *                      `reason === "error"`.)
 * For a FIXED set of sources this sum is monotonic (done pinned to full, running
 * only advances); it only grows if a NEW city is marked mid-warm (total rises as
 * that city's steps join). The bar therefore hits 100% exactly when every
 * contributing warm has settled, at which point `refreshing` is false and the
 * bar gives way to the fresh / failed state.
 */
export function aggregateFreshness(
  items: Array<DataFreshness | undefined | null>,
): FreshnessSummary {
  const present = items.filter((x): x is DataFreshness => !!x);
  let newestDate: string | null = null;
  let expectedDate: string | null = null;
  let reason: string | null = null;
  let lastError: string | null = null;
  let anyError = false;

  let completed = 0;
  let total = 0;
  let startedAt: number | null = null;
  let updatedAt: number | null = null;
  let serverNow: number | null = null;
  let anyProgress = false;

  for (const f of present) {
    if (f.newest_date && (newestDate === null || f.newest_date < newestDate)) {
      newestDate = f.newest_date;
    }
    if (f.expected_date) expectedDate = f.expected_date;
    if (f.reason === "error") anyError = true;
    if (!reason && f.reason) reason = f.reason;
    if (!lastError && f.last_error) lastError = f.last_error;

    const p = f.progress;
    if (p && typeof p.total === "number" && p.total > 0) {
      // Settled (done OR error) sources pin to full so the bar can't stick <100%
      // on a failed city or regress when a warm finishes; running/state-less
      // sources clamp their live count into [0, total].
      const settled = p.state === "done" || p.state === "error";
      const raw = typeof p.completed === "number" ? p.completed : 0;
      const contrib = settled ? p.total : Math.min(Math.max(0, raw), p.total);
      anyProgress = true;
      completed += contrib;
      total += p.total;
      const sa = p.started_at;
      const ua = p.updated_at;
      if (typeof sa === "number") startedAt = startedAt == null ? sa : Math.min(startedAt, sa);
      if (typeof ua === "number") updatedAt = updatedAt == null ? ua : Math.max(updatedAt, ua);
    }
    if (typeof f.server_now === "number") {
      serverNow = serverNow == null ? f.server_now : Math.max(serverNow, f.server_now);
    }
  }

  return {
    stale: present.some((f) => f.stale),
    refreshing: present.some((f) => f.refreshing),
    canAutoRefresh: present.some((f) => f.can_auto_refresh),
    newestDate,
    expectedDate,
    reason: anyError ? "error" : reason,
    progress: anyProgress ? { completed, total, startedAt, updatedAt } : null,
    serverNow,
    lastError,
  };
}

// A warm whose progress `updated_at` hasn't advanced within this many seconds
// (server-relative) while still "refreshing" is treated as STALLED — the banner
// flips from the progress bar to a "Refresh failed — Retry" state instead of
// spinning forever. Kept comfortably ABOVE the backend's ~120s per-query
// statement timeout (a slow-but-legit single query errors out on its own first),
// so this only trips on a genuinely wedged warm.
export const STALL_SECONDS = 180;
// Render a DETERMINATE bar only when at least this many steps are known; a single
// long step (e.g. the one-query country late-reasons warm) can't show meaningful
// fractional progress, so it falls back to an indeterminate animated bar.
const DETERMINATE_MIN_TOTAL = 2;

/** True when a warm is in flight but its progress has been frozen past the
 *  stall timeout (server-relative), i.e. it likely broke without erroring. */
export function isStalled(s: FreshnessSummary): boolean {
  if (!s.refreshing || !s.progress || s.serverNow == null) return false;
  const u = s.progress.updatedAt;
  if (u == null) return false;
  return s.serverNow - u > STALL_SECONDS;
}

/**
 * Live-ticking elapsed seconds since the (earliest) warm started. Anchored to the
 * server-relative start (`server_now - started_at`) on each freshness update, then
 * advanced client-side every second so the number moves smoothly between polls —
 * making a slow/stalled warm visible. Returns null when not refreshing.
 */
function useLiveElapsed(summary: FreshnessSummary): number | null {
  const { refreshing, serverNow } = summary;
  const startedAt = summary.progress?.startedAt ?? null;
  const anchor = useRef<{ clientMs: number; baseSec: number } | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (refreshing && startedAt != null && serverNow != null) {
      anchor.current = { clientMs: Date.now(), baseSec: Math.max(0, serverNow - startedAt) };
      setTick((t) => t + 1);
    } else {
      anchor.current = null;
    }
  }, [refreshing, startedAt, serverNow]);

  useEffect(() => {
    if (!refreshing) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [refreshing]);

  if (!anchor.current) return null;
  return anchor.current.baseSec + (Date.now() - anchor.current.clientMs) / 1000;
}

function formatElapsed(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function withJitter(ms: number): number {
  // ±15% so many tabs / polls don't synchronize into a thundering herd.
  return Math.round(ms * (0.85 + Math.random() * 0.3));
}

/**
 * How long to wait before the next silent re-poll, or null to stop polling.
 *   - refreshing → poll fast (a warm is in flight; fresh data is imminent), with
 *     a mild backoff cap in case a warm runs long.
 *   - stale (incl. sign-in-required + a failed warm within cooldown) → poll with
 *     EXPONENTIAL BACKOFF (25s → up to ~5 min) so a tab that can't refresh (no
 *     live synthetic data source session) or stays behind auto-recovers without hammering
 *     every 25s forever. A failed warm's backend cooldown lapses within this
 *     window and the next poll auto-retries.
 *   - fresh → stop.
 *
 * `attempt` is the count of consecutive silent polls since the last fresh /
 * user-initiated load; the caller resets it to 0 on a manual reload or once the
 * tab is fresh. All delays carry jitter.
 */
export function pollDelayMs(s: FreshnessSummary, attempt = 0): number | null {
  const n = Math.max(0, attempt);
  if (s.refreshing) {
    // Warm in flight — poll fast to swap fresh data in ASAP; cap ~15s.
    return withJitter(Math.min(15_000, 7_000 * Math.pow(1.3, n)));
  }
  if (s.stale) {
    // Stale / sign-in-down / failed — back off 25s → cap 5 min.
    return withJitter(Math.min(300_000, 25_000 * Math.pow(1.6, n)));
  }
  return null;
}

/**
 * Small, non-blocking hint shown when a SILENT background re-poll fails (network
 * down, request timed out, backend hiccup). The tab keeps rendering its last
 * good data underneath; this just tells the user a refresh attempt failed and is
 * being retried, with an immediate manual "Retry" affordance.
 */
export function PollRetryHint({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-700/30 bg-amber-900/10 px-3 py-1.5 text-xs text-amber-200/90">
      <span className="flex items-center gap-1.5">
        <AlertTriangle size={12} className="shrink-0" />
        Couldn’t reach the server to refresh — showing the last loaded data, retrying automatically.
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 rounded-md border border-amber-600/40 px-2 py-0.5 font-medium text-amber-100 transition-colors hover:bg-amber-800/30"
      >
        Retry
      </button>
    </div>
  );
}

function ageHint(newestDate: string | null): string {
  return newestDate ? ` (data as of ${newestDate})` : "";
}

/** Determinate or indeterminate warm progress bar (see DETERMINATE_MIN_TOTAL). */
function WarmProgressBar({ determinate, pct }: { determinate: boolean; pct: number }) {
  return (
    <div className="relative mt-2 h-1.5 w-full overflow-hidden rounded-full bg-blue-500/20">
      {determinate ? (
        <div
          className="h-full rounded-full bg-blue-400 transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      ) : (
        <div className="indeterminate-bar bg-blue-400" />
      )}
    </div>
  );
}

/**
 * Non-blocking freshness banner shown above a tab's content. Renders nothing
 * when the data is fresh. While a background synthetic data source refresh runs it shows a
 * PROGRESS bar (determinate "Refreshing 3 of 8…" when the step count is known,
 * else an animated indeterminate bar) with a live elapsed timer. If the warm
 * FAILS (backend reported an error) or STALLS (progress frozen past the timeout)
 * it shows a "Refresh failed — Retry" state instead of an endless spinner. When
 * the data is stale but no live connection exists (sign-in required) it shows a
 * "Sign in to synthetic data source" prompt. The tab keeps rendering its (stale) data
 * underneath the whole time — nothing is blocked.
 */
export function StaleDataBanner({
  summary,
  onSignIn,
  signingIn = false,
  onRetry,
}: {
  summary: FreshnessSummary;
  /**
   * Establish the synthetic data source session (pops the one-time interactive sign-in on the backend).
   * When provided, the "stale-needs-sign-in" state shows a working Sign-in
   * button instead of a passive hint. Wired to the shared connection context.
   */
  onSignIn?: () => void;
  signingIn?: boolean;
  /**
   * Force an immediate re-warm (bypasses the backend cooldown). Wired to the
   * "Retry" button of the failed/stalled state. Still sign-in-gated server-side.
   */
  onRetry?: () => void;
}) {
  const { stale, refreshing, canAutoRefresh, newestDate, progress } = summary;
  // Hook must run unconditionally, before any early return.
  const elapsed = useLiveElapsed(summary);
  const stalled = isStalled(summary);
  const failed = !refreshing && summary.reason === "error";

  if (refreshing && !stalled) {
    const determinate = !!progress && progress.total >= DETERMINATE_MIN_TOTAL;
    const pct =
      determinate && progress ? Math.min(100, Math.round((progress.completed / Math.max(1, progress.total)) * 100)) : 0;
    const label =
      determinate && progress
        ? `Refreshing ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}…`
        : "Generating synthetic data…";
    return (
      <div className="rounded-lg border border-blue-700/40 bg-blue-900/20 px-4 py-2.5 text-sm text-blue-200">
        <div className="flex items-center gap-2">
          <Loader2 size={15} className="animate-spin shrink-0" />
          <span className="flex-1">
            {label}
            {ageHint(newestDate)} This view refreshes automatically when it's ready.
          </span>
          {elapsed != null && (
            <span className="shrink-0 text-xs tabular-nums text-blue-300/80">{formatElapsed(elapsed)}</span>
          )}
        </div>
        <WarmProgressBar determinate={determinate} pct={pct} />
      </div>
    );
  }

  if (failed || stalled) {
    const detail =
      stalled
        ? "This is taking much longer than expected — it may have stalled."
        : summary.lastError
        ? `Refresh failed: ${summary.lastError.slice(0, 140)}`
        : "The last refresh failed.";
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-red-700/40 bg-red-900/20 px-4 py-2.5 text-sm text-red-200">
        <span className="flex items-center gap-2">
          <AlertTriangle size={15} className="shrink-0" />
          <span>
            {detail} Showing the last loaded data{ageHint(newestDate)}.
          </span>
        </span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-red-500/50 bg-red-500/10 px-3 py-1 font-medium text-red-100 transition-colors hover:bg-red-500/20"
          >
            <RefreshCw size={13} />
            Retry
          </button>
        )}
      </div>
    );
  }

  if (!stale) return null;

  if (!canAutoRefresh) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-700/40 bg-amber-900/20 px-4 py-2.5 text-sm text-amber-200">
        <span className="flex items-center gap-2">
          <AlertTriangle size={15} className="shrink-0" />
          <span>
            Cached data is out of date{ageHint(newestDate)}. Initialize the local scenario
            generator to refresh it automatically.
          </span>
        </span>
        {onSignIn && (
          <button
            type="button"
            onClick={onSignIn}
            disabled={signingIn}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-1 font-medium text-amber-100 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {signingIn ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Database size={13} />
            )}
            {signingIn ? LEX.warehouseSigningIn : LEX.warehouseSignIn}
          </button>
        )}
      </div>
    );
  }

  // Stale but auto-refresh is possible — the next poll will flip to "updating".
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-700/40 bg-amber-900/20 px-4 py-2.5 text-sm text-amber-200">
      <Clock size={15} className="shrink-0" />
      <span>Cached data is out of date{ageHint(newestDate)}. Refreshing in the background…</span>
    </div>
  );
}
