import type { ReactNode } from "react";
import { ClipboardList } from "lucide-react";
import type { VenueDiagFinding } from "../../types";
import { SectionHeader } from "./SectionHeader";
import { InfoTooltip } from "./InfoTooltip";

// Findings, redesigned for a basic user: each finding leads with a plain
// title + a coloured classification badge whose tooltip explains the rule
// (confirmed = 2+ independent signals, etc.), a confidence indicator, and a
// "What the data shows" evidence list. "When" and "Impact" are labelled chips
// so the structure reads at a glance.

const CLASS_META: Record<string, { label: string; tone: string; tip: string }> = {
  confirmed: {
    label: "Confirmed",
    tone: "bg-emerald-500/15 text-emerald-400",
    tip: "Backed by 2+ independent signals — e.g. high Accept latency in specific hours AND a matching courier complaint. Trust this.",
  },
  likely: {
    label: "Likely",
    tone: "bg-sky-500/15 text-sky-400",
    tip: "One strong signal supports this, but no second corroboration yet.",
  },
  possible: {
    label: "Possible",
    tone: "bg-amber-500/15 text-amber-400",
    tip: "A weak or isolated signal — treat as a lead to investigate, not a conclusion.",
  },
  insufficient: {
    label: "Too little evidence",
    tone: "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]",
    tip: "Not enough data to conclude anything here.",
  },
};

const CONF_META: Record<string, { tone: string; dot: string; tip: string }> = {
  high: { tone: "text-emerald-400", dot: "bg-emerald-400", tip: "High confidence in the reading of the data." },
  medium: { tone: "text-amber-400", dot: "bg-amber-400", tip: "Medium confidence." },
  low: { tone: "text-[var(--color-text-muted)]", dot: "bg-[var(--color-text-muted)]", tip: "Low confidence — limited supporting data." },
};

function Chip({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium ${className}`}>
      {children}
    </span>
  );
}

function FindingCard({ finding, index }: { finding: VenueDiagFinding; index: number }) {
  const cls = CLASS_META[finding.classification] ?? CLASS_META.insufficient;
  const conf = CONF_META[finding.confidence] ?? CONF_META.low;
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 text-[11px] font-semibold text-[var(--color-text-muted)]">{index + 1}</span>
          <div className="text-sm font-semibold text-[var(--color-text)]">{finding.title}</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          <Chip className={cls.tone}>
            {cls.label}
            <InfoTooltip label={`What does ${cls.label} mean?`} text={cls.tip} />
          </Chip>
          <Chip className="border border-[var(--color-border)] bg-[var(--color-bg)]">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${conf.dot}`} />
            <span className={conf.tone}>{finding.confidence} confidence</span>
            <InfoTooltip label="What does confidence mean?" text={conf.tip} />
          </Chip>
        </div>
      </div>

      <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">{finding.description}</p>

      <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
        {finding.time_period && (
          <span className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[var(--color-text-muted)]">
            When: {finding.time_period}
          </span>
        )}
        {finding.impact_estimate && (
          <span className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[var(--color-text-muted)]">
            Impact: {finding.impact_estimate}
          </span>
        )}
      </div>

      {finding.evidence.length > 0 && (
        <div className="mt-2">
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">What the data shows</div>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-[var(--color-text-muted)]">
            {finding.evidence.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function FindingsPanel({ findings }: { findings: VenueDiagFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <div className="space-y-2">
      <SectionHeader
        icon={ClipboardList}
        title="Findings"
        subtitle="What the evidence shows, strongest first"
        explainer={
          <>
            Each finding is ranked most-important-first. The badge is how well it&rsquo;s backed up:
            <strong> Confirmed</strong> needs 2+ independent signals to agree; <strong>Likely</strong>{" "}
            is one strong signal; <strong>Possible</strong> is a weak/isolated lead;{" "}
            <strong>Too little evidence</strong> means we can&rsquo;t conclude. Confidence is how
            sure the model is about reading the data correctly.
          </>
        }
      />
      {findings.map((f, i) => (
        <FindingCard key={`${f.title}-${i}`} finding={f} index={i} />
      ))}
    </div>
  );
}
