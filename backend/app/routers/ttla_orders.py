from __future__ import annotations

import hashlib
from typing import List, Optional

from fastapi import APIRouter, Query

from app.config import (
    get_settings,
    CITY_COUNTRY_MAP,
    CITY_OPERATIONS_AREA_ALIAS,
    CITY_OPERATIONS_AREA_ALIAS_REVERSE,
    COUNTRY_NAMES,
    ttla_target_sec,
)
from app.services.synthetic_data import read_plain_cached
from app.services.serve_stale import Read, view_freshness
from app.services.cache import cache
from app.services.ttla_filters import (
    date_window_clause,
    norm_order_type,
    norm_ttla_mode,
    order_type_clause,
    order_type_suffix,
    period_suffix,
    ttla_mode_fragments,
    ttla_mode_suffix,
    ttla_tab_population_clause,
    TTLA_MODE_DEFAULT,
)

router = APIRouter(prefix="/api/ttla", tags=["ttla"])

# Bump when the response shape (or the in-memory cache key layout) changes so
# entries cached before the change aren't served missing a field.
#   v2 — freshness/warm split into three independent per-view scopes.
#   v3 — per-panel FILTERS (Phase 2): venue type (Restaurant/Retail) + retail
#        venue picker, date range (custom from/to), min-TTLA threshold, and
#        courier vehicle type. Each filter dimension is encoded into the
#        cache_suffix (so combos never collide on one file) and into the
#        in-memory data-cache key below. Orders/Venues rows gain `product_line`.
#   v4 — Phase 3 drill-downs: the Orders view can be restricted to a single
#        venue (`venue_id`) or courier (`courier_id`) so the Venues/Couriers
#        panels' order-count popovers list that entity's orders. Encoded in the
#        cache_suffix + key (`dv-`/`dc-`).
#   v5 — venue-type filter + Venues "Type" now use the authoritative
#        synthetic_jobs.product_line_category ('Restaurant'/'Retail store'/'Other'),
#        dropping the public.venues.product_line join+heuristic. Orders/Venues
#        rows now carry product_line_category (was product_line).
#   v6 — GLOBAL TTLA-tab filters: Order type (Regular=is_drive FALSE [default] /
#        Drive=is_drive TRUE) + Period "complete weeks" (last N complete ISO
#        weeks). Both are encoded into the cache_suffix (drive => `ot-drive`,
#        weeks => `wN`) and the freshness scope. NOTE: `regular` now EXCLUDES
#        Drive, whereas <=v5 mixed Drive+Regular (delivery_provider_type='relay'
#        with no is_drive filter) — the default population changed, so the old
#        default-warmed disk files must be re-warmed.
#   v7 — Orders view can be restricted to a SET of inspected venue ids
#        (`inspect_venue_ids`, from the Venue TTLA panel's checkbox selection) via
#        the new `{inspect_venue_clause}`; encoded in the cache_suffix (`iv-<hash>`)
#        + freshness scope. Distinct from the retail-picker `retail_venue_ids`.
#   v8 — Orders rows add prep_error_min: signed minutes between the venue's INITIAL
#        pickup ETA (its prep-time promise, synthetic job records.pickup_eta_log[0]) and
#        the actual ready time (time_ready). New response key ⇒ bump.
#   v9 — Orders rows add delivery_count (from synthetic_jobs.deliveries_count) so the
#        Orders panel can flag cloned orders (>1 delivery). New response key ⇒
#        bump. ALSO adds the MASTER "delivery counts" multi-select filter
#        (delivery_counts query param — comma-separated ints, e.g. "2,3,4" or
#        "1,5" — → {delivery_counts_clause} = `AND fp.deliveries_count IN (...)`)
#        applied to ALL FOUR views (orders/venues/couriers/country-context) so the
#        whole tab recalculates on the same subset; encoded in the cache_suffix as
#        `dc<v1>-<v2>-...` (so filtered tabs never collide with the default/
#        unfiltered cache file or any other subset). Empty/None = no filter. No
#        response-shape change for the filter itself (the suffix isolates it), so
#        v9 covers both.
#   v10 — GLOBAL TTLA-calculation-logic filter (ttla_mode query param — default |
#         first_courier | fixed). The mode swaps the per-order TTLA expression:
#         default = synthetic_jobs.time_to_last_accept_sec (unchanged); the other two
#         derive it from synthetic assignment records via a {tg_per_purchase}
#         helper CTE (1st-courier = original task group's TIME_TO_LAST_ACCEPT;
#         fixed = AVG over all the order's task groups). Applied to ALL FOUR views
#         + /freshness; encoded in the cache_suffix as `tm-first` / `tm-fixed`
#         (default adds nothing, so the default-mode cache files stay identical
#         to v9 — no forced re-warm). The 4 ttla_*.dataset files now carry
#         {ttla_cte_inner|outer} / {ttla_join} / {ttla_expr} / {ttla_not_null}
#         placeholders (default-mode resolution == today's DATASET). No response-shape
#         change (the suffix isolates modes), so v10 is a documentation bump.
CACHE_VERSION = "v10"

# Orders is an INSPECTION list of the slowest-to-accept orders, not the full set
# (a single city over 28d can hold tens of thousands of orders). We cap it at the
# worst-N by TTLA. Not user-configurable, so it isn't part of the cache key.
TTLA_ORDERS_ROW_LIMIT = 1000

# Size filter (shared Late-Orders "size" control) applied to ALL three TTLA views
# via the pre-aggregated fcd heavy/large flags (see the DATASET files). Encoded in the
# cache_suffix so different sizes never collide on one file.
_TTLA_SIZE_FILTER_DATASET = {
    "all": "",
    "heavy": "AND COALESCE(fa.is_heavy, 0) = 1",
    "large": "AND COALESCE(fa.is_large, 0) = 1",
    "heavy_or_large": "AND (COALESCE(fa.is_heavy, 0) = 1 OR COALESCE(fa.is_large, 0) = 1)",
    "normal": "AND COALESCE(fa.is_heavy, 0) = 0 AND COALESCE(fa.is_large, 0) = 0",
}

# The DATASET file backing each stacked panel / view.
_VIEW_DATASET = {
    "orders": "ttla_orders.dataset",
    "venues": "ttla_venues.dataset",
    "couriers": "ttla_couriers.dataset",
    # Country TTLA context panel (country-wide per-city TTLA inputs). Uses the
    # same clause placeholders as the others (extra ones are ignored by the DATASET).
    "context": "ttla_country_context.dataset",
}

# In-memory data-cache key prefix per view; a view's background warm only evicts
# ITS OWN cache (the panels are independently served-stale now).
_VIEW_INVALIDATE = {
    "orders": ["ttla_orders:"],
    "venues": ["ttla_venues:"],
    "couriers": ["ttla_couriers:"],
    "context": ["ttla_context:"],
}

_VENUE_TYPES = {"all", "restaurant", "retail"}


# --- DATASET clause builders -----------------------------------------------------
# Every TTLA DATASET file references the same set of clause placeholders; we always
# pass the full set (str.format ignores keys a given file doesn't use) so the
# shared files format without KeyError from any caller (endpoints + admin warm).

def _sql_str(v) -> str:
    """Escape a single-quoted DATASET literal (values come from server-mapped enums /
    numeric inputs, but be defensive)."""
    return str(v).replace("'", "''")


def _date_window_clause(
    lookback_days: int,
    date_from: Optional[str],
    date_to: Optional[str],
    complete_weeks: Optional[int] = None,
) -> str:
    """The confirmed-UTC window (shared with retail_ttla). Precedence: custom
    [from, to] range > last N complete ISO weeks > rolling lookback; all exclude
    the current partial day."""
    return date_window_clause(lookback_days, date_from, date_to, complete_weeks)


def _venue_type_clause(venue_type: str) -> str:
    """Restaurant vs Retail via the authoritative synthetic job records
    segment column product_line_category ('Restaurant' / 'Retail store' /
    'Other'). This is the same column the Retail-TTLA tab uses, so no
    public.venues join or product_line heuristic is needed."""
    if venue_type == "restaurant":
        return "AND fp.product_line_category = 'Restaurant'"
    if venue_type == "retail":
        return "AND fp.product_line_category = 'Retail store'"
    return ""


def _retail_venue_clause(venue_ids: Optional[List[str]]) -> str:
    ids = [str(v) for v in (venue_ids or []) if v not in (None, "")]
    if not ids:
        return ""
    quoted = ", ".join(f"'{_sql_str(v)}'" for v in ids)
    return f"AND ap.venue_id IN ({quoted})"


def _min_ttla_order_clause(min_ttla: Optional[float], ttla_expr: str) -> str:
    """Orders view: keep only orders whose (mode-derived) TTLA >= threshold. The
    expression is the per-order ttla value for the active mode (default =
    fp.time_to_last_accept_sec; first/fixed = the tg_per_purchase-derived value),
    so the threshold always applies to the SAME value the panel ranks by."""
    if min_ttla is None:
        return ""
    return f"AND {ttla_expr} >= {float(min_ttla)}"


def _delivery_counts_clause(delivery_counts: Optional[List[int]]) -> str:
    """Master filter: keep only purchases whose courier-delivery count
    (synthetic_jobs.deliveries_count) is one of the selected values. Lets the user
    pick specific multiplicities (e.g. only 2,3,4 — or just 1,5 — or 2,4). Applied
    to ALL TTLA views (orders / venues / couriers / country-context) so the whole
    tab recalculates on the same subset. Empty/None = no filter (the default, so
    the unfiltered cache files stay shared with the warm)."""
    if not delivery_counts:
        return ""
    vals = sorted({int(v) for v in delivery_counts if v and int(v) > 0})
    if not vals:
        return ""
    return f"AND fp.deliveries_count IN ({', '.join(map(str, vals))})"


def _parse_int_ids(s: Optional[str]) -> Optional[List[int]]:
    """Comma-separated positive-int list from the query string -> list (e.g.
    "2,3,4"). None / empty / non-numeric -> None (= no filter)."""
    if not s:
        return None
    out: List[int] = []
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            v = int(part)
        except ValueError:
            continue
        if v > 0:
            out.append(v)
    return out or None


def _min_ttla_having(min_ttla: Optional[float]) -> str:
    """Venues view: keep venues whose ORDER-WEIGHTED avg TTLA is >= threshold."""
    if min_ttla is None:
        return ""
    return f"HAVING SUM(ttla_sec) / NULLIF(COUNT(*), 0) >= {float(min_ttla)}"


def _vehicle_type_clause(vehicle_type: Optional[str]) -> str:
    """Couriers view: restrict to purchases the completing courier did on the
    selected vehicle (case-insensitive; source values undocumented)."""
    if not vehicle_type or vehicle_type == "all":
        return ""
    return f"AND LOWER(fa.vehicle_type) = LOWER('{_sql_str(vehicle_type)}')"


def _drill_clause(venue_id: Optional[str], courier_id: Optional[str]) -> str:
    """Orders view only: restrict to a single venue OR courier for the
    Venues/Couriers order-count drill-down popovers (courier takes precedence)."""
    if courier_id:
        return f"AND fa.courier_id = '{_sql_str(courier_id)}'"
    if venue_id:
        return f"AND ap.venue_id = '{_sql_str(venue_id)}'"
    return ""


def _inspect_venue_clause(venue_ids: Optional[List[str]]) -> str:
    """Orders view only: restrict the inspection list to a SET of venue ids the
    user checked in the Venue TTLA panel (`AND ap.venue_id IN (...)`), so the
    Orders panel shows the worst-TTLA orders from just those venues. Distinct from
    ``retail_venue_clause`` (the filter-bar retail picker) so the two selections
    never collide."""
    ids = [str(v) for v in (venue_ids or []) if v not in (None, "")]
    if not ids:
        return ""
    quoted = ", ".join(f"'{_sql_str(v)}'" for v in ids)
    return f"AND ap.venue_id IN ({quoted})"


def default_clause_params(lookback_days: int, order_type: str = "regular") -> dict:
    """All DATASET clause placeholders for the DEFAULT (size-unfiltered) TTLA view for
    a given order type. Used by the admin warm so the shared DATASET formats without
    KeyError. The endpoints build the filtered variants below."""
    # Default TTLA-calculation mode (synthetic_jobs.time_to_last_accept_sec, no
    # tg_per_purchase CTE/join) so the admin warm writes the same default-mode
    # files the endpoints read when ttla_mode is unset/default. The
    # population_clause is irrelevant in default mode (no CTE) so an empty
    # placeholder is fine here.
    mode_frags = ttla_mode_fragments(TTLA_MODE_DEFAULT, "", None, "")
    return {
        "date_window_clause": _date_window_clause(lookback_days, None, None),
        "order_type_clause": order_type_clause(order_type),
        "size_filter_clause": "",
        "venue_type_clause": "",
        "retail_venue_clause": "",
        "min_ttla_clause": "",
        "min_ttla_having": "",
        "vehicle_type_clause": "",
        "drill_clause": "",
        "inspect_venue_clause": "",
        "delivery_counts_clause": "",
        "ttla_cte_inner": mode_frags["ttla_cte_inner"],
        "ttla_cte_outer": mode_frags["ttla_cte_outer"],
        "ttla_join": mode_frags["ttla_join"],
        "ttla_expr": mode_frags["ttla_expr"],
        "ttla_not_null": mode_frags["ttla_not_null"],
    }


def _cache_suffix(
    sf: str,
    venue_type: str,
    retail_ids: Optional[List[str]],
    min_ttla: Optional[float],
    vehicle_type: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
    venue_id: Optional[str] = None,
    courier_id: Optional[str] = None,
    order_type: str = "regular",
    complete_weeks: Optional[int] = None,
    inspect_ids: Optional[List[str]] = None,
    delivery_counts: Optional[List[int]] = None,
    ttla_mode: Optional[str] = None,
) -> Optional[str]:
    """Encode every filter dimension into the on-disk cache suffix so distinct
    filter combinations never collide on one cached file (the file base already
    carries city + lookback via cache_by_lookback). Regular order type + rolling
    days add NOTHING (they keep the historical default filenames)."""
    parts: List[str] = []
    ot_sfx = order_type_suffix(order_type)
    if ot_sfx:
        parts.append(ot_sfx)
    wk_sfx = period_suffix(complete_weeks, None, None)
    if wk_sfx:
        parts.append(wk_sfx)
    if sf and sf != "all":
        parts.append(sf)
    if venue_type and venue_type != "all":
        parts.append(f"vt-{venue_type}")
    ids = [str(v) for v in (retail_ids or []) if v not in (None, "")]
    if ids:
        h = hashlib.sha1("|".join(sorted(ids)).encode()).hexdigest()[:8]
        parts.append(f"rv-{h}")
    if min_ttla is not None:
        parts.append(f"mt{int(float(min_ttla))}")
    if vehicle_type and vehicle_type != "all":
        parts.append(f"veh-{str(vehicle_type).lower()}")
    if date_from and date_to:
        parts.append(f"d{date_from}_{date_to}")
    # Drill-down (Orders view): a single-venue / single-courier slice.
    if courier_id:
        parts.append(f"dc-{hashlib.sha1(str(courier_id).encode()).hexdigest()[:10]}")
    elif venue_id:
        parts.append(f"dv-{hashlib.sha1(str(venue_id).encode()).hexdigest()[:10]}")
    # Inspect (Orders view): the checked venue-set from the Venue TTLA panel.
    inspect = [str(v) for v in (inspect_ids or []) if v not in (None, "")]
    if inspect:
        h = hashlib.sha1("|".join(sorted(inspect)).encode()).hexdigest()[:10]
        parts.append(f"iv-{h}")
    # Master deliveries-count multi-select (specific values, e.g. [2,3,4] or [1,5]).
    # Encoded as `dc` + sorted values joined by `-` so a filtered tab never
    # collides with the unfiltered (default) cache file or any other subset.
    if delivery_counts:
        vals = sorted({int(v) for v in delivery_counts if v and int(v) > 0})
        if vals:
            parts.append("dc" + "-".join(map(str, vals)))
    # TTLA calculation-logic mode (default | first_courier | fixed). Default adds
    # nothing (keeps the historical default filenames); the other modes get their
    # own `tm-first` / `tm-fixed` slice so a mode never collides with the default
    # cache file or the other mode.
    mode_sfx = ttla_mode_suffix(ttla_mode)
    if mode_sfx:
        parts.append(mode_sfx)
    return "_".join(parts) if parts else None


def _resolve(city: Optional[str], size_filter: str):
    """Map the shared Late-Orders filters onto the synthetic_jobs country model:
    derive the ISO country from the display city, apply the Ridgeport->Ridgeport
    warehouse alias to the DATASET city value, and normalize the size filter."""
    s = get_settings()
    city = city or s.default_city
    country = CITY_COUNTRY_MAP.get(city, "R1")
    wh_city = CITY_OPERATIONS_AREA_ALIAS.get(city, city)
    sf = size_filter if size_filter in _TTLA_SIZE_FILTER_DATASET else "all"
    return city, country, wh_city, sf


def _norm_venue_type(vt: Optional[str]) -> str:
    return vt if vt in _VENUE_TYPES else "all"


def _build_params(
    view: str,
    country: str,
    wh_city: str,
    lookback_days: int,
    sf: str,
    venue_type: str,
    retail_ids: Optional[List[str]],
    min_ttla: Optional[float],
    vehicle_type: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
    venue_id: Optional[str] = None,
    courier_id: Optional[str] = None,
    order_type: str = "regular",
    complete_weeks: Optional[int] = None,
    inspect_ids: Optional[List[str]] = None,
    delivery_counts: Optional[List[int]] = None,
    ttla_mode: Optional[str] = None,
) -> dict:
    """Full DATASET param set (spine + every clause placeholder) for a filtered TTLA
    view. Extra keys a given DATASET file doesn't reference are harmlessly ignored."""
    dw_clause = _date_window_clause(lookback_days, date_from, date_to, complete_weeks)
    ot_clause = order_type_clause(order_type)
    # TTLA-calculation-mode fragments. The country-context view groups across the
    # WHOLE country (no city filter), so its helper CTE is country-scoped
    # (city=None); the city panels scope the CTE to the one operations area
    # (wh_city) to cut the task-group aggregation. The CTE's synthetic_jobs
    # semi-join is scoped to the SAME population the outer query filters on
    # (status+provider+order_type+date_window) so the aggregation never drifts.
    mode_frags = ttla_mode_fragments(
        ttla_mode,
        country,
        None if view == "context" else wh_city,
        ttla_tab_population_clause(dw_clause, ot_clause),
    )
    params = {
        "country": country,
        "city": wh_city,
        "lookback_days": lookback_days,
        "date_window_clause": dw_clause,
        "order_type_clause": ot_clause,
        "size_filter_clause": _TTLA_SIZE_FILTER_DATASET[sf],
        "venue_type_clause": _venue_type_clause(venue_type),
        "retail_venue_clause": _retail_venue_clause(retail_ids),
        "min_ttla_clause": _min_ttla_order_clause(min_ttla, mode_frags["ttla_expr"]),
        "min_ttla_having": _min_ttla_having(min_ttla),
        "vehicle_type_clause": _vehicle_type_clause(vehicle_type),
        "drill_clause": _drill_clause(venue_id, courier_id),
        "inspect_venue_clause": _inspect_venue_clause(inspect_ids),
        "delivery_counts_clause": _delivery_counts_clause(delivery_counts),
        "ttla_cte_inner": mode_frags["ttla_cte_inner"],
        "ttla_cte_outer": mode_frags["ttla_cte_outer"],
        "ttla_join": mode_frags["ttla_join"],
        "ttla_expr": mode_frags["ttla_expr"],
        "ttla_not_null": mode_frags["ttla_not_null"],
    }
    if view == "orders":
        params["row_limit"] = TTLA_ORDERS_ROW_LIMIT
    return params


def _view_read(
    view: str,
    country: str,
    wh_city: str,
    lookback_days: int,
    sf: str,
    venue_type: str,
    retail_ids: Optional[List[str]],
    min_ttla: Optional[float],
    vehicle_type: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
    venue_id: Optional[str] = None,
    courier_id: Optional[str] = None,
    order_type: str = "regular",
    complete_weeks: Optional[int] = None,
    inspect_ids: Optional[List[str]] = None,
    delivery_counts: Optional[List[int]] = None,
    ttla_mode: Optional[str] = None,
) -> Read:
    """The single plain-cache query backing ONE TTLA panel/view for a given filter
    set. The default warm runs this DATASET (with all clauses) and writes the file
    keyed by city + lookback + suffix; the data endpoint reads the same key, so
    warm and read never drift."""
    params = _build_params(
        view, country, wh_city, lookback_days, sf, venue_type, retail_ids,
        min_ttla, vehicle_type, date_from, date_to, venue_id, courier_id,
        order_type, complete_weeks, inspect_ids, delivery_counts, ttla_mode,
    )
    suffix = _cache_suffix(
        sf, venue_type, retail_ids, min_ttla, vehicle_type, date_from, date_to,
        venue_id, courier_id, order_type, complete_weeks, inspect_ids, delivery_counts,
        ttla_mode,
    )
    return Read(_VIEW_DATASET[view], params, cache_by_lookback=True, cache_suffix=suffix)


def _parse_ids(retail_venue_ids: Optional[str]) -> Optional[List[str]]:
    """Comma-separated venue-id list from the query string -> list."""
    if not retail_venue_ids:
        return None
    return [p for p in (x.strip() for x in retail_venue_ids.split(",")) if p]


@router.get("/freshness")
def get_ttla_freshness(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    size_filter: str = Query(default="all"),
    venue_type: str = Query(default="all"),
    retail_venue_ids: str = Query(default=None),
    min_ttla: float = Query(default=None, ge=0),
    vehicle_type: str = Query(default=None),
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
    venue_id: str = Query(default=None),
    courier_id: str = Query(default=None),
    order_type: str = Query(default="regular"),
    complete_weeks: int = Query(default=None, ge=1, le=53),
    inspect_venue_ids: str = Query(default=None),
    delivery_counts: str = Query(default=None),
    ttla_mode: str = Query(default="default"),
    view: str = Query(default="orders"),
    force: bool = Query(default=False),
):
    """Serve-stale freshness probe + sign-in-gated background warm for ONE TTLA panel
    (``view`` = orders | venues | couriers), scoped to the panel's CURRENT filter
    set so only the viewed slice warms. Never queries on the request path. The
    ``venue_id``/``courier_id`` drill scope (Orders view only) warms + serves the
    single-entity order slice behind the order-count popovers; ``inspect_venue_ids``
    (Orders view only) warms the checked venue-set slice."""
    v = view if view in _VIEW_DATASET else "orders"
    vt = _norm_venue_type(venue_type)
    ot = norm_order_type(order_type)
    tm = norm_ttla_mode(ttla_mode)
    retail_ids = _parse_ids(retail_venue_ids)
    inspect_ids = _parse_ids(inspect_venue_ids)
    dc_ids = _parse_int_ids(delivery_counts)
    city, country, wh_city, sf = _resolve(city, size_filter)
    read = _view_read(v, country, wh_city, lookback_days, sf, vt, retail_ids, min_ttla, vehicle_type, date_from, date_to, venue_id, courier_id, ot, complete_weeks, inspect_ids, dc_ids, tm)
    suffix = read.cache_suffix or "all"
    fresh = view_freshness(
        [read],
        scope=f"ttla_{v}_view:{city}:{lookback_days}:{suffix}",
        signal_index=0,
        invalidate_prefixes=_VIEW_INVALIDATE[v],
        force=force,
    )
    return {"_freshness": fresh}


def _read_rows(view: str, country: str, wh_city: str, lookback_days: int, sf: str,
               venue_type: str, retail_ids, min_ttla, vehicle_type, date_from, date_to,
               venue_id=None, courier_id=None, order_type="regular", complete_weeks=None,
               inspect_ids=None, delivery_counts=None, ttla_mode=None):
    read = _view_read(view, country, wh_city, lookback_days, sf, venue_type, retail_ids, min_ttla, vehicle_type, date_from, date_to, venue_id, courier_id, order_type, complete_weeks, inspect_ids, delivery_counts, ttla_mode)
    return read_plain_cached(
        _VIEW_DATASET[view], read.params,
        cache_by_lookback=True, cache_suffix=read.cache_suffix,
    ) or []


def _ckey(view: str, city: str, lookback_days: int, suffix: str) -> str:
    return f"ttla_{view}:{CACHE_VERSION}:{city}:{lookback_days}:{suffix}"


@router.get("")
def get_ttla_orders(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    size_filter: str = Query(default="all"),
    venue_type: str = Query(default="all"),
    retail_venue_ids: str = Query(default=None),
    min_ttla: float = Query(default=None, ge=0),
    vehicle_type: str = Query(default=None),
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
    venue_id: str = Query(default=None),
    courier_id: str = Query(default=None),
    order_type: str = Query(default="regular"),
    complete_weeks: int = Query(default=None, ge=1, le=53),
    inspect_venue_ids: str = Query(default=None),
    delivery_counts: str = Query(default=None),
    ttla_mode: str = Query(default="default"),
):
    """Worst-N (by TTLA) per-order rows for the current filtered view. Cache-only.
    ``venue_id``/``courier_id`` restrict to a single venue/courier for the
    Venues/Couriers order-count drill-down popovers; ``inspect_venue_ids``
    restricts to the venue-set checked in the Venue TTLA panel."""
    vt = _norm_venue_type(venue_type)
    ot = norm_order_type(order_type)
    tm = norm_ttla_mode(ttla_mode)
    retail_ids = _parse_ids(retail_venue_ids)
    inspect_ids = _parse_ids(inspect_venue_ids)
    dc_ids = _parse_int_ids(delivery_counts)
    city, country, wh_city, sf = _resolve(city, size_filter)
    suffix = _cache_suffix(sf, vt, retail_ids, min_ttla, vehicle_type, date_from, date_to, venue_id, courier_id, ot, complete_weeks, inspect_ids, dc_ids, tm) or "all"
    ck = _ckey("orders", city, lookback_days, suffix)
    cached = cache.get(ck)
    if cached:
        return cached

    rows = _read_rows("orders", country, wh_city, lookback_days, sf, vt, retail_ids, min_ttla, vehicle_type, date_from, date_to, venue_id, courier_id, ot, complete_weeks, inspect_ids, dc_ids, tm)

    # The warehouse stores Ridgeport as "Ridgeport"; show the UI display name back.
    for r in rows:
        r["city"] = CITY_OPERATIONS_AREA_ALIAS_REVERSE.get(r.get("city"), r.get("city"))

    result = {
        "orders": rows,
        "total": len(rows),
        "row_limit": TTLA_ORDERS_ROW_LIMIT,
        "country": country,
        "ttla_target_sec": ttla_target_sec(country),
    }
    cache.set(ck, result, get_settings().cache_ttl_seconds)
    return result


@router.get("/venues")
def get_ttla_venues(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    size_filter: str = Query(default="all"),
    venue_type: str = Query(default="all"),
    retail_venue_ids: str = Query(default=None),
    min_ttla: float = Query(default=None, ge=0),
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
    order_type: str = Query(default="regular"),
    complete_weeks: int = Query(default=None, ge=1, le=53),
    delivery_counts: str = Query(default=None),
    ttla_mode: str = Query(default="default"),
):
    """Per-venue order count + order-weighted avg TTLA for the filtered view.
    Cache-only read. Also carries ``product_line_category`` (the authoritative
    Restaurant / Retail store / Other segment) for display."""
    vt = _norm_venue_type(venue_type)
    ot = norm_order_type(order_type)
    tm = norm_ttla_mode(ttla_mode)
    retail_ids = _parse_ids(retail_venue_ids)
    city, country, wh_city, sf = _resolve(city, size_filter)
    dc_ids = _parse_int_ids(delivery_counts)
    suffix = _cache_suffix(sf, vt, retail_ids, min_ttla, None, date_from, date_to, None, None, ot, complete_weeks, None, dc_ids, tm) or "all"
    ck = _ckey("venues", city, lookback_days, suffix)
    cached = cache.get(ck)
    if cached:
        return cached

    rows = _read_rows("venues", country, wh_city, lookback_days, sf, vt, retail_ids, min_ttla, None, date_from, date_to, None, None, ot, complete_weeks, None, dc_ids, tm)

    venues = []
    for r in rows:
        cnt = r.get("order_count") or 0
        sec_sum = r.get("ttla_sec_sum") or 0
        venues.append({
            "venue_name": r.get("venue_name"),
            "venue_id": r.get("venue_id"),
            "product_line_category": r.get("product_line_category"),
            "order_count": cnt,
            "ttla_sec_sum": sec_sum,
            "avg_ttla_sec": round(sec_sum / cnt, 1) if cnt > 0 else None,
        })
    venues.sort(key=lambda x: x["order_count"], reverse=True)

    result = {
        "venues": venues,
        "total": len(venues),
        "country": country,
        "ttla_target_sec": ttla_target_sec(country),
    }
    cache.set(ck, result, get_settings().cache_ttl_seconds)
    return result


@router.get("/couriers")
def get_ttla_couriers(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    size_filter: str = Query(default="all"),
    venue_type: str = Query(default="all"),
    retail_venue_ids: str = Query(default=None),
    vehicle_type: str = Query(default=None),
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
    order_type: str = Query(default="regular"),
    complete_weeks: int = Query(default=None, ge=1, le=53),
    delivery_counts: str = Query(default=None),
    ttla_mode: str = Query(default="default"),
):
    """Per-courier order count + order-weighted avg TTLA for the filtered view.
    Cache-only read."""
    vt = _norm_venue_type(venue_type)
    ot = norm_order_type(order_type)
    tm = norm_ttla_mode(ttla_mode)
    retail_ids = _parse_ids(retail_venue_ids)
    city, country, wh_city, sf = _resolve(city, size_filter)
    dc_ids = _parse_int_ids(delivery_counts)
    suffix = _cache_suffix(sf, vt, retail_ids, None, vehicle_type, date_from, date_to, None, None, ot, complete_weeks, None, dc_ids, tm) or "all"
    ck = _ckey("couriers", city, lookback_days, suffix)
    cached = cache.get(ck)
    if cached:
        return cached

    rows = _read_rows("couriers", country, wh_city, lookback_days, sf, vt, retail_ids, None, vehicle_type, date_from, date_to, None, None, ot, complete_weeks, None, dc_ids, tm)

    couriers = []
    for r in rows:
        cnt = r.get("order_count") or 0
        sec_sum = r.get("ttla_sec_sum") or 0
        couriers.append({
            "courier_id": r.get("courier_id"),
            "order_count": cnt,
            "ttla_sec_sum": sec_sum,
            "avg_ttla_sec": round(sec_sum / cnt, 1) if cnt > 0 else None,
        })
    couriers.sort(key=lambda x: x["order_count"], reverse=True)

    result = {
        "couriers": couriers,
        "total": len(couriers),
        "country": country,
        "ttla_target_sec": ttla_target_sec(country),
    }
    cache.set(ck, result, get_settings().cache_ttl_seconds)
    return result


@router.get("/country-context")
def get_ttla_country_context(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    order_type: str = Query(default="regular"),
    complete_weeks: int = Query(default=None, ge=1, le=53),
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
    delivery_counts: str = Query(default=None),
    ttla_mode: str = Query(default="default"),
):
    """Country TTLA context for the panel above Venue TTLA & unassign: the whole
    country's order-weighted TTLA for the chosen period + order type, the selected
    city's share (order-volume weight) + leave-one-out impact on the country TTLA,
    and the gap vs the country target. Cache-only (serve-stale)."""
    ot = norm_order_type(order_type)
    tm = norm_ttla_mode(ttla_mode)
    city, country, wh_city, sf = _resolve(city, "all")
    dc_ids = _parse_int_ids(delivery_counts)
    suffix = _cache_suffix("all", "all", None, None, None, date_from, date_to, None, None, ot, complete_weeks, None, dc_ids, tm) or "all"
    ck = f"ttla_context:{CACHE_VERSION}:{city}:{lookback_days}:{suffix}"
    cached = cache.get(ck)
    if cached:
        return cached

    rows = _read_rows("context", country, wh_city, lookback_days, "all", "all", None, None, None, date_from, date_to, None, None, ot, complete_weeks, None, dc_ids, tm)

    country_orders = sum(int(r.get("ttla_order_count") or 0) for r in rows)
    country_sec = sum(float(r.get("ttla_sec_sum") or 0) for r in rows)
    city_row = next((r for r in rows if r.get("city") == wh_city), None)
    city_orders = int(city_row.get("ttla_order_count") or 0) if city_row else 0
    city_sec = float(city_row.get("ttla_sec_sum") or 0.0) if city_row else 0.0

    country_avg = country_sec / country_orders if country_orders else None
    city_avg = city_sec / city_orders if city_orders else None
    rest_orders = country_orders - city_orders
    rest_avg = (country_sec - city_sec) / rest_orders if rest_orders > 0 else None
    # Leave-one-out impact: seconds the selected city ADDS to the country avg TTLA
    # (country avg minus the country avg computed without this city). Positive =
    # the city drags the country TTLA up (worse).
    impact = (country_avg - rest_avg) if (country_avg is not None and rest_avg is not None) else None
    # Influence weight = the city's share of the country's TTLA orders (the weight
    # it carries in the order-weighted country mean).
    influence = (city_orders / country_orders) if country_orders else None

    result = {
        "country": country,
        "country_name": COUNTRY_NAMES.get(country, country),
        "city": city,
        "order_type": ot,
        "country_avg_sec": round(country_avg, 1) if country_avg is not None else None,
        "country_order_count": country_orders,
        "city_avg_sec": round(city_avg, 1) if city_avg is not None else None,
        "city_order_count": city_orders,
        "rest_avg_sec": round(rest_avg, 1) if rest_avg is not None else None,
        "influence_pct": round(influence, 4) if influence is not None else None,
        "impact_sec": round(impact, 1) if impact is not None else None,
        "city_count": len(rows),
        "ttla_target_sec": ttla_target_sec(country),
    }
    cache.set(ck, result, get_settings().cache_ttl_seconds)
    return result
