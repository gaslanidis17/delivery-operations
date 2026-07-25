import { useState, type ReactNode } from "react";
import { HelpCircle } from "lucide-react";

// A small "?" affordance that reveals a plain-language definition on hover/focus.
// Reused across the venue-diagnostic panels so a basic user can hover any jargon
// term and read what it means + how it's computed, without leaving the card.
export function InfoTooltip({
  text,
  label = "What does this mean?",
  iconSize = 12,
  children,
}: {
  text: ReactNode;
  label?: string;
  iconSize?: number;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children ?? (
        <button
          type="button"
          className="text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] focus:outline-none"
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
        >
          <HelpCircle size={iconSize} />
        </button>
      )}
      {open && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 w-60 -translate-x-1/2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[11px] font-normal leading-snug text-[var(--color-text)] shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  );
}
