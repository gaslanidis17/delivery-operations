from __future__ import annotations

"""AI Venue Diagnostic — deterministic evidence packs + (Phase 3) LLM synthesis.

This service owns the DATA layer of the TTLA-tab venue diagnostic feature
(AI_VENUE_DIAGNOSTIC_PLAN.md). For one venue over the tab's global filter set
(city / period / order-type) it builds SIX compact, deterministic evidence packs
from cached DATASET — NEVER from an LLM — plus a data-quality gate:

  Pack 1  Metrics + benchmark  — reuse retail_ttla_venues + per-segment city /
                                 country denominators (venue vs its peers).
  Pack 2  Hourly               — venue_ttla_hourly.dataset: per local hour TTLA +
                                 unassign, peak-vs-baseline.
  Pack 3  Trend                — venue_ttla_daily.dataset: daily TTLA + unassign,
                                 spike-vs-recurring.
  Pack 4  Conversation themes  — venue_courier_conversations.dataset: courier CP/PU+R
                                 tag distribution, share vs the venue's volume and
                                 the city.
  Pack 5  Unassign             — the synthetic_jobs unassign flags (Pack 1) split
                                 total / courier / ops vs the segment baseline.
  Pack 6  Location / access    — venue_attributes.dataset: courier notes, opening-hour
                                 presence, venue type, hex, uptime.

All numbers come from DATASET (order-weighted means, distinct counts). The packs are
the ground truth the LLM only interprets, and the frontend renders even when the
LLM fails.

sign-in-safe: every read is ``read_plain_cached`` (on-disk only, never opens a
synthetic data source connection). A cache miss serves what's available and — only when a
synthetic data source session is already live — kicks off a background warm (see
``scorecard`` + ``view_freshness``). The four venue DATASET are keyed by
city + lookback + order-type suffix exactly like the retail-TTLA reads.
"""

import math
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field

from app.config import get_settings, CITY_COUNTRY_MAP, CITY_OPERATIONS_AREA_ALIAS, ttla_target_sec, CITY_DATA
from app.services.synthetic_data import read_plain_cached, execute_query
from app.services.serve_stale import Read, view_freshness
from app.services.ttla_filters import (
    date_window_clause,
    norm_order_type,
    order_type_clause,
    order_type_suffix,
    period_suffix,
)
# Pack 1 reuses the retail-TTLA venue/segment machinery verbatim so the venue's
# headline metrics reconcile to what the Venue TTLA table shows.
from app.routers import retail_ttla as rt

# Bump when a pack's shape (or the scorecard response layout) changes so callers
# / caches written by an older version aren't served missing a field.
#   v2 — Phase 7: Pack 5 unassign-EVENT enrichment (venue_unassign_events.dataset),
#        Pack 7 peer benchmarking, Pack 6 opening-hours correlation fields.
#   v3 — Pack 6 geo-context: lat/lon, city-centre distance + position_label,
#        mall_hint, traffic_hint.
CACHE_VERSION = "v3"

# Bump when the prompt, definitions, analytical rules, or output schema change so
# 6h-cached LLM results written by an older version are never served.
#   v2 — Phase 7: enriched evidence bundle (peers + unassign events + opening-hours
#        + optional PII-scrubbed conversation-text themes).
#   v3 — Pack 6 geo-context fields added to the location pack handed to the LLM
#        (lat/lon, city-centre distance + position_label, mall_hint, traffic_hint)
#        + a DEFINITION explaining them.
AI_CACHE_VERSION = "v3"

_HOURLY_DATASET = "venue_ttla_hourly.dataset"
_DAILY_DATASET = "venue_ttla_daily.dataset"
_CONVOS_DATASET = "venue_courier_conversations.dataset"
_ATTRS_DATASET = "venue_attributes.dataset"
_UNASSIGN_DATASET = "venue_unassign_events.dataset"
# Deep, PII-laden, per-venue only (NOT city-warmed) — see venue_conversation_messages.dataset.
_MESSAGES_DATASET = "venue_conversation_messages.dataset"

# City-keyed DATASET warmed + read together (deterministic packs). The per-venue raw
# message DATASET is deliberately excluded (deep opt-in only).
DIAG_DATASET_FILES = [_HOURLY_DATASET, _DAILY_DATASET, _CONVOS_DATASET, _ATTRS_DATASET, _UNASSIGN_DATASET]

# In-memory cache prefix a background warm evicts on completion.
_INVALIDATE = ["venue_diag:"]

# --- Data-quality thresholds -------------------------------------------------
# A venue needs at least this many in-window orders to be diagnosed at all
# (below it the report is auto "insufficient evidence", no LLM). Matches the
# retail-TTLA ranking floor so the two views agree on what's rankable.
MIN_VENUE_ORDERS = rt.MIN_VENUE_ORDERS  # 30
# An hour / day needs this many orders before its rate is treated as a real
# signal (a 1-2 order bucket is noise, never "recurring").
MIN_HOUR_ORDERS = 10
MIN_DAY_ORDERS = 5
# A conversation theme needs this many conversations before it's "confirmed"
# rather than an isolated complaint.
MIN_THEME_COUNT = 5
# How many worst hours / days / themes to surface in the packs.
TOP_HOURS = 4
TOP_DAYS = 5
TOP_THEMES = 8
# Peer benchmarking (Pack 7): a venue needs at least this many comparable peers
# (same segment + venue_type in the city, each above MIN_VENUE_ORDERS) before a
# percentile rank is treated as meaningful; below it we widen to segment-only and
# flag the thin peer set.
MIN_PEERS = 5
# Raw-text deep mode (Pack 4 v2): cap the courier messages fed to the scrub LLM.
MAX_RAW_MESSAGES = 60
# Output-token floor for the main venue synthesis. The VenueDiagnostic schema is
# large and gpt-5 reasoning tokens count against the completion budget, so the
# 6000 analysis default truncated the answer to empty content. 16000 leaves ample
# room for reasoning + the full structured report.
VENUE_SYNTHESIS_MAX_TOKENS = 16000


# ---------------------------------------------------------------------------
# Human labels for the courier CP/PU+R conversation tags (Pack 4). Keyed by the
# LVL3 value the DATASET emits; unknown tags fall back to the raw value.
# ---------------------------------------------------------------------------
THEME_LABELS: Dict[str, str] = {
    "Venuelateness": "Order not ready on arrival (venue lateness)",
    "Cantfindvenue": "Courier can't find the venue",
    "Venueclosed": "Venue closed / unreachable",
    "Clarifyorder": "Order needs clarification at pickup",
    "Heavyorderhelp": "Heavy-order help requested",
    "Largeorderhelp": "Large-order help requested",
    "Courierlateness": "Courier arrived late",
    "UnassignOther": "Unassigned — other reason",
    "UnassignVehicleissue": "Unassigned — vehicle issue",
    "Unassignlongwait": "Unassigned — long wait at venue",
    "Unassigntoolarge": "Unassigned — order too large",
    "Unassigntooheavy": "Unassigned — order too heavy",
    "Unassigndistance": "Unassigned — delivery distance",
    "Unassignnoreason": "Unassigned — no reason given",
}

# Accessibility keywords scanned in the merchant's courier notes (Pack 6). Kept
# in neutral English for the public demo. Grouped
# so a hit maps to an accessibility hypothesis the LLM can corroborate with the
# Pack 4 "can't find venue" / "venue closed" tags.
_ACCESS_KEYWORDS: Dict[str, List[str]] = {
    "mall_indoor": ["mall", "moll", "молл", "тц", "трц", "shopping", "универмаг"],
    "floor_level": ["floor", "этаж", "level", "этажа", "2nd", "3rd", "цокол", "подвал", "basement"],
    "parking": ["parking", "парков", "паркинг", "стоянк"],
    "entrance": ["entrance", "вход", "подъезд", "gate", "ворота", "back door", "черный вход", "служебн"],
    "access_code": ["code", "код", "домофон", "intercom", "звонок", "call", "позвон"],
}


# ---------------------------------------------------------------------------
# Small numeric helpers.
# ---------------------------------------------------------------------------

def _f(row: Dict[str, Any], field: str) -> float:
    v = row.get(field)
    if v is None:
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _round1(v: Optional[float]) -> Optional[float]:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return round(float(v), 1)


def _avg(sec_sum: float, cnt: float) -> Optional[float]:
    return round(sec_sum / cnt, 1) if cnt and cnt > 0 else None


def _rate(num: float, den: float) -> Optional[float]:
    return round(num / den, 4) if den and den > 0 else None


# ---------------------------------------------------------------------------
# Filter/param plumbing (mirrors retail_ttla._params/_suffix so reads/warms hit
# the identical on-disk files).
# ---------------------------------------------------------------------------

def _params(country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to) -> dict:
    return {
        "country": country,
        "city": wh_city,
        "lookback_days": lookback_days,
        "date_window_clause": date_window_clause(lookback_days, date_from, date_to, complete_weeks),
        "order_type_clause": order_type_clause(order_type),
    }


def _suffix(order_type, complete_weeks, date_from, date_to) -> Optional[str]:
    parts = [p for p in (order_type_suffix(order_type), period_suffix(complete_weeks, date_from, date_to)) if p]
    return "_".join(parts) if parts else None


def _diag_reads(country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to) -> List[Read]:
    p = _params(country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to)
    sfx = _suffix(order_type, complete_weeks, date_from, date_to)
    return [
        Read(sql, p, cache_by_lookback=True, cache_suffix=sfx) for sql in DIAG_DATASET_FILES
    ]


def _read_rows(dataset_key, country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to):
    p = _params(country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to)
    sfx = _suffix(order_type, complete_weeks, date_from, date_to)
    return read_plain_cached(dataset_key, p, cache_by_lookback=True, cache_suffix=sfx) or []


import re

# Scenario ids are used in deterministic cache keys, so accept only a compact
# alphanumeric token. Anything else is rejected
# (never sent to DATASET) — the diagnostic's own venue ids always match.
_SAFE_VENUE_ID = re.compile(r"^[A-Za-z0-9]+$")


def _messages_params(country, wh_city, venue_id, lookback_days, order_type, complete_weeks, date_from, date_to) -> dict:
    p = _params(country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to)
    p["venue_id"] = str(venue_id)
    return p


def _messages_suffix(venue_id, order_type, complete_weeks, date_from, date_to) -> str:
    base = _suffix(order_type, complete_weeks, date_from, date_to)
    parts = [p for p in (f"v{venue_id}", base) if p]
    return "_".join(parts)


def read_conversation_messages(venue_id, country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to):
    """Cache-only read of the deep per-venue raw courier messages (sign-in-safe)."""
    if not _SAFE_VENUE_ID.match(str(venue_id)):
        return []
    p = _messages_params(country, wh_city, venue_id, lookback_days, order_type, complete_weeks, date_from, date_to)
    sfx = _messages_suffix(venue_id, order_type, complete_weeks, date_from, date_to)
    return read_plain_cached(_MESSAGES_DATASET, p, cache_by_lookback=True, cache_suffix=sfx) or []


def fetch_conversation_messages(venue_id, country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to):
    """Warm the deep per-venue raw messages (background/live-connection only). The
    raw bodies live ONLY in this per-venue disk file; they are never returned to the
    client or stored in an AI result — the scrub LLM output replaces them."""
    if not _SAFE_VENUE_ID.match(str(venue_id)):
        return []
    p = _messages_params(country, wh_city, venue_id, lookback_days, order_type, complete_weeks, date_from, date_to)
    sfx = _messages_suffix(venue_id, order_type, complete_weeks, date_from, date_to)
    return execute_query(_MESSAGES_DATASET, p, cache_by_lookback=True, cache_suffix=sfx, force_refresh=True) or []


# ---------------------------------------------------------------------------
# Warm helper (sign-in-safe background refresh; also used by admin / nightly warm).
# ---------------------------------------------------------------------------

def warm_venue_diagnostics(city: Optional[str], lookback: int = 28, *, force_refresh: bool = False, report=None) -> None:
    """Re-run the four venue-diagnostic DATASET for a city — for BOTH order types —
    overwriting in place (``force_refresh``) so the tab shows fresh data. Uses the
    same city + lookback + order-type keying the scorecard reads."""
    from app.services.auto_refresh import NOOP_PROGRESS

    report = report or NOOP_PROGRESS
    _city, country, wh_city = rt._resolve(city)
    for ot in ("regular", "drive"):
        p = _params(country, wh_city, lookback, ot, None, None, None)
        sfx = _suffix(ot, None, None, None)
        for sql in DIAG_DATASET_FILES:
            execute_query(sql, p, cache_by_lookback=True, cache_suffix=sfx, force_refresh=force_refresh)
            report.step()


VENUE_DIAG_WARM_STEPS = len(DIAG_DATASET_FILES) * 2


# ---------------------------------------------------------------------------
# Pack 1 — Metrics + benchmark (reuse retail-TTLA venue/segment machinery).
# ---------------------------------------------------------------------------

def _venue_metrics_and_benchmark(
    venue_id: str, country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to,
) -> Dict[str, Any]:
    """The venue's headline metrics + its per-segment city/country benchmark,
    computed the same way as retail_ttla.get_retail_ttla_venues (so they
    reconcile), but WITHOUT the min-order rank filter (the venue is always
    included; the data-quality gate handles thin volume)."""
    summary_rows = rt._read_summary_rows(country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to)
    _city, groups = rt._group_stats(summary_rows)
    country_groups = rt._country_group_stats(
        rt._read_country_summary_rows(country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to)
    )
    venue_rows = rt._read_venue_rows(country, wh_city, lookback_days, order_type, complete_weeks, date_from, date_to)

    row = next((r for r in venue_rows if str(r.get("venue_id")) == str(venue_id)), None)
    if row is None:
        return {"found": False, "venue_id": venue_id}

    slug = rt._CAT_TO_SLUG.get(row.get("product_line_category"))
    g = groups.get(slug) or {}
    cg = country_groups.get(slug) or {}
    g_cnt = g.get("order_count") or 0
    g_avg = g.get("avg_ttla_sec")
    g_ttla_sum = g.get("ttla_sec_sum") or 0
    g_un = g.get("unassigned_count") or 0

    cnt = row.get("order_count") or 0
    sec_sum = row.get("ttla_sec_sum") or 0
    avg_ttla = sec_sum / cnt if cnt else None
    un_total = row.get("unassigned_count") or 0
    un_courier = row.get("unassigned_courier") or 0
    un_ops = row.get("unassigned_ops") or 0

    ttla_impact = cnt * (avg_ttla - g_avg) if (avg_ttla is not None and g_avg is not None) else None
    ttla_impact_pct = round(ttla_impact / g_ttla_sum * 100, 3) if (ttla_impact is not None and g_ttla_sum) else None

    return {
        "found": True,
        "venue_id": row.get("venue_id"),
        "venue_name": row.get("venue_name"),
        "segment": slug,
        "product_line_category": row.get("product_line_category"),
        "venue_type": row.get("venue_type") or None,
        "account_manager": row.get("account_manager") or None,
        "order_count": cnt,
        "avg_ttla_sec": round(avg_ttla, 1) if avg_ttla is not None else None,
        "ttla_impact_sec": round(ttla_impact, 1) if ttla_impact is not None else None,
        "ttla_impact_pct": ttla_impact_pct,
        "unassign_rate": _rate(un_total, cnt),
        "unassign_rate_courier": _rate(un_courier, cnt),
        "unassign_rate_ops": _rate(un_ops, cnt),
        "unassign_contribution_pp": round(100 * un_total / g_cnt, 4) if g_cnt else None,
        "share_of_unassigns": _rate(un_total, g_un),
        "avg_prep_min": rt._avg_min(row.get("prep_sec_sum") or 0, row.get("prep_count") or 0),
        "avg_pickup_service_sec": _avg(row.get("pickup_sec_sum") or 0, row.get("pickup_count") or 0),
        "avg_prep_error_min": rt._avg_min(row.get("prep_err_sec_sum") or 0, row.get("prep_err_count") or 0),
        "benchmark": {
            "segment": slug,
            "segment_city_avg_ttla_sec": g.get("avg_ttla_sec"),
            "segment_city_unassign_rate": g.get("avg_unassign_rate"),
            "segment_city_order_count": g.get("order_count"),
            "segment_country_avg_ttla_sec": cg.get("avg_ttla_sec"),
            "segment_country_order_count": cg.get("order_count"),
            "ttla_target_sec": ttla_target_sec(country),
        },
    }


# ---------------------------------------------------------------------------
# Pack 2 — Hourly (peak vs baseline).
# ---------------------------------------------------------------------------

def _pack_hourly(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    by_hour: Dict[int, Dict[str, float]] = {}
    for r in rows:
        h = int(_f(r, "hour_of_day"))
        b = by_hour.setdefault(h, {"orders": 0.0, "ttla_sum": 0.0, "un": 0.0})
        b["orders"] += _f(r, "order_count")
        b["ttla_sum"] += _f(r, "ttla_sec_sum")
        b["un"] += _f(r, "unassigned_count")

    total_orders = sum(b["orders"] for b in by_hour.values())
    total_ttla = sum(b["ttla_sum"] for b in by_hour.values())
    venue_avg = (total_ttla / total_orders) if total_orders > 0 else None

    hours = []
    for h in range(24):
        b = by_hour.get(h)
        if not b:
            continue
        oc = b["orders"]
        hours.append({
            "hour": h,
            "order_count": int(oc),
            "avg_ttla_sec": _avg(b["ttla_sum"], oc),
            "unassign_rate": _rate(b["un"], oc),
            "unassigned_count": int(b["un"]),
            "low_volume": oc < MIN_HOUR_ORDERS,
        })

    eligible = [h for h in hours if not h["low_volume"] and h["avg_ttla_sec"] is not None]
    worst = sorted(eligible, key=lambda h: h["avg_ttla_sec"], reverse=True)[:TOP_HOURS]
    # Peak volume window (busiest hours) — capacity signal.
    peak_volume = sorted(hours, key=lambda h: h["order_count"], reverse=True)[:TOP_HOURS]

    return {
        "hours": hours,
        "venue_avg_ttla_sec": _round1(venue_avg),
        "total_orders": int(total_orders),
        "worst_hours": worst,
        "peak_volume_hours": peak_volume,
        "min_hour_orders": MIN_HOUR_ORDERS,
    }


# ---------------------------------------------------------------------------
# Pack 3 — Daily trend (spike vs recurring).
# ---------------------------------------------------------------------------

def _pack_daily(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    by_day: Dict[str, Dict[str, float]] = {}
    for r in rows:
        d = str(r.get("local_date"))
        b = by_day.setdefault(d, {"orders": 0.0, "ttla_sum": 0.0, "un": 0.0})
        b["orders"] += _f(r, "order_count")
        b["ttla_sum"] += _f(r, "ttla_sec_sum")
        b["un"] += _f(r, "unassigned_count")

    days = []
    for d in sorted(by_day.keys()):
        b = by_day[d]
        oc = b["orders"]
        days.append({
            "date": d,
            "order_count": int(oc),
            "avg_ttla_sec": _avg(b["ttla_sum"], oc),
            "unassign_rate": _rate(b["un"], oc),
            "low_volume": oc < MIN_DAY_ORDERS,
        })

    total_orders = sum(b["orders"] for b in by_day.values())
    total_ttla = sum(b["ttla_sum"] for b in by_day.values())
    venue_avg = (total_ttla / total_orders) if total_orders > 0 else None

    eligible = [d for d in days if not d["low_volume"] and d["avg_ttla_sec"] is not None]

    # Spike vs recurring: days whose avg TTLA is >= 1.5x the venue mean.
    spike_threshold = (venue_avg * 1.5) if venue_avg else None
    bad_days = [
        d for d in eligible
        if spike_threshold is not None and d["avg_ttla_sec"] >= spike_threshold
    ]
    n_eligible = len(eligible)
    n_bad = len(bad_days)
    if n_eligible == 0:
        classification = "insufficient"
    elif n_bad == 0:
        classification = "stable"
    elif n_bad <= max(1, round(0.2 * n_eligible)):
        classification = "spike"
    else:
        classification = "recurring"

    # Trend direction: order-weighted first half vs second half.
    trend = "stable"
    if n_eligible >= 4:
        mid = n_eligible // 2
        first = eligible[:mid]
        second = eligible[mid:]

        def _wavg(sub):
            num = sum((x["avg_ttla_sec"] or 0) * x["order_count"] for x in sub)
            den = sum(x["order_count"] for x in sub)
            return (num / den) if den else None

        a, b2 = _wavg(first), _wavg(second)
        if a and b2:
            if b2 > a * 1.1:
                trend = "worsening"
            elif b2 < a * 0.9:
                trend = "improving"

    worst = sorted(eligible, key=lambda d: d["avg_ttla_sec"], reverse=True)[:TOP_DAYS]

    return {
        "days": days,
        "venue_avg_ttla_sec": _round1(venue_avg),
        "classification": classification,
        "trend": trend,
        "bad_day_count": n_bad,
        "eligible_day_count": n_eligible,
        "worst_days": worst,
        "min_day_orders": MIN_DAY_ORDERS,
    }


# ---------------------------------------------------------------------------
# Pack 4 — Conversation themes.
# ---------------------------------------------------------------------------

def _pack_conversations(venue_rows: List[Dict[str, Any]], city_rows: List[Dict[str, Any]], venue_order_count: int) -> Dict[str, Any]:
    # City totals per theme (venue's share of the city's theme volume).
    city_theme: Dict[str, float] = {}
    for r in city_rows:
        key = f"{r.get('tag_lvl2')}/{r.get('tag_lvl3')}"
        city_theme[key] = city_theme.get(key, 0.0) + _f(r, "conversation_count")

    themes = []
    total_convos = 0.0
    for r in venue_rows:
        lvl2 = r.get("tag_lvl2")
        lvl3 = r.get("tag_lvl3")
        key = f"{lvl2}/{lvl3}"
        cc = _f(r, "conversation_count")
        oc = _f(r, "order_count")
        total_convos += cc
        themes.append({
            "tag_lvl2": lvl2,
            "tag_lvl3": lvl3,
            "label": THEME_LABELS.get(lvl3, lvl3),
            "conversation_count": int(cc),
            "order_count": int(oc),
            "per_100_orders": round(cc / venue_order_count * 100, 2) if venue_order_count else None,
            "share_of_city_theme": _rate(cc, city_theme.get(key, 0.0)),
            "confirmed": cc >= MIN_THEME_COUNT,
            "first_seen": r.get("first_seen_utc"),
            "last_seen": r.get("last_seen_utc"),
        })

    themes.sort(key=lambda t: t["conversation_count"], reverse=True)
    return {
        "themes": themes[:TOP_THEMES],
        "total_themes": len(themes),
        "total_conversations": int(total_convos),
        "conversations_per_100_orders": round(total_convos / venue_order_count * 100, 2) if venue_order_count else None,
        "min_theme_count": MIN_THEME_COUNT,
    }


# ---------------------------------------------------------------------------
# Pack 5 — Unassign (from the Pack 1 flags, split + benchmarked).
# ---------------------------------------------------------------------------

def _pack_unassign(metrics: Dict[str, Any], event_row: Optional[Dict[str, Any]], venue_orders: int) -> Dict[str, Any]:
    """Pack 5 = the synthetic_jobs unassign FLAGS (Pack 1) split + benchmarked, PLUS
    (v2) the F_COURIER_DELIVERY_UNASSIGNS EVENT enrichment when available: how many
    unassign events happened (multiplicity beyond the yes/no flag), how many distinct
    couriers dropped the order, the Courier/Ops event split, and how long couriers
    held the task before dropping it (a long hold corroborates 'long wait at venue')."""
    bench = metrics.get("benchmark", {})
    out = {
        "unassign_rate": metrics.get("unassign_rate"),
        "unassign_rate_courier": metrics.get("unassign_rate_courier"),
        "unassign_rate_ops": metrics.get("unassign_rate_ops"),
        "unassign_contribution_pp": metrics.get("unassign_contribution_pp"),
        "share_of_unassigns": metrics.get("share_of_unassigns"),
        "segment_city_unassign_rate": bench.get("segment_city_unassign_rate"),
        "events_available": False,
    }
    if event_row:
        events = int(_f(event_row, "unassign_events"))
        purchases = int(_f(event_row, "purchases_unassigned"))
        out.update({
            "events_available": True,
            "unassign_events": events,
            "purchases_unassigned": purchases,
            "distinct_couriers": int(_f(event_row, "distinct_couriers")),
            "events_courier": int(_f(event_row, "events_courier")),
            "events_ops": int(_f(event_row, "events_ops")),
            # Multiplicity: how many times, on average, an unassigned order was
            # dropped before it stuck (> 1 means repeated re-assignment churn).
            "events_per_unassigned_order": round(events / purchases, 2) if purchases else None,
            "events_per_100_orders": round(events / venue_orders * 100, 2) if venue_orders else None,
            "avg_hold_before_unassign_sec": _round1(event_row.get("avg_wait_sec")),
            "median_hold_before_unassign_sec": _round1(event_row.get("median_wait_sec")),
        })
    return out


# ---------------------------------------------------------------------------
# Pack 6 — Location / accessibility.
# ---------------------------------------------------------------------------

def _scan_access_keywords(notes: Optional[str]) -> List[str]:
    if not notes:
        return []
    low = notes.lower()
    hits = []
    for group, kws in _ACCESS_KEYWORDS.items():
        if any(kw in low for kw in kws):
            hits.append(group)
    return hits


# ---------------------------------------------------------------------------
# Pack 6 v3 — geo context (where the venue sits in the city).
# ---------------------------------------------------------------------------

# City-centre lookup from the curated CITY_DATA (display name -> (lat, lon)).
_CITY_CENTER: Dict[str, Tuple[float, float]] = {
    c["name"]: (float(c["lat"]), float(c["lon"]))
    for c in CITY_DATA
    if c.get("lat") is not None and c.get("lon") is not None
}

# Heuristics for "is this a mall" — scanned (case-insensitive) across venue_type,
# brand, franchise, merchant_type and courier notes. "Mega"/"Mega Park" are the
# large KZ mall chains; ТРЦ/ТГУ/ТРК are CIS "shopping/trade centre" abbrevs.
_MALL_KEYWORDS = (
    "mall", "shopping centre", "shopping center", "shopping mall",
    "trade centre", "trade center", "trade mall",
    "трц", "тгу", "трк", "мега", "mega park", "mega silk",
    "arman", "dostyk plaza", "esentai mall",
)

# Typical local rush hours used for the traffic hint (corroborated by the venue's
# OWN hourly TTLA — there is no external traffic feed).
_RUSH_HOURS = {7, 8, 9, 17, 18, 19}


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km between two lat/lon points."""
    r = 6371.0088
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def _position_label(km: Optional[float]) -> Optional[str]:
    if km is None:
        return None
    if km <= 2.0:
        return "city centre"
    if km <= 5.0:
        return "inner city"
    if km <= 10.0:
        return "outer city"
    return "far outskirts"


def _mall_hint(location: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    hay = " ".join(
        str(location.get(k) or "")
        for k in ("venue_type", "brand_name", "franchise_name", "merchant_type", "courier_notes")
    ).lower()
    for kw in _MALL_KEYWORDS:
        if kw in hay:
            return True, kw
    return False, None


def _traffic_hint(hourly: Dict[str, Any]) -> Optional[str]:
    """If the venue's own slowest (non-low-volume) hours fall in the local rush
    window, flag a traffic / access-congestion signal. Derived from Pack 2 only."""
    hours = [
        h for h in (hourly.get("hours") or [])
        if not h.get("low_volume") and h.get("avg_ttla_sec") is not None
    ]
    if not hours:
        return None
    hours.sort(key=lambda h: float(h["avg_ttla_sec"]), reverse=True)
    rush_hits = [h for h in hours[:3] if int(h["hour"]) in _RUSH_HOURS]
    if not rush_hits:
        return None
    labels = ", ".join(f"{int(h['hour']):02d}:00" for h in rush_hits)
    return f"rush-hour peak (worst around {labels})"


def _geo_signal(location: Dict[str, Any], city: str, hourly: Dict[str, Any]) -> None:
    """Enrich the location pack in place with where the venue sits in the city:
    the curated city-centre coords, the great-circle distance + a coarse position
    label, a mall heuristic, and a rush-hour traffic hint. All deterministic;
    a missing curated city / coords -> None fields (the frontend still maps the
    venue pin alone)."""
    center = _CITY_CENTER.get(city)
    location["city_center_lat"] = center[0] if center is not None else None
    location["city_center_lon"] = center[1] if center is not None else None
    lat = location.get("lat")
    lon = location.get("lon")
    if center is not None and lat is not None and lon is not None:
        try:
            km = round(_haversine_km(float(lat), float(lon), center[0], center[1]), 1)
        except (TypeError, ValueError):
            km = None
        location["distance_km_from_center"] = km
        location["position_label"] = _position_label(km)
    else:
        location["distance_km_from_center"] = None
        location["position_label"] = None
    is_mall, mall_kw = _mall_hint(location)
    location["mall_hint"] = is_mall
    location["mall_reason"] = mall_kw
    location["traffic_hint"] = _traffic_hint(hourly)


def _pack_location(attr_rows: List[Dict[str, Any]], venue_id: str) -> Dict[str, Any]:
    row = next((r for r in attr_rows if str(r.get("venue_id")) == str(venue_id)), None)
    if row is None:
        return {"found": False}
    notes = row.get("venue_courier_notes")
    return {
        "found": True,
        "venue_type": row.get("venue_type"),
        "product_line_category": row.get("product_line_category"),
        "retail_business_segment": row.get("retail_business_segment"),
        "merchant_type": row.get("merchant_type"),
        "is_hub_store": row.get("is_hub_store"),
        "is_eatin": row.get("is_eatin"),
        "is_takeaway": row.get("is_takeaway"),
        "brand_name": row.get("brand_name") or None,
        "franchise_name": row.get("franchise_name") or None,
        "venue_address": row.get("venue_address"),
        "venue_postcode": row.get("venue_postcode") or None,
        "has_courier_notes": bool(notes),
        "courier_notes": notes or None,
        "access_keywords": _scan_access_keywords(notes),
        "has_opening_times": bool(row.get("has_opening_times")),
        "has_special_opening_times": bool(row.get("has_special_opening_times")),
        "open_hour": int(row["open_hour"]) if row.get("open_hour") is not None else None,
        "close_hour": int(row["close_hour"]) if row.get("close_hour") is not None else None,
        "special_opening_count": int(row["special_opening_count"]) if row.get("special_opening_count") is not None else None,
        "venue_hex8": row.get("venue_hex8") or None,
        "avg_uptime_l4w_min": row.get("avg_uptime_l4w_min"),
        "lat": row.get("venue_lat"),
        "lon": row.get("venue_long"),
    }


# ---------------------------------------------------------------------------
# Pack 7 — Peer benchmarking (same segment + venue_type in the city).
# ---------------------------------------------------------------------------

def _percentile_rank(values: List[float], x: float) -> Optional[float]:
    """Fraction of peer values <= x (0-1, higher = worse when x is a TTLA/rate)."""
    if not values:
        return None
    n_le = sum(1 for v in values if v <= x)
    return round(n_le / len(values), 3)


def _quantile(sorted_vals: List[float], q: float) -> Optional[float]:
    if not sorted_vals:
        return None
    idx = min(len(sorted_vals) - 1, max(0, int(round(q * (len(sorted_vals) - 1)))))
    return round(sorted_vals[idx], 1)


def _pack_peers(venue_row: Optional[Dict[str, Any]], venue_rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Rank THIS venue against comparable peers — same product_line_category
    (segment) AND same venue_type (grocery / restaurant / …) in the same city,
    each with >= MIN_VENUE_ORDERS. Percentile is over peer avg TTLA / unassign rate
    (higher percentile = slower / more unassigns than peers). Falls back to
    segment-only peers when the tighter set is too thin, flagging it."""
    if not venue_row:
        return {"found": False}

    seg = venue_row.get("product_line_category")
    vtype = venue_row.get("venue_type")

    def _rows_for(match_type: bool) -> List[Dict[str, Any]]:
        out = []
        for r in venue_rows:
            if r.get("product_line_category") != seg:
                continue
            if match_type and r.get("venue_type") != vtype:
                continue
            if (r.get("order_count") or 0) < MIN_VENUE_ORDERS:
                continue
            out.append(r)
        return out

    peers = _rows_for(match_type=True)
    matched_on = "segment+type"
    if len(peers) < MIN_PEERS:
        peers = _rows_for(match_type=False)
        matched_on = "segment"

    def _row_avg(r):
        c = r.get("order_count") or 0
        s = r.get("ttla_sec_sum") or 0
        return (s / c) if c else None

    ttla_vals = sorted([a for a in (_row_avg(r) for r in peers) if a is not None])
    un_vals = sorted([
        (r.get("unassigned_count") or 0) / (r.get("order_count") or 1) for r in peers
        if (r.get("order_count") or 0) > 0
    ])

    v_ttla = _row_avg(venue_row)
    v_un = (venue_row.get("unassigned_count") or 0) / (venue_row.get("order_count") or 1) if (venue_row.get("order_count") or 0) else None

    return {
        "found": True,
        "matched_on": matched_on,
        "venue_type": vtype,
        "segment": rt._CAT_TO_SLUG.get(seg),
        "peer_count": len(peers),
        "low_peer_count": len(peers) < MIN_PEERS,
        "ttla_percentile": _percentile_rank(ttla_vals, v_ttla) if v_ttla is not None else None,
        "unassign_percentile": _percentile_rank(un_vals, v_un) if v_un is not None else None,
        "peer_ttla_median_sec": _quantile(ttla_vals, 0.5),
        "peer_ttla_p75_sec": _quantile(ttla_vals, 0.75),
        "peer_unassign_median": round(_quantile(un_vals, 0.5) or 0, 4) if un_vals else None,
        "venue_avg_ttla_sec": _round1(v_ttla),
        "venue_unassign_rate": round(v_un, 4) if v_un is not None else None,
    }


# ---------------------------------------------------------------------------
# Opening-hours / closure correlation (Pack 6 enrichment).
# ---------------------------------------------------------------------------

def _opening_hours_signal(location: Dict[str, Any], hourly: Dict[str, Any]) -> None:
    """Enrich the location pack in place with an opening-hours correlation: does
    the venue's worst-TTLA window sit in the last operating hour(s) before close, or
    do orders land outside the parsed open->close envelope? A near-close cluster is a
    strong 'winding-down / staff leaving' signal; out-of-hours orders hint the parsed
    hours are stale (corroborates 'Venue closed' tags). Robust to a missing/24h
    envelope (open_hour==close_hour or nulls -> no signal)."""
    oh = location.get("open_hour")
    ch = location.get("close_hour")
    location["special_opening_count"] = location.get("special_opening_count")
    location["worst_hours_near_close"] = None
    location["out_of_hours_order_share"] = None
    location["near_close_hours"] = None
    if oh is None or ch is None or oh == ch:
        return

    worst = [h.get("hour") for h in (hourly.get("worst_hours") or []) if h.get("hour") is not None]
    # The final 2 operating hours before close (handle envelopes crossing midnight).
    near_close = {(ch - 1) % 24, (ch - 2) % 24}
    location["near_close_hours"] = sorted(near_close)
    location["worst_hours_near_close"] = bool(worst) and any(h in near_close for h in worst)

    # Share of orders confirmed outside the parsed open->close envelope.
    hours = hourly.get("hours") or []
    total = sum(int(h.get("order_count") or 0) for h in hours)
    if total > 0:
        def _in_window(h: int) -> bool:
            if oh <= ch:
                return oh <= h < ch
            return h >= oh or h < ch  # crosses midnight
        out_orders = sum(int(h.get("order_count") or 0) for h in hours
                         if h.get("hour") is not None and not _in_window(int(h["hour"])))
        location["out_of_hours_order_share"] = round(out_orders / total, 3)


# ---------------------------------------------------------------------------
# Data-quality gate.
# ---------------------------------------------------------------------------

def _data_quality(metrics: Dict[str, Any], hourly: Dict[str, Any], daily: Dict[str, Any],
                  convos: Dict[str, Any], location: Dict[str, Any]) -> Dict[str, Any]:
    orders = metrics.get("order_count") or 0 if metrics.get("found") else 0
    sufficient = bool(metrics.get("found")) and orders >= MIN_VENUE_ORDERS
    reasons: List[str] = []
    if not metrics.get("found"):
        reasons.append("Venue not present in the cached retail-TTLA population for this window.")
    elif orders < MIN_VENUE_ORDERS:
        reasons.append(f"Only {orders} orders in-window (< {MIN_VENUE_ORDERS} minimum for a reliable diagnosis).")

    return {
        "sufficient": sufficient,
        "reasons": reasons,
        "order_count": orders,
        "min_venue_orders": MIN_VENUE_ORDERS,
        "flags": {
            "hourly_thin": bool(hourly) and hourly.get("total_orders", 0) < MIN_VENUE_ORDERS,
            "daily_thin": bool(daily) and daily.get("eligible_day_count", 0) < 4,
            "no_conversations": not (convos and convos.get("total_conversations", 0) > 0),
            "no_location": not (location and location.get("found")),
        },
    }


# ---------------------------------------------------------------------------
# Public: build the full evidence-pack scorecard for ONE venue (no LLM).
# ---------------------------------------------------------------------------

def build_packs(
    venue_id: str,
    city: Optional[str] = None,
    lookback_days: int = 28,
    order_type: str = "regular",
    complete_weeks: Optional[int] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
) -> Dict[str, Any]:
    """Assemble the six deterministic evidence packs + data-quality gate for a
    venue. Cache-only reads (sign-in-safe). Returns a plain dict."""
    disp_city, country, wh_city = rt._resolve(city)
    ot = norm_order_type(order_type)

    metrics = _venue_metrics_and_benchmark(
        venue_id, country, wh_city, lookback_days, ot, complete_weeks, date_from, date_to
    )
    venue_orders = metrics.get("order_count") or 0 if metrics.get("found") else 0

    # All venue rows (cached) — reused for Pack 1 (via the helper above) and Pack 7
    # peer benchmarking here.
    all_venue_rows = rt._read_venue_rows(country, wh_city, lookback_days, ot, complete_weeks, date_from, date_to)
    venue_row = next((r for r in all_venue_rows if str(r.get("venue_id")) == str(venue_id)), None)

    hourly_rows = [r for r in _read_rows(_HOURLY_DATASET, country, wh_city, lookback_days, ot, complete_weeks, date_from, date_to)
                   if str(r.get("venue_id")) == str(venue_id)]
    daily_rows = [r for r in _read_rows(_DAILY_DATASET, country, wh_city, lookback_days, ot, complete_weeks, date_from, date_to)
                  if str(r.get("venue_id")) == str(venue_id)]
    convo_city_rows = _read_rows(_CONVOS_DATASET, country, wh_city, lookback_days, ot, complete_weeks, date_from, date_to)
    convo_venue_rows = [r for r in convo_city_rows if str(r.get("venue_id")) == str(venue_id)]
    attr_rows = _read_rows(_ATTRS_DATASET, country, wh_city, lookback_days, ot, complete_weeks, date_from, date_to)
    unassign_rows = _read_rows(_UNASSIGN_DATASET, country, wh_city, lookback_days, ot, complete_weeks, date_from, date_to)
    unassign_event_row = next((r for r in unassign_rows if str(r.get("venue_id")) == str(venue_id)), None)

    hourly = _pack_hourly(hourly_rows)
    daily = _pack_daily(daily_rows)
    convos = _pack_conversations(convo_venue_rows, convo_city_rows, venue_orders)
    unassign = _pack_unassign(metrics, unassign_event_row, venue_orders)
    location = _pack_location(attr_rows, venue_id)
    if location.get("found"):
        _opening_hours_signal(location, hourly)
        _geo_signal(location, disp_city, hourly)
    peers = _pack_peers(venue_row, all_venue_rows)
    dq = _data_quality(metrics, hourly, daily, convos, location)

    return {
        "venue_id": venue_id,
        "venue_name": metrics.get("venue_name") or location.get("brand_name") or venue_id,
        "city": disp_city,
        "country": country,
        "lookback_days": lookback_days,
        "order_type": ot,
        "cache_version": CACHE_VERSION,
        "data_quality": dq,
        "packs": {
            "metrics": metrics,
            "hourly": hourly,
            "daily": daily,
            "conversations": convos,
            "unassign": unassign,
            "location": location,
            "peers": peers,
        },
    }


def scorecard_freshness(
    city: Optional[str],
    lookback_days: int,
    order_type: str,
    complete_weeks: Optional[int] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    force: bool = False,
) -> Dict[str, Any]:
    """sign-in-safe freshness probe + background warm for the four venue-diagnostic
    caches (scoped to the current city + global filter set)."""
    disp_city, country, wh_city = rt._resolve(city)
    ot = norm_order_type(order_type)
    reads = _diag_reads(country, wh_city, lookback_days, ot, complete_weeks, date_from, date_to)
    scope_sfx = _suffix(ot, complete_weeks, date_from, date_to) or "all"

    def _warm(report=None):
        from app.services.auto_refresh import NOOP_PROGRESS
        report = report or NOOP_PROGRESS
        for r in reads:
            execute_query(r.dataset_key, r.params, force_refresh=True,
                          cache_by_lookback=r.cache_by_lookback, cache_suffix=r.cache_suffix)
            report.step()

    return view_freshness(
        reads,
        scope=f"venue_diag_view:{disp_city}:{lookback_days}:{scope_sfx}",
        signal_index=0,
        invalidate_prefixes=_INVALIDATE,
        warm=_warm,
        warm_total=len(reads),
        force=force,
    )


# ===========================================================================
# Phase 3 — LLM synthesis (strict structured output over the evidence packs).
# ===========================================================================

# ---------------------------------------------------------------------------
# Output schema (STRICT json_schema via pydantic). All fields required (no
# defaults) so OpenAI strict structured outputs accepts the schema — mirrors the
# CountryAIAnalysis pattern. Enum-like fields are plain str with the allowed
# values in the description (kept lenient across model families / drop_params).
# ---------------------------------------------------------------------------

class PerformanceOverview(BaseModel):
    ttla_level: str = Field(..., description="One of: low, moderate, high, critical (vs the segment city TTLA benchmark)")
    ttla_trend: str = Field(..., description="One of: improving, stable, worsening (from the daily pack trend)")
    unassign_level: str = Field(..., description="One of: low, moderate, high, critical (vs the segment city unassign rate)")
    unassign_trend: str = Field(..., description="One of: improving, stable, worsening")
    order_volume: str = Field(..., description="One of: thin, low, moderate, high (the venue's in-window order volume)")
    worst_hours: List[str] = Field(..., description="Local hours (0-23) with the worst TTLA, copied from hourly.worst_hours")
    worst_days: List[str] = Field(..., description="Dates with the worst TTLA, copied from daily.worst_days")
    benchmark_delta: str = Field(..., description="One quantified line: venue avg TTLA vs the segment city avg (seconds and %)")


class Finding(BaseModel):
    title: str = Field(..., description="Short finding title")
    description: str = Field(..., description="What the data shows, quantified")
    evidence: List[str] = Field(..., description="Exact numbers/tags/shares copied from the packs that support this finding")
    time_period: str = Field(..., description="When it occurs, e.g. '18:00-21:00', 'weekends', 'whole window'")
    impact_estimate: str = Field(..., description="Quantified impact, e.g. excess TTLA seconds or unassign pp")
    confidence: str = Field(..., description="One of: high, medium, low")
    classification: str = Field(..., description="One of: confirmed, likely, possible, insufficient")


class RootCause(BaseModel):
    venue_ops: List[str] = Field(..., description="Venue operations causes (prep time, readiness, order accuracy)")
    courier_access: List[str] = Field(..., description="Courier experience / access causes (long waits, unassigns)")
    location_infra: List[str] = Field(..., description="Location / infrastructure causes (mall, floor, parking, entrance)")
    peak_capacity: List[str] = Field(..., description="Peak / capacity causes (specific busy hours/days)")
    bad_venue_info: List[str] = Field(..., description="Bad venue information causes (missing/wrong notes, address, hours)")
    external: List[str] = Field(..., description="External causes (supply, weather, area-wide)")
    data_quality: List[str] = Field(..., description="Data-quality caveats affecting the diagnosis")


class RecommendedAction(BaseModel):
    addresses_finding: str = Field(..., description="Which finding title this action addresses")
    horizon: str = Field(..., description="One of: immediate, short, long, investigate")
    expected_impact: str = Field(..., description="Expected effect if actioned")
    owner: str = Field(..., description="Who should own it, e.g. venue team, courier ops, account manager")
    priority: str = Field(..., description="One of: high, medium, low")
    success_metric: str = Field(..., description="How to measure success, e.g. TTLA back under segment avg")


class Limitations(BaseModel):
    missing_data: List[str] = Field(..., description="Data that was missing/absent for this venue")
    weak_evidence: List[str] = Field(..., description="Signals too thin to conclude on")
    assumptions: List[str] = Field(..., description="Assumptions made")
    data_needed: List[str] = Field(..., description="Data that would strengthen the diagnosis")


class VenueDiagnostic(BaseModel):
    executive_summary: str = Field(..., description="2-4 sentence, quantified summary for this ONE venue")
    performance_overview: PerformanceOverview
    findings: List[Finding] = Field(..., description="Ranked findings, most important first; each must cite pack numbers")
    root_cause: RootCause
    recommended_actions: List[RecommendedAction] = Field(..., description="Concrete, prioritized actions")
    limitations: Limitations


# ---------------------------------------------------------------------------
# Prompt.
# ---------------------------------------------------------------------------

DEFINITIONS = [
    "TTLA (Task to Last Accept): seconds before the courier who ultimately picks up accepted the "
    "task; re-accepts after an unassign keep counting. Order-weighted mean in SECONDS, lower is "
    "faster. Every avg_ttla_sec in the packs is Σttla_sec / order_count.",
    "UNASSIGN: a purchase whose courier assignment was dropped. unassign_rate is the fraction of the "
    "venue's orders that were unassigned; _courier vs _ops split by who initiated (they overlap, so "
    "they do NOT sum to the total). unassign_contribution_pp is the venue's additive contribution to "
    "its SEGMENT's city unassign rate (percentage points); share_of_unassigns is its share of the "
    "segment's unassigns.",
    "SEGMENT: the venue's product line — Restaurant or Retail store. All benchmarks are per-segment "
    "(a Retail venue is compared to Retail city/country totals, never a mixed denominator).",
    "CONVERSATION THEMES: courier-app support conversations tagged on the Courier-Platform pickup (PU) "
    "and reassign (R) branches, linked to the venue's orders. per_100_orders = conversations per 100 "
    "of the venue's orders; share_of_city_theme = the venue's share of the whole city's volume for "
    "that theme. A theme is 'confirmed' only at >= its min count.",
    "PREP ERROR (avg_prep_error_min): signed minutes between the venue's initial pickup-ETA promise "
    "and when the order was actually ready. Positive = ready LATER than promised.",
    "POPULATION: on-demand orders only (delivered/refunded, Relay provider, no preorders/time-slots). "
    "Order type is set by the tab filter (Regular excludes Drive by default; Drive uses the platform "
    "venue id, so venue attributes then describe the platform, not one store — say so if order_type=drive).",
    "PEERS (pack `peers`): the venue ranked against comparable venues (same segment + venue_type in the "
    "city). ttla_percentile / unassign_percentile are the venue's rank among peers (0-1; higher = slower / "
    "more unassigns than peers). peer_ttla_median_sec / _p75_sec are the peer distribution. low_peer_count "
    "means too few peers to trust the rank.",
    "UNASSIGN EVENTS (pack `unassign`, when events_available): from the modeled unassign-event feed — "
    "unassign_events (total drops, can exceed unassigned orders = re-assignment churn), "
    "events_per_unassigned_order (multiplicity), distinct_couriers, events_courier/_ops, and "
    "median/avg_hold_before_unassign_sec (how long a courier held the task before dropping it; a long hold "
    "corroborates 'long wait at venue').",
    "OPENING HOURS (pack `location`): open_hour/close_hour are the parsed local operating envelope; "
    "worst_hours_near_close=true means the worst-TTLA hours sit in the last operating hour(s); "
    "out_of_hours_order_share is the fraction of orders outside the parsed hours (stale hours / closed-venue "
    "signal); special_opening_count = number of temporary-hours overrides.",
    "R3 CONTEXT (pack `location`): lat/lon are the venue's coordinates; city_center_lat/lon are the curated "
    "city-centre coords; distance_km_from_center is the great-circle distance; position_label is a coarse band "
    "(city centre / inner city / outer city / far outskirts). mall_hint=true means the venue type/brand/notes "
    "match a shopping-mall keyword (mall_reason) — a multi-entrance / hard-to-find-pickup risk. traffic_hint "
    "flags when the venue's OWN slowest hours fall in the local rush window (07-09 / 17-19) — a traffic / "
    "access-congestion signal, NOT an external traffic feed. Use these to support a 'location / hard-to-reach' "
    "hypothesis, but still corroborate with a conversation theme before marking it `confirmed`.",
    "CONVERSATION TEXT (pack `conversation_text`, deep mode only): PII-SCRUBBED, paraphrased themes from raw "
    "courier messages. Treat venue_related=true themes with a real mention_count as corroboration; never quote "
    "them as verbatim evidence.",
]

ANALYTICAL_RULES = [
    "Use ONLY numbers, tags and shares present in the evidence packs. NEVER invent or estimate a "
    "figure; quote the exact value when making a point.",
    "Every finding MUST carry `evidence` copied from the packs and a `classification`. Mark a cause "
    "`confirmed` ONLY when at least TWO independent packs agree (e.g. high TTLA in specific hours AND "
    "a matching conversation theme). One weak signal is at most `likely` or `possible`.",
    "An isolated complaint or a bucket below its minimum-volume floor (low_volume hours/days, themes "
    "under the min count) is `possible`/`insufficient`, never `confirmed`, and must not drive the "
    "headline.",
    "Location / accessibility is a HYPOTHESIS unless corroborated by a conversation theme "
    "(e.g. 'Courier can't find the venue' / 'Venue closed'); say so explicitly.",
    "Diagnose THIS venue only. Do not generalize to other venues or the city.",
    "If evidence is thin, say so in `limitations` rather than over-claiming.",
]


def build_system_prompt() -> str:
    parts = [
        "You are a senior Relay delivery-operations diagnostician. You receive a COMPACT, "
        "pre-aggregated evidence pack for ONE venue over a fixed window and must explain WHY its TTLA "
        "and unassign rate are elevated, then recommend concrete fixes. You are an interpreter of "
        "trustworthy numbers — you never compute or invent statistics.",
        "DEFINITIONS (use these EXACT meanings):\n- " + "\n- ".join(DEFINITIONS),
        "ANALYTICAL RULES (follow strictly):\n- " + "\n- ".join(ANALYTICAL_RULES),
        "Respond ONLY with the structured schema. Rank findings and actions most-important-first, "
        "keep every claim quantified and grounded in the pack, and populate the root_cause categories "
        "and limitations honestly.",
    ]
    return "\n\n".join(parts)


def _evidence_bundle(packs_result: Dict[str, Any]) -> Dict[str, Any]:
    """The compact JSON handed to the LLM — the packs plus identifying context.
    Already compact (daily ~28 rows, hourly <=24), so passed near-verbatim."""
    return {
        "venue_id": packs_result.get("venue_id"),
        "venue_name": packs_result.get("venue_name"),
        "city": packs_result.get("city"),
        "country": packs_result.get("country"),
        "lookback_days": packs_result.get("lookback_days"),
        "order_type": packs_result.get("order_type"),
        "data_quality": packs_result.get("data_quality"),
        "packs": packs_result.get("packs"),
    }


def build_insufficient_report(packs_result: Dict[str, Any]) -> Dict[str, Any]:
    """A no-LLM 'insufficient evidence' result (numbers still returned)."""
    dq = packs_result.get("data_quality", {})
    return {
        **_result_envelope(packs_result),
        "status": "insufficient_data",
        "analysis": None,
        "summary": None,
        "error": None,
        "insufficient_reasons": dq.get("reasons", []),
    }


def _result_envelope(packs_result: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "venue_id": packs_result.get("venue_id"),
        "venue_name": packs_result.get("venue_name"),
        "city": packs_result.get("city"),
        "country": packs_result.get("country"),
        "lookback_days": packs_result.get("lookback_days"),
        "order_type": packs_result.get("order_type"),
        "data_quality": packs_result.get("data_quality"),
        "packs": packs_result.get("packs"),
        "ai_cache_version": AI_CACHE_VERSION,
    }


async def synthesize_venue(packs_result: Dict[str, Any]) -> Dict[str, Any]:
    """Run the single structured LLM synthesis for a venue's packs.

    Pre-LLM gate: a venue that fails the data-quality gate returns an
    'insufficient evidence' report WITHOUT calling the LLM. Otherwise the packs
    are always returned alongside the structured `analysis` (or a plain-text
    `summary` / `error` when the LLM call or schema validation fails), so the UI
    can render numbers regardless."""
    from app.services.ai_service import generate_structured_analysis

    dq = packs_result.get("data_quality", {})
    if not dq.get("sufficient"):
        return build_insufficient_report(packs_result)

    settings = get_settings()
    parsed, error, raw = await generate_structured_analysis(
        build_system_prompt(),
        _evidence_bundle(packs_result),
        VenueDiagnostic,
        reasoning_effort=settings.litellm_analysis_reasoning_effort,
        # VenueDiagnostic is a LARGE schema (findings[] + 7 root-cause arrays +
        # actions[] + limitations). With gpt-5 reasoning tokens counting against
        # max_completion_tokens, the default analysis budget (6000) was fully spent
        # on reasoning, leaving EMPTY content -> schema-validation failure. Give this
        # call a much larger floor so reasoning + the full JSON both fit.
        max_output_tokens=max(settings.litellm_analysis_max_output_tokens, VENUE_SYNTHESIS_MAX_TOKENS),
        user_prefix=(
            "Diagnose ONLY this venue. Every claim must cite a number/tag/share present in this "
            "evidence bundle. Respond ONLY with the structured schema:"
        ),
    )
    return {
        **_result_envelope(packs_result),
        "status": "completed" if parsed is not None else "failed",
        "model": settings.litellm_model,
        "analysis": parsed,
        "summary": None if parsed is not None else raw,
        "error": error,
    }


# ===========================================================================
# Phase 7 — Raw courier conversation-text themes (2nd LLM pass, PII-scrubbed).
# ===========================================================================

class ConversationTheme(BaseModel):
    theme: str = Field(..., description="Short venue-relevant theme label, e.g. 'Order not ready', 'Venue closed', 'Long wait', 'Can't find venue', 'Wrong/again address'")
    paraphrase: str = Field(..., description="ONE neutral English paraphrase of what couriers said — NO names, phone numbers, ids, or verbatim quotes")
    mention_count: int = Field(..., description="How many of the supplied messages express this theme")
    severity: str = Field(..., description="One of: low, medium, high")
    venue_related: bool = Field(..., description="True only if the theme is about THIS venue's pickup/readiness/access, not generic app/courier chatter")


class ConversationTextAnalysis(BaseModel):
    themes: List[ConversationTheme] = Field(..., description="Venue-relevant themes found in fictional support notes; empty if none are venue-related")
    dominant_language: str = Field(..., description="Language used by the generated notes, normally English")
    scrubbed_note: str = Field(..., description="1-2 sentence aggregate summary without verbatim text")


SCRUB_SYSTEM_PROMPT = (
    "You are a privacy-conscious operations analyst. You receive RAW courier support "
    "FICTIONAL messages generated for ONE demo venue. Your job is to extract only "
    "VENUE-RELEVANT operational themes (order not ready on arrival, venue closed / can't be "
    "reached, courier can't find the venue, long wait at the venue, wrong/again address, order "
    "too heavy/large, staff/handover issues). Ignore greetings, thanks, and generic chit-chat.\n"
    "STRICT PRIVACY RULES: NEVER reproduce a message verbatim, NEVER include names, phone "
    "numbers, ids, plates or any personal data, and NEVER identify an individual. Paraphrase "
    "neutrally in ENGLISH and aggregate. If nothing venue-relevant is present, return an empty "
    "themes list. Do not invent themes that are not supported by the messages. Respond ONLY "
    "with the structured schema."
)


async def summarize_conversation_text(venue_name: str, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """2nd, PII-scrubbing LLM pass over raw courier messages. Returns ONLY the
    scrubbed, aggregated themes (never the raw bodies). Safe to include in the
    evidence bundle + surface to the UI."""
    from app.services.ai_service import generate_structured_analysis

    msgs = [
        {"tag": f"{r.get('tag_lvl2')}/{r.get('tag_lvl3')}", "text": (r.get("body") or "")[:240]}
        for r in rows if (r.get("body") or "").strip()
    ][:MAX_RAW_MESSAGES]
    flow_paths = [fp for fp in {str(r.get("flow_path")) for r in rows if r.get("flow_path")} if fp and fp != "None"]

    if not msgs:
        return {"available": False, "message_count": 0, "themes": [], "top_flow_paths": flow_paths[:5]}

    settings = get_settings()
    parsed, error, raw = await generate_structured_analysis(
        SCRUB_SYSTEM_PROMPT,
        {"venue": venue_name, "messages": msgs, "support_flow_paths": flow_paths[:8]},
        ConversationTextAnalysis,
        reasoning_effort=settings.litellm_reasoning_effort,
        max_output_tokens=settings.litellm_analysis_max_output_tokens,
        user_prefix=(
            "Extract venue-relevant, PII-scrubbed themes from these courier messages. "
            "Respond ONLY with the structured schema:"
        ),
    )
    if parsed is None:
        return {"available": False, "message_count": len(msgs), "themes": [], "top_flow_paths": flow_paths[:5], "error": error}
    data = parsed.model_dump() if hasattr(parsed, "model_dump") else parsed
    return {
        "available": True,
        "message_count": len(msgs),
        "themes": data.get("themes", []),
        "dominant_language": data.get("dominant_language"),
        "scrubbed_note": data.get("scrubbed_note"),
        "top_flow_paths": flow_paths[:5],
    }


async def enrich_with_conversation_text(
    packs_result: Dict[str, Any], *, allow_fetch: bool,
    complete_weeks=None, date_from=None, date_to=None,
) -> None:
    """Attach a PII-scrubbed `conversation_text` pack (Pack 4 v2) in place. Reads the
    deep per-venue message cache; when ``allow_fetch`` and a synthetic data source session is
    live, warms it first (background/job path only — NEVER from a request path).
    On any miss / thin data / LLM failure it attaches an 'unavailable' marker so the
    rest of the report is unaffected."""
    venue_id = packs_result.get("venue_id")
    disp_city, country, wh_city = rt._resolve(packs_result.get("city"))
    lookback = packs_result.get("lookback_days") or 28
    ot = packs_result.get("order_type") or "regular"

    rows = read_conversation_messages(venue_id, country, wh_city, lookback, ot, complete_weeks, date_from, date_to)
    if not rows and allow_fetch and connection_is_live():
        try:
            rows = fetch_conversation_messages(venue_id, country, wh_city, lookback, ot, complete_weeks, date_from, date_to)
        except Exception:
            rows = []

    if not rows:
        packs_result.setdefault("packs", {})["conversation_text"] = {"available": False, "message_count": 0, "themes": []}
        return
    scrubbed = await summarize_conversation_text(packs_result.get("venue_name") or str(venue_id), rows)
    packs_result.setdefault("packs", {})["conversation_text"] = scrubbed


# ===========================================================================
# Phase 4 — Multi-venue job queue (sequential, per-venue isolation, polling).
# ===========================================================================

import asyncio
import threading
import time
import uuid
from datetime import datetime, timezone

from app.services.cache import cache
from app.services.synthetic_data import connection_is_live

# Cap venues per job (bounds cost/latency; the frontend warns above this).
MAX_VENUES_PER_JOB = 10

# In-memory job store: {job_id: {..., venues: {venue_id: {status, ...}}}}.
_jobs: Dict[str, Dict[str, Any]] = {}
_jobs_lock = threading.Lock()

# Per-venue status states (see AI_VENUE_DIAGNOSTIC_PLAN.md §2).
STATUS_WAITING = "waiting"
STATUS_COLLECTING = "collecting_data"
STATUS_ANALYZING = "analyzing_performance"
STATUS_GENERATING = "generating_summary"
STATUS_COMPLETED = "completed"
STATUS_INSUFFICIENT = "insufficient_data"
STATUS_FAILED = "failed"


def _set_venue(job_id: str, vid: str, **fields) -> None:
    # NOTE: the 2nd positional is `vid` (not `venue_id`) on purpose — callers
    # spread result dicts (`**result`/`**report`/`**cached`) that themselves carry
    # a `venue_id` key, so naming it `venue_id` would raise "got multiple values
    # for argument 'venue_id'".
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return
        v = job["venues"].setdefault(str(vid), {})
        v.update(fields)


def _venue_ai_ck(city: str, venue_id: str, lookback_days: int, sfx: str) -> str:
    return f"venue_ai:{AI_CACHE_VERSION}:{city}:{venue_id}:{lookback_days}:{sfx}"


def _process_venue(job: Dict[str, Any], venue_id: str) -> None:
    """Build packs + synthesize ONE venue, isolated. Never opens a synthetic data source
    connection (packs are cache-only). Caches a successful diagnosis 6h."""
    job_id = job["job_id"]
    city = job["city"]
    lookback = job["lookback_days"]
    ot = job["order_type"]
    cw, df, dt = job["complete_weeks"], job["date_from"], job["date_to"]
    disp_city, _country, _wh = rt._resolve(city)
    sfx = _suffix(ot, cw, df, dt) or "all"

    ck = _venue_ai_ck(disp_city, str(venue_id), lookback, sfx)
    cached = cache.get(ck)
    if cached:
        _set_venue(job_id, venue_id, **cached, cached=True)
        return

    _set_venue(job_id, venue_id, status=STATUS_COLLECTING)
    packs_result = build_packs(venue_id, city, lookback, ot, cw, df, dt)

    if not packs_result.get("data_quality", {}).get("sufficient"):
        report = build_insufficient_report(packs_result)
        _set_venue(job_id, venue_id, **report, cached=False)
        return

    # Deep mode (opt-in): a 2nd, PII-scrubbing LLM pass over raw courier messages,
    # attached as the `conversation_text` pack BEFORE the main synthesis so its
    # themes feed the diagnosis. Isolated — a failure never blocks the report.
    if job.get("deep"):
        _set_venue(job_id, venue_id, status=STATUS_ANALYZING)
        try:
            asyncio.run(enrich_with_conversation_text(
                packs_result, allow_fetch=True,
                complete_weeks=cw, date_from=df, date_to=dt,
            ))
        except Exception:
            packs_result.setdefault("packs", {})["conversation_text"] = {"available": False, "message_count": 0, "themes": []}

    _set_venue(job_id, venue_id, status=STATUS_GENERATING,
               venue_name=packs_result.get("venue_name"),
               data_quality=packs_result.get("data_quality"),
               packs=packs_result.get("packs"))

    # 1 retry on a transient LLM failure.
    result = None
    for _attempt in range(2):
        result = asyncio.run(synthesize_venue(packs_result))
        if result.get("status") == "completed" and result.get("analysis") is not None:
            break
        time.sleep(0.5)

    _set_venue(job_id, venue_id, **result, cached=False)
    if result.get("status") == "completed" and result.get("analysis") is not None:
        cache.set(ck, result, 6 * 3600)


def _run_job(job_id: str) -> None:
    job = _jobs.get(job_id)
    if not job:
        return
    with _jobs_lock:
        job["status"] = "running"

    # Optional one-shot warm of the four caches for this city — ONLY if a
    # synthetic data source session is already live (never opens sign-in from this path). Missing
    # files are queried once so cold venues aren't all "insufficient".
    if connection_is_live():
        try:
            warm_venue_diagnostics(job["city"], job["lookback_days"], force_refresh=False)
        except Exception:
            pass

    for venue_id in job["venue_ids"]:
        try:
            _process_venue(job, venue_id)
        except Exception as exc:  # per-venue isolation — one failure never stops the rest
            _set_venue(job_id, venue_id, status=STATUS_FAILED, error=str(exc)[:300],
                       analysis=None, summary=None)

    with _jobs_lock:
        job["status"] = "done"
        job["finished_at"] = datetime.now(timezone.utc).isoformat()


def start_job(
    venue_ids: List[str],
    city: Optional[str],
    lookback_days: int = 28,
    order_type: str = "regular",
    complete_weeks: Optional[int] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    deep: bool = False,
) -> Dict[str, Any]:
    """Create a job for up to MAX_VENUES_PER_JOB venues and start the sequential
    background worker. ``deep`` adds the PII-scrubbed conversation-text pass (a 2nd
    LLM call per venue). Returns the initial job snapshot."""
    ids = [str(v) for v in (venue_ids or [])][:MAX_VENUES_PER_JOB]
    ot = norm_order_type(order_type)
    disp_city, _country, _wh = rt._resolve(city)
    job_id = uuid.uuid4().hex
    job = {
        "job_id": job_id,
        "status": "queued",
        "city": disp_city,
        "lookback_days": lookback_days,
        "order_type": ot,
        "complete_weeks": complete_weeks,
        "date_from": date_from,
        "date_to": date_to,
        "deep": bool(deep),
        "venue_ids": ids,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "venues": {vid: {"venue_id": vid, "status": STATUS_WAITING} for vid in ids},
    }
    with _jobs_lock:
        _jobs[job_id] = job
    threading.Thread(target=_run_job, args=(job_id,), daemon=True).start()
    return get_job(job_id)


# ===========================================================================
# Phase 7 — Feedback loop (lightweight capture, append-only JSONL on disk).
# ===========================================================================

import json
import os

_FEEDBACK_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "logs", "venue_diag_feedback.jsonl")
_feedback_lock = threading.Lock()


def record_feedback(
    venue_id: str,
    rating: str,
    *,
    city: Optional[str] = None,
    lookback_days: Optional[int] = None,
    order_type: Optional[str] = None,
    comment: Optional[str] = None,
    username: Optional[str] = None,
) -> Dict[str, Any]:
    """Persist a thumbs up/down (+ optional note) on a venue's diagnosis to an
    append-only JSONL log. Feeds a future quality review; deliberately simple (no DB)."""
    rating = (rating or "").lower().strip()
    if rating not in ("up", "down"):
        raise ValueError("rating must be 'up' or 'down'")
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "venue_id": str(venue_id),
        "rating": rating,
        "city": city,
        "lookback_days": lookback_days,
        "order_type": order_type,
        "comment": (comment or "")[:2000] or None,
        "username": username,
    }
    with _feedback_lock:
        os.makedirs(os.path.dirname(_FEEDBACK_PATH), exist_ok=True)
        with open(_FEEDBACK_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return {"ok": True, "recorded_at": entry["ts"]}


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return None
        # Shallow copy for a stable snapshot to the caller.
        return {
            "job_id": job["job_id"],
            "status": job["status"],
            "city": job["city"],
            "lookback_days": job["lookback_days"],
            "order_type": job["order_type"],
            "deep": job.get("deep", False),
            "venue_ids": list(job["venue_ids"]),
            "created_at": job["created_at"],
            "finished_at": job.get("finished_at"),
            "venues": {k: dict(v) for k, v in job["venues"].items()},
        }
