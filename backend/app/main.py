from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

import time

from app.config import get_settings, CITY_DATA, COUNTRY_NAMES
from app.routers import late_orders, rotten_orders, map_data, ai_summary, export, country_analytics, auth, logs, admin, clone_rate, region_analytics, ai_country, data_source, ttla_orders, retail_ttla, venue_diagnostics
from app.services.cache import cache
from app.services.activity_log import log_event

app = FastAPI(
    title="Delivery Analytics Dashboard API",
    version="1.0.0",
    description="Late & rotten order analytics with overlapping lateness reasons",
)

s = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=s.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PUBLIC_PATHS = {"/api/auth/login", "/api/auth/logout", "/api/health"}


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if request.method == "OPTIONS" or not path.startswith("/api/"):
            return await call_next(request)

        if path in PUBLIC_PATHS:
            return await call_next(request)

        token = request.cookies.get("session_token")
        session = auth._sessions.get(token) if token else None
        if not session:
            return JSONResponse(status_code=401, content={"detail": "Not authenticated"})

        username = session.get("username")
        request.state.username = username
        client_ip = request.client.host if request.client else "unknown"
        start = time.time()
        response = await call_next(request)
        elapsed_ms = round((time.time() - start) * 1000)

        if path not in ("/api/auth/me", "/api/logs/recent", "/api/logs/stats"):
            log_event(
                "request",
                f"{request.method} {path}",
                username=username,
                ip=client_ip,
                detail={
                    "query": str(request.url.query) or None,
                    "status": response.status_code,
                    "ms": elapsed_ms,
                },
            )

        return response


app.add_middleware(AuthMiddleware)

app.include_router(auth.router)
app.include_router(late_orders.router)
app.include_router(ttla_orders.router)
app.include_router(retail_ttla.router)
app.include_router(venue_diagnostics.router)
app.include_router(rotten_orders.router)
app.include_router(map_data.router)
app.include_router(ai_summary.router)
app.include_router(export.router)
app.include_router(country_analytics.router)
app.include_router(ai_country.router)
app.include_router(logs.router)
app.include_router(admin.router)
app.include_router(clone_rate.router)
app.include_router(region_analytics.router)
app.include_router(data_source.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}




@app.get("/api/cities")
def get_cities():
    return {"cities": CITY_DATA}


@app.get("/api/countries")
def get_countries():
    by_country: dict[str, dict] = {}
    for c in CITY_DATA:
        code = c["country"]
        if code not in by_country:
            by_country[code] = {"code": code, "name": COUNTRY_NAMES.get(code, code), "cities": []}
        by_country[code]["cities"].append(c["name"])
    return {"countries": list(by_country.values())}


@app.post("/api/cache/clear")
def clear_cache():
    cache.clear()
    return {"status": "cache cleared"}


FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"

if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="static-assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        file_path = FRONTEND_DIST / full_path
        if full_path and file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(FRONTEND_DIST / "index.html")
