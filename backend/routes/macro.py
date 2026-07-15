"""Macro snapshot + sector breadth."""
from typing import Any, Dict, List

from fastapi import APIRouter, Depends

from auth import get_current_user
from connectors.market_data import MacroConnector
from db import technicals_col, report_runs_col

router = APIRouter(prefix="/macro", tags=["macro"])


@router.get("")
async def macro(user: dict = Depends(get_current_user)) -> Dict[str, Any]:
    """Return cached macro from latest report_run if present, else live fetch."""
    latest = await report_runs_col.find_one({"status": "success"}, {"_id": 0, "macro_snapshot": 1, "run_date": 1}, sort=[("started_at", -1)])
    if latest and latest.get("macro_snapshot"):
        return {"source": "cached", "run_date": latest.get("run_date"), "data": latest["macro_snapshot"]}
    # fallback to live
    res = await MacroConnector().run()
    return {"source": "live", "data": res.get("data") or {}}


@router.get("/sectors")
async def sectors(user: dict = Depends(get_current_user)) -> List[Dict[str, Any]]:
    """Aggregate sector change_pct_1d and change_pct_1m from technicals."""
    rows = await technicals_col.find({}, {"_id": 0}).to_list(500)
    # need sector — joined via stock_universe
    from db import stock_universe_col
    uni = await stock_universe_col.find({}, {"_id": 0, "symbol": 1, "sector": 1}).to_list(500)
    sector_map = {u["symbol"]: u["sector"] for u in uni}
    agg: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        sec = sector_map.get(r.get("symbol"), "Other")
        d = agg.setdefault(sec, {"sector": sec, "count": 0, "day": 0.0, "week": 0.0, "month": 0.0})
        d["count"] += 1
        d["day"] += r.get("change_pct_1d") or 0
        d["week"] += r.get("change_pct_1w") or 0
        d["month"] += r.get("change_pct_1m") or 0
    out = []
    for s in agg.values():
        c = s["count"] or 1
        out.append({
            "sector": s["sector"], "count": s["count"],
            "day_pct": round(s["day"] / c, 2),
            "week_pct": round(s["week"] / c, 2),
            "month_pct": round(s["month"] / c, 2),
        })
    out.sort(key=lambda x: x["month_pct"], reverse=True)
    return out
