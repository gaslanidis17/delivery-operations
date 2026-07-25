import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Loader2, Shield, Database, Globe, LogIn, Filter } from "lucide-react";
import type { LogEntry, LogStats } from "../types";

const CATEGORY_COLORS: Record<string, string> = {
  auth: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  request: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  "synthetic-data": "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
};

const CATEGORY_ICONS: Record<string, typeof Shield> = {
  auth: LogIn,
  request: Globe,
  "synthetic-data": Database,
};

function CategoryBadge({ category }: { category: string }) {
  const cls = CATEGORY_COLORS[category] || "bg-gray-500/20 text-gray-300 border-gray-500/30";
  const Icon = CATEGORY_ICONS[category] || Filter;
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium ${cls}`}>
      <Icon size={10} />
      {category}
    </span>
  );
}

export function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<LogStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "500" });
      if (filterCategory) params.set("category", filterCategory);

      const [logsRes, statsRes] = await Promise.all([
        fetch(`/api/logs/recent?${params}`, { credentials: "include" }),
        fetch("/api/logs/stats", { credentials: "include" }),
      ]);
      if (logsRes.ok) {
        const data = await logsRes.json();
        setLogs(data.logs);
      }
      if (statsRes.ok) {
        setStats(await statsRes.json());
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [filterCategory]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(loadData, 5000);
    return () => clearInterval(id);
  }, [autoRefresh, loadData]);

  return (
    <div className="space-y-4">
      {/* Stats bar */}
      {stats && (
        <div className="flex flex-wrap gap-3">
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
            <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">Total Events</div>
            <div className="text-xl font-bold text-[var(--color-text)]">{stats.total_events}</div>
          </div>
          {Object.entries(stats.by_category).map(([cat, count]) => (
            <div key={cat} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
              <div className="flex items-center gap-1.5">
                <CategoryBadge category={cat} />
              </div>
              <div className="mt-1 text-xl font-bold text-[var(--color-text)]">{count}</div>
            </div>
          ))}
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
            <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">Active Users</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {Object.entries(stats.by_user).map(([user, count]) => (
                <span key={user} className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-300">
                  {user} ({count})
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-[var(--color-text-muted)]">Filter</label>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-xs text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
          >
            <option value="">All categories</option>
            <option value="auth">Auth</option>
            <option value="request">Requests</option>
            <option value="synthetic-data">Synthetic data</option>
          </select>
        </div>

        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="rounded"
          />
          Auto-refresh (5s)
        </label>

        <button
          onClick={loadData}
          disabled={loading}
          className="ml-auto flex h-7 items-center gap-1 rounded-md bg-[var(--color-primary)] px-3 text-xs font-medium text-white transition-colors hover:bg-[var(--color-primary)]/90 disabled:opacity-50"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Refresh
        </button>
      </div>

      {/* Log table */}
      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="max-h-[calc(100vh-320px)] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[var(--color-surface)] text-[var(--color-text-muted)]">
              <tr className="border-b border-[var(--color-border)]">
                <th className="px-3 py-2 text-left font-medium">Time</th>
                <th className="px-3 py-2 text-left font-medium">Category</th>
                <th className="px-3 py-2 text-left font-medium">Action</th>
                <th className="px-3 py-2 text-left font-medium">User</th>
                <th className="px-3 py-2 text-left font-medium">IP</th>
                <th className="px-3 py-2 text-left font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((entry, i) => (
                <tr
                  key={`${entry.ts}-${i}`}
                  className={`border-b border-[var(--color-border)]/50 transition-colors hover:bg-[var(--color-bg)] ${
                    entry.action.includes("error") || entry.action.includes("failed")
                      ? "bg-red-900/5"
                      : ""
                  }`}
                >
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[var(--color-text-muted)]">
                    {entry.ts.split("T")[1] || entry.ts}
                  </td>
                  <td className="px-3 py-1.5">
                    <CategoryBadge category={entry.category} />
                  </td>
                  <td className="px-3 py-1.5 font-medium text-[var(--color-text)]">
                    {entry.action}
                  </td>
                  <td className="px-3 py-1.5 text-[var(--color-text-muted)]">
                    {entry.user || "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[var(--color-text-muted)]">
                    {entry.ip || "—"}
                  </td>
                  <td className="max-w-xs truncate px-3 py-1.5 font-mono text-[10px] text-[var(--color-text-muted)]">
                    {Object.keys(entry.detail).length > 0
                      ? Object.entries(entry.detail)
                          .filter(([, v]) => v != null)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(" · ")
                      : "—"}
                  </td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-[var(--color-text-muted)]">
                    {loading ? "Loading logs…" : "No log entries yet"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
