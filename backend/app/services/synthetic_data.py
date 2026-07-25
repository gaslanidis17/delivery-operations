from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path
from threading import Lock
from typing import Any, Optional

import time

from app.config import get_settings
from app.services.activity_log import log_event

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"

def connection_is_live() -> bool:
    """The bundled synthetic data source is always available."""
    return True


def connect_and_ping() -> bool:
    """Confirm that the local synthetic generator is ready."""
    log_event("synthetic-data", "ready", detail={"mode": "synthetic"})
    return True


def _cache_path_for(
    dataset_key: str,
    city: str | None = None,
    lookback_days: int | None = None,
    suffix: str | None = None,
) -> Path:
    """Build path to cached JSON, optionally keyed by city, lookback_days, and suffix."""
    base = dataset_key.replace(".dataset", "").replace("/", "_")
    parts = [base]
    if city:
        parts.append(city.lower().replace(" ", "_"))
    if lookback_days is not None:
        parts.append(f"{lookback_days}d")
    if suffix:
        parts.append(suffix)
    return DATA_DIR / f"{'_'.join(parts)}.json"


def _detect_date_field(rows: list[dict[str, Any]]) -> str | None:
    """Auto-detect which date column is present in the data."""
    candidates = ["delivered_date", "confirmed_date", "date"]
    sample = rows[:3]
    for field in candidates:
        if any(field in r for r in sample):
            return field
    return None


def _filter_by_date(
    rows: list[dict[str, Any]],
    lookback_days: int | None,
    date_field: str | None = None,
) -> list[dict[str, Any]]:
    """Filter cached rows to only include rows within lookback_days of today."""
    if not lookback_days or not rows:
        return rows

    if not date_field:
        date_field = _detect_date_field(rows)
    if not date_field:
        return rows

    cutoff = (date.today() - timedelta(days=lookback_days)).isoformat()
    today = date.today().isoformat()
    return [
        r for r in rows
        if r.get(date_field) and cutoff <= str(r[date_field]) < today
    ]


# In-memory parse memo keyed by path -> (mtime, size, parsed_json). Avoids
# re-``json.loads``-ing the same on-disk cache file on repeat reads / poll ticks
# (master / Region / cities are read on every request and every poll cadence).
# Re-parses automatically when the file changes (a background warm rewrites it,
# bumping mtime/size). Files larger than ``_PARSE_MEMO_MAX_BYTES`` — i.e. the
# multi-hundred-MB per-order ``country_late_reasons`` aggregates — BYPASS this
# memo so we never hold that giant raw parse resident here; they are instead
# served via the enriched-result memo in ``country_analytics``. The returned
# object is SHARED by reference: callers must only read fields / build new
# filtered lists from it (all current callers do; ``_filter_by_date`` returns a
# fresh list, never mutating in place).
_parse_memo: dict[str, tuple[float, int, Any]] = {}
_parse_memo_lock = Lock()
_PARSE_MEMO_MAX_BYTES = 50 * 1024 * 1024  # 50 MB


def _read_json_memoized(path: Path) -> Any:
    """``json.loads(path.read_text())`` memoized by the file's (mtime, size).

    Large files (> ``_PARSE_MEMO_MAX_BYTES``) are parsed without being stored, so
    the memo's footprint stays bounded by the small daily-rollup / by-city files.
    May raise ``OSError`` (missing file) / ``json.JSONDecodeError`` exactly like a
    direct read — callers keep their existing try/except.
    """
    st = path.stat()
    mtime, size = st.st_mtime, st.st_size
    if size > _PARSE_MEMO_MAX_BYTES:
        return json.loads(path.read_text())
    key = str(path)
    with _parse_memo_lock:
        hit = _parse_memo.get(key)
        if hit is not None and hit[0] == mtime and hit[1] == size:
            return hit[2]
    parsed = json.loads(path.read_text())
    with _parse_memo_lock:
        _parse_memo[key] = (mtime, size, parsed)
    return parsed


def _load_cache_rows(path: Path) -> list[dict[str, Any]]:
    """Read rows from a cache file, tolerating both the legacy bare-array shape
    and the metadata-wrapped country/Region shape (defensive: a given file is
    only ever read in one mode, but never crash if the modes ever cross)."""
    raw = _read_json_memoized(path)
    if isinstance(raw, dict):
        rows = raw.get("rows")
        return rows if isinstance(rows, list) else []
    return raw if isinstance(raw, list) else []


def _load_cache_with_meta(
    path: Path,
) -> tuple[Optional[list[dict[str, Any]]], Optional[dict[str, Any]]]:
    """Read a metadata-wrapped cache file, returning (rows, meta).

    Legacy bare-array files, malformed JSON, or anything missing the expected
    ``{"_meta": {...}, "rows": [...]}`` shape return meta=None so the caller
    treats them as "needs refresh" rather than serving a stale/shallow snapshot.
    """
    raw = _read_json_memoized(path)
    if isinstance(raw, dict):
        meta = raw.get("_meta")
        rows = raw.get("rows")
        if isinstance(meta, dict) and isinstance(rows, list):
            return rows, meta
    return None, None


def _meta_is_fresh(meta: dict[str, Any], ttl_seconds: Optional[int]) -> bool:
    """True when the deep file was written within ttl_seconds. A missing/invalid
    timestamp (e.g. a legacy file) is treated as not fresh."""
    written_at = meta.get("written_at")
    if not isinstance(written_at, (int, float)):
        return False
    if not ttl_seconds or ttl_seconds <= 0:
        return True
    return (time.time() - float(written_at)) <= ttl_seconds


def _meta_covers(meta: dict[str, Any], lookback_days: Optional[int]) -> bool:
    """True when the deep file's covered window reaches the requested window."""
    if not lookback_days:
        return True
    window = meta.get("window_days")
    if not isinstance(window, (int, float)):
        return False
    return float(window) >= float(lookback_days)


def _operation_name(dataset_key: str) -> str:
    """Return a portfolio-safe label for logs and progress messages."""
    label = dataset_key.removesuffix(".dataset")
    replacements = {
        "ttla": "accept latency",
        "rotten": "queue aging",
        "clone": "redispatch",
        "unassign": "reassignment",
        "courier": "field unit",
        "venue": "partner",
        "orders": "jobs",
        "order": "job",
        "country": "region",
    }
    for source, target in replacements.items():
        label = label.replace(source, target)
    return label.replace("_", " ")


def _generate_rows(
    dataset_key: str,
    params: Optional[dict[str, Any]],
    city: Optional[str],
) -> list[dict[str, Any]]:
    """Generate deterministic fictional rows without reading query files."""
    from app.services.scenario_generator import generate_mock_rows

    time.sleep(0.04)
    operation = _operation_name(dataset_key)
    log_event(
        "synthetic-data",
        "generation_start",
        detail={"operation": operation, "city": city, "mode": "synthetic"},
    )
    result = generate_mock_rows(dataset_key, params or {}, city)
    log_event(
        "synthetic-data",
        "generation_done",
        detail={
            "operation": operation,
            "city": city,
            "rows": len(result),
            "mode": "synthetic",
        },
    )
    return result


def _execute_canonical_query(
    dataset_key: str,
    params: dict[str, Any],
    city: Optional[str],
    lookback_days: Optional[int],
    canonical_max_days: int,
    cache_suffix: Optional[str],
    cache_ttl_seconds: Optional[int],
) -> list[dict[str, Any]]:
    """Window-aware + freshness-aware cache for the country-master / Region DATASET
    files. One deep canonical JSON file per (dataset_key, country) holds up to
    ``canonical_max_days`` of daily rows plus coverage metadata
    (``window_days`` + ``written_at``). A cached file is served (trimmed down to
    the requested window) ONLY when it is BOTH fresh (within the TTL) AND covers
    the requested ``lookback_days``. Otherwise the DATASET is re-queried at MAX
    depth, the deep file is overwritten, and the fresh result is trimmed to the
    requested window before returning. Legacy bare-array files are detected as
    "needs refresh" and self-heal on first access."""
    if cache_ttl_seconds is None:
        cache_ttl_seconds = get_settings().country_cache_ttl_seconds

    # Keyed by fictional region only (e.g. "__region_r1"), never by lookback, so the
    # Region and Country-master tabs share one deep file that always holds MAX
    # depth. This also matches the existing file names admin refresh deletes.
    path = _cache_path_for(dataset_key, city, None, cache_suffix)

    if path.exists():
        try:
            rows, meta = _load_cache_with_meta(path)
        except (json.JSONDecodeError, OSError):
            rows, meta = None, None
        if (
            meta is not None
            and rows is not None
            and _meta_is_fresh(meta, cache_ttl_seconds)
            and _meta_covers(meta, lookback_days)
        ):
            filtered = _filter_by_date(rows, lookback_days)
            log_event("synthetic-data", "cache_hit", detail={
                "operation": _operation_name(dataset_key), "city": city, "rows": len(filtered),
                "mode": "canonical", "window_days": meta.get("window_days"),
            })
            return filtered

    # Stale, shallow, legacy, or missing → re-query at MAX depth and overwrite.
    deep_params = dict(params)
    deep_params["lookback_days"] = canonical_max_days
    result = _generate_rows(dataset_key, deep_params, city)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "_meta": {"window_days": canonical_max_days, "written_at": time.time()},
        "rows": result,
    }
    path.write_text(json.dumps(payload, default=str))

    return _filter_by_date(result, lookback_days)


def _newest_date_in_rows(rows: list[dict[str, Any]]) -> Optional[str]:
    """Largest (most recent) value of the auto-detected date column, or None."""
    if not rows:
        return None
    field = _detect_date_field(rows)
    if not field:
        return None
    dates = [str(r[field]) for r in rows if r.get(field)]
    return max(dates) if dates else None


def peek_cache_file(
    dataset_key: str,
    city: Optional[str] = None,
    *,
    cache_suffix: Optional[str] = None,
) -> dict[str, Any]:
    """Inspect a cache file WITHOUT querying synthetic data source (freshness probe).

    Returns ``{exists, age_seconds, newest_date}`` where ``age_seconds`` is how
    long ago the file was written (from its mtime) and ``newest_date`` is the most
    recent date present in the cached rows (handles both the plain bare-array and
    the metadata-wrapped canonical shapes via ``_load_cache_rows``). Used by the
    auto-refresh service to decide whether the per-city ``/analytics`` plain cache
    is stale. Never raises on a bad/partial file — returns ``exists=False``-ish
    defaults instead.
    """
    path = _cache_path_for(dataset_key, city, None, cache_suffix)
    if not path.exists():
        return {"exists": False, "age_seconds": None, "newest_date": None}
    try:
        age = time.time() - path.stat().st_mtime
    except OSError:
        age = None
    try:
        rows = _load_cache_rows(path)
        newest = _newest_date_in_rows(rows)
    except (json.JSONDecodeError, OSError, ValueError):
        newest = None
    return {"exists": True, "age_seconds": age, "newest_date": newest}


def peek_plain_cache(
    dataset_key: str,
    params: Optional[dict[str, Any]] = None,
    *,
    cache_by_lookback: bool = False,
    cache_suffix: Optional[str] = None,
) -> dict[str, Any]:
    """Freshness probe for a PLAIN (city-tab) cache file — the peek counterpart of
    ``read_plain_cached``.

    Resolves the on-disk key EXACTLY like ``read_plain_cached`` (city + lookback +
    suffix, then the un-keyed fallback), so it also handles the
    ``cache_by_lookback`` files (venue-performance, clone-rate summaries) whose
    filename carries the lookback — which ``peek_cache_file`` (city + suffix only)
    would miss. Returns ``{exists, age_seconds, newest_date}`` for the FIRST
    matching file; never raises on a bad/partial file. Used by the city-tab
    serve-stale ``/freshness`` endpoints to decide whether to warm.
    """
    params = params or {}
    city = params.get("city")
    lookback_days = params.get("lookback_days")
    lb_key = lookback_days if cache_by_lookback else None
    for path in [
        _cache_path_for(dataset_key, city, lb_key, cache_suffix),
        _cache_path_for(dataset_key),
    ]:
        if not path.exists():
            continue
        try:
            age = time.time() - path.stat().st_mtime
        except OSError:
            age = None
        try:
            rows = _load_cache_rows(path)
            newest = _newest_date_in_rows(rows)
        except (json.JSONDecodeError, OSError, ValueError):
            newest = None
        return {"exists": True, "age_seconds": age, "newest_date": newest}
    return {"exists": False, "age_seconds": None, "newest_date": None}


def canonical_cache_path(
    dataset_key: str,
    city: Optional[str] = None,
    *,
    cache_suffix: Optional[str] = None,
) -> Path:
    """Public path of the deep canonical cache file for (dataset_key, city).

    Exposed so callers that memoize an expensive TRANSFORM of a deep file (e.g.
    the enriched late-orders list in ``country_analytics``) can key their memo on
    this path + its ``stat().st_mtime`` and re-compute only when a warm rewrites
    the file.
    """
    return _cache_path_for(dataset_key, city, None, cache_suffix)


def read_plain_cached(
    dataset_key: str,
    params: Optional[dict[str, Any]] = None,
    *,
    cache_by_lookback: bool = False,
    cache_suffix: Optional[str] = None,
) -> Optional[list[dict[str, Any]]]:
    """Non-blocking serve-stale read of a PLAIN (non-canonical) cache file.

    Returns the cached rows trimmed to ``lookback_days`` (or the raw rows when
    ``cache_by_lookback``), or ``None`` when no cache file exists / is readable.
    NEVER queries synthetic data source, so it can't open a connection or pop the sign-in browser
    — the sign-in-safe counterpart of ``execute_query`` for the per-city ``/analytics``
    serve-stale path. Mirrors ``execute_query``'s cache key resolution exactly
    (city + lookback + suffix, then the un-keyed fallback) so it reads precisely
    the file the matching ``execute_query`` warm writes.
    """
    params = params or {}
    city = params.get("city")
    lookback_days = params.get("lookback_days")
    lb_key = lookback_days if cache_by_lookback else None
    for path in [
        _cache_path_for(dataset_key, city, lb_key, cache_suffix),
        _cache_path_for(dataset_key),
    ]:
        if path.exists():
            try:
                rows = _load_cache_rows(path)
            except (json.JSONDecodeError, OSError, ValueError):
                return None
            return rows if cache_by_lookback else _filter_by_date(rows, lookback_days)
    return None


def read_canonical_cached(
    dataset_key: str,
    city: Optional[str],
    lookback_days: Optional[int],
    *,
    cache_suffix: Optional[str] = None,
    cache_ttl_seconds: Optional[int] = None,
) -> tuple[Optional[list[dict[str, Any]]], bool, Optional[dict[str, Any]]]:
    """Non-blocking serve-stale read of a canonical deep file.

    Returns ``(rows, fresh, meta)`` WITHOUT ever querying synthetic data source:
      - ``rows``  = the deep rows trimmed to ``lookback_days`` (``None`` only when
                    the file is missing / legacy / unreadable, i.e. nothing to
                    serve);
      - ``fresh`` = True iff the file is BOTH within the TTL AND covers the window
                    (same predicate the blocking canonical path uses to decide a
                    cache hit);
      - ``meta``  = the stored ``_meta`` block (or ``None``).

    The auto-refresh-aware endpoints use this to serve the existing (possibly
    stale) deep data immediately and kick off a background refresh, instead of
    blocking the request on a live MAX-depth re-query (which could pop sign-in).
    """
    if cache_ttl_seconds is None:
        cache_ttl_seconds = get_settings().country_cache_ttl_seconds
    path = _cache_path_for(dataset_key, city, None, cache_suffix)
    if not path.exists():
        return None, False, None
    try:
        rows, meta = _load_cache_with_meta(path)
    except (json.JSONDecodeError, OSError):
        return None, False, None
    if meta is None or rows is None:
        return None, False, None
    fresh = _meta_is_fresh(meta, cache_ttl_seconds) and _meta_covers(meta, lookback_days)
    return _filter_by_date(rows, lookback_days), fresh, meta


def execute_query(
    dataset_key: str,
    params: Optional[dict[str, Any]] = None,
    *,
    cache_by_lookback: bool = False,
    cache_suffix: Optional[str] = None,
    canonical_max_days: Optional[int] = None,
    cache_ttl_seconds: Optional[int] = None,
    force_refresh: bool = False,
) -> list[dict[str, Any]]:
    """
    Load from city-keyed cached JSON first, then un-keyed fallback,
    then live synthetic data source as last resort.

    Set cache_by_lookback=True for aggregated queries whose output has
    no per-row date field and cannot be post-filtered by lookback_days.
    Set cache_suffix for additional cache key discrimination (e.g. size filter).

    Set canonical_max_days to enable the window-aware + freshness-aware deep
    cache used ONLY by the country-master / Region DATASET files: one deep file per
    country holds up to canonical_max_days of history and is re-queried when it
    is stale (older than cache_ttl_seconds, default
    Settings.country_cache_ttl_seconds) or does not cover the requested
    lookback_days. City-tab callers leave canonical_max_days None, preserving the
    original caching behavior exactly.

    Set force_refresh=True (plain cache only) to skip the cache READ and re-query
    synthetic data source, overwriting the file IN PLACE. The auto-refresh background warm
    uses this so it never deletes-then-recreates a file (which would leave a brief
    gap where a concurrent request hits a live blocking query); the old file keeps
    serving stale-but-instant until the fresh result is written.
    """
    params = params or {}
    city = params.get("city")
    lookback_days = params.get("lookback_days")

    if canonical_max_days is not None:
        return _execute_canonical_query(
            dataset_key, params, city, lookback_days,
            canonical_max_days, cache_suffix, cache_ttl_seconds,
        )

    lb_key = lookback_days if cache_by_lookback else None

    if not force_refresh:
        primary = _cache_path_for(dataset_key, city, lb_key, cache_suffix)
        for path in [primary, _cache_path_for(dataset_key)]:
            if path.exists():
                rows = _load_cache_rows(path)
                filtered = _filter_by_date(rows, lookback_days) if not cache_by_lookback else rows
                log_event("synthetic-data", "cache_hit", detail={
                    "operation": _operation_name(dataset_key), "city": city, "rows": len(filtered),
                })
                return filtered

    result = _generate_rows(dataset_key, params, city)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = _cache_path_for(dataset_key, city, lb_key, cache_suffix)
    cache_path.write_text(json.dumps(result, default=str))

    return result
