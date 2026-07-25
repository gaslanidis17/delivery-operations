from __future__ import annotations

from fastapi import APIRouter, Query

from app.config import get_settings
from app.services.ai_service import generate_summary, generate_ai_analysis
from app.routers.late_orders import get_late_orders, get_summary, get_trend, get_venue_performance, get_courier_performance
from app.routers.rotten_orders import get_delayed_orders, get_rotten_summary
from app.services.data_processor import compute_flag_counts

router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.post("/summarize")
async def summarize(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
):
    s = get_settings()
    city = city or s.default_city

    orders_resp = get_late_orders(city, lookback_days)
    orders = orders_resp["orders"]
    summary_data = get_summary(city, lookback_days)
    trend_resp = get_trend(city, lookback_days)

    flag_counts = compute_flag_counts(orders)

    venue_counts: dict[str, int] = {}
    for o in orders:
        vn = o.get("venue_name", "Unknown")
        venue_counts[vn] = venue_counts.get(vn, 0) + 1
    top_venues = [
        {"venue": k, "late_orders": v}
        for k, v in sorted(venue_counts.items(), key=lambda x: -x[1])[:10]
    ]

    text = await generate_summary(
        summary_data=summary_data,
        flag_counts=flag_counts,
        top_venues=top_venues,
        trend_data=trend_resp["trend"],
    )
    return {"summary": text}


@router.post("/summarize-venues")
async def summarize_venues(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
    size_filter: str = Query(default="all"),
):
    s = get_settings()
    city = city or s.default_city

    vp = get_venue_performance(city=city, lookback_days=lookback_days, size_filter=size_filter)
    top_venues = vp["venues"][:20]

    data = {
        "city": city,
        "period_days": lookback_days,
        "size_filter": size_filter,
        "summary": vp["summary"],
        "top_problem_venues": [
            {
                "name": v.get("venue_name"),
                "type": v.get("venue_vertical"),
                "orders": v.get("total_orders"),
                "late_orders": v.get("late_orders"),
                "late_pct": v.get("late_pct"),
                "rotten_pct": v.get("rotten_pct"),
                "venue_late_count": v.get("venue_late_count"),
                "venue_late_share": v.get("venue_late_share"),
                "avg_prep_min": v.get("avg_prep_time_min"),
                "avg_ttla_sec": v.get("avg_ttla_sec"),
                "problem_score": v.get("problem_score"),
            }
            for v in top_venues
        ],
    }

    text = await generate_ai_analysis("venue", data)
    return {"summary": text}


@router.post("/summarize-couriers")
async def summarize_couriers(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
):
    s = get_settings()
    city = city or s.default_city

    cp = get_courier_performance(city=city, lookback_days=lookback_days)
    top_couriers = cp["couriers"][:20]

    data = {
        "city": city,
        "period_days": lookback_days,
        "summary": cp["summary"],
        "speed_benchmarks": cp.get("speed_benchmarks", []),
        "speed_targets": cp.get("speed_targets", {}),
        "top_slow_couriers": [
            {
                "worker_id": c.get("worker_id"),
                "vehicle_type": c.get("vehicle_type"),
                "order_count": c.get("order_count"),
                "slow_order_count": c.get("slow_order_count"),
                "slow_pct": c.get("slow_pct"),
                "avg_speed_kmh": c.get("avg_speed_kmh"),
                "avg_pickup_min": c.get("avg_pickup_min"),
                "avg_dropoff_min": c.get("avg_dropoff_min"),
            }
            for c in top_couriers
        ],
    }

    text = await generate_ai_analysis("courier", data)
    return {"summary": text}


@router.post("/summarize-rotten")
async def summarize_rotten(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
):
    s = get_settings()
    city = city or s.default_city

    rotten_days = min(lookback_days, 14)
    rotten_resp = get_delayed_orders(city=city, lookback_days=rotten_days)
    rotten_summary = get_rotten_summary(city=city, lookback_days=rotten_days)

    data = {
        "city": city,
        "period_days": rotten_days,
        "total_delayed_orders": rotten_resp.get("total", 0),
        "daily_summary": rotten_summary.get("summary", [])[-14:],
        "sample_orders": [
            {
                "venue": o.get("venue_name"),
                "ttla_min": o.get("time_to_accept_min"),
                "is_late": o.get("is_late_official"),
                "vehicle": o.get("vehicle_type"),
                "date": o.get("delivered_date"),
            }
            for o in rotten_resp.get("orders", [])[:30]
        ],
    }

    text = await generate_ai_analysis("rotten", data)
    return {"summary": text}


@router.post("/summarize-country")
async def summarize_country(
    country: str = Query(...),
    lookback_days: int = Query(default=28, ge=1, le=365),
):
    from app.routers.country_analytics import get_country_master

    master = get_country_master(country_code=country, lookback_days=lookback_days)

    data = {
        "country": country,
        "period_days": lookback_days,
        "hl_lateness_total": master.get("hl_lateness_total", [])[-14:],
        "perf_metrics": master.get("perf_metrics", [])[-30:],
    }

    text = await generate_ai_analysis("country", data)
    return {"summary": text}


@router.post("/summarize-clone")
async def summarize_clone(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28, ge=1, le=365),
):
    from app.routers.clone_rate import get_clone_summary, get_clone_acceptance, get_vehicle_distribution

    s = get_settings()
    city = city or s.default_city

    summary = get_clone_summary(city=city, lookback_days=lookback_days)
    acceptance = get_clone_acceptance(city=city, lookback_days=lookback_days)
    vehicles = get_vehicle_distribution(city=city, lookback_days=lookback_days)

    data = {
        "city": city,
        "period_days": lookback_days,
        "clone_summary": summary.get("summary", {}),
        "daily_trend": summary.get("daily", [])[-14:],
        "weight_tiers": acceptance.get("tiers", []),
        "weight_costs": acceptance.get("weight_costs", {}),
        "vehicle_distribution": vehicles.get("vehicles", []),
    }

    text = await generate_ai_analysis("clone", data)
    return {"summary": text}
