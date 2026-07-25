import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { getDataSourceStatus, initializeDataSource } from "../api/client";
import type { FreshnessSummary } from "../components/StaleDataBanner";

/**
 * App-wide synthetic data source session + data-freshness state, shared by every tab.
 *
 * - `live` — is the shared synthetic data source session established? `null` until the first
 *   status check returns. Polled (cheaply, never opening a connection) so the
 *   header reflects a sign-in that happened elsewhere.
 * - `connect()` — establish the session on explicit user action (the ONE call
 *   that may pop the interactive sign-in popup). Any signed-in user can call it. Resolves to
 *   the resulting `live` state.
 * - `status` / `setStatus` — the ACTIVE tab publishes its aggregated
 *   `FreshnessSummary` here so the global header can show "data as of {date} ·
 *   Up to date / Updating…". Cleared when a tab unmounts.
 */
interface ConnectionContextValue {
  live: boolean | null;
  connecting: boolean;
  connect: () => Promise<boolean>;
  refreshStatus: () => void;
  status: FreshnessSummary | null;
  setStatus: (s: FreshnessSummary | null) => void;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

// How often to re-check the (cheap, non-sign-in) live status so the header notices a
// session that came online in another tab / via the admin refresh.
const STATUS_POLL_MS = 30_000;

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [live, setLive] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatusState] = useState<FreshnessSummary | null>(null);

  const refreshStatus = useCallback(() => {
    getDataSourceStatus()
      .then((r) => setLive(r.live))
      .catch(() => setLive((prev) => prev ?? false));
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      const r = await initializeDataSource();
      setLive(r.live);
      return r.live;
    } catch {
      // The popup may have been dismissed / login failed; reflect not-live so the
      // UI keeps offering the sign-in affordance.
      refreshStatus();
      return false;
    } finally {
      setConnecting(false);
    }
  }, [refreshStatus]);

  // `setStatus` is stable so tabs can call it from an effect without loops.
  const setStatus = useCallback((s: FreshnessSummary | null) => {
    setStatusState(s);
  }, []);

  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, STATUS_POLL_MS);
    return () => clearInterval(t);
  }, [refreshStatus]);

  const value = useMemo<ConnectionContextValue>(
    () => ({ live, connecting, connect, refreshStatus, status, setStatus }),
    [live, connecting, connect, refreshStatus, status, setStatus],
  );

  return (
    <ConnectionContext.Provider value={value}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnection(): ConnectionContextValue {
  const ctx = useContext(ConnectionContext);
  if (!ctx) {
    // Defensive default so a component rendered outside the provider (shouldn't
    // happen) doesn't crash the whole app.
    return {
      live: null,
      connecting: false,
      connect: async () => false,
      refreshStatus: () => {},
      status: null,
      setStatus: () => {},
    };
  }
  return ctx;
}
