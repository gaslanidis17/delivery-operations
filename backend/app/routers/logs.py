from __future__ import annotations

from fastapi import APIRouter, Query

from app.services.activity_log import get_recent, get_stats

router = APIRouter(prefix="/api/logs", tags=["logs"])


@router.get("/recent")
def recent_logs(
    limit: int = Query(default=200, ge=1, le=2000),
    category: str = Query(default=None),
):
    return {"logs": get_recent(limit=limit, category=category)}


@router.get("/stats")
def log_stats():
    return get_stats()
