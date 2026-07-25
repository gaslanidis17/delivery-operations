from __future__ import annotations

from datetime import date
from functools import lru_cache
from typing import Optional

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # The public portfolio build supports deterministic synthetic data only.
    data_source: str = "synthetic"

    # AI
    # gpt-5 is the mid-tier all-rounder; override via env (LITELLM_MODEL) to pick
    # e.g. gpt-5.5 / gpt-5.4-mini, or a non-OpenAI model litellm supports.
    litellm_model: str = "gpt-5"
    litellm_api_key: str = ""
    # GPT-5 reasoning models use `reasoning_effort` (none/low/medium/high) instead
    # of `temperature`. "low" keeps these simple summaries fast/cheap; LiteLLM
    # (drop_params=True) silently ignores it on non-reasoning models (e.g. gpt-4o).
    litellm_reasoning_effort: str = "low"
    # Max OUTPUT tokens. For gpt-5 reasoning models the (hidden) reasoning tokens
    # are charged against this budget, so it must sit well above the visible
    # answer or the response truncates to empty. LiteLLM maps `max_tokens` ->
    # `max_completion_tokens` automatically for gpt-5; gpt-4o* keep `max_tokens`.
    litellm_max_output_tokens: int = 2000

    # Country "big analysis" panel (ai_country router). These richer, structured
    # analyses use a separate (higher) reasoning_effort + output budget than the
    # quick free-text summaries above, both env-overridable. "medium" reasoning
    # gives deeper multi-city/reason synthesis; the larger token budget keeps the
    # JSON-schema output from truncating once hidden reasoning tokens are charged
    # against it. Inherited model is still `litellm_model` (gpt-5).
    litellm_analysis_reasoning_effort: str = "medium"
    litellm_analysis_max_output_tokens: int = 6000

    # App
    default_city: str = "Ridgeport"
    cache_ttl_seconds: int = 600
    cors_origins: str = "*"

    # Network / region deep disk cache (see synthetic_data canonical mode).
    # The canonical depth is NO LONGER a fixed 365: it is a rolling, MONTH-ANCHORED
    # window = "current month-to-date + canonical_complete_months complete calendar
    # months before it", resolved dynamically by canonical_max_lookback_days()
    # (the single source of truth — see below). All deep-cache call sites use that
    # helper; nothing queries/holds a fixed year any more.
    # canonical_complete_months: how many COMPLETE calendar months precede the
    #   current (partial) month in the canonical window. 6 → "this month so far +
    #   the previous 6 full months" (~199 days as of mid-June, grows through the
    #   month, steps to a new month-start on the 1st). Configurable.
    # region_max_lookback_days: an ABSOLUTE hard ceiling (safety cap) the dynamic
    #   helper is clamped under, and the generous outer bound for the API's le=
    #   validators. With 6 complete months the window tops out ~214d, so 365 never
    #   binds in normal use; raise it only if canonical_complete_months ≳ 11.
    # country_cache_ttl_seconds: how long a deep file is trusted before it is
    #   re-queried. 24h fits the data cadence — the DATASET excludes today
    #   (time_confirmed_utc < CURRENT_DATE()), so the newest complete day is
    #   yesterday and only changes once per day; this keeps the recent edge fresh
    #   without re-hitting synthetic data source on every page load. Admin "Update Data"
    #   still forces an immediate deep refresh.
    canonical_complete_months: int = 6
    region_max_lookback_days: int = 365
    country_cache_ttl_seconds: int = 86400

    # Lateness flag thresholds
    venue_late_threshold: float = 300
    venue_early_threshold: float = -300
    courier_wait_threshold: float = 300
    slow_pickup_buffer_min: float = 10
    rotten_threshold_min: int = 20
    long_distance_threshold_m: float = 5000
    restaurant_slow_threshold_min: float = 30
    eta_error_threshold_sec: float = 600
    low_acceptance_shown_min: int = 5

    # Courier speed targets (km/h) for slow travel detection
    # These are starting defaults; refine after running speed benchmark
    courier_speed_targets: dict = {
        "car": 15.0,
        "ecar": 15.0,
        "motorcycle": 15.0,
        "emotorcycle": 15.0,
        "scooter": 12.0,
        "bicycle": 10.0,
        "walking": 5.0,
    }
    courier_slow_travel_buffer: float = 1.5  # multiplier: flag if travel_time > target * buffer

    # Fictional weight-tier costs used by the synthetic scenario.
    weight_tier_costs: dict = {
        "WEIGHT_L": 0.50,
        "WEIGHT_XL": 1.00,
        "WEIGHT_XXL": 1.50,
        "WEIGHT_XXXL": 2.00,
    }

    # Venue performance
    venue_problem_score_min_orders: int = 5

    # Supported cities
    supported_cities: list[str] = [
        "Ridgeport", "Millstead", "Summerton",
        "Harbor Junction", "Tide Market", "Bay Loop",
        "Plateau Nine", "Crest Line", "Valley Gate",
        "Circuit City", "Grid North", "Axis Point",
    ]

    class Config:
        env_file = ("../.env", ".env")
        env_file_encoding = "utf-8"
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


def canonical_max_lookback_days(today: Optional[date] = None) -> int:
    """Single source of truth for the canonical deep-cache depth (in days).

    The canonical window is "current month-to-date + N complete calendar months
    before it", where N = ``Settings.canonical_complete_months``:

      start = the FIRST day of the month that is N months before the current
              month (with year borrow, e.g. current March → 6 months back =
              September of the previous year).
      end   = today, EXCLUSIVE — the deep DATASET already filters
              ``time_confirmed_utc < CURRENT_DATE()``, so the window runs through
              yesterday.

    Returns ``(today - start).days``, computed DYNAMICALLY: it grows by one each
    day and steps back to a fresh month-start on the 1st. As of 2026-06-18 with
    N=6 this is 199 (start = 2025-12-01). The result is clamped to
    ``region_max_lookback_days`` as an absolute safety ceiling.

    MUST be called at request/warm time (never memoized at import), so the window
    tracks the current date. ``today`` is injectable for offline unit tests.
    """
    settings = get_settings()
    if today is None:
        today = date.today()

    months = settings.canonical_complete_months
    # Walk back `months` whole months from the current month, borrowing years.
    year, month = today.year, today.month - months
    while month <= 0:
        month += 12
        year -= 1
    start = date(year, month, 1)

    days = (today - start).days
    return min(days, settings.region_max_lookback_days)


CITY_DATA = [
    # These points form an artificial grid; none is copied from a real city,
    # facility, customer, or delivery zone.
    {"name": "Ridgeport", "country": "R1", "lat": 2.0, "lon": -5.0, "zoom": 8},
    {"name": "Millstead", "country": "R1", "lat": 3.0, "lon": -3.0, "zoom": 8},
    {"name": "Summerton", "country": "R1", "lat": 1.0, "lon": -1.0, "zoom": 8},
    {"name": "Harbor Junction", "country": "R2", "lat": -1.0, "lon": 2.0, "zoom": 8},
    {"name": "Tide Market", "country": "R2", "lat": -2.0, "lon": 4.0, "zoom": 8},
    {"name": "Bay Loop", "country": "R2", "lat": 0.0, "lon": 6.0, "zoom": 8},
    {"name": "Plateau Nine", "country": "R3", "lat": 5.0, "lon": 1.0, "zoom": 8},
    {"name": "Crest Line", "country": "R3", "lat": 6.0, "lon": 3.0, "zoom": 8},
    {"name": "Valley Gate", "country": "R3", "lat": 4.0, "lon": 5.0, "zoom": 8},
    {"name": "Circuit City", "country": "R4", "lat": -5.0, "lon": -4.0, "zoom": 8},
    {"name": "Grid North", "country": "R4", "lat": -4.0, "lon": -2.0, "zoom": 8},
    {"name": "Axis Point", "country": "R4", "lat": -6.0, "lon": 0.0, "zoom": 8},
]

COUNTRY_NAMES = {
    "R1": "Region One — Inland",
    "R2": "Region Two — Coastal",
    "R3": "Region Three — Highland",
    "R4": "Region Four — Metro",
}

# Per-country TTLA (Task to Last Accept) targets, in SECONDS. PLACEHOLDER — the
# real numbers are supplied later; every value is None for now.
#
# TTLA is the average seconds before the courier who ultimately completes pickup
# accepted the task (see country_ttla_total.dataset). The dashboard renders a TTLA
# target indicator (value coloured good/bad vs target) ONLY when a country's
# target is set; when it is None the TTLA value renders with no target styling,
# so the feature works fine before any numbers are filled in.
#
# TO PLUG IN A REAL TARGET: set that country's value to the target seconds — one
# line each, e.g. "R1": 180. `ttla_target_sec()` is the single read path used by
# the Region / Country / per-city responses. Keyed by the dashboard's 8 supported
# countries (the COUNTRY_NAMES set: R6 R5 R2 R3 R4 R1 R8 R7).
TTLA_TARGETS_SEC: dict[str, Optional[float]] = {
    "R1": 174,
    "R2": 166,
    "R3": 198,
    "R4": 142,
}


def ttla_target_sec(country_code: Optional[str]) -> Optional[float]:
    """The configured TTLA target (seconds) for a country, or None if unset.

    Single source of truth read by every TTLA response (Region overview, Region
    city drill-down, Country master, per-city analytics). Returns None for an
    unknown/blank code or an unset (placeholder) target, in which case the UI
    renders the TTLA value without target styling.
    """
    if not country_code:
        return None
    return TTLA_TARGETS_SEC.get(country_code.upper())


# NOTE: TTLA venue-type (Restaurant vs Retail) classification now uses the
# authoritative synthetic job records.product_line_category column directly in
# the ttla_*.dataset files (same segment column as the Retail-TTLA tab) — no config
# mapping or public.venues join is involved.
CITY_COUNTRY_MAP: dict[str, str] = {c["name"]: c["country"] for c in CITY_DATA}

# Some cities are stored in the synthetic data source warehouse under a different name than
# the display name shown in the UI. This maps the UI display city name to the
# warehouse value used by `fp.venue_operations_area` (country tab DATASET) and
# `public.venues.city` (e.g. city_weight_perf). Only mismatches are listed;
# everything else matches verbatim. Verified against synthetic job records
# and public.venues (last 28 days) — only Ridgeport differs for R1.
CITY_OPERATIONS_AREA_ALIAS: dict[str, str] = {}

CITY_OPERATIONS_AREA_ALIAS_REVERSE: dict[str, str] = {
    v: k for k, v in CITY_OPERATIONS_AREA_ALIAS.items()
}
