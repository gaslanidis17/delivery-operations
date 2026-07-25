from __future__ import annotations

"""Country "big analysis" AI endpoint.

GET /api/country/{country_code}/ai-analysis?topic=&focus=&lookback_days=

Drives a shared pipeline (services/country_ai.py) parameterized by
(topic, focus, range): validate + clamp -> build a compact stat pack from the
existing cached feeds -> build the prompt (definitions + topic framing + stat
pack) -> STRICT structured LLM call -> cache the result 6h. The stat pack is
ALWAYS returned (so the UI can render numbers even if the LLM call fails); the
structured `analysis` is null on LLM failure with a plain-text `summary` /
`error` fallback.
"""

from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Path, Query, HTTPException
from fastapi.concurrency import run_in_threadpool

from app.config import get_settings, COUNTRY_NAMES, CITY_DATA
from app.services.cache import cache
from app.services.ai_service import generate_structured_analysis
from app.services.country_ai import (
    TOPIC_REGISTRY,
    TOPIC_IDS,
    AI_CACHE_VERSION,
    CountryAIAnalysis,
    build_system_prompt,
    build_stat_pack,
    clamp_lookback,
)

router = APIRouter(prefix="/api/country", tags=["country-ai"])

# Cache the AI result for 6h (results are deterministic enough over a window and
# the LLM call is the expensive part).
AI_CACHE_TTL_SECONDS = 6 * 3600


def _country_city_names(code: str) -> List[str]:
    return [c["name"] for c in CITY_DATA if c["country"] == code]


def _resolve_focus(code: str, focus: str):
    """Return the canonical city display name for a focus value, or None for the
    whole-country scope. Validates the city belongs to the country (like
    country_analytics.py validates against CITY_DATA)."""
    if not focus or focus.strip().lower() == "country":
        return None
    by_lower = {n.lower(): n for n in _country_city_names(code)}
    key = focus.strip().lower()
    if key in by_lower:
        return by_lower[key]
    raise HTTPException(
        status_code=400,
        detail=f"Unknown focus city '{focus}' for country {code}. Use 'country' or one of: "
        + ", ".join(_country_city_names(code)),
    )


@router.get("/{country_code}/ai-analysis")
async def get_country_ai_analysis(
    country_code: str = Path(...),
    topic: str = Query(..., description="One of: " + ", ".join(TOPIC_IDS)),
    focus: str = Query(default="country", description="'country' or a city in the country"),
    lookback_days: int = Query(default=28, ge=1, le=365),
):
    code = country_code.upper()
    if code not in COUNTRY_NAMES:
        raise HTTPException(status_code=404, detail=f"Unknown country '{country_code}'")
    if topic not in TOPIC_REGISTRY:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown topic '{topic}'. Valid topics: {', '.join(TOPIC_IDS)}",
        )

    focus_city = _resolve_focus(code, focus)
    focus_key = focus_city or "country"
    # Clamp the window to the canonical deep-cache depth. IMPORTANT: this window
    # drives the analysis explicitly (the panel does NOT inherit the shared page
    # filter).
    lookback = clamp_lookback(lookback_days)

    ck = f"country_ai:{AI_CACHE_VERSION}:{code}:{topic}:{focus_key}:{lookback}"
    cached = cache.get(ck)
    if cached:
        return {**cached, "cached": True}

    spec = TOPIC_REGISTRY[topic]
    settings = get_settings()
    name = COUNTRY_NAMES.get(code, code)

    # Build the compact stat pack off the event loop — it may read deep caches,
    # enrich late orders, or (cold) hit synthetic data source, none of which should block the
    # async loop.
    stat_pack = await run_in_threadpool(build_stat_pack, topic, code, focus_city, lookback)
    system_prompt = build_system_prompt(spec, focus_city, name)

    parsed, error, raw = await generate_structured_analysis(
        system_prompt,
        stat_pack,
        CountryAIAnalysis,
        reasoning_effort=settings.litellm_analysis_reasoning_effort,
        max_output_tokens=settings.litellm_analysis_max_output_tokens,
    )

    result = {
        "code": code,
        "name": name,
        "topic": topic,
        "topic_label": spec.label,
        "focus": focus_key,
        "scope": "city" if focus_city else "country",
        "lookback_days": lookback,
        "model": settings.litellm_model,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "cached": False,
        "stat_pack": stat_pack,
        "analysis": parsed,
        # Plain-text fallback: the model's raw content when structured parsing
        # failed (None when parsing succeeded or the call errored with no text).
        "summary": None if parsed is not None else raw,
        "error": error,
    }

    # Only cache a successful structured result, so a transient LLM failure can be
    # retried rather than served stale for 6h.
    if parsed is not None:
        cache.set(ck, result, AI_CACHE_TTL_SECONDS)
    return result
