from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Query

from app.config import get_settings
from app.services.synthetic_data import read_plain_cached
from app.services.serve_stale import Read, view_freshness
from app.services.cache import cache

router = APIRouter(prefix="/api/clone-rate", tags=["clone-rate"])

# In-memory cache prefixes for the Clone tab view — evicted after a background
# warm so the next request rebuilds from the freshly written on-disk cache.
_CLONE_VIEW_INVALIDATE = [
    "clone_summary:", "clone_acceptance:", "clone_vehicle_dist:", "clone_vehicle_cal:",
    "clone_orders:", "clone_venues:", "clone_orders_cal:", "clone_courier_pos:",
    "clone_order_pos:", "clone_vehicle_share:",
]

# CASE expression that mirrors capability_group in the DATASET SELECT; used so a
# weight-tier filter matches the same exclusive bucketing.
_CAPABILITY_CASE = (
    "CASE "
    "WHEN ctg.required_capabilities::TEXT LIKE '%WEIGHT^_L%' ESCAPE '^' THEN 'WEIGHT_L' "
    "WHEN ctg.required_capabilities::TEXT LIKE '%WEIGHT^_XL%' ESCAPE '^' THEN 'WEIGHT_XL' "
    "WHEN ctg.required_capabilities::TEXT LIKE '%WEIGHT^_XXL%' ESCAPE '^' THEN 'WEIGHT_XXL' "
    "WHEN ctg.required_capabilities::TEXT LIKE '%WEIGHT^_XXXL%' ESCAPE '^' THEN 'WEIGHT_XXXL' "
    "ELSE 'NONE' END"
)

_VALID_TIERS = {"WEIGHT_L", "WEIGHT_XL", "WEIGHT_XXL", "WEIGHT_XXXL"}


def _weight_costs() -> dict:
    return get_settings().weight_tier_costs


def _size_filter_clause(size_filter: Optional[str]) -> str:
    """Build the heavy/large WHERE clause. This tab is inherently heavy/large,
    so 'all', 'heavy_or_large', and 'normal' all mean heavy OR large."""
    sf = (size_filter or "heavy_or_large").lower()
    if sf == "heavy":
        return "AND COALESCE(fcd.IS_HEAVY_DELIVERY, FALSE)"
    if sf == "large":
        return "AND COALESCE(fcd.IS_LARGE_DELIVERY, FALSE)"
    return "AND (COALESCE(fcd.IS_HEAVY_DELIVERY, FALSE) OR COALESCE(fcd.IS_LARGE_DELIVERY, FALSE))"


def _weight_tier_clause(weight_tier: Optional[str]) -> str:
    wt = (weight_tier or "all").upper()
    if wt in _VALID_TIERS:
        return f"AND {_CAPABILITY_CASE} = '{wt}'"
    return ""


def _cache_key(prefix: str, city: str, lookback_days: int, *extra: str) -> str:
    suffix = ":".join(str(e) for e in extra)
    base = f"{prefix}:{city}:{lookback_days}"
    return f"{base}:{suffix}" if suffix else base


def _clone_view_reads(city: str, lookback_days: int):
    """The lookback-keyed daily clone files that drive the Clone tab's freshness
    signal (index 0 = the dated ``clone_rate_summary``). The date-window panels
    (calendars / positions / venues) are still WARMED by ``_warm_clone_cache`` but
    aren't part of the freshness signal (their filenames rotate daily by date)."""
    return [
        Read("clone_rate_summary.dataset", {"city": city, "lookback_days": lookback_days}, cache_by_lookback=True, cache_suffix="heavy_or_large_all"),
        Read("clone_city_share.dataset", {"city": city, "lookback_days": lookback_days}, cache_by_lookback=True),
        Read("clone_acceptance_by_weight.dataset", {"city": city, "lookback_days": lookback_days}, cache_by_lookback=True, cache_suffix="heavy_or_large"),
        Read("clone_vehicle_distribution.dataset", {"city": city, "lookback_days": lookback_days}),
        Read("clone_orders_list.dataset", {"city": city, "lookback_days": lookback_days}, cache_by_lookback=True, cache_suffix="heavy_or_large_all"),
        Read("clone_vehicle_share.dataset", {"city": city, "lookback_days": lookback_days}, cache_by_lookback=True),
    ]


@router.get("/freshness")
def get_clone_view_freshness(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    force: bool = Query(default=False),
):
    """Serve-stale freshness probe + sign-in-gated background warm for the Clone tab's
    default view of one city. NEVER queries on the request path; when a synthetic data source
    session is live and the cache is behind, it warms the default clone view (the
    same set admin ``_warm_clone_cache`` builds, but ``force_refresh`` in place) so
    the frontend poll swaps in fresh data. See services/serve_stale.

    ``force=True`` is the UI's explicit "Retry" after a failed/stalled warm — it
    bypasses the warm cooldown (still live-gated; never opens sign-in)."""
    s = get_settings()
    city = city or s.default_city
    # Function-local import avoids a module-level clone_rate <-> admin cycle.
    from app.routers.admin import _warm_clone_cache, CLONE_WARM_STEPS

    fresh = view_freshness(
        _clone_view_reads(city, lookback_days),
        scope=f"clone_view:{city}:{lookback_days}",
        signal_index=0,
        invalidate_prefixes=_CLONE_VIEW_INVALIDATE,
        warm=lambda report: _warm_clone_cache(city, lookback_days, force_refresh=True, report=report),
        warm_total=CLONE_WARM_STEPS,
        force=force,
    )
    return {"_freshness": fresh}


@router.get("/summary")
def get_clone_summary(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    size_filter: Optional[str] = Query(default="heavy_or_large"),
    weight_tier: Optional[str] = Query(default="all"),
):
    s = get_settings()
    city = city or s.default_city
    ck = _cache_key("clone_summary", city, lookback_days, size_filter or "", weight_tier or "")
    cached = cache.get(ck)
    if cached:
        return cached

    sf = (size_filter or "heavy_or_large").lower()
    wt = (weight_tier or "all").lower()
    rows = read_plain_cached("clone_rate_summary.dataset", {
        "city": city,
        "lookback_days": lookback_days,
    }, cache_by_lookback=True, cache_suffix=f"{sf}_{wt}") or []

    share_daily = read_plain_cached("clone_city_share.dataset", {
        "city": city,
        "lookback_days": lookback_days,
    }, cache_by_lookback=True) or []

    total_orders = sum((r.get("total_orders") or 0) for r in rows)
    total_cloned = sum((r.get("cloned_count") or 0) for r in rows)
    total_heavy = sum((r.get("heavy_count") or 0) for r in rows)
    total_large = sum((r.get("large_count") or 0) for r in rows)
    avg_ttla = (
        sum((r.get("avg_ttla_sec") or 0) * (r.get("total_orders") or 0) for r in rows) / total_orders
        if total_orders > 0 else 0
    )

    result = {
        "daily": rows,
        "share_daily": share_daily,
        "summary": {
            "total_orders": total_orders,
            "heavy_count": total_heavy,
            "large_count": total_large,
            "cloned_count": total_cloned,
            "clone_rate_pct": round(total_cloned / total_orders * 100, 1) if total_orders > 0 else 0,
            "avg_ttla_sec": round(avg_ttla),
            "days": len(rows),
        },
    }
    cache.set(ck, result, s.cache_ttl_seconds)
    return result


@router.get("/acceptance")
def get_clone_acceptance(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    size_filter: Optional[str] = Query(default="heavy_or_large"),
):
    s = get_settings()
    city = city or s.default_city
    ck = _cache_key("clone_acceptance", city, lookback_days, size_filter or "")
    cached = cache.get(ck)
    if cached:
        return cached

    sf = (size_filter or "heavy_or_large").lower()
    rows = read_plain_cached("clone_acceptance_by_weight.dataset", {
        "city": city,
        "lookback_days": lookback_days,
    }, cache_by_lookback=True, cache_suffix=sf) or []

    tier_agg: dict[str, dict] = {}
    for r in rows:
        cg = r.get("capability_group", "Other")
        if cg == "Other":
            continue
        if cg not in tier_agg:
            tier_agg[cg] = {
                "capability_group": cg,
                "total_orders": 0,
                "sum_cloned_pct": 0,
                "sum_acceptance": 0,
                "sum_ttla": 0,
                "n": 0,
            }
        t = tier_agg[cg]
        orders = r.get("order_count") or 0
        t["total_orders"] += orders
        t["sum_cloned_pct"] += (r.get("cloned_pct", 0) or 0) * orders
        t["sum_acceptance"] += (r.get("acceptance_rate", 0) or 0) * orders
        t["sum_ttla"] += (r.get("avg_ttla_sec", 0) or 0) * orders
        t["n"] += orders

    tiers = []
    for cg in ["WEIGHT_L", "WEIGHT_XL", "WEIGHT_XXL", "WEIGHT_XXXL"]:
        t = tier_agg.get(cg)
        if not t or t["n"] == 0:
            tiers.append({
                "capability_group": cg,
                "total_orders": 0,
                "cloned_pct": 0,
                "acceptance_rate": 0,
                "avg_ttla_sec": 0,
                "weight_cost": _weight_costs().get(cg, 0),
            })
            continue
        tiers.append({
            "capability_group": cg,
            "total_orders": t["total_orders"],
            "cloned_pct": round(t["sum_cloned_pct"] / t["n"], 1),
            "acceptance_rate": round(t["sum_acceptance"] / t["n"], 3),
            "avg_ttla_sec": round(t["sum_ttla"] / t["n"]),
            "weight_cost": _weight_costs().get(cg, 0),
        })

    result = {
        "tiers": tiers,
        "daily": rows,
        "weight_costs": _weight_costs(),
    }
    cache.set(ck, result, s.cache_ttl_seconds)
    return result


@router.get("/vehicle-distribution")
def get_vehicle_distribution(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
):
    s = get_settings()
    city = city or s.default_city
    ck = _cache_key("clone_vehicle_dist", city, lookback_days)
    cached = cache.get(ck)
    if cached:
        return cached

    rows = read_plain_cached("clone_vehicle_distribution.dataset", {
        "city": city,
        "lookback_days": lookback_days,
    }) or []

    vt_agg: dict[str, dict] = {}
    for r in rows:
        vt = r.get("vehicle_type", "unknown")
        if vt not in vt_agg:
            vt_agg[vt] = {
                "vehicle_type": vt,
                "total_couriers": 0,
                "total_orders": 0,
                "total_active_hours": 0,
                "courier_sets": set(),
            }
        v = vt_agg[vt]
        v["total_orders"] += r.get("order_count") or 0
        v["total_active_hours"] += r.get("total_active_hours") or 0
        v["courier_sets"].add(r.get("confirmed_date", ""))

    vehicles = []
    total_orders = sum(v["total_orders"] for v in vt_agg.values())
    for vt_data in sorted(vt_agg.values(), key=lambda x: -x["total_orders"]):
        vehicles.append({
            "vehicle_type": vt_data["vehicle_type"],
            "total_orders": vt_data["total_orders"],
            "order_share_pct": round(vt_data["total_orders"] / total_orders * 100, 1) if total_orders > 0 else 0,
            "total_active_hours": round(vt_data["total_active_hours"], 1),
        })

    result = {
        "vehicles": vehicles,
        "daily": rows,
    }
    cache.set(ck, result, s.cache_ttl_seconds)
    return result


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _safe_date(value: Optional[str], fallback: date) -> str:
    """Validate a YYYY-MM-DD string (these are interpolated into DATASET)."""
    if value and _DATE_RE.match(value):
        try:
            datetime.strptime(value, "%Y-%m-%d")
            return value
        except ValueError:
            pass
    return fallback.isoformat()


def _vehicle_filter_clause(vehicle_type: Optional[str]) -> str:
    vt = (vehicle_type or "all").strip()
    if vt.lower() in ("all", ""):
        return ""
    # Only allow safe identifier-like values since this is interpolated.
    # Alias-free so it can be dropped into any query exposing a vehicle_type column.
    if re.match(r"^[A-Za-z0-9_\- ]+$", vt):
        return f"AND vehicle_type = '{vt}'"
    return ""


@router.get("/vehicle-calendar")
def get_vehicle_calendar(
    city: str = Query(default=None),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    vehicle_type: Optional[str] = Query(default="all"),
):
    s = get_settings()
    city = city or s.default_city

    today = date.today()
    d_to = _safe_date(date_to, today - timedelta(days=1))
    d_from = _safe_date(date_from, today - timedelta(days=28))

    ck = _cache_key("clone_vehicle_cal", city, 0, d_from, d_to, vehicle_type or "all")
    cached = cache.get(ck)
    if cached:
        return cached

    vfc = _vehicle_filter_clause(vehicle_type)
    vt_key = re.sub(r"[^A-Za-z0-9]+", "", (vehicle_type or "all")) or "all"
    rows = read_plain_cached("clone_vehicle_calendar.dataset", {
        "city": city,
        "date_from": d_from,
        "date_to": d_to,
    }, cache_suffix=f"{d_from}_{d_to}_{vt_key}") or []

    # Full list of vehicle types in the window (independent of the active
    # filter) so the dropdown stays populated. Reuse rows when unfiltered.
    if vfc == "":
        type_rows = rows
    else:
        type_rows = read_plain_cached("clone_vehicle_calendar.dataset", {
            "city": city,
            "date_from": d_from,
            "date_to": d_to,
        }, cache_suffix=f"{d_from}_{d_to}_all") or []
    vehicle_types = sorted({
        r.get("vehicle_type") for r in type_rows if r.get("vehicle_type")
    })

    result = {
        "rows": rows,
        "vehicle_types": vehicle_types,
        "date_from": d_from,
        "date_to": d_to,
    }
    cache.set(ck, result, s.cache_ttl_seconds)
    return result


@router.get("/orders")
def get_clone_orders(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    size_filter: Optional[str] = Query(default="heavy_or_large"),
    weight_tier: Optional[str] = Query(default="all"),
):
    """Individual cloned orders (purchases with 2+ task groups / a duplicate),
    respecting the active size + weight-tier filters."""
    s = get_settings()
    city = city or s.default_city
    sf = (size_filter or "heavy_or_large").lower()
    wt = (weight_tier or "all").lower()
    ck = _cache_key("clone_orders", city, lookback_days, sf, wt)
    cached = cache.get(ck)
    if cached:
        return cached

    rows = read_plain_cached("clone_orders_list.dataset", {
        "city": city,
        "lookback_days": lookback_days,
    }, cache_by_lookback=True, cache_suffix=f"{sf}_{wt}") or []

    result = {"orders": rows, "count": len(rows)}
    cache.set(ck, result, s.cache_ttl_seconds)
    return result


@router.get("/venues")
def get_clone_venues(
    city: str = Query(default=None),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
):
    """Per-venue contribution of heavy/large orders + cloned counts, for the
    Clone Rate "Top Venues" panel. Returns the full size breakdown (no server-side
    size filter) so the frontend can switch heavy|large / heavy / large instantly.
    Scoped to an explicit [date_from, date_to] window so the panel has its own
    timeline."""
    s = get_settings()
    city = city or s.default_city

    today = date.today()
    d_to = _safe_date(date_to, today - timedelta(days=1))
    d_from = _safe_date(date_from, today - timedelta(days=28))

    ck = _cache_key("clone_venues", city, 0, d_from, d_to)
    cached = cache.get(ck)
    if cached:
        return cached

    rows = read_plain_cached("clone_venue_contribution.dataset", {
        "city": city,
        "date_from": d_from,
        "date_to": d_to,
    }, cache_suffix=f"{d_from}_{d_to}") or []

    result = {"venues": rows, "count": len(rows), "date_from": d_from, "date_to": d_to}
    cache.set(ck, result, s.cache_ttl_seconds)
    return result


@router.get("/orders-calendar")
def get_orders_calendar(
    city: str = Query(default=None),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
):
    """Per day/hour heavy, large, and heavy-or-large order counts for a calendar heatmap."""
    s = get_settings()
    city = city or s.default_city

    today = date.today()
    d_to = _safe_date(date_to, today - timedelta(days=1))
    d_from = _safe_date(date_from, today - timedelta(days=28))

    ck = _cache_key("clone_orders_cal", city, 0, d_from, d_to)
    cached = cache.get(ck)
    if cached:
        return cached

    rows = read_plain_cached("clone_orders_calendar.dataset", {
        "city": city,
        "date_from": d_from,
        "date_to": d_to,
    }, cache_suffix=f"{d_from}_{d_to}") or []

    result = {"rows": rows, "date_from": d_from, "date_to": d_to}
    cache.set(ck, result, s.cache_ttl_seconds)
    return result


@router.get("/courier-positions")
def get_courier_positions(
    city: str = Query(default=None),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    vehicle_type: Optional[str] = Query(default="all"),
):
    """One representative ONLINE location per courier per local hour, for the
    vehicle availability map. Uses the same online-presence source + day gate as
    the availability calendar (not heavy/large order pickups), so dots match the
    calendar. Respects the vehicle-type filter only."""
    s = get_settings()
    city = city or s.default_city

    today = date.today()
    d_to = _safe_date(date_to, today - timedelta(days=1))
    d_from = _safe_date(date_from, today - timedelta(days=28))

    vt_key = re.sub(r"[^A-Za-z0-9]+", "", (vehicle_type or "all")) or "all"
    ck = _cache_key("clone_courier_pos", city, 0, d_from, d_to, vt_key)
    cached = cache.get(ck)
    if cached:
        return cached

    rows = read_plain_cached("clone_courier_positions.dataset", {
        "city": city,
        "date_from": d_from,
        "date_to": d_to,
    }, cache_suffix=f"{d_from}_{d_to}_{vt_key}") or []

    # Full vehicle-type list for the window (unfiltered) so the dropdown stays
    # populated regardless of the active vehicle filter.
    if _vehicle_filter_clause(vehicle_type) == "":
        type_rows = rows
    else:
        type_rows = read_plain_cached("clone_courier_positions.dataset", {
            "city": city,
            "date_from": d_from,
            "date_to": d_to,
        }, cache_suffix=f"{d_from}_{d_to}_all") or []
    vehicle_types = sorted({
        r.get("vehicle_type") for r in type_rows if r.get("vehicle_type")
    })

    result = {
        "rows": rows,
        "vehicle_types": vehicle_types,
        "date_from": d_from,
        "date_to": d_to,
    }
    cache.set(ck, result, s.cache_ttl_seconds)
    return result


@router.get("/order-positions")
def get_order_positions(
    city: str = Query(default=None),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    size_filter: Optional[str] = Query(default="heavy_or_large"),
):
    """Heavy/large orders aggregated by venue location per local hour, for the orders map."""
    s = get_settings()
    city = city or s.default_city

    today = date.today()
    d_to = _safe_date(date_to, today - timedelta(days=1))
    d_from = _safe_date(date_from, today - timedelta(days=28))

    sf = (size_filter or "heavy_or_large").lower()
    ck = _cache_key("clone_order_pos", city, 0, d_from, d_to, sf)
    cached = cache.get(ck)
    if cached:
        return cached

    rows = read_plain_cached("clone_order_positions.dataset", {
        "city": city,
        "date_from": d_from,
        "date_to": d_to,
    }, cache_suffix=f"{d_from}_{d_to}_{sf}") or []

    result = {"rows": rows, "date_from": d_from, "date_to": d_to}
    cache.set(ck, result, s.cache_ttl_seconds)
    return result


@router.get("/vehicle-share")
def get_vehicle_share(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
):
    """Per day, per delivering vehicle type: how many heavy/large/(h|l) orders it
    delivered. The frontend derives the share % and selects size + vehicle."""
    s = get_settings()
    city = city or s.default_city
    ck = _cache_key("clone_vehicle_share", city, lookback_days)
    cached = cache.get(ck)
    if cached:
        return cached

    rows = read_plain_cached("clone_vehicle_share.dataset", {
        "city": city,
        "lookback_days": lookback_days,
    }, cache_by_lookback=True) or []

    vehicle_types = sorted({
        r.get("vehicle_type") for r in rows if r.get("vehicle_type")
    })

    result = {"rows": rows, "vehicle_types": vehicle_types}
    cache.set(ck, result, s.cache_ttl_seconds)
    return result
