from __future__ import annotations

import time
from collections import defaultdict, OrderedDict
from threading import Lock
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query, Path

from app.config import (
    get_settings,
    canonical_max_lookback_days,
    CITY_DATA,
    COUNTRY_NAMES,
    CITY_OPERATIONS_AREA_ALIAS,
    CITY_OPERATIONS_AREA_ALIAS_REVERSE,
    ttla_target_sec,
)
from app.services.synthetic_data import (
    execute_query,
    peek_cache_file,
    read_canonical_cached,
    read_plain_cached,
    canonical_cache_path,
)
from app.services.cache import cache
from app.services import auto_refresh
from app.services.ttla_filters import (
    norm_ttla_mode,
    ttla_mode_fragments,
    ttla_mode_suffix,
    country_ttla_population_clause,
    TTLA_MODE_DEFAULT,
)
from app.services.data_processor import (
    enrich_orders,
    compute_flag_counts,
    compute_overlap_matrix,
    compute_combination_counts,
    REASON_FLAG_NAMES,
    FLAG_LABELS,
)

router = APIRouter(prefix="/api/country", tags=["country-analytics"])

# Bump this whenever the response shape changes (e.g. new DATASET keys are added)
# so cache entries written by an older version can never be served. Without
# this, an entry cached before `daily_rates`/`daily_rates_total` existed would
# be returned missing those keys, collapsing cards to "No data".
# v4: responses now carry a `_freshness` block and the country-master in-memory
# entry is wrapped ({data,_stale,_newest}) for the auto-refresh-on-tab-open path.
# v5: master carries `ttla_total` (+ `ttla_target_sec`) and per-city analytics
# carries `ttla` (+ `ttla_target_sec`) for the new TTLA (Task to Last Accept)
# panels.
# v6: the TTLA panels now honor a TTLA-calculation-logic MODE filter
# (ttla_mode query param — default | first_courier | fixed) exactly like the
# dedicated TTLA tab. The mode is encoded into BOTH the on-disk cache_suffix for
# country_ttla.dataset / country_ttla_total.dataset (so modes never collide on one file;
# default adds no suffix so existing files stay valid) AND the in-memory assembled
# cache key (so a mode switch rebuilds from disk). The default mode reproduces the
# pre-mode DATASET byte-for-byte (COUNT/SUM skip NULLs), so no on-disk file delete is
# needed for default.
CACHE_VERSION = "v6"

# Independent version for the late-reasons endpoint's in-memory cache.
# v2: response now carries a `_freshness` block and the in-memory entry is wrapped
# ({body,_newest}) for the serve-stale + auto-refresh-on-tab-open path (the reasons
# feed no longer runs a live MAX-depth query on the request; it warms in the
# background instead).
LATE_REASONS_CACHE_VERSION = "v2"


def build_country_city_list_sql(country_code: str) -> str:
    """Build a safely single-quoted, comma-separated list of WAREHOUSE city names
    for a country, for injection into ``country_late_reasons.dataset``'s
    ``v.city IN ({city_list})`` clause.

    Names come from the curated ``CITY_DATA`` config (no untrusted input), and
    the forward alias (UI -> warehouse, e.g. Ridgeport -> Ridgeport) is applied so
    the filter matches ``public.venues.city``. Single quotes are still escaped
    defensively.
    """
    ui_cities = [c["name"] for c in CITY_DATA if c["country"] == country_code]
    warehouse_cities = [CITY_OPERATIONS_AREA_ALIAS.get(c, c) for c in ui_cities]
    return ", ".join("'" + c.replace("'", "''") + "'" for c in warehouse_cities)

CITY_DATASET_FILES = [
    "country_heavy_vehicle_share.dataset",
    "country_large_vehicle_share.dataset",
    "country_split_heavy_vehicle.dataset",
    "country_hl_lateness.dataset",
    "country_daily_rates.dataset",
    # Per-city TTLA (Task to Last Accept) — single-city daily avg-seconds inputs
    # (ttla_sec_sum + ttla_order_count), read into the `ttla` response key.
    "country_ttla.dataset",
    "city_weight_perf.dataset",
]

MASTER_DATASET_FILES = [
    "country_hl_lateness_total.dataset",
    "country_daily_rates_total.dataset",
    "country_perf_metrics.dataset",
    # Country-wide TTLA (Task to Last Accept) totals — same synthetic_jobs deep cache
    # as the other *_total files; read into the `ttla_total` response key and also
    # fanned out by the Region tab.
    "country_ttla_total.dataset",
]

# The per-city /analytics tab always fetches at this depth (the frontend's
# Country tab caps at 28d). The warm re-runs at the same depth so the rewritten
# files cover exactly what the endpoint serves.
CITY_ANALYTICS_LOOKBACK = 28
# The dated per-city file used as the staleness signal (daily confirmed_date rows;
# the vehicle-share/weight files are undated aggregates that can't show staleness).
CITY_ANALYTICS_DATE_SOURCE = "country_daily_rates.dataset"


def _warm_country_city(country_code: str, warehouse_city: str, ttla_mode: str = TTLA_MODE_DEFAULT, report=auto_refresh.NOOP_PROGRESS) -> None:
    """Background warm for ONE city's per-city /analytics PLAIN cache.

    Re-queries every CITY_DATASET_FILES file for the given (already warehouse-aliased)
    city with ``force_refresh`` (overwrite in place — no delete gap), so a
    month-stale per-city cache self-heals. Works for ANY city, including the
    non-curated ones the picker now surfaces (those that aren't in ``CITY_DATA``):
    marking such a city triggers this warm for exactly that city, so it fills in
    via the existing poll instead of cache-missing into a blocking live query +
    sign-in popup on the request path. Only ever runs when a connection is already
    live (gated by ``auto_refresh.trigger``); the per-city ``scope`` dedups so
    each marked city warms independently without contending for one job slot.

    ``ttla_mode`` warms ``country_ttla.dataset`` with the selected TTLA-calculation
    logic (default | first_courier | fixed): the ttla file gets the mode's
    {ttla_cte_outer}/{ttla_join}/{ttla_expr} fragments + a mode-specific
    cache_suffix (``tm-first``/``tm-fixed``; default adds none) so each mode's
    plain file is independent. The other CITY_DATASET_FILES are mode-independent
    (warmed once, shared across modes).

    ``report`` (from the auto-refresh daemon) advances the progress bar one step
    per completed CITY_DATASET_FILES query.
    """
    settings = get_settings()
    params = {
        "country": country_code,
        "city": warehouse_city,
        "lookback_days": CITY_ANALYTICS_LOOKBACK,
        "rotten_threshold_min": settings.rotten_threshold_min,
    }
    mode_suffix = ttla_mode_suffix(ttla_mode)
    ttla_frags = ttla_mode_fragments(
        ttla_mode, country_code, warehouse_city,
        country_ttla_population_clause(CITY_ANALYTICS_LOOKBACK),
    )
    ttla_params = {**params, **ttla_frags}
    for dataset_key in CITY_DATASET_FILES:
        if dataset_key == "country_ttla.dataset":
            execute_query(dataset_key, ttla_params, force_refresh=True, cache_suffix=mode_suffix)
        else:
            execute_query(dataset_key, params, force_refresh=True)
        report.step()


def _warm_country_master(country_code: str, max_days: int, ttla_mode: str = TTLA_MODE_DEFAULT, report=auto_refresh.NOOP_PROGRESS) -> None:
    """Background warm for the country-master deep cache (canonical MAX depth).

    ``ttla_mode`` warms ``country_ttla_total.dataset`` with the selected
    TTLA-calculation logic (default | first_courier | fixed): the ttla total file
    gets the mode's {ttla_cte_outer}/{ttla_join}/{ttla_expr} fragments (CTE
    country-scoped, city=None) + a mode-specific cache_suffix so each mode's deep
    file is independent (default adds no suffix → reuses the existing deep file).
    The other MASTER_DATASET_FILES are mode-independent.

    ``report`` advances one step per completed MASTER_DATASET_FILES query."""
    settings = get_settings()
    params = {
        "country": country_code,
        "lookback_days": max_days,
        "city": f"__country_{country_code}",
        "rotten_threshold_min": settings.rotten_threshold_min,
    }
    mode_suffix = ttla_mode_suffix(ttla_mode)
    ttla_frags = ttla_mode_fragments(
        ttla_mode, country_code, None,
        country_ttla_population_clause(max_days),
    )
    ttla_params = {**params, **ttla_frags}
    for dataset_key in MASTER_DATASET_FILES:
        if dataset_key == "country_ttla_total.dataset":
            execute_query(dataset_key, ttla_params, canonical_max_days=max_days, cache_suffix=mode_suffix)
        else:
            execute_query(dataset_key, params, canonical_max_days=max_days)
        report.step()


@router.get("/{country_code}/analytics")
def get_country_analytics(
    country_code: str = Path(...),
    city: str = Query(...),
    lookback_days: int = Query(default=28, ge=1, le=365),
    ttla_mode: str = Query(default="default"),
    force: bool = Query(default=False),
):
    country_code = country_code.upper()
    tm = norm_ttla_mode(ttla_mode)
    mode_suffix = ttla_mode_suffix(tm)

    # The warehouse stores some cities under a different name (e.g. UI "Ridgeport"
    # -> venue_operations_area/venues.city "Ridgeport"). Translate ONLY the
    # value injected into the per-city DATASET. The cache key and the response stay
    # keyed by the display name so the frontend (which iterates country.cities
    # and reads filteredCityData[cityName]) still finds the city.
    warehouse_city = CITY_OPERATIONS_AREA_ALIAS.get(city, city)

    # --- Freshness (cheap disk peek; never opens synthetic data source) ---------------------
    # Per-city scope (keyed by THIS city) so each marked city warms independently
    # — including non-curated cities the picker now surfaces — instead of sharing
    # one whole-country job slot. The in-memory entries are display-keyed, so the
    # invalidate prefix uses the display `city`.
    scope = f"country_city:{country_code}:{warehouse_city}"
    inv_prefix = f"country_analytics:{CACHE_VERSION}:{country_code}:{city}:"

    info = peek_cache_file(CITY_ANALYTICS_DATE_SOURCE, warehouse_city)
    age = info["age_seconds"]
    newest = info["newest_date"]

    # File-age gate (mirrors /master's `needs_warm`): only treat the city as
    # needing a warm when its dated daily-rates file is missing OR older than the
    # 24h TTL. A genuinely low-volume city whose newest date never reaches
    # yesterday (no orders yesterday) but whose file was warmed within the TTL is
    # NOT stale — without this gate it would sit in a permanent stale-banner +
    # 25s/300s poll-warm loop. Staleness is otherwise DATE-based (newest cached
    # date < yesterday), so data through yesterday shows no banner.
    ttl = get_settings().country_cache_ttl_seconds
    file_needs_warm = (
        (not info["exists"])
        or age is None
        or (ttl is not None and ttl > 0 and age > ttl)
    )
    is_stale = file_needs_warm and auto_refresh.is_stale_date(newest)

    # In-memory assembled cache key includes the TTLA mode (default | first_courier
    # | fixed) so a mode switch rebuilds from disk instead of serving the other
    # mode's assembled response. The on-disk ttla file itself is mode-suffixed
    # (see the read below); the other CITY_DATASET_FILES are mode-independent.
    ck = f"country_analytics:{CACHE_VERSION}:{country_code}:{city}:{lookback_days}:{mode_suffix or 'def'}"
    cached = cache.get(ck)
    if cached is not None:
        data = cached
        data_missing = False
    else:
        # SERVE-STALE: read ONLY the plain cache — never run a live query on the
        # request path (a cold non-curated city would otherwise fan out into 6
        # blocking live queries + an sign-in popup while the client awaits). A missing
        # file yields [] and flags `data_missing` so we warm THIS city below.
        params = {
            "country": country_code,
            "city": warehouse_city,
            "lookback_days": lookback_days,
            "rotten_threshold_min": get_settings().rotten_threshold_min,
        }
        data = {}
        data_missing = False
        for dataset_key in CITY_DATASET_FILES:
            key = dataset_key.replace("country_", "").replace("city_", "").replace(".dataset", "")
            # country_ttla.dataset is mode-parameterized: read the mode-specific plain
            # file (cache_suffix=mode_suffix). read_plain_cached only uses
            # city/lookback/suffix for the key (it never runs DATASET, so the mode's
            # {ttla_*} fragments aren't needed here — they're baked in at WARM
            # time below), so the base params + suffix is enough; a cold mode
            # yields None -> data_missing -> warm below.
            if dataset_key == "country_ttla.dataset":
                rows = read_plain_cached(dataset_key, params, cache_suffix=mode_suffix)
            else:
                rows = read_plain_cached(dataset_key, params)
            data[key] = rows if rows is not None else []
            if rows is None:
                data_missing = True
        # Only memoize a COMPLETE response; a cold city is left uncached so the
        # next poll re-reads and picks up the freshly warmed files.
        if not data_missing:
            cache.set(ck, data, 600)

    # Warm when the file is stale/old OR any per-city file is missing (a freshly
    # marked, never-warmed city). Gated on a live connection by auto_refresh — so
    # marking a city NEVER blocks the request or pops sign-in; it fills in via the poll
    # once warmed. With no live session, `trigger` reports `initialization_required`.
    needs_warm = file_needs_warm or data_missing
    if needs_warm or force:
        trig = auto_refresh.trigger(
            scope,
            lambda report: _warm_country_city(country_code, warehouse_city, tm, report),
            total=len(CITY_DATASET_FILES),
            invalidate_prefixes=[inv_prefix],
            force=force,
        )
    else:
        trig = auto_refresh.reflect(scope)
    freshness = auto_refresh.build_freshness(
        scope,
        stale=(is_stale or data_missing),
        newest_date=newest,
        trig=trig,
        cache_age_seconds=age,
    )
    # The per-city TTLA panel colours the city's TTLA against its COUNTRY target
    # (config-static; not cached with `data`, so it always reflects config).
    return {**data, "ttla_target_sec": ttla_target_sec(country_code), "_freshness": freshness}


@router.get("/{country_code}/master")
def get_country_master(
    country_code: str = Path(...),
    lookback_days: int = Query(default=28, ge=1, le=365),
    ttla_mode: str = Query(default="default"),
    force: bool = Query(default=False),
):
    country_code = country_code.upper()
    tm = norm_ttla_mode(ttla_mode)
    mode_suffix = ttla_mode_suffix(tm)

    # Country-master files share the window-aware + freshness-aware deep cache
    # with the Region tab (keyed by __country_<code>, held at the canonical
    # month-anchored MAX depth, trimmed to lookback_days). Clamp the request to
    # that window so it can never exceed what the deep cache holds.
    max_days = canonical_max_lookback_days()
    lookback_days = min(lookback_days, max_days)

    scope = f"country_master:{country_code}"
    inv_prefix = f"country_master:{CACHE_VERSION}:{country_code}:"
    # In-memory assembled cache key includes the TTLA mode so a mode switch
    # rebuilds from disk. The on-disk ttla total file is mode-suffixed (default
    # adds no suffix → reuses the existing deep file the Region tab also reads);
    # the other MASTER_DATASET_FILES are mode-independent.
    ck = f"country_master:{CACHE_VERSION}:{country_code}:{lookback_days}:{mode_suffix or 'def'}"

    cached = cache.get(ck)
    if cached is not None:
        data = cached["data"]
        needs_warm = cached["_needs_warm"]
        newest = cached["_newest"]
        data_missing = cached.get("_data_missing", False)
    else:
        # Non-blocking serve-stale: read the deep files WITHOUT a live re-query.
        # If a file is missing/stale/short we still serve what we have (or []) and
        # flag it for a background warm; the warm re-queries at MAX depth.
        # `needs_warm` is the deep cache's TTL+coverage discipline (drives the warm
        # + window deepening); the user-facing `stale` flag below is DATE-based
        # PLUS `data_missing`.
        # `data_missing` = a deep file is ENTIRELY absent (read_canonical_cached
        # returns rows=None), not merely TTL-stale/short. A freshly-added source
        # whose file was never warmed (e.g. country_ttla_total.dataset, added after the
        # older files were already warmed) lands here while the others read fresh —
        # it MUST make the view "stale" (below) or opening the country shows an
        # empty TTLA panel with NO banner/progress and sign-in never re-warms it
        # (date-based staleness reads "fresh" off the dense daily_rates file).
        data = {}
        needs_warm = False
        data_missing = False
        for dataset_key in MASTER_DATASET_FILES:
            key = dataset_key.replace("country_", "").replace(".dataset", "")
            # country_ttla_total.dataset is mode-parameterized: read the mode-specific
            # deep file (cache_suffix=mode_suffix). A cold mode yields rows=None
            # -> data_missing -> the view goes stale + warms that mode below.
            if dataset_key == "country_ttla_total.dataset":
                rows, fresh, _meta = read_canonical_cached(
                    dataset_key, f"__country_{country_code}", lookback_days,
                    cache_suffix=mode_suffix,
                )
            else:
                rows, fresh, _meta = read_canonical_cached(
                    dataset_key, f"__country_{country_code}", lookback_days,
                )
            data[key] = rows or []
            if not fresh:
                needs_warm = True
            if rows is None:
                data_missing = True
        newest = auto_refresh.max_date(data.get("daily_rates_total", []))
        cache.set(
            ck,
            {"data": data, "_needs_warm": needs_warm, "_newest": newest, "_data_missing": data_missing},
            600,
        )

    # Banner staleness is DATE-based (newest data behind yesterday) OR
    # coverage-based (`data_missing` — a source file is entirely absent). The
    # missing-file case can't be caught by the date check (the dense daily_rates
    # file still reaches yesterday), so without it a cold-TTLA country would show
    # empty TTLA with no banner/progress and sign-in wouldn't trigger a warm. A
    # snapshot warmed today (all files present) reaches yesterday, so it never
    # shows a stale banner even within the 24h TTL; `needs_warm` drives the warm.
    is_stale = data_missing or (needs_warm and auto_refresh.is_stale_date(newest))
    if needs_warm or force:
        trig = auto_refresh.trigger(
            scope,
            lambda report: _warm_country_master(country_code, max_days, tm, report),
            total=len(MASTER_DATASET_FILES),
            invalidate_prefixes=[inv_prefix],
            force=force,
        )
    else:
        trig = auto_refresh.reflect(scope)
    freshness = auto_refresh.build_freshness(
        scope, stale=is_stale, newest_date=newest, trig=trig,
    )
    # Country-level TTLA target (seconds) or None — the TTLA panel colours the
    # country's order-weighted TTLA against it. Config-static, added at return
    # time so it isn't frozen in the cached `data`.
    return {**data, "ttla_target_sec": ttla_target_sec(country_code), "_freshness": freshness}


# Source of the COMPLETE city list for a country. The curated CITY_DATA in
# config.py is only a hand-picked subset (e.g. R1 lists 7 cities, R4 9), so it
# omits many real operational cities. The by-city deep aggregate, by contrast,
# keeps EVERY `venue_operations_area` the warehouse has for the country (see
# country_daily_rates_by_city.dataset) — so it is the authoritative complete list.
CITY_LIST_SOURCE_DATASET = "country_daily_rates_by_city.dataset"


@router.get("/{country_code}/cities")
def get_country_city_list(
    country_code: str = Path(...),
    lookback_days: int = Query(default=84, ge=1, le=365),
):
    """Complete city list for a country, for the Country tab's city picker.

    Sourced from the by-city deep aggregate (every `venue_operations_area` the
    warehouse has for the country over the window), so it includes cities that
    are NOT in the curated CITY_DATA — fixing the "missing R1/R4 cities"
    problem where the picker only ever saw the hand-listed subset. Each entry
    carries the city's order volume (for a sensible volume-desc sort + a
    top-N default) and a ``curated`` flag.

    READ-ONLY by design: it never runs synthetic data source and never triggers a warm, so
    it cannot warm unmarked cities (the per-city ``/analytics`` warm is what the
    auto-refresh gates on marked cities). It serves whatever the by-city deep
    aggregate holds — that one file is kept warm by admin "Update Data" and the
    Region tab. When the aggregate has data we trust the warehouse's complete,
    correctly-spelled city set (some curated CITY_DATA names are even stale, e.g.
    display variants); only when the aggregate is cold do
    we fall back to the curated names so the picker is never blank. The warehouse
    value ``Ridgeport`` is reverse-aliased back to the UI name ``Ridgeport``; the
    ``Unknown`` bucket (NULL operations area) is dropped (not a selectable city).
    """
    code = country_code.upper()
    max_days = canonical_max_lookback_days()
    lookback_days = min(lookback_days, max_days)

    rows, _fresh, _meta = read_canonical_cached(
        CITY_LIST_SOURCE_DATASET, f"__country_{code}", lookback_days,
    )
    volumes: Dict[str, int] = {}
    for raw in rows or []:
        warehouse_city = raw.get("city") or "Unknown"
        if warehouse_city == "Unknown":
            continue
        display = CITY_OPERATIONS_AREA_ALIAS_REVERSE.get(warehouse_city, warehouse_city)
        volumes[display] = volumes.get(display, 0) + int(raw.get("total_orders") or 0)

    curated = {c["name"] for c in CITY_DATA if c["country"] == code}
    # Cold-cache fallback only: never leave the picker empty.
    if not volumes:
        for name in curated:
            volumes[name] = 0

    cities = [
        {"city": name, "orders": vol, "curated": name in curated}
        for name, vol in volumes.items()
    ]
    # Most-active cities first (alphabetical tiebreak) so the top-N default and
    # the top of the picker surface the cities that matter; the search box
    # handles the long tail of low-volume cities.
    cities.sort(key=lambda c: (-c["orders"], c["city"]))
    return {"code": code, "name": COUNTRY_NAMES.get(code, code), "cities": cities}


def build_reason_block(
    orders: List[Dict[str, Any]],
    with_overlap: bool,
    flag_names: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Aggregate per-order lateness flags into the LatenessReasonChart shape.

    ``flag_names`` defaults to ``REASON_FLAG_NAMES`` (which omits
    ``is_heavy_large`` — useful when the population is already restricted to
    heavy/large orders, where that flag carries no signal). ``total`` is the
    subset size, i.e. the denominator for "% of late orders". Overlap matrix +
    top combinations are only computed when ``with_overlap`` is True.

    Reused by both the Country late-reasons endpoint and the Country AI-analysis
    pipeline (``services/country_ai.py``) so the flag taxonomy stays identical.
    """
    names = flag_names if flag_names is not None else REASON_FLAG_NAMES
    block: Dict[str, Any] = {
        "flag_counts": compute_flag_counts(orders, names),
        "total": len(orders),
    }
    if with_overlap:
        block["overlap_matrix"] = compute_overlap_matrix(orders, names)
        block["top_combinations"] = compute_combination_counts(orders, flag_names=names)
    return block


def build_heavy_large_blocks(
    orders: List[Dict[str, Any]], with_overlap: bool
) -> Dict[str, Any]:
    """Split late orders into the heavy and large subsets and aggregate each."""
    heavy = [o for o in orders if o.get("is_heavy_delivery")]
    large = [o for o in orders if o.get("is_large_delivery")]
    return {
        "heavy": build_reason_block(heavy, with_overlap),
        "large": build_reason_block(large, with_overlap),
    }


# Memoized enriched late orders, keyed by (deep-file path, mtime, window). The
# ``country_late_reasons`` deep file is the multi-hundred-MB per-order aggregate;
# ``json.loads``-ing it AND re-enriching every order is the dominant Country-tab
# cost (it recurs on every late-reasons-endpoint TTL lapse, every distinct
# window, and every AI-pipeline call). Memoizing the ENRICHED result means repeat
# opens at the same window — and the AI pipeline, which calls this directly —
# skip BOTH the giant parse and the enrich. A small LRU bounds memory for
# high-volume countries (each R1 entry is large); it re-enriches when a warm
# rewrites the file (mtime changes) or the entry is evicted. NOTE: this is an
# in-memory memo only (no on-disk format change → no CACHE_VERSION bump). The
# fuller fix — persisting the small AGGREGATED reason blocks to disk so we never
# hold the raw enriched orders resident — is deliberately DEFERRED.
_ENRICHED_LATE_MEMO: "OrderedDict[tuple, List[Dict[str, Any]]]" = OrderedDict()
_ENRICHED_LATE_MEMO_LOCK = Lock()
_ENRICHED_LATE_MEMO_MAX = 3


def _late_reasons_deep_path(country_code: str):
    """Path of the per-order late-reasons deep canonical file for a country."""
    return canonical_cache_path("country_late_reasons.dataset", f"__country_{country_code.upper()}")


def _warm_country_late_reasons(country_code: str, max_days: int, report=auto_refresh.NOOP_PROGRESS) -> None:
    """Background warm for the country late-reasons deep cache (canonical MAX
    depth). This is the ONE blocking MAX-depth re-query for the reasons feed; it
    runs only on the auto-refresh daemon thread (gated on a live connection), so
    the ``/late-reasons`` request path itself never runs it and never pops sign-in.
    A high-volume country (R1) is slow + writes a hundreds-of-MB file — the
    reason this is off the request path.

    A single-step warm (``total=1``): the frontend renders it as an INDETERMINATE
    bar (a lone multi-minute query can't show fractional progress), and the
    elapsed timer makes a stall/slow warm visible."""
    country_code = country_code.upper()
    city_list = build_country_city_list_sql(country_code)
    if not city_list:
        return
    settings = get_settings()
    params = {
        "country": country_code,
        "city": f"__country_{country_code}",
        "city_list": city_list,
        "lookback_days": max_days,
        "rotten_threshold_min": settings.rotten_threshold_min,
    }
    execute_query("country_late_reasons.dataset", params, canonical_max_days=max_days)
    report.step()


def get_enriched_country_late_orders(
    country_code: str, lookback_days: Optional[int]
) -> List[Dict[str, Any]]:
    """Enriched (deduped + flagged) late orders for a whole country — SERVE-STALE.

    Shared feed for the late-reasons endpoint AND the Country AI pipeline. Reads
    ``country_late_reasons.dataset``'s deep canonical cache (the city late-orders
    model widened to the country's city list) via ``read_canonical_cached``, so it
    NEVER runs a live query on the request path (a cold/stale country returns what
    the deep file holds, or ``[]`` — a background warm, gated on a live synthetic data source
    session, refreshes it; see ``_warm_country_late_reasons`` + the endpoint). It
    enriches the rows with the same flag engine as the Late tab and tags each with
    ``ui_city`` (Ridgeport -> Ridgeport). Memoized by (deep-file path, mtime,
    window) so repeat calls skip the giant parse + enrich — and, crucially, a memo
    HIT avoids re-parsing the hundreds-of-MB file entirely (``read_canonical_cached``
    bypasses the parse memo for such large files)."""
    country_code = country_code.upper()
    max_days = canonical_max_lookback_days()
    days = min(lookback_days or 28, max_days)

    city_list = build_country_city_list_sql(country_code)
    if not city_list:
        return []

    deep_path = _late_reasons_deep_path(country_code)

    def _mtime() -> Optional[float]:
        try:
            return deep_path.stat().st_mtime
        except OSError:
            return None

    # Memo lookup uses the CURRENT mtime; on a hit we skip the (huge) parse + the
    # enrich AND never touch synthetic data source.
    lookup_key = (str(deep_path), _mtime(), days)
    with _ENRICHED_LATE_MEMO_LOCK:
        hit = _ENRICHED_LATE_MEMO.get(lookup_key)
        if hit is not None:
            _ENRICHED_LATE_MEMO.move_to_end(lookup_key)
            return hit

    # SERVE-STALE read (never queries): whatever the deep file holds, trimmed to
    # the window. A missing/legacy file yields [] (the endpoint then warms it).
    rows, _fresh, _meta = read_canonical_cached(
        "country_late_reasons.dataset", f"__country_{country_code}", days,
    )

    enriched = enrich_orders(rows or [])
    for o in enriched:
        warehouse_city = o.get("city")
        o["ui_city"] = CITY_OPERATIONS_AREA_ALIAS_REVERSE.get(warehouse_city, warehouse_city)

    store_key = (str(deep_path), _mtime(), days)
    with _ENRICHED_LATE_MEMO_LOCK:
        _ENRICHED_LATE_MEMO[store_key] = enriched
        _ENRICHED_LATE_MEMO.move_to_end(store_key)
        while len(_ENRICHED_LATE_MEMO) > _ENRICHED_LATE_MEMO_MAX:
            _ENRICHED_LATE_MEMO.popitem(last=False)
    return enriched


@router.get("/{country_code}/late-reasons")
def get_country_late_reasons(
    country_code: str = Path(...),
    lookback_days: Optional[int] = Query(default=28, ge=1, le=365),
    force: bool = Query(default=False),
):
    """Why are HEAVY / LARGE orders late? — server-side reason flag counts.

    Reuses the CITY late-orders model (``country_late_reasons.dataset`` = the
    per-city ``base_late_orders.dataset`` widened to ``v.city IN (...)`` for a whole
    country) + the same flag engine as the Late tab (``enrich_orders`` +
    ``compute_flag_counts``). Returns flag counts for the heavy and large late
    subsets at the country level (with overlap matrix + top combinations) and per
    city (counts only).

    Provenance caveat: these counts come from the city late-orders model (its
    pre-estimate-based late set), NOT the Country Overview SLA heavy/large-late
    definition, so they will not perfectly reconcile to those KPIs — the same
    trade-off already accepted for clone rate. Some flag inputs (pickup/dropoff
    timing in ``pdt``, task-group fields in ``ctg``) are populated mainly for
    R1, so several reasons may read 0 for other countries — a data-coverage
    matter, not a bug.
    """
    country_code = country_code.upper()
    # Clamp to the canonical month-anchored window: this endpoint's deep cache
    # holds raw per-order rows only that deep, so a wider request can't be served.
    max_days = canonical_max_lookback_days()
    days = min(lookback_days or 28, max_days)

    # --- Freshness (cheap disk mtime peek; NEVER opens synthetic data source) ---------------
    # The reasons feed is now SERVE-STALE (see get_enriched_country_late_orders):
    # the request path only READS the deep cache. Freshness is the deep file's age
    # (mtime — cheap, no parse of the giant per-order file) + the newest delivered
    # date (computed once when the response body is built, then cached). A stale /
    # missing file triggers a background warm ONLY when a synthetic data source session is
    # already live (auto_refresh gate); otherwise it reports `initialization_required`.
    scope = f"country_late_reasons:{country_code}"
    inv_prefix = f"country_late_reasons:{LATE_REASONS_CACHE_VERSION}:{country_code}:"
    has_cities = bool(build_country_city_list_sql(country_code))
    deep_path = _late_reasons_deep_path(country_code)
    try:
        mtime = deep_path.stat().st_mtime
        exists = True
    except OSError:
        mtime = None
        exists = False
    age = (time.time() - mtime) if mtime else None
    ttl = get_settings().country_cache_ttl_seconds
    file_needs_warm = has_cities and (
        (not exists) or age is None or (bool(ttl) and age > ttl)
    )

    ck = f"country_late_reasons:{LATE_REASONS_CACHE_VERSION}:{country_code}:{days}"
    cached = cache.get(ck)
    if cached is not None:
        body = cached["body"]
        newest = cached["_newest"]
    else:
        # Shared serve-stale feed: enriched late orders for the whole country
        # (deep-cached rows + the Late-tab flag engine), each tagged with `ui_city`
        # (Ridgeport -> Ridgeport). Empty when the deep cache is cold / the country
        # has no configured cities.
        enriched = get_enriched_country_late_orders(country_code, days)

        newest: Optional[str] = None
        by_city: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        for o in enriched:
            by_city[o.get("ui_city")].append(o)
            d = o.get("delivered_date")
            if d and (newest is None or str(d) > newest):
                newest = str(d)

        cities_out: List[Dict[str, Any]] = []
        for ui_city in sorted(k for k in by_city.keys() if k is not None):
            blocks = build_heavy_large_blocks(by_city[ui_city], with_overlap=False)
            cities_out.append({"city": ui_city, **blocks})

        body = {
            "code": country_code,
            "name": COUNTRY_NAMES.get(country_code, country_code),
            "lookback_days": days,
            "flag_labels": FLAG_LABELS,
            "country": build_heavy_large_blocks(enriched, with_overlap=True),
            "cities": cities_out,
        }
        # Wrap with the precomputed newest date so cache HITS need not re-scan the
        # (huge) enriched list to report freshness.
        cache.set(ck, {"body": body, "_newest": newest}, 600)

    is_stale = file_needs_warm and auto_refresh.is_stale_date(newest)
    if file_needs_warm or force:
        trig = auto_refresh.trigger(
            scope,
            lambda report: _warm_country_late_reasons(country_code, max_days, report),
            total=1,
            invalidate_prefixes=[inv_prefix],
            force=force,
        )
    else:
        trig = auto_refresh.reflect(scope)
    freshness = auto_refresh.build_freshness(
        scope, stale=is_stale, newest_date=newest, trig=trig, cache_age_seconds=age,
    )
    return {**body, "_freshness": freshness}
