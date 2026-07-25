from __future__ import annotations

import csv
import io

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse
from openpyxl import Workbook

from app.config import get_settings
from app.routers.late_orders import get_late_orders
from app.routers.rotten_orders import get_delayed_orders

router = APIRouter(prefix="/api/export", tags=["export"])


def _orders_to_csv(orders: list[dict]) -> io.StringIO:
    if not orders:
        buf = io.StringIO()
        buf.write("No data")
        buf.seek(0)
        return buf

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=orders[0].keys())
    writer.writeheader()
    writer.writerows(orders)
    buf.seek(0)
    return buf


def _orders_to_xlsx(orders: list[dict], sheet_name: str = "Data") -> io.BytesIO:
    wb = Workbook()
    ws = wb.active
    ws.title = sheet_name

    if not orders:
        ws.append(["No data"])
    else:
        ws.append(list(orders[0].keys()))
        for row in orders:
            ws.append([str(v) if v is not None else "" for v in row.values()])

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


@router.get("/csv/late-orders")
def export_late_csv(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28),
):
    s = get_settings()
    city = city or s.default_city
    data = get_late_orders(city, lookback_days, 10000)
    buf = _orders_to_csv(data["orders"])
    return StreamingResponse(
        buf,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=late_orders.csv"},
    )


@router.get("/csv/rotten-orders")
def export_rotten_csv(
    city: str = Query(default=None),
    lookback_days: int = Query(default=7),
):
    s = get_settings()
    city = city or s.default_city
    data = get_delayed_orders(city, lookback_days, 10000)
    buf = _orders_to_csv(data["orders"])
    return StreamingResponse(
        buf,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=delayed_orders.csv"},
    )


@router.get("/excel/late-orders")
def export_late_excel(
    city: str = Query(default=None),
    lookback_days: int = Query(default=28),
):
    s = get_settings()
    city = city or s.default_city
    data = get_late_orders(city, lookback_days, 10000)
    buf = _orders_to_xlsx(data["orders"], "Late Orders")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=late_orders.xlsx"},
    )


@router.get("/excel/rotten-orders")
def export_rotten_excel(
    city: str = Query(default=None),
    lookback_days: int = Query(default=7),
):
    s = get_settings()
    city = city or s.default_city
    data = get_delayed_orders(city, lookback_days, 10000)
    buf = _orders_to_xlsx(data["orders"], "Rotten Orders")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=delayed_orders.xlsx"},
    )
