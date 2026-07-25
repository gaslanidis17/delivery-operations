import { useState, useEffect, useMemo } from "react";
import { Sparkles, Loader2, AlertTriangle, MapPin, ListChecks, Info, Activity } from "lucide-react";
import { fetchCountryAIAnalysis } from "../api/client";
import type {
  CountryAIResponse,
  CountryAITopic,
  CountryAICityStat,
  CountryAIReasonBlock,
} from "../types";
import { LatenessReasonChart } from "./LatenessReasonChart";
import { OverlapMatrix } from "./OverlapMatrix";
import { flagAnalysisFromBlock } from "../lib/flagUtils";

interface Props {
  countryCode: string;
  countryName: string;
  cities: string[];
  /** Seeds the initial range (the Country tab's effective window). The panel
   *  then drives the analysis window INDEPENDENTLY (it does not inherit later
   *  page-filter changes). */
  defaultLookbackDays: number;
}

const TOPIC_OPTIONS: { value: CountryAITopic; label: string; hint: string }[] = [
  { value: "heavy_large_lateness", label: "Tier A & Tier B lateness", hint: "Why oversized jobs are late and which cities drive it" },
  { value: "overall_lateness", label: "Overall lateness", hint: "Drivers of overall lateness + worst cities" },
  { value: "rotten", label: "Queue aging (supply gaps)", hint: "Queue aging root causes + worst cities/periods" },
];

const RANGE_OPTIONS = [
  { value: 7, label: "7d" },
  { value: 28, label: "28d" },
  { value: 84, label: "12w" },
  { value: 365, label: "6mo" }, // server clamps to the canonical max window
];

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-red-500/15 text-red-400 border-red-500/40",
  high: "bg-orange-500/15 text-orange-400 border-orange-500/40",
  moderate: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  watch: "bg-sky-500/15 text-sky-300 border-sky-500/40",
};

function severityClass(sev: string): string {
  return SEVERITY_STYLE[sev?.toLowerCase()] ?? "bg-[var(--color-border)] text-[var(--color-text-muted)] border-[var(--color-border)]";
}

function nearestPreset(d: number): number {
  let best = 28;
  let bestDiff = Infinity;
  for (const o of RANGE_OPTIONS) {
    const diff = Math.abs(o.value - d);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = o.value;
    }
  }
  return best;
}

const fmtPct = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(1)}%`);
const fmtCount = (n: number | null | undefined) => (n == null ? "—" : Math.round(n).toLocaleString());

function CityStatLine({ stat }: { stat: CountryAICityStat | undefined }) {
  if (!stat) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-text-muted)]">
      <span><span className="font-semibold text-[var(--color-text)]">{fmtPct(stat.rate_pct)}</span> rate</span>
      <span>{fmtCount(stat.numerator)} / {fmtCount(stat.denominator)}</span>
      <span>{fmtPct(stat.influence_pct)} influence</span>
      {stat.delta_vs_country_pp != null && (
        <span className={stat.delta_vs_country_pp > 0 ? "text-red-400" : "text-emerald-400"}>
          {stat.delta_vs_country_pp > 0 ? "+" : ""}{stat.delta_vs_country_pp.toFixed(1)}pp vs country
        </span>
      )}
      {stat.outlier && (
        <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-400">outlier</span>
      )}
    </div>
  );
}

export function CountryAIAnalysisPanel({ countryCode, countryName, cities, defaultLookbackDays }: Props) {
  const [topic, setTopic] = useState<CountryAITopic>("heavy_large_lateness");
  const [focus, setFocus] = useState("country");
  const [lookbackDays, setLookbackDays] = useState(() => nearestPreset(defaultLookbackDays));
  const [result, setResult] = useState<CountryAIResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset focus + result when the country changes (cities differ).
  useEffect(() => {
    setFocus("country");
    setResult(null);
    setError(null);
  }, [countryCode]);

  // Clear a stale result whenever any selector changes.
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [topic, focus, lookbackDays]);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchCountryAIAnalysis(countryCode, topic, focus, lookbackDays);
      setResult(r);
      if (r.error && !r.analysis) setError(r.error);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const cityStatByName = useMemo(() => {
    const m = new Map<string, CountryAICityStat>();
    for (const c of result?.stat_pack.cities ?? []) m.set(c.city, c);
    if (result?.stat_pack.focus_city) m.set(result.stat_pack.focus_city.city, result.stat_pack.focus_city);
    return m;
  }, [result]);

  const pack = result?.stat_pack;
  const analysis = result?.analysis ?? null;
  const reasons = pack?.reasons;

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-purple-400" />
          <h3 className="text-sm font-semibold text-[var(--color-text)]">AI Analysis — {countryName}</h3>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Topic</label>
          <select
            value={topic}
            onChange={(e) => setTopic(e.target.value as CountryAITopic)}
            className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-xs text-[var(--color-text)] focus:border-purple-500 focus:outline-none"
          >
            {TOPIC_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Focus</label>
          <select
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            className="h-8 max-w-[160px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-xs text-[var(--color-text)] focus:border-purple-500 focus:outline-none"
          >
            <option value="country">Whole country</option>
            {cities.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Range</label>
          <div className="flex h-8 rounded-md border border-[var(--color-border)] overflow-hidden">
            {RANGE_OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() => setLookbackDays(o.value)}
                className={`px-2.5 text-xs font-medium transition-colors ${
                  lookbackDays === o.value
                    ? "bg-purple-600 text-white"
                    : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={handleGenerate}
          disabled={loading}
          className="ml-auto flex h-8 items-center gap-1.5 rounded-md bg-purple-600 px-4 text-xs font-medium text-white transition-colors hover:bg-purple-700 disabled:opacity-50"
        >
          {loading ? (
            <><Loader2 size={12} className="animate-spin" /> Analyzing…</>
          ) : (
            <><Sparkles size={12} /> Generate</>
          )}
        </button>
      </div>

      <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
        {TOPIC_OPTIONS.find((t) => t.value === topic)?.hint} · this panel drives its OWN window (it does not inherit the page filter).
      </p>

      {/* Empty / loading states */}
      {!result && !loading && !error && (
        <p className="mt-4 text-xs text-[var(--color-text-muted)]">
          Pick a topic, focus, and range, then click Generate for a structured AI analysis (the first uncached pull is slow).
        </p>
      )}
      {loading && (
        <div className="mt-6 flex h-24 items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]">
          <Loader2 size={16} className="animate-spin" /> Building stat pack &amp; running the model…
        </div>
      )}
      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-700/40 bg-amber-900/15 px-4 py-3 text-xs text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>AI narrative unavailable: {error}. The computed numbers below are still shown.</span>
        </div>
      )}

      {pack && (
        <div className="mt-5 space-y-5">
          {/* Meta line */}
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
            <span className="rounded bg-[var(--color-bg)] px-2 py-0.5">{result?.topic_label}</span>
            <span className="rounded bg-[var(--color-bg)] px-2 py-0.5">Focus: {pack.scope === "city" ? pack.focus : "Whole country"}</span>
            <span className="rounded bg-[var(--color-bg)] px-2 py-0.5">Window: {pack.lookback_days}d</span>
            {result?.model && <span className="rounded bg-[var(--color-bg)] px-2 py-0.5">Model: {result.model}</span>}
            {result?.cached && <span className="rounded bg-[var(--color-bg)] px-2 py-0.5">cached</span>}
          </div>

          {/* Country KPI strip (always available from the stat pack) */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Object.entries(pack.country.metrics).map(([id, m]) => (
              <div key={id} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/50 p-3">
                <div className="text-[10px] text-[var(--color-text-muted)]">{m.label}</div>
                <div className="mt-1 text-lg font-bold text-[var(--color-text)]">{fmtPct(m.rate_pct)}</div>
                <div className="text-[9px] text-[var(--color-text-muted)]">
                  {fmtCount(m.numerator)} / {fmtCount(m.denominator)} {m.den_is_subpopulation ? "(sub-pop)" : m.den_label}
                </div>
              </div>
            ))}
          </div>

          {/* AI narrative */}
          {analysis && (
            <div className="space-y-4">
              <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-4">
                <p className="text-sm font-semibold leading-relaxed text-[var(--color-text)]">{analysis.headline}</p>
                {analysis.summary.length > 0 && (
                  <ul className="mt-3 space-y-1.5">
                    {analysis.summary.map((s, i) => (
                      <li key={i} className="flex gap-2 text-xs leading-relaxed text-[var(--color-text-muted)]">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-purple-400" />
                        <span>{s}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {analysis.key_drivers.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text)]">
                    <Activity size={13} className="text-purple-400" /> Key drivers
                  </div>
                  <ul className="space-y-1">
                    {analysis.key_drivers.map((d, i) => (
                      <li key={i} className="flex gap-2 text-xs text-[var(--color-text-muted)]">
                        <span className="text-purple-400">•</span><span>{d}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {analysis.cities_to_watch.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text)]">
                    <MapPin size={13} className="text-purple-400" /> Cities needing attention
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 [&>*]:min-w-0">
                    {analysis.cities_to_watch.map((c, i) => (
                      <div key={i} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-[var(--color-text)]">{c.city}</span>
                          <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize ${severityClass(c.severity)}`}>
                            {c.severity}
                          </span>
                        </div>
                        <CityStatLine stat={cityStatByName.get(c.city)} />
                        <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">{c.headline}</p>
                        {c.reason_tags.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {c.reason_tags.map((t) => (
                              <span key={t} className="rounded bg-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">{t}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Focus-city deep dive numbers */}
          {pack.scope === "city" && pack.focus_city && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-[var(--color-text)]">{pack.focus_city.city}</span>
                {pack.focus_rank != null && pack.total_cities != null && (
                  <span className="text-[11px] text-[var(--color-text-muted)]">rank #{pack.focus_rank} of {pack.total_cities} by influence</span>
                )}
              </div>
              <CityStatLine stat={pack.focus_city} />
            </div>
          )}

          {/* Reason charts (lateness topics) */}
          {reasons?.all && (
            <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
              <LatenessReasonChart
                flagAnalysis={flagAnalysisFromBlock(reasons.all as CountryAIReasonBlock)}
                title="Why are orders late?"
                subtitle={`${reasons.all.total.toLocaleString()} late orders · % of late`}
                total={reasons.all.total}
                showPct
              />
              <OverlapMatrix
                flagAnalysis={flagAnalysisFromBlock(reasons.all as CountryAIReasonBlock)}
                title="Top reason combinations"
                subtitle="Most common co-occurring lateness reasons"
              />
            </div>
          )}
          {(reasons?.heavy || reasons?.large) && (
            <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
              <LatenessReasonChart
                flagAnalysis={flagAnalysisFromBlock(reasons.heavy as CountryAIReasonBlock)}
                title="Why are HEAVY orders late?"
                subtitle={`${(reasons.heavy?.total ?? 0).toLocaleString()} late heavy · % of late heavy`}
                total={reasons.heavy?.total ?? 0}
                showPct
              />
              <LatenessReasonChart
                flagAnalysis={flagAnalysisFromBlock(reasons.large as CountryAIReasonBlock)}
                title="Why are LARGE orders late?"
                subtitle={`${(reasons.large?.total ?? 0).toLocaleString()} late large · % of late large`}
                total={reasons.large?.total ?? 0}
                showPct
              />
            </div>
          )}

          {/* Supply context (rotten topic) */}
          {pack.supply && Object.keys(pack.supply.by_city).length > 0 && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
              <h4 className="mb-2 text-xs font-semibold text-[var(--color-text)]">Courier-supply context (acceptance % &amp; avg Accept latency)</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] text-[var(--color-text)]">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
                      <th className="px-2 py-1 text-left font-medium">City</th>
                      <th className="px-2 py-1 text-right font-medium">Orders</th>
                      <th className="px-2 py-1 text-right font-medium">Acceptance</th>
                      <th className="px-2 py-1 text-right font-medium">Avg Accept latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-[var(--color-border)]/40 font-medium">
                      <td className="px-2 py-1">{countryName} (all)</td>
                      <td className="px-2 py-1 text-right">{fmtCount(pack.supply.country.orders)}</td>
                      <td className="px-2 py-1 text-right">{fmtPct(pack.supply.country.acceptance_pct)}</td>
                      <td className="px-2 py-1 text-right">{pack.supply.country.avg_ttla_sec ?? "—"}s</td>
                    </tr>
                    {Object.entries(pack.supply.by_city).map(([city, s]) => (
                      <tr key={city} className="border-b border-[var(--color-border)]/30">
                        <td className="px-2 py-1">{city}</td>
                        <td className="px-2 py-1 text-right">{fmtCount(s.orders)}</td>
                        <td className="px-2 py-1 text-right">{fmtPct(s.acceptance_pct)}</td>
                        <td className="px-2 py-1 text-right">{s.avg_ttla_sec ?? "—"}s</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Full city stat table (country scope) — always rendered from numbers */}
          {pack.scope === "country" && (pack.cities?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
              <h4 className="mb-2 text-xs font-semibold text-[var(--color-text)]">
                Cities by influence (share of the country's bad numerator)
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] text-[var(--color-text)]">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
                      <th className="px-2 py-1 text-left font-medium">City</th>
                      <th className="px-2 py-1 text-right font-medium">Rate</th>
                      <th className="px-2 py-1 text-right font-medium">Count</th>
                      <th className="px-2 py-1 text-right font-medium">Influence</th>
                      <th className="px-2 py-1 text-right font-medium">Δ vs country</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pack.cities!.map((c) => (
                      <tr key={c.city} className="border-b border-[var(--color-border)]/30">
                        <td className="px-2 py-1">
                          <span className="font-medium">{c.city}</span>
                          {c.outlier && <span className="ml-1.5 rounded bg-red-500/15 px-1 py-0.5 text-[9px] font-medium text-red-400">outlier</span>}
                        </td>
                        <td className="px-2 py-1 text-right">{fmtPct(c.rate_pct)}</td>
                        <td className="px-2 py-1 text-right text-[var(--color-text-muted)]">{fmtCount(c.numerator)} / {fmtCount(c.denominator)}</td>
                        <td className="px-2 py-1 text-right">{fmtPct(c.influence_pct)}</td>
                        <td className={`px-2 py-1 text-right ${c.delta_vs_country_pp != null && c.delta_vs_country_pp > 0 ? "text-red-400" : "text-emerald-400"}`}>
                          {c.delta_vs_country_pp == null ? "—" : `${c.delta_vs_country_pp > 0 ? "+" : ""}${c.delta_vs_country_pp.toFixed(1)}pp`}
                        </td>
                      </tr>
                    ))}
                    {pack.others && (
                      <tr className="border-t border-[var(--color-border)] text-[var(--color-text-muted)]">
                        <td className="px-2 py-1 italic">Other ({pack.others.cities} cities)</td>
                        <td className="px-2 py-1 text-right">{fmtPct(pack.others.rate_pct)}</td>
                        <td className="px-2 py-1 text-right">{fmtCount(pack.others.numerator)} / {fmtCount(pack.others.denominator)}</td>
                        <td className="px-2 py-1 text-right">{fmtPct(pack.others.influence_pct)}</td>
                        <td className="px-2 py-1 text-right">—</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Worst periods */}
          {(pack.worst_periods?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 p-3">
              <h4 className="mb-2 text-xs font-semibold text-[var(--color-text)]">Worst days (by rate)</h4>
              <div className="flex flex-wrap gap-2">
                {pack.worst_periods!.map((p) => (
                  <span key={p.date} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11px] text-[var(--color-text)]">
                    {p.date}: <span className="font-semibold text-red-400">{fmtPct(p.rate_pct)}</span>{" "}
                    <span className="text-[var(--color-text-muted)]">({fmtCount(p.numerator)}/{fmtCount(p.denominator)})</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Recommended actions */}
          {analysis && analysis.recommended_actions.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text)]">
                <ListChecks size={13} className="text-purple-400" /> Recommended actions
              </div>
              <ul className="space-y-1.5">
                {analysis.recommended_actions.map((a, i) => (
                  <li key={i} className="flex gap-2 text-xs text-[var(--color-text-muted)]">
                    <span className="mt-0.5 inline-block h-3.5 w-3.5 shrink-0 rounded border border-[var(--color-border)]" />
                    <span>{a}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Caveats */}
          {analysis && analysis.caveats.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/30 px-3 py-2 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
              <Info size={12} className="mt-0.5 shrink-0" />
              <div className="space-y-1">
                {analysis.caveats.map((c, i) => (<p key={i}>{c}</p>))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
