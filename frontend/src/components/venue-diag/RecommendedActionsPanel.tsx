import type { ReactNode } from "react";
import { Lightbulb, Zap, Clock, CalendarDays, Search, Target, User, type LucideIcon } from "lucide-react";
import type { VenueDiagRecommendedAction } from "../../types";
import { SectionHeader } from "./SectionHeader";

// Recommended actions, redesigned as a prioritised checklist: each action leads
// with its expected impact, then shows owner / priority / horizon as labelled
// chips (priority coloured, horizon with an icon), which finding it addresses,
// and the success metric as "How we'll know it worked".

const PRIORITY_META: Record<string, string> = {
  high: "bg-red-500/10 text-red-400",
  medium: "bg-amber-500/10 text-amber-400",
  low: "bg-[var(--color-surface)] text-[var(--color-text-muted)]",
};

const HORIZON_META: Record<string, { label: string; Icon: LucideIcon }> = {
  immediate: { label: "Immediate", Icon: Zap },
  short: { label: "Short term", Icon: Clock },
  long: { label: "Long term", Icon: CalendarDays },
  investigate: { label: "Investigate", Icon: Search },
};

function Chip({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${className}`}>
      {children}
    </span>
  );
}

function ActionCard({ action }: { action: VenueDiagRecommendedAction }) {
  const horizon = HORIZON_META[action.horizon] ?? { label: action.horizon, Icon: Clock };
  const priorityTone = PRIORITY_META[action.priority] ?? PRIORITY_META.low;
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="flex items-start gap-2">
        <span className="mt-1 h-4 w-4 shrink-0 rounded-full border-2 border-[var(--color-primary)]" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-[var(--color-text)]">{action.expected_impact}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Chip className={priorityTone}>Priority: {action.priority}</Chip>
            <Chip className="bg-[var(--color-bg)] text-[var(--color-text-muted)]">
              <horizon.Icon size={11} /> {horizon.label}
            </Chip>
            {action.owner && (
              <Chip className="bg-[var(--color-bg)] text-[var(--color-text-muted)]">
                <User size={11} /> {action.owner}
              </Chip>
            )}
          </div>
          {action.addresses_finding && (
            <div className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
              Addresses: <span className="text-[var(--color-text)]">{action.addresses_finding}</span>
            </div>
          )}
          {action.success_metric && (
            <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-[var(--color-text-muted)]">
              <Target size={12} className="mt-0.5 shrink-0 text-teal-500" />
              <span>
                How we&rsquo;ll know it worked: <span className="text-[var(--color-text)]">{action.success_metric}</span>
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function RecommendedActionsPanel({ actions }: { actions: VenueDiagRecommendedAction[] }) {
  if (actions.length === 0) return null;
  // Show high-priority actions first, then medium, then low — regardless of model order.
  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sorted = [...actions].sort(
    (a, b) => (order[a.priority] ?? 3) - (order[b.priority] ?? 3),
  );
  return (
    <div className="space-y-1.5">
      <SectionHeader
        icon={Lightbulb}
        title="Recommended actions"
        subtitle="Prioritised checklist — high priority first"
        explainer="Each action says what to do, who owns it, how soon (horizon), and how to measure success. 'Addresses' links it back to the finding it fixes."
      />
      {sorted.map((a, i) => (
        <ActionCard key={i} action={a} />
      ))}
    </div>
  );
}
