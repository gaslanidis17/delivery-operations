from __future__ import annotations

"""
Country "big analysis" AI pipeline.

ONE pipeline parameterized by (topic, focus, range):

    clamp range -> gather cached feeds -> aggregate to a COMPACT stat pack
    (rates from summed counts, influence/IQR-ranked cities, reason distributions
    — NEVER raw order rows) -> build a prompt (shared Definitions block + topic
    framing + injected stat pack) -> LLM (STRICT structured output).

Each topic is a registry entry (``TopicSpec``): { definitions subset, framing,
aggregator_fn }. The output schema (``CountryAIAnalysis``) is shared for the MVP.
The router (``routers/ai_country.py``) handles validation, lookback clamping,
caching (6h TTL) and the LLM call; this module owns the data shaping + prompt.

Numbers in the response come ONLY from the stat pack (computed here from the
existing daily roll-ups + the flag engine). The LLM provides the narrative; the
UI can always render the stat-pack numbers even when the LLM call fails.
"""

import math
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field

from app.config import (
    get_settings,
    canonical_max_lookback_days,
    COUNTRY_NAMES,
    CITY_OPERATIONS_AREA_ALIAS_REVERSE,
)
from app.services.data_processor import FLAG_LABELS, REASON_FLAG_NAMES

# Bump when the prompt, definitions, stat-pack shape, or output schema changes so
# 6h-cached entries written by an older version can never be served.
AI_CACHE_VERSION = "v1"

# How many cities to surface in a whole-country analysis before the "others"
# rollup (IQR outliers below this rank are still surfaced — see _select_country).
TOP_CITIES = 8
# Minimum-volume guard: a city needs at least this many orders (the metric's
# window denominator) to (a) contribute to the IQR fence and (b) be flagged as an
# outlier — so a 2-order, 100%-late city is never flagged as a system issue, but
# a genuinely tiny-but-extreme city above the floor still surfaces.
MIN_VOLUME_FOR_OUTLIER = 20
# Worst-period rows to include (top days by the metric's rate).
WORST_PERIODS = 5
MIN_DEN_FOR_PERIOD = 10


# ---------------------------------------------------------------------------
# Structured output schema (STRICT json_schema via pydantic). All fields are
# required (no defaults) so OpenAI strict structured outputs accepts the schema.
# ---------------------------------------------------------------------------

class CityCallout(BaseModel):
    city: str = Field(..., description="Exact city name copied from the stat pack")
    severity: str = Field(..., description="One of: critical, high, moderate, watch")
    headline: str = Field(..., description="One-line, quantified reason this city needs attention")
    reason_tags: List[str] = Field(
        ..., description="Short reason labels (use the provided reason labels where relevant)"
    )


class CountryAIAnalysis(BaseModel):
    headline: str = Field(..., description="One-sentence headline for the whole analysis")
    summary: List[str] = Field(..., description="3-6 concise, quantified key findings")
    key_drivers: List[str] = Field(..., description="The main drivers/reasons behind the metric")
    cities_to_watch: List[CityCallout] = Field(
        ..., description="Cities needing attention, most important first (empty for a single-city focus)"
    )
    recommended_actions: List[str] = Field(..., description="Concrete, actionable next steps")
    caveats: List[str] = Field(..., description="Data-coverage / provenance caveats to keep in mind")


# ---------------------------------------------------------------------------
# Definitions block — EXACT, code/synthetic data source-verified meanings, subset per topic.
# Injected into the system prompt so the model never guesses from field names.
# ---------------------------------------------------------------------------

DEFINITIONS: Dict[str, str] = {
    "late": (
        "LATE (SLA): an order is late when its actual delivery time exceeds the "
        "upper-bound pre-estimate by more than 20 minutes (pre_estimate_high + 20 < "
        "actual completion minutes). The official `is_late` comes from "
        "synthetic job records_high_quality_deliveries scoped to "
        "is_sla_aligned_definition = TRUE. Reason flags run over this same 20-minute "
        "model and explain WHY a late order was late — they do not redefine lateness."
    ),
    "rotten": (
        "ROTTEN: an order took at least ROTTEN_THRESHOLD_MIN (= 20) minutes to be "
        "accepted by a courier (time-to-last-accept TTLA >= 20 min). It signals a "
        "courier-supply gap, not a delivery-speed problem."
    ),
    "clone": (
        "CLONE / CLONED ORDER: the order's task group was duplicated "
        "(ctg.is_duplicate = TRUE), i.e. it effectively needed a second courier leg. "
        "Clone-rate = share of orders with is_duplicate. (This is distinct from the "
        "`is_cloned` reason flag, which is derived from courier-count >= 2.)"
    ),
    "heavy": (
        "HEAVY: an order that required a WEIGHT courier capability. Tiers, lightest to "
        "heaviest: WEIGHT_L < WEIGHT_XL < WEIGHT_XXL < WEIGHT_XXXL. This is "
        "weight-driven; the exact kilograms per tier are NOT fixed (they change often) "
        "and are not stored in the warehouse — describe heavy orders by tier, never "
        "cite a kg number."
    ),
    "large": (
        "LARGE: a HIGH-VALUE order (roughly order value > EUR 40), tagged "
        "LARGE_DELIVERY. It is value-driven and distinct from heavy/weight."
    ),
    "heavy_large_subset": (
        "HEAVY/LARGE SUBSET = orders that are heavy OR large. An order can be both; "
        "the composite heavy/large counts add the heavy and large numerators, so an "
        "order that is both is reflected in each."
    ),
    "influence_outlier": (
        "INFLUENCE = a city's share of the country's total numerator for the metric "
        "(its absolute contribution to the bad outcome). The ranked `cities` list is "
        "ordered by influence descending (largest contributor first). OUTLIER = a city "
        "whose rate is an IQR-fence outlier across cities (computed only over cities "
        "above a minimum order volume), marked by `outlier` / `outlier_side`. A "
        "high-influence city moves the country number most; a low-influence outlier is "
        "a small but anomalous hotspot."
    ),
    "drive_excluded": "Drive orders are EXCLUDED from every metric here.",
    "coverage_caveats": (
        "COVERAGE CAVEATS to tell the reader: pickup/dropoff timing (pdt) and "
        "assignment-stage inputs are sparse outside Region One (R1), so some reason "
        "flags can read 0 for data reasons rather than real ones; and `is_restaurant_slow` "
        "is disabled (hardcoded False) — do not surface it. Reason distributions come "
        "from the city late-orders model (pre-estimate based), so they will not perfectly "
        "reconcile to the SLA rate KPIs (an accepted trade-off)."
    ),
}

BASE_ROLE = (
    "You are a senior delivery-operations analyst for Relay food delivery. You receive "
    "a COMPACT, pre-aggregated stat pack for one country over a fixed time window and "
    "must produce a rigorous, decision-ready analysis. Use ONLY the numbers in the "
    "stat pack — never invent or estimate figures, and quote the exact values "
    "(rates, counts, influence %) when making a point. Refer to cities by their exact "
    "names as they appear in the stat pack. Be specific and concise; do not hedge or "
    "use filler."
)

OUTPUT_INSTRUCTIONS = (
    "Respond ONLY with the structured schema. Field guidance:\n"
    "- headline: one quantified sentence capturing the situation.\n"
    "- summary: 3-6 bullet findings, each grounded in stat-pack numbers.\n"
    "- key_drivers: the main reasons behind the metric (use the reason distribution / "
    "supply context provided; map flag keys to their human labels in `flag_labels`).\n"
    "- cities_to_watch: the cities most needing attention, MOST IMPORTANT FIRST. Prefer "
    "high-influence cities (biggest contributors) and flagged outliers. Each callout's "
    "`severity` must be exactly one of critical/high/moderate/watch, `headline` must be "
    "quantified, and `reason_tags` should use the provided reason labels where relevant. "
    "Leave this list empty when the focus is a single city.\n"
    "- recommended_actions: concrete, prioritized operational steps (e.g. add couriers of "
    "a vehicle type in specific cities/hours, investigate specific venues/tiers).\n"
    "- caveats: surface the relevant data-coverage / provenance caveats."
)


# ---------------------------------------------------------------------------
# Metric definitions (which feed + numerator/denominator fields each topic uses).
# ---------------------------------------------------------------------------

METRIC_DEFS: Dict[str, Dict[str, Any]] = {
    "lateness": {
        "label": "Overall lateness (SLA, drive-excluded)",
        "source": "daily_rates_total",
        "num": ["late_count"], "den": ["total_orders"],
        "num_label": "late orders", "den_label": "delivered orders",
        "den_is_subpop": False, "direction": "high",
    },
    "rotten": {
        "label": "Rotten rate (TTLA >= 20 min, drive-excluded)",
        "source": "daily_rates_total",
        "num": ["rotten_count"], "den": ["total_orders"],
        "num_label": "severely delayed deliveries", "den_label": "delivered orders",
        "den_is_subpop": False, "direction": "high",
    },
    "heavy_large": {
        "label": "Heavy/large lateness (SLA)",
        "source": "hl_lateness_total",
        "num": ["heavy_late", "large_late"], "den": ["heavy_count", "large_count"],
        "num_label": "late heavy/large", "den_label": "heavy/large deliveries",
        "den_is_subpop": True, "direction": "high",
    },
    "heavy": {
        "label": "Heavy lateness (SLA)",
        "source": "hl_lateness_total",
        "num": ["heavy_late"], "den": ["heavy_count"],
        "num_label": "late heavy", "den_label": "heavy deliveries",
        "den_is_subpop": True, "direction": "high",
    },
    "large": {
        "label": "Large lateness (SLA)",
        "source": "hl_lateness_total",
        "num": ["large_late"], "den": ["large_count"],
        "num_label": "late large", "den_label": "large deliveries",
        "den_is_subpop": True, "direction": "high",
    },
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


def _rate(num: float, den: float) -> Optional[float]:
    return (num / den * 100.0) if den > 0 else None


def _metric_window(rows: List[Dict[str, Any]], mdef: Dict[str, Any]) -> Tuple[float, float]:
    """Sum a metric's numerator/denominator over a set of daily rows."""
    num = sum(_f(r, fld) for r in rows for fld in mdef["num"])
    den = sum(_f(r, fld) for r in rows for fld in mdef["den"])
    return num, den


def _quantile(sorted_vals: List[float], q: float) -> float:
    n = len(sorted_vals)
    if n == 0:
        return float("nan")
    if n == 1:
        return sorted_vals[0]
    pos = (n - 1) * q
    base = int(math.floor(pos))
    rest = pos - base
    nxt = sorted_vals[base + 1] if base + 1 < n else sorted_vals[base]
    return sorted_vals[base] + (nxt - sorted_vals[base]) * rest


# ---------------------------------------------------------------------------
# City ranking (influence + IQR outliers), ported from frontend regionBuckets.ts.
# ---------------------------------------------------------------------------

def _city_stats(
    cities_feed: List[Dict[str, Any]],
    mdef: Dict[str, Any],
    country_num: float,
    country_rate: Optional[float],
) -> List[Dict[str, Any]]:
    """Per-city window stats ranked by INFLUENCE desc, with IQR-outlier flags.

    Influence = city numerator / country numerator (constant denominator), so
    influence-desc equals numerator-desc; tiebreaks: numerator desc, name asc.
    """
    raw: List[Dict[str, Any]] = []
    for c in cities_feed:
        rows = c.get(mdef["source"], []) or []
        num, den = _metric_window(rows, mdef)
        rate = _rate(num, den)
        influence = (num / country_num * 100.0) if country_num > 0 else 0.0
        delta = (rate - country_rate) if (rate is not None and country_rate is not None) else None
        raw.append({
            "city": c.get("city"), "num": num, "den": den, "rate": rate,
            "influence": influence, "delta": delta,
            "outlier": False, "outlier_side": None,
        })

    # IQR fence over rates of cities meeting the minimum-volume guard.
    pts = [r["rate"] for r in raw if r["rate"] is not None and r["den"] >= MIN_VOLUME_FOR_OUTLIER]
    if len(pts) >= 4:
        sp = sorted(pts)
        q1, q3 = _quantile(sp, 0.25), _quantile(sp, 0.75)
        iqr = q3 - q1
        if iqr > 0:
            upper = q3 + 1.5 * iqr
            lower = q1 - 1.5 * iqr
            for r in raw:
                if r["rate"] is None or r["den"] < MIN_VOLUME_FOR_OUTLIER:
                    continue
                if r["rate"] > upper:
                    r["outlier"], r["outlier_side"] = True, "high"
                elif mdef["direction"] == "both" and r["rate"] < lower:
                    r["outlier"], r["outlier_side"] = True, "low"

    raw.sort(key=lambda r: (-r["influence"], -r["num"], str(r["city"])))
    return raw


def _fmt_city(r: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "city": r["city"],
        "rate_pct": _round1(r["rate"]),
        "numerator": int(round(r["num"])),
        "denominator": int(round(r["den"])),
        "influence_pct": _round1(r["influence"]),
        "delta_vs_country_pp": _round1(r["delta"]),
        "outlier": r["outlier"],
        "outlier_side": r["outlier_side"],
    }


def _aggregate_others(hidden: List[Dict[str, Any]], country_num: float) -> Optional[Dict[str, Any]]:
    if not hidden:
        return None
    num = sum(r["num"] for r in hidden)
    den = sum(r["den"] for r in hidden)
    return {
        "cities": len(hidden),
        "rate_pct": _round1(_rate(num, den)),
        "numerator": int(round(num)),
        "denominator": int(round(den)),
        "influence_pct": _round1((num / country_num * 100.0) if country_num > 0 else 0.0),
    }


def _select_country(
    stats: List[Dict[str, Any]], country_num: float
) -> Tuple[List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Top-N by influence + any IQR outliers below the cut (so tiny-but-extreme
    hotspots still surface), plus an 'others' rollup that reconciles to the
    country total."""
    top = stats[:TOP_CITIES]
    top_names = {r["city"] for r in top}
    extra = [r for r in stats[TOP_CITIES:] if r["outlier"] and r["city"] not in top_names]
    visible = top + extra
    visible_names = {r["city"] for r in visible}
    hidden = [r for r in stats if r["city"] not in visible_names]
    return [_fmt_city(r) for r in visible], _aggregate_others(hidden, country_num)


def _country_metric(rows: List[Dict[str, Any]], mdef: Dict[str, Any]) -> Dict[str, Any]:
    num, den = _metric_window(rows, mdef)
    return {
        "label": mdef["label"],
        "rate_pct": _round1(_rate(num, den)),
        "numerator": int(round(num)),
        "denominator": int(round(den)),
        "num_label": mdef["num_label"],
        "den_label": mdef["den_label"],
        "den_is_subpopulation": mdef["den_is_subpop"],
    }


def _worst_periods(rows: List[Dict[str, Any]], mdef: Dict[str, Any]) -> List[Dict[str, Any]]:
    periods: List[Dict[str, Any]] = []
    for r in rows:
        num = sum(_f(r, fld) for fld in mdef["num"])
        den = sum(_f(r, fld) for fld in mdef["den"])
        if den < MIN_DEN_FOR_PERIOD:
            continue
        rate = _rate(num, den)
        if rate is None:
            continue
        periods.append({
            "date": r.get("confirmed_date"),
            "rate_pct": _round1(rate),
            "numerator": int(round(num)),
            "denominator": int(round(den)),
        })
    periods.sort(key=lambda p: -(p["rate_pct"] or 0.0))
    return periods[:WORST_PERIODS]


def _compact_block(block: Dict[str, Any]) -> Dict[str, Any]:
    """Trim a reason block for the stat pack: keep flag_counts + total + the top
    co-occurring combinations, drop the verbose full overlap matrix (the UI's
    OverlapMatrix only needs top_combinations)."""
    out: Dict[str, Any] = {
        "flag_counts": block.get("flag_counts", {}),
        "total": block.get("total", 0),
    }
    combos = block.get("top_combinations")
    if combos:
        out["top_combinations"] = combos[:8]
    return out


def _supply_context(
    perf_rows: List[Dict[str, Any]], cities_of_interest: List[str]
) -> Dict[str, Any]:
    """Aggregate country_perf_metrics into per-city courier-supply signals
    (order-weighted task-acceptance % and average TTLA), reverse-aliasing the
    warehouse city name. Used by the rotten topic to connect rate to supply."""
    agg: Dict[str, Dict[str, float]] = {}
    country = {"orders": 0.0, "acc_num": 0.0, "acc_den": 0.0, "ttla_num": 0.0, "ttla_den": 0.0}

    def _bucket(city: str) -> Dict[str, float]:
        return agg.setdefault(city, {"orders": 0.0, "acc_num": 0.0, "acc_den": 0.0, "ttla_num": 0.0, "ttla_den": 0.0})

    for r in perf_rows:
        wc = r.get("city")
        city = CITY_OPERATIONS_AREA_ALIAS_REVERSE.get(wc, wc)
        oc = _f(r, "order_count")
        b = _bucket(city)
        b["orders"] += oc
        country["orders"] += oc
        acc = r.get("task_acceptance_rate")
        if acc is not None:
            b["acc_num"] += float(acc) * oc
            b["acc_den"] += oc
            country["acc_num"] += float(acc) * oc
            country["acc_den"] += oc
        ttla = r.get("avg_ttla_sec")
        if ttla is not None:
            b["ttla_num"] += float(ttla) * oc
            b["ttla_den"] += oc
            country["ttla_num"] += float(ttla) * oc
            country["ttla_den"] += oc

    def _shape(b: Dict[str, float]) -> Dict[str, Any]:
        return {
            "orders": int(round(b["orders"])),
            "acceptance_pct": _round1((b["acc_num"] / b["acc_den"] * 100.0) if b["acc_den"] > 0 else None),
            "avg_ttla_sec": _round1((b["ttla_num"] / b["ttla_den"]) if b["ttla_den"] > 0 else None),
        }

    by_city = {c: _shape(agg[c]) for c in cities_of_interest if c in agg}
    return {"country": _shape(country), "by_city": by_city}


# ---------------------------------------------------------------------------
# Feed fetching (cached upstream) — late imports avoid a router<->service cycle.
# ---------------------------------------------------------------------------

def _fetch_master(code: str, lookback: int) -> Dict[str, Any]:
    from app.routers.country_analytics import get_country_master
    return get_country_master(country_code=code, lookback_days=lookback)


def _fetch_cities(code: str, lookback: int) -> List[Dict[str, Any]]:
    from app.routers.region_analytics import get_region_country_cities
    return get_region_country_cities(country_code=code, lookback_days=lookback).get("cities", [])


def _fetch_late_orders(code: str, lookback: int) -> List[Dict[str, Any]]:
    from app.routers.country_analytics import get_enriched_country_late_orders
    return get_enriched_country_late_orders(code, lookback)


def _base_pack(topic: str, code: str, focus_city: Optional[str], lookback: int) -> Dict[str, Any]:
    return {
        "topic": topic,
        "scope": "city" if focus_city else "country",
        "focus": focus_city or "country",
        "lookback_days": lookback,
        "country": {"code": code, "name": COUNTRY_NAMES.get(code, code)},
        "flag_labels": FLAG_LABELS,
    }


# ---------------------------------------------------------------------------
# Per-topic aggregators -> compact stat pack.
# ---------------------------------------------------------------------------

def _aggregate_rate_topic(
    topic: str, metric_id: str, code: str, focus_city: Optional[str], lookback: int,
    *, reasons: str,
) -> Dict[str, Any]:
    """Shared shape for the two lateness topics (overall + heavy/large)."""
    mdef = METRIC_DEFS[metric_id]
    master = _fetch_master(code, lookback)
    cities_feed = _fetch_cities(code, lookback)
    country_rows = master.get(mdef["source"], []) or []
    c_num, _c_den = _metric_window(country_rows, mdef)
    country_rate = _rate(*_metric_window(country_rows, mdef))

    pack = _base_pack(topic, code, focus_city, lookback)

    # Country-level metric(s).
    metrics = {metric_id: _country_metric(country_rows, mdef)}
    if metric_id == "heavy_large":
        metrics["heavy"] = _country_metric(country_rows, METRIC_DEFS["heavy"])
        metrics["large"] = _country_metric(country_rows, METRIC_DEFS["large"])
    pack["country"]["metrics"] = metrics
    pack["worst_periods"] = _worst_periods(country_rows, mdef)
    pack["primary_metric"] = metric_id

    stats = _city_stats(cities_feed, mdef, c_num, country_rate)

    # Reason distribution (lazy: load the heavy enriched feed only here).
    from app.routers.country_analytics import build_reason_block, build_heavy_large_blocks
    enriched = _fetch_late_orders(code, lookback)

    if focus_city:
        focus_stat = next((r for r in stats if r["city"] == focus_city), None)
        rank = next((i + 1 for i, r in enumerate(stats) if r["city"] == focus_city), None)
        pack["focus_city"] = _fmt_city(focus_stat) if focus_stat else {
            "city": focus_city, "rate_pct": None, "numerator": 0, "denominator": 0,
            "influence_pct": 0.0, "delta_vs_country_pp": None, "outlier": False, "outlier_side": None,
        }
        pack["focus_rank"] = rank
        pack["total_cities"] = len(stats)
        city_orders = [o for o in enriched if o.get("ui_city") == focus_city]
        if reasons == "heavy_large":
            blocks = build_heavy_large_blocks(city_orders, with_overlap=True)
            pack["reasons"] = {"scope": focus_city, "heavy": _compact_block(blocks["heavy"]), "large": _compact_block(blocks["large"])}
        else:
            pack["reasons"] = {"scope": focus_city, "all": _compact_block(build_reason_block(city_orders, with_overlap=True))}
    else:
        visible, others = _select_country(stats, c_num)
        pack["cities"] = visible
        pack["others"] = others
        pack["total_cities"] = len(stats)
        if reasons == "heavy_large":
            blocks = build_heavy_large_blocks(enriched, with_overlap=True)
            pack["reasons"] = {"scope": "country", "heavy": _compact_block(blocks["heavy"]), "large": _compact_block(blocks["large"])}
        else:
            pack["reasons"] = {"scope": "country", "all": _compact_block(build_reason_block(enriched, with_overlap=True))}

    return pack


def aggregate_heavy_large_lateness(code: str, focus_city: Optional[str], lookback: int) -> Dict[str, Any]:
    return _aggregate_rate_topic(
        "heavy_large_lateness", "heavy_large", code, focus_city, lookback, reasons="heavy_large"
    )


def aggregate_overall_lateness(code: str, focus_city: Optional[str], lookback: int) -> Dict[str, Any]:
    return _aggregate_rate_topic(
        "overall_lateness", "lateness", code, focus_city, lookback, reasons="all"
    )


def aggregate_rotten(code: str, focus_city: Optional[str], lookback: int) -> Dict[str, Any]:
    mdef = METRIC_DEFS["rotten"]
    master = _fetch_master(code, lookback)
    cities_feed = _fetch_cities(code, lookback)
    country_rows = master.get("daily_rates_total", []) or []
    c_num, _ = _metric_window(country_rows, mdef)
    country_rate = _rate(*_metric_window(country_rows, mdef))

    pack = _base_pack("rotten", code, focus_city, lookback)
    pack["country"]["metrics"] = {"rotten": _country_metric(country_rows, mdef)}
    pack["worst_periods"] = _worst_periods(country_rows, mdef)
    pack["primary_metric"] = "rotten"

    stats = _city_stats(cities_feed, mdef, c_num, country_rate)
    perf_rows = master.get("perf_metrics", []) or []

    if focus_city:
        focus_stat = next((r for r in stats if r["city"] == focus_city), None)
        rank = next((i + 1 for i, r in enumerate(stats) if r["city"] == focus_city), None)
        pack["focus_city"] = _fmt_city(focus_stat) if focus_stat else {
            "city": focus_city, "rate_pct": None, "numerator": 0, "denominator": 0,
            "influence_pct": 0.0, "delta_vs_country_pp": None, "outlier": False, "outlier_side": None,
        }
        pack["focus_rank"] = rank
        pack["total_cities"] = len(stats)
        pack["supply"] = _supply_context(perf_rows, [focus_city])
    else:
        visible, others = _select_country(stats, c_num)
        pack["cities"] = visible
        pack["others"] = others
        pack["total_cities"] = len(stats)
        pack["supply"] = _supply_context(perf_rows, [c["city"] for c in visible])

    return pack


# ---------------------------------------------------------------------------
# Topic registry. Adding a topic later = one entry here (+ an aggregator above).
# ---------------------------------------------------------------------------

@dataclass
class TopicSpec:
    id: str
    label: str
    description: str
    definitions: List[str]
    framing: str
    aggregator: Callable[[str, Optional[str], int], Dict[str, Any]]


TOPIC_REGISTRY: Dict[str, TopicSpec] = {
    "heavy_large_lateness": TopicSpec(
        id="heavy_large_lateness",
        label="Heavy & large order lateness",
        description="Why heavy & large orders are late, and which cities drive it.",
        definitions=["late", "heavy", "large", "heavy_large_subset", "influence_outlier", "drive_excluded", "coverage_caveats"],
        framing=(
            "TOPIC: Heavy & large order lateness. Explain WHY heavy and large orders are "
            "late (using the heavy/large reason distributions) and WHICH cities drive the "
            "country's late heavy/large volume (using influence + outliers). The stat pack "
            "gives heavy, large and combined heavy/large late rates and counts."
        ),
        aggregator=aggregate_heavy_large_lateness,
    ),
    "overall_lateness": TopicSpec(
        id="overall_lateness",
        label="Overall lateness",
        description="Drivers of the country's overall lateness and the worst cities.",
        definitions=["late", "influence_outlier", "drive_excluded", "coverage_caveats"],
        framing=(
            "TOPIC: Overall lateness. Explain the drivers of the country's overall lateness "
            "(using the reason distribution over all late orders) and identify the worst "
            "cities by influence + outlier status. The stat pack gives the overall SLA late "
            "rate and per-city contributions."
        ),
        aggregator=aggregate_overall_lateness,
    ),
    "rotten": TopicSpec(
        id="rotten",
        label="Severely delayed deliveries (supply gaps)",
        description="Rotten root causes (courier-supply gaps) and the worst cities/periods.",
        definitions=["rotten", "influence_outlier", "drive_excluded", "coverage_caveats"],
        framing=(
            "TOPIC: Severely delayed deliveries (courier-supply gaps). Explain the root causes of rotten "
            "orders using the rotten rate, the worst cities (influence + outliers), the "
            "worst periods, and the courier-supply context (task-acceptance % and average "
            "TTLA per city). Frame recommendations around courier supply."
        ),
        aggregator=aggregate_rotten,
    ),
}

TOPIC_IDS: List[str] = list(TOPIC_REGISTRY.keys())


# ---------------------------------------------------------------------------
# Prompt assembly + small public helpers used by the router.
# ---------------------------------------------------------------------------

def build_system_prompt(spec: TopicSpec, focus_city: Optional[str], country_name: str) -> str:
    parts: List[str] = [BASE_ROLE]
    parts.append("DEFINITIONS (use these EXACT meanings):\n- " + "\n- ".join(DEFINITIONS[d] for d in spec.definitions))
    parts.append(spec.framing)
    if focus_city:
        parts.append(
            f"FOCUS: a deep-dive on the city '{focus_city}' within {country_name}. Use the "
            f"country-level `country.metrics` as the anchor/benchmark and explain how "
            f"'{focus_city}' compares (see `focus_city` for its rate, counts, influence, "
            f"delta vs country, outlier status, and rank among {country_name}'s cities). "
            f"Leave `cities_to_watch` empty and focus the narrative on '{focus_city}'."
        )
    else:
        parts.append(
            f"FOCUS: a whole-country analysis of {country_name}. The `cities` list is already "
            f"ranked by influence (share of the country's bad numerator) descending and "
            f"includes any IQR outliers; `others` rolls up the rest so the parts reconcile to "
            f"the country total. Populate `cities_to_watch` with the cities most needing "
            f"attention, most important first."
        )
    parts.append(OUTPUT_INSTRUCTIONS)
    return "\n\n".join(parts)


def clamp_lookback(lookback_days: Optional[int]) -> int:
    """Clamp a requested window to [1, canonical_max_lookback_days()]."""
    max_days = canonical_max_lookback_days()
    return max(1, min(int(lookback_days or 28), max_days))


def build_stat_pack(topic: str, code: str, focus_city: Optional[str], lookback: int) -> Dict[str, Any]:
    return TOPIC_REGISTRY[topic].aggregator(code, focus_city, lookback)
