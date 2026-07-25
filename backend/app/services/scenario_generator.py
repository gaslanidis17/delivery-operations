"""Deterministic fictional scenarios for the public portfolio demo."""

from __future__ import annotations

import hashlib
import random
from datetime import date, timedelta
from typing import Any, Optional

from app.config import CITY_DATA, CITY_COUNTRY_MAP, COUNTRY_NAMES

VEHICLES = ["car", "motorcycle", "bicycle", "scooter", "walking"]


def _rng(*parts: Any) -> random.Random:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return random.Random(int(h[:16], 16))


def _lookback(params: dict[str, Any]) -> int:
    return int(params.get("lookback_days") or 28)


def _city(params: dict[str, Any], fallback: Optional[str]) -> str:
    return str(params.get("city") or fallback or "Ridgeport")


def _country(params: dict[str, Any]) -> str:
    return str(params.get("country") or "R1").upper()


def _dates(lookback: int) -> list[str]:
    today = date.today()
    return [
        (today - timedelta(days=d)).isoformat()
        for d in range(lookback, 0, -1)
    ]


def _city_coords(city: str) -> tuple[float, float]:
    for c in CITY_DATA:
        if c["name"] == city:
            return float(c["lat"]), float(c["lon"])
    return 45.0, 10.0


def _cities_for_country(code: str) -> list[str]:
    return [c["name"] for c in CITY_DATA if c["country"] == code.upper()]


def _daily_totals(
    seed_key: str,
    lookback: int,
    *,
    base_orders: int = 900,
    late_rate: float = 0.11,
    rotten_rate: float = 0.04,
    clone_rate: float = 0.06,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for d in _dates(lookback):
        r = _rng(seed_key, d)
        total = int(base_orders * r.uniform(0.82, 1.18))
        late = int(total * late_rate * r.uniform(0.7, 1.35))
        rotten = int(total * rotten_rate * r.uniform(0.6, 1.4))
        cloned = int(total * clone_rate * r.uniform(0.5, 1.5))
        heavy = int(total * 0.08 * r.uniform(0.7, 1.3))
        large = int(total * 0.12 * r.uniform(0.7, 1.3))
        rows.append(
            {
                "confirmed_date": d,
                "delivered_date": d,
                "date": d,
                "total_orders": total,
                "late_count": late,
                "rotten_count": rotten,
                "cloned_count": cloned,
                "heavy_count": heavy,
                "large_count": large,
                "heavy_late": int(heavy * late_rate * 1.2),
                "large_late": int(large * late_rate * 1.1),
                "clone_rate_pct": round(cloned / max(total, 1) * 100, 1),
                "avg_ttla_sec": int(r.uniform(95, 210)),
                "avg_delivery_time": round(r.uniform(28, 44), 1),
                "delivery_order_count": int(total * 0.92),
                "delivery_min_sum": round(total * 0.92 * r.uniform(30, 42), 2),
                "ttla_order_count": int(total * 0.88),
                "ttla_sec_sum": round(total * 0.88 * r.uniform(100, 190), 2),
            }
        )
    return rows


def _late_order_row(city: str, d: str, idx: int) -> dict[str, Any]:
    r = _rng("order", city, d, idx)
    lat, lon = _city_coords(city)
    completion = r.uniform(32, 58)
    return {
        "purchase_id": abs(hash((city, d, idx))) % 10_000_000,
        "venue_name": f"Partner {r.randint(100, 999)}",
        "venue_id": r.randint(10_000, 99_999),
        "venue_lat": lat + r.uniform(-0.08, 0.08),
        "venue_long": lon + r.uniform(-0.08, 0.08),
        "dropoff_h3_index": f"8{ r.randint(10**14, 10**15 - 1)}",
        "dropoff_h3_lat": lat + r.uniform(-0.05, 0.05),
        "dropoff_h3_lon": lon + r.uniform(-0.05, 0.05),
        "status": "delivered",
        "delivered_date": d,
        "delivered_at": f"{d} {r.randint(10, 22):02d}:{r.randint(0, 59):02d}:00",
        "received_at": f"{d} {r.randint(8, 20):02d}:{r.randint(0, 59):02d}:00",
        "delivered_hour": r.randint(11, 21),
        "completion_time_min": round(completion, 1),
        "pre_estimate_high": round(completion - r.uniform(5, 15), 1),
        "pre_estimate_avg": round(completion - r.uniform(8, 18), 1),
        "is_sla_breach": True,
        "is_sla_breach_official": r.random() < 0.85,
        "ready_vs_pickup_eta_sec": r.choice([420, 180, -120, 90, 600]),
        "courier_arrived_after_eta": r.random() < 0.35,
        "courier_wait_at_venue_sec": r.choice([30, 420, 180, 90]),
        "pickup_duration_min": r.uniform(4, 14),
        "initial_pickup_eta_min": r.uniform(6, 12),
        "courier_task_total_min": r.uniform(18, 42),
        "courier_started_before_ready": r.random() < 0.2,
        "bundled_count": r.choice([1, 1, 1, 2, 3]),
        "time_to_last_accept_sec": r.choice([240, 480, 900, 1200, 360]),
        "dropoff_distance_m": r.uniform(800, 6500),
        "shown_to_couriers_count": r.randint(1, 8),
        "task_accepted_count": r.randint(1, 3),
        "eta_error_seconds": r.choice([-120, 300, 720, 0]),
        "vehicle_type": r.choice(VEHICLES),
        "restaurant_total_time_min": r.uniform(8, 35),
        "courier_travel_to_venue_min": r.uniform(4, 18),
        "is_heavy_delivery": r.random() < 0.08,
        "is_large_delivery": r.random() < 0.11,
        "ui_city": city,
        "city": city,
        "country": CITY_COUNTRY_MAP.get(city, "R1"),
    }


def _late_orders(city: str, lookback: int, cap: int = 400) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for d in _dates(lookback)[-min(lookback, 21) :]:
        n = _rng(city, d).randint(8, 28)
        for i in range(n):
            if len(rows) >= cap:
                return rows
            rows.append(_late_order_row(city, d, i))
    return rows


def generate_mock_rows(
    dataset_key: str,
    params: dict[str, Any],
    city: Optional[str],
) -> list[dict[str, Any]]:
    p = dict(params or {})
    lb = _lookback(p)
    c = _city(p, city)
    country = _country(p)
    seed = f"{dataset_key}:{c}:{country}:{lb}"

    # --- Country / region daily series -----------------------------------------
    if dataset_key in {
        "country_daily_rates_total.dataset",
        "country_daily_rates_by_city.dataset",
    }:
        rows = _daily_totals(seed, lb)
        if "by_city" in dataset_key:
            out: list[dict[str, Any]] = []
            for city_name in _cities_for_country(country) or [c]:
                for row in rows:
                    r = _rng(seed, city_name, row["confirmed_date"])
                    factor = r.uniform(0.15, 0.45)
                    out.append(
                        {
                            **row,
                            "city": city_name,
                            "total_orders": int(row["total_orders"] * factor),
                            "late_count": int(row["late_count"] * factor),
                            "rotten_count": int(row["rotten_count"] * factor),
                        }
                    )
            return out
        return rows

    if dataset_key in {
        "country_hl_lateness_total.dataset",
        "country_hl_lateness_by_city.dataset",
        "country_clone_rate_total.dataset",
        "country_clone_rate_by_city.dataset",
        "country_adt_total.dataset",
        "country_adt_by_city.dataset",
        "country_ttla_total.dataset",
        "country_ttla_by_city.dataset",
    }:
        rows = _daily_totals(seed, lb)
        if "by_city" in dataset_key:
            out = []
            for city_name in _cities_for_country(country) or [c]:
                for row in rows:
                    r = _rng(seed, city_name, row["confirmed_date"])
                    factor = r.uniform(0.12, 0.4)
                    scaled = {k: v for k, v in row.items()}
                    for k in (
                        "total_orders",
                        "late_count",
                        "rotten_count",
                        "cloned_count",
                        "heavy_count",
                        "large_count",
                        "heavy_late",
                        "large_late",
                        "delivery_order_count",
                        "ttla_order_count",
                    ):
                        if k in scaled:
                            scaled[k] = int(scaled[k] * factor)
                    for k in ("delivery_min_sum", "ttla_sec_sum"):
                        if k in scaled:
                            scaled[k] = round(float(scaled[k]) * factor, 2)
                    scaled["city"] = city_name
                    out.append(scaled)
            return out
        return rows

    if dataset_key == "country_late_reasons.dataset":
        out = []
        for city_name in _cities_for_country(country):
            out.extend(_late_orders(city_name, lb, cap=80))
        return out

    if dataset_key.startswith("country_") and dataset_key.endswith(".dataset"):
        return _daily_totals(seed, lb)

    # --- City late / rotten / maps ---------------------------------------------
    if dataset_key == "base_late_orders.dataset":
        return _late_orders(c, lb)

    if dataset_key == "late_orders_summary.dataset":
        orders = _late_orders(c, lb, cap=250)
        total = max(len(orders) * 4, 120)
        late = len(orders)
        dates = _dates(lb)
        return [
            {
                "total_orders": total,
                "late_orders": late,
                "late_orders_official": int(late * 0.92),
                "late_pct": round(late / total * 100, 2),
                "avg_late_completion_min": 46.2,
                "avg_completion_min": 36.8,
                "period_start": dates[0],
                "period_end": dates[-1],
            }
        ]

    if dataset_key == "late_orders_trend.dataset":
        return [
            {
                "delivered_date": row["confirmed_date"],
                "total_orders": row["total_orders"],
                "late_orders": row["late_count"],
                "late_pct": round(row["late_count"] / max(row["total_orders"], 1) * 100, 2),
                "avg_completion_min": row["avg_delivery_time"],
                "total_heavy": row["heavy_count"],
                "total_large": row["large_count"],
                "total_heavy_or_large": row["heavy_count"] + row["large_count"],
            }
            for row in _daily_totals(seed, lb)
        ]

    if dataset_key in {"delayed_orders.dataset", "rotten_summary.dataset"}:
        return [
            {
                "delivered_date": row["confirmed_date"],
                "total_orders": row["total_orders"],
                "platform_orders": row["total_orders"],
                "late_count": row["late_count"],
                "rotten_count": row["rotten_count"],
            }
            for row in _daily_totals(seed, lb)
        ]

    if dataset_key == "hourly_distribution.dataset":
        r = _rng(seed, "hourly")
        return [
            {
                "delivered_hour": h,
                "total_orders": int(r.uniform(40, 220)),
                "late_orders": int(r.uniform(4, 35)),
            }
            for h in range(24)
        ]

    if dataset_key == "map_venues.dataset":
        r = _rng(seed, "venues")
        lat, lon = _city_coords(c)
        return [
            {
                "venue_name": f"Site {i}",
                "venue_lat": lat + r.uniform(-0.06, 0.06),
                "venue_long": lon + r.uniform(-0.06, 0.06),
                "total_orders": r.randint(20, 400),
                "late_orders": r.randint(2, 60),
                "lateness_rate": round(r.uniform(4, 22), 2),
                "avg_completion_min": round(r.uniform(28, 48), 1),
                "avg_dropoff_distance": round(r.uniform(900, 4200), 0),
            }
            for i in range(18)
        ]

    if dataset_key == "map_dropoffs.dataset":
        r = _rng(seed, "dropoffs")
        lat, lon = _city_coords(c)
        return [
            {
                "dropoff_h3_lat": lat + r.uniform(-0.07, 0.07),
                "dropoff_h3_lon": lon + r.uniform(-0.07, 0.07),
                "order_count": r.randint(5, 120),
            }
            for _ in range(120)
        ]

    if dataset_key in {"courier_travel.dataset", "courier_speed_benchmark.dataset", "venue_performance.dataset"}:
        r = _rng(seed, dataset_key)
        rows = []
        for i in range(25 if "venue" in dataset_key else 40):
            rows.append(
                {
                    "courier_id": 10_000 + i,
                    "vehicle_type": r.choice(VEHICLES),
                    "total_orders": r.randint(15, 120),
                    "slow_travel_pct": round(r.uniform(2, 28), 1),
                    "avg_speed_kmh": round(r.uniform(8, 22), 1),
                    "venue_name": f"Partner {100 + i}",
                    "venue_id": 20_000 + i,
                    "late_pct": round(r.uniform(3, 24), 1),
                    "rotten_pct": round(r.uniform(1, 9), 1),
                    "problem_score": round(r.uniform(0.2, 0.95), 2),
                    "total_late_orders": r.randint(2, 40),
                }
            )
        return rows

    # --- Clone tab -------------------------------------------------------------
    if dataset_key.startswith("clone_"):
        daily = _daily_totals(seed, lb, clone_rate=0.07)
        if dataset_key == "clone_rate_summary.dataset":
            return daily
        if dataset_key == "clone_orders_list.dataset":
            r = _rng(seed, "clone_orders")
            return [
                {
                    "purchase_id": 5_000_000 + i,
                    "confirmed_date": r.choice(_dates(lb)[-14:]),
                    "clone_rate_pct": round(r.uniform(4, 18), 1),
                    "delivery_count": r.choice([2, 2, 3]),
                    "is_heavy": r.random() < 0.2,
                    "is_large": r.random() < 0.25,
                    "vehicle_type": r.choice(VEHICLES),
                    "venue_name": f"Partner {r.randint(200, 900)}",
                }
                for i in range(60)
            ]
        if "calendar" in dataset_key or "share" in dataset_key or "distribution" in dataset_key:
            r = _rng(seed, dataset_key)
            return [
                {
                    "confirmed_date": row["confirmed_date"],
                    "vehicle_type": r.choice(VEHICLES),
                    "total_orders": row["total_orders"],
                    "cloned_count": row["cloned_count"],
                    "clone_rate_pct": row["clone_rate_pct"],
                    "share_pct": round(r.uniform(5, 35), 1),
                    "capability_group": r.choice(["WEIGHT_L", "WEIGHT_XL", "NONE"]),
                }
                for row in daily[:14]
            ]
        if "positions" in dataset_key:
            lat, lon = _city_coords(c)
            r = _rng(seed, "pos")
            return [
                {
                    "lat": lat + r.uniform(-0.04, 0.04),
                    "lon": lon + r.uniform(-0.04, 0.04),
                    "timestamp": f"{date.today().isoformat()} 12:00:00",
                    "vehicle_type": r.choice(VEHICLES),
                }
                for _ in range(80)
            ]
        return daily

    # --- TTLA tab --------------------------------------------------------------
    if dataset_key.startswith("ttla_") or dataset_key.startswith("retail_ttla_"):
        r = _rng(seed, dataset_key)
        if dataset_key == "ttla_orders.dataset":
            limit = int(p.get("row_limit") or 200)
            return [
                {
                    "purchase_id": 7_000_000 + i,
                    "confirmed_date": r.choice(_dates(lb)[-10:]),
                    "confirmed_at": f"{date.today().isoformat()} 13:00:00",
                    "city": c,
                    "country": CITY_COUNTRY_MAP.get(c, "R1"),
                    "venue_name": f"Partner {r.randint(300, 999)}",
                    "venue_id": r.randint(1, 50_000),
                    "ttla_sec": int(r.uniform(70, 520)),
                    "delivery_count": r.choice([1, 1, 2]),
                    "vehicle_type": r.choice(VEHICLES),
                    "is_heavy": r.random() < 0.15,
                    "is_large": r.random() < 0.18,
                }
                for i in range(min(limit, 120))
            ]
        if "venues" in dataset_key or "couriers" in dataset_key:
            return [
                {
                    "venue_name": f"Partner {i}",
                    "venue_id": 30_000 + i,
                    "courier_id": 40_000 + i,
                    "avg_ttla_sec": round(_rng(seed, i).uniform(80, 260), 0),
                    "order_count": _rng(seed, i).randint(10, 200),
                    "impact_sec": round(_rng(seed, i).uniform(-12, 48), 1),
                    "city": c,
                }
                for i in range(35)
            ]
        return _daily_totals(seed, lb)

    if dataset_key.startswith("venue_"):
        r = _rng(seed, dataset_key)
        return [{"venue_id": 1, "message_count": r.randint(0, 12), "theme": "handoff delay"}]

    # Fallback: empty list (UI should degrade gracefully)
    return []
