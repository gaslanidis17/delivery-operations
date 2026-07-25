from __future__ import annotations

from fastapi import APIRouter

from app.services.synthetic_data import connect_and_ping, connection_is_live

router = APIRouter(prefix="/api/data-source", tags=["synthetic-data"])


@router.get("/status")
def data_source_status():
    """Report whether the bundled synthetic generator is available."""
    return {"live": connection_is_live()}


@router.post("/connect")
def data_source_connect():
    """Initialize the bundled synthetic generator."""
    connect_and_ping()
    return {"live": connection_is_live()}
