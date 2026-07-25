"""Venue TTLA & unassign analysis + map (the "Retail TTLA" overview panel).

A dedicated, cache-backed view over ``synthetic job records`` at venue grain
that answers, for a city (retail-heavy targets: Ridgeport, Harbor Junction), across a
**Restaurant / Retail store** segment toggle:

  1. average TTLA (Task to Last Accept) for the city, EXCLUDING Relay Express,
     scheduled/preorders and time-slot orders (the pure on-demand courier set),
     split by venue product line (Restaurant vs Retail store);
  2. the venues that most WORSEN their SEGMENT's city TTLA, ranked by total
     excess TTLA-seconds ``ttla_impact = order_count * (venue_avg - group_avg)``;
  3. the venues that most drive their segment's courier UNASSIGN rate, with the
     segment benchmark-style additive ``unassign_contribution_pp = 100 * un / group_orders``
     and ``share_of_unassigns`` metrics (see internal unassign spec), the total unassign
     rate + its courier-/ops-initiated breakdown, avg prep + pickup service, and
     coordinates for the map.

PER-GROUP DENOMINATORS (segment benchmark rule): a Restaurant venue's rates/contribution are
measured against the **Restaurant** city totals, Retail against **Retail** — never
a combined denominator — so each toggle view is apples-to-apples.

sign-in-SAFE serve-stale discipline (see services/serve_stale.py): the data
endpoints read ONLY the on-disk plain cache (never query synthetic data source, so a tab open
can't pop the interactive sign-in browser); a separate ``/freshness`` probe reports whether
the cache is behind and — only when a synthetic data source session is already live — kicks
off a background warm of this view. The two backing DATASET files
(``retail_ttla_city_summary.dataset`` + ``retail_ttla_venues.dataset``) are keyed by
city + lookback (``cache_by_lookback=True``) and warmed by admin "Update Data".
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Query

from app.config import (
    get_settings,
    CITY_COUNTRY_MAP,
    CITY_OPERATIONS_AREA_ALIAS,
    ttla_target_sec,
)
from app.services.synthetic_data import read_plain_cached
from app.services.serve_stale import Read, view_freshness
from app.services.cache import cache
from app.services.ttla_filters import (
    date_window_clause,
    norm_order_type,
    order_type_clause,
    order_type_suffix,
    period_suffix,
)

router = APIRouter(prefix="/api/retail-ttla", tags=["retail-ttla"])

# Bump when the response shape (or the in-memory cache key layout) changes so
# entries cached before the change aren't served missing a field.
#   v2 — venue rows: avg prep is now in MINUTES (avg_prep_min, was avg_prep_sec)
#        and impact is also expressed as a PERCENTAGE of the city's total TTLA
#        seconds (impact_pct alongside impact_sec).
#   v3 — BOTH segments (Restaurant + Retail store) now returned with a
#        product_line_category tag + per-group city stats; venue rows add the
#        3-way unassign (total/courier/ops) + segment benchmark unassign_contribution_pp +
#        share_of_unassigns; impact fields renamed ttla_impact_sec/ttla_impact_pct.
#   v4 — driven by the TTLA tab's GLOBAL filters: Order type (Regular=is_drive
#        FALSE [default] / Drive=is_drive TRUE) + Period "complete weeks" / custom
#        range (via the shared date_window_clause), both encoded into the
#        cache_suffix + cache key + freshness scope. (Regular keeps the historical
#        default filenames; Drive gets an `ot-drive` slice.)
#   v5 — venue rows enriched with venue_type (public.venues.product_line:
#        grocery/pharmacy/alcohol/...) + account_manager (resolved name from
#        synthetic partner records.account_manager_name; null when unattached). New
#        response keys ⇒ bump so pre-v5 in-memory entries don't serve rows missing
#        them. (The plain venue disk cache is filename-keyed, so its files are
#        deleted once to re-warm with the new columns.)
#   v6 — venue rows add avg_prep_error_min: the order-weighted mean error (MINUTES,
#        signed) between the venue's INITIAL pickup ETA (its prep-time promise) and
#        the actual ready time (Σ/count of prep_err_sec from retail_ttla_venues.dataset,
#        over on-demand orders). New key + new DATASET columns ⇒ bump + delete the
#        filename-keyed venue disk cache once so it re-warms with the columns.
#   v7 — /venues response adds `country_groups` (country-wide per-segment order_count
#        + ttla_sec_sum + avg, from retail_ttla_country_summary.dataset) so the frontend
#        "selected-venues what-if" can recompute the country segment TTLA. New key.
CACHE_VERSION = "v7"

_SUMMARY_DATASET = "retail_ttla_city_summary.dataset"
_VENUES_DATASET = "retail_ttla_venues.dataset"
_COUNTRY_SUMMARY_DATASET = "retail_ttla_country_summary.dataset"

# The two ranked segments, mapping the UI slug <-> the warehouse
# product_line_category value.
SEGMENTS = {"restaurant": "Restaurant", "retail": "Retail store"}
_CAT_TO_SLUG = {v: k for k, v in SEGMENTS.items()}

# Noise guard: a venue must have at least this many orders in the window to be
# ranked (prevents a 1-2 order venue showing a spurious rate). segment benchmark used 150 over
# a 2-month window; 30 is a gentler floor for our default 28d window.
MIN_VENUE_ORDERS = 30

# Max venues returned PER SEGMENT (ranked by TTLA impact desc). Bounds the payload
# while leaving plenty for the frontend "show all" expander.
MAX_VENUES_PER_GROUP = 150

# In-memory data-cache key prefix; a background warm evicts it so the next poll
# rebuilds from fresh disk.
_INVALIDATE = ["retail_ttla:"]


def _resolve(city: Optional[str]):
    """Map the display city onto the synthetic_jobs country model: derive the ISO
    country and apply the Ridgeport->Ridgeport warehouse alias to the DATASET value."""
    s = get_settings()
    city = city or s.default_city
    country = CITY_COUNTRY_MAP.get(city, "R1")
    wh_city = CITY_OPERATIONS_AREA_ALIAS.get(city, city)
    return city, country, wh_city


def _params(
    country: str,
    wh_city: str,
    lookback_days: int,
    order_type: str = "regular",
    complete_weeks: Optional[int] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
) -> dict:
    """Spine + the two shared global-filter clauses. lookback_days is still passed
    (it keys the on-disk filename base via cache_by_lookback), but the actual
    window is driven by date_window_clause (rolling days / complete weeks /
    custom range)."""
    return {
        "country": country,
        "city": wh_city,
        "lookback_days": lookback_days,
        "date_window_clause": date_window_clause(lookback_days, date_from, date_to, complete_weeks),
        "order_type_clause": order_type_clause(order_type),
    }


def _suffix(order_type: str, complete_weeks: Optional[int], date_from: Optional[str], date_to: Optional[str]) -> Optional[str]:
    """Combined cache suffix for the order type + period (Regular + rolling days
    add nothing, keeping the historical default filenames)."""
    parts = [p for p in (order_type_suffix(order_type), period_suffix(complete_weeks, date_from, date_to)) if p]
    return "_".join(parts) if parts else None


def _summary_read(country, wh_city, lookback_days, order_type="regular", complete_weeks=None, date_from=None, date_to=None) -> Read:
    return Read(
        _SUMMARY_DATASET, _params(country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to),
        cache_by_lookback=True, cache_suffix=_suffix(order_type, complete_weeks, date_from, date_to),
    )


def _venues_read(country, wh_city, lookback_days, order_type="regular", complete_weeks=None, date_from=None, date_to=None) -> Read:
    return Read(
        _VENUES_DATASET, _params(country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to),
        cache_by_lookback=True, cache_suffix=_suffix(order_type, complete_weeks, date_from, date_to),
    )


def _read_summary_rows(country, wh_city, lookback_days, order_type="regular", complete_weeks=None, date_from=None, date_to=None):
    r = _summary_read(country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to)
    return read_plain_cached(_SUMMARY_DATASET, r.params, cache_by_lookback=True, cache_suffix=r.cache_suffix) or []


def _read_venue_rows(country, wh_city, lookback_days, order_type="regular", complete_weeks=None, date_from=None, date_to=None):
    r = _venues_read(country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to)
    return read_plain_cached(_VENUES_DATASET, r.params, cache_by_lookback=True, cache_suffix=r.cache_suffix) or []


def _country_summary_read(country, wh_city, lookback_days, order_type="regular", complete_weeks=None, date_from=None, date_to=None) -> Read:
    return Read(
        _COUNTRY_SUMMARY_DATASET, _params(country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to),
        cache_by_lookback=True, cache_suffix=_suffix(order_type, complete_weeks, date_from, date_to),
    )


def _read_country_summary_rows(country, wh_city, lookback_days, order_type="regular", complete_weeks=None, date_from=None, date_to=None):
    r = _country_summary_read(country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to)
    return read_plain_cached(_COUNTRY_SUMMARY_DATASET, r.params, cache_by_lookback=True, cache_suffix=r.cache_suffix) or []


def _avg(sec_sum, cnt):
    return round(sec_sum / cnt, 1) if cnt and cnt > 0 else None


def _avg_min(sec_sum, cnt):
    """Order-weighted mean converted from seconds to MINUTES (1 decimal)."""
    return round((sec_sum / cnt) / 60, 1) if cnt and cnt > 0 else None


def _rate(num, den):
    """Fraction 0-1 (4 decimals) or None when the denominator is empty."""
    return round(num / den, 4) if den and den > 0 else None


def _group_stats(rows):
    """Fold the per-category summary rows into per-SEGMENT city stats + a combined
    ``city`` (all groups, incl. Other) roll-up. Each segment carries the order
    count, TTLA sum/avg and the three unassign totals (total/courier/ops) +
    order-weighted rates. These are the per-group denominators for the venue
    contribution / share / impact metrics (segment benchmark per-group rule)."""
    groups = {slug: {
        "order_count": 0, "ttla_sec_sum": 0.0,
        "unassigned_count": 0, "unassigned_courier": 0, "unassigned_ops": 0,
    } for slug in SEGMENTS}
    city_sec = city_cnt = 0.0
    city_un = 0
    for r in rows:
        cnt = r.get("order_count") or 0
        sec = r.get("ttla_sec_sum") or 0
        un = r.get("unassigned_count") or 0
        city_sec += sec
        city_cnt += cnt
        city_un += un
        slug = _CAT_TO_SLUG.get(r.get("product_line_category"))
        if slug is None:
            continue
        g = groups[slug]
        g["order_count"] += cnt
        g["ttla_sec_sum"] += sec
        g["unassigned_count"] += un
        g["unassigned_courier"] += r.get("unassigned_courier") or 0
        g["unassigned_ops"] += r.get("unassigned_ops") or 0

    out_groups = {}
    for slug, g in groups.items():
        cnt = g["order_count"]
        out_groups[slug] = {
            "order_count": int(cnt),
            "ttla_sec_sum": round(g["ttla_sec_sum"], 2),
            "avg_ttla_sec": _avg(g["ttla_sec_sum"], cnt),
            "unassigned_count": int(g["unassigned_count"]),
            "unassigned_courier": int(g["unassigned_courier"]),
            "unassigned_ops": int(g["unassigned_ops"]),
            "avg_unassign_rate": _rate(g["unassigned_count"], cnt),
            "avg_unassign_rate_courier": _rate(g["unassigned_courier"], cnt),
            "avg_unassign_rate_ops": _rate(g["unassigned_ops"], cnt),
        }
    city = {
        "city_avg_sec": _avg(city_sec, city_cnt),
        "city_order_count": int(city_cnt),
        "city_unassign_rate": _rate(city_un, city_cnt),
    }
    return city, out_groups


def _country_group_stats(rows):
    """Fold the country-wide per-category summary rows into per-SEGMENT country
    totals (order_count + ttla_sec_sum + order-weighted avg). Same population as the
    city summary, minus the city filter — the country denominators the what-if uses
    to recompute the country segment TTLA when selected city venues are fixed."""
    groups = {slug: {"order_count": 0, "ttla_sec_sum": 0.0} for slug in SEGMENTS}
    for r in rows:
        slug = _CAT_TO_SLUG.get(r.get("product_line_category"))
        if slug is None:
            continue
        g = groups[slug]
        g["order_count"] += r.get("order_count") or 0
        g["ttla_sec_sum"] += r.get("ttla_sec_sum") or 0
    return {
        slug: {
            "order_count": int(g["order_count"]),
            "ttla_sec_sum": round(g["ttla_sec_sum"], 2),
            "avg_ttla_sec": _avg(g["ttla_sec_sum"], g["order_count"]),
        }
        for slug, g in groups.items()
    }


def _summarize(rows):
    """Flat summary (all / restaurant / retail avg TTLA + unassign rate) for the
    KPI strip. Kept flat (not nested) for the summary endpoint / backward compat."""
    city, groups = _group_stats(rows)
    rest = groups["restaurant"]
    retail = groups["retail"]
    return {
        "city_avg_sec": city["city_avg_sec"],
        "city_order_count": city["city_order_count"],
        "city_unassign_rate": city["city_unassign_rate"],
        "restaurant_avg_sec": rest["avg_ttla_sec"],
        "restaurant_order_count": rest["order_count"],
        "restaurant_unassign_rate": rest["avg_unassign_rate"],
        "retail_avg_sec": retail["avg_ttla_sec"],
        "retail_order_count": retail["order_count"],
        "retail_unassign_rate": retail["avg_unassign_rate"],
    }


@router.get("/freshness")
def get_retail_ttla_freshness(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    order_type: str = Query(default="regular"),
    complete_weeks: int = Query(default=None, ge=1, le=53),
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
    force: bool = Query(default=False),
):
    """Serve-stale freshness probe + sign-in-gated background warm for the retail-TTLA
    view (summary + venues), scoped to the current global filter set. Never
    queries on the request path."""
    city, country, wh_city = _resolve(city)
    ot = norm_order_type(order_type)
    reads = [
        _summary_read(country, wh_city, lookback_days, ot, complete_weeks, date_from, date_to),
        _venues_read(country, wh_city, lookback_days, ot, complete_weeks, date_from, date_to),
        _country_summary_read(country, wh_city, lookback_days, ot, complete_weeks, date_from, date_to),
    ]
    scope_sfx = _suffix(ot, complete_weeks, date_from, date_to) or "all"
    fresh = view_freshness(
        reads,
        scope=f"retail_ttla_view:{city}:{lookback_days}:{scope_sfx}",
        signal_index=0,
        invalidate_prefixes=_INVALIDATE,
        force=force,
    )
    return {"_freshness": fresh}


@router.get("/summary")
def get_retail_ttla_summary(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    order_type: str = Query(default="regular"),
    complete_weeks: int = Query(default=None, ge=1, le=53),
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
):
    """City TTLA averages (all / restaurant / retail) for the filtered window.
    Cache-only read; Order type (Regular/Drive) + period come from the TTLA tab's
    global filters. Always excludes preorder / time-slot orders."""
    city, country, wh_city = _resolve(city)
    ot = norm_order_type(order_type)
    ck = f"retail_ttla:summary:{CACHE_VERSION}:{city}:{lookback_days}:{_suffix(ot, complete_weeks, date_from, date_to) or 'all'}"
    cached = cache.get(ck)
    if cached:
        return cached

    rows = _read_summary_rows(country, wh_city, lookback_days, ot, complete_weeks, date_from, date_to)
    result = {
        **_summarize(rows),
        "city": city,
        "country": country,
        "ttla_target_sec": ttla_target_sec(country),
    }
    cache.set(ck, result, get_settings().cache_ttl_seconds)
    return result


@router.get("/venues")
def get_retail_ttla_venues(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    order_type: str = Query(default="regular"),
    complete_weeks: int = Query(default=None, ge=1, le=53),
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
):
    """Per-venue TTLA + unassign table (BOTH segments) for the venue analysis +
    map. Each venue's metrics use its OWN segment's city denominators (segment benchmark
    per-group rule). Cache-only read; Order type (Regular/Drive) + period come
    from the TTLA tab's global filters. Carries coordinates for the map + the
    driver metrics + the per-group city stats for the KPI strip / references."""
    city, country, wh_city = _resolve(city)
    ot = norm_order_type(order_type)
    ck = f"retail_ttla:venues:{CACHE_VERSION}:{city}:{lookback_days}:{_suffix(ot, complete_weeks, date_from, date_to) or 'all'}"
    cached = cache.get(ck)
    if cached:
        return cached

    _city, groups = _group_stats(_read_summary_rows(country, wh_city, lookback_days, ot, complete_weeks, date_from, date_to))

    # Per-segment denominators (order-weighted): the group's avg TTLA (impact
    # baseline), total TTLA-seconds (impact_pct denominator) and total orders +
    # unassigns (contribution / share denominators).
    def _group_refs(slug):
        g = groups.get(slug) or {}
        cnt = g.get("order_count") or 0
        avg = g.get("avg_ttla_sec")
        ttla_sum = g.get("ttla_sec_sum") or 0
        un = g.get("unassigned_count") or 0
        return cnt, avg, ttla_sum, un

    by_group: dict[str, list] = {slug: [] for slug in SEGMENTS}
    for r in _read_venue_rows(country, wh_city, lookback_days, ot, complete_weeks, date_from, date_to):
        cnt = r.get("order_count") or 0
        if cnt < MIN_VENUE_ORDERS:
            continue
        slug = _CAT_TO_SLUG.get(r.get("product_line_category"))
        if slug is None:
            continue
        g_cnt, g_avg, g_ttla_sum, g_un = _group_refs(slug)
        sec_sum = r.get("ttla_sec_sum") or 0
        avg_ttla = sec_sum / cnt
        un_total = r.get("unassigned_count") or 0
        un_courier = r.get("unassigned_courier") or 0
        un_ops = r.get("unassigned_ops") or 0
        prep_cnt = r.get("prep_count") or 0
        pickup_cnt = r.get("pickup_count") or 0
        prep_err_cnt = r.get("prep_err_count") or 0
        # TTLA: excess seconds this venue adds vs its GROUP average, and that as a
        # % of the group's total TTLA-seconds.
        ttla_impact = cnt * (avg_ttla - g_avg) if g_avg is not None else None
        ttla_impact_pct = (
            round(ttla_impact / g_ttla_sum * 100, 3)
            if (ttla_impact is not None and g_ttla_sum)
            else None
        )
        # Unassign (segment benchmark additive): the venue's contribution to the group's
        # unassign rate in percentage POINTS (Σ over venues == group rate), and its
        # share of the group's unassigns.
        contribution_pp = round(100 * un_total / g_cnt, 4) if g_cnt else None
        share = _rate(un_total, g_un)
        by_group[slug].append({
            "product_line_category": r.get("product_line_category"),
            "segment": slug,
            "venue_name": r.get("venue_name"),
            "venue_id": r.get("venue_id"),
            "venue_lat": r.get("venue_lat"),
            "venue_long": r.get("venue_long"),
            # Venue sub-type (product_line: grocery/pharmacy/alcohol/...) + attached
            # account manager (resolved name), blank when the venue has none.
            "venue_type": (r.get("venue_type") or None),
            "account_manager": (r.get("account_manager") or None),
            "order_count": cnt,
            "avg_ttla_sec": round(avg_ttla, 1),
            "ttla_impact_sec": round(ttla_impact, 1) if ttla_impact is not None else None,
            "ttla_impact_pct": ttla_impact_pct,
            "unassign_rate": _rate(un_total, cnt),
            "unassign_rate_courier": _rate(un_courier, cnt),
            "unassign_rate_ops": _rate(un_ops, cnt),
            "unassign_contribution_pp": contribution_pp,
            "share_of_unassigns": share,
            "avg_prep_min": _avg_min(r.get("prep_sec_sum") or 0, prep_cnt),
            "avg_pickup_service_sec": _avg(r.get("pickup_sec_sum") or 0, pickup_cnt),
            # Order-weighted mean prep-estimate error in MINUTES (signed): + = venue
            # ready later than its initial pickup ETA promised, − = ready early.
            "avg_prep_error_min": _avg_min(r.get("prep_err_sec_sum") or 0, prep_err_cnt),
        })

    # Rank each segment by the biggest positive drag on ITS group average first,
    # cap per group, then combine (frontend filters to the toggled segment).
    venues = []
    counts = {}
    for slug, rows in by_group.items():
        rows.sort(key=lambda v: (v["ttla_impact_sec"] if v["ttla_impact_sec"] is not None else float("-inf")), reverse=True)
        counts[slug] = len(rows)
        venues.extend(rows[:MAX_VENUES_PER_GROUP])

    country_groups = _country_group_stats(
        _read_country_summary_rows(country, wh_city, lookback_days, ot, complete_weeks, date_from, date_to)
    )

    result = {
        "venues": venues,
        "groups": groups,
        "country_groups": country_groups,
        "total_by_segment": counts,
        "min_venue_orders": MIN_VENUE_ORDERS,
        "city": city,
        "country": country,
        "ttla_target_sec": ttla_target_sec(country),
    }
    cache.set(ck, result, get_settings().cache_ttl_seconds)
    return result
