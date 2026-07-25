from __future__ import annotations

from fastapi import APIRouter, Query

from app.config import get_settings
from app.services.synthetic_data import read_plain_cached
from app.services.data_processor import deduplicate_orders
from app.services.cache import cache

router = APIRouter(prefix="/api/rotten-orders", tags=["rotten-orders"])


@router.get("")
def get_delayed_orders(
    city: str = Query(default=None),
    lookback_days: int = Query(default=7, ge=1, le=365),
):
    s = get_settings()
    city = city or s.default_city
    ck = f"delayed_orders:{city}:{lookback_days}"
    cached = cache.get(ck)
    if cached:
        return cached

    rows = read_plain_cached("delayed_orders.dataset", {
        "city": city,
        "lookback_days": lookback_days,
        "rotten_threshold_min": s.rotten_threshold_min,
    }) or []
    rows = deduplicate_orders(rows)
    result = {"orders": rows, "total": len(rows)}
    cache.set(ck, result, s.cache_ttl_seconds)
    return result


@router.get("/summary")
def get_rotten_summary(
    city: str = Query(default=None),
    lookback_days: int = Query(default=7, ge=1, le=365),
):
    s = get_settings()
    city = city or s.default_city
    rows = read_plain_cached("rotten_summary.dataset", {
        "city": city,
        "lookback_days": lookback_days,
        "rotten_threshold_min": s.rotten_threshold_min,
    }) or []
    return {"summary": rows}
