import { Loader2, CheckCircle2, Clock, Database, AlertTriangle } from "lucide-react";
import { LEX } from "../lib/lexicon";
import { useConnection } from "../hooks/useConnection";
import { isStalled } from "./StaleDataBanner";

/**
 * Compact, always-visible header pill summarising the synthetic data source session + the
 * active tab's data freshness: "data as of {date} · Up to date / Updating… 3/8 /
 * Refresh failed / Sign in to synthetic data source". Reads the shared connection context
 * (the active tab publishes its `FreshnessSummary` via `setStatus`). While a
 * background warm runs it mirrors the same progress the StaleDataBanner shows
 * (determinate step count when known). The Sign-in button is the global entry
 * point to establish the session (pops the one-time interactive popup on the backend);
 * once live, every tab's background warm runs without sign-in again.
 */
export function ConnectionStatus() {
  const { live, connecting, connect, status } = useConnection();

  const asOf = status?.newestDate ? `data as of ${status.newestDate}` : null;

  // Session not established yet → the ONE affordance that opens the interactive popup.
  // (`live === null` = status not checked yet: stay neutral, don't flash a prompt.)
  if (live === false) {
    return (
      <button
        type="button"
        onClick={() => connect()}
        disabled={connecting}
        className="flex h-8 items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/10 px-2.5 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        title={LEX.warehouseTitle}
      >
        {connecting ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Database size={13} />
        )}
        {connecting ? LEX.warehouseSigningIn : LEX.warehouseSignIn}
      </button>
    );
  }

  // Still checking the session and no tab has reported freshness yet → neutral.
  if (live === null && !status) return null;

  const refreshing = !!status?.refreshing;
  const stale = !!status?.stale;
  const stalled = status ? isStalled(status) : false;
  const failed = !!status && ((!refreshing && status.reason === "error") || stalled);
  const progress = status?.progress ?? null;

  let icon = <CheckCircle2 size={13} className="text-emerald-400" />;
  let text = "Up to date";
  let tone = "text-[var(--color-text-muted)]";
  if (failed) {
    icon = <AlertTriangle size={13} className="text-red-400" />;
    text = "Refresh failed";
    tone = "text-red-300";
  } else if (connecting || refreshing) {
    const determinate = !!progress && progress.total >= 2;
    icon = <Loader2 size={13} className="animate-spin text-blue-400" />;
    text =
      determinate && progress
        ? `Updating… ${Math.min(progress.completed + 1, progress.total)}/${progress.total}`
        : "Updating…";
    tone = "text-blue-300";
  } else if (stale) {
    icon = <Clock size={13} className="text-amber-400" />;
    text = "Data may be behind";
    tone = "text-amber-300";
  }

  return (
    <div
      className={`flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 text-xs font-medium ${tone}`}
      title={asOf ?? undefined}
    >
      {icon}
      <span>{text}</span>
      {asOf && (
        <span className="hidden text-[var(--color-text-muted)] sm:inline">· {asOf}</span>
      )}
    </div>
  );
}
