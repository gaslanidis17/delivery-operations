import { useState } from "react";
import { Lock, Loader2, AlertCircle } from "lucide-react";
import { LEX } from "../lib/lexicon";

interface LoginPageProps {
  onLogin: (user: { username: string; name: string }) => void;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        let detail = "Login failed";
        try {
          const data = await res.json();
          detail = typeof data.detail === "string" ? data.detail : detail;
        } catch {
          /* non-JSON body */
        }
        setError(
          detail === "Invalid username or password"
            ? "Invalid username or password. Demo: demo / delivery-demo"
            : detail,
        );
        return;
      }

      const user = await res.json();
      onLogin(user);
    } catch {
      setError("Connection error. Is the server running?");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)]">
      <div className="w-full max-w-sm">
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-xl">
          <div className="mb-6 flex flex-col items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-primary)]/10">
              <Lock size={20} className="text-[var(--color-primary)]" />
            </div>
            <h1 className="text-lg font-bold text-[var(--color-text)]">{LEX.appTitle}</h1>
            <p className="text-xs text-[var(--color-text-muted)]">{LEX.appSubtitle}</p>
            <p className="text-center text-[10px] text-[var(--color-text-muted)]">
              {LEX.companyName} — {LEX.companyBlurb}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--color-text-muted)]">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
                className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]/50 focus:border-[var(--color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
                placeholder="Enter username"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-[var(--color-text-muted)]">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]/50 focus:border-[var(--color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
                placeholder="Enter password"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-red-800/40 bg-red-900/20 px-3 py-2 text-xs text-red-300">
                <AlertCircle size={14} />
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !username || !password}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] text-sm font-medium text-white transition-colors hover:bg-[var(--color-primary)]/90 disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Signing in…
                </>
              ) : (
                "Sign in"
              )}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-[10px] text-[var(--color-text-muted)]">
          Demo access: <span className="font-mono">demo</span> /{" "}
          <span className="font-mono">delivery-demo</span>
          {" · "}
          <span className="font-mono">analyst</span> /{" "}
          <span className="font-mono">delivery-analyst</span>
        </p>
      </div>
    </div>
  );
}
