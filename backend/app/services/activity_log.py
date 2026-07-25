from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any

LOG_DIR = Path(__file__).resolve().parent.parent.parent.parent / "logs"

_lock = Lock()


def _ensure_log_dir():
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def _log_file() -> Path:
    _ensure_log_dir()
    return LOG_DIR / f"activity_{datetime.now().strftime('%Y-%m-%d')}.jsonl"


def log_event(
    category: str,
    action: str,
    *,
    username: str | None = None,
    detail: dict[str, Any] | None = None,
    ip: str | None = None,
):
    entry = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "category": category,
        "action": action,
        "user": username,
        "ip": ip,
        "detail": detail or {},
    }

    try:
        with _lock:
            with open(_log_file(), "a") as f:
                f.write(json.dumps(entry, default=str) + "\n")
    except OSError:
        pass


def _read_from_disk(limit: int = 2000, category: str | None = None) -> list[dict]:
    """Read log entries from today's and recent log files on disk."""
    _ensure_log_dir()
    log_files = sorted(LOG_DIR.glob("activity_*.jsonl"), reverse=True)

    entries: list[dict] = []
    for log_path in log_files:
        if len(entries) >= limit:
            break
        try:
            lines = log_path.read_text().strip().split("\n")
            for line in reversed(lines):
                if len(entries) >= limit:
                    break
                if not line.strip():
                    continue
                try:
                    entry = json.loads(line)
                    if category and entry.get("category") != category:
                        continue
                    entries.append(entry)
                except json.JSONDecodeError:
                    continue
        except OSError:
            continue

    return entries


def get_recent(limit: int = 200, category: str | None = None) -> list[dict]:
    return _read_from_disk(limit=limit, category=category)


def get_stats() -> dict[str, Any]:
    items = _read_from_disk(limit=5000)

    users: dict[str, int] = {}
    categories: dict[str, int] = {}
    for e in items:
        u = e.get("user") or "anonymous"
        users[u] = users.get(u, 0) + 1
        c = e["category"]
        categories[c] = categories.get(c, 0) + 1

    return {
        "total_events": len(items),
        "by_user": users,
        "by_category": categories,
    }
