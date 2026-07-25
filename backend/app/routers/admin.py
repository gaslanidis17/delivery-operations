from __future__ import annotations

import json
import threading
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from typing import Optional
from fastapi import APIRouter, Request, HTTPException

from app.config import get_settings, canonical_max_lookback_days
from app.services.synthetic_data import execute_query, DATA_DIR, _operation_name
from app.services.cache import cache
from app.services.activity_log import log_event
from app.routers.auth import _sessions

router = APIRouter(prefix="/api/admin", tags=["admin"])

REFRESH_DATASET_CITY = [
    ("base_late_orders.dataset", {}),
    ("late_orders_summary.dataset", {}),
    ("late_orders_trend.dataset", {}),
    ("delayed_orders.dataset", {"needs_rotten": True}),
    ("rotten_summary.dataset", {"needs_rotten": True}),
    ("map_venues.dataset", {}),
    ("map_dropoffs.dataset", {}),
    ("hourly_distribution.dataset", {}),
    ("courier_travel.dataset", {}),
    ("courier_speed_benchmark.dataset", {}),
    ("venue_performance.dataset", {"needs_venue": True}),
]

REFRESH_DATASET_COUNTRY_CITY = [
    "country_heavy_vehicle_share.dataset",
    "country_large_vehicle_share.dataset",
    "country_split_heavy_vehicle.dataset",
    "country_hl_lateness.dataset",
    "country_daily_rates.dataset",
    # Per-city TTLA (Task to Last Accept) — single-city plain cache, read by the
    # Country tab's per-city /analytics `ttla` key.
    "country_ttla.dataset",
    "city_weight_perf.dataset",
]

REFRESH_DATASET_COUNTRY_MASTER = [
    "country_hl_lateness_total.dataset",
    "country_daily_rates_total.dataset",
    "country_clone_rate_total.dataset",
    # Region-only ADT (Average Delivery Time) country total — same synthetic_jobs
    # spine / deep cache as the other *_total files, read by /api/region/overview.
    # Warmed here so admin "Update Data" backfills the Region ADT column.
    "country_adt_total.dataset",
    # TTLA (Task to Last Accept) country total — same deep-cache discipline as the
    # ADT/rate totals; read by BOTH /api/region/overview and the Country tab's
    # /master `ttla_total`. Warmed here so "Update Data" backfills the TTLA column.
    "country_ttla_total.dataset",
    "country_perf_metrics.dataset",
    # Region city drill-down: per-city versions of the country-wide daily files.
    # Warmed at MAX depth per country (keyed __country_{code}) so the Region tab's
    # city expansion has deep Week/Month coverage immediately.
    "country_daily_rates_by_city.dataset",
    "country_hl_lateness_by_city.dataset",
    "country_clone_rate_by_city.dataset",
    # Region-only ADT by city — read by /api/region/country/{code}/cities. Same
    # deep-cache discipline as the other *_by_city files.
    "country_adt_by_city.dataset",
    # TTLA by city — read by /api/region/country/{code}/cities (drill-down). Same
    # deep-cache discipline as the other *_by_city files.
    "country_ttla_by_city.dataset",
    # Country tab "why are heavy/large orders late?" — the city late-orders model
    # widened to a whole country. Keyed __country_{code}, deep-cached at MAX depth
    # like the other canonical files. Needs a {city_list} param (added below).
    "country_late_reasons.dataset",
]

# These country-master / Region files use the window-aware + freshness-aware
# deep cache (see synthetic_data.execute_query canonical mode). Warming them
# re-queries at REGION_MAX_LOOKBACK_DAYS and writes one deep file per country
# (the requested lookback is overridden to MAX inside execute_query), so the
# Region Week/Month windows are backfilled to the full canonical depth.
COUNTRY_MASTER_CANONICAL = set(REFRESH_DATASET_COUNTRY_MASTER)

# Clone-rate caches are keyed with extra suffixes (size/weight/date-window), so a
# plain base-name delete misses them. These are cleared via glob + re-warmed.
CLONE_DATASET_BASES = [
    "clone_rate_summary",
    "clone_city_share",
    "clone_acceptance_by_weight",
    "clone_vehicle_distribution",
    "clone_vehicle_calendar",
    "clone_orders_list",
    "clone_orders_calendar",
    "clone_vehicle_share",
    "clone_courier_positions",
    "clone_order_positions",
    "clone_venue_contribution",
]

from app.config import CITY_COUNTRY_MAP, CITY_OPERATIONS_AREA_ALIAS
from app.routers.country_analytics import build_country_city_list_sql
from app.routers.ttla_orders import TTLA_ORDERS_ROW_LIMIT, default_clause_params
from app.services.ttla_filters import ttla_mode_fragments, TTLA_MODE_DEFAULT

# Default-mode TTLA fragments (empty CTE/join + CAST(fp.time_to_last_accept_sec AS
# DOUBLE)) for the now-parameterized country_ttla.dataset / country_ttla_total.dataset /
# country_ttla_by_city.dataset. The admin "Update Data" warm always warms the DEFAULT
# mode (no mode control here), so one shared frag set is fine; default mode ignores
# the population_clause (no CTE) so "" is OK. Applied to the per-city + country-master
# task loops below so str.format doesn't KeyError on the new {ttla_*} placeholders.
_TTLA_DEFAULT_FRAGS = ttla_mode_fragments(TTLA_MODE_DEFAULT, "", None, "")
_TTLA_PARAM_FILES = {"country_ttla.dataset", "country_ttla_total.dataset", "country_ttla_by_city.dataset"}


def _with_ttla_frags(dataset_key: str, params: dict) -> dict:
    """Merge default-mode TTLA fragments into ``params`` for the parameterized
    country_ttla*.dataset files (no-op for every other DATASET file)."""
    return {**params, **_TTLA_DEFAULT_FRAGS} if dataset_key in _TTLA_PARAM_FILES else params

# TTLA tab lazy-warm files (Orders / Venues / Couriers). Keyed by city + lookback
# (cache_by_lookback=True) + size suffix like the endpoints read — so they get a
# dedicated warm helper (below) rather than the generic task loop, which doesn't
# pass cache_by_lookback. Warmed at size "all" (the default view).
REFRESH_DATASET_TTLA = [
    "ttla_orders.dataset",
    "ttla_venues.dataset",
    "ttla_couriers.dataset",
]

# Retail-TTLA tab lazy-warm files (city summary + venue ranking). Keyed by city +
# lookback (cache_by_lookback=True) like the /api/retail-ttla endpoints read, so
# they use their own warm helper (below) rather than the generic task loop.
REFRESH_DATASET_RETAIL_TTLA = [
    "retail_ttla_city_summary.dataset",
    "retail_ttla_venues.dataset",
    "retail_ttla_country_summary.dataset",
]

# AI Venue Diagnostic lazy-warm files (hourly / daily / conversations / venue
# attributes), keyed by city + lookback + order-type suffix like the
# /api/ttla/venue-diagnostics reads. Warmed via the service's own helper
# (warm_venue_diagnostics) so admin "Update Data" keeps the diagnostic packs
# sign-in-safe + instant.
from app.services import venue_diagnostics as _vd

REFRESH_DATASET_VENUE_DIAG = list(_vd.DIAG_DATASET_FILES)

_refresh_lock = threading.Lock()
_refresh_status: dict[str, Any] = {
    "running": False,
    "progress": "",
    "completed": 0,
    "total": 0,
    "errors": [],
}


def _get_user(request: Request) -> dict | None:
    token = request.cookies.get("session_token")
    return _sessions.get(token) if token else None


def _require_admin(request: Request) -> dict:
    user = _get_user(request)
    if not user or user.get("username") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def _delete_cache_file(dataset_key: str, city: str | None = None):
    base = dataset_key.replace(".dataset", "").replace("/", "_")
    if city:
        safe = city.lower().replace(" ", "_")
        path = DATA_DIR / f"{base}_{safe}.json"
    else:
        path = DATA_DIR / f"{base}.json"
    if path.exists():
        path.unlink()


def _delete_clone_cache(city: str):
    """Remove every clone-rate cache file for a city (all size/weight/date suffixes)."""
    safe = city.lower().replace(" ", "_")
    for base in CLONE_DATASET_BASES:
        for path in DATA_DIR.glob(f"{base}_{safe}*.json"):
            try:
                path.unlink()
            except OSError:
                pass


# Number of execute_query steps _warm_clone_cache runs — the Clone tab's warm
# `total` for the progress bar (kept in sync with the calls below).
CLONE_WARM_STEPS = 11


def _warm_clone_cache(city: str, lookback: int = 28, *, force_refresh: bool = False, report=None):
    """Re-run the default clone-rate queries so the tab shows fresh data immediately.

    ``force_refresh`` (used by the tab-open background warm, which — unlike admin
    refresh — never deletes first so it can keep serving stale-but-instant data)
    re-queries and overwrites each file in place. Admin refresh leaves it False
    because it deletes the files up front, so the cache read misses anyway.

    ``report`` (an ``auto_refresh`` progress handle, or None when called from the
    admin refresh which has its own progress model) advances the progress bar one
    step per completed query."""
    from app.routers.clone_rate import _size_filter_clause
    from app.services.auto_refresh import NOOP_PROGRESS

    report = report or NOOP_PROGRESS
    report.set_total(CLONE_WARM_STEPS)

    sfc = _size_filter_clause("heavy_or_large")

    execute_query("clone_rate_summary.dataset", {
        "city": city, "lookback_days": lookback,
        "size_filter_clause": sfc, "weight_tier_clause": "",
    }, cache_by_lookback=True, cache_suffix="heavy_or_large_all", force_refresh=force_refresh)
    report.step()

    execute_query("clone_city_share.dataset", {
        "city": city, "lookback_days": lookback,
    }, cache_by_lookback=True, force_refresh=force_refresh)
    report.step()

    execute_query("clone_acceptance_by_weight.dataset", {
        "city": city, "lookback_days": lookback, "size_filter_clause": sfc,
    }, cache_by_lookback=True, cache_suffix="heavy_or_large", force_refresh=force_refresh)
    report.step()

    execute_query("clone_vehicle_distribution.dataset", {
        "city": city, "lookback_days": lookback,
    }, force_refresh=force_refresh)
    report.step()

    execute_query("clone_orders_list.dataset", {
        "city": city, "lookback_days": lookback,
        "size_filter_clause": sfc, "weight_tier_clause": "",
    }, cache_by_lookback=True, cache_suffix="heavy_or_large_all", force_refresh=force_refresh)
    report.step()

    execute_query("clone_vehicle_share.dataset", {
        "city": city, "lookback_days": lookback,
    }, cache_by_lookback=True, force_refresh=force_refresh)
    report.step()

    today = date.today()
    d_to = (today - timedelta(days=1)).isoformat()
    d_from = (today - timedelta(days=lookback)).isoformat()
    execute_query("clone_vehicle_calendar.dataset", {
        "city": city, "date_from": d_from, "date_to": d_to, "vehicle_filter_clause": "",
    }, cache_suffix=f"{d_from}_{d_to}_all", force_refresh=force_refresh)
    report.step()
    execute_query("clone_orders_calendar.dataset", {
        "city": city, "date_from": d_from, "date_to": d_to,
    }, cache_suffix=f"{d_from}_{d_to}", force_refresh=force_refresh)
    report.step()
    execute_query("clone_venue_contribution.dataset", {
        "city": city, "date_from": d_from, "date_to": d_to,
    }, cache_suffix=f"{d_from}_{d_to}", force_refresh=force_refresh)
    report.step()
    execute_query("clone_courier_positions.dataset", {
        "city": city, "date_from": d_from, "date_to": d_to,
        "vehicle_filter_clause": "",
    }, cache_suffix=f"{d_from}_{d_to}_all", force_refresh=force_refresh)
    report.step()
    execute_query("clone_order_positions.dataset", {
        "city": city, "date_from": d_from, "date_to": d_to,
        "size_filter_clause": sfc,
    }, cache_suffix=f"{d_from}_{d_to}_heavy_or_large", force_refresh=force_refresh)
    report.step()


def _refresh_clone_for_cities(cities: list[str], username: str, base_completed: int, total: int):
    """Delete + re-warm clone-rate caches for each city, updating refresh progress."""
    for j, city in enumerate(cities):
        _refresh_status["progress"] = f"[{base_completed + j + 1}/{total}] clone-rate ({city})"
        _refresh_status["completed"] = base_completed + j
        try:
            _delete_clone_cache(city)
            _warm_clone_cache(city)
        except Exception as exc:
            err = f"clone-rate ({city}): {str(exc)[:200]}"
            _refresh_status["errors"].append(err)
            log_event("admin", "refresh_error", username=username, detail={"task": err})


# Order types warmed for both the TTLA + Retail-TTLA tabs (the global Order-type
# filter). Regular is the default (no suffix); Drive gets its own `ot-drive` slice.
_TTLA_WARM_ORDER_TYPES = ["regular", "drive"]

# Number of execute_query steps _warm_ttla_cache runs (Orders/Venues/Couriers per
# order type).
TTLA_WARM_STEPS = len(REFRESH_DATASET_TTLA) * len(_TTLA_WARM_ORDER_TYPES)


def _warm_ttla_cache(city: str, lookback: int = 28, *, force_refresh: bool = False, report=None):
    """Re-run the default (size "all") TTLA-tab queries for a city — for BOTH order
    types (Regular + Drive) — so the tab shows fresh data immediately. Uses
    cache_by_lookback=True + the order-type suffix to match exactly what the
    /api/ttla endpoints read. ``force_refresh`` re-queries and overwrites in place
    (the tab-open background warm never deletes first)."""
    from app.services.auto_refresh import NOOP_PROGRESS
    from app.services.ttla_filters import order_type_suffix

    report = report or NOOP_PROGRESS
    report.set_total(TTLA_WARM_STEPS)

    country = CITY_COUNTRY_MAP.get(city, "R1")
    wh_city = CITY_OPERATIONS_AREA_ALIAS.get(city, city)
    # The TTLA DATASET files carry the global-filter placeholders (order type, date
    # window, venue type, retail venues, min-TTLA, vehicle type); the admin warm
    # warms the DEFAULT size-unfiltered view per order type, so pull the
    # empty/default clause set from the router so the shared DATASET formats without
    # KeyError.
    for ot in _TTLA_WARM_ORDER_TYPES:
        suffix = order_type_suffix(ot)
        base = {
            "country": country,
            "city": wh_city,
            "lookback_days": lookback,
            **default_clause_params(lookback, ot),
        }
        execute_query("ttla_orders.dataset", {**base, "row_limit": TTLA_ORDERS_ROW_LIMIT},
                      cache_by_lookback=True, cache_suffix=suffix, force_refresh=force_refresh)
        report.step()
        execute_query("ttla_venues.dataset", base, cache_by_lookback=True, cache_suffix=suffix, force_refresh=force_refresh)
        report.step()
        execute_query("ttla_couriers.dataset", base, cache_by_lookback=True, cache_suffix=suffix, force_refresh=force_refresh)
        report.step()


def _refresh_ttla_for_cities(cities: list[str], username: str, base_completed: int, total: int):
    """Re-warm TTLA-tab caches for each city, updating refresh progress. Files are
    overwritten in place (force_refresh), matching the clone-rate re-warm model."""
    for j, city in enumerate(cities):
        _refresh_status["progress"] = f"[{base_completed + j + 1}/{total}] ttla ({city})"
        _refresh_status["completed"] = base_completed + j
        try:
            _warm_ttla_cache(city, force_refresh=True)
        except Exception as exc:
            err = f"ttla ({city}): {str(exc)[:200]}"
            _refresh_status["errors"].append(err)
            log_event("admin", "refresh_error", username=username, detail={"task": err})


# Number of execute_query steps _warm_retail_ttla_cache runs (summary + venues per
# order type).
RETAIL_TTLA_WARM_STEPS = len(REFRESH_DATASET_RETAIL_TTLA) * len(_TTLA_WARM_ORDER_TYPES)


def _warm_retail_ttla_cache(city: str, lookback: int = 28, *, force_refresh: bool = False, report=None):
    """Re-run the Retail-TTLA (venue overview) queries for a city — for BOTH order
    types (Regular + Drive) — so the tab shows fresh data immediately. Uses
    cache_by_lookback=True + the order-type suffix + the shared date window clause
    to match exactly what the /api/retail-ttla endpoints read. ``force_refresh``
    overwrites in place (the tab-open background warm never deletes first)."""
    from app.services.auto_refresh import NOOP_PROGRESS
    from app.services.ttla_filters import (
        date_window_clause,
        order_type_clause,
        order_type_suffix,
    )

    report = report or NOOP_PROGRESS
    report.set_total(RETAIL_TTLA_WARM_STEPS)

    country = CITY_COUNTRY_MAP.get(city, "R1")
    wh_city = CITY_OPERATIONS_AREA_ALIAS.get(city, city)
    for ot in _TTLA_WARM_ORDER_TYPES:
        suffix = order_type_suffix(ot)
        params = {
            "country": country,
            "city": wh_city,
            "lookback_days": lookback,
            "date_window_clause": date_window_clause(lookback, None, None, None),
            "order_type_clause": order_type_clause(ot),
        }
        for dataset_key in REFRESH_DATASET_RETAIL_TTLA:
            execute_query(dataset_key, params, cache_by_lookback=True, cache_suffix=suffix, force_refresh=force_refresh)
            report.step()


def _refresh_retail_ttla_for_cities(cities: list[str], username: str, base_completed: int, total: int):
    """Re-warm Retail-TTLA caches for each city, updating refresh progress. Files
    are overwritten in place (force_refresh), matching the TTLA re-warm model."""
    for j, city in enumerate(cities):
        _refresh_status["progress"] = f"[{base_completed + j + 1}/{total}] retail-ttla ({city})"
        _refresh_status["completed"] = base_completed + j
        try:
            _warm_retail_ttla_cache(city, force_refresh=True)
        except Exception as exc:
            err = f"retail-ttla ({city}): {str(exc)[:200]}"
            _refresh_status["errors"].append(err)
            log_event("admin", "refresh_error", username=username, detail={"task": err})


def _refresh_venue_diag_for_cities(cities: list[str], username: str, base_completed: int, total: int):
    """Re-warm AI Venue Diagnostic caches (hourly/daily/conversations/attributes,
    both order types) for each city. Files are overwritten in place
    (force_refresh), matching the retail-TTLA re-warm model."""
    for j, city in enumerate(cities):
        _refresh_status["progress"] = f"[{base_completed + j + 1}/{total}] venue-diag ({city})"
        _refresh_status["completed"] = base_completed + j
        try:
            _vd.warm_venue_diagnostics(city, force_refresh=True)
        except Exception as exc:
            err = f"venue-diag ({city}): {str(exc)[:200]}"
            _refresh_status["errors"].append(err)
            log_event("admin", "refresh_error", username=username, detail={"task": err})


def _run_refresh(username: str):
    global _refresh_status
    s = get_settings()
    cities = s.supported_cities
    lookback = 28

    tasks: list[tuple[str, dict]] = []

    for city in cities:
        country = CITY_COUNTRY_MAP.get(city, "R1")
        for dataset_key, extra in REFRESH_DATASET_CITY:
            params: dict[str, Any] = {
                "city": city,
                "lookback_days": lookback,
            }
            if extra.get("needs_rotten"):
                params["rotten_threshold_min"] = s.rotten_threshold_min
            if extra.get("needs_venue"):
                params["rotten_threshold_min"] = s.rotten_threshold_min
                params["venue_late_threshold"] = int(s.venue_late_threshold)
                params["venue_early_threshold"] = int(s.venue_early_threshold)
                params["size_filter_clause"] = ""
            tasks.append((dataset_key, {**params}))

        for dataset_key in REFRESH_DATASET_COUNTRY_CITY:
            tasks.append((dataset_key, {
                "country": country,
                "city": CITY_OPERATIONS_AREA_ALIAS.get(city, city),
                "lookback_days": lookback,
                "rotten_threshold_min": s.rotten_threshold_min,
            }))

    countries_done: set[str] = set()
    for city in cities:
        country = CITY_COUNTRY_MAP.get(city, "R1")
        if country not in countries_done:
            countries_done.add(country)
            for dataset_key in REFRESH_DATASET_COUNTRY_MASTER:
                tasks.append((dataset_key, {
                    "country": country,
                    "lookback_days": lookback,
                    "city": f"__country_{country}",
                    "city_list": build_country_city_list_sql(country),
                    "rotten_threshold_min": s.rotten_threshold_min,
                }))

    total = len(tasks) + 4 * len(cities)  # clone-rate + TTLA + retail-TTLA + venue-diag step per city
    _refresh_status = {
        "running": True,
        "progress": "Starting...",
        "completed": 0,
        "total": total,
        "errors": [],
    }

    log_event("admin", "refresh_start", username=username, detail={"total_tasks": total})

    for i, (dataset_key, params) in enumerate(tasks):
        city_label = params.get("city", "country")
        _refresh_status["progress"] = f"[{i+1}/{total}] {_operation_name(dataset_key)} ({city_label})"
        _refresh_status["completed"] = i

        _delete_cache_file(dataset_key, params.get("city"))

        try:
            if dataset_key in COUNTRY_MASTER_CANONICAL:
                execute_query(dataset_key, _with_ttla_frags(dataset_key, params), canonical_max_days=canonical_max_lookback_days())
            else:
                execute_query(dataset_key, _with_ttla_frags(dataset_key, params))
        except Exception as exc:
            err = f"{_operation_name(dataset_key)} ({city_label}): refresh failed"
            _refresh_status["errors"].append(err)
            log_event("admin", "refresh_error", username=username, detail={"task": err})

    _refresh_clone_for_cities(list(cities), username, len(tasks), total)
    _refresh_ttla_for_cities(list(cities), username, len(tasks) + len(cities), total)
    _refresh_retail_ttla_for_cities(list(cities), username, len(tasks) + 2 * len(cities), total)
    _refresh_venue_diag_for_cities(list(cities), username, len(tasks) + 3 * len(cities), total)

    cache.clear()

    _refresh_status["running"] = False
    _refresh_status["completed"] = total
    _refresh_status["progress"] = "Done"

    log_event("admin", "refresh_done", username=username, detail={
        "total": total,
        "errors": len(_refresh_status["errors"]),
    })


def _run_city_refresh(username: str, city: str):
    global _refresh_status
    s = get_settings()
    lookback = 28
    country = CITY_COUNTRY_MAP.get(city, "R1")

    tasks: list[tuple[str, dict]] = []

    for dataset_key, extra in REFRESH_DATASET_CITY:
        params: dict[str, Any] = {
            "city": city,
            "lookback_days": lookback,
        }
        if extra.get("needs_rotten"):
            params["rotten_threshold_min"] = s.rotten_threshold_min
        if extra.get("needs_venue"):
            params["rotten_threshold_min"] = s.rotten_threshold_min
            params["venue_late_threshold"] = int(s.venue_late_threshold)
            params["venue_early_threshold"] = int(s.venue_early_threshold)
            params["size_filter_clause"] = ""
        tasks.append((dataset_key, {**params}))

    for dataset_key in REFRESH_DATASET_COUNTRY_CITY:
        tasks.append((dataset_key, {
            "country": country,
            "city": CITY_OPERATIONS_AREA_ALIAS.get(city, city),
            "lookback_days": lookback,
            "rotten_threshold_min": s.rotten_threshold_min,
        }))

    for dataset_key in REFRESH_DATASET_COUNTRY_MASTER:
        tasks.append((dataset_key, {
            "country": country,
            "lookback_days": lookback,
            "city": f"__country_{country}",
            "city_list": build_country_city_list_sql(country),
            "rotten_threshold_min": s.rotten_threshold_min,
        }))

    total = len(tasks) + 4  # +1 clone-rate, +1 TTLA, +1 retail-TTLA, +1 venue-diag refresh step
    _refresh_status = {
        "running": True,
        "progress": "Starting...",
        "completed": 0,
        "total": total,
        "errors": [],
    }

    log_event("admin", "refresh_city_start", username=username, detail={"city": city, "total_tasks": total})

    for i, (dataset_key, params) in enumerate(tasks):
        city_label = params.get("city", "country")
        _refresh_status["progress"] = f"[{i+1}/{total}] {_operation_name(dataset_key)} ({city_label})"
        _refresh_status["completed"] = i

        _delete_cache_file(dataset_key, params.get("city"))

        try:
            if dataset_key in COUNTRY_MASTER_CANONICAL:
                execute_query(dataset_key, _with_ttla_frags(dataset_key, params), canonical_max_days=canonical_max_lookback_days())
            else:
                execute_query(dataset_key, _with_ttla_frags(dataset_key, params))
        except Exception as exc:
            err = f"{_operation_name(dataset_key)} ({city_label}): refresh failed"
            _refresh_status["errors"].append(err)
            log_event("admin", "refresh_error", username=username, detail={"task": err})

    _refresh_clone_for_cities([city], username, len(tasks), total)
    _refresh_ttla_for_cities([city], username, len(tasks) + 1, total)
    _refresh_retail_ttla_for_cities([city], username, len(tasks) + 2, total)
    _refresh_venue_diag_for_cities([city], username, len(tasks) + 3, total)

    cache.clear()

    _refresh_status["running"] = False
    _refresh_status["completed"] = total
    _refresh_status["progress"] = "Done"

    log_event("admin", "refresh_city_done", username=username, detail={
        "city": city,
        "total": total,
        "errors": len(_refresh_status["errors"]),
    })


def _run_country_refresh(username: str, country_code: str):
    global _refresh_status
    s = get_settings()
    lookback = 28

    country_cities = [c for c, cc in CITY_COUNTRY_MAP.items() if cc == country_code]
    if not country_cities:
        _refresh_status = {"running": False, "progress": "No cities found", "completed": 0, "total": 0, "errors": [f"No cities for country {country_code}"]}
        return

    tasks: list[tuple[str, dict]] = []

    for city in country_cities:
        for dataset_key, extra in REFRESH_DATASET_CITY:
            params: dict[str, Any] = {"city": city, "lookback_days": lookback}
            if extra.get("needs_rotten"):
                params["rotten_threshold_min"] = s.rotten_threshold_min
            if extra.get("needs_venue"):
                params["rotten_threshold_min"] = s.rotten_threshold_min
                params["venue_late_threshold"] = int(s.venue_late_threshold)
                params["venue_early_threshold"] = int(s.venue_early_threshold)
                params["size_filter_clause"] = ""
            tasks.append((dataset_key, {**params}))

        for dataset_key in REFRESH_DATASET_COUNTRY_CITY:
            tasks.append((dataset_key, {"country": country_code, "city": CITY_OPERATIONS_AREA_ALIAS.get(city, city), "lookback_days": lookback, "rotten_threshold_min": s.rotten_threshold_min}))

    for dataset_key in REFRESH_DATASET_COUNTRY_MASTER:
        tasks.append((dataset_key, {"country": country_code, "lookback_days": lookback, "city": f"__country_{country_code}", "city_list": build_country_city_list_sql(country_code), "rotten_threshold_min": s.rotten_threshold_min}))

    total = len(tasks) + 4 * len(country_cities)  # clone-rate + TTLA + retail-TTLA + venue-diag step per city
    _refresh_status = {"running": True, "progress": "Starting...", "completed": 0, "total": total, "errors": []}
    log_event("admin", "refresh_country_start", username=username, detail={"country": country_code, "cities": len(country_cities), "total_tasks": total})

    for i, (dataset_key, params) in enumerate(tasks):
        city_label = params.get("city", "country")
        _refresh_status["progress"] = f"[{i+1}/{total}] {_operation_name(dataset_key)} ({city_label})"
        _refresh_status["completed"] = i
        _delete_cache_file(dataset_key, params.get("city"))
        try:
            if dataset_key in COUNTRY_MASTER_CANONICAL:
                execute_query(dataset_key, _with_ttla_frags(dataset_key, params), canonical_max_days=canonical_max_lookback_days())
            else:
                execute_query(dataset_key, _with_ttla_frags(dataset_key, params))
        except Exception as exc:
            err = f"{_operation_name(dataset_key)} ({city_label}): refresh failed"
            _refresh_status["errors"].append(err)
            log_event("admin", "refresh_error", username=username, detail={"task": err})

    _refresh_clone_for_cities(country_cities, username, len(tasks), total)
    _refresh_ttla_for_cities(country_cities, username, len(tasks) + len(country_cities), total)
    _refresh_retail_ttla_for_cities(country_cities, username, len(tasks) + 2 * len(country_cities), total)
    _refresh_venue_diag_for_cities(country_cities, username, len(tasks) + 3 * len(country_cities), total)

    cache.clear()
    _refresh_status["running"] = False
    _refresh_status["completed"] = total
    _refresh_status["progress"] = "Done"
    log_event("admin", "refresh_country_done", username=username, detail={"country": country_code, "total": total, "errors": len(_refresh_status["errors"])})


@router.post("/refresh")
def start_refresh(request: Request, city: Optional[str] = None, country: Optional[str] = None):
    user = _require_admin(request)

    if _refresh_status["running"]:
        raise HTTPException(status_code=409, detail="Refresh already in progress")

    if city:
        thread = threading.Thread(target=_run_city_refresh, args=(user["username"], city), daemon=True)
        label = city
    elif country:
        thread = threading.Thread(target=_run_country_refresh, args=(user["username"], country), daemon=True)
        from app.config import COUNTRY_NAMES
        label = COUNTRY_NAMES.get(country, country)
    else:
        thread = threading.Thread(target=_run_refresh, args=(user["username"],), daemon=True)
        label = "all cities"
    thread.start()

    return {"status": "started", "message": f"Data refresh started for {label}"}


@router.get("/refresh/status")
def refresh_status(request: Request):
    _require_admin(request)
    return _refresh_status
