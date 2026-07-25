"""Serve-stale + sign-in-gated background warm for the city-detail tabs.

The city tabs (Late / Rotten / Clone / Map) historically ran a LIVE synthetic data source
generation on a cache miss. The public demo has no external sign-in and cannot open an
interactive login on a plain tab open / poll — the exact footgun the Country and
Region tabs already avoid. This module gives the city tabs the same discipline:

  * their data endpoints read ONLY the on-disk plain cache
    (``synthetic_data.read_plain_cached``) and NEVER query, so a cold tab shows
    cached-or-empty data and can never spawn the sign-in popup;
  * a lightweight per-tab ``/freshness`` endpoint reports whether the current
    view's cache is behind and — only when a synthetic data source session is ALREADY live —
    kicks off a background warm of ONLY that view (the current city + the params
    actually being viewed), reusing ``auto_refresh`` (live-gate + per-scope dedup
    + cooldown + in-memory cache eviction on completion).

The frontend polls ``/freshness`` and re-fetches the (now-fresh) data endpoints,
mirroring the Region/Country poll loop. The warm work itself is plain
``execute_query(..., force_refresh=True)`` — the same file the matching data
endpoint reads — so there is no cache-key drift between what is warmed and what
is served.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from app.config import get_settings
from app.services import auto_refresh
from app.services.synthetic_data import execute_query, peek_plain_cache


@dataclass
class Read:
    """One plain-cache query that composes part of a city-tab view.

    Mirrors the arguments a matching ``execute_query`` call uses so the peek /
    warm resolve the identical on-disk file.
    """

    dataset_key: str
    params: Dict[str, Any] = field(default_factory=dict)
    cache_by_lookback: bool = False
    cache_suffix: Optional[str] = None


def view_freshness(
    reads: List[Read],
    *,
    scope: str,
    signal_index: int = 0,
    invalidate_prefixes: Optional[List[str]] = None,
    warm: Optional[Callable[..., Any]] = None,
    warm_total: Optional[int] = None,
    ttl_seconds: Optional[int] = None,
    force: bool = False,
) -> Dict[str, Any]:
    """Assemble the ``_freshness`` block for a city-tab view and sign-in-safely gate a
    background warm of that WHOLE view.

    ``reads`` are the plain-cache queries the current view is composed of. The
    ``signal_index`` read is the DATED one whose newest cached date + file age
    drive the stale/fresh decision (dateless aggregates can't be date-compared, so
    they lean on file age only). A view is considered behind when its signal file
    is missing / older than ``ttl_seconds`` (default the 24h
    ``country_cache_ttl_seconds``, matching the deep-cache discipline — the DATASET
    excludes today so data only changes daily) OR any read's file is absent.

    A warm is started ONLY when a synthetic data source connection is already live
    (``auto_refresh.trigger``'s gate); otherwise the block reports
    ``reason="initialization_required"`` so the UI shows the "Sign in to synthetic data source" prompt
    instead of spinning. ``warm`` overrides the default action (which
    ``force_refresh``-es every read) — used by the Clone tab to reuse the admin
    ``_warm_clone_cache`` closure so the warmed set never drifts from it. The
    default warm reports one PROGRESS step per read (``total`` = ``len(reads)``);
    an override ``warm`` reports its own steps and passes its step count via
    ``warm_total``. ``force=True`` (an explicit user "Retry") bypasses the warm
    cooldown (still live-gated — never opens sign-in).
    """
    if not reads:
        return auto_refresh.build_freshness(
            scope, stale=False, newest_date=None, trig=auto_refresh.reflect(scope),
        )
    if ttl_seconds is None:
        ttl_seconds = get_settings().country_cache_ttl_seconds

    idx = max(0, min(signal_index, len(reads) - 1))
    signal = reads[idx]
    info = peek_plain_cache(
        signal.dataset_key,
        signal.params,
        cache_by_lookback=signal.cache_by_lookback,
        cache_suffix=signal.cache_suffix,
    )

    # Any missing file in the view forces a warm (the view is incomplete).
    data_missing = False
    for r in reads:
        pk = peek_plain_cache(
            r.dataset_key, r.params,
            cache_by_lookback=r.cache_by_lookback, cache_suffix=r.cache_suffix,
        )
        if not pk["exists"]:
            data_missing = True
            break

    age = info["age_seconds"]
    newest = info["newest_date"]
    file_needs_warm = (
        not info["exists"]
        or age is None
        or (bool(ttl_seconds) and age > ttl_seconds)
        or data_missing
    )
    # Match the Country/Region gate: a file that reaches yesterday (the last
    # completed day) is FRESH even if slightly aged; only report stale when the
    # newest cached date is actually behind.
    is_stale = file_needs_warm and auto_refresh.is_stale_date(newest)

    def _default_warm(report=auto_refresh.NOOP_PROGRESS) -> None:
        for r in reads:
            execute_query(
                r.dataset_key, r.params, force_refresh=True,
                cache_by_lookback=r.cache_by_lookback, cache_suffix=r.cache_suffix,
            )
            report.step()

    warm_fn = warm or _default_warm
    total = warm_total if warm_total is not None else len(reads)

    if file_needs_warm or force:
        trig = auto_refresh.trigger(
            scope, warm_fn, total=total,
            invalidate_prefixes=invalidate_prefixes or [], force=force,
        )
    else:
        trig = auto_refresh.reflect(scope)

    return auto_refresh.build_freshness(
        scope, stale=is_stale, newest_date=newest, trig=trig, cache_age_seconds=age,
    )
