import type {
  LateOrder,
  FlagCounts,
  FlagLabels,
  OverlapEntry,
  CombinationEntry,
  FlagAnalysis,
  LateReasonBlock,
} from "../types";

const FLAG_KEYS = [
  "is_venue_late",
  "is_venue_early",
  "is_courier_waited",
  "is_slow_pickup",
  "is_slow_dropoff",
  "is_bundled",
  "is_cloned",
  "is_rotten",
  "is_long_distance",
  "is_reassigned",
  "is_low_acceptance",
  "is_eta_underestimate",
] as const;

export const FLAG_LABELS: FlagLabels = {
  is_venue_late: "Partner readiness lag",
  is_venue_early: "Partner early handoff",
  is_courier_waited: "Field wait at partner",
  is_slow_pickup: "Slow en-route segment",
  is_slow_dropoff: "Slow final segment",
  is_bundled: "Multi-stop batch",
  is_cloned: "Secondary fulfillment",
  is_rotten: "Extended queue time",
  is_long_distance: "Long-range route",
  is_reassigned: "Reassigned field unit",
  is_low_acceptance: "Low offer uptake",
  is_restaurant_slow: "Partner cycle time",
  is_eta_underestimate: "Promise gap",
  is_heavy_large: "Oversize category",
};

/**
 * Adapt a server-side LateReasonBlock (Country tab heavy/large reasons) into the
 * FlagAnalysis shape that LatenessReasonChart / OverlapMatrix consume. Uses the
 * frontend FLAG_LABELS so labels match the Late tab exactly. overlap_matrix /
 * top_combinations are only present at the country level (cities = bars only).
 */
export function flagAnalysisFromBlock(block?: LateReasonBlock | null): FlagAnalysis | null {
  if (!block) return null;
  return {
    flag_counts: block.flag_counts,
    flag_labels: FLAG_LABELS,
    overlap_matrix: block.overlap_matrix ?? [],
    top_combinations: block.top_combinations ?? [],
  };
}

export function compute_flag_counts(orders: LateOrder[]): FlagCounts {
  const counts: FlagCounts = {};
  for (const key of FLAG_KEYS) {
    counts[key] = orders.filter((o) => (o as any)[key]).length;
  }
  return counts;
}

export function compute_overlap_matrix(orders: LateOrder[]): OverlapEntry[] {
  const entries: OverlapEntry[] = [];
  for (let i = 0; i < FLAG_KEYS.length; i++) {
    for (let j = i + 1; j < FLAG_KEYS.length; j++) {
      const a = FLAG_KEYS[i];
      const b = FLAG_KEYS[j];
      const count = orders.filter((o) => (o as any)[a] && (o as any)[b]).length;
      if (count > 0) {
        entries.push({
          flag_a: a,
          label_a: FLAG_LABELS[a],
          flag_b: b,
          label_b: FLAG_LABELS[b],
          count,
        });
      }
    }
  }
  return entries.sort((a, b) => b.count - a.count);
}

export function compute_combination_counts(orders: LateOrder[]): CombinationEntry[] {
  const combos = new Map<string, { flags: string[]; labels: string[]; count: number }>();
  for (const o of orders) {
    const active = FLAG_KEYS.filter((k) => (o as any)[k]);
    if (active.length === 0) continue;
    const key = active.join("+");
    const existing = combos.get(key);
    if (existing) {
      existing.count++;
    } else {
      combos.set(key, {
        flags: [...active],
        labels: active.map((k) => FLAG_LABELS[k]),
        count: 1,
      });
    }
  }
  return Array.from(combos.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}
