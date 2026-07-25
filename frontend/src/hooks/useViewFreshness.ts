import { useCallback, useEffect, useState } from "react";
import type { DataFreshness } from "../types";
import {
  aggregateFreshness,
  pollDelayMs,
  type FreshnessSummary,
} from "../components/StaleDataBanner";
import { useConnection } from "./useConnection";

/**
 * Serve-stale freshness + sign-in-gated background-warm poll loop for the CITY-detail
 * tabs (Late / Queue aging / Redispatch), matching the loop the Region/Country tabs run
 * inline. It NEVER pulls live synthetic data source on its own — it reads whatever is cached
 * and, when a session is live, the backend `/freshness` probe kicks off a
 * background warm of the current view; this hook polls until the view flips
 * fresh, re-pulling the (cached) data each tick so warmed data swaps in.
 *
 * The caller supplies:
 *   - `key`        — identifies the current view (e.g. `${city}:${lookback}`);
 *                    a change resets + reloads.
 *   - `enabled`    — only poll/publish while the tab is on-screen.
 *   - `probe`      — hits the tab's `/freshness` endpoint (returns `DataFreshness`).
 *   - `reloadData` — re-pulls the tab's (cache-only) data endpoints.
 * `probe`/`reloadData` MUST be memoized on the same inputs as `key` so identities
 * change exactly when the view does.
 *
 * Returns the aggregated `FreshnessSummary` (for `StaleDataBanner`), a
 * `pollError` flag (for `PollRetryHint`), a `retry`, and a `signIn` that
 * establishes the synthetic data source session then immediately warms this view. It also
 * publishes the summary to the shared connection context so the global header
 * status reflects the active tab.
 */
export function useViewFreshness(opts: {
  key: string;
  enabled?: boolean;
  publish?: boolean;
  probe: (force?: boolean) => Promise<DataFreshness>;
  reloadData: (silent: boolean) => void | Promise<void>;
}) {
  const { key, enabled = true, publish = true, probe, reloadData } = opts;
  const { live, connect, connecting, setStatus } = useConnection();

  const [freshness, setFreshness] = useState<FreshnessSummary | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [pollError, setPollError] = useState(false);

  const refresh = useCallback(
    async (silent: boolean, force = false) => {
      if (!silent) {
        setPollAttempt(0);
        setPollError(false);
      }
      try {
        // Pull cached data first (instant), then check freshness — the probe is
        // what (sign-in-gated) starts a background warm of this view. `force` (an
        // explicit Retry) bypasses the backend warm cooldown.
        await reloadData(silent);
        const f = await probe(force);
        setFreshness(aggregateFreshness([f]));
        setPollError(false);
      } catch {
        // On a silent poll, keep last-good data + surface a retry hint; on the
        // initial (non-silent) load the tab's own error UI takes over.
        if (silent) setPollError(true);
      } finally {
        if (silent) setPollAttempt((a) => a + 1);
      }
    },
    [probe, reloadData],
  );

  // Initial load + reload whenever the view (key) changes.
  useEffect(() => {
    if (!enabled) return;
    refresh(false);
  }, [enabled, key, refresh]);

  // Backoff poll while a warm is in flight or the view is stale.
  useEffect(() => {
    if (!enabled || !freshness) return;
    const delay = pollDelayMs(freshness, pollAttempt);
    if (delay === null) {
      if (pollAttempt !== 0) setPollAttempt(0);
      return;
    }
    const t = setTimeout(() => {
      refresh(true);
    }, delay);
    return () => clearTimeout(t);
  }, [enabled, freshness, pollAttempt, refresh]);

  // When a synthetic data source session comes online (via this tab's Sign-in, the header, or
  // another tab) and this view is behind with no live refresh yet, immediately
  // re-probe so the backend starts the warm without waiting out the backoff.
  useEffect(() => {
    if (!enabled || !live || !freshness) return;
    if ((freshness.stale || freshness.refreshing) && !freshness.canAutoRefresh) {
      setPollAttempt(0);
      refresh(true);
    }
    // Only react to the live edge; `freshness` is intentionally read, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, enabled]);

  // Publish this (active) tab's summary to the global header status.
  useEffect(() => {
    if (!enabled || !publish) return;
    setStatus(freshness);
    return () => setStatus(null);
  }, [enabled, publish, freshness, setStatus]);

  // Explicit user Retry (from the failed/stalled banner or the poll-error hint):
  // FORCE a re-warm so a failed scope re-runs immediately without waiting out the
  // backend cooldown.
  const retry = useCallback(() => {
    setPollAttempt(0);
    setPollError(false);
    refresh(true, true);
  }, [refresh]);

  const signIn = useCallback(async () => {
    const ok = await connect();
    if (ok) {
      setPollAttempt(0);
      // Force so a warm that errored before sign-in (or during a prior session)
      // isn't blocked by its cooldown.
      refresh(true, true);
    }
  }, [connect, refresh]);

  return { freshness, pollError, retry, signIn, signingIn: connecting };
}
