import { useState, useEffect } from "react";
import { Dashboard } from "./pages/Dashboard";
import { LoginPage } from "./components/LoginPage";
import { FilterContext } from "./hooks/useFilters";
import { ConnectionProvider } from "./hooks/useConnection";
import type { Filters, TabView } from "./types";

interface AuthUser {
  username: string;
  name: string;
  role?: string;
}

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);

  const [filters, setFilters] = useState<Filters>({
    city: "Ridgeport",
    lookbackDays: 28,
    sizeFilter: "all",
    periodMode: "lookback",
  });
  // Region is the default landing tab after sign-in (and on "/").
  const [activeTab, setActiveTab] = useState<TabView>("region");

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => {
        if (r.ok) return r.json();
        throw new Error("not auth");
      })
      .then((data) => setUser(data))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)]">
        <div className="text-sm text-[var(--color-text-muted)]">Loading…</div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLogin={setUser} />;
  }

  return (
    <ConnectionProvider>
      <FilterContext.Provider value={{ filters, setFilters, activeTab, setActiveTab }}>
        <Dashboard user={user} onLogout={() => {
          fetch("/api/auth/logout", { method: "POST", credentials: "include" });
          setUser(null);
        }} />
      </FilterContext.Provider>
    </ConnectionProvider>
  );
}
