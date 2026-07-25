from __future__ import annotations

"""
Boolean-flag computation for overlapping lateness reasons.

Each condition is evaluated independently so an order can carry multiple
flags at once. Thresholds are pulled from Settings.
"""

from typing import Any, Optional
from collections import Counter

from app.config import get_settings


def _num(val: Any) -> float | None:
    if val is None:
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def compute_lateness_flags(row: dict[str, Any]) -> dict[str, bool]:
    s = get_settings()

    ready_vs_eta = _num(row.get("ready_vs_pickup_eta_sec"))
    courier_arrived_late = bool(row.get("courier_arrived_after_eta"))
    courier_wait = _num(row.get("courier_wait_at_venue_sec"))
    pickup_dur = _num(row.get("pickup_duration_min"))
    initial_pu_eta = _num(row.get("initial_pickup_eta_min"))
    task_total = _num(row.get("courier_task_total_min"))
    pre_est_high = _num(row.get("pre_estimate_high"))
    started_before_ready = bool(row.get("courier_started_before_ready"))
    bundled = int(row.get("bundled_count") or 1)
    time_to_accept = _num(row.get("time_to_last_accept_sec"))

    dropoff_distance = _num(row.get("dropoff_distance_m"))
    shown_to_couriers = int(row.get("shown_to_couriers_count") or 0)
    task_accepted = int(row.get("task_accepted_count") or 0)
    eta_error = _num(row.get("eta_error_seconds"))
    restaurant_time = _num(row.get("restaurant_total_time_min"))
    is_heavy = bool(row.get("is_heavy_delivery"))
    is_large = bool(row.get("is_large_delivery"))

    is_venue_late = (
        ready_vs_eta is not None and ready_vs_eta > s.venue_late_threshold
    )

    is_venue_early = (
        ready_vs_eta is not None and ready_vs_eta < s.venue_early_threshold
    )

    is_courier_waited = (
        courier_arrived_late
        and courier_wait is not None
        and courier_wait > s.courier_wait_threshold
    )

    is_slow_pickup = (
        pickup_dur is not None
        and initial_pu_eta is not None
        and pickup_dur > initial_pu_eta + s.slow_pickup_buffer_min
    )

    is_slow_dropoff = (
        task_total is not None
        and pre_est_high is not None
        and task_total > pre_est_high
    )

    is_bundled = bundled >= 2

    is_rotten = (
        time_to_accept is not None
        and time_to_accept >= s.rotten_threshold_min * 60
    )

    is_long_distance = (
        dropoff_distance is not None
        and dropoff_distance > s.long_distance_threshold_m
    )

    is_reassigned = task_accepted > 1

    is_low_acceptance = (
        shown_to_couriers >= s.low_acceptance_shown_min
        and task_accepted <= 1
    )

    is_restaurant_slow = False

    is_eta_underestimate = (
        eta_error is not None
        and eta_error > s.eta_error_threshold_sec
    )

    is_heavy_large = is_heavy or is_large

    return {
        "is_venue_late": is_venue_late,
        "is_venue_early": is_venue_early,
        "is_courier_waited": is_courier_waited,
        "is_slow_pickup": is_slow_pickup,
        "is_slow_dropoff": is_slow_dropoff,
        "is_bundled": is_bundled,
        "is_rotten": is_rotten,
        "is_long_distance": is_long_distance,
        "is_reassigned": is_reassigned,
        "is_low_acceptance": is_low_acceptance,
        "is_restaurant_slow": is_restaurant_slow,
        "is_eta_underestimate": is_eta_underestimate,
        "is_heavy_large": is_heavy_large,
    }


def deduplicate_orders(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse duplicate purchase_id rows, merging vehicle types and counting couriers."""
    seen: dict[str, dict[str, Any]] = {}
    for row in rows:
        pid = row.get("purchase_id")
        if pid in seen:
            existing = seen[pid]
            existing["_courier_count"] += 1
            new_vt = row.get("vehicle_type")
            old_vt = existing.get("vehicle_type")
            if new_vt and new_vt not in (old_vt or ""):
                existing["vehicle_type"] = f"{old_vt} | {new_vt}" if old_vt else new_vt
        else:
            seen[pid] = {**row, "_courier_count": 1}
    for entry in seen.values():
        entry["courier_count"] = entry.pop("_courier_count")
    return list(seen.values())


def enrich_orders(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped = deduplicate_orders(rows)
    enriched = []
    for row in deduped:
        flags = compute_lateness_flags(row)
        flags["is_cloned"] = row.get("courier_count", 1) >= 2
        enriched.append({**row, **flags})
    return enriched


FLAG_NAMES = [
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
    "is_heavy_large",
]

# When the population is already restricted to heavy/large orders (e.g. the
# Country tab's "why are heavy/large orders late?" breakdowns), the
# `is_heavy_large` flag is trivially true for every order and carries no signal,
# so it would dominate every bar and every co-occurrence combination. Use this
# reduced taxonomy there. (Matches the frontend FLAG_KEYS, which also omits it.)
REASON_FLAG_NAMES = [f for f in FLAG_NAMES if f != "is_heavy_large"]

FLAG_LABELS = {
    "is_venue_late": "Partner readiness lag",
    "is_venue_early": "Partner early handoff",
    "is_courier_waited": "Field wait at partner",
    "is_slow_pickup": "Slow en-route segment",
    "is_slow_dropoff": "Slow final segment",
    "is_bundled": "Multi-stop batch",
    "is_cloned": "Secondary fulfillment",
    "is_rotten": "Extended queue time",
    "is_long_distance": "Long-range route",
    "is_reassigned": "Reassigned field unit",
    "is_low_acceptance": "Low offer uptake",
    "is_restaurant_slow": "Partner cycle time",
    "is_eta_underestimate": "Promise gap",
    "is_heavy_large": "Oversize category",
}


def compute_flag_counts(
    orders: list[dict[str, Any]], flag_names: Optional[list[str]] = None
) -> dict[str, int]:
    names = flag_names if flag_names is not None else FLAG_NAMES
    counts = {f: 0 for f in names}
    for o in orders:
        for f in names:
            if o.get(f):
                counts[f] += 1
    return counts


def compute_overlap_matrix(
    orders: list[dict[str, Any]], flag_names: Optional[list[str]] = None
) -> list[dict[str, Any]]:
    names = flag_names if flag_names is not None else FLAG_NAMES
    matrix = []
    for i, fa in enumerate(names):
        for fb in names[i:]:
            count = sum(1 for o in orders if o.get(fa) and o.get(fb))
            matrix.append({
                "flag_a": fa,
                "label_a": FLAG_LABELS[fa],
                "flag_b": fb,
                "label_b": FLAG_LABELS[fb],
                "count": count,
            })
    return matrix


def compute_combination_counts(
    orders: list[dict[str, Any]],
    top_n: int = 15,
    flag_names: Optional[list[str]] = None,
) -> list[dict[str, Any]]:
    names = flag_names if flag_names is not None else FLAG_NAMES
    combos: Counter[tuple[str, ...]] = Counter()
    for o in orders:
        active = tuple(f for f in names if o.get(f))
        if active:
            combos[active] += 1

    results = []
    for combo, count in combos.most_common(top_n):
        results.append({
            "flags": list(combo),
            "labels": [FLAG_LABELS[f] for f in combo],
            "count": count,
        })
    return results
