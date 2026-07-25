from __future__ import annotations

import json
import secrets
from pathlib import Path
from datetime import datetime

from fastapi import APIRouter, Request, Response, HTTPException
from pydantic import BaseModel

from app.services.activity_log import log_event

router = APIRouter(prefix="/api/auth", tags=["auth"])

USERS_FILE = Path(__file__).resolve().parent.parent.parent.parent / "users.json"

_sessions: dict[str, dict] = {}


def _load_users() -> list[dict]:
    if not USERS_FILE.exists():
        return []
    data = json.loads(USERS_FILE.read_text())
    return data.get("users", [])


class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginRequest, request: Request, response: Response):
    ip = request.client.host if request.client else "unknown"
    users = _load_users()
    user = next((u for u in users if u["username"] == body.username and u["password"] == body.password), None)
    if not user:
        log_event("auth", "login_failed", username=body.username, ip=ip)
        raise HTTPException(status_code=401, detail="Invalid username or password")

    token = secrets.token_hex(32)
    role = user.get("role", "viewer")
    _sessions[token] = {
        "username": user["username"],
        "name": user.get("name", user["username"]),
        "role": role,
        "logged_in_at": datetime.now().isoformat(),
    }

    response.set_cookie(
        key="session_token",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=86400,
    )
    log_event("auth", "login_success", username=user["username"], ip=ip)
    return {"username": user["username"], "name": user.get("name", user["username"]), "role": role}


@router.get("/me")
def get_me(request: Request):
    token = request.cookies.get("session_token")
    if not token or token not in _sessions:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return _sessions[token]


@router.post("/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get("session_token")
    username = None
    if token and token in _sessions:
        username = _sessions[token].get("username")
        del _sessions[token]
    response.delete_cookie("session_token")
    ip = request.client.host if request.client else "unknown"
    log_event("auth", "logout", username=username, ip=ip)
    return {"status": "logged out"}


@router.get("/sessions")
def active_sessions(request: Request):
    """Admin endpoint to see who's currently logged in."""
    token = request.cookies.get("session_token")
    if not token or token not in _sessions:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {
        "active": [
            {"username": s["username"], "name": s["name"], "since": s["logged_in_at"]}
            for s in _sessions.values()
        ]
    }
