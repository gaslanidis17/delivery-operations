from __future__ import annotations

import time
from typing import Any


class TTLCache:
    """Simple in-memory cache with per-key TTL expiration."""

    def __init__(self, default_ttl: int = 300):
        self._store: dict[str, tuple[float, Any]] = {}
        self._default_ttl = default_ttl

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if time.time() > expires_at:
            del self._store[key]
            return None
        return value

    def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        self._store[key] = (time.time() + (ttl or self._default_ttl), value)

    def invalidate(self, key: str) -> None:
        self._store.pop(key, None)

    def invalidate_prefix(self, prefix: str) -> int:
        """Drop every entry whose key starts with ``prefix``. Returns the count
        removed. Used by the auto-refresh service to evict an endpoint's stale
        in-memory results (across all lookback windows) once a background
        synthetic data source warm for that scope completes, so the next request re-assembles
        from the freshly-written disk cache instead of the stale TTL entry."""
        keys = [k for k in self._store if k.startswith(prefix)]
        for k in keys:
            self._store.pop(k, None)
        return len(keys)

    def clear(self) -> None:
        self._store.clear()


cache = TTLCache()
