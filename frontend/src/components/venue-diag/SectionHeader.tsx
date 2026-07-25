import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { InfoTooltip } from "./InfoTooltip";

// The standard header for every venue-diagnostic sub-panel: an icon, a
// plain-language title, an optional one-line subtitle, and an optional
// "?" explainer that defines the metric in basic terms. Keeps the panels
// visually consistent and self-documenting.
export function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  explainer,
  iconClassName = "text-teal-500",
}: {
  icon: LucideIcon;
  title: ReactNode;
  subtitle?: ReactNode;
  explainer?: ReactNode;
  iconClassName?: string;
}) {
  return (
    <div className="mb-2 flex items-start gap-1.5">
      <Icon size={14} className={`mt-0.5 shrink-0 ${iconClassName}`} />
      <div className="min-w-0">
        <div className="flex items-center gap-1 text-xs font-semibold text-[var(--color-text)]">
          <span className="truncate">{title}</span>
          {explainer && <InfoTooltip text={explainer} />}
        </div>
        {subtitle && <div className="text-[11px] text-[var(--color-text-muted)]">{subtitle}</div>}
      </div>
    </div>
  );
}
