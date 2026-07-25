import { useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import {
  fetchAISummary,
  fetchAIVenueSummary,
  fetchAICourierSummary,
  fetchAIRottenSummary,
  fetchAICountrySummary,
  fetchAICloneSummary,
} from "../api/client";
import { useFilters } from "../hooks/useFilters";

type AnalysisMode = "general" | "venue" | "courier";
type TabMode = "late" | "rotten" | "country" | "clone";

interface Props {
  tab?: TabMode;
  countryCode?: string;
}

const LATE_MODES: { value: AnalysisMode; label: string }[] = [
  { value: "general", label: "General" },
  { value: "venue", label: "Venue Performance" },
  { value: "courier", label: "Courier Performance" },
];

export function AISummaryPanel({ tab = "late", countryCode }: Props) {
  const { filters } = useFilters();
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<AnalysisMode>("general");

  const handleGenerate = async () => {
    setLoading(true);
    setSummary(null);
    try {
      let text: string;
      if (tab === "clone") {
        text = await fetchAICloneSummary(filters.city, filters.lookbackDays);
      } else if (tab === "rotten") {
        text = await fetchAIRottenSummary(filters.city, filters.lookbackDays);
      } else if (tab === "country") {
        text = await fetchAICountrySummary(countryCode ?? "R1", filters.lookbackDays);
      } else if (mode === "venue") {
        text = await fetchAIVenueSummary(filters.city, filters.lookbackDays, filters.sizeFilter);
      } else if (mode === "courier") {
        text = await fetchAICourierSummary(filters.city, filters.lookbackDays);
      } else {
        text = await fetchAISummary(filters.city, filters.lookbackDays);
      }
      setSummary(text);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSummary(`Failed to generate AI summary: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const title =
    tab === "clone" ? "AI Action Plan — Redispatch Rate" :
    tab === "rotten" ? "AI Insights — Queue Aging" :
    tab === "country" ? "AI Insights — Country Overview" :
    "AI Insights";

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-purple-400" />
            <h3 className="text-sm font-semibold text-[var(--color-text)]">{title}</h3>
          </div>

          {tab === "late" && (
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as AnalysisMode);
                setSummary(null);
              }}
              className="h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text)] focus:border-purple-500 focus:outline-none"
            >
              {LATE_MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          )}
        </div>

        <button
          onClick={handleGenerate}
          disabled={loading}
          className="flex h-7 items-center gap-1.5 rounded-md bg-purple-600 px-3 text-xs font-medium text-white transition-colors hover:bg-purple-700 disabled:opacity-50"
        >
          {loading ? (
            <>
              <Loader2 size={12} className="animate-spin" /> Analyzing…
            </>
          ) : (
            <>
              <Sparkles size={12} /> Generate
            </>
          )}
        </button>
      </div>

      {summary && (
        <div className="mt-4 space-y-2 text-sm leading-relaxed text-[var(--color-text-muted)]">
          {summary.split("\n").filter(Boolean).map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      )}

      {!summary && !loading && (
        <p className="mt-4 text-xs text-[var(--color-text-muted)]">
          Click "Generate" to produce an AI-powered analysis of the current data.
        </p>
      )}
    </div>
  );
}
