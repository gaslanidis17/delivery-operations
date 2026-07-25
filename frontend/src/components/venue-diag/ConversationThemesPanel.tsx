import { MessageSquareWarning } from "lucide-react";
import type { VenueDiagConversationsPack } from "../../types";
import { SectionHeader } from "./SectionHeader";
import { InfoTooltip } from "./InfoTooltip";

// "What couriers raise with support about this venue" — replaces the old terse
// "11 · 0.89/100" list. Each theme now leads with a plain label + the raw
// conversation count, then explains the two normalised numbers in words:
//   - per_100_orders  : this theme per 100 of THIS venue's orders (volume-normalised)
//   - share_of_city_theme : this venue's share of the WHOLE CITY's volume for the
//     theme — already returned by the backend but previously not rendered (this is
//     the "what are we comparing against?" piece that was missing).
function fmtDateSlice(d: string | null): string | null {
  if (!d) return null;
  return d.length >= 10 ? d.slice(5) : d;
}

export function ConversationThemesPanel({ convos }: { convos: VenueDiagConversationsPack }) {
  const { themes, total_conversations, conversations_per_100_orders } = convos;
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <SectionHeader
        icon={MessageSquareWarning}
        title="What couriers raise with support about this venue"
        subtitle={`${total_conversations.toLocaleString()} support conversations · ${conversations_per_100_orders ?? 0} per 100 of this venue's orders`}
        explainer={
          <>
            Courier-app support conversations tagged on the pickup (PU) and reassign (R) branches,
            linked to this venue&rsquo;s orders.
            <br />
            <br />
            <strong>per 100 orders</strong> = conversations of a theme per 100 of THIS
            venue&rsquo;s orders, so high-volume venues aren&rsquo;t over-counted.
            <br />
            <strong>city-wide share</strong> = this venue&rsquo;s share of the whole
            city&rsquo;s volume for that theme (how much of the problem sits here vs elsewhere).
          </>
        }
      />

      {themes.length ? (
        <ul className="space-y-1.5 text-xs">
          {themes.map((t) => {
            const first = fmtDateSlice(t.first_seen);
            const last = fmtDateSlice(t.last_seen);
            const span = first && last && first !== last ? `${first} – ${last}` : first ?? null;
            return (
              <li
                key={`${t.tag_lvl2}/${t.tag_lvl3}`}
                className="rounded bg-[var(--color-bg)] px-2 py-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[var(--color-text)]">
                    {t.label}
                    {t.confirmed && (
                      <span className="inline-flex items-center gap-0.5 rounded bg-teal-500/15 px-1 py-0.5 text-[10px] font-medium text-teal-400">
                        recurring (≥5×)
                        <InfoTooltip
                          label="What does recurring mean?"
                          text="Marked 'recurring' when this theme appears in at least 5 separate conversations — a pattern, not a one-off complaint."
                        />
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 tabular-nums font-semibold text-[var(--color-text)]">
                    {t.conversation_count.toLocaleString()}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-text-muted)]">
                  <span>{t.per_100_orders ?? 0} per 100 of this venue&rsquo;s orders</span>
                  {t.share_of_city_theme != null && (
                    <span>{Math.round(t.share_of_city_theme * 100)}% of all such complaints city-wide</span>
                  )}
                  {span && <span>· seen {span}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="text-xs text-[var(--color-text-muted)]">
          No courier pickup/reassign conversations linked in this window.
        </div>
      )}
    </div>
  );
}
