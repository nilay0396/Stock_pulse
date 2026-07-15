"""Stock universe + per-symbol detail."""
import asyncio
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import get_current_user
from connectors.market_data import download_history
from db import stock_universe_col, technicals_col, scores_col, news_col
from services import stock_deep_dive as dd_svc

router = APIRouter(prefix="/stocks", tags=["stocks"])


class DeepDiveRequest(BaseModel):
    force_refresh: bool = False
    skip_llm: bool = False


@router.get("/search")
async def search_stocks(
    q: str = Query("", min_length=0, max_length=64),
    limit: int = 12,
    _: dict = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    """Autocomplete across the full NSE EQUITY_L universe (symbol + company name)."""
    return await dd_svc.search_universe(q, limit=limit)


@router.post("/{symbol}/deep-dive")
async def deep_dive(
    symbol: str,
    body: Optional[DeepDiveRequest] = None,
    _: dict = Depends(get_current_user),
) -> Dict[str, Any]:
    """Live deep-dive: quote → OHLC → technicals → fundamentals → news →
    events → F&O → scoring → weekly/monthly verdict + entry-exit plan + AI memo."""
    body = body or DeepDiveRequest()
    try:
        return await dd_svc.fetch_stock_deep_dive(
            symbol, force_refresh=body.force_refresh, skip_llm=body.skip_llm,
        )
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Deep dive failed: {e}")


@router.get("/universe")
async def universe(
    user: dict = Depends(get_current_user),
    limit: int = 5000,
) -> List[Dict[str, Any]]:
    return await stock_universe_col.find({}, {"_id": 0}).to_list(limit)


@router.get("/universe/stats")
async def universe_stats(_: dict = Depends(get_current_user)) -> Dict[str, Any]:
    """Lightweight counts for the Admin dashboard — avoids pulling 2,000+ docs
    over the wire just to compute total / curated / "Other" splits."""
    total = await stock_universe_col.count_documents({})
    curated = await stock_universe_col.count_documents(
        {"sector": {"$nin": ["Other", None]}}
    )
    other = await stock_universe_col.count_documents({"sector": "Other"})
    return {"total": total, "curated": curated, "other": other}


@router.get("/{symbol}")
async def stock_detail(symbol: str, user: dict = Depends(get_current_user)) -> Dict[str, Any]:
    sym = symbol.upper()
    uni = await stock_universe_col.find_one({"symbol": sym}, {"_id": 0})
    if not uni:
        raise HTTPException(404, "Symbol not in universe")
    tech = await technicals_col.find_one({"symbol": sym}, {"_id": 0})
    score = await scores_col.find_one({"symbol": sym}, {"_id": 0}, sort=[("as_of", -1)])
    news = await news_col.find({"symbol": sym}, {"_id": 0}).sort("ingested_at", -1).to_list(10)
    return {"universe": uni, "technicals": tech, "score": score, "news": news}


@router.get("/{symbol}/history")
async def stock_history(symbol: str, period: str = "6mo", interval: str = "1d", user: dict = Depends(get_current_user)) -> Dict[str, Any]:
    sym = symbol.upper()
    uni = await stock_universe_col.find_one({"symbol": sym}, {"_id": 0})
    if not uni:
        raise HTTPException(404, "Symbol not in universe")
    hist = await download_history([uni["yf_symbol"]], period=period, interval=interval)
    df = hist.get(uni["yf_symbol"])
    if df is None or df.empty:
        return {"symbol": sym, "candles": []}
    candles = []
    for idx, row in df.iterrows():
        candles.append({
            "date": str(idx.date()) if hasattr(idx, "date") else str(idx),
            "open": round(float(row["Open"]), 2) if not _is_nan(row.get("Open")) else None,
            "high": round(float(row["High"]), 2) if not _is_nan(row.get("High")) else None,
            "low": round(float(row["Low"]), 2) if not _is_nan(row.get("Low")) else None,
            "close": round(float(row["Close"]), 2) if not _is_nan(row.get("Close")) else None,
            "volume": int(row["Volume"]) if not _is_nan(row.get("Volume")) else 0,
        })
    return {"symbol": sym, "candles": candles}


def _is_nan(v) -> bool:
    try:
        import math
        return v is None or (isinstance(v, float) and math.isnan(v))
    except Exception:
        return False
