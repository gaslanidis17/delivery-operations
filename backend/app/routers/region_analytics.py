from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query

from app.config import (
    get_settings,
    canonical_max_lookback_days,
    COUNTRY_NAMES,
    CITY_OPERATIONS_AREA_ALIAS_REVERSE,
    ttla_target_sec,
)
from app.services.synthetic_data import execute_query, read_canonical_cached
from app.services.cache import cache
from app.services import auto_refresh
from app.services.ttla_filters import (
    norm_ttla_mode,
    ttla_mode_fragments,
    ttla_mode_suffix,
    country_ttla_population_clause,
    TTLA_MODE_DEFAULT,
)

router = APIRouter(prefix="/api/region", tags=["region-analytics"])

# Bump this whenever the response shape changes (e.g. new DATASET keys are added)
# so cache entries written by an older version can never be served. Bumped to
# v2 when the shared country-master/Region disk cache became window-aware +
# freshness-aware (deep canonical files, see synthetic_data.execute_query).
# v3 added the ADT (Average Delivery Time) source (adt_total) to every country
# and city. v4: responses now carry a `_freshness` block and the in-memory entry
# is wrapped ({data,_stale,_newest}) for the auto-refresh-on-tab-open path.
# v5 added the TTLA (Task to Last Accept) source (ttla_total) + a per-country
# `ttla_target_sec` to every country and city.
# v6: the Region tab's TTLA panel now honors a TTLA-calculation-logic MODE filter
# (ttla_mode query param — default | first_courier | fixed) placed INSIDE the
# TTLA panel (not the top filter bar). The mode is encoded into BOTH the on-disk
# cache_suffix for country_ttla_total.dataset (overview) + country_ttla_by_city.dataset
# (city drill-down) — default adds no suffix so existing files stay valid — AND
# the in-memory overview/cities cache keys (so a mode switch rebuilds from disk).
# country_ttla_by_city.dataset is now parameterized too (it was default-only before).
CACHE_VERSION = "v6"

# Country-wide daily DATASET fanned out across every country for the Region tab.
# These reuse the Country master endpoint's params (and therefore its disk
# cache), so warming the country master also warms the Region tab. country_adt_*
# (ADT/Average Delivery Time) and country_ttla_* (TTLA/Task to Last Accept) are
# average-seconds metrics that share the same synthetic_jobs spine, drive-exclusion
# and deep-cache mechanism as the others.
REGION_DATASET_FILES = [
    "country_daily_rates_total.dataset",
    "country_hl_lateness_total.dataset",
    "country_clone_rate_total.dataset",
    "country_adt_total.dataset",
    "country_ttla_total.dataset",
]

# Per-city versions of the country-wide daily DATASET files (same synthetic_jobs
# spine, GROUP BY venue_operations_area). Used by the Region tab's city
# drill-down. The output key each one pivots into mirrors the RegionCountry
# shape so the frontend reuses buildMetricModel unchanged.
REGION_CITY_DATASET: Dict[str, str] = {
    "country_daily_rates_by_city.dataset": "daily_rates_total",
    "country_hl_lateness_by_city.dataset": "hl_lateness_total",
    "country_clone_rate_by_city.dataset": "clone_rate_total",
    "country_adt_by_city.dataset": "adt_total",
    "country_ttla_by_city.dataset": "ttla_total",
}


def _warm_region_overview(max_days: int, ttla_mode: str = TTLA_MODE_DEFAULT, report=auto_refresh.NOOP_PROGRESS) -> None:
    """Background warm for the Region overview deep cache.

    Re-queries (at canonical MAX depth) only the (country, DATASET) deep files that
    are currently stale/short, leaving fresh ones untouched. Self-contained so it
    works whether triggered from the assemble path or a cache hit. Gated by
    ``auto_refresh.trigger`` so it only runs when a synthetic data source connection is live.

    ``ttla_mode`` warms ``country_ttla_total.dataset`` with the selected
    TTLA-calculation logic (default | first_courier | fixed): the ttla total file
    gets the mode's fragments (CTE country-scoped) + a mode-specific cache_suffix
    (``tm-first``/``tm-fixed``; default adds none → reuses the default deep file).
    The other REGION_DATASET_FILES are mode-independent.

    ``report`` advances one step per (country, DATASET) pair EXAMINED — including the
    already-fresh ones it skips — so ``total`` = countries × files and the bar
    sweeps smoothly (a skipped-because-fresh file just ticks by instantly).
    """
    settings = get_settings()
    rotten_threshold_min = settings.rotten_threshold_min
    mode_suffix = ttla_mode_suffix(ttla_mode)
    # NOTE: the ttla frags are built PER-COUNTRY inside the loop (not once outside)
    # because the `tg_per_purchase` helper CTE embeds `fp.venue_country = '{country}'`
    # in its semi-join scoping — building them once with country="" would scope the
    # CTE to `venue_country = ''` (matches nothing) and the warm would write EMPTY
    # tm-first/tm-fixed files, leaving the TTLA panel permanently blank. (Default
    # mode ignores country so it was unaffected — only first_courier/fixed were.)
    pop_clause = country_ttla_population_clause(max_days)
    for code in COUNTRY_NAMES:
        params = {
            "country": code,
            "lookback_days": max_days,
            "city": f"__country_{code}",
            "rotten_threshold_min": rotten_threshold_min,
        }
        ttla_frags = ttla_mode_fragments(ttla_mode, code, None, pop_clause)
        for dataset_key in REGION_DATASET_FILES:
            if dataset_key == "country_ttla_total.dataset":
                _rows, fresh, _meta = read_canonical_cached(
                    dataset_key, f"__country_{code}", max_days, cache_suffix=mode_suffix,
                )
            else:
                _rows, fresh, _meta = read_canonical_cached(
                    dataset_key, f"__country_{code}", max_days,
                )
            if not fresh:
                if dataset_key == "country_ttla_total.dataset":
                    p = {**params, **ttla_frags}
                    execute_query(dataset_key, p, canonical_max_days=max_days, cache_suffix=mode_suffix)
                else:
                    execute_query(dataset_key, params, canonical_max_days=max_days)
            report.step()


def _warm_region_country_cities(country_code: str, max_days: int, ttla_mode: str = TTLA_MODE_DEFAULT, report=auto_refresh.NOOP_PROGRESS) -> None:
    """Background warm for one country's Region city-drilldown deep cache.

    ``ttla_mode`` warms ``country_ttla_by_city.dataset`` with the selected
    TTLA-calculation logic (default | first_courier | fixed): the by-city ttla
    file gets the mode's fragments (CTE country-scoped, city=None since by-city
    covers ALL operations areas) + a mode-specific cache_suffix so each mode's
    deep file is independent (default adds none → reuses the existing deep file).
    The other REGION_CITY_DATASET files are mode-independent.

    ``report`` advances one step per by-city file examined (fresh files tick by)."""
    settings = get_settings()
    mode_suffix = ttla_mode_suffix(ttla_mode)
    ttla_frags = ttla_mode_fragments(
        ttla_mode, country_code, None, country_ttla_population_clause(max_days),
    )
    params = {
        "country": country_code,
        "lookback_days": max_days,
        "city": f"__country_{country_code}",
        "rotten_threshold_min": settings.rotten_threshold_min,
    }
    ttla_params = {**params, **ttla_frags}
    for dataset_key in REGION_CITY_DATASET:
        if dataset_key == "country_ttla_by_city.dataset":
            _rows, fresh, _meta = read_canonical_cached(
                dataset_key, f"__country_{country_code}", max_days, cache_suffix=mode_suffix,
            )
        else:
            _rows, fresh, _meta = read_canonical_cached(
                dataset_key, f"__country_{country_code}", max_days,
            )
        if not fresh:
            if dataset_key == "country_ttla_by_city.dataset":
                execute_query(dataset_key, ttla_params, canonical_max_days=max_days, cache_suffix=mode_suffix)
            else:
                execute_query(dataset_key, params, canonical_max_days=max_days)
        report.step()


@router.get("/overview")
def get_region_overview(
    lookback_days: int = Query(default=84, ge=1, le=365),
    ttla_mode: str = Query(default="default"),
    force: bool = Query(default=False),
):
    """Compare every country side by side over the same window.

    For each country we read the country-wide daily DATASET files (total
    lateness/rotten rates, heavy/large lateness, clone rate, ADT) and return the
    raw daily rows. The frontend buckets them by day/week/month client-side.

    ``ttla_mode`` (default | first_courier | fixed) selects the TTLA-calculation
    logic for the TTLA panel: only ``country_ttla_total.dataset`` is mode-specific
    (read/warmed with a ``tm-*`` cache_suffix); the other REGION_DATASET_FILES are
    mode-independent. The in-memory overview cache key carries the mode so a mode
    switch rebuilds from disk.

    Auto-refresh: rather than block on a live MAX-depth re-query when a deep file
    is stale (which could pop sign-in), we serve the existing (possibly stale) deep
    rows immediately, flag staleness in ``_freshness``, and kick off an sign-in-safe
    background warm so the client can re-poll for the fresh result.
    """
    # Clamp to the canonical (month-anchored) window — the deep cache never holds
    # more than this, so nothing can request beyond it.
    max_days = canonical_max_lookback_days()
    lookback_days = min(lookback_days, max_days)
    tm = norm_ttla_mode(ttla_mode)
    mode_suffix = ttla_mode_suffix(tm)

    scope = "region_overview"
    inv_prefix = f"region_overview:{CACHE_VERSION}:"
    # In-memory overview cache key carries the TTLA mode so a mode switch
    # rebuilds from disk. The on-disk ttla total file is mode-suffixed (default
    # adds none → reuses the existing deep file); the other files are mode-
    # independent (shared across modes).
    ck = f"region_overview:{CACHE_VERSION}:{lookback_days}:{mode_suffix or 'def'}"

    cached = cache.get(ck)
    if cached is not None:
        countries = cached["data"]
        needs_warm = cached["_needs_warm"]
        newest = cached["_newest"]
        data_missing = cached.get("_data_missing", False)
    else:
        settings = get_settings()
        rotten_threshold_min = settings.rotten_threshold_min

        countries = []
        needs_warm = False
        # `data_missing` = a deep file is ENTIRELY absent (rows=None), not just
        # TTL-stale/short. A freshly-added source (e.g. country_ttla_total.dataset)
        # whose file was never warmed lands here even when the older files read
        # fresh — it MUST flag the tab stale (below) so the banner/poll appear and
        # a sign-in re-warms it (the date check reads "fresh" off daily_rates).
        data_missing = False
        per_country_newest: List[Optional[str]] = []
        for code, name in COUNTRY_NAMES.items():
            entry: Dict[str, Any] = {
                "code": code,
                "name": name,
                # Static per-country TTLA target (seconds) or None — the frontend
                # colours the country's TTLA vs this. Safe to embed in the cached
                # entry (config-static; CACHE_VERSION covers the shape change).
                "ttla_target_sec": ttla_target_sec(code),
            }
            for dataset_key in REGION_DATASET_FILES:
                key = dataset_key.replace("country_", "").replace(".dataset", "")
                # Non-blocking serve-stale: read the deep file (trimmed) WITHOUT a
                # live re-query; flag if missing/stale/short of the window.
                if dataset_key == "country_ttla_total.dataset":
                    rows, fresh, _meta = read_canonical_cached(
                        dataset_key, f"__country_{code}", lookback_days,
                        cache_suffix=mode_suffix,
                    )
                else:
                    rows, fresh, _meta = read_canonical_cached(
                        dataset_key, f"__country_{code}", lookback_days,
                    )
                entry[key] = rows or []
                if not fresh:
                    needs_warm = True
                if rows is None:
                    data_missing = True
            # Per-country newest (country-level totals are dense — a date behind
            # yesterday reliably means that country's snapshot is behind).
            per_country_newest.append(auto_refresh.max_date(entry.get("daily_rates_total", [])))
            countries.append(entry)
        # Report the MOST-BEHIND country's date: the side-by-side tab is only as up
        # to date as its laggard. Using the global max here would read as "yesterday"
        # even while one country is behind, contradicting the stale flag.
        newest = auto_refresh.oldest_date(per_country_newest)
        cache.set(
            ck,
            {"data": countries, "_needs_warm": needs_warm, "_newest": newest, "_data_missing": data_missing},
            600,
        )

    # Banner staleness is DATE-based (most-behind country behind yesterday) OR
    # coverage-based (`data_missing` — a source file is entirely absent, e.g. a
    # freshly-added metric never warmed). The missing-file case can't rely on the
    # date check (dense daily_rates still reaches yesterday); without it a cold
    # metric shows empty with no banner/progress and sign-in wouldn't warm it.
    is_stale = data_missing or (needs_warm and auto_refresh.is_stale_date(newest))
    if needs_warm or force:
        trig = auto_refresh.trigger(
            scope,
            lambda report: _warm_region_overview(max_days, tm, report),
            total=len(COUNTRY_NAMES) * len(REGION_DATASET_FILES),
            invalidate_prefixes=[inv_prefix],
            force=force,
        )
    else:
        trig = auto_refresh.reflect(scope)
    freshness = auto_refresh.build_freshness(
        scope, stale=is_stale, newest_date=newest, trig=trig,
    )
    return {"countries": countries, "lookback_days": lookback_days, "_freshness": freshness}


@router.get("/country/{country_code}/cities")
def get_region_country_cities(
    country_code: str,
    lookback_days: int = Query(default=84, ge=1, le=365),
    ttla_mode: str = Query(default="default"),
    force: bool = Query(default=False),
):
    """City drill-down for one country in the Region tab.

    Runs the per-city daily DATASET files (total lateness/rotten, heavy/large
    lateness, clone rate, ADT, TTLA) for the given country over the same window as
    the overview, then pivots the flat ``city``-tagged rows into per-city arrays.
    Each city object mirrors the RegionCountry shape (``city`` in place of
    code/name) so the frontend reuses ``buildMetricModel`` unchanged; summing all
    cities per metric reconciles EXACTLY to the country-total row served by
    ``/overview`` (same spine, same WHERE, all operations areas kept).

    ``ttla_mode`` (default | first_courier | fixed) selects the TTLA-calculation
    logic: only ``country_ttla_by_city.dataset`` is mode-specific (read/warmed with a
    ``tm-*`` cache_suffix); the other REGION_CITY_DATASET files are mode-independent.
    The in-memory cities cache key carries the mode so a mode switch rebuilds.
    """
    code = country_code.upper()
    name = COUNTRY_NAMES.get(code, code)

    # Clamp to the canonical (month-anchored) window so cities can never request
    # beyond what the shared deep cache holds.
    max_days = canonical_max_lookback_days()
    lookback_days = min(lookback_days, max_days)
    tm = norm_ttla_mode(ttla_mode)
    mode_suffix = ttla_mode_suffix(tm)

    scope = f"region_cities:{code}"
    inv_prefix = f"region_cities:{CACHE_VERSION}:{code}:"
    # In-memory cities cache key carries the TTLA mode so a mode switch rebuilds
    # from disk. The on-disk ttla by-city file is mode-suffixed (default adds none
    # → reuses the existing deep file); the other by-city files are mode-
    # independent (shared across modes).
    ck = f"region_cities:{CACHE_VERSION}:{code}:{lookback_days}:{mode_suffix or 'def'}"

    cached = cache.get(ck)
    if cached is not None:
        city_list = cached["data"]
        needs_warm = cached["_needs_warm"]
        newest = cached["_newest"]
        data_missing = cached.get("_data_missing", False)
    else:
        # city display name -> {source_key -> [rows without the city column]}
        cities: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}

        def _bucket(city_name: str) -> Dict[str, List[Dict[str, Any]]]:
            return cities.setdefault(
                city_name,
                {
                    "daily_rates_total": [],
                    "hl_lateness_total": [],
                    "clone_rate_total": [],
                    "adt_total": [],
                    "ttla_total": [],
                },
            )

        needs_warm = False
        # `data_missing` = a by-city deep file is ENTIRELY absent (rows=None), not
        # just TTL-stale/short — e.g. a freshly-added metric (country_ttla_by_city)
        # never warmed. It MUST flag the drill-down stale (below) so opening it
        # shows the banner/progress and a sign-in re-warms it.
        data_missing = False
        for dataset_key, source_key in REGION_CITY_DATASET.items():
            # Non-blocking serve-stale: read the deep by-city file WITHOUT a live
            # re-query; the background warm refreshes any stale/short file.
            if dataset_key == "country_ttla_by_city.dataset":
                rows, fresh, _meta = read_canonical_cached(
                    dataset_key, f"__country_{code}", lookback_days,
                    cache_suffix=mode_suffix,
                )
            else:
                rows, fresh, _meta = read_canonical_cached(
                    dataset_key, f"__country_{code}", lookback_days,
                )
            if not fresh:
                needs_warm = True
            if rows is None:
                data_missing = True
            for raw in (rows or []):
                warehouse_city = raw.get("city") or "Unknown"
                # R1 comes back as "Ridgeport" from venue_operations_area;
                # reverse the alias so the UI shows "Ridgeport".
                display_city = CITY_OPERATIONS_AREA_ALIAS_REVERSE.get(
                    warehouse_city, warehouse_city
                )
                row_out = {k: v for k, v in raw.items() if k != "city"}
                _bucket(display_city)[source_key].append(row_out)

        city_list = [
            {"city": city_name, **sources} for city_name, sources in cities.items()
        ]
        # Stable order (frontend re-ranks per metric anyway).
        city_list.sort(key=lambda c: c["city"])

        # File-level newest (MAX across all cities): the by-city files are warmed
        # as one unit, so the latest row date = yesterday when fresh. We use MAX
        # (not per-city min) so a small city with no orders yesterday doesn't get
        # mistaken for stale data.
        newest = auto_refresh.max_date(
            [r for c in city_list for r in c.get("daily_rates_total", [])]
        )
        cache.set(
            ck,
            {"data": city_list, "_needs_warm": needs_warm, "_newest": newest, "_data_missing": data_missing},
            600,
        )

    # Banner staleness is DATE-based (newest behind yesterday) OR coverage-based
    # (`data_missing` — a by-city source file entirely absent, e.g. a freshly-added
    # metric never warmed). `needs_warm` (TTL/coverage) still drives the background
    # warm. So a drill-down warmed today reads FRESH even inside the 24h TTL.
    is_stale = data_missing or (needs_warm and auto_refresh.is_stale_date(newest))
    if needs_warm or force:
        trig = auto_refresh.trigger(
            scope,
            lambda report: _warm_region_country_cities(code, max_days, tm, report),
            total=len(REGION_CITY_DATASET),
            invalidate_prefixes=[inv_prefix],
            force=force,
        )
    else:
        trig = auto_refresh.reflect(scope)
    freshness = auto_refresh.build_freshness(
        scope, stale=is_stale, newest_date=newest, trig=trig,
    )

    return {
        "code": code,
        "name": name,
        "lookback_days": lookback_days,
        # Cities compare their TTLA against the COUNTRY target (the reference for
        # the whole drill-down), so it is exposed once at the top level.
        "ttla_target_sec": ttla_target_sec(code),
        "cities": city_list,
        "_freshness": freshness,
    }
