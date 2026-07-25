import { useState, useEffect } from "react";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import type { LoadingStep } from "../hooks/useLoadingProgress";

interface Props {
  steps: LoadingStep[];
  active: boolean;
  pct: number;
  completedCount: number;
  totalCount: number;
  elapsedMs: number;
  estimatedRemainingMs: number;
}

function formatTime(ms: number): string {
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const min = Math.floor(secs / 60);
  const sec = secs % 60;
  return `${min}m ${sec}s`;
}

export function DataLoadingBar({
  steps,
  active,
  pct,
  completedCount,
  totalCount,
  elapsedMs,
  estimatedRemainingMs,
}: Props) {
  const [visible, setVisible] = useState(false);
  const justFinished = !active && completedCount === totalCount && totalCount > 0;

  useEffect(() => {
    if (active) {
      setVisible(true);
    } else if (justFinished) {
      const t = setTimeout(() => setVisible(false), 3000);
      return () => clearTimeout(t);
    }
  }, [active, justFinished]);

  if (!visible || totalCount === 0) return null;

  const currentStep = steps.find((s) => s.status === "loading");

  return (
    <div
      className={`rounded-xl border bg-[var(--color-surface)] p-4 transition-all duration-500 ${
        justFinished
          ? "border-emerald-600/40 opacity-80"
          : "border-[var(--color-border)]"
      }`}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {active ? (
            <Loader2 size={14} className="animate-spin text-blue-400" />
          ) : (
            <CheckCircle2 size={14} className="text-emerald-400" />
          )}
          <span className="text-xs font-medium text-[var(--color-text)]">
            {active
              ? currentStep
                ? `Loading: ${currentStep.label}`
                : "Loading data…"
              : "All data loaded"}
          </span>
        </div>

        <div className="flex items-center gap-3 text-[10px] text-[var(--color-text-muted)]">
          <span>{completedCount} / {totalCount} queries</span>
          <span>Elapsed: {formatTime(elapsedMs)}</span>
          {active && estimatedRemainingMs > 0 && (
            <span>~{formatTime(estimatedRemainingMs)} remaining</span>
          )}
        </div>
      </div>

      <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-border)]">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            justFinished ? "bg-emerald-500" : "bg-blue-500"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {steps.map((step) => (
          <div key={step.key} className="flex items-center gap-1.5">
            {step.status === "done" ? (
              <CheckCircle2 size={10} className="text-emerald-400" />
            ) : step.status === "error" ? (
              <XCircle size={10} className="text-red-400" />
            ) : step.status === "loading" ? (
              <Loader2 size={10} className="animate-spin text-blue-400" />
            ) : (
              <div className="h-2.5 w-2.5 rounded-full border border-[var(--color-border)]" />
            )}
            <span
              className={`text-[10px] ${
                step.status === "done"
                  ? "text-emerald-400"
                  : step.status === "error"
                  ? "text-red-400"
                  : step.status === "loading"
                  ? "text-[var(--color-text)]"
                  : "text-[var(--color-text-muted)]"
              }`}
            >
              {step.label}
              {step.status === "done" && step.durationMs != null && (
                <span className="ml-1 opacity-60">({formatTime(step.durationMs)})</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
