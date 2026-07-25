"""sign-in-safe, non-blocking background auto-refresh for stale dashboard caches.

The dashboard uses a bundled, deterministic scenario generator. No external system
sign-in — opening a connection pops an interactive browser login. We therefore must
NEVER trigger a live query automatically (on tab open / poll) unless a connection
is already established. This module is the gate + bookkeeping for that:

  * ``trigger(scope, warm_fn)`` starts ``warm_fn`` on a daemon thread **only when
    a synthetic data source connection is already live** (``synthetic_data.connection_is_live``).
    If no connection is live it does nothing and reports ``reason="initialization_required"``
    so the caller can serve cached-but-stale data and the UI can surface a
    "needs refresh" affordance instead of spawning an sign-in popup.
  * Jobs are de-duplicated per ``scope`` (one in-flight warm per scope) and have a
    cooldown after finishing so a fast client re-poll loop — or a scope that is
    genuinely behind (e.g. synthetic data source hasn't loaded yesterday yet) — cannot hammer
    the warehouse.
  * On completion the job evicts the matching in-memory cache prefixes so the next
    request re-assembles from the freshly written disk cache.

The actual warm work (which DATASET to re-run, how) lives in the routers as closures;
this module only owns the sign-in gate, threading, status, and cache eviction.
"""

from __future__ import annotations

import inspect
import threading
import time
from datetime import date, timedelta
from typing import Any, Callable, Dict, List, Optional

from app.services.synthetic_data import connection_is_live
from app.services.cache import cache
from app.services.activity_log import log_event


def last_completed_date(today: Optional[date] = None) -> str:
    """The freshness TARGET = the last fully-COMPLETED day = yesterday.

    The dashboard intentionally never loads the current (partial) day: every
    daily/deep DATASET filters ``time_confirmed_utc < CURRENT_DATE()`` and
    ``_filter_by_date`` trims with ``< today``. So a fully fresh cache reaches
    yesterday and NEVER today. Therefore the target a cache is measured against is
    yesterday, not today — data through yesterday is up to date, not stale.
    """
    if today is None:
        today = date.today()
    return (today - timedelta(days=1)).isoformat()


def is_stale_date(newest_date: Optional[str], today: Optional[date] = None) -> bool:
    """Is a cache whose newest data point is ``newest_date`` behind the data?

    Stale ⇔ the newest cached date is strictly BEFORE the last completed day
    (yesterday). A cache whose newest date == yesterday (the last completed day)
    is FRESH (``False``) — yesterday is the freshest data that can exist, since
    the current day is never loaded. A missing/None date (empty or never-warmed
    cache) is treated as stale. ISO ``YYYY-MM-DD`` strings compare correctly
    lexicographically.
    """
    if not newest_date:
        return True
    return str(newest_date) < last_completed_date(today)


_DATE_KEYS = ("confirmed_date", "delivered_date", "date")


def max_date(rows: Any) -> Optional[str]:
    """Most recent ISO date found across an iterable of row dicts (best-effort,
    used only to report ``newest_date`` for the UI). ISO ``YYYY-MM-DD`` strings
    compare correctly lexicographically."""
    best: Optional[str] = None
    try:
        iterator = iter(rows)
    except TypeError:
        return None
    for r in iterator:
        if not isinstance(r, dict):
            continue
        for k in _DATE_KEYS:
            v = r.get(k)
            if v is not None:
                s = str(v)
                if best is None or s > best:
                    best = s
                break
    return best


def oldest_date(values: Any) -> Optional[str]:
    """The MIN (most-behind) of a list of ISO date strings, ignoring None/empty.

    Used to report a single ``newest_date`` for a tab that aggregates several
    independently-warmed sources (e.g. the Region overview's per-country rows):
    the tab is only as up to date as its MOST-BEHIND source, so we surface that
    date. This keeps the reported ``newest_date`` consistent with the ``stale``
    flag (instead of the global max, which could read as "yesterday" even while a
    lagging source makes the tab stale). Returns None if no dates are present.
    """
    best: Optional[str] = None
    try:
        iterator = iter(values)
    except TypeError:
        return None
    for v in iterator:
        if not v:
            continue
        s = str(v)
        if best is None or s < best:
            best = s
    return best

# Minimum gap between the END of one warm for a scope and the START of the next,
# regardless of staleness. Guards against client re-poll loops and scopes that
# stay "stale" because the upstream data itself is behind.
COOLDOWN_SECONDS = 300

_lock = threading.Lock()
# scope -> {state, started_at, updated_at, finished_at, error, attempts, completed, total}
#   state ∈ {"running", "done", "error"}
#   completed/total — warm PROGRESS: total = # of warm steps (DATASET files/queries)
#                  the view's warm_fn iterates; completed = finished steps. Drives
#                  the UI's determinate progress bar ("Refreshing 3 of 8…").
#   updated_at   — last time `completed`/`total`/`state` changed (a client compares
#                  it to `server_now` to detect a STALLED warm — progress frozen).
_jobs: Dict[str, Dict[str, Any]] = {}


class _Reporter:
    """Thread-safe progress handle passed into a scope's ``warm_fn``.

    The warm closure calls ``report()`` (or ``report.step()``) after each DATASET
    file / query it finishes, and may call ``report.set_total(n)`` if the step
    count isn't known until it runs. All mutations take ``_lock`` (the same lock
    guarding ``_jobs``) so a warm thread reporting progress can't race a
    ``trigger``/``reflect`` reading it. A no-op if the job vanished (evicted)."""

    def __init__(self, scope: str) -> None:
        self._scope = scope

    def set_total(self, total: int) -> None:
        with _lock:
            job = _jobs.get(self._scope)
            if job is not None:
                job["total"] = max(0, int(total))
                job["updated_at"] = time.time()

    def step(self, inc: int = 1) -> None:
        with _lock:
            job = _jobs.get(self._scope)
            if job is not None:
                job["completed"] = int(job.get("completed", 0)) + int(inc)
                job["updated_at"] = time.time()

    def __call__(self, inc: int = 1) -> None:
        self.step(inc)


class _NoopReporter:
    """No-op reporter for warm functions invoked OUTSIDE the auto-refresh daemon
    (e.g. admin "Refresh all data", which has its own progress model)."""

    def set_total(self, total: int) -> None:  # noqa: D401 - trivial
        pass

    def step(self, inc: int = 1) -> None:
        pass

    def __call__(self, inc: int = 1) -> None:
        pass


# Shared no-op so callers can default `report=NOOP_PROGRESS`.
NOOP_PROGRESS = _NoopReporter()


def _call_warm(warm_fn: Callable[..., Any], report: _Reporter) -> Any:
    """Call ``warm_fn`` with the progress ``report`` if it accepts an argument,
    else with none. Lets legacy zero-arg warm closures keep working while new
    ones opt into progress by declaring a single ``report`` parameter."""
    try:
        params = inspect.signature(warm_fn).parameters.values()
        accepts = any(
            p.kind
            in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD, p.VAR_POSITIONAL)
            for p in params
        )
    except (TypeError, ValueError):
        accepts = False
    return warm_fn(report) if accepts else warm_fn()


def _progress_snapshot(job: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """JSON-safe {completed,total,state,started_at,updated_at} for a job, or None."""
    if not job:
        return None
    return {
        "completed": int(job.get("completed", 0)),
        "total": int(job.get("total", 0)),
        "state": job.get("state"),
        "started_at": job.get("started_at"),
        "updated_at": job.get("updated_at"),
    }


def _trig_status(
    refreshing: bool,
    can_auto_refresh: bool,
    reason: Optional[str],
    job: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Assemble the dict ``trigger``/``reflect`` hand to ``build_freshness``.
    MUST be called while holding ``_lock`` when ``job`` is a live ``_jobs`` entry
    (it reads mutable fields)."""
    return {
        "refreshing": bool(refreshing),
        "can_auto_refresh": bool(can_auto_refresh),
        "reason": reason,
        "progress": _progress_snapshot(job),
        # Only meaningful when reason == "error"; None otherwise.
        "last_error": (job.get("error") if job else None),
    }


def is_running(scope: str) -> bool:
    with _lock:
        job = _jobs.get(scope)
        return bool(job and job.get("state") == "running")


def _in_cooldown(job: Optional[Dict[str, Any]]) -> bool:
    if not job:
        return False
    finished_at = job.get("finished_at")
    if not isinstance(finished_at, (int, float)):
        return False
    return (time.time() - finished_at) < COOLDOWN_SECONDS


def status(scope: str) -> Optional[Dict[str, Any]]:
    """Public, JSON-safe snapshot of a scope's last/current job (or None)."""
    with _lock:
        job = _jobs.get(scope)
        return dict(job) if job else None


def all_status() -> Dict[str, Dict[str, Any]]:
    with _lock:
        return {k: dict(v) for k, v in _jobs.items()}


def _run(scope: str, warm_fn: Callable[..., Any], invalidate_prefixes: List[str], username: str) -> None:
    error: Optional[str] = None
    t0 = time.time()
    report = _Reporter(scope)
    try:
        _call_warm(warm_fn, report)
    except Exception as exc:  # noqa: BLE001 — record, never crash the daemon thread
        error = str(exc)[:300]
        log_event("auto_refresh", "warm_error", username=username, detail={"scope": scope, "error": error})
    finally:
        # Evict stale in-memory results so the next request rebuilds from the
        # freshly written disk cache (do this even on error: a partial disk
        # rewrite is still newer than the evicted TTL entry, and a miss just
        # recomputes from whatever the deep/plain files now hold).
        for prefix in invalidate_prefixes:
            try:
                cache.invalidate_prefix(prefix)
            except Exception:  # noqa: BLE001
                pass
        with _lock:
            job = _jobs.get(scope) or {}
            job["state"] = "error" if error else "done"
            now = time.time()
            job["finished_at"] = now
            job["updated_at"] = now
            job["error"] = error
            _jobs[scope] = job
        log_event(
            "auto_refresh",
            "warm_done" if not error else "warm_failed",
            username=username,
            detail={"scope": scope, "seconds": round(time.time() - t0, 1), "error": error},
        )


def trigger(
    scope: str,
    warm_fn: Callable[..., Any],
    *,
    total: int = 0,
    invalidate_prefixes: Optional[List[str]] = None,
    username: str = "auto",
    force: bool = False,
) -> Dict[str, Any]:
    """Attempt an sign-in-safe background refresh for ``scope``.

    ``total`` seeds the job's step count so the progress bar can show
    ``completed/total`` the instant the warm starts (the ``warm_fn`` still calls
    ``report()`` per step and may ``report.set_total(n)`` to correct it).
    ``force=True`` (an explicit user "Retry") bypasses the post-run COOLDOWN so a
    failed/settled scope can be re-warmed immediately — it still respects the
    already-running guard and the live-connection gate (force NEVER opens sign-in).

    Returns a JSON-safe status dict the endpoint folds into its ``_freshness``
    block:
      - ``refreshing``       — a warm for this scope is now in flight.
      - ``can_auto_refresh`` — whether the backend could start one (a live
                               synthetic data source connection exists). When False the UI
                               shows the "Sign in to synthetic data source" prompt.
      - ``reason``           — why a refresh was NOT (re)started: ``"in_progress"``,
                               ``"cooldown"``, ``"initialization_required"``, ``"error"`` (the
                               last warm FAILED and is within cooldown — the UI
                               renders "Refresh failed — Retry"), or ``None`` when
                               one was just started.
      - ``progress``         — ``{completed,total,state,started_at,updated_at}`` or None.
      - ``last_error``       — the last warm's error string (only when reason=error).
    """
    invalidate_prefixes = invalidate_prefixes or []
    live = connection_is_live()

    with _lock:
        job = _jobs.get(scope)
        if job and job.get("state") == "running":
            return _trig_status(True, live, "in_progress", job)
        if not force and _in_cooldown(job):
            # Surface a FAILED last run (so the UI shows "Refresh failed — Retry")
            # distinctly from a normal post-success cooldown.
            reason = "error" if (job and job.get("state") == "error") else "cooldown"
            return _trig_status(False, live, reason, job)
        if not live:
            # sign-in-safety: do NOT open a connection automatically (even on force).
            return _trig_status(False, False, "initialization_required", job)
        # Claim the slot before releasing the lock so concurrent requests can't
        # both start a warm for the same scope. Seed progress (completed=0, total).
        now = time.time()
        _jobs[scope] = {
            "state": "running",
            "started_at": now,
            "updated_at": now,
            "finished_at": None,
            "error": None,
            "attempts": (job.get("attempts", 0) + 1) if job else 1,
            "completed": 0,
            "total": max(0, int(total)),
        }
        started_status = _trig_status(True, True, None, _jobs[scope])

    log_event("auto_refresh", "warm_start", username=username, detail={"scope": scope, "total": int(total)})
    thread = threading.Thread(
        target=_run,
        args=(scope, warm_fn, invalidate_prefixes, username),
        daemon=True,
    )
    thread.start()
    return started_status


def reflect(scope: str) -> Dict[str, Any]:
    """Report a scope's state WITHOUT starting anything.

    For an endpoint whose own data is fresh but which wants to know if a sibling
    request (e.g. another city in the same country) already kicked off a warm for
    the shared scope — so all views can show the same "updating…" state.
    """
    live = connection_is_live()
    with _lock:
        job = _jobs.get(scope)
        running = bool(job and job.get("state") == "running")
        # Surface a FAILED last warm during its cooldown so the banner can show
        # "Refresh failed" even on a reflect-only (needs_warm=False) path.
        errored = bool(job and job.get("state") == "error" and _in_cooldown(job))
        reason = "in_progress" if running else ("error" if errored else None)
        return _trig_status(running, live, reason, job)


def build_freshness(
    scope: str,
    *,
    stale: bool,
    newest_date: Optional[str],
    trig: Dict[str, Any],
    cache_age_seconds: Optional[float] = None,
) -> Dict[str, Any]:
    """Assemble the JSON ``_freshness`` block returned alongside tab data.

    ``stale`` is the user-facing "this data is behind" signal — it should be
    derived from ``is_stale_date`` (newest cached date < the last completed day),
    so data through yesterday is reported FRESH. ``expected_date`` is always the
    last completed day (yesterday), never today. ``trig`` is the result of
    ``trigger``/``reflect`` (whether a background warm is in flight and whether one
    could even be started without sign-in).
    """
    return {
        "scope": scope,
        "stale": bool(stale),
        "refreshing": bool(trig.get("refreshing")),
        "can_auto_refresh": bool(trig.get("can_auto_refresh")),
        "reason": trig.get("reason"),
        # PROGRESS: {completed,total,state,started_at,updated_at} or None. The
        # client renders a determinate bar when total ≥ 2, else an indeterminate
        # one, and compares `updated_at` to `server_now` to spot a STALLED warm.
        "progress": trig.get("progress"),
        "last_error": trig.get("last_error"),
        "newest_date": newest_date,
        "expected_date": last_completed_date(),
        "cache_age_seconds": round(cache_age_seconds) if isinstance(cache_age_seconds, (int, float)) else None,
        # Server clock at response time so the client can compute elapsed/stall
        # from the server-relative `started_at`/`updated_at` (no clock-skew math).
        "server_now": time.time(),
    }
