"""AI Venue Diagnostic endpoints (TTLA tab).

Deterministic per-venue evidence-pack scorecard (Phase 2) + freshness probe.
The LLM synthesis + multi-venue job queue live in later phases and share this
router. All reads are cache-only (sign-in-safe); a miss serves what's available and
kicks off an sign-in-gated background warm via ``scorecard_freshness``.
"""

from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from app.config import get_settings
from app.services.cache import cache
from app.services.ttla_filters import norm_order_type
from app.services import venue_diagnostics as vd

router = APIRouter(prefix="/api/ttla/venue-diagnostics", tags=["venue-diagnostics"])

# 6h TTL for the LLM diagnosis (deterministic enough over a window; the LLM call
# is the expensive part). Only successful structured results are cached.
AI_CACHE_TTL_SECONDS = 6 * 3600


def _ck(kind: str, venue_id: str, city: str, lookback_days: int, sfx: str) -> str:
    return f"venue_diag:{kind}:{vd.CACHE_VERSION}:{city}:{venue_id}:{lookback_days}:{sfx}"


@router.get("/freshness")
def get_freshness(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    order_type: str = Query(default="regular"),
    complete_weeks: int = Query(default=None, ge=1, le=53),
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
    force: bool = Query(default=False),
):
    """Serve-stale freshness probe + sign-in-gated background warm for the four venue
    diagnostic caches, scoped to the current city + global filter set."""
    return {"_freshness": vd.scorecard_freshness(
        city, lookback_days, order_type, complete_weeks, date_from, date_to, force
    )}


@router.get("/scorecard")
def get_scorecard(
    venue_id: str = Query(...),
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    order_type: str = Query(default="regular"),
    complete_weeks: int = Query(default=None, ge=1, le=53),
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
):
    """The six deterministic evidence packs + data-quality gate for ONE venue.
    Cache-only read (never queries synthetic data source); numbers only, no LLM."""
    disp_city, _country, _wh = vd.rt._resolve(city)
    ot = norm_order_type(order_type)
    sfx = vd._suffix(ot, complete_weeks, date_from, date_to) or "all"
    ck = _ck("scorecard", str(venue_id), disp_city, lookback_days, sfx)
    cached = cache.get(ck)
    if cached:
        return cached

    result = vd.build_packs(
        venue_id, city, lookback_days, ot, complete_weeks, date_from, date_to
    )
    cache.set(ck, result, get_settings().cache_ttl_seconds)
    return result


@router.get("/diagnose")
async def diagnose_venue(
    venue_id: str = Query(...),
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    order_type: str = Query(default="regular"),
    complete_weeks: int = Query(default=None, ge=1, le=53),
    date_from: str = Query(default=None),
    date_to: str = Query(default=None),
):
    """Full single-venue diagnostic: evidence packs + ONE structured LLM synthesis.
    Success-only 6h cache; the packs are ALWAYS returned (numbers render even when
    the LLM fails); a thin venue returns an 'insufficient_data' report with no LLM
    call."""
    disp_city, _country, _wh = vd.rt._resolve(city)
    ot = norm_order_type(order_type)
    sfx = vd._suffix(ot, complete_weeks, date_from, date_to) or "all"
    ck = f"venue_ai:{vd.AI_CACHE_VERSION}:{disp_city}:{venue_id}:{lookback_days}:{sfx}"
    cached = cache.get(ck)
    if cached:
        return {**cached, "cached": True}

    packs_result = await run_in_threadpool(
        vd.build_packs, venue_id, city, lookback_days, ot, complete_weeks, date_from, date_to
    )
    result = await vd.synthesize_venue(packs_result)
    result["cached"] = False

    # Only cache a successful structured diagnosis (transient LLM failures retry).
    if result.get("status") == "completed" and result.get("analysis") is not None:
        cache.set(ck, result, AI_CACHE_TTL_SECONDS)
    return result


class JobRequest(BaseModel):
    venue_ids: List[str] = Field(..., description="Venue ids to diagnose (capped per job)")
    city: Optional[str] = None
    lookback_days: int = 28
    order_type: str = "regular"
    complete_weeks: Optional[int] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    deep: bool = Field(default=False, description="Add an aggregate analysis of fictional support-note themes")


@router.post("/jobs")
def create_job(req: JobRequest):
    """Start a multi-venue diagnostic job (venues processed sequentially, isolated).
    Returns the initial job snapshot with a job_id to poll. ``deep`` enables an
    aggregate analysis of fictional support-note themes."""
    if not req.venue_ids:
        raise HTTPException(status_code=400, detail="venue_ids is required")
    return vd.start_job(
        req.venue_ids, req.city, req.lookback_days, norm_order_type(req.order_type),
        req.complete_weeks, req.date_from, req.date_to, req.deep,
    )


@router.get("/jobs/{job_id}")
def poll_job(job_id: str):
    """Poll a diagnostic job: per-venue {status, packs, analysis, error}."""
    job = vd.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown job_id")
    return job


class FeedbackRequest(BaseModel):
    venue_id: str
    rating: str = Field(..., description="'up' or 'down'")
    city: Optional[str] = None
    lookback_days: Optional[int] = None
    order_type: Optional[str] = None
    comment: Optional[str] = None


@router.post("/feedback")
def submit_feedback(req: FeedbackRequest, request: Request):
    """Capture a thumbs up/down (+ optional note) on a venue diagnosis (append-only
    JSONL). Powers a future diagnostic-quality review."""
    username = getattr(request.state, "username", None)
    try:
        return vd.record_feedback(
            req.venue_id, req.rating, city=req.city, lookback_days=req.lookback_days,
            order_type=req.order_type, comment=req.comment, username=username,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
