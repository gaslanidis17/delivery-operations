from __future__ import annotations

from fastapi import APIRouter, Query

from app.config import get_settings
from app.services.synthetic_data import read_plain_cached
from app.services.cache import cache

router = APIRouter(prefix="/api/map", tags=["map"])


@router.get("/venues")
def get_venue_map(
    city: str = Query(default=None),
    lookback_days: int = Query(default=7, ge=1, le=365),
):
    s = get_settings()
    city = city or s.default_city
    ck = f"map_venues:{city}:{lookback_days}"
    cached = cache.get(ck)
    if cached:
        return cached

    rows = read_plain_cached("map_venues.dataset", {
        "city": city,
        "lookback_days": lookback_days,
    }) or []
    result = {"venues": rows, "total": len(rows)}
    cache.set(ck, result, s.cache_ttl_seconds)
    return result


@router.get("/dropoffs")
def get_dropoff_map(
    city: str = Query(default=None),
    lookback_days: int = Query(default=7, ge=1, le=365),
):
    s = get_settings()
    city = city or s.default_city
    ck = f"map_dropoffs:{city}:{lookback_days}"
    cached = cache.get(ck)
    if cached:
        return cached

    rows = read_plain_cached("map_dropoffs.dataset", {
        "city": city,
        "lookback_days": lookback_days,
    }) or []
    result = {"hexagons": rows, "total": len(rows)}
    cache.set(ck, result, s.cache_ttl_seconds)
    return result


@router.get("/hourly")
def get_hourly_distribution(
    city: str = Query(default=None),
    lookback_days: int = Query(default=7, ge=1, le=365),
):
    s = get_settings()
    city = city or s.default_city
    rows = read_plain_cached("hourly_distribution.dataset", {
        "city": city,
        "lookback_days": lookback_days,
    }) or []
    return {"hourly": rows}
