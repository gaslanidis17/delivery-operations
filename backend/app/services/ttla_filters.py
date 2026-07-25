"""Synthetic filter helpers retained for API compatibility.

The portfolio build does not construct or execute warehouse queries. These
helpers normalize user selections and create deterministic cache keys only.
"""

from __future__ import annotations

from typing import Optional

ORDER_TYPE_REGULAR = "regular"
ORDER_TYPE_DRIVE = "drive"
ORDER_TYPES = {ORDER_TYPE_REGULAR, ORDER_TYPE_DRIVE}

TTLA_MODE_DEFAULT = "default"
TTLA_MODE_FIRST_COURIER = "first_courier"
TTLA_MODE_FIXED = "fixed"
TTLA_MODES = {TTLA_MODE_DEFAULT, TTLA_MODE_FIRST_COURIER, TTLA_MODE_FIXED}


def norm_order_type(order_type: Optional[str]) -> str:
    return order_type if order_type in ORDER_TYPES else ORDER_TYPE_REGULAR


def norm_ttla_mode(mode: Optional[str]) -> str:
    return mode if mode in TTLA_MODES else TTLA_MODE_DEFAULT


def date_window_clause(
    lookback_days: int,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    complete_weeks: Optional[int] = None,
) -> str:
    """Return a neutral serialized period for the synthetic generator."""
    if date_from and date_to:
        return f"custom:{date_from}:{date_to}"
    if complete_weeks:
        return f"weeks:{int(complete_weeks)}"
    return f"days:{int(lookback_days)}"


def order_type_clause(order_type: Optional[str]) -> str:
    """Return the normalized synthetic scenario segment."""
    return f"segment:{norm_order_type(order_type)}"


def period_suffix(
    complete_weeks: Optional[int],
    date_from: Optional[str],
    date_to: Optional[str],
) -> Optional[str]:
    if date_from and date_to:
        return f"d{date_from}_{date_to}"
    if complete_weeks:
        return f"w{int(complete_weeks)}"
    return None


def order_type_suffix(order_type: Optional[str]) -> Optional[str]:
    return "segment-drive" if norm_order_type(order_type) == ORDER_TYPE_DRIVE else None


def ttla_mode_suffix(mode: Optional[str]) -> Optional[str]:
    normalized = norm_ttla_mode(mode)
    if normalized == TTLA_MODE_FIRST_COURIER:
        return "latency-first"
    if normalized == TTLA_MODE_FIXED:
        return "latency-average"
    return None


def ttla_tab_population_clause(
    date_window_clause: str,
    order_type_clause: str,
) -> str:
    return f"{order_type_clause}|{date_window_clause}"


def country_ttla_population_clause(lookback_days: int) -> str:
    return f"region-window:{int(lookback_days)}"


def ttla_mode_fragments(
    mode: Optional[str],
    country: str,
    city: Optional[str],
    population_clause: str,
) -> dict[str, str]:
    """Return inert compatibility fields expected by existing route builders."""
    normalized = norm_ttla_mode(mode)
    return {
        "ttla_cte_inner": "",
        "ttla_cte_prepend": "",
        "ttla_cte_outer": "",
        "ttla_join": "",
        "ttla_expr": normalized,
        "ttla_not_null": "synthetic",
    }
