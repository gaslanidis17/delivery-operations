from __future__ import annotations

from fastapi import APIRouter, Query

from app.config import get_settings
from app.services.synthetic_data import read_plain_cached
from app.services.serve_stale import Read, view_freshness
from app.services.data_processor import (
    enrich_orders,
    compute_flag_counts,
    compute_overlap_matrix,
    compute_combination_counts,
    FLAG_LABELS,
)
from app.services.cache import cache

router = APIRouter(prefix="/api/late-orders", tags=["late-orders"])


def _cache_key(prefix: str, city: str, days: int) -> str:
    return f"{prefix}:{city}:{days}"


# In-memory cache prefixes for the whole Late/Rotten dashboard view. A background
# warm evicts these on completion so the next request re-assembles from the fresh
# on-disk cache instead of a stale TTL entry.
_CITY_VIEW_INVALIDATE = [
    "late_orders:", "late_summary:", "courier_perf:", "venue_perf:",
    "delayed_orders:", "map_venues:", "map_dropoffs:",
]


def _city_view_reads(city: str, lookback_days: int):
    """The plain-cache queries that compose the Late/Rotten dashboard view for one
    city (late + rotten + map + courier + venue). The frontend Dashboard loads all
    of these together, so they share a single freshness signal + warm scope. The
    dated ``base_late_orders`` file is the freshness signal (index 0).

    NOTE: the Rotten and Map panels are always fetched at ``min(lookback, 14)``
    days (``useOrders``/``useMapData`` on the frontend), so the warm here must use
    that SAME window for those files — otherwise a warm would refresh the full-
    window rotten/map cache the UI never reads and leave the 14d files it does
    read untouched (cache-key drift)."""
    s = get_settings()
    rm_days = min(lookback_days, 14)  # rotten + map read at this window on the UI
    return [
        Read("base_late_orders.dataset", {"city": city, "lookback_days": lookback_days}),
        Read("late_orders_summary.dataset", {"city": city, "lookback_days": lookback_days}),
        Read("late_orders_trend.dataset", {"city": city, "lookback_days": lookback_days}),
        Read("delayed_orders.dataset", {"city": city, "lookback_days": rm_days, "rotten_threshold_min": s.rotten_threshold_min}),
        Read("rotten_summary.dataset", {"city": city, "lookback_days": rm_days, "rotten_threshold_min": s.rotten_threshold_min}),
        Read("map_venues.dataset", {"city": city, "lookback_days": rm_days}),
        Read("map_dropoffs.dataset", {"city": city, "lookback_days": rm_days}),
        Read("hourly_distribution.dataset", {"city": city, "lookback_days": rm_days}),
        Read("courier_travel.dataset", {"city": city, "lookback_days": lookback_days}),
        Read("courier_speed_benchmark.dataset", {"city": city, "lookback_days": lookback_days}),
        Read("venue_performance.dataset", {
            "city": city, "lookback_days": lookback_days,
            "rotten_threshold_min": s.rotten_threshold_min,
            "venue_late_threshold": int(s.venue_late_threshold),
            "venue_early_threshold": int(s.venue_early_threshold),
            "size_filter_clause": "",
        }, cache_by_lookback=True),
    ]


@router.get("/freshness")
def get_city_view_freshness(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    force: bool = Query(default=False),
):
    """Serve-stale freshness probe + sign-in-gated background warm for the whole
    Late/Rotten dashboard view (late + rotten + map + courier + venue). NEVER
    queries on the request path (so it can't pop sign-in); when a synthetic data source session is
    already live and the cache is behind, it warms this city's view in the
    background and the frontend poll swaps in fresh data. See services/serve_stale.

    ``force=True`` is the UI's explicit "Retry" after a failed/stalled warm — it
    bypasses the warm cooldown (still live-gated; never opens sign-in)."""
    s = get_settings()
    city = city or s.default_city
    fresh = view_freshness(
        _city_view_reads(city, lookback_days),
        scope=f"city_view:{city}:{lookback_days}",
        signal_index=0,
        invalidate_prefixes=_CITY_VIEW_INVALIDATE,
        force=force,
    )
    return {"_freshness": fresh}


@router.get("")
def get_late_orders(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
):
    s = get_settings()
    city = city or s.default_city
    ck = _cache_key("late_orders", city, lookback_days)
    cached = cache.get(ck)
    if cached:
        return cached

    rows = read_plain_cached("base_late_orders.dataset", {
        "city": city,
        "lookback_days": lookback_days,
    }) or []
    enriched = enrich_orders(rows)
    result = {"orders": enriched, "total": len(enriched)}
    cache.set(ck, result, s.cache_ttl_seconds)
    return result


@router.get("/summary")
def get_summary(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
):
    s = get_settings()
    city = city or s.default_city
    ck = _cache_key("late_summary", city, lookback_days)
    cached = cache.get(ck)
    if cached:
        return cached

    rows = read_plain_cached("late_orders_summary.dataset", {
        "city": city,
        "lookback_days": lookback_days,
    }) or []
    result = rows[0] if rows else {}
    cache.set(ck, result, s.cache_ttl_seconds)
    return result


@router.get("/trend")
def get_trend(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
):
    s = get_settings()
    city = city or s.default_city
    rows = read_plain_cached("late_orders_trend.dataset", {
        "city": city,
        "lookback_days": lookback_days,
    }) or []
    return {"trend": rows}


@router.get("/flags")
def get_flag_analysis(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
):
    """Returns flag counts, overlap matrix, and top combinations."""
    s = get_settings()
    city = city or s.default_city

    orders_resp = get_late_orders(city, lookback_days)
    orders = orders_resp["orders"]

    return {
        "flag_counts": compute_flag_counts(orders),
        "flag_labels": FLAG_LABELS,
        "overlap_matrix": compute_overlap_matrix(orders),
        "top_combinations": compute_combination_counts(orders),
    }


@router.get("/courier-performance")
def get_courier_performance(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
):
    """Per-order travel metrics + per-courier aggregated summary + speed benchmarks."""
    s = get_settings()
    city = city or s.default_city
    ck = _cache_key("courier_perf", city, lookback_days)
    cached = cache.get(ck)
    if cached:
        return cached

    travel_rows = read_plain_cached("courier_travel.dataset", {
        "city": city,
        "lookback_days": lookback_days,
    }) or []

    benchmark_rows = read_plain_cached("courier_speed_benchmark.dataset", {
        "city": city,
        "lookback_days": lookback_days,
    }) or []

    dynamic_targets: dict[str, float] = {}
    for b in benchmark_rows:
        vt = (b.get("vehicle_type") or "").upper()
        median = b.get("median_speed_kmh")
        if vt and median and median > 0:
            dynamic_targets[vt] = float(median)

    static_targets = {k.upper(): v for k, v in s.courier_speed_targets.items()}
    speed_targets = {vt: dynamic_targets.get(vt, static_targets.get(vt, 15.0)) for vt in set(list(dynamic_targets.keys()) + list(static_targets.keys()))}
    buffer = s.courier_slow_travel_buffer

    for row in travel_rows:
        pickup_min = row.get("pickup_arrival_min")
        dropoff_min = row.get("dropoff_arrival_min")
        pickup_dist = row.get("pickup_distance_m")
        dropoff_dist = row.get("dropoff_distance_m")
        vt = (row.get("courier_vehicle_type") or "").upper()
        target_speed = speed_targets.get(vt, 15.0)

        if pickup_dist and pickup_dist > 0:
            row["pickup_target_min"] = round((pickup_dist / 1000.0) / target_speed * 60, 1)
        else:
            row["pickup_target_min"] = None

        if dropoff_dist and dropoff_dist > 0:
            row["dropoff_target_min"] = round((dropoff_dist / 1000.0) / target_speed * 60, 1)
        else:
            row["dropoff_target_min"] = None

        if pickup_min and pickup_min > 0 and pickup_dist and pickup_dist > 100:
            row["pickup_speed_kmh"] = round((pickup_dist / 1000.0) / (pickup_min / 60.0), 1)
        else:
            row["pickup_speed_kmh"] = None

        if dropoff_min and dropoff_min > 0 and dropoff_dist and dropoff_dist > 100:
            row["dropoff_speed_kmh"] = round((dropoff_dist / 1000.0) / (dropoff_min / 60.0), 1)
        else:
            row["dropoff_speed_kmh"] = None

        travel_min = (pickup_min or 0) + (dropoff_min or 0)
        total_dist = (pickup_dist or 0) + (dropoff_dist or 0)
        if total_dist > 0 and target_speed > 0:
            target_total_min = (total_dist / 1000.0) / target_speed * 60
            row["target_total_min"] = round(target_total_min, 1)
            row["travel_total_min"] = round(travel_min, 1)
            row["is_slow_travel"] = travel_min > target_total_min * buffer
            row["travel_ratio"] = round(travel_min / target_total_min, 2) if target_total_min > 0 else None
        else:
            row["target_total_min"] = None
            row["travel_total_min"] = round(travel_min, 1)
            row["is_slow_travel"] = False
            row["travel_ratio"] = None

        row["is_slow_pickup_travel"] = bool(
            pickup_min and row.get("pickup_target_min")
            and pickup_min > row["pickup_target_min"] * buffer
        )
        row["is_slow_dropoff_travel"] = bool(
            dropoff_min and row.get("dropoff_target_min")
            and dropoff_min > row["dropoff_target_min"] * buffer
        )

    courier_agg: dict[str, dict] = {}
    for row in travel_rows:
        wid = row.get("dropoff_worker_id") or row.get("pickup_worker_id")
        if not wid:
            continue
        if wid not in courier_agg:
            courier_agg[wid] = {
                "worker_id": wid,
                "vehicle_type": row.get("courier_vehicle_type"),
                "orders": 0,
                "slow_orders": 0,
                "sum_pickup_min": 0,
                "sum_dropoff_min": 0,
                "sum_pickup_dist": 0,
                "sum_dropoff_dist": 0,
                "n_speed": 0,
                "sum_speed": 0,
            }
        c = courier_agg[wid]
        c["orders"] += 1
        if row.get("is_slow_travel"):
            c["slow_orders"] += 1
        pm = row.get("pickup_arrival_min") or 0
        dm = row.get("dropoff_arrival_min") or 0
        c["sum_pickup_min"] += pm
        c["sum_dropoff_min"] += dm
        c["sum_pickup_dist"] += row.get("pickup_distance_m") or 0
        c["sum_dropoff_dist"] += row.get("dropoff_distance_m") or 0
        total_dist = (row.get("pickup_distance_m") or 0) + (row.get("dropoff_distance_m") or 0)
        travel_min = pm + dm
        if travel_min > 0 and total_dist > 100:
            speed = (total_dist / 1000.0) / (travel_min / 60.0)
            c["n_speed"] += 1
            c["sum_speed"] += speed

    couriers = []
    for c in courier_agg.values():
        n = c["orders"]
        couriers.append({
            "worker_id": c["worker_id"],
            "vehicle_type": c["vehicle_type"],
            "order_count": n,
            "slow_order_count": c["slow_orders"],
            "slow_pct": round(c["slow_orders"] / n * 100, 1) if n > 0 else 0,
            "avg_pickup_min": round(c["sum_pickup_min"] / n, 1) if n > 0 else 0,
            "avg_dropoff_min": round(c["sum_dropoff_min"] / n, 1) if n > 0 else 0,
            "avg_pickup_dist_m": round(c["sum_pickup_dist"] / n, 0) if n > 0 else 0,
            "avg_dropoff_dist_m": round(c["sum_dropoff_dist"] / n, 0) if n > 0 else 0,
            "avg_speed_kmh": round(c["sum_speed"] / c["n_speed"], 1) if c["n_speed"] > 0 else None,
        })
    couriers.sort(key=lambda x: x["slow_pct"], reverse=True)

    total_orders = len(travel_rows)
    slow_count = sum(1 for r in travel_rows if r.get("is_slow_travel"))

    result = {
        "orders": travel_rows,
        "couriers": couriers,
        "speed_benchmarks": benchmark_rows,
        "speed_targets": {k.lower(): v for k, v in speed_targets.items()},
        "summary": {
            "total_late_orders": total_orders,
            "slow_travel_orders": slow_count,
            "slow_travel_pct": round(slow_count / total_orders * 100, 1) if total_orders > 0 else 0,
            "buffer_multiplier": buffer,
        },
    }
    cache.set(ck, result, s.cache_ttl_seconds)
    return result


_SIZE_FILTER_DATASET = {
    "all": "",
    "heavy": "AND COALESCE(fcd.IS_HEAVY_DELIVERY, FALSE) = TRUE",
    "large": "AND COALESCE(fcd.IS_LARGE_DELIVERY, FALSE) = TRUE",
    "heavy_or_large": "AND (COALESCE(fcd.IS_HEAVY_DELIVERY, FALSE) = TRUE OR COALESCE(fcd.IS_LARGE_DELIVERY, FALSE) = TRUE)",
    "normal": "AND COALESCE(fcd.IS_HEAVY_DELIVERY, FALSE) = FALSE AND COALESCE(fcd.IS_LARGE_DELIVERY, FALSE) = FALSE",
}


@router.get("/venue-performance")
def get_venue_performance(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    size_filter: str = Query(default="all"),
):
    """Per-venue aggregated metrics with problem score ranking."""
    s = get_settings()
    city = city or s.default_city
    sf = size_filter if size_filter in _SIZE_FILTER_DATASET else "all"
    ck = f"venue_perf:{city}:{lookback_days}:{sf}"
    cached = cache.get(ck)
    if cached:
        return cached

    rows = read_plain_cached("venue_performance.dataset", {
        "city": city,
        "lookback_days": lookback_days,
    }, cache_by_lookback=True, cache_suffix=sf if sf != "all" else None) or []

    min_orders = s.venue_problem_score_min_orders

    for row in rows:
        total = row.get("total_orders") or 0
        late = row.get("late_orders") or 0
        rotten = row.get("delayed_orders") or 0
        vl = row.get("venue_late_count") or 0
        row["late_pct"] = round(late / total * 100, 1) if total > 0 else 0
        row["rotten_pct"] = round(rotten / total * 100, 1) if total > 0 else 0
        row["venue_late_share"] = round(vl / total * 100, 1) if total > 0 else 0

    scoreable = [r for r in rows if (r.get("total_orders") or 0) >= min_orders]

    max_prep = max((r.get("avg_prep_time_min") or 0 for r in scoreable), default=1) or 1
    max_ttla = max((r.get("avg_ttla_sec") or 0 for r in scoreable), default=1) or 1

    for row in rows:
        if (row.get("total_orders") or 0) < min_orders:
            row["problem_score"] = 0
            continue
        late_pct = row["late_pct"]
        vl_share = row["venue_late_share"]
        prep_norm = ((row.get("avg_prep_time_min") or 0) / max_prep) * 100
        ttla_norm = ((row.get("avg_ttla_sec") or 0) / max_ttla) * 100
        score = (
            late_pct * 0.35
            + vl_share * 0.30
            + prep_norm * 0.20
            + ttla_norm * 0.15
        )
        row["problem_score"] = round(score, 1)

    rows.sort(key=lambda r: r.get("problem_score", 0), reverse=True)

    total_venues = len(rows)
    problem_venues = sum(1 for r in rows if r.get("problem_score", 0) > 30)
    avg_late = round(
        sum(r["late_pct"] for r in rows) / total_venues, 1
    ) if total_venues > 0 else 0

    result = {
        "venues": rows,
        "summary": {
            "total_venues": total_venues,
            "problem_venues": problem_venues,
            "avg_late_pct": avg_late,
        },
    }
    cache.set(ck, result, s.cache_ttl_seconds)
    return result
