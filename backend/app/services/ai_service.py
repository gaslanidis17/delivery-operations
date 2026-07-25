from __future__ import annotations

"""AI summary service using LiteLLM for provider-agnostic LLM calls."""

from typing import Any, Optional, Tuple
import json

from app.config import get_settings

PROMPTS = {
    "general": """You are a delivery operations analyst. You receive aggregated data about 
late and rotten food delivery orders in a city. Produce 3-5 concise, actionable bullet points.

Focus on:
- Which time periods or days have the worst lateness
- Which venues are the biggest contributors
- Whether undersupply, bundling, or venue readiness are the primary drivers
- Concrete recommendations (e.g. "add couriers during 6-9 PM", "investigate venue X")

Be specific with numbers. Do not hedge or use filler language.""",

    "venue": """You are a delivery operations analyst reviewing venue performance data.
You receive per-venue metrics including late %, rotten %, venue-caused lateness, prep times,
and problem scores. Produce 3-5 concise, actionable bullet points.

Focus on:
- Which venues have the highest problem scores and why
- Patterns in venue types (restaurant vs retail) that drive lateness
- Whether venue prep time or venue readiness is the bigger issue
- Specific venues to investigate or escalate to venue management
- Recommendations to reduce venue-caused delays

Be specific with venue names and numbers. Do not hedge or use filler language.""",

    "courier": """You are a delivery operations analyst reviewing courier travel performance.
You receive per-courier metrics including slow travel %, average speeds, pickup/dropoff times,
and speed benchmarks by vehicle type. Produce 3-5 concise, actionable bullet points.

Focus on:
- Which vehicle types have the most slow travel issues
- Whether pickup or dropoff travel is the bigger bottleneck
- Couriers with unusually high slow travel rates
- How actual speeds compare to targets by vehicle type
- Recommendations for courier routing, training, or fleet optimization

Be specific with numbers and vehicle types. Do not hedge or use filler language.""",

    "rotten": """You are a delivery operations analyst reviewing rotten order data.
Severely delayed deliveries are those with excessively long Time To Last Accept (TTLA >= 20 min),
indicating courier supply issues. Produce 3-5 concise, actionable bullet points.

Focus on:
- Daily trends in rotten order rates and which days are worst
- The ratio of severely delayed deliveries to total and late orders
- Whether the rotten rate is improving or worsening over time
- Which time periods have the most supply shortages
- Recommendations for courier supply management

Be specific with numbers and dates. Do not hedge or use filler language.""",

    "country": """You are a delivery operations analyst reviewing country-level delivery data
across multiple cities. You receive heavy/large order metrics, vehicle type distributions,
and lateness trends. Produce 3-5 concise, actionable bullet points.

Focus on:
- Which cities perform best/worst for heavy and large order delivery
- Vehicle type distribution issues (e.g. too many walkers for heavy orders)
- Trends in lateness rates for heavy vs regular orders across cities
- Cross-city patterns and best practices that could be shared
- Recommendations for fleet and logistics optimization at the country level

Be specific with city names and numbers. Do not hedge or use filler language.""",

    "clone": """You are a delivery operations analyst reviewing clone rate data for heavy/large orders.
Cloned orders are those needing 2+ couriers due to weight or size, often indicating supply gaps.
You receive clone rates by weight tier, acceptance rates, vehicle distribution, and cost data.
Produce 5-7 concise, actionable bullet points as an "Action Plan".

Focus on:
- Clone rate trends: is the rate increasing or stable? Which days are worst?
- Which weight tiers (WEIGHT_L/XL/XXL/XXXL) have the highest clone rates and why
- Acceptance rate issues: which tiers couriers avoid and possible reasons
- Vehicle type distribution: are the right vehicles available for heavy orders?
- Whether a DxGy incentive bonus would help (e.g., "do X heavy orders, get Y reward")
- Cost efficiency: compare weight costs to clone cost impact
- Supply recommendations: how many additional couriers of what type and when

Be specific with numbers, tiers, and vehicle types. Do not hedge or use filler language.""",
}


# Prefix used when no structured schema is requested.
AI_ERROR_PREFIX = "AI summary unavailable:"


async def generate_ai_analysis(
    prompt_key: str,
    data: dict[str, Any],
    *,
    system_prompt: Optional[str] = None,
    response_format: Any = None,
    reasoning_effort: Optional[str] = None,
    max_output_tokens: Optional[int] = None,
    user_prefix: str = "Analyze this delivery data:",
) -> str:
    """Generate an AI analysis and return the model's text content.

    The classic callers pass just ``(prompt_key, data)`` and get a free-text
    summary built from the fixed ``PROMPTS`` dict (behavior preserved). The
    Country "big analysis" pipeline overrides:
      - ``system_prompt`` — a per-call system prompt (bypasses ``PROMPTS``);
      - ``response_format`` — a pydantic model / json_schema for STRICT
        structured output (litellm then returns a JSON string in ``content``);
      - ``reasoning_effort`` / ``max_output_tokens`` — per-call overrides of the
        global gpt-5 knobs (e.g. "medium" + a larger budget for richer output).

    ``litellm.drop_params = True`` keeps ``reasoning_effort`` / ``response_format``
    safe across model families (OpenAI / Claude / Ollama).
    """
    s = get_settings()

    if s.data_source == "synthetic":
        return (
            "- Evening peaks show the highest SLA breach share; consider shifting capacity 17:00–21:00.\n"
            "- A handful of partner sites drive most breach flags; prioritize the top three by volume-weighted impact.\n"
            "- Queue-aging and redispatch signals co-occur on bundled routes — review batching rules.\n"
            "- Accept-latency outliers cluster on two vehicle classes; validate dispatch scoring for those modes."
        )

    sys_prompt = system_prompt if system_prompt is not None else PROMPTS.get(prompt_key, PROMPTS["general"])
    context = json.dumps(data, indent=2, default=str)

    try:
        import os
        import litellm
        litellm.drop_params = True
        if s.litellm_api_key:
            os.environ["OPENAI_API_KEY"] = s.litellm_api_key
        kwargs: dict[str, Any] = dict(
            model=s.litellm_model,
            messages=[
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": f"{user_prefix}\n\n{context}"},
            ],
            # LiteLLM maps max_tokens -> max_completion_tokens for gpt-5; reasoning
            # tokens count against this budget, so keep it well above the answer
            # length to avoid truncating the visible text to empty.
            max_tokens=max_output_tokens or s.litellm_max_output_tokens,
            # Used by gpt-5 reasoning models; dropped by drop_params on gpt-4o*.
            reasoning_effort=reasoning_effort or s.litellm_reasoning_effort,
        )
        if response_format is not None:
            kwargs["response_format"] = response_format
        response = await litellm.acompletion(**kwargs)
        choice = response.choices[0]
        msg = choice.message
        content = msg.content
        if content:
            return content
        # No visible content. On reasoning models (gpt-5) an empty content with
        # finish_reason == "length" means the max_completion_tokens budget was fully
        # spent on reasoning tokens before any answer was emitted — surface that as a
        # clear, actionable error instead of the useless Message(...) repr (which used
        # to leak into the UI and always failed schema validation).
        finish = getattr(choice, "finish_reason", None)
        if finish == "length":
            return (
                f"{AI_ERROR_PREFIX} the model hit its output-token limit before "
                "producing an answer (reasoning budget exhausted). Increase "
                "max_output_tokens or lower reasoning_effort."
            )
        # Structured calls must return parseable JSON only — never fall back to the
        # message repr. Free-text callers may still use a reasoning_content fallback.
        if response_format is not None:
            return f"{AI_ERROR_PREFIX} the model returned no content."
        try:
            reasoning = msg.get("reasoning_content", "")
        except AttributeError:
            reasoning = getattr(msg, "reasoning_content", "") or ""
        return reasoning or f"{AI_ERROR_PREFIX} the model returned no content."
    except Exception as e:
        return f"{AI_ERROR_PREFIX} {e}"


async def generate_structured_analysis(
    system_prompt: str,
    data: dict[str, Any],
    response_format: Any,
    *,
    reasoning_effort: Optional[str] = None,
    max_output_tokens: Optional[int] = None,
    user_prefix: str = "Analyze this aggregated delivery data and respond ONLY with the structured schema:",
) -> Tuple[Optional[dict], Optional[str], Optional[str]]:
    """Run a structured (json_schema / pydantic) LLM call.

    Returns ``(parsed, error, raw_text)``:
      - ``parsed`` — a plain dict validated against ``response_format`` (a pydantic
        BaseModel subclass) when the model returned valid structured output, else
        ``None``;
      - ``error`` — a short message when the call or parse failed, else ``None``;
      - ``raw_text`` — the model's raw content (the JSON string on success, or any
        prose on failure), usable as a plain-text fallback in the UI.

    The caller still gets the (separately computed) stat pack to render numbers
    even when ``parsed`` is ``None``.
    """
    raw = await generate_ai_analysis(
        "general",
        data,
        system_prompt=system_prompt,
        response_format=response_format,
        reasoning_effort=reasoning_effort,
        max_output_tokens=max_output_tokens,
        user_prefix=user_prefix,
    )

    if not raw or raw.startswith(AI_ERROR_PREFIX):
        # Strip our own prefix so the caller/UI sees a clean reason (not "[AI error] ...").
        reason = raw[len(AI_ERROR_PREFIX):].strip() if raw and raw.startswith(AI_ERROR_PREFIX) else (raw or "Empty AI response")
        return None, reason, None

    # Strict validation against the schema. Try the JSON string directly, then a
    # lenient json.loads, then a fence/brace-extracted candidate (handles the rare
    # case where a model wraps the JSON in ```json fences or leading prose).
    candidates = [raw]
    stripped = _extract_json(raw)
    if stripped and stripped != raw:
        candidates.append(stripped)
    for cand in candidates:
        for attempt in ("model_validate_json", "model_validate"):
            try:
                if attempt == "model_validate_json":
                    obj = response_format.model_validate_json(cand)
                else:
                    obj = response_format.model_validate(json.loads(cand))
                return obj.model_dump(), None, raw
            except Exception:
                continue

    return None, "Structured output did not match the expected schema", raw


def _extract_json(text: str) -> Optional[str]:
    """Best-effort pull of a JSON object out of a model reply — strips ```json code
    fences and any prose before/after the outermost {...}. Returns None if nothing
    object-like is found."""
    if not text:
        return None
    t = text.strip()
    if t.startswith("```"):
        # Drop the opening fence line (``` or ```json) and any trailing fence.
        t = t.split("\n", 1)[1] if "\n" in t else t
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
        t = t.strip()
    start = t.find("{")
    end = t.rfind("}")
    if start != -1 and end != -1 and end > start:
        return t[start:end + 1]
    return None


async def generate_summary(
    summary_data: dict[str, Any],
    flag_counts: dict[str, int],
    top_venues: list[dict[str, Any]],
    trend_data: list[dict[str, Any]],
) -> str:
    """Legacy wrapper for the general late orders summary."""
    return await generate_ai_analysis("general", {
        "summary": summary_data,
        "lateness_reason_counts": flag_counts,
        "top_late_venues": top_venues[:10],
        "daily_trend": trend_data[-14:],
    })
